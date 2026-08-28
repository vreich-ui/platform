/**
 * T13.2 — `tracking_config`: the eleventh governed type (12-plan §3).
 *
 * The theme-type test set mirrored: schema (regex-pinned provider IDs,
 * enabled⇒id refinement, env-var NAMES never URLs, GTM permanently
 * unenables), ids (trk_ grammar + mint), patch/inverse
 * (set_tracking_config_fields — the fields idiom), contract completeness
 * (governed, agent-closed creation, autonomous publish under the master,
 * safety-law + singleton + readiness constraints), the
 * tracking_config_ready criterion split (hard blocks vs publish-gated
 * warnings), and the engine-enforced singleton create-refusal.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11 T11.2: register providers for tests hitting active*/getSiteIdentity
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleObjectVerb,
  type ObjectVerbRequest,
  type ObjectVerbStore,
} from '../../packages/core/server/lib/object-verbs.js';
import { buildStoreValidationContext } from '../../packages/core/server/lib/object-validation-context.js';
import { checkStructuralInvariants } from '../../packages/core/server/lib/object-validate.js';
import {
  applyPatchOps,
  deepEqualJson,
  derivePatchInverse,
  type PatchOpCapture,
} from '../../packages/core/lib/object-patch-apply.js';
import { buildObjectContract } from '../../packages/core/lib/registry/object-contract.js';
import { validateObjectIdForType } from '../../packages/core/lib/object-ids.js';
import { mintId } from '../../packages/core/lib/object-ids-mint.js';
import {
  trackingConfigBodySchema,
  type TrackingConfigBody,
} from '../../packages/core/schema/bodies/tracking-config-v1.js';
import type { ObjectRecord, Principal } from '../../packages/core/schema/object-record-v1.js';

const AGENT: Principal = { kind: 'agent', agent_name: 'trk-test', auth: 'publish_key' };
const HUMAN: Principal = { kind: 'human', id: 'wolf', email: 'wolf@example.com' };
const NOW = Date.parse('2026-07-19T12:00:00.000Z');
const AT = '2026-07-19T12:00:00.000Z';

const validBody = (): TrackingConfigBody =>
  trackingConfigBodySchema.parse({
    providers: {
      own: { enabled: true, consent_class: 'essential', ingest_path: '/api/t', blob_mirror: 'fallback' },
      ga4: { enabled: false, consent_class: 'analytics' },
      google_ads: { enabled: false, consent_class: 'advertising' },
    },
    consent: {
      posture: 'geo-adaptive',
      restricted_regions: ['DE', 'FR', 'GB', 'CH'],
      honor_gpc: true,
      banner: { headline: 'Privacy choices', body: 'We use trackers.', accept_label: 'Accept', reject_label: 'Reject' },
    },
    defaults: {
      page: ['pageview', 'scroll_depth', 'engagement'],
      section: ['section_impression', 'section_dwell', 'cta_click', 'form_start', 'form_submit'],
      content_item: ['read_progress', 'node_impression', 'node_dwell', 'completion'],
      product: ['buy_click'],
      navigation: ['nav_click'],
      taxonomy: ['term_view', 'tag_click'],
      outbound_links: true,
      utm_capture: true,
    },
  });

// ═══ schema ═══════════════════════════════════════════════════════════════════

test('schema: valid body parses; ingest_path defaults; unknown keys reject', () => {
  const body = validBody();
  assert.equal(body.providers.own?.ingest_path, '/api/t');
  assert.equal(body.consent.analytics_id_mode, 'granted-only', 'older records default to the consent-only mode');
  assert.equal(
    trackingConfigBodySchema.parse({
      ...validBody(),
      consent: { ...validBody().consent, analytics_id_mode: 'unrestricted-auto' },
    }).consent.analytics_id_mode,
    'unrestricted-auto'
  );
  assert.ok(
    !trackingConfigBodySchema.safeParse({
      ...validBody(),
      consent: { ...validBody().consent, analytics_id_mode: 'always' },
    }).success,
    'unknown analytics identity modes reject'
  );
  assert.ok(!trackingConfigBodySchema.safeParse({ ...validBody(), extra: true }).success);
  assert.ok(
    !trackingConfigBodySchema.safeParse({ ...validBody(), providers: { fullstory: { enabled: true } } }).success,
    'the provider registry is fixed-key'
  );
});

test('schema: enabled requires the regex-pinned id; bad ids reject even when disabled', () => {
  const base = validBody();
  const enabledNoId = { ...base, providers: { ...base.providers, ga4: { enabled: true, consent_class: 'analytics' } } };
  assert.ok(!trackingConfigBodySchema.safeParse(enabledNoId).success, 'ga4 enabled without measurement_id rejects');
  const goodId = {
    ...base,
    providers: { ...base.providers, ga4: { enabled: true, consent_class: 'analytics', measurement_id: 'G-AB12CD34' } },
  };
  assert.ok(trackingConfigBodySchema.safeParse(goodId).success);
  const badId = {
    ...base,
    providers: {
      ...base.providers,
      ga4: { enabled: false, consent_class: 'analytics', measurement_id: 'UA-1234-5' },
    },
  };
  assert.ok(!trackingConfigBodySchema.safeParse(badId).success, 'a legacy UA id fails the G- regex');
  const badAds = {
    ...base,
    providers: {
      ...base.providers,
      google_ads: { enabled: true, consent_class: 'advertising', conversion_id: 'AW-12' },
    },
  };
  assert.ok(!trackingConfigBodySchema.safeParse(badAds).success, 'AW- id must carry 6-12 digits');
});

test('schema: the own tracker carries env-var NAMES, never values or URLs; no free-URL field exists', () => {
  const base = validBody();
  const good = {
    ...base,
    providers: {
      ...base.providers,
      own: { ...base.providers.own!, endpoint_env: 'TRACKING_SINK_URL', auth_env: 'TRACKING_SINK_TOKEN' },
    },
  };
  assert.ok(trackingConfigBodySchema.safeParse(good).success);
  const url = {
    ...base,
    providers: { ...base.providers, own: { ...base.providers.own!, endpoint_env: 'https://sink.example.com' } },
  };
  assert.ok(!trackingConfigBodySchema.safeParse(url).success, 'a URL in an env field rejects');
  const path = {
    ...base,
    providers: { ...base.providers, own: { ...base.providers.own!, ingest_path: 'https://x.com/api/t' } },
  };
  assert.ok(!trackingConfigBodySchema.safeParse(path).success, 'ingest_path is a same-origin path, never a URL');
  const plausibleBad = {
    ...base,
    providers: {
      ...base.providers,
      plausible: { enabled: true, consent_class: 'analytics', api_host: 'https://p.example.com/js/script.js' },
    },
  };
  assert.ok(!trackingConfigBodySchema.safeParse(plausibleBad).success, 'plausible api_host is a bare origin — no path');
});

test('schema: GTM can NEVER be enabled (permanently OUT, OQ-W13-3)', () => {
  const base = validBody();
  const gtmOff = {
    ...base,
    providers: { ...base.providers, gtm: { enabled: false, consent_class: 'advertising' } },
  };
  assert.ok(trackingConfigBodySchema.safeParse(gtmOff).success, 'the key exists for shape stability');
  const gtmOn = {
    ...base,
    providers: {
      ...base.providers,
      gtm: { enabled: true, consent_class: 'advertising', container_id: 'GTM-ABC123' },
    },
  };
  const rejected = trackingConfigBodySchema.safeParse(gtmOn);
  assert.ok(!rejected.success);
  assert.match(JSON.stringify(rejected.success ? '' : rejected.error.issues), /permanently OUT/);
});

// ═══ ids ══════════════════════════════════════════════════════════════════════

test('ids: trk_ grammar validates and mints', () => {
  assert.ok(validateObjectIdForType('tracking_config', 'trk_drlurie').ok);
  assert.ok(validateObjectIdForType('tracking_config', 'trk_second_site').ok);
  assert.ok(!validateObjectIdForType('tracking_config', 'tracking_drlurie').ok);
  assert.ok(!validateObjectIdForType('tracking_config', 'trk_UPPER').ok);
  const minted = mintId({ kind: 'object', objectType: 'tracking_config' }, 'Dr Lurie');
  assert.match(minted, /^trk_[a-z0-9_]+$/);
});

// ═══ patch + inverse ══════════════════════════════════════════════════════════

test('set_tracking_config_fields deep-merges one provider block; inverse restores byte-exactly', () => {
  const record: ObjectRecord<unknown> = {
    object_id: 'trk_drlurie',
    object_type: 'tracking_config',
    schema_version: 'tracking_config.v1',
    site: 'site_drlurie',
    created_at: AT,
    updated_at: AT,
    status: 'active',
    body: validBody(),
    publication: { published_time: null },
    history: [],
    version: 1,
    content_revision: 1,
  };
  const forward = applyPatchOps(
    record,
    [
      {
        op: 'set_tracking_config_fields',
        fields: {
          providers: { ga4: { enabled: true, measurement_id: 'G-AB12CD34' } },
          consent: { honor_gpc: false },
        },
      },
    ],
    { actor: AGENT, at: AT }
  );
  const body = forward.record.body as TrackingConfigBody;
  assert.equal(body.providers.ga4?.enabled, true);
  assert.equal(body.providers.ga4?.measurement_id, 'G-AB12CD34');
  assert.equal(body.providers.ga4?.consent_class, 'analytics', 'untouched keys in the block survive the merge');
  assert.equal(body.providers.own?.enabled, true, 'sibling provider blocks untouched');
  assert.equal(body.consent.honor_gpc, false);
  assert.ok(trackingConfigBodySchema.safeParse(body).success, 'the merged body still parses');

  const entry = forward.record.history.at(-1)!;
  assert.equal(entry.action, 'set_tracking_config_fields');
  const inverse = derivePatchInverse(entry.details!.op as never, entry.details!.capture as PatchOpCapture);
  const reverted = applyPatchOps(forward.record, [inverse], { actor: AGENT, at: AT }).record.body;
  assert.ok(deepEqualJson(reverted, validBody()), 'inverse restores the pre-patch body exactly');
});

// ═══ validation criterion ═════════════════════════════════════════════════════

test('tracking_config_ready: complete on the valid body; banner/regions rules warn at draft and block at publish', () => {
  const find = (body: unknown, atPublish: boolean) =>
    checkStructuralInvariants('tracking_config', 'trk_drlurie', body, {}, atPublish).find(
      (criterion) => criterion.id === 'tracking_config_ready'
    );

  assert.equal(find(validBody(), true)?.status, 'complete');

  // Advertising provider enabled, banner missing → warn at draft, block at publish.
  const base = validBody();
  const ads = {
    ...base,
    providers: {
      ...base.providers,
      google_ads: { enabled: true, consent_class: 'advertising', conversion_id: 'AW-123456789' },
    },
    consent: { ...base.consent, banner: undefined },
  };
  assert.equal(find(ads, false)?.status, 'warning');
  assert.equal(find(ads, true)?.status, 'missing');
  assert.match(find(ads, true)!.message, /banner/);

  // us-first posture: no banner needed even with advertising enabled.
  const usFirst = { ...ads, consent: { ...ads.consent, posture: 'us-first', banner: undefined } };
  assert.equal(find(usFirst, true)?.status, 'complete');

  // geo-adaptive with empty regions → publish-gated.
  const noRegions = { ...base, consent: { ...base.consent, restricted_regions: [] } };
  assert.equal(find(noRegions, false)?.status, 'warning');
  assert.equal(find(noRegions, true)?.status, 'missing');

  // Enabled provider without an id → hard missing (mirrors the schema block).
  const noId = {
    ...base,
    providers: { ...base.providers, ga4: { enabled: true, consent_class: 'analytics' } },
  };
  assert.equal(find(noId, false)?.status, 'missing');
});

// ═══ contract ═════════════════════════════════════════════════════════════════

test('object_contract(tracking_config) is complete: governed, agent-closed creation, the three constraints', () => {
  const contract = buildObjectContract('tracking_config');
  assert.equal(contract.governed, true);
  // T13.10: "seeds mint" has a name — the conversion-factory driver.
  assert.deepEqual(
    contract.creation_policy.agents,
    { allowlist: ['object-conversion-roundtrip'] },
    'human/seed-minted only (the driver is the seed identity)'
  );
  assert.equal(contract.publish_policy.requires_approval, false, 'ships AUTONOMOUS (OQ-W13-2)');
  assert.deepEqual(
    contract.patch_ops.map((op) => op.op),
    ['set_tracking_config_fields']
  );
  for (const id of ['tracking_config_safety', 'tracking_config_singleton', 'tracking_config_ready']) {
    assert.ok(
      contract.constraints.some((constraint) => constraint.id === id),
      `constraint ${id} present`
    );
  }
  assert.ok(
    !contract.constraints.some((constraint) => constraint.id === 'tracking_attribute'),
    'the registry does not carry the per-object tracking attribute'
  );
  const schemaText = JSON.stringify(contract.body_schema);
  for (const fragment of ['providers', 'consent', 'defaults', 'restricted_regions']) {
    assert.ok(schemaText.includes(fragment), `body_schema advertises ${fragment}`);
  }
});

// ═══ singleton refusal (verbs) ════════════════════════════════════════════════

const createMemoryStore = () => {
  const blobs = new Map<string, string>();
  return {
    blobs,
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      blobs.set(key, JSON.stringify(value));
    },
    async list({ prefix }: { prefix: string }) {
      return { blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
};

test('create: humans mint the singleton; agents are refused; a second active registry is refused (409)', async () => {
  const store = createMemoryStore();
  const call = async (request: ObjectVerbRequest, principal: Principal) => {
    const verbStore = store as unknown as ObjectVerbStore;
    const validationContext = await buildStoreValidationContext(verbStore);
    return handleObjectVerb(verbStore, request, principal, { nowMs: NOW, validationContext });
  };
  const createRequest = (id: string): ObjectVerbRequest => ({
    action: 'create',
    object_type: 'tracking_config',
    site: 'site_drlurie',
    body: validBody(),
    requested_id: id,
  });

  const agentDenied = await call(createRequest('trk_drlurie'), AGENT);
  assert.equal(agentDenied.status, 403, JSON.stringify(agentDenied.body));

  const created = await call(createRequest('trk_drlurie'), HUMAN);
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const second = await call(createRequest('trk_second'), HUMAN);
  assert.equal(second.status, 409, 'a second active registry is refused regardless of id');
  assert.match(JSON.stringify(second.body), /singleton|exactly one/i);
});
