import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  DERIVED_REQUEST_STATUSES,
  MAX_NUDGES,
  STALL_AFTER_MS,
  deriveRequestStatus,
  type ChatSnapshot,
  type RunNodeSnapshot,
  type RunSnapshot,
} from './derive-status.js';

// ─── one shared realistic fixture (a real production workflow_get_run row, ──
// ─── expanded to its full 23 nodes), with variants derived from it ──────────

const NOW = Date.parse('2026-08-22T14:30:00.000Z'); // just after the fixture's updatedAt
const NOW_LATE = Date.parse('2026-08-22T15:00:00.000Z'); // > STALL_AFTER_MS after every fixture timestamp

const APPROVAL_REASON =
  'Publish-risk node publication_controller requires explicit approval; dry-run blocked before publishing.';
const SKIP_REASON = 'Media slot fill skipped: mediaSlots is declared and empty for this brief.';

const node = (nodeId: string, status: string, extra: Partial<RunNodeSnapshot> = {}): RunNodeSnapshot => ({
  nodeId,
  status,
  ...extra,
});

/** Fresh copy per call so tests can mutate variants without cross-talk. */
const realRun = (): RunSnapshot => ({
  runId: 'run_1787408495018_e97wrk',
  workflowId: 'publishing_conductor',
  projectId: 'dr-lurie',
  status: 'failed',
  currentNodeId: 'reader_simulation',
  startedAt: '2026-08-22T14:21:35.018Z',
  updatedAt: '2026-08-22T14:28:35.940Z',
  nodes: [
    node('input_triage', 'completed', {
      startedAt: '2026-08-22T14:21:35.020Z',
      completedAt: '2026-08-22T14:21:42.113Z',
      durationMs: 7093,
      lastDispatch: {
        dispatchedAt: '2026-08-22T14:21:35.020Z',
        driver: 'continuation_tick',
        projectEndpointConfigured: true,
      },
    }),
    node('research', 'completed', { durationMs: 48_000 }),
    node('brief_architect', 'completed', { durationMs: 66_000 }),
    node('capture_emit_live', 'completed', { durationMs: 129_000 }),
    node('draft_writer', 'completed'),
    node('headline_lab', 'completed'),
    node('seo_mapper', 'completed'),
    node('claim_verifier', 'completed'),
    node('compliance_screen', 'completed'),
    node('style_polisher', 'completed'),
    node('reader_simulation', 'failed', {
      durationMs: 40_029,
      errors: ['model_error', 'Invalid output type: Unterminated string in JSON at position 13494'],
    }),
    node('artifact_plan', 'skipped', { skip: { reason: SKIP_REASON } }),
    node('review_aggregator', 'queued'),
    node('image_director', 'queued'),
    node('media_importer', 'queued'),
    node('internal_linker', 'queued'),
    node('taxonomy_mapper', 'queued'),
    node('quality_gate', 'queued'),
    node('score_card', 'queued'),
    node('review_room', 'queued'),
    node('artifact_uploader', 'queued'),
    node('publication_controller', 'queued'),
    node('release_manager', 'queued'),
  ],
  nodeCount: 23,
  artifactCount: 14,
  errors: ['reader_simulation:model_error'],
  approvalsRequired: [
    {
      nodeId: 'publication_controller',
      type: 'approval_required',
      reason: APPROVAL_REASON,
      requestedAt: '2026-08-21T15:25:48.488Z',
    },
  ],
  stall: { stalled: false },
});

const withRun = (overrides: Partial<RunSnapshot>): RunSnapshot => ({ ...realRun(), ...overrides });

const withNodeStatus = (run: RunSnapshot, nodeId: string, status: string): RunSnapshot => ({
  ...run,
  nodes: (run.nodes ?? []).map((n) => (n.nodeId === nodeId ? { ...n, status } : n)),
});

/** The fixture as a healthy in-flight run: no failure, no outstanding approval. */
const runningRun = (): RunSnapshot =>
  withNodeStatus(withRun({ status: 'running', approvalsRequired: [], errors: [] }), 'reader_simulation', 'running');

/** The fixture with every stall signal dead (evaluate at NOW_LATE) and no failed node. */
const stalledRun = (): RunSnapshot => ({ ...runningRun(), stall: { stalled: true } });

const chat = (status: string): ChatSnapshot => ({ status, updated_at: '2026-08-22T14:29:00.000Z' });

const iso = (ms: number): string => new Date(ms).toISOString();

// ─── exports ────────────────────────────────────────────────────────────────

describe('exports', () => {
  it('exposes the derived-status union members, frozen and in order (archived is never derived)', () => {
    assert.deepStrictEqual(
      [...DERIVED_REQUEST_STATUSES],
      ['queued', 'running', 'needs_you', 'stalled', 'failed', 'done', 'cancelled']
    );
    assert.ok(Object.isFrozen(DERIVED_REQUEST_STATUSES));
  });

  it('exposes the D2 defaults: STALL_AFTER_MS 10 minutes, MAX_NUDGES 3', () => {
    assert.strictEqual(STALL_AFTER_MS, 10 * 60_000);
    assert.strictEqual(MAX_NUDGES, 3);
  });
});

// ─── plan §5.1 — one test per table row, named 1:1 ──────────────────────────

describe('plan §5.1 mapping table', () => {
  it('run queued, or created and not yet dispatched → queued', () => {
    const queued = deriveRequestStatus({ run: withRun({ status: 'queued', approvalsRequired: [] }), now: NOW });
    assert.strictEqual(queued.status, 'queued');
    assert.strictEqual(queued.nudgeable, false);

    const notDispatched = deriveRequestStatus({ now: NOW });
    assert.strictEqual(notDispatched.status, 'queued');
  });

  it('run running, stall.stalled false → running', () => {
    const derived = deriveRequestStatus({ run: runningRun(), now: NOW });
    assert.strictEqual(derived.status, 'running');
    assert.strictEqual(derived.nudgeable, false);
  });

  it('run running, stall.stalled true, or updated_at older than STALL_AFTER_MS → stalled', () => {
    // Both liveness signals dead: CMS-Agent flags the stall AND the doc is old.
    const flagged = deriveRequestStatus({ run: stalledRun(), now: NOW_LATE });
    assert.strictEqual(flagged.status, 'stalled');
    assert.ok(flagged.status_reason);
    assert.strictEqual(flagged.nudgeable, true);

    // No stall block at all, but nothing has moved for > STALL_AFTER_MS.
    const aged = deriveRequestStatus({ run: { ...runningRun(), stall: undefined }, now: NOW_LATE });
    assert.strictEqual(aged.status, 'stalled');
  });

  it('run blocked, or approvalsRequired non-empty → needs_you', () => {
    const blocked = deriveRequestStatus({ run: withRun({ status: 'blocked', approvalsRequired: [] }), now: NOW });
    assert.strictEqual(blocked.status, 'needs_you');
    assert.ok(blocked.status_reason);

    const approval = deriveRequestStatus({
      run: { ...runningRun(), approvalsRequired: realRun().approvalsRequired },
      now: NOW,
    });
    assert.strictEqual(approval.status, 'needs_you');
    // CMS-Agent's editor copy is used verbatim, never paraphrased.
    assert.strictEqual(approval.status_reason, APPROVAL_REASON);
    assert.strictEqual(approval.blockers[0].node_id, 'publication_controller');
    assert.strictEqual(approval.blockers[0].code, 'approval_required');
    assert.strictEqual(approval.blockers[0].at, '2026-08-21T15:25:48.488Z');
  });

  it('run paused → needs_you', () => {
    const derived = deriveRequestStatus({ run: withRun({ status: 'paused', approvalsRequired: [] }), now: NOW });
    assert.strictEqual(derived.status, 'needs_you');
    assert.ok(derived.status_reason);
    assert.strictEqual(derived.nudgeable, false);
  });

  it('run failed, or any node failed with the run not advancing → failed', () => {
    // The fixture verbatim: run status failed on reader_simulation.
    const failed = deriveRequestStatus({ run: realRun(), now: NOW });
    assert.strictEqual(failed.status, 'failed');
    // Editor sentence names the node in words; the machine code stays out of it…
    assert.match(failed.status_reason ?? '', /reader simulation/);
    assert.ok(!(failed.status_reason ?? '').includes('model_error'));
    // …and lives in the blocker instead, with CMS-Agent's message verbatim.
    const blocker = failed.blockers.find((b) => b.node_id === 'reader_simulation');
    assert.ok(blocker);
    assert.strictEqual(blocker.code, 'model_error');
    assert.match(blocker.message, /Unterminated string in JSON at position 13494/);

    // A run still marked running whose node failed and which has stopped advancing is failed, not stalled.
    const deadWithFailure = withNodeStatus(stalledRun(), 'reader_simulation', 'failed');
    const derived = deriveRequestStatus({ run: deadWithFailure, now: NOW_LATE });
    assert.strictEqual(derived.status, 'failed');
    assert.strictEqual(derived.nudgeable, false);
  });

  it('run completed, publish decision still outstanding → needs_you', () => {
    // An approvalsRequired entry still present outranks the completed status.
    const withApproval = deriveRequestStatus({ run: withRun({ status: 'completed' }), now: NOW });
    assert.strictEqual(withApproval.status, 'needs_you');
    assert.strictEqual(withApproval.status_reason, APPROVAL_REASON);

    // No approvals array left, but the publication_controller node never settled.
    const withOpenNode = deriveRequestStatus({
      run: withRun({ status: 'completed', approvalsRequired: [] }),
      now: NOW,
    });
    assert.strictEqual(withOpenNode.status, 'needs_you');
    assert.ok(withOpenNode.status_reason);
    assert.strictEqual(withOpenNode.blockers[0].code, 'publish_decision_outstanding');
    assert.strictEqual(withOpenNode.blockers[0].node_id, 'publication_controller');
  });

  it('run completed, nothing outstanding → done', () => {
    const settled = withRun({ status: 'completed', approvalsRequired: [], errors: [] });
    settled.nodes = (settled.nodes ?? []).map((n) =>
      n.status === 'completed' || n.status === 'skipped' ? n : { ...n, status: 'completed' }
    );
    const derived = deriveRequestStatus({ run: settled, now: NOW });
    assert.strictEqual(derived.status, 'done');
    assert.strictEqual(derived.nudgeable, false);
    assert.deepStrictEqual(derived.blockers, []);
  });

  it('run cancelled → cancelled', () => {
    const derived = deriveRequestStatus({ run: withRun({ status: 'cancelled' }), now: NOW });
    assert.strictEqual(derived.status, 'cancelled');
    assert.ok(derived.status_reason);
    assert.strictEqual(derived.nudgeable, false);
  });

  it('attached chat awaiting_approval / awaiting_candidate → needs_you (chat approval wins — it is the nearer gate)', () => {
    const approval = deriveRequestStatus({ run: runningRun(), chat: chat('awaiting_approval'), now: NOW });
    assert.strictEqual(approval.status, 'needs_you');
    assert.ok(approval.status_reason);
    assert.strictEqual(approval.blockers[0].code, 'chat_awaiting_approval');

    const candidate = deriveRequestStatus({ chat: chat('awaiting_candidate'), now: NOW });
    assert.strictEqual(candidate.status, 'needs_you');
    assert.ok(candidate.status_reason);
    assert.strictEqual(candidate.blockers[0].code, 'chat_awaiting_candidate');
  });
});

// ─── the two precedence rules ───────────────────────────────────────────────

describe('precedence rules', () => {
  it('chat awaiting_approval outranks the run state — even a failed run reads needs_you', () => {
    const derived = deriveRequestStatus({ run: realRun(), chat: chat('awaiting_approval'), now: NOW });
    assert.strictEqual(derived.status, 'needs_you');
    // The run's approval entry supplies the editor copy, verbatim.
    assert.strictEqual(derived.status_reason, APPROVAL_REASON);
  });

  it('a human gate is never stalled: an approval-blocked run with every stall signal firing reads needs_you', () => {
    const gated = { ...stalledRun(), approvalsRequired: realRun().approvalsRequired };
    const derived = deriveRequestStatus({ run: gated, now: NOW_LATE });
    assert.strictEqual(derived.status, 'needs_you');
    assert.strictEqual(derived.status_reason, APPROVAL_REASON);
    assert.strictEqual(derived.nudgeable, false);
  });
});

// ─── stall, honestly (§5.2) ─────────────────────────────────────────────────

describe('stall, honestly (§5.2)', () => {
  it('a merely slow node is not stalled: capture_emit_live running for 129 s reads running', () => {
    let slow = withRun({
      status: 'running',
      approvalsRequired: [],
      errors: [],
      stall: undefined,
      currentNodeId: 'capture_emit_live',
      updatedAt: iso(NOW - 129_000), // the node started 129 s ago and has produced nothing since
    });
    slow = withNodeStatus(slow, 'reader_simulation', 'completed');
    slow = withNodeStatus(slow, 'capture_emit_live', 'running');
    const derived = deriveRequestStatus({ run: slow, now: NOW });
    assert.strictEqual(derived.status, 'running');
    assert.strictEqual(derived.nudgeable, false);
  });

  it('a live dispatch heartbeat within STALL_AFTER_MS prevents a stall even when updated_at is old', () => {
    const heartbeat = { ...runningRun(), stall: undefined, updatedAt: iso(NOW - 40 * 60_000) };
    heartbeat.nodes = (heartbeat.nodes ?? []).map((n) =>
      n.nodeId === 'input_triage' ? { ...n, lastDispatch: { dispatchedAt: iso(NOW - 60_000) } } : n
    );
    const derived = deriveRequestStatus({ run: heartbeat, now: NOW });
    assert.strictEqual(derived.status, 'running');
  });

  it("CMS-Agent's stall.stalled true alone does not stall a run whose doc moved within STALL_AFTER_MS", () => {
    const moved = { ...stalledRun(), updatedAt: iso(NOW - 2 * 60_000) };
    const derived = deriveRequestStatus({ run: moved, now: NOW });
    assert.strictEqual(derived.status, 'running');
  });

  it('with both signals dead the run is stalled, nudgeable, and the reason is an editor sentence', () => {
    const derived = deriveRequestStatus({ run: stalledRun(), now: NOW_LATE });
    assert.strictEqual(derived.status, 'stalled');
    assert.strictEqual(derived.nudgeable, true);
    assert.ok(derived.status_reason);
    assert.ok(!derived.status_reason.includes('model_error'));
    assert.strictEqual(derived.blockers[0].code, 'stalled');
  });

  it('an approval-blocked run is never nudgeable', () => {
    const gated = { ...stalledRun(), approvalsRequired: realRun().approvalsRequired };
    const derived = deriveRequestStatus({ run: gated, now: NOW_LATE });
    assert.strictEqual(derived.nudgeable, false);
  });

  it('stallAfterMs is overridable through DeriveConfig', () => {
    const run = { ...runningRun(), stall: undefined, updatedAt: iso(NOW - 2 * 60_000) };
    const byDefault = deriveRequestStatus({ run, now: NOW });
    assert.strictEqual(byDefault.status, 'running');
    const tightened = deriveRequestStatus({ run, now: NOW, config: { stallAfterMs: 60_000 } });
    assert.strictEqual(tightened.status, 'stalled');
  });
});

// ─── tolerant of garbage and unknown wire shapes — none may throw ───────────

describe('tolerant of garbage and unknown wire shapes', () => {
  it('missing nodes: derives from the run status alone, with no progress block', () => {
    const derived = deriveRequestStatus({ run: withRun({ nodes: undefined }), now: NOW });
    assert.strictEqual(derived.status, 'failed'); // run status failed, no node detail
    assert.strictEqual(derived.progress, undefined);
    // The run-level '<node>:<code>' string still yields the machine blocker.
    assert.deepStrictEqual(derived.blockers, [
      { node_id: 'reader_simulation', code: 'model_error', message: 'reader_simulation:model_error' },
    ]);
  });

  it('stall as a bare boolean true is honoured once the transition window is also dead', () => {
    const derived = deriveRequestStatus({ run: { ...runningRun(), stall: true }, now: NOW_LATE });
    assert.strictEqual(derived.status, 'stalled');
  });

  it('stall as { stalled: true } and stall absent both derive without throwing', () => {
    assert.strictEqual(deriveRequestStatus({ run: stalledRun(), now: NOW_LATE }).status, 'stalled');
    assert.strictEqual(deriveRequestStatus({ run: { ...runningRun(), stall: undefined }, now: NOW }).status, 'running');
  });

  it("the projection shape (projectWorkspaceRun's stalled boolean + {id,status} nodes) derives correctly", () => {
    const projection: RunSnapshot = {
      run_id: 'run_1787408495018_e97wrk',
      status: 'running',
      stalled: false,
      nodes: [
        { id: 'input_triage', status: 'completed' },
        { id: 'draft_writer', status: 'running' },
      ],
    };
    const alive = deriveRequestStatus({ run: projection, now: NOW });
    assert.strictEqual(alive.status, 'running');
    assert.deepStrictEqual(alive.progress, { done: 1, total: 2, failed: 0, current_node: 'draft_writer' });

    // The projection carries no timestamps at all — CMS-Agent's own stalled
    // flag is then the only liveness signal, and it is believed.
    const dead = deriveRequestStatus({ run: { ...projection, stalled: true }, now: NOW });
    assert.strictEqual(dead.status, 'stalled');
  });

  it('an unknown run status yields running with a could-not-read reason, never a fabricated failed', () => {
    const derived = deriveRequestStatus({ run: withRun({ status: 'exploding', approvalsRequired: [] }), now: NOW });
    assert.strictEqual(derived.status, 'running');
    assert.match(derived.status_reason ?? '', /could not be read/);
    assert.strictEqual(derived.blockers[0].code, 'unreadable_run_state');
  });

  it('nodes: [] still counts progress from nodeCount without throwing', () => {
    const derived = deriveRequestStatus({
      run: withRun({ status: 'running', approvalsRequired: [], nodes: [] }),
      now: NOW,
    });
    assert.strictEqual(derived.status, 'running');
    assert.deepStrictEqual(derived.progress, { done: 0, total: 23, failed: 0, current_node: 'reader_simulation' });
  });

  it('null-ish fields everywhere do not throw and do not fabricate a failure', () => {
    const garbage = {
      status: null,
      nodes: null,
      stall: null,
      approvalsRequired: null,
      updatedAt: null,
      currentNodeId: null,
    } as unknown as RunSnapshot;
    const derived = deriveRequestStatus({ run: garbage, now: NOW });
    assert.strictEqual(derived.status, 'running');
    assert.match(derived.status_reason ?? '', /could not be read/);
  });

  it('a non-object run snapshot does not throw and reads as could-not-read running', () => {
    const derived = deriveRequestStatus({ run: 'garbage' as unknown as RunSnapshot, now: NOW });
    assert.strictEqual(derived.status, 'running');
    assert.match(derived.status_reason ?? '', /could not be read/);
  });

  it('an unknown chat status is ignored and the run governs', () => {
    const derived = deriveRequestStatus({ run: runningRun(), chat: { status: 'daydreaming' }, now: NOW });
    assert.strictEqual(derived.status, 'running');
  });

  it('an unusable clock never fabricates a stall', () => {
    const derived = deriveRequestStatus({ run: stalledRun(), now: Number.NaN });
    assert.strictEqual(derived.status, 'running');
  });

  it('an empty object run derives without throwing', () => {
    const derived = deriveRequestStatus({ run: {}, now: NOW });
    assert.strictEqual(derived.status, 'running');
    assert.deepStrictEqual(derived.blockers[0].code, 'unreadable_run_state');
  });
});

// ─── progress ───────────────────────────────────────────────────────────────

describe('progress', () => {
  it('counts the real 23-node run: skipped nodes are done, not failed', () => {
    const derived = deriveRequestStatus({ run: realRun(), now: NOW });
    // 10 completed + 1 skipped (artifact_plan) = 11 done; reader_simulation is the 1 failure.
    assert.deepStrictEqual(derived.progress, { done: 11, total: 23, failed: 1, current_node: 'reader_simulation' });
  });
});

// ─── editor copy ────────────────────────────────────────────────────────────

describe('editor copy', () => {
  it("a skipped run uses the current node's skip.reason verbatim", () => {
    const skipped = withRun({ status: 'skipped', approvalsRequired: [], currentNodeId: 'artifact_plan' });
    const derived = deriveRequestStatus({ run: skipped, now: NOW });
    assert.strictEqual(derived.status, 'cancelled');
    assert.strictEqual(derived.status_reason, SKIP_REASON);
  });

  it('status_reason is always populated for needs_you, stalled, failed and cancelled', () => {
    const cases = [
      deriveRequestStatus({ run: withRun({ status: 'completed' }), now: NOW }), // needs_you
      deriveRequestStatus({ run: stalledRun(), now: NOW_LATE }), // stalled
      deriveRequestStatus({ run: realRun(), now: NOW }), // failed
      deriveRequestStatus({ run: withRun({ status: 'cancelled' }), now: NOW }), // cancelled
    ];
    assert.deepStrictEqual(
      cases.map((c) => c.status),
      ['needs_you', 'stalled', 'failed', 'cancelled']
    );
    for (const derived of cases) {
      assert.ok(derived.status_reason && derived.status_reason.length > 0);
    }
  });
});
