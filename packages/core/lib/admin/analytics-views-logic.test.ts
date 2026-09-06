import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUILTIN_VIEW_IDS,
  buildViewInput,
  defaultAnalyticsViews,
  isValidNoteDate,
  isValidNoteText,
  isValidViewName,
  notesInRange,
  serializeViewSearch,
  sortAnalyticsNotes,
  sortAnalyticsViews,
  viewIdFromSearch,
  viewToSearchState,
  type AnalyticsNote,
  type AnalyticsSavedView,
} from './analytics-views-logic.js';
import type { AnalyticsSearchState } from './analytics-logic.js';

test('defaultAnalyticsViews ships exactly the three named views, builtin and own-tab', () => {
  const views = defaultAnalyticsViews('2026-09-05T00:00:00.000Z');
  assert.equal(views.length, 3);
  assert.deepEqual(
    views.map((v) => v.id),
    [BUILTIN_VIEW_IDS.weeklyReview, BUILTIN_VIEW_IDS.contentPerformance, BUILTIN_VIEW_IDS.acquisition]
  );
  for (const view of views) {
    assert.equal(view.builtin, true);
    assert.equal(view.tab, 'own');
  }
  const weekly = views.find((v) => v.id === BUILTIN_VIEW_IDS.weeklyReview)!;
  assert.equal(weekly.range, '7d');
  assert.equal(weekly.compare, true);
  const content = views.find((v) => v.id === BUILTIN_VIEW_IDS.contentPerformance)!;
  assert.equal(content.range, '30d');
  assert.equal(content.pagesSort, 'completion_rate');
  const acquisition = views.find((v) => v.id === BUILTIN_VIEW_IDS.acquisition)!;
  assert.equal(acquisition.range, '30d');
});

test('viewToSearchState / buildViewInput round-trip a preset-range view', () => {
  const view: AnalyticsSavedView = {
    id: 'view_1',
    name: 'My view',
    tab: 'own',
    range: '30d',
    compare: true,
    filters: { country: 'IL' },
    createdAt: 't0',
    updatedAt: 't0',
  };
  const state = viewToSearchState(view);
  assert.deepEqual(state, {
    source: 'own',
    range: '30d',
    custom: undefined,
    compare: true,
    filters: { country: 'IL' },
  });

  const input = buildViewInput('My view', state);
  assert.deepEqual(input, {
    name: 'My view',
    tab: 'own',
    range: '30d',
    from: undefined,
    to: undefined,
    compare: true,
    filters: { country: 'IL' },
    pagesSort: undefined,
  });
});

test('viewToSearchState / buildViewInput round-trip a custom range view', () => {
  const view: AnalyticsSavedView = {
    id: 'view_2',
    name: 'Custom span',
    tab: 'netlify',
    range: 'custom',
    from: '2026-08-01',
    to: '2026-08-15',
    compare: false,
    filters: {},
    createdAt: 't0',
    updatedAt: 't0',
  };
  const state = viewToSearchState(view);
  assert.deepEqual(state.custom, { from: '2026-08-01', to: '2026-08-15' });

  const input = buildViewInput('Custom span', state);
  assert.equal(input.from, '2026-08-01');
  assert.equal(input.to, '2026-08-15');
  // Netlify tab never carries a pagesSort, even if one is passed in.
  const withSort = buildViewInput('Custom span', state, 'completion_rate');
  assert.equal(withSort.pagesSort, undefined);
});

test('buildViewInput carries pagesSort only for the own tab', () => {
  const ownState: AnalyticsSearchState = { source: 'own', range: '30d', compare: false, filters: {} };
  assert.equal(buildViewInput('x', ownState, 'completion_rate').pagesSort, 'completion_rate');
  const netlifyState: AnalyticsSearchState = { source: 'netlify', range: '30d', compare: false, filters: {} };
  assert.equal(buildViewInput('x', netlifyState, 'completion_rate').pagesSort, undefined);
});

test('isValidViewName rejects empty, whitespace-only, and over-long names', () => {
  assert.equal(isValidViewName('Weekly review'), true);
  assert.equal(isValidViewName(''), false);
  assert.equal(isValidViewName('   '), false);
  assert.equal(isValidViewName('x'.repeat(61)), false);
  assert.equal(isValidViewName('x'.repeat(60)), true);
});

test('sortAnalyticsViews pins builtins first, then most-recently-updated', () => {
  const views: AnalyticsSavedView[] = [
    {
      id: 'a',
      name: 'A',
      tab: 'own',
      range: '7d',
      compare: false,
      filters: {},
      createdAt: 't0',
      updatedAt: '2026-01-01',
    },
    {
      id: 'b',
      name: 'B',
      tab: 'own',
      range: '7d',
      compare: false,
      filters: {},
      createdAt: 't0',
      updatedAt: '2026-02-01',
    },
    {
      id: 'c',
      name: 'C',
      tab: 'own',
      range: '7d',
      compare: false,
      filters: {},
      builtin: true,
      createdAt: 't0',
      updatedAt: '2020-01-01',
    },
  ];
  const sorted = sortAnalyticsViews(views);
  assert.deepEqual(
    sorted.map((v) => v.id),
    ['c', 'b', 'a']
  );
});

// ─── URL addressing ─────────────────────────────────────────────────────────

test('viewIdFromSearch / serializeViewSearch round-trip', () => {
  const id = 'builtin_weekly_review';
  const qs = serializeViewSearch(id);
  assert.equal(qs, `view=${id}`);
  assert.equal(viewIdFromSearch(`?${qs}`), id);
  assert.equal(viewIdFromSearch(qs), id);
});

test('viewIdFromSearch degrades to undefined on absence or garbage', () => {
  assert.equal(viewIdFromSearch(''), undefined);
  assert.equal(viewIdFromSearch('?source=own&range=30d'), undefined);
  assert.equal(viewIdFromSearch('not a query string at all'), undefined);
});

// ─── operator notes ─────────────────────────────────────────────────────────

test('isValidNoteDate accepts only YYYY-MM-DD', () => {
  assert.equal(isValidNoteDate('2026-09-05'), true);
  assert.equal(isValidNoteDate('2026-9-5'), false);
  assert.equal(isValidNoteDate('2026-09-05T00:00:00Z'), false);
  assert.equal(isValidNoteDate(''), false);
});

test('isValidNoteText rejects empty and over-long text', () => {
  assert.equal(isValidNoteText('Shipped the new pricing page'), true);
  assert.equal(isValidNoteText('   '), false);
  assert.equal(isValidNoteText('x'.repeat(501)), false);
  assert.equal(isValidNoteText('x'.repeat(500)), true);
});

test('notesInRange filters inclusive of both endpoints', () => {
  const notes: AnalyticsNote[] = [
    { id: '1', date: '2026-08-01', text: 'a', createdBy: 'w', createdAt: 't' },
    { id: '2', date: '2026-08-15', text: 'b', createdBy: 'w', createdAt: 't' },
    { id: '3', date: '2026-08-31', text: 'c', createdBy: 'w', createdAt: 't' },
  ];
  const filtered = notesInRange(notes, '2026-08-01', '2026-08-15');
  assert.deepEqual(
    filtered.map((n) => n.id),
    ['1', '2']
  );
});

test('sortAnalyticsNotes orders newest date first, then newest created', () => {
  const notes: AnalyticsNote[] = [
    { id: '1', date: '2026-08-01', text: 'a', createdBy: 'w', createdAt: '2026-08-01T10:00:00Z' },
    { id: '2', date: '2026-08-15', text: 'b', createdBy: 'w', createdAt: '2026-08-15T09:00:00Z' },
    { id: '3', date: '2026-08-15', text: 'c', createdBy: 'w', createdAt: '2026-08-15T10:00:00Z' },
  ];
  const sorted = sortAnalyticsNotes(notes);
  assert.deepEqual(
    sorted.map((n) => n.id),
    ['3', '2', '1']
  );
});
