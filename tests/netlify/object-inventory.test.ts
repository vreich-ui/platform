/**
 * Object inventory (Part 2): the read-only `inventory` verb and its pure
 * derivation helpers. Everything is computed from what the existing verbs
 * already persist — these tests pin the derivation rules:
 *
 *   - unpublished_changes: never published → true; published with the
 *     receipt's content_revision equal to the record's → false; record
 *     revision ahead of the receipt → true; receipt without a numeric
 *     revision → true (conservative).
 *   - lock: held only while the lease is active (an expired lock reports
 *     free), holder identified WITHOUT the lock token.
 *   - review_state 'none' distinguishes never-reviewed from an open review.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contentSummaryFromBody,
  inventoryDetailFromRecord,
  inventoryRowFromRecord,
  matchesInventoryFilters,
  recipeSummaryFromBody,
} from '../../packages/core/server/lib/object-inventory.js';
import {
  handleObjectVerb,
  type ObjectVerbRequest,
  type ObjectVerbStore,
} from '../../packages/core/server/lib/object-verbs.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import type { ApprovalPolicy } from '../../packages/core/lib/approval-policy.js';
import type { ObjectRecord, Principal } from '../../packages/core/schema/object-record-v1.js';

const NOW = Date.parse('2026-07-06T12:00:00.000Z');
const AGENT: Principal = { kind: 'agent', agent_name: 'inventory-agent', auth: 'publish_key' };

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

const call = (
  store: Store,
  request: ObjectVerbRequest,
  principal: Principal = AGENT,
  nowMs = NOW,
  approvalPolicy?: ApprovalPolicy
) => handleObjectVerb(store as unknown as ObjectVerbStore, request, principal, { nowMs, approvalPolicy });

const validPageBody = (title = 'Dr. Lurié') => ({
  route: '/',
  pageType: 'home',
  title,
  seo: { description: 'Science-first skincare.' },
  // A 'home' PageType page must carry this (structure_home_footer,
  // netlify/lib/object-validate.ts) or a further patch on an already-published
  // record is rejected.
  navigationOverrides: { footer: 'nav_footer_home' },
  sections: [{ id: 's_hero', type: 'hero', data: { heading: 'Hi', actions: [] } }],
});

const emptyTaxonomyBody = () => ({ kinds: { category: { terms: [] }, tag: { terms: [] } } });

// The full receipt shape buildReceipt writes (pinned by publishReceiptSchema).
const fullReceipt = (contentRevision: number) => ({
  kind: 'object_export_commit' as const,
  branch: 'main',
  commit_sha: 'abc123',
  tree_sha: 'def456',
  no_op: false,
  attempts: 1,
  files: ['sites/drlurie/data/site/pages/page_sample.json'],
  content_revision: contentRevision,
  exported_at: '2026-07-05T00:00:00.000Z',
});

const baseRecord = (overrides: Partial<ObjectRecord> = {}): ObjectRecord => ({
  object_id: 'page_sample',
  object_type: 'page',
  schema_version: 'page.v1',
  site: 'site_drlurie',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  status: 'active',
  body: {},
  publication: { published_time: null },
  history: [],
  version: 3,
  content_revision: 2,
  ...overrides,
});

// ═══ derivation rules (pure) ══════════════════════════════════════════════════

test('display_name (T9.2 derivation) and updated_at are mirrored onto the row', () => {
  const untitled = inventoryRowFromRecord(baseRecord(), NOW);
  assert.equal(untitled.display_name, 'Untitled page');
  assert.equal(untitled.updated_at, '2026-07-01T00:00:00.000Z');

  const named = inventoryRowFromRecord(baseRecord({ body: validPageBody('Start Here') as ObjectRecord['body'] }), NOW);
  assert.equal(named.display_name, 'Start Here');
});

test('a never-published draft reports unpublished_changes with no receipt revision', () => {
  const row = inventoryRowFromRecord(baseRecord(), NOW);
  assert.equal(row.unpublished_changes, true);
  assert.equal(row.published_time, null);
  assert.equal(row.published_content_revision, null);
  assert.equal(row.review_state, 'none');
  assert.deepEqual(row.lock, { held: false });
});

test('requires_approval derives from the approval policy; content_item is never gated by the generic surface', () => {
  const gateNavigation: ApprovalPolicy = { master: 'all-autonomous', overrides: { navigation: 'require-approval' } };
  // Committed dev default (all-autonomous) applies when no policy is passed.
  assert.equal(inventoryRowFromRecord(baseRecord({ object_type: 'page' }), NOW).requires_approval, false);
  assert.equal(inventoryRowFromRecord(baseRecord({ object_type: 'navigation' }), NOW).requires_approval, false);
  // An injected policy flows through.
  assert.equal(
    inventoryRowFromRecord(baseRecord({ object_type: 'navigation' }), NOW, gateNavigation).requires_approval,
    true
  );
  assert.equal(
    inventoryRowFromRecord(baseRecord({ object_type: 'page' }), NOW, gateNavigation).requires_approval,
    false
  );
  // content_item follows the policy like every governed type (W7.3); the
  // committed dev default keeps it autonomous (Tier 1, OQ-W7-4).
  const allRequire: ApprovalPolicy = { master: 'all-require-approval', overrides: {} };
  assert.equal(
    inventoryRowFromRecord(baseRecord({ object_type: 'content_item' }), NOW, allRequire).requires_approval,
    true
  );
  assert.equal(inventoryRowFromRecord(baseRecord({ object_type: 'content_item' }), NOW).requires_approval, false);
});

test('a published record with the receipt at the current revision reports no pending changes', () => {
  const row = inventoryRowFromRecord(
    baseRecord({
      publication: {
        published_time: '2026-07-05T00:00:00.000Z',
        publish_receipt: fullReceipt(2),
      },
    }),
    NOW
  );
  assert.equal(row.unpublished_changes, false);
  assert.equal(row.published_content_revision, 2);
});

test('a record edited after its last publish reports pending changes', () => {
  const row = inventoryRowFromRecord(
    baseRecord({
      content_revision: 5,
      publication: {
        published_time: '2026-07-05T00:00:00.000Z',
        publish_receipt: fullReceipt(2),
      },
    }),
    NOW
  );
  assert.equal(row.unpublished_changes, true);
  assert.equal(row.published_content_revision, 2);
});

test('a published record whose receipt lacks a numeric revision reports pending changes (conservative)', () => {
  // Deliberately violates publishReceiptSchema: stored blobs are not
  // schema-validated on read, so the inventory must stay defensive against
  // hand-written or legacy receipts.
  const legacyPublication = {
    published_time: '2026-07-05T00:00:00.000Z',
    publish_receipt: { kind: 'legacy' },
  } as unknown as ObjectRecord['publication'];
  const row = inventoryRowFromRecord(baseRecord({ publication: legacyPublication }), NOW);
  assert.equal(row.unpublished_changes, true);
  assert.equal(row.published_content_revision, null);
});

test('lock state: active lease → held with holder and expiry but never the token; expired lease → free', () => {
  const lock = {
    token: 'secret-token',
    owner_id: 'editor-1',
    owner_label: 'editor@example.com',
    acquired_at: '2026-07-06T11:50:00.000Z',
    expires_at: '2026-07-06T12:05:00.000Z',
  };
  const held = inventoryRowFromRecord(baseRecord({ lock }), NOW);
  assert.deepEqual(held.lock, {
    held: true,
    owner_id: 'editor-1',
    owner_label: 'editor@example.com',
    acquired_at: '2026-07-06T11:50:00.000Z',
    expires_at: '2026-07-06T12:05:00.000Z',
  });
  assert.ok(!JSON.stringify(held.lock).includes('secret-token'), 'the lock token must never appear');

  const expired = inventoryRowFromRecord(
    baseRecord({ lock: { ...lock, expires_at: '2026-07-06T11:59:59.000Z' } }),
    NOW
  );
  assert.deepEqual(expired.lock, { held: false });
});

test('matchesInventoryFilters composes requires_approval, review_state, pending_changes, and status', () => {
  const row = inventoryRowFromRecord(baseRecord(), NOW); // page (autonomous default), review none, pending true, active
  assert.equal(matchesInventoryFilters(row, {}), true);
  assert.equal(
    matchesInventoryFilters(row, { requires_approval: false, review_state: 'none', pending_changes: true }),
    true
  );
  assert.equal(matchesInventoryFilters(row, { requires_approval: true }), false);
  assert.equal(matchesInventoryFilters(row, { review_state: 'open' }), false);
  assert.equal(matchesInventoryFilters(row, { pending_changes: false }), false);
  assert.equal(matchesInventoryFilters(row, { status: 'archived' }), false);
});

test('the detail view adds envelope metadata without leaking the lock token', () => {
  const detail = inventoryDetailFromRecord(
    baseRecord({
      review: { state: 'approved', decisions: [] },
      history: [
        { at: '2026-07-01T00:00:00.000Z', action: 'create', actor: AGENT },
        { at: '2026-07-02T00:00:00.000Z', action: 'patch', actor: AGENT },
      ] as unknown as ObjectRecord['history'],
    }),
    NOW
  );
  assert.equal(detail.site, 'site_drlurie');
  assert.equal(detail.schema_version, 'page.v1');
  assert.equal(detail.history_length, 2);
  assert.equal(detail.review?.state, 'approved');
  assert.equal(detail.publish_receipt, null);
});

// ═══ the inventory verb over the real store paths ═════════════════════════════

test('inventory sweeps every type when object_type is omitted, sorted and filterable', async () => {
  const store = createMemoryStore();
  const pageA = await call(store, {
    action: 'create',
    object_type: 'page',
    site: 'site_drlurie',
    body: validPageBody('A'),
  });
  assert.equal(pageA.status, 200, JSON.stringify(pageA.body));
  const taxonomy = await call(store, {
    action: 'create',
    object_type: 'taxonomy',
    site: 'site_drlurie',
    body: emptyTaxonomyBody(),
  });
  assert.equal(taxonomy.status, 200, JSON.stringify(taxonomy.body));

  const sweep = await call(store, { action: 'inventory' });
  assert.equal(sweep.status, 200);
  const rows = sweep.body.objects as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  // Canonical type order: page before taxonomy.
  assert.deepEqual(
    rows.map((row) => row.object_type),
    ['page', 'taxonomy']
  );
  assert.ok(typeof sweep.body.generated_at === 'string');

  // The requires_approval filter reflects the injected policy: gate taxonomy
  // only, then ask for gated rows.
  const gateTaxonomy: ApprovalPolicy = { master: 'all-autonomous', overrides: { taxonomy: 'require-approval' } };
  const gated = await call(store, { action: 'inventory', requires_approval: true }, AGENT, NOW, gateTaxonomy);
  assert.deepEqual(
    (gated.body.objects as Array<Record<string, unknown>>).map((row) => row.object_type),
    ['taxonomy']
  );
  const free = await call(store, { action: 'inventory', requires_approval: false }, AGENT, NOW, gateTaxonomy);
  assert.deepEqual(
    (free.body.objects as Array<Record<string, unknown>>).map((row) => row.object_type),
    ['page']
  );

  const pending = await call(store, { action: 'inventory', pending_changes: true });
  assert.equal((pending.body.objects as unknown[]).length, 2, 'nothing is published yet');
  const published = await call(store, { action: 'inventory', pending_changes: false });
  assert.equal((published.body.objects as unknown[]).length, 0);
});

test('inventory reflects live lock and review state through the real verbs', async () => {
  const store = createMemoryStore();
  const created = await call(store, {
    action: 'create',
    object_type: 'page',
    site: 'site_drlurie',
    body: validPageBody(),
  });
  const objectId = (created.body.record as ObjectRecord).object_id;

  const checkout = await call(store, { action: 'checkout', object_type: 'page', object_id: objectId });
  assert.equal(checkout.status, 200);
  const lockToken = checkout.body.lockToken as string;

  const locked = await call(store, { action: 'inventory', object_type: 'page' });
  const lockedRow = (locked.body.objects as Array<Record<string, unknown>>)[0];
  assert.deepEqual(
    {
      held: (lockedRow.lock as Record<string, unknown>).held,
      owner: (lockedRow.lock as Record<string, unknown>).owner_id,
    },
    { held: true, owner: 'inventory-agent' }
  );
  assert.ok(!JSON.stringify(lockedRow).includes(lockToken), 'the lock token must never appear in inventory output');

  const submitted = await call(store, {
    action: 'submit_review',
    object_type: 'page',
    object_id: objectId,
    lock_token: lockToken,
    requested_publish_action: { published_time: 'immediate' },
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  const open = await call(store, { action: 'inventory', review_state: 'open' });
  assert.deepEqual(
    (open.body.objects as Array<Record<string, unknown>>).map((row) => row.object_id),
    [objectId]
  );

  await call(store, { action: 'checkin', object_type: 'page', object_id: objectId, lock_token: lockToken });
  const released = await call(store, { action: 'inventory', object_type: 'page' });
  assert.deepEqual((released.body.objects as Array<Record<string, unknown>>)[0].lock, { held: false });
});

test('inventory pending_changes flips as a record is published and then edited past its receipt', async () => {
  const store = createMemoryStore();
  const created = await call(store, {
    action: 'create',
    object_type: 'page',
    site: 'site_drlurie',
    body: validPageBody(),
  });
  const record = created.body.record as ObjectRecord;

  // Simulate T1.3's post-commit stamp: published_time + receipt at the
  // current content_revision (the publish pipeline itself is covered by
  // object-publish.test.ts; the inventory only reads the stamp).
  const key = objectRecordKey('page', record.object_id);
  const stored = JSON.parse(store.blobs.get(key)!) as ObjectRecord;
  stored.publication = {
    published_time: '2026-07-06T00:00:00.000Z',
    publish_receipt: fullReceipt(stored.content_revision),
  };
  store.blobs.set(key, JSON.stringify(stored));

  const clean = await call(store, { action: 'inventory', object_type: 'page' });
  assert.equal((clean.body.objects as Array<Record<string, unknown>>)[0].unpublished_changes, false);

  const checkout = await call(store, { action: 'checkout', object_type: 'page', object_id: record.object_id });
  const patched = await call(store, {
    action: 'patch',
    object_type: 'page',
    object_id: record.object_id,
    lock_token: checkout.body.lockToken as string,
    expected_record_version: checkout.body.record_version as number,
    ops: [{ op: 'set_page_meta', fields: { title: 'Dr. Lurié — updated' } }],
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  const dirty = await call(store, { action: 'inventory', object_type: 'page', pending_changes: true });
  assert.deepEqual(
    (dirty.body.objects as Array<Record<string, unknown>>).map((row) => row.object_id),
    [record.object_id]
  );
});

test('inventory single-object detail requires the type, 404s on a missing id, and returns envelope detail', async () => {
  const store = createMemoryStore();
  const created = await call(store, {
    action: 'create',
    object_type: 'page',
    site: 'site_drlurie',
    body: validPageBody(),
  });
  const objectId = (created.body.record as ObjectRecord).object_id;

  const missingType = await call(store, { action: 'inventory', object_id: objectId });
  assert.equal(missingType.status, 400);

  const missing = await call(store, { action: 'inventory', object_type: 'page', object_id: 'page_ghost' });
  assert.equal(missing.status, 404);

  const detail = await call(store, { action: 'inventory', object_type: 'page', object_id: objectId });
  assert.equal(detail.status, 200);
  const object = detail.body.object as Record<string, unknown>;
  assert.equal(object.object_id, objectId);
  assert.equal(object.requires_approval, false, 'dev default: autonomous');
  assert.equal(object.site, 'site_drlurie');
  assert.equal(object.history_length, 1);
  assert.equal(object.unpublished_changes, true);
});

// ═══ recipe summaries — the W8.3b reuse-first index ═══════════════════════════

test('recipe rows carry a snake_case summary with per-type kind details; other types carry none', () => {
  const template = inventoryRowFromRecord(
    baseRecord({
      object_id: 'tpl_probe',
      object_type: 'template',
      body: {
        name: 'Interior page',
        description: 'The interior shape.',
        whenToUse: 'Default for content pages.',
        scope: 'evergreen',
        appliesTo: ['standard'],
        slots: [{ slotId: 'slot_a' }, { slotId: 'slot_b' }],
      },
    }),
    NOW
  );
  assert.deepEqual(template.recipe, {
    name: 'Interior page',
    scope: 'evergreen',
    description: 'The interior shape.',
    when_to_use: 'Default for content pages.',
    applies_to: ['standard'],
    slot_count: 2,
  });

  const stamp = inventoryRowFromRecord(
    baseRecord({
      object_id: 'stpl_probe',
      object_type: 'section_template',
      body: {
        name: 'Landing hero',
        description: 'Opening hero.',
        whenToUse: 'First section of landing pages.',
        scope: 'evergreen',
        blueprint: { id: 's_bp', type: 'hero', data: {} },
      },
    }),
    NOW
  );
  assert.equal(stamp.recipe?.blueprint_type, 'hero');

  const page = inventoryRowFromRecord(baseRecord(), NOW);
  assert.equal(page.recipe, undefined, 'non-recipe rows carry no summary');
});

test('recipe summaries are DEFENSIVE: malformed or incomplete bodies yield nulls, never a throw', () => {
  const malformed = inventoryRowFromRecord(
    baseRecord({ object_id: 'thm_broken', object_type: 'theme', body: 42 }),
    NOW
  );
  assert.deepEqual(malformed.recipe, { name: null, scope: null, description: null, when_to_use: null });

  const partial = recipeSummaryFromBody('section_template', { name: 'X', scope: 'weird', blueprint: 'nope' });
  assert.deepEqual(partial, {
    name: 'X',
    scope: null,
    description: null,
    when_to_use: null,
    blueprint_type: null,
  });
});

test('the detail view inherits the recipe summary', async () => {
  const store = createMemoryStore();
  await store.setJSON(
    objectRecordKey('theme', 'thm_probe'),
    baseRecord({
      object_id: 'thm_probe',
      object_type: 'theme',
      schema_version: 'theme.v1',
      body: {
        name: 'Default',
        description: 'The palette.',
        whenToUse: 'Restore defaults.',
        scope: 'evergreen',
        tokens: {},
      },
    })
  );
  const res = await call(store, { action: 'inventory', object_type: 'theme', object_id: 'thm_probe' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const detail = res.body.object as { recipe?: { name: string | null } };
  assert.equal(detail.recipe?.name, 'Default');
});

// ═══ W4.1: the variants index on a content_item row ═══════════════════════════

const articleBody = (overrides: Record<string, unknown> = {}) => ({
  title: 'A study of niacinamide',
  slug: 'a-study-of-niacinamide',
  ...overrides,
});

test('a content_item row carries slug and parentage so a family is derivable from the LISTING', () => {
  const parent = inventoryRowFromRecord(
    baseRecord({
      object_id: 'req_parent',
      object_type: 'content_item',
      schema_version: 'content_item.v1',
      body: articleBody() as ObjectRecord['body'],
    }),
    NOW
  );
  assert.deepEqual(parent.content, { slug: 'a-study-of-niacinamide', parent_content_id: null });

  const clone = inventoryRowFromRecord(
    baseRecord({
      object_id: 'req_clone',
      object_type: 'content_item',
      schema_version: 'content_item.v1',
      body: articleBody({
        slug: 'a-study-of-niacinamide-b',
        lineage: { parent_content_id: 'req_parent', source_version_id: 'v3' },
      }) as ObjectRecord['body'],
    }),
    NOW
  );
  assert.equal(clone.content?.parent_content_id, 'req_parent', 'the ONLY variant → parent link, now on the row');
  assert.equal(clone.content?.slug, 'a-study-of-niacinamide-b');

  const page = inventoryRowFromRecord(baseRecord(), NOW);
  assert.equal(page.content, undefined, 'non-article rows carry no summary — the projection grows for one type');
});

test('the scores digest keeps the LATEST entry per (framework, dimension) and drops what no row could render', () => {
  const summary = contentSummaryFromBody(
    'content_item',
    articleBody({
      scores: [
        { scored_by: 'agent:a', at: '2026-08-01T00:00:00.000Z', framework: 'f1', dimension: 'clarity', score: 3 },
        // Newer judgement of the same line — scores are append-only, so this wins.
        {
          scored_by: 'agent:b',
          at: '2026-08-09T00:00:00.000Z',
          framework: 'f1',
          dimension: 'clarity',
          score: 4,
          rationale: 'tighter lede',
        },
        { scored_by: 'metric:ctr', at: '2026-08-05T00:00:00.000Z', framework: 'f1', dimension: 'ctr', score: 0.1 },
        // Unrenderable: no dimension, and a non-numeric score.
        { scored_by: 'agent:a', at: '2026-08-02T00:00:00.000Z', framework: 'f1', score: 2 },
        { scored_by: 'agent:a', at: '2026-08-02T00:00:00.000Z', framework: 'f1', dimension: 'depth', score: 'high' },
        'not an entry at all',
      ],
    })
  );
  assert.deepEqual(summary?.scores, [
    {
      scored_by: 'agent:b',
      at: '2026-08-09T00:00:00.000Z',
      framework: 'f1',
      dimension: 'clarity',
      score: 4,
      rationale: 'tighter lede',
    },
    { scored_by: 'metric:ctr', at: '2026-08-05T00:00:00.000Z', framework: 'f1', dimension: 'ctr', score: 0.1 },
  ]);

  // Most articles are unjudged, and the key is absent rather than empty so
  // every other inventory consumer pays nothing for this.
  assert.equal(contentSummaryFromBody('content_item', articleBody())?.scores, undefined);
  assert.equal(contentSummaryFromBody('content_item', articleBody({ scores: 'nope' }))?.scores, undefined);
});

test('content summaries are DEFENSIVE: a malformed article body yields nulls, never a throw', () => {
  assert.deepEqual(contentSummaryFromBody('content_item', 42), { slug: null, parent_content_id: null });
  assert.deepEqual(contentSummaryFromBody('content_item', { slug: '  ', lineage: 'nope' }), {
    slug: null,
    parent_content_id: null,
  });
  assert.equal(contentSummaryFromBody('page', articleBody()), undefined);
});
