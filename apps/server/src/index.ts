import { isValidVaultId } from '@carbon-sync/protocol';
import type { Env } from './config.js';
import { VaultObject } from './transport/vault-object.js';

export { VaultObject };

const WS_ROUTE = /^\/v1\/vaults\/([^/]+)\/ws$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('carbon-sync ok', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const match = WS_ROUTE.exec(url.pathname);
    if (match === null) {
      return new Response('not found\n', { status: 404 });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade\n', { status: 426 });
    }

    const vaultId = match[1] ?? '';
    if (!isValidVaultId(vaultId)) {
      return new Response('not found\n', { status: 404 });
    }

    return env.VAULT.getByName(vaultId).fetch(request);
  },
} satisfies ExportedHandler<Env>;
