/**
 * W19 T19.6/T19.7 — the per-person notification state: mute, dedup, and how
 * much mail a person wants.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EditorialRequestStore } from './store.js';
import {
  DEFAULT_EMAIL_MODE,
  LAST_NOTIFIED_MAX,
  ackMailed,
  ackNotifications,
  alreadyMailed,
  emailModeFor,
  isMuted,
  loadMailedLedger,
  loadNotifyState,
  loadSeenLedger,
  muteRequest,
  setEmailMode,
  shouldMailNow,
  unmuteRequest,
} from './notify-state.js';

const memoryStore = (): EditorialRequestStore => {
  const data = new Map<string, string>();
  return {
    get: async (key: string) => data.get(key) ?? null,
    setJSON: async (key: string, value: unknown) => {
      data.set(key, JSON.stringify(value));
    },
    list: async ({ prefix }: { prefix: string }) => ({
      blobs: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
    }),
  } as EditorialRequestStore;
};

describe('muting', () => {
  it('is personal, idempotent and reversible', async () => {
    const store = memoryStore();
    await muteRequest(store, 'Editor@Example.com', 'req_a');
    await muteRequest(store, 'editor@example.com', 'req_a');
    const state = await loadNotifyState(store, 'EDITOR@example.com');
    assert.deepEqual(state?.muted, ['req_a'], 'the address is normalised and the mute is not doubled');
    assert.equal(isMuted(state, 'req_a'), true);

    await unmuteRequest(store, 'editor@example.com', 'req_a');
    assert.deepEqual((await loadNotifyState(store, 'editor@example.com'))?.muted, []);
  });

  it('leaves another person alone', async () => {
    const store = memoryStore();
    await muteRequest(store, 'a@example.com', 'req_a');
    assert.equal(isMuted(await loadNotifyState(store, 'b@example.com'), 'req_a'), false);
  });
});

describe('the dedup ledgers', () => {
  it('remembers what a person was told, so a second tab stays quiet', async () => {
    const store = memoryStore();
    await ackNotifications(store, 'editor@example.com', { req_a: 'needs_you' });
    assert.equal((await loadSeenLedger(store, 'editor@example.com')).req_a, 'needs_you');
  });

  it('keeps the mail ledger SEPARATE, so an e-mail never swallows the toast', async () => {
    const store = memoryStore();
    // The sweeper mails first — in the same invocation that writes the status.
    await ackMailed(store, 'editor@example.com', { req_a: 'needs_you' });
    assert.equal(alreadyMailed(await loadMailedLedger(store, 'editor@example.com'), 'req_a', 'needs_you'), true);
    assert.equal(
      (await loadSeenLedger(store, 'editor@example.com')).req_a,
      undefined,
      'the browser has not shown it yet, and must still be allowed to'
    );
  });

  it('lets a request that returns to a notifying status be announced again', async () => {
    const store = memoryStore();
    await ackNotifications(store, 'editor@example.com', { req_a: 'needs_you' });
    // The editor approves; it runs; the client acks the intermediate status…
    await ackNotifications(store, 'editor@example.com', { req_a: 'running' });
    // …so a SECOND approval gate is news again.
    assert.equal((await loadSeenLedger(store, 'editor@example.com')).req_a, 'running');
    assert.equal(alreadyMailed(await loadMailedLedger(store, 'editor@example.com'), 'req_a', 'needs_you'), false);
  });

  it('is bounded, and evicts the LEAST RECENTLY SEEN rather than the entry it just refreshed', async () => {
    const store = memoryStore();
    const many = Object.fromEntries(Array.from({ length: LAST_NOTIFIED_MAX }, (_, index) => [`req_${index}`, 'done']));
    await ackNotifications(store, 'editor@example.com', many);
    // The map is full. Refresh the OLDEST key and add one new one.
    await ackNotifications(store, 'editor@example.com', { req_0: 'needs_you', req_new: 'failed' });
    const seen = await loadSeenLedger(store, 'editor@example.com');
    assert.equal(Object.keys(seen).length, LAST_NOTIFIED_MAX);
    assert.equal(seen.req_0, 'needs_you', 'the entry this ack touched must survive it');
    assert.equal(seen.req_new, 'failed');
    assert.equal(seen.req_1, undefined, 'the least recently seen entry is the one that goes');
  });
});

describe('one document per writer', () => {
  it('lets a MUTE and an ack land in either order without either reverting the other', async () => {
    const store = memoryStore();
    await ackNotifications(store, 'editor@example.com', { req_a: 'needs_you' });
    // The person clicks Mute in one tab; the other tab's poll acks a
    // transition. These were one document with three writers, and whichever
    // saved second silently reverted the other — a person could mute a
    // request, be told it worked, and keep being notified about it.
    await muteRequest(store, 'editor@example.com', 'req_b');
    await ackNotifications(store, 'editor@example.com', { req_c: 'failed' });

    assert.deepEqual((await loadNotifyState(store, 'editor@example.com'))?.muted, ['req_b']);
    const seen = await loadSeenLedger(store, 'editor@example.com');
    assert.equal(seen.req_a, 'needs_you');
    assert.equal(seen.req_c, 'failed');
  });

  it('lets the sweeper mail while a tab acks, without the same e-mail going twice', async () => {
    const store = memoryStore();
    await ackMailed(store, 'editor@example.com', { req_a: 'needs_you' });
    await ackNotifications(store, 'editor@example.com', { req_a: 'needs_you', req_b: 'done' });
    assert.equal(
      alreadyMailed(await loadMailedLedger(store, 'editor@example.com'), 'req_a', 'needs_you'),
      true,
      'the browser ack must not be able to clear the mailer\u2019s record of what it sent'
    );
  });

  it('an OFF switch survives the next poll from another tab', async () => {
    const store = memoryStore();
    await setEmailMode(store, 'editor@example.com', 'off');
    await ackNotifications(store, 'editor@example.com', { req_a: 'failed' });
    assert.equal(emailModeFor(await loadNotifyState(store, 'editor@example.com')), 'off');
  });

  it('reads a PRE-SPLIT document, so nobody is re-notified about what they were already told', async () => {
    const store = memoryStore();
    // Exactly what the one-document version wrote.
    await store.setJSON('requests/notify/editor@example.com.json', {
      schema_version: 'editorial-request-notify.v1',
      person: 'editor@example.com',
      updated_at: '2026-08-22T10:00:00.000Z',
      muted: ['req_z'],
      last_notified: { req_a: 'needs_you' },
      last_mailed: { req_a: 'needs_you' },
    });
    assert.equal((await loadSeenLedger(store, 'editor@example.com')).req_a, 'needs_you');
    assert.equal(alreadyMailed(await loadMailedLedger(store, 'editor@example.com'), 'req_a', 'needs_you'), true);
    assert.equal(isMuted(await loadNotifyState(store, 'editor@example.com'), 'req_z'), true);
  });
});

describe('how much mail a person wants', () => {
  it('defaults to being told, not to silence', () => {
    assert.equal(emailModeFor(undefined), DEFAULT_EMAIL_MODE);
    assert.equal(DEFAULT_EMAIL_MODE, 'immediate');
  });

  it('interrupts for the unhappy states and lets `done` wait for a digest', () => {
    assert.equal(shouldMailNow('immediate', 'needs_you'), true);
    assert.equal(shouldMailNow('immediate', 'stalled'), true);
    assert.equal(shouldMailNow('immediate', 'failed'), true);
    assert.equal(shouldMailNow('immediate', 'done'), false);
    assert.equal(shouldMailNow('daily', 'needs_you'), false);
    assert.equal(shouldMailNow('off', 'failed'), false);
  });

  it('is stored per person', async () => {
    const store = memoryStore();
    await setEmailMode(store, 'editor@example.com', 'off');
    assert.equal(emailModeFor(await loadNotifyState(store, 'editor@example.com')), 'off');
    assert.equal(emailModeFor(await loadNotifyState(store, 'other@example.com')), 'immediate');
  });
});
