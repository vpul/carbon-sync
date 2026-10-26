#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
// Provisions a deployment: generate a token, deploy, store the secret, and
// print a setup code. Node built-ins only.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const { values } = parseArgs({
  options: {
    vault: { type: 'string', default: 'main' },
    url: { type: 'string' },
  },
  allowPositionals: false,
});

const vault = values.vault;
if (vault === undefined || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(vault)) {
  fail(`invalid --vault "${vault ?? ''}": must match ^[a-z0-9][a-z0-9-]{0,62}$`);
}

const wranglerPackage = require.resolve('wrangler/package.json');
const wranglerBin = path.join(
  path.dirname(wranglerPackage),
  JSON.parse(readFileSync(wranglerPackage, 'utf8')).bin.wrangler,
);

function wrangler(args, input) {
  return spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd: appDir,
    encoding: 'utf8',
    input,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Duplicated from packages/protocol/src/setup-code.ts (encodeSetupCode), the
// source of truth; plain Node cannot import the TypeScript source directly.
function encodeSetupCode({ url, vault, token }) {
  const json = JSON.stringify({ url, vault, token });
  return `carbon1:${Buffer.from(json, 'utf8').toString('base64url')}`;
}

const token = randomBytes(32).toString('base64url');

console.log('Deploying carbon-sync...');
const deploy = wrangler(['deploy']);
process.stdout.write(deploy.stdout ?? '');
process.stderr.write(deploy.stderr ?? '');
if (deploy.status !== 0) {
  fail('wrangler deploy failed');
}

console.log('Storing CARBON_TOKEN secret...');
const secret = wrangler(['secret', 'put', 'CARBON_TOKEN'], `${token}\n`);
process.stdout.write(secret.stdout ?? '');
process.stderr.write(secret.stderr ?? '');
if (secret.status !== 0) {
  fail('wrangler secret put CARBON_TOKEN failed');
}

const deployedUrl = `${deploy.stdout ?? ''}${deploy.stderr ?? ''}`.match(
  /https:\/\/[^\s"'<>]+\.workers\.dev/i,
)?.[0];

let url = values.url ?? deployedUrl;
if (url === undefined) {
  fail('could not find a *.workers.dev URL in the deploy output; pass --url');
}

const parsed = new URL(url);
if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
  fail(`invalid --url "${url}": must be http or https`);
}
url = parsed.origin;

console.log(`\nDeployment URL: ${url}`);
console.log(`Setup code (vault "${vault}"):\n`);
console.log(encodeSetupCode({ url, vault, token }));
