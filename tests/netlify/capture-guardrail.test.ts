import '../../sites/drlurie/config/policy-bindings.js'; // registers the site policy providers activePoliciesFromDoc resolves through
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SITE_CAPTURE_MODE,
  applyCaptureGuardrail,
  resolveSiteCaptureMode,
  validateCaptureBridgePolicy,
  type SiteCaptureMode,
} from '../../packages/core/server/lib/capture-bridge-policy.js';
import { governanceDocSchema, activePoliciesFromDoc } from '../../packages/core/server/lib/governance-store.js';
import { describeSiteCaptureGuardrail, SITE_CAPTURE_LABELS } from '../../packages/core/lib/admin/governance-presentation.js';

/**
 * W21 — the per-site capture guardrail.
 *
 * The one law this feature must not break is the module it lives in: the capture bridge may
 * NEVER widen what the project registry handed it. So the tests that matter most here are the
 * negative ones — no mode adds an origin, raises maxPages, or relaxes an invariant — and the
 * default, which has to leave an untouched tenant behaving exactly as it did before.
 */

const OWN = 'https://kugel-platform.netlify.app';
const THIRD_PARTY = 'https://www.zilbermanfilmfoundation.com';

const registryPolicy = (origins: string[]) => ({
  maxPages: 20,
  allowedCrawlOrigins: origins,
  allowedPathPrefixes: ['/'],
  sameOriginOnly: true,
  respectRobots: true,
  concurrency: 1,
  delayMs: 1500,
  authenticatedAccess: 'prohibited',
  rights: { content: 'retain_allowed_origin_content', media: 'retain_referenced_allowed_origin_media' },
  designReferences: [],
  fidelity: { mode: 'source_faithful', sourceDesignTreatment: 'source_content_and_design' },
});

const validated = (origins: string[]) => {
  const result = validateCaptureBridgePolicy(registryPolicy(origins));
  assert.equal(result.ok, true, 'fixture policy must pass the bridge validator');
  return (result as Extract<typeof result, { ok: true }>).policy;
};

test('default mode is open, and an untouched tenant behaves exactly as before the guardrail existed', () => {
  assert.equal(DEFAULT_SITE_CAPTURE_MODE, 'open');
  assert.equal(resolveSiteCaptureMode(null), 'open');
  assert.equal(resolveSiteCaptureMode(undefined), 'open');
  assert.equal(resolveSiteCaptureMode({}), 'open');

  const policy = validated([THIRD_PARTY, OWN]);
  const guarded = applyCaptureGuardrail(policy, 'open', OWN);
  assert.equal(guarded.ok, true);
  assert.deepEqual((guarded as Extract<typeof guarded, { ok: true }>).policy, policy);
  assert.equal((guarded as Extract<typeof guarded, { ok: true }>).narrowed, false);
});

test('an unreadable or nonsense stored mode fails OPEN, never into a denial', () => {
  for (const bogus of ['', 'OPEN', 'yes', 'off', 'self', '0']) {
    assert.equal(resolveSiteCaptureMode({ siteCapture: bogus }), 'open', `"${bogus}" must resolve to the default`);
  }
});

test('self_only keeps the site\'s own origin and drops every other one', () => {
  const guarded = applyCaptureGuardrail(validated([THIRD_PARTY, OWN]), 'self_only', OWN);
  assert.equal(guarded.ok, true);
  const ok = guarded as Extract<typeof guarded, { ok: true }>;
  assert.deepEqual(ok.policy.allowedCrawlOrigins, [OWN]);
  assert.equal(ok.narrowed, true);
});

test('self_only refuses when the registry never authorized the site\'s own origin — it cannot add one', () => {
  const guarded = applyCaptureGuardrail(validated([THIRD_PARTY]), 'self_only', OWN);
  assert.equal(guarded.ok, false);
  const denied = guarded as Extract<typeof guarded, { ok: false }>;
  assert.equal(denied.errorCode, 'capture_policy_denies');
  assert.match(denied.error, /does not authorize that origin/);
});

test('self_only refuses rather than widening when the site reports no canonical origin', () => {
  const guarded = applyCaptureGuardrail(validated([THIRD_PARTY, OWN]), 'self_only', undefined);
  assert.equal(guarded.ok, false);
  assert.equal((guarded as Extract<typeof guarded, { ok: false }>).errorCode, 'capture_policy_denies');
});

test('locked refuses every capture, whatever the registry authorized', () => {
  const guarded = applyCaptureGuardrail(validated([THIRD_PARTY, OWN]), 'locked', OWN);
  assert.equal(guarded.ok, false);
  assert.equal((guarded as Extract<typeof guarded, { ok: false }>).errorCode, 'capture_policy_denies');
});

test('NO mode can widen: origins, maxPages and the invariants only ever narrow or stay equal', () => {
  const base = validated([THIRD_PARTY, OWN]);
  for (const mode of ['open', 'self_only', 'locked'] as SiteCaptureMode[]) {
    const guarded = applyCaptureGuardrail(base, mode, OWN);
    if (!guarded.ok) continue;
    const after = guarded.policy;
    const origins = after.allowedCrawlOrigins as string[];
    assert.ok(
      origins.every((origin) => (base.allowedCrawlOrigins as string[]).includes(origin)),
      `${mode} introduced an origin the registry never authorized`
    );
    assert.ok(origins.length <= (base.allowedCrawlOrigins as string[]).length, `${mode} added origins`);
    assert.ok((after.maxPages as number) <= (base.maxPages as number), `${mode} raised maxPages`);
    assert.equal(after.sameOriginOnly, true);
    assert.equal(after.respectRobots, true);
    assert.equal(after.authenticatedAccess, 'prohibited');
  }
});

test('the guardrail never mutates the policy it was handed', () => {
  const base = validated([THIRD_PARTY, OWN]);
  const snapshot = structuredClone(base);
  applyCaptureGuardrail(base, 'self_only', OWN);
  applyCaptureGuardrail(base, 'locked', OWN);
  assert.deepEqual(base, snapshot);
});

test('the governance doc accepts the three modes and rejects anything else', () => {
  const doc = (siteCapture: unknown) => ({
    schema_version: 'overrides.v1' as const,
    siteCapture,
    updated_by: 'owner@example.test',
    updated_at: '2026-09-14T00:00:00.000Z',
    history: [],
  });
  for (const mode of ['open', 'self_only', 'locked']) {
    assert.equal(governanceDocSchema.parse(doc(mode)).siteCapture, mode);
  }
  assert.throws(() => governanceDocSchema.parse(doc('anything')));
  // Absent is legal and is what every existing document looks like.
  const { siteCapture: _omitted, ...withoutField } = doc('open');
  assert.equal(governanceDocSchema.parse(withoutField).siteCapture, undefined);
});

test('activePoliciesFromDoc resolves the mode and its provenance', () => {
  const withoutDoc = activePoliciesFromDoc(null);
  assert.equal(withoutDoc.siteCapture, 'open');
  assert.equal(withoutDoc.provenance.siteCapture, 'committed');

  const overridden = activePoliciesFromDoc({
    schema_version: 'overrides.v1',
    siteCapture: 'self_only',
    updated_by: 'owner@example.test',
    updated_at: '2026-09-14T00:00:00.000Z',
    history: [],
  });
  assert.equal(overridden.siteCapture, 'self_only');
  assert.equal(overridden.provenance.siteCapture, 'override');
});

test('the card view-model labels the effective mode and names where the bounds actually live', () => {
  const view = describeSiteCaptureGuardrail('self_only', 'override');
  assert.equal(view.label, SITE_CAPTURE_LABELS.self_only);
  assert.equal(view.provenance, 'override');
  assert.ok(view.rows.some((row) => /capturePolicy/.test(row.value)), 'the card must say the registry owns the bounds');
  // "Open" must never read as "the open web" — the registry is still an allowlist.
  assert.match(describeSiteCaptureGuardrail('open', 'committed').effect, /registry/);
});

test('the capture handler consults the guardrail, and does it before the seed is judged', () => {
  // Compiled tests run out of .tmp/ci-test, so walk up to the repo root rather than trusting cwd
  // (the same resolution admin-governance.test.ts uses for its own source-wiring assertions).
  let root = path.dirname(fileURLToPath(import.meta.url));
  while (root !== path.dirname(root)) {
    if (existsSync(path.join(root, 'netlify.toml')) && existsSync(path.join(root, 'packages/core/admin'))) break;
    root = path.dirname(root);
  }
  const source = readFileSync(path.join(root, 'packages/core/server/lib/mcp-tool-handlers.ts'), 'utf8');
  const handler = source.slice(source.indexOf('export const callCreateCaptureJob'));
  const body = handler.slice(0, handler.indexOf('\nexport const '));
  const guardrailAt = body.indexOf('applyCaptureGuardrail');
  const seedAt = body.indexOf('validateCaptureSeedUrl');
  assert.ok(guardrailAt > -1, 'callCreateCaptureJob must apply the guardrail');
  assert.ok(seedAt > -1, 'callCreateCaptureJob must still validate the seed');
  assert.ok(guardrailAt < seedAt, 'the guardrail must narrow the policy BEFORE the seed is checked against it');
  assert.ok(/policy: guarded\.policy/.test(body), 'the NARROWED policy is what gets forwarded to pdf-tool');
});
