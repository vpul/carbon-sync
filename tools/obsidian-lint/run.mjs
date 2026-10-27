// Runs Obsidian's community review rules against the whole repo, the same way
// the directory scanner does, and gates on the code that ships in the plugin.
//
// Gate (exit 1): ANY finding, error or warning, in code bundled into main.js
//   (apps/plugin/src, packages/engine/src, packages/protocol/src).
// Report only: findings in the daemon and server. They are Node and Workers
//   code, so the scanner always warns about Node modules, console output and
//   timers there. Those warnings do not block listing.
//
// Usage: node tools/obsidian-lint/run.mjs   (installs its own deps on first run)

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(toolDir, '..', '..');

const SHIPPED = ['apps/plugin/src/', 'packages/engine/src/', 'packages/protocol/src/'];

if (!existsSync(join(toolDir, 'node_modules', 'eslint'))) {
  console.log('obsidian-lint: installing linter deps (first run)...');
  const install = spawnSync(
    'npm',
    ['ci', '--prefix', toolDir, '--no-audit', '--no-fund', '--loglevel=error'],
    { stdio: 'inherit' },
  );
  if (install.status !== 0) {
    console.error('obsidian-lint: npm ci failed');
    process.exit(1);
  }
}

// The no-unsupported-api rule reads manifest.json from the working directory.
process.chdir(repoRoot);

const require = createRequire(join(toolDir, 'package.json'));
const { ESLint } = await import(pathToFileURL(require.resolve('eslint')).href);

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: join(toolDir, 'eslint.config.mjs'),
});
const results = await eslint.lintFiles(['.']);

const toPosix = (path) => relative(repoRoot, path).split(sep).join('/');
const gated = [];
const reported = new Map();

for (const result of results) {
  const file = toPosix(result.filePath);
  const ships = SHIPPED.some((prefix) => file.startsWith(prefix));
  for (const message of result.messages) {
    const rule = message.ruleId ?? 'parse-error';
    if (ships || message.fatal) {
      const level = message.severity === 2 ? 'error' : 'warning';
      gated.push(
        `${file}:${message.line}:${message.column}  ${level}  ${rule}\n    ${message.message}`,
      );
    } else {
      reported.set(rule, (reported.get(rule) ?? 0) + 1);
    }
  }
}

if (reported.size > 0) {
  const total = [...reported.values()].reduce((sum, count) => sum + count, 0);
  console.log(
    `obsidian-lint: ${total} findings in daemon/server code (report only, not shipped in the plugin):`,
  );
  for (const [rule, count] of [...reported].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${rule}`);
  }
}

if (gated.length > 0) {
  console.error(
    `\nobsidian-lint: ${gated.length} findings in plugin code. The community review will flag these:\n`,
  );
  for (const line of gated) {
    console.error(line);
  }
  process.exit(1);
}

console.log(`obsidian-lint: plugin code clean (${results.length} files scanned)`);
