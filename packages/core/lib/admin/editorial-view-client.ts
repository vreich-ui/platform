/**
 * Browser wrapper over `admin-editorial-view` (T5.1 Phase 2, T0.2 §6.3) — the
 * one call `/admin`'s publication map makes.
 *
 * It replaces three: the full object inventory, the full release overview
 * (which recomputed that same inventory server-side) and the full chat list.
 * The page renders three rows and eight integers, so that is what comes back;
 * see the handler's header for what is deliberately NOT folded in (`me` and
 * the request-attention counts, both already served by shared module stores
 * the shell owns).
 *
 * Module-scope TTL + in-flight dedupe, the `library-client.ts` shape: module
 * state survives an Astro `ClientRouter` navigation even though the React tree
 * does not, so returning to `/admin` inside the window is free.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { ChatSummaryView } from './chat-client.js';
import type { EditorialObjectState } from './editorial-state.js';
import type { LibraryRow } from './library-logic.js';
import type { ReleaseDeployState } from './release-client.js';

const ENDPOINT = '/.netlify/functions/admin-editorial-view';

/** Exactly the fields `FoundationSlot` reads — assignable to `LibraryRow`. */
export type EditorialSlotRow = Pick<
  LibraryRow,
  'object_id' | 'object_type' | 'display_name' | 'updated_at' | 'status' | 'review_state' | 'published_time'
> & { unpublished_changes: boolean };

export interface EditorialWorkView {
  chat_id: string;
  title: string;
  status: ChatSummaryView['status'];
  updated_at: string;
  object_id?: string;
}

export interface EditorialSlotView {
  rows: EditorialSlotRow[];
  count: number;
  state: EditorialObjectState | null;
  work: EditorialWorkView | null;
}

export interface EditorialView {
  foundation: {
    site: EditorialSlotView;
    editorial_voice: EditorialSlotView;
    visual_identity: EditorialSlotView & { theme_count: number };
  };
  families: {
    pages: number;
    navigation: number;
    templates: number;
    media: number;
    content: number;
  };
  deploy: {
    configured: boolean;
    state: ReleaseDeployState;
    production_confirmed: boolean;
    live_commit: string | null;
  };
}

/** Short: the map is a landing surface, and an editor who publishes elsewhere should see it here. */
export const EDITORIAL_VIEW_TTL_MS = 15_000;

let memoryCache: { view: EditorialView; fetchedAt: number } | null = null;
let inflight: Promise<EditorialView> | null = null;

async function request(getToken: GetToken): Promise<EditorialView> {
  const response = await fetch(ENDPOINT, { headers: { Authorization: `Bearer ${await getToken()}` } });
  const body = (await response.json().catch(() => ({}))) as EditorialView & { error?: string };
  if (!response.ok) throw new Error(body.error || `Publication map request failed (${response.status}).`);
  return body;
}

function runFetch(getToken: GetToken): Promise<EditorialView> {
  const thisFetch = request(getToken).then((view) => {
    memoryCache = { view, fetchedAt: Date.now() };
    return view;
  });
  inflight = thisFetch;
  // Clear the marker on settle without creating a second unhandled-rejection
  // path — the returned promise still carries the rejection (library-client's
  // discipline).
  thisFetch.then(
    () => {
      if (inflight === thisFetch) inflight = null;
    },
    () => {
      if (inflight === thisFetch) inflight = null;
    }
  );
  return thisFetch;
}

export async function fetchEditorialView(getToken: GetToken, opts?: { force?: boolean }): Promise<EditorialView> {
  if (!opts?.force) {
    if (memoryCache && Date.now() - memoryCache.fetchedAt < EDITORIAL_VIEW_TTL_MS) return memoryCache.view;
    if (inflight) return inflight;
  }
  return runFetch(getToken);
}

export function invalidateEditorialView(): void {
  memoryCache = null;
  inflight = null;
}
