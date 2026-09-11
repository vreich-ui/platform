import {
  artifactStorageKey,
  getArtifactReferenceIssue,
  isArtifactReference,
  safePathSegment,
  type ArtifactKind,
  type ArtifactReference,
} from './artifacts.js';
import { collectBlobListItems, type BlobListResponse } from './blob-list.js';

export type ArtifactIndexStore = {
  get: (key: string) => Promise<string | null>;
  setJSON: (key: string, value: unknown, options?: { metadata?: Record<string, string> }) => Promise<unknown>;
  list: (options?: {
    prefix?: string;
    directories?: boolean;
    paginate?: boolean;
  }) => Promise<BlobListResponse> | AsyncIterable<BlobListResponse>;
};

export type ArtifactPointer = {
  requestId: string;
  sha256: string;
  artifactKind: ArtifactKind;
};

export const requestArtifactReferenceKey = (requestId: string, sha256: string) => {
  return `request-artifacts/${encodeURIComponent(requestId)}/${sha256}.json`;
};

export const artifactPointerValue = (requestId: string, reference: ArtifactReference): ArtifactPointer => {
  const [artifactKind] = reference.blobKey.split('/');
  return {
    requestId,
    sha256: reference.sha256,
    artifactKind: (reference.artifactKind ?? artifactKind) as ArtifactKind,
  };
};

export const artifactKindPointerKey = (reference: ArtifactReference) => {
  const pointer = artifactPointerValue('', reference);
  return `by-kind/${pointer.artifactKind}/${reference.sha256}.json`;
};

export const artifactRequestPointerKey = (requestId: string, reference: ArtifactReference) => {
  const pointer = artifactPointerValue(requestId, reference);
  return `by-request/${encodeURIComponent(requestId)}/${pointer.artifactKind}/${reference.sha256}.json`;
};

/**
 * W2 T2.1: the by-sha content index — `by-sha/<artifactKind>/<sha256>.json` in the
 * artifact-index store.
 *
 * This is the ONLY record of "which blob already holds these exact bytes for this
 * tenant". It is written once, on the FIRST byte write for a sha, and never
 * rewritten by a later upload of the same bytes: `firstRequestId` is therefore the
 * request whose blob every other request's reference redirects to via
 * `ArtifactReference.storageKey`.
 *
 * Deliberately keyed by kind as well as sha so it cannot collapse an image and a
 * PDF that happen to share a digest — the same split `by-kind/` already uses.
 */
export type ArtifactShaIndexEntry = {
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  firstRequestId: string;
  createdAtISO: string;
};

export const artifactShaIndexKey = (artifactKind: ArtifactKind | string, sha256: string) =>
  `by-sha/${safePathSegment(String(artifactKind))}/${sha256.toLowerCase()}.json`;

const isShaIndexEntry = (value: unknown): value is ArtifactShaIndexEntry => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.storageKey === 'string' &&
    entry.storageKey.trim().length > 0 &&
    typeof entry.contentType === 'string' &&
    typeof entry.sizeBytes === 'number' &&
    Number.isFinite(entry.sizeBytes) &&
    typeof entry.firstRequestId === 'string' &&
    typeof entry.createdAtISO === 'string'
  );
};

/** Read the by-sha entry for a kind+digest. Returns undefined for absent OR unparseable/invalid. */
export const readArtifactByShaIndex = async (
  indexStore: ArtifactIndexStore,
  artifactKind: ArtifactKind | string,
  sha256: string
): Promise<ArtifactShaIndexEntry | undefined> => {
  const text = await indexStore.get(artifactShaIndexKey(artifactKind, sha256));
  if (!text) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    console.warn(`[artifact-index] unparseable by-sha entry at ${artifactShaIndexKey(artifactKind, sha256)}`);
    return undefined;
  }

  if (!isShaIndexEntry(parsed)) {
    console.warn(`[artifact-index] rejected by-sha entry at ${artifactShaIndexKey(artifactKind, sha256)}`);
    return undefined;
  }

  return parsed;
};

/**
 * First-write-wins. An existing VALID entry is left exactly as it is, so the
 * `firstRequestId`/`storageKey` a later upload would have claimed can never
 * displace the blob earlier references already redirect to. Returns the entry
 * that is now authoritative.
 */
export const writeArtifactByShaIndex = async (
  indexStore: ArtifactIndexStore,
  artifactKind: ArtifactKind | string,
  sha256: string,
  entry: ArtifactShaIndexEntry
): Promise<ArtifactShaIndexEntry> => {
  const existing = await readArtifactByShaIndex(indexStore, artifactKind, sha256);
  if (existing) return existing;

  await indexStore.setJSON(artifactShaIndexKey(artifactKind, sha256), entry, {
    metadata: {
      sha256: sha256.toLowerCase(),
      artifactKind: String(artifactKind),
      storageKey: entry.storageKey,
      firstRequestId: entry.firstRequestId,
    },
  });

  return entry;
};

/** Point an existing by-sha entry at a different blob (admin dedupe compaction only). */
export const repointArtifactByShaIndex = async (
  indexStore: ArtifactIndexStore,
  artifactKind: ArtifactKind | string,
  sha256: string,
  entry: ArtifactShaIndexEntry
): Promise<void> => {
  await indexStore.setJSON(artifactShaIndexKey(artifactKind, sha256), entry, {
    metadata: {
      sha256: sha256.toLowerCase(),
      artifactKind: String(artifactKind),
      storageKey: entry.storageKey,
      firstRequestId: entry.firstRequestId,
    },
  });
};

export const artifactTagPointerKeys = (reference: ArtifactReference) => {
  const tags = reference.tags ?? [];
  return Array.from(new Set(tags.map(safePathSegment).filter(Boolean))).map(
    (tag) => `by-tag/${tag}/${reference.sha256}.json`
  );
};

export const writeArtifactReferenceIndexes = async (
  indexStore: ArtifactIndexStore,
  requestId: string,
  reference: ArtifactReference
) => {
  const pointer = artifactPointerValue(requestId, reference);
  const pointerMetadata = {
    requestId,
    sha256: reference.sha256,
    artifactKind: pointer.artifactKind,
  };

  const fullReferenceKey = requestArtifactReferenceKey(requestId, reference.sha256);
  const fullReferenceMetadata = {
    requestId,
    sha256: reference.sha256,
    contentType: reference.contentType,
    ...(reference.deletedAtISO ? { deletedAtISO: reference.deletedAtISO } : {}),
  };

  await Promise.all([
    indexStore.setJSON(fullReferenceKey, reference, { metadata: fullReferenceMetadata }),
    indexStore.setJSON(artifactKindPointerKey(reference), pointer, { metadata: pointerMetadata }),
    indexStore.setJSON(artifactRequestPointerKey(requestId, reference), pointer, { metadata: pointerMetadata }),
    ...artifactTagPointerKeys(reference).map((key) => indexStore.setJSON(key, pointer, { metadata: pointerMetadata })),
  ]);
};

/**
 * Why this exists: `readArtifactReference` collapses three very different outcomes into
 * one `undefined` — the index entry is absent, the index entry is present but unparseable,
 * or the index entry is present, parseable and REJECTED by `isArtifactReference`. Callers
 * that treat `undefined` as "no artifact" then report a live artifact as missing, and the
 * operator has nothing to go on.
 *
 * That is not hypothetical. On 2026-08-06 pdf-tool began persisting a `filename` field on
 * every ArtifactReference (pdf-tool c066798); platform's key allowlist did not include it,
 * so every artifact written from 2026-08-10 onward was rejected here and the publish gate
 * told operators the bytes "will 404 on the live page" while those bytes served HTTP 200.
 * Diagnosing it took hours precisely because the rejection left no trace.
 *
 * Prefer this over `readArtifactReference` anywhere the distinction can reach a human.
 */
export type ArtifactReferenceRead =
  | { status: 'ok'; reference: ArtifactReference }
  | { status: 'absent' }
  | { status: 'rejected'; issue: string };

export const readArtifactReferenceResult = async (
  indexStore: ArtifactIndexStore,
  requestId: string,
  sha256: string
): Promise<ArtifactReferenceRead> => {
  const existing = await indexStore.get(requestArtifactReferenceKey(requestId, sha256));
  if (!existing) return { status: 'absent' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(existing) as unknown;
  } catch {
    return { status: 'rejected', issue: 'index entry is not valid JSON' };
  }

  const issue = getArtifactReferenceIssue(parsed);
  if (issue) return { status: 'rejected', issue };
  return { status: 'ok', reference: parsed as ArtifactReference };
};

export const readArtifactReference = async (
  indexStore: ArtifactIndexStore,
  requestId: string,
  sha256: string
): Promise<ArtifactReference | undefined> => {
  const result = await readArtifactReferenceResult(indexStore, requestId, sha256);
  if (result.status === 'ok') return result.reference;
  if (result.status === 'rejected') {
    // A stored-but-rejected entry is a contract drift between pdf-tool and platform, not a
    // missing artifact. Never let it pass silently, even through the legacy signature.
    console.warn(
      `[artifact-index] rejected stored ArtifactReference at ${requestArtifactReferenceKey(requestId, sha256)}: ${result.issue}`
    );
  }
  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const resolveArtifactPointer = async (
  indexStore: ArtifactIndexStore,
  pointer: unknown
): Promise<ArtifactReference | undefined> => {
  if (!isRecord(pointer)) return undefined;

  const requestId = typeof pointer.requestId === 'string' ? pointer.requestId : undefined;
  const sha256 = typeof pointer.sha256 === 'string' ? pointer.sha256 : undefined;

  if (!requestId || !sha256) return undefined;

  return readArtifactReference(indexStore, requestId, sha256);
};

export const listArtifactIndexKeys = async (indexStore: ArtifactIndexStore, prefix: string): Promise<string[]> => {
  const result = await indexStore.list({ prefix, directories: false, paginate: true });
  const items = await collectBlobListItems(result as BlobListResponse);
  return items
    .map((item) => item.key)
    .filter((key) => key.endsWith('.json'))
    .sort();
};

const parseIndexJsonBlob = async (indexStore: ArtifactIndexStore, key: string): Promise<unknown> => {
  const text = await indexStore.get(key);
  if (!text) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Resolve every non-deleted ArtifactReference stored under a request in the artifact-index
 * store. Reads BOTH `by-request/<requestId>/` pointers and the full
 * `request-artifacts/<requestId>/` reference objects and merges them by sha256, so an
 * artifact whose pointer write failed (index writes are not atomic) is still returned as
 * long as its reference JSON exists — and vice versa.
 *
 * This is the single source of truth for "which artifacts belong to this request." It backs
 * both the publish-time resolver (mcp.ts `getArtifactReferencesForRequest`) and the
 * pre-publish trust check (save-json-blob.ts `gatherTrustedArtifactRefs`) so the two paths
 * cannot diverge.
 */
export const listArtifactReferencesForRequest = async (
  indexStore: ArtifactIndexStore,
  requestId: string
): Promise<ArtifactReference[]> => {
  const pointerPrefix = `by-request/${encodeURIComponent(requestId)}/`;
  const [pointerKeys, referenceKeys] = await Promise.all([
    listArtifactIndexKeys(indexStore, pointerPrefix),
    listArtifactIndexKeys(indexStore, `request-artifacts/${encodeURIComponent(requestId)}/`),
  ]);

  const artifacts = await Promise.all([
    ...pointerKeys.map(async (key) => resolveArtifactPointer(indexStore, await parseIndexJsonBlob(indexStore, key))),
    ...referenceKeys.map((key) => parseIndexJsonBlob(indexStore, key)),
  ]);

  const referencesBySha256 = new Map<string, ArtifactReference>();
  for (const artifact of artifacts) {
    if (artifact === undefined || !isArtifactReference(artifact)) continue;
    // Not isDeletedArtifactReference: its `value is ArtifactReference` predicate would narrow
    // the surviving branch to `never`.
    if (artifact.deletedAtISO) continue;
    if (!referencesBySha256.has(artifact.sha256)) referencesBySha256.set(artifact.sha256, artifact);
  }

  return [...referencesBySha256.values()];
};

// ── Request owner (W1 T1.1) ────────────────────────────────────────────────
/**
 * An artifact `request_id` used to mean exactly one thing: a `content_item`
 * whose object id IS the request id. `resolveArtifactBridgeScope` encoded that
 * as its only lookup, so every artifact request minted by something that is
 * not an article — a capture page, a visual_standard's example images — failed
 * the ownership wall with `artifact_request_not_found` no matter how legitimate
 * the caller was.
 *
 * This record breaks the identity apart: a request id is a NAME, and this says
 * which governed object answers for it. The content_item path is untouched (an
 * article still owns its request implicitly, with no pointer written) — this is
 * purely additive, consulted only when the content_item lookup misses.
 *
 * ONE record per request id, and it does not move: re-registering the same
 * owner is a no-op, a different one is refused (`artifact_request_owner_conflict`).
 * The pointer is what a media op trusts to decide whose site an artifact may be
 * written into, so silently re-pointing it would be a privilege transfer.
 */
export const ARTIFACT_REQUEST_OWNER_TYPES = [
  'content_item',
  'page',
  'section',
  'site',
  'visual_standard',
  'product',
] as const;

export type ArtifactRequestOwnerType = (typeof ARTIFACT_REQUEST_OWNER_TYPES)[number];

/**
 * Never widen this to `'*'` or "any object type the store knows". The owner
 * type is half of an authorization decision, and an object type nobody has
 * reasoned about is not a type whose `status`/`site` fields can be trusted to
 * mean what this resolver assumes they mean.
 */
export const isArtifactRequestOwnerType = (value: unknown): value is ArtifactRequestOwnerType =>
  typeof value === 'string' && (ARTIFACT_REQUEST_OWNER_TYPES as readonly string[]).includes(value);

export type ArtifactRequestOwner = {
  object_type: ArtifactRequestOwnerType;
  object_id: string;
  site: string;
  registered_at: string;
  registered_by: string;
};

/** `request-owner/<encodeURIComponent(requestId)>.json`, one record per request. */
export const requestOwnerKey = (requestId: string) => `request-owner/${encodeURIComponent(requestId)}.json`;

const isArtifactRequestOwner = (value: unknown): value is ArtifactRequestOwner => {
  if (!isRecord(value)) return false;
  if (!isArtifactRequestOwnerType(value.object_type)) return false;

  return (
    typeof value.object_id === 'string' &&
    value.object_id.length > 0 &&
    typeof value.site === 'string' &&
    value.site.length > 0 &&
    typeof value.registered_at === 'string' &&
    typeof value.registered_by === 'string'
  );
};

/**
 * Reads the owner pointer, or `undefined` when there is none. A stored record
 * that no longer parses (or names a type since removed from the allowlist) is
 * treated as ABSENT rather than thrown: an unreadable pointer must degrade to
 * "this request has no registered owner", never to a hard failure on a media
 * op, and never to a pass.
 */
export const readRequestOwner = async (
  indexStore: ArtifactIndexStore,
  requestId: string
): Promise<ArtifactRequestOwner | undefined> => {
  const existing = await indexStore.get(requestOwnerKey(requestId));
  if (!existing) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(existing) as unknown;
  } catch {
    console.warn(`[artifact-index] request-owner record at ${requestOwnerKey(requestId)} is not valid JSON.`);
    return undefined;
  }

  if (!isArtifactRequestOwner(parsed)) {
    console.warn(`[artifact-index] request-owner record at ${requestOwnerKey(requestId)} is not a valid owner record.`);
    return undefined;
  }

  return parsed;
};

export type WriteRequestOwnerInput = {
  object_type: string;
  object_id: string;
  site: string;
  registered_by: string;
  /** Test seam only; production always stamps "now". */
  registered_at?: string;
};

export type WriteRequestOwnerResult =
  | { ok: true; owner: ArtifactRequestOwner; changed: boolean }
  | {
      ok: false;
      statusCode: 400 | 409;
      errorCode: 'artifact_request_owner_invalid' | 'artifact_request_owner_conflict';
      error: string;
      owner?: ArtifactRequestOwner;
    };

/**
 * Registers (or re-confirms) the object that owns a request id.
 *
 * Idempotent by VALUE: the same `object_type` + `object_id` + `site` returns
 * the stored record with `changed: false` and does not rewrite it, so capture
 * re-runs and retried uploads are free. A different owner is a 409 —
 * `artifact_request_owner_conflict` — and writes nothing.
 */
export const writeRequestOwner = async (
  indexStore: ArtifactIndexStore,
  requestId: string,
  input: WriteRequestOwnerInput
): Promise<WriteRequestOwnerResult> => {
  const trimmedRequestId = requestId.trim();
  if (!trimmedRequestId) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: 'artifact_request_owner_invalid',
      error: 'request_id is required.',
    };
  }
  if (!isArtifactRequestOwnerType(input.object_type)) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: 'artifact_request_owner_invalid',
      error: `object_type must be one of: ${ARTIFACT_REQUEST_OWNER_TYPES.join(', ')}.`,
    };
  }

  const objectId = input.object_id.trim();
  const site = input.site.trim();
  if (!objectId || !site) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: 'artifact_request_owner_invalid',
      error: 'object_id and site are required.',
    };
  }

  const existing = await readRequestOwner(indexStore, trimmedRequestId);
  if (existing) {
    if (existing.object_type === input.object_type && existing.object_id === objectId && existing.site === site) {
      return { ok: true, owner: existing, changed: false };
    }

    return {
      ok: false,
      statusCode: 409,
      errorCode: 'artifact_request_owner_conflict',
      error: `Request ${trimmedRequestId} is already owned by ${existing.object_type} ${existing.object_id} on ${existing.site}; it cannot be re-pointed at ${input.object_type} ${objectId} on ${site}.`,
      owner: existing,
    };
  }

  const owner: ArtifactRequestOwner = {
    object_type: input.object_type,
    object_id: objectId,
    site,
    registered_at: input.registered_at ?? new Date().toISOString(),
    registered_by: input.registered_by,
  };

  await indexStore.setJSON(requestOwnerKey(trimmedRequestId), owner, {
    metadata: {
      requestId: trimmedRequestId,
      objectType: owner.object_type,
      objectId: owner.object_id,
      site: owner.site,
    },
  });

  return { ok: true, owner, changed: true };
};

/**
 * Normalizes the optional `owner: { object_type, object_id }` argument the
 * artifact WRITE tools accept. Deliberately does NOT check that the object
 * exists: capture ingests a page's imagery before the page object is created,
 * and refusing that would recreate the very ordering deadlock this wave
 * exists to remove. Existence, `status: active` and site are checked at
 * media-op time by the bridge scope resolver.
 */
export const normalizeArtifactRequestOwnerInput = (
  value: unknown
):
  | { ok: true; owner?: { object_type: ArtifactRequestOwnerType; object_id: string } }
  | { ok: false; error: string } => {
  if (value === undefined || value === null) return { ok: true };
  if (!isRecord(value)) return { ok: false, error: 'owner must be an object with object_type and object_id.' };

  const objectType = value.object_type;
  if (!isArtifactRequestOwnerType(objectType)) {
    return { ok: false, error: `owner.object_type must be one of: ${ARTIFACT_REQUEST_OWNER_TYPES.join(', ')}.` };
  }

  const objectId = typeof value.object_id === 'string' ? value.object_id.trim() : '';
  if (!objectId) return { ok: false, error: 'owner.object_id is required.' };

  return { ok: true, owner: { object_type: objectType, object_id: objectId } };
};

/**
 * W2 T2.3, key-only callers: resolve the BYTE key for a raw `<kind>/<requestId>/<sha>.<ext>`
 * blobKey by looking the reference up in the index and applying `artifactStorageKey`.
 *
 * For the byte-read sites that never hold an ArtifactReference — a public `/img/*` request,
 * a brand-imagery `readBlobBytes(blobKey)` callback — this is the equivalent of the helper.
 * Fails OPEN: any absent/unreadable/rejected index entry returns the input unchanged, so a
 * reference written before `storageKey` existed (and every non-deduplicated artifact) reads
 * exactly as it always did, and an index outage can never turn a live blob into a 404.
 */
export const resolveArtifactStorageKeyForBlobKey = async (
  indexStore: ArtifactIndexStore,
  blobKey: string
): Promise<string> => {
  const [, requestId = '', filename = '', ...extra] = blobKey.split('/');
  if (extra.length || !requestId || !filename) return blobKey;

  const sha256 = filename.match(/^[a-f0-9]{64}/i)?.[0]?.toLowerCase();
  if (!sha256) return blobKey;

  try {
    const reference = await readArtifactReference(indexStore, requestId, sha256);
    if (!reference || reference.blobKey !== blobKey) return blobKey;
    return artifactStorageKey(reference);
  } catch {
    return blobKey;
  }
};
