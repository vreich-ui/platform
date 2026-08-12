import { useCallback, useEffect, useRef, useState } from 'react';

import type { UseChatState } from './chat';
import {
  readPersistedRunApprovalMode,
  shouldAutoApproveRunTool,
  writePersistedRunApprovalMode,
  type RunApprovalMode,
} from '@core/lib/admin/approval-mode';

export function RunApprovalControls({
  mode,
  onChange,
}: {
  mode: RunApprovalMode;
  onChange: (mode: RunApprovalMode) => void;
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
        title="Continue through ordinary content changes. Publishing, release, destructive, privileged, and unknown actions still ask."
        className={`adm-focusable rounded-[var(--adm-radius-pill)] px-2.5 py-1 font-medium ${mode === 'safe-run' ? 'bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]' : 'text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]'}`}
      >
        Approve safe actions
      </button>
    </div>
  );
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
