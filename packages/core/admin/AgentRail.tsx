import { useState } from 'react';

import { EmptyState, IconButton } from './primitives';
import { ChatComposer, ChatStateChip, ChatThread, type UseChatState } from './chat';
import { IconChevronLeft, IconChevronRight, IconSparkles } from './icons';
import { RequestActivity } from './RequestActivity';
import { RunApprovalControls, useRunApprovalMode, useTestMode } from './RunApprovalControls';
import { cn } from './utils';

export function AgentRail({
  chat,
  focus,
  agentFocus,
  suggestions,
  preferenceScope,
  aboveComposer,
  belowHeader,
  contextActions,
  draftSeed,
  approvalInStage = false,
  canUseTestMode = false,
  className,
  collapsed = false,
  onToggleCollapsed,
}: {
  chat: UseChatState;
  focus: string;
  agentFocus?: string;
  suggestions?: string[];
  preferenceScope?: string;
  aboveComposer?: React.ReactNode;
  /** Contextual sections the host surface docks above the transcript (T2.2). */
  belowHeader?: React.ReactNode;
  contextActions?: Array<{ id: string; label: string; text: string }>;
  draftSeed?: { key: string; text: string };
  approvalInStage?: boolean;
  /**
   * Owner-only test mode. The rail does not resolve roles itself — the surface
   * that already holds them passes this in. Default false, so every existing
   * caller renders exactly as it did before test mode existed.
   */
  canUseTestMode?: boolean;
  /** Layout override for the host (T2.2 docks it sticky). Height/border stay the rail's. */
  className?: string;
  /**
   * T2.2: the object detail dock collapses to a spine. No `Resizable`
   * primitive exists in this kit (`primitives.tsx`/`overlays.tsx` have none),
   * so the dock is fixed-width with this toggle rather than drag-resizable.
   * Both default off, so every pre-existing caller renders unchanged.
   */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const [approvalMode, setApprovalMode] = useRunApprovalMode(chat, { preferenceScope, approvalInStage });
  const [testMode, setTestMode] = useTestMode({ preferenceScope, allowed: canUseTestMode });
  // Highlight-to-reference: a quoted selection from the transcript, relayed into the composer.
  const [quote, setQuote] = useState<{ token: number; text: string } | undefined>(undefined);

  const collapsedTone =
    chat.status === 'awaiting_approval' || chat.status === 'awaiting_candidate'
      ? { label: 'The agent is waiting for you', className: 'bg-[var(--adm-warning)]' }
      : chat.status === 'queued' || chat.status === 'running'
        ? { label: 'The agent is working', className: 'animate-pulse bg-[var(--adm-info)]' }
        : chat.status === 'error'
          ? { label: 'The last run failed', className: 'bg-[var(--adm-danger)]' }
          : undefined;

  if (collapsed) {
    return (
      <section
        className={cn(
          'flex h-[calc(100dvh-8rem)] min-h-[30rem] w-12 flex-col items-center gap-3 border-l border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] py-3',
          className
        )}
        aria-label="Publishing Agent (collapsed)"
      >
        <IconButton
          label="Expand the agent dock"
          title="Expand the agent dock"
          onClick={onToggleCollapsed}
          size="sm"
          icon={<IconChevronLeft size={16} />}
        />
        <IconSparkles size={16} className="text-[var(--adm-text-muted)]" />
        {/* The ambient tier survives collapse as a dot — the full
            `<ChatStateChip>` needs more width than a spine has. Amber =
            waiting on the editor (a held gate is never red, W19); blue =
            running; red = the run failed. */}
        {collapsedTone ? (
          <span
            aria-label={collapsedTone.label}
            title={collapsedTone.label}
            role="status"
            className={cn('h-2.5 w-2.5 shrink-0 rounded-full', collapsedTone.className)}
          />
        ) : null}
      </section>
    );
  }

  return (
    <section
      className={cn(
        'flex h-[calc(100dvh-8rem)] min-h-[30rem] min-w-0 flex-col border-l border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] pl-4',
        className
      )}
      aria-label="Publishing Agent"
    >
      <header className="shrink-0 border-b border-[var(--adm-border)] pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[length:var(--adm-text-sm)] font-semibold text-[var(--adm-text-heading)]">
            Publishing Agent
          </h2>
          {/* D5 tier 1: the ambient state chip — always visible while this
              chat has an active or recently-finished run. */}
          <div className="flex items-center gap-1.5">
            <ChatStateChip
              status={chat.status}
              lastOutcome={chat.lastOutcome}
              events={chat.events}
              lastEventAtMs={chat.lastEventAtMs}
            />
            {onToggleCollapsed ? (
              <IconButton
                label="Collapse the agent dock"
                title="Collapse the agent dock"
                onClick={onToggleCollapsed}
                size="sm"
                icon={<IconChevronRight size={16} />}
              />
            ) : null}
          </div>
        </div>
        <p className="mt-0.5 truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          Working on {focus}
        </p>
      </header>
      {belowHeader ? <div className="shrink-0 pt-3">{belowHeader}</div> : null}
      {/* W19: what the job is doing, above the transcript. Collapsed to one
          live line until the editor asks for the detail. */}
      {chat.request ? (
        <div className="shrink-0 pt-3">
          <RequestActivity requestId={chat.request.request_id} />
        </div>
      ) : null}
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
        onSendControls={(text) => void chat.send(text, undefined, testMode)}
        preferenceScope={preferenceScope}
        approvalInStage={approvalInStage}
        pendingConsumed={chat.pendingConsumed}
        lastOutcome={chat.lastOutcome}
        lastEventAtMs={chat.lastEventAtMs}
        onUndo={(prompt) => void chat.send(prompt)}
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
          <RunApprovalControls
            mode={approvalMode}
            onChange={setApprovalMode}
            testMode={testMode}
            onTestModeChange={setTestMode}
            canUseTestMode={canUseTestMode}
          />
        </div>
        <ChatComposer
          status={chat.status}
          busy={chat.busy}
          onSend={(text) => void chat.send(text, agentFocus ?? focus, testMode)}
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
