#!/usr/bin/env node
// Live smoke test against `wrangler dev`. Expects a fresh vault (rev 1 for a.md):
//
//   CARBON_TOKEN=<token> node scripts/smoke.mjs [ws://127.0.0.1:8787/v1/vaults/test/ws]
//
// Uses the Node 22 global WebSocket; no dependencies.
const url = process.argv[2] ?? 'ws://127.0.0.1:8787/v1/vaults/test/ws';
const token = process.env.CARBON_TOKEN;
if (!token) {
  console.error('CARBON_TOKEN is required');
  process.exit(1);
}

const VERSION = 1;

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

class Client {
  frames = [];
  waiter = null;
  closed = null;
  closeWaiters = [];

  constructor(ws) {
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data);
      if (this.waiter !== null) {
        const { resolve, timer } = this.waiter;
        this.waiter = null;
        clearTimeout(timer);
        resolve(frame);
      } else {
        this.frames.push(frame);
      }
    });
    ws.addEventListener('close', (event) => {
      this.closed = { code: event.code, reason: event.reason };
      if (this.waiter !== null) {
        const { reject, timer } = this.waiter;
        this.waiter = null;
        clearTimeout(timer);
        reject(new Error(`socket closed (${event.code} ${event.reason}) before a frame`));
      }
      for (const resolve of this.closeWaiters.splice(0)) {
        resolve(this.closed);
      }
    });
  }

  static connect(target) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(target);
      ws.addEventListener('open', () => resolve(new Client(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`failed to connect to ${target}`)), {
        once: true,
      });
    });
  }

  send(frame) {
    this.ws.send(JSON.stringify({ v: VERSION, ...frame }));
  }

  next(timeoutMs = 5000) {
    if (this.frames.length > 0) {
      return Promise.resolve(this.frames.shift());
    }
    if (this.closed !== null) {
      return Promise.reject(new Error(`socket already closed (${this.closed.code})`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('timed out waiting for a frame'));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  waitClose(timeoutMs = 5000) {
    if (this.closed !== null) {
      return Promise.resolve(this.closed);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
      this.closeWaiters.push((close) => {
        clearTimeout(timer);
        resolve(close);
      });
    });
  }

  close() {
    try {
      this.ws.close(1000, 'done');
    } catch {
      // Already closed.
    }
  }
}

async function step(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    return true;
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return false;
  }
}

let a;
let b;

const ok = await step('connect + hello -> welcome on an empty vault', async () => {
  a = await Client.connect(url);
  a.send({ type: 'hello', token, deviceId: 'smoke-a', since: 0 });
  const welcome = await a.next();
  check(welcome.type === 'welcome', `expected welcome, got ${JSON.stringify(welcome)}`);
  check(welcome.cursor === 0, `expected cursor 0, got ${welcome.cursor}`);
  check(welcome.changes.length === 0, `expected no changes, got ${welcome.changes.length}`);
});

if (
  ok &&
  (await step('push a.md -> ack rev 1', async () => {
    a.send({ type: 'push', reqId: 'r1', path: 'a.md', baseRev: 0, content: 'v1' });
    const ack = await a.next();
    check(ack.type === 'ack', `expected ack, got ${JSON.stringify(ack)}`);
    check(ack.reqId === 'r1' && ack.path === 'a.md' && ack.rev === 1, 'unexpected ack payload');
  }))
) {
  const connected = await step('second socket welcome + change broadcast', async () => {
    b = await Client.connect(url);
    b.send({ type: 'hello', token, deviceId: 'smoke-b', since: 0 });
    const welcome = await b.next();
    check(welcome.type === 'welcome', `expected welcome, got ${JSON.stringify(welcome)}`);
    check(
      welcome.changes.some((change) => change.path === 'a.md' && change.rev === 1),
      'second socket welcome does not include a.md rev 1',
    );

    a.send({ type: 'push', reqId: 'r2', path: 'a.md', baseRev: 1, content: 'v2' });
    const ack = await a.next();
    check(ack.type === 'ack' && ack.rev === 2, `expected ack rev 2, got ${JSON.stringify(ack)}`);

    const change = await b.next();
    check(change.type === 'change', `expected change, got ${JSON.stringify(change)}`);
    check(
      change.change.path === 'a.md' &&
        change.change.rev === 2 &&
        change.change.content === 'v2' &&
        change.cursor === change.change.seq,
      'unexpected change payload',
    );
  });

  if (connected) {
    await step('stale push -> reject with current', async () => {
      a.send({ type: 'push', reqId: 'r3', path: 'a.md', baseRev: 1, content: 'stale' });
      const reject = await a.next();
      check(reject.type === 'reject', `expected reject, got ${JSON.stringify(reject)}`);
      check(
        reject.reqId === 'r3' && reject.current.rev === 2 && reject.current.content === 'v2',
        'unexpected reject payload',
      );
    });
  }
}

await step('bad token -> close 4401', async () => {
  const bad = await Client.connect(url);
  bad.send({ type: 'hello', token: 'wrong'.repeat(8), deviceId: 'smoke-c', since: 0 });
  const close = await bad.waitClose();
  check(close.code === 4401, `expected close 4401, got ${close.code}`);
});

a?.close();
b?.close();
await new Promise((resolve) => setTimeout(resolve, 50));
