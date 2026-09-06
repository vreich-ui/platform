/**
 * T21.5 — experiments: schema, reference validation, arm indexing, the loader's
 * one-exposure rule, and the props/event-kind wiring.
 *
 * The EDGE decision has its own file (tracking-experiments-edge.test.ts); the
 * build step's map/weights have theirs (tests/scripts/tracking-experiments.test.mjs).
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkStructuralInvariants } from '../../packages/core/server/lib/object-validate.js';
import { materializeTrackingConfig } from '../../packages/core/server/lib/materializers/tracking-config.js';
import type {
  ExperimentArmResolution,
  ObjectValidationContext,
} from '../../packages/core/server/lib/object-validate.js';
import {
  TRACKING_EVENT_KINDS,
  trackingConfigBodySchema,
  type TrackingConfigBody,
} from '../../packages/core/schema/bodies/tracking-config-v1.js';
import { clientTrackingEventSchema } from '../../packages/core/schema/tracking-event-v1.js';
import {
  TRACKING_PROPS_ALLOWLIST,
  sanitizeTrackingProps,
} from '../../packages/core/server/lib/tracking-events.js';
import {
  contentItemRoute,
  indexActiveArms,
} from '../../packages/core/lib/tracking/experiments/arms.js';
import {
  applyPatchOps,
  deepEqualJson,
  derivePatchInverse,
  type PatchOpCapture,
} from '../../packages/core/lib/object-patch-apply.js';
import type { ObjectRecord, Principal } from '../../packages/core/schema/object-record-v1.js';

const AGENT: Principal = { kind: 'agent', agent_name: 'trk-exp-test', auth: 'publish_key' };
const AT = '2026-09-05T12:00:00.000Z';

const CONTROL = 'req_agent_demo_20260713_01';
const VARIANT_A = 'req_agent_demo_variant_a_20260831_01';
const VARIANT_B = 'req_agent_demo_variant_b_20260831_01';
const OTHER_PARENT = 'req_agent_other_20260713_01';

const baseBody = (): TrackingConfigBody =>
  trackingConfigBodySchema.parse({
    providers: { own: { enabled: true, consent_class: 'essential' } },
    consent: { posture: 'geo-adaptive', restricted_regions: ['DE', 'FR'], honor_gpc: true },
    defaults: {
      page: ['pageview'],
      section: [],
      content_item: ['pageview'],
      product: [],
      navigation: [],
      taxonomy: [],
      outbound_links: false,
      utm_capture: false,
    },
  });

const experiment = (over: Record<string, unknown> = {}) => ({
  object_id: CONTROL,
  arms: [
    { variant_id: CONTROL, route: '/demo' },
    { variant_id: VARIANT_A, route: '/demo-a' },
  ],
  status: 'active',
  ...over,
});

const withExperiments = (experiments: unknown[]) => ({ ...baseBody(), experiments });

// ═══ schema ═══════════════════════════════════════════════════════════════════

test('schema: experiments defaults to [] — the zero-experiment state is the shape default', () => {
  const parsed = baseBody();
  assert.deepEqual(parsed.experiments, [], 'a body written before T21.5 parses with an empty experiments list');
});

test('schema: arm bounds, id grammar, route shape, status enum, strictness', () => {
  assert.ok(trackingConfigBodySchema.safeParse(withExperiments([experiment()])).success);

  const oneArm = experiment({ arms: [{ variant_id: CONTROL, route: '/demo' }] });
  assert.ok(!trackingConfigBodySchema.safeParse(withExperiments([oneArm])).success, 'min 2 arms');

  const sevenArms = experiment({
    arms: Array.from({ length: 7 }, (_unused, index) => ({
      variant_id: `req_agent_demo_v${index}_20260831_01`,
      route: `/demo-${index}`,
    })),
  });
  assert.ok(!trackingConfigBodySchema.safeParse(withExperiments([sevenArms])).success, 'max 6 arms');

  const badId = experiment({ arms: [{ variant_id: CONTROL, route: '/demo' }, { variant_id: 'page_home', route: '/x' }] });
  assert.ok(!trackingConfigBodySchema.safeParse(withExperiments([badId])).success, 'arms are content_item ids only');

  const badRoute = experiment({
    arms: [{ variant_id: CONTROL, route: '/demo' }, { variant_id: VARIANT_A, route: 'https://evil.example.com' }],
  });
  assert.ok(!trackingConfigBodySchema.safeParse(withExperiments([badRoute])).success, 'route is site-relative, never a URL');

  const badStatus = experiment({ status: 'paused' });
  assert.ok(!trackingConfigBodySchema.safeParse(withExperiments([badStatus])).success);

  const extraKey = experiment({ traffic: 0.5 });
  assert.ok(!trackingConfigBodySchema.safeParse(withExperiments([extraKey])).success, 'strict object');

  const tooMany = Array.from({ length: 21 }, (_unused, index) => experiment({ object_id: `req_agent_demo${index}_20260713_01` }));
  assert.ok(!trackingConfigBodySchema.safeParse(withExperiments(tooMany)).success, 'max 20 experiments');
});

test("schema: 'exposure' is a first-class event kind with its own bounded props", () => {
  assert.ok(TRACKING_EVENT_KINDS.includes('exposure'));
  assert.deepEqual(TRACKING_PROPS_ALLOWLIST.exposure, ['experiment_id', 'variant_id']);
  assert.deepEqual(
    sanitizeTrackingProps('exposure', { experiment_id: CONTROL, variant_id: VARIANT_A, label_slug: 'sneaky' }),
    { experiment_id: CONTROL, variant_id: VARIANT_A },
    'the allowlist drops everything else silently'
  );
  const event = {
    event_id: '11111111-1111-4111-8111-111111111111',
    ts: '2026-09-05T00:00:00.000Z',
    event: 'exposure',
    url: { path: '/demo', route: null },
    props: { experiment_id: CONTROL, variant_id: VARIANT_A },
    consent: { analytics: false, ads: false, gpc: false },
  };
  assert.ok(clientTrackingEventSchema.safeParse(event).success);
  assert.ok(
    !clientTrackingEventSchema.safeParse({ ...event, props: { experiment_id: 'nope', variant_id: VARIANT_A } }).success,
    'the id grammar is enforced on the wire, not just at render'
  );
});

// ═══ patchability ═════════════════════════════════════════════════════════════

test('set_tracking_config_fields patches experiments and inverts exactly', () => {
  const record: ObjectRecord = {
    schema_version: 'object_record.v1',
    object_id: 'trk_drlurie',
    object_type: 'tracking_config',
    site: 'site_drlurie',
    created_at: AT,
    updated_at: AT,
    status: 'active',
    body: baseBody(),
    publication: { published_time: null },
    history: [],
    version: 1,
    content_revision: 1,
  };
  const forward = applyPatchOps(
    record,
    [{ op: 'set_tracking_config_fields', fields: { experiments: [experiment()] } }],
    { actor: AGENT, at: AT }
  );
  const patched = forward.record.body as TrackingConfigBody;
  assert.equal(patched.experiments.length, 1);
  assert.ok(trackingConfigBodySchema.safeParse(patched).success, 'the merged body still parses');

  const entry = forward.record.history.at(-1)!;
  const inverse = derivePatchInverse(entry.details!.op as never, entry.details!.capture as PatchOpCapture);
  const reverted = applyPatchOps(forward.record, [inverse], { actor: AGENT, at: AT }).record.body;
  assert.ok(deepEqualJson(reverted, baseBody()), 'the fields idiom round-trips experiments like every other block');
});

// ═══ reference validation ═════════════════════════════════════════════════════

const arms: Record<string, ExperimentArmResolution> = {
  [CONTROL]: { exists: true, published: true, parentContentId: null, slug: 'demo' },
  [VARIANT_A]: { exists: true, published: true, parentContentId: CONTROL, slug: 'demo-a' },
  [VARIANT_B]: { exists: true, published: true, parentContentId: CONTROL, slug: 'demo-b' },
  [OTHER_PARENT]: { exists: true, published: true, parentContentId: 'req_agent_elsewhere_20260713_01', slug: 'other' },
};

const context = (over: Partial<ObjectValidationContext> = {}): ObjectValidationContext => ({
  resolveExperimentArm: (id) => arms[id],
  ...over,
});

const criterion = (body: unknown, ctx: ObjectValidationContext = context(), atPublish = true) =>
  checkStructuralInvariants('tracking_config', 'trk_drlurie', body, ctx, atPublish).find(
    (item) => item.id === 'tracking_config_ready'
  )!;

test('validation: a well-formed experiment is complete', () => {
  assert.equal(criterion(withExperiments([experiment()])).status, 'complete');
  assert.equal(criterion(withExperiments([])).status, 'complete', 'zero experiments changes nothing');
});

test('validation: every non-control arm must be a variant of the control', () => {
  const foreign = experiment({
    arms: [
      { variant_id: CONTROL, route: '/demo' },
      { variant_id: OTHER_PARENT, route: '/other' },
    ],
  });
  const result = criterion(withExperiments([foreign]));
  assert.equal(result.status, 'missing');
  assert.match(result.message, /lineage\.parent_content_id/);
});

test('validation: the control must be listed exactly once among the arms', () => {
  const noControl = experiment({
    arms: [
      { variant_id: VARIANT_A, route: '/demo-a' },
      { variant_id: VARIANT_B, route: '/demo-b' },
    ],
  });
  const result = criterion(withExperiments([noControl]));
  assert.equal(result.status, 'missing');
  assert.match(result.message, /must include the control/);
});

test("validation: an arm's route must be its own published route", () => {
  const stale = experiment({
    arms: [
      { variant_id: CONTROL, route: '/demo' },
      { variant_id: VARIANT_A, route: '/demo-a-old' },
    ],
  });
  const result = criterion(withExperiments([stale]));
  assert.equal(result.status, 'missing');
  assert.match(result.message, /is not its published route "\/demo-a"/);
});

test('validation: an ACTIVE experiment cannot serve an unpublished arm; a DRAFT one may', () => {
  const draftArms: Record<string, ExperimentArmResolution> = {
    ...arms,
    [VARIANT_A]: { exists: true, published: false, parentContentId: CONTROL, slug: 'demo-a' },
  };
  const ctx = context({ resolveExperimentArm: (id) => draftArms[id] });
  assert.equal(criterion(withExperiments([experiment()]), ctx).status, 'missing');
  assert.match(criterion(withExperiments([experiment()]), ctx).message, /not published/);
  assert.equal(
    criterion(withExperiments([experiment({ status: 'draft' })]), ctx).status,
    'complete',
    'drafting an experiment before its variants ship is the normal order of work'
  );
});

test('validation: a nonexistent arm fails; an UNRESOLVABLE one is not verified rather than failed', () => {
  const missing = experiment({
    arms: [
      { variant_id: CONTROL, route: '/demo' },
      { variant_id: 'req_agent_ghost_20260831_01', route: '/ghost' },
    ],
  });
  const ctx = context({ resolveExperimentArm: (id) => (id in arms ? arms[id] : { exists: false, published: false, parentContentId: null, slug: null }) });
  assert.equal(criterion(withExperiments([missing]), ctx).status, 'missing');
  assert.match(criterion(withExperiments([missing]), ctx).message, /is not a content_item that exists/);

  // No resolver at all → the standing "absent resolver = not verified" rule.
  assert.equal(criterion(withExperiments([missing]), {}).status, 'complete');
});

test('validation: winner must be one of the arms, and duplicate controls are refused', () => {
  const badWinner = experiment({ status: 'concluded', winner: OTHER_PARENT });
  assert.match(criterion(withExperiments([badWinner])).message, /winner/);

  const duplicated = [experiment(), experiment()];
  assert.match(criterion(withExperiments(duplicated)).message, /share the same control/);
});

// ═══ arm indexing (the render seam's source of truth) ═════════════════════════

test('indexActiveArms: only ACTIVE experiments index, and the control is marked as such', () => {
  const index = indexActiveArms([
    { object_id: CONTROL, status: 'active', arms: [{ variant_id: CONTROL, route: '/demo' }, { variant_id: VARIANT_A, route: '/demo-a' }] },
  ]);
  assert.deepEqual(index[CONTROL], {
    experiment_id: CONTROL,
    variant_id: CONTROL,
    is_control: true,
    control_route: '/demo',
  });
  assert.deepEqual(index[VARIANT_A], {
    experiment_id: CONTROL,
    variant_id: VARIANT_A,
    is_control: false,
    control_route: '/demo',
  });

  for (const status of ['draft', 'concluded']) {
    assert.deepEqual(
      indexActiveArms([{ object_id: CONTROL, status, arms: [{ variant_id: CONTROL, route: '/demo' }, { variant_id: VARIANT_A, route: '/demo-a' }] }]),
      {},
      `${status} serves nobody — concluding reverts every reader to the control with no second switch`
    );
  }
  assert.deepEqual(indexActiveArms(undefined), {}, 'an export with no experiments indexes nothing');
});

test('contentItemRoute derives the route from the slug and the site pattern', () => {
  assert.equal(contentItemRoute('demo-a'), '/demo-a');
  assert.equal(contentItemRoute('demo-a', '/library/%slug%'), '/library/demo-a');
  assert.equal(contentItemRoute('demo-a', '/library/%slug%/'), '/library/demo-a');
});

// ═══ materializer ═════════════════════════════════════════════════════════════

test('materializer: tracking.json carries experiments verbatim, and [] when there are none', () => {
  const meta = { at: '2026-09-05T12:00:00.000Z', record_version: 7, exportRoot: 'sites/drlurie/data/site' };

  const withOne = materializeTrackingConfig('trk_drlurie', withExperiments([experiment()]), meta);
  assert.equal(withOne.path, 'sites/drlurie/data/site/tracking.json');
  const exported = JSON.parse(withOne.content) as { experiments: unknown[]; __generated: { from: string } };
  assert.deepEqual(
    exported.experiments,
    [experiment()],
    'the registry snapshot is exported verbatim — the build step is its only consumer'
  );
  assert.equal(exported.__generated.from, 'objects/tracking_config/by-id/trk_drlurie.json');

  const withNone = JSON.parse(materializeTrackingConfig('trk_drlurie', baseBody(), meta).content) as {
    experiments: unknown[];
  };
  assert.deepEqual(withNone.experiments, [], 'the zero-experiment export is an empty list, never an absent key');

  // A draft/concluded experiment still EXPORTS (the registry is a snapshot);
  // it is `indexActiveArms` / the build step that decides what serves.
  const drafted = JSON.parse(
    materializeTrackingConfig('trk_drlurie', withExperiments([experiment({ status: 'draft' })]), meta).content
  ) as { experiments: { status: string }[] };
  assert.equal(drafted.experiments[0]!.status, 'draft');

  // A body the schema refuses never reaches an export file.
  assert.throws(() => materializeTrackingConfig('trk_drlurie', withExperiments([experiment({ status: 'paused' })]), meta));
});
