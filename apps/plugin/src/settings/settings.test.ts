import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  mergeSettings,
  type SettingsDataStore,
  saveSettings,
} from './settings';

function memoryStore(initial: unknown = null): SettingsDataStore & { data: unknown } {
  const store = {
    data: initial,
    async loadData(): Promise<unknown> {
      return store.data;
    },
    async saveData(data: unknown): Promise<void> {
      store.data = data;
    },
  };
  return store;
}

describe('settings', () => {
  it('falls back to defaults when nothing is saved', async () => {
    expect(await loadSettings(memoryStore(null))).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps every valid saved value', () => {
    const saved = {
      setupCode: ' carbon1:abc ',
      extraIgnoreGlobs: ['Private/**', '  ', 42, '  Archive/**  '],
      debounceMs: 1200.4,
      showMergeNotices: false,
    };
    expect(mergeSettings(saved)).toEqual({
      setupCode: 'carbon1:abc',
      extraIgnoreGlobs: ['Private/**', 'Archive/**'],
      debounceMs: 1200,
      showMergeNotices: false,
    });
  });

  it('replaces wrong types with defaults and round-trips through save', async () => {
    expect(
      mergeSettings({
        setupCode: 7,
        extraIgnoreGlobs: 'Private/**',
        debounceMs: Number.NaN,
        showMergeNotices: 'yes',
      }),
    ).toEqual(DEFAULT_SETTINGS);

    const store = memoryStore({ setupCode: 'carbon1:abc' });
    const settings = await loadSettings(store);
    settings.extraIgnoreGlobs = ['Private/**'];
    await saveSettings(store, settings);
    expect(await loadSettings(store)).toEqual(settings);
    expect(settings.extraIgnoreGlobs).not.toBe((store.data as typeof settings).extraIgnoreGlobs);
  });
});
