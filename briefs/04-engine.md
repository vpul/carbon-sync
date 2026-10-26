# Brief 04: client sync engine

Read PLAN.md first, especially "Client engine". Every numbered engine rule there is a requirement.
It is the contract; do not change it.

Rules: do exactly this brief, nothing extra. TypeScript strict, ESM, no `any` without a comment.
Vitest colocated. Commit at the end (`feat(engine): sync engine`); do not push. Final message: files
changed, commands run with their real results, anything left undone.

## Build `packages/engine` (`@carbon-sync/engine`)

Deps: `@carbon-sync/protocol` (workspace), `reconcile-text` pinned EXACTLY `0.13.2`.
Exports TS source like the protocol package.

- `src/ports.ts`: `FileSystem`, `StateStore`, `SyncState`, `Transport`, `Connection` exactly as PLAN.md.
  `Connection = { send(msg: ClientMessage): void; close(): void; onMessage(cb: (m: ServerMessage) => void): void; onClose(cb: (code: number) => void): void }`.
  `Clock = { setTimeout, clearTimeout, now }` injectable for tests.
- `src/merge.ts`: `merge(base, mine, theirs): string` -> `reconcile(base, mine, theirs, 'Word').text`.
  The ONLY import of reconcile-text in the repo.
- `src/engine.ts`: `class SyncEngine` with constructor `{ fs, state, transport, clock, url, token, debounceMs = 500, onEvent? }`.
  Public API: `start()`, `stop()`, `syncNow()`, `notifyLocalChange(path)`, `notifyLocalDelete(path)`,
  `notifyLocalRename(from, to)`, `status(): 'offline' | 'connecting' | 'syncing' | 'idle'`.
  `onEvent` receives `{ type: 'status' | 'merged' | 'error' | 'applied' | 'pushed', path?, detail? }`.
  Implement rules 1-8 of PLAN.md exactly. Notes:
  - Pending pushes keyed by path; `reqId` = incrementing counter string.
  - Rename: if path tracked and base hash equals current local hash at `to`, send `rename`; on
    `error rename_conflict` or `reject`, fall back to push(create `to`) + push(delete `from`).
  - Persist state after every ack/applied change (debounced 200 ms via clock is fine).
  - deviceId: generated once (crypto.randomUUID) when state has none, then persisted.
  - Paths filtered with protocol `isSyncable` before anything else.
- `src/testing/memory-fs.ts`, `src/testing/memory-state.ts`: in-memory ports for tests.
- `src/testing/loopback.ts`: an in-process fake server implementing the protocol on top of a
  minimal reimplementation is NOT allowed. Instead, import `VaultStore` + `node-sql` from
  `apps/server/src/...` ONLY inside test files (tests may cross the boundary; production code may not),
  and wire a loopback `Transport` that runs frames through a tiny handler mirroring
  `VaultObject.handle` (hello/push/rename/broadcast). Keep it under 120 lines.

## Tests `src/engine.test.ts` (two or three engines against one loopback server, fake clock)

1. Device A creates `a.md`; B receives it.
2. A and B edit different words of the same line while both online -> both converge to merged text,
   no conflict copy, one `merged` event.
3. B offline (transport closed), both edit, B reconnects -> converge, B's offline edit survives.
4. Local delete on A vs remote edit from B -> B's edit wins and A gets the file back.
5. Remote delete vs local unsynced edit -> local wins, file re-created on server.
6. Rename on A arrives at B as rename (old gone, new present with content).
7. Echo suppression: applying a remote change does not trigger a push back (count pushes).
8. Fresh device C with empty state and empty fs joins -> gets every live file, no tombstoned files.
9. Fresh device D with empty state but an existing identical copy of the vault -> no duplicated text,
   no pushes of changed content (hash equal => adopt server base).
10. Debounce: 5 rapid local changes within 500 ms -> one push.
11. Ignored paths (`.obsidian/x.json`, `pic.png`) never pushed.

Rule 9 case needs this engine rule (add it, it is consistent with PLAN.md rule 5): when an incoming row
has no base and the local file exists with the SAME hash, adopt it as base without writing. If it exists
with a DIFFERENT hash and no base, merge with base `""` is wrong (duplicates); instead keep both:
write remote content to the path and save the local version as `<name> (conflict <deviceId-short>).md`,
then push that conflict file. Emit `merged` with detail `conflict-copy`.

## Ordering rules (from the server review, mandatory)

- Process inbound server frames strictly one at a time, in arrival order, through a single async queue.
  Never apply two frames concurrently (file writes are async).
- Persist `cursor` only AFTER the change carrying that seq has been applied to disk and its base saved.
  `ack.cursor` may advance the cursor only through the same queue. A crash must never leave a persisted
  cursor ahead of an unapplied change. Add a test: kill the engine (stop without flush) between receiving
  a change and applying it, restart, the change still arrives via welcome.

## Done when

`npm run typecheck && npm run lint && npm test` pass at the root.
