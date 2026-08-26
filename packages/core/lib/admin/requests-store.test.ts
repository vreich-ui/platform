/**
 * T6.2 — the seam that actually owns cross-surface convergence.
 *
 * `decisions.test.ts` proves the façade DISPATCHES to the right mechanism
 * and calls its `sync`/`begin`/`settle` deps in the right order, but it does
 * so against a `Recorder` — a fake overlay and a fake sync counter standing
 * in for T2.3's shared store. This file drives the same `decide()` entry
 * point through `defaultDecisionDeps` instead: the REAL `objectVerb` /
 * `approveTool` / `denyTool` / `decideRunPublish` client wrappers, and the
 * REAL `requests-store.ts` — its own `tick`/`schedule`/`generation`/
 * ref-counted-subscriber machinery, never exercised by any test before this
 * one. The only thing faked is the network boundary (`globalThis.fetch`),
 * routed by endpoint path.
 *
 * Every surface (`RequestsWorkspace`'s row, `NeedsYouMenu`'s pill and its
 * dropdown) reads the SAME module-scope `overlay`/`snapshot` singletons
 * through `useDecisionOverlay`/`useRequestsIndex`, both built on the same
 * `subscribe`/`emit`. There is no React renderer in this repo's test stack
 * (no jsdom, no testing-library — see the repo's own test-convention notes),
 * so "every subscriber sees the same rows" is proven the only way available
 * without one: by asserting on the shared singleton state itself, which is
 * BY CONSTRUCTION the one thing every hook-based subscriber reads from.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  decide,
  decisionKey,
  decisionKeys,
  defaultDecisionDeps,
  type ChatToolTarget,
  type ObjectReviewTarget,
  type WorkflowGateTarget,
} from './decisions.js';
import { DECISION_OVERLAY_TTL_MS, pendingDecisionForRequest, rowsStillNeedingDecision } from './decision-overlay.js';
import {
  beginDecisionOverlay,
  decisionOverlaySnapshot,
  refreshRequestsIndexNow,
  settleDecisionOverlay,
  startRequestsIndexPoll,
} from './requests-store.js';

const getToken = async () => 'token';

const REQUESTS_URL = '/.netlify/functions/admin-requests';
const OBJECT_URL = '/.netlify/functions/admin-object';
const ACTIVITY_URL = '/.netlify/functions/admin-request-activity';

type RouteResult = { status?: number; body: unknown };
type Route = (body: Record<string, unknown> | undefined) => RouteResult | Promise<RouteResult>;
type FetchCall = { url: string; body: Record<string, unknown> | undefined };

/** Routes `fetch` by exact endpoint path — the one seam left to fake once `defaultDecisionDeps` is real. */
function mockFetch(routes: Record<string, Route>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    const route = routes[url];
    if (!route) throw new Error(`requests-store.test.ts: unmocked fetch to ${url}`);
    const { status = 200, body: resBody } = await route(body);
    return new Response(JSON.stringify(resBody), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    calls,
    countOf: (url: string) => calls.filter((call) => call.url === url).length,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const waitFor = async (pred: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('requests-store.test.ts: timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // One more turn of the loop so the store's own post-fetch bookkeeping
  // (setOverlay, setSnapshot, schedule) — which runs synchronously right
  // after the awaited fetch/json resolve, but still after this predicate's
  // own poll observed the fetch call land — has finished.
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const emptyRequestsBody = { requests: [], total: 0, muted: [], last_notified: {}, email_mode: 'immediate' as const };

let activeStop: (() => void) | undefined;
let activeFetch: ReturnType<typeof mockFetch> | undefined;

afterEach(() => {
  // Unsubscribe FIRST — it clears the store's pending poll timer — then
  // restore fetch, so no leftover chain from one test can call into the next
  // test's (or no) mock.
  activeStop?.();
  activeStop = undefined;
  activeFetch?.restore();
  activeFetch = undefined;
});

describe('the optimistic overlay — the real store, not a recorder', () => {
  it('begin/settle write and clear the exact entry every hook-based subscriber reads', () => {
    const key = decisionKey({ mechanism: 'workflow_gate', requestId: 'req_ov_1' });
    beginDecisionOverlay(key, 'approve');
    assert.equal(decisionOverlaySnapshot()[key]?.phase, 'pending');
    settleDecisionOverlay(key, true);
    assert.equal(decisionOverlaySnapshot()[key]?.phase, 'confirmed');
  });

  it('a rollback leaves NOTHING behind — no phase left for a button to keep reading as spinning', () => {
    const key = decisionKey({ mechanism: 'workflow_gate', requestId: 'req_ov_2' });
    beginDecisionOverlay(key, 'reject');
    assert.equal(decisionOverlaySnapshot()[key]?.phase, 'pending');
    settleDecisionOverlay(key, false);
    assert.equal(
      decisionOverlaySnapshot()[key],
      undefined,
      'rollback must remove the entry outright, not merely mark it failed'
    );
  });
});

describe('refreshRequestsIndexNow — ref-counted, real store', () => {
  it('does nothing at all while nobody is subscribed — no wasted invalidation fetch', () => {
    const fetchMock = mockFetch({});
    activeFetch = fetchMock;
    refreshRequestsIndexNow(getToken);
    assert.deepEqual(fetchMock.calls, []);
  });
});

describe('decide() through the real store — convergence for the mechanism whose key space supports it', () => {
  it('workflow_gate: one invalidation beyond the mount fetch; the overlay is applied immediately and reconciled once the server catches up', async () => {
    const RUN: WorkflowGateTarget = { mechanism: 'workflow_gate', requestId: 'req_conv_1' };
    const key = decisionKey(RUN);
    let requestsCalls = 0;

    const fetchMock = mockFetch({
      [REQUESTS_URL]: async () => {
        requestsCalls += 1;
        // Call 1 (mount): the row still needs a human. Call 2 (the decision's
        // own invalidation): the row has moved on — simulating the server
        // having caught up by the time the refetch lands. A small delay on
        // this second response only widens the window between `settle`'s
        // confirm and `sync`'s reconcile enough for the poll below to
        // reliably observe "confirmed" as its own state rather than racing
        // straight past it — both dispatched fire-and-forget by `decide()`,
        // and an in-process mock resolves fast enough that they can
        // otherwise land within the same microtask flush.
        if (requestsCalls === 2) await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          body: {
            ...emptyRequestsBody,
            requests:
              requestsCalls === 1
                ? [{ request_id: 'req_conv_1', status: 'needs_you' }]
                : [{ request_id: 'req_conv_1', status: 'done' }],
            total: 1,
          },
        };
      },
      [ACTIVITY_URL]: () => ({ body: { activity: null } }),
    });
    activeFetch = fetchMock;

    // Mount a subscriber — the inbox/pill/dropdown being on screen, which is
    // the precondition the store's own `sync` requires to do anything at all.
    activeStop = startRequestsIndexPoll(getToken);
    await waitFor(() => fetchMock.countOf(REQUESTS_URL) === 1);

    const result = await decide(getToken, RUN, 'approve', {}, defaultDecisionDeps);
    assert.equal(result.ok, true);
    // Confirmed the instant the server accepts it — before the invalidation
    // fetch this same decision triggers has even landed. `begin`/`settle` on
    // `defaultDecisionDeps` are themselves fire-and-forget dynamic imports
    // (`decide()` does not await them), so give that indirection a turn to
    // land rather than asserting in the same microtask `decide()` resolved in.
    await waitFor(() => decisionOverlaySnapshot()[key]?.phase === 'confirmed');

    // Reconciled away once the refetched snapshot agrees the row moved on —
    // W19 law: the overlay never rewrote the row, it only stopped hiding it.
    // (Gate on the OVERLAY clearing, not merely on the second fetch having
    // been ISSUED — the delayed response above means the call count reaches
    // 2 well before that response, and the reconcile it drives, land.)
    await waitFor(() => decisionOverlaySnapshot()[key] === undefined);

    assert.equal(fetchMock.countOf(ACTIVITY_URL), 1);
    assert.equal(fetchMock.countOf(REQUESTS_URL), 2, 'exactly one invalidation beyond the initial mount fetch');
  });

  it('rolls back to nothing on a server refusal, and never invalidates the store nobody asked it to', async () => {
    const OBJECT: ObjectReviewTarget = {
      mechanism: 'object_review',
      objectType: 'content_item',
      objectId: 'obj_conv_2',
    };
    const key = decisionKey(OBJECT);

    const fetchMock = mockFetch({
      [OBJECT_URL]: () => ({ status: 403, body: { error: 'Deciding a review requires a configured role.' } }),
      [REQUESTS_URL]: () => ({ body: emptyRequestsBody }),
    });
    activeFetch = fetchMock;
    activeStop = startRequestsIndexPoll(getToken);
    await waitFor(() => fetchMock.countOf(REQUESTS_URL) === 1);

    const result = await decide(getToken, OBJECT, 'approve', {}, defaultDecisionDeps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_permitted');
    await waitFor(() => decisionOverlaySnapshot()[key] === undefined);

    // Give a wrongly-fired sync a moment to show up before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fetchMock.countOf(REQUESTS_URL), 1, 'a failed decision must not invalidate the shared store');
  });

  it('partly_applied (T3.2): the durable half is recorded server-side, but the client-visible result is a rollback, not a second invalidation', async () => {
    // The endpoint answers 200 with `error` when `workflow_set_operator_publish_decision`
    // stood but `workflow_run_all` failed — decisions.ts preserves this as
    // `code: 'partly_applied'` rather than flattening it into a plain failure.
    const RUN: WorkflowGateTarget = { mechanism: 'workflow_gate', requestId: 'req_conv_3' };
    const key = decisionKey(RUN);

    const fetchMock = mockFetch({
      [ACTIVITY_URL]: () => ({
        body: { activity: null, reason: 'advance_failed', error: 'CMS-Agent refused workflow_run_all' },
      }),
      [REQUESTS_URL]: () => ({ body: emptyRequestsBody }),
    });
    activeFetch = fetchMock;
    activeStop = startRequestsIndexPoll(getToken);
    await waitFor(() => fetchMock.countOf(REQUESTS_URL) === 1);

    const result = await decide(getToken, RUN, 'approve', {}, defaultDecisionDeps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'partly_applied', 'must not be flattened into a plain failure');
    assert.equal(result.activity?.reason, 'advance_failed');
    await waitFor(() => decisionOverlaySnapshot()[key] === undefined);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      fetchMock.countOf(REQUESTS_URL),
      1,
      'ok:false — even a partly-applied decision — never triggers a second invalidation'
    );
  });
});

/**
 * The same finding T6.2 proved here, now the other way round: an
 * object-review or chat-tool decision invalidates the shared store AND is
 * found by `pendingDecisionForRequest` for the row it is about — through the
 * REAL store, not the pure reducer (`decisions.test.ts` has the reducer-level
 * version in its "one decision, both keyings" block).
 *
 * What changed: `ObjectReviewTarget` and `ChatToolTarget` now carry an
 * optional `requestId`, and `decide()` files the optimistic entry under the
 * request key as well as its own (`decisionKeys`). Without one, nothing
 * changes — which is the second half of what these tests pin, because the
 * two surfaces that populate it (the object detail view's chat binding, the
 * chat rail's own) do not always have a link to give.
 */
describe('cross-surface sync through the real store — object-review and chat-tool decisions reach the row', () => {
  it('an object-review approval invalidates the store AND the row it belongs to is found by request id', async () => {
    const linkedRequestId = 'req_conv_4'; // the row this object backs, per RequestRowView.object_id
    const OBJECT: ObjectReviewTarget = {
      mechanism: 'object_review',
      objectType: 'content_item',
      objectId: 'obj_conv_4',
      requestId: linkedRequestId,
    };

    const fetchMock = mockFetch({
      [OBJECT_URL]: () => ({ body: { review_state: 'approved' } }),
      [REQUESTS_URL]: () => ({
        body: {
          ...emptyRequestsBody,
          // Nothing but the sweeper rewrites a request's status (W19 law) —
          // this same row still reads needs_you right after the approval, and
          // that is exactly the window the overlay exists to cover.
          requests: [{ request_id: linkedRequestId, status: 'needs_you', object_id: 'obj_conv_4' }],
          total: 1,
        },
      }),
    });
    activeFetch = fetchMock;
    activeStop = startRequestsIndexPoll(getToken);
    await waitFor(() => fetchMock.countOf(REQUESTS_URL) === 1);

    const result = await decide(getToken, OBJECT, 'approve', {}, defaultDecisionDeps);
    assert.equal(result.ok, true);

    // The invalidation fires...
    await waitFor(() => fetchMock.countOf(REQUESTS_URL) === 2);
    // ...and the refetched snapshot — which still says needs_you — no longer
    // makes every surface ask for a human, because the decision this browser
    // just took is now filed under the key those surfaces read.
    await waitFor(() => pendingDecisionForRequest(decisionOverlaySnapshot(), linkedRequestId) !== undefined);
    const overlay = decisionOverlaySnapshot();
    assert.equal(pendingDecisionForRequest(overlay, linkedRequestId)?.decision, 'approve');
    assert.deepEqual(rowsStillNeedingDecision([{ request_id: linkedRequestId, status: 'needs_you' }], overlay), []);
    // The mechanism's own key still holds the same entry — one decision, two
    // keyings, never two entries.
    assert.equal(overlay[decisionKey(OBJECT)], overlay[`workflow_gate:request:${linkedRequestId}`]);
  });

  it('a chat-tool approval converges identically', async () => {
    const linkedRequestId = 'req_conv_5';
    const CHAT: ChatToolTarget = {
      mechanism: 'chat_tool',
      chatId: 'chat_conv_5',
      callId: 'call_conv_5',
      tool: 'object_publish',
      requestId: linkedRequestId,
    };

    const fetchMock = mockFetch({
      '/.netlify/functions/admin-agent-chat': () => ({ body: { approved: true, executing: true } }),
      [REQUESTS_URL]: () => ({
        body: {
          ...emptyRequestsBody,
          requests: [{ request_id: linkedRequestId, status: 'needs_you', chat_id: 'chat_conv_5' }],
          total: 1,
        },
      }),
    });
    activeFetch = fetchMock;
    activeStop = startRequestsIndexPoll(getToken);
    await waitFor(() => fetchMock.countOf(REQUESTS_URL) === 1);

    const result = await decide(getToken, CHAT, 'approve', {}, defaultDecisionDeps);
    assert.equal(result.ok, true);

    await waitFor(() => fetchMock.countOf(REQUESTS_URL) === 2);
    await waitFor(() => pendingDecisionForRequest(decisionOverlaySnapshot(), linkedRequestId) !== undefined);
    assert.equal(pendingDecisionForRequest(decisionOverlaySnapshot(), linkedRequestId)?.decision, 'approve');
  });

  it('an unlinked decision behaves exactly as it did before — no alias, and the row keeps asking for a human', async () => {
    // The surface genuinely does not know which request this object backs
    // (no chat binding resolved), so there is nothing honest to alias. That
    // path must stay a no-op rather than inventing a request id from the
    // object id — a `content_item` id wears the `req_*` shape whether or not
    // an editorial request ever produced it.
    const OBJECT: ObjectReviewTarget = {
      mechanism: 'object_review',
      objectType: 'content_item',
      objectId: 'obj_conv_6',
    };
    const unlinkedRequestId = 'req_conv_6';

    const fetchMock = mockFetch({
      [OBJECT_URL]: () => ({ body: { review_state: 'approved' } }),
      [REQUESTS_URL]: () => ({
        body: {
          ...emptyRequestsBody,
          requests: [{ request_id: unlinkedRequestId, status: 'needs_you', object_id: 'obj_conv_6' }],
          total: 1,
        },
      }),
    });
    activeFetch = fetchMock;
    activeStop = startRequestsIndexPoll(getToken);
    await waitFor(() => fetchMock.countOf(REQUESTS_URL) === 1);

    const result = await decide(getToken, OBJECT, 'approve', {}, defaultDecisionDeps);
    assert.equal(result.ok, true);

    // The invalidation still fires — that half always worked...
    await waitFor(() => fetchMock.countOf(REQUESTS_URL) === 2);
    // ...and the row is still, correctly, the browser's problem: no link was
    // known, so no alias was written and nothing pretends the row is decided.
    const overlay = decisionOverlaySnapshot();
    assert.equal(pendingDecisionForRequest(overlay, unlinkedRequestId), undefined);
    assert.deepEqual(rowsStillNeedingDecision([{ request_id: unlinkedRequestId, status: 'needs_you' }], overlay), [
      { request_id: unlinkedRequestId, status: 'needs_you' },
    ]);
    assert.equal(
      Object.keys(overlay).filter((key) => key.includes('obj_conv_6') || key.includes(unlinkedRequestId)).length <= 1,
      true,
      'at most the mechanism own key — never a request key nobody could justify'
    );
  });

  it('a refused linked decision rolls BOTH keyings back — no row left stuck reading "already decided"', async () => {
    const linkedRequestId = 'req_conv_7';
    const OBJECT: ObjectReviewTarget = {
      mechanism: 'object_review',
      objectType: 'content_item',
      objectId: 'obj_conv_7',
      requestId: linkedRequestId,
    };

    const fetchMock = mockFetch({
      [OBJECT_URL]: () => ({ status: 403, body: { error: 'Deciding a review requires a configured role.' } }),
      [REQUESTS_URL]: () => ({
        body: {
          ...emptyRequestsBody,
          requests: [{ request_id: linkedRequestId, status: 'needs_you', object_id: 'obj_conv_7' }],
          total: 1,
        },
      }),
    });
    activeFetch = fetchMock;
    activeStop = startRequestsIndexPoll(getToken);
    await waitFor(() => fetchMock.countOf(REQUESTS_URL) === 1);

    const result = await decide(getToken, OBJECT, 'approve', {}, defaultDecisionDeps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_permitted');

    await waitFor(() => decisionOverlaySnapshot()[decisionKey(OBJECT)] === undefined);
    assert.equal(
      pendingDecisionForRequest(decisionOverlaySnapshot(), linkedRequestId),
      undefined,
      'a decision the server refused must not keep hiding the row from the inbox or the pill'
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fetchMock.countOf(REQUESTS_URL), 1, 'a failed decision must not invalidate the shared store');
  });

  it('a snapshot that still says the row needs a human keeps BOTH keyings — the overlay is what covers that window', async () => {
    const linkedRequestId = 'req_conv_8';
    const OBJECT: ObjectReviewTarget = {
      mechanism: 'object_review',
      objectType: 'content_item',
      objectId: 'obj_conv_8',
      requestId: linkedRequestId,
    };
    const [key, ...alsoKeys] = decisionKeys(OBJECT);
    beginDecisionOverlay(key, 'approve', alsoKeys);
    settleDecisionOverlay(key, true, alsoKeys);

    let requestsCalls = 0;
    const fetchMock = mockFetch({
      [REQUESTS_URL]: () => {
        requestsCalls += 1;
        return {
          body: {
            ...emptyRequestsBody,
            // The sweeper has not caught up — `openDecisionKeys` still names
            // this row, so the reconcile must keep the decision.
            requests: [{ request_id: linkedRequestId, status: 'needs_you', object_id: 'obj_conv_8' }],
            total: 1,
          },
        };
      },
    });
    activeFetch = fetchMock;
    activeStop = startRequestsIndexPoll(getToken);
    await waitFor(() => requestsCalls === 1);

    assert.equal(decisionOverlaySnapshot()[key]?.phase, 'confirmed');
    assert.equal(pendingDecisionForRequest(decisionOverlaySnapshot(), linkedRequestId)?.phase, 'confirmed');
  });

  it('expiry clears BOTH keyings, so a decision the server never applied cannot hide a row forever', async () => {
    const linkedRequestId = 'req_conv_9';
    const OBJECT: ObjectReviewTarget = {
      mechanism: 'object_review',
      objectType: 'content_item',
      objectId: 'obj_conv_9',
      requestId: linkedRequestId,
    };
    const [key, ...alsoKeys] = decisionKeys(OBJECT);

    // Record the decision as though it had been taken a full TTL ago — the
    // store stamps `atMs` from `Date.now()` and takes no clock injection.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() - DECISION_OVERLAY_TTL_MS - 1;
      beginDecisionOverlay(key, 'approve', alsoKeys);
      settleDecisionOverlay(key, true, alsoKeys);
    } finally {
      Date.now = realNow;
    }
    assert.equal(pendingDecisionForRequest(decisionOverlaySnapshot(), linkedRequestId)?.phase, 'confirmed');

    let requestsCalls = 0;
    const fetchMock = mockFetch({
      [REQUESTS_URL]: () => {
        requestsCalls += 1;
        return {
          body: {
            ...emptyRequestsBody,
            // Still listed as needing a human, so `reconcile` keeps it — only
            // the TTL may take it away, and it must take both keys at once.
            requests: [{ request_id: linkedRequestId, status: 'needs_you', object_id: 'obj_conv_9' }],
            total: 1,
          },
        };
      },
    });
    activeFetch = fetchMock;
    activeStop = startRequestsIndexPoll(getToken);
    await waitFor(() => requestsCalls === 1);

    assert.equal(decisionOverlaySnapshot()[key], undefined, 'the primary keying expires');
    assert.equal(
      pendingDecisionForRequest(decisionOverlaySnapshot(), linkedRequestId),
      undefined,
      'and the alias expires with it — otherwise the row is stuck reading "decided" forever'
    );
  });
});
