/**
 * Pure helpers behind `server/functions/admin-inventory.ts` (T1).
 *
 * Everything here is deterministic and store-free so the server function can
 * stay a thin fan-out over the three collections while the parts that are easy
 * to get subtly wrong — what counts as a match, how a row is normalized, how a
 * cursor survives the store changing underneath it, how a preview is trimmed —
 * are covered by `inventory-server-logic.test.ts` under `node:test`.
 *
 * Deliberately free of Node-only globals (no `Buffer`) so the same module is
 * safe to import from a browser bundle; byte work goes through
 * TextEncoder/TextDecoder.
 */
import { ADMIN_PREVIEWABLE_IMAGE_REF_RE } from './artifact-preview.js';

export const inventoryCollections = ['objects', 'artifacts', 'stores'] as const;

export type InventoryCollection = (typeof inventoryCollections)[number];

/**
 * The one row shape every collection normalizes to (BRIEF §Tasks T1).
 *
 * `updatedAt`, `sizeBytes` and `previewRef` are nullable rather than optional
 * because the governing rule is "the UI never claims a state it can't prove":
 * a store blob whose listing carries no timestamp reports `null`, which a
 * surface can render as "unknown", instead of inheriting a plausible-looking
 * fabricated value.
 */
export type InventoryHit = {
  collection: InventoryCollection;
  id: string;
  label: string;
  kind: string;
  status: string;
  updatedAt: string | null;
  sizeBytes: number | null;
  previewRef: string | null;
  /**
   * A blob key for an image this row can PROVE is its own, or `null`.
   *
   * Same nullability rule as the fields above, and for the same reason: a
   * surface renders real bytes when this is set and its own type visual when
   * it is not — never a placeholder image standing in for a picture that was
   * never found. Objects get theirs from the requestId join the search
   * response performs once (`buildRequestThumbnailIndex` +
   * `attachObjectThumbnails`); artifacts already carry their bytes on
   * `previewRef`, and store blobs have no imagery at all, so both leave this
   * `null`.
   */
  thumbnailRef: string | null;
  refs: string[];
};

export const INVENTORY_MAX_LIMIT = 50;
export const INVENTORY_DEFAULT_LIMIT = 25;
/** Largest preview payload returned inline, per BRIEF ("JSON trimmed to 32 KB"). */
export const INVENTORY_PREVIEW_MAX_BYTES = 32 * 1024;

const asTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

// ─── request parsing ────────────────────────────────────────────────────────

export const clampInventoryLimit = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(asTrimmedString(value));
  if (!Number.isFinite(parsed)) return INVENTORY_DEFAULT_LIMIT;

  return Math.min(INVENTORY_MAX_LIMIT, Math.max(1, Math.floor(parsed)));
};

export const isInventoryCollection = (value: unknown): value is InventoryCollection =>
  typeof value === 'string' && (inventoryCollections as readonly string[]).includes(value);

/**
 * `collections` is optional; absent (or entirely unrecognized) means "all
 * three". Unknown entries are dropped rather than 400'ing so a newer client
 * asking for a collection this deploy does not have still gets the ones it
 * does — but a request that names ONLY unknown collections falls back to all
 * three rather than silently returning nothing.
 */
export const parseInventoryCollections = (value: unknown): InventoryCollection[] => {
  if (!Array.isArray(value)) return [...inventoryCollections];

  const selected = inventoryCollections.filter((collection) => value.includes(collection));
  return selected.length > 0 ? selected : [...inventoryCollections];
};

export const normalizeInventoryQuery = (value: unknown): string => (asTrimmedString(value) ?? '').toLowerCase();

/**
 * A hit matches when the (already lowercased) query is a substring of any of
 * the supplied fields. An empty query matches everything — the inventory's
 * default view is "show me what is there", not an empty table.
 */
export const matchesInventoryQuery = (query: string, fields: ReadonlyArray<string | null | undefined>): boolean => {
  if (!query) return true;

  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(query));
};

// ─── ids ────────────────────────────────────────────────────────────────────

export const formatObjectHitId = (objectType: string, objectId: string) => `${objectType}/${objectId}`;

/**
 * Split on the FIRST slash: the object TYPE never contains one, the id half
 * may. Both halves are untrusted — the id arrives from a client-supplied hit
 * id and becomes a segment of a blob key (`objects/<type>/by-id/<id>.json`,
 * `object-store-keys.ts`).
 *
 * WHY THE TRAVERSAL CHECK IS HERE AND NOT LEFT TO THE VERB SCHEMA. It is
 * tempting to say `objectVerbRequestSchema` already validates both halves; it
 * does not. `object_type` is a real `z.enum`, but `object_id` is
 * `z.string().min(1)` (object-verbs.ts) over `objectIdSchema = z.string()`
 * (schema/object-record-v1.ts) — there is NO id pattern anywhere in the
 * platform. A `..` segment therefore reaches `objectRecordKey` intact, and
 * the local file-backed store (`server/lib/local-blobs.ts`) maps a key to a
 * path with `path.join`, which normalizes `..` and walks out of the store
 * directory. So the guard lives here, matching the identical rule
 * `parseStoreHitId` applies to blob keys below.
 */
export const parseObjectHitId = (id: unknown): { objectType: string; objectId: string } | undefined => {
  const raw = asTrimmedString(id);
  if (!raw) return undefined;

  const separator = raw.indexOf('/');
  if (separator <= 0 || separator === raw.length - 1) return undefined;

  const objectType = raw.slice(0, separator);
  const objectId = raw.slice(separator + 1);
  if (objectType === '.' || objectType === '..' || objectType.includes('\\')) return undefined;
  if (objectId.includes('\\')) return undefined;
  if (objectId.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;

  return { objectType, objectId };
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export const formatArtifactHitId = (requestId: string, sha256: string) => `${requestId}/${sha256.toLowerCase()}`;

/**
 * Split on the LAST slash: the sha256 is the fixed-width half, so a requestId
 * that ever grows a slash still round-trips.
 */
export const parseArtifactHitId = (id: unknown): { requestId: string; sha256: string } | undefined => {
  const raw = asTrimmedString(id);
  if (!raw) return undefined;

  const separator = raw.lastIndexOf('/');
  if (separator <= 0) return undefined;

  const requestId = raw.slice(0, separator);
  const sha256 = raw.slice(separator + 1);
  if (!requestId || !SHA256_PATTERN.test(sha256)) return undefined;

  return { requestId, sha256: sha256.toLowerCase() };
};

export const formatStoreHitId = (store: string, key: string) => `${store}/${key}`;

/**
 * Split on the FIRST slash: blob keys routinely contain slashes, store names
 * never do. The store half is only ever a CANDIDATE here — the caller must
 * still check it against `listManagedBlobStores` before opening anything, and
 * this function deliberately rejects the traversal shapes (`.`, `..`, empty
 * segment) rather than leaving that to the allowlist alone.
 */
export const parseStoreHitId = (id: unknown): { store: string; key: string } | undefined => {
  const raw = asTrimmedString(id);
  if (!raw) return undefined;

  const separator = raw.indexOf('/');
  if (separator <= 0 || separator === raw.length - 1) return undefined;

  const store = raw.slice(0, separator);
  const key = raw.slice(separator + 1);
  if (store === '.' || store === '..' || store.includes('\\')) return undefined;
  if (key.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;

  return { store, key };
};

// ─── normalization ──────────────────────────────────────────────────────────

export type ObjectHitInput = {
  object_id: string;
  object_type: string;
  display_name?: string | null;
  status?: string | null;
  updated_at?: string | null;
};

export const normalizeObjectHit = (row: ObjectHitInput): InventoryHit => {
  const id = formatObjectHitId(row.object_type, row.object_id);

  return {
    collection: 'objects',
    id,
    label: asTrimmedString(row.display_name) ?? row.object_id,
    kind: row.object_type,
    status: asTrimmedString(row.status) ?? 'unknown',
    updatedAt: asTrimmedString(row.updated_at) ?? null,
    sizeBytes: null,
    previewRef: id,
    // Filled in by `attachObjectThumbnails` once the artifact index for this
    // response has been read — never by this function, which sees one row.
    thumbnailRef: null,
    refs: [],
  };
};

export type ArtifactHitInput = {
  requestId: string;
  sha256: string;
  blobKey?: string | null;
  label?: string | null;
  originalFilename?: string | null;
  filename?: string | null;
  artifactKind?: string | null;
  contentType?: string | null;
  createdAtISO?: string | null;
  sizeBytes?: number | null;
  tags?: string[] | null;
  deletedAtISO?: string | null;
};

export const normalizeArtifactHit = (reference: ArtifactHitInput): InventoryHit => ({
  collection: 'artifacts',
  id: formatArtifactHitId(reference.requestId, reference.sha256),
  label:
    asTrimmedString(reference.label) ??
    asTrimmedString(reference.filename) ??
    asTrimmedString(reference.originalFilename) ??
    reference.sha256.slice(0, 12),
  kind: asTrimmedString(reference.artifactKind) ?? asTrimmedString(reference.contentType) ?? 'other',
  // A soft-deleted reference is still listed (that is how it gets restored),
  // but it never reports itself as active.
  status: reference.deletedAtISO ? 'deleted' : 'active',
  updatedAt: asTrimmedString(reference.deletedAtISO) ?? asTrimmedString(reference.createdAtISO) ?? null,
  sizeBytes:
    typeof reference.sizeBytes === 'number' && Number.isFinite(reference.sizeBytes) ? reference.sizeBytes : null,
  previewRef: asTrimmedString(reference.blobKey) ?? null,
  // An artifact's own bytes are `previewRef`; it is never the thumbnail FOR
  // something else in the same row.
  thumbnailRef: null,
  refs: [reference.requestId],
});

/** Every field the artifact query is matched against (BRIEF: label / originalFilename / tags / kind). */
export const artifactMatchFields = (reference: ArtifactHitInput): string[] =>
  [
    reference.label,
    reference.originalFilename,
    reference.filename,
    reference.artifactKind,
    reference.contentType,
    reference.requestId,
    reference.sha256,
    ...(reference.tags ?? []),
  ].filter((field): field is string => typeof field === 'string' && field.length > 0);

export type StoreHitInput = {
  store: string;
  key: string;
  etag?: string | null;
};

export const normalizeStoreHit = (blob: StoreHitInput): InventoryHit => {
  const id = formatStoreHitId(blob.store, blob.key);

  return {
    collection: 'stores',
    id,
    label: blob.key,
    kind: blob.store,
    // A blob listing carries a key and (sometimes) an etag — nothing that
    // proves a lifecycle state — so the row says exactly that.
    status: 'stored',
    updatedAt: null,
    sizeBytes: null,
    previewRef: id,
    // A store listing carries a key and maybe an etag; nothing image-like.
    thumbnailRef: null,
    refs: [],
  };
};

// ─── object thumbnails (the requestId join) ─────────────────────────────────

/**
 * WHY OBJECTS CAN HAVE IMAGERY AT ALL. Objects and artifacts share an
 * identifier: an object id is `<type>/<requestId>` (e.g.
 * `content_item/req_agent_fruit_..._20260829_01`) and every artifact produced
 * under that article carries an id of `<requestId>/<sha256>`. So an object's
 * own pictures are exactly the artifact-index references whose `requestId`
 * equals its object id — no extra store, no extra listing, no per-row fetch.
 *
 * The join is therefore a pure function of the artifact references the search
 * response ALREADY read for the artifacts collection. It is built once per
 * response (`buildRequestThumbnailIndex`) and applied to the object rows
 * (`attachObjectThumbnails`); nothing here is per-row and nothing here does
 * I/O.
 */
export type ArtifactThumbnailCandidate = {
  requestId: string;
  sha256: string;
  blobKey?: string | null;
  artifactKind?: string | null;
  contentType?: string | null;
  createdAtISO?: string | null;
  deletedAtISO?: string | null;
  /**
   * The request-scoped slot this artifact was written under, when the
   * reference carries one — `primary_image`, `hero_image`, `article_image_2`.
   * Platform's `ArtifactReference` has no first-class `slot` field today (the
   * by-slot pointer lives in pdf-tool), so the server reads it out of
   * `metadata.slot` via `artifactSlotHint` and passes whatever it finds. When
   * nothing carries a slot the selection below degrades to "earliest image",
   * which is the documented second preference — not a guess dressed up as a
   * hero.
   */
  slot?: string | null;
};

/** The slot spellings that mean "this is the one to show": `primary_image`, `hero`, `article_hero_image`. */
const PRIMARY_SLOT_RE = /(^|[_-])(primary|hero)([_-]|$)/i;

/** `metadata.slot`, when an artifact reference's opaque metadata bag carries one as a string. */
export const artifactSlotHint = (metadata: unknown): string | null => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return asTrimmedString((metadata as Record<string, unknown>).slot) ?? null;
};

/** True for a reference whose bytes are an image — by declared kind, else by content type. */
const isImageCandidate = (candidate: ArtifactThumbnailCandidate): boolean => {
  const kind = asTrimmedString(candidate.artifactKind)?.toLowerCase();
  if (kind) return kind === 'image';
  return (asTrimmedString(candidate.contentType)?.toLowerCase() ?? '').startsWith('image/');
};

/**
 * The one image to show for a request, or `null`.
 *
 * Order of preference, per the brief: the primary/hero slot, else the
 * EARLIEST image artifact. A candidate is only eligible when it is
 * (a) an image, (b) not soft-deleted — a deleted artifact must not be a
 * thing's face — and (c) carries a blob key `admin-get-blob-image` will
 * actually serve, checked against the very pattern that endpoint enforces,
 * so a row never issues a request that is known to 400.
 *
 * `null` is a real answer, and the only honest one when nothing qualifies:
 * the surface then draws the type visual.
 */
export const selectRequestThumbnail = (candidates: readonly ArtifactThumbnailCandidate[]): string | null => {
  const eligible = candidates.filter(
    (candidate) =>
      !asTrimmedString(candidate.deletedAtISO) &&
      isImageCandidate(candidate) &&
      ADMIN_PREVIEWABLE_IMAGE_REF_RE.test(asTrimmedString(candidate.blobKey) ?? '')
  );
  if (eligible.length === 0) return null;

  const primary = eligible.filter((candidate) => PRIMARY_SLOT_RE.test(asTrimmedString(candidate.slot) ?? ''));
  const pool = primary.length > 0 ? primary : eligible;

  // Earliest first. A reference with no timestamp cannot claim to be the
  // earliest, so it sorts after every dated one; sha256 breaks the remaining
  // ties, which keeps the answer stable across responses.
  const [chosen] = [...pool].sort((a, b) => {
    const left = asTrimmedString(a.createdAtISO) ?? '';
    const right = asTrimmedString(b.createdAtISO) ?? '';
    if (left !== right) {
      if (!left) return 1;
      if (!right) return -1;
      return left < right ? -1 : 1;
    }
    return a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0;
  });

  return (chosen && asTrimmedString(chosen.blobKey)) ?? null;
};

/** requestId → hero image blob key, for every request that has one. Built once per search response. */
export const buildRequestThumbnailIndex = (
  candidates: readonly ArtifactThumbnailCandidate[]
): Map<string, string> => {
  const byRequest = new Map<string, ArtifactThumbnailCandidate[]>();
  for (const candidate of candidates) {
    const requestId = asTrimmedString(candidate.requestId);
    if (!requestId) continue;
    const existing = byRequest.get(requestId);
    if (existing) existing.push(candidate);
    else byRequest.set(requestId, [candidate]);
  }

  const index = new Map<string, string>();
  for (const [requestId, group] of byRequest) {
    const blobKey = selectRequestThumbnail(group);
    if (blobKey) index.set(requestId, blobKey);
  }

  return index;
};

/**
 * Stamps the joined thumbnail onto object rows. Every other collection passes
 * through untouched, and an object with no match keeps `thumbnailRef: null`
 * — which is what makes the type visual the fallback rather than a spinner
 * that never resolves.
 */
export const attachObjectThumbnails = (
  hits: readonly InventoryHit[],
  thumbnails: ReadonlyMap<string, string>
): InventoryHit[] =>
  hits.map((hit) => {
    if (hit.collection !== 'objects') return hit;
    const parsed = parseObjectHitId(hit.id);
    const blobKey = parsed ? thumbnails.get(parsed.objectId) : undefined;
    return blobKey ? { ...hit, thumbnailRef: blobKey } : hit;
  });

// ─── cursors ────────────────────────────────────────────────────────────────

export type InventoryCursorMap = Partial<Record<InventoryCollection, string>>;

/**
 * Cursors are keyset, not offset, and they key on the hit `id` — the only part
 * of a row that cannot change under the reader. Sorting by `updatedAt` would
 * read better but makes the cursor unstable: a row touched between page 1 and
 * page 2 moves across the cursor boundary and is either served twice or
 * skipped. Pages are therefore ordered by `id` ascending, and a surface that
 * wants recency sorts the page it holds.
 */
export const encodeInventoryCursors = (cursors: InventoryCursorMap): string => {
  const params = new URLSearchParams();
  for (const collection of inventoryCollections) {
    const after = cursors[collection];
    if (after) params.set(collection, after);
  }

  return params.toString();
};

export const decodeInventoryCursors = (raw: unknown): InventoryCursorMap => {
  const value = asTrimmedString(raw);
  if (!value) return {};

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(value);
  } catch {
    return {};
  }

  const cursors: InventoryCursorMap = {};
  for (const collection of inventoryCollections) {
    const after = asTrimmedString(params.get(collection));
    if (after) cursors[collection] = after;
  }

  return cursors;
};

export type InventoryPage = {
  hits: InventoryHit[];
  /** The `id` a follow-up request should continue after, or null when exhausted. */
  nextAfter: string | null;
};

export const paginateInventoryHits = (
  hits: readonly InventoryHit[],
  after: string | undefined,
  limit: number
): InventoryPage => {
  const safeLimit = clampInventoryLimit(limit);
  const ordered = [...hits].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const remaining = after ? ordered.filter((hit) => hit.id > after) : ordered;
  const page = remaining.slice(0, safeLimit);

  return {
    hits: page,
    nextAfter: remaining.length > safeLimit ? (page.at(-1)?.id ?? null) : null,
  };
};

// ─── previews ───────────────────────────────────────────────────────────────

export type TrimmedPreview = {
  text: string;
  truncated: boolean;
  /** Byte length of the UNTRIMMED payload, so a surface can say how much it is not showing. */
  sizeBytes: number;
};

export const trimTextPreview = (text: string, maxBytes = INVENTORY_PREVIEW_MAX_BYTES): TrimmedPreview => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false, sizeBytes: bytes.byteLength };

  // Walk back off any UTF-8 continuation byte so the cut never lands mid
  // code point and hands the client a replacement character.
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;

  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true, sizeBytes: bytes.byteLength };
};

export const trimJsonPreview = (value: unknown, maxBytes = INVENTORY_PREVIEW_MAX_BYTES): TrimmedPreview => {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    // A cyclic or otherwise unserializable value is a real thing to find in a
    // store; report it as the preview rather than failing the request.
    text = '"[unserializable]"';
  }

  return trimTextPreview(text, maxBytes);
};

/**
 * Store blobs are not guaranteed to hold JSON. Parse when we can (so the
 * preview is pretty-printed and stable), fall back to the raw text otherwise,
 * and say which happened.
 */
export const trimStoreBlobPreview = (
  raw: string,
  maxBytes = INVENTORY_PREVIEW_MAX_BYTES
): TrimmedPreview & { format: 'json' | 'text' } => {
  try {
    return { ...trimJsonPreview(JSON.parse(raw) as unknown, maxBytes), format: 'json' };
  } catch {
    return { ...trimTextPreview(raw, maxBytes), format: 'text' };
  }
};

// ─── tags ───────────────────────────────────────────────────────────────────

export const ARTIFACT_TAG_MAX_LENGTH = 40;
export const ARTIFACT_TAGS_MAX = 20;

// Built from char codes rather than written as a literal for the same reason
// artifacts.ts does it: a control-character class in a regex literal trips
// eslint's no-control-regex.
const tagControlCharacters = `${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`;
const TAG_UNSAFE_CHARACTERS = new RegExp(`[${tagControlCharacters}<>]`, 'u');

export const normalizeArtifactTag = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > ARTIFACT_TAG_MAX_LENGTH) return undefined;
  if (TAG_UNSAFE_CHARACTERS.test(normalized)) return undefined;

  return normalized;
};

export type ArtifactTagChange = {
  tags: string[];
  added: string[];
  removed: string[];
  /** Inputs that could not be normalized — the caller refuses the whole call rather than silently dropping them. */
  rejected: string[];
  /** Set when the result would exceed the ArtifactReference tag cap. */
  error?: string;
};

/**
 * Tag arithmetic for `retag-artifact`. `remove` wins over `add` for the same
 * tag so a request that says both is deterministic rather than order-dependent.
 * Comparison is case-insensitive (the tag pointer key is a path segment) while
 * the stored casing of an existing tag is preserved.
 */
export const applyArtifactTagChanges = (
  existing: ReadonlyArray<string> | undefined,
  add: unknown,
  remove: unknown
): ArtifactTagChange => {
  const rejected: string[] = [];
  const normalizeList = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const entry of value) {
      const normalized = normalizeArtifactTag(entry);
      if (normalized) out.push(normalized);
      else rejected.push(typeof entry === 'string' ? entry : String(entry));
    }
    return out;
  };

  const toAdd = normalizeList(add);
  const toRemove = normalizeList(remove);
  const removeKeys = new Set(toRemove.map((tag) => tag.toLowerCase()));

  const current = (existing ?? []).map((tag) => normalizeArtifactTag(tag)).filter((tag): tag is string => Boolean(tag));

  const tags: string[] = [];
  const seen = new Set<string>();
  const push = (tag: string) => {
    const key = tag.toLowerCase();
    if (seen.has(key) || removeKeys.has(key)) return;
    seen.add(key);
    tags.push(tag);
  };

  for (const tag of current) push(tag);
  const before = new Set(current.map((tag) => tag.toLowerCase()));
  for (const tag of toAdd) push(tag);

  const removed = current.filter((tag) => removeKeys.has(tag.toLowerCase()));
  const added = tags.filter((tag) => !before.has(tag.toLowerCase()));

  return {
    tags,
    added,
    removed,
    rejected,
    ...(tags.length > ARTIFACT_TAGS_MAX ? { error: `An artifact may carry at most ${ARTIFACT_TAGS_MAX} tags.` } : {}),
  };
};

// ─── artifact reference lookup ──────────────────────────────────────────────

/**
 * Which ACTIVE objects reference an artifact. `needles` are the strings that
 * identify the artifact anywhere in a record — its blobKey, its public
 * `/img|/pdf` path form, and its sha256 — and a record matches when its
 * serialized form contains any of them.
 *
 * Substring matching over the serialized record is deliberate: artifact refs
 * appear in a dozen different node shapes (and inside prose), and a
 * shape-aware walk that missed one would let a delete through that the refusal
 * exists to stop. The failure mode of the loose check is a refusal that names
 * an object which merely mentions the sha — the safe direction.
 */
export const findReferencingObjectId = (
  records: ReadonlyArray<{ object_id: string; object_type: string; serialized: string }>,
  needles: ReadonlyArray<string>
): { object_id: string; object_type: string } | undefined => {
  const present = needles.filter((needle) => typeof needle === 'string' && needle.length > 0);
  if (present.length === 0) return undefined;

  for (const record of records) {
    if (present.some((needle) => record.serialized.includes(needle))) {
      return { object_id: record.object_id, object_type: record.object_type };
    }
  }

  return undefined;
};

/** The strings that stand for one artifact inside an object record. */
export const artifactReferenceNeedles = (input: { blobKey?: string | null; sha256: string }): string[] => {
  const needles = new Set<string>([input.sha256.toLowerCase()]);
  const blobKey = asTrimmedString(input.blobKey);
  if (blobKey) {
    const normalized = blobKey.replace(/^\/+/, '').replace(/^artifacts\//, '');
    needles.add(normalized);
    const [kind, ...rest] = normalized.split('/');
    if (kind === 'image' && rest.length) needles.add(`/img/${rest.join('/')}`);
    if (kind === 'pdf' && rest.length) needles.add(`/pdf/${rest.join('/')}`);
  }

  return [...needles];
};
