import { setImmediate as tick } from 'node:timers/promises';
import { sha256Hex } from '@carbon-sync/protocol';
import { describe, expect, it } from 'vitest';
import { SyncEngine, type SyncEvent } from './engine.js';
import type { Clock, Connection, TimerHandle, Transport } from './ports.js';
import { LoopbackServer } from './testing/loopback.js';
import { MemoryFileSystem } from './testing/memory-fs.js';
import { MemoryStateStore } from './testing/memory-state.js';

class FakeClock implements Clock {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.current + ms, run: callback });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    if (typeof handle === 'number') {
      this.timers.delete(handle);
    }
  }

  now(): number {
    return this.current;
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      let nextRun: (() => void) | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
          nextRun = timer.run;
        }
      }
      if (nextId === null || nextRun === null) {
        break;
      }
      this.timers.delete(nextId);
      this.current = Math.max(this.current, nextAt);
      nextRun();
      await tick();
    }
    this.current = target;
    await tick();
  }
}

/** Transport gate so a test can drop a live connection without stopping the engine. */
class Door implements Transport {
  online = true;
  private connection: Connection | null = null;

  constructor(public inner: Transport) {}

  async connect(url: string): Promise<Connection> {
    if (!this.online) {
      throw new Error('door is offline');
    }
    const connection = await this.inner.connect(url);
    this.connection = connection;
    return connection;
  }

  cut(): void {
    this.online = false;
    const connection = this.connection;
    this.connection = null;
    connection?.close();
  }

  open(): void {
    this.online = true;
  }
}

interface Device {
  fs: MemoryFileSystem;
  state: MemoryStateStore;
  door: Door;
  engine: SyncEngine;
  events: SyncEvent[];
}

function makeDevice(
  server: LoopbackServer,
  clock: Clock,
  fs: MemoryFileSystem = new MemoryFileSystem(),
  state: MemoryStateStore = new MemoryStateStore(),
  ignore: readonly string[] = [],
): Device {
  const door = new Door(server);
  const events: SyncEvent[] = [];
  const engine = new SyncEngine({
    fs,
    state,
    transport: door,
    clock,
    url: 'loopback://vault',
    token: 'test-token',
    debounceMs: 500,
    ignore,
    onEvent: (event) => events.push(event),
  });
  return { fs, state, door, engine, events };
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) {
      return;
    }
    // The engine hashes through Web Crypto, which resolves on the libuv
    // threadpool; a microtask-only spin can outrun it under parallel load.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 1);
    await promise;
  }
  throw new Error(`timed out: ${label}`);
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await tick();
  }
}

async function seedPair(
  clock: FakeClock,
  server: LoopbackServer,
  content = 'hello world',
): Promise<{ a: Device; b: Device }> {
  const a = makeDevice(server, clock);
  const b = makeDevice(server, clock);
  await a.engine.start();
  await b.engine.start();
  await settle();
  await a.fs.write('note.md', content);
  a.engine.notifyLocalChange('note.md');
  await clock.advance(500);
  await until(
    () => a.fs.files.get('note.md') === content && b.fs.files.get('note.md') === content,
    'seed pair',
  );
  await settle();
  return { a, b };
}

describe('SyncEngine', () => {
  it('propagates a new file from A to B', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const a = makeDevice(server, clock);
    const b = makeDevice(server, clock);
    await a.engine.start();
    await b.engine.start();
    await settle();

    await a.fs.write('a.md', 'one');
    a.engine.notifyLocalChange('a.md');
    await clock.advance(500);

    await until(() => b.fs.files.get('a.md') === 'one', 'B receives a.md');
    expect(a.fs.files.get('a.md')).toBe('one');
  });

  it('merges edits to different words of the same line', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const { a, b } = await seedPair(clock, server);
    a.events.length = 0;
    b.events.length = 0;

    await a.fs.write('note.md', 'hello there');
    a.engine.notifyLocalChange('note.md');
    await b.fs.write('note.md', 'hi world');
    b.engine.notifyLocalChange('note.md');
    await clock.advance(500);

    await until(
      () => a.fs.files.get('note.md') === 'hi there' && b.fs.files.get('note.md') === 'hi there',
      'both converge to the merged text',
    );
    await settle();

    const merged = [...a.events, ...b.events].filter((event) => event.type === 'merged');
    expect(merged).toHaveLength(1);
    expect([...a.fs.files.keys()].some((path) => path.includes('conflict'))).toBe(false);
    expect([...b.fs.files.keys()].some((path) => path.includes('conflict'))).toBe(false);
  });

  it('keeps B offline edits and merges them on reconnect', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const { a, b } = await seedPair(clock, server, 'alpha beta');

    b.door.cut();
    await until(() => b.engine.status() === 'offline', 'B offline');
    await b.fs.write('note.md', 'alpha BETA');
    b.engine.notifyLocalChange('note.md');
    await clock.advance(500);

    await a.fs.write('note.md', 'ALPHA beta');
    a.engine.notifyLocalChange('note.md');
    await clock.advance(500);
    await until(() => server.store.file('note.md')?.content === 'ALPHA beta', 'A edit accepted');

    b.door.open();
    await clock.advance(10_000);

    await until(
      () =>
        a.fs.files.get('note.md') === 'ALPHA BETA' && b.fs.files.get('note.md') === 'ALPHA BETA',
      'offline edit survives reconnect',
    );
  });

  it('brings a file back when a local delete races a remote edit', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const { a, b } = await seedPair(clock, server);

    await a.fs.remove('note.md');
    a.engine.notifyLocalDelete('note.md');
    await b.fs.write('note.md', 'edited by B');
    b.engine.notifyLocalChange('note.md');
    await clock.advance(500);

    await until(() => server.store.file('note.md')?.content === 'edited by B', 'B edit wins');
    await until(() => a.fs.files.get('note.md') === 'edited by B', 'A gets the file back');
    expect(server.store.file('note.md')?.deleted).toBe(false);
  });

  it('recreates a remote-deleted file when the local edit is unsynced', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const { a, b } = await seedPair(clock, server);

    await b.fs.remove('note.md');
    b.engine.notifyLocalDelete('note.md');
    await clock.advance(500);
    await until(() => server.store.file('note.md')?.deleted === true, 'server tombstone');

    await a.fs.write('note.md', 'A local edit');
    a.engine.notifyLocalChange('note.md');
    await clock.advance(500);
    await until(() => server.store.file('note.md')?.content === 'A local edit', 'local wins');
    await until(() => b.fs.files.get('note.md') === 'A local edit', 'B gets recreated file');

    await clock.advance(500);
    await settle();
    expect(server.store.file('note.md')?.deleted).toBe(false);
    expect(server.store.file('note.md')?.content).toBe('A local edit');
  });

  it('propagates a rename as a rename with content', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const { a, b } = await seedPair(clock, server);
    const pushes = server.pushes;

    await a.fs.rename('note.md', 'renamed.md');
    a.engine.notifyLocalRename('note.md', 'renamed.md');

    await until(
      () => b.fs.files.get('renamed.md') === 'hello world' && !b.fs.files.has('note.md'),
      'B sees the renamed file',
    );
    expect(server.store.file('note.md')?.deleted).toBe(true);
    expect(server.store.file('renamed.md')?.content).toBe('hello world');
    expect(server.pushes).toBe(pushes);
  });

  it('does not push back a change it just applied', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const { a, b } = await seedPair(clock, server);

    await a.fs.write('note.md', 'hello from A');
    a.engine.notifyLocalChange('note.md');
    await clock.advance(500);
    await until(() => b.fs.files.get('note.md') === 'hello from A', 'B applies remote write');

    const pushes = server.pushes;
    b.engine.notifyLocalChange('note.md');
    b.engine.notifyLocalDelete('note.md');
    await clock.advance(600);
    await settle();
    expect(server.pushes).toBe(pushes);
    expect(b.engine.status()).toBe('idle');
  });

  it('gives a fresh empty device only live files', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const a = makeDevice(server, clock);
    await a.engine.start();
    await settle();

    await a.fs.write('live.md', 'live');
    a.engine.notifyLocalChange('live.md');
    await a.fs.write('gone.md', 'gone');
    a.engine.notifyLocalChange('gone.md');
    await clock.advance(500);
    await until(() => server.store.file('gone.md') !== undefined, 'both files on server');
    await a.fs.remove('gone.md');
    a.engine.notifyLocalDelete('gone.md');
    await clock.advance(500);
    await until(() => server.store.file('gone.md')?.deleted === true, 'gone tombstoned');

    const pushes = server.pushes;
    const c = makeDevice(server, clock);
    await c.engine.start();
    await until(() => c.engine.status() === 'idle', 'C idle');
    await settle();

    expect([...c.fs.files.keys()]).toEqual(['live.md']);
    expect(c.fs.files.get('live.md')).toBe('live');
    expect(server.pushes).toBe(pushes);
  });

  it('adopts matching server rows for a fresh device with a local copy', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const a = makeDevice(server, clock);
    await a.engine.start();
    await settle();
    await a.fs.write('a.md', 'alpha');
    a.engine.notifyLocalChange('a.md');
    await a.fs.write('nested/b.md', 'beta');
    a.engine.notifyLocalChange('nested/b.md');
    await clock.advance(500);
    await until(
      () =>
        server.store.file('a.md') !== undefined && server.store.file('nested/b.md') !== undefined,
      'files on server',
    );

    const pushes = server.pushes;
    const fs = new MemoryFileSystem({ 'a.md': 'alpha', 'nested/b.md': 'beta' });
    const d = makeDevice(server, clock, fs);
    await d.engine.start();
    await until(() => d.engine.status() === 'idle', 'D idle');
    await settle();

    expect(d.fs.files.get('a.md')).toBe('alpha');
    expect(d.fs.files.get('nested/b.md')).toBe('beta');
    expect([...d.fs.files.keys()].some((path) => path.includes('conflict'))).toBe(false);
    expect(server.pushes).toBe(pushes);
    const persisted = d.state.snapshot();
    expect(persisted.files['a.md']?.base).toBe('alpha');
    expect(persisted.files['a.md']?.rev).toBe(server.store.file('a.md')?.rev);
  });

  it('debounces five rapid local changes into one push', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const a = makeDevice(server, clock);
    await a.engine.start();
    await settle();

    for (let version = 1; version <= 5; version += 1) {
      await a.fs.write('rapid.md', `v${version}`);
      a.engine.notifyLocalChange('rapid.md');
      await clock.advance(100);
    }
    expect(server.pushes).toBe(0);

    await clock.advance(500);
    await until(() => server.pushes === 1, 'one debounced push');
    await settle();
    expect(server.pushLog).toEqual([{ path: 'rapid.md', content: 'v5' }]);
  });

  it('never pushes ignored paths', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const fs = new MemoryFileSystem({ '.obsidian/x.json': '{}', 'pic.png': 'binary' });
    const a = makeDevice(server, clock, fs);
    await a.engine.start();
    await settle();

    await a.fs.write('.obsidian/another.json', '{}');
    a.engine.notifyLocalChange('.obsidian/another.json');
    await a.fs.write('pic2.png', 'binary');
    a.engine.notifyLocalChange('pic2.png');
    await clock.advance(600);
    await settle();

    expect(server.pushes).toBe(0);
    expect(server.pushLog).toEqual([]);
  });

  it('does not persist a cursor ahead of an unapplied change', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const a = makeDevice(server, clock);
    const gated = new GatedFileSystem();
    const b = makeDevice(server, clock, gated);
    await a.engine.start();
    await b.engine.start();
    await settle();
    await a.fs.write('note.md', 'base');
    a.engine.notifyLocalChange('note.md');
    await clock.advance(500);
    await until(() => gated.files.get('note.md') === 'base', 'B base');

    const gate = Promise.withResolvers<void>();
    gated.gate = gate.promise;

    await a.fs.write('note.md', 'from A');
    a.engine.notifyLocalChange('note.md');
    await clock.advance(500);
    await until(() => gated.writeStarted, 'B write is blocked');

    const cursorBefore = b.state.snapshot().cursor;
    expect(cursorBefore).toBe(1);
    b.engine.stop();
    gate.resolve();
    await settle();
    expect(b.state.snapshot().cursor).toBe(cursorBefore);

    // Simulate the in-flight write being lost with the crashed process.
    gated.gate = null;
    await gated.remove('note.md');
    const pushes = server.pushes;
    await b.engine.start();
    await until(() => gated.files.get('note.md') === 'from A', 'change arrives via welcome');
    await until(() => b.state.snapshot().cursor > cursorBefore, 'cursor advances after apply');
    await settle();
    expect(server.pushes).toBe(pushes);
  });

  it('keeps both copies when a fresh device has an unrelated local version', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const a = makeDevice(server, clock);
    await a.engine.start();
    await settle();
    await a.fs.write('note.md', 'remote text');
    a.engine.notifyLocalChange('note.md');
    await clock.advance(500);
    await until(() => server.store.file('note.md')?.content === 'remote text', 'remote file');

    const fs = new MemoryFileSystem({ 'note.md': 'local text' });
    const d = makeDevice(server, clock, fs);
    await d.engine.start();
    await until(() => d.fs.files.get('note.md') === 'remote text', 'remote copy wins path');
    await until(
      () => [...d.fs.files.keys()].some((path) => path.startsWith('note (conflict ')),
      'conflict copy written',
    );

    const conflictPath = [...d.fs.files.keys()].find((path) => path.startsWith('note (conflict '));
    if (conflictPath === undefined) {
      throw new Error('conflict copy not created');
    }
    expect(d.fs.files.get(conflictPath)).toBe('local text');
    await until(
      () => server.store.file(conflictPath)?.content === 'local text',
      'conflict copy pushed',
    );
    const merged = d.events.filter(
      (event) => event.type === 'merged' && event.detail === 'conflict-copy',
    );
    expect(merged).toHaveLength(1);
  });

  it('pushes a local edit that returns to content the server once echoed', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const { a, b } = await seedPair(clock, server, 'one');
    // No local event is delivered for the engine's own write on B.
    await until(() => b.fs.files.get('note.md') === 'one', 'B applies the remote write');
    await settle();
    const pushes = server.pushes;

    await b.fs.write('note.md', 'two');
    b.engine.notifyLocalChange('note.md');
    await clock.advance(500);
    await until(() => server.store.file('note.md')?.content === 'two', 'B edit pushed');

    await b.fs.write('note.md', 'one');
    b.engine.notifyLocalChange('note.md');
    await clock.advance(500);
    await until(() => server.store.file('note.md')?.content === 'one', 'returning edit pushed');
    await until(() => b.state.snapshot().files['note.md']?.base === 'one', 'B persisted the ack');
    await until(() => a.fs.files.get('note.md') === 'one', 'A applied the returning edit');
    await settle();

    expect(server.pushes).toBe(pushes + 2);
    expect(b.state.snapshot().files['note.md']?.rev).toBe(server.store.file('note.md')?.rev);
  });

  it('re-uploads every file after the server loses its state', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const a = makeDevice(server, clock);
    await a.engine.start();
    await settle();
    await a.fs.write('a.md', 'alpha');
    a.engine.notifyLocalChange('a.md');
    await a.fs.write('nested/b.md', 'beta');
    a.engine.notifyLocalChange('nested/b.md');
    await clock.advance(500);
    await until(
      () =>
        server.store.file('a.md') !== undefined && server.store.file('nested/b.md') !== undefined,
      'files on the first server',
    );
    await settle();
    expect(a.state.snapshot().cursor).toBeGreaterThan(0);

    const fresh = new LoopbackServer();
    a.door.inner = fresh;
    a.engine.syncNow();
    await until(
      () =>
        fresh.store.file('a.md')?.content === 'alpha' &&
        fresh.store.file('nested/b.md')?.content === 'beta',
      'files re-uploaded to the fresh server',
    );
    await until(
      () =>
        a.state.snapshot().files['a.md']?.rev === 1 &&
        a.state.snapshot().files['nested/b.md']?.rev === 1 &&
        a.state.snapshot().cursor === fresh.store.cursor(),
      'fresh revisions persisted',
    );
    await settle();

    expect(a.state.snapshot().files['a.md']?.rev).toBe(1);
    expect(a.state.snapshot().files['nested/b.md']?.rev).toBe(1);
    expect(a.state.snapshot().cursor).toBe(fresh.store.cursor());
    expect(a.events.some((event) => event.detail === 'server-reset')).toBe(true);
  });

  it('re-pushes a local edit when the server has no row for the saved revision', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const hash = await sha256Hex('old');
    const state = new MemoryStateStore({
      cursor: 0,
      deviceId: 'stale-device',
      files: { 'a.md': { rev: 5, hash, base: 'old' } },
    });
    const fs = new MemoryFileSystem({ 'a.md': 'old' });
    const a = makeDevice(server, clock, fs, state);
    await a.engine.start();
    await until(() => a.engine.status() === 'idle', 'A idle');
    await settle();
    expect(server.store.file('a.md')).toBeUndefined();

    await a.fs.write('a.md', 'new');
    a.engine.notifyLocalChange('a.md');
    await clock.advance(500);
    await until(() => server.store.file('a.md')?.content === 'new', 'edit pushed as a create');
    await until(() => a.state.snapshot().files['a.md']?.rev === 1, 'create acked as rev 1');
    await settle();

    expect(server.store.file('a.md')?.rev).toBe(1);
    expect(a.state.snapshot().files['a.md']?.base).toBe('new');
  });

  it('honours extra ignore globs for remote changes', async () => {
    const clock = new FakeClock();
    const server = new LoopbackServer();
    const a = makeDevice(server, clock);
    const b = makeDevice(server, clock, new MemoryFileSystem(), new MemoryStateStore(), [
      'Private/**',
    ]);
    await a.engine.start();
    await b.engine.start();
    await settle();

    await a.fs.write('Private/x.md', 'secret');
    a.engine.notifyLocalChange('Private/x.md');
    await clock.advance(500);
    await until(() => server.store.file('Private/x.md') !== undefined, 'ignored path on server');
    await until(() => b.state.snapshot().cursor > 0, 'cursor advanced past the ignored change');
    await settle();

    expect(b.fs.files.has('Private/x.md')).toBe(false);
    expect(b.state.snapshot().cursor).toBe(server.store.cursor());
  });
});

class GatedFileSystem extends MemoryFileSystem {
  gate: Promise<void> | null = null;
  writeStarted = false;

  override async write(path: string, content: string): Promise<void> {
    if (this.gate !== null) {
      this.writeStarted = true;
      await this.gate;
    }
    await super.write(path, content);
  }
}
