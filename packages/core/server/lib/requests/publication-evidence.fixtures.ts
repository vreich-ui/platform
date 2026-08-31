/**
 * Shared fixtures, trimmed from REAL `workflow_get_run` records on the
 * dr-lurie bridge, 2026-08-31 — the run behind the "Waiting for your
 * approval" card on an article that was already live
 * (`run_1788161192916_2sguif`), and the genuine holds around it. Not a test
 * file: several suites import these, and a `.test.ts` imported by another
 * suite would run twice.
 */
export const ADVISORY_REASON = (node: string) =>
  `Publish-risk node ${node} proceeded under this project's autonomous publishing policy (autonomyMode: "autonomous"); no operator acted. Advisory only — nothing is held.`;

export const advisoryApproval = (node: string, requestedAt: string) => ({
  nodeId: node,
  type: 'approval_required',
  gateId: `gate.publishing.${node}`,
  reason: ADVISORY_REASON(node),
  requestedAt,
  source: 'policy_autonomous',
});

/** The three audit records on the retinol run, verbatim. */
export const RETINOL_POLICY_RECORDS = [
  advisoryApproval('publication_controller', '2026-08-31T07:37:19.739Z'),
  advisoryApproval('publish_executor', '2026-08-31T07:37:21.727Z'),
  advisoryApproval('release_executor', '2026-08-31T07:37:30.574Z'),
];

/** A genuine hold — an operator-gated project, dry-run blocked (no `source`). */
export const GENUINE_HOLD = {
  nodeId: 'publication_controller',
  type: 'approval_required',
  reason: 'Publish-risk node publication_controller requires explicit approval; dry-run blocked before publishing.',
  requestedAt: '2026-08-21T15:25:48.488Z',
};

/** The operator's veto, as `run_1787919896283_yybhg0` carries it (no `source` either). */
export const WITHHELD_HOLD = {
  nodeId: 'publication_controller',
  type: 'approval_required',
  gateId: 'gate.publishing.publication_controller',
  reason:
    'the operator\'s durable publish decision for this run (run.operatorPublishDecision, set via workflow.set_operator_publish_decision) is "withheld"; nothing publishes until the operator replaces it.',
  requestedAt: '2026-08-28T14:44:01.883Z',
};

/** `publish_execution.v1` from the retinol run, trimmed to the fields read here. */
export const PUBLISH_OUTPUT_PENDING = {
  artifact: 'publish_execution.v1',
  status: 'published_pending_release',
  publishCommitted: true,
  approvalMatched: true,
  publishAuthority: { mode: 'autonomous', source: 'policy_autonomous', operatorDecision: null },
  result: {
    structuredContent: {
      published: true,
      object_id: 'req_agent_retinol_vs_bakuchiol_sensitive_skin_20260831_01',
      published_time: '2026-08-31T07:37:26.344Z',
      receipt: { kind: 'object_export_commit', commit_sha: '61f1b1827f38766b85beaa0bdd58ccdc82539f9c' },
      article_path: '/retinol-vs-bakuchiol-sensitive-skin',
      production: { committed: true, live: false, article_path: '/retinol-vs-bakuchiol-sensitive-skin' },
    },
  },
  verification: { deployAware: false, goLiveConfirmed: false },
  blockers: [],
};

/** `release_execution.v1` from the same run — the release did NOT confirm. */
export const RELEASE_OUTPUT_UNCONFIRMED = {
  artifact: 'release_execution.v1',
  summary: 'release_executor did not confirm go-live: release_not_confirmed — MCP request failed with HTTP 504..',
  status: 'blocked',
  reason: 'release_not_confirmed',
  blockers: ['release_not_confirmed: MCP request failed with HTTP 504.'],
};

/** What the output schema requires of an executed release. */
export const RELEASE_OUTPUT_EXECUTED = {
  artifact: 'release_execution.v1',
  summary: 'Production confirmed serving 61f1b18.',
  status: 'executed',
  releaseId: '6a92f3c558169f0008f28e47',
  deployedSha: '61f1b1827f38766b85beaa0bdd58ccdc82539f9c',
  verification: { deployStatus: 'ready', productionConfirmed: true },
  result: { deployStatus: 'ready' },
  blockers: [],
};

/** The compact-view node rows of the retinol run's tail (no `output`). */
export const COMPACT_TAIL = [
  { nodeId: 'publication_controller', status: 'completed', durationMs: 76 },
  {
    nodeId: 'publish_executor',
    status: 'completed',
    warnings: ['publish_committed_pending_release'],
    durationMs: 7969,
  },
  { nodeId: 'release_executor', status: 'completed', warnings: ['release_not_confirmed'], durationMs: 30747 },
  { nodeId: 'learning_recorder', status: 'completed', durationMs: 97 },
];
