import { useEffect, useRef, useState } from 'react';

import { EmptyState } from './primitives';
import { ChatComposer, ChatThread, type UseChatState } from './chat';
import { shouldAutoApproveRunTool, type RunApprovalMode } from '@core/lib/admin/approval-mode';

function RunApprovalControls({ mode, onChange }: { mode: RunApprovalMode; onChange: (mode: RunApprovalMode) => void }) {
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

export function AgentRail({
  chat,
  focus,
  agentFocus,
  suggestions,
  preferenceScope,
  aboveComposer,
  contextActions,
  draftSeed,
  approvalInStage = false,
}: {
  chat: UseChatState;
  focus: string;
  agentFocus?: string;
  suggestions?: string[];
  preferenceScope?: string;
  aboveComposer?: React.ReactNode;
  contextActions?: Array<{ id: string; label: string; text: string }>;
  draftSeed?: { key: string; text: string };
  approvalInStage?: boolean;
}) {
  const [approvalMode, setApprovalMode] = useState<RunApprovalMode>('ask');
  const autoApproved = useRef(new Set<string>());

  useEffect(() => {
    setApprovalMode('ask');
    autoApproved.current.clear();
  }, [preferenceScope]);

  useEffect(() => {
    if (!chat.pending && ['idle', 'error', 'cancelled'].includes(chat.status ?? '')) {
      setApprovalMode('ask');
      autoApproved.current.clear();
    }
  }, [chat.pending, chat.status]);

  useEffect(() => {
    const pending = chat.pending;
    if (
      approvalMode !== 'safe-run' ||
      approvalInStage ||
      chat.busy ||
      !pending ||
      !shouldAutoApproveRunTool(approvalMode, pending.tool, approvalInStage) ||
      autoApproved.current.has(pending.call_id)
    ) {
      return;
    }
    autoApproved.current.add(pending.call_id);
    void chat.approve(pending.call_id).then((result) => {
      if (!result.approved) {
        autoApproved.current.delete(pending.call_id);
        setApprovalMode('ask');
      }
    });
  }, [approvalInStage, approvalMode, chat.busy, chat.pending]);

  return (
    <section
      className="flex h-[calc(100dvh-8rem)] min-h-[30rem] min-w-0 flex-col border-l border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] pl-4"
      aria-label="Publishing Agent"
    >
      <header className="shrink-0 border-b border-[var(--adm-border)] pb-3">
        <h2 className="text-[length:var(--adm-text-sm)] font-semibold text-[var(--adm-text-heading)]">
          Publishing Agent
        </h2>
        <p className="mt-0.5 truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          Working on {focus}
        </p>
      </header>
      <ChatThread
        events={chat.events}
        status={chat.status}
        pending={chat.pending}
        candidateSet={chat.candidateSet}
        previewCandidateId={chat.previewCandidate?.candidate_id}
        busy={chat.busy}
        onApprove={(editedArgs) => chat.pending && void chat.approve(chat.pending.call_id, editedArgs)}
        onDeny={(reason) => chat.pending && void chat.deny(chat.pending.call_id, reason)}
        onPreviewCandidate={(candidateId) => chat.preview(candidateId)}
        onChooseCandidate={(candidateId) => void chat.chooseCandidate(candidateId)}
        onRejectCandidates={(reason) => void chat.rejectCandidates(reason)}
        preferenceScope={preferenceScope}
        approvalInStage={approvalInStage}
        emptyHint={
          <EmptyState
            title="Ready when you are"
            message="Describe an outcome. The agent can inspect this object and propose a governed change."
          />
        }
      />
      {chat.error ? (
        <p className="shrink-0 py-2 text-[length:var(--adm-text-xs)] text-[var(--adm-danger)]">{chat.error}</p>
      ) : null}
      <div className="shrink-0 border-t border-[var(--adm-border)] pt-3">
        <div className="mb-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-2 py-1.5">
          <RunApprovalControls mode={approvalMode} onChange={setApprovalMode} />
        </div>
        <ChatComposer
          status={chat.status}
          busy={chat.busy}
          onSend={(text) => void chat.send(text, agentFocus ?? focus)}
          onCancel={() => void chat.cancel()}
          suggestions={suggestions}
          contextActions={contextActions}
          draftSeed={draftSeed}
          above={aboveComposer}
        />
      </div>
    </section>
  );
}
