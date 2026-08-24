import { useCallback, useEffect, useRef, useState } from 'react';

import type { UseChatState } from './chat';
import {
  readPersistedRunApprovalMode,
  readPersistedTestMode,
  shouldAutoApproveRunTool,
  writePersistedRunApprovalMode,
  writePersistedTestMode,
  type RunApprovalMode,
} from '@core/lib/admin/approval-mode';

export function RunApprovalControls({
  mode,
  onChange,
  testMode = false,
  onTestModeChange,
  canUseTestMode = false,
}: {
  mode: RunApprovalMode;
  onChange: (mode: RunApprovalMode) => void;
  /** Orthogonal to `mode` — a run can be asking OR continuing while in test mode. */
  testMode?: boolean;
  onTestModeChange?: (on: boolean) => void;
  /** Owner-only. Absent or false renders the row exactly as it was before test mode existed. */
  canUseTestMode?: boolean;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 text-[length:var(--adm-text-xs)]"
      aria-label="Run approval preference"
    >
      <span className="mr-0.5 font-medium text-[var(--adm-text-muted)]">This run:</span>
      <button
        type="button"
        aria-pressed={mode === 'ask'}
        onClick={() => onChange('ask')}
        className={`adm-focusable rounded-[var(--adm-radius-pill)] px-2.5 py-1 font-medium ${mode === 'ask' ? 'bg-[var(--adm-surface-raised)] text-[var(--adm-text-heading)] shadow-[var(--adm-shadow-sm)]' : 'text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]'}`}
      >
        Ask each time
      </button>
      <button
        type="button"
        aria-pressed={mode === 'safe-run'}
        onClick={() => onChange('safe-run')}
        title="Continue through every action this run proposes without asking. You can still deny or switch back."
        className={`adm-focusable rounded-[var(--adm-radius-pill)] px-2.5 py-1 font-medium ${mode === 'safe-run' ? 'bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]' : 'text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]'}`}
      >
        Approve safe actions
      </button>
      {canUseTestMode && onTestModeChange ? (
        <>
          <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-[var(--adm-border)]" />
          <button
            type="button"
            aria-pressed={testMode}
            onClick={() => onTestModeChange(!testMode)}
            title="Exercise publishing mechanics with the committed test fixture instead of writing client copy. Owner only; the server re-checks your roles before honouring it."
            className={`adm-focusable rounded-[var(--adm-radius-pill)] px-2.5 py-1 font-medium ${testMode ? 'bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]' : 'text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]'}`}
          >
            Test mode
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * The test-mode switch, persisted per chat exactly like `useRunApprovalMode`.
 *
 * `allowed` is the caller's own owner check (the admin surfaces already hold
 * `me.roles`). When it is false the hook reports `false` and its setter is a
 * no-op, so a stale persisted `on` from a previous session can never re-arm the
 * switch for someone who is no longer an owner. The server re-derives roles per
 * turn regardless — this is convenience, not the gate.
 */
export function useTestMode(
  { preferenceScope, allowed }: { preferenceScope?: string; allowed: boolean }
): [boolean, (on: boolean) => void] {
  const [on, setOnState] = useState<boolean>(() => (allowed ? readPersistedTestMode(preferenceScope) : false));
  const scopeRef = useRef(preferenceScope);
  scopeRef.current = preferenceScope;

  const setOn = useCallback(
    (next: boolean) => {
      if (!allowed) return;
      writePersistedTestMode(scopeRef.current, next);
      setOnState(next);
    },
    [allowed]
  );

  // A scope change (switching chats) loads THAT chat's own stored value.
  useEffect(() => {
    setOnState(allowed ? readPersistedTestMode(preferenceScope) : false);
  }, [allowed, preferenceScope]);

  return [on, setOn];
}

/**
 * Shared run-only preference behavior for every admin chat surface.
 *
 * Per Wolf's ruling (2026-08-12), this preference is per-chat and sticky: it
 * persists (via `approval-mode.ts`, `sessionStorage`-backed) across turns,
 * status changes, remounts, and full page reloads, scoped by
 * `preferenceScope`. It changes only when the editor clicks the other
 * option, or when an auto-approval below is rejected by the server — both
 * paths go through `setMode`, which persists as well as updates state.
 */
export function useRunApprovalMode(
  chat: Pick<UseChatState, 'pending' | 'busy' | 'approve' | 'pendingConsumed'>,
  { preferenceScope, approvalInStage = false }: { preferenceScope?: string; approvalInStage?: boolean } = {}
): [RunApprovalMode, (mode: RunApprovalMode) => void] {
  const [mode, setModeState] = useState<RunApprovalMode>(() => readPersistedRunApprovalMode(preferenceScope));
  const autoApproved = useRef(new Set<string>());
  const scopeRef = useRef(preferenceScope);
  scopeRef.current = preferenceScope;

  const setMode = useCallback((next: RunApprovalMode) => {
    writePersistedRunApprovalMode(scopeRef.current, next);
    setModeState(next);
  }, []);

  // A scope change (e.g. switching chats) loads THAT scope's own stored
  // value — never a blanket reset to 'ask'.
  useEffect(() => {
    setModeState(readPersistedRunApprovalMode(preferenceScope));
    autoApproved.current.clear();
  }, [preferenceScope]);

  useEffect(() => {
    const pending = chat.pending;
    if (
      chat.busy ||
      // Already submitted (by this effect or a manual click on the same
      // call_id) and awaiting the poll — retrying here would just hit the
      // consumed-call guard and wrongly read as a failure below.
      chat.pendingConsumed ||
      !pending ||
      !shouldAutoApproveRunTool(mode, pending.tool, approvalInStage) ||
      autoApproved.current.has(pending.call_id)
    ) {
      return;
    }
    autoApproved.current.add(pending.call_id);
    void chat.approve(pending.call_id).then((result) => {
      if (!result.approved) {
        autoApproved.current.delete(pending.call_id);
        setMode('ask');
      }
    });
  }, [approvalInStage, chat.busy, chat.pendingConsumed, chat.pending, mode, setMode]);

  return [mode, setMode];
}
