/** Everything the plugin persists in `data.json` (never the token in clear text beyond the setup code). */
export interface Settings {
  setupCode: string;
  extraIgnoreGlobs: string[];
  debounceMs: number;
  showMergeNotices: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  setupCode: '',
  extraIgnoreGlobs: [],
  debounceMs: 500,
  showMergeNotices: true,
};

/** The slice of `Plugin` this module needs, so it stays testable without Obsidian. */
export interface SettingsDataStore {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

function normalizeGlobs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeDebounce(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.debounceMs;
  }
  return Math.max(0, Math.round(value));
}

/** Fill missing fields from defaults and drop values of the wrong type. */
export function mergeSettings(saved: unknown): Settings {
  const raw =
    typeof saved === 'object' && saved !== null && !Array.isArray(saved)
      ? (saved as Record<string, unknown>)
      : {};
  return {
    setupCode:
      typeof raw.setupCode === 'string' ? raw.setupCode.trim() : DEFAULT_SETTINGS.setupCode,
    extraIgnoreGlobs:
      raw.extraIgnoreGlobs === undefined
        ? [...DEFAULT_SETTINGS.extraIgnoreGlobs]
        : normalizeGlobs(raw.extraIgnoreGlobs),
    debounceMs:
      raw.debounceMs === undefined
        ? DEFAULT_SETTINGS.debounceMs
        : normalizeDebounce(raw.debounceMs),
    showMergeNotices:
      typeof raw.showMergeNotices === 'boolean'
        ? raw.showMergeNotices
        : DEFAULT_SETTINGS.showMergeNotices,
  };
}

export async function loadSettings(store: SettingsDataStore): Promise<Settings> {
  return mergeSettings(await store.loadData());
}

export async function saveSettings(store: SettingsDataStore, settings: Settings): Promise<void> {
  await store.saveData({ ...settings, extraIgnoreGlobs: [...settings.extraIgnoreGlobs] });
}
