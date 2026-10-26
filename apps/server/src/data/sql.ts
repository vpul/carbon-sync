/** Values the store binds into SQL statements. */
export type SqlValue = string | number | null;

/** A single synchronous statement result, mirroring Durable Object `ctx.storage.sql`. */
export interface SqlResult<T> {
  toArray(): T[];
  /** Throws unless the query produced exactly one row. */
  one(): T;
}

/**
 * The minimal SQL surface the store depends on. Shaped like
 * `ctx.storage.sql` in a Durable Object.
 */
export interface Sql {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlResult<T>;
}

/** Runs `fn` atomically. Durable Object: `ctx.storage.transactionSync`. */
export type Transaction = <T>(fn: () => T) => T;
