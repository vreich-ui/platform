import assert from 'node:assert/strict';
import test from 'node:test';

import { WORKSPACE_EXPANDED_MIN_WIDTH } from './responsive-workspace.js';
import { minContentWidthForDockPx, objectColumnFraction } from './agent-surface-layout.js';
import { requestsAddress } from './request-url-filters.js';
import {
  ADMIN_SHELL_CHROME_PX,
  DOCK_EMPTY_HEADING,
  dockAddress,
  dockChatIntent,
  dockCollapsedStorageKey,
  dockFocusLabel,
  dockHeading,
  dockLayout,
  dockPreferenceScope,
  minViewportWidthForDockPx,
  rememberDockChat,
  resolveDockCollapsed,
} from './universal-dock.js';
import type { ObjectSelection } from './object-selection.js';

const article: ObjectSelection = { object_type: 'content_item', object_id: 'req_evergreen_retinol_20260901_01' };
const page: ObjectSelection = { object_type: 'page', object_id: 'home' };

// ─── selection → open / collapsed ───────────────────────────────────────────

test('the dock is a spine until something is selected, and opens on the first selection', () => {
  assert.equal(resolveDockCollapsed({}), true);
  assert.equal(resolveDockCollapsed({ userCollapsed: false }), true);
  // Even a human who expanded it cannot open a dock bound to nothing.
  assert.equal(resolveDockCollapsed({ userCollapsed: false, selection: undefined }), true);
  assert.equal(resolveDockCollapsed({ selection: article }), false);
});

test('once there is a selection the human toggle wins, on this and every later selection', () => {
  assert.equal(resolveDockCollapsed({ selection: article, userCollapsed: true }), true);
  // Clicking a second row must not re-open a dock the editor collapsed.
  assert.equal(resolveDockCollapsed({ selection: page, userCollapsed: true }), true);
  assert.equal(resolveDockCollapsed({ selection: page, userCollapsed: false }), false);
});

test('a malformed selection is no selection here too — the spine stays', () => {
  assert.equal(resolveDockCollapsed({ selection: { object_type: '', object_id: 'home' }, userCollapsed: false }), true);
});

// ─── which layout path a width takes ────────────────────────────────────────

test('beside needs BOTH gates: the expanded breakpoint and the dock’s own 60% promise', () => {
  assert.equal(dockLayout({ expandedWorkspace: true, contentWidthPx: 1400 }), 'beside');
  // Wide content, but the surface is in its compact arrangement.
  assert.equal(dockLayout({ expandedWorkspace: false, contentWidthPx: 1400 }), 'drawer');
  // Expanded, but the object would be starved.
  assert.equal(dockLayout({ expandedWorkspace: true, contentWidthPx: 800 }), 'drawer');
});

test('the two gates genuinely disagree: at the 1280 breakpoint the promise is not yet kept', () => {
  // What `<main>` actually offers at exactly WORKSPACE_EXPANDED_MIN_WIDTH,
  // once the xl sidebar and the content padding are taken out.
  const contentAtBreakpoint = WORKSPACE_EXPANDED_MIN_WIDTH - ADMIN_SHELL_CHROME_PX;
  assert.equal(contentAtBreakpoint, 992);
  assert.ok(contentAtBreakpoint < minContentWidthForDockPx());
  assert.ok(objectColumnFraction(contentAtBreakpoint, true) < 0.6);
  // So the viewport breakpoint alone would break the promise — the layout
  // must still say 'drawer' there, which is the whole reason both gates run.
  assert.equal(dockLayout({ expandedWorkspace: true, contentWidthPx: contentAtBreakpoint }), 'drawer');
  assert.equal(minViewportWidthForDockPx(), 1298);
  assert.equal(dockLayout({ expandedWorkspace: true, contentWidthPx: minContentWidthForDockPx() }), 'beside');
});

// ─── the header ─────────────────────────────────────────────────────────────

test('the header shows the title and a type pill, or the instruction', () => {
  assert.deepEqual(dockHeading(undefined), { title: DOCK_EMPTY_HEADING, empty: true });
  assert.deepEqual(dockHeading(article, 'Retinol after 40'), {
    title: 'Retinol after 40',
    typeLabel: 'Article',
    empty: false,
  });
  // A selection restored from the address names an object whose row this
  // surface may never have loaded — the id is the honest fallback.
  assert.deepEqual(dockHeading(page), { title: 'home', typeLabel: 'Page', empty: false });
  assert.deepEqual(dockHeading(page, '   '), { title: 'home', typeLabel: 'Page', empty: false });
});

test('an object type this admin has no label for still gets a readable pill', () => {
  assert.equal(dockHeading({ object_type: 'weather_widget', object_id: 'w1' }).typeLabel, 'Weather Widget');
});

test('the focus label names the object, and says so when there is none', () => {
  assert.equal(dockFocusLabel(article, 'Retinol after 40'), 'Article “Retinol after 40”');
  assert.equal(dockFocusLabel(undefined), 'nothing yet — select an object');
});

// ─── the selection survives a filter change, and vice versa ─────────────────

test('a rebuilt filter address keeps the selection', () => {
  // `RequestsWorkspace` composes its whole address from filter state, so the
  // selection has to be re-applied to whatever that produced.
  const filtered = requestsAddress({ quickFilter: 'done', kind: 'article', mine: true, q: 'retinol' });
  const withSelection = dockAddress(filtered, article);
  assert.ok(withSelection.startsWith('/admin/requests?'));
  const params = new URLSearchParams(withSelection.slice(withSelection.indexOf('?')));
  assert.equal(params.get('filter'), 'done');
  assert.equal(params.get('kind'), 'article');
  assert.equal(params.get('mine'), '1');
  assert.equal(params.get('q'), 'retinol');
  assert.equal(params.get('focus'), 'content_item:req_evergreen_retinol_20260901_01');
});

test('changing the filter after a selection keeps the selection, and vice versa', () => {
  const first = dockAddress('/admin/objects?type=page&view=grid', page);
  assert.equal(first, '/admin/objects?type=page&view=grid&focus=page%3Ahome');
  // The surface rebuilds its address from the NEW facets; re-applying the
  // same selection to it must not lose them.
  const afterFilterChange = dockAddress('/admin/objects?type=template', page);
  assert.equal(afterFilterChange, '/admin/objects?type=template&focus=page%3Ahome');
  // And a new selection on the same filters keeps the filters.
  assert.equal(
    dockAddress(afterFilterChange, article),
    '/admin/objects?type=template&focus=content_item%3Areq_evergreen_retinol_20260901_01'
  );
  // Clearing the selection leaves everything else alone.
  assert.equal(dockAddress(afterFilterChange, undefined), '/admin/objects?type=template');
});

// ─── the chat binding is lazy ───────────────────────────────────────────────

test('SELECTING issues nothing and mints nothing — ever', () => {
  assert.deepEqual(dockChatIntent('select', article, {}), { kind: 'idle' });
  // Not even when a chat for this selection is already known: a click is not
  // a request, and attaching would still be a poll this click did not ask for.
  assert.deepEqual(dockChatIntent('select', article, { 'content_item:req_evergreen_retinol_20260901_01': 'chat_1' }), {
    kind: 'idle',
  });
});

test('the FIRST send mints, every later send attaches', () => {
  const empty = {};
  assert.deepEqual(dockChatIntent('send', article, empty), { kind: 'mint', selection: article });
  const cache = rememberDockChat(empty, article, 'chat_1');
  assert.deepEqual(dockChatIntent('send', article, cache), { kind: 'attach', chatId: 'chat_1' });
  // A different selection is a different conversation.
  assert.deepEqual(dockChatIntent('send', page, cache), { kind: 'mint', selection: page });
  // `rememberDockChat` never mutates the cache it was handed.
  assert.deepEqual(empty, {});
});

test('a send with nothing selected is idle — there is no pair to bind', () => {
  assert.deepEqual(dockChatIntent('send', undefined, {}), { kind: 'idle' });
  assert.deepEqual(dockChatIntent('send', { object_type: 'page', object_id: '' }, {}), { kind: 'idle' });
});

test('rememberDockChat ignores a blank id and a selection that is not a pair', () => {
  assert.deepEqual(rememberDockChat({}, article, '  '), {});
  assert.deepEqual(rememberDockChat({}, { object_type: '', object_id: 'x' }, 'chat_1'), {});
});

// ─── the preference scope ───────────────────────────────────────────────────

test('the collapsed preference is scoped per viewer, per surface, per selection', () => {
  assert.equal(
    dockPreferenceScope('objects', 'editor@example.com', article),
    'editor@example.com:objects:content_item:req_evergreen_retinol_20260901_01'
  );
  // Two surfaces are not one fact.
  assert.notEqual(dockPreferenceScope('objects', 'e@x', page), dockPreferenceScope('requests', 'e@x', page));
  // The COLLAPSED preference omits the selection on purpose — it is a
  // property of the surface, so collapsing the dock survives the next row
  // click instead of being re-opened by it.
  assert.equal(dockPreferenceScope('objects', 'e@x'), dockPreferenceScope('objects', 'e@x'));
  assert.notEqual(dockPreferenceScope('objects', 'e@x'), dockPreferenceScope('objects', 'e@x', page));
  assert.equal(dockPreferenceScope('objects', undefined), 'anonymous:objects:');
  assert.equal(dockCollapsedStorageKey('a:b:c'), 'agent-dock-collapsed:v1:a:b:c');
  assert.equal(dockCollapsedStorageKey(undefined), 'agent-dock-collapsed:v1:default');
});
