import { ProtocolError } from './errors.js';
import { isValidVaultId } from './vault-id.js';

export const SETUP_CODE_PREFIX = 'carbon1:';
export const MIN_TOKEN_LENGTH = 32;

export interface SetupPayload {
  url: string;
  vault: string;
  token: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
    throw new ProtocolError('bad_request', 'setup code is not valid base64url');
  }
  const padded = encoded
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new ProtocolError('bad_request', 'setup code is not valid base64url');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encode `{ url, vault, token }` as `carbon1:` + base64url(JSON). */
export function encodeSetupCode(setup: SetupPayload): string {
  const json = JSON.stringify({ url: setup.url, vault: setup.vault, token: setup.token });
  return SETUP_CODE_PREFIX + bytesToBase64Url(new TextEncoder().encode(json));
}

/** Decode and validate a setup code. URL must be http(s), token at least 32 characters. */
export function decodeSetupCode(code: string): SetupPayload {
  if (typeof code !== 'string' || !code.startsWith(SETUP_CODE_PREFIX)) {
    throw new ProtocolError('bad_request', `setup code must start with "${SETUP_CODE_PREFIX}"`);
  }
  const encoded = code.slice(SETUP_CODE_PREFIX.length);
  let parsed: unknown;
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(encoded));
    parsed = JSON.parse(json);
  } catch (error) {
    if (error instanceof ProtocolError) {
      throw error;
    }
    throw new ProtocolError('bad_request', 'setup code payload is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError('bad_request', 'setup code payload must be a JSON object');
  }
  const { url, vault, token } = parsed as Record<string, unknown>;

  if (typeof url !== 'string') {
    throw new ProtocolError('bad_request', 'setup code url must be a string');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ProtocolError('bad_request', 'setup code url is not a valid URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.hostname === '') {
    throw new ProtocolError('bad_request', 'setup code url must be http or https');
  }
  if (!isValidVaultId(vault)) {
    throw new ProtocolError('bad_request', 'setup code vault id is invalid');
  }
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
    throw new ProtocolError(
      'bad_request',
      `setup code token must be at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  return { url, vault, token };
}
