/**
 * Function name: Admin_Inventory
 * Required method: POST
 * Auth: Netlify Identity, gated to owner|admin via `resolveAdminAccessFromEvent`.
 *
 * The server behind `/admin/inventory` (T1). One action-dispatched POST, the
 * same shape as `admin-blob-manager.ts`, fanning one query out over the three
 * collections the page shows — governed objects (the `inventory` verb),
 * artifacts (the artifact-index), and every managed blob store — and
 * normalizing all three onto one `InventoryHit` row.
 *
 * WHY THIS IS NOT `admin-blob-manager.ts`. That function gates its ENTIRE
 * surface to `isOwner` (it is raw blob CRUD: set, rename, wipe-store,
 * wipe-all), and it stays that way — raw-store delete and wipe are unchanged
 * and unreachable from here. Inventory is the wider, read-plus-safe-verbs
 * surface an admin may use, so it opens `listManagedBlobStores` /
 * `getManagedBlobStore` directly rather than routing through an owner-only
 * function.
 *
 * PREVIEW ALLOWLIST (the security property this file exists to keep). A
 * `preview` of a store blob may only ever open a store that
 * `listManagedBlobStores` returned for THIS request. The store name arrives
 * from the client inside a hit id, so it is treated as untrusted: parsed by
 * `parseStoreHitId` (which rejects traversal shapes), then checked for exact
 * membership in the live allowlist, and only then handed to
 * `getManagedBlobStore`. There is no other code path in this file that turns a
 * caller-supplied string into a store handle.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { isOwner } from '../lib/roles.js';
import {
  artifactTagPointerKeys,
  listArtifactIndexKeys,
  readArtifactReferenceResult,
  requestArtifactReferenceKey,
  writeArtifactReferenceIndexes,
  type ArtifactIndexStore,
} from '../lib/artifact-index.js';
import type { ArtifactReference } from '../lib/artifacts.js';
import { verifyArtifactRetag } from '../../lib/admin/artifact-retag-verification.js';
import { getManagedBlobStore, listManagedBlobStores } from '../lib/blob-admin.js';
import { collectBlobListItems, mapWithConcurrency, STORE_READ_CONCURRENCY } from '../lib/blob-list.js';
import { getArtifactIndexBlobStore, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import {
  handleObjectVerb,
  listAllObjectRecords,
  objectVerbRequestSchema,
  type ObjectVerbStore,
} from '../lib/object-verbs.js';
import type { InventoryRow } from '../lib/object-inventory.js';
import type { Principal } from '../../schema/object-record-v1.js';
import {
  applyArtifactTagChanges,
  artifactMatchFields,
  artifactReferenceNeedles,
  artifactSlotHint,
  attachObjectThumbnails,
  buildRequestThumbnailIndex,
  clampInventoryLimit,
  decodeInventoryCursors,
  encodeInventoryCursors,
  findReferencingObjectId,
  formatArtifactHitId,
  formatStoreHitId,
  matchesInventoryQuery,
  normalizeArtifactHit,
  normalizeInventoryQuery,
  normalizeObjectHit,
  normalizeStoreHit,
  paginateInventoryHits,
  parseArtifactHitId,
  parseInventoryCollections,
  parseObjectHitId,
  parseStoreHitId,
  trimJsonPreview,
  trimStoreBlobPreview,
  type ArtifactThumbnailCandidate,
  type InventoryCollection,
  type InventoryCursorMap,
  type InventoryHit,
} from '../../lib/admin/inventory-server-logic.js';

type LambdaEvent = {
  blobs?: unknown;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
};

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: jsonHeaders,
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});

/**
 * Safety caps. A search fans out over every managed store, so it must be
 * impossible for one request to try to materialize the fleet in memory —
 * `truncated` on the response says out loud when a cap bit, rather than
 * letting the page imply it has seen everything.
 */
const MAX_STORE_KEYS_PER_STORE = 2_000;
const MAX_STORE_MATCHES = 500;
const MAX_ARTIFACT_INDEX_KEYS = 2_000;
/** Bound on the active-object sweep that backs the delete refusal. */
const MAX_REFERENCE_SCAN_RECORDS = 5_000;

const parseBody = (event: LambdaEvent): Record<string, unknown> => {
  if (!event.body) return {};

  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const asTrimmed = (value: unknown): string | undefined => {
  const str = typeof value === 'string' ? value.trim() : '';
  return str.length > 0 ? str : undefined;
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

type ActionContext = {
  event: LambdaEvent;
  principal: Principal;
  binding: SiteBinding;
  /** Display identity of the acting human, stamped onto a soft delete. */
  actor: string;
};

type ActionHandler = (
  params: Record<string, unknown>,
  context: ActionContext
) => Promise<ReturnType<typeof jsonResponse>>;

// ─── shared store access ────────────────────────────────────────────────────

const openArtifactIndexStore = async (event: LambdaEvent, binding: SiteBinding) =>
  (await getArtifactIndexBlobStore(event, binding)) as unknown as ArtifactIndexStore & {
    delete?: (key: string) => Promise<void>;
    del?: (key: string) => Promise<void>;
  };

const openObjectStore = async (event: LambdaEvent, binding: SiteBinding) =>
  (await getSiteObjectsBlobStore(event, binding)) as unknown as ObjectVerbStore;

/**
 * The one place a caller-supplied store name becomes a store handle. Returns
 * undefined for anything `listManagedBlobStores` did not name for this
 * request — never a handle to a store outside the allowlist.
 */
const openAllowedManagedStore = async (storeName: string, event: LambdaEvent, binding: SiteBinding) => {
  const allowed = await listManagedBlobStores(event, binding);
  if (!allowed.includes(storeName)) return undefined;

  return getManagedBlobStore(storeName, event, binding);
};

// ─── search ─────────────────────────────────────────────────────────────────

const searchObjects = async (query: string, context: ActionContext): Promise<InventoryHit[]> => {
  const store = await openObjectStore(context.event, context.binding);
  const result = await handleObjectVerb(store, { action: 'inventory' }, context.principal);
  if (result.status < 200 || result.status >= 300) return [];

  const rows = Array.isArray(result.body.objects) ? (result.body.objects as InventoryRow[]) : [];

  return rows
    .filter((row) => matchesInventoryQuery(query, [row.display_name, row.object_id, row.object_type]))
    .map((row) =>
      normalizeObjectHit({
        object_id: row.object_id,
        object_type: row.object_type,
        display_name: row.display_name,
        status: row.status,
        updated_at: row.updated_at,
      })
    );
};

const readArtifactReferences = async (
  indexStore: ArtifactIndexStore
): Promise<{ references: Array<ArtifactReference & { requestId: string }>; truncated: boolean }> => {
  const keys = await listArtifactIndexKeys(indexStore, 'request-artifacts/');
  const truncated = keys.length > MAX_ARTIFACT_INDEX_KEYS;
  const scanned = truncated ? keys.slice(0, MAX_ARTIFACT_INDEX_KEYS) : keys;

  const loaded = await mapWithConcurrency(scanned, STORE_READ_CONCURRENCY, async (key) => {
    // `request-artifacts/<requestId>/<sha256>.json` — the requestId half is
    // URL-encoded on write, so decode it back to the id callers use.
    const match = key.match(/^request-artifacts\/([^/]+)\/([a-f0-9]{64})\.json$/i);
    if (!match) return undefined;

    const requestId = decodeURIComponent(match[1] ?? '');
    const sha256 = (match[2] ?? '').toLowerCase();
    const read = await readArtifactReferenceResult(indexStore, requestId, sha256);
    if (read.status !== 'ok') return undefined;

    return { ...read.reference, requestId };
  });

  return {
    references: loaded.filter((entry): entry is ArtifactReference & { requestId: string } => Boolean(entry)),
    truncated,
  };
};

type ArtifactIndexSweep = { references: Array<ArtifactReference & { requestId: string }>; truncated: boolean };

/**
 * ONE artifact-index sweep per search request, shared by the artifacts
 * collection and the object-thumbnail join. The join must never turn into a
 * second listing (let alone a per-row fetch), so the read happens here and
 * both consumers work off the same array.
 */
const loadArtifactIndexSweep = async (context: ActionContext): Promise<ArtifactIndexSweep> =>
  readArtifactReferences(await openArtifactIndexStore(context.event, context.binding));

const searchArtifacts = (query: string, sweep: ArtifactIndexSweep): { hits: InventoryHit[]; truncated: boolean } => ({
  hits: sweep.references
    .filter((reference) => matchesInventoryQuery(query, artifactMatchFields(reference)))
    .map((reference) => normalizeArtifactHit(reference)),
  truncated: sweep.truncated,
});

/**
 * The requestId → hero-image map for this response, or an EMPTY map.
 *
 * Empty when the index sweep hit `MAX_ARTIFACT_INDEX_KEYS`: a truncated sweep
 * cannot prove which artifacts an object has, so the rows fall back to their
 * type visual rather than showing a thumbnail for the objects that happened
 * to sort early and nothing for the rest. Partial imagery would look like
 * data ("this article has no picture") when it is really scan order.
 */
const thumbnailIndexFor = (sweep: ArtifactIndexSweep): Map<string, string> => {
  if (sweep.truncated) return new Map();

  const candidates: ArtifactThumbnailCandidate[] = sweep.references.map((reference) => ({
    requestId: reference.requestId,
    sha256: reference.sha256,
    blobKey: reference.blobKey,
    artifactKind: reference.artifactKind ?? null,
    contentType: reference.contentType,
    createdAtISO: reference.createdAtISO,
    deletedAtISO: reference.deletedAtISO ?? null,
    slot: artifactSlotHint(reference.metadata),
  }));

  return buildRequestThumbnailIndex(candidates);
};

const searchStores = async (
  query: string,
  context: ActionContext
): Promise<{ hits: InventoryHit[]; truncated: boolean }> => {
  const stores = await listManagedBlobStores(context.event, context.binding);
  let truncated = false;
  const hits: InventoryHit[] = [];

  const perStore = await mapWithConcurrency(stores, STORE_READ_CONCURRENCY, async (storeName) => {
    try {
      const store = getManagedBlobStore(storeName, context.event, context.binding);
      const items = await collectBlobListItems(await store.list({ paginate: true }));
      return { storeName, items };
    } catch (error) {
      // One unreadable store degrades to "no rows from that store this
      // sweep" rather than failing the whole search — the same posture
      // listAllObjectRecords takes per object type.
      console.warn(`Admin_Inventory: skipping unlistable store "${storeName}".`, error);
      return { storeName, items: [] };
    }
  });

  for (const { storeName, items } of perStore) {
    if (items.length > MAX_STORE_KEYS_PER_STORE) truncated = true;
    for (const item of items.slice(0, MAX_STORE_KEYS_PER_STORE)) {
      if (!matchesInventoryQuery(query, [formatStoreHitId(storeName, item.key)])) continue;
      if (hits.length >= MAX_STORE_MATCHES) {
        truncated = true;
        break;
      }
      hits.push(normalizeStoreHit({ store: storeName, key: item.key, etag: item.etag ?? null }));
    }
  }

  return { hits, truncated };
};

const handleSearch: ActionHandler = async (params, context) => {
  const query = normalizeInventoryQuery(params.q);
  const collections = parseInventoryCollections(params.collections);
  const limit = clampInventoryLimit(params.limit);
  const cursors = decodeInventoryCursors(params.cursor);

  /**
   * Which collections this request should actually sweep.
   *
   * A cursor names only the collections that still had rows when it was
   * issued — `encodeInventoryCursors` drops an exhausted one. Without this
   * check, a follow-up page re-swept every exhausted collection (a full
   * `inventory` verb pass, a full artifact-index read, a full store listing)
   * and re-served its FIRST page, since `cursors[collection]` was undefined
   * and `paginateInventoryHits` started over. The rows were invisible
   * downstream only because the client happens to de-duplicate by id — the
   * server was still paying for, and re-sending, the whole collection on
   * every "Load more". A request with NO cursor is page one and sweeps
   * everything; a request WITH one sweeps only what that cursor names.
   */
  const paging = Boolean(asTrimmed(params.cursor));
  const active = collections.filter((collection) => !paging || cursors[collection]);

  const hitsByCollection: Partial<Record<InventoryCollection, InventoryHit[]>> = {};
  const truncatedByCollection: Partial<Record<InventoryCollection, boolean>> = {};

  /**
   * The artifact index is read when EITHER collection needs it: artifacts to
   * list, objects to find their own imagery under the shared requestId. One
   * sweep serves both — an objects page never pays for it twice, and an
   * objects-only page (a "Load more" whose cursor no longer names artifacts)
   * still gets thumbnails instead of losing them halfway down the table.
   */
  const needsArtifactIndex = active.includes('artifacts') || active.includes('objects');

  // The three collections share no state — run them together rather than
  // making an admin wait for an object sweep before the store listing starts.
  const [objects, artifactSweep, stores] = await Promise.all([
    active.includes('objects') ? searchObjects(query, context) : undefined,
    needsArtifactIndex ? loadArtifactIndexSweep(context) : undefined,
    active.includes('stores') ? searchStores(query, context) : undefined,
  ]);

  if (objects) {
    // The join is a pure post-step over two results that were fetched in
    // parallel — no extra round trip, and no per-row lookup.
    hitsByCollection.objects = artifactSweep
      ? attachObjectThumbnails(objects, thumbnailIndexFor(artifactSweep))
      : objects;
    truncatedByCollection.objects = false;
  }
  if (artifactSweep && active.includes('artifacts')) {
    const artifacts = searchArtifacts(query, artifactSweep);
    hitsByCollection.artifacts = artifacts.hits;
    truncatedByCollection.artifacts = artifacts.truncated;
  }
  if (stores) {
    hitsByCollection.stores = stores.hits;
    truncatedByCollection.stores = stores.truncated;
  }

  const hits: InventoryHit[] = [];
  const counts: Partial<Record<InventoryCollection, number>> = {};
  const nextCursor: Record<string, string | null> = {};
  const nextAfter: InventoryCursorMap = {};

  for (const collection of active) {
    const page = paginateInventoryHits(hitsByCollection[collection] ?? [], cursors[collection], limit);
    hits.push(...page.hits);
    counts[collection] = (hitsByCollection[collection] ?? []).length;
    nextCursor[collection] = page.nextAfter ? encodeInventoryCursors({ [collection]: page.nextAfter }) : null;
    if (page.nextAfter) nextAfter[collection] = page.nextAfter;
  }
  // A collection this page skipped is EXHAUSTED, not unknown — say so rather
  // than omitting it and letting a surface read the gap as "no answer".
  for (const collection of collections) {
    if (!active.includes(collection)) nextCursor[collection] = null;
  }

  return jsonResponse(200, {
    query,
    collections,
    limit,
    hits,
    counts,
    // Per-collection continuation, plus one combined cursor that advances
    // every collection that still has rows.
    nextCursor,
    cursor: Object.keys(nextAfter).length ? encodeInventoryCursors(nextAfter) : null,
    truncated: truncatedByCollection,
  });
};

// ─── preview ────────────────────────────────────────────────────────────────

const previewObject: ActionHandler = async (params, context) => {
  const parsed = parseObjectHitId(params.id);
  if (!parsed) return jsonResponse(400, { error: 'An object preview id must be "<object_type>/<object_id>".' });

  // TWO checks, because neither is sufficient alone. `parseObjectHitId` above
  // already refused a `.`/`..` segment in either half — that is the traversal
  // guard, and it has to live there because the verb schema does NOT have one:
  // `object_id` is `z.string().min(1)` over `objectIdSchema = z.string()`, so
  // a `../` would otherwise reach `objectRecordKey` and, on the file-backed
  // store, walk out of the store directory. What the schema DOES give is the
  // `object_type` enum, so validate through it rather than casting into it —
  // the same gate `admin-object.ts` puts in front of every verb.
  const request = objectVerbRequestSchema.safeParse({
    action: 'get',
    object_type: parsed.objectType,
    object_id: parsed.objectId,
    projection: 'full',
  });
  if (!request.success) return jsonResponse(400, { error: 'Unknown object type or id.' });

  const store = await openObjectStore(context.event, context.binding);
  const result = await handleObjectVerb(store, request.data, context.principal);

  if (result.status < 200 || result.status >= 300) {
    return jsonResponse(result.status, { error: result.body.error ?? 'The object could not be read.' });
  }

  // The `get` verb answers `{ record }` (object-verbs.ts `case 'get'`), NOT
  // `{ object }` — that spelling belongs to `inventory`'s single-object
  // detail branch. Reading the wrong key made every object preview a
  // one-field `{"record": …}` wrapper, which `previewSummary` then reduced
  // to the useless row "Record — N fields". Both spellings are accepted so
  // either branch's shape previews correctly; the raw body stays the floor.
  const preview = trimJsonPreview(result.body.record ?? result.body.object ?? result.body);

  return jsonResponse(200, {
    collection: 'objects',
    id: `${parsed.objectType}/${parsed.objectId}`,
    format: 'json',
    ...preview,
  });
};

const previewArtifact: ActionHandler = async (params, context) => {
  const parsed = parseArtifactHitId(params.id);
  if (!parsed) return jsonResponse(400, { error: 'An artifact preview id must be "<requestId>/<sha256>".' });

  const indexStore = await openArtifactIndexStore(context.event, context.binding);
  const read = await readArtifactReferenceResult(indexStore, parsed.requestId, parsed.sha256);

  if (read.status === 'absent') return jsonResponse(404, { error: 'Artifact metadata not found.' });
  if (read.status === 'rejected') {
    // Never collapse "stored but unreadable" into "missing" — that ambiguity
    // is exactly what readArtifactReferenceResult exists to preserve.
    return jsonResponse(422, { error: `Artifact index entry is not usable: ${read.issue}` });
  }

  return jsonResponse(200, {
    collection: 'artifacts',
    id: formatArtifactHitId(parsed.requestId, parsed.sha256),
    format: 'artifact-metadata',
    artifact: read.reference,
    hit: normalizeArtifactHit({ ...read.reference, requestId: parsed.requestId }),
  });
};

const previewStoreBlob: ActionHandler = async (params, context) => {
  const parsed = parseStoreHitId(params.id);
  if (!parsed) return jsonResponse(400, { error: 'A store preview id must be "<store>/<key>".' });

  const store = await openAllowedManagedStore(parsed.store, context.event, context.binding);
  if (!store) {
    // The allowlist is the whole point: an unmanaged store name is refused
    // before any read is attempted, and the refusal does not disclose whether
    // such a store exists.
    return jsonResponse(403, { error: 'That store is not available through the inventory preview.' });
  }

  const raw = await store.get(parsed.key);
  if (raw === null || raw === undefined) return jsonResponse(404, { error: 'Blob not found.' });

  const preview = trimStoreBlobPreview(typeof raw === 'string' ? raw : String(raw));

  return jsonResponse(200, {
    collection: 'stores',
    id: formatStoreHitId(parsed.store, parsed.key),
    store: parsed.store,
    key: parsed.key,
    ...preview,
  });
};

const handlePreview: ActionHandler = async (params, context) => {
  switch (asTrimmed(params.collection)) {
    case 'objects':
      return previewObject(params, context);
    case 'artifacts':
      return previewArtifact(params, context);
    case 'stores':
      return previewStoreBlob(params, context);
    default:
      return jsonResponse(400, { error: 'A collection of "objects", "artifacts", or "stores" is required.' });
  }
};

// ─── artifact verbs ─────────────────────────────────────────────────────────

const writeArtifactReferenceJson = async (
  indexStore: ArtifactIndexStore,
  requestId: string,
  artifact: ArtifactReference
) => {
  await indexStore.setJSON(requestArtifactReferenceKey(requestId, artifact.sha256), artifact, {
    metadata: {
      requestId,
      sha256: artifact.sha256,
      contentType: artifact.contentType,
      ...(artifact.deletedAtISO ? { deletedAtISO: artifact.deletedAtISO } : {}),
    },
  });
};

const deleteIndexKey = async (
  indexStore: { delete?: (key: string) => Promise<void>; del?: (key: string) => Promise<void> },
  key: string
) => {
  // Netlify's Store names it `delete`; the local file-backed fallback names it
  // `del`. A store that offers neither leaves a stale by-tag pointer behind —
  // harmless (pointer resolution re-reads the reference, which no longer
  // carries the tag) but never silent.
  if (typeof indexStore.delete === 'function') return indexStore.delete(key);
  if (typeof indexStore.del === 'function') return indexStore.del(key);
  console.warn(`Admin_Inventory: artifact index store cannot delete "${key}"; the stale tag pointer remains.`);
  return undefined;
};

/**
 * Which ACTIVE object (if any) still points at this artifact. Sweeps the live
 * records and matches on the artifact's blobKey, its public `/img|/pdf` path
 * form, or its bare sha256 — deliberately broad, because a delete that slipped
 * past a narrow shape-aware check would break a published page.
 */
const findActiveObjectReferencing = async (event: LambdaEvent, reference: ArtifactReference, binding: SiteBinding) => {
  const store = await openObjectStore(event, binding);
  const records = await listAllObjectRecords(store, { status: 'active' });
  const scanned = records.slice(0, MAX_REFERENCE_SCAN_RECORDS);

  return {
    match: findReferencingObjectId(
      scanned.map((record) => ({
        object_id: record.object_id,
        object_type: record.object_type,
        serialized: JSON.stringify(record),
      })),
      artifactReferenceNeedles({ blobKey: reference.blobKey, sha256: reference.sha256 })
    ),
    // A sweep that hit the cap cannot prove "nothing references this", so the
    // caller reports the check as incomplete rather than as a clean bill.
    complete: records.length <= MAX_REFERENCE_SCAN_RECORDS,
  };
};

const handleDeleteArtifact: ActionHandler = async (params, context) => {
  const parsed = parseArtifactHitId(params.id);
  if (!parsed) return jsonResponse(400, { error: 'An artifact id of "<requestId>/<sha256>" is required.' });

  const indexStore = await openArtifactIndexStore(context.event, context.binding);
  const read = await readArtifactReferenceResult(indexStore, parsed.requestId, parsed.sha256);
  if (read.status === 'absent') return jsonResponse(404, { error: 'Artifact metadata not found.' });
  if (read.status === 'rejected') {
    return jsonResponse(422, { error: `Artifact index entry is not usable: ${read.issue}` });
  }

  const { match, complete } = await findActiveObjectReferencing(context.event, read.reference, context.binding);
  if (match) {
    return jsonResponse(409, {
      refused: true,
      id: formatArtifactHitId(parsed.requestId, parsed.sha256),
      referencedBy: match.object_id,
      referencedByType: match.object_type,
      error: `Refused: artifact is referenced by the active object ${match.object_id}.`,
    });
  }

  if (!complete) {
    return jsonResponse(409, {
      refused: true,
      id: formatArtifactHitId(parsed.requestId, parsed.sha256),
      error: 'Refused: the active-object reference check could not be completed, so the artifact is not proven unused.',
    });
  }

  if (read.reference.deletedAtISO) {
    return jsonResponse(200, {
      id: formatArtifactHitId(parsed.requestId, parsed.sha256),
      artifact: read.reference,
      deleted: true,
      alreadyDeleted: true,
    });
  }

  // Soft delete, the same shape `artifact_soft_delete` writes: the reference
  // is marked and the bytes stay put, so a mistaken delete is recoverable.
  const deletedArtifact: ArtifactReference = {
    ...read.reference,
    deletedAtISO: new Date().toISOString(),
    deletedBy: context.actor,
  };

  await writeArtifactReferenceJson(indexStore, parsed.requestId, deletedArtifact);

  return jsonResponse(200, {
    id: formatArtifactHitId(parsed.requestId, parsed.sha256),
    artifact: deletedArtifact,
    deleted: true,
  });
};

const handleRetagArtifact: ActionHandler = async (params, context) => {
  const parsed = parseArtifactHitId(params.id);
  if (!parsed) return jsonResponse(400, { error: 'An artifact id of "<requestId>/<sha256>" is required.' });

  const add = asStringArray(params.add);
  const remove = asStringArray(params.remove);
  if (add.length === 0 && remove.length === 0) {
    return jsonResponse(400, { error: 'At least one tag to add or remove is required.' });
  }

  const indexStore = await openArtifactIndexStore(context.event, context.binding);
  const read = await readArtifactReferenceResult(indexStore, parsed.requestId, parsed.sha256);
  if (read.status === 'absent') return jsonResponse(404, { error: 'Artifact metadata not found.' });
  if (read.status === 'rejected') {
    return jsonResponse(422, { error: `Artifact index entry is not usable: ${read.issue}` });
  }

  const change = applyArtifactTagChanges(read.reference.tags, add, remove);
  if (change.rejected.length) {
    return jsonResponse(400, {
      error: 'One or more tags are not usable.',
      rejected: change.rejected,
    });
  }
  if (change.error) return jsonResponse(400, { error: change.error });

  const updated: ArtifactReference = { ...read.reference, ...(change.tags.length ? { tags: change.tags } : {}) };
  if (!change.tags.length) delete updated.tags;

  const staleTagPointerKeys = artifactTagPointerKeys(read.reference).filter(
    (key) => !artifactTagPointerKeys(updated).includes(key)
  );

  // Rewrite the reference and every pointer it should now have, THEN drop the
  // pointers it should no longer have. In that order a crash between the two
  // leaves a stale by-tag pointer (harmless — pointer resolution re-reads the
  // reference, which no longer carries the tag) rather than an artifact that
  // has lost its index entry.
  await writeArtifactReferenceIndexes(indexStore, parsed.requestId, updated);
  for (const key of staleTagPointerKeys) await deleteIndexKey(indexStore, key);

  /**
   * THE WRITE IS NOT THE ANSWER — THE READ-BACK IS.
   *
   * This handler used to return 200 with `change.tags`: the list it had just
   * COMPUTED, never a list anything had read. The client turned that into
   * "N of N updated", so a retag that did not end up visible to the very next
   * search — the reported acceptance failure — was indistinguishable from one
   * that did. `readArtifactReferences` (the search sweep) reads exactly this
   * key, so reading it here asks the same question the search will ask, at the
   * moment the operator is still looking.
   *
   * The read-back costs one `get` against a store this request already has
   * open, and it is the only thing entitled to say the tag is on the artifact.
   * `verifyArtifactRetag` owns the ruling; anything short of `verified` comes
   * back as a refusal carrying the store's own answer, because a 200 here is
   * read downstream as proof.
   */
  const readBack = await readArtifactReferenceResult(indexStore, parsed.requestId, parsed.sha256);
  const verification = verifyArtifactRetag(
    change.tags,
    readBack.status === 'ok' ? { status: 'ok', tags: readBack.reference.tags } : readBack
  );

  if (!verification.verified) {
    return jsonResponse(409, {
      refused: true,
      id: formatArtifactHitId(parsed.requestId, parsed.sha256),
      verified: false,
      // What the STORE says, never what this request intended.
      tags: verification.persistedTags,
      persistedTags: verification.persistedTags,
      intendedTags: change.tags,
      missing: verification.missing,
      unexpected: verification.unexpected,
      error: verification.reason ?? 'The retag could not be confirmed.',
    });
  }

  return jsonResponse(200, {
    id: formatArtifactHitId(parsed.requestId, parsed.sha256),
    artifact: readBack.status === 'ok' ? readBack.reference : updated,
    verified: true,
    // Both spellings carry the read-back list, so no caller can accidentally
    // report the intended tags as the stored ones.
    tags: verification.persistedTags,
    persistedTags: verification.persistedTags,
    added: change.added,
    removed: change.removed,
  });
};

const actionHandlers: Record<string, ActionHandler> = {
  search: handleSearch,
  preview: handlePreview,
  'delete-artifact': handleDeleteArtifact,
  'retag-artifact': handleRetagArtifact,
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const adminState = await resolveAdminAccessFromEvent(event, context, binding);
  if (!adminState.authenticated) {
    return jsonResponse(401, { error: adminState.error || 'Authentication is required.' });
  }

  // owner|admin. `resolveAdminAccessFromEvent` sets isAdmin from the RESOLVED
  // role set (owner expands to owner+admin+publisher), so an owner passes on
  // either arm; publisher, editor and viewer pass on neither.
  if (!adminState.isAdmin && !isOwner(adminState.roles)) {
    return jsonResponse(403, { error: 'Owner or admin access is required for the inventory.' });
  }

  const params = parseBody(event);
  const action = asTrimmed(params.action);
  const actionHandler = action ? actionHandlers[action] : undefined;

  if (!actionHandler) {
    return jsonResponse(400, { error: 'Unknown or missing action.' });
  }

  const principal: Principal = {
    kind: 'human',
    id: adminState.userId ?? '',
    email: adminState.email ?? '',
  };
  const actor = adminState.email || adminState.userId || 'admin';

  try {
    return await actionHandler(params, { event, principal, actor, binding });
  } catch (error) {
    console.error(`Admin_Inventory action "${action}" failed.`, error);
    return jsonResponse(500, { error: 'The inventory operation failed.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
