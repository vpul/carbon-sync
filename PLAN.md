# Carbon Sync: architecture and protocol (v1)

> A carbon copy on every device.

Real-time sync for an Obsidian vault. One Cloudflare Durable Object per vault holds the
current text of every file and pushes changes over WebSockets. Clients (the Obsidian plugin
and a Node daemon for servers) merge concurrent edits with a three-way merge
(`reconcile-text`). The `.md` file on disk is always the source of truth on each device.

## Scope

**v1 (milestone 1):** text files only (`.md`, `.canvas`, `.txt`, `.json` outside `.obsidian/`).
Create, modify, delete, rename. Offline edits merge on reconnect. Single shared secret per deployment.

**Milestone 2:** attachments via R2 (content-addressed by sha256, Durable Object stores path -> hash).
**Not planned:** live cursors, Yjs, end-to-end encryption (maybe later).

## Repo layout (npm workspaces, TypeScript, ESM)

```
packages/protocol   message types, runtime validators, setup-code encode/decode, path rules. Zero deps.
packages/engine     client sync engine. Pure logic behind ports (FileSystem, StateStore, Transport, Clock).
                    Owns the merge wrapper: the ONLY place that imports reconcile-text.
apps/server         Cloudflare Worker + VaultObject (Durable Object, SQLite, hibernating WebSockets).
                    Domain logic in a plain VaultStore class over a tiny SQL interface, testable on node:sqlite.
apps/daemon         Node CLI `carbon-sync` for headless servers: `init`, `sync --once`, `daemon`.
apps/plugin         Obsidian plugin. Thin adapter over the engine. Standard obsidian-sample-plugin structure.
```

Dependency direction: `protocol` <- `engine` <- `daemon`, `plugin`; `protocol` <- `server`.
Nothing imports from an app.

## Server

- Worker routes:
  - `GET /` -> plain text `carbon-sync ok` (health).
  - `GET /v1/vaults/:vaultId/ws` -> WebSocket upgrade, forwarded to `VAULT.getByName(vaultId)`.
  - Everything else 404. `vaultId` must match `^[a-z0-9][a-z0-9-]{0,62}$`.
- Auth: secret `CARBON_TOKEN` (wrangler secret). Browser WebSockets cannot set headers, so the
  client sends `hello` as its first message; the DO compares the token in constant time and closes
  with code 4401 on mismatch, or 4408 if no hello within 10 s. Authenticated state lives in
  `ws.serializeAttachment({ deviceId, authed: true })` so it survives hibernation.
- Uses `ctx.acceptWebSocket` (Hibernation API) and `setWebSocketAutoResponse` for ping/pong.
- SQLite schema (one table, one meta row):

```sql
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  rev        INTEGER NOT NULL,     -- per-file revision, starts at 1, +1 on every accepted write
  seq        INTEGER NOT NULL,     -- global change sequence at last write (vault cursor)
  deleted    INTEGER NOT NULL DEFAULT 0,  -- tombstone
  content    TEXT,                 -- NULL when deleted
  hash       TEXT,                 -- sha256 hex of content, NULL when deleted
  device_id  TEXT NOT NULL,
  updated_at INTEGER NOT NULL      -- ms epoch
);
CREATE INDEX IF NOT EXISTS files_seq ON files(seq);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL); -- k='seq'
```

- Catch-up needs no separate log: `SELECT * FROM files WHERE seq > ? ORDER BY seq`.
- Writes are serialized by the DO; every accepted write bumps `meta.seq` and sets the row's `seq`.
- Max content size 1 MiB (UTF-8 bytes) per file; larger -> `error{code:'too_large'}`.

## Protocol (JSON text frames, `v: 1`)

Client -> server:

| type | fields | meaning |
|---|---|---|
| `hello` | `token, deviceId, since` | first frame. `since` = last cursor the client applied, 0 for fresh |
| `push` | `reqId, path, baseRev, content` | write. `baseRev` 0 = create. `content: null` = delete |
| `rename` | `reqId, from, to, baseRev` | move `from` (at `baseRev`) to `to` (must not exist or be a tombstone) |

Server -> client:

| type | fields | meaning |
|---|---|---|
| `welcome` | `cursor, changes[]` | every row with `seq > since` (tombstones included), then the current cursor |
| `ack` | `reqId, path, rev, cursor` | write accepted |
| `reject` | `reqId, path, current` | `baseRev` stale. `current = {rev, content}` (content null if deleted) |
| `change` | `cursor, change` | broadcast to every OTHER authed socket after an accepted write |
| `error` | `reqId?, code, message` | `bad_request`, `too_large`, `unauthorized`, `rename_conflict` |

`change = { path, rev, deleted, content, hash, deviceId, seq }`. A rename is broadcast as two
changes (tombstone for `from`, create for `to`) with consecutive seqs.

Push rules on the server:
- row missing or tombstoned: accept only if `baseRev === 0` or `baseRev === row.rev` (tombstone).
- row live: accept only if `baseRev === row.rev`, else `reject` with current.
- delete of a missing row: ack with rev 0 (idempotent).
- identical content to the live row with matching baseRev: ack without bumping rev/seq.

## Client engine

Ports (interfaces in `packages/engine/src/ports.ts`):

```ts
interface FileSystem {
  list(): Promise<string[]>;                       // vault-relative POSIX paths, already filtered
  read(path: string): Promise<string | null>;      // null if missing
  write(path: string, content: string): Promise<void>;  // creates parent folders
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}
interface StateStore {        // persisted per device per vault
  load(): Promise<SyncState>;
  save(state: SyncState): Promise<void>;
}
interface SyncState { cursor: number; deviceId: string; files: Record<string, { rev: number; hash: string; base: string }> }
interface Transport { connect(url: string): Promise<Connection> }  // wraps WebSocket
```

Engine rules (this is the heart; every rule gets a test):
1. **Base** = the last content both this device and the server agreed on, with its `rev`.
2. Local change event -> debounce 500 ms per path -> `push{baseRev: base.rev, content}`.
   One in-flight push per path; if the file changes while in flight, push again after the ack.
3. `ack` -> base = what was sent, rev = ack.rev, cursor = max(cursor, ack.cursor). Persist.
4. `reject` -> `merged = merge(base, local, current.content)`; write merged locally if it differs;
   base = current; push merged with `baseRev = current.rev`. Remote delete + local edit -> local wins
   (push as create with baseRev = current.rev). Local delete + remote edit -> remote wins (write it back).
5. Incoming `change` / `welcome` row:
   - local hash == base hash (no unsynced local edit): apply remote (write or remove), base = remote.
   - local edited: `merge(base, local, remote)`, write, base = remote, then push merged.
   - ignore rows with `rev <= base.rev`.
6. On (re)connect after `welcome`: scan `fs.list()`; untracked files -> push create; tracked files whose
   hash differs from base -> push; tracked files missing locally -> push delete.
7. **Echo suppression:** no per-write hash bookkeeping. A local event is dropped when the path's content
   hash already equals the tracked base hash, so a real edit back to an old echo is still pushed.
8. Reconnect with exponential backoff (1 s -> 30 s, jitter). `syncNow()` forces reconnect + full scan.
9. Path filter (in `protocol`): skip `.obsidian/`, `.trash/`, `.git/`, `.carbon/`, dotfiles, and
   non-text extensions. Configurable extra ignore globs.

Merge wrapper (`packages/engine/src/merge.ts`): `merge(base, mine, theirs): string` calls
`reconcile(base, mine, theirs, 'Word').text`. Pinned exact version `reconcile-text@0.13.2`.
Every automatic merge is reported through an `onMerge` event so apps can log it.

## Setup (as simple as possible)

- **Setup code** = `carbon1:` + base64url(JSON `{ url, vault, token }`). One string carries everything.
- Server side: `npm run setup -w apps/server` generates a token, runs `wrangler secret put`, deploys,
  and prints the setup code. The "Deploy to Cloudflare" button path prompts for `CARBON_TOKEN`
  (from `.dev.vars.example`).
- Plugin settings: one text field "Setup code" + **Connect** button. Connect validates, does a live
  hello, and shows `Connected · N files`. Advanced (collapsed): ignore globs, debounce, device name.
- Daemon: `carbon-sync init --code <setup-code> --dir ~/vault` writes `~/.config/carbon-sync/<vault>.json`,
  then `carbon-sync daemon --vault <vault>` (or `sync --once` for cron). Ships a systemd unit example.

## Conventions (Tao of Node, applied)

- Structure by component, not by technical role. Inside an app: `transport` (WebSocket/HTTP/CLI/Obsidian
  events) -> `domain` (pure logic) -> `data` (SQL, fs, state). Handlers stay thin; no logic in them.
- Validate every inbound frame at the edge with the `protocol` validators; domain code trusts its types.
- Config read once in a `config.ts` per app; nothing else touches `process.env`/settings directly.
- Errors: typed error classes in `protocol`; one place per app maps them to wire errors / notices.
- Prefer plain functions and small classes with injected dependencies; no singletons, no globals.
- TypeScript strict, ESM, Node 22. Biome for lint+format. Vitest for tests, colocated as `*.test.ts`.
- Small dependencies only: `reconcile-text`, `obsidian` (types), `esbuild`, `wrangler`, `vitest`, `@biomejs/biome`, `typescript`.
  Daemon uses Node built-ins only (global `WebSocket`, `fs.watch` recursive, `node:util` parseArgs).

## Milestones

- **M1** markdown sync: protocol, server, engine, daemon, plugin, e2e test (wrangler dev + 2 daemons).
- **M2** attachments on R2.
- **M3** (maybe) own diff3 merge behind the same `merge()` signature, chosen by the M1 test suite.
