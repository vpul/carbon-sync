export const VAULT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidVaultId(value: unknown): value is string {
  return typeof value === 'string' && VAULT_ID_RE.test(value);
}
