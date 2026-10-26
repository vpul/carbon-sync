import type { StateStore, SyncState } from '@carbon-sync/engine';
import type { DataAdapter } from 'obsidian';

export function stateFilePath(pluginDir: string): string {
  return `${pluginDir}/state.json`;
}

function freshState(): SyncState {
  return { cursor: 0, deviceId: '', files: {} };
}

function isSyncState(value: unknown): value is SyncState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const { cursor, deviceId, files } = value as Record<string, unknown>;
  if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
    return false;
  }
  if (typeof deviceId !== 'string') {
    return false;
  }
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    return false;
  }
  return Object.values(files).every((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return false;
    }
    const { rev, hash, base } = entry as Record<string, unknown>;
    return typeof rev === 'number' && typeof hash === 'string' && typeof base === 'string';
  });
}

/**
 * `StateStore` kept next to the plugin in the vault (`state.json`), separate
 * from `data.json` so settings stay small and readable.
 */
export class PluginStateStore implements StateStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: DataAdapter,
    private readonly path: string,
  ) {}

  async load(): Promise<SyncState> {
    if (!(await this.adapter.exists(this.path))) {
      return freshState();
    }
    const raw = await this.adapter.read(this.path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Carbon Sync state is not valid JSON: ${this.path}`);
    }
    if (!isSyncState(parsed)) {
      throw new Error(`Carbon Sync state is corrupt: ${this.path}`);
    }
    return parsed;
  }

  save(state: SyncState): Promise<void> {
    const write = this.pending.then(async () => {
      const dir = this.path.slice(0, this.path.lastIndexOf('/'));
      if (dir.length > 0 && !(await this.adapter.exists(dir))) {
        await this.adapter.mkdir(dir);
      }
      await this.adapter.write(this.path, JSON.stringify(state));
    });
    this.pending = write.catch(() => undefined);
    return write;
  }
}
