/**
 * T13.10 — the tracking conversion-factory leg: the trk_drlurie seed parses
 * as the RATIFIED posture; the singleton drill (set_tracking_config_fields
 * flip/flip-back) runs byte-identical through the REAL patch engine; and
 * the full T13.10 `set_tracking` drill (set → mutate → unset-to-null) runs
 * on ONE object of EACH of the ten attribute-carrying types, ending
 * byte-identical with every step's derived inverse exact. The reconcile
 * branch heals a drifted singleton back to the seed (trap-2 stray-nulling).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { drillOpsForSeed, trackingProbeOps } from '../../scripts/lib/roundtrip-drill.mjs';
import { reconcileOps } from '../../scripts/lib/roundtrip-reconcile.mjs';
import {
  CONVERSION_SEEDS,
  RESTRICTED_REGIONS,
  trackingConfigBody,
} from '../../sites/drlurie/seeds/tracking-config-seed-data.mjs';
import { RESTRICTED_REGIONS as FERNWELL_RESTRICTED_REGIONS } from '../../sites/fernwell/seeds/tracking-config-seed-data.mjs';
import { RESTRICTED_REGIONS as PLATFORM_RESTRICTED_REGIONS } from '../../sites/platform/seeds/tracking-config-seed-data.mjs';
import { RESTRICTED_REGIONS as ZILBERMAN_RESTRICTED_REGIONS } from '../../sites/zilberman/seeds/tracking-config-seed-data.mjs';
import {
  applyPatchOps,
  deepEqualJson,
  derivePatchInverse,
  type PatchOpCapture,
} from '../../packages/core/lib/object-patch-apply.js';
import { trackingConfigBodySchema } from '../../packages/core/schema/bodies/tracking-config-v1.js';
import { objectTypes, type ObjectType, type Principal } from '../../packages/core/schema/object-record-v1.js';
import {
  carriesTrackingAttribute,
  TRACKING_ATTRIBUTE_EXEMPT_TYPES,
} from '../../packages/core/schema/bodies/tracking-attribute-v1.js';

const ACTOR: Principal = { kind: 'agent', agent_name: 'object-conversion-roundtrip', auth: 'publish_key' };
const AT = '2026-07-20T00:00:00.000Z';

const record = (objectType: ObjectType, body: unknown) => ({
  object_id: objectType === 'tracking_config' ? 'trk_drlurie' : `${objectType}_probe`,
  object_type: objectType,
  schema_version: `${objectType}.v1`,
  site: 'site_drlurie',
  created_at: AT,
  updated_at: AT,
  status: 'active' as const,
  body,
  publication: { published_time: null },
  history: [],
  version: 1,
  content_revision: 1,
});

// ═══ the seed ══════════════════════════════════════════════════════════

test('trk_drlurie seed: schema-parses as the ratified posture (OQ-W13-1/-3/-6, §6 matrix)', () => {
  const parsed = trackingConfigBodySchema.parse(trackingConfigBody);
  assert.equal(parsed.consent.posture, 'geo-adaptive');
  assert.equal(RESTRICTED_REGIONS.length, 33, 'EEA-30 (EU-27 + IS/LI/NO) + UK + CH + IL');
  for (const code of ['DE', 'FR', 'IS', 'LI', 'NO', 'GB', 'CH']) {
    assert.ok(parsed.consent.restricted_regions.includes(code), `${code} restricted`);
  }
  assert.equal(parsed.consent.honor_gpc, true);
  assert.ok(parsed.consent.banner, 'banner copy seeded (the T13.6 component reads it)');
  assert.equal(parsed.providers.own?.enabled, true);
  assert.equal(parsed.providers.own?.endpoint_env, 'TRACKING_SINK_URL');
  assert.equal(parsed.providers.own?.auth_env, 'TRACKING_SINK_TOKEN');
  assert.equal(parsed.providers.own?.blob_mirror, 'fallback');
  for (const key of ['ga4', 'gtm', 'google_ads', 'meta_pixel', 'taboola', 'outbrain', 'mgid', 'plausible'] as const) {
    assert.equal(parsed.providers[key]?.enabled, false, `${key} ships disabled`);
  }
  assert.deepEqual(parsed.defaults.page, ['pageview', 'scroll_depth', 'engagement']);
  assert.ok(parsed.defaults.section.includes('section_impression'), 'schema-legal event kinds only');
  assert.deepEqual(CONVERSION_SEEDS, [
    { objectType: 'tracking_config', objectId: 'trk_drlurie', body: trackingConfigBody },
  ]);
});

test('all four tracking seeds include IL in restricted_regions', () => {
  for (const regions of [
    RESTRICTED_REGIONS,
    PLATFORM_RESTRICTED_REGIONS,
    FERNWELL_RESTRICTED_REGIONS,
    ZILBERMAN_RESTRICTED_REGIONS,
  ]) {
    assert.ok(regions.includes('IL'));
  }
});

// ═══ the singleton drill ════════════════════════════════════════════════

test('tracking_config drill runs byte-identical through the real engine', () => {
  const { ops } = drillOpsForSeed(CONVERSION_SEEDS[0]!);
  const result = applyPatchOps(record('tracking_config', structuredClone(trackingConfigBody)), ops, {
    actor: ACTOR,
    at: AT,
  });
  assert.ok(deepEqualJson(result.record.body, trackingConfigBody), 'flip/flip-back ends byte-identical');
});

// ═══ the ten-type set_tracking drill ═══════════════════════════════════════

test('the T13.10 set→mutate→unset drill ends byte-identical on ALL ten types; every inverse exact', () => {
  // DERIVED, never a restated count: the exemption list is the schema module's
  // (TRACKING_ATTRIBUTE_EXEMPT_TYPES), so adding a 13th type cannot make this
  // guard quietly wrong the way a hardcoded 10 did when editorial_voice landed.
  const targets = objectTypes.filter(carriesTrackingAttribute);
  assert.equal(
    targets.length,
    objectTypes.length - TRACKING_ATTRIBUTE_EXEMPT_TYPES.length,
    'every attribute-carrying type is drilled'
  );
  for (const objectType of targets) {
    // The engine is shape-agnostic (schema gating is the verb layer's job) —
    // a minimal body proves the drill on every type uniformly.
    const body = { probe: `body-${objectType}` };
    const ops = trackingProbeOps(body);
    assert.equal(ops.length, 3, `${objectType}: set → mutate → unset`);
    const forward = applyPatchOps(record(objectType, structuredClone(body)), ops, { actor: ACTOR, at: AT });
    assert.ok(deepEqualJson(forward.record.body, body), `${objectType}: drill ends byte-identical`);

    // Walk the history back with DERIVED inverses — each step must be exact.
    let current = forward.record;
    const entries = [...current.history];
    for (const entry of entries.reverse()) {
      const inverse = derivePatchInverse(entry.details!.op as never, entry.details!.capture as PatchOpCapture);
      current = applyPatchOps(current, [inverse], { actor: ACTOR, at: AT }).record;
    }
    assert.ok(
      deepEqualJson(current.body, body),
      `${objectType}: replaying every inverse restores the original (trivially — it never left)`
    );
    // The middle step genuinely mutated: prove by applying only the first two.
    const partial = applyPatchOps(record(objectType, structuredClone(body)), ops.slice(0, 2), {
      actor: ACTOR,
      at: AT,
    });
    const tracking = (partial.record.body as { tracking?: Record<string, unknown> }).tracking;
    assert.equal(tracking?.label, 'RT probe [poked]', `${objectType}: the mutate step is a real merge`);
    assert.ok(deepEqualJson(tracking?.tags, ['rt-probe']), `${objectType}: merge adds keys`);
  }
});

// ═══ reconcile ═════════════════════════════════════════════════════════

test('reconcile heals a drifted trk_drlurie back to the seed (stray keys nulled — trap 2)', () => {
  const drifted = structuredClone(trackingConfigBody) as Record<string, never> & typeof trackingConfigBody;
  drifted.consent.honor_gpc = false;
  drifted.consent.banner!.headline = 'Drifted headline';
  (drifted.defaults as Record<string, unknown>).page = ['pageview'];
  (drifted.consent as Record<string, unknown>).stray_key = 'gone-after-heal';
  const ops = reconcileOps(CONVERSION_SEEDS[0], drifted);
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.op, 'set_tracking_config_fields');
  const healed = applyPatchOps(record('tracking_config', drifted), ops as never[], { actor: ACTOR, at: AT });
  assert.ok(deepEqualJson(healed.record.body, trackingConfigBody), 'healed body === seed, strays removed');
});
