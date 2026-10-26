import { describe, expect, it } from 'vitest';
import { type Resolution, type ResolveInput, resolve } from './resolve.js';

type Row = { input: ResolveInput; expected: Resolution };

const rows: Record<string, Row> = {
  'both sides have nothing': {
    input: { base: null, local: null, remote: null },
    expected: { action: 'noop-adopt' },
  },
  'untracked path, no local copy': {
    input: { base: null, local: null, remote: 'R' },
    expected: { action: 'write-remote' },
  },
  'untracked path, remote delete vs local file': {
    input: { base: null, local: 'L', remote: null },
    expected: { action: 'keep-local-push' },
  },
  'untracked path, identical bytes': {
    input: { base: null, local: 'L', remote: 'L' },
    expected: { action: 'noop-adopt' },
  },
  'untracked path, different bytes': {
    input: { base: null, local: 'L', remote: 'R' },
    expected: { action: 'conflict-copy' },
  },
  'remote delete, unedited local copy': {
    input: { base: 'B', local: 'B', remote: null },
    expected: { action: 'remove-local' },
  },
  'remote delete, edited local copy': {
    input: { base: 'B', local: 'L', remote: null },
    expected: { action: 'keep-local-push' },
  },
  'remote delete, local already deleted': {
    input: { base: 'B', local: null, remote: null },
    expected: { action: 'noop-adopt' },
  },
  'remote edit, unedited local copy': {
    input: { base: 'B', local: 'B', remote: 'R' },
    expected: { action: 'write-remote' },
  },
  'remote edit, identical local copy': {
    input: { base: 'B', local: 'B', remote: 'B' },
    expected: { action: 'noop-adopt' },
  },
  'remote edit, local edited to the same bytes': {
    input: { base: 'B', local: 'L', remote: 'L' },
    expected: { action: 'noop-adopt' },
  },
  'remote edit, local delete': {
    input: { base: 'B', local: null, remote: 'R' },
    expected: { action: 'write-remote' },
  },
  'both edited against a shared base': {
    input: { base: 'alpha beta', local: 'ALPHA beta', remote: 'alpha BETA' },
    expected: { action: 'merge', merged: 'ALPHA BETA' },
  },
};

describe('resolve', () => {
  it.each(Object.entries(rows))('%s', (_name, { input, expected }) => {
    expect(resolve(input)).toEqual(expected);
  });
});
