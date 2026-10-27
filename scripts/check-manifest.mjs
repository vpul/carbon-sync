// Obsidian's community directory reads manifest.json from the repo ROOT, while
// the plugin's source of truth lives in apps/plugin. This script keeps the two
// in lockstep and checks a release tag against the manifest version.
//
// Usage: node scripts/check-manifest.mjs
//        GITHUB_REF_TYPE=tag GITHUB_REF_NAME=0.1.1 node scripts/check-manifest.mjs   (release mode)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const canonical = read('apps/plugin/manifest.json');
const rootManifest = read('manifest.json');
const versions = read('apps/plugin/versions.json');

const failures = [];

const sortKeys = (value) =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

if (JSON.stringify(sortKeys(canonical)) !== JSON.stringify(sortKeys(rootManifest))) {
  failures.push(
    'root manifest.json differs from apps/plugin/manifest.json\n' +
      `  root:      ${JSON.stringify(rootManifest)}\n` +
      `  canonical: ${JSON.stringify(canonical)}`,
  );
}

if (rootManifest.id !== 'carbon-sync') {
  failures.push(`manifest id must be "carbon-sync", got "${rootManifest.id}"`);
}

if (versions[canonical.version] !== canonical.minAppVersion) {
  failures.push(
    `apps/plugin/versions.json must map ${canonical.version} -> ${canonical.minAppVersion}`,
  );
}

// GITHUB_REF_NAME is the tag on tag pushes but the branch name ("main") on branch
// pushes, so only compare when GitHub says the ref is a tag.
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
if (tag && tag !== canonical.version) {
  failures.push(`release tag ${tag} does not match manifest version ${canonical.version}`);
}

if (failures.length > 0) {
  console.error('manifest check failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`manifest ok: ${rootManifest.id} ${rootManifest.version}`);
