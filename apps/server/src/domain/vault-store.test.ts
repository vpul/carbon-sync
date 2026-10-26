import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { NodeSql } from '../data/node-sql.js';
import { VaultStore } from './vault-store.js';

function setup(): VaultStore {
  const sql = new NodeSql(new DatabaseSync(':memory:'));
  let clock = 1_000;
  const store = new VaultStore({
    sql,
    transaction: (fn) => sql.transaction(fn),
    now: () => clock++,
  });
  store.migrate();
  return store;
}

describe('VaultStore', () => {
  it('creates a file at baseRev 0', () => {
    const store = setup();

    const result = store.push({
      path: 'note.md',
      baseRev: 0,
      content: 'one',
      hash: 'h1',
      deviceId: 'dev-a',
    });

    expect(result).toEqual({
      kind: 'ack',
      rev: 1,
      cursor: 1,
      change: {
        path: 'note.md',
        rev: 1,
        deleted: false,
        content: 'one',
        hash: 'h1',
        deviceId: 'dev-a',
        seq: 1,
      },
    });
    expect(store.cursor()).toBe(1);
  });

  it('rejects creating a missing file with a non-zero baseRev', () => {
    const store = setup();

    const result = store.push({
      path: 'note.md',
      baseRev: 3,
      content: 'one',
      hash: 'h1',
      deviceId: 'dev-a',
    });

    expect(result).toEqual({ kind: 'reject', current: { rev: 0, content: null } });
    expect(store.cursor()).toBe(0);
    expect(store.changesSince(0)).toEqual([]);
  });

  it('updates a file whose baseRev matches', () => {
    const store = setup();
    store.push({ path: 'note.md', baseRev: 0, content: 'one', hash: 'h1', deviceId: 'dev-a' });

    const result = store.push({
      path: 'note.md',
      baseRev: 1,
      content: 'two',
      hash: 'h2',
      deviceId: 'dev-b',
    });

    expect(result).toEqual({
      kind: 'ack',
      rev: 2,
      cursor: 2,
      change: {
        path: 'note.md',
        rev: 2,
        deleted: false,
        content: 'two',
        hash: 'h2',
        deviceId: 'dev-b',
        seq: 2,
      },
    });
  });

  it('rejects a stale baseRev with the current state', () => {
    const store = setup();
    store.push({ path: 'note.md', baseRev: 0, content: 'one', hash: 'h1', deviceId: 'dev-a' });
    store.push({ path: 'note.md', baseRev: 1, content: 'two', hash: 'h2', deviceId: 'dev-a' });

    const result = store.push({
      path: 'note.md',
      baseRev: 1,
      content: 'three',
      hash: 'h3',
      deviceId: 'dev-b',
    });

    expect(result).toEqual({ kind: 'reject', current: { rev: 2, content: 'two' } });
    expect(store.cursor()).toBe(2);
  });

  it('acks identical content without bumping rev or seq', () => {
    const store = setup();
    store.push({ path: 'note.md', baseRev: 0, content: 'one', hash: 'h1', deviceId: 'dev-a' });

    const result = store.push({
      path: 'note.md',
      baseRev: 1,
      content: 'one',
      hash: 'h1',
      deviceId: 'dev-b',
    });

    expect(result).toEqual({ kind: 'ack', rev: 1, cursor: 1, change: null });
    expect(store.cursor()).toBe(1);
    expect(store.changesSince(0)).toHaveLength(1);
  });

  it('deletes a live file as a tombstone', () => {
    const store = setup();
    store.push({ path: 'note.md', baseRev: 0, content: 'one', hash: 'h1', deviceId: 'dev-a' });

    const result = store.push({
      path: 'note.md',
      baseRev: 1,
      content: null,
      hash: null,
      deviceId: 'dev-b',
    });

    expect(result).toEqual({
      kind: 'ack',
      rev: 2,
      cursor: 2,
      change: {
        path: 'note.md',
        rev: 2,
        deleted: true,
        content: null,
        hash: null,
        deviceId: 'dev-b',
        seq: 2,
      },
    });
    expect(store.changesSince(1)).toEqual([
      {
        path: 'note.md',
        rev: 2,
        deleted: true,
        content: null,
        hash: null,
        deviceId: 'dev-b',
        seq: 2,
      },
    ]);
  });

  it('acks deleting a missing file with rev 0 and no change', () => {
    const store = setup();

    const result = store.push({
      path: 'gone.md',
      baseRev: 0,
      content: null,
      hash: null,
      deviceId: 'dev-a',
    });

    expect(result).toEqual({ kind: 'ack', rev: 0, cursor: 0, change: null });
    expect(store.changesSince(0)).toEqual([]);
  });

  it('re-creates over a tombstone only with the tombstone rev', () => {
    const store = setup();
    store.push({ path: 'note.md', baseRev: 0, content: 'one', hash: 'h1', deviceId: 'dev-a' });
    store.push({ path: 'note.md', baseRev: 1, content: null, hash: null, deviceId: 'dev-a' });

    const stale = store.push({
      path: 'note.md',
      baseRev: 1,
      content: 'back',
      hash: 'h3',
      deviceId: 'dev-b',
    });
    expect(stale).toEqual({ kind: 'reject', current: { rev: 2, content: null } });

    const result = store.push({
      path: 'note.md',
      baseRev: 2,
      content: 'back',
      hash: 'h3',
      deviceId: 'dev-b',
    });
    expect(result).toEqual({
      kind: 'ack',
      rev: 3,
      cursor: 3,
      change: {
        path: 'note.md',
        rev: 3,
        deleted: false,
        content: 'back',
        hash: 'h3',
        deviceId: 'dev-b',
        seq: 3,
      },
    });
  });

  it('returns only rows newer than the cursor, including tombstones', () => {
    const store = setup();
    store.push({ path: 'a.md', baseRev: 0, content: 'a', hash: 'ha', deviceId: 'd' });
    store.push({ path: 'b.md', baseRev: 0, content: 'b', hash: 'hb', deviceId: 'd' });
    store.push({ path: 'a.md', baseRev: 1, content: 'a2', hash: 'ha2', deviceId: 'd' });
    store.push({ path: 'b.md', baseRev: 1, content: null, hash: null, deviceId: 'd' });

    const changes = store.changesSince(2);

    expect(changes.map((change) => [change.path, change.seq, change.deleted])).toEqual([
      ['a.md', 3, false],
      ['b.md', 4, true],
    ]);
    expect(store.changesSince(4)).toEqual([]);
    // One row per path: the latest state of each file, at its own seq.
    expect(store.changesSince(0)).toHaveLength(2);
  });

  it('renames a live file to a tombstoned path with two consecutive changes', () => {
    const store = setup();
    store.push({ path: 'old.md', baseRev: 0, content: 'body', hash: 'h-old', deviceId: 'd' });
    store.push({ path: 'new.md', baseRev: 0, content: 'stale', hash: 'h-stale', deviceId: 'd' });
    store.push({ path: 'new.md', baseRev: 1, content: null, hash: null, deviceId: 'd' });

    const result = store.rename({
      from: 'old.md',
      to: 'new.md',
      baseRev: 1,
      deviceId: 'dev-r',
      toHash: 'h-moved',
    });

    expect(result).toEqual({
      kind: 'ack',
      rev: 3,
      cursor: 5,
      changes: [
        {
          path: 'old.md',
          rev: 2,
          deleted: true,
          content: null,
          hash: null,
          deviceId: 'dev-r',
          seq: 4,
        },
        {
          path: 'new.md',
          rev: 3,
          deleted: false,
          content: 'body',
          hash: 'h-moved',
          deviceId: 'dev-r',
          seq: 5,
        },
      ],
    });

    const changes = store.changesSince(3);
    expect(changes.map((change) => change.seq)).toEqual([4, 5]);
    expect(changes.map((change) => change.path)).toEqual(['old.md', 'new.md']);
  });

  it('refuses to rename onto a live path', () => {
    const store = setup();
    store.push({ path: 'a.md', baseRev: 0, content: 'a', hash: 'ha', deviceId: 'd' });
    store.push({ path: 'b.md', baseRev: 0, content: 'b', hash: 'hb', deviceId: 'd' });

    const result = store.rename({
      from: 'a.md',
      to: 'b.md',
      baseRev: 1,
      deviceId: 'd',
      toHash: 'hb',
    });

    expect(result).toEqual({ kind: 'conflict' });
    expect(store.cursor()).toBe(2);
    expect(store.changesSince(0)).toHaveLength(2);
  });

  it('rejects a rename from a stale or missing path', () => {
    const store = setup();
    store.push({ path: 'a.md', baseRev: 0, content: 'a', hash: 'ha', deviceId: 'd' });
    store.push({ path: 'a.md', baseRev: 1, content: 'a2', hash: 'ha2', deviceId: 'd' });

    expect(
      store.rename({ from: 'a.md', to: 'b.md', baseRev: 1, deviceId: 'd', toHash: 'ha2' }),
    ).toEqual({ kind: 'reject', current: { rev: 2, content: 'a2' } });

    expect(
      store.rename({ from: 'nope.md', to: 'b.md', baseRev: 0, deviceId: 'd', toHash: 'ha2' }),
    ).toEqual({ kind: 'reject', current: { rev: 0, content: null } });

    expect(store.cursor()).toBe(2);
  });

  it('migrates repeatedly without disturbing state', () => {
    const store = setup();
    store.push({ path: 'note.md', baseRev: 0, content: 'one', hash: 'h1', deviceId: 'd' });

    store.migrate();
    store.migrate();

    expect(store.cursor()).toBe(1);
    expect(store.changesSince(0)).toHaveLength(1);
  });
});
