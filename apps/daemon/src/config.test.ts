import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSetupCode } from '@carbon-sync/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CliIO, runCli } from './cli.js';

const TOKEN = 'k'.repeat(48);
const URL = 'https://sync.example.com';
const VAULT = 'my-vault';

describe('config and status', () => {
  let root: string;
  let vaultDir: string;
  let configFile: string;
  let out: string[];
  let err: string[];
  const io: CliIO = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  const savedEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    HOME: process.env.HOME,
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'carbon-config-'));
    vaultDir = join(root, 'vault');
    await mkdir(vaultDir);
    process.env.XDG_CONFIG_HOME = join(root, 'config');
    process.env.XDG_STATE_HOME = join(root, 'state');
    process.env.HOME = root;
    configFile = join(root, 'config', 'carbon-sync', `${VAULT}.json`);
    out = [];
    err = [];
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  it('init writes mode 600 config and refuses a missing --dir', async () => {
    const code = encodeSetupCode({ url: URL, vault: VAULT, token: TOKEN });

    out = [];
    err = [];
    expect(await runCli(['init', '--code', code, '--dir', vaultDir], io)).toBe(0);
    expect(out.join('\n')).not.toContain(TOKEN);

    const mode = (await stat(configFile)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual({
      url: URL,
      vault: VAULT,
      token: TOKEN,
      dir: vaultDir,
      ignore: [],
    });

    out = [];
    err = [];
    const missing = join(root, 'does-not-exist');
    expect(await runCli(['init', '--code', code, '--dir', missing, '--name', 'other'], io)).toBe(1);
    expect(err.join('\n')).toContain('directory does not exist');
  });

  it('status prints the summary and never the token', async () => {
    out = [];
    err = [];
    expect(await runCli(['status', '--vault', VAULT], io)).toBe(0);

    const text = out.join('\n');
    expect(out).toContain(`config: ${configFile}`);
    expect(out).toContain(`dir: ${vaultDir}`);
    expect(out).toContain(`url: ${URL}`);
    expect(out).toContain('cursor: 0');
    expect(out).toContain('tracked files: 0');
    expect(text).not.toContain(TOKEN);
    expect(err).toEqual([]);
  });
});
