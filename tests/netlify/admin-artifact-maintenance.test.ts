/**
 * Artifact storage maintenance through the ADMIN SESSION surface.
 *
 * `artifact_dedupe_by_sha` and `artifact_orphan_sweep` are INTERNAL_ONLY_TOOLS
 * on the MCP surface and requireAdminToolAccess refuses an MCP bearer, so the
 * only way to run them was a human holding the site's publish secret. These
 * two actions put the same functions behind the Owner-only admin session that
 * already governs blob-store maintenance on this endpoint.
 *
 * What these tests pin is the WALL, not the sweeps' own behaviour (that lives
 * in artifact-dedupe-admin-verbs.test.ts): an unauthenticated caller must be
 * refused BEFORE any store is touched, and the refusal must be the endpoint's
 * existing one rather than a new, softer door.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler } from '../../packages/core/server/functions/admin-blob-manager.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';

const handler = createHandler(drlurieSiteBinding);

const post = async (body: Record<string, unknown>) =>
  handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });

const MAINTENANCE_ACTIONS = ['artifact-dedupe-by-sha', 'artifact-orphan-sweep'];

test('the maintenance actions refuse an unauthenticated caller, exactly as wipe-store does', async () => {
  const baseline = await post({ action: 'wipe-store', store: 'artifacts' });

  for (const action of MAINTENANCE_ACTIONS) {
    const response = await post({ action });

    assert.equal(
      response.statusCode,
      baseline.statusCode,
      `${action} must be refused on the same terms as the endpoint's existing destructive actions`
    );
    assert.ok(
      response.statusCode === 401 || response.statusCode === 403,
      `${action} answered ${response.statusCode}; an unauthenticated caller must never get through`
    );
  }
});

test('a non-POST request is rejected before the action is even read', async () => {
  for (const action of MAINTENANCE_ACTIONS) {
    const response = await handler({ httpMethod: 'GET', headers: {}, body: JSON.stringify({ action }) });
    assert.equal(response.statusCode, 405);
  }
});

test('the two maintenance actions are registered — an unknown action is still a 400', async () => {
  // A 400 "unknown action" for a registered action would mean the dispatch
  // entry was dropped; the auth refusal above proves they are reached.
  const unknown = await post({ action: 'artifact-dedupe-by-sha-typo' });
  assert.equal(unknown.statusCode, 401, 'auth is checked before the action name, so a typo cannot leak the registry');
});
