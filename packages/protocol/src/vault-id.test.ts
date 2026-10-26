import { describe, expect, it } from 'vitest';
import { isValidVaultId, VAULT_ID_RE } from './vault-id.js';

describe('vault ids', () => {
  it('accepts lowercase alphanumeric ids with dashes', () => {
    expect(isValidVaultId('a')).toBe(true);
    expect(isValidVaultId('vault-1')).toBe(true);
    expect(isValidVaultId('a1b2c3')).toBe(true);
    expect(isValidVaultId('a'.repeat(63))).toBe(true);
    expect(VAULT_ID_RE.test('my-vault')).toBe(true);
  });

  it('rejects ids that do not match the plan regex', () => {
    expect(isValidVaultId('')).toBe(false);
    expect(isValidVaultId('Vault')).toBe(false);
    expect(isValidVaultId('-vault')).toBe(false);
    expect(isValidVaultId('vault_1')).toBe(false);
    expect(isValidVaultId('vault/1')).toBe(false);
    expect(isValidVaultId('a'.repeat(64))).toBe(false);
    expect(isValidVaultId(42)).toBe(false);
    expect(isValidVaultId(null)).toBe(false);
  });
});
