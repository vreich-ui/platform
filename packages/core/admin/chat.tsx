/**
 * Chat primitives (T9.14, plan §3/§4): ChatThread, ChatMessage, ToolCallCard,
 * ApprovalCard, AgentChip, ChatComposer, and the useChat polling hook over the
 * T9.13 protocol. The thread header always shows WHICH agent is speaking
 * (§4a); every write shows an ApprovalCard with the tool's human summary, the
 * args, the server-computed dry-run, and Approve / Edit-and-approve / Deny.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Avatar, Button, Card } from './primitives';
import { Markdown } from './Markdown';
import { Textarea } from './forms';
import { useToast } from './overlays';
import { ControlsCard } from './ControlsCard';
import { IconAlertTriangle, IconCheck, IconInfo, IconRobot, IconSend, IconX } from './icons';
import {
  approveTool,
  cancelChatRun,
  chooseCandidate as chooseCandidateRequest,
  denyTool,
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
} from '@core/lib/admin/chat-client';
import type { CandidateOptionView, CandidateSetView } from '@core/lib/admin/candidate-choice';
import type { GetToken } from '@core/lib/edit-mode/verbs-client';
import { groupChatEvents, toolLabel } from '@core/lib/admin/chat-logic';
import { DENIED_SEVERITY, classifyToolResult, type Severity } from '@core/lib/admin/activity-severity';
import { createApprovalClaim } from '@core/lib/admin/object-context-actions';
import { insertQuoteIntoDraft, selectionWithinContainer } from '@core/lib/admin/chat-quote';
import { findControlsSubmissionText, splitControlsSegments } from '@core/lib/admin/chat-controls';

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
  error: string | undefined;
  busy: boolean;
  send: (text: string, focus?: string) => Promise<void>;
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

  const ingest = useCallback((view: ChatView) => {
    setStatus(view.status);
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
    if (view.events.length > 0) {
      seqRef.current = Math.max(seqRef.current, ...view.events.map((event) => event.seq));
      setEvents((prior) => [...prior, ...view.events.filter((event) => !prior.some((p) => p.seq === event.seq))]);
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
    setCandidateSet(undefined);
    setPreviewCandidateId(undefined);
    setRequest(undefined);
    requestRef.current = undefined;
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
        const result = await approveTool(getToken, chatId, callId, editedArgs);
        setError(undefined);
        // The server didn't consume it (e.g. already-decided elsewhere) — free
        // it up so a genuine retry isn't permanently blocked.
        if (!result.approved) claimRef.current.release(callId);
        // Execution is async now (Task 5): the card clears on approval; the
        // tool's success/failure arrives as a normal `tool_result` event via
        // the poll, not here.
        return { approved: result.approved };
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
    error,
    busy,
    writeStamp,
    pendingConsumed: pending !== undefined && claimRef.current.has(pending.call_id),
    send: (text, focus) => wrap(() => sendChatMessage(getToken, chatId!, text, focus)),
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
    // Decline shares `pending.call_id` with Approve — claiming through the
    // same guard means a click on one disables the other immediately, not
    // just after the next poll.
    deny: (callId, reason) => {
      if (!claimRef.current.claim(callId)) return Promise.resolve();
      return wrap(async () => {
        try {
          await denyTool(getToken, chatId!, callId, reason);
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
  // Declining a proposed write is a normal outcome of the approval protocol,
  // not an error — it has always rendered as a red ✗ too.
  const severity: Severity = classified?.severity ?? (denied ? DENIED_SEVERITY : 'ok');

  const icon =
    severity === 'failure' ? (
      <IconX size={14} />
    ) : severity === 'attention' ? (
      <IconAlertTriangle size={14} />
    ) : severity === 'notice' ? (
      <IconInfo size={14} />
    ) : (
      <IconCheck size={14} />
    );
  const tone =
    severity === 'failure'
      ? 'text-[var(--adm-danger)]'
      : severity === 'attention'
        ? 'text-[var(--adm-warning-text)]'
        : severity === 'notice'
          ? 'text-[var(--adm-text-muted)]'
          : 'text-[var(--adm-success)]';
  const label =
    event.type === 'tool_call'
      ? summary
      : event.type === 'tool_result'
        ? (classified?.label ?? summary)
        : denied
          ? `Declined by ${String(event.detail?.by ?? 'the human')}`
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
        <span className={tone}>{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      {classified?.detail ? (
        <p className="pl-6 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{classified.detail}</p>
      ) : null}
      {rawOutput ? <JsonDisclosure label="Raw workspace output" value={parsedOutput} /> : null}
    </div>
  );
}

function ActivityLine({ events, preferenceScope = 'default' }: { events: ChatEventView[]; preferenceScope?: string }) {
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
        className="adm-focusable flex w-full items-center justify-between gap-3 text-left text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]"
        aria-expanded={expanded}
      >
        <span className="truncate">
          Activity · {steps} step{steps === 1 ? '' : 's'} · {toolLabel(latest)}
        </span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
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

// ─── ApprovalCard ───────────────────────────────────

export function ApprovalCard({
  pending,
  busy,
  onApprove,
  onDeny,
  showActions = true,
  consumed = false,
}: {
  pending: PendingView;
  busy: boolean;
  onApprove: (editedArgs?: Record<string, unknown>) => void;
  onDeny: (reason?: string) => void;
  showActions?: boolean;
  /** This call_id has already been submitted (approve/deny) — hide actions until the poll confirms it's gone. */
  consumed?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | undefined>(undefined);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const { toast } = useToast();

  const dryRunSummary = useMemo(() => {
    const dryRun = pending.dry_run;
    if (!dryRun) return undefined;
    if (dryRun.error) return { tone: 'danger' as const, text: `Preview failed: ${String(dryRun.error)}` };
    if (dryRun.eligible === false || (dryRun.summary as { eligible?: boolean } | undefined)?.eligible === false) {
      return { tone: 'warning' as const, text: 'Preview ran — validation reports blockers (see details).' };
    }
    return { tone: 'success' as const, text: 'Preview ran clean — the change validates.' };
  }, [pending.dry_run]);

  const startEdit = () => {
    setDraft(JSON.stringify(pending.args, null, 2));
    setDraftError(undefined);
    setEditing(true);
  };
  const approveEdited = () => {
    try {
      const parsed = JSON.parse(draft) as Record<string, unknown>;
      onApprove(parsed);
    } catch {
      setDraftError('Not valid JSON.');
      toast({ title: 'Edited args are not valid JSON', tone: 'danger' });
    }
  };

  const title = String((pending as unknown as { summary?: string }).summary ?? `Run ${pending.tool}`);

  return (
    <div className="rounded-[var(--adm-radius-lg)] border border-[var(--adm-border-strong)] bg-[var(--adm-surface-sunken)] p-3 shadow-[var(--adm-shadow-sm)]">
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-[var(--adm-accent)]">
            <IconAlertTriangle size={15} />
          </span>
          <div className="min-w-0">
            <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
              Approval needed
            </p>
            <p className="mt-0.5 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-heading)]">
              {title}
            </p>
          </div>
        </div>
        {dryRunSummary ? (
          <p
            className={
              dryRunSummary.tone === 'success'
                ? 'text-[length:var(--adm-text-sm)] text-[var(--adm-success)]'
                : dryRunSummary.tone === 'warning'
                  ? 'text-[length:var(--adm-text-sm)] text-[var(--adm-warning)]'
                  : 'text-[length:var(--adm-text-sm)] text-[var(--adm-danger)]'
            }
          >
            {dryRunSummary.text}
          </p>
        ) : null}
        <details>
          <summary className="adm-focusable cursor-pointer rounded text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text-muted)]">
            Review details
          </summary>
          <div className="mt-2 flex flex-col gap-2 border-l border-[var(--adm-border)] pl-3">
            <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              Action: <code>{pending.tool}</code>
            </p>
            <JsonDisclosure label="Proposed arguments" value={pending.args} />
            {pending.dry_run ? <JsonDisclosure label="Dry-run details" value={pending.dry_run} /> : null}
          </div>
        </details>

        {consumed ? (
          <p className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-muted)]">
            Approved — waiting for the agent…
          </p>
        ) : !showActions ? (
          <p className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-muted)]">
            Review the proposal here, then save it from the Object Stage.
          </p>
        ) : editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={8}
              aria-label="Edited arguments (JSON)"
              error={draftError}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={approveEdited} loading={busy}>
                Approve edited
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
                Back
              </Button>
            </div>
          </div>
        ) : denying ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              placeholder="Why not? (optional — the agent sees this)"
              aria-label="Denial reason"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="danger" onClick={() => onDeny(reason || undefined)} loading={busy}>
                Deny
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDenying(false)} disabled={busy}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => onApprove()} loading={busy}>
              Approve
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setDenying(true)} disabled={busy}>
              Decline
            </Button>
            <button
              type="button"
              onClick={startEdit}
              disabled={busy}
              className="adm-focusable ml-auto rounded px-1.5 py-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)] hover:text-[var(--adm-text)] disabled:opacity-50"
            >
              Edit request
            </button>
          </div>
        )}
      </div>
    </div>
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
  onDeny,
  onPreviewCandidate,
  onChooseCandidate,
  onRejectCandidates,
  onQuote,
  onSendControls,
  emptyHint,
  preferenceScope,
  approvalInStage = false,
  pendingConsumed = false,
}: {
  events: ChatEventView[];
  status: ChatStatus | undefined;
  pending: PendingView | undefined;
  candidateSet?: CandidateSetView;
  previewCandidateId?: string;
  busy: boolean;
  onApprove: (editedArgs?: Record<string, unknown>) => void;
  onDeny: (reason?: string) => void;
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
      {timeline.map((item) => {
        if (item.kind === 'activity')
          return (
            <ActivityLine
              key={`activity-${item.events[0]?.seq}`}
              events={item.events}
              preferenceScope={preferenceScope}
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
        if (event.type === 'run_finished') return <RunFinishedLine key={event.seq} event={event} />;
        if (event.type === 'run_error') {
          return (
            <p key={event.seq} className="text-center text-[length:var(--adm-text-xs)] text-[var(--adm-danger)]">
              The run hit a problem: {String(event.detail?.message ?? 'unknown error')}
            </p>
          );
        }
        if (event.type === 'run_cancelled') {
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
              All versions declined — trying a new direction.
            </p>
          );
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
        <ApprovalCard
          pending={pending}
          busy={busy}
          onApprove={onApprove}
          onDeny={onDeny}
          showActions={!approvalInStage}
          consumed={pendingConsumed}
        />
      ) : null}
      {status === 'queued' || status === 'running' ? (
        <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          <span className="mr-1 inline-block animate-pulse">●</span>
          {status === 'queued' ? 'Waking the agent…' : 'Working…'}
        </p>
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
}) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
                ? 'The agent is working — approve, deny, or wait…'
                : 'Ask for a change or describe what you need…'
          }
          aria-label="Message the agent"
          disabled={busy && !live}
          className="flex-1"
        />
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
    </div>
  );
}
