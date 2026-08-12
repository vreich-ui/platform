import { useState } from 'react';

import { EmptyState } from './primitives';
import { ChatComposer, ChatThread, type UseChatState } from './chat';
import { RunApprovalControls, useRunApprovalMode } from './RunApprovalControls';

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
  const [approvalMode, setApprovalMode] = useRunApprovalMode(chat, { preferenceScope, approvalInStage });
  // Highlight-to-reference: a quoted selection from the transcript, relayed into the composer.
  const [quote, setQuote] = useState<{ token: number; text: string } | undefined>(undefined);

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
        onQuote={(text) => setQuote({ token: Date.now(), text })}
        onSendControls={(text) => void chat.send(text)}
        preferenceScope={preferenceScope}
        approvalInStage={approvalInStage}
        pendingConsumed={chat.pendingConsumed}
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
          quote={quote}
          above={aboveComposer}
        />
      </div>
    </section>
  );
}
