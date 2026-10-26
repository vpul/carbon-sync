// Test-only adapter: node:sqlite -> the store's Sql interface.
import type { DatabaseSync } from 'node:sqlite';
import type { Sql, SqlResult, SqlValue } from './sql.js';

/** Adapts a `node:sqlite` database to {@link Sql}. */
export class NodeSql implements Sql {
  constructor(private readonly db: DatabaseSync) {}

  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlResult<T> {
    // node:sqlite statements run lazily, so execute eagerly here to match the
    // Durable Object `exec` semantics (DDL statements must take effect too).
    const rows = this.db.prepare(query).all(...bindings) as unknown as T[];
    return {
      toArray: () => rows.slice(),
      one: () => {
        if (rows.length !== 1) {
          throw new Error(`expected exactly one row, got ${rows.length}`);
        }
        // Checked just above; rows cannot be empty here.
        return rows[0] as T;
      },
    };
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
