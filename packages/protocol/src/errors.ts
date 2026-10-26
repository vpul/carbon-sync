/** Error codes carried by `error` frames in the wire protocol. */
export type ErrorCode = 'bad_request' | 'too_large' | 'unauthorized' | 'rename_conflict';

/**
 * Raised when a frame, setup code, or path fails protocol validation.
 * Applications map `code` to a wire `error` frame or a user-facing notice.
 */
export class ProtocolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}
