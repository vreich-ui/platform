/**
 * tracking-mirror-prune — delete `tracking-events` mirror blobs older than 90 days.
 *
 * Dry-run by default; add `--execute` to delete the selected keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pruneBeforeDate, pruneMirrorKeys, selectPrunableKeys } from './lib/tracking-prune.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const options = { before: null, execute: false };
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--before') options.before = argv[++index];
  else if (arg === '--execute') options.execute = true;
  else {
    console.error(`[prune] unknown argument: ${arg}`);
    process.exit(2);
  }
}

const compiledRoot = path.join(repoRoot, '.tmp', 'ci-test');
if (!fs.existsSync(path.join(compiledRoot, 'packages', 'core', 'server', 'lib', 'blob-store.js'))) {
  console.error('[prune] compiled blob client missing. Run first:');
  console.error('  rm -rf .tmp/ci-test && npx tsc -p tsconfig.test.json');
  process.exit(2);
}

const { getTrackingEventsBlobStore } = await import(
  path.join(compiledRoot, 'packages', 'core', 'server', 'lib', 'blob-store.js')
);
const { collectBlobListItems } = await import(path.join(compiledRoot, 'packages', 'core', 'server', 'lib', 'blob-list.js'));

const store = await getTrackingEventsBlobStore(undefined);
const items = await collectBlobListItems(await store.list({ prefix: 'events/', directories: false, paginate: true }));
const beforeDate = options.before ?? pruneBeforeDate();
const keys = selectPrunableKeys(items, beforeDate);
const summary = await pruneMirrorKeys(keys, { del: (key) => store.del(key), dryRun: !options.execute });

console.log(`[prune] cutoff ${beforeDate}: ${summary.matched} mirrored key(s) ${summary.dryRun ? 'would be deleted' : 'deleted'}`);
for (const key of summary.keys) console.log(`[prune] ${summary.dryRun ? 'would delete' : 'deleted'} ${key}`);
