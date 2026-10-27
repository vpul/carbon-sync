import { DurableObject } from 'cloudflare:workers';
import {
  type Change,
  CLOSE_HELLO_TIMEOUT,
  CLOSE_UNAUTHORIZED,
  type ClientMessage,
  PROTOCOL_VERSION,
  ProtocolError,
  parseClientMessage,
  type ServerMessage,
  sha256Hex,
} from '@carbon-sync/protocol';
import { type Env, readConfig } from '../config.js';
import { VaultStore } from '../domain/vault-store.js';

const HELLO_TIMEOUT_MS = 10_000;

type Attachment =
  | { authed: false; deviceId: null; openedAt: number }
  | { authed: true; deviceId: string; openedAt: number };

const encoder = new TextEncoder();

/** Cloudflare's extension to SubtleCrypto; @types/node declares a narrower global. */
type TimingSafeSubtleCrypto = {
  timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
};

function readAttachment(ws: WebSocket): Attachment | null {
  const value: unknown = ws.deserializeAttachment();
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { authed, deviceId, openedAt } = value as Record<string, unknown>;
  if (typeof authed !== 'boolean' || typeof openedAt !== 'number') {
    return null;
  }
  if (authed) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      return null;
    }
    return { authed: true, deviceId, openedAt };
  }
  return deviceId === null ? { authed: false, deviceId: null, openedAt } : null;
}

function reqIdOf(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const reqId = (parsed as Record<string, unknown>).reqId;
    return typeof reqId === 'string' && reqId.length > 0 ? reqId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One Durable Object per vault. Domain state lives in {@link VaultStore}; this
 * class is the transport boundary (WebSocket lifecycle and frame routing).
 */
export class VaultObject extends DurableObject<Env> {
  private readonly store: VaultStore;
  private readonly tokenBytes: Uint8Array;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.tokenBytes = encoder.encode(readConfig(env).token);
    this.store = new VaultStore({
      sql: ctx.storage.sql,
      transaction: (fn) => ctx.storage.transactionSync(fn),
      now: () => Date.now(),
    });
    // Errors here reset the object; the runtime handles the rejection.
    void ctx.blockConcurrencyWhile(async () => {
      this.store.migrate();
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      authed: false,
      deviceId: null,
      openedAt: Date.now(),
    } satisfies Attachment);

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + HELLO_TIMEOUT_MS);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      await this.handle(ws, message);
    } catch (error) {
      this.sendError(ws, error, typeof message === 'string' ? reqIdOf(message) : undefined);
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.close(ws, code, reason);
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('vault websocket error', error);
    this.close(ws, 1011, 'websocket error');
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    let nextDeadline: number | null = null;

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = readAttachment(ws);
      if (attachment === null || attachment.authed) {
        continue;
      }
      const deadline = attachment.openedAt + HELLO_TIMEOUT_MS;
      if (deadline <= now) {
        ws.close(CLOSE_HELLO_TIMEOUT, 'hello timeout');
      } else if (nextDeadline === null || deadline < nextDeadline) {
        nextDeadline = deadline;
      }
    }

    if (nextDeadline !== null) {
      await this.ctx.storage.setAlarm(nextDeadline);
    }
  }

  private async handle(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      this.sendError(ws, new ProtocolError('bad_request', 'binary frames are not supported'));
      return;
    }

    const attachment = readAttachment(ws);
    if (attachment === null) {
      this.close(ws, CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }

    let frame: ClientMessage;
    try {
      frame = parseClientMessage(message);
    } catch (error) {
      this.sendError(ws, error, reqIdOf(message));
      return;
    }

    if (!attachment.authed) {
      if (frame.type !== 'hello') {
        this.close(ws, CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      if (!this.tokenMatches(frame.token)) {
        this.close(ws, CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      ws.serializeAttachment({
        authed: true,
        deviceId: frame.deviceId,
        openedAt: attachment.openedAt,
      } satisfies Attachment);
      this.send(ws, {
        v: PROTOCOL_VERSION,
        type: 'welcome',
        cursor: this.store.cursor(),
        changes: this.store.changesSince(frame.since),
      });
      return;
    }

    switch (frame.type) {
      case 'hello':
        this.sendError(ws, new ProtocolError('bad_request', 'already authenticated'));
        return;
      case 'push':
        await this.handlePush(ws, attachment.deviceId, frame);
        return;
      case 'rename':
        await this.handleRename(ws, attachment.deviceId, frame);
        return;
    }
  }

  private async handlePush(
    ws: WebSocket,
    deviceId: string,
    frame: Extract<ClientMessage, { type: 'push' }>,
  ): Promise<void> {
    const hash = frame.content === null ? null : await sha256Hex(frame.content);
    const result = this.store.push({
      path: frame.path,
      baseRev: frame.baseRev,
      content: frame.content,
      hash,
      deviceId,
    });

    if (result.kind === 'reject') {
      this.send(ws, {
        v: PROTOCOL_VERSION,
        type: 'reject',
        reqId: frame.reqId,
        path: frame.path,
        current: result.current,
      });
      return;
    }

    this.send(ws, {
      v: PROTOCOL_VERSION,
      type: 'ack',
      reqId: frame.reqId,
      path: frame.path,
      rev: result.rev,
      cursor: result.cursor,
    });
    if (result.change !== null) {
      this.broadcast(ws, result.change);
    }
  }

  private async handleRename(
    ws: WebSocket,
    deviceId: string,
    frame: Extract<ClientMessage, { type: 'rename' }>,
  ): Promise<void> {
    // Reject stale/missing sources before hashing; the store repeats the check
    // inside its transaction, so an interleaved write still cannot slip through.
    const from = this.store.file(frame.from);
    if (from === undefined || from.deleted || from.rev !== frame.baseRev) {
      this.send(ws, {
        v: PROTOCOL_VERSION,
        type: 'reject',
        reqId: frame.reqId,
        path: frame.from,
        current: {
          rev: from?.rev ?? 0,
          content: from === undefined || from.deleted ? null : from.content,
        },
      });
      return;
    }

    const result = this.store.rename({
      from: frame.from,
      to: frame.to,
      baseRev: frame.baseRev,
      deviceId,
      toHash: await sha256Hex(from.content ?? ''),
    });

    if (result.kind === 'conflict') {
      this.send(ws, {
        v: PROTOCOL_VERSION,
        type: 'error',
        reqId: frame.reqId,
        code: 'rename_conflict',
        message: `rename target already exists: ${frame.to}`,
      });
      return;
    }

    if (result.kind === 'reject') {
      this.send(ws, {
        v: PROTOCOL_VERSION,
        type: 'reject',
        reqId: frame.reqId,
        path: frame.from,
        current: result.current,
      });
      return;
    }

    this.send(ws, {
      v: PROTOCOL_VERSION,
      type: 'ack',
      reqId: frame.reqId,
      path: frame.to,
      rev: result.rev,
      cursor: result.cursor,
    });
    for (const change of result.changes) {
      this.broadcast(ws, change);
    }
  }

  private tokenMatches(candidate: string): boolean {
    const bytes = encoder.encode(candidate);
    if (bytes.length !== this.tokenBytes.length) {
      return false;
    }
    return (crypto.subtle as unknown as TimingSafeSubtleCrypto).timingSafeEqual(
      bytes,
      this.tokenBytes,
    );
  }

  private broadcast(sender: WebSocket, change: Change): void {
    const frame: ServerMessage = {
      v: PROTOCOL_VERSION,
      type: 'change',
      cursor: change.seq,
      change,
    };
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== sender && readAttachment(ws)?.authed === true) {
        this.send(ws, frame);
      }
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('failed to send frame', error);
    }
  }

  private sendError(ws: WebSocket, error: unknown, reqId?: string): void {
    const protocolError =
      error instanceof ProtocolError
        ? error
        : new ProtocolError(
            'bad_request',
            error instanceof Error ? error.message : 'internal error',
          );
    if (!(error instanceof ProtocolError)) {
      console.error('vault request error', error);
    }
    this.send(ws, {
      v: PROTOCOL_VERSION,
      type: 'error',
      ...(reqId === undefined ? {} : { reqId }),
      code: protocolError.code,
      message: protocolError.message,
    });
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed; nothing to clean up.
    }
  }
}
