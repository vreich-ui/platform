import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  clearAllPersistedRunApprovalModes,
  clearPersistedRunApprovalMode,
  isRunSafeApproval,
  readPersistedRunApprovalMode,
  readPersistedTestMode,
  RUN_MODE_OPTION_HINTS,
  RUN_MODE_OPTIONS,
  RUN_MODE_SCOPE_HINT,
  runModeControl,
  shouldAutoApproveRunTool,
  writePersistedRunApprovalMode,
  writePersistedTestMode,
} from './approval-mode.js';

/** Minimal in-memory Storage stand-in — Node has no global sessionStorage. Same pattern as library-client.test.ts. */
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

let originalSessionStorage: Storage | undefined;

beforeEach(() => {
  originalSessionStorage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  (globalThis as { sessionStorage: Storage }).sessionStorage = new MemoryStorage() as unknown as Storage;
});

afterEach(() => {
  if (originalSessionStorage === undefined) {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  } else {
    (globalThis as { sessionStorage: Storage }).sessionStorage = originalSessionStorage;
  }
});

describe('isRunSafeApproval', () => {
  // Wolf's ruling, 2026-08-12: "Approve safe actions" means *continue the run
  // without asking* for EVERY tool — publication, privileged, and unknown
  // tools included. The old RUN_SAFE_TOOLS allow-list held LEGACY tool names
  // that no longer matched the generated registry's canonical names, so the
  // toggle silently did nothing (Task 5 root cause 2).
  it('allows ordinary content work for the current run', () => {
    assert.equal(isRunSafeApproval('patch'), true);
    assert.equal(isRunSafeApproval('instantiate_section_template'), true);
    assert.equal(isRunSafeApproval('submit_review'), true);
  });

  it('also covers publication, privileged, and release tools — the server, not this allow-list, is the authority', () => {
    for (const tool of [
      'publish',
      'discard',
      'apply_theme',
      'delete_pdf_template',
      'publish_pdf_template',
      'create_agent_artifact_job',
      'release_to_production',
    ]) {
      assert.equal(isRunSafeApproval(tool), true);
    }
  });

  it('does not fail closed for an unknown tool either — that gate lives server-side, not in this allow-list', () => {
    assert.equal(isRunSafeApproval('future_unclassified_tool'), true);
  });

  it('auto-approves every tool once "safe-run" is selected, unless a staged proposal is in flight', () => {
    assert.equal(shouldAutoApproveRunTool('ask', 'patch'), false);
    assert.equal(shouldAutoApproveRunTool('ask', 'create_agent_artifact_job'), false);
    assert.equal(shouldAutoApproveRunTool('safe-run', 'patch'), true);
    assert.equal(shouldAutoApproveRunTool('safe-run', 'create_agent_artifact_job'), true);
    assert.equal(shouldAutoApproveRunTool('safe-run', 'release_to_production'), true);
    // `approvalInStage` still fails closed regardless of mode or tool.
    assert.equal(shouldAutoApproveRunTool('safe-run', 'patch', true), false);
    assert.equal(shouldAutoApproveRunTool('safe-run', 'create_agent_artifact_job', true), false);
  });
});

describe('run-approval-mode persistence', () => {
  it('defaults to "ask" for a scope nothing has been written to', () => {
    assert.equal(readPersistedRunApprovalMode('chat-1'), 'ask');
  });

  it('round-trips a written mode for a scope', () => {
    writePersistedRunApprovalMode('chat-1', 'safe-run');
    assert.equal(readPersistedRunApprovalMode('chat-1'), 'safe-run');

    writePersistedRunApprovalMode('chat-1', 'ask');
    assert.equal(readPersistedRunApprovalMode('chat-1'), 'ask');
  });

  it('the preference survives across turns/status changes/remounts — no automatic reset exists anymore', () => {
    // There is no `shouldResetRunApprovalMode` (or equivalent) any more: the
    // only ways `readPersistedRunApprovalMode` returns something other than
    // what was last written are (a) nothing was ever written for that scope,
    // or (b) storage itself is unavailable. Simulate many "turns" completing
    // (chat going idle/error/cancelled repeatedly) — the stored value never
    // moves on its own.
    writePersistedRunApprovalMode('chat-1', 'safe-run');
    for (let i = 0; i < 5; i += 1) {
      assert.equal(readPersistedRunApprovalMode('chat-1'), 'safe-run');
    }
  });

  it('a rejected auto-approval downgrade persists (the one automatic mode change that is allowed)', () => {
    writePersistedRunApprovalMode('chat-1', 'safe-run');
    assert.equal(readPersistedRunApprovalMode('chat-1'), 'safe-run');

    // The hook calls writePersistedRunApprovalMode('chat-1', 'ask') when the
    // server rejects an auto-approval — simulate that downgrade here.
    writePersistedRunApprovalMode('chat-1', 'ask');

    assert.equal(readPersistedRunApprovalMode('chat-1'), 'ask');
  });

  it('scopes are isolated — one scope changing does not leak into another', () => {
    writePersistedRunApprovalMode('chat-1', 'safe-run');
    writePersistedRunApprovalMode('chat-2', 'ask');

    assert.equal(readPersistedRunApprovalMode('chat-1'), 'safe-run');
    assert.equal(readPersistedRunApprovalMode('chat-2'), 'ask');

    // Changing scope-1 further still doesn't touch scope-2.
    writePersistedRunApprovalMode('chat-1', 'ask');
    assert.equal(readPersistedRunApprovalMode('chat-1'), 'ask');
    assert.equal(readPersistedRunApprovalMode('chat-2'), 'ask');
  });

  it('falls back to a shared default scope when the caller has none yet, without merging real scopes into it', () => {
    writePersistedRunApprovalMode(undefined, 'safe-run');
    assert.equal(readPersistedRunApprovalMode(undefined), 'safe-run');
    assert.equal(readPersistedRunApprovalMode(''), 'safe-run');
    assert.equal(readPersistedRunApprovalMode('chat-1'), 'ask');
  });

  it('an invalid/corrupted stored value defaults back to "ask" instead of throwing', () => {
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem('run-approval-mode:v1:chat-1', 'yolo');
    assert.equal(readPersistedRunApprovalMode('chat-1'), 'ask');
  });

  it('storage unavailable → read defaults to "ask" and write/clear are no-ops, none of it throws', () => {
    (globalThis as { sessionStorage: Storage }).sessionStorage = {
      getItem() {
        throw new Error('SecurityError: storage disabled');
      },
      setItem() {
        throw new Error('SecurityError: storage disabled');
      },
      removeItem() {
        throw new Error('SecurityError: storage disabled');
      },
      clear() {},
      key() {
        return null;
      },
      length: 0,
    } as unknown as Storage;

    assert.equal(readPersistedRunApprovalMode('chat-1'), 'ask');
    assert.doesNotThrow(() => writePersistedRunApprovalMode('chat-1', 'safe-run'));
    assert.doesNotThrow(() => clearPersistedRunApprovalMode('chat-1'));
    assert.doesNotThrow(() => clearAllPersistedRunApprovalModes());
    // Still defaults to 'ask' — the throwing write above never actually stuck.
    assert.equal(readPersistedRunApprovalMode('chat-1'), 'ask');
  });

  it('clearPersistedRunApprovalMode drops one scope without touching others', () => {
    writePersistedRunApprovalMode('chat-1', 'safe-run');
    writePersistedRunApprovalMode('chat-2', 'safe-run');

    clearPersistedRunApprovalMode('chat-1');

    assert.equal(readPersistedRunApprovalMode('chat-1'), 'ask');
    assert.equal(readPersistedRunApprovalMode('chat-2'), 'safe-run');
  });

  it('clearAllPersistedRunApprovalModes drops every scope (the logout invalidation point)', () => {
    writePersistedRunApprovalMode('chat-1', 'safe-run');
    writePersistedRunApprovalMode('chat-2', 'safe-run');
    writePersistedRunApprovalMode(undefined, 'safe-run');

    clearAllPersistedRunApprovalModes();

    assert.equal(readPersistedRunApprovalMode('chat-1'), 'ask');
    assert.equal(readPersistedRunApprovalMode('chat-2'), 'ask');
    assert.equal(readPersistedRunApprovalMode(undefined), 'ask');
  });
});

describe('PCL-P2 — a click on the run-mode control is never silently ignored', () => {
  // Root cause: `ChatRun.autonomy` (server/lib/agent/chat-store.ts) is
  // resolved once at `send` and frozen for that run's whole lifetime
  // (`autonomyForCall`, server/lib/agent/registry.ts) — a legitimate
  // constraint, not a bug. This control cannot and does not try to rewrite
  // that frozen map (`sendChatMessage`, lib/admin/chat-client.ts, never
  // sends the mode at all); what it changes is whether the human's approval
  // is auto-submitted for whatever the frozen autonomy decides needs one —
  // for THIS run's remaining prompts, and for the next one this chat sends.
  it('a mode picked between two pending calls decides the SECOND one, proving the click is live, not cosmetic', () => {
    const scope = 'chat-next-turn';
    writePersistedRunApprovalMode(scope, 'ask');

    // "Turn" 1: a pending call arrives while still in "Ask each time" — no
    // auto-approval, exactly like before this control existed.
    assert.equal(shouldAutoApproveRunTool(readPersistedRunApprovalMode(scope), 'patch'), false);

    // Between turns the editor opens the dropdown and picks "Approve safe
    // actions" — the one action the control offers.
    writePersistedRunApprovalMode(scope, 'safe-run');

    // "Turn" 2's pending call arrives afterwards. It is decided by the mode
    // read AT THAT MOMENT — not the one turn 1 saw — which is what "changes
    // what the next turn does" means: the same tool that had to ask a moment
    // ago now clears itself.
    assert.equal(shouldAutoApproveRunTool(readPersistedRunApprovalMode(scope), 'patch'), true);

    // Switching back before a third call arrives restores asking for it too
    // — the control keeps working in both directions, every time.
    writePersistedRunApprovalMode(scope, 'ask');
    assert.equal(shouldAutoApproveRunTool(readPersistedRunApprovalMode(scope), 'release_to_production'), false);
  });

  it('every option carries a non-empty hint, so a tool this run already runs automatically (or already refuses) is explained rather than left looking inert', () => {
    for (const option of RUN_MODE_OPTIONS) {
      const hint = RUN_MODE_OPTION_HINTS[option.value];
      assert.equal(typeof hint, 'string');
      assert.ok(hint.length > 0);
    }
    assert.equal(typeof RUN_MODE_SCOPE_HINT, 'string');
    assert.ok(RUN_MODE_SCOPE_HINT.length > 0);
    // The hint itself names the constraint this control cannot cross, so a
    // reader who hovers before clicking is told the truth up front.
    assert.match(RUN_MODE_SCOPE_HINT, /before the run starts/);
  });
});

describe('runModeControl (A5 — the owner-only Test-mode gate, pure)', () => {
  it('always carries both mutually exclusive run modes, in order', () => {
    assert.deepEqual(
      RUN_MODE_OPTIONS.map((option) => option.value),
      ['ask', 'safe-run']
    );
    assert.deepEqual(runModeControl(['owner']).options, RUN_MODE_OPTIONS);
  });

  it('owner: Test mode is enabled, with no reason to show', () => {
    const control = runModeControl(['owner']);
    assert.equal(control.enabled, true);
    assert.equal(control.reason, undefined);
  });

  it('an owner among other roles still enables it', () => {
    assert.equal(runModeControl(['admin', 'owner']).enabled, true);
  });

  for (const role of ['admin', 'publisher', 'editor', 'viewer']) {
    it(`${role} alone: Test mode is disabled with a reason (D3 — never hidden)`, () => {
      const control = runModeControl([role]);
      assert.equal(control.enabled, false);
      assert.equal(typeof control.reason, 'string');
      assert.ok(control.reason && control.reason.length > 0);
    });
  }

  it('no roles at all: disabled with a reason too, same as any non-owner', () => {
    const control = runModeControl([]);
    assert.equal(control.enabled, false);
    assert.ok(control.reason);
  });

  it('the moved control still round-trips its selection through approval-mode persistence', () => {
    for (const option of RUN_MODE_OPTIONS) {
      writePersistedRunApprovalMode('chat-a5-move', option.value);
      assert.equal(readPersistedRunApprovalMode('chat-a5-move'), option.value);
    }
  });
});

describe('test mode persistence (Wolf, 2026-08-24)', () => {
  it('defaults to off, round-trips per scope, and never bleeds between chats', () => {
    assert.equal(readPersistedTestMode('chat_a'), false);
    writePersistedTestMode('chat_a', true);
    assert.equal(readPersistedTestMode('chat_a'), true);
    // Orthogonal to the approval mode — turning one on says nothing about the other.
    assert.equal(readPersistedRunApprovalMode('chat_a'), 'ask');
    assert.equal(readPersistedTestMode('chat_b'), false, 'another chat is not in test mode');
    writePersistedTestMode('chat_a', false);
    assert.equal(readPersistedTestMode('chat_a'), false);
  });

  it('is dropped by the logout sweep — a shared machine never inherits it', () => {
    writePersistedTestMode('chat_a', true);
    writePersistedRunApprovalMode('chat_a', 'safe-run');
    clearAllPersistedRunApprovalModes();
    assert.equal(readPersistedTestMode('chat_a'), false);
    assert.equal(readPersistedRunApprovalMode('chat_a'), 'ask');
  });

  it('never throws when storage is unavailable', () => {
    const saved = (globalThis as { sessionStorage?: unknown }).sessionStorage;
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('disabled');
      },
    });
    try {
      assert.equal(readPersistedTestMode('chat_a'), false);
      assert.doesNotThrow(() => writePersistedTestMode('chat_a', true));
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: saved });
    }
  });
});
