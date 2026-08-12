import {
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
