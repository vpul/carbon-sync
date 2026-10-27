import { DatabaseSync } from 'node:sqlite';
import type { Change, ClientMessage, ServerMessage } from '@carbon-sync/protocol';
import { sha256Hex } from '@carbon-sync/protocol';
import { NodeSql } from '../../../../apps/server/src/data/node-sql.js';
import { VaultStore } from '../../../../apps/server/src/domain/vault-store.js';
import type { Connection, Transport } from '../ports.js';

type Loop = Connection & {
  authed: boolean;
  deviceId: string;
  closed: boolean;
  deliver(message: ServerMessage): void;
  fail(code: number): void;
  closeFromServer(code: number): void;
};
export class LoopbackServer implements Transport {
  readonly store: VaultStore;
  readonly pushLog: { path: string; content: string | null }[] = [];
  pushes = 0;
  private readonly sockets = new Set<Loop>();
  constructor(private readonly token = 'test-token') {
    const sql = new NodeSql(new DatabaseSync(':memory:'));
    const transaction = <T>(fn: () => T): T => sql.transaction(fn);
    this.store = new VaultStore({ sql, transaction, now: () => Date.now() });
    this.store.migrate();
  }
  async connect(_url: string): Promise<Connection> {
    const connection: Loop = {
      authed: false,
      deviceId: '',
      closed: false,
      send: (message) => {
        queueMicrotask(() => {
          if (!connection.closed) void this.handle(connection, message);
        });
      },
      close: () => connection.closeFromServer(1000),
      onMessage: (callback) => {
        connection.deliver = callback;
      },
      onClose: (callback) => {
        connection.fail = callback;
      },
      deliver: () => undefined,
      fail: () => undefined,
      closeFromServer: (code) => {
        if (connection.closed) return;
        connection.closed = true;
        this.sockets.delete(connection);
        queueMicrotask(() => connection.fail(code));
      },
    };
    this.sockets.add(connection);
    return connection;
  }
  private send(connection: Loop, frame: ServerMessage): void {
    queueMicrotask(() => {
      if (!connection.closed) connection.deliver(frame);
    });
  }
  private broadcast(sender: Loop, change: Change): void {
    const frame: ServerMessage = { v: 1, type: 'change', cursor: change.seq, change };
    for (const socket of this.sockets) {
      if (socket !== sender && socket.authed) this.send(socket, frame);
    }
  }
  async handle(connection: Loop, frame: ClientMessage): Promise<void> {
    if (connection.closed) return;
    if (!connection.authed) {
      if (frame.type !== 'hello' || frame.token !== this.token) {
        return connection.closeFromServer(4401);
      }
      connection.authed = true;
      connection.deviceId = frame.deviceId;
      return this.send(connection, {
        v: 1,
        type: 'welcome',
        cursor: this.store.cursor(),
        changes: this.store.changesSince(frame.since),
      });
    }
    const error = (code: 'bad_request' | 'rename_conflict', message: string, id?: string) =>
      this.send(connection, { v: 1, type: 'error', code, message, ...(id ? { reqId: id } : {}) });
    if (frame.type === 'hello') return error('bad_request', 'authed');
    const reqId = frame.reqId;
    const reject = (path: string, current: { rev: number; content: string | null }) =>
      this.send(connection, { v: 1, type: 'reject', reqId, path, current });
    if (frame.type === 'push') {
      this.pushes += 1;
      this.pushLog.push({ path: frame.path, content: frame.content });
      const hash = frame.content === null ? null : await sha256Hex(frame.content);
      const result = this.store.push({ ...frame, hash, deviceId: connection.deviceId });
      if (result.kind === 'reject') return reject(frame.path, result.current);
      const { rev, cursor, change } = result;
      this.send(connection, { v: 1, type: 'ack', reqId, path: frame.path, rev, cursor });
      if (change !== null) this.broadcast(connection, change);
      return;
    }
    const from = this.store.file(frame.from);
    if (from === undefined || from.deleted || from.rev !== frame.baseRev) {
      return reject(frame.from, { rev: from?.rev ?? 0, content: from?.content ?? null });
    }
    const toHash = await sha256Hex(from.content ?? '');
    const { from: source, to, baseRev } = frame;
    const result = this.store.rename({
      from: source,
      to,
      baseRev,
      deviceId: connection.deviceId,
      toHash,
    });
    if (result.kind === 'conflict') return error('rename_conflict', 'target exists', reqId);
    if (result.kind === 'reject') return reject(source, result.current);
    const { rev, cursor } = result;
    this.send(connection, { v: 1, type: 'ack', reqId, path: to, rev, cursor });
    for (const change of result.changes) this.broadcast(connection, change);
  }
}
