/**
 * W19 — the live view of a workflow run, for the chat transcript and the
 * request detail page.
 *
 * An article is 23 nodes and several minutes; until now the chat showed
 * nothing at all while that ran. This is the window into it: one line that is
 * always true, a node timeline behind a disclosure, and a per-node detail for
 * the editor who wants to know which tool took the time.
 *
 * Colour comes from the server's `severity`, run through D4
 * (`@core/lib/admin/severity`'s `severityFromActivity`, T2.3) — `attention`
 * is D4 `needs_you` (amber), a `failure` next to a retry affordance is
 * `error` and one without is `blocked` (both red; the split is the icon
 * shape, not the colour — see `SeverityGlyph`'s own comment).
 *
 * ONE deliberate exception, kept rather than silently upgraded: per Wolf's
 * ruling, `notice` stays the muted grey it always was, not D4's brighter
 * `info` blue — an editor's eye must pass over the handled things so that a
 * real red still means something. `severity.ts`'s own adapter docstring
 * flags "should notice become info" as a UI-layer/prominence question that
 * task deliberately left open; this component's answer is no, for exactly
 * the reason the original comment (below, kept) gives. This component never
 * re-classifies beyond that one named exception.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Button, Skeleton } from './primitives';
import { ActionRow } from './approval';
import { decide, type DecisionAction } from '@core/lib/admin/decisions';
import { SeverityIcon } from './severity';
import { IconChevronDown, IconChevronRight, IconInfo } from './icons';
import { cn } from './utils';
import {
  activityPollIntervalFor,
  formatDuration,
  formatEta,
  formatShortDuration,
  formatUsd,
  getRequestActivityIfChanged,
  type ActivityNodeView,
  type ActivitySeverity,
  type ActivityView,
} from '@core/lib/admin/requests-client';
import { severityFromActivity, type AdminSeverity } from '@core/lib/admin/severity';
import { relativeAge } from '@core/lib/admin/request-logic';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

/**
 * The ONE cadence still decided here: the fetch itself threw, so there is no
 * response and `activityPollIntervalFor` has nothing to rule on. Every other
 * interval — including a bridge that is down and a run that has not started —
 * is the server's call now, via `retry_ms`.
 */
/** A hidden tab schedules nothing; the visibility handler re-arms the chain on return. */
const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

const UNREACHABLE_POLL_MS = 20_000;

/**
 * T2.3/T3.1 (T0.3 Table B rows B1/B2/B10) — colour and glyph now come from D4
 * (`@core/lib/admin/severity`, `./severity.tsx`) via `severityFromActivity`,
 * not from a private tint table keyed on `activity-severity.ts`'s four-level
 * `severityTone`. This used to be its own severity→icon switch, hand-copied
 * from the one in `chat.tsx`'s `ToolCallCard` (B2) — the two would drift the
 * next time either changed; both now render through T1.1's `<SeverityIcon>`.
 * The split this closes: `failure` used to render the same bare ✕ whether or
 * not a "Retry this step" button sat right next to it on the same card — now
 * a `failure` with a retry available (`canRetry`, below) is D4 `error`
 * (circle-!), and one without is `blocked` (octagon). Both remain red — D4
 * says colour, not shape, is what "died" means, and this split is about
 * telling the two dead-ends apart, not about un-reddening either of them.
 */
const BAR_FILL: Record<AdminSeverity, string> = {
  info: 'bg-[var(--adm-info)]',
  success: 'bg-[var(--adm-success)]',
  needs_you: 'bg-[var(--adm-warning)]',
  error: 'bg-[var(--adm-danger)]',
  blocked: 'bg-[var(--adm-danger)]',
};

// ─── pure helpers (exported so they can be tested outside this folder) ───────

export const progressPercent = (done: number, total: number): number =>
  total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;

/**
 * The one timing string a node row carries. The comparison against
 * `typical_ms` appears only when there is something to notice — otherwise
 * every row would repeat a number nobody asked for.
 */
export function nodeDurationPhrase(
  node: Pick<ActivityNodeView, 'status' | 'started_at' | 'duration_ms' | 'typical_ms' | 'overrunning'>,
  nowMs: number
): string | undefined {
  const startedAt = node.started_at ? Date.parse(node.started_at) : Number.NaN;
  const elapsed =
    node.duration_ms ??
    (node.status === 'running' && Number.isFinite(startedAt) ? Math.max(0, nowMs - startedAt) : undefined);
  if (elapsed === undefined) return undefined;
  const base = formatDuration(elapsed);
  if (!base) return undefined;
  const typical = node.typical_ms;
  if (typical && typical > 0 && (node.overrunning || elapsed > typical)) {
    return `${base} · usually ${formatDuration(typical)}`;
  }
  // Overrunning with no history to compare against is still a fact worth stating.
  return node.overrunning ? `${base} · longer than usual` : base;
}

/** Whether a node has anything behind it worth a second disclosure. */
export const nodeHasDetail = (node: ActivityNodeView): boolean =>
  node.warnings.length > 0 ||
  node.errors.length > 0 ||
  node.tools.length > 0 ||
  Boolean(node.produces) ||
  Boolean(node.cost);

/**
 * `done` counts settled steps, and a skipped step is settled — so "18/23"
 * silently includes steps that never ran. "of them" is the load-bearing part:
 * without it an editor reads the skipped count as a fourth, separate quantity.
 */
export function activityProgressPhrase(progress: ActivityView['progress']): string {
  const base = `${progress.done}/${progress.total}`;
  return progress.skipped > 0 ? `${base} · ${progress.skipped} of them skipped` : base;
}

/**
 * A mock run produces text that reads like an article and is not one. That is
 * the single confusion in this view worth interrupting for — but it is still a
 * `notice`: nothing is broken, the run did exactly what it was asked to do.
 */
export function placeholderNotice(activity: Pick<ActivityView, 'execution_mode' | 'live_output'>): string | undefined {
  if (activity.execution_mode === 'mock') {
    return 'This run used mock output. Every step produced structurally valid placeholder text — it reads like an article and is not one. Nothing here is publishable.';
  }
  if (activity.live_output === false) {
    return 'No step in this run produced real model output. What it holds is placeholder, not writing — nothing here is publishable.';
  }
  return undefined;
}

/** The sentence that turns `reusable_stages` into a reason not to worry. */
export function recoveryReassurance(reusableStages: number): string {
  if (reusableStages <= 0) return 'Nothing has been thrown away — a retry starts again from this step.';
  return reusableStages === 1
    ? '1 finished stage is kept. A retry picks up from there; nothing that already succeeded is recomputed.'
    : `${reusableStages} finished stages are kept. A retry picks up from there; nothing that already succeeded is recomputed.`;
}

/**
 * What to say when there is no activity. None of these are errors dressed as
 * errors: a request without a workflow is a normal request, and an unreachable
 * bridge says nothing whatsoever about the article.
 */
export function degradedNotice(reason?: string, error?: string): { title: string; message: string } {
  if (reason === 'no_workflow_run') {
    return {
      title: 'No workflow behind this one',
      message: 'This request was handled in the conversation — there is no multi-step run to watch.',
    };
  }
  if (reason === 'cms_agent_unavailable') {
    return {
      title: 'Cannot reach the workflow bridge',
      message:
        'The live view is unavailable right now. This does not mean the article failed — the run carries on without us watching, and this picks it back up when the bridge answers.',
    };
  }
  if (error) {
    return {
      title: 'The live view could not be read',
      message: `${error} This is the watcher, not the run — the article itself is unaffected.`,
    };
  }
  return {
    title: 'Nothing to show yet',
    message: reason ? `The run could not be read (${reason}).` : 'No activity has been recorded for this request yet.',
  };
}

// ─── glyphs ──────────────────────────────────────────────────────────────────

/** Copied rather than imported — `primitives.tsx` keeps its Spinner private. */
function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={cn('animate-spin', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function Dot({ className }: { className?: string }) {
  return <span className={cn('inline-block h-1.5 w-1.5 rounded-full', className)} aria-hidden="true" />;
}

const GLYPH_TITLE: Record<AdminSeverity, string> = {
  info: 'Handled — the run carried on',
  success: 'Done',
  needs_you: 'Waiting for you',
  error: 'Failed — a retry is available',
  blocked: 'Failed',
};

/**
 * `canRetry` is the B1/B2 split criterion — pass whether THIS signal is the
 * one a retry affordance targets. Defaults to false, the safer read of an
 * unknown recovery state (see `severityFromActivity`'s own doc). Threaded
 * per node/warning/tool-call (via `retryNodeId` below), not as one card-wide
 * flag — a card can fail in several places at once and only the one
 * `recovery` actually names should read as the softer `error`.
 */
function SeverityGlyph({
  severity,
  size = 14,
  canRetry = false,
}: {
  severity: ActivitySeverity;
  size?: number;
  canRetry?: boolean;
}) {
  // The one named exception (see file header): `notice` keeps its original
  // muted-grey `IconInfo`, never D4's brighter `info` blue.
  if (severity === 'notice') {
    return <IconInfo size={size} className="text-[var(--adm-text-muted)]" title={GLYPH_TITLE.info} />;
  }
  const level = severityFromActivity(severity, { canRetry });
  return <SeverityIcon level={level} size={size} title={GLYPH_TITLE[level]} />;
}

/**
 * Shape — not colour — still keys off `status`: a step that has not run yet
 * and a step that was skipped by design must not wear the same tick as one
 * that actually finished. Severity remains the only thing choosing a hue.
 */
function NodeGlyph({ node, retryNodeId }: { node: ActivityNodeView; retryNodeId?: string }) {
  if (node.status === 'running') return <Spinner size={14} className="text-[var(--adm-info-text)]" />;
  if (node.severity === 'ok' && node.status === 'skipped') return <Dot className="bg-[var(--adm-text-muted)]" />;
  if (node.severity === 'ok' && !node.started_at) return <Dot className="border border-[var(--adm-border-strong)]" />;
  return <SeverityGlyph severity={node.severity} canRetry={node.id === retryNodeId} />;
}

// ─── level 3: one node's detail ──────────────────────────────────────────────

function NodeDetail({ node, retryNodeId }: { node: ActivityNodeView; retryNodeId?: string }) {
  const canRetry = node.id === retryNodeId;
  return (
    <div className="flex flex-col gap-2 pb-2 text-[length:var(--adm-text-xs)]">
      {node.errors.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-[var(--adm-radius-sm)] bg-[var(--adm-danger-soft)] px-2 py-1.5">
          {node.errors.map((error, index) => (
            <li key={index} className="whitespace-pre-wrap text-[var(--adm-danger-text)]">
              {error}
            </li>
          ))}
        </ul>
      ) : null}

      {node.warnings.length > 0 ? (
        <div className="flex flex-col gap-1">
          {node.warnings.map((warning, index) => (
            <p key={index} className="flex items-start gap-1.5 text-[var(--adm-text-muted)]">
              <span className="mt-px flex w-3.5 shrink-0 items-center justify-center">
                <SeverityGlyph severity={warning.severity} size={13} canRetry={canRetry} />
              </span>
              <span className={warning.severity === 'attention' ? 'text-[var(--adm-warning-text)]' : undefined}>
                {warning.label}
              </span>
            </p>
          ))}
          {/* The raw codes stay reachable for whoever is debugging, and silent for whoever is not. */}
          <details>
            <summary className="adm-focusable w-fit cursor-pointer select-none rounded text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]">
              Codes
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded-[var(--adm-radius-sm)] bg-[var(--adm-surface-sunken)] p-2 text-[var(--adm-text-muted)]">
              {node.warnings.map((warning) => warning.raw).join('\n')}
            </pre>
          </details>
        </div>
      ) : null}

      {node.tools.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--adm-text-muted)]">
          {node.tools.map((tool, toolIndex) => {
            // `formatShortDuration`, not `formatDuration`: a 530ms fetch is the
            // whole reason anyone opened this row, and rounding it to "1s"
            // (or a 200ms one to "0s") throws away the only fact it carries.
            const took = tool.duration_ms === undefined ? '' : formatShortDuration(tool.duration_ms);
            return (
              <li key={`${tool.id}-${toolIndex}`} className="inline-flex items-center gap-1.5">
                <SeverityGlyph severity={tool.severity} size={12} canRetry={canRetry} />
                <span className="text-[var(--adm-text)]">{tool.id}</span>
                {took ? <span>· {took}</span> : null}
                {tool.severity !== 'ok' && tool.error_code ? <span>· {tool.error_code}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {node.produces ? (
        <p className="text-[var(--adm-text-muted)]">
          Produces <span className="text-[var(--adm-text)]">{node.produces}</span>
        </p>
      ) : null}

      {node.cost ? (
        <p className="text-[var(--adm-text-muted)]">
          {formatUsd(node.cost.usd)} · {node.cost.tokens.toLocaleString('en-US')} tokens
        </p>
      ) : null}
    </div>
  );
}

// ─── level 2: one node row ───────────────────────────────────────────────────

function NodeRow({ node, nowMs, retryNodeId }: { node: ActivityNodeView; nowMs: number; retryNodeId?: string }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const expandable = nodeHasDetail(node);
  const running = node.status === 'running';
  // Not started and nothing to say about it — the queue ahead of the editor.
  const waiting = node.severity === 'ok' && node.status !== 'skipped' && !node.started_at;
  const timing = nodeDurationPhrase(node, nowMs);

  const line = (
    <>
      <span className="flex w-3.5 shrink-0 items-center justify-center">
        <NodeGlyph node={node} retryNodeId={retryNodeId} />
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          running ? 'font-medium text-[var(--adm-text)]' : 'text-[var(--adm-text-muted)]'
        )}
      >
        {node.label}
      </span>
      {timing ? <span className="shrink-0 tabular-nums text-[var(--adm-text-muted)]">{timing}</span> : null}
      {expandable ? (
        <IconChevronRight
          size={13}
          className={cn('shrink-0 text-[var(--adm-text-muted)] transition-transform', open && 'rotate-90')}
        />
      ) : null}
    </>
  );

  return (
    <li
      className={cn(
        'rounded-[var(--adm-radius-sm)]',
        running && 'bg-[var(--adm-surface-raised)]',
        waiting && 'opacity-70'
      )}
    >
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={detailId}
          className="adm-focusable flex w-full items-center gap-2 rounded-[var(--adm-radius-sm)] px-1.5 py-1 text-left text-[length:var(--adm-text-xs)]"
        >
          {line}
        </button>
      ) : (
        <div className="flex w-full items-center gap-2 px-1.5 py-1 text-[length:var(--adm-text-xs)]">{line}</div>
      )}
      {node.skip_reason ? (
        <p className="pb-1 pl-7 pr-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {node.skip_reason}
        </p>
      ) : null}
      <div id={detailId} hidden={!expandable || !open} className="pl-7 pr-1.5">
        {expandable && open ? <NodeDetail node={node} retryNodeId={retryNodeId} /> : null}
      </div>
    </li>
  );
}

// ─── the component ───────────────────────────────────────────────────────────

export interface RequestActivityProps {
  /** Poll by request; the server resolves it to a run. */
  requestId?: string;
  /** Or poll a run directly (the chat knows a run_id before a request row exists). */
  runId?: string;
  /** Start expanded (the request detail page) or collapsed (inside a chat transcript). */
  defaultExpanded?: boolean;
  /** Called when the run reaches a terminal state, so the host can refresh its own data. */
  onSettled?: (activity: ActivityView) => void;
  /** Offered on the recovery block. Absent means no button at all. */
  onRetry?: (nodeId: string) => void;
}

export function RequestActivity({ requestId, runId, defaultExpanded, onSettled, onRetry }: RequestActivityProps) {
  const [expanded, setExpanded] = useState(Boolean(defaultExpanded));
  const [activity, setActivity] = useState<ActivityView | null>(null);
  const [reason, setReason] = useState<string | undefined>(undefined);
  /** Server-decided: this caller's roles allow acting on an approval. */
  const [canApprove, setCanApprove] = useState(false);
  const [deciding, setDeciding] = useState<DecisionAction | undefined>(undefined);
  const [decideError, setDecideError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const panelId = useId();
  const headerId = useId();
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  /**
   * A GENERATION counter, not a shared `live` flag — the bug `RequestsWorkspace`
   * paid for. Swapping `requestId`/`runId` tears down one chain and starts
   * another; with one shared flag the new effect re-armed it, so a fetch still
   * in flight from the OLD run wrote its state and scheduled its own timer.
   */
  const generationRef = useRef(0);
  /** Polling has been retired for good (the run settled, or there is nothing to watch). */
  const stoppedRef = useRef(false);
  const settledRef = useRef(false);
  /** Held in a ref so a host that re-creates the callback each render cannot restart the poll chain. */
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const hasTarget = Boolean(requestId || runId);

  /**
   * T5.1 (T0.2 F13): `admin-requests-view`'s two caching wins, held across
   * ticks in refs so they survive re-renders without becoming poll deps.
   * `resolvedRunId` starts at the `runId` prop when the caller already knows
   * it, and is otherwise learned from the first response — a request's
   * `run_id` never changes, so every later tick sends it back and the server
   * skips re-reading the request doc entirely. `etag` lets an unmoved run
   * come back a bodyless `304`. `nextCadence` remembers the last computed
   * poll interval so a `304` tick can reschedule without needing to
   * reconstruct a response `activityPollIntervalFor` has never seen.
   */
  const resolvedRunIdRef = useRef<string | undefined>(runId);
  const etagRef = useRef<string | undefined>(undefined);
  const nextCadenceRef = useRef<number | undefined>(undefined);

  // A new target (a different request/run) must never see the OLD target's
  // cached run_id or etag — reset in lockstep with the generation bump below,
  // which already tears down and restarts the chain on this same dependency
  // change.
  useEffect(() => {
    resolvedRunIdRef.current = runId;
    etagRef.current = undefined;
    nextCadenceRef.current = undefined;
  }, [requestId, runId]);

  const load = useCallback(
    async (generation: number) => {
      // Only the current generation may write state or schedule the next poll.
      const current = () => generationRef.current === generation;
      try {
        const result = await getRequestActivityIfChanged(
          getToken,
          {
            ...(resolvedRunIdRef.current
              ? { run_id: resolvedRunIdRef.current }
              : requestId
                ? { request_id: requestId }
                : {}),
          },
          etagRef.current
        );
        if (!current()) return;

        if (result.unchanged) {
          // Byte-identical to what is already on screen — R8's shape. Nothing
          // to reconcile; just confirm freshness and reschedule at the SAME
          // cadence the last real response computed.
          etagRef.current = result.etag;
          setNowMs(Date.now());
          setError(undefined);
          setLoaded(true);
          if (timerRef.current) clearTimeout(timerRef.current);
          const next = nextCadenceRef.current;
          if (next !== undefined && !hidden()) {
            timerRef.current = setTimeout(() => void load(generation), next);
          }
          return;
        }

        etagRef.current = result.etag;
        const view = result.view;
        if (view.run_id) resolvedRunIdRef.current = view.run_id;
        setActivity(view.activity);
        setReason(view.reason);
        setCanApprove(view.can_approve === true);
        setNowMs(Date.now());
        setError(undefined);
        setLoaded(true);
        if (timerRef.current) clearTimeout(timerRef.current);

        // The whole response, not just the activity: only the server knows
        // whether a request with no run yet is one about to start or one that
        // will never have one, and it answers with `retry_ms`.
        const next = activityPollIntervalFor(view);
        nextCadenceRef.current = next;
        // A fetch already in flight when the tab hid used to schedule its own
        // successor, so polling carried on in a hidden tab and returning to it
        // could briefly run two chains. The visibility handler re-arms this
        // chain on the way back.
        if (next !== undefined && !hidden()) {
          timerRef.current = setTimeout(() => void load(generation), next);
          return;
        }
        // Nothing more will change. An editor rereading a finished article must
        // not leave a poll running behind the page.
        stoppedRef.current = true;
        // A run that ENDED is settled; "there is no run" never started, and the
        // host has nothing to refresh.
        if (view.activity && !settledRef.current) {
          settledRef.current = true;
          onSettledRef.current?.(view.activity);
        }
      } catch (loadError) {
        if (!current()) return;
        // The last good view stays on screen — blanking it costs the editor the
        // only picture they had of a run that is almost certainly still fine.
        setError(loadError instanceof Error ? loadError.message : 'Could not read the run.');
        setLoaded(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        if (!hidden()) timerRef.current = setTimeout(() => void load(generation), UNREACHABLE_POLL_MS);
      }
    },
    [requestId, runId]
  );

  /**
   * Act on the approval this run is waiting on.
   *
   * The response carries the run's state AFTER the decision, so the card moves
   * on the click rather than on the next poll. Polling is then re-armed by
   * bumping the generation: an approved run has just started executing again,
   * and the chain that was watching it had almost certainly stopped (a blocked
   * run is not something `activityPollIntervalFor` keeps asking about).
   */
  const runDecision = useCallback(
    async (action: DecisionAction) => {
      if (deciding) return;
      setDeciding(action);
      setDecideError(undefined);
      try {
        // T3.2: through the one decision façade rather than `decideRunPublish`
        // directly. Same wire call; what the façade adds is the shared
        // optimistic marker and the one invalidation path, so deciding HERE
        // moves the header pill and the runs inbox with no reload.
        const result = await decide(
          getToken,
          {
            mechanism: 'workflow_gate',
            ...(requestId ? { requestId } : {}),
            ...(runId ? { runId } : {}),
            canApprove,
          },
          action
        );
        if (result.activity) {
          setActivity(result.activity.activity);
          setReason(result.activity.reason);
          setCanApprove(result.activity.can_approve === true);
          setNowMs(Date.now());
          setLoaded(true);
        }
        // The server reports a decision it could not carry out in `error` with
        // a code in `reason` — surfaced verbatim rather than flattened into a
        // generic failure, because "which half did not happen" is the whole
        // question when a publish stalls.
        if (!result.ok) setDecideError(result.error);
        generationRef.current += 1;
        stoppedRef.current = false;
        settledRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
        void load(generationRef.current);
      } catch (actionError) {
        setDecideError(actionError instanceof Error ? actionError.message : 'The decision could not be recorded.');
      } finally {
        setDeciding(undefined);
      }
    },
    [canApprove, deciding, load, requestId, runId]
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    stoppedRef.current = false;
    settledRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (hasTarget) void load(generation);
    return () => {
      // Bumping the generation retires this chain even mid-flight; the clear
      // handles the idle case.
      generationRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [load, hasTarget]);

  // Nobody is reading a hidden tab, and the run does not need us to be watching.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // A settled run has nothing left to watch; coming back to the tab must
      // not resurrect its chain.
      if (stoppedRef.current || !hasTarget) return;
      if (document.visibilityState === 'visible') void load(generationRef.current);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [load, hasTarget]);

  /**
   * The running node's elapsed time is a LOCAL clock. Watching a number move
   * is the whole point of this view, and it is not worth a network round trip
   * per second to get it.
   */
  const ticking = expanded && (activity?.nodes.some((node) => node.status === 'running') ?? false);
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [ticking]);

  if (!hasTarget) return null;

  const shell = 'rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)]';

  if (!loaded) {
    return (
      <div className={shell}>
        <div className="px-3 py-2">
          <Skeleton variant="rect" height={14} />
        </div>
      </div>
    );
  }

  if (!activity) {
    const notice = degradedNotice(reason, error);
    return (
      <div className={shell}>
        <div className="px-3 py-2">
          <p className="text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text)]">{notice.title}</p>
          <p className="mt-0.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{notice.message}</p>
        </div>
      </div>
    );
  }

  const { done, total } = activity.progress;
  const eta = formatEta(activity.eta);
  const live = activity.status === 'running' || activity.status === 'queued';
  const recovery = activity.recovery;
  const retryNodeId = recovery?.node_id;
  /**
   * B1 (T0.3): a `failure` reads as D4 `error` (retry affordance exists)
   * rather than `blocked` (none) only where BOTH halves of that affordance
   * are actually present on this card — the node `recovery` names, AND a
   * host that passed `onRetry` at all (an embed that never wires `onRetry`
   * offers no "Retry this step" button no matter what `recovery` says, so
   * every failure on it must read as the harder `blocked`). Gated once here,
   * then threaded down as `retryNodeId` — per node, not as one card-wide
   * boolean — so only the node the affordance actually targets gets the
   * softer `error` icon; every other failed node on the same card, and every
   * warning/tool-call under it, stays `blocked`.
   */
  const effectiveRetryNodeId = onRetry ? retryNodeId : undefined;
  // D4/T2.3: the whole-run level of the same B1/B2 split — a retry exists
  // SOMEWHERE on this run iff `effectiveRetryNodeId` names a node for it.
  // `notice` keeps its pre-existing neutral/accent bar rather than D4's
  // `info` blue — the same named exception `SeverityGlyph` makes, kept in
  // sync here so the header glyph and the bar underneath it never disagree.
  const progressFill =
    activity.severity === 'notice'
      ? 'bg-[var(--adm-accent)]'
      : BAR_FILL[severityFromActivity(activity.severity, { canRetry: Boolean(effectiveRetryNodeId) })];
  const labelFor = (nodeId: string) => activity.nodes.find((node) => node.id === nodeId)?.label;
  const spend = activity.cost;
  const spendLabel = spend?.most_expensive_node ? labelFor(spend.most_expensive_node) : undefined;
  const placeholder = placeholderNotice(activity);

  return (
    <div className={shell}>
      <div className="px-3 py-2">
        <button
          type="button"
          id={headerId}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((value) => !value)}
          className="adm-focusable flex w-full items-center gap-2 rounded-[var(--adm-radius-sm)] text-left text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]"
        >
          <span className="flex w-3.5 shrink-0 items-center justify-center">
            {live ? (
              <Spinner size={14} className="text-[var(--adm-info-text)]" />
            ) : (
              <SeverityGlyph severity={activity.severity} canRetry={Boolean(effectiveRetryNodeId)} />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-[var(--adm-text)]">{activity.headline}</span>
          {/* Quiet by the severity rule — a mock run is working correctly. Never
              absent, though: this is the one thing here that can be mistaken
              for a finished article. */}
          {placeholder ? (
            <span className="shrink-0 rounded-[var(--adm-radius-pill)] border border-[var(--adm-border-strong)] px-1.5 py-px font-medium text-[var(--adm-text-muted)]">
              Placeholder content
            </span>
          ) : null}
          <span className="shrink-0 tabular-nums">{activityProgressPhrase(activity.progress)}</span>
          {eta ? <span className="hidden shrink-0 sm:inline">· {eta}</span> : null}
          {spend ? <span className="shrink-0">· {formatUsd(spend.usd)}</span> : null}
          <IconChevronDown size={14} className={cn('shrink-0 transition-transform', expanded && 'rotate-180')} />
        </button>

        <span
          className="mt-1.5 block h-1 w-full overflow-hidden rounded-[var(--adm-radius-pill)] bg-[var(--adm-border)]"
          role="progressbar"
          aria-valuenow={done}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuetext={`${done} of ${total} steps done`}
        >
          <span
            className={cn('block h-full rounded-[var(--adm-radius-pill)]', progressFill)}
            style={{ width: `${progressPercent(done, total)}%` }}
          />
        </span>

        {error ? (
          <p className="mt-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            Live updates paused — {error} Showing the last thing we saw.
          </p>
        ) : null}
      </div>

      {/*
       * Approvals and recovery sit OUTSIDE the disclosure. A run waiting on a
       * person, and the sentence telling an editor what survived a failure,
       * are the two things that must not be one click away in a transcript.
       */}
      {activity.approvals.length > 0 ? (
        <section
          aria-label="Waiting for you"
          className="mx-3 mb-2 rounded-[var(--adm-radius-sm)] border border-[var(--adm-warning)] bg-[var(--adm-warning-soft)] px-3 py-2"
        >
          <p className="flex items-center gap-1.5 text-[length:var(--adm-text-xs)] font-semibold text-[var(--adm-warning-text)]">
            <SeverityIcon level="needs_you" size={14} title="" /> Waiting for you
          </p>
          <ul className="mt-1 flex flex-col gap-1.5">
            {activity.approvals.map((approval, index) => {
              const label = labelFor(approval.node_id);
              const age = approval.requested_at ? relativeAge(approval.requested_at, nowMs) : '';
              return (
                <li
                  key={`${approval.node_id}-${index}`}
                  className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]"
                >
                  {/* CMS-Agent already writes editor copy — never paraphrased here. */}
                  {approval.reason}
                  {label || age ? (
                    <span className="ml-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                      {label ? `· ${label}` : ''}
                      {age ? ` · held ${age === 'just now' ? 'just now' : `for ${age}`}` : ''}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {/* T1.2/D3: ActionRow always renders — disabled with a tooltip when
              the server says this viewer cannot decide (T0.3 row A4's own
              gap: the old card showed zero buttons AND zero explanation when
              `canApprove` was false). Reject maps to the existing `withhold`
              mechanism (§6.3) — the vocabulary ruling (T1.2 brief,
              ux-inventory.md Table C) is Approve/Reject/Modify everywhere;
              "Hold" was one of four different words the codebase used for
              this same action. */}
          <ActionRow
            className="mt-2"
            onApprove={() => runDecision('approve')}
            onReject={() => runDecision('reject')}
            approveLabel="Approve and publish"
            /* T3.2: this endpoint's request body is `{request_id|run_id,
               action}` and nothing else, so there is nowhere to put a typed
               reason — `decisions.ts`'s `reasonDroppedNote`. Reject decides on
               the click rather than prompting for words it would discard. */
            rejectReason="none"
            disabledReason={canApprove ? undefined : 'You do not have publish-decision authority for this run.'}
          />
          <p className="mt-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            Rejecting records the operator veto and blocks every publish-risk node on this run until the decision is
            replaced.
          </p>
          {decideError ? (
            <p className="mt-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-danger)]">{decideError}</p>
          ) : null}
        </section>
      ) : null}

      {recovery ? (
        <section
          aria-label="What survived"
          className="mx-3 mb-2 rounded-[var(--adm-radius-sm)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-3 py-2"
        >
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">{recovery.sentence}</p>
          <p className="mt-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {recoveryReassurance(recovery.reusable_stages)}
          </p>
          {onRetry && retryNodeId ? (
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => onRetry(retryNodeId)}>
              Retry this step
            </Button>
          ) : null}
        </section>
      ) : null}

      <div
        id={panelId}
        role="region"
        aria-labelledby={headerId}
        hidden={!expanded}
        className="border-t border-[var(--adm-border)] px-3 py-2"
      >
        {expanded ? (
          <>
            {placeholder ? (
              <p className="mb-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{placeholder}</p>
            ) : null}
            <ol className="flex flex-col">
              {activity.nodes.map((node, nodeIndex) => (
                <NodeRow key={`${node.id}-${nodeIndex}`} node={node} nowMs={nowMs} retryNodeId={effectiveRetryNodeId} />
              ))}
            </ol>
            {spend ? (
              <p className="mt-2 border-t border-[var(--adm-border)] pt-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                {formatUsd(spend.usd)} · {(spend.input_tokens + spend.output_tokens).toLocaleString('en-US')} tokens
                {spendLabel ? ` · most of it in ${spendLabel}` : ''}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export default RequestActivity;
