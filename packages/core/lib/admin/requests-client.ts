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
}

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
