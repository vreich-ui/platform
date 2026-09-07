/**
 * Inventory client (T3) — typed browser wrappers over the `admin-inventory`
 * server function (T1, action-dispatched POST, same shape as
 * `admin-blob-manager` — see `maintenance-client.ts`). Search spans three
 * collections (governed objects via the `inventory` verb, artifacts via
 * `artifact-index`, and raw system stores); preview and the two per-artifact
 * mutations (`delete-artifact`, `retag-artifact`) round out the T1 action
 * set per BRIEF.md's task table.
 *
 * `GetToken` is injected the same way `maintenance-client.ts` and
 * `verbs-client.ts` do it, so this module needs no auth wiring of its own.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { InventoryCollection, InventoryHit } from './inventory-server-logic.js';

const INVENTORY_ENDPOINT = '/.netlify/functions/admin-inventory';

/**
 * Re-exported from `inventory-server-logic.ts` (the canonical home — BRIEF.md
 * T1 row) so consumers of the client module don't need a second import for
 * the shared inventory types. `previewRef` is an opaque token the `preview`
 * action resolves — never a raw store/key pair the client constructs itself.
 * `refs` lists other records that reference this hit (e.g. objects holding
 * an artifact) — used to explain a refused delete.
 */
export type { InventoryCollection, InventoryHit };

/**
 * T4 reconciliation — these shapes are the ones `server/functions/admin-inventory.ts`
 * ACTUALLY sends and accepts, read off the shipped handler rather than off
 * the plan. Three things differed from the first draft of this module and
 * would have shipped a search box that silently searched for nothing:
 *
 *   1. `search` reads its query from `q`, not `query`.
 *   2. Pagination is ONE opaque cursor string (`encodeInventoryCursors`
 *      packs every collection's keyset position into it), not an array of
 *      per-collection cursors. The response returns both that combined
 *      `cursor` and a per-collection `nextCursor` map.
 *   3. `preview` returns TRIMMED TEXT plus the `format` it is in — or, for
 *      an artifact, the index reference — never a parsed `json` object.
 */
export interface SearchResult {
  /** The normalized (lowercased, trimmed) query the server actually matched on. */
  query: string;
  collections: InventoryCollection[];
  limit: number;
  hits: InventoryHit[];
  /** Total matches per collection BEFORE the page limit — what the facet rail counts against. */
  counts: Partial<Record<InventoryCollection, number>>;
  /** Per-collection continuation token, `null` for a collection that is exhausted. */
  nextCursor: Partial<Record<InventoryCollection, string | null>>;
  /** One combined cursor advancing every collection that still has rows; `null` when nothing does. */
  cursor: string | null;
  /** True for a collection whose sweep hit its own scan cap — the page must not claim it saw everything. */
  truncated: Partial<Record<InventoryCollection, boolean>>;
}

export interface SearchParams {
  query?: string;
  collections?: InventoryCollection[];
  /** A `cursor` from a previous `SearchResult` — opaque, never constructed by hand. */
  cursor?: string;
  limit?: number;
}

/** The artifact-index reference as the `preview` action returns it (`server/lib/artifacts.ts`). */
export interface PreviewArtifact {
  sha256?: string;
  blobKey?: string;
  label?: string;
  originalFilename?: string;
  filename?: string;
  tags?: string[];
  createdAtISO?: string;
  sizeBytes?: number;
  artifactKind?: string;
  contentType?: string;
  deletedAtISO?: string;
}

/**
 * An object or store-blob preview: pretty-printed JSON (`format: 'json'`) or
 * the raw text of a blob that did not parse (`format: 'text'`), trimmed to
 * 32 KB. `sizeBytes` is the UNTRIMMED size, so a surface can say how much it
 * is not showing instead of implying it showed everything.
 */
export interface TextPreviewResult {
  collection: 'objects' | 'stores';
  id: string;
  format: 'json' | 'text';
  text: string;
  truncated: boolean;
  sizeBytes: number;
  store?: string;
  key?: string;
}

/** An artifact preview: the index reference plus the re-normalized hit, no payload text. */
export interface ArtifactPreviewResult {
  collection: 'artifacts';
  id: string;
  format: 'artifact-metadata';
  artifact: PreviewArtifact;
  hit: InventoryHit;
}

export type PreviewResult = TextPreviewResult | ArtifactPreviewResult;

export interface DeleteArtifactResult {
  id: string;
  deleted: boolean;
}

export interface RetagArtifactResult {
  id: string;
  tags: string[];
}

async function callInventory<T>(getToken: GetToken, action: string, payload: Record<string, unknown> = {}) {
  const token = await getToken();
  const res = await fetch(INVENTORY_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json.ok === false) throw new Error((json.error as string) || `Request failed (${res.status}).`);
  return json as T;
}

/**
 * Fans a query out across the requested collections (all three by default),
 * keyset-paginated by the opaque `cursor` a previous result returned. The
 * server names the query parameter `q`; that spelling is this wrapper's whole
 * reason to exist, so no call site has to remember it.
 */
export const searchInventory = (getToken: GetToken, params: SearchParams = {}) =>
  callInventory<SearchResult>(getToken, 'search', {
    q: params.query ?? '',
    collections: params.collections ?? (['objects', 'artifacts', 'stores'] as InventoryCollection[]),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    limit: params.limit ?? 50,
  });

/** Fetches the Drawer inspector's trimmed preview for a single hit. */
export const previewInventoryHit = (getToken: GetToken, collection: InventoryCollection, id: string) =>
  callInventory<PreviewResult>(getToken, 'preview', { collection, id });

/**
 * Deletes one artifact. The server refuses per-item (throws with the
 * referencing object id in the message) when the artifact is still
 * referenced by an active object — this wrapper does not special-case that,
 * callers (including `bulk-artifact-ops.ts`) surface the thrown error as-is.
 */
export const deleteArtifact = (getToken: GetToken, id: string) =>
  callInventory<DeleteArtifactResult>(getToken, 'delete-artifact', { id });

/** Adds/removes tags on one artifact in a single call; either array may be omitted/empty. */
export const retagArtifact = (getToken: GetToken, id: string, add: string[] = [], remove: string[] = []) =>
  callInventory<RetagArtifactResult>(getToken, 'retag-artifact', { id, add, remove });
