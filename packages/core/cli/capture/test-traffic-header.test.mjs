/**
 * R7.3 — every headless-browser drill in the capture plane (and the
 * accept-router e2e smoke) tags its own traffic via `withTestTrafficHeaders`
 * so the loader's own beacon carries `x-trk-test: 1` and the sink's
 * `/stats`/`/rollups`/Thompson-weights job drop it by default. This proves
 * the shared helper actually stamps the header, and that it never lets a
 * caller's own `extraHTTPHeaders` accidentally clobber it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEST_TRAFFIC_HEADER_NAME,
  TEST_TRAFFIC_HEADER_VALUE,
  TEST_TRAFFIC_HEADERS,
  withTestTrafficHeaders,
} from './test-traffic-header.mjs';

test('the marker is the exact header the sink change (R7.3) expects', () => {
  assert.equal(TEST_TRAFFIC_HEADER_NAME, 'x-trk-test');
  assert.equal(TEST_TRAFFIC_HEADER_VALUE, '1');
  assert.deepEqual(TEST_TRAFFIC_HEADERS, { 'x-trk-test': '1' });
});

test('withTestTrafficHeaders() on no options still stamps the header', () => {
  const options = withTestTrafficHeaders();
  assert.deepEqual(options.extraHTTPHeaders, { 'x-trk-test': '1' });
});

test('withTestTrafficHeaders preserves every other newContext option untouched', () => {
  const options = withTestTrafficHeaders({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    userAgent: 'W12CaptureSpike/1.0',
  });
  assert.deepEqual(options.viewport, { width: 1440, height: 1000 });
  assert.equal(options.deviceScaleFactor, 1);
  assert.equal(options.userAgent, 'W12CaptureSpike/1.0');
  assert.deepEqual(options.extraHTTPHeaders, { 'x-trk-test': '1' });
});

test('withTestTrafficHeaders merges into (and never loses to) a caller-supplied extraHTTPHeaders bag', () => {
  const options = withTestTrafficHeaders({ extraHTTPHeaders: { 'x-custom': 'kept', 'x-trk-test': 'should-not-survive' } });
  assert.deepEqual(options.extraHTTPHeaders, { 'x-custom': 'kept', 'x-trk-test': '1' });
});
