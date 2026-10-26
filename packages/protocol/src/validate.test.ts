import { describe, expect, it } from 'vitest';
import type { ErrorCode } from './errors.js';
import { ProtocolError } from './errors.js';
import type { Change, ClientMessage, ServerMessage } from './messages.js';
import { MAX_CONTENT_BYTES, PROTOCOL_VERSION } from './messages.js';
import { parseClientMessage, parseServerMessage } from './validate.js';

const sampleChange: Change = {
  path: 'notes/a.md',
  rev: 2,
  deleted: false,
  content: '# Hello',
  hash: 'aa'.repeat(32),
  deviceId: 'device-a',
  seq: 7,
};

const clientMessages: ClientMessage[] = [
  { v: PROTOCOL_VERSION, type: 'hello', token: 't'.repeat(32), deviceId: 'device-a', since: 0 },
  {
    v: PROTOCOL_VERSION,
    type: 'push',
    reqId: 'r1',
    path: 'notes/a.md',
    baseRev: 0,
    content: '# Hi',
  },
  { v: PROTOCOL_VERSION, type: 'push', reqId: 'r2', path: 'notes/a.md', baseRev: 3, content: null },
  { v: PROTOCOL_VERSION, type: 'rename', reqId: 'r3', from: 'a.md', to: 'b.md', baseRev: 1 },
];

const serverMessages: ServerMessage[] = [
  { v: PROTOCOL_VERSION, type: 'welcome', cursor: 9, changes: [sampleChange] },
  { v: PROTOCOL_VERSION, type: 'ack', reqId: 'r1', path: 'notes/a.md', rev: 3, cursor: 10 },
  {
    v: PROTOCOL_VERSION,
    type: 'reject',
    reqId: 'r2',
    path: 'notes/a.md',
    current: { rev: 4, content: 'theirs' },
  },
  { v: PROTOCOL_VERSION, type: 'change', cursor: 11, change: sampleChange },
  { v: PROTOCOL_VERSION, type: 'error', reqId: 'r1', code: 'too_large', message: 'too big' },
  { v: PROTOCOL_VERSION, type: 'error', code: 'bad_request', message: 'nope' },
];

function captureError(run: () => unknown): ProtocolError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    return error as ProtocolError;
  }
  throw new Error('expected a ProtocolError');
}

function expectCode(run: () => unknown, code: ErrorCode): void {
  expect(captureError(run).code).toBe(code);
}

describe('parseClientMessage', () => {
  it.each(clientMessages)('round-trips a $type frame', (message) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it('rejects invalid JSON', () => {
    expectCode(() => parseClientMessage('{'), 'bad_request');
  });

  it('rejects non-object frames', () => {
    expectCode(() => parseClientMessage('[]'), 'bad_request');
    expectCode(() => parseClientMessage('null'), 'bad_request');
  });

  it('rejects a wrong protocol version', () => {
    expectCode(
      () => parseClientMessage(JSON.stringify({ ...clientMessages[0], v: 2 })),
      'bad_request',
    );
  });

  it('rejects an unknown message type', () => {
    expectCode(
      () => parseClientMessage(JSON.stringify({ v: 1, type: 'subscribe' })),
      'bad_request',
    );
  });

  it('rejects server-only message types', () => {
    expectCode(() => parseClientMessage(JSON.stringify(serverMessages[1])), 'bad_request');
  });

  it('rejects wrong field types', () => {
    expectCode(
      () =>
        parseClientMessage(
          JSON.stringify({ v: 1, type: 'push', reqId: 'r', path: 'a.md', baseRev: 0, content: 3 }),
        ),
      'bad_request',
    );
    expectCode(
      () =>
        parseClientMessage(
          JSON.stringify({ v: 1, type: 'hello', token: '', deviceId: 'd', since: 0 }),
        ),
      'bad_request',
    );
  });

  it('rejects invalid paths', () => {
    expectCode(
      () =>
        parseClientMessage(
          JSON.stringify({
            v: 1,
            type: 'push',
            reqId: 'r',
            path: 'a/../b.md',
            baseRev: 0,
            content: 'x',
          }),
        ),
      'bad_request',
    );
    expectCode(
      () =>
        parseClientMessage(
          JSON.stringify({
            v: 1,
            type: 'rename',
            reqId: 'r',
            from: 'a.md',
            to: '/b.md',
            baseRev: 0,
          }),
        ),
      'bad_request',
    );
  });

  it('rejects negative revisions', () => {
    expectCode(
      () =>
        parseClientMessage(
          JSON.stringify({
            v: 1,
            type: 'push',
            reqId: 'r',
            path: 'a.md',
            baseRev: -1,
            content: 'x',
          }),
        ),
      'bad_request',
    );
    expectCode(
      () =>
        parseClientMessage(
          JSON.stringify({ v: 1, type: 'hello', token: 't', deviceId: 'd', since: -5 }),
        ),
      'bad_request',
    );
  });

  it('rejects oversized content by UTF-8 byte length', () => {
    const ascii = 'x'.repeat(MAX_CONTENT_BYTES + 1);
    expectCode(
      () =>
        parseClientMessage(
          JSON.stringify({
            v: 1,
            type: 'push',
            reqId: 'r',
            path: 'a.md',
            baseRev: 0,
            content: ascii,
          }),
        ),
      'too_large',
    );

    const multibyte = 'é'.repeat(MAX_CONTENT_BYTES / 2 + 1);
    expectCode(
      () =>
        parseClientMessage(
          JSON.stringify({
            v: 1,
            type: 'push',
            reqId: 'r',
            path: 'a.md',
            baseRev: 0,
            content: multibyte,
          }),
        ),
      'too_large',
    );
  });
});

describe('parseServerMessage', () => {
  it.each(serverMessages)('round-trips a $type frame', (message) => {
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it('rejects invalid JSON', () => {
    expectCode(() => parseServerMessage('nope'), 'bad_request');
  });

  it('rejects client-only message types', () => {
    expectCode(() => parseServerMessage(JSON.stringify(clientMessages[0])), 'bad_request');
  });

  it('rejects a malformed change row', () => {
    expectCode(
      () =>
        parseServerMessage(
          JSON.stringify({
            v: 1,
            type: 'welcome',
            cursor: 1,
            changes: [{ ...sampleChange, rev: -1 }],
          }),
        ),
      'bad_request',
    );
    expectCode(
      () => parseServerMessage(JSON.stringify({ v: 1, type: 'change', cursor: 1, change: 'nope' })),
      'bad_request',
    );
  });

  it('rejects oversized row content', () => {
    expectCode(
      () =>
        parseServerMessage(
          JSON.stringify({
            v: 1,
            type: 'change',
            cursor: 1,
            change: { ...sampleChange, content: 'x'.repeat(MAX_CONTENT_BYTES + 1) },
          }),
        ),
      'too_large',
    );
  });

  it('rejects welcome.changes that is not an array', () => {
    expectCode(
      () =>
        parseServerMessage(
          JSON.stringify({ v: 1, type: 'welcome', cursor: 1, changes: sampleChange }),
        ),
      'bad_request',
    );
  });

  it('rejects an unknown error code and a missing message', () => {
    expectCode(
      () =>
        parseServerMessage(JSON.stringify({ v: 1, type: 'error', code: 'explode', message: 'x' })),
      'bad_request',
    );
    expectCode(
      () => parseServerMessage(JSON.stringify({ v: 1, type: 'error', code: 'bad_request' })),
      'bad_request',
    );
  });

  it('rejects a malformed reject payload', () => {
    expectCode(
      () =>
        parseServerMessage(
          JSON.stringify({
            v: 1,
            type: 'reject',
            reqId: 'r',
            path: 'a.md',
            current: { rev: 1 },
          }),
        ),
      'bad_request',
    );
  });
});
