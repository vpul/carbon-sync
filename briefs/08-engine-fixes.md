# Brief 08: engine fixes from review

Read PLAN.md and `packages/engine/src/engine.ts` first. Fix exactly these issues. Each fix gets a
regression test in `packages/engine/src/engine.test.ts` that FAILS before the fix (write it first,
run it, see it fail, then fix).

Rules: TypeScript strict, no `any`. Commit at the end (`fix(engine): review fixes`); do not push. Final
message: files changed, the failing-then-passing test names, commands run with real results.

## 1. Stale echo hashes can swallow a real edit (bug)

`recordEcho`/`consumeEcho` leave a hash behind when the file watcher never reports the engine's own
write (fs.watch coalesces events). Later, if the user edits the file to Y and then back to the echoed
content X, `consumeEcho(X)` returns true and the push is skipped: the device diverges silently.
The base-hash check in `sendPush` (`existing.hash === hash`) already suppresses real echoes.
**Fix:** delete the echo map entirely (`echoes`, `recordEcho`, `consumeEcho`, `ECHO_LIMIT`).
**Test:** remote change writes X to `a.md` with NO local event delivered; local edits to Y (pushed);
local edits back to X -> a push with content X must be sent and acked. Existing test 7 (no push back after
applying a remote change) must still pass.

## 2. Server reset or new Durable Object strands the device (bug)

If the server state is lost (new deploy name, DO wiped), `welcome.cursor` is lower than the device's
saved cursor and `welcome.changes` is empty, so the device believes it is in sync and never re-uploads.
Also `handleReject` treats `current = {rev: 0, content: null}` as stale when the state has a higher rev,
so the push is dropped forever.
**Fix A:** in `handleWelcome`, if `frame.cursor < this.state.cursor`: emit
`{type:'error', detail:'server-reset'}`, reset `state.cursor = 0` and `state.files = {}`, persist, then
force a reconnect (`syncNow()`); the fresh welcome (since 0) then behaves like a new device (identical
files adopted, local-only files pushed as creates).
**Fix B:** in `handleReject`, when `current.rev === 0 && current.content === null`, delete
`state.files[path]`, add the path back to `pendingPaths`, persist, pump (re-push as create).
**Tests:** (a) sync two files, replace the loopback server with a fresh empty one, reconnect -> both
files exist on the new server with the same content. (b) state says `a.md` rev 5, server has no row ->
local edit is pushed and acked as rev 1.

## 3. User ignore globs are not honoured by the engine (gap)

The engine calls `isSyncable(path)` without the user's extra ignore globs, so a remote change to an
ignored path is still written locally.
**Fix:** add `ignore?: readonly string[]` to `SyncEngineOptions`; every `isSyncable` call passes it.
Wire it in `apps/daemon/src/main.ts` (config.ignore) and `apps/plugin/src/main.ts` (settings ignore list).
**Test:** engine with ignore `['Private/**']` receives a remote change to `Private/x.md` -> not written,
cursor still advances.

## 4. Split the engine (Tao of Node: small modules, pure domain logic)

`engine.ts` is 967 lines and `applyChange` and `handleReject` duplicate the same three-way decision.
Extract a pure function in `packages/engine/src/resolve.ts`:

```ts
export type Resolution =
  | { action: 'noop-adopt' }                          // local already equals remote
  | { action: 'write-remote' }                        // no local edit, or local deleted vs remote edit
  | { action: 'remove-local' }                        // remote delete, no local edit
  | { action: 'keep-local-push' }                     // remote delete vs local edit
  | { action: 'merge'; merged: string }               // both edited, shared base
  | { action: 'conflict-copy' };                      // both have content, no shared base, differ
export function resolve(input: { base: string | null; local: string | null; remote: string | null }): Resolution
```
(`base` null = no shared base or tombstone; compare by string equality, hashing stays in the engine.)
`applyChange` and `handleReject` both call it and only perform the I/O for the chosen action. Add a
table-driven `resolve.test.ts` covering every row. Behaviour must not change: all existing engine tests
pass unmodified (except deleting echo-specific internals if a test reached into them).

## Done when
Root `npm run typecheck && npm run lint && npm test` pass.
