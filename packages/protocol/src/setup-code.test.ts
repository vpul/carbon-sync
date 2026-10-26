import { describe, expect, it } from 'vitest';
import { ProtocolError } from './errors.js';
import type { SetupPayload } from './setup-code.js';
import { decodeSetupCode, encodeSetupCode, MIN_TOKEN_LENGTH } from './setup-code.js';

const payload: SetupPayload = {
  url: 'https://sync.example.com',
  vault: 'vault-1',
  token: 't'.repeat(MIN_TOKEN_LENGTH),
};

function decodeError(code: string): ProtocolError {
  try {
    decodeSetupCode(code);
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    return error as ProtocolError;
  }
  throw new Error('expected a ProtocolError');
}

function codeFor(value: unknown): string {
  return `carbon1:${btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

describe('setup codes', () => {
  it('round-trips a payload', () => {
    const code = encodeSetupCode(payload);
    expect(code.startsWith('carbon1:')).toBe(true);
    expect(decodeSetupCode(code)).toEqual(payload);
  });

  it('accepts http URLs and tokens at the minimum length', () => {
    const local: SetupPayload = {
      url: 'http://localhost:8787',
      vault: 'my-vault',
      token: 'x'.repeat(MIN_TOKEN_LENGTH),
    };
    expect(decodeSetupCode(encodeSetupCode(local))).toEqual(local);
  });

  it('rejects a bad prefix', () => {
    expect(decodeError(`carbon2:${encodeSetupCode(payload).slice('carbon1:'.length)}`).code).toBe(
      'bad_request',
    );
  });

  it('rejects invalid base64url', () => {
    expect(decodeError('carbon1:***').code).toBe('bad_request');
    expect(decodeError('carbon1:').code).toBe('bad_request');
  });

  it('rejects a bad url', () => {
    const ftp = encodeSetupCode({ ...payload, url: 'ftp://sync.example.com' });
    expect(decodeError(ftp).code).toBe('bad_request');
    const relative = encodeSetupCode({ ...payload, url: 'sync.example.com' });
    expect(decodeError(relative).code).toBe('bad_request');
    const missing = encodeSetupCode({ ...payload, url: '' });
    expect(decodeError(missing).code).toBe('bad_request');
  });

  it('rejects a short token', () => {
    const short = encodeSetupCode({ ...payload, token: 'x'.repeat(MIN_TOKEN_LENGTH - 1) });
    expect(decodeError(short).code).toBe('bad_request');
  });

  it('rejects an invalid vault id', () => {
    const invalid = encodeSetupCode({ ...payload, vault: 'Bad_Vault' });
    expect(decodeError(invalid).code).toBe('bad_request');
  });

  it('rejects payloads with missing fields or wrong types', () => {
    expect(decodeError(codeFor({})).code).toBe('bad_request');
    expect(decodeError(codeFor({ ...payload, token: 42 })).code).toBe('bad_request');
    expect(decodeError(codeFor([])).code).toBe('bad_request');
  });
});
