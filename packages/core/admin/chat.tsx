/**
 * Chat primitives (T9.14, plan §3/§4): ChatThread, ChatMessage, ToolCallCard,
 * PendingApprovalCard, AgentChip, ChatComposer, and the useChat polling hook
 * over the T9.13 protocol. The thread header always shows WHICH agent is
 * speaking (§4a); every write shows the kit `<ApprovalCard>` (`./approval`)
 * with the tool's human summary, the args, the server-computed dry-run, and
 * one row of Approve / Reject / Modify (A7 — this file no longer has an
 * approval card of its own).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Avatar, Button, Card } from './primitives';
import { Markdown } from './Markdown';
import { Textarea } from './forms';
import { Popover, useToast } from './overlays';
import { ControlsCard } from './ControlsCard';
import { MicButton } from './MicButton';
import { ApprovalCard, RunProgress, type ApprovalCardProps } from './approval';
import { SeverityIcon } from './severity';
import { IconRobot, IconSend } from './icons';
import {
  cancelChatRun,
  chooseCandidate as chooseCandidateRequest,
  getChat,
  pollIntervalFor,
  rejectCandidates as rejectCandidatesRequest,
  sendChatMessage,
  type AgentView,
  type ChatEventView,
  type ChatStatus,
  type ChatRequestBindingView,
  type ChatView,
  type PendingView,
  type RunSummaryView,
} from '@core/lib/admin/chat-client';
import type { CandidateOptionView, CandidateSetView } from '@core/lib/admin/candidate-choice';
import type { GetToken } from '@core/lib/edit-mode/verbs-client';
import { createdObjectsFromEvents, groupChatEvents, requestProgressCopy, toolLabel } from '@core/lib/admin/chat-logic';
import { DENIED_SEVERITY, classifyToolResult, type Severity } from '@core/lib/admin/activity-severity';
import { severityFromActivity } from '@core/lib/admin/severity';
import {
  deriveLivenessChip,
  elapsedMsForChip,
  elapsedMsSince,
  isStreamingNow,
  lastUndoableWriteTool,
  receiptLine,
  terminalReceiptInfo,
  threadStatusVisibility,
  undoPrompt,
} from '@core/lib/admin/chat-liveness';
import { formatDuration } from '@core/lib/admin/requests-client';
import { createApprovalClaim } from '@core/lib/admin/object-context-actions';
import { assertDecided, decide } from '@core/lib/admin/decisions';
import {
  editedArgsDraft,
  editedArgsError,
  parseEditedArgs,
  presentPendingApproval,
} from '@core/lib/admin/pending-approval';
import { insertQuoteIntoDraft, selectionWithinContainer } from '@core/lib/admin/chat-quote';
import { findControlsSubmissionText, splitControlsSegments } from '@core/lib/admin/chat-controls';
import { useDictation } from '@core/lib/admin/use-dictation';
import { cmsAgentErrorCopy, type CmsAgentErrorDetail } from '@core/lib/admin/cms-agent-error-copy';

// ─── useChat: since_seq polling over get_chat ───────────────────────

export interface UseChatState {
  status: ChatStatus | undefined;
  events: ChatEventView[];
  pending: PendingView | undefined;
  candidateSet: CandidateSetView | undefined;
  previewCandidate: CandidateOptionView | undefined;
  agent: AgentView | undefined;
  /** W19 T19.5: the editorial request this conversation is about, once the server has resolved it. */
  request: ChatRequestBindingView | undefined;
  /** T3.1 (D5): the most recent run's summary — carried on every `get_chat`
   *  response (`ChatSummaryView.last_outcome`) already, so the receipt tier
   *  and the ambient chip's `idle` reading need no new fetch. `null` means
   *  the chat has loaded and genuinely never run; `undefined` means it
   *  hasn't loaded yet. */
  lastOutcome: RunSummaryView | null | undefined;
  /** T3.1 (D5): a CLIENT clock reading of the moment the last poll ingested
   *  new events — the one honest signal available for "tokens are actively
   *  arriving" given this transport has no per-token stream. See
   *  `isStreamingNow` (`chat-liveness.ts`). */
  lastEventAtMs: number | undefined;
  error: string | undefined;
  busy: boolean;
  send: (text: string, focus?: string, testMode?: boolean) => Promise<void>;
  preview: (candidateId: string | undefined) => void;
  chooseCandidate: (candidateId: string) => Promise<void>;
  rejectCandidates: (reason: string) => Promise<void>;
  approve: (callId: string, editedArgs?: Record<string, unknown>) => Promise<{ approved: boolean }>;
  deny: (callId: string, reason?: string) => Promise<void>;
  cancel: () => Promise<void>;
  /** Bumps whenever an executed (non-error) write tool result arrives — preview refresh signal. */
  writeStamp: number;
  /**
   * True once `pending`'s call_id has been submitted for approve/deny/cancel
   * and the poll hasn't yet confirmed it's gone. Consumers must treat the
   * card as non-interactive while this holds — the local `busy` flag alone
   * clears before the next poll and would otherwise let a second click
   * re-submit an already-consumed call_id (fixed defect: stale approval
   * re-enables the button).
   */
  pendingConsumed: boolean;
}

const WRITE_TOOLS = new Set([
  'patch',
  'create_object',
  'create_variant',
  'instantiate_template',
  'instantiate_section_template',
  'publish',
  'submit_review',
  'discard',
  'apply_theme',
  'create_pdf_template',
  'publish_pdf_template',
  'delete_pdf_template',
  'create_agent_artifact_job',
  'get_agent_artifact_job_status',
]);

export function useChat(getToken: GetToken, chatId: string | undefined): UseChatState {
  const [status, setStatus] = useState<ChatStatus | undefined>(undefined);
  const [events, setEvents] = useState<ChatEventView[]>([]);
  const [pending, setPending] = useState<PendingView | undefined>(undefined);
  const [candidateSet, setCandidateSet] = useState<CandidateSetView | undefined>(undefined);
  const [previewCandidateId, setPreviewCandidateId] = useState<string | undefined>(undefined);
  const [agent, setAgent] = useState<AgentView | undefined>(undefined);
  const [request, setRequest] = useState<ChatRequestBindingView | undefined>(undefined);
  const [lastOutcome, setLastOutcome] = useState<RunSummaryView | null | undefined>(undefined);
  const [lastEventAtMs, setLastEventAtMs] = useState<number | undefined>(undefined);
  /** Read inside `poll`'s closure, which must not re-create on every binding change. */
  const requestRef = useRef<ChatRequestBindingView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [writeStamp, setWriteStamp] = useState(0);
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const liveRef = useRef(true);
  // Local double-submit guard (same primitive the sequential-section path
  // uses) generalized to every call_id this chat consumes: approve/deny act
  // on `pending.call_id`, chooseCandidate/cancel on `candidateSet.call_id` /
  // the in-flight `pending.call_id`. A claimed call_id stays claimed until
  // the next poll confirms the server has moved past it (see `ingest`).
  const claimRef = useRef(createApprovalClaim());
  /** The pending call, mirrored in a ref so a decision callback can name the tool in its receipt without re-creating itself on every poll. */
  const pendingRef = useRef<PendingView | undefined>(undefined);

  const ingest = useCallback((view: ChatView) => {
    setStatus(view.status);
    pendingRef.current = view.pending;
    setPending(view.pending);
    setCandidateSet(view.candidate_set);
    setPreviewCandidateId((current) =>
      current && view.candidate_set?.candidates.some((candidate) => candidate.candidate_id === current)
        ? current
        : undefined
    );
    if (view.agent) setAgent(view.agent);
    // Sent on the first poll only; keep it for the rest of the session.
    if (view.request) {
      requestRef.current = view.request;
      setRequest(view.request);
    }
    setLastOutcome(view.last_outcome);
    if (view.events.length > 0) {
      seqRef.current = Math.max(seqRef.current, ...view.events.map((event) => event.seq));
      setEvents((prior) => [...prior, ...view.events.filter((event) => !prior.some((p) => p.seq === event.seq))]);
      // T3.1 (D5): the one client-side signal "tokens are actively arriving"
      // can honestly be built from, given this transport polls rather than
      // streams — see `isStreamingNow`.
      setLastEventAtMs(Date.now());
      if (
        view.events.some(
          (event) =>
            event.type === 'tool_result' && !event.detail?.is_error && WRITE_TOOLS.has(String(event.detail?.tool ?? ''))
        )
      ) {
        setWriteStamp((stamp) => stamp + 1);
      }
    }
  }, []);

  const poll = useCallback(async () => {
    if (!chatId || !liveRef.current) return;
    try {
      // Keep asking for the request binding until we have one: the job is
      // registered mid-run, after this chat's first poll.
      const view = await getChat(getToken, chatId, seqRef.current, !requestRef.current);
      if (!liveRef.current) return;
      ingest(view);
      setError(undefined);
      timerRef.current = setTimeout(poll, pollIntervalFor(view.status));
    } catch (pollError) {
      if (!liveRef.current) return;
      setError(pollError instanceof Error ? pollError.message : 'Polling failed.');
      timerRef.current = setTimeout(poll, 6000);
    }
  }, [chatId, getToken, ingest]);

  useEffect(() => {
    liveRef.current = true;
    seqRef.current = 0;
    setEvents([]);
    setStatus(undefined);
    setPending(undefined);
    pendingRef.current = undefined;
    setCandidateSet(undefined);
    setPreviewCandidateId(undefined);
    setRequest(undefined);
    requestRef.current = undefined;
    setLastOutcome(undefined);
    setLastEventAtMs(undefined);
    claimRef.current = createApprovalClaim();
    if (chatId) void poll();
    return () => {
      liveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [chatId, poll]);

  const kick = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void poll();
  }, [poll]);

  const wrap = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
        setError(undefined);
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : 'Action failed.');
      } finally {
        setBusy(false);
        kick();
      }
    },
    [kick]
  );

  const approve = useCallback(
    async (callId: string, editedArgs?: Record<string, unknown>): Promise<{ approved: boolean }> => {
      if (!chatId) return { approved: false };
      // Same call_id claimed twice (a stale re-enabled button, or a race with
      // deny/cancel on the same pending) is a no-op here, not a re-POST.
      if (!claimRef.current.claim(callId)) return { approved: false };
      setBusy(true);
      try {
        // T3.2: through the ONE decision façade, not `approveTool` directly.
        // The wire call is identical (`approve_tool`, with `edited_args` when
        // the human edited the arguments — the only real Modify of the three
        // mechanisms); what the façade adds is the shared optimistic marker
        // and the one invalidation path, so a chat approval moves the header
        // pill and the runs inbox without a reload.
        const result = await decide(
          getToken,
          {
            mechanism: 'chat_tool',
            chatId,
            callId,
            tool: pendingRef.current?.tool,
            // W19 T19.5's binding — "chats attach to a request rather than
            // owning it" — read from the ref the poll already keeps for this
            // session. It gives the optimistic entry the request keying the
            // inbox row and the header pill actually look up, so approving a
            // tool call HERE stops them counting the row in the same tick
            // instead of when the sweeper next runs. A free chat that never
            // registered a job has no binding and behaves exactly as before.
            ...(requestRef.current ? { requestId: requestRef.current.request_id } : {}),
          },
          editedArgs ? 'modify' : 'approve',
          editedArgs ? { editedArgs } : {}
        );
        setError(result.ok ? undefined : result.error);
        // The server didn't consume it (e.g. already-decided elsewhere) — free
        // it up so a genuine retry isn't permanently blocked.
        if (!result.ok) claimRef.current.release(callId);
        // Execution is async now (Task 5): the card clears on approval; the
        // tool's success/failure arrives as a normal `tool_result` event via
        // the poll, not here.
        return { approved: result.ok };
      } catch (actionError) {
        claimRef.current.release(callId);
        setError(actionError instanceof Error ? actionError.message : 'Action failed.');
        return { approved: false };
      } finally {
        setBusy(false);
        kick();
      }
    },
    [chatId, getToken, kick]
  );

  return {
    status,
    events,
    pending,
    candidateSet,
    previewCandidate: candidateSet?.candidates.find((candidate) => candidate.candidate_id === previewCandidateId),
    agent,
    request,
    lastOutcome,
    lastEventAtMs,
    error,
    busy,
    writeStamp,
    pendingConsumed: pending !== undefined && claimRef.current.has(pending.call_id),
    send: (text, focus, testMode) => wrap(() => sendChatMessage(getToken, chatId!, text, focus, testMode)),
    preview: setPreviewCandidateId,
    chooseCandidate: (candidateId) => {
      const callId = candidateSet?.call_id;
      if (callId && !claimRef.current.claim(callId)) return Promise.resolve();
      return wrap(async () => {
        if (!candidateSet) return;
        try {
          await chooseCandidateRequest(getToken, chatId!, candidateSet.call_id, candidateId);
          setCandidateSet(undefined);
          setPreviewCandidateId(undefined);
        } catch (actionError) {
          if (callId) claimRef.current.release(callId);
          throw actionError;
        }
      });
    },
    rejectCandidates: (reason) =>
      wrap(async () => {
        if (!candidateSet) return;
        await rejectCandidatesRequest(getToken, chatId!, candidateSet.call_id, reason);
        setCandidateSet(undefined);
        setPreviewCandidateId(undefined);
      }),
    approve,
    // Reject shares `pending.call_id` with Approve — claiming through the
    // same guard means a click on one disables the other immediately, not
    // just after the next poll.
    deny: (callId, reason) => {
      if (!claimRef.current.claim(callId)) return Promise.resolve();
      return wrap(async () => {
        try {
          // T3.2: same façade, same shared invalidation — `deny_tool` is the
          // one call of the three mechanisms that carries the typed reason.
          const result = await decide(
            getToken,
            {
              mechanism: 'chat_tool',
              chatId: chatId!,
              callId,
              tool: pendingRef.current?.tool,
              // Same binding as Approve above — a rejection has to clear the
              // row from the other two surfaces just as promptly.
              ...(requestRef.current ? { requestId: requestRef.current.request_id } : {}),
            },
            'reject',
            reason ? { reason } : {}
          );
          assertDecided(result);
        } catch (actionError) {
          claimRef.current.release(callId);
          throw actionError;
        }
      });
    },
    cancel: () => {
      const callId = pending?.call_id;
      if (callId && !claimRef.current.claim(callId)) return Promise.resolve();
      return wrap(async () => {
        try {
          await cancelChatRun(getToken, chatId!);
        } catch (actionError) {
          if (callId) claimRef.current.release(callId);
          throw actionError;
        }
      });
    },
  };
}

// ─── AgentChip ───────────────────────────────────

export function AgentChip({ agent }: { agent: AgentView | undefined }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--adm-border)] bg-[var(--adm-surface)] px-2.5 py-1">
      {agent ? (
        <Avatar name={agent.name} size={20} />
      ) : (
        <span className="text-[var(--adm-accent)]">
          <IconRobot size={16} />
        </span>
      )}
      <span className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">
        {agent?.name ?? 'Client Manager'}
      </span>
    </span>
  );
}

export function CandidateSetCard({
  set,
  selectedId,
  busy,
  onPreview,
  onChoose,
  onReject,
}: {
  set: CandidateSetView;
  selectedId?: string;
  busy: boolean;
  onPreview: (candidateId: string) => void;
  onChoose: (candidateId: string) => void;
  onReject: (reason: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const selected = set.candidates.find((candidate) => candidate.candidate_id === selectedId);
  return (
    <Card
      kicker="Compare"
      title={`${set.candidates.length} versions — pick the one that reads best`}
      className="bg-[var(--adm-surface-sunken)] shadow-none"
    >
      <div className="mb-3 flex gap-1.5" role="group" aria-label="Preview a version">
        {set.candidates.map((candidate) => (
          <button
            key={candidate.candidate_id}
            type="button"
            aria-pressed={candidate.candidate_id === selectedId}
            onClick={() => onPreview(candidate.candidate_id)}
            className={`adm-focusable h-8 min-w-8 rounded-full border px-2 text-[length:var(--adm-text-sm)] font-semibold ${candidate.candidate_id === selectedId ? 'border-[var(--adm-accent)] bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]' : 'border-[var(--adm-border)] text-[var(--adm-text-muted)]'}`}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {set.candidates.map((candidate) => (
          <button
            key={candidate.candidate_id}
            type="button"
            onClick={() => onPreview(candidate.candidate_id)}
            className="adm-focusable flex gap-2 rounded-[var(--adm-radius-md)] p-2 text-left hover:bg-[var(--adm-surface-sunken)]"
          >
            <strong className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">{candidate.label}</strong>
            <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              {candidate.self_description}
            </span>
          </button>
        ))}
      </div>
      {selected ? (
        <Button className="mt-3 w-full" size="sm" onClick={() => onChoose(selected.candidate_id)} disabled={busy}>
          Pick version {selected.label}
        </Button>
      ) : (
        <p className="mt-3 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          Preview a version on the Object Stage before picking it.
        </p>
      )}
      {rejecting ? (
        <div className="mt-3 flex flex-col gap-2">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            label="What should change in the next round?"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setRejecting(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => onReject(reason.trim())} disabled={busy || !reason.trim()}>
              Try another round
            </Button>
          </div>
        </div>
      ) : (
        <Button className="mt-2" size="sm" variant="ghost" onClick={() => setRejecting(true)} disabled={busy}>
          None of these
        </Button>
      )}
    </Card>
  );
}

// ─── message + tool cards ─────────────────────────

function Bubble({ mine, children }: { mine?: boolean; children: React.ReactNode }) {
  return (
    <div className={mine ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          mine
            ? 'max-w-[85%] rounded-[var(--adm-radius-lg)] rounded-br-sm bg-[var(--adm-accent)] px-3.5 py-2.5 text-[length:var(--adm-text-sm)] text-[var(--adm-accent-contrast,#fff)]'
            : 'max-w-[85%] rounded-[var(--adm-radius-lg)] rounded-bl-sm bg-[var(--adm-surface-sunken)] px-3.5 py-2.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text)]'
        }
      >
        {children}
      </div>
    </div>
  );
}

export function ChatMessage({
  event,
  laterUserTexts,
  busy = false,
  onSendControls,
}: {
  event: ChatEventView;
  /** Text of every user message that comes AFTER this one in the transcript — used to
   *  derive a `controls` block's submitted state (see `chat-controls.ts`). Assistant messages only. */
  laterUserTexts?: string[];
  busy?: boolean;
  onSendControls?: (text: string) => void;
}) {
  if (event.type === 'user_message') {
    return (
      <Bubble mine>
        <span className="whitespace-pre-wrap">{String(event.detail?.text ?? '')}</span>
      </Bubble>
    );
  }
  const text = String(event.detail?.text ?? '');
  const segments = splitControlsSegments(text);
  if (segments.length === 1 && segments[0]?.kind === 'text') {
    return (
      <div className="max-w-none px-1 py-1 text-[length:var(--adm-text-sm)] leading-6 text-[var(--adm-text)]">
        <Markdown>{text}</Markdown>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {segments.map((segment, index) => {
        if (segment.kind === 'text') {
          if (!segment.text.trim()) return null;
          return (
            <div
              key={index}
              className="max-w-none px-1 py-1 text-[length:var(--adm-text-sm)] leading-6 text-[var(--adm-text)]"
            >
              <Markdown>{segment.text}</Markdown>
            </div>
          );
        }
        return (
          <ControlsCard
            key={index}
            block={segment.block}
            submittedText={findControlsSubmissionText(segment.block.id, laterUserTexts ?? [])}
            busy={busy}
            onSubmit={(brief) => onSendControls?.(brief)}
          />
        );
      })}
    </div>
  );
}

/** Collapsed-by-default JSON block for args / dry-run payloads. */
function JsonDisclosure({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]">
        {label}
      </summary>
      <pre className="mt-1 max-h-56 overflow-auto rounded-[var(--adm-radius-sm)] bg-[var(--adm-surface-sunken)] p-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text)]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

/**
 * W19 F1: a run that ends now SAYS SO.
 *
 * This event rendered as `null`, so a run that completed, one that failed and
 * one that simply exhausted its turn budget all left the transcript
 * byte-identical — the editor watched a pulsing dot disappear and had no way
 * to tell success from silence. The `caps` case is the one that mattered most
 * and read worst: for a long article it is the NORMAL ending of a turn, and it
 * does not mean the job stopped.
 */
/**
 * Task B (provider-error-details) — turns a `run_error` event's `detail` into
 * display copy, handling both the current structured shape
 * (code/message/operatorAction/providerStatus/providerMessage/fromJsonBody)
 * and a pre-existing chat document's events, which only ever carried a
 * precomposed `message` string and no `code` at all.
 */
function runErrorCopy(detail: Record<string, unknown> | undefined, isOwner: boolean): { text: string; providerDetail?: string } {
  const code = typeof detail?.code === 'string' ? detail.code : undefined;
  if (!code) return { text: String(detail?.message ?? 'unknown error') };
  const error: CmsAgentErrorDetail = {
    code,
    message: typeof detail?.message === 'string' ? detail.message : '',
    ...(typeof detail?.operatorAction === 'string' ? { operatorAction: detail.operatorAction } : {}),
    ...(typeof detail?.providerStatus === 'number' ? { providerStatus: detail.providerStatus } : {}),
    ...(typeof detail?.providerMessage === 'string' ? { providerMessage: detail.providerMessage } : {}),
    ...(detail?.fromJsonBody === true ? { fromJsonBody: true } : {}),
  };
  return cmsAgentErrorCopy(error, { isOwner });
}

function RunFinishedLine({ event }: { event: ChatEventView }) {
  // `reason` is the loop's own vocabulary (agent/loop.ts): `caps` and
  // `wall_clock` both mean the TURN ran out of budget — never that the job
  // did. `end_turn` is the agent finishing what it was asked.
  const reason = String(event.detail?.reason ?? 'end_turn');
  const budgetSpent = reason === 'caps' || reason === 'wall_clock';
  const text = budgetSpent
    ? "I paused this turn — anything already running keeps going without me, and I'll pick it up from here."
    : 'Done for now.';
  return <p className="text-center text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{text}</p>;
}

/**
 * W19 — the sweeper's `request_progress` line (`sweep.ts`'s `progressDetail`),
 * appended on every meaningful transition. Before this it fell through
 * `chat.tsx`'s catch-all `<ToolCallCard>`, which reads `event.detail.tool` /
 * `is_error` — fields this event never carries — so a `failed` transition
 * rendered with `ToolCallCard`'s default `severity: 'ok'`: a green check next
 * to the failure sentence, and the job LOOKED unchanged from the "still
 * working" line above it even though the sweeper had already flipped the
 * request. Severity now comes from the same `requestSeverityLevel` map the
 * `/admin/requests` list renders its rows through, so this line and that list
 * can never disagree about what red means.
 *
 * Task B: for a `failed` transition, the first blocker carries CMS-Agent's
 * own structured detail (code/message/operatorAction — `derive-status.ts`'s
 * `failedNodeBlockers`) exactly where CMS-Agent supplies one (a classified
 * provider error or its own `budget_exceeded` guard). Same `cmsAgentErrorCopy`
 * function as `run_error` and `RequestActivity`'s node detail — "same text",
 * not a third hand-copied rendering.
 */
function RequestProgressLine({ event, isOwner }: { event: ChatEventView; isOwner: boolean }) {
  const copy = requestProgressCopy(event.detail, isOwner);
  // A4: a plain line, no border/box — the sweeper's own status line no
  // longer competes visually with the boxed cards around it. Callers (see
  // `ChatThread`) render this at all only when no `RequestActivity` card is
  // already mounted for the same request (`hasRunCard`); this component
  // itself stays a dumb consumer of the event.
  return (
    <div className="flex flex-col gap-1 text-[length:var(--adm-text-xs)]">
      <div className="flex items-center gap-2 text-[var(--adm-text-muted)]">
        <SeverityIcon level={copy.level} size={14} title="" />
        <span className="font-medium text-[var(--adm-text)]">{copy.label}</span>
        {copy.progress ? <span className="tabular-nums">{copy.progress}</span> : null}
      </div>
      {copy.failure ? (
        <p className="whitespace-pre-wrap pl-6 text-[var(--adm-danger-text)]">{copy.failure.text}</p>
      ) : copy.summary ? (
        <p className="pl-6 text-[var(--adm-text-muted)]">{copy.summary}</p>
      ) : null}
      {copy.failure?.providerDetail ? (
        <p className="whitespace-pre-wrap pl-6 text-[var(--adm-danger-text)]">{copy.failure.providerDetail}</p>
      ) : null}
    </div>
  );
}

// ─── RunReceipt (D5 tier 4) ───────────────────────────────

/**
 * D5 tier 4 — the receipt. Renders in place of the plain `RunFinishedLine` /
 * `run_error` / `run_cancelled` text ONLY for the chat's most recent run
 * (`lastOutcome` — `ChatSummaryView.last_outcome`, matched by `run_id`);
 * older runs further up the transcript keep the plain line, since only the
 * latest run's `chips`/timing are available client-side.
 *
 * What changed: `outcome.chips` — already computed server-side (`runChips`,
 * `agent/loop.ts`) from exactly the same events this component could
 * re-derive, so it is read, not recomputed (W19's "one classifier" discipline
 * applies to this shape too). Where: the created-object links, when this run
 * created anything. Cost: omitted — no cost figure exists anywhere in the
 * chat/agent-loop protocol (see this task's final report). Undo: only when
 * the run's last successful write has a known exact inverse
 * (`lastUndoableWriteTool`/`undoPrompt`) — clicking it sends the ask back
 * into THIS chat, so the same agent that holds (or can reacquire) the
 * checkout/lock context performs it, through the same governed, interrupt-
 * capable path (tier 3) as any other write. No inverse, no button — never a
 * dead link.
 *
 * A3: this used to be its own bordered card restating severity, elapsed
 * time, the run's message, EVERY chip (including a lone "no changes" that
 * says nothing), created-object links, and Undo all at once — one more
 * voice repeating "Working / Failed" alongside the header chip and the
 * request card. It is now a single 12px muted line, right-aligned under the
 * assistant message: `✓ Done · 5s`. Everything else that used to sit in the
 * open — the run's own chips, its failure text, created-object links, Undo —
 * moves behind a `Popover mode="click"` ("details"), shown only when there
 * is something in it worth opening (`receiptLine`, `chat-liveness.ts`, also
 * decides whether the failure text renders there at all: a `RequestActivity`
 * card mounted for the same request already states a failed run once).
 */
function RunReceipt({
  outcome,
  message,
  providerDetail,
  events,
  onUndo,
  busy,
  hasRunCard = false,
}: {
  outcome: RunSummaryView;
  /** The `run_error` event's human message, when this receipt is for a failed run. */
  message?: string;
  /** Task B: an Owner-only second line — "provider <status>: <message>" — when the failure carried one. */
  providerDetail?: string;
  events: ChatEventView[];
  onUndo?: (prompt: string) => void;
  busy?: boolean;
  /** A `RequestActivity` card is mounted for this chat's request — see `receiptLine`. */
  hasRunCard?: boolean;
}) {
  const info = terminalReceiptInfo(outcome.outcome);
  const elapsed = elapsedMsSince(outcome.started_at, Date.parse(outcome.finished_at));
  const undoTool = lastUndoableWriteTool(events, outcome.run_id);
  const prompt = undoTool ? undoPrompt(undoTool) : undefined;
  const created = createdObjectsFromEvents(events, outcome.run_id);
  const decision = receiptLine({ outcome: outcome.outcome, chips: outcome.chips, message, hasRunCard });
  const hasDetails =
    decision.visibleChips.length > 0 ||
    (decision.showFailureText && Boolean(message || providerDetail)) ||
    created.length > 0 ||
    Boolean(prompt && onUndo);

  return (
    <div className="flex justify-end">
      <div className="flex max-w-[85%] items-center gap-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
        {info.severity === 'success' ? (
          <span aria-hidden="true">✓</span>
        ) : (
          <SeverityIcon level={info.severity} size={12} title="" />
        )}
        <span>{info.label}</span>
        {elapsed !== undefined ? <span className="tabular-nums">· {formatDuration(elapsed)}</span> : null}
        {hasDetails ? (
          <Popover
            mode="click"
            placement="top"
            trigger={(a11y) => (
              <button
                type="button"
                {...a11y}
                className="adm-focusable rounded text-[var(--adm-text-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--adm-text)]"
              >
                details
              </button>
            )}
            content={
              <div className="flex w-64 flex-col gap-2 text-[length:var(--adm-text-xs)]">
                {decision.showFailureText && message ? <p className="text-[var(--adm-text-muted)]">{message}</p> : null}
                {decision.showFailureText && providerDetail ? (
                  <p className="text-[var(--adm-text-muted)]">{providerDetail}</p>
                ) : null}
                {decision.visibleChips.length > 0 ? (
                  <p className="text-[var(--adm-text-muted)]">{decision.visibleChips.join(' · ')}</p>
                ) : null}
                {created.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {created.map((object) => (
                      <a
                        key={object.id}
                        href={`/admin/content/${encodeURIComponent(object.id)}${object.type ? `?type=${encodeURIComponent(object.type)}` : ''}`}
                        className="adm-focusable rounded-full border border-[var(--adm-border)] px-2 py-0.5 text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]"
                      >
                        Open {object.id}
                      </a>
                    ))}
                  </div>
                ) : null}
                {prompt && onUndo ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onUndo(prompt)}
                    className="adm-focusable w-fit rounded text-[var(--adm-accent)] hover:underline disabled:opacity-50"
                  >
                    Undo
                  </button>
                ) : null}
              </div>
            }
          />
        ) : null}
      </div>
    </div>
  );
}

// ─── ChatStateChip (D5 tier 1) ───────────────────────────────

/**
 * D5 tier 1 — the ambient header state chip: `working` / `waiting` /
 * `blocked` / `done`, elapsed time, and — while streaming — a distinct
 * "Writing…" reading instead of the generic `working` label. Always visible
 * while `deriveLivenessChip` has something to say (an active run, or a
 * recently-finished one); renders nothing for a chat that has never run.
 *
 * Colour is D4's, via `SeverityIcon` — `working` has none (D5: "working is
 * not a severity"), rendered as a plain pulsing accent dot instead.
 */
export function ChatStateChip({
  status,
  lastOutcome,
  events,
  lastEventAtMs,
}: {
  status: ChatStatus | undefined;
  lastOutcome: RunSummaryView | null | undefined;
  events: ChatEventView[];
  lastEventAtMs: number | undefined;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const chip = deriveLivenessChip(status, lastOutcome);
  const ticking = chip?.tier === 'working' || chip?.tier === 'waiting';
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  // A2: this is the ONE place `isStreamingNow` is computed (was also
  // computed a second time in `ChatThread`, for the trailing line that's now
  // retired — see `threadStatusVisibility`). Memoized since `events` is a
  // stable reference between the once-a-second `nowMs` ticks that don't
  // actually change the streaming read.
  //
  // ORDER IS LOAD-BEARING: every hook in this component must run BEFORE the
  // `if (!chip)` bail-out below. `deriveLivenessChip` returns `undefined` for
  // a chat that has never run (`status: 'idle'`, no `lastOutcome`) and a chip
  // once the first turn starts, so a memo placed after the early return would
  // change this component's hook COUNT between two renders of the same
  // instance — React throws "Rendered more hooks than during the previous
  // render" and unmounts the whole surface. `chat-liveness.test.ts` pins the
  // `undefined` case that triggers it.
  const streaming = useMemo(() => isStreamingNow(status, lastEventAtMs, nowMs), [status, lastEventAtMs, nowMs]);
  if (!chip) return null;
  const elapsed = elapsedMsForChip(chip.tier, events, lastOutcome, nowMs);
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-1.5 rounded-[var(--adm-radius-pill)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-2 py-0.5 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text)]"
    >
      {chip.severity ? (
        <SeverityIcon level={chip.severity} size={12} title="" />
      ) : (
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full bg-[var(--adm-accent)] ${streaming ? 'animate-bounce' : 'animate-pulse'}`}
          aria-hidden="true"
        />
      )}
      <span>{streaming ? 'Writing…' : chip.label}</span>
      {elapsed !== undefined ? (
        <span className="tabular-nums text-[var(--adm-text-muted)]">{formatDuration(elapsed)}</span>
      ) : null}
    </span>
  );
}

/**
 * W19 (Wolf, 2026-08-22): red is for a step that actually died.
 *
 * This card used to paint EVERY `is_error` tool result red and label it
 * "<tool> failed" — including a publish refused because the readiness
 * checklist said `no_go`, which is the guardrail doing its job. Wolf's words
 * on seeing it: *"the cross is given to proper agent behaviour, it should be a
 * warning in this case, nothing is broken and it continues."* Classification
 * now comes from `lib/admin/activity-severity.ts`, shared with the request
 * activity view so the two surfaces can never disagree about what red means.
 */
export function ToolCallCard({ event }: { event: ChatEventView }) {
  const isError = Boolean(event.detail?.is_error);
  const summary = toolLabel(event);
  const denied = event.type === 'tool_denied';
  const approved = event.type === 'tool_approved';

  const classified =
    event.type === 'tool_result'
      ? classifyToolResult({
          tool: String(event.detail?.tool ?? 'tool'),
          isError,
          output: event.detail?.output,
        })
      : undefined;
  // Rejecting a proposed write is a normal outcome of the approval protocol,
  // not an error — it has always rendered as a red ✗ too.
  const severity: Severity = classified?.severity ?? (denied ? DENIED_SEVERITY : 'ok');
  // B2 (T0.3 Table B): this was its own severity→icon/colour switch, hand-
  // copied from `RequestActivity.tsx`'s (B1) — the two drifted apart once
  // already. Both now render through T1.1's `<SeverityIcon>`. No retry
  // affordance exists on THIS card (a chat transcript row never offers one —
  // recovery lives in `RequestActivity`, a separate component), so a
  // `failure` here is always `blocked`, never `error`.
  const adminSeverity = severityFromActivity(severity, { canRetry: false });
  const label =
    event.type === 'tool_call'
      ? summary
      : event.type === 'tool_result'
        ? (classified?.label ?? summary)
        : denied
          ? `Rejected by ${String(event.detail?.by ?? 'the human')}`
          : approved
            ? `Approved by ${String(event.detail?.by ?? 'the human')}${event.detail?.edited ? ' (edited)' : ''}`
            : summary;
  // PF4: bounded workspace-orchestration output rides tool_result events —
  // rendered collapsed by default, never inline (P3.2's surviving idea).
  const rawOutput =
    event.type === 'tool_result' && typeof event.detail?.output === 'string' ? event.detail.output : undefined;
  let parsedOutput: unknown = rawOutput;
  if (rawOutput) {
    try {
      parsedOutput = JSON.parse(rawOutput);
    } catch {
      parsedOutput = rawOutput;
    }
  }
  return (
    <div className="flex flex-col gap-1 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-3 py-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
      <div className="flex items-center gap-2">
        <SeverityIcon level={adminSeverity} size={14} title="" />
        <span className="truncate">{label}</span>
      </div>
      {classified?.detail ? (
        <p className="pl-6 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{classified.detail}</p>
      ) : null}
      {rawOutput ? <JsonDisclosure label="Raw workspace output" value={parsedOutput} /> : null}
    </div>
  );
}

/**
 * D5 tier 2 — progress. Collapsed by default (the `/admin/publish` dock
 * convention — sections default collapsed, `ControlsCard.tsx`), expanding to
 * the run's steps: unchanged behaviour for a HISTORICAL activity group.
 *
 * `live` is true only for the trailing group of the currently-running turn —
 * there, the trigger row swaps its plain "N steps" text for T1.2's
 * `<RunProgress>` (step count + elapsed), so the collapsed dock itself reads
 * as active rather than as a static label. A2: the caller (`ChatThread`,
 * via `threadStatusVisibility`) also holds `live` false once a
 * `RequestActivity` card is mounted for this chat's request — that card
 * already live-renders the SAME run's step count, so this component falls
 * back to the plain static label rather than stating it a second time.
 * `totalSteps` is deliberately set
 * equal to `step`: the agent loop decides its own tool calls turn by turn, so
 * there is no fixed target to show a fraction of — this reports "N steps so
 * far", not a guessed percentage toward an unknown total. Cost is left
 * unset: no cost figure exists anywhere in the chat/agent-loop protocol (see
 * `chat-liveness.ts`'s module comment and this task's final report) — only a
 * request-bound run's SEPARATE `RequestActivity` poll knows a cost, and this
 * component does not duplicate that poll.
 */
function ActivityLine({
  events,
  preferenceScope = 'default',
  live = false,
  elapsedMs,
}: {
  events: ChatEventView[];
  preferenceScope?: string;
  live?: boolean;
  elapsedMs?: number;
}) {
  const storageKey = `platform:admin:activity:${preferenceScope}`;
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === 'expanded';
    } catch {
      return false;
    }
  });
  const steps = events.filter((event) => event.type === 'tool_call').length || events.length;
  const latest = [...events].reverse().find((event) => event.type === 'tool_call') ?? events.at(-1)!;
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      localStorage.setItem(storageKey, next ? 'expanded' : 'collapsed');
    } catch {
      // Preferences are best-effort in restricted storage contexts.
    }
  };
  return (
    <div className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] px-3 py-2">
      <button
        type="button"
        onClick={toggle}
        className="adm-focusable flex w-full items-center gap-3 text-left text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]"
        aria-expanded={expanded}
      >
        {live ? (
          <RunProgress
            step={steps}
            totalSteps={steps}
            label={toolLabel(latest)}
            elapsedMs={elapsedMs}
            className="min-w-0 flex-1"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">
            Activity · {steps} step{steps === 1 ? '' : 's'} · {toolLabel(latest)}
          </span>
        )}
        <span aria-hidden="true" className="shrink-0">
          {expanded ? '−' : '+'}
        </span>
      </button>
      {expanded ? (
        <div className="mt-2 flex flex-col gap-1">
          {events.map((event) => (
            <ToolCallCard key={event.seq} event={event} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ─── PendingApprovalCard ───────────────────────────────────

/**
 * A7 — the chat's pending tool-call approval, on the KIT card.
 *
 * This file used to carry its own `ApprovalCard`: a sunken panel, an
 * "Approval needed" eyebrow, a `<details>` wrapper around the payload, and
 * Approve / Reject on the left with Modify pushed to the far right as a bare
 * text button. Two unrelated components named `ApprovalCard` then existed in
 * one package (see `index.ts`'s header, now corrected). This is the migration
 * the T1.2 header always pointed at: ONE flat card, ONE row, Approve / Reject
 * / Modify side by side, from `./approval`.
 *
 * It stays an adapter and nothing more — every string and every branch below
 * comes from `pending-approval.ts`, because `.tsx` under `packages/core/admin`
 * is excluded from `tsconfig.test.json` and cannot be asserted on (BRIEF.md).
 *
 * The two chat-specific shapes the kit card had to learn (rather than be
 * forked for):
 *  - **Modify is an edited-args capture**, not a "why" — `modifyCapture`
 *    opens the textarea on the call's current JSON and refuses a draft that
 *    does not parse, keeping the edit. Confirming re-approves with the parsed
 *    arguments (`approve_tool` + `edited_args`), which is what Modify has
 *    always meant on this mechanism.
 *  - **No callbacks at all** when the decision belongs elsewhere (A9's
 *    Object Stage hand-off) or has already been submitted.
 */
function PendingApprovalCard({
  pending,
  onApprove,
  onReject,
  showActions = true,
  consumed = false,
}: {
  pending: PendingView;
  onApprove: (editedArgs?: Record<string, unknown>) => void;
  onReject: (reason?: string) => void;
  showActions?: boolean;
  /** This call_id has already been submitted (approve/reject) — no actions until the poll confirms it's gone. */
  consumed?: boolean;
}) {
  const summary = (pending as unknown as { summary?: string }).summary;
  const view = presentPendingApproval({
    tool: pending.tool,
    ...(summary !== undefined ? { summary } : {}),
    ...(pending.dry_run ? { dryRun: pending.dry_run } : {}),
    consumed,
    decidedElsewhere: !showActions,
  });

  // The chat's decision callbacks are fire-and-forget (`useChat` owns the
  // in-flight state and flips `pendingConsumed` on the claim, which swaps
  // this whole card to its receipt line). `<ActionRow>` wants promises, so
  // they are adapted here rather than changing `ChatThread`'s prop surface,
  // which three call sites outside this task's file list depend on.
  const decisions: ApprovalCardProps['actions'] = view.showActions
    ? {
        onApprove: async () => onApprove(),
        onReject: async (reason) => onReject(reason),
        onModify: async (draft) => {
          const parsed = parseEditedArgs(draft ?? '');
          // `modifyCapture.validate` already refused anything unparseable
          // before this ran; this is the type narrowing, not a second gate.
          if ('args' in parsed) onApprove(parsed.args);
        },
        modifyReason: 'required',
        modifyCapture: {
          initial: editedArgsDraft(pending.args),
          rows: 8,
          label: 'Edited arguments (JSON)',
          placeholder: 'The tool call’s arguments, as JSON',
          validate: editedArgsError,
        },
      }
    : {};

  return (
    <ApprovalCard severity={view.severity} title={view.title} cause={view.cause} actions={decisions}>
      <div className="flex flex-col gap-2">
        <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          Action: <code>{pending.tool}</code>
        </p>
        <JsonDisclosure label="Proposed arguments" value={pending.args} />
        {pending.dry_run ? <JsonDisclosure label="Dry-run details" value={pending.dry_run} /> : null}
      </div>
    </ApprovalCard>
  );
}

// ─── ChatThread ───────────────────────────────────

const HIDDEN_EVENTS = new Set(['run_started', 'events_trimmed']);

interface QuoteSelectionState {
  text: string;
  top: number;
  left: number;
}

export function ChatThread({
  events,
  status,
  pending,
  candidateSet,
  previewCandidateId,
  busy,
  onApprove,
  onReject,
  onPreviewCandidate,
  onChooseCandidate,
  onRejectCandidates,
  onQuote,
  onSendControls,
  emptyHint,
  preferenceScope,
  approvalInStage = false,
  pendingConsumed = false,
  lastOutcome,
  onUndo,
  isOwner = false,
  hasRunCard = false,
}: {
  events: ChatEventView[];
  status: ChatStatus | undefined;
  pending: PendingView | undefined;
  candidateSet?: CandidateSetView;
  previewCandidateId?: string;
  busy: boolean;
  onApprove: (editedArgs?: Record<string, unknown>) => void;
  onReject: (reason?: string) => void;
  onPreviewCandidate?: (candidateId: string) => void;
  onChooseCandidate?: (candidateId: string) => void;
  onRejectCandidates?: (reason: string) => void;
  /** Highlight-to-reference: called with the raw selected text when "Quote" is clicked. */
  onQuote?: (text: string) => void;
  /** Sends a `controls` submission brief through the same path as the composer. */
  onSendControls?: (text: string) => void;
  emptyHint?: React.ReactNode;
  preferenceScope?: string;
  approvalInStage?: boolean;
  /** From `chat.pendingConsumed` — `pending`'s call_id was already submitted. */
  pendingConsumed?: boolean;
  /** T3.1 (D5): `chat.lastOutcome` — powers the tier-4 receipt for the latest run. */
  lastOutcome?: RunSummaryView | null;
  /**
   * T3.1 (D5): `chat.lastEventAtMs` — kept on the prop surface for callers,
   * but no longer read by this component. A2 retired the trailing
   * "Working…/Writing…" line, this value's only consumer here; the
   * streaming-vs-silent read now lives solely in `ChatStateChip` (the
   * thread's single live indicator), which takes it directly.
   */
  lastEventAtMs?: number;
  /** T3.1 (D5): the receipt's Undo button sends this prompt back into the chat. */
  onUndo?: (prompt: string) => void;
  /**
   * Task B (provider-error-details): whether the CURRENT viewer is an Owner —
   * decided by the surface that already resolves roles (mirrors
   * `AgentRail`'s `canUseTestMode`: this component does not resolve roles
   * itself). Gates the second "provider <status>: <message>" line on a
   * `run_error`; default false, so every existing caller renders exactly as
   * it did before this line existed.
   */
  isOwner?: boolean;
  /**
   * A2/A3/A4: a `RequestActivity` card is mounted (in `AgentsHub`) for this
   * chat's bound request — the ONE prop this whole wave threads down to
   * suppress everything in the thread that would otherwise restate what
   * that card already shows (trailing activity progress, the run
   * receipt's own failure text, the sweeper's progress line).
   */
  hasRunCard?: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** False until the first scroll-to-bottom with content: opening a
   *  conversation LANDS on the latest message instantly (like any chat app);
   *  only subsequent appends animate. Reset by remount (the hub keys this
   *  component by conversation id). */
  const settledAtBottom = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const [quoteSelection, setQuoteSelection] = useState<QuoteSelectionState | undefined>(undefined);
  // T3.1 (D5): a local clock for the live activity group's elapsed time —
  // ticking only while there is something worth ticking for, same pattern as
  // `RequestActivity`'s own node clock.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const running = status === 'running';
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  useEffect(() => {
    if (atBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: settledAtBottom.current ? 'smooth' : 'auto', block: 'end' });
      if (events.length > 0) settledAtBottom.current = true;
    } else {
      setShowLatest(true);
    }
  }, [events.length, pending, candidateSet, status]);

  // Highlight-to-reference: track a text selection made inside the transcript
  // and show a floating "Quote" pill above it (only while onQuote is wired up).
  const updateQuoteSelection = useCallback(() => {
    if (!onQuote) return;
    const container = scrollRef.current;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    if (!selectionWithinContainer(selection, container)) {
      setQuoteSelection(undefined);
      return;
    }
    const text = selection!.toString();
    if (!text.trim()) {
      setQuoteSelection(undefined);
      return;
    }
    const rect = selection!.getRangeAt(0).getBoundingClientRect();
    const containerRect = container!.getBoundingClientRect();
    setQuoteSelection({
      text,
      top: Math.max(0, rect.top - containerRect.top + container!.scrollTop - 8),
      left: rect.left - containerRect.left + container!.scrollLeft + rect.width / 2,
    });
  }, [onQuote]);

  useEffect(() => {
    if (!onQuote || typeof document === 'undefined') return;
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) setQuoteSelection(undefined);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [onQuote]);

  useEffect(() => {
    if (!quoteSelection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      window.getSelection()?.removeAllRanges();
      setQuoteSelection(undefined);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [quoteSelection]);

  const handleQuoteClick = () => {
    if (!quoteSelection) return;
    onQuote?.(quoteSelection.text);
    window.getSelection()?.removeAllRanges();
    setQuoteSelection(undefined);
  };

  const timeline = groupChatEvents(events.filter((event) => !HIDDEN_EVENTS.has(event.type)));
  // Submitted-state for a `controls` block is derived from the transcript itself
  // (rule 4 of the protocol) — never from local component state.
  const userMessages = events.filter((event) => event.type === 'user_message');
  const laterUserTextsAfter = (seq: number): string[] =>
    userMessages.filter((event) => event.seq > seq).map((event) => String(event.detail?.text ?? ''));
  // T3.1 (D5 tier 2): only the trailing activity group of an actually-running
  // turn gets the live `<RunProgress>` treatment — a historical group (from a
  // finished run, further up the transcript) keeps the plain static summary.
  const liveActivityElapsedMs = running ? elapsedMsForChip('working', events, lastOutcome, nowMs) : undefined;
  // A2: `ChatStateChip` (the header) is the thread's single live indicator —
  // this decides what, if anything, else may still say "still going".
  const visibility = threadStatusVisibility({ running, hasRunCard });

  return (
    <div
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current;
        if (!el) return;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
        if (atBottom.current) setShowLatest(false);
        // Selection coordinates are relative to scrollTop — don't chase them, just hide.
        if (quoteSelection) setQuoteSelection(undefined);
      }}
      onMouseUp={updateQuoteSelection}
      className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1"
      role="log"
      aria-label="Conversation"
    >
      {onQuote && quoteSelection ? (
        <button
          type="button"
          style={{ top: quoteSelection.top, left: quoteSelection.left }}
          className="adm-focusable absolute z-10 -translate-x-1/2 -translate-y-full rounded-full border border-[var(--adm-border-strong)] bg-[var(--adm-surface-raised)] px-2.5 py-1 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text)] shadow-[var(--adm-shadow-md)] hover:border-[var(--adm-accent)] hover:text-[var(--adm-accent)]"
          onClick={handleQuoteClick}
        >
          Quote
        </button>
      ) : null}
      {events.length === 0 && status === undefined ? emptyHint : null}
      {timeline.map((item, index) => {
        const isLast = index === timeline.length - 1;
        if (item.kind === 'activity')
          return (
            <ActivityLine
              key={`activity-${item.events[0]?.seq}`}
              events={item.events}
              preferenceScope={preferenceScope}
              live={isLast && visibility.activityProgress}
              elapsedMs={isLast && visibility.activityProgress ? liveActivityElapsedMs : undefined}
            />
          );
        const event = item.event;
        if (event.type === 'user_message' || event.type === 'assistant_text') {
          return (
            <ChatMessage
              key={event.seq}
              event={event}
              laterUserTexts={event.type === 'assistant_text' ? laterUserTextsAfter(event.seq) : undefined}
              busy={busy}
              onSendControls={onSendControls}
            />
          );
        }
        // T3.1 (D5 tier 4): the LATEST run's terminal event gets the full
        // receipt (chips, cost-if-any, undo) — `lastOutcome` only carries
        // the most recent run's summary, so an older run further up the
        // transcript falls through to the plain line it always rendered.
        const isLatestRun = lastOutcome != null && event.detail?.run_id === lastOutcome.run_id;
        if (event.type === 'run_finished') {
          if (isLatestRun) {
            return (
              <RunReceipt
                key={event.seq}
                outcome={lastOutcome}
                events={events}
                onUndo={onUndo}
                busy={busy}
                hasRunCard={hasRunCard}
              />
            );
          }
          return <RunFinishedLine key={event.seq} event={event} />;
        }
        if (event.type === 'run_error') {
          const copy = runErrorCopy(event.detail, isOwner);
          if (isLatestRun) {
            return (
              <RunReceipt
                key={event.seq}
                outcome={lastOutcome}
                message={copy.text}
                providerDetail={copy.providerDetail}
                events={events}
                onUndo={onUndo}
                busy={busy}
                hasRunCard={hasRunCard}
              />
            );
          }
          return (
            <p key={event.seq} className="text-center text-[length:var(--adm-text-xs)] text-[var(--adm-danger)]">
              The run hit a problem: {copy.text}
              {copy.providerDetail ? ` — ${copy.providerDetail}` : ''}
            </p>
          );
        }
        if (event.type === 'run_cancelled') {
          if (isLatestRun) {
            return (
              <RunReceipt
                key={event.seq}
                outcome={lastOutcome}
                events={events}
                onUndo={onUndo}
                busy={busy}
                hasRunCard={hasRunCard}
              />
            );
          }
          return (
            <p key={event.seq} className="text-center text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              Run cancelled.
            </p>
          );
        }
        if (event.type === 'tool_approval_required') return null; // rendered live via `pending`
        if (event.type === 'candidate_set') return null; // rendered live via `candidateSet`
        if (event.type === 'candidate_selected') {
          return (
            <p key={event.seq} className="text-center text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              Version {String(event.detail?.label ?? '').toUpperCase()} selected — preparing the governed change.
            </p>
          );
        }
        if (event.type === 'candidate_rejected') {
          return (
            <p key={event.seq} className="text-center text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              All versions rejected — trying a new direction.
            </p>
          );
        }
        // W19: the sweeper's own status line — never the generic
        // `ToolCallCard` (see `RequestProgressLine`'s own comment for why
        // that silently misrendered a `failed` transition as `ok`).
        if (event.type === 'request_progress') {
          // A4: a `RequestActivity` card mounted for this same request
          // already shows this progress live — defer to it entirely rather
          // than restating the sweeper's line a second time in the thread.
          if (hasRunCard) return null;
          return <RequestProgressLine key={event.seq} event={event} isOwner={isOwner} />;
        }
        return <ToolCallCard key={event.seq} event={event} />;
      })}
      {candidateSet && onPreviewCandidate && onChooseCandidate && onRejectCandidates ? (
        <CandidateSetCard
          set={candidateSet}
          selectedId={previewCandidateId}
          busy={busy}
          onPreview={onPreviewCandidate}
          onChoose={onChooseCandidate}
          onReject={onRejectCandidates}
        />
      ) : null}
      {pending ? (
        <PendingApprovalCard
          pending={pending}
          onApprove={onApprove}
          onReject={onReject}
          showActions={!approvalInStage}
          consumed={pendingConsumed}
        />
      ) : null}
      {showLatest ? (
        <Button
          size="sm"
          variant="secondary"
          className="sticky bottom-2 self-center"
          onClick={() => {
            atBottom.current = true;
            setShowLatest(false);
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
        >
          Jump to latest
        </Button>
      ) : null}
      <div ref={bottomRef} />
    </div>
  );
}

// ─── ChatComposer ───────────────────────────────────

export function ChatComposer({
  status,
  busy,
  onSend,
  onCancel,
  suggestions,
  contextActions,
  draftSeed,
  quote,
  above,
  runMode,
}: {
  status: ChatStatus | undefined;
  busy: boolean;
  onSend: (text: string) => void;
  onCancel?: () => void;
  suggestions?: string[];
  contextActions?: Array<{ id: string; label: string; text: string }>;
  draftSeed?: { key: string; text: string };
  /** Highlight-to-reference: a raw selection to insert as a blockquote (appended below any existing draft). */
  quote?: { token: number; text: string };
  /** The readiness strip mounts directly above the composer (plan §4). */
  above?: React.ReactNode;
  /**
   * A5: the run-mode segmented pill (`RunApprovalControls`), anchored to the
   * bottom-left of the input row — same corner Claude's own UI puts its
   * model/mode control — instead of a full-width row above the composer.
   * Optional so a composer with no run-mode concept (none exists today, but
   * `ChatComposer` shouldn't assume one) renders exactly as before.
   */
  runMode?: React.ReactNode;
}) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();
  const dictation = useDictation({
    value: text,
    onChange: setText,
    onError: (error) => {
      toast({
        title: error === 'not-allowed' ? 'Microphone access was denied' : 'Dictation stopped',
        description: error === 'not-allowed' ? 'Allow microphone access to dictate, or type your message.' : undefined,
        tone: 'warning',
      });
    },
  });
  const live =
    status === 'queued' || status === 'running' || status === 'awaiting_approval' || status === 'awaiting_candidate';
  useEffect(() => {
    if (draftSeed) setText(draftSeed.text);
  }, [draftSeed]);
  useEffect(() => {
    if (!quote) return;
    setText((prev) => {
      const inserted = insertQuoteIntoDraft(prev, quote.text);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(inserted.cursor, inserted.cursor);
        }
      });
      return inserted.text;
    });
  }, [quote]);
  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || live || busy) return;
    dictation.stop();
    onSend(trimmed);
    setText('');
  };
  return (
    <div className="flex flex-col gap-2">
      {above}
      {!live && contextActions && contextActions.length > 0 ? (
        <div>
          <p className="mb-1.5 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text-muted)]">
            Quick context
          </p>
          <div className="flex flex-wrap gap-1.5">
            {contextActions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="adm-focusable rounded-full border border-[var(--adm-border)] bg-[var(--adm-surface)] px-2.5 py-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)] hover:border-[var(--adm-accent)] hover:text-[var(--adm-text)]"
                onClick={() => setText(action.text)}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {!live && suggestions && suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.slice(0, 4).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="adm-focusable rounded-full border border-[var(--adm-border)] bg-[var(--adm-surface)] px-2.5 py-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)] hover:border-[var(--adm-accent)] hover:text-[var(--adm-text)]"
              onClick={() => setText(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && dictation.listening) {
              event.preventDefault();
              dictation.stop();
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder={
            status === 'awaiting_candidate'
              ? 'Preview and pick a version above…'
              : live
                ? 'The agent is working — approve, reject, or wait…'
                : 'Ask for a change or describe what you need…'
          }
          aria-label="Message the agent"
          disabled={busy && !live}
          className="flex-1"
        />
        {dictation.supported ? (
          <MicButton listening={dictation.listening} onToggle={dictation.toggle} disabled={busy && !live} />
        ) : null}
        {live && onCancel ? (
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Stop
          </Button>
        ) : (
          <Button
            onClick={submit}
            disabled={busy || live || text.trim().length === 0}
            leftIcon={<IconSend size={16} />}
          >
            Send
          </Button>
        )}
      </div>
      {/* A5: bottom-left of the composer, the same corner Claude's own UI
          puts its model/mode control — never a full-width row above it. */}
      {runMode ? <div className="flex items-center justify-start">{runMode}</div> : null}
    </div>
  );
}
