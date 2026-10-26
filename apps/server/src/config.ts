import { MIN_TOKEN_LENGTH } from '@carbon-sync/protocol';
import type { VaultObject } from './transport/vault-object.js';

export type Env = {
  VAULT: DurableObjectNamespace<VaultObject>;
  CARBON_TOKEN: string;
};

export interface Config {
  token: string;
}

/**
 * Reads the deployment secret once. Throws rather than booting a worker that
 * would reject every hello.
 */
export function readConfig(env: Env): Config {
  const token = env.CARBON_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('CARBON_TOKEN is missing; set it with `wrangler secret put CARBON_TOKEN`');
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `CARBON_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters, got ${token.length}`,
    );
  }
  return { token };
}
