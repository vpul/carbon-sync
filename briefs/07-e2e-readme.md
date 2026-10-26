# Brief 07: end-to-end test, README, deploy docs

Read PLAN.md first. It is the contract; do not change it.

Rules: do exactly this brief, nothing extra. Commit at the end (`test: e2e` and `docs: readme`); do not
push. Final message: files changed, commands run with their real results, anything left undone.

## e2e (`tests/e2e/two-daemons.test.mjs`, run by root script `npm run e2e`, NOT part of `npm test`)

Plain Node 22 script using `node:test`:
1. Build the daemon. Write `apps/server/.dev.vars` with a random 40-char token if absent.
2. Start `wrangler dev --port 8799 --persist-to <tmp>` in apps/server; wait until `GET /` says ok.
3. Two temp vault dirs A and B, two temp XDG config/state dirs. `carbon-sync init` both with a setup code
   for vault `e2e`, start both daemons.
4. Scenarios, each with a 10 s poll-until-equal helper:
   - create `note.md` in A -> appears in B with same content.
   - edit different words in A and B within 100 ms -> both converge to the same text containing both edits.
   - delete in B -> gone in A.
   - stop daemon B, edit in A and B, start B -> converge, both edits present.
   - `.obsidian/x.json` and `pic.png` in A never appear in B.
   - nested folder `a/b/c.md` created in A appears in B.
5. Kill everything in `finally`. Print a PASS/FAIL line per scenario.

## README.md (root)

Sections, short and plain (no em dashes, no hype): what it is (one paragraph), how it works (5 bullets),
Setup in 3 steps (deploy: `npm install && npm run setup -w apps/server -- --vault brain`; plugin: install via
BRAT or copy `main.js manifest.json styles.css` into `.obsidian/plugins/carbon-sync/`, paste setup code,
Connect; server: `carbon-sync init --code ... --dir ~/vault` then the systemd unit), the "Deploy to
Cloudflare" button markdown pointing at `https://github.com/vpul/carbon-sync/tree/main/apps/server`
with a note that it needs the repo public, limits (text only in v1, 1 MiB per file, no E2E encryption,
merges never show conflict markers so keep backups/git), cost on the Workers free plan, development
commands, license MIT.

## Done when
`npm run e2e` passes and its output is in the final message.
