/**
 * D3-sharedref — the write-path half of the shared_ref denormalization fix.
 * `stampSharedRefSectionNames` (object-verbs.ts) is not exported (it's an
 * internal step of the `patch` verb), so this exercises it the same way
 * agent-learning-patch.test.ts exercises the rest of the patch pipeline: a
 * real `handleObjectVerb('patch', ...)` call against an in-memory store, with
 * `buildStoreValidationContext` wired so `resolveSharedSectionName` is the
 * SAME resolver a real write uses (object-validation-context.ts) — not a
 * hand-rolled stub.
 */
import '../../../../sites/drlurie/config/policy-bindings.js'; // registers site providers — handleObjectVerb needs them resolvable (migrate-site.test.ts's precedent)
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { handleObjectVerb, type ObjectVerbStore } from './object-verbs.js';
import { buildStoreValidationContext } from './object-validation-context.js';
import type { ObjectValidationContext } from './object-validate.js';
import { objectRecordKey } from './object-store-keys.js';
import type { ObjectRecord, Principal } from '../../schema/object-record-v1.js';

// ─── injected-store pattern (migrate-site.test.ts's createMemoryStore, reused
//     verbatim from agent-learning-patch.test.ts) ────────────────────────────

const makeStore = (seeds: ObjectRecord[]) => {
  const blobs = new Map<string, string>();
  for (const seed of seeds) blobs.set(objectRecordKey(seed.object_type, seed.object_id), JSON.stringify(seed));
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

const NOW_MS = Date.parse('2026-08-06T00:00:00.000Z');
const LOCK_TOKEN = 'lock-test-token';
const HUMAN: Principal = { kind: 'human', id: 'u1', email: 'editor@example.com' };

const pageBody = () => ({
  route: '/test-page',
  pageType: 'standard',
  title: 'Home',
  seo: { description: 'x' },
  sections: [{ id: 's_hero', type: 'hero', data: { heading: 'Hi', actions: [] } }],
});

const makePageRecord = (): ObjectRecord => ({
  object_id: 'page_test1',
  object_type: 'page',
  schema_version: 'page.v1',
  site: 'site_drlurie',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  status: 'active',
  body: pageBody(),
  publication: { published_time: null },
  history: [],
  version: 5,
  content_revision: 3,
  lock: {
    token: LOCK_TOKEN,
    owner_id: 'u1',
    owner_label: 'editor@example.com',
    acquired_at: '2026-08-06T00:00:00.000Z',
    expires_at: '2026-08-06T00:30:00.000Z',
  },
});

// A real shared 'section' object — the shared_ref target. Its wrapped
// instance is `prose` with an <h2> lead so objectDisplayName (the SAME
// derivation the admin object list uses) resolves a real name via
// firstHeadingText, not the id-derived fallback — proving this is the exact
// display-name.ts derivation, not a bespoke one.
const makeTargetSectionRecord = (): ObjectRecord => ({
  object_id: 'sec_winter_promo',
  object_type: 'section',
  schema_version: 'section.v1',
  site: 'site_drlurie',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  status: 'active',
  body: {
    section: {
      id: 's_winter_promo',
      type: 'prose',
      data: { body: '<h2>Winter Skincare Guide</h2><p>Stock up before the cold hits.</p>' },
    },
  },
  publication: { published_time: null },
  history: [],
  version: 1,
  content_revision: 1,
});

describe('D3-sharedref write path — stampSharedRefSectionNames (via handleObjectVerb patch)', () => {
  it('resolves and stamps the target section’s display name onto a NEW shared_ref (upsert_section)', async () => {
    const page = makePageRecord();
    const target = makeTargetSectionRecord();
    const store = makeStore([page, target]);
    const context = await buildStoreValidationContext(store as unknown as ObjectVerbStore, {
      selfObjectId: page.object_id,
      selfObjectType: 'page',
    });

    const result = await handleObjectVerb(
      store as unknown as ObjectVerbStore,
      {
        action: 'patch',
        object_type: 'page',
        object_id: page.object_id,
        lock_token: LOCK_TOKEN,
        expected_record_version: page.version,
        ops: [
          {
            op: 'upsert_section',
            section: { id: 's_shared1', type: 'shared_ref', data: { section: target.object_id } },
          },
        ],
      },
      HUMAN,
      { nowMs: NOW_MS, validationContext: context }
    );

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    const stored = JSON.parse(store.blobs.get(objectRecordKey('page', page.object_id))!);
    const shared = stored.body.sections.find((s: { id: string }) => s.id === 's_shared1');
    assert.ok(shared, 'the shared_ref section was written');
    assert.strictEqual(shared.type, 'shared_ref');
    assert.strictEqual(shared.data.section, target.object_id);
    assert.strictEqual(shared.data.sectionName, 'Winter Skincare Guide');
  });

  it('re-stamps an EXISTING shared_ref when its target changes via update_section_data', async () => {
    const page = makePageRecord();
    // Seed the page already carrying a shared_ref pointed at a first target.
    (page.body as { sections: unknown[] }).sections.push({
      id: 's_shared1',
      type: 'shared_ref',
      data: { section: 'sec_old_target', sectionName: 'Old Target Name' },
    });
    const target = makeTargetSectionRecord();
    const store = makeStore([page, target]);
    const context = await buildStoreValidationContext(store as unknown as ObjectVerbStore, {
      selfObjectId: page.object_id,
      selfObjectType: 'page',
    });

    const result = await handleObjectVerb(
      store as unknown as ObjectVerbStore,
      {
        action: 'patch',
        object_type: 'page',
        object_id: page.object_id,
        lock_token: LOCK_TOKEN,
        expected_record_version: page.version,
        ops: [{ op: 'update_section_data', section_id: 's_shared1', fields: { section: target.object_id } }],
      },
      HUMAN,
      { nowMs: NOW_MS, validationContext: context }
    );

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    const stored = JSON.parse(store.blobs.get(objectRecordKey('page', page.object_id))!);
    const shared = stored.body.sections.find((s: { id: string }) => s.id === 's_shared1');
    assert.strictEqual(shared.data.section, target.object_id);
    assert.strictEqual(shared.data.sectionName, 'Winter Skincare Guide', 'stale name from the old target is replaced');
  });

  it('leaves sectionName UNSET (not a throw, not a null, not a garbage value) when the target does not resolve — a dangling ref', async () => {
    const page = makePageRecord();
    // No 'section' object seeded at all for 'sec_does_not_exist' — a target
    // deleted since, or a typo'd id an agent supplied. `resolveSharedSectionName`
    // is wired (so we're exercising the SAME "can't answer → undefined"
    // contract buildStoreValidationContext's version implements — a records
    // miss) in isolation from reference-integrity enforcement (a separate,
    // pre-existing hard-block check in object-validate.ts's requireObject —
    // not this step's concern, and not what's under test here: this test is
    // specifically about the STAMP not throwing/blocking on its own). Note
    // it can't stamp `null` even if it wanted to: object-patch-apply.ts's
    // engine refuses ANY null inside a whole-value upsert_section payload
    // (null is reserved as its fields-unset marker) — see object-verbs.ts's
    // stampSharedRefSectionNames comment.
    const store = makeStore([page]);
    const context: ObjectValidationContext = {
      resolveSharedSectionName: () => undefined, // "cannot resolve a name for this id"
    };

    const result = await handleObjectVerb(
      store as unknown as ObjectVerbStore,
      {
        action: 'patch',
        object_type: 'page',
        object_id: page.object_id,
        lock_token: LOCK_TOKEN,
        expected_record_version: page.version,
        ops: [
          {
            op: 'upsert_section',
            section: { id: 's_shared1', type: 'shared_ref', data: { section: 'sec_does_not_exist' } },
          },
        ],
      },
      HUMAN,
      { nowMs: NOW_MS, validationContext: context }
    );

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    const stored = JSON.parse(store.blobs.get(objectRecordKey('page', page.object_id))!);
    const shared = stored.body.sections.find((s: { id: string }) => s.id === 's_shared1');
    assert.strictEqual(shared.data.section, 'sec_does_not_exist');
    assert.strictEqual('sectionName' in shared.data, false);
  });

  it('an update_section_data that fails to resolve a NEW target leaves a previously-stamped sectionName untouched rather than blanking it', async () => {
    const page = makePageRecord();
    (page.body as { sections: unknown[] }).sections.push({
      id: 's_shared1',
      type: 'shared_ref',
      data: { section: 'sec_old_target', sectionName: 'Old Target Name' },
    });
    const store = makeStore([page]); // 'sec_new_target' resolves to nothing
    const context: ObjectValidationContext = { resolveSharedSectionName: () => undefined };

    const result = await handleObjectVerb(
      store as unknown as ObjectVerbStore,
      {
        action: 'patch',
        object_type: 'page',
        object_id: page.object_id,
        lock_token: LOCK_TOKEN,
        expected_record_version: page.version,
        ops: [{ op: 'update_section_data', section_id: 's_shared1', fields: { section: 'sec_new_target' } }],
      },
      HUMAN,
      { nowMs: NOW_MS, validationContext: context }
    );

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    const stored = JSON.parse(store.blobs.get(objectRecordKey('page', page.object_id))!);
    const shared = stored.body.sections.find((s: { id: string }) => s.id === 's_shared1');
    assert.strictEqual(shared.data.section, 'sec_new_target');
    assert.strictEqual(
      shared.data.sectionName,
      'Old Target Name',
      'the stale name from the OLD target survives an unresolved re-stamp attempt, rather than being deleted'
    );
  });

  it('a REAL dangling ref (reference-integrity resolver present, target genuinely absent from the store) is refused by validateObject as before — this change does not weaken that separate, pre-existing gate', async () => {
    const page = makePageRecord();
    const store = makeStore([page]); // no 'sec_does_not_exist' record anywhere
    const context = await buildStoreValidationContext(store as unknown as ObjectVerbStore, {
      selfObjectId: page.object_id,
      selfObjectType: 'page',
    });

    const result = await handleObjectVerb(
      store as unknown as ObjectVerbStore,
      {
        action: 'patch',
        object_type: 'page',
        object_id: page.object_id,
        lock_token: LOCK_TOKEN,
        expected_record_version: page.version,
        ops: [
          {
            op: 'upsert_section',
            section: { id: 's_shared1', type: 'shared_ref', data: { section: 'sec_does_not_exist' } },
          },
        ],
      },
      HUMAN,
      { nowMs: NOW_MS, validationContext: context }
    );

    assert.strictEqual(result.status, 422, JSON.stringify(result.body));
    // Refused before persisting — the store still holds only the original page.
    assert.strictEqual(JSON.parse(store.blobs.get(objectRecordKey('page', page.object_id))!).version, page.version);
  });

  it('leaves sectionName unset rather than throwing when no validationContext is wired at all (e.g. a bare test harness)', async () => {
    const page = makePageRecord();
    const target = makeTargetSectionRecord();
    const store = makeStore([page, target]);

    const result = await handleObjectVerb(
      store as unknown as ObjectVerbStore,
      {
        action: 'patch',
        object_type: 'page',
        object_id: page.object_id,
        lock_token: LOCK_TOKEN,
        expected_record_version: page.version,
        ops: [
          {
            op: 'upsert_section',
            section: { id: 's_shared1', type: 'shared_ref', data: { section: target.object_id } },
          },
        ],
      },
      HUMAN,
      { nowMs: NOW_MS } // no validationContext
    );

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    const stored = JSON.parse(store.blobs.get(objectRecordKey('page', page.object_id))!);
    const shared = stored.body.sections.find((s: { id: string }) => s.id === 's_shared1');
    assert.strictEqual('sectionName' in shared.data, false);
  });

  it('leaves non-shared_ref sections completely untouched (no sectionName appears on them)', async () => {
    const page = makePageRecord();
    const target = makeTargetSectionRecord();
    const store = makeStore([page, target]);
    const context = await buildStoreValidationContext(store as unknown as ObjectVerbStore, {
      selfObjectId: page.object_id,
      selfObjectType: 'page',
    });

    const result = await handleObjectVerb(
      store as unknown as ObjectVerbStore,
      {
        action: 'patch',
        object_type: 'page',
        object_id: page.object_id,
        lock_token: LOCK_TOKEN,
        expected_record_version: page.version,
        ops: [{ op: 'update_section_data', section_id: 's_hero', fields: { heading: 'Updated heading' } }],
      },
      HUMAN,
      { nowMs: NOW_MS, validationContext: context }
    );

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    const stored = JSON.parse(store.blobs.get(objectRecordKey('page', page.object_id))!);
    const hero = stored.body.sections.find((s: { id: string }) => s.id === 's_hero');
    assert.strictEqual(hero.data.heading, 'Updated heading');
    assert.strictEqual('sectionName' in hero.data, false);
  });
});
