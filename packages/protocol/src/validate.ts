import type { ErrorCode } from './errors.js';
import { ProtocolError } from './errors.js';
import type { Change, ClientMessage, ServerMessage } from './messages.js';
import { MAX_CONTENT_BYTES, PROTOCOL_VERSION } from './messages.js';
import { isValidPath } from './paths.js';

type Fields = Record<string, unknown>;

const encoder = new TextEncoder();
const ERROR_CODES: Record<ErrorCode, true> = {
  bad_request: true,
  too_large: true,
  unauthorized: true,
  rename_conflict: true,
};

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value);
}

function asFields(value: unknown, what: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError('bad_request', `${what} must be a JSON object`);
  }
  return value as Fields;
}

function readString(fields: Fields, key: string, what: string): string {
  const value = fields[key];
  if (typeof value !== 'string') {
    throw new ProtocolError('bad_request', `${what}.${key} must be a string`);
  }
  return value;
}

function readNonEmptyString(fields: Fields, key: string, what: string): string {
  const value = readString(fields, key, what);
  if (value.length === 0) {
    throw new ProtocolError('bad_request', `${what}.${key} must not be empty`);
  }
  return value;
}

function readCount(fields: Fields, key: string, what: string): number {
  const value = fields[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolError('bad_request', `${what}.${key} must be a non-negative integer`);
  }
  return value;
}

function readBoolean(fields: Fields, key: string, what: string): boolean {
  const value = fields[key];
  if (typeof value !== 'boolean') {
    throw new ProtocolError('bad_request', `${what}.${key} must be a boolean`);
  }
  return value;
}

function readPath(fields: Fields, key: string, what: string): string {
  const value = readString(fields, key, what);
  if (!isValidPath(value)) {
    throw new ProtocolError('bad_request', `${what}.${key} is not a valid vault path`);
  }
  return value;
}

function readContent(fields: Fields, key: string, what: string): string | null {
  const value = fields[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ProtocolError('bad_request', `${what}.${key} must be a string or null`);
  }
  if (encoder.encode(value).length > MAX_CONTENT_BYTES) {
    throw new ProtocolError('too_large', `${what}.${key} exceeds ${MAX_CONTENT_BYTES} bytes`);
  }
  return value;
}

function readNullableString(fields: Fields, key: string, what: string): string | null {
  const value = fields[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ProtocolError('bad_request', `${what}.${key} must be a string or null`);
  }
  return value;
}

function parseChange(value: unknown): Change {
  const fields = asFields(value, 'change');
  return {
    path: readPath(fields, 'path', 'change'),
    rev: readCount(fields, 'rev', 'change'),
    deleted: readBoolean(fields, 'deleted', 'change'),
    content: readContent(fields, 'content', 'change'),
    hash: readNullableString(fields, 'hash', 'change'),
    deviceId: readNonEmptyString(fields, 'deviceId', 'change'),
    seq: readCount(fields, 'seq', 'change'),
  };
}

function parseFrame(raw: string): Fields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError('bad_request', 'frame is not valid JSON');
  }
  const frame = asFields(parsed, 'frame');
  if (frame.v !== PROTOCOL_VERSION) {
    throw new ProtocolError('bad_request', `frame.v must be ${PROTOCOL_VERSION}`);
  }
  if (typeof frame.type !== 'string') {
    throw new ProtocolError('bad_request', 'frame.type must be a string');
  }
  return frame;
}

/** Parse and validate one client -> server text frame. Throws `ProtocolError`. */
export function parseClientMessage(raw: string): ClientMessage {
  const frame = parseFrame(raw);
  switch (frame.type) {
    case 'hello':
      return {
        v: PROTOCOL_VERSION,
        type: 'hello',
        token: readNonEmptyString(frame, 'token', 'hello'),
        deviceId: readNonEmptyString(frame, 'deviceId', 'hello'),
        since: readCount(frame, 'since', 'hello'),
      };
    case 'push':
      return {
        v: PROTOCOL_VERSION,
        type: 'push',
        reqId: readNonEmptyString(frame, 'reqId', 'push'),
        path: readPath(frame, 'path', 'push'),
        baseRev: readCount(frame, 'baseRev', 'push'),
        content: readContent(frame, 'content', 'push'),
      };
    case 'rename':
      return {
        v: PROTOCOL_VERSION,
        type: 'rename',
        reqId: readNonEmptyString(frame, 'reqId', 'rename'),
        from: readPath(frame, 'from', 'rename'),
        to: readPath(frame, 'to', 'rename'),
        baseRev: readCount(frame, 'baseRev', 'rename'),
      };
    default:
      throw new ProtocolError('bad_request', `unknown client message type: ${String(frame.type)}`);
  }
}

/** Parse and validate one server -> client text frame. Throws `ProtocolError`. */
export function parseServerMessage(raw: string): ServerMessage {
  const frame = parseFrame(raw);
  switch (frame.type) {
    case 'welcome': {
      const changes = frame.changes;
      if (!Array.isArray(changes)) {
        throw new ProtocolError('bad_request', 'welcome.changes must be an array');
      }
      return {
        v: PROTOCOL_VERSION,
        type: 'welcome',
        cursor: readCount(frame, 'cursor', 'welcome'),
        changes: changes.map(parseChange),
      };
    }
    case 'ack':
      return {
        v: PROTOCOL_VERSION,
        type: 'ack',
        reqId: readNonEmptyString(frame, 'reqId', 'ack'),
        path: readPath(frame, 'path', 'ack'),
        rev: readCount(frame, 'rev', 'ack'),
        cursor: readCount(frame, 'cursor', 'ack'),
      };
    case 'reject': {
      const current = asFields(frame.current, 'reject.current');
      return {
        v: PROTOCOL_VERSION,
        type: 'reject',
        reqId: readNonEmptyString(frame, 'reqId', 'reject'),
        path: readPath(frame, 'path', 'reject'),
        current: {
          rev: readCount(current, 'rev', 'reject.current'),
          content: readContent(current, 'content', 'reject.current'),
        },
      };
    }
    case 'change':
      return {
        v: PROTOCOL_VERSION,
        type: 'change',
        cursor: readCount(frame, 'cursor', 'change'),
        change: parseChange(frame.change),
      };
    case 'error': {
      const code = frame.code;
      if (!isErrorCode(code)) {
        throw new ProtocolError(
          'bad_request',
          `error.code is not a known error code: ${String(code)}`,
        );
      }
      const message = readString(frame, 'message', 'error');
      const reqId = frame.reqId;
      if (reqId !== undefined && typeof reqId !== 'string') {
        throw new ProtocolError('bad_request', 'error.reqId must be a string when present');
      }
      return {
        v: PROTOCOL_VERSION,
        type: 'error',
        ...(reqId === undefined ? {} : { reqId }),
        code,
        message,
      };
    }
    default:
      throw new ProtocolError('bad_request', `unknown server message type: ${String(frame.type)}`);
  }
}
