import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { FileSystem } from '@carbon-sync/engine';
import { isSyncable } from '@carbon-sync/protocol';
import { writeFileAtomic } from './atomic.js';

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * `FileSystem` port over `node:fs/promises`, rooted at `dir`. Every path is
 * resolved and checked to stay inside the vault; writes are atomic.
 */
export class NodeFileSystem implements FileSystem {
  private readonly dir: string;
  private readonly ignore: readonly string[];

  constructor(dir: string, ignore: readonly string[] = []) {
    this.dir = resolve(dir);
    this.ignore = ignore;
  }

  async list(): Promise<string[]> {
    const paths: string[] = [];
    await this.walk(this.dir, '', paths);
    return paths.sort();
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.absolute(path), 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  async write(path: string, content: string): Promise<void> {
    const absolute = this.absolute(path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFileAtomic(absolute, content);
  }

  async remove(path: string): Promise<void> {
    try {
      await rm(this.absolute(path));
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.absolute(from);
    const target = this.absolute(to);
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
  }

  /** Resolve a vault-relative path, rejecting anything that escapes the root. */
  private absolute(path: string): string {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
      throw new Error(`invalid vault path: ${JSON.stringify(path)}`);
    }
    const absolute = resolve(this.dir, path);
    if (absolute !== this.dir && !absolute.startsWith(this.dir + sep)) {
      throw new Error(`path escapes the vault: ${path}`);
    }
    return absolute;
  }

  private async walk(absolute: string, relative: string, paths: string[]): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        // Every reserved directory (.obsidian, .git, .trash, .carbon) is a dotdir.
        if (!entry.name.startsWith('.')) {
          await this.walk(join(absolute, entry.name), childRelative, paths);
        }
      } else if (entry.isFile() && isSyncable(childRelative, this.ignore)) {
        paths.push(childRelative);
      }
    }
  }
}
