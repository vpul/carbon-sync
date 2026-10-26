# Brief 03: Worker + VaultObject transport, wrangler config, deploy scripts

Read PLAN.md first (Server, Protocol, Setup). It is the contract; do not change it.

Rules: do exactly this brief, nothing extra. TypeScript strict, ESM. Commit at the end
(`feat(server): worker, durable object, deploy`); do not push. Final message: files changed, commands
run with their real results, anything left undone.

## Build in `apps/server`

- `src/index.ts`: Worker default export `fetch`. Routes exactly as PLAN.md. WebSocket route requires
  `Upgrade: websocket` (426 otherwise), validates vaultId (404 otherwise), forwards the request to
  `env.VAULT.getByName(vaultId)`. Export the `VaultObject` class.
- `src/config.ts`: `type Env = { VAULT: DurableObjectNamespace<VaultObject>; CARBON_TOKEN: string }`
  and `readConfig(env)` that throws a clear error if `CARBON_TOKEN` is missing or shorter than 32 chars.
- `src/transport/vault-object.ts`: `class VaultObject extends DurableObject<Env>`.
  - constructor: `VaultStore` over `ctx.storage.sql` with `ctx.storage.transactionSync`, call `migrate()`
    inside `ctx.blockConcurrencyWhile`. `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'))`.
  - `fetch`: create `WebSocketPair`, `ctx.acceptWebSocket(server)`, attachment `{ authed: false, deviceId: null, openedAt }`,
    schedule an alarm 10 s out if none set (hello timeout sweep), return 101 with client.
  - `webSocketMessage(ws, msg)`: string only (binary -> error bad_request). Parse with `parseClientMessage`.
    Not authed: only `hello` accepted; constant-time token compare (`crypto.subtle.timingSafeEqual` on
    encoded bytes, length check first); wrong -> `ws.close(4401, 'unauthorized')`. Right -> set attachment
    authed + deviceId, send `welcome { cursor, changes: store.changesSince(since) }`.
    Authed: `push` -> compute sha256 via protocol `sha256Hex` (null for delete), `store.push`, send `ack`/`reject`,
    broadcast `change` to every OTHER authed socket (`ctx.getWebSockets()` + attachment check).
    `rename` -> same pattern, conflict -> `error{code:'rename_conflict', reqId}`.
    `ProtocolError` -> send `error{code, message, reqId?}`; never throw out of the handler.
  - `alarm()`: close sockets unauthed for more than 10 s with 4408; re-arm if any unauthed remain.
  - `webSocketClose`/`webSocketError`: close politely, no state to clean.
  - Keep handlers thin: one private `handle(ws, message)` dispatch, logic stays in VaultStore.
- `wrangler.jsonc`: name `carbon-sync`, main `src/index.ts`, current `compatibility_date`,
  `durable_objects.bindings` `VAULT` -> `VaultObject`, `migrations` `[{ tag: "v1", new_sqlite_classes: ["VaultObject"] }]`,
  `observability.enabled: true`.
- `.dev.vars.example`: `CARBON_TOKEN=` with a comment (used by the Deploy to Cloudflare button to prompt).
- `scripts/setup.mjs` (Node, no deps): generates a 32-byte base64url token, runs `wrangler deploy`,
  pipes the token into `wrangler secret put CARBON_TOKEN`, parses the deployed `*.workers.dev` URL from
  wrangler output (or accepts `--url`), and prints a setup code for vault `--vault` (default `main`) using
  the protocol `encodeSetupCode` (import via relative path to the TS is not possible in plain node: duplicate the
  4-line encoder in the script with a comment pointing at the source of truth). Never prints the token
  except inside the setup code.
- package scripts: `dev` (`wrangler dev`), `deploy` (`wrangler deploy`), `setup` (`node scripts/setup.mjs`),
  `typecheck`, `cf-typegen` (`wrangler types`).

## Verify (real, not mocked)

1. `npm run typecheck && npm run lint && npm test` at root.
2. Start `npx wrangler dev --port 8787` in apps/server with a `.dev.vars` containing a 40-char token
   (create it, it is gitignored). Then a small Node 22 script `scripts/smoke.mjs` using the global
   `WebSocket` that: connects to `/v1/vaults/test/ws`, sends hello, expects welcome; pushes `a.md`,
   expects ack rev 1; a second socket receives `change`; a stale push gets `reject`; a bad token gets
   close 4401. Print PASS/FAIL per step and exit non-zero on failure. Run it and include output.
   Stop wrangler dev afterwards.
