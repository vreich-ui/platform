/**
 * CHAT-ORIGIN — the route → surface map, checked against the REAL route table.
 *
 * Same reasoning as `admin-nav-route-parity.test.ts` next door: a fixture list
 * of routes copied by hand drifts silently the moment a route is added, and the
 * surface slug is the one field of `context.origin` that has no other source of
 * truth. `parseShellRoutePatterns` reads the real `shell-routes.ts` (the app
 * tree is excluded from `tsconfig.test.json`, so it is parsed, not imported),
 * which means a NEW admin route fails this test until someone has decided what
 * it is called on the wire — or has accepted the `admin` fallback on purpose.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatCreateOrigin,
  chatSendOrigin,
  currentOriginSurface,
  originSurfaceForPath,
  UNKNOWN_ORIGIN_SURFACE,
} from './chat-origin.js';
import { parseShellRoutePatterns } from '../../cli/admin-parity.mjs';

/** The eight surfaces that mint chats today (the wire shape's documented set). */
const CHAT_MINTING_SURFACES: ReadonlyArray<readonly [route: string, surface: string]> = [
  ['/admin/agents', 'agents'],
  ['/admin/objects', 'objects'],
  ['/admin/requests', 'requests'],
  ['/admin/requests/req_flow_topic_20260916_01', 'requests'],
  ['/admin/content/page_home', 'object-workspace'],
  ['/admin/inventory', 'inventory'],
  ['/admin/editorial', 'home'],
  ['/admin/settings/visual-identity', 'visual-identity'],
  ['/admin/templates', 'templates'],
];

test('every surface that mints a chat maps to its documented slug', () => {
  for (const [route, surface] of CHAT_MINTING_SURFACES) {
    assert.equal(originSurfaceForPath(route), surface, `${route} must read as "${surface}"`);
  }
});

test('the bare /admin landing path is the home surface, not the unknown fallback', () => {
  assert.equal(originSurfaceForPath('/admin'), 'home');
  assert.equal(originSurfaceForPath('/admin/'), 'home');
});

test('every registered /admin/* route maps to a non-empty slug — never undefined, never empty', () => {
  const routes = parseShellRoutePatterns().filter((pattern: string) => pattern.startsWith('/admin'));
  assert.ok(routes.length > 10, 'sanity: the route table was parsed');
  for (const route of routes) {
    // A bracket segment is a real request path at runtime; substitute one so
    // the map is exercised the way the browser will exercise it.
    const concrete = route.replaceAll(/\[[^\]]+\]/g, 'obj_123');
    const surface = originSurfaceForPath(concrete);
    assert.equal(typeof surface, 'string', `${route} produced no slug`);
    assert.ok(surface.length > 0, `${route} produced an empty slug`);
    assert.match(surface, /^[a-z0-9-]+$/, `${route} produced a non-slug: ${surface}`);
  }
});

test('an unknown or non-admin route falls back to the admin slug rather than sending nothing', () => {
  assert.equal(originSurfaceForPath('/admin/something-nobody-has-built'), 'something-nobody-has-built');
  assert.equal(originSurfaceForPath('/'), UNKNOWN_ORIGIN_SURFACE);
  assert.equal(originSurfaceForPath(''), UNKNOWN_ORIGIN_SURFACE);
  assert.equal(originSurfaceForPath(undefined), UNKNOWN_ORIGIN_SURFACE);
  assert.equal(originSurfaceForPath('/blog/some-article'), UNKNOWN_ORIGIN_SURFACE);
});

test('query strings, hashes and trailing slashes are the same route', () => {
  assert.equal(originSurfaceForPath('/admin/agents?starter=article'), 'agents');
  assert.equal(originSurfaceForPath('/admin/agents/#thread'), 'agents');
  assert.equal(originSurfaceForPath('/admin/requests/req_1?tab=activity#node'), 'requests');
});

test('SSR (no window) answers the fallback slug instead of throwing', () => {
  assert.equal(typeof window, 'undefined', 'node:test runs without a DOM — that is the point');
  assert.equal(currentOriginSurface(), UNKNOWN_ORIGIN_SURFACE);
  assert.deepEqual(chatCreateOrigin(), { surface: UNKNOWN_ORIGIN_SURFACE });
  assert.deepEqual(chatCreateOrigin('article'), { surface: UNKNOWN_ORIGIN_SURFACE, starter: 'article' });
});

test('chatSendOrigin drops the empty parts and answers undefined when there is nothing to say', () => {
  assert.equal(chatSendOrigin(undefined), undefined);
  assert.equal(chatSendOrigin({}), undefined);
  assert.equal(chatSendOrigin({ request_id: '' }), undefined);
  assert.deepEqual(chatSendOrigin({ request_id: 'req_1' }), { request_id: 'req_1' });
  assert.deepEqual(chatSendOrigin({ request_id: 'req_1', run_id: 'run_9' }), {
    request_id: 'req_1',
    run_id: 'run_9',
  });
  // A half-built selection is not a selection — the pair travels together or not at all.
  assert.equal(chatSendOrigin({ selection: { object_type: 'page', object_id: '' } }), undefined);
  assert.deepEqual(chatSendOrigin({ selection: { object_type: 'page', object_id: 'page_home' } }), {
    selection: { object_type: 'page', object_id: 'page_home' },
  });
});
