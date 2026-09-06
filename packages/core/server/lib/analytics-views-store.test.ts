import assert from 'node:assert/strict';
import test from 'node:test';

import { BUILTIN_VIEW_IDS, buildViewInput } from '../../lib/admin/analytics-views-logic.js';
import type { AnalyticsSearchState } from '../../lib/admin/analytics-logic.js';
import {
  addAnalyticsNote,
  deleteAnalyticsNote,
  deleteAnalyticsView,
  listAnalyticsNotes,
  listAnalyticsViews,
  saveAnalyticsView,
  type AnalyticsViewsStore,
} from './analytics-views-store.js';

/** A minimal in-memory fake — the real thing is Netlify Blobs' `getJSON`-style store; this module only ever calls `get`/`setJSON`. */
function fakeStore(): AnalyticsViewsStore {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async setJSON(key, value) {
      data.set(key, JSON.stringify(value));
    },
  };
}

test('listAnalyticsViews seeds the three defaults exactly once, on an empty store', async () => {
  const store = fakeStore();
  const first = await listAnalyticsViews(store, '2026-09-05T00:00:00.000Z');
  assert.equal(first.length, 3);
  assert.ok(first.some((v) => v.id === BUILTIN_VIEW_IDS.weeklyReview));

  // A deleted default must never come back on a subsequent list — seeding
  // only fires against a genuinely empty/unparseable store.
  await deleteAnalyticsView(store, BUILTIN_VIEW_IDS.acquisition);
  const second = await listAnalyticsViews(store, '2026-09-06T00:00:00.000Z');
  assert.equal(second.length, 2);
  assert.ok(!second.some((v) => v.id === BUILTIN_VIEW_IDS.acquisition));
});

test('saveAnalyticsView creates, then updates the same view by id', async () => {
  const store = fakeStore();
  await listAnalyticsViews(store); // seed defaults so the store isn't empty for this test's own assertions

  const state: AnalyticsSearchState = { source: 'own', range: '7d', compare: true, filters: { country: 'IL' } };
  const created = await saveAnalyticsView(store, buildViewInput('My weekday check', state), undefined, 't1');
  assert.equal(created.name, 'My weekday check');
  assert.equal(created.builtin, false);
  assert.ok(created.id.startsWith('view_'));

  const listed = await listAnalyticsViews(store);
  assert.ok(listed.some((v) => v.id === created.id));

  const updatedState: AnalyticsSearchState = { source: 'own', range: '30d', compare: false, filters: {} };
  const updated = await saveAnalyticsView(store, buildViewInput('Renamed', updatedState), created.id, 't2');
  assert.equal(updated.id, created.id);
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.range, '30d');
  assert.equal(updated.createdAt, 't1', 'createdAt must not move on an update');
  assert.equal(updated.updatedAt, 't2');

  const afterUpdate = await listAnalyticsViews(store);
  assert.equal(afterUpdate.filter((v) => v.id === created.id).length, 1, 'update must replace, not duplicate');
});

test('saveAnalyticsView throws on an update naming an id that does not exist', async () => {
  const store = fakeStore();
  const state: AnalyticsSearchState = { source: 'own', range: '7d', compare: false, filters: {} };
  await assert.rejects(() => saveAnalyticsView(store, buildViewInput('x', state), 'view_does_not_exist'));
});

test('deleteAnalyticsView returns false for an id that is not there', async () => {
  const store = fakeStore();
  await listAnalyticsViews(store);
  assert.equal(await deleteAnalyticsView(store, 'view_never_existed'), false);
});

// ─── operator notes ─────────────────────────────────────────────────────────

test('addAnalyticsNote / listAnalyticsNotes / deleteAnalyticsNote round-trip', async () => {
  const store = fakeStore();
  assert.deepEqual(await listAnalyticsNotes(store), []);

  const note = await addAnalyticsNote(
    store,
    { date: '2026-08-15', text: 'Shipped the pricing redesign' },
    'wolf@example.com',
    't1'
  );
  assert.ok(note.id.startsWith('note_'));
  assert.equal(note.createdBy, 'wolf@example.com');

  const listed = await listAnalyticsNotes(store);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, note.id);

  assert.equal(await deleteAnalyticsNote(store, note.id), true);
  assert.deepEqual(await listAnalyticsNotes(store), []);
  assert.equal(await deleteAnalyticsNote(store, note.id), false);
});

test('listAnalyticsNotes(range) scopes to the window', async () => {
  const store = fakeStore();
  await addAnalyticsNote(store, { date: '2026-08-01', text: 'a' }, 'w', 't1');
  await addAnalyticsNote(store, { date: '2026-08-20', text: 'b' }, 'w', 't2');

  const scoped = await listAnalyticsNotes(store, { from: '2026-08-15', to: '2026-08-31' });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0]!.text, 'b');
});
