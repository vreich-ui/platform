/**
 * R7.3 — the one shared marker every synthetic-traffic drill/probe in this
 * repo stamps on requests that can reach the tracking loader or the
 * `kugel-data` sink: any ingest request carrying `x-trk-test: 1` is test
 * traffic, and the sink drops those rows from `/stats`, `/rollups`, and the
 * Thompson-weights job by default. Import this constant everywhere a drill
 * launches a browser context (Playwright `extraHTTPHeaders`, so the loader's
 * own beacon carries it) or makes a direct HTTP call against a live site or
 * the sink — never repeat the header literal.
 *
 * Drills/tests ONLY. Never set on a real user path, production runtime code,
 * or the tracking loader itself (`packages/core/lib/tracking/loader/`) — see
 * the R7.3 task brief.
 */
export const TEST_TRAFFIC_HEADER_NAME = 'x-trk-test';
export const TEST_TRAFFIC_HEADER_VALUE = '1';

/** Ready-to-spread header bag for `fetch`/Playwright `extraHTTPHeaders`. */
export const TEST_TRAFFIC_HEADERS = Object.freeze({
  [TEST_TRAFFIC_HEADER_NAME]: TEST_TRAFFIC_HEADER_VALUE,
});

/**
 * Merge the test-traffic marker into a Playwright `browser.newContext(...)`
 * options object, preserving whatever else the caller set (including a
 * caller-supplied `extraHTTPHeaders` bag — the marker always wins there,
 * since a drill's own headers should never be able to accidentally un-tag
 * its traffic).
 */
export const withTestTrafficHeaders = (options = {}) => ({
  ...options,
  extraHTTPHeaders: { ...(options.extraHTTPHeaders ?? {}), ...TEST_TRAFFIC_HEADERS },
});
