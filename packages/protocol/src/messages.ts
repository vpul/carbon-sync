import type { ErrorCode } from './errors.js';

/** Version carried by every JSON text frame. */
export const PROTOCOL_VERSION = 1;

/** Maximum UTF-8 size of a file's content, in bytes (1 MiB). */
export const MAX_CONTENT_BYTES = 1_048_576;

/** Close code for a failed `hello` token check. */
export const CLOSE_UNAUTHORIZED = 4401;

/** Close code for a missing `hello` within the 10 s handshake window. */
export const CLOSE_HELLO_TIMEOUT = 4408;

/** A single vault file state as stored by the server and broadcast to clients. */
export interface Change {
  path: string;
  rev: number;
  deleted: boolean;
  content: string | null;
  hash: string | null;
  deviceId: string;
  seq: number;
}

export type ClientMessage =
  | {
      v: 1;
      type: 'hello';
      token: string;
      deviceId: string;
      since: number;
    }
  | {
      v: 1;
      type: 'push';
      reqId: string;
      path: string;
      baseRev: number;
      content: string | null;
    }
  | {
      v: 1;
      type: 'rename';
      reqId: string;
      from: string;
      to: string;
      baseRev: number;
    };

export type ServerMessage =
  | {
      v: 1;
      type: 'welcome';
      cursor: number;
      changes: Change[];
    }
  | {
      v: 1;
      type: 'ack';
      reqId: string;
      path: string;
      rev: number;
      cursor: number;
    }
  | {
      v: 1;
      type: 'reject';
      reqId: string;
      path: string;
      current: { rev: number; content: string | null };
    }
  | {
      v: 1;
      type: 'change';
      cursor: number;
      change: Change;
    }
  | {
      v: 1;
      type: 'error';
      reqId?: string;
      code: ErrorCode;
      message: string;
    };
