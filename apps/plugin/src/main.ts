import {
  type Clock,
  SyncEngine,
  type SyncEvent,
  type SyncState,
  type SyncStatus,
} from '@carbon-sync/engine';
import { decodeSetupCode, isSyncable, type SetupPayload } from '@carbon-sync/protocol';
import { Notice, Plugin, type TAbstractFile, TFile } from 'obsidian';
import { PluginStateStore, stateFilePath } from './adapters/plugin-state';
import { VaultFileSystem } from './adapters/vault-fs';
import { vaultSocketUrl, WsTransport } from './adapters/ws-transport';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  type Settings,
  saveSettings as writeSettings,
} from './settings/settings';
import { CarbonSyncSettingTab } from './settings/settings-tab';
import { StatusBar } from './ui/status-bar';

const CONNECT_TIMEOUT_MS = 15_000;

export interface ConnectSuccess {
  ok: true;
  files: number;
}

export interface ConnectFailure {
  ok: false;
  message: 'Invalid setup code' | 'Wrong token' | 'Server unreachable';
}

export type ConnectResult = ConnectSuccess | ConnectFailure;

function parseSetupCode(code: string): SetupPayload | null {
  try {
    return decodeSetupCode(code);
  } catch {
    return null;
  }
}

const clock: Clock = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
  now: () => Date.now(),
};

export default class CarbonSyncPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS, extraIgnoreGlobs: [] };

  private engine: SyncEngine | null = null;
  private stateStore: PluginStateStore | null = null;
  private statusBar: StatusBar | null = null;
  private connectWaiter: { resolve: (result: ConnectResult) => void; timer: number } | null = null;
  private lastError: string | null = null;
  private lifecycle = 0;

  async onload(): Promise<void> {
    this.settings = await loadSettings(this);
    this.statusBar = new StatusBar(this.addStatusBarItem(), () => this.syncNow());

    this.addSettingTab(new CarbonSyncSettingTab(this));
    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => this.syncNow() });
    this.addCommand({ id: 'reconnect', name: 'Reconnect', callback: () => void this.reconnect() });
    this.addCommand({
      id: 'copy-diagnostics',
      name: 'Copy diagnostics',
      callback: () => void this.copyDiagnostics(),
    });

    this.registerEvent(this.app.vault.on('create', (file) => this.onVaultWrite(file)));
    this.registerEvent(this.app.vault.on('modify', (file) => this.onVaultWrite(file)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.onVaultDelete(file)));
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => this.onVaultRename(file, oldPath)),
    );
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.syncNow();
      }
    });

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.setupCode.length > 0) {
        void this.startEngine();
      }
    });
  }

  onunload(): void {
    this.stopEngine();
  }

  async saveSettings(): Promise<void> {
    await writeSettings(this, this.settings);
  }

  /** Decode and persist the code, then start the engine and wait for its first sync. */
  async connect(code: string): Promise<ConnectResult> {
    const trimmed = code.trim();
    let payload: SetupPayload;
    try {
      payload = decodeSetupCode(trimmed);
    } catch {
      return { ok: false, message: 'Invalid setup code' };
    }
    this.settings.setupCode = trimmed;
    await this.saveSettings();
    this.settleConnect({ ok: false, message: 'Server unreachable' });
    this.stopEngine();

    const outcome = new Promise<ConnectResult>((resolve) => {
      const waiter = { resolve, timer: 0 };
      waiter.timer = window.setTimeout(() => {
        if (this.connectWaiter === waiter) {
          this.connectWaiter = null;
        }
        resolve({ ok: false, message: 'Server unreachable' });
      }, CONNECT_TIMEOUT_MS);
      this.connectWaiter = waiter;
    });
    await this.startEngine(payload);

    const result = await outcome;
    if (!result.ok) {
      return result;
    }
    return { ok: true, files: await this.trackedCount() };
  }

  async disconnect(): Promise<void> {
    this.stopEngine();
    this.settings.setupCode = '';
    await this.saveSettings();
  }

  isConnected(): boolean {
    const status = this.engine?.status();
    return status === 'connecting' || status === 'syncing' || status === 'idle';
  }

  currentStatus(): SyncStatus {
    return this.engine?.status() ?? 'offline';
  }

  connectionInfo(): { vault: string; host: string } | null {
    const setup = parseSetupCode(this.settings.setupCode);
    if (setup === null) {
      return null;
    }
    return { vault: setup.vault, host: new URL(setup.url).host };
  }

  /** Live tracked files (tombstones excluded), for the settings summary. */
  async trackedCount(): Promise<number> {
    if (this.stateStore === null) {
      return 0;
    }
    try {
      return liveFileCount(await this.stateStore.load());
    } catch {
      return 0;
    }
  }

  async restartEngine(): Promise<void> {
    if (this.engine === null) {
      return;
    }
    this.stopEngine();
    await this.startEngine();
  }

  private async startEngine(payload?: SetupPayload | null): Promise<void> {
    if (this.engine !== null) {
      return;
    }
    const setup = payload === undefined ? parseSetupCode(this.settings.setupCode) : payload;
    if (setup === null) {
      this.lastError = 'Invalid setup code';
      this.statusBar?.set('offline');
      return;
    }

    const pluginDir =
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const lifecycle = ++this.lifecycle;
    const stateStore = new PluginStateStore(this.app.vault.adapter, stateFilePath(pluginDir));
    const transport = new WsTransport({
      onCloseCode: (closeCode) => {
        if (lifecycle === this.lifecycle && closeCode === 4401) {
          this.settleConnect({ ok: false, message: 'Wrong token' });
        }
      },
      onConnectError: () => {
        if (lifecycle === this.lifecycle) {
          this.settleConnect({ ok: false, message: 'Server unreachable' });
        }
      },
    });
    const fs = new VaultFileSystem(this.app, this.settings.extraIgnoreGlobs);

    const engine = new SyncEngine({
      fs,
      state: stateStore,
      transport,
      clock,
      url: vaultSocketUrl(setup.url, setup.vault),
      token: setup.token,
      debounceMs: this.settings.debounceMs,
      ignore: this.settings.extraIgnoreGlobs,
      onEvent: (event) => {
        if (lifecycle === this.lifecycle) {
          this.handleEvent(event);
        }
      },
    });
    this.stateStore = stateStore;
    this.lastError = null;
    this.engine = engine;
    await engine.start();
  }

  private stopEngine(): void {
    this.lifecycle += 1;
    const engine = this.engine;
    this.engine = null;
    engine?.stop();
    this.statusBar?.set('offline');
  }

  private settleConnect(result: ConnectResult): void {
    const waiter = this.connectWaiter;
    if (waiter === null) {
      return;
    }
    this.connectWaiter = null;
    window.clearTimeout(waiter.timer);
    waiter.resolve(result);
  }

  private handleEvent(event: SyncEvent): void {
    switch (event.type) {
      case 'status': {
        const status = event.detail;
        if (
          status === 'offline' ||
          status === 'connecting' ||
          status === 'syncing' ||
          status === 'idle'
        ) {
          this.statusBar?.set(status);
          if (status === 'idle') {
            this.settleConnect({ ok: true, files: 0 });
          }
        }
        break;
      }
      case 'merged':
        if (this.settings.showMergeNotices && event.path !== undefined) {
          new Notice(`Carbon Sync merged edits in ${event.path}`);
        }
        break;
      case 'error':
        this.lastError = event.detail ?? 'unknown error';
        break;
      default:
        break;
    }
  }

  private isSyncedPath(path: string): boolean {
    return isSyncable(path, this.settings.extraIgnoreGlobs);
  }

  private onVaultWrite(file: TAbstractFile): void {
    if (!(file instanceof TFile) || !this.isSyncedPath(file.path)) {
      return;
    }
    this.engine?.notifyLocalChange(file.path);
  }

  private onVaultDelete(file: TAbstractFile): void {
    if (!(file instanceof TFile) || !this.isSyncedPath(file.path)) {
      return;
    }
    this.engine?.notifyLocalDelete(file.path);
  }

  private onVaultRename(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile)) {
      return;
    }
    const to = file.path;
    if (!this.isSyncedPath(to)) {
      if (this.isSyncedPath(oldPath)) {
        this.engine?.notifyLocalDelete(oldPath);
      }
      return;
    }
    if (!this.isSyncedPath(oldPath)) {
      this.engine?.notifyLocalChange(to);
      return;
    }
    this.engine?.notifyLocalRename(oldPath, to);
  }

  private syncNow(): void {
    if (this.engine !== null) {
      this.engine.syncNow();
      return;
    }
    if (this.settings.setupCode.length > 0) {
      void this.startEngine();
    }
  }

  private async reconnect(): Promise<void> {
    if (this.settings.setupCode.length === 0) {
      new Notice('Carbon Sync: no setup code saved');
      return;
    }
    this.stopEngine();
    await this.startEngine();
  }

  private async diagnostics(): Promise<string> {
    const lines = [
      'Carbon Sync diagnostics',
      `version: ${this.manifest.version}`,
      `status: ${this.currentStatus()}`,
    ];
    const setup = parseSetupCode(this.settings.setupCode);
    if (setup !== null) {
      lines.push(`vault: ${setup.vault}`, `server: ${new URL(setup.url).host}`);
    }
    if (this.stateStore !== null) {
      try {
        const state = await this.stateStore.load();
        lines.push(
          `device: ${state.deviceId}`,
          `cursor: ${state.cursor}`,
          `tracked files: ${liveFileCount(state)}`,
        );
      } catch (error) {
        lines.push(`state: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.lastError !== null) {
      lines.push(`last error: ${this.lastError}`);
    }
    return lines.join('\n');
  }

  private async copyDiagnostics(): Promise<void> {
    const text = await this.diagnostics();
    try {
      await navigator.clipboard.writeText(text);
      new Notice('Carbon Sync diagnostics copied');
    } catch {
      new Notice('Carbon Sync: could not copy diagnostics');
    }
  }
}

function liveFileCount(state: SyncState): number {
  return Object.values(state.files).filter((entry) => entry.hash !== '').length;
}
