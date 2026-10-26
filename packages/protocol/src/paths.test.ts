import { describe, expect, it } from 'vitest';
import { isSyncable, isValidPath, MAX_PATH_LENGTH } from './paths.js';

describe('isValidPath', () => {
  it('accepts relative POSIX vault paths', () => {
    expect(isValidPath('notes/a.md')).toBe(true);
    expect(isValidPath('a.md')).toBe(true);
    expect(isValidPath('.obsidian/app.json')).toBe(true);
    expect(isValidPath('deep/nested/dir/file.txt')).toBe(true);
  });

  it('rejects absolute, traversing, or malformed paths', () => {
    expect(isValidPath('a/../b.md')).toBe(false);
    expect(isValidPath('/notes/a.md')).toBe(false);
    expect(isValidPath('C:\\vault\\a.md')).toBe(false);
    expect(isValidPath('notes\\a.md')).toBe(false);
    expect(isValidPath('notes/a\0.md')).toBe(false);
    expect(isValidPath('')).toBe(false);
    expect(isValidPath('notes//a.md')).toBe(false);
    expect(isValidPath('./a.md')).toBe(false);
    expect(isValidPath('a.md/')).toBe(false);
  });

  it('enforces the length limit', () => {
    expect(isValidPath(`${'a'.repeat(MAX_PATH_LENGTH - 3)}.md`)).toBe(true);
    expect(isValidPath(`${'a'.repeat(MAX_PATH_LENGTH - 2)}.md`)).toBe(false);
  });
});

describe('isSyncable', () => {
  it('accepts text files outside reserved and hidden directories', () => {
    expect(isSyncable('notes/a.md')).toBe(true);
    expect(isSyncable('board.canvas')).toBe(true);
    expect(isSyncable('notes/readme.txt')).toBe(true);
    expect(isSyncable('data.json')).toBe(true);
  });

  it('rejects reserved directories, dotfiles, and non-text extensions', () => {
    expect(isSyncable('.obsidian/app.json')).toBe(false);
    expect(isSyncable('.trash/a.md')).toBe(false);
    expect(isSyncable('.git/config.json')).toBe(false);
    expect(isSyncable('.carbon/state.json')).toBe(false);
    expect(isSyncable('notes/.hidden.md')).toBe(false);
    expect(isSyncable('.env.md')).toBe(false);
    expect(isSyncable('img.png')).toBe(false);
    expect(isSyncable('archive.zip')).toBe(false);
    expect(isSyncable('Makefile')).toBe(false);
  });

  it('rejects invalid paths', () => {
    expect(isSyncable('a/../b.md')).toBe(false);
    expect(isSyncable('/notes/a.md')).toBe(false);
  });

  it('honors extra ignore globs', () => {
    expect(isSyncable('Private/x/y.md', ['Private/**'])).toBe(false);
    expect(isSyncable('Public/x/y.md', ['Private/**'])).toBe(true);
    expect(isSyncable('a.md', ['*.md'])).toBe(false);
    expect(isSyncable('notes/a.md', ['*.md'])).toBe(true);
    expect(isSyncable('a.md', ['**/*.md'])).toBe(false);
    expect(isSyncable('notes/a.md', ['**/*.md'])).toBe(false);
    expect(isSyncable('notes/a.md', ['Private/**', 'notes/**'])).toBe(false);
  });
});
