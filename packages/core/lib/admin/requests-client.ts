/**
 * Editorial request client (W19 T19.2) — browser wrappers over the
 * `admin-requests` endpoint. Same house pattern as `chat-client.ts`: Identity
 * bearer, typed results, errors thrown with the server's human message.
 *
 * View types are declared HERE rather than imported from the server module —
 * `lib/admin` is browser code and must not reach into `server/`. They mirror
 * `server/lib/requests/store.ts`'s `RequestIndexRow` / `EditorialRequest`; a
 * drift between them is caught by the endpoint's own tests, not by tsc.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';

const ENDPOINT = '/.netlify/functions/admin-requests';

export type RequestStatus =
  | 'queued'
  | 'running'
  | 'needs_you'
  | 'stalled'
  | 'failed'
  | 'done'
  | 'cancelled'
  | 'archived';

export type RequestKind = 'article' | 'page' | 'section' | 'theme' | 'media' | 'capture' | 'other';

export interface RequestRowView {
  request_id: string;
  kind: RequestKind;
  title: string;
  status: RequestStatus;
  status_reason?: string;
  created_by: string;
  updated_at: string;
  progress?: { done: number; total: number };
  current_node?: string;
  chat_id?: string;
  object_id?: string;
  archived: boolean;
}

export interface RequestWorkflowView {
  run_id: string;
  workflow_id: string;
  project_id: string;
  node_total: number;
  node_done: number;
  node_failed: number;
  current_node?: string;
  stalled: boolean;
  approvals_required?: Array<{ node_id: string; reason: string; requested_at: string }>;
  errors?: string[];
  last_polled_at: string;
  nudges: number;
}

export interface RequestDetailView extends Omit<RequestRowView, 'archived' | 'progress' | 'current_node'> {
  brief_excerpt?: string;
  created_at: string;
  workflow?: RequestWorkflowView;
  chats: Array<{ chat_id: string; kind: 'object' | 'free'; attached_at: string }>;
  object?: { object_type: string; object_id: string };
  artifact_count?: number;
  archived_at?: string;
  archived_by?: string;
  history: Array<{ at: string; status: string; note?: string }>;
}

export interface RequestListFiltersInput {
  status?: RequestStatus[];
  kind?: RequestKind[];
  mine?: boolean;
  archived?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface RequestListView {
  requests: RequestRowView[];
  total: number;
  seq: number;
  next_cursor?: string;
  rebuilt?: boolean;
  muted: string[];
  /** T19.6: request_id → the status this person was last told about, server-side so the dedup crosses tabs and devices. */
  last_notified: Record<string, string>;
  /** This person has never been told anything: the first ingest acks in silence rather than announcing the whole backlog. */
  notify_first_contact?: boolean;
  email_mode: EmailMode;
}

export type EmailMode = 'immediate' | 'daily' | 'off';

async function post<T>(getToken: GetToken, body: Record<string, unknown>): Promise<T> {
  const token = await getToken();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error as string) || `Request failed (${res.status}).`);
  return json as T;
}

export const listRequests = (getToken: GetToken, filters: RequestListFiltersInput = {}) =>
  post<RequestListView>(getToken, { action: 'list', ...filters });

/**
 * The conditional form of `listRequests` (T5.1 R8, T0.2 F12).
 *
 * `list` is the busiest endpoint in the admin — T0.2 measured ~16 requests a
 * minute per open tab, every one re-serialising and re-transferring
 * byte-identical JSON. `admin-requests.ts` now emits an `ETag` over the list
 * body; pass the one from the previous response and an unchanged view comes
 * back as a bodyless `304`.
 *
 * This is an explicit protocol between this client and that handler, NOT
 * browser HTTP caching — the action is a POST, which no cache revalidates.
 * A caller with no etag, or a server that emits none, simply gets the full
 * response, so the path degrades to exactly what it did before.
 *
 * Saves bytes and serialisation, never blob reads: the handler still reads the
 * index, the notify state and the seen ledger before it can hash.
 */
export async function listRequestsIfChanged(
  getToken: GetToken,
  filters: RequestListFiltersInput,
  etag: string | undefined
): Promise<{ unchanged: true; etag: string | undefined } | { unchanged: false; view: RequestListView; etag?: string }> {
  const token = await getToken();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(etag ? { 'If-None-Match': etag } : {}),
    },
    body: JSON.stringify({ action: 'list', ...filters }),
  });
  if (res.status === 304) return { unchanged: true, etag: res.headers.get('etag') ?? etag };
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error as string) || `Request failed (${res.status}).`);
  const nextEtag = res.headers.get('etag');
  return { unchanged: false, view: json as unknown as RequestListView, ...(nextEtag ? { etag: nextEtag } : {}) };
}

export const getRequest = (getToken: GetToken, requestId: string) =>
  post<{ request: RequestDetailView }>(getToken, { action: 'get', request_id: requestId });

export const archiveRequest = (getToken: GetToken, requestId: string) =>
  post<{ request: RequestDetailView }>(getToken, { action: 'archive', request_id: requestId });

export const unarchiveRequest = (getToken: GetToken, requestId: string) =>
  post<{ request: RequestDetailView }>(getToken, { action: 'unarchive', request_id: requestId });

export const cancelRequest = (getToken: GetToken, requestId: string, reason?: string) =>
  post<{ request: RequestDetailView }>(getToken, {
    action: 'cancel',
    request_id: requestId,
    ...(reason ? { reason } : {}),
  });

/** Record what has now been shown to this person, so nothing announces twice. */
export const ackNotifications = (getToken: GetToken, acked: Record<string, string>) =>
  post<{ last_notified: Record<string, string> }>(getToken, { action: 'notify_ack', acked });

export const setEmailMode = (getToken: GetToken, mode: EmailMode) =>
  post<{ email_mode: EmailMode }>(getToken, { action: 'set_email_mode', mode });

export const muteRequest = (getToken: GetToken, requestId: string) =>
  post<{ muted: string[] }>(getToken, { action: 'mute', request_id: requestId });

export const unmuteRequest = (getToken: GetToken, requestId: string) =>
  post<{ muted: string[] }>(getToken, { action: 'unmute', request_id: requestId });

/**
 * T2.3 — visibility backoff for a poll chain. Nobody is reading a hidden tab
 * and the sweeper (W19) keeps every record true regardless, so the strongest
 * available form of "back off" is to schedule nothing at all while hidden —
 * `undefined` means "do not arm a timer." The caller's `visibilitychange`
 * handler is expected to re-fetch immediately on return rather than waiting
 * out a stale interval; see `requests-store.ts` and `RequestActivity.tsx`,
 * which already did this by hand before this helper existed to name it and
 * make it independently testable.
 */
export const pollIntervalWithBackoff = (baseMs: number, hiddenNow: boolean): number | undefined =>
  hiddenNow ? undefined : baseMs;

/** A request whose state can still change on its own. */
export const isLiveRequestStatus = (status: RequestStatus): boolean =>
  status === 'queued' || status === 'running' || status === 'needs_you' || status === 'stalled';

/**
 * Poll cadence: fast while anything on the page can move under us, slow when
 * nothing can. Mirrors `chat-client.ts`'s `pollIntervalFor` so the two
 * surfaces feel the same.
 */
export const requestPollIntervalFor = (rows: readonly { status: RequestStatus }[]): number => {
  if (rows.some((row) => row.status === 'queued' || row.status === 'running')) return 5_000;
  if (rows.some((row) => row.status === 'needs_you' || row.status === 'stalled')) return 15_000;
  return 30_000;
};

/**
 * Editor-facing label for a status — moved to `request-logic.ts` (T2.3) as
 * `requestStatusLabel`, alongside the `STALLED_VS_FAILED_SPLIT` flag it now
 * reads for `stalled`'s copy ("Taking longer than expected" when split).
 * Re-exported here so the one existing import site does not need two module
 * specifiers for two closely related things.
 */
export { requestStatusLabel } from './request-logic.js';

// ─── W19: the live watch path (admin-request-activity) ───────────────────────

const ACTIVITY_ENDPOINT = '/.netlify/functions/admin-request-activity';

export type ActivitySeverity = 'failure' | 'attention' | 'notice' | 'ok';

export interface ActivityToolCallView {
  id: string;
  status: string;
  severity: ActivitySeverity;
  duration_ms?: number;
  error_code?: string;
}

export interface ActivityNodeView {
  id: string;
  label: string;
  status: string;
  severity: ActivitySeverity;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  typical_ms?: number;
  overrunning?: boolean;
  produces?: string;
  skip_reason?: string;
  warnings: Array<{ severity: ActivitySeverity; label: string; raw: string }>;
  errors: string[];
  /** Task B (provider-error-details): CMS-Agent's own structured failure detail, when this node failed with one. Mirrors `server/lib/requests/activity.ts`'s `ActivityNode.failure`. */
  failure?: { code: string; message: string; operatorAction?: string; providerStatus?: number; providerMessage?: string };
  tools: ActivityToolCallView[];
  cost?: { tokens: number; usd: number };
}

export interface ActivityView {
  run_id: string;
  status: string;
  /** Narrowed on purpose: the placeholder badge compares against 'mock', and a silent rename must break the build, not the warning. */
  execution_mode?: 'mock' | 'openai';
  live_output?: boolean;
  severity: ActivitySeverity;
  headline: string;
  progress: { done: number; total: number; failed: number; running: number; skipped: number };
  eta?: { p50_ms: number; p95_ms: number; based_on_runs: number };
  cost?: { input_tokens: number; output_tokens: number; usd: number; most_expensive_node?: string };
  /** `operator_action` (Task B): set only when the retry target failed with a classified provider error or CMS-Agent's own budget guard — see the "Retry this step" gating in `RequestActivity.tsx`. */
  recovery?: { strategy: string; node_id?: string; sentence: string; reusable_stages: number; operator_action?: string };
  approvals: Array<{ node_id: string; reason: string; requested_at?: string }>;
  nodes: ActivityNodeView[];
}

export interface ActivityResponse {
  activity: ActivityView | null;
  title?: string;
  /** Why there is nothing to show: `no_workflow_run`, `cms_agent_unavailable`, or a read failure code. */
  reason?: string;
  /**
   * How long the client should wait before asking again, decided SERVER-side
   * because only the server knows whether a request without a run yet is one
   * that is about to start or one that will never have one. Absent means "stop".
   */
  retry_ms?: number;
  /**
   * Whether THIS caller may act on an approval the run is waiting on. Decided
   * server-side from the caller's resolved roles, so a surface never offers a
   * button the server would refuse.
   */
  can_approve?: boolean;
  /** Set when an approve/withhold could not be carried out; the reason code is in `reason`. */
  error?: string;
}

export const getRequestActivity = async (
  getToken: GetToken,
  target: { request_id?: string; run_id?: string }
): Promise<ActivityResponse> => {
  const token = await getToken();
  const res = await fetch(ACTIVITY_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error as string) || `Request failed (${res.status}).`);
  return json as unknown as ActivityResponse;
};

const VIEW_ENDPOINT = '/.netlify/functions/admin-requests-view';

export interface ActivityViewResponse extends ActivityResponse {
  /** Handed back once resolved — cache it and send it as `run_id` on the next poll (T5.1 F13). */
  run_id?: string;
}

/**
 * T5.1 (T0.2 F13) — the polling form `RequestActivity.tsx` uses. Read-only
 * (the decision stays on `getRequestActivity`/`decideRunPublish` above,
 * against `admin-request-activity`, per W19: only the sweeper writes a
 * running request's status, and a view must never become a second writer).
 *
 * Two things a plain `getRequestActivity` poll pays every tick that this
 * skips once the caller has them: the request-doc read (pass the CACHED
 * `run_id` back and the server skips `loadRequest` entirely — it can never
 * change for a given request), and the response bytes for an unmoved run
 * (pass the previous `ETag` as `If-None-Match`; unchanged comes back `304`).
 */
export async function getRequestActivityIfChanged(
  getToken: GetToken,
  target: { request_id?: string; run_id?: string },
  etag: string | undefined
): Promise<
  { unchanged: true; etag: string | undefined } | { unchanged: false; view: ActivityViewResponse; etag?: string }
> {
  const token = await getToken();
  const res = await fetch(VIEW_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(etag ? { 'If-None-Match': etag } : {}),
    },
    body: JSON.stringify(target),
  });
  if (res.status === 304) return { unchanged: true, etag: res.headers.get('etag') ?? etag };
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error as string) || `Request failed (${res.status}).`);
  const nextEtag = res.headers.get('etag');
  return { unchanged: false, view: json as unknown as ActivityViewResponse, ...(nextEtag ? { etag: nextEtag } : {}) };
}

/**
 * The watch cadence. Fast while a node can move under us; a terminal run is
 * polled once more and then left alone — an editor rereading a finished run
 * must not keep a poll alive.
 *
 * Takes the whole RESPONSE, not just the activity: a null activity can mean
 * three different things and they need three different answers. "The bridge
 * blinked" must not permanently freeze the live view of a still-running
 * article, and "no run yet" must not freeze one that is about to start — the
 * server says which via `retry_ms`.
 */
/**
 * Act on the approval a run is waiting on, from the surface that shows it.
 *
 * `approve` records the operator's durable publish decision AND advances the
 * run through the publish-risk nodes — both, because either alone leaves the
 * run stopped with nothing new for the editor to press. `withhold` records the
 * veto instead, which is what keeps the decision reversible.
 *
 * Returns the refreshed activity, so the caller renders the run's state AFTER
 * the decision rather than waiting for the next poll.
 */
export const decideRunPublish = async (
  getToken: GetToken,
  target: { request_id?: string; run_id?: string },
  action: 'approve' | 'withhold'
): Promise<ActivityResponse> => {
  const token = await getToken();
  const res = await fetch(ACTIVITY_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...target, action }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error as string) || `Request failed (${res.status}).`);
  return json as unknown as ActivityResponse;
};

export const activityPollIntervalFor = (response: ActivityResponse | null): number | undefined => {
  if (!response) return undefined;
  if (!response.activity) return response.retry_ms;
  const { status } = response.activity;
  if (status === 'running' || status === 'queued') return 3_000;
  if (status === 'blocked' || status === 'paused') return 15_000;
  return undefined;
};

/** "2m 14s", "48s", "3h 20m" — durations an editor reads, not milliseconds. */
export const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
};

/** "~2 min left", and nothing at all when there is no history to base it on. */
export const formatEta = (eta: ActivityView['eta']): string | undefined => {
  if (!eta || eta.p50_ms <= 0) return undefined;
  return `~${formatDuration(eta.p50_ms)} left`;
};

/**
 * Tool-call durations, where sub-second resolution is the entire point —
 * `formatDuration` rounds a 530 ms fetch to "1s" and a 200 ms one to "0s".
 */
export const formatShortDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms);
};

export const formatUsd = (usd: number): string => (usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);
