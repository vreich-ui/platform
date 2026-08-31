/**
 * Fixtures are trimmed from REAL production runs of `publishing_conductor`
 * (2026-08-21/22) — including the two that failed and the one that blocked on
 * approval. The point of this suite is that the projection tells an editor the
 * truth about those three, in their language, without throwing on wire data it
 * has not seen before.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { activityHeadline, estimateRemaining, projectActivity } from './activity.js';
import {
  COMPACT_TAIL,
  PUBLISH_OUTPUT_PENDING,
  RELEASE_OUTPUT_EXECUTED,
  RELEASE_OUTPUT_UNCONFIRMED,
  RETINOL_POLICY_RECORDS,
} from './publication-evidence.fixtures.js';

const TIMINGS = {
  research: { p50DurationMs: 31_742, p95DurationMs: 68_946, count: 12 },
  draft_writer: { p50DurationMs: 45_110, p95DurationMs: 65_322, count: 9 },
  article_body: { p50DurationMs: 18_019, p95DurationMs: 81_292, count: 8 },
  reader_simulation: { p50DurationMs: 34_814, p95DurationMs: 48_327, count: 10 },
};

/** The 2026-08-22 run that died at reader_simulation with seven nodes still queued. */
const failedRun = {
  runId: 'run_1787408495018_e97wrk',
  status: 'failed',
  currentNodeId: 'reader_simulation',
  nodeCount: 5,
  executionMode: 'openai',
  mode: { live: true },
  errors: ['reader_simulation:model_error'],
  approvalsRequired: [],
  nodes: [
    { nodeId: 'input_triage', status: 'completed', durationMs: 7093, produces: ['content_source.v1'] },
    {
      nodeId: 'research',
      status: 'completed',
      durationMs: 48_328,
      warnings: ['voice_prefetch_fallback:voice_prefetch_unreachable'],
      toolCalls: [
        { toolId: 'web.search', status: 'success', durationMs: 164 },
        { toolId: 'web.fetch', status: 'success', durationMs: 530 },
        { toolId: 'web.fetch', status: 'denied', errorCode: 'tool_call_limit_exceeded' },
      ],
    },
    { nodeId: 'draft_writer', status: 'completed', durationMs: 51_260 },
    {
      nodeId: 'reader_simulation',
      status: 'failed',
      durationMs: 40_029,
      errors: ['model_error', 'Invalid output type: Unterminated string in JSON at position 13494'],
    },
    { nodeId: 'article_body', status: 'queued' },
  ],
};

const failedCost = {
  ledger: {
    totalInputTokens: 184_387,
    totalOutputTokens: 24_189,
    totalTokens: 208_576,
    totalCostUsdEstimate: 1.647605,
    mostExpensiveNodeId: 'research',
    stages: [
      { nodeId: 'research', totalTokens: 132_603, costUsdEstimate: 0.72684 },
      { nodeId: 'draft_writer', totalTokens: 7199, costUsdEstimate: 0.117545 },
      { nodeId: 'article_body', totalTokens: 0, costUsdEstimate: 0 },
    ],
  },
  plan: {
    strategy: 'retry_node',
    retryNodeId: 'reader_simulation',
    reason:
      'Run failed at reader_simulation (model_error) with 14 completed stage(s) intact. workflow.retry_node with nodeId "reader_simulation" re-runs just that node and continues; nothing completed is recomputed.',
    reusableStages: ['input_triage', 'research', 'draft_writer'],
    nodeTimingAggregates: TIMINGS,
  },
};

describe('a run that died', () => {
  const view = projectActivity(failedRun, failedCost, Date.parse('2026-08-22T14:30:00.000Z'))!;

  it('names the step that stopped, in words an editor uses', () => {
    assert.equal(view.severity, 'failure');
    assert.equal(view.headline, 'Stopped at simulating a reader');
  });

  it("surfaces CMS-Agent's own recovery sentence, which nothing displayed before", () => {
    assert.equal(view.recovery?.strategy, 'retry_node');
    assert.equal(view.recovery?.node_id, 'reader_simulation');
    assert.match(String(view.recovery?.sentence), /nothing completed is recomputed/);
    assert.equal(view.recovery?.reusable_stages, 3);
  });

  it('shows what the run has already spent, and where', () => {
    assert.equal(view.cost?.usd, 1.647605);
    assert.equal(view.cost?.most_expensive_node, 'research');
    assert.equal(view.nodes.find((node) => node.id === 'research')?.cost?.tokens, 132_603);
  });

  it('keeps the every-run warning quiet and the real error loud', () => {
    const research = view.nodes.find((node) => node.id === 'research')!;
    assert.equal(research.severity, 'notice');
    assert.equal(research.warnings[0]?.label, 'Brand voice unavailable — used the fallback');
    const reader = view.nodes.find((node) => node.id === 'reader_simulation')!;
    assert.equal(reader.severity, 'failure');
    assert.deepEqual(reader.errors.slice(0, 1), ['model_error']);
  });

  it('lists the tools a node used, and treats the capped fetch as routine', () => {
    const research = view.nodes.find((node) => node.id === 'research')!;
    assert.deepEqual(
      research.tools.map((tool) => `${tool.id}:${tool.severity}`),
      ['web.search:ok', 'web.fetch:ok', 'web.fetch:notice']
    );
  });
});

/**
 * Task B (provider-error-details) — the failed node's `output.error`
 * (executor.ts, CMS-Agent PR #233) must reach the "Stopped at …" card: a
 * per-node `failure` on `ActivityNode`, and `operator_action` on the run's
 * `recovery`, so the UI can show WHY and stop offering a "Retry this step"
 * button that would only fail the same way again.
 */
describe('a run that died on a classified provider error', () => {
  const providerFailedRun = {
    runId: 'run_provider_quota',
    status: 'failed',
    currentNodeId: 'article_body',
    nodeCount: 2,
    executionMode: 'openai',
    mode: { live: true },
    errors: ['article_body:provider_quota'],
    approvalsRequired: [],
    nodes: [
      { nodeId: 'input_triage', status: 'completed', durationMs: 5000 },
      {
        nodeId: 'article_body',
        status: 'failed',
        durationMs: 900,
        errors: ['provider_quota', 'Node "article_body" received 429 from openai: Your credit balance is too low.'],
        output: {
          error: {
            code: 'provider_quota',
            message: 'Node "article_body" received 429 from openai: Your credit balance is too low.',
            providerStatus: 429,
            providerMessage: 'Your credit balance is too low',
            operatorAction: "Top up openai credit for this project's key, then workflow.retry_node article_body.",
          },
        },
      },
    ],
  };
  const providerFailedCost = {
    ledger: { totalInputTokens: 100, totalOutputTokens: 20, totalTokens: 120, totalCostUsdEstimate: 0.01, stages: [] },
    plan: {
      strategy: 'retry_node',
      retryNodeId: 'article_body',
      reason:
        'Run failed at article_body (provider_quota) — Your credit balance is too low. Top up openai credit ' +
        'for this project\'s key, then workflow.retry_node article_body. with 1 completed stage(s) intact. ' +
        'workflow.retry_node with nodeId "article_body" re-runs just that node and continues; nothing completed is recomputed.',
      reusableStages: ['input_triage'],
    },
  };

  it("carries the failed node's providerStatus/providerMessage/operatorAction", () => {
    const view = projectActivity(providerFailedRun, providerFailedCost)!;
    const node = view.nodes.find((n) => n.id === 'article_body')!;
    assert.equal(node.failure?.code, 'provider_quota');
    assert.equal(node.failure?.providerStatus, 429);
    assert.equal(node.failure?.providerMessage, 'Your credit balance is too low');
    assert.match(String(node.failure?.operatorAction), /Top up/);
  });

  it('surfaces operator_action on the run-level recovery, so the UI knows to hide the retry button', () => {
    const view = projectActivity(providerFailedRun, providerFailedCost)!;
    assert.match(String(view.recovery?.operator_action), /Top up/);
  });

  it('a node with no output.error carries no failure field (tolerant of every prior fixture)', () => {
    const view = projectActivity(providerFailedRun, providerFailedCost)!;
    const node = view.nodes.find((n) => n.id === 'input_triage')!;
    assert.equal(node.failure, undefined);
  });
});

describe('a run blocked on a human', () => {
  const blocked = {
    runId: 'run_blocked',
    status: 'blocked',
    nodeCount: 2,
    nodes: [
      { nodeId: 'publish_payload', status: 'completed', durationMs: 201 },
      {
        nodeId: 'publication_controller',
        status: 'blocked',
        warnings: ['approval_required', 'no_publication_performed'],
      },
    ],
    approvalsRequired: [
      {
        nodeId: 'publication_controller',
        type: 'approval_required',
        reason:
          'Publish-risk node publication_controller requires explicit approval; dry-run blocked before publishing.',
        requestedAt: '2026-08-21T15:25:48.488Z',
      },
    ],
  };

  it('says a human is needed, and never calls a held gate a failure', () => {
    const view = projectActivity(blocked, undefined)!;
    assert.equal(view.severity, 'attention');
    assert.equal(view.headline, 'Waiting for your approval');
    assert.equal(view.approvals[0]?.node_id, 'publication_controller');
    assert.match(String(view.approvals[0]?.reason), /requires explicit approval/);
    // (b) a genuine hold is unchanged by the advisory split: it is an approval, not a policy record.
    assert.equal(view.approvals.length, 1);
    assert.deepEqual(view.policy_records, []);
    assert.equal(view.publication, undefined);
  });
});

/**
 * 2026-08-31, dr-lurie, "Retinol vs. bakuchiol": 24/24 nodes complete, the
 * article published, and the card said "Waiting for your approval" with three
 * entries and Approve/Reject buttons — because CMS-Agent's three
 * `policy_autonomous` audit records sat in `approvalsRequired[]`.
 */
describe('a run that published under the autonomous policy', () => {
  const retinolRun = (overrides: Record<string, unknown> = {}) => ({
    runId: 'run_1788161192916_2sguif',
    requestId: 'req_agent_retinol_vs_bakuchiol_sensitive_skin_20260831_01',
    status: 'completed',
    executionMode: 'openai',
    mode: { live: true },
    operatorPublishDecision: 'approved',
    operatorDecisionSource: 'explicit',
    errors: [],
    approvalsRequired: RETINOL_POLICY_RECORDS,
    nodeCount: 6,
    nodes: [
      { nodeId: 'article_body', status: 'completed', durationMs: 49_636 },
      { nodeId: 'publish_payload', status: 'completed', durationMs: 2 },
      ...COMPACT_TAIL,
    ],
    ...overrides,
  });

  /** The tail as a confirmed release leaves it: no "not confirmed" warning on the release row. */
  const confirmedTail = COMPACT_TAIL.map((node) =>
    node.nodeId === 'release_executor' ? { nodeId: node.nodeId, status: 'completed', durationMs: 30_747 } : node
  );

  it('(a) three policy_autonomous entries + committed publish + confirmed release → "Live", no approvals, no amber', () => {
    const view = projectActivity(
      { run: retinolRun({ nodes: [{ nodeId: 'article_body', status: 'completed' }, ...confirmedTail] }), mode: { live: true }, stall: null },
      undefined,
      Date.now(),
      { nodeOutputs: { publish_executor: PUBLISH_OUTPUT_PENDING, release_executor: RELEASE_OUTPUT_EXECUTED } }
    )!;
    assert.equal(view.headline, 'Live');
    // `publish_committed_pending_release` on the publish row is a quiet notice
    // (muted grey) — nothing amber, nothing red, on a run that went live.
    assert.equal(view.severity, 'notice');
    assert.deepEqual(view.approvals, [], 'nothing waits on a human — the buttons must not exist');
    assert.equal(view.policy_records.length, 3);
    assert.deepEqual(
      view.policy_records.map((record) => record.node_id),
      ['publication_controller', 'publish_executor', 'release_executor']
    );
    assert.equal(view.policy_records[0]?.source, 'policy_autonomous');
    assert.match(view.policy_records[0]?.reason ?? '', /Advisory only — nothing is held/);
    assert.equal(view.publication?.state, 'live');
    assert.equal(view.publication?.article_path, '/retinol-vs-bakuchiol-sensitive-skin');
    assert.equal(view.publication?.deploy_id, '6a92f3c558169f0008f28e47');
    assert.equal(view.publication?.commit, '61f1b1827f38766b85beaa0bdd58ccdc82539f9c');
  });

  it('(c) publish committed, release unconfirmed → "awaiting release confirmation", still no buttons', () => {
    const view = projectActivity(retinolRun(), undefined, Date.now(), {
      nodeOutputs: { publish_executor: PUBLISH_OUTPUT_PENDING, release_executor: RELEASE_OUTPUT_UNCONFIRMED },
    })!;
    assert.equal(view.headline, 'Published — awaiting release confirmation');
    assert.deepEqual(view.approvals, []);
    assert.equal(view.policy_records.length, 3);
    assert.equal(view.publication?.state, 'published_pending_release');
    assert.equal(view.publication?.article_path, '/retinol-vs-bakuchiol-sensitive-skin');
    assert.equal(view.publication?.release_reason, 'release_not_confirmed');
    assert.equal(view.severity, 'attention', 'amber — a human should check the deploy; nothing died');
  });

  it('(c′) with only the compact view (no outputs readable) it still says pending, never "Live"', () => {
    const view = projectActivity(retinolRun(), undefined)!;
    assert.equal(view.headline, 'Published — awaiting release confirmation');
    assert.equal(view.publication?.state, 'published_pending_release');
    assert.equal(view.publication?.article_path, undefined);
    assert.deepEqual(view.approvals, []);
  });

  it('a genuine hold alongside advisory records still wins the headline', () => {
    const view = projectActivity(
      retinolRun({
        status: 'blocked',
        approvalsRequired: [
          ...RETINOL_POLICY_RECORDS,
          {
            nodeId: 'publication_controller',
            type: 'approval_required',
            reason: 'Publish-risk node publication_controller requires explicit approval; dry-run blocked before publishing.',
          },
        ],
      }),
      undefined
    )!;
    assert.equal(view.headline, 'Waiting for your approval');
    assert.equal(view.approvals.length, 1);
    assert.equal(view.policy_records.length, 3);
  });
});

describe('a run in flight', () => {
  const now = Date.parse('2026-08-22T10:00:30.000Z');
  const running = {
    runId: 'run_live',
    status: 'running',
    nodeCount: 4,
    nodes: [
      { nodeId: 'input_triage', status: 'completed', durationMs: 7000 },
      { nodeId: 'research', status: 'completed', durationMs: 30_000 },
      { nodeId: 'draft_writer', status: 'running', startedAt: '2026-08-22T10:00:00.000Z' },
      { nodeId: 'article_body', status: 'queued' },
    ],
  };

  it('says what it is doing right now', () => {
    const view = projectActivity(running, { plan: { nodeTimingAggregates: TIMINGS } }, now)!;
    assert.equal(view.headline, 'Drafting');
    assert.deepEqual(view.progress, { done: 2, total: 4, failed: 0, running: 1, skipped: 0 });
  });

  it('estimates what is left from measured history, discounting the running node', () => {
    const view = projectActivity(running, { plan: { nodeTimingAggregates: TIMINGS } }, now)!;
    // draft_writer p50 45_110 − 30_000 elapsed, plus article_body p50 18_019.
    assert.equal(view.eta?.p50_ms, 33_129);
    assert.equal(view.eta?.based_on_runs, 8);
    assert.ok(view.eta!.p95_ms > view.eta!.p50_ms);
  });

  it('flags a node that has already passed its own p95, rather than pretending it is fine', () => {
    const late = {
      ...running,
      nodes: [{ nodeId: 'draft_writer', status: 'running', startedAt: '2026-08-22T09:57:00.000Z' }],
    };
    const view = projectActivity(late, { plan: { nodeTimingAggregates: TIMINGS } }, now)!;
    assert.equal(view.nodes[0]?.overrunning, true);
  });

  it('offers no estimate at all when the workflow has no history — better nothing than a made-up number', () => {
    const view = projectActivity(running, undefined, now)!;
    assert.equal(view.eta, undefined);
  });
});

describe('a skipped node', () => {
  it('reads as a decision with a reason, not as a problem', () => {
    const view = projectActivity(
      {
        runId: 'run_skip',
        status: 'running',
        nodes: [
          {
            nodeId: 'artifact_plan',
            status: 'skipped',
            warnings: ['node_skipped:no_media_slots'],
            skip: { reason: 'artifact_plan skipped: mediaSlots is declared and empty — no media slot exists to plan.' },
          },
        ],
      },
      undefined
    )!;
    assert.equal(view.nodes[0]?.severity, 'ok');
    assert.match(String(view.nodes[0]?.skip_reason), /no media slot exists to plan/);
    assert.equal(view.progress.done, 1, 'a skipped node is settled, not pending');
  });
});

describe('wire data it has never seen', () => {
  it('never throws, and never invents a run', () => {
    for (const garbage of [
      undefined,
      null,
      'a string',
      42,
      {},
      { runId: 'x' },
      { runId: 'x', nodes: 'not-an-array' },
    ]) {
      assert.doesNotThrow(() => projectActivity(garbage, garbage));
    }
    assert.equal(projectActivity({}, {}), undefined, 'no run id means no view');
    assert.equal(projectActivity({ runId: 'x' }, {})?.nodes.length, 0);
  });

  it('bounds what it will project, however large the run', () => {
    const huge = {
      runId: 'run_huge',
      status: 'running',
      nodes: Array.from({ length: 300 }, (_, index) => ({
        nodeId: `node_${index}`,
        status: 'completed',
        toolCalls: Array.from({ length: 40 }, () => ({ toolId: 'web.fetch', status: 'success' })),
      })),
    };
    const view = projectActivity(huge, undefined)!;
    assert.equal(view.nodes.length, 64);
    assert.equal(view.nodes[0]?.tools.length, 12);
  });
});

describe('the collapsed headline', () => {
  it('puts a human gate above everything else, including a failure', () => {
    assert.equal(
      activityHeadline({ status: 'failed', severity: 'failure', failedLabel: 'drafting', approvals: 1 }),
      'Waiting for your approval'
    );
  });

  it('falls back sensibly with nothing to go on', () => {
    assert.equal(activityHeadline({ status: 'running', severity: 'ok', approvals: 0 }), 'Working');
    assert.equal(activityHeadline({ status: 'queued', severity: 'ok', approvals: 0 }), 'Starting');
    assert.equal(activityHeadline({ status: 'completed', severity: 'ok', approvals: 0 }), 'Finished');
  });
});

describe('the estimator on its own', () => {
  it('counts only unsettled nodes', () => {
    const eta = estimateRemaining(
      [
        { id: 'research', status: 'completed' },
        { id: 'draft_writer', status: 'queued' },
      ],
      TIMINGS,
      Date.now()
    );
    assert.equal(eta?.p50_ms, 45_110);
  });

  it('never returns a negative estimate for a node that has already overrun', () => {
    const eta = estimateRemaining(
      [{ id: 'draft_writer', status: 'running', started_at: '2026-08-22T09:00:00.000Z' }],
      TIMINGS,
      Date.parse('2026-08-22T10:00:00.000Z')
    );
    assert.equal(eta?.p50_ms, 0);
  });
});

// ─── regressions from the W19 adversarial review ─────────────────────────────

describe('a node that was retried', () => {
  it('shows what it cost across BOTH attempts, not just the cheap one', () => {
    const view = projectActivity(
      { runId: 'run_retry', status: 'running', nodes: [{ nodeId: 'research', status: 'completed' }] },
      {
        ledger: {
          totalTokens: 152_000,
          stages: [
            { nodeId: 'research', totalTokens: 150_000, costUsdEstimate: 0.8 },
            { nodeId: 'research', totalTokens: 2000, costUsdEstimate: 0.01 },
          ],
        },
      }
    )!;
    assert.equal(view.nodes[0]?.cost?.tokens, 152_000);
    assert.ok(Math.abs((view.nodes[0]?.cost?.usd ?? 0) - 0.81) < 1e-9);
  });
});

describe('the estimate is only offered where it means something', () => {
  it('is withheld from a run that is not going anywhere', () => {
    const stopped = {
      runId: 'run_dead',
      status: 'failed',
      nodes: [
        { nodeId: 'draft_writer', status: 'failed', errors: ['model_error'] },
        { nodeId: 'article_body', status: 'queued' },
      ],
    };
    const view = projectActivity(stopped, { plan: { nodeTimingAggregates: TIMINGS } })!;
    assert.equal(view.eta, undefined, 'a stopped run must not advertise "~6m left"');
  });

  it('survives an unparseable start time instead of serialising the estimate as null', () => {
    const view = projectActivity(
      {
        runId: 'run_bad_clock',
        status: 'running',
        nodes: [
          { nodeId: 'draft_writer', status: 'running', startedAt: 'not-a-timestamp' },
          { nodeId: 'article_body', status: 'queued' },
        ],
      },
      { plan: { nodeTimingAggregates: TIMINGS } }
    )!;
    assert.ok(Number.isFinite(view.eta?.p50_ms), 'the ETA must be a real number');
    assert.equal(JSON.parse(JSON.stringify(view)).eta.p50_ms, 63_129);
  });
});

describe('a workflow larger than the projection cap', () => {
  it('reports a total the bar can actually reach', () => {
    const view = projectActivity(
      {
        runId: 'run_big',
        status: 'running',
        nodeCount: 80,
        nodes: Array.from({ length: 80 }, (_, index) => ({ nodeId: `n${index}`, status: 'completed' })),
      },
      undefined
    )!;
    assert.equal(view.nodes.length, 64);
    assert.equal(view.progress.done, view.progress.total, 'a fully complete run must read as complete');
  });

  it('spends the tool budget on real calls, not on malformed rows', () => {
    const view = projectActivity(
      {
        runId: 'run_junk',
        status: 'running',
        nodes: [
          {
            nodeId: 'research',
            status: 'completed',
            toolCalls: [
              null,
              'nonsense',
              7,
              ...Array.from({ length: 3 }, () => ({ toolId: 'web.fetch', status: 'success' })),
            ],
          },
        ],
      },
      undefined
    )!;
    assert.equal(view.nodes[0]?.tools.length, 3);
  });
});
