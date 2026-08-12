/**
 * Guards the fix for the genesis-manifest / admin-parity cross-file race.
 *
 * `admin-parity.test.mjs` scaffolds tenants under `sites/` and removes them in a
 * `finally`; `genesis-manifest.test.mjs` and `client-scripts-site-bindings.test.mjs`
 * enumerate `sites/*` as "every real tenant". node:test runs test FILES concurrently,
 * so those walks could observe a scratch tenant mid-flight and fail against a
 * genesis-stage scaffold — intermittently, on whichever matrix entry interleaved.
 *
 * These tests operate on a temp directory, never on the repo's own `sites/`, so this
 * file adds no shared state of its own.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SCRATCH_SITE_PREFIX, isScratchSite, realTenantNames } from './scratch-sites.mjs';

const withSitesDir = (names, run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-sites-'));
  try {
    for (const name of names) fs.mkdirSync(path.join(root, name), { recursive: true });
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test('a scratch tenant is recognised by the reserved prefix, and a real tenant is not', () => {
  assert.equal(isScratchSite(`${SCRATCH_SITE_PREFIX}bindcap`), true);
  assert.equal(isScratchSite(`${SCRATCH_SITE_PREFIX}genesis`), true);
  for (const real of ['platform', 'drlurie', 'fernwell']) {
    assert.equal(isScratchSite(real), false, `'${real}' is a real tenant and must never be filtered out`);
  }
});

test('realTenantNames drops scratch tenants a concurrent test left on disk, and keeps every real one', () => {
  withSitesDir(
    ['platform', `${SCRATCH_SITE_PREFIX}bindcap`, 'drlurie', `${SCRATCH_SITE_PREFIX}genesis`, 'fernwell'],
    (root) => {
      assert.deepEqual(realTenantNames(root), ['drlurie', 'fernwell', 'platform']);
    }
  );
});

test('realTenantNames returns every real tenant sorted, and ignores stray files', () => {
  withSitesDir(['zeta', 'alpha', 'mid'], (root) => {
    fs.writeFileSync(path.join(root, 'README.md'), 'not a tenant');
    assert.deepEqual(realTenantNames(root), ['alpha', 'mid', 'zeta']);
  });
});

// NOTE: deliberately NO test here that reads the repo's own sites/ looking for a
// stranded scratch tenant. admin-parity.test.mjs legitimately has one on disk for part
// of its run, and this file executes concurrently with it — such a test would be the
// very race this fix removes. A stranded directory is already caught, with a clear
// message, by scratchSite()'s own "must not already exist" assertion.
