import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { pruneBeforeDate, pruneMirrorKeys, selectPrunableKeys } from '../../scripts/lib/tracking-prune.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const compiledRoot = path.resolve(here, '../../.tmp/ci-test');
const { createLocalBlobStore, setLocalBlobsRootForTesting } = await import(
  path.join(compiledRoot, 'packages/core/server/lib/local-blobs.js')
);

test('pruneBeforeDate returns the yyyy-mm-dd cutoff 90 days back', () => {
  assert.equal(pruneBeforeDate(new Date('2026-08-28T12:00:00Z')), '2026-05-30');
});

test('selectPrunableKeys chooses only keys older than the cutoff', () => {
  const keys = selectPrunableKeys(
    [
      { key: 'events/2026-05-29/20260529-a.json' },
      { key: 'events/2026-05-30/20260530-a.json' },
      { key: 'events/2026-06-01/20260601-a.json' },
      { key: 'junk/no-date.json' },
    ],
    '2026-05-30'
  );
  assert.deepEqual(keys, ['events/2026-05-29/20260529-a.json']);
});

test('dry-run lists prunable keys and deletes nothing in the file-backed store', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracking-prune-'));
  setLocalBlobsRootForTesting(tmpRoot);
  try {
    const store = createLocalBlobStore('tracking-events');
    await store.setJSON('events/2026-05-29/old.json', { old: true });
    await store.setJSON('events/2026-05-30/borderline.json', { keep: true });
    await store.setJSON('events/2026-06-01/new.json', { new: true });
    const keys = selectPrunableKeys((await store.list({ prefix: 'events/' })).blobs, '2026-05-30');
    const summary = await pruneMirrorKeys(keys, { del: (key) => store.del(key) });
    assert.equal(summary.dryRun, true);
    assert.deepEqual(summary.keys, ['events/2026-05-29/old.json']);
    assert.notEqual(await store.get('events/2026-05-29/old.json'), null);
    assert.notEqual(await store.get('events/2026-05-30/borderline.json'), null);
  } finally {
    setLocalBlobsRootForTesting(undefined);
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.rm(`${tmpRoot}-meta`, { recursive: true, force: true });
  }
});

test('execute deletes only keys older than 90 days in the file-backed store', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracking-prune-'));
  setLocalBlobsRootForTesting(tmpRoot);
  try {
    const store = createLocalBlobStore('tracking-events');
    await store.setJSON('events/2026-05-29/old.json', { old: true });
    await store.setJSON('events/2026-05-30/borderline.json', { keep: true });
    await store.setJSON('events/2026-06-01/new.json', { new: true });
    const keys = selectPrunableKeys((await store.list({ prefix: 'events/' })).blobs, '2026-05-30');
    const summary = await pruneMirrorKeys(keys, { del: (key) => store.del(key), dryRun: false });
    assert.equal(summary.deleted, 1);
    assert.equal(await store.get('events/2026-05-29/old.json'), null);
    assert.notEqual(await store.get('events/2026-05-30/borderline.json'), null);
    assert.notEqual(await store.get('events/2026-06-01/new.json'), null);
  } finally {
    setLocalBlobsRootForTesting(undefined);
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.rm(`${tmpRoot}-meta`, { recursive: true, force: true });
  }
});
