import type { GetToken } from '../edit-mode/verbs-client.js';
import type { EditorialObjectState } from './editorial-state.js';

const STATE_ENDPOINT = '/.netlify/functions/admin-release-state';
const RELEASE_ENDPOINT = '/.netlify/functions/admin-release';

export interface ReleaseObjectView {
  object_id: string;
  object_type: string;
  display_name: string;
  review_state: 'none' | 'open' | 'changes_requested' | 'approved';
  approval_state: 'none' | 'open' | 'changes_requested' | 'approved_stale' | 'approved_current';
  requires_approval: boolean;
  state: EditorialObjectState;
}

export type ReleaseDeployState =
  | 'unavailable'
  | 'idle'
  | 'queued'
  | 'building'
  | 'ready'
  | 'ready_not_published'
  | 'failed'
  | 'stalled';

export interface ReleaseOverview {
  deploy: {
    configured: boolean;
    state: ReleaseDeployState;
    production_confirmed: boolean;
    live_commit: string | null;
    latest: { id: string; status: string; production_url: string; commit?: string } | null;
    published: { id: string; status: string; production_url: string; commit?: string } | null;
  };
  objects: ReleaseObjectView[];
  waiting_count: number;
  pending_approval_count: number;
}

export interface ReleaseResultView {
  released: boolean;
  status: string;
  reason: string;
  productionUrl?: string;
}

const authorized = async (getToken: GetToken) => ({ Authorization: `Bearer ${await getToken()}` });

export async function fetchReleaseOverview(getToken: GetToken): Promise<ReleaseOverview> {
  const response = await fetch(STATE_ENDPOINT, { headers: await authorized(getToken) });
  const body = (await response.json().catch(() => ({}))) as ReleaseOverview & { error?: string };
  if (!response.ok) throw new Error(body.error || `Release state request failed (${response.status}).`);
  return body;
}

export async function triggerProductionRelease(getToken: GetToken): Promise<ReleaseResultView> {
  const response = await fetch(RELEASE_ENDPOINT, {
    method: 'POST',
    headers: { ...(await authorized(getToken)), 'Content-Type': 'application/json' },
    body: JSON.stringify({ force_build: true, timeout_seconds: 8 }),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string; result?: ReleaseResultView };
  if (!response.ok || !body.result) throw new Error(body.error || `Release request failed (${response.status}).`);
  return body.result;
}
