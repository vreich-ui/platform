import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupMarkersByDay,
  markersInRange,
  mergeAnnotationMarkers,
  noteMarkersFromNotes,
  publishMarkersFromHistory,
  publishMarkersFromRecords,
  releaseMarkersFromDeploys,
  type AnnotatableObjectRecordLike,
  type AnnotationMarker,
} from './analytics-annotations-logic.js';

// ─── release markers ────────────────────────────────────────────────────────

test('releaseMarkersFromDeploys keeps only ready deploys with a finish time', () => {
  const markers = releaseMarkersFromDeploys([
    { deployId: 'd1', deployStatus: 'ready', finishedAt: '2026-08-01T12:00:00.000Z', commit: 'abcdef1234567' },
    { deployId: 'd2', deployStatus: 'building', finishedAt: '', commit: 'ffffff' },
    { deployId: 'd3', deployStatus: 'ready', finishedAt: '', commit: 'zzz' },
    { deployId: 'd4', deployStatus: 'failed', finishedAt: '2026-08-02T00:00:00.000Z', commit: 'bad' },
  ]);
  assert.equal(markers.length, 1);
  assert.equal(markers[0]!.id, 'release_d1');
  assert.equal(markers[0]!.kind, 'release');
  assert.equal(markers[0]!.at, '2026-08-01T12:00:00.000Z');
  assert.equal(markers[0]!.detail, 'Deploy abcdef1');
});

test('releaseMarkersFromDeploys degrades commit-less receipts to a plain "Deploy" detail', () => {
  const markers = releaseMarkersFromDeploys([
    { deployId: 'd1', deployStatus: 'ready', finishedAt: '2026-08-01T00:00:00.000Z', commit: '' },
  ]);
  assert.equal(markers[0]!.detail, 'Deploy');
});

// ─── publish markers ────────────────────────────────────────────────────────

test('publishMarkersFromHistory prefers the resolved title, and links to the admin object when resolvable', () => {
  const markers = publishMarkersFromHistory([
    {
      objectId: 'article_1',
      objectType: 'content_item',
      at: '2026-08-05T00:00:00.000Z',
      title: 'Skincare Basics',
      adminHref: '/admin/content/article_1',
    },
    { objectId: 'page_2', objectType: 'page', at: '2026-08-06T00:00:00.000Z' },
  ]);
  assert.equal(markers[0]!.label, 'Published: Skincare Basics');
  assert.equal(markers[0]!.href, '/admin/content/article_1');
  assert.equal(markers[1]!.label, 'Published page page_2');
  assert.equal(markers[1]!.href, undefined);
});

// ─── publish markers, selected off a fixture record sweep ──────────────────

function fixtureRecords(): AnnotatableObjectRecordLike[] {
  return [
    {
      objectId: 'article_1',
      objectType: 'content_item',
      title: 'Skincare Basics',
      adminHref: '/admin/content/article_1',
      history: [
        { action: 'create', at: '2026-07-01T00:00:00.000Z' },
        { action: 'publish', at: '2026-08-05T00:00:00.000Z' },
        { action: 'patch', at: '2026-08-06T00:00:00.000Z' },
        { action: 'publish', at: '2026-09-01T00:00:00.000Z' },
      ],
    },
    {
      objectId: 'nav_1',
      objectType: 'navigation',
      history: [{ action: 'publish', at: '2026-08-05T00:00:00.000Z' }],
    },
  ];
}

test('publishMarkersFromRecords keeps only content_item/page publish entries inside the window', () => {
  const markers = publishMarkersFromRecords(fixtureRecords(), '2026-08-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z');
  assert.equal(markers.length, 1, 'the navigation publish and the September publish must both be excluded');
  assert.equal(markers[0]!.at, '2026-08-05T00:00:00.000Z');
  assert.equal(markers[0]!.label, 'Published: Skincare Basics');
});

test('publishMarkersFromRecords returns nothing for a window with no publish activity', () => {
  assert.deepEqual(publishMarkersFromRecords(fixtureRecords(), '2026-01-01', '2026-01-31'), []);
});

// ─── note markers ───────────────────────────────────────────────────────────

test('noteMarkersFromNotes carries the note text as the label, keyed by note id', () => {
  const markers = noteMarkersFromNotes([{ id: 'note_1', date: '2026-08-10', text: 'Shipped the redesign' }]);
  assert.deepEqual(markers, [{ id: 'note_1', at: '2026-08-10', kind: 'note', label: 'Shipped the redesign' }]);
});

// ─── merge / range / grouping ───────────────────────────────────────────────

test('mergeAnnotationMarkers combines every source and sorts ascending by `at`', () => {
  const releases = releaseMarkersFromDeploys([
    { deployId: 'd1', deployStatus: 'ready', finishedAt: '2026-08-03T00:00:00.000Z', commit: 'abc' },
  ]);
  const publishes = publishMarkersFromHistory([{ objectId: 'a', objectType: 'page', at: '2026-08-01T00:00:00.000Z' }]);
  const notes = noteMarkersFromNotes([{ id: 'n1', date: '2026-08-02', text: 'note' }]);
  const merged = mergeAnnotationMarkers(releases, publishes, notes);
  assert.deepEqual(
    merged.map((m) => m.kind),
    ['publish', 'note', 'release']
  );
});

test('markersInRange is inclusive of both endpoints', () => {
  const markers: AnnotationMarker[] = [
    { id: '1', at: '2026-08-01', kind: 'note', label: 'a' },
    { id: '2', at: '2026-08-15T12:00:00.000Z', kind: 'release', label: 'b' },
    { id: '3', at: '2026-08-31', kind: 'note', label: 'c' },
  ];
  const scoped = markersInRange(markers, '2026-08-01', '2026-08-15T23:59:59.999Z');
  assert.deepEqual(
    scoped.map((m) => m.id),
    ['1', '2']
  );
});

test('groupMarkersByDay buckets release/publish timestamps and note dates onto the same calendar day', () => {
  const markers: AnnotationMarker[] = [
    { id: '1', at: '2026-08-01T09:00:00.000Z', kind: 'release', label: 'a' },
    { id: '2', at: '2026-08-01T18:00:00.000Z', kind: 'publish', label: 'b' },
    { id: '3', at: '2026-08-02', kind: 'note', label: 'c' },
  ];
  const grouped = groupMarkersByDay(markers);
  assert.equal(grouped['2026-08-01']!.length, 2);
  assert.equal(grouped['2026-08-02']!.length, 1);
});
