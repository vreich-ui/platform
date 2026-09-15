import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fleetNetlifySiteName, FLEET_SITE_NAME_PREFIX, buildPlan } from '../../packages/core/cli/create-site.mjs';
import { discoverFleetSites, FLEET_SITES, SITES_ROOT } from '../../scripts/fleet-capability-probe.mjs';
import { FLEET_SLUGS } from '../../scripts/fleet-promote.mjs';
import { realTenantNames } from './scratch-sites.mjs';

// 2026-09-15. Two halves of ONE defect: the Netlify site name `kugel-<slug>` lived in an operator's
// habit rather than in code, and the fleet map that decides what can be promoted was a
// hand-maintained literal that `create-site` never updated.
//
// What it cost: CMS-Agent's genesis minted a Netlify site literally named `genesis-lab-3` beside the
// fleet's `kugel-genesis-lab-2` (an orphan site, two paths naming one tenant two ways), and because
// production ships only through `fleet-promote.mjs` — which REFUSES an unknown slug — the tenant it
// did mint could not ship at all until a human edited a list.

test('the Netlify site name is derived, once, and is idempotent on the prefix', () => {
  assert.equal(FLEET_SITE_NAME_PREFIX, 'kugel-');
  assert.equal(fleetNetlifySiteName('seniorpets'), 'kugel-seniorpets');
  assert.equal(fleetNetlifySiteName('genesis-lab-3'), 'kugel-genesis-lab-3');
  assert.equal(fleetNetlifySiteName('fernwell'), 'kugel-fernwell');
  // A slug that already carries it is not double-prefixed: the value round-trips.
  assert.equal(fleetNetlifySiteName('kugel-platform'), 'kugel-platform');
  assert.equal(fleetNetlifySiteName(fleetNetlifySiteName('seniorpets')), 'kugel-seniorpets');
});

test('a mint with no flags scaffolds the canonical host it will actually serve from', () => {
  // This is what used to need `--canonical-host` on every mint: the default was
  // `https://<slug>.netlify.app`, a subdomain no kugel- tenant owns.
  assert.equal(buildPlan({ name: 'seniorpets' }).canonicalHost, 'https://kugel-seniorpets.netlify.app');
  // The flag still wins — the two tenants that predate the convention need it.
  assert.equal(
    buildPlan({ name: 'zilberman', canonicalHost: 'https://zilbermanfilmfoundation.netlify.app' }).canonicalHost,
    'https://zilbermanfilmfoundation.netlify.app'
  );
});

test('the fleet map is derived from the committed tenants, and every one of them is promotable', () => {
  const slugs = FLEET_SITES.map((site) => site.slug);
  // The five the hand-maintained literal carried, reproduced exactly...
  for (const slug of ['drlurie', 'platform', 'fernwell', 'zilberman', 'genesis-lab-2']) {
    assert.ok(slugs.includes(slug), `${slug} must stay in the fleet map`);
  }
  // ...plus every tenant committed since, with no edit to any list.
  assert.deepEqual(
    slugs,
    // realTenantNames, never a raw readdirSync: admin-parity.test.mjs scaffolds a real,
    // transient sites/parity-scratch-<slug> tenant concurrently (npm test runs test files
    // in separate processes against this same real SITES_ROOT), and an unfiltered read here
    // would race discoverFleetSites' own (already-filtered) snapshot — see scratch-sites.mjs.
    realTenantNames(SITES_ROOT), // SITES_ROOT, never cwd: this suite is also run from compiled trees where cwd differs.
    'one entry per sites/<slug>/, sorted'
  );
  // The map fleet-promote refuses unknown slugs against IS this one.
  assert.deepEqual([...FLEET_SLUGS].sort(), [...slugs].sort());
  // Endpoints come off each tenant's own config, so the hosts that are NOT kugel-<slug> are right.
  const endpoint = (slug) => FLEET_SITES.find((site) => site.slug === slug).endpoint;
  assert.equal(endpoint('drlurie'), 'https://drluriescience.netlify.app/.netlify/functions/mcp');
  assert.equal(endpoint('zilberman'), 'https://zilbermanfilmfoundation.netlify.app/.netlify/functions/mcp');
  assert.equal(endpoint('platform'), 'https://kugel-platform.netlify.app/.netlify/functions/mcp');
});

test('a tenant whose config declares no canonical host is NAMED, not silently dropped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-discover-'));
  fs.mkdirSync(path.join(root, 'good'));
  fs.writeFileSync(path.join(root, 'good', 'config.yaml'), "site:\n  site: 'https://kugel-good.netlify.app'\n");
  fs.mkdirSync(path.join(root, 'nohost'));
  fs.writeFileSync(path.join(root, 'nohost', 'config.yaml'), 'site:\n  name: nohost\n');
  fs.mkdirSync(path.join(root, 'noconfig'));

  const discovered = discoverFleetSites(root);
  assert.deepEqual(discovered.sites, [{ slug: 'good', endpoint: 'https://kugel-good.netlify.app/.netlify/functions/mcp' }]);
  // The old failure mode was a missing entry nobody noticed. Both unreadable tenants are reported.
  assert.deepEqual(discovered.skipped, ['noconfig', 'nohost']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a missing sites root is empty rather than a crash', () => {
  assert.deepEqual(discoverFleetSites(path.join(os.tmpdir(), 'fleet-does-not-exist')), { sites: [], skipped: [] });
});
