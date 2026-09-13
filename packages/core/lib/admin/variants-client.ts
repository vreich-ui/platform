/**
 * T4.4 — data client for `/admin/variants`. Thin wrappers over the SAME
 * `admin-object` verb endpoint every other admin surface uses; nothing here
 * reads or writes anything else.
 *
 * ## W4.1 — one call, not N+1
 *
 * This file used to list the inventory and then issue one `object_get` per
 * article, because the only link between a variant and its parent —
 * `lineage.parent_content_id` (`lib/article-object/variant.ts`) — lived in the
 * BODY, and an inventory row carried no body. Measured live, that was 40
 * `admin-object` invocations for one page load: each individually warm and
 * fast, all 40 paying the ~250-400 ms fixed per-invocation platform overhead
 * `Server-Timing` isolated.
 *
 * The fix was the one the old comment here named as the right one: the
 * projection now carries what the page needs. `content_item` inventory rows
 * ship a `content` summary — `slug`, `parent_content_id`, and the judged-score
 * digest (`server/lib/object-inventory.ts`) — so the family graph, the
 * permalink column and the judgement table are all derivable from the listing
 * itself. One call, whatever the corpus size.
 */
import { callObjectVerb, type GetToken } from '../edit-mode/verbs-client.js';
import type { VariantMember, VariantScore } from './variant-experiments.js';

export type { GetToken };

/** The W4.1 `content` summary, as it arrives on the wire. Every field is optional here on purpose: this is untrusted JSON, not the server's own type. */
interface InventoryContentSummary {
  slug?: string | null;
  parent_content_id?: string | null;
  scores?: unknown;
}

interface InventoryArticleRow {
  object_id: string;
  object_type: string;
  display_name: string;
  status: 'active' | 'archived';
  review_state: VariantMember['review_state'];
  approval_state?: VariantMember['approval_state'];
  requires_approval?: boolean;
  published_time: string | null;
  unpublished_changes: boolean;
  updated_at: string;
  lock?: { held: boolean; owner_id?: string; owner_label?: string };
  content?: InventoryContentSummary;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

/**
 * The digest, re-read defensively. The server already drops entries a
 * judgement row could not render (no framework, no dimension, no finite
 * score); this repeats the check rather than trusting the wire, exactly as it
 * did when the same shape arrived from a record body.
 */
const readScores = (scores: unknown): VariantScore[] | undefined => {
  if (!Array.isArray(scores)) return undefined;
  const parsed = scores.filter(isRecord).map((entry) => ({
    scored_by: String(entry.scored_by ?? ''),
    at: String(entry.at ?? ''),
    framework: String(entry.framework ?? ''),
    dimension: String(entry.dimension ?? ''),
    score: typeof entry.score === 'number' ? entry.score : Number.NaN,
    ...(typeof entry.rationale === 'string' ? { rationale: entry.rationale } : {}),
  }));
  const usable = parsed.filter((entry) => entry.framework && entry.dimension && Number.isFinite(entry.score));
  return usable.length ? usable : undefined;
};

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/**
 * Every article, with the three body facts the family derivation needs — from
 * ONE `inventory` call.
 *
 * `viewerId` is the signed-in user's identity subject when the caller knows it:
 * a lock the VIEWER holds is not an obstacle (checkout is re-entrant for the
 * owner), a lock someone else holds is. Omitted, every held lock is treated as
 * someone else's — the safe direction, since the worst it does is show a
 * blocker the server would not have raised.
 */
export async function fetchVariantMembers(
  getToken: GetToken,
  options: { viewerId?: string } = {}
): Promise<VariantMember[]> {
  const listed = await callObjectVerb(getToken, { action: 'inventory', object_type: 'content_item' });
  if (listed.status !== 200) {
    throw new Error((listed.body?.error as string) || `The article inventory could not be read (${listed.status}).`);
  }
  const rows = ((listed.body.objects as InventoryArticleRow[] | undefined) ?? []).filter(
    (row) => row.object_type === 'content_item'
  );

  return rows.map((row) => {
    const content = row.content ?? {};
    const parentId = stringOrUndefined(content.parent_content_id);
    const slug = stringOrUndefined(content.slug);
    const scores = readScores(content.scores);
    const lockOwner = row.lock?.held ? row.lock.owner_id : undefined;
    return {
      object_id: row.object_id,
      display_name: row.display_name,
      status: row.status,
      review_state: row.review_state,
      ...(row.approval_state ? { approval_state: row.approval_state } : {}),
      ...(row.requires_approval !== undefined ? { requires_approval: row.requires_approval } : {}),
      published_time: row.published_time,
      unpublished_changes: row.unpublished_changes,
      updated_at: row.updated_at,
      ...(row.lock?.held
        ? {
            lock: {
              held: true,
              ...(row.lock.owner_label ? { owner_label: row.lock.owner_label } : {}),
              own: Boolean(options.viewerId && lockOwner === options.viewerId),
            },
          }
        : {}),
      ...(parentId ? { parent_content_id: parentId } : {}),
      ...(slug ? { slug } : {}),
      ...(scores ? { scores } : {}),
    } satisfies VariantMember;
  });
}

// ─── create_variant ─────────────────────────────────────────────────────────

export interface VariantPreview {
  ok: boolean;
  /** The id `create_variant` would mint, from the dry run — never guessed here. */
  objectId?: string;
  idAvailable?: boolean;
  slug?: string;
  /** The verb's own validation summary, verbatim. */
  summary?: Record<string, unknown>;
  error?: string;
}

/**
 * `create_variant` with `dry_run: true` — builds and validates the would-be
 * variant and persists NOTHING (`object-verbs.ts:1052-1068`). This is the same
 * probe the W7 round-trip driver used to prove the verb in production without
 * leaving probe variants behind, and it is why the create flow can show a real
 * id and a real validation result before anything is written.
 */
export async function previewVariant(
  getToken: GetToken,
  sourceObjectId: string,
  slug?: string
): Promise<VariantPreview> {
  const result = await callObjectVerb(getToken, {
    action: 'create_variant',
    object_type: 'content_item',
    source_object_id: sourceObjectId,
    dry_run: true,
    ...(slug ? { slug } : {}),
  });
  if (result.status !== 200) {
    return { ok: false, error: (result.body.error as string) || `The variant could not be built (${result.status}).` };
  }
  const body = isRecord(result.body.body) ? result.body.body : undefined;
  return {
    ok: true,
    ...(typeof result.body.object_id === 'string' ? { objectId: result.body.object_id } : {}),
    ...(typeof result.body.id_available === 'boolean' ? { idAvailable: result.body.id_available } : {}),
    ...(body && typeof body.slug === 'string' ? { slug: body.slug } : {}),
    ...(isRecord(result.body.summary) ? { summary: result.body.summary } : {}),
  };
}

/** The real `create_variant`. The clone lands as a DRAFT — it publishes nothing. */
export async function createVariant(
  getToken: GetToken,
  sourceObjectId: string,
  options: { slug?: string; requestedId?: string } = {}
): Promise<{ ok: boolean; objectId?: string; error?: string }> {
  const result = await callObjectVerb(getToken, {
    action: 'create_variant',
    object_type: 'content_item',
    source_object_id: sourceObjectId,
    ...(options.slug ? { slug: options.slug } : {}),
    ...(options.requestedId ? { requested_id: options.requestedId } : {}),
  });
  if (result.status !== 200) {
    return {
      ok: false,
      error: (result.body.error as string) || `The variant could not be created (${result.status}).`,
    };
  }
  const record = isRecord(result.body.record) ? result.body.record : undefined;
  const objectId = typeof record?.object_id === 'string' ? record.object_id : undefined;
  return { ok: true, ...(objectId ? { objectId } : {}) };
}
