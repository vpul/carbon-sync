import { SyncEngine, type SyncEvent, type TimerHandle } from '@carbon-sync/engine';
import { type DaemonConfig, statePath } from './config.js';
import { FileStateStore } from './data/file-state.js';
import { NodeFileSystem } from './data/node-fs.js';
import { vaultSocketUrl, WsTransport } from './data/ws-transport.js';

export interface RuntimeOptions {
  onEvent?: (event: SyncEvent) => void;
  onCloseCode?: (code: number) => void;
}

export interface DaemonRuntime {
  engine: SyncEngine;
  fs: NodeFileSystem;
  state: FileStateStore;
}

/** Wire the Node ports to the engine. All policy lives in the engine. */
export function createRuntime(
  config: DaemonConfig,
  alias: string,
  options: RuntimeOptions = {},
): DaemonRuntime {
  const fs = new NodeFileSystem(config.dir, config.ignore);
  const state = new FileStateStore(statePath(alias));
  const transport = new WsTransport(
    options.onCloseCode === undefined ? {} : { onCloseCode: options.onCloseCode },
  );
  const clock = {
    setTimeout: (callback: () => void, ms: number): TimerHandle => setTimeout(callback, ms),
    clearTimeout: (handle: TimerHandle): void => clearTimeout(handle as NodeJS.Timeout),
    now: (): number => Date.now(),
  };
  const engine = new SyncEngine({
    fs,
    state,
    transport,
    clock,
    url: vaultSocketUrl(config.url, config.vault),
    token: config.token,
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
  return { engine, fs, state };
}
