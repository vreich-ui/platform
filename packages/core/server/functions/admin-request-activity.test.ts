/**
 * Bug B (budget-raise-card) — the request CONTRACT for the two new Owner-only
 * actions, added to the same allowlist `approve`/`withhold` already live on.
 * The full handler needs a real Netlify Identity-authenticated event (no
 * test-injection seam exists for `getAdminStateFromEvent` — the
 * `admin-requests.test.ts` precedent), so the Owner gate and the CMS-Agent
 * call sequence are proven at the unit level instead:
 * `budget-override.test.ts` (the two-call order) and
 * `admin-request-activity.ts`'s own gate is exercised end to end nowhere in
 * this repo's test suite for `approve`/`withhold` either — this file matches
 * that existing posture, not a new one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { requestSchema } from './admin-request-activity.js';

describe('admin-request-activity requestSchema', () => {
  it('accepts approve/withhold unchanged', () => {
    assert.equal(requestSchema.safeParse({ request_id: 'req_agent_x_20260822_01', action: 'approve' }).success, true);
    assert.equal(requestSchema.safeParse({ request_id: 'req_agent_x_20260822_01', action: 'withhold' }).success, true);
  });

  it('accepts both new budget actions with node_id and budget_usd', () => {
    for (const action of ['raise_node_budget_for_run', 'raise_node_budget_default']) {
      assert.equal(
        requestSchema.safeParse({
          request_id: 'req_agent_x_20260822_01',
          action,
          node_id: 'artifact_plan',
          budget_usd: 5,
        }).success,
        true,
        action
      );
    }
  });

  it('still parses with no action at all — a plain activity read', () => {
    assert.equal(requestSchema.safeParse({ request_id: 'req_agent_x_20260822_01' }).success, true);
  });

  it('rejects an unknown action', () => {
    assert.equal(
      requestSchema.safeParse({ request_id: 'req_agent_x_20260822_01', action: 'raise_node_budget' }).success,
      false
    );
  });

  it('rejects a non-positive budget_usd', () => {
    assert.equal(
      requestSchema.safeParse({
        request_id: 'req_agent_x_20260822_01',
        action: 'raise_node_budget_for_run',
        node_id: 'artifact_plan',
        budget_usd: 0,
      }).success,
      false
    );
  });
});
