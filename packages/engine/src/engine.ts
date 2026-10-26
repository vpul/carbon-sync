import {
  type Change,
  type ClientMessage,
  isSyncable,
  type ServerMessage,
  sha256Hex,
} from '@carbon-sync/protocol';
import type {
  Clock,
  Connection,
  FileSystem,
  StateStore,
  SyncState,
  TimerHandle,
  Transport,
} from './ports.js';
import { type Resolution, resolve } from './resolve.js';

/** A tombstones use an empty hash; a real SHA-256 is always 64 hex characters. */
const TOMBSTONE_HASH = '';
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type SyncStatus = 'offline' | 'connecting' | 'syncing' | 'idle';

export interface SyncEvent {
  type: 'status' | 'merged' | 'error' | 'applied' | 'pushed';
  path?: string;
  detail?: string;
}

export interface SyncEngineOptions {
  fs: FileSystem;
  state: StateStore;
  transport: Transport;
  clock: Clock;
  url: string;
  token: string;
  debounceMs?: number;
  ignore?: readonly string[];
  onEvent?: (event: SyncEvent) => void;
}

type Inflight =
  | {
      kind: 'push';
      reqId: string;
      path: string;
      content: string | null;
      hash: string;
    }
  | {
      kind: 'rename';
      reqId: string;
      from: string;
      to: string;
      content: string;
      hash: string;
    };

function cloneState(state: SyncState): SyncState {
  const files: SyncState['files'] = {};
  for (const [path, entry] of Object.entries(state.files)) {
    files[path] = { rev: entry.rev, hash: entry.hash, base: entry.base };
  }
  return { cursor: state.cursor, deviceId: state.deviceId, files };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `resolve` guarantees content for these actions; null means a programming error. */
function requireText(value: string | null, action: Resolution['action']): string {
  if (value === null) {
    throw new Error(`resolve returned ${action} without content`);
  }
  return value;
}

/**
 * Client sync state machine. All server frames are serialized through one
 * queue, and state is persisted only after the matching disk change has been
 * applied, so a crash can never leave `cursor` ahead of local reality.
 */
export class SyncEngine {
  private readonly fs: FileSystem;
  private readonly stateStore: StateStore;
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly url: string;
  private readonly token: string;
  private readonly debounceMs: number;
  private readonly ignore: readonly string[];
  private readonly onEvent: ((event: SyncEvent) => void) | undefined;

  private state: SyncState = { cursor: 0, deviceId: '', files: {} };
  private running = false;
  private generation = 0;
  private currentStatus: SyncStatus = 'offline';

  private connection: Connection | null = null;
  private connectSeq = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: TimerHandle | null = null;

  private frameChain: Promise<void> = Promise.resolve();
  private readonly debounces = new Map<string, TimerHandle>();
  private readonly pendingPaths = new Set<string>();
  private pendingRenames: { from: string; to: string }[] = [];
  private inflight: Inflight | null = null;
  private reqCounter = 0;

  constructor(options: SyncEngineOptions) {
    this.fs = options.fs;
    this.stateStore = options.state;
    this.transport = options.transport;
    this.clock = options.clock;
    this.url = options.url;
    this.token = options.token;
    this.debounceMs = options.debounceMs ?? 500;
    this.ignore = options.ignore ?? [];
    this.onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const generation = ++this.generation;
    this.resetRuntime();

    let loaded: SyncState;
    try {
      loaded = await this.stateStore.load();
    } catch (error) {
      if (generation === this.generation) {
        this.running = false;
        this.emitError(undefined, error);
        this.setStatus('offline');
      }
      return;
    }
    if (this.isStale(generation)) {
      return;
    }

    this.state = cloneState(loaded);
    if (this.state.deviceId.length === 0) {
      this.state.deviceId = crypto.randomUUID();
      try {
        await this.stateStore.save(cloneState(this.state));
      } catch (error) {
        this.emitError(undefined, error);
      }
    }
    if (this.isStale(generation)) {
      return;
    }
    this.connect();
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.generation += 1;
    this.connectSeq += 1;
    const connection = this.connection;
    this.connection = null;
    connection?.close();
    this.resetRuntime();
    this.setStatus('offline');
  }

  /** Force a reconnect; the welcome handler performs a full local scan. */
  syncNow(): void {
    if (!this.running) {
      return;
    }
    this.reconnectAttempt = 0;
    if (this.reconnectTimer !== null) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connectSeq += 1;
    this.inflight = null;
    const connection = this.connection;
    this.connection = null;
    connection?.close();
    this.connect();
  }

  status(): SyncStatus {
    return this.currentStatus;
  }

  notifyLocalChange(path: string): void {
    this.scheduleLocal(path);
  }

  notifyLocalDelete(path: string): void {
    this.scheduleLocal(path);
  }

  notifyLocalRename(from: string, to: string): void {
    if (!this.running) {
      return;
    }
    if (!this.syncable(to)) {
      if (this.syncable(from)) {
        const timer = this.debounces.get(from);
        if (timer !== undefined) {
          this.clock.clearTimeout(timer);
          this.debounces.delete(from);
        }
        this.pendingPaths.add(from);
        this.pump();
      }
      return;
    }
    if (!this.syncable(from)) {
      this.scheduleLocal(to);
      return;
    }
    const timer = this.debounces.get(from);
    if (timer !== undefined) {
      this.clock.clearTimeout(timer);
      this.debounces.delete(from);
    }
    this.pendingPaths.delete(from);
    this.pendingRenames.push({ from, to });
    this.pump();
  }

  private resetRuntime(): void {
    for (const timer of this.debounces.values()) {
      this.clock.clearTimeout(timer);
    }
    this.debounces.clear();
    if (this.reconnectTimer !== null) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pendingPaths.clear();
    this.pendingRenames = [];
    this.inflight = null;
    this.reconnectAttempt = 0;
    this.frameChain = Promise.resolve();
  }

  private isStale(generation: number): boolean {
    return !this.running || generation !== this.generation;
  }

  private syncable(path: string): boolean {
    return isSyncable(path, this.ignore);
  }

  private scheduleLocal(path: string): void {
    if (!this.running || !this.syncable(path)) {
      return;
    }
    const previous = this.debounces.get(path);
    if (previous !== undefined) {
      this.clock.clearTimeout(previous);
    }
    const timer = this.clock.setTimeout(() => {
      this.debounces.delete(path);
      if (!this.running) {
        return;
      }
      this.pendingPaths.add(path);
      this.pump();
    }, this.debounceMs);
    this.debounces.set(path, timer);
  }

  private connect(): void {
    if (!this.running) {
      return;
    }
    const seq = ++this.connectSeq;
    this.setStatus('connecting');
    void Promise.resolve()
      .then(() => this.transport.connect(this.url))
      .then((connection) => {
        if (!this.running || seq !== this.connectSeq) {
          connection.close();
          return;
        }
        this.connection = connection;
        this.inflight = null;
        connection.onMessage((message) => {
          this.enqueue(connection, message);
        });
        connection.onClose((code) => {
          this.handleClose(connection, code);
        });
        this.setStatus('syncing');
        connection.send({
          v: 1,
          type: 'hello',
          token: this.token,
          deviceId: this.state.deviceId,
          since: this.state.cursor,
        });
      })
      .catch((error: unknown) => {
        if (!this.running || seq !== this.connectSeq) {
          return;
        }
        if (this.connection !== null) {
          const connection = this.connection;
          this.connection = null;
          connection.close();
        }
        this.emitError(undefined, error);
        this.setStatus('offline');
        this.scheduleReconnect();
      });
  }

  private handleClose(connection: Connection, _code: number): void {
    if (this.connection !== connection) {
      return;
    }
    this.connection = null;
    this.inflight = null;
    if (!this.running) {
      return;
    }
    this.setStatus('offline');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== null) {
      return;
    }
    const exponential = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt, 5),
    );
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private enqueue(connection: Connection, frame: ServerMessage): void {
    const generation = this.generation;
    this.frameChain = this.frameChain
      .then(async () => {
        if (!this.running || generation !== this.generation || this.connection !== connection) {
          return;
        }
        await this.handleFrame(frame, generation);
      })
      .catch((error: unknown) => {
        if (!this.isStale(generation)) {
          this.emitError(undefined, error);
        }
      });
  }

  private async handleFrame(frame: ServerMessage, generation: number): Promise<void> {
    switch (frame.type) {
      case 'welcome':
        await this.handleWelcome(frame, generation);
        return;
      case 'ack':
        await this.handleAck(frame, generation);
        return;
      case 'reject':
        await this.handleReject(frame, generation);
        return;
      case 'change':
        await this.applyChange(frame.change, frame.cursor, generation);
        if (this.isStale(generation)) {
          return;
        }
        this.pump();
        this.maybeIdle();
        return;
      case 'error':
        this.handleError(frame);
        return;
    }
  }

  private async handleWelcome(
    frame: Extract<ServerMessage, { type: 'welcome' }>,
    generation: number,
  ): Promise<void> {
    this.reconnectAttempt = 0;
    if (frame.cursor < this.state.cursor) {
      // The server lost its state (new deploy name or wiped Durable Object).
      // Start over as a fresh device so local files are re-uploaded.
      this.emit({ type: 'error', detail: 'server-reset' });
      this.state.cursor = 0;
      this.state.files = {};
      await this.persist(generation);
      if (this.isStale(generation)) {
        return;
      }
      this.syncNow();
      return;
    }
    for (const change of frame.changes) {
      if (this.isStale(generation)) {
        return;
      }
      await this.applyChange(change, change.seq, generation, false);
    }
    if (this.isStale(generation)) {
      return;
    }
    // Every row above is applied; only now may the cursor be persisted.
    this.advanceCursor(frame.cursor);
    await this.persist(generation);
    if (this.isStale(generation)) {
      return;
    }
    this.pendingRenames = [];
    await this.scan(generation);
    if (this.isStale(generation)) {
      return;
    }
    this.pump();
  }

  private async scan(generation: number): Promise<void> {
    const listed = await this.fs.list();
    if (this.isStale(generation)) {
      return;
    }
    const local = new Set(listed.filter((path) => this.syncable(path)));
    for (const path of local) {
      const entry = this.state.files[path];
      if (entry === undefined) {
        this.pendingPaths.add(path);
        continue;
      }
      const content = await this.fs.read(path);
      if (this.isStale(generation)) {
        return;
      }
      const hash = content === null ? TOMBSTONE_HASH : await sha256Hex(content);
      if (this.isStale(generation)) {
        return;
      }
      if (hash !== entry.hash) {
        this.pendingPaths.add(path);
      }
    }
    for (const path of Object.keys(this.state.files)) {
      if (!this.syncable(path) || local.has(path)) {
        continue;
      }
      const entry = this.state.files[path];
      if (entry !== undefined && entry.hash !== TOMBSTONE_HASH) {
        this.pendingPaths.add(path);
      }
    }
  }

  private async applyChange(
    change: Change,
    seq: number,
    generation: number,
    save = true,
  ): Promise<void> {
    const path = change.path;
    if (!this.syncable(path)) {
      this.advanceCursor(seq);
      if (save) await this.persist(generation);
      return;
    }

    const remote = change.content;
    const remoteHash = remote === null ? TOMBSTONE_HASH : await sha256Hex(remote);
    if (this.isStale(generation)) {
      return;
    }
    const existing = this.state.files[path];
    if (existing !== undefined && change.rev <= existing.rev) {
      this.advanceCursor(seq);
      if (save) await this.persist(generation);
      return;
    }

    const local = await this.fs.read(path);
    if (this.isStale(generation)) {
      return;
    }

    const resolution = resolve({
      base: existing !== undefined && existing.hash !== TOMBSTONE_HASH ? existing.base : null,
      local,
      remote,
    });

    let pushLocal = false;
    switch (resolution.action) {
      case 'noop-adopt':
        this.emit({ type: 'applied', path, detail: 'adopted' });
        break;
      case 'write-remote':
        await this.fs.write(path, requireText(remote, 'write-remote'));
        if (this.isStale(generation)) {
          return;
        }
        this.emit({ type: 'applied', path, detail: local === null ? 'remote-wins' : 'wrote' });
        break;
      case 'remove-local':
        await this.fs.remove(path);
        if (this.isStale(generation)) {
          return;
        }
        this.emit({ type: 'applied', path, detail: 'removed' });
        break;
      case 'keep-local-push':
        // Remote delete vs local edit: the local file wins and is recreated.
        pushLocal = true;
        break;
      case 'conflict-copy':
        await this.conflictCopy(
          path,
          requireText(local, 'conflict-copy'),
          requireText(remote, 'conflict-copy'),
          generation,
        );
        if (this.isStale(generation)) {
          return;
        }
        break;
      case 'merge':
        if (resolution.merged !== local) {
          await this.fs.write(path, resolution.merged);
          if (this.isStale(generation)) {
            return;
          }
        }
        this.emit({ type: 'merged', path });
        pushLocal = true;
        break;
    }

    this.state.files[path] =
      remote === null
        ? { rev: change.rev, hash: TOMBSTONE_HASH, base: TOMBSTONE_HASH }
        : { rev: change.rev, hash: remoteHash, base: remote };
    this.advanceCursor(seq);
    if (pushLocal) {
      this.pendingPaths.add(path);
    }
    if (save) await this.persist(generation);
  }

  /**
   * No common base but different local bytes: keep both. The remote copy takes
   * the canonical path; the local copy is pushed as a conflict file.
   */
  private async conflictCopy(
    path: string,
    local: string,
    remote: string,
    generation: number,
  ): Promise<void> {
    const short = this.state.deviceId.slice(0, 8);
    const slash = path.lastIndexOf('/');
    const directory = slash === -1 ? '' : path.slice(0, slash + 1);
    const name = path.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const stem = dot <= 0 ? name : name.slice(0, dot);
    let conflictPath = `${directory}${stem} (conflict ${short}).md`;
    for (let attempt = 2; attempt < 10; attempt += 1) {
      const occupant = await this.fs.read(conflictPath);
      if (this.isStale(generation)) {
        return;
      }
      if (occupant === null) {
        break;
      }
      conflictPath = `${directory}${stem} (conflict ${short} ${attempt}).md`;
    }

    await this.fs.write(path, remote);
    if (this.isStale(generation)) {
      return;
    }
    await this.fs.write(conflictPath, local);
    if (this.isStale(generation)) {
      return;
    }
    this.pendingPaths.add(conflictPath);
    this.emit({ type: 'merged', path, detail: 'conflict-copy' });
  }

  private async handleAck(
    frame: Extract<ServerMessage, { type: 'ack' }>,
    generation: number,
  ): Promise<void> {
    const inflight = this.inflight;
    if (inflight === null || inflight.reqId !== frame.reqId) {
      return;
    }
    this.inflight = null;

    if (inflight.kind === 'push') {
      this.state.files[inflight.path] =
        inflight.content === null
          ? { rev: frame.rev, hash: TOMBSTONE_HASH, base: TOMBSTONE_HASH }
          : { rev: frame.rev, hash: inflight.hash, base: inflight.content };
      this.advanceCursor(frame.cursor);
      await this.persist(generation);
      this.emit({
        type: 'pushed',
        path: inflight.path,
        detail: inflight.content === null ? 'delete' : 'push',
      });
    } else {
      this.state.files[inflight.to] = {
        rev: frame.rev,
        hash: inflight.hash,
        base: inflight.content,
      };
      delete this.state.files[inflight.from];
      this.advanceCursor(frame.cursor);
      await this.persist(generation);
      this.emit({ type: 'pushed', path: inflight.to, detail: 'rename' });
    }

    if (this.isStale(generation)) {
      return;
    }
    this.pump();
  }

  private async handleReject(
    frame: Extract<ServerMessage, { type: 'reject' }>,
    generation: number,
  ): Promise<void> {
    const inflight = this.inflight;
    if (inflight === null || inflight.reqId !== frame.reqId) {
      return;
    }
    this.inflight = null;

    if (inflight.kind === 'rename') {
      this.fallbackRename(inflight.from, inflight.to);
      this.pump();
      return;
    }

    const path = inflight.path;
    const current = frame.current;
    if (current.rev === 0 && current.content === null) {
      // The server has no row for this path (reset or a fresh Durable Object):
      // drop the stale revision and re-push whatever is on disk as a create.
      delete this.state.files[path];
      this.pendingPaths.add(path);
      await this.persist(generation);
      this.pump();
      return;
    }

    const existing = this.state.files[path];
    if (existing !== undefined && existing.rev >= current.rev) {
      // A change frame already resolved this revision; the reject is stale.
      this.pump();
      return;
    }

    const local = await this.fs.read(path);
    if (this.isStale(generation)) {
      return;
    }

    const remote = current.content;
    const remoteHash = remote === null ? TOMBSTONE_HASH : await sha256Hex(remote);
    if (this.isStale(generation)) {
      return;
    }

    const resolution = resolve({
      base: existing !== undefined && existing.hash !== TOMBSTONE_HASH ? existing.base : null,
      local,
      remote,
    });

    switch (resolution.action) {
      case 'noop-adopt':
        this.emit({ type: 'applied', path, detail: 'adopted' });
        break;
      case 'write-remote':
        await this.fs.write(path, requireText(remote, 'write-remote'));
        if (this.isStale(generation)) {
          return;
        }
        this.emit({ type: 'applied', path, detail: local === null ? 'remote-wins' : 'wrote' });
        break;
      case 'remove-local':
        await this.fs.remove(path);
        if (this.isStale(generation)) {
          return;
        }
        this.emit({ type: 'applied', path, detail: 'removed' });
        break;
      case 'keep-local-push':
        // Remote delete vs local edit: local wins as a create.
        this.pendingPaths.add(path);
        break;
      case 'conflict-copy':
        await this.conflictCopy(
          path,
          requireText(local, 'conflict-copy'),
          requireText(remote, 'conflict-copy'),
          generation,
        );
        if (this.isStale(generation)) {
          return;
        }
        break;
      case 'merge':
        if (resolution.merged !== local) {
          await this.fs.write(path, resolution.merged);
          if (this.isStale(generation)) {
            return;
          }
        }
        this.emit({ type: 'merged', path });
        this.pendingPaths.add(path);
        break;
    }

    this.state.files[path] =
      remote === null
        ? { rev: current.rev, hash: TOMBSTONE_HASH, base: TOMBSTONE_HASH }
        : { rev: current.rev, hash: remoteHash, base: remote };
    await this.persist(generation);
    this.pump();
  }

  private handleError(frame: Extract<ServerMessage, { type: 'error' }>): void {
    const inflight = this.inflight;
    const matches = inflight !== null && frame.reqId === inflight.reqId;
    const path = inflight?.kind === 'push' ? inflight.path : inflight?.to;

    if (matches && inflight.kind === 'rename' && frame.code === 'rename_conflict') {
      this.inflight = null;
      this.emit({ type: 'error', path: inflight.to, detail: frame.code });
      this.fallbackRename(inflight.from, inflight.to);
      this.pump();
      return;
    }

    if (matches) {
      this.inflight = null;
    }
    this.emit({
      type: 'error',
      ...(path === undefined ? {} : { path }),
      detail: `${frame.code}: ${frame.message}`,
    });
    if (matches) {
      this.pump();
    }
  }

  private fallbackRename(from: string, to: string): void {
    this.pendingPaths.delete(from);
    this.pendingPaths.delete(to);
    this.pendingPaths.add(to);
    if (this.state.files[from] !== undefined) {
      this.pendingPaths.add(from);
    }
    this.pump();
  }

  private async prepareRename(from: string, to: string, generation: number): Promise<void> {
    const connection = this.connection;
    if (connection === null) {
      return;
    }
    const existing = this.state.files[from];
    const content = await this.fs.read(to);
    if (this.isStale(generation) || this.connection !== connection) {
      return;
    }
    const hash = content === null ? TOMBSTONE_HASH : await sha256Hex(content);
    if (this.isStale(generation) || this.connection !== connection) {
      return;
    }

    if (
      content === null ||
      existing === undefined ||
      existing.hash === TOMBSTONE_HASH ||
      existing.hash !== hash
    ) {
      this.pendingPaths.delete(to);
      this.pendingPaths.delete(from);
      this.pendingPaths.add(to);
      if (existing !== undefined) {
        this.pendingPaths.add(from);
      }
      this.pump();
      return;
    }

    const reqId = this.nextReqId();
    this.inflight = { kind: 'rename', reqId, from, to, content, hash };
    this.setStatus('syncing');
    try {
      connection.send({ v: 1, type: 'rename', reqId, from, to, baseRev: existing.rev });
    } catch (error) {
      this.inflight = null;
      this.emitError(from, error);
      connection.close();
    }
  }

  private pump(): void {
    if (!this.running || this.connection === null || this.inflight !== null) {
      return;
    }

    const rename = this.pendingRenames.shift();
    if (rename !== undefined) {
      void this.prepareRename(rename.from, rename.to, this.generation);
      return;
    }

    let next: string | undefined;
    for (const path of this.pendingPaths) {
      next = path;
      break;
    }
    if (next === undefined) {
      this.maybeIdle();
      return;
    }
    this.pendingPaths.delete(next);
    void this.sendPush(next, this.generation, this.connection);
  }

  private async sendPush(path: string, generation: number, connection: Connection): Promise<void> {
    const content = await this.fs.read(path);
    if (this.isStale(generation) || this.connection !== connection) {
      return;
    }
    const hash = content === null ? TOMBSTONE_HASH : await sha256Hex(content);
    if (this.isStale(generation) || this.connection !== connection) {
      return;
    }

    const existing = this.state.files[path];
    if (content === null) {
      if (existing === undefined || existing.hash === TOMBSTONE_HASH) {
        this.pump();
        return;
      }
    } else if (existing !== undefined && existing.hash === hash) {
      this.pump();
      return;
    }

    const reqId = this.nextReqId();
    const frame: ClientMessage = {
      v: 1,
      type: 'push',
      reqId,
      path,
      baseRev: existing?.rev ?? 0,
      content,
    };
    this.inflight = { kind: 'push', reqId, path, content, hash };
    this.setStatus('syncing');
    try {
      connection.send(frame);
    } catch (error) {
      this.inflight = null;
      this.emitError(path, error);
      connection.close();
    }
  }

  private maybeIdle(): void {
    if (!this.running || this.connection === null) {
      return;
    }
    if (
      this.inflight === null &&
      this.pendingPaths.size === 0 &&
      this.pendingRenames.length === 0
    ) {
      this.setStatus('idle');
    }
  }

  private advanceCursor(seq: number): void {
    if (seq > this.state.cursor) {
      this.state.cursor = seq;
    }
  }

  private async persist(generation: number): Promise<void> {
    if (this.isStale(generation)) {
      return;
    }
    try {
      await this.stateStore.save(cloneState(this.state));
    } catch (error) {
      if (!this.isStale(generation)) {
        this.emitError(undefined, error);
      }
    }
  }

  private nextReqId(): string {
    this.reqCounter += 1;
    return String(this.reqCounter);
  }

  private setStatus(next: SyncStatus): void {
    if (this.currentStatus === next) {
      return;
    }
    this.currentStatus = next;
    this.emit({ type: 'status', detail: next });
  }

  private emit(event: SyncEvent): void {
    this.onEvent?.(event);
  }

  private emitError(path: string | undefined, error: unknown): void {
    this.emit({
      type: 'error',
      ...(path === undefined ? {} : { path }),
      detail: describeError(error),
    });
  }
}
