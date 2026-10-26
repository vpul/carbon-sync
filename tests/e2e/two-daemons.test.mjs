// End-to-end test: one `wrangler dev` server, two `carbon-sync` daemons.
// Plain Node 22 with node:test. Run with `npm run e2e`; not part of `npm test`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverDir = path.join(repoRoot, 'apps', 'server');
const daemonBin = path.join(repoRoot, 'apps', 'daemon', 'dist', 'carbon-sync.mjs');
const require = createRequire(import.meta.url);
const wranglerBin = path.join(
  path.dirname(require.resolve('wrangler/package.json')),
  JSON.parse(await readFile(require.resolve('wrangler/package.json'), 'utf8')).bin.wrangler,
);

const PORT = 8799;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const VAULT = 'e2e';
const POLL_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fatal(message) {
  return Object.assign(new Error(message), { fatal: true });
}

function tail(text, lines = 40) {
  return text.split('\n').slice(-lines).join('\n');
}

/** Poll `predicate` every 100 ms for up to `timeoutMs`; include the last error on timeout. */
async function until(description, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      if (error?.fatal === true) {
        throw error;
      }
      lastError = error;
    }
    await sleep(POLL_MS);
  }
  const detail = lastError === null ? '' : `: ${lastError.message}`;
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${description}${detail}`);
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function waitExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function stopProcess(child, label) {
  if (child === null || child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  if (await waitExit(child, 5000)) {
    return;
  }
  child.kill('SIGKILL');
  if (!(await waitExit(child, 2000))) {
    throw new Error(`${label} did not exit after SIGKILL`);
  }
}

async function stopProcessGroup(child, label) {
  if (child === null || child.exitCode !== null) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  if (await waitExit(child, 8000)) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  if (!(await waitExit(child, 2000))) {
    throw new Error(`${label} did not exit after SIGKILL`);
  }
}

/** Read the token from apps/server/.dev.vars, creating the file when absent. */
async function ensureDevVars() {
  const file = path.join(serverDir, '.dev.vars');
  let raw = null;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  const existing = raw?.match(/^CARBON_TOKEN=(.*)$/m)?.[1]?.trim() ?? '';
  if (existing.length >= 32) {
    return existing;
  }
  const token = randomBytes(30).toString('base64url'); // 40 characters
  await writeFile(file, `CARBON_TOKEN=${token}\n`, 'utf8');
  return token;
}

function buildDaemon() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'build', '-w', 'apps/daemon'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`daemon build failed with status ${result.status}`);
  }
}

function encodeSetupCode({ url, vault, token }) {
  const json = JSON.stringify({ url, vault, token });
  return `carbon1:${Buffer.from(json, 'utf8').toString('base64url')}`;
}

function daemonEnv(configHome, stateHome, home) {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
  };
}

function initVault({ dir, configHome, stateHome, home, code }) {
  const result = spawnSync(process.execPath, [daemonBin, 'init', '--code', code, '--dir', dir], {
    env: daemonEnv(configHome, stateHome, home),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`carbon-sync init failed: ${result.stderr || result.stdout}`);
  }
}

function startDaemon({ configHome, stateHome, home }) {
  const child = spawn(process.execPath, [daemonBin, 'daemon', '--vault', VAULT], {
    env: daemonEnv(configHome, stateHome, home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  const append = (chunk) => {
    child.output += chunk.toString();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return child;
}

async function waitForIdle(child, label, timeoutMs = 20_000) {
  await until(
    `${label} to report idle`,
    async () => {
      if (child.exitCode !== null) {
        throw fatal(`${label} exited with ${child.exitCode}:\n${tail(child.output)}`);
      }
      return / status idle\b/.test(child.output);
    },
    timeoutMs,
  );
}

test('two daemons sync end to end', { timeout: 300_000 }, async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'carbon-sync-e2e-'));
  const home = path.join(tmp, 'home');
  const persistDir = path.join(tmp, 'wrangler');
  const vaultA = path.join(tmp, 'vault-a');
  const vaultB = path.join(tmp, 'vault-b');
  const envA = {
    configHome: path.join(tmp, 'config-a'),
    stateHome: path.join(tmp, 'state-a'),
    home,
  };
  const envB = {
    configHome: path.join(tmp, 'config-b'),
    stateHome: path.join(tmp, 'state-b'),
    home,
  };

  let wrangler = null;
  let wranglerLog = '';
  let daemonA = null;
  let daemonB = null;

  const noteA = path.join(vaultA, 'note.md');
  const noteB = path.join(vaultB, 'note.md');
  const mergeA = path.join(vaultA, 'merge.md');
  const mergeB = path.join(vaultB, 'merge.md');

  try {
    await mkdir(home, { recursive: true });
    await mkdir(persistDir, { recursive: true });
    await mkdir(vaultA, { recursive: true });
    await mkdir(vaultB, { recursive: true });

    buildDaemon();
    const token = await ensureDevVars();

    wrangler = spawn(
      process.execPath,
      [wranglerBin, 'dev', '--port', String(PORT), '--persist-to', persistDir],
      {
        cwd: serverDir,
        env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    wrangler.stdout.on('data', (chunk) => {
      wranglerLog += chunk.toString();
    });
    wrangler.stderr.on('data', (chunk) => {
      wranglerLog += chunk.toString();
    });

    await until(
      'wrangler dev health check',
      async () => {
        if (wrangler.exitCode !== null) {
          throw fatal(`wrangler dev exited with ${wrangler.exitCode}:\n${tail(wranglerLog)}`);
        }
        const response = await fetch(`${BASE_URL}/`);
        return response.ok && (await response.text()).trim() === 'carbon-sync ok';
      },
      60_000,
    );

    const code = encodeSetupCode({ url: BASE_URL, vault: VAULT, token });
    initVault({ dir: vaultA, ...envA, code });
    initVault({ dir: vaultB, ...envB, code });

    daemonA = startDaemon(envA);
    await waitForIdle(daemonA, 'daemon A');
    daemonB = startDaemon(envB);
    await waitForIdle(daemonB, 'daemon B');

    const scenarios = [
      [
        'create note.md in A appears in B with the same content',
        async () => {
          const content = '# Note\n\ncreated in A\n';
          await writeFile(noteA, content);
          await until(
            'note.md to appear in B with the same content',
            async () => (await readText(noteB)) === content,
          );
        },
      ],
      [
        'concurrent edits to different words merge on both devices',
        async () => {
          const base = 'alpha beta gamma\n';
          await writeFile(mergeA, base);
          await until(
            'merge.md baseline to reach B',
            async () => (await readText(mergeB)) === base,
          );

          // Fire both edits without waiting between them.
          const started = Date.now();
          await Promise.all([
            writeFile(mergeA, 'ALPHA beta gamma\n'),
            writeFile(mergeB, 'alpha BETA gamma\n'),
          ]);
          const gap = Date.now() - started;

          await until('both devices to converge on the merged text', async () => {
            const a = await readText(mergeA);
            const b = await readText(mergeB);
            return (
              a !== null &&
              a === b &&
              a.includes('ALPHA') &&
              a.includes('BETA') &&
              !a.includes('<<<<<<<')
            );
          });
          console.log(`  concurrent writes issued ${gap} ms apart`);
        },
      ],
      [
        'delete in B removes the file in A',
        async () => {
          await rm(noteB);
          await until('note.md deletion to reach A', async () => (await readText(noteA)) === null);
        },
      ],
      [
        'offline edits on B merge after restart',
        async () => {
          // Let the previous merge settle before taking B offline.
          await sleep(1200);
          await stopProcess(daemonB, 'daemon B');
          daemonB = null;

          const merged = await readText(mergeA);
          assert.ok(merged !== null, 'merge.md missing on A before offline scenario');
          const stem = merged.trimEnd();
          await writeFile(mergeA, `${stem} offline-a\n`);
          await writeFile(mergeB, `${stem} offline-b\n`);

          await sleep(1000); // let A push while B is down
          daemonB = startDaemon(envB);
          await waitForIdle(daemonB, 'daemon B (restarted)');

          await until('offline edits to converge on both devices', async () => {
            const a = await readText(mergeA);
            const b = await readText(mergeB);
            return a !== null && a === b && a.includes('offline-a') && a.includes('offline-b');
          });
        },
      ],
      [
        '.obsidian/ and non-text files from A never appear in B',
        async () => {
          await mkdir(path.join(vaultA, '.obsidian'), { recursive: true });
          await writeFile(path.join(vaultA, '.obsidian', 'x.json'), '{"x":1}\n');
          await writeFile(path.join(vaultA, 'pic.png'), 'not really a png');
          await sleep(2500);

          assert.equal(
            await readText(path.join(vaultB, '.obsidian', 'x.json')),
            null,
            '.obsidian/x.json leaked into B',
          );
          assert.equal(await readText(path.join(vaultB, 'pic.png')), null, 'pic.png leaked into B');
        },
      ],
      [
        'nested a/b/c.md created in A appears in B',
        async () => {
          const content = '# nested\n';
          await mkdir(path.join(vaultA, 'a', 'b'), { recursive: true });
          await writeFile(path.join(vaultA, 'a', 'b', 'c.md'), content);
          await until(
            'nested a/b/c.md to appear in B',
            async () => (await readText(path.join(vaultB, 'a', 'b', 'c.md'))) === content,
          );
        },
      ],
    ];

    let failures = 0;
    for (const [name, run] of scenarios) {
      try {
        await run();
        console.log(`PASS ${name}`);
      } catch (error) {
        failures += 1;
        console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
        if (daemonA !== null) {
          console.log(`--- daemon A log ---\n${tail(daemonA.output)}`);
        }
        if (daemonB !== null) {
          console.log(`--- daemon B log ---\n${tail(daemonB.output)}`);
        }
      }
    }
    assert.equal(failures, 0, `${failures} scenario(s) failed`);
  } finally {
    await stopProcess(daemonA, 'daemon A').catch(() => undefined);
    await stopProcess(daemonB, 'daemon B').catch(() => undefined);
    await stopProcessGroup(wrangler, 'wrangler dev').catch(() => undefined);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});
