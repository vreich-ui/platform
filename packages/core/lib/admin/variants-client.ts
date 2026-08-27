/**
 * T4.4 — data client for `/admin/variants`. Thin wrappers over the SAME
 * `admin-object` verb endpoint every other admin surface uses; nothing here
 * reads or writes anything else.
 *
 * ## Why this fetches records and not just the inventory
 *
 * The only link between a variant and its parent is `lineage.parent_content_id`
 * inside the BODY (`lib/article-object/variant.ts:57`), and an inventory row
 * carries no body at all (`server/lib/object-inventory.ts:148-189`). The
 * `object_inventory {variants_of}` projection the schema comment mentions
 * (`schema/bodies/content-item-v1.ts:146`) does not exist — `variants_of`
 * appears nowhere in the code. So the family graph can only be built by
 * reading each article record.
 *
 * That is one `inventory` call plus one `get` per article, bounded by
 * `RECORD_FETCH_CONCURRENCY`. It is honest about its cost: the article corpus
 * is small, and the alternative is a server change this task does not own. If
 * the corpus grows past a few hundred articles, the right fix is a
 * `variants_of` projection on the inventory row, not a bigger fan-out here.
 */
import { callObjectVerb, type GetToken } from '../edit-mode/verbs-client.js';
import type { VariantMember, VariantScore } from './variant-experiments.js';

export type { GetToken };

/** How many record reads are in flight at once. Matches the server sweep's own posture. */
export const RECORD_FETCH_CONCURRENCY = 6;

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
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const readScores = (body: Record<string, unknown>): VariantScore[] | undefined => {
  const scores = body.scores;
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

const readParentId = (body: Record<string, unknown>): string | undefined => {
  const lineage = body.lineage;
  if (!isRecord(lineage)) return undefined;
  return typeof lineage.parent_content_id === 'string' ? lineage.parent_content_id : undefined;
};

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Every article, with the three body fields the family derivation needs.
 *
 * `viewerId` is the signed-in user's identity subject when the caller knows it:
 * a lock the VIEWER holds is not an obstacle (checkout is re-entrant for the
 * owner), a lock someone else holds is. Omitted, every held lock is treated as
 * someone else's — the safe direction, since the worst it does is show a
 * blocker the server would not have raised.
 *
 * A record that fails to load is skipped rather than failing the sweep: one
 * unreadable article should cost one row, not the page.
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

  const bodies = await mapWithConcurrency(rows, RECORD_FETCH_CONCURRENCY, async (row) => {
    const result = await callObjectVerb(getToken, {
      action: 'get',
      object_type: 'content_item',
      object_id: row.object_id,
    });
    const record = result.status === 200 && isRecord(result.body.record) ? result.body.record : undefined;
    return isRecord(record?.body) ? (record.body as Record<string, unknown>) : undefined;
  });

  return rows.map((row, index) => {
    const body = bodies[index];
    const parentId = body ? readParentId(body) : undefined;
    const slug = body && typeof body.slug === 'string' ? body.slug : undefined;
    const scores = body ? readScores(body) : undefined;
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
