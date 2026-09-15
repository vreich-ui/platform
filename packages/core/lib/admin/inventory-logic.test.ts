import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  allowedActions,
  bulkActionOffers,
  bulkActionsFor,
  EMPTY_INVENTORY_FACETS,
  facetCounts,
  filterHitsByFacets,
  hasActiveFacets,
  hitHasTag,
  inventoryTagKey,
  matchesInventoryFacets,
  previewSummary,
  type InventoryCollection,
  type InventoryFacetSelection,
  type InventoryHit,
  type Role,
} from './inventory-logic.js';

const ROLES = {
  owner: ['owner', 'admin', 'publisher'] as const,
  admin: ['admin'] as const,
  editor: ['editor'] as const,
} satisfies Record<string, readonly Role[]>;

const hit = (over: Partial<InventoryHit> & { collection: InventoryCollection }): InventoryHit => ({
  id: 'x1',
  label: 'X',
  kind: 'thing',
  status: 'active',
  updatedAt: '2026-09-01T00:00:00.000Z',
  sizeBytes: null,
  previewRef: null,
  thumbnailRef: null,
  refs: [],
  tags: [],
  ...over,
});

describe('facetCounts', () => {
  it('counts hits per collection, kind and status independently', () => {
    const hits: InventoryHit[] = [
      hit({ collection: 'objects', kind: 'page', status: 'active' }),
      hit({ collection: 'objects', kind: 'page', status: 'archived' }),
      hit({ collection: 'artifacts', kind: 'image', status: 'active' }),
      hit({ collection: 'stores', kind: 'workflows', status: 'running' }),
    ];
    assert.deepStrictEqual(facetCounts(hits), {
      collection: { objects: 2, artifacts: 1, stores: 1 },
      kind: { page: 2, image: 1, workflows: 1 },
      status: { active: 2, archived: 1, running: 1 },
      tag: {},
      tagLabels: {},
    });
  });

  it('returns empty maps for an empty hit list', () => {
    assert.deepStrictEqual(facetCounts([]), {
      collection: {},
      kind: {},
      status: {},
      tag: {},
      tagLabels: {},
    });
  });
});

describe('facetCounts — the tag facet', () => {
  it('counts nothing when no hit carries a tag', () => {
    const counts = facetCounts([hit({ collection: 'objects' }), hit({ collection: 'stores' })]);
    assert.deepStrictEqual(counts.tag, {});
    assert.deepStrictEqual(counts.tagLabels, {});
  });

  it('counts a hit once under each of its several tags', () => {
    const counts = facetCounts([
      hit({ collection: 'artifacts', id: 'a', tags: ['julia', 'hero', 'draft'] }),
      hit({ collection: 'artifacts', id: 'b', tags: ['julia'] }),
      hit({ collection: 'artifacts', id: 'c', tags: [] }),
    ]);
    assert.deepStrictEqual(counts.tag, { julia: 2, hero: 1, draft: 1 });
  });

  it('collapses tags that differ only by case, the way the by-tag pointer key already does', () => {
    const counts = facetCounts([
      hit({ collection: 'artifacts', id: 'a', tags: ['Julia'] }),
      hit({ collection: 'artifacts', id: 'b', tags: ['julia'] }),
      hit({ collection: 'artifacts', id: 'c', tags: ['JULIA'] }),
    ]);
    assert.deepStrictEqual(counts.tag, { julia: 3 });
    // Label is the code-unit-smallest spelling seen, so it does not change as
    // later pages load rows spelling it differently.
    assert.deepStrictEqual(counts.tagLabels, { julia: 'JULIA' });
  });

  it('counts one ROW once even when it carries two case-variants of one tag', () => {
    const counts = facetCounts([hit({ collection: 'artifacts', tags: ['Julia', 'julia'] })]);
    assert.deepStrictEqual(counts.tag, { julia: 1 });
  });

  it('ignores blank and whitespace-only tags, and trims the label it shows', () => {
    const counts = facetCounts([hit({ collection: 'artifacts', tags: ['  ', '', ' Julia '] })]);
    assert.deepStrictEqual(counts.tag, { julia: 1 });
    assert.deepStrictEqual(counts.tagLabels, { julia: 'Julia' });
  });
});

describe('inventoryTagKey / hitHasTag', () => {
  it('folds case and surrounding whitespace on both sides', () => {
    assert.strictEqual(inventoryTagKey('  Julia '), 'julia');
    const tagged = hit({ collection: 'artifacts', tags: ['Julia'] });
    assert.strictEqual(hitHasTag(tagged, 'julia'), true);
    assert.strictEqual(hitHasTag(tagged, ' JULIA '), true);
    assert.strictEqual(hitHasTag(tagged, 'juli'), false, 'a tag filter is exact, not a substring search');
  });

  it('is false for a hit with no tags, and for an empty needle', () => {
    assert.strictEqual(hitHasTag(hit({ collection: 'objects' }), 'julia'), false);
    assert.strictEqual(hitHasTag(hit({ collection: 'artifacts', tags: ['julia'] }), '   '), false);
  });
});

describe('matchesInventoryFacets / filterHitsByFacets', () => {
  const facets = (over: Partial<InventoryFacetSelection> = {}): InventoryFacetSelection => ({
    ...EMPTY_INVENTORY_FACETS,
    ...over,
  });

  const rows: InventoryHit[] = [
    hit({ collection: 'artifacts', id: 'a', kind: 'image', status: 'active', tags: ['Julia'] }),
    hit({ collection: 'artifacts', id: 'b', kind: 'image', status: 'deleted', tags: ['julia'] }),
    hit({ collection: 'artifacts', id: 'c', kind: 'pdf', status: 'active', tags: ['julia', 'hero'] }),
    hit({ collection: 'artifacts', id: 'd', kind: 'image', status: 'active', tags: [] }),
    hit({ collection: 'objects', id: 'e', kind: 'page', status: 'active' }),
  ];

  it('an empty selection filters nothing out', () => {
    assert.deepStrictEqual(
      filterHitsByFacets(rows, EMPTY_INVENTORY_FACETS).map((row) => row.id),
      ['a', 'b', 'c', 'd', 'e']
    );
    assert.strictEqual(hasActiveFacets(EMPTY_INVENTORY_FACETS), false);
  });

  it('the tag facet alone keeps every row carrying that tag, whatever its casing', () => {
    assert.deepStrictEqual(
      filterHitsByFacets(rows, facets({ tag: 'julia' })).map((row) => row.id),
      ['a', 'b', 'c']
    );
    assert.strictEqual(hasActiveFacets(facets({ tag: 'julia' })), true);
  });

  it('AND-combines with the other three facets', () => {
    assert.deepStrictEqual(
      filterHitsByFacets(rows, facets({ tag: 'julia', kind: 'image' })).map((row) => row.id),
      ['a', 'b']
    );
    assert.deepStrictEqual(
      filterHitsByFacets(rows, facets({ tag: 'julia', kind: 'image', status: 'active' })).map((row) => row.id),
      ['a']
    );
    assert.deepStrictEqual(
      filterHitsByFacets(rows, facets({ tag: 'julia', collection: 'artifacts', status: 'active' })).map(
        (row) => row.id
      ),
      ['a', 'c']
    );
  });

  it('drops untaggable rows the moment a tag facet is active — objects and stores carry no tags', () => {
    assert.deepStrictEqual(
      filterHitsByFacets(rows, facets({ collection: 'objects', tag: 'julia' })).map((row) => row.id),
      []
    );
    assert.strictEqual(matchesInventoryFacets(rows[4] as InventoryHit, facets({ tag: 'julia' })), false);
  });

  it('a tag no loaded row carries yields nothing rather than everything', () => {
    assert.deepStrictEqual(filterHitsByFacets(rows, facets({ tag: 't9-acceptance' })), []);
  });
});

describe('allowedActions — role matrix', () => {
  const objectHit = hit({ collection: 'objects' });
  const artifactHit = hit({ collection: 'artifacts' });
  const storeHit = hit({ collection: 'stores', kind: 'agent-chats' });

  it('editor gets nothing on any collection — Inventory is owner+admin only', () => {
    assert.deepStrictEqual(allowedActions(objectHit, ROLES.editor), []);
    assert.deepStrictEqual(allowedActions(artifactHit, ROLES.editor), []);
    assert.deepStrictEqual(allowedActions(storeHit, ROLES.editor), []);
  });

  it('admin gets the object verb set: archive, validate, open-in-workspace, send-to-chat', () => {
    assert.deepStrictEqual(allowedActions(objectHit, ROLES.admin), [
      'archive',
      'validate',
      'open-in-workspace',
      'send-to-chat',
    ]);
  });

  it('admin gets the ACTIVE artifact verb set: delete, add-tag, remove-tag, download, send-to-chat', () => {
    assert.deepStrictEqual(allowedActions(artifactHit, ROLES.admin), [
      'delete',
      'add-tag',
      'remove-tag',
      'download',
      'send-to-chat',
    ]);
  });

  it('admin gets read + send-to-chat on a system store, but NOT the raw-delete family', () => {
    const actions = allowedActions(storeHit, ROLES.admin);
    assert.deepStrictEqual(actions, ['read', 'send-to-chat']);
    assert.ok(!actions.includes('delete-blob'));
    assert.ok(!actions.includes('wipe-store'));
    assert.ok(!actions.includes('wipe-all'));
  });

  it('owner gets everything admin gets on objects/artifacts (owner expands to include admin)', () => {
    assert.deepStrictEqual(allowedActions(objectHit, ROLES.owner), allowedActions(objectHit, ROLES.admin));
    assert.deepStrictEqual(allowedActions(artifactHit, ROLES.owner), allowedActions(artifactHit, ROLES.admin));
  });

  it('owner ADDITIONALLY gets delete-blob / wipe-store / wipe-all on a system store', () => {
    assert.deepStrictEqual(allowedActions(storeHit, ROLES.owner), [
      'read',
      'send-to-chat',
      'delete-blob',
      'wipe-store',
      'wipe-all',
    ]);
  });
});

/**
 * The table this wave exists to enforce: a row's actions are a function of the
 * row's TRUE state. Written out a second time, independently, and compared —
 * the same shape as `row-actions.test.ts`'s matrix.
 *
 * | status    | offered                                              |
 * |-----------|------------------------------------------------------|
 * | active    | delete, add-tag, remove-tag, download, send-to-chat   |
 * | deleted   | restore, download, send-to-chat                       |
 * | anything  | download, send-to-chat (read-only; never `delete`)    |
 */
describe('allowedActions — artifact status table', () => {
  const artifact = (status: string) => hit({ collection: 'artifacts', status });

  const TABLE: ReadonlyArray<{ status: string; offered: readonly string[] }> = [
    { status: 'active', offered: ['delete', 'add-tag', 'remove-tag', 'download', 'send-to-chat'] },
    { status: 'deleted', offered: ['restore', 'download', 'send-to-chat'] },
    // Not a status `normalizeArtifactHit` can produce today — the point is
    // what happens if one ever arrives.
    { status: 'quarantined', offered: ['download', 'send-to-chat'] },
    { status: '', offered: ['download', 'send-to-chat'] },
  ];

  for (const row of TABLE) {
    it(`status "${row.status}" offers exactly ${row.offered.join(', ')}`, () => {
      assert.deepStrictEqual(allowedActions(artifact(row.status), ROLES.admin), [...row.offered]);
      assert.deepStrictEqual(allowedActions(artifact(row.status), ROLES.owner), [...row.offered]);
    });
  }

  it('NO status offers delete except active — the UI never offers a verb the server no-ops', () => {
    for (const status of ['deleted', 'quarantined', '', 'unknown']) {
      assert.ok(
        !allowedActions(artifact(status), ROLES.owner).includes('delete'),
        `status "${status}" still offers delete`
      );
    }
  });

  it('restore is offered ONLY on a deleted row, and never on objects or stores', () => {
    assert.ok(allowedActions(artifact('deleted'), ROLES.admin).includes('restore'));
    assert.ok(!allowedActions(artifact('active'), ROLES.admin).includes('restore'));
    assert.ok(!allowedActions(artifact('quarantined'), ROLES.admin).includes('restore'));
    assert.ok(!allowedActions(hit({ collection: 'objects' }), ROLES.owner).includes('restore'));
    assert.ok(!allowedActions(hit({ collection: 'stores', kind: 'workflows' }), ROLES.owner).includes('restore'));
  });

  it('a deleted row is not offered tag verbs — tags on a dead row are dead weight', () => {
    const actions = allowedActions(artifact('deleted'), ROLES.admin);
    assert.ok(!actions.includes('add-tag'));
    assert.ok(!actions.includes('remove-tag'));
  });
});

/**
 * The bulk matrix. `bulkActionsFor` still answers with the plain intersection;
 * `bulkActionOffers` is what the toolbar renders, and it is the one that must
 * never go quiet on a mixed selection.
 */
describe('bulkActionOffers — the state verbs, enabled or explained', () => {
  const artifact = (id: string, status: string) => hit({ collection: 'artifacts', id, status });
  const find = (offers: ReturnType<typeof bulkActionOffers>, id: string) => offers.find((offer) => offer.id === id);

  it('an all-active selection: Delete enabled, Restore not offered at all', () => {
    const offers = bulkActionOffers([artifact('a', 'active'), artifact('b', 'active')], ROLES.admin);
    assert.deepStrictEqual(find(offers, 'delete'), { id: 'delete', enabled: true });
    assert.equal(find(offers, 'restore'), undefined, 'there is nothing to restore, so nothing to explain');
  });

  it('an all-deleted selection: Restore enabled, Delete not offered at all', () => {
    const offers = bulkActionOffers([artifact('a', 'deleted'), artifact('b', 'deleted')], ROLES.admin);
    assert.deepStrictEqual(find(offers, 'restore'), { id: 'restore', enabled: true });
    assert.equal(find(offers, 'delete'), undefined, 'every row is already deleted — Delete would be the no-op');
  });

  it('a mixed selection shows BOTH verbs disabled, each naming its own half', () => {
    const selection = [
      artifact('a', 'active'),
      artifact('b', 'active'),
      artifact('c', 'deleted'),
      artifact('d', 'deleted'),
      artifact('e', 'deleted'),
    ];
    const offers = bulkActionOffers(selection, ROLES.admin);
    assert.deepStrictEqual(find(offers, 'delete'), {
      id: 'delete',
      enabled: false,
      reason: '3 of 5 selected are already deleted.',
    });
    assert.deepStrictEqual(find(offers, 'restore'), {
      id: 'restore',
      enabled: false,
      reason: '2 of 5 selected are not deleted.',
    });
  });

  it('an unknown status disables delete with a reason that does not claim "already deleted"', () => {
    const offers = bulkActionOffers([artifact('a', 'active'), artifact('b', 'quarantined')], ROLES.admin);
    assert.deepStrictEqual(find(offers, 'delete'), {
      id: 'delete',
      enabled: false,
      reason: '1 of 2 selected is not active.',
    });
    assert.equal(find(offers, 'restore'), undefined);
  });

  it('every disabled offer carries a reason, and no enabled one does (D3)', () => {
    const selections = [
      [artifact('a', 'active')],
      [artifact('a', 'deleted')],
      [artifact('a', 'active'), artifact('b', 'deleted')],
      [artifact('a', 'active'), artifact('b', 'quarantined')],
      [artifact('a', 'deleted'), artifact('b', 'quarantined')],
    ];
    for (const selection of selections) {
      for (const offer of bulkActionOffers(selection, ROLES.owner)) {
        if (offer.enabled) assert.equal(offer.reason, undefined, `${offer.id} is enabled but carries a reason`);
        else assert.ok(offer.reason && offer.reason.length > 0, `${offer.id} is disabled with no reason`);
      }
    }
  });

  it('carries the non-state verbs through unchanged, and drops them on a mixed-collection selection', () => {
    const uniform = bulkActionOffers([artifact('a', 'active'), artifact('b', 'active')], ROLES.admin);
    assert.deepStrictEqual(
      uniform.map((offer) => offer.id),
      ['delete', 'add-tag', 'remove-tag', 'send-to-chat']
    );

    const mixed = bulkActionOffers([hit({ collection: 'objects', id: 'o' }), artifact('a', 'active')], ROLES.admin);
    // A state verb is only meaningful for an all-artifact selection; the rest
    // is `bulkActionsFor`'s intersection, unchanged.
    assert.deepStrictEqual(
      mixed.map((offer) => offer.id),
      ['send-to-chat']
    );
  });

  it('offers nothing to a caller without admin standing, and nothing for an empty selection', () => {
    assert.deepStrictEqual(bulkActionOffers([artifact('a', 'deleted')], ROLES.editor), []);
    assert.deepStrictEqual(bulkActionOffers([], ROLES.owner), []);
  });
});

describe('bulkActionsFor', () => {
  it('is the per-hit action set minus the single-subject verbs, for a uniform selection', () => {
    const selection = [hit({ collection: 'objects', id: 'a' }), hit({ collection: 'objects', id: 'b' })];
    // Objects carry no store-wide verb, so only `open-in-workspace` is dropped
    // — it navigates to ONE object and has no "all twelve" form. It stays in
    // the per-hit matrix, which is what the row menu reads.
    assert.deepStrictEqual(bulkActionsFor(selection, ROLES.admin), ['archive', 'validate', 'send-to-chat']);
    assert.ok(allowedActions(selection[0], ROLES.admin).includes('open-in-workspace'));
  });

  it('drops actions not shared across a mixed objects+artifacts selection, keeping only send-to-chat', () => {
    const selection = [hit({ collection: 'objects', id: 'a' }), hit({ collection: 'artifacts', id: 'b' })];
    assert.deepStrictEqual(bulkActionsFor(selection, ROLES.admin), ['send-to-chat']);
  });

  it('drops the owner-only raw-delete family when a store row is mixed with an admin-only collection', () => {
    // Same collection (two store rows, different underlying store kind) but
    // the intersection logic must still apply per-hit, not just per-collection
    // — an admin caller never sees the owner-only actions materialize just
    // because the selection is uniform.
    const selection = [
      hit({ collection: 'stores', kind: 'agent-chats', id: 'a' }),
      hit({ collection: 'stores', kind: 'workflows', id: 'b' }),
    ];
    // `wipe-store`/`wipe-all` are absent even for an owner: they are
    // store-wide, so a bulk toolbar ("apply to each selected row") is the
    // wrong place for them — see `isRowScopedAction`. They stay in
    // `allowedActions`, offered one row at a time with a typed confirm.
    // `read` is absent for the other reason: it opens the drawer inspector,
    // which inspects one hit at a time — see `BULK_UNSAFE_ACTIONS`.
    assert.deepStrictEqual(bulkActionsFor(selection, ROLES.owner), ['send-to-chat', 'delete-blob']);
    assert.deepStrictEqual(bulkActionsFor(selection, ROLES.admin), ['send-to-chat']);
    assert.ok(allowedActions(selection[0], ROLES.admin).includes('read'));
  });

  it('never offers a store-wide verb in a bulk selection, however uniform', () => {
    const selection = [
      hit({ collection: 'stores', kind: 'workflows', id: 'a' }),
      hit({ collection: 'stores', kind: 'workflows', id: 'b' }),
    ];
    const actions = bulkActionsFor(selection, ROLES.owner);
    assert.ok(!actions.includes('wipe-store'), 'wipe-store must not reach the bulk toolbar');
    assert.ok(!actions.includes('wipe-all'), 'wipe-all must not reach the bulk toolbar');
    // …while the row-level matrix still allows them for an owner.
    assert.ok(allowedActions(selection[0], ROLES.owner).includes('wipe-store'));
  });

  it('offers exactly the artifact verbs the bulk toolbar has buttons for', () => {
    const selection = [hit({ collection: 'artifacts', id: 'a' }), hit({ collection: 'artifacts', id: 'b' })];

    // `download` used to survive the intersection while the toolbar rendered
    // no button for it — the action list and the surface disagreed. It is
    // excluded here and still offered per row.
    assert.deepStrictEqual(bulkActionsFor(selection, ROLES.admin), [
      'delete',
      'add-tag',
      'remove-tag',
      'send-to-chat',
    ]);
    assert.ok(allowedActions(selection[0], ROLES.admin).includes('download'));
  });

  it('intersects to no state verb at all when the artifact selection is mixed-status', () => {
    const selection = [
      hit({ collection: 'artifacts', id: 'a', status: 'active' }),
      hit({ collection: 'artifacts', id: 'b', status: 'deleted' }),
    ];
    // This is WHY `bulkActionOffers` exists: the plain intersection is right
    // and also silent, and a toolbar built from it alone loses both verbs.
    const actions = bulkActionsFor(selection, ROLES.admin);
    assert.ok(!actions.includes('delete'));
    assert.ok(!actions.includes('restore'));
    assert.deepStrictEqual(actions, ['send-to-chat']);
  });

  it('is empty for an empty selection', () => {
    assert.deepStrictEqual(bulkActionsFor([], ROLES.owner), []);
  });

  it('is empty for any selection when the caller has no admin standing', () => {
    const selection = [hit({ collection: 'objects', id: 'a' })];
    assert.deepStrictEqual(bulkActionsFor(selection, ROLES.editor), []);
  });
});

describe('previewSummary', () => {
  it('summarizes a workflows record: status, node count, updated', () => {
    const json = {
      request_id: 'req_9',
      workflow_status: 'in_progress',
      current_stage: 'writer',
      agent_outputs: {
        researcher: { version: 1, updated_at: '2026-09-01T00:00:00.000Z', expected_agent_version: 1 },
        writer: { version: 1, updated_at: '2026-09-02T00:00:00.000Z', expected_agent_version: 1 },
      },
      updated_at: '2026-09-02T00:00:00.000Z',
    };
    assert.deepStrictEqual(previewSummary('workflows', json), [
      { label: 'Status', value: 'in_progress' },
      { label: 'Node count', value: '2' },
      { label: 'Updated', value: '2026-09-02T00:00:00.000Z' },
    ]);
  });

  it('summarizes an agent-artifact-jobs record: status, slot, project', () => {
    const json = {
      jobId: 'job_1',
      status: 'rendering',
      slot: 'hero',
      projectId: 'proj_dr_lurie',
      requestId: 'req_9',
    };
    assert.deepStrictEqual(previewSummary('agent-artifact-jobs', json), [
      { label: 'Status', value: 'rendering' },
      { label: 'Slot', value: 'hero' },
      { label: 'Project', value: 'proj_dr_lurie' },
    ]);
  });

  it('summarizes an agent-chats record: title, turn count', () => {
    const json = {
      title: 'Fix the seed drift',
      status: 'idle',
      events: [{ type: 'user_message' }, { type: 'assistant_text' }, { type: 'run_finished' }],
    };
    assert.deepStrictEqual(previewSummary('agent-chats', json), [
      { label: 'Title', value: 'Fix the seed drift' },
      { label: 'Turns', value: '3' },
    ]);
  });

  it('falls back to the default top-level-key extractor for an unrecognized store', () => {
    const json = { plan_id: 'plan_1', owner_email: 'vreich@kugelbrands.com', step_count: 5, tags: ['a', 'b'] };
    assert.deepStrictEqual(previewSummary('some-future-store', json), [
      { label: 'Plan id', value: 'plan_1' },
      { label: 'Owner email', value: 'vreich@kugelbrands.com' },
      { label: 'Step count', value: '5' },
      { label: 'Tags', value: '2 items' },
    ]);
  });

  it('default extractor caps at 4 fields and handles missing/nested values gracefully', () => {
    const json = { a: 1, b: null, c: { nested: true }, d: 'ok', e: 'dropped' };
    const result = previewSummary('another-unknown-store', json);
    assert.strictEqual(result.length, 4);
    assert.deepStrictEqual(result, [
      { label: 'A', value: '1' },
      { label: 'B', value: '—' },
      { label: 'C', value: '1 field' },
      { label: 'D', value: 'ok' },
    ]);
  });

  it('never throws on non-object JSON (e.g. a bare string/number blob)', () => {
    assert.deepStrictEqual(previewSummary('workflows', 'not-an-object'), [
      { label: 'Status', value: '—' },
      { label: 'Node count', value: '0' },
      { label: 'Updated', value: '—' },
    ]);
    assert.deepStrictEqual(previewSummary('some-unknown-store', null), []);
  });
});
