import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { SyncEvent } from '@carbon-sync/engine';
import { CLOSE_UNAUTHORIZED, decodeSetupCode } from '@carbon-sync/protocol';
import {
  assertVaultDirectory,
  configPath,
  type DaemonConfig,
  loadConfig,
  saveConfig,
  statePath,
} from './config.js';
import { FileStateStore } from './data/file-state.js';
import { watchVault } from './domain/watcher.js';
import { createRuntime } from './main.js';

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

const consoleIO: CliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const HELP = `Usage: carbon-sync <command> [options]

Commands:
  init    Write a vault config from a setup code
  sync    Sync once and exit (for cron)
  daemon  Run forever, syncing and watching the vault
  status  Show config path, dir, server url, cursor, and tracked file count

Run "carbon-sync <command> --help" for command options.`;

const INIT_HELP = `Usage: carbon-sync init --code <setup-code> --dir <path> [--name <alias>]

Decode a carbon1: setup code and write $XDG_CONFIG_HOME/carbon-sync/<alias>.json
with mode 600. The alias defaults to the vault id. --dir must be an existing
directory and is stored as an absolute path.`;

const SYNC_HELP = `Usage: carbon-sync sync --vault <alias> [--timeout <seconds>]

Connect, apply the welcome and full scan, wait for all pending acks, then exit.
Exit status 1 on auth failure or timeout. Default timeout is 60 seconds.
Intended for cron.`;

const DAEMON_HELP = `Usage: carbon-sync daemon --vault <alias>

Run forever: reconnect with backoff, watch the vault folder, and log one line
per sync event. SIGINT/SIGTERM flush state, close the socket, and exit 0.`;

const STATUS_HELP = `Usage: carbon-sync status --vault <alias>

Print the config path, vault dir, server url, cursor, and tracked file count.
The token is never printed.`;

async function init(argv: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      code: { type: 'string' },
      dir: { type: 'string' },
      name: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    io.out(INIT_HELP);
    return 0;
  }
  if (values.code === undefined) {
    throw new Error('init requires --code <setup-code>');
  }
  if (values.dir === undefined) {
    throw new Error('init requires --dir <path>');
  }

  const setup = decodeSetupCode(values.code);
  const alias = values.name ?? setup.vault;

  const dir = resolve(values.dir);
  await assertVaultDirectory(dir);

  const config: DaemonConfig = {
    url: setup.url,
    vault: setup.vault,
    token: setup.token,
    dir,
    ignore: [],
  };
  const file = await saveConfig(alias, config);
  io.out(`wrote ${file}`);
  return 0;
}

type SyncOutcome = 'idle' | 'unauthorized' | 'timeout';

async function sync(argv: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      vault: { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    io.out(SYNC_HELP);
    return 0;
  }
  if (values.vault === undefined) {
    throw new Error('sync requires --vault <alias>');
  }

  const seconds = Number(values.timeout ?? '60');
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--timeout must be a positive number of seconds, got "${values.timeout}"`);
  }
  const config = await loadConfig(values.vault);

  let settle: ((outcome: SyncOutcome) => void) | null = null;
  const done = new Promise<SyncOutcome>((resolveDone) => {
    settle = resolveDone;
  });
  const finish = (outcome: SyncOutcome): void => {
    const current = settle;
    settle = null;
    current?.(outcome);
  };

  const runtime = createRuntime(config, values.vault, {
    onEvent: (event: SyncEvent): void => {
      if (event.type === 'status' && event.detail === 'idle') {
        finish('idle');
      } else if (event.type === 'error' && event.detail === 'unauthorized') {
        finish('unauthorized');
      } else if (event.type === 'error' && event.detail !== undefined) {
        io.err(`carbon-sync: sync error: ${event.detail}`);
      }
    },
    onCloseCode: (code): void => {
      if (code === CLOSE_UNAUTHORIZED) {
        finish('unauthorized');
      }
    },
  });

  const timer = setTimeout(() => finish('timeout'), seconds * 1000);
  try {
    await runtime.engine.start();
    const outcome = await done;
    runtime.engine.stop();
    await runtime.state.flush();
    if (outcome === 'idle') {
      return 0;
    }
    if (outcome === 'unauthorized') {
      io.err('carbon-sync: unauthorized: the setup code token was rejected');
    } else {
      io.err(`carbon-sync: sync timed out after ${seconds}s`);
    }
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

function logEvent(io: CliIO, event: SyncEvent): void {
  const parts = [new Date().toISOString(), event.type];
  if (event.path !== undefined) {
    parts.push(event.path);
  }
  if (event.detail !== undefined) {
    parts.push(event.detail);
  }
  io.out(parts.join(' '));
}

async function daemon(argv: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      vault: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    io.out(DAEMON_HELP);
    return 0;
  }
  if (values.vault === undefined) {
    throw new Error('daemon requires --vault <alias>');
  }
  const config = await loadConfig(values.vault);
  const runtime = createRuntime(config, values.vault, {
    onEvent: (event: SyncEvent): void => logEvent(io, event),
  });
  const watcher = watchVault({ dir: config.dir, ignore: config.ignore, sink: runtime.engine });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logEvent(io, { type: 'status', detail: `shutdown ${signal}` });
    watcher.close();
    runtime.engine.stop();
    void (async () => {
      try {
        await runtime.state.flush();
      } finally {
        process.exit(0);
      }
    })();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await runtime.engine.start();
  logEvent(io, { type: 'status', detail: `watching ${config.dir}` });
  await new Promise<void>(() => {});
  return 0;
}

async function status(argv: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      vault: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    io.out(STATUS_HELP);
    return 0;
  }
  if (values.vault === undefined) {
    throw new Error('status requires --vault <alias>');
  }
  const config = await loadConfig(values.vault);
  const state = await new FileStateStore(statePath(values.vault)).load();
  const tracked = Object.values(state.files).filter((entry) => entry.hash !== '').length;

  io.out(`config: ${configPath(values.vault)}`);
  io.out(`dir: ${config.dir}`);
  io.out(`url: ${config.url}`);
  io.out(`cursor: ${state.cursor}`);
  io.out(`tracked files: ${tracked}`);
  return 0;
}

async function dispatch(argv: readonly string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    io.out(HELP);
    return 1;
  }
  if (command === '--help' || command === '-h') {
    io.out(HELP);
    return 0;
  }
  switch (command) {
    case 'init':
      return await init(rest, io);
    case 'sync':
      return await sync(rest, io);
    case 'daemon':
      return await daemon(rest, io);
    case 'status':
      return await status(rest, io);
    default:
      io.err(`carbon-sync: unknown command "${command}"`);
      io.out(HELP);
      return 1;
  }
}

/** Entry point. Returns the process exit code; never calls `process.exit`. */
export async function runCli(argv: readonly string[], io: CliIO = consoleIO): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    io.err(`carbon-sync: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
