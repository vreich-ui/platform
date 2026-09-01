/**
 * C3 — signed out is a state, not a rights problem.
 *
 * Four things have to hold together for that sentence to be true, and this
 * file drives all four through the real modules with only `globalThis.fetch`
 * (and, for the recovery event, `window`/`document`) faked:
 *
 *  1. a 401 anywhere in `requests-client.ts` sets ONE global state — and an
 *     empty bearer never leaves the browser at all;
 *  2. `requests-store.ts` stops polling while that state holds, and does not
 *     arm a retry;
 *  3. `cms:login` clears it and the chain resumes with a real fetch;
 *  4. a genuine `viewer` — signed IN, low rights — still reads "Ask an
 *     editor" and is never confused with a signed-out session. That last one
 *     is the regression this task can most easily cause, so it is pinned from
 *     both directions: 403 must not set the state, and `signedOut: false`
 *     must not change a single reason.
 *
 * There is no renderer in this repo's test stack (no jsdom, no
 * testing-library — see the repo's test-convention notes), so the recovery
 * path is pinned through `watchAuthRecovery`, the plain function
 * `useRequestsIndex` calls, rather than through the effect body.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  AuthExpiredError,
  AUTH_EXPIRED_MESSAGE,
  clearAuthExpired,
  isAuthExpired,
  isAuthExpiredError,
  isAuthExpiredStatus,
  markAuthExpired,
  resetAuthExpiryForTests,
  SESSION_EXPIRED_TITLE,
  subscribeAuthExpiry,
} from './auth-expiry.js';
import { getRequestActivity, listRequests, retryRequest } from './requests-client.js';
import { refreshRequestsIndexNow, startRequestsIndexPoll, watchAuthRecovery } from './requests-store.js';
import { rowActions, SIGN_IN_REQUIRED_REASON, type RowActionRowLike } from './request-logic.js';

const REQUESTS_URL = '/.netlify/functions/admin-requests';
const ACTIVITY_URL = '/.netlify/functions/admin-request-activity';

const LIST_BODY = { requests: [], total: 0, muted: [], last_notified: {}, email_mode: 'immediate' as const };

type Reply = { status?: number; body?: unknown };
type FetchCall = { url: string; authorization: string | undefined };

/** Faked at the network boundary only — every module under test here is the real one. */
function mockFetch(reply: () => Reply) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), authorization: headers.get('authorization') ?? undefined });
    const { status = 200, body = LIST_BODY } = reply();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const settle = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

const goodToken = async () => 'tok_live';
/** What `getAccessToken()` returning null looks like at every call site in this admin. */
const expiredToken = async () => '';

afterEach(() => {
  resetAuthExpiryForTests();
});

describe('the auth-expiry state itself', () => {
  it('separates 401 (who are you) from 403 (not for you) — the whole distinction', () => {
    assert.equal(isAuthExpiredStatus(401), true);
    assert.equal(isAuthExpiredStatus(403), false);
    assert.equal(isAuthExpiredStatus(500), false);
    assert.equal(isAuthExpiredStatus(200), false);
  });

  it('notifies subscribers on the way in and on the way out, and never twice for the same fact', () => {
    let notified = 0;
    const stop = subscribeAuthExpiry(() => {
      notified += 1;
    });
    markAuthExpired();
    markAuthExpired();
    assert.equal(isAuthExpired(), true);
    assert.equal(notified, 1, 'a repeated 401 from a poll chain must not re-notify every surface');
    clearAuthExpired();
    clearAuthExpired();
    assert.equal(isAuthExpired(), false);
    assert.equal(notified, 2);
    stop();
  });

  it('names the state in words a person can act on', () => {
    assert.equal(SESSION_EXPIRED_TITLE, 'Session expired — sign in again');
    assert.match(AUTH_EXPIRED_MESSAGE, /sign in/i);
    assert.equal(isAuthExpiredError(new AuthExpiredError()), true);
    assert.equal(isAuthExpiredError(new Error('Request failed (403).')), false);
  });
});

describe('the fetch seam — one interceptor, every helper through it', () => {
  it('sets the state on a 401 and throws an error that says so, not a status code', async () => {
    const fetchMock = mockFetch(() => ({ status: 401, body: { error: 'Unauthorized' } }));
    try {
      await assert.rejects(
        () => listRequests(goodToken),
        (error: unknown) => isAuthExpiredError(error)
      );
      assert.equal(isAuthExpired(), true);
    } finally {
      fetchMock.restore();
    }
  });

  it('never lets an empty bearer leave the browser', async () => {
    const fetchMock = mockFetch(() => ({}));
    try {
      await assert.rejects(
        () => listRequests(expiredToken),
        (error: unknown) => isAuthExpiredError(error)
      );
      assert.equal(fetchMock.calls.length, 0, 'a request with no credential must not be sent at all');
      assert.equal(isAuthExpired(), true);
    } finally {
      fetchMock.restore();
    }
  });

  it('covers the activity endpoint and the write helpers, not just list', async () => {
    for (const call of [
      () => getRequestActivity(goodToken, { request_id: 'req_1' }),
      () => retryRequest(goodToken, 'req_1'),
    ]) {
      resetAuthExpiryForTests();
      const fetchMock = mockFetch(() => ({ status: 401, body: { error: 'Unauthorized' } }));
      try {
        await assert.rejects(call, (error: unknown) => isAuthExpiredError(error));
        assert.equal(isAuthExpired(), true);
        assert.deepEqual(
          [...new Set(fetchMock.calls.map((entry) => entry.url))].every(
            (url) => url === REQUESTS_URL || url === ACTIVITY_URL
          ),
          true
        );
      } finally {
        fetchMock.restore();
      }
    }
  });

  it('a 403 is a RIGHTS refusal and must not be reported as an expired session', async () => {
    const fetchMock = mockFetch(() => ({ status: 403, body: { error: 'Admin access required' } }));
    try {
      await assert.rejects(
        () => listRequests(goodToken),
        (error: unknown) => error instanceof Error && error.message === 'Admin access required'
      );
      assert.equal(isAuthExpired(), false, 'telling a viewer to sign in again is the same lie in reverse');
    } finally {
      fetchMock.restore();
    }
  });

  it('a response that comes back at all clears a stale banner', async () => {
    markAuthExpired();
    const fetchMock = mockFetch(() => ({}));
    try {
      await listRequests(goodToken);
      assert.equal(isAuthExpired(), false);
    } finally {
      fetchMock.restore();
    }
  });
});

describe('the poll chain pauses while the session is gone, and resumes when it is back', () => {
  let stopPoll: (() => void) | undefined;
  let stopWatch: (() => void) | undefined;

  beforeEach(() => {
    // `armRecovery` needs both targets: `LoginModal.astro` dispatches
    // `cms:login` on `document` with `bubbles` unset, so `window` alone never
    // hears it — the reason the module listens on both.
    const globals = globalThis as unknown as { window?: EventTarget; document?: EventTarget };
    globals.window = new EventTarget();
    globals.document = new EventTarget();
  });

  afterEach(() => {
    stopWatch?.();
    stopPoll?.();
    stopWatch = undefined;
    stopPoll = undefined;
    const globals = globalThis as unknown as { window?: EventTarget; document?: EventTarget };
    delete globals.window;
    delete globals.document;
  });

  it('stops fetching on the 401, arms no retry, and comes back on cms:login', async () => {
    let status = 401;
    const fetchMock = mockFetch(() => (status === 401 ? { status: 401, body: { error: 'Unauthorized' } } : {}));
    try {
      stopPoll = startRequestsIndexPoll(goodToken);
      stopWatch = watchAuthRecovery(goodToken);
      await settle();

      const afterFirstFailure = fetchMock.calls.length;
      assert.equal(afterFirstFailure, 1, 'the chain gets exactly one 401 before it knows');
      assert.equal(isAuthExpired(), true);

      // Nothing may be armed: a forced refresh is the most aggressive thing a
      // surface can ask for, and even that must not spend a request here.
      refreshRequestsIndexNow(goodToken);
      await settle();
      assert.equal(fetchMock.calls.length, afterFirstFailure, 'a dead session must not be polled');

      status = 200;
      (globalThis as unknown as { document: EventTarget }).document.dispatchEvent(new Event('cms:login'));
      assert.equal(isAuthExpired(), false, 'signing back in is what resolves this state');
      await settle();
      assert.ok(fetchMock.calls.length > afterFirstFailure, 'the chain must refetch on recovery, not wait for a timer');
      assert.equal(fetchMock.calls.at(-1)?.authorization, 'Bearer tok_live');
    } finally {
      fetchMock.restore();
    }
  });
});

describe('the disabled reasons — the honest half of the task', () => {
  const doneRow: RowActionRowLike = { status: 'done', archived: false, chat_id: 'c_1', object_id: 'o_1' };
  const needsYouRow: RowActionRowLike = { status: 'needs_you', archived: false, chat_id: 'c_1', object_id: 'o_1' };
  const failedRow: RowActionRowLike = { status: 'failed', archived: false, chat_id: 'c_1', object_id: 'o_1' };

  it('says "Sign in required" for every rights-blocked action when the session expired', () => {
    for (const row of [doneRow, needsYouRow, failedRow]) {
      const actions = rowActions(row, [], { signedOut: true });
      const blocked = actions.filter((action) => !action.enabled);
      assert.ok(blocked.length > 0, 'an empty role list must still disable something');
      for (const action of blocked) {
        assert.equal(
          action.reason,
          SIGN_IN_REQUIRED_REASON,
          `${action.id} explained an auth problem as "${action.reason}"`
        );
      }
    }
  });

  it('never says "Ask an owner" (or any other colleague) to someone who is simply signed out', () => {
    const reasons = rowActions(needsYouRow, [], { signedOut: true })
      .map((action) => action.reason)
      .filter((reason): reason is string => Boolean(reason));
    for (const reason of reasons) assert.doesNotMatch(reason, /^Ask an?\b/);
  });

  it('REGRESSION: a genuine viewer is signed IN and still reads "Ask an editor"', () => {
    // Same empty-ish rights, entirely different state. This is the case the
    // task can most easily break: if "signed out" were inferred from the role
    // list, this viewer would be told to sign in — while they already are.
    const viewer = rowActions(doneRow, ['viewer']);
    const publish = viewer.find((action) => action.id === 'publish');
    assert.equal(publish?.enabled, false);
    assert.equal(publish?.reason, 'Ask an editor');

    const retry = rowActions(failedRow, ['viewer']).find((action) => action.id === 'retry');
    assert.equal(retry?.reason, 'Ask an admin', 'the registry seam still answers for itself');

    const editorRetry = rowActions(failedRow, ['editor']).find((action) => action.id === 'retry');
    assert.equal(editorRetry?.reason, 'Ask an admin');

    const publisherArchive = rowActions(doneRow, ['publisher']).find((action) => action.id === 'archive');
    assert.equal(publisherArchive?.reason, 'Ask an owner', 'the ladder above a publisher is unchanged');
  });

  it('changes nothing at all when the session is alive — signedOut:false is the default', () => {
    for (const roles of [['viewer'], ['editor'], ['publisher'], ['admin'], ['owner', 'admin', 'publisher']]) {
      for (const row of [doneRow, needsYouRow, failedRow]) {
        assert.deepEqual(rowActions(row, roles, { signedOut: false }), rowActions(row, roles));
      }
    }
  });

  it('leaves reasons that are facts about the ROW alone — they are true whoever is looking', () => {
    const noChat: RowActionRowLike = { status: 'done', archived: false, object_id: 'o_1' };
    const openChat = rowActions(noChat, [], { signedOut: true }).find((action) => action.id === 'open_chat');
    assert.equal(openChat?.enabled, false);
    assert.match(openChat?.reason ?? '', /No chat is attached/);
  });
});
