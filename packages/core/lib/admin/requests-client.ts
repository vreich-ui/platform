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

/** Editor-facing label for a status — the one vocabulary the list, the pills and the chat card all use. */
export const requestStatusLabel = (status: RequestStatus): string =>
  ({
    queued: 'Starting',
    running: 'Working',
    needs_you: 'Needs you',
    stalled: 'Stalled',
    failed: 'Failed',
    done: 'Done',
    cancelled: 'Cancelled',
    archived: 'Archived',
  })[status];

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
  recovery?: { strategy: string; node_id?: string; sentence: string; reusable_stages: number };
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
