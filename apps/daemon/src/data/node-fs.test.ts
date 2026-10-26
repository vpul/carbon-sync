import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeFileSystem } from './node-fs.js';

describe('NodeFileSystem', () => {
  let dir: string;
  let vault: NodeFileSystem;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'carbon-node-fs-'));
    vault = new NodeFileSystem(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes, reads, renames, and removes files, creating parents', async () => {
    await vault.write('notes/deep/a.md', 'one');
    expect(await vault.read('notes/deep/a.md')).toBe('one');

    await vault.rename('notes/deep/a.md', 'notes/b.md');
    expect(await vault.read('notes/deep/a.md')).toBeNull();
    expect(await vault.read('notes/b.md')).toBe('one');

    await vault.remove('notes/b.md');
    expect(await vault.read('notes/b.md')).toBeNull();
    await vault.remove('notes/b.md');
  });

  it('leaves no temp files behind on atomic writes', async () => {
    await vault.write('a.md', 'first');
    await vault.write('a.md', 'second');

    const entries = await readdir(dir, { recursive: true });
    expect(entries.filter((entry) => String(entry).includes('.carbon-tmp-'))).toEqual([]);
    expect(await vault.read('a.md')).toBe('second');
  });

  it('rejects paths that resolve outside the vault', async () => {
    await expect(vault.write('../escape.md', 'x')).rejects.toThrow(/escapes the vault/);
    await expect(vault.read('../escape.md')).rejects.toThrow(/escapes the vault/);
    await expect(vault.remove('notes/../../escape.md')).rejects.toThrow(/escapes the vault/);
    await vault.write('a.md', 'x');
    await expect(vault.rename('a.md', '../b.md')).rejects.toThrow(/escapes the vault/);
    await expect(vault.read('/etc/passwd')).rejects.toThrow(/escapes the vault/);
  });

  it('lists only syncable files, skipping .obsidian/ and images', async () => {
    await vault.write('notes/a.md', 'a');
    await vault.write('notes/deep/c.txt', 'c');
    await vault.write('b.canvas', '{}');
    await vault.write('img.png', 'png');
    await vault.write('.hidden.md', 'hidden');
    await mkdir(join(dir, '.obsidian'), { recursive: true });
    await vault.write('.obsidian/app.json', '{}');
    await mkdir(join(dir, '.trash'), { recursive: true });
    await vault.write('.trash/old.md', 'old');

    expect(await vault.list()).toEqual(['b.canvas', 'notes/a.md', 'notes/deep/c.txt']);
  });
});
