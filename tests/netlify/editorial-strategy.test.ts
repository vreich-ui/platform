/**
 * `editorial_strategy` — the third genesis-seeded tenant singleton (Wolf,
 * 2026-09-09).
 *
 * What this file pins, and why each one matters:
 *   1. The type exists in the ONE enum source and the contract surface tracks
 *      it (the anti-drift guard in object-contract.test.ts is the other half).
 *   2. The id is `strat_<site>` and nothing else — the convention every
 *      address-resolver in the fleet derives by hand.
 *   3. `strategy_not_a_prompt` BLOCKS AT WRITE, including inside
 *      `private.notes`. This is the constraint the whole "governed data, not a
 *      prompt fragment" argument rests on; a warning here would be too late.
 *   4. The singleton refusal is a 409 that names the existing object and the
 *      edit op — the failure mode is an agent minting a second strategy and
 *      the fleet quietly disagreeing about which one is "the" strategy.
 *   5. `provenance` is the UNSET MARKER: a seeded default warns and never
 *      blocks, and an ordinary edit stamps it to the editing principal, so the
 *      marker cannot rot into noise.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  editorialStrategyBodySchema,
  type EditorialStrategyBody,
} from '../../packages/core/schema/bodies/editorial-strategy-v1.js';
import { isSeededDefault } from '../../packages/core/schema/bodies/baseline-provenance-v1.js';
import { buildObjectContract } from '../../packages/core/lib/registry/object-contract.js';
import { checkEditorialStrategy } from '../../packages/core/server/lib/object-validate.js';
import { materialize } from '../../packages/core/server/lib/materialize.js';
import { objectTypes, type Principal } from '../../packages/core/schema/object-record-v1.js';
import { governedObjectTypes } from '../../packages/core/lib/approval-policy.js';
import { validateObjectIdForType } from '../../packages/core/lib/object-ids.js';
import { patchOpNamesByObjectType } from '../../packages/core/schema/object-patch-ops.js';
import {
  handleObjectVerb,
  type ObjectVerbRequest,
  type ObjectVerbStore,
} from '../../packages/core/server/lib/object-verbs.js';

const AT = '2026-09-09T00:00:00.000Z';

const VALID: EditorialStrategyBody = {
  name: 'Test strategy',
  goal: 'Publishing exists to bring qualified readers to the barrier-repair line.',
  offer: 'A £39 barrier-repair guide, upsold to the full protocol.',
  audience_segments: ['post-procedure patients', 'long-term eczema sufferers'],
  topic_weights: [
    { term_id: 'term_barrier', label: 'barrier repair', weight: 0.6 },
    { label: 'ingredient myths', weight: 0.4 },
  ],
  angle_mix: [
    { angle: 'myth-correction', share: 0.5 },
    { angle: 'protocol walkthrough', share: 0.5 },
  ],
  funnel_aggression: { tofu: 0.1, mofu: 0.4, bofu: 0.8 },
  cadence: 'Two long-form articles a week; one teardown a month.',
  provenance: { set_by: 'human', set_at: AT },
};

const body = (overrides: Partial<EditorialStrategyBody> = {}): EditorialStrategyBody => ({
  ...structuredClone(VALID),
  ...overrides,
});

// ─── 1. the type exists and is governed ──────────────────────────────────────

test('editorial_strategy is the fourteenth object type and the THIRTEENTH governed one', () => {
  assert.ok((objectTypes as readonly string[]).includes('editorial_strategy'));
  assert.equal(objectTypes.length, 14);
  // Unlike visual_standard (the other late arrival), a strategy IS publishable
  // and approvable — it materializes to an audit-trail export.
  assert.ok((governedObjectTypes as readonly string[]).includes('editorial_strategy'));
  assert.equal(governedObjectTypes.length, 13);
});

test('object_contract("editorial_strategy") is reachable and publishes its own constraints', () => {
  const contract = buildObjectContract('editorial_strategy');
  const ids = contract.constraints.map((constraint) => constraint.id);
  for (const id of [
    'strategy_not_a_prompt',
    'strategy_singleton',
    'strategy_provenance_set',
    'strategy_shares_not_normalized',
    'strategy_funnel_shape',
  ]) {
    assert.ok(ids.includes(id), `contract is missing ${id}`);
  }
  // The prompt law is the one that refuses a WRITE — the whole reason the
  // strategy is an object and not a prompt fragment.
  const promptLaw = contract.constraints.find((constraint) => constraint.id === 'strategy_not_a_prompt');
  assert.equal(promptLaw?.severity, 'blocks_write');
});

test('the only patch op is set_strategy_fields — no set_tracking (publishing law is not a tracked surface)', () => {
  assert.deepEqual([...patchOpNamesByObjectType.editorial_strategy], ['set_strategy_fields']);
});

// ─── 2. the id convention ────────────────────────────────────────────────────

test('the id shape is strat_<site> and nothing else', () => {
  assert.ok(validateObjectIdForType('editorial_strategy', 'strat_drlurie').ok);
  assert.ok(validateObjectIdForType('editorial_strategy', 'strat_genesis_lab_2').ok);
  assert.ok(!validateObjectIdForType('editorial_strategy', 'voice_drlurie').ok);
  assert.ok(!validateObjectIdForType('editorial_strategy', 'strat_Drlurie').ok);
});

// ─── 3. the body schema ──────────────────────────────────────────────────────

test('a well-formed strategy parses; the shares are NOT required to sum to 1', () => {
  assert.ok(editorialStrategyBodySchema.safeParse(VALID).success);
  const lopsided = body({ angle_mix: [{ angle: 'one', share: 0.9 }, { angle: 'two', share: 0.9 }] });
  assert.ok(
    editorialStrategyBodySchema.safeParse(lopsided).success,
    'a sum invariant would make the natural partial edit refuse until everything else was rebalanced'
  );
});

test('a weight attached to nothing, a duplicate topic and a duplicate angle are all refused', () => {
  assert.ok(!editorialStrategyBodySchema.safeParse(body({ topic_weights: [{ weight: 0.5 }] })).success);
  assert.ok(
    !editorialStrategyBodySchema.safeParse(
      body({ topic_weights: [{ term_id: 'term_a', weight: 0.5 }, { term_id: 'term_a', weight: 0.2 }] })
    ).success
  );
  assert.ok(
    !editorialStrategyBodySchema.safeParse(
      body({ angle_mix: [{ angle: 'same', share: 0.5 }, { angle: 'same', share: 0.5 }] })
    ).success
  );
});

test('shares and weights are bounded 0–1, and provenance is required', () => {
  assert.ok(!editorialStrategyBodySchema.safeParse(body({ funnel_aggression: { tofu: 0, mofu: 0.5, bofu: 1.4 } })).success);
  const { provenance: _dropped, ...withoutProvenance } = structuredClone(VALID);
  assert.ok(!editorialStrategyBodySchema.safeParse(withoutProvenance).success);
});

// ─── 4. the prompt guard ─────────────────────────────────────────────────────

test('strategy_not_a_prompt blocks at WRITE — in an ordinary field and inside private.notes', () => {
  const inGoal = checkEditorialStrategy(body({ goal: 'You are an expert growth marketer. Your task is to sell.' }), false);
  const goalCriterion = inGoal.find((criterion) => criterion.id === 'strategy_not_a_prompt');
  assert.equal(goalCriterion?.status, 'missing', 'a prompt in goal is refused while DRAFTING, not warned at publish');

  const inNotes = checkEditorialStrategy(body({ private: { notes: 'You are an expert. Your task is to comply.' } }), false);
  assert.equal(
    inNotes.find((criterion) => criterion.id === 'strategy_not_a_prompt')?.status,
    'missing',
    'a private field is still read by models — the guard must not exempt it'
  );

  assert.equal(
    checkEditorialStrategy(VALID, false).find((criterion) => criterion.id === 'strategy_not_a_prompt')?.status,
    'complete'
  );
});

test('ordinary strategic prose passes — the guard matches prompt scaffolding, not imperatives', () => {
  const prose = body({ goal: 'Lead with the diagnostic. Never open with the discount.' });
  assert.equal(
    checkEditorialStrategy(prose, false).find((criterion) => criterion.id === 'strategy_not_a_prompt')?.status,
    'complete'
  );
});

// ─── 5. provenance: the unset marker ─────────────────────────────────────────

test('a seeded default WARNS and never blocks — at draft and at publish alike', () => {
  const seeded = body({ provenance: { set_by: 'genesis_default', set_at: AT } });
  assert.ok(isSeededDefault(seeded.provenance));
  for (const atPublish of [false, true]) {
    const criterion = checkEditorialStrategy(seeded, atPublish).find(
      (entry) => entry.id === 'strategy_provenance_set'
    );
    assert.equal(criterion?.status, 'warning', `atPublish=${atPublish}: a thin default is legal, never a blocker`);
  }
});

test('an agent-supplied or human-authored strategy is complete, not warned', () => {
  for (const setBy of ['agent', 'human'] as const) {
    const decided = body({ provenance: { set_by: setBy, set_at: AT } });
    assert.equal(
      checkEditorialStrategy(decided, false).find((entry) => entry.id === 'strategy_provenance_set')?.status,
      'complete'
    );
  }
  // Absence is NOT treated as a seeded default — it is its own warning.
  assert.ok(!isSeededDefault(undefined));
});

test('an inverted funnel warns rather than refusing — usually a transposed pair, occasionally deliberate', () => {
  const inverted = body({ funnel_aggression: { tofu: 0.9, mofu: 0.4, bofu: 0.1 } });
  assert.equal(
    checkEditorialStrategy(inverted, false).find((entry) => entry.id === 'strategy_funnel_shape')?.status,
    'warning'
  );
});

// ─── 6. the materializer ─────────────────────────────────────────────────────

test('materializes to <exportRoot>/strategy/<id>.json, deterministically, with private.notes stripped', () => {
  const meta = { exportRoot: 'sites/drlurie/data/site', from: 'test', at: AT, record_version: 1 };
  const withNotes = body({ private: { notes: 'The real reason we lead with the diagnostic.' } });
  const file = materialize('editorial_strategy', 'strat_drlurie', withNotes, meta);
  assert.equal(file.path, 'sites/drlurie/data/site/strategy/strat_drlurie.json');
  assert.ok(!file.content.includes('The real reason'), 'private.* never leaves the store');
  const again = materialize('editorial_strategy', 'strat_drlurie', withNotes, meta);
  assert.equal(file.content, again.content, 'same body in, byte-identical file out');
});

// ─── 7. the singleton refusal, over the real verb surface ────────────────────

const createMemoryStore = (): ObjectVerbStore => {
  const blobs = new Map<string, string>();
  return {
    get: async (key: string) => blobs.get(key) ?? null,
    setJSON: async (key: string, value: unknown) => {
      blobs.set(key, JSON.stringify(value));
    },
    list: async (options?: { prefix?: string }) => ({
      blobs: [...blobs.keys()]
        .filter((key) => key.startsWith(options?.prefix ?? ''))
        .map((key) => ({ key, etag: 'e' })),
    }),
    delete: async (key: string) => {
      blobs.delete(key);
    },
  } as unknown as ObjectVerbStore;
};

// The sanctioned seed identity — creation-policy.ts pins editorial_strategy to
// the same allowlist as editorial_voice, so an ordinary agent cannot mint one.
const SEED: Principal = { kind: 'agent', agent_name: 'object-conversion-roundtrip', auth: 'publish_key' };
const call = (store: ObjectVerbStore, request: ObjectVerbRequest, actor: Principal = SEED) =>
  handleObjectVerb(store, request, actor, {});

test('a second active strategy is refused 409, naming the existing object and the edit op', async () => {
  const store = createMemoryStore();
  const first = await call(store, {
    action: 'create',
    object_type: 'editorial_strategy',
    site: 'site_drlurie',
    body: body(),
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal((first.body as { record: { object_id: string } }).record.object_id, 'strat_drlurie');

  const second = await call(store, {
    action: 'create',
    object_type: 'editorial_strategy',
    site: 'site_drlurie',
    requested_id: 'strat_drlurie_second',
    body: body({ name: 'A rival strategy' }),
  });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.match(JSON.stringify(second.body), /set_strategy_fields/);
});

test('an ordinary agent may not MINT a strategy — the creation policy is the voice rule, verbatim', async () => {
  const store = createMemoryStore();
  const refused = await call(
    store,
    { action: 'create', object_type: 'editorial_strategy', site: 'site_drlurie', body: body() },
    { kind: 'agent', agent_name: 'draft_writer', auth: 'publish_key' }
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
});

test('an edit stamps provenance to the editing principal, so a seeded default stops looking like one', async () => {
  const store = createMemoryStore();
  const created = await call(store, {
    action: 'create',
    object_type: 'editorial_strategy',
    site: 'site_drlurie',
    body: body({ provenance: { set_by: 'genesis_default', set_at: AT } }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const checkout = await call(store, {
    action: 'checkout',
    object_type: 'editorial_strategy',
    object_id: 'strat_drlurie',
  });
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
  const { lockToken, record_version: version } = checkout.body as { lockToken: string; record_version: number };

  const patched = await call(store, {
    action: 'patch',
    object_type: 'editorial_strategy',
    object_id: 'strat_drlurie',
    lock_token: lockToken,
    expected_record_version: version,
    ops: [{ op: 'set_strategy_fields', fields: { cadence: 'One article a week.' } }],
  } as ObjectVerbRequest);
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  const read = await call(store, {
    action: 'get',
    object_type: 'editorial_strategy',
    object_id: 'strat_drlurie',
  } as ObjectVerbRequest);
  const stored = (read.body as { record: { body: EditorialStrategyBody } }).record.body;
  assert.equal(stored.provenance.set_by, 'agent', 'the seed marker must not survive somebody actually editing it');
  assert.equal(stored.cadence, 'One article a week.');
});
