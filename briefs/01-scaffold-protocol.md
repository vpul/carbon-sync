# Brief 01: monorepo scaffold + protocol package

Read PLAN.md first. It is the contract (protocol, schema, engine rules, layout). Do not change it;
if something in it is impossible, stop and say so in your final message.

Rules: do exactly this brief, nothing extra. TypeScript strict, ESM, Node 22, no `any` without a
comment saying why. Vitest, colocated `*.test.ts`. Never touch `~/brain` or any real vault; tests use
temp dirs only. Commit at the end with a conventional message; do not push. Final message: files
changed, commands run with their real results, anything left undone.

## Build

1. Root `package.json`: `"private": true`, `"type": "module"`, npm workspaces
   `["packages/*", "apps/*"]`, engines node >=22. Scripts:
   - `typecheck`: `tsc -b` (project references) or per-workspace `npm run typecheck --workspaces --if-present`
   - `lint`: `biome check .`
   - `format`: `biome format --write .`
   - `test`: `vitest run`
   devDependencies (exact versions, latest stable): `typescript`, `vitest`, `@biomejs/biome`, `@types/node`.
2. `tsconfig.base.json`: strict, `target` ES2022, `module`/`moduleResolution` `Bundler`,
   `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `isolatedModules`, `skipLibCheck`.
3. `biome.json`: recommended rules, 2-space indent, line width 100, ignore `dist`, `node_modules`, `.wrangler`.
4. `vitest.config.ts` at root using `test.projects` (or workspace) covering `packages/*` and `apps/*`.
5. `.gitignore`: node_modules, dist, .wrangler, .dev.vars, coverage, *.log, main.js in apps/plugin.
6. `.editorconfig`, MIT `LICENSE` (Vipul Chaudhary, 2026).

## packages/protocol (`@carbon-sync/protocol`, zero runtime deps)

Source in `src/`, exported from `src/index.ts`, consumed as TS source by other workspaces
(`"exports": { ".": "./src/index.ts" }`, `"types"` same). Files:

- `src/messages.ts`: TypeScript types for every frame in PLAN.md (`ClientMessage`, `ServerMessage`
  unions discriminated on `type`, plus `Change`), `PROTOCOL_VERSION = 1`, `MAX_CONTENT_BYTES = 1048576`,
  close codes `CLOSE_UNAUTHORIZED = 4401`, `CLOSE_HELLO_TIMEOUT = 4408`.
- `src/validate.ts`: `parseClientMessage(raw: string): ClientMessage` and
  `parseServerMessage(raw: string): ServerMessage`. Hand-written checks (no zod). Throw
  `ProtocolError` (from `src/errors.ts`, has `code: 'bad_request' | 'too_large' | 'unauthorized' | 'rename_conflict'`)
  on anything malformed: wrong types, unknown `type`, invalid path, negative revs, oversized content.
- `src/paths.ts`: `isValidPath(p)` (relative POSIX, no leading `/`, no `..` segment, no `\\`, no NUL,
  length <= 512) and `isSyncable(p, extraIgnore: string[] = [])` implementing PLAN.md rule 9
  (skip `.obsidian/`, `.trash/`, `.git/`, `.carbon/`, any segment starting with `.`, allow only
  `.md .canvas .txt .json`). Extra ignore entries are simple globs supporting `*` and `**`; implement a
  tiny glob-to-RegExp, no dependency.
- `src/setup-code.ts`: `encodeSetupCode({url, vault, token})` -> `carbon1:` + base64url(JSON) and
  `decodeSetupCode(code)` that validates url (http/https), vault id regex from PLAN.md, token length >= 32.
  Use only `btoa`/`atob` + TextEncoder so it works in Workers, browsers and Node.
- `src/hash.ts`: `sha256Hex(text: string): Promise<string>` using `globalThis.crypto.subtle`.
- `src/vault-id.ts`: `VAULT_ID_RE` and `isValidVaultId`.

## Tests (colocated)

Cover: every message type round-trips through its parser; each malformed case throws ProtocolError with the
right code; path validity and syncable filter (include `notes/a.md` yes, `.obsidian/app.json` no,
`img.png` no, `a/../b.md` invalid, glob `Private/**` excludes `Private/x/y.md`); setup code round-trip,
rejects bad prefix / bad url / short token; sha256 of `"abc"` equals the known vector.

## Done when

`npm install && npm run typecheck && npm run lint && npm test` all pass from the root. Commit
`chore: scaffold monorepo` and `feat(protocol): messages, validation, paths, setup code` (one or two commits).
