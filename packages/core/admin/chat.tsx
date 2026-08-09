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
import { IconAlertTriangle, IconCheck, IconRobot, IconSend, IconX } from './icons';
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
  type ChatView,
  type PendingView,
} from '@core/lib/admin/chat-client';
import type { CandidateOptionView, CandidateSetView } from '@core/lib/admin/candidate-choice';
import type { GetToken } from '@core/lib/edit-mode/verbs-client';
import { groupChatEvents, toolLabel } from '@core/lib/admin/chat-logic';

// ─── useChat: since_seq polling over get_chat ────────────────────────────────

export interface UseChatState {
  status: ChatStatus | undefined;
  events: ChatEventView[];
  pending: PendingView | undefined;
  candidateSet: CandidateSetView | undefined;
  previewCandidate: CandidateOptionView | undefined;
  agent: AgentView | undefined;
  error: string | undefined;
  busy: boolean;
  send: (text: string, focus?: string) => Promise<void>;
  preview: (candidateId: string | undefined) => void;
  chooseCandidate: (candidateId: string) => Promise<void>;
  rejectCandidates: (reason: string) => Promise<void>;
  approve: (callId: string, editedArgs?: Record<string, unknown>) => Promise<{ approved: boolean; saved: boolean }>;
  deny: (callId: string, reason?: string) => Promise<void>;
  cancel: () => Promise<void>;
  /** Bumps whenever an executed (non-error) write tool result arrives — preview refresh signal. */
  writeStamp: number;
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
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [writeStamp, setWriteStamp] = useState(0);
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const liveRef = useRef(true);

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
      const view = await getChat(getToken, chatId, seqRef.current);
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
    async (callId: string, editedArgs?: Record<string, unknown>): Promise<{ approved: boolean; saved: boolean }> => {
      if (!chatId) return { approved: false, saved: false };
      setBusy(true);
      try {
        const result = await approveTool(getToken, chatId, callId, editedArgs);
        setError(undefined);
        return { approved: result.approved, saved: !result.is_error };
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : 'Action failed.');
        return { approved: false, saved: false };
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
    error,
    busy,
    writeStamp,
    send: (text, focus) => wrap(() => sendChatMessage(getToken, chatId!, text, focus)),
    preview: setPreviewCandidateId,
    chooseCandidate: (candidateId) =>
      wrap(async () => {
        if (!candidateSet) return;
        await chooseCandidateRequest(getToken, chatId!, candidateSet.call_id, candidateId);
        setCandidateSet(undefined);
        setPreviewCandidateId(undefined);
      }),
    rejectCandidates: (reason) =>
      wrap(async () => {
        if (!candidateSet) return;
        await rejectCandidatesRequest(getToken, chatId!, candidateSet.call_id, reason);
        setCandidateSet(undefined);
        setPreviewCandidateId(undefined);
      }),
    approve,
    deny: (callId, reason) => wrap(() => denyTool(getToken, chatId!, callId, reason)),
    cancel: () => wrap(() => cancelChatRun(getToken, chatId!)),
  };
}

// ─── AgentChip ───────────────────────────────────────────────────────────────

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
        {agent?.name ?? 'Site Agent'}
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

// ─── message + tool cards ────────────────────────────────────────────────────

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

export function ChatMessage({ event }: { event: ChatEventView }) {
  if (event.type === 'user_message') {
    return (
      <Bubble mine>
        <span className="whitespace-pre-wrap">{String(event.detail?.text ?? '')}</span>
      </Bubble>
    );
  }
  return (
    <div className="max-w-none px-1 py-1 text-[length:var(--adm-text-sm)] leading-6 text-[var(--adm-text)]">
      <Markdown>{String(event.detail?.text ?? '')}</Markdown>
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

export function ToolCallCard({ event }: { event: ChatEventView }) {
  const isError = Boolean(event.detail?.is_error);
  const summary = toolLabel(event);
  const denied = event.type === 'tool_denied';
  const approved = event.type === 'tool_approved';
  const icon = denied || isError ? <IconX size={14} /> : approved ? <IconCheck size={14} /> : <IconCheck size={14} />;
  const tone = denied || isError ? 'text-[var(--adm-danger)]' : 'text-[var(--adm-success)]';
  const label =
    event.type === 'tool_call'
      ? summary
      : event.type === 'tool_result'
        ? `${String(event.detail?.tool ?? 'tool')} ${isError ? 'failed' : 'finished'}`
        : denied
          ? `Declined by ${String(event.detail?.by ?? 'the human')}`
          : approved
            ? `Approved by ${String(event.detail?.by ?? 'the human')}${event.detail?.edited ? ' (edited)' : ''}`
            : summary;
  return (
    <div className="flex items-center gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-3 py-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
      <span className={tone}>{icon}</span>
      <span className="truncate">{label}</span>
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

// ─── ApprovalCard ────────────────────────────────────────────────────────────

export function ApprovalCard({
  pending,
  busy,
  onApprove,
  onDeny,
  showActions = true,
}: {
  pending: PendingView;
  busy: boolean;
  onApprove: (editedArgs?: Record<string, unknown>) => void;
  onDeny: (reason?: string) => void;
  showActions?: boolean;
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

        {!showActions ? (
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

// ─── ChatThread ──────────────────────────────────────────────────────────────

const HIDDEN_EVENTS = new Set(['run_started', 'events_trimmed']);

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
  emptyHint,
  preferenceScope,
  approvalInStage = false,
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
  emptyHint?: React.ReactNode;
  preferenceScope?: string;
  approvalInStage?: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => {
    if (atBottom.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    else setShowLatest(true);
  }, [events.length, pending, candidateSet, status]);

  const timeline = groupChatEvents(events.filter((event) => !HIDDEN_EVENTS.has(event.type)));

  return (
    <div
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current;
        if (!el) return;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
        if (atBottom.current) setShowLatest(false);
      }}
      className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1"
      role="log"
      aria-label="Conversation"
    >
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
          return <ChatMessage key={event.seq} event={event} />;
        }
        if (event.type === 'run_finished') return null;
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

// ─── ChatComposer ────────────────────────────────────────────────────────────

export function ChatComposer({
  status,
  busy,
  onSend,
  onCancel,
  suggestions,
  contextActions,
  draftSeed,
  above,
}: {
  status: ChatStatus | undefined;
  busy: boolean;
  onSend: (text: string) => void;
  onCancel?: () => void;
  suggestions?: string[];
  contextActions?: Array<{ id: string; label: string; text: string }>;
  draftSeed?: { key: string; text: string };
  /** The readiness strip mounts directly above the composer (plan §4). */
  above?: React.ReactNode;
}) {
  const [text, setText] = useState('');
  const live =
    status === 'queued' || status === 'running' || status === 'awaiting_approval' || status === 'awaiting_candidate';
  useEffect(() => {
    if (draftSeed) setText(draftSeed.text);
  }, [draftSeed]);
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
