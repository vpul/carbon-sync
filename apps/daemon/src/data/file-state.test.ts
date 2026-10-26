import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncState } from '@carbon-sync/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStateStore } from './file-state.js';

describe('FileStateStore', () => {
  let dir: string;
  let store: FileStateStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'carbon-state-'));
    store = new FileStateStore(join(dir, 'vault.state.json'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a saved state', async () => {
    const state: SyncState = {
      cursor: 7,
      deviceId: 'device-1',
      files: {
        'notes/a.md': { rev: 3, hash: 'abc', base: 'hello' },
        'b.md': { rev: 0, hash: '', base: '' },
      },
    };
    await store.save(state);

    expect(await store.load()).toEqual(state);
    expect(await readdir(dir)).toEqual(['vault.state.json']);
  });

  it('returns fresh state when the file is missing', async () => {
    expect(await store.load()).toEqual({ cursor: 0, deviceId: '', files: {} });
  });
});
