/**
 * admin-editorial-view (T5.1 Phase 2, T0.2 §6.3) — everything `/admin`'s
 * publication map renders, in one request, as counts rather than collections.
 *
 * ## What it replaces
 *
 * `AdminHome` fired three calls on mount, in parallel, and blocked paint on
 * all three:
 *
 *   1. `admin-object {action:'inventory'}` — the WHOLE inventory, N rows of
 *      ~15 fields each;
 *   2. `admin-release-state` — a second, independent full store sweep on the
 *      server (it computes its own inventory), plus two Netlify deploys-API
 *      calls and one GitHub `/compare` per distinct publish commit;
 *   3. `admin-agent-chat {action:'list_chats'}` — every chat doc the caller
 *      can see, each read in full to produce an eight-field summary.
 *
 * And it renders, from all of that, THREE object rows and EIGHT integers.
 * T0.2 called deriving them server-side "the single largest payload reduction
 * available on any surface".
 *
 * ## What it returns
 *
 * Three rows — the foundation slots (`site`, `editorial_voice`, and the
 * visual-identity pair of `theme` + `site`) — each with its lifecycle state
 * and, if an agent is mid-run on it, that run's summary. Eight integers: five
 * family counts and the three slots' object counts. Plus the deploy header.
 * No row array for the rest of the store ever crosses the wire.
 *
 * ## What it deliberately does NOT return
 *
 * T0.2 §6.3 also sketched `me` and an `attention` block folded in from the
 * request index. Both are omitted, because on this branch they would ADD work
 * rather than remove it:
 *
 *   - `me` is already served to `AdminShell` — this page's own parent —
 *     through `use-current-user`'s module-scope store, which dedupes it. And
 *     `me` is a WRITE path (`invitations.ts` stamps `last_seen_at`). Folding
 *     a copy in here would mean a SECOND `me` per page load, not zero.
 *   - `attention` is already served by T2.3's `requests-store`, the one shared
 *     poll behind the shell's pills. A second source for the same numbers
 *     would race it and give the shell two answers.
 *
 * ## Cost
 *
 * With T5.1 R3's `objects/index.json` and the shared release-overview memo:
 * `T list() + 1 blob read` for the inventory (was `T list() + N get()`, twice
 * over), `1 list() + C get()` for the chats, memoized deploy and commit
 * ancestry. Three round trips become one, and the response body goes from
 * O(N) rows to a fixed handful.
 *
 * `ETag` + `If-None-Match` -> `304` and `Cache-Control: private, no-cache`,
 * following `admin-traffic.ts`'s precedent.
 */
import { createHash } from 'node:crypto';

import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { loadReleaseOverview, ReleaseOverviewUnavailableError } from '../lib/release-overview.js';
import { getAgentChatBlobStore, listChatDocs } from '../lib/agent/chat-store.js';
import { visibleChatDocs } from '../lib/agent/chat-visibility.js';
import type { InventoryRow } from '../lib/object-inventory.js';
import type { EditorialObjectState } from '../../lib/admin/editorial-state.js';
import type { ObjectType } from '../../schema/object-record-v1.js';

type LambdaEvent = {
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
};

const jsonResponse = (
  statusCode: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});

const CACHE_CONTROL = 'private, no-cache';
const etagFor = (body: unknown): string => `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;

/** The statuses `AdminHome` treats as "an agent is working on this right now". */
const LIVE_CHAT_STATUSES = new Set(['queued', 'running', 'awaiting_approval', 'awaiting_candidate', 'error']);

/**
 * The row as the publication map needs it — the seven fields `FoundationSlot`
 * reads (`href()`, `rowStatus()`, the display name), not the full
 * `InventoryRow`. Assignable to the client's `LibraryRow`.
 */
export type EditorialSlotRow = {
  object_id: string;
  object_type: ObjectType;
  display_name: string;
  updated_at: string;
  status: InventoryRow['status'];
  review_state: InventoryRow['review_state'];
  published_time: string | null;
  unpublished_changes: boolean;
};

export type EditorialWorkView = {
  chat_id: string;
  title: string;
  status: string;
  updated_at: string;
  object_id?: string;
};

export type EditorialSlotView = {
  /** Every object in the slot, newest-relevant first — usually one, at most a handful. */
  rows: EditorialSlotRow[];
  /** `rows.length`, so the client never counts a list it does not have. */
  count: number;
  /** The primary row's release-aware lifecycle, or null when the slot is empty / release state is unknown. */
  state: EditorialObjectState | null;
  /** The live agent run on the primary row, if any. */
  work: EditorialWorkView | null;
};

const slotRow = (row: InventoryRow): EditorialSlotRow => ({
  object_id: row.object_id,
  object_type: row.object_type,
  display_name: row.display_name,
  updated_at: row.updated_at,
  status: row.status,
  review_state: row.review_state,
  published_time: row.published_time,
  unpublished_changes: row.unpublished_changes,
});

const buildHandlerImpl = (_binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });
  const access = await resolveAdminAccessFromEvent(event, context);
  if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
  if (!access.isAdmin || !access.email) return jsonResponse(403, { error: 'Admin access is required.' });
  const email = access.email;

  try {
    // The chat scan is independent of the overview — issue them together.
    const [overview, chatDocs] = await Promise.all([
      loadReleaseOverview(event, { userId: access.userId, email, roles: access.roles }),
      (async () => {
        try {
          return await listChatDocs(await getAgentChatBlobStore(event));
        } catch (error) {
          // The publication map is still worth painting without the "an agent
          // is working on this" line — the client already tolerated a failed
          // `listChats` by falling back to an empty list.
          console.warn('admin-editorial-view: chat summaries unavailable.', error);
          return [];
        }
      })(),
    ]);

    const rows = overview.rows;
    const stateById = new Map(overview.objects.map((object) => [object.object_id, object.state]));

    // Scoped exactly as `AdminHome`'s own `listChats(token)` was: the caller's
    // own chats, never `include_all`.
    const visible = visibleChatDocs(chatDocs, email, false, false);
    const workByObject = new Map<string, EditorialWorkView>();
    for (const doc of visible) {
      if (!doc.object_id || !LIVE_CHAT_STATUSES.has(doc.status)) continue;
      if (workByObject.has(doc.object_id)) continue;
      workByObject.set(doc.object_id, {
        chat_id: doc.chat_id,
        title: doc.title,
        status: doc.status,
        updated_at: doc.updated_at,
        object_id: doc.object_id,
      });
    }

    const byType = (type: ObjectType) => rows.filter((row) => row.object_type === type);
    const countOf = (types: readonly ObjectType[]) => rows.filter((row) => types.includes(row.object_type)).length;

    const slot = (slotRows: InventoryRow[]): EditorialSlotView => {
      const primary = slotRows[0];
      return {
        rows: slotRows.map(slotRow),
        count: slotRows.length,
        state: primary ? (stateById.get(primary.object_id) ?? null) : null,
        work: primary ? (workByObject.get(primary.object_id) ?? null) : null,
      };
    };

    const themes = byType('theme');
    const body: Record<string, unknown> = {
      // Three rows.
      foundation: {
        site: slot(byType('site')),
        editorial_voice: slot(byType('editorial_voice')),
        // The client's `visualRows` is exactly this concatenation.
        visual_identity: { ...slot([...themes, ...byType('site')]), theme_count: themes.length },
      },
      // Five of the eight integers; the other three are the slots' `count`s.
      families: {
        pages: countOf(['page', 'section']),
        navigation: countOf(['navigation']),
        templates: countOf(['template', 'section_template']),
        // No governed object type is "media" — see media-counts.ts. Kept as a
        // real zero rather than dropped, so the client renders the same label.
        media: 0,
        content: countOf(['content_item', 'product']),
      },
      deploy: overview.deploy,
    };

    const etag = etagFor(body);
    const ifNoneMatch = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      return { statusCode: 304, headers: { 'Cache-Control': CACHE_CONTROL, ETag: etag }, body: '' };
    }
    return jsonResponse(200, body, { 'Cache-Control': CACHE_CONTROL, ETag: etag });
  } catch (error) {
    if (error instanceof ReleaseOverviewUnavailableError) {
      return jsonResponse(500, { error: 'The publication map could not be loaded.' });
    }
    console.error('Failed to build the editorial view.', error);
    return jsonResponse(500, { error: 'The publication map could not be loaded.' });
  }
};

export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
