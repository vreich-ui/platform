import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleObjectVerb,
  type ObjectVerbRequest,
  type ObjectVerbStore,
} from '../../packages/core/server/lib/object-verbs.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import { validateObjectIdForType } from '../../packages/core/lib/object-ids.js';
import { trackingConfigBodySchema } from '../../packages/core/schema/bodies/tracking-config-v1.js';
import type { ObjectRecord, Principal } from '../../packages/core/schema/object-record-v1.js';

// Integration suite for the shared object-verb core (T0.8) against an in-memory
// store — the local blob fallback for tests. Both auth paths funnel through
// handleObjectVerb differing only in the Principal, so both principals are
// exercised here; the HTTP auth layers are covered in object-store-auth.test.ts.

const NOW = Date.parse('2026-07-05T12:00:00.000Z');
const AGENT: Principal = { kind: 'agent', agent_name: 'draft-agent', auth: 'publish_key' };
const HUMAN: Principal = { kind: 'human', id: 'identity-1', email: 'editor@example.com' };

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
type Store = ReturnType<typeof createMemoryStore>;

const call = (store: Store, request: ObjectVerbRequest, principal: Principal = AGENT, nowMs = NOW) =>
  handleObjectVerb(store as unknown as ObjectVerbStore, request, principal, { nowMs });

const stored = (store: Store, objectType: ObjectRecord['object_type'], objectId: string): ObjectRecord => {
  const raw = store.blobs.get(objectRecordKey(objectType, objectId));
  assert.ok(raw, 'record must exist');
  return JSON.parse(raw) as ObjectRecord;
};

const validPageBody = () => ({
  route: '/',
  pageType: 'home',
  title: 'Dr. Lurié',
  seo: { description: 'Science-first skincare.' },
  sections: [
    { id: 's_hero', type: 'hero', data: { heading: 'A calmer start', actions: [] } },
    { id: 's_bio', type: 'bio', data: { heading: 'Bio', body: '<p>Biophysicist.</p>', trustNotes: ['PhD'] } },
  ],
});

const emptyTaxonomyBody = () => ({ kinds: { category: { terms: [] }, tag: { terms: [] } } });

// Seed a created page and return {objectId, version}.
const seedPage = async (store: Store, principal: Principal = AGENT) => {
  const res = await call(
    store,
    { action: 'create', object_type: 'page', site: 'site_drlurie', body: validPageBody() },
    principal
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const record = res.body.record as ObjectRecord;
  return { objectId: record.object_id, version: record.version };
};

// ═══ create ═══════════════════════════════════════════════════════════════════

test('create mints a valid object id, persists v1/cr1, and writes the status index', async () => {
  const store = createMemoryStore();
  const res = await call(store, { action: 'create', object_type: 'page', site: 'site_drlurie', body: validPageBody() });
  assert.equal(res.status, 200);
  const record = res.body.record as ObjectRecord;
  assert.ok(validateObjectIdForType('page', record.object_id).ok, 'minted id passes the T0.3 validator');
  assert.equal(record.version, 1);
  assert.equal(record.content_revision, 1);
  assert.equal(record.status, 'active');
  assert.equal(record.history[0].action, 'create');
  assert.equal(record.history[0].actor.kind, 'agent');
  // status index marker present.
  assert.ok([...store.blobs.keys()].some((key) => key.startsWith('objects/page/index/by-status/active/')));
});

test('create honors a valid requested_id and rejects an invalid one', async () => {
  const store = createMemoryStore();
  const good = await call(store, {
    action: 'create',
    object_type: 'page',
    site: 'site_drlurie',
    body: validPageBody(),
    requested_id: 'page_home',
  });
  assert.equal(good.status, 200);
  assert.equal((good.body.record as ObjectRecord).object_id, 'page_home');

  const bad = await call(store, {
    action: 'create',
    object_type: 'page',
    site: 'site_drlurie',
    body: validPageBody(),
    requested_id: 'home', // missing page_ prefix
  });
  assert.equal(bad.status, 400);
});

test('create rejects an invalid body (422) and never persists it', async () => {
  const store = createMemoryStore();
  const body = { ...validPageBody(), pageType: 'landing' }; // unknown PageType
  const res = await call(store, {
    action: 'create',
    object_type: 'page',
    site: 'site_drlurie',
    body,
    requested_id: 'page_bad',
  });
  assert.equal(res.status, 422);
  assert.equal(store.blobs.get(objectRecordKey('page', 'page_bad')), undefined);
});

test('create accepts content_item since W7.3, minting a dated req_* id from the slug', async () => {
  const store = createMemoryStore();
  const res = await call(store, {
    action: 'create',
    object_type: 'content_item',
    site: 'site_drlurie',
    body: {
      slug: 'barrier-myths',
      title: 'Barrier myths',
      nodes: [
        { id: 'n_a1', kind: 'content', public: { body: 'Opening.' }, private: { strategy: 'hook' } },
        { id: 'n_a2', kind: 'content', public: { body: 'Close.' }, private: { strategy: 'resolution' } },
      ],
    },
  });
  assert.equal(res.status, 200);
  const record = (res.body as { record: { object_id: string; schema_version: string } }).record;
  assert.match(record.object_id, /^req_agent_barrier_myths_\d{8}_01$/);
  assert.equal(record.schema_version, 'content_item.v1');
  // A garbage body is still refused by validation, exactly like any type.
  const bad = await call(store, { action: 'create', object_type: 'content_item', site: 'site_drlurie', body: {} });
  assert.equal(bad.status, 422);
});

test('create rejects a duplicate object id (409)', async () => {
  const store = createMemoryStore();
  const req: ObjectVerbRequest = {
    action: 'create',
    object_type: 'page',
    site: 'site_drlurie',
    body: validPageBody(),
    requested_id: 'page_home',
  };
  assert.equal((await call(store, req)).status, 200);
  assert.equal((await call(store, req)).status, 409);
});

// ═══ get / list ═══════════════════════════════════════════════════════════════

test('get returns the record; get on a missing id is 404', async () => {
  const store = createMemoryStore();
  const { objectId } = await seedPage(store);
  const got = await call(store, { action: 'get', object_type: 'page', object_id: objectId });
  assert.equal(got.status, 200);
  assert.equal((got.body.record as ObjectRecord).object_id, objectId);
  assert.equal((await call(store, { action: 'get', object_type: 'page', object_id: 'page_ghost' })).status, 404);
});

test('list returns summaries for the type, honoring a status filter', async () => {
  const store = createMemoryStore();
  await seedPage(store);
  const res = await call(store, { action: 'list', object_type: 'page' });
  assert.equal(res.status, 200);
  const objects = res.body.objects as Record<string, unknown>[];
  assert.equal(objects.length, 1);
  assert.equal(objects[0].status, 'active');
  const archived = await call(store, { action: 'list', object_type: 'page', status: 'archived' });
  assert.equal((archived.body.objects as unknown[]).length, 0);
});

// ═══ lifecycle + conflict codes ══════════════════════════════════════════════

test('lifecycle: create → checkout → patch → checkin, both principals attributed', async () => {
  const store = createMemoryStore();
  const { objectId } = await seedPage(store, HUMAN);

  const checkout = await call(store, { action: 'checkout', object_type: 'page', object_id: objectId }, HUMAN);
  assert.equal(checkout.status, 200);
  const lockToken = checkout.body.lockToken as string;
  const version = checkout.body.record_version as number; // surfaced by the endpoint

  const patch = await call(
    store,
    {
      action: 'patch',
      object_type: 'page',
      object_id: objectId,
      lock_token: lockToken,
      expected_record_version: version,
      ops: [{ op: 'update_section_data', section_id: 's_hero', fields: { heading: 'A calmer, clearer start' } }],
    },
    HUMAN
  );
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  assert.equal(patch.body.content_revision, 2); // create=1, patch mutated body → 2
  assert.ok((patch.body.validation_summary as { eligible: boolean }).eligible);

  const record = stored(store, 'page', objectId);
  assert.equal((record.body as ReturnType<typeof validPageBody>).sections[0].data.heading, 'A calmer, clearer start');
  assert.ok(record.history.some((entry) => entry.action === 'update_section_data' && entry.actor.kind === 'human'));

  const checkin = await call(
    store,
    { action: 'checkin', object_type: 'page', object_id: objectId, lock_token: lockToken },
    HUMAN
  );
  assert.equal(checkin.status, 200);
});

test('conflict parity: 423 without a held lock, 423 on wrong/expired lock, 409 on stale version', async () => {
  const store = createMemoryStore();
  const { objectId } = await seedPage(store);
  const patchReq = (over: Partial<Extract<ObjectVerbRequest, { action: 'patch' }>>): ObjectVerbRequest => ({
    action: 'patch',
    object_type: 'page',
    object_id: objectId,
    lock_token: 'nope',
    expected_record_version: 1,
    ops: [{ op: 'update_section_data', section_id: 's_hero', fields: { heading: 'x' } }],
    ...over,
  });

  // No lock held at all → 423.
  assert.equal((await call(store, patchReq({}))).status, 423);

  const checkout = await call(store, { action: 'checkout', object_type: 'page', object_id: objectId });
  const lockToken = checkout.body.lockToken as string;
  const version = checkout.body.record_version as number;

  // Held lock, but WRONG token → 423.
  assert.equal((await call(store, patchReq({ lock_token: 'wrong', expected_record_version: version }))).status, 423);

  // Correct token but STALE expected_record_version → 409 (distinct from 423).
  assert.equal(
    (await call(store, patchReq({ lock_token: lockToken, expected_record_version: version - 1 }))).status,
    409
  );

  // Correct token but lock EXPIRED (now far past lease) → 423.
  const expired = await call(
    store,
    patchReq({ lock_token: lockToken, expected_record_version: version }),
    AGENT,
    NOW + 3600_000
  );
  assert.equal(expired.status, 423);
});

test('patch engine errors surface with T0.6 codes: typo op → 400 invalid_op, wrong family → 422 op_not_applicable', async () => {
  const store = createMemoryStore();
  const { objectId } = await seedPage(store);
  const checkout = await call(store, { action: 'checkout', object_type: 'page', object_id: objectId });
  const lockToken = checkout.body.lockToken as string;
  const version = checkout.body.record_version as number;

  const typo = await call(store, {
    action: 'patch',
    object_type: 'page',
    object_id: objectId,
    lock_token: lockToken,
    expected_record_version: version,
    ops: [{ op: 'update_sekshun_data', section_id: 's_hero', fields: { heading: 'x' } }],
  });
  assert.equal(typo.status, 400);
  assert.equal(typo.body.code, 'invalid_op');

  const wrongFamily = await call(store, {
    action: 'patch',
    object_type: 'page',
    object_id: objectId,
    lock_token: lockToken,
    expected_record_version: version,
    ops: [{ op: 'add_term', kind: 'tag', term: { term_id: 't_x', slug: 'x', label: 'X' } }],
  });
  assert.equal(wrongFamily.status, 422);
  assert.equal(wrongFamily.body.code, 'op_not_applicable');
});

test('patch that produces an invalid body is rejected (422) and NOT persisted', async () => {
  const store = createMemoryStore();
  const { objectId } = await seedPage(store);
  const checkout = await call(store, { action: 'checkout', object_type: 'page', object_id: objectId });
  const lockToken = checkout.body.lockToken as string;
  const version = checkout.body.record_version as number;
  const before = stored(store, 'page', objectId).version;

  const res = await call(store, {
    action: 'patch',
    object_type: 'page',
    object_id: objectId,
    lock_token: lockToken,
    expected_record_version: version,
    ops: [{ op: 'update_section_data', section_id: 's_bio', fields: { body: '<p>agentNotes: leak</p>' } }],
  });
  assert.equal(res.status, 422);
  assert.ok((res.body.blockers as { id: string }[]).some((c) => c.id === 'reader_safety'));
  assert.equal(stored(store, 'page', objectId).version, before, 'record must be unchanged after a rejected patch');
});

// ═══ validate (dry-run) ═══════════════════════════════════════════════════════

test('validate returns the report; validate with a candidate_patch dry-runs through T0.6', async () => {
  const store = createMemoryStore();
  const { objectId } = await seedPage(store);

  const plain = await call(store, { action: 'validate', object_type: 'page', object_id: objectId });
  assert.equal(plain.status, 200);
  assert.ok(Array.isArray(plain.body.validation));

  const good = await call(store, {
    action: 'validate',
    object_type: 'page',
    object_id: objectId,
    candidate_patch: [{ op: 'update_section_data', section_id: 's_hero', fields: { heading: 'New' } }],
  });
  assert.equal(good.body.eligible, true);

  const bad = await call(store, {
    action: 'validate',
    object_type: 'page',
    object_id: objectId,
    candidate_patch: [{ op: 'update_sekshun_data', section_id: 's_hero', fields: { heading: 'x' } }],
  });
  assert.equal(bad.body.eligible, false);
  assert.equal((bad.body.apply_error as { code: string }).code, 'invalid_op');
});

// ═══ validate: candidate body, no object_id yet (dry-run before create) ═══════

test('validate with body and no object_id dry-runs the create-path checks: valid body mints an id and reports ready', async () => {
  const store = createMemoryStore();
  const res = await call(store, { action: 'validate', object_type: 'page', body: validPageBody() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.dry_run, true);
  assert.ok(typeof res.body.object_id === 'string' && res.body.object_id.length > 0);
  assert.ok(validateObjectIdForType('page', res.body.object_id as string).ok, 'minted id passes the T0.3 validator');
  assert.equal(res.body.id_available, true);
  assert.equal((res.body.summary as { eligible: boolean }).eligible, true);
  assert.ok(Array.isArray(res.body.validation));
  // Nothing persisted.
  assert.equal(store.blobs.size, 0);
});

test('validate with body and no object_id surfaces the same schema failure object_create would 422 on', async () => {
  const store = createMemoryStore();
  const res = await call(store, { action: 'validate', object_type: 'page', body: { route: '/', title: 'x' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const summary = res.body.summary as { eligible: boolean; blockers: { id: string }[] };
  assert.equal(summary.eligible, false);
  assert.ok(summary.blockers.some((b) => b.id === 'schema_zod'));
  assert.equal(store.blobs.size, 0);
});

test('validate with body honors requested_id: invalid pattern 400s, taken id reports id_available:false', async () => {
  const store = createMemoryStore();
  const badId = await call(store, {
    action: 'validate',
    object_type: 'page',
    body: validPageBody(),
    requested_id: 'not-a-valid-page-id',
  });
  assert.equal(badId.status, 400);
  assert.match(String(badId.body.error), /Invalid requested_id/);

  const { objectId } = await seedPage(store);
  const taken = await call(store, {
    action: 'validate',
    object_type: 'page',
    body: validPageBody(),
    requested_id: objectId,
  });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(taken.body.object_id, objectId);
  assert.equal(taken.body.id_available, false);
});

test('validate rejects body+candidate_patch together and rejects neither object_id nor body', async () => {
  const store = createMemoryStore();
  const both = await call(store, {
    action: 'validate',
    object_type: 'page',
    body: validPageBody(),
    candidate_patch: [{ op: 'update_section_data', section_id: 's_hero', fields: { heading: 'x' } }],
  });
  assert.equal(both.status, 400);
  assert.match(String(both.body.error), /candidate_patch/);

  const neither = await call(store, { action: 'validate', object_type: 'page' });
  assert.equal(neither.status, 400);
  assert.match(String(neither.body.error), /object_id|body/);
});

test('validate with body reports a singleton_conflict for a would-be second tracking_config (agents can still dry-run it)', async () => {
  const store = createMemoryStore();
  const singletonBody = trackingConfigBodySchema.parse({
    providers: {},
    consent: { posture: 'us-first', restricted_regions: [], honor_gpc: true },
    defaults: {
      page: [],
      section: [],
      content_item: [],
      product: [],
      navigation: [],
      taxonomy: [],
      outbound_links: false,
      utm_capture: false,
    },
  });
  const created = await call(
    store,
    {
      action: 'create',
      object_type: 'tracking_config',
      site: 'site_drlurie',
      body: singletonBody,
      requested_id: 'trk_drlurie',
    },
    HUMAN
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));

  // An agent may not CREATE a second tracking_config, but validate is a
  // read-only preview and still reports the conflict it would hit.
  // `site` is required for a candidate dry-run of a SITE-DERIVED id type
  // (trk_<site>/voice_<site>/vis_<site>): this store holds no `site` record
  // for the dry-run to resolve one from, and seeding such an id from the body
  // is exactly the bug this parameter exists to prevent.
  const res = await call(
    store,
    { action: 'validate', object_type: 'tracking_config', site: 'site_drlurie', body: singletonBody },
    AGENT
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const conflict = res.body.singleton_conflict as { object_id: string } | undefined;
  assert.ok(conflict, 'expected a singleton_conflict to be reported');
  assert.equal(conflict?.object_id, 'trk_drlurie');
});

// ═══ ID minting: {slug,label} → add_term with a minted term_id ════════════════

test('a {slug,label} add_term is minted a valid term_id server-side (C§2.5-C)', async () => {
  const store = createMemoryStore();
  const created = await call(store, {
    action: 'create',
    object_type: 'taxonomy',
    site: 'site_drlurie',
    body: emptyTaxonomyBody(),
    requested_id: 'tax_drlurie',
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const checkout = await call(store, { action: 'checkout', object_type: 'taxonomy', object_id: 'tax_drlurie' });
  const lockToken = checkout.body.lockToken as string;
  const version = checkout.body.record_version as number;

  const patch = await call(store, {
    action: 'patch',
    object_type: 'taxonomy',
    object_id: 'tax_drlurie',
    lock_token: lockToken,
    expected_record_version: version,
    ops: [{ op: 'add_term', kind: 'tag', term: { slug: 'sunscreen', label: 'Sunscreen' } }], // NO term_id supplied
  });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));

  const minted = patch.body.minted as { index: number; field: string; id: string }[];
  assert.equal(minted.length, 1);
  assert.equal(minted[0].field, 'term.term_id');
  assert.match(minted[0].id, /^t_[a-z0-9]+$/); // passes the committed term-id shape
  assert.equal(minted[0].id, 't_sunscreen'); // deterministic from the slug

  const terms = (stored(store, 'taxonomy', 'tax_drlurie').body as ReturnType<typeof emptyTaxonomyBody>).kinds.tag
    .terms as {
    term_id: string;
    status: string;
  }[];
  assert.equal(terms[0].term_id, 't_sunscreen');
  assert.equal(terms[0].status, 'active');
});

// ═══ ID minting: id-less upsert_node → minted opaque n_* id (W7.7) ═══════════
// The contract has always advertised minted_id_field node.id; the canvas node
// palette is the first caller that actually omits the id.

test('an id-less upsert_node is minted a valid opaque node id server-side (W7.7)', async () => {
  const store = createMemoryStore();
  const created = await call(store, {
    action: 'create',
    object_type: 'content_item',
    site: 'site_drlurie',
    requested_id: 'req_agent_mint_probe_20260713_01',
    body: {
      slug: 'mint-probe',
      title: 'Mint probe',
      nodes: [{ id: 'n_first', kind: 'content', public: { body: 'First.' }, private: { strategy: 'hook' } }],
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const checkout = await call(store, {
    action: 'checkout',
    object_type: 'content_item',
    object_id: 'req_agent_mint_probe_20260713_01',
  });
  const lockToken = checkout.body.lockToken as string;
  const version = checkout.body.record_version as number;

  const patch = await call(store, {
    action: 'patch',
    object_type: 'content_item',
    object_id: 'req_agent_mint_probe_20260713_01',
    lock_token: lockToken,
    expected_record_version: version,
    ops: [
      {
        op: 'upsert_node',
        node: { kind: 'content', public: { body: 'Added from the palette.' }, private: { strategy: 'context' } },
        position: 1,
      }, // NO node.id supplied
    ],
  });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));

  const minted = patch.body.minted as { index: number; field: string; id: string }[];
  assert.equal(minted.length, 1);
  assert.equal(minted[0].field, 'node.id');
  assert.match(minted[0].id, /^n_[a-f0-9]+$/); // opaque hex — leak-safe by construction

  const nodes = (stored(store, 'content_item', 'req_agent_mint_probe_20260713_01').body as { nodes: { id: string }[] })
    .nodes;
  assert.equal(nodes.length, 2);
  assert.equal(nodes[1].id, minted[0].id);
});

// ═══ the 2026-09 minting incident: nothing derives an id from a body ════════
//
// seedForCreate had no case for `visual_standard` — P1 added the `vis` prefix
// to OBJECT_PREFIX without the matching seed rule — so it fell through to
// stringifying the WHOLE BODY as the id seed. A realistic body minted a
// several-hundred-character id, the blob store refused the key, and its raw
// "Netlify Blobs has generated an internal error (400 status code, ID: …)"
// reached a user's chat. Three separate guarantees close that, and each is
// pinned here.

test('SEED AUDIT: every object type mints a short, valid id even from a body carrying none of its seed fields', async () => {
  // A body with no route/name/slug/title/role for ANY type: whatever the seed
  // rule was going to reach for, it is not here. Before the fix this became
  // the id verbatim; now it becomes a bounded hash.
  const opaqueBody = {
    prose: 'x'.repeat(4000),
    nested: { deep: Array.from({ length: 40 }, (_, i) => ({ index: i, text: 'y'.repeat(80) })) },
  };
  // The three site-derived singleton types are covered by their own rule (and
  // their own tests) — they mint from the site, never from the body at all.
  const bodySeeded = [
    'page',
    'section',
    'navigation',
    'taxonomy',
    'site',
    'template',
    'section_template',
    'theme',
    'product',
    'content_item',
  ] as const;

  for (const objectType of bodySeeded) {
    const store = createMemoryStore();
    const res = await call(store, {
      action: 'validate',
      object_type: objectType,
      site: 'site_drlurie',
      body: opaqueBody,
    });
    assert.equal(res.status, 200, `${objectType}: ${JSON.stringify(res.body)}`);
    const objectId = res.body.object_id as string;
    assert.ok(validateObjectIdForType(objectType, objectId).ok, `${objectType}: ${objectId} must be a valid id`);
    assert.ok(objectId.length <= 80, `${objectType}: ${objectId} must be short (${objectId.length} chars)`);
    assert.ok(!objectId.includes('prose'), `${objectType}: the id must carry no trace of the body`);
  }
});

test('SEED AUDIT: the singleton types mint their per-site convention, never a body-derived id', async () => {
  // editorial_voice and tracking_config are, like visual_standard was,
  // singletons with no seed case — reachable today only because every caller
  // happens to pass requested_id. "Happens to" is what this bug was made of.
  const store = createMemoryStore();
  for (const [objectType, expected] of [
    ['editorial_voice', 'voice_drlurie'],
    ['tracking_config', 'trk_drlurie'],
  ] as const) {
    const res = await call(store, {
      action: 'validate',
      object_type: objectType,
      site: 'site_drlurie',
      body: { anything: 'at all', anotherKey: 'x'.repeat(500) },
    });
    assert.equal(res.status, 200, `${objectType}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.object_id, expected);
  }
});

test('an over-long requested_id is a typed 400 naming the length — it never reaches the store', async () => {
  const store = createMemoryStore();
  const overLong = `page_${'a'.repeat(400)}`;
  const res = await call(store, {
    action: 'create',
    object_type: 'page',
    site: 'site_drlurie',
    body: validPageBody(),
    requested_id: overLong,
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error, 'Invalid requested_id');
  assert.match(String(res.body.detail), /characters — the limit is 200/);
  assert.equal(store.blobs.size, 0, 'nothing may reach the store');
});

test('an over-long MINTED id is a typed 400 (MintIdError), not a store failure', async () => {
  const store = createMemoryStore();
  // A page mints from its title, which is genuinely caller-controlled and
  // genuinely unbounded — the one remaining way to ask for an id too long to
  // be a store key.
  const res = await call(store, {
    action: 'validate',
    object_type: 'page',
    body: { ...validPageBody(), route: 'a-'.repeat(200) },
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error, 'Could not mint an object id');
  assert.match(String(res.body.detail), /the limit is 200/);
});

test('a blob-store failure becomes a typed platform error naming the verb — never the provider’s own words', async () => {
  const store = createMemoryStore();
  // Exactly what the live store threw during the incident.
  const blobsFailure = new Error('Netlify Blobs has generated an internal error (400 status code, ID: cb90450d-0000)');
  const failing = {
    ...store,
    async get() {
      throw blobsFailure;
    },
  };

  const res = await handleObjectVerb(
    failing as unknown as ObjectVerbStore,
    { action: 'get', object_type: 'page', object_id: 'page_home' },
    AGENT,
    { nowMs: NOW }
  );

  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(res.body.code, 'object_store_error');
  assert.equal(res.body.action, 'get');
  // The facts survive as FIELDS...
  assert.equal(res.body.store_status, 400);
  assert.equal(res.body.store_support_id, 'cb90450d-0000');
  // ...and the message says what the caller did and what it means, rather
  // than handing them a support id for someone else's support desk.
  const message = String(res.body.error);
  assert.match(message, /get of page page_home/);
  assert.match(message, /did not complete/);
  assert.doesNotMatch(message, /Netlify Blobs has generated an internal error/);
});

test('a store failure inside a verb that recurses into another one is still converted exactly once', async () => {
  const store = createMemoryStore();
  const failing = {
    ...store,
    async list() {
      throw new Error('Netlify Blobs has generated an internal error (500 status code, ID: deadbeef)');
    },
  };
  const res = await handleObjectVerb(
    failing as unknown as ObjectVerbStore,
    { action: 'list', object_type: 'page' },
    AGENT,
    { nowMs: NOW }
  );
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(res.body.store_status, 500);
});

test('a non-store exception still propagates — the conversion never hides a real bug', async () => {
  const store = createMemoryStore();
  const failing = {
    ...store,
    async get() {
      throw new TypeError('cannot read properties of undefined');
    },
  };
  await assert.rejects(
    () =>
      handleObjectVerb(
        failing as unknown as ObjectVerbStore,
        { action: 'get', object_type: 'page', object_id: 'page_home' },
        AGENT,
        { nowMs: NOW }
      ),
    /cannot read properties of undefined/
  );
});
