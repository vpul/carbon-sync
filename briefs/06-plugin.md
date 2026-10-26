# Brief 06: Obsidian plugin

Read PLAN.md first (Client engine, Setup). It is the contract; do not change it.

Rules: do exactly this brief, nothing extra. TypeScript strict, ESM source, no `any` without a comment.
Commit at the end (`feat(plugin): obsidian plugin`); do not push. Final message: files changed, commands
run with their real results, anything left undone.

## Structure (follow obsidianmd/obsidian-sample-plugin conventions)

```
apps/plugin/
  manifest.json        id "carbon-sync", name "Carbon Sync", version "0.1.0", minAppVersion "1.5.0",
                       description "Real-time vault sync through your own Cloudflare Durable Object.",
                       author "Vipul Chaudhary", isDesktopOnly false
  versions.json        {"0.1.0": "1.5.0"}
  esbuild.config.mjs   bundle src/main.ts -> main.js (cjs, platform browser, target es2020,
                       external: obsidian, electron, @codemirror/*, @lezer/*, builtin node modules;
                       mainFields ['browser','module','main'] so reconcile-text uses its web build;
                       `npm run dev` watches, `npm run build` minifies, no sourcemap in production)
  styles.css           tiny: status bar dot colors
  src/main.ts          Plugin subclass: wiring only
  src/settings/settings.ts       settings type + defaults + load/save (the plugin's config.ts)
  src/settings/settings-tab.ts   PluginSettingTab UI
  src/adapters/vault-fs.ts       FileSystem port over app.vault (adapter API for exact paths)
  src/adapters/plugin-state.ts   StateStore persisted as JSON in the plugin folder
                                 (`.obsidian/plugins/carbon-sync/state.json` via vault.adapter),
                                 NOT in data.json (keeps settings small and readable)
  src/adapters/ws-transport.ts   Transport over window.WebSocket
  src/ui/status-bar.ts           status bar item: "● synced" / "↻ syncing" / "○ offline", click = sync now
```

## Behaviour

- Settings tab, top: one text input "Setup code" (password-style), button **Connect**. Connect decodes the
  code, saves it, starts the engine, and shows the result inline: `Connected · N files` or the error
  (`Wrong token`, `Server unreachable`, `Invalid setup code`). If already connected: shows vault id + server
  host + a **Disconnect** button. Below a collapsed "Advanced" section: extra ignore globs (textarea, one per
  line), debounce ms, "Show a notice when notes are merged" toggle (default on).
- Engine starts on `onLayoutReady` if a setup code is saved. Stops on `onunload`.
- Vault events (`registerEvent`): create/modify -> `notifyLocalChange`, delete -> `notifyLocalDelete`,
  rename -> `notifyLocalRename`. Only TFile, only syncable paths.
- Engine `merged` event -> `new Notice('Carbon Sync merged edits in <path>')` when the toggle is on.
- Mobile: on `document` `visibilitychange` to visible -> `syncNow()`. Register with `registerDomEvent`.
- Commands: "Sync now", "Reconnect", "Copy diagnostics" (status, cursor, tracked count, no token).
- vault-fs `write` must create missing parent folders and use `vault.modify` for existing TFiles
  (so open editors refresh) and `vault.create` for new ones; `remove` uses `app.fileManager.trashFile`
  so deletes go to the user's trash setting.

## Done when
Root `npm run typecheck && npm run lint && npm test` pass; `npm run build -w apps/plugin` produces
`apps/plugin/main.js`; report its size. Add a tiny test for settings defaults/merge of saved data.
