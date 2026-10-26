# Carbon Sync

Carbon Sync keeps an Obsidian vault in sync across devices through a Cloudflare Worker you deploy
yourself. Each vault gets one Durable Object that stores the current text of every file in SQLite and
pushes changes to connected clients over WebSockets. The Obsidian plugin and a small Node daemon for
servers use the same sync engine. When two devices edit the same file, a three-way word merge combines
both edits.

## How it works

- One Cloudflare Worker and one Durable Object per vault. The Durable Object is the source of truth for
  revisions and change order.
- File text lives in the Durable Object's SQLite database. Every accepted write bumps the file revision
  and a vault-wide sequence, and deleted files stay as tombstones.
- Clients open a WebSocket, send a `hello` with the last cursor they applied, and receive every change
  after that cursor before syncing live.
- Each device keeps a base revision and base content per file. Local changes are debounced, pushed with
  their base revision, then acked or merged when the revision is stale.
- Concurrent edits are merged with `reconcile-text` (word diff). The file on disk is always the source of
  truth on that device.

## Setup in 3 steps

### 1. Deploy the server

```sh
npm install && npm run setup -w apps/server -- --vault brain
```

This deploys the Worker, stores a random token as the `CARBON_TOKEN` secret, and prints a `carbon1:`
setup code. Run `npx wrangler login` first.

Or use the button:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://github.com/vpul/carbon-sync/tree/main/apps/server)

The button needs this repository to be public. It prompts for `CARBON_TOKEN`; generate a value with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.

### 2. Install the Obsidian plugin

Install with [BRAT](https://github.com/TfTHacker/obsidian42-brat) using `vpul/carbon-sync`, or copy
`main.js`, `manifest.json`, and `styles.css` from `apps/plugin` into
`<vault>/.obsidian/plugins/carbon-sync/` and enable Carbon Sync in Community plugins. Paste the setup
code into settings and click Connect.

### 3. Sync a server vault

Build the daemon and put it on your PATH, then initialize the vault:

```sh
npm run build -w apps/daemon
mkdir -p ~/.local/bin
install -m 755 apps/daemon/dist/carbon-sync.mjs ~/.local/bin/carbon-sync
carbon-sync init --code 'carbon1:...' --dir ~/vault
carbon-sync daemon --vault brain
```

To run it as a user service, copy `apps/daemon/systemd/carbon-sync@.service` to
`~/.config/systemd/user/` and run:

```sh
systemctl --user enable --now carbon-sync@brain
```

## Limits

- Text files only in v1: `.md`, `.canvas`, `.txt`, and `.json` outside `.obsidian/`.
- 1 MiB per file.
- No end-to-end encryption. The server can read every file.
- Merges never write conflict markers. Keep backups or keep the vault in git.

## Cost

A personal vault fits the Workers free plan, including the Durable Object with SQLite storage and
WebSocket connections. Check Cloudflare's current pricing page for the exact limits.

## Development

Node 22 and npm workspaces.

```sh
npm install
npm run typecheck
npm test          # unit tests with vitest
npm run lint      # biome
npm run e2e       # wrangler dev plus two daemons
npm run dev -w apps/server
npm run build -w apps/daemon
npm run build -w apps/plugin
```

`npm run e2e` builds the daemon, starts `wrangler dev` on port 8799 with temporary state, and runs two
daemons against temporary vaults. It is not part of `npm test`.

## License

MIT. See [LICENSE](LICENSE).
