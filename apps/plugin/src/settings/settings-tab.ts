import type { SyncStatus } from '@carbon-sync/engine';
import { type ButtonComponent, PluginSettingTab, Setting } from 'obsidian';
import type CarbonSyncPlugin from '../main';

export class CarbonSyncSettingTab extends PluginSettingTab {
  private resultEl: HTMLElement | null = null;
  private connectButton: ButtonComponent | null = null;
  private lastResult = '';

  constructor(private readonly carbon: CarbonSyncPlugin) {
    super(carbon.app, carbon);
  }

  display(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    this.resultEl = null;
    this.connectButton = null;
    if (this.carbon.isConnected()) {
      await this.renderConnected(containerEl);
    } else {
      this.renderSetup(containerEl);
    }
    this.renderAdvanced(containerEl);
  }

  private async renderConnected(containerEl: HTMLElement): Promise<void> {
    const info = this.carbon.connectionInfo();
    const status = this.carbon.currentStatus();
    const setting = new Setting(containerEl)
      .setName(info === null ? 'Connected' : `Vault: ${info.vault}`)
      .setDesc(info === null ? 'Carbon Sync is running.' : `Server: ${info.host}`);
    setting.addButton((button) => {
      button
        .setButtonText('Disconnect')
        .setWarning()
        .onClick(async () => {
          await this.carbon.disconnect();
          this.lastResult = '';
          this.display();
        });
    });
    const files = await this.carbon.trackedCount();
    containerEl.createDiv({
      cls: 'carbon-sync-result',
      text:
        status === 'idle'
          ? `Connected · ${files} files`
          : `${STATUS_LABELS[status]} · ${files} files`,
    });
  }

  private renderSetup(containerEl: HTMLElement): void {
    let code = this.carbon.settings.setupCode;
    const setting = new Setting(containerEl)
      .setName('Setup code')
      .setDesc('Paste the code printed when you deployed the Carbon Sync server.');
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
          void this.runConnect(code);
        }
      });
    });
    setting.addButton((button) => {
      this.connectButton = button;
      button
        .setButtonText('Connect')
        .setCta()
        .onClick(() => void this.runConnect(code));
    });
    this.resultEl = containerEl.createDiv({ cls: 'carbon-sync-result' });
    if (this.lastResult.length > 0) {
      this.resultEl.setText(this.lastResult);
    }
  }

  private renderAdvanced(containerEl: HTMLElement): void {
    const details = containerEl.createEl('details');
    details.createEl('summary', { text: 'Advanced' });

    let globsChanged = false;
    new Setting(details)
      .setName('Extra ignore globs')
      .setDesc('One per line, matched against the full path (for example Private/**).')
      .addTextArea((text) => {
        text.setValue(this.carbon.settings.extraIgnoreGlobs.join('\n'));
        text.inputEl.rows = 4;
        text.onChange((value) => {
          this.carbon.settings.extraIgnoreGlobs = value
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          globsChanged = true;
          void this.carbon.saveSettings();
        });
        text.inputEl.addEventListener('blur', () => {
          if (globsChanged) {
            globsChanged = false;
            void this.carbon.restartEngine();
          }
        });
      });

    let debounceChanged = false;
    new Setting(details)
      .setName('Debounce (ms)')
      .setDesc('How long to wait after an edit before pushing it.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.setValue(String(this.carbon.settings.debounceMs));
        text.onChange((value) => {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed >= 0) {
            this.carbon.settings.debounceMs = Math.round(parsed);
            debounceChanged = true;
            void this.carbon.saveSettings();
          }
        });
        text.inputEl.addEventListener('blur', () => {
          if (debounceChanged) {
            debounceChanged = false;
            void this.carbon.restartEngine();
          }
        });
      });

    new Setting(details).setName('Show a notice when notes are merged').addToggle((toggle) => {
      toggle.setValue(this.carbon.settings.showMergeNotices);
      toggle.onChange((value) => {
        this.carbon.settings.showMergeNotices = value;
        void this.carbon.saveSettings();
      });
    });
  }

  private async runConnect(code: string): Promise<void> {
    const button = this.connectButton;
    button?.setDisabled(true).setButtonText('Connecting…');
    const result = await this.carbon.connect(code);
    if (result.ok) {
      this.lastResult = '';
      this.display();
      return;
    }
    this.lastResult = result.message;
    this.resultEl?.setText(result.message);
    button?.setDisabled(false).setButtonText('Connect');
  }
}

const STATUS_LABELS: Record<SyncStatus, string> = {
  offline: 'Offline',
  connecting: 'Connecting',
  syncing: 'Syncing',
  idle: 'Connected',
};
