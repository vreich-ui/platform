import { useEffect, useRef, useState } from 'react';

import type { UseChatState } from './chat';
import {
  shouldAutoApproveRunTool,
  shouldResetRunApprovalMode,
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

/** Shared run-only preference behavior for every admin chat surface. */
export function useRunApprovalMode(
  chat: Pick<UseChatState, 'pending' | 'status' | 'busy' | 'approve'>,
  { preferenceScope, approvalInStage = false }: { preferenceScope?: string; approvalInStage?: boolean } = {}
): [RunApprovalMode, (mode: RunApprovalMode) => void] {
  const [mode, setMode] = useState<RunApprovalMode>('ask');
  const autoApproved = useRef(new Set<string>());

  useEffect(() => {
    setMode('ask');
    autoApproved.current.clear();
  }, [preferenceScope]);

  useEffect(() => {
    if (shouldResetRunApprovalMode(chat.status, Boolean(chat.pending))) {
      setMode('ask');
      autoApproved.current.clear();
    }
  }, [chat.pending, chat.status]);

  useEffect(() => {
    const pending = chat.pending;
    if (
      chat.busy ||
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
  }, [approvalInStage, chat.busy, chat.pending, mode]);

  return [mode, setMode];
}
