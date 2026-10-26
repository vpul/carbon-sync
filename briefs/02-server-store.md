# Brief 02: server domain (VaultStore) on a SQL interface

Read PLAN.md first (sections Server, Protocol). It is the contract; do not change it.

Rules: do exactly this brief, nothing extra. TypeScript strict, ESM, no `any` without a comment.
Vitest colocated. Commit at the end (`feat(server): vault store`); do not push. Final message: files
changed, commands run with their real results, anything left undone.

## Build in `apps/server` (`@carbon-sync/server`, private)

`package.json` with deps `@carbon-sync/protocol` (workspace `*`), devDeps `wrangler`,
`@cloudflare/workers-types` (exact latest). `tsconfig.json` extending the base, types
`@cloudflare/workers-types`. Add `typecheck` script.

### `src/data/sql.ts`

A minimal interface the store depends on, shaped like Durable Object `ctx.storage.sql`:

```ts
export interface Sql {
  exec<T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): { toArray(): T[]; one(): T };
}
export type SqlValue = string | number | null;
```
Plus `transaction<T>(fn: () => T): T` passed separately (DO: `ctx.storage.transactionSync`).

### `src/data/node-sql.ts` (test helper only, imported only by tests)

Adapter from `node:sqlite` `DatabaseSync` to `Sql` + `transaction` (BEGIN/COMMIT/ROLLBACK).
`one()` throws if there is not exactly one row, like Cloudflare's.

### `src/domain/vault-store.ts`

`class VaultStore` constructed with `{ sql, transaction, now: () => number }`. Methods
(all synchronous, results are plain objects matching protocol types):

- `migrate(): void` runs the schema from PLAN.md (idempotent), seeds `meta.seq = 0`.
- `cursor(): number`
- `changesSince(since: number): Change[]` ordered by seq. Includes tombstones.
- `push({ path, baseRev, content, hash, deviceId }): PushResult` where
  `PushResult = { kind: 'ack', rev, cursor, change: Change | null } | { kind: 'reject', current: { rev, content } }`.
  `change` is null when nothing changed (identical content, or delete of missing row).
  Implements exactly the "Push rules on the server" list in PLAN.md. Hash is computed by the caller
  (async crypto) and passed in; content null means delete.
- `rename({ from, to, baseRev, deviceId, toHash }): RenameResult` = `{ kind: 'ack', rev, cursor, changes: [Change, Change] }`
  or `{ kind: 'reject', current }` (from stale or missing) or `{ kind: 'conflict' }` (`to` exists and is live).
  The new path starts at `rev = (tombstone rev at 'to' ?? 0) + 1`. Both rows written in one transaction,
  consecutive seqs.
- Every accepted write runs inside `transaction`, bumps `meta.seq` by one per changed row.

Size limit is NOT checked here (protocol validator does it).

## Tests `src/domain/vault-store.test.ts` (use node-sql adapter, in-memory DB)

Cover each push rule: create at baseRev 0; create with baseRev 3 on missing row -> reject current
`{rev:0, content:null}`; update matching rev; stale rev -> reject with current; identical content -> ack, no
seq bump, change null; delete -> tombstone, content/hash null; delete missing -> ack rev 0 change null;
re-create over tombstone needs baseRev = tombstone rev; changesSince returns only newer rows incl tombstone;
rename happy path (two changes, consecutive seqs, old is tombstone, new has content); rename onto live
path -> conflict; rename with stale baseRev -> reject; migrate twice is harmless.

## Done when

`npm run typecheck && npm run lint && npm test` pass at the root.
