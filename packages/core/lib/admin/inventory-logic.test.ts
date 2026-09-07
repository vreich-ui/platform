import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  allowedActions,
  bulkActionsFor,
  facetCounts,
  previewSummary,
  type InventoryCollection,
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
  refs: [],
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
    });
  });

  it('returns empty maps for an empty hit list', () => {
    assert.deepStrictEqual(facetCounts([]), { collection: {}, kind: {}, status: {} });
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

  it('admin gets the artifact verb set: delete, add-tag, remove-tag, download, send-to-chat', () => {
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

describe('bulkActionsFor', () => {
  it('is the full per-hit action set when every row in the selection is the same collection', () => {
    const selection = [hit({ collection: 'objects', id: 'a' }), hit({ collection: 'objects', id: 'b' })];
    // Objects carry no store-wide verb, so the bulk set is the whole per-hit set.
    assert.deepStrictEqual(bulkActionsFor(selection, ROLES.admin), allowedActions(selection[0], ROLES.admin));
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
    assert.deepStrictEqual(bulkActionsFor(selection, ROLES.owner), ['read', 'send-to-chat', 'delete-blob']);
    assert.deepStrictEqual(bulkActionsFor(selection, ROLES.admin), ['read', 'send-to-chat']);
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
