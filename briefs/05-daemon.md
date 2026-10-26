# Brief 05: Node daemon CLI (`carbon-sync`)

Read PLAN.md first (Client engine, Setup, Conventions). It is the contract; do not change it.

Rules: do exactly this brief, nothing extra. TypeScript strict, ESM, Node 22 built-ins only (no runtime
deps besides workspace packages). Vitest colocated. Commit at the end (`feat(daemon): cli`); do not push.
Final message: files changed, commands run with their real results, anything left undone.

## Build `apps/daemon` (`carbon-sync`, bin `carbon-sync`)

Layout (transport -> domain -> data):
- `src/cli.ts` (transport): `node:util` `parseArgs`. Commands:
  - `init --code <setup-code> --dir <path> [--name <alias>]` -> decode setup code, write config to
    `$XDG_CONFIG_HOME/carbon-sync/<alias>.json` (default alias = vault id), mode 600. Refuse if `--dir` missing.
  - `sync --vault <alias> [--timeout 60]` -> connect, wait for welcome + full scan + all pending acks, exit 0;
    exit 1 on auth failure or timeout. For cron.
  - `daemon --vault <alias>` -> run forever, reconnect with backoff, watch the folder, log one line per event.
    SIGINT/SIGTERM: flush state, close socket, exit 0.
  - `status --vault <alias>` -> print config path, dir, server url, cursor, tracked file count. Never the token.
  - `--help` text for each.
- `src/config.ts`: load/save config `{ url, vault, token, dir, ignore: string[] }`; the only place that reads
  env (`XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `HOME`).
- `src/data/node-fs.ts`: `FileSystem` port over `node:fs/promises` rooted at `dir`. Writes are atomic
  (write temp file in same dir then rename). `list()` walks recursively, returns POSIX relative paths that
  pass `isSyncable`. Rejects any path that resolves outside `dir`.
- `src/data/file-state.ts`: `StateStore` persisted to `$XDG_STATE_HOME/carbon-sync/<alias>.state.json`
  (atomic write). NOT inside the vault.
- `src/data/ws-transport.ts`: `Transport` over global `WebSocket`; URL = `<url>/v1/vaults/<vault>/ws`
  with http->ws, https->wss.
- `src/domain/watcher.ts`: `fs.watch(dir, { recursive: true })`; debounce per path is the engine's job, the
  watcher only maps events: after an event, stat the path; exists -> `notifyLocalChange`, missing ->
  `notifyLocalDelete`. Renames arrive as delete + change, that is fine for the daemon.
- `src/main.ts`: wires ports + engine; no logic.
- Build: esbuild bundle to `dist/carbon-sync.mjs` (platform node, format esm, banner shebang,
  `mainFields: ['module','main']` so reconcile-text resolves its node build). Scripts `build`, `typecheck`.
- `systemd/carbon-sync@.service`: user unit template, `ExecStart=%h/.local/bin/carbon-sync daemon --vault %i`,
  `Restart=always`, `RestartSec=5`.

## Tests
- node-fs: write/read/remove/rename in a temp dir; atomic write leaves no temp files; path escape rejected;
  `list()` skips `.obsidian/` and `.png`.
- file-state: save then load round-trips; missing file -> fresh state.
- config: init writes mode 600 and status output never contains the token.

## Done when
Root `npm run typecheck && npm run lint && npm test` pass and `npm run build -w apps/daemon` produces
`dist/carbon-sync.mjs` that prints help with `node apps/daemon/dist/carbon-sync.mjs --help`.
