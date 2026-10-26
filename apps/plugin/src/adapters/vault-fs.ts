import type { FileSystem } from '@carbon-sync/engine';
import { isSyncable } from '@carbon-sync/protocol';
import { type App, TFile } from 'obsidian';

/**
 * `FileSystem` port over the vault. Writes go through `vault.modify` for
 * existing files so open editors refresh, and `vault.create` for new ones.
 */
export class VaultFileSystem implements FileSystem {
  constructor(
    private readonly app: App,
    private readonly ignore: readonly string[],
  ) {}

  async list(): Promise<string[]> {
    return this.app.vault
      .getFiles()
      .map((file) => file.path)
      .filter((path) => isSyncable(path, this.ignore))
      .sort();
  }

  async read(path: string): Promise<string | null> {
    try {
      return await this.app.vault.adapter.read(path);
    } catch {
      return null;
    }
  }

  async write(path: string, content: string): Promise<void> {
    await this.ensureParentFolders(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }
    try {
      await this.app.vault.create(path, content);
    } catch (error) {
      // A concurrent edit may have created the note between the check and here.
      const raced = this.app.vault.getAbstractFileByPath(path);
      if (!(raced instanceof TFile)) {
        throw error;
      }
      await this.app.vault.modify(raced, content);
    }
  }

  async remove(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      if (typeof this.app.fileManager.trashFile === 'function') {
        await this.app.fileManager.trashFile(file);
      } else {
        // Obsidian < 1.6.6 has no trashFile; keep deletes working.
        await this.app.vault.delete(file);
      }
      return;
    }
    if (await this.app.vault.adapter.exists(path)) {
      await this.app.vault.adapter.remove(path);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(from);
    if (!(file instanceof TFile)) {
      return;
    }
    await this.ensureParentFolders(to);
    await this.app.vault.rename(file, to);
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const slash = path.lastIndexOf('/');
    if (slash === -1) {
      return;
    }
    const adapter = this.app.vault.adapter;
    let prefix = '';
    for (const segment of path.slice(0, slash).split('/')) {
      prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
      if (await adapter.exists(prefix)) {
        continue;
      }
      try {
        await adapter.mkdir(prefix);
      } catch (error) {
        if (!(await adapter.exists(prefix))) {
          throw error;
        }
      }
    }
  }
}
