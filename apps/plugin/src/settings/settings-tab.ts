import type { SyncStatus } from '@carbon-sync/engine';
import {
  type ButtonComponent,
  PluginSettingTab,
  type Setting,
  type SettingDefinitionItem,
} from 'obsidian';
import type CarbonSyncPlugin from '../main';

/**
 * Declarative settings (Obsidian 1.13+): rows are indexed for the global settings
 * search. Simple values bind through `control`; the connection row and the
 * ignore globs need side effects, so they use `render`.
 */
export class CarbonSyncSettingTab extends PluginSettingTab {
  private lastResult = '';

  constructor(private readonly carbon: CarbonSyncPlugin) {
    super(carbon.app, carbon);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.carbon.isConnected() ? this.connectedRow() : this.setupRow(),
      {
        type: 'page',
        name: 'Advanced',
        desc: 'Ignore rules, push delay, and merge notices.',
        items: [
          this.ignoreGlobsRow(),
          {
            name: 'Debounce (ms)',
            desc: 'How long to wait after an edit before pushing it.',
            control: { type: 'number', key: 'debounceMs', min: 0, step: 1, defaultValue: 500 },
          },
          {
            name: 'Show a notice when notes are merged',
            control: { type: 'toggle', key: 'showMergeNotices' },
          },
        ],
      },
    ];
  }

  override getControlValue(key: string): unknown {
    if (key === 'debounceMs') {
      return this.carbon.settings.debounceMs;
    }
    if (key === 'showMergeNotices') {
      return this.carbon.settings.showMergeNotices;
    }
    return undefined;
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === 'debounceMs' && typeof value === 'number' && Number.isFinite(value)) {
      this.carbon.settings.debounceMs = Math.max(0, Math.round(value));
      await this.carbon.saveSettings();
      // The engine reads debounce at start. Number controls commit on blur or
      // Enter, so this restarts once per edit, not once per keystroke.
      await this.carbon.restartEngine();
      return;
    }
    if (key === 'showMergeNotices' && typeof value === 'boolean') {
      this.carbon.settings.showMergeNotices = value;
      await this.carbon.saveSettings();
    }
  }

  private connectedRow(): SettingDefinitionItem {
    const info = this.carbon.connectionInfo();
    return {
      name: info === null ? 'Connected' : `Vault: ${info.vault}`,
      desc: info === null ? 'Carbon Sync is running.' : `Server: ${info.host}`,
      aliases: ['setup code', 'disconnect', 'server'],
      render: (setting: Setting) => {
        setting.addButton((button) => {
          button
            .setButtonText('Disconnect')
            .setDestructive()
            .onClick(async () => {
              await this.carbon.disconnect();
              this.lastResult = '';
              this.update();
            });
        });
        const statusEl = setting.infoEl.createDiv({ cls: 'carbon-sync-result' });
        void this.fillStatus(statusEl);
      },
    };
  }

  private setupRow(): SettingDefinitionItem {
    return {
      name: 'Setup code',
      desc: 'Paste the code printed when you deployed the Carbon Sync server.',
      aliases: ['connect', 'server', 'token'],
      render: (setting: Setting) => {
        let code = this.carbon.settings.setupCode;
        let connectButton: ButtonComponent | null = null;
        const resultEl = setting.infoEl.createDiv({ cls: 'carbon-sync-result' });
        if (this.lastResult.length > 0) {
          resultEl.setText(this.lastResult);
        }
        const connect = (): void => {
          if (connectButton !== null) {
            void this.runConnect(code, connectButton, resultEl);
          }
        };
        setting.addText((text) => {
          text.inputEl.type = 'password';
          text.setPlaceholder('carbon1:…');
          text.setValue(code);
          text.onChange((value) => {
            code = value;
          });
          text.inputEl.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              connect();
            }
          });
        });
        setting.addButton((button) => {
          connectButton = button;
          button.setButtonText('Connect').setCta().onClick(connect);
        });
      },
    };
  }

  private ignoreGlobsRow(): SettingDefinitionItem {
    return {
      name: 'Extra ignore globs',
      desc: 'One per line, matched against the full path (for example Private/**).',
      render: (setting: Setting) => {
        let changed = false;
        setting.addTextArea((text) => {
          text.setValue(this.carbon.settings.extraIgnoreGlobs.join('\n'));
          text.inputEl.rows = 4;
          text.onChange((value) => {
            this.carbon.settings.extraIgnoreGlobs = value
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            changed = true;
            void this.carbon.saveSettings();
          });
          // Restart on blur so typing a glob doesn't reconnect per keystroke.
          text.inputEl.addEventListener('blur', () => {
            if (changed) {
              changed = false;
              void this.carbon.restartEngine();
            }
          });
        });
      },
    };
  }

  private async fillStatus(el: HTMLElement): Promise<void> {
    const status = this.carbon.currentStatus();
    const files = await this.carbon.trackedCount();
    el.setText(`${STATUS_LABELS[status]} · ${files} files`);
  }

  private async runConnect(
    code: string,
    button: ButtonComponent,
    resultEl: HTMLElement,
  ): Promise<void> {
    button.setDisabled(true).setButtonText('Connecting…');
    const result = await this.carbon.connect(code);
    if (result.ok) {
      this.lastResult = '';
      // The set of rows changes (setup -> connected), so rebuild definitions.
      this.update();
      return;
    }
    this.lastResult = result.message;
    resultEl.setText(result.message);
    button.setDisabled(false).setButtonText('Connect');
  }
}

const STATUS_LABELS: Record<SyncStatus, string> = {
  offline: 'Offline',
  connecting: 'Connecting',
  syncing: 'Syncing',
  idle: 'Connected',
};
