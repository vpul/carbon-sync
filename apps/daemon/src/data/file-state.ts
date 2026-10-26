import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StateStore, SyncState } from '@carbon-sync/engine';
import { writeFileAtomic } from './atomic.js';

function freshState(): SyncState {
  return { cursor: 0, deviceId: '', files: {} };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
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
 * `StateStore` backed by one JSON file under `$XDG_STATE_HOME`, never inside
 * the vault. Saves are serialized and atomic, so `flush()` can wait for the
 * last write before the process exits.
 */
export class FileStateStore implements StateStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<SyncState> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        return freshState();
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`state file is not valid JSON: ${this.file}`);
    }
    if (!isSyncState(parsed)) {
      throw new Error(`state file is corrupt: ${this.file}`);
    }
    return parsed;
  }

  save(state: SyncState): Promise<void> {
    const write = this.pending.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.file, JSON.stringify(state), { mode: 0o600 });
    });
    this.pending = write.catch(() => undefined);
    return write;
  }

  /** Resolve once every save issued so far has hit the disk. */
  async flush(): Promise<void> {
    await this.pending;
  }
}
