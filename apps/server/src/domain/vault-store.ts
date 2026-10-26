import type { Change } from '@carbon-sync/protocol';
import type { Sql, Transaction } from '../data/sql.js';

export interface VaultStoreOptions {
  sql: Sql;
  transaction: Transaction;
  now: () => number;
}

export type PushInput = {
  path: string;
  baseRev: number;
  content: string | null;
  hash: string | null;
  deviceId: string;
};

export type PushResult =
  | { kind: 'ack'; rev: number; cursor: number; change: Change | null }
  | { kind: 'reject'; current: { rev: number; content: string | null } };

export type RenameInput = {
  from: string;
  to: string;
  baseRev: number;
  deviceId: string;
  toHash: string;
};

export type RenameResult =
  | { kind: 'ack'; rev: number; cursor: number; changes: [Change, Change] }
  | { kind: 'reject'; current: { rev: number; content: string | null } }
  | { kind: 'conflict' };

/** Current state of one path, tombstones included. */
export type FileState = { rev: number; deleted: boolean; content: string | null };

type FileRow = {
  path: string;
  rev: number;
  seq: number;
  deleted: number;
  content: string | null;
  hash: string | null;
  device_id: string;
  updated_at: number;
};

type WriteRow = {
  path: string;
  rev: number;
  seq: number;
  deleted: 0 | 1;
  content: string | null;
  hash: string | null;
  deviceId: string;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS files (
    path       TEXT PRIMARY KEY,
    rev        INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    content    TEXT,
    hash       TEXT,
    device_id  TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS files_seq ON files(seq)',
  `CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL
  )`,
  "INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', 0)",
];

const UPSERT = `INSERT INTO files (path, rev, seq, deleted, content, hash, device_id, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(path) DO UPDATE SET
  rev = excluded.rev,
  seq = excluded.seq,
  deleted = excluded.deleted,
  content = excluded.content,
  hash = excluded.hash,
  device_id = excluded.device_id,
  updated_at = excluded.updated_at`;

/**
 * Vault state over a tiny synchronous SQL interface. All writes are serialized
 * inside `transaction`; each changed row consumes one global sequence number.
 */
export class VaultStore {
  private readonly sql: Sql;
  private readonly transaction: Transaction;
  private readonly now: () => number;

  constructor({ sql, transaction, now }: VaultStoreOptions) {
    this.sql = sql;
    this.transaction = transaction;
    this.now = now;
  }

  /** Creates the schema if needed and seeds the vault cursor. Idempotent. */
  migrate(): void {
    for (const statement of SCHEMA) {
      this.sql.exec(statement);
    }
  }

  cursor(): number {
    return this.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'seq'").one().v;
  }

  /** Current state of `path`, or `undefined` if it was never written. */
  file(path: string): FileState | undefined {
    const row = this.lookup(path);
    if (row === undefined) {
      return undefined;
    }
    return { rev: row.rev, deleted: row.deleted === 1, content: row.content };
  }

  changesSince(since: number): Change[] {
    const rows = this.sql
      .exec<FileRow>('SELECT * FROM files WHERE seq > ? ORDER BY seq', since)
      .toArray();
    return rows.map((row) => this.toChange(row));
  }

  push({ path, baseRev, content, hash, deviceId }: PushInput): PushResult {
    return this.transaction(() => {
      const row = this.lookup(path);
      const cursor = this.cursor();

      if (row === undefined) {
        if (baseRev !== 0) {
          return { kind: 'reject', current: { rev: 0, content: null } };
        }
        if (content === null) {
          return { kind: 'ack', rev: 0, cursor, change: null };
        }
        const change = this.write({ path, rev: 1, content, hash, deviceId, deleted: 0 });
        return { kind: 'ack', rev: change.rev, cursor: change.seq, change };
      }

      const current = { rev: row.rev, content: row.content };

      if (row.deleted === 1) {
        if (baseRev !== 0 && baseRev !== row.rev) {
          return { kind: 'reject', current };
        }
        if (content === null) {
          return { kind: 'ack', rev: row.rev, cursor, change: null };
        }
        const change = this.write({ path, rev: row.rev + 1, content, hash, deviceId, deleted: 0 });
        return { kind: 'ack', rev: change.rev, cursor: change.seq, change };
      }

      if (baseRev !== row.rev) {
        return { kind: 'reject', current };
      }
      if (content === null) {
        const change = this.write({
          path,
          rev: row.rev + 1,
          content: null,
          hash: null,
          deviceId,
          deleted: 1,
        });
        return { kind: 'ack', rev: change.rev, cursor: change.seq, change };
      }
      if (content === row.content) {
        return { kind: 'ack', rev: row.rev, cursor, change: null };
      }
      const change = this.write({ path, rev: row.rev + 1, content, hash, deviceId, deleted: 0 });
      return { kind: 'ack', rev: change.rev, cursor: change.seq, change };
    });
  }

  rename({ from, to, baseRev, deviceId, toHash }: RenameInput): RenameResult {
    return this.transaction(() => {
      const fromRow = this.lookup(from);
      if (fromRow === undefined || fromRow.deleted === 1) {
        return { kind: 'reject', current: { rev: fromRow?.rev ?? 0, content: null } };
      }
      if (fromRow.rev !== baseRev) {
        return { kind: 'reject', current: { rev: fromRow.rev, content: fromRow.content } };
      }

      const toRow = this.lookup(to);
      if (toRow !== undefined && toRow.deleted === 0) {
        return { kind: 'conflict' };
      }

      const tombstone = this.write({
        path: from,
        rev: fromRow.rev + 1,
        content: null,
        hash: null,
        deviceId,
        deleted: 1,
      });
      const created = this.write({
        path: to,
        rev: (toRow?.rev ?? 0) + 1,
        content: fromRow.content,
        hash: toHash,
        deviceId,
        deleted: 0,
      });

      return {
        kind: 'ack',
        rev: created.rev,
        cursor: created.seq,
        changes: [tombstone, created],
      };
    });
  }

  private lookup(path: string): FileRow | undefined {
    return this.sql.exec<FileRow>('SELECT * FROM files WHERE path = ?', path).toArray()[0];
  }

  /** Allocates the next global seq and upserts one row; returns its change. */
  private write({ path, rev, content, hash, deviceId, deleted }: Omit<WriteRow, 'seq'>): Change {
    const seq = this.cursor() + 1;
    this.sql.exec("UPDATE meta SET v = ? WHERE k = 'seq'", seq);
    this.sql.exec(UPSERT, path, rev, seq, deleted, content, hash, deviceId, this.now());
    return {
      path,
      rev,
      deleted: deleted === 1,
      content,
      hash,
      deviceId,
      seq,
    };
  }

  private toChange(row: FileRow): Change {
    return {
      path: row.path,
      rev: row.rev,
      deleted: row.deleted === 1,
      content: row.content,
      hash: row.hash,
      deviceId: row.device_id,
      seq: row.seq,
    };
  }
}
