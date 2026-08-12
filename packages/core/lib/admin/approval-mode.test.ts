import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  clearAllPersistedRunApprovalModes,
  clearPersistedRunApprovalMode,
  isRunSafeApproval,
  readPersistedRunApprovalMode,
  shouldAutoApproveRunTool,
  writePersistedRunApprovalMode,
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
  it('allows ordinary content work for the current run', () => {
    assert.equal(isRunSafeApproval('patch'), true);
    assert.equal(isRunSafeApproval('instantiate_section_template'), true);
    assert.equal(isRunSafeApproval('submit_review'), true);
  });

  it('keeps consequential actions behind an explicit decision', () => {
    for (const tool of [
      'publish',
      'discard',
      'apply_theme',
      'delete_pdf_template',
      'publish_pdf_template',
      'create_agent_artifact_job',
      'release',
    ]) {
      assert.equal(isRunSafeApproval(tool), false);
    }
  });

  it('fails closed for an unknown tool', () => {
    assert.equal(isRunSafeApproval('future_unclassified_tool'), false);
  });

  it('only auto-approves allow-listed actions in the editor-selected run mode', () => {
    assert.equal(shouldAutoApproveRunTool('ask', 'patch'), false);
    assert.equal(shouldAutoApproveRunTool('safe-run', 'patch'), true);
    assert.equal(shouldAutoApproveRunTool('safe-run', 'patch', true), false);

    for (const tool of ['publish', 'release', 'apply_theme', 'delete_pdf_template', 'unknown_tool']) {
      assert.equal(shouldAutoApproveRunTool('safe-run', tool), false);
    }
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
