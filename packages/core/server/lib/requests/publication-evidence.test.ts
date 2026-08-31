/**
 * Fixtures are trimmed from REAL `workflow_get_run` records on the dr-lurie
 * bridge, 2026-08-31 — the run behind the "Waiting for your approval" card
 * on an article that was already live (`run_1788161192916_2sguif`), and the
 * genuine holds around it. The wire facts this suite pins:
 *
 *   • an advisory entry carries `source: "policy_autonomous"` and the words
 *     "Advisory only — nothing is held";
 *   • a genuine hold carries NO `source` at all;
 *   • `release_executor` says `status: "executed"` only with
 *     `productionConfirmed: true` (its output schema forbids otherwise).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ADVISORY_APPROVAL_SOURCES,
  derivePublication,
  isAdvisoryApproval,
  publicationOutputsWorthReading,
} from './publication-evidence.js';
import {
  COMPACT_TAIL,
  GENUINE_HOLD,
  PUBLISH_OUTPUT_PENDING,
  RELEASE_OUTPUT_EXECUTED,
  RELEASE_OUTPUT_UNCONFIRMED,
  RETINOL_POLICY_RECORDS,
  WITHHELD_HOLD,
} from './publication-evidence.fixtures.js';

describe('isAdvisoryApproval — the enum value the wire actually carries', () => {
  it('names policy_autonomous as the advisory source', () => {
    assert.deepEqual([...ADVISORY_APPROVAL_SOURCES], ['policy_autonomous']);
  });

  it('classifies every retinol record as advisory', () => {
    for (const record of RETINOL_POLICY_RECORDS) assert.equal(isAdvisoryApproval(record), true, record.nodeId);
  });

  it('classifies by wording too, for a record that lost its source', () => {
    const { source: _source, ...withoutSource } = RETINOL_POLICY_RECORDS[0]!;
    assert.equal(isAdvisoryApproval(withoutSource), true);
  });

  it('never classifies a genuine hold as advisory — neither the dry-run gate nor the operator veto', () => {
    assert.equal(isAdvisoryApproval(GENUINE_HOLD), false);
    assert.equal(isAdvisoryApproval(WITHHELD_HOLD), false);
    assert.equal(isAdvisoryApproval({ nodeId: 'publication_controller', reason: 'approval_required' }), false);
  });

  it('is tolerant of junk', () => {
    assert.equal(isAdvisoryApproval(null), false);
    assert.equal(isAdvisoryApproval(undefined), false);
    assert.equal(isAdvisoryApproval({}), false);
    assert.equal(isAdvisoryApproval({ source: 42, reason: 7 }), false);
  });
});

describe("derivePublication — from the executors' own evidence", () => {
  it('is absent before a publish is committed', () => {
    assert.equal(derivePublication([{ nodeId: 'draft_writer', status: 'running' }]), undefined);
    assert.equal(derivePublication([{ nodeId: 'publish_executor', status: 'queued' }]), undefined);
    assert.equal(
      derivePublication([
        {
          nodeId: 'publish_executor',
          status: 'blocked',
          warnings: ['publication_decision_not_affirmative', 'no_publication_performed'],
        },
      ]),
      undefined
    );
    // Completed with no word left behind and no output: not enough to claim anything.
    assert.equal(derivePublication([{ nodeId: 'publish_executor', status: 'completed' }]), undefined);
  });

  it('reads the compact view: committed + not confirmed → pending, with the release warning as the reason', () => {
    const evidence = derivePublication(COMPACT_TAIL)!;
    assert.equal(evidence.state, 'published_pending_release');
    assert.equal(evidence.release_reason, 'release_not_confirmed');
    assert.equal(evidence.article_path, undefined, 'the compact view carries no receipt');
  });

  it('never fabricates "live" from the compact view alone', () => {
    const cleanRelease = COMPACT_TAIL.map((node) =>
      node.nodeId === 'release_executor' ? { nodeId: node.nodeId, status: 'completed' } : node
    );
    assert.equal(derivePublication(cleanRelease)!.state, 'published_pending_release');
  });

  it('reads the executor outputs (fetched separately): committed + unconfirmed release → pending with path, commit, blocker', () => {
    const evidence = derivePublication(COMPACT_TAIL, {
      publish_executor: PUBLISH_OUTPUT_PENDING,
      release_executor: RELEASE_OUTPUT_UNCONFIRMED,
    })!;
    assert.equal(evidence.state, 'published_pending_release');
    assert.equal(evidence.article_path, '/retinol-vs-bakuchiol-sensitive-skin');
    assert.equal(evidence.commit, '61f1b1827f38766b85beaa0bdd58ccdc82539f9c');
    assert.equal(evidence.published_at, '2026-08-31T07:37:26.344Z');
    assert.equal(evidence.release_reason, 'release_not_confirmed');
    assert.deepEqual(evidence.release_blockers, ['release_not_confirmed: MCP request failed with HTTP 504.']);
    assert.equal(evidence.deploy_id, undefined);
  });

  it('reads an executed release as LIVE, with the deploy id, and drops the release reason', () => {
    const evidence = derivePublication(COMPACT_TAIL, {
      publish_executor: PUBLISH_OUTPUT_PENDING,
      release_executor: RELEASE_OUTPUT_EXECUTED,
    })!;
    assert.equal(evidence.state, 'live');
    assert.equal(evidence.article_path, '/retinol-vs-bakuchiol-sensitive-skin');
    assert.equal(evidence.deploy_id, '6a92f3c558169f0008f28e47');
    assert.equal(evidence.commit, '61f1b1827f38766b85beaa0bdd58ccdc82539f9c');
    assert.equal(evidence.release_reason, undefined);
    assert.equal(evidence.release_blockers, undefined);
  });

  it('accepts the output on the node itself (the full run view) and the node_get_latest_output envelope', () => {
    const fullView = derivePublication([
      { nodeId: 'publish_executor', status: 'completed', output: PUBLISH_OUTPUT_PENDING },
      { nodeId: 'release_executor', status: 'completed', output: RELEASE_OUTPUT_EXECUTED },
    ])!;
    assert.equal(fullView.state, 'live');
    const envelope = derivePublication(COMPACT_TAIL, {
      publish_executor: { output: { id: 'artifact_1', nodeId: 'publish_executor', value: PUBLISH_OUTPUT_PENDING } },
      release_executor: { id: 'artifact_2', nodeId: 'release_executor', value: RELEASE_OUTPUT_EXECUTED },
    })!;
    assert.equal(envelope.state, 'live');
    assert.equal(envelope.deploy_id, '6a92f3c558169f0008f28e47');
  });

  it('a publish whose OWN verification confirmed production is live without a release node', () => {
    const evidence = derivePublication([{ nodeId: 'publish_executor', status: 'completed' }], {
      publish_executor: {
        ...PUBLISH_OUTPUT_PENDING,
        status: 'executed',
        verification: { deployStatus: 'ready', productionConfirmed: true },
      },
    })!;
    assert.equal(evidence.state, 'live');
  });

  it('a release that ran but reports blocked stays pending even when the publish output is missing', () => {
    const evidence = derivePublication(COMPACT_TAIL, { release_executor: RELEASE_OUTPUT_UNCONFIRMED })!;
    assert.equal(evidence.state, 'published_pending_release');
    assert.deepEqual(evidence.release_blockers, ['release_not_confirmed: MCP request failed with HTTP 504.']);
  });
});

describe('publicationOutputsWorthReading', () => {
  it('is false until publish_executor has completed', () => {
    assert.equal(publicationOutputsWorthReading([{ nodeId: 'publish_executor', status: 'queued' }]), false);
    assert.equal(publicationOutputsWorthReading([{ nodeId: 'publish_executor', status: 'blocked' }]), false);
    assert.equal(publicationOutputsWorthReading([]), false);
  });
  it('is true once it has', () => {
    assert.equal(publicationOutputsWorthReading(COMPACT_TAIL), true);
  });
});
