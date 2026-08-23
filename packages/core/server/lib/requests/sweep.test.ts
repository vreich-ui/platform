/**
 * W19 T19.3 — the sweep's three rules, proven.
 *
 *  1. Only the sweeper writes a running request's status.
 *  2. An unreachable CMS-Agent is NOT a failed article.
 *  3. A human gate is never nudged, and a dead driver is nudged at most
 *     MAX_NUDGES times.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_NUDGES } from './derive-status.js';
import {
  SWEEP_TOKEN_TTL_MS,
  consumeSweepToken,
  createRequest,
  loadIndex,
  loadRequest,
  mintSweepToken,
  type EditorialRequestStore,
} from './store.js';
import {
  SWEEPABLE_STATUSES,
  SWEEP_BATCH_MAX,
  progressDetail,
  runSweep,
  selectSweepable,
  sweepRequest,
  type SweepBridge,
  type SweepChatSink,
} from './sweep.js';

const memoryStore = (): EditorialRequestStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key: string) => data.get(key) ?? null,
    setJSON: async (key: string, value: unknown) => {
      data.set(key, JSON.stringify(value));
    },
    list: async ({ prefix }: { prefix: string }) => ({
      blobs: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
    }),
  } as EditorialRequestStore & { data: Map<string, string> };
};

const REQUEST_ID = 'req_agent_retinol_20260822_01';

const seed = async (store: EditorialRequestStore, requestId = REQUEST_ID) =>
  createRequest(
    store,
    {
      request_id: requestId,
      kind: 'article',
      title: 'Retinol after 40',
      created_by: 'editor@example.com',
      chat: { chat_id: 'chat_1', kind: 'free' },
      workflow: { run_id: 'run_1', workflow_id: 'publishing_conductor', project_id: 'dr-lurie', node_total: 23 },
    },
    '2026-08-22T10:00:00.000Z'
  );

/** A live run, half-way through, with a fresh dispatch heartbeat. */
const liveRun = (nowIso: string) => ({
  runId: 'run_1',
  status: 'running',
  currentNodeId: 'draft_writer',
  updatedAt: nowIso,
  nodes: [
    { nodeId: 'input_triage', status: 'completed' },
    { nodeId: 'research', status: 'completed' },
    { nodeId: 'draft_writer', status: 'running', lastDispatch: { dispatchedAt: nowIso, driver: 'continuation_tick' } },
    { nodeId: 'article_body', status: 'queued' },
  ],
});

const bridgeFor = (
  run: unknown,
  calls: { get: number; advance: number } = { get: 0, advance: 0 }
): { bridge: SweepBridge; calls: typeof calls } => ({
  calls,
  bridge: {
    getRun: async () => {
      calls.get += 1;
      return { ok: true, data: run as Record<string, unknown> };
    },
    advance: async () => {
      calls.advance += 1;
      return { ok: true, data: {} };
    },
  },
});

const chatSink = (log: Array<{ chatId: string; detail: Record<string, unknown> }>, status?: string): SweepChatSink => ({
  appendProgress: async (chatId, detail) => {
    log.push({ chatId, detail });
  },
  chatStatus: async () => status,
});

describe('sweep selection', () => {
  it('polls only the non-terminal statuses, and never a terminal one', () => {
    assert.deepEqual([...SWEEPABLE_STATUSES].sort(), ['needs_you', 'queued', 'running', 'stalled']);
    const ids = selectSweepable([
      { request_id: 'a', status: 'running', updated_at: '2026-08-22T10:00:00.000Z' },
      { request_id: 'b', status: 'done', updated_at: '2026-08-22T11:00:00.000Z' },
      { request_id: 'c', status: 'archived', updated_at: '2026-08-22T12:00:00.000Z' },
      { request_id: 'd', status: 'needs_you', updated_at: '2026-08-22T13:00:00.000Z' },
      { request_id: 'e', status: 'cancelled', updated_at: '2026-08-22T14:00:00.000Z' },
      { request_id: 'f', status: 'failed', updated_at: '2026-08-22T15:00:00.000Z' },
    ]);
    // `failed` is excluded on purpose: it is terminal for the sweep. A human
    // retries it, which re-opens the run and puts the row back in scope.
    assert.deepEqual(ids, ['d', 'a']);
  });

  it('bounds a backlog so one pass cannot outrun the invocation', () => {
    const rows = Array.from({ length: SWEEP_BATCH_MAX + 25 }, (_, index) => ({
      request_id: `r${index}`,
      status: 'running' as const,
      updated_at: `2026-08-22T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    }));
    assert.equal(selectSweepable(rows).length, SWEEP_BATCH_MAX);
  });
});

describe('rule 2 — an unreachable bridge is not a failed article', () => {
  it('leaves the status untouched and reports why when the bridge is absent', async () => {
    const store = memoryStore();
    await seed(store);
    const outcome = await sweepRequest({ store }, REQUEST_ID);
    assert.equal(outcome?.to, 'queued');
    assert.equal(outcome?.changed, false);
    assert.equal(outcome?.unreachable, 'cms_agent_unavailable');
    assert.equal((await loadRequest(store, REQUEST_ID))?.status, 'queued');
  });

  it('leaves the status untouched when the bridge errors, and never invents `failed`', async () => {
    const store = memoryStore();
    await seed(store);
    const bridge: SweepBridge = {
      getRun: async () => ({ ok: false, code: 'mcp_unreachable', message: 'HTTP 503' }),
      advance: async () => ({ ok: false, code: 'mcp_unreachable', message: 'HTTP 503' }),
    };
    const outcome = await sweepRequest({ store, bridge }, REQUEST_ID);
    assert.equal(outcome?.unreachable, 'mcp_unreachable');
    assert.notEqual(outcome?.to, 'failed');
    assert.equal((await loadRequest(store, REQUEST_ID))?.status, 'queued');
  });

  it('survives a bridge that throws', async () => {
    const store = memoryStore();
    await seed(store);
    const bridge: SweepBridge = {
      getRun: async () => {
        throw new Error('socket hang up');
      },
      advance: async () => ({ ok: true, data: {} }),
    };
    const outcome = await sweepRequest({ store, bridge }, REQUEST_ID);
    assert.ok(outcome?.unreachable);
    assert.equal((await loadRequest(store, REQUEST_ID))?.status, 'queued');
  });
});

describe('rule 1 — the sweeper writes the status, and progress reaches the chat', () => {
  it('moves queued → running and appends one progress line to the attached chat', async () => {
    const nowIso = '2026-08-22T10:05:00.000Z';
    const store = memoryStore();
    await seed(store);
    const { bridge } = bridgeFor(liveRun(nowIso));
    const log: Array<{ chatId: string; detail: Record<string, unknown> }> = [];
    const outcome = await sweepRequest(
      { store, bridge, chats: chatSink(log), now: () => Date.parse(nowIso), nowIso: () => nowIso },
      REQUEST_ID
    );
    assert.equal(outcome?.to, 'running');
    assert.equal(outcome?.changed, true);
    assert.equal(log.length, 1);
    assert.equal(log[0]?.chatId, 'chat_1');
    assert.equal(log[0]?.detail.status, 'running');

    const doc = await loadRequest(store, REQUEST_ID);
    assert.equal(doc?.status, 'running');
    assert.equal(doc?.workflow?.node_done, 2);
    assert.equal(doc?.workflow?.node_total, 4);
    assert.equal(doc?.workflow?.current_node, 'draft_writer');
  });

  it('will not write over a request a human archived under it', async () => {
    const nowIso = '2026-08-22T10:05:00.000Z';
    const store = memoryStore();
    const seeded = await seed(store);
    const { archiveRequest } = await import('./store.js');
    await archiveRequest(store, seeded.request_id, 'owner@example.com');
    const { bridge } = bridgeFor(liveRun(nowIso));
    const log: Array<{ chatId: string; detail: Record<string, unknown> }> = [];
    await sweepRequest(
      { store, bridge, chats: chatSink(log), now: () => Date.parse(nowIso), nowIso: () => nowIso },
      REQUEST_ID
    );
    assert.equal((await loadRequest(store, REQUEST_ID))?.status, 'archived');
    assert.equal(log.length, 0);
  });

  it('a chat awaiting approval outranks a running run', async () => {
    const nowIso = '2026-08-22T10:05:00.000Z';
    const store = memoryStore();
    await seed(store);
    const { bridge } = bridgeFor(liveRun(nowIso));
    const outcome = await sweepRequest(
      {
        store,
        bridge,
        chats: chatSink([], 'awaiting_approval'),
        now: () => Date.parse(nowIso),
        nowIso: () => nowIso,
      },
      REQUEST_ID
    );
    assert.equal(outcome?.to, 'needs_you');
  });
});

describe('rule 3 — nudging', () => {
  /** A run whose driver died: no heartbeat, nothing moved for well over STALL_AFTER_MS. */
  const deadRun = {
    runId: 'run_1',
    status: 'running',
    currentNodeId: 'draft_writer',
    updatedAt: '2026-08-22T09:00:00.000Z',
    nodes: [
      { nodeId: 'input_triage', status: 'completed' },
      {
        nodeId: 'draft_writer',
        status: 'running',
        lastDispatch: { dispatchedAt: '2026-08-22T09:00:00.000Z', driver: 'continuation_tick' },
      },
    ],
  };
  const nowIso = '2026-08-22T10:00:00.000Z';

  it('nudges a dead driver once per pass and stops at MAX_NUDGES', async () => {
    const store = memoryStore();
    await seed(store);
    const calls = { get: 0, advance: 0 };
    const { bridge } = bridgeFor(deadRun, calls);
    const deps = { store, bridge, now: () => Date.parse(nowIso), nowIso: () => nowIso };
    for (let pass = 0; pass < MAX_NUDGES + 3; pass += 1) await sweepRequest(deps, REQUEST_ID);
    assert.equal(calls.advance, MAX_NUDGES);
    const doc = await loadRequest(store, REQUEST_ID);
    assert.equal(doc?.status, 'stalled');
    assert.equal(doc?.workflow?.nudges, MAX_NUDGES);
    assert.ok(doc?.status_reason, 'a stalled request must carry an editor-facing reason');
  });

  it('never nudges a run waiting on a human', async () => {
    const store = memoryStore();
    await seed(store);
    const calls = { get: 0, advance: 0 };
    const { bridge } = bridgeFor(
      {
        runId: 'run_1',
        status: 'blocked',
        currentNodeId: 'publication_controller',
        updatedAt: '2026-08-22T09:00:00.000Z',
        nodes: [{ nodeId: 'publication_controller', status: 'blocked' }],
        approvalsRequired: [
          {
            nodeId: 'publication_controller',
            type: 'approval_required',
            reason:
              'Publish-risk node publication_controller requires explicit approval; dry-run blocked before publishing.',
            requestedAt: '2026-08-22T09:00:00.000Z',
          },
        ],
      },
      calls
    );
    const outcome = await sweepRequest(
      { store, bridge, now: () => Date.parse(nowIso), nowIso: () => nowIso },
      REQUEST_ID
    );
    assert.equal(outcome?.to, 'needs_you');
    assert.equal(outcome?.nudged, false);
    assert.equal(calls.advance, 0);
    const doc = await loadRequest(store, REQUEST_ID);
    assert.equal(doc?.workflow?.approvals_required?.[0]?.node_id, 'publication_controller');
    // CMS-Agent's own editor copy is surfaced verbatim, not paraphrased.
    assert.match(String(doc?.status_reason), /approval/i);
  });
});

describe('a full pass', () => {
  it('sweeps every non-terminal request and stops cleanly when the invocation budget runs out', async () => {
    const nowIso = '2026-08-22T10:05:00.000Z';
    const store = memoryStore();
    await seed(store, 'req_agent_one_20260822_01');
    await seed(store, 'req_agent_two_20260822_01');
    const calls = { get: 0, advance: 0 };
    const { bridge } = bridgeFor(liveRun(nowIso), calls);

    const full = await runSweep({ store, bridge, now: () => Date.parse(nowIso), nowIso: () => nowIso });
    assert.equal(full.considered, 2);
    assert.equal(full.outcomes.length, 2);

    calls.get = 0;
    const starved = await runSweep({
      store,
      bridge,
      now: () => Date.parse(nowIso),
      nowIso: () => nowIso,
      remainingMs: () => 1_000,
    });
    assert.equal(starved.outcomes.length, 0, 'no per-request work starts with no budget left');
  });
});

describe('the progress line', () => {
  it('carries the editor sentence, the counts and the blockers — and nothing else', async () => {
    const store = memoryStore();
    const doc = await seed(store);
    const detail = progressDetail(doc, {
      status: 'needs_you',
      status_reason: 'Waiting for your approval to publish.',
      progress: { done: 21, total: 23, failed: 0, current_node: 'publication_controller' },
      blockers: [{ code: 'approval_required', message: 'approval', node_id: 'publication_controller' }],
      nudgeable: false,
    });
    assert.deepEqual(Object.keys(detail).sort(), [
      'blockers',
      'done',
      'node',
      'request_id',
      'status',
      'summary',
      'total',
    ]);
  });
});

// ─── regressions found by the W19 adversarial review ─────────────────────────

describe('a run the workflow itself ended', () => {
  const nowIso = '2026-08-22T10:05:00.000Z';

  it('records a CMS-Agent cancellation instead of dropping it and polling forever', async () => {
    const store = memoryStore();
    await seed(store);
    const { bridge } = bridgeFor({
      runId: 'run_1',
      status: 'cancelled',
      updatedAt: nowIso,
      nodes: [{ nodeId: 'input_triage', status: 'completed' }],
    });
    const outcome = await sweepRequest(
      { store, bridge, now: () => Date.parse(nowIso), nowIso: () => nowIso },
      REQUEST_ID
    );
    assert.equal(outcome?.to, 'cancelled');
    const doc = await loadRequest(store, REQUEST_ID);
    assert.equal(doc?.status, 'cancelled');
    // …and the row leaves the swept set, so the run is never polled again.
    const index = await loadIndex(store);
    assert.deepEqual(selectSweepable(index?.rows ?? []), []);
  });
});

describe('a stale index row that survived a lost write', () => {
  it('is reconciled by the sweeper, which is the only thing that would ever look at it again', async () => {
    const store = memoryStore();
    const doc = await seed(store);
    const { archiveRequest } = await import('./store.js');
    await archiveRequest(store, doc.request_id, 'owner@example.com');
    // Simulate the lost index write: put the row back as it was before.
    const index = await loadIndex(store);
    const stale = {
      ...index!,
      rows: index!.rows.map((row) => ({ ...row, status: 'running' as const, archived: false })),
    };
    await store.setJSON('requests/index.json', stale);
    assert.equal(selectSweepable((await loadIndex(store))!.rows).length, 1, 'the stale row is still selected');

    const calls = { get: 0, advance: 0 };
    const { bridge } = bridgeFor({ runId: 'run_1', status: 'running', nodes: [] }, calls);
    const outcome = await sweepRequest({ store, bridge }, REQUEST_ID);

    assert.equal(outcome?.repaired, true);
    assert.equal(calls.get, 0, 'a closed request costs no CMS-Agent read');
    assert.deepEqual(selectSweepable((await loadIndex(store))!.rows), [], 'and is never selected again');
  });
});

describe('an approval whose wire record carries no requestedAt', () => {
  it('does not re-announce itself every pass', async () => {
    const store = memoryStore();
    await seed(store);
    const blocked = {
      runId: 'run_1',
      status: 'blocked',
      currentNodeId: 'publication_controller',
      updatedAt: '2026-08-22T09:59:00.000Z',
      nodes: [{ nodeId: 'publication_controller', status: 'blocked' }],
      // No `requestedAt` — the contract tolerates it, and CMS-Agent omits it
      // on some shapes. Stamping `now` here used to churn the doc every pass.
      approvalsRequired: [
        { nodeId: 'publication_controller', type: 'approval_required', reason: 'Approval required.' },
      ],
    };
    const log: Array<{ chatId: string; detail: Record<string, unknown> }> = [];
    const { bridge } = bridgeFor(blocked);
    let clock = Date.parse('2026-08-22T10:00:00.000Z');
    for (let pass = 0; pass < 3; pass += 1) {
      const at = new Date(clock).toISOString();
      await sweepRequest({ store, bridge, chats: chatSink(log), now: () => clock, nowIso: () => at }, REQUEST_ID);
      clock += 5 * 60_000;
    }
    assert.equal(log.length, 1, 'one announcement for one approval, not one per five minutes');
    const doc = await loadRequest(store, REQUEST_ID);
    assert.equal(doc?.history.filter((entry) => entry.status === 'needs_you').length, 1);
  });
});

describe('the nudge budget', () => {
  it('is restored when the run actually moves forward again', async () => {
    const store = memoryStore();
    await seed(store);
    const dead = {
      runId: 'run_1',
      status: 'running',
      currentNodeId: 'draft_writer',
      updatedAt: '2026-08-22T09:00:00.000Z',
      nodes: [
        { nodeId: 'input_triage', status: 'completed' },
        { nodeId: 'draft_writer', status: 'running' },
      ],
    };
    const nowIso = '2026-08-22T10:00:00.000Z';
    const { bridge } = bridgeFor(dead);
    await sweepRequest({ store, bridge, now: () => Date.parse(nowIso), nowIso: () => nowIso }, REQUEST_ID);
    assert.equal((await loadRequest(store, REQUEST_ID))?.workflow?.nudges, 1);

    // The nudge worked: the run advanced.
    const revivedIso = '2026-08-22T10:05:00.000Z';
    const { bridge: revived } = bridgeFor({
      runId: 'run_1',
      status: 'running',
      currentNodeId: 'article_body',
      updatedAt: revivedIso,
      nodes: [
        { nodeId: 'input_triage', status: 'completed' },
        { nodeId: 'draft_writer', status: 'completed' },
        { nodeId: 'article_body', status: 'running', lastDispatch: { dispatchedAt: revivedIso } },
      ],
    });
    await sweepRequest(
      { store, bridge: revived, now: () => Date.parse(revivedIso), nowIso: () => revivedIso },
      REQUEST_ID
    );
    assert.equal((await loadRequest(store, REQUEST_ID))?.workflow?.nudges, 0, 'forward progress earns the budget back');
  });
});

describe('a human archiving while the pass is mid-poll', () => {
  it('writes nothing, announces nothing, and repairs the row', async () => {
    const store = memoryStore();
    const doc = await seed(store);
    const { archiveRequest } = await import('./store.js');
    const log: Array<{ chatId: string; detail: Record<string, unknown> }> = [];
    const nowIso = '2026-08-22T10:05:00.000Z';
    // The archive lands DURING the CMS-Agent read — the real race window.
    const bridge: SweepBridge = {
      getRun: async () => {
        await archiveRequest(store, doc.request_id, 'owner@example.com');
        return { ok: true, data: liveRun(nowIso) as unknown as Record<string, unknown> };
      },
      advance: async () => ({ ok: true, data: {} }),
    };
    const outcome = await sweepRequest(
      { store, bridge, chats: chatSink(log), now: () => Date.parse(nowIso), nowIso: () => nowIso },
      REQUEST_ID
    );
    assert.equal(outcome?.changed, false);
    assert.equal(outcome?.repaired, true);
    assert.equal(log.length, 0, 'no progress line into the chat of a request the human just closed');
    assert.equal((await loadRequest(store, REQUEST_ID))?.status, 'archived');
  });
});

describe('the sweep trigger token', () => {
  it('is one-shot, mint-scoped and TTL-bounded — a background function is a public endpoint', async () => {
    const store = memoryStore();
    const token = await mintSweepToken(store, '2026-08-22T10:00:00.000Z');
    const nowMs = Date.parse('2026-08-22T10:01:00.000Z');

    assert.equal(await consumeSweepToken(store, 'forged', nowMs), false, 'a forged token is refused');
    assert.equal(await consumeSweepToken(store, token, nowMs), true, 'the minted token works once');
    assert.equal(await consumeSweepToken(store, token, nowMs), false, 'and only once — a replay is inert');

    const second = await mintSweepToken(store, '2026-08-22T10:00:00.000Z');
    assert.equal(
      await consumeSweepToken(store, second, nowMs + SWEEP_TOKEN_TTL_MS + 1),
      false,
      'a token that outlived its TTL is refused even unconsumed'
    );

    const third = await mintSweepToken(store, '2026-08-22T11:00:00.000Z');
    await mintSweepToken(store, '2026-08-22T11:00:01.000Z');
    assert.equal(
      await consumeSweepToken(store, third, Date.parse('2026-08-22T11:00:02.000Z')),
      false,
      'minting a fresh token retires the previous one, so two passes can never overlap'
    );
  });
});

describe('the article a run produced', () => {
  const nowIso = '2026-08-22T10:05:00.000Z';

  it('is recorded once article_body completes, so a finished request opens its article', async () => {
    const store = memoryStore();
    await seed(store);
    const { bridge } = bridgeFor({
      runId: 'run_1',
      status: 'running',
      updatedAt: nowIso,
      nodes: [
        { nodeId: 'draft_writer', status: 'completed' },
        { nodeId: 'article_body', status: 'completed' },
        { nodeId: 'publish_payload', status: 'running', lastDispatch: { dispatchedAt: nowIso } },
      ],
    });
    await sweepRequest({ store, bridge, now: () => Date.parse(nowIso), nowIso: () => nowIso }, REQUEST_ID);
    const doc = await loadRequest(store, REQUEST_ID);
    // The request id IS the content_item id, by the minting convention.
    assert.deepEqual(doc?.object, { object_type: 'content_item', object_id: REQUEST_ID });
    const index = await loadIndex(store);
    assert.equal(index?.rows[0]?.object_id, REQUEST_ID, 'and the list row can link to it');
  });

  it('claims no object when the run says the shell was never created', async () => {
    const store = memoryStore();
    await seed(store);
    const { bridge } = bridgeFor({
      runId: 'run_1',
      status: 'running',
      updatedAt: nowIso,
      nodes: [
        { nodeId: 'artifact_plan', status: 'completed', warnings: ['content_item_shell_failed:create_failed'] },
        { nodeId: 'article_body', status: 'completed' },
      ],
    });
    await sweepRequest({ store, bridge, now: () => Date.parse(nowIso), nowIso: () => nowIso }, REQUEST_ID);
    // A link to an object that does not exist would be permanent — recordObject never overwrites.
    assert.equal((await loadRequest(store, REQUEST_ID))?.object, undefined);
  });

  it('claims no object while article_body has not finished', async () => {
    const store = memoryStore();
    await seed(store);
    const { bridge } = bridgeFor({
      runId: 'run_1',
      status: 'running',
      updatedAt: nowIso,
      nodes: [
        { nodeId: 'article_body', status: 'failed', errors: ['output_validation_failed'] },
        { nodeId: 'draft_writer', status: 'completed' },
      ],
    });
    await sweepRequest({ store, bridge, now: () => Date.parse(nowIso), nowIso: () => nowIso }, REQUEST_ID);
    assert.equal((await loadRequest(store, REQUEST_ID))?.object, undefined);
  });
});
