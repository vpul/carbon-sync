import type { Stats } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { isValidVaultId } from '@carbon-sync/protocol';
import { writeFileAtomic } from './data/atomic.js';

/** Everything `init` writes and every command loads. Never logged in full. */
export interface DaemonConfig {
  url: string;
  vault: string;
  token: string;
  dir: string;
  ignore: string[];
}

function homeDir(): string {
  const home = process.env.HOME;
  if (typeof home !== 'string' || home.length === 0) {
    throw new Error('HOME is not set');
  }
  return home;
}

function xdgDir(variable: 'XDG_CONFIG_HOME' | 'XDG_STATE_HOME', fallback: string): string {
  const value = process.env[variable];
  return typeof value === 'string' && isAbsolute(value) ? value : join(homeDir(), fallback);
}

/** `$XDG_CONFIG_HOME/carbon-sync` (default `~/.config/carbon-sync`). */
export function configDir(): string {
  return join(xdgDir('XDG_CONFIG_HOME', '.config'), 'carbon-sync');
}

/** `$XDG_STATE_HOME/carbon-sync` (default `~/.local/state/carbon-sync`). */
export function stateDir(): string {
  return join(xdgDir('XDG_STATE_HOME', '.local/state'), 'carbon-sync');
}

function assertAlias(alias: string): void {
  if (!isValidVaultId(alias)) {
    throw new Error(
      `invalid alias "${String(alias)}": use 1-63 lowercase letters, digits, or dashes (starting with a letter or digit)`,
    );
  }
}

/** Absolute path of one vault's config file. */
export function configPath(alias: string): string {
  assertAlias(alias);
  return join(configDir(), `${alias}.json`);
}

/** Absolute path of one vault's device state file. Deliberately outside the vault. */
export function statePath(alias: string): string {
  assertAlias(alias);
  return join(stateDir(), `${alias}.state.json`);
}

/** Load and validate one config; errors name the path and never echo the token. */
export async function loadConfig(alias: string): Promise<DaemonConfig> {
  const file = configPath(alias);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`no config for "${alias}" at ${file}; run carbon-sync init first`);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`config is not valid JSON: ${file}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config must be a JSON object: ${file}`);
  }

  const { url, vault, token, dir, ignore } = parsed as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof url !== 'string' || url.length === 0) problems.push('url');
  if (typeof vault !== 'string' || !isValidVaultId(vault)) problems.push('vault');
  if (typeof token !== 'string' || token.length === 0) problems.push('token');
  if (typeof dir !== 'string' || !isAbsolute(dir)) problems.push('dir');
  if (!Array.isArray(ignore) || !ignore.every((glob) => typeof glob === 'string')) {
    problems.push('ignore');
  }
  if (problems.length > 0) {
    throw new Error(`config is invalid (${problems.join(', ')}): ${file}`);
  }
  return {
    url: url as string,
    vault: vault as string,
    token: token as string,
    dir: dir as string,
    ignore: ignore as string[],
  };
}

/** Write one config atomically with mode 600; returns its path. */
export async function saveConfig(alias: string, config: DaemonConfig): Promise<string> {
  const file = configPath(alias);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Validate `--dir` before writing a config. */
export async function assertVaultDirectory(dir: string): Promise<void> {
  let info: Stats;
  try {
    info = await stat(dir);
  } catch {
    throw new Error(`directory does not exist: ${dir}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }
}
