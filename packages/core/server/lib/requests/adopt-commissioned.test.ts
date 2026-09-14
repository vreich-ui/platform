/**
 * Track C — the adoption selector, as logic.
 *
 * Pure by construction (no store, no bridge, no clock), so every rule that
 * decides whether an unattended run becomes a visible request row is pinned
 * here rather than inside a sweep integration test nobody reads.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adoptableCommissionedRuns, commissionedTitle } from './adopt-commissioned.js';

const run = (over: Record<string, unknown> = {}) => ({
  run_id: 'run_1',
  request_id: 'req_planner_ceramide_20260914_01',
  workflow_id: 'publishing_conductor',
  project_id: 'dr-lurie',
  commissionedBy: 'editorial_planner',
  commissioningRationale: 'No ceramide explainer exists and recognition is the thinnest reader state.',
  instructions: 'Explain what ceramides do for a compromised barrier.\nLead with the diagnostic.',
  ...over,
});

describe('adoptableCommissionedRuns', () => {
  it('adopts a commissioned run with no request row yet', () => {
    const [adopted, ...rest] = adoptableCommissionedRuns([run()], new Set(), 'dr-lurie');
    assert.equal(rest.length, 0);
    assert.equal(adopted!.request_id, 'req_planner_ceramide_20260914_01');
    assert.equal(adopted!.commissioned_by, 'editorial_planner');
    assert.equal(adopted!.kind, 'article');
    assert.equal(adopted!.title, 'Explain what ceramides do for a compromised barrier.');
    assert.match(adopted!.brief_excerpt!, /^Explain what ceramides/);
    assert.equal(adopted!.commissioning_rationale, run().commissioningRationale);
  });

  it('never adopts a run a human started — no commissionedBy, no adoption', () => {
    assert.deepEqual(adoptableCommissionedRuns([run({ commissionedBy: undefined })], new Set(), 'dr-lurie'), []);
  });

  it('skips a run whose request row already exists', () => {
    const known = new Set(['req_planner_ceramide_20260914_01']);
    assert.deepEqual(adoptableCommissionedRuns([run()], known, 'dr-lurie'), []);
  });

  it('refuses a request id that does not match the grammar, rather than throwing later in the store', () => {
    assert.deepEqual(adoptableCommissionedRuns([run({ request_id: 'ceramides' })], new Set(), 'dr-lurie'), []);
    assert.deepEqual(adoptableCommissionedRuns([run({ request_id: undefined })], new Set(), 'dr-lurie'), []);
  });

  it('drops a run belonging to another project', () => {
    assert.deepEqual(adoptableCommissionedRuns([run({ project_id: 'fernwell' })], new Set(), 'dr-lurie'), []);
  });

  it('reads either spelling of the two planes and de-duplicates within one batch', () => {
    const snake = run({ commissionedBy: undefined, commissioned_by: 'editorial_planner', runId: 'run_1', run_id: undefined });
    const adopted = adoptableCommissionedRuns([run(), snake], new Set(), 'dr-lurie');
    assert.equal(adopted.length, 1);
  });

  it("reads the node count under the name the engine actually sends", () => {
    const [adopted] = adoptableCommissionedRuns([run({ nodeCount: 21 })], new Set(), 'dr-lurie');
    assert.equal(adopted!.node_total, 21);
  });

  it('falls back to the request id when a run carries no brief at all', () => {
    assert.equal(
      commissionedTitle({ request_id: 'req_planner_x_20260914_01', instructions: undefined }),
      'req_planner_x_20260914_01'
    );
  });
});
