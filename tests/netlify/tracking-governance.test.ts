/**
 * T13.12 — the tracking governance surface (OQ-W13-2: posture is
 * config-driven and must be visible/flippable in the admin). Pins: the view
 * renders from POLICY TRUTH (flip the config, the view follows — master,
 * per-type pin, runtime provenance); the creation summary reflects the live
 * committed policy (humans always + the seed-driver allowlist); the
 * quick-flip payload is an EXPLICIT per-type pin through the same override
 * doc the T9.15 matrix edits (never a silent master change); and the
 * server-side write path is Owner-only (the T9.15 boundary this card
 * reuses — re-asserted here against the governance function's contract).
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11 T11.2: register providers for tests hitting active*/getSiteIdentity
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeTrackingGovernance,
  withTrackingPublishMode,
  formatAnalyticsIdMode,
  type CreationPolicyLike,
} from '../../packages/core/lib/admin/tracking-governance.js';
import { activeCreationPolicy } from '../../packages/core/lib/creation-policy.js';
import { activeApprovalPolicy } from '../../packages/core/lib/approval-policy.js';
import type { ApprovalConfig } from '../../packages/core/lib/admin/governance-client.js';

const OPEN_CREATION: CreationPolicyLike = { master: 'open', overrides: {} };

test('the view renders from config truth: master flips follow, per-type pins beat the master', () => {
  const autonomous: ApprovalConfig = { master: 'all-autonomous', overrides: {} };
  const viewA = describeTrackingGovernance(autonomous, 'committed', OPEN_CREATION, 'committed');
  assert.equal(viewA.trackingPublish, 'autonomous');
  assert.equal(viewA.rows[0]!.pinned, false);
  assert.equal(viewA.approvalProvenance, 'committed');

  const masterFlipped: ApprovalConfig = { master: 'all-require-approval', overrides: {} };
  assert.equal(
    describeTrackingGovernance(masterFlipped, 'committed', OPEN_CREATION, 'committed').trackingPublish,
    'require-approval',
    'no pin ⇒ the master decides'
  );

  const pinned: ApprovalConfig = { master: 'all-autonomous', overrides: { tracking_config: 'require-approval' } };
  const viewP = describeTrackingGovernance(pinned, 'override', OPEN_CREATION, 'committed');
  assert.equal(viewP.trackingPublish, 'require-approval', 'the pin beats the master');
  assert.equal(viewP.rows[0]!.pinned, true);
  assert.equal(viewP.approvalProvenance, 'override', 'runtime provenance is labeled');
});

test('product rides beside tracking (the other pinned type) — honest about ALL posture pins', () => {
  const config: ApprovalConfig = { master: 'all-autonomous', overrides: { product: 'require-approval' } };
  const view = describeTrackingGovernance(config, 'committed', OPEN_CREATION, 'committed');
  assert.deepEqual(
    view.rows.map((row) => [row.type, row.publish, row.pinned]),
    [
      ['tracking_config', 'autonomous', false],
      ['product', 'require-approval', true],
    ]
  );
});

test('creation summary reflects the LIVE committed policy: humans always, seed driver only', () => {
  const view = describeTrackingGovernance(
    { master: 'all-autonomous', overrides: {} },
    'committed',
    activeCreationPolicy() as CreationPolicyLike,
    'committed'
  );
  assert.equal(view.creation.humans, 'always');
  assert.deepEqual(view.creation.agents, ['object-conversion-roundtrip'], 'the T13.10 seed identity, from config');

  // And the REAL committed approval policy answers the OQ-W13-2 question:
  // tracking_config publishes autonomously under the all-autonomous master.
  const live = describeTrackingGovernance(
    activeApprovalPolicy() as ApprovalConfig,
    'committed',
    activeCreationPolicy() as CreationPolicyLike,
    'committed'
  );
  assert.equal(live.trackingPublish, 'autonomous', 'ships AUTONOMOUS per the ruling');
});

test('the quick flip is an explicit per-type pin — the master and other pins are untouched', () => {
  const before: ApprovalConfig = { master: 'all-autonomous', overrides: { product: 'require-approval' } };
  const flipped = withTrackingPublishMode(before, 'require-approval');
  assert.deepEqual(flipped, {
    master: 'all-autonomous',
    overrides: { product: 'require-approval', tracking_config: 'require-approval' },
  });
  assert.deepEqual(before.overrides, { product: 'require-approval' }, 'input untouched (pure)');
  // Flipping to what the master already implies STILL pins — the posture
  // must survive later master flips; the matrix's "Master default" unpins.
  const rePinned = withTrackingPublishMode(before, 'autonomous');
  assert.equal(rePinned.overrides.tracking_config, 'autonomous');
});

test('T21.2: analytics_id_mode — present renders the raw value, absent renders "not set"', () => {
  assert.equal(formatAnalyticsIdMode('granted-only'), 'granted-only', 'value present ⇒ shown as-is');
  assert.equal(formatAnalyticsIdMode('unrestricted-auto'), 'unrestricted-auto', 'value present ⇒ shown as-is');
  assert.equal(formatAnalyticsIdMode(undefined), 'not set', 'no export yet ⇒ the existing "not set" treatment');
  assert.equal(formatAnalyticsIdMode(null), 'not set', 'null degrades the same as undefined');
});

test('the write path is the Owner-only governance endpoint (the T9.15 boundary — no new machinery)', async () => {
  // The card writes through setApprovalOverride → admin-governance 'set',
  // which 403s non-owners server-side. Re-assert that contract against the
  // SOURCE files (this test runs compiled from .tmp/ci-test — walk up to
  // the repo root, the loader-size test's pattern) so the card can never
  // silently grow its own write path.
  const { readFileSync, existsSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  let root = path.dirname(fileURLToPath(import.meta.url));
  while (root !== path.dirname(root)) {
    if (existsSync(path.join(root, 'netlify.toml')) && existsSync(path.join(root, 'packages/core/admin'))) break;
    root = path.dirname(root);
  }
  const source = readFileSync(path.join(root, 'packages/core/server/functions/admin-governance.ts'), 'utf8');
  assert.match(source, /owner/i, 'the governance function carries the Owner gate');
  assert.match(source, /403/, 'non-owners are rejected');
  const card = readFileSync(path.join(root, 'packages/core/admin/GovernancePage.tsx'), 'utf8');
  assert.match(
    card,
    /setApprovalOverride\(getToken, withTrackingPublishMode/,
    'the card uses the shared override write'
  );
  assert.ok(!card.includes('admin-governance-tracking'), 'no bespoke endpoint');
  assert.match(card, /Analytics ID mode: \{analyticsIdMode\}/, 'the effective identity mode is shown read-only');
  assert.ok(
    !card.includes('setAnalyticsIdMode'),
    'the guardrails card does not add a write path for the identity mode'
  );
});
