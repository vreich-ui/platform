import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DOCKED_CHAT_FAILURE_TEXT,
  VISUAL_IDENTITY_CHAT_SCOPE,
  clearDockedChatId,
  dockedChatControl,
  dockedChatErrorText,
  dockedChatReducer,
  dockedChatSeed,
  dockedChatStorageKey,
  initialDockedChatSession,
  readDockedChatId,
  writeDockedChatId,
  type DockedChatSession,
  type DockedChatStorage,
} from './docked-chat-session.js';
import { agentStarterByKey } from './agent-starters.js';

const memoryStorage = (): DockedChatStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
};

const throwingStorage = (): DockedChatStorage => ({
  getItem: () => {
    throw new Error('storage disabled');
  },
  setItem: () => {
    throw new Error('storage disabled');
  },
  removeItem: () => {
    throw new Error('storage disabled');
  },
});

describe('dockedChatStorageKey', () => {
  it('is scoped per site, which is what keeps Imagery and PDF templates on ONE shared conversation', () => {
    assert.equal(dockedChatStorageKey(VISUAL_IDENTITY_CHAT_SCOPE, 'site_acme'), 'visual-identity-chat:site_acme');
    assert.notEqual(
      dockedChatStorageKey(VISUAL_IDENTITY_CHAT_SCOPE, 'site_acme'),
      dockedChatStorageKey(VISUAL_IDENTITY_CHAT_SCOPE, 'site_other')
    );
  });

  it('keeps the shipped key shape, so an existing dock re-attaches rather than orphaning its chat', () => {
    assert.equal(VISUAL_IDENTITY_CHAT_SCOPE, 'visual-identity-chat');
  });
});

describe('cached chat id', () => {
  it('round-trips and — the defect — can be CLEARED', () => {
    const storage = memoryStorage();
    const key = dockedChatStorageKey(VISUAL_IDENTITY_CHAT_SCOPE, 'site_acme');
    assert.equal(readDockedChatId(storage, key), undefined);
    writeDockedChatId(storage, key, 'chat_dead');
    assert.equal(readDockedChatId(storage, key), 'chat_dead');
    clearDockedChatId(storage, key);
    assert.equal(readDockedChatId(storage, key), undefined);
  });

  it('clearing one site does not clear another site’s conversation', () => {
    const storage = memoryStorage();
    const acme = dockedChatStorageKey(VISUAL_IDENTITY_CHAT_SCOPE, 'site_acme');
    const other = dockedChatStorageKey(VISUAL_IDENTITY_CHAT_SCOPE, 'site_other');
    writeDockedChatId(storage, acme, 'chat_a');
    writeDockedChatId(storage, other, 'chat_b');
    clearDockedChatId(storage, acme);
    assert.equal(readDockedChatId(storage, acme), undefined);
    assert.equal(readDockedChatId(storage, other), 'chat_b');
  });

  it('treats a blank cached value as no chat (a blank id would poll a chat that does not exist)', () => {
    const storage = memoryStorage();
    storage.map.set('k', '   ');
    assert.equal(readDockedChatId(storage, 'k'), undefined);
  });

  it('never throws when storage is absent or refuses (SSR, private browsing)', () => {
    assert.equal(readDockedChatId(undefined, 'k'), undefined);
    assert.doesNotThrow(() => writeDockedChatId(undefined, 'k', 'chat_1'));
    assert.doesNotThrow(() => clearDockedChatId(undefined, 'k'));
    const hostile = throwingStorage();
    assert.equal(readDockedChatId(hostile, 'k'), undefined);
    assert.doesNotThrow(() => writeDockedChatId(hostile, 'k', 'chat_1'));
    assert.doesNotThrow(() => clearDockedChatId(hostile, 'k'));
  });
});

describe('dockedChatReducer', () => {
  it('starts idle with no chat and generation 0', () => {
    assert.deepEqual(initialDockedChatSession(), { phase: 'idle', attempt: 0 });
  });

  it('attaches to a cached id without minting', () => {
    const next = dockedChatReducer(initialDockedChatSession(), { type: 'attached', chatId: 'chat_cached' });
    assert.equal(next.phase, 'ready');
    assert.equal(next.chatId, 'chat_cached');
    assert.equal(next.attempt, 0);
  });

  it('mints: creating drops the held id, minted installs the new one', () => {
    let state = dockedChatReducer(initialDockedChatSession(), { type: 'attached', chatId: 'chat_old' });
    state = dockedChatReducer(state, { type: 'minting' });
    assert.equal(state.phase, 'creating');
    assert.equal(state.chatId, undefined, 'the dead chat must not stay mounted while a new one is minted');
    state = dockedChatReducer(state, { type: 'minted', chatId: 'chat_new' });
    assert.deepEqual(state, { phase: 'ready', chatId: 'chat_new', attempt: 0 });
  });

  it('a failed mint is recorded as a failure with a reason — never a silent undefined', () => {
    const state = dockedChatReducer(
      { phase: 'creating', attempt: 0 },
      { type: 'failed', reason: new Error('Request failed (500).') }
    );
    assert.equal(state.phase, 'failed');
    assert.equal(state.chatId, undefined);
    assert.match(state.error ?? '', /Request failed \(500\)\./);
  });

  it('reset drops the id and bumps the generation, so the mint effect re-runs', () => {
    const ready = dockedChatReducer(initialDockedChatSession(), { type: 'attached', chatId: 'chat_dead' });
    const reset = dockedChatReducer(ready, { type: 'reset' });
    assert.deepEqual(reset, { phase: 'idle', attempt: 1 });
    const again = dockedChatReducer(dockedChatReducer(reset, { type: 'minted', chatId: 'chat_2' }), { type: 'reset' });
    assert.equal(again.attempt, 2);
  });

  it('reset works from a FAILED state too — the retry path is the same path', () => {
    const failed = dockedChatReducer({ phase: 'creating', attempt: 3 }, { type: 'failed', reason: 'nope' });
    const reset = dockedChatReducer(failed, { type: 'reset' });
    assert.deepEqual(reset, { phase: 'idle', attempt: 4 });
    assert.equal(reset.error, undefined, 'the stale failure must not survive the retry');
  });
});

describe('dockedChatErrorText', () => {
  it('keeps the server’s own message when there is one', () => {
    assert.equal(
      dockedChatErrorText(new Error('Request failed (503).')),
      `${DOCKED_CHAT_FAILURE_TEXT} Request failed (503).`
    );
    assert.equal(dockedChatErrorText('offline'), `${DOCKED_CHAT_FAILURE_TEXT} offline`);
  });

  it('falls back to the plain sentence for an empty or non-error rejection', () => {
    assert.equal(dockedChatErrorText(new Error('   ')), DOCKED_CHAT_FAILURE_TEXT);
    assert.equal(dockedChatErrorText(undefined), DOCKED_CHAT_FAILURE_TEXT);
    assert.equal(dockedChatErrorText({ weird: true }), DOCKED_CHAT_FAILURE_TEXT);
  });
});

describe('dockedChatControl', () => {
  const ready: DockedChatSession = { phase: 'ready', chatId: 'chat_1', attempt: 0 };

  it('is offered while a chat is mounted — the dead-chat case is exactly when it is needed', () => {
    const control = dockedChatControl(ready);
    assert.equal(control.label, 'New chat');
    assert.equal(control.disabled, false);
    assert.equal(control.error, undefined);
  });

  it('every state’s accessible hint CONTAINS its visible label (it is rendered as aria-label, never as a title tooltip on a disabled control)', () => {
    for (const state of [
      initialDockedChatSession(),
      ready,
      { phase: 'creating', attempt: 1 } as DockedChatSession,
      { phase: 'failed', attempt: 1 } as DockedChatSession,
    ]) {
      const control = dockedChatControl(state);
      assert.ok(
        control.hint.startsWith(control.label.replace(/…$/, '')),
        `hint ${JSON.stringify(control.hint)} must open with the visible label ${JSON.stringify(control.label)}`
      );
    }
  });

  it('is offered before any chat exists as well', () => {
    assert.equal(dockedChatControl(initialDockedChatSession()).disabled, false);
  });

  it('is disabled only while a mint is in flight', () => {
    const control = dockedChatControl({ phase: 'creating', attempt: 1 });
    assert.equal(control.disabled, true);
    assert.equal(control.label, 'Starting…');
  });

  it('a failed mint leaves a VISIBLE retry carrying the reason', () => {
    const control = dockedChatControl({
      phase: 'failed',
      error: 'A new conversation could not be started. 500',
      attempt: 1,
    });
    assert.equal(control.disabled, false);
    assert.equal(control.label, 'Try again');
    assert.equal(control.error, 'A new conversation could not be started. 500');
  });

  it('a failure with no recorded reason still shows the fallback sentence', () => {
    assert.equal(dockedChatControl({ phase: 'failed', attempt: 1 }).error, DOCKED_CHAT_FAILURE_TEXT);
  });
});

describe('dockedChatSeed', () => {
  it('re-seeds a reset chat with the SAME starter first load used', () => {
    const starter = agentStarterByKey('visual-identity');
    assert.ok(starter, 'the visual-identity starter must exist');
    const seed = dockedChatSeed('visual-identity', 'Visual identity');
    assert.equal(seed.title, starter.label);
    assert.equal(seed.prompt, starter.prompt);
  });

  it('keeps the shared conversation shared: the starter names theme, image style AND PDF templates', () => {
    const seed = dockedChatSeed('visual-identity', 'Visual identity');
    assert.match(seed.prompt ?? '', /image style/i);
    assert.match(seed.prompt ?? '', /PDF template/i);
  });

  it('falls back to a plain title with no opening turn when the starter key does not resolve', () => {
    assert.deepEqual(dockedChatSeed('no-such-starter', 'Visual identity'), { title: 'Visual identity' });
  });
});
