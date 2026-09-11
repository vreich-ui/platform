import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  artifactKindSet,
  artifactReferenceLimits,
  artifactStorageKey,
  createArtifactReference,
  isSafeArtifactFilename,
  isSafeArtifactText,
  type ArtifactKind,
  type ArtifactReference,
} from './artifacts.js';
import { validateFilename, validateRequestId } from '../../lib/agents-naming.js';
import {
  readArtifactByShaIndex,
  readArtifactReference,
  writeArtifactByShaIndex,
  writeArtifactReferenceIndexes,
  writeRequestOwner,
  type ArtifactIndexStore,
  type ArtifactRequestOwnerType,
} from './artifact-index.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import { getArtifactBlobStore, getArtifactIndexBlobStore } from './blob-store.js';
import { sha256Hex } from './crypto.js';
import { ImageValidationError, validatePublishImageBytes } from './image-validation.js';
import type { SiteBinding } from './site-binding.js';

export type ArtifactUploadTokenClaims = {
  requestId: string;
  artifactKind: ArtifactKind;
  contentType: string;
  filename?: string;
  label?: string;
  tags?: string[];
  expectedSizeBytes: number;
  expectedSha256: string;
  expiresAt: number;
};

export type ArtifactUploadIntentInput = Omit<ArtifactUploadTokenClaims, 'expiresAt'> & {
  expiresAt?: number;
  ttlMs?: number;
  nowMs?: number;
  secret?: string;
};

export type ArtifactUploadValidationResult =
  | { ok: true; claims: ArtifactUploadTokenClaims }
  | { ok: false; statusCode: number; error: string };

export type SaveArtifactBytesInput = Omit<ArtifactUploadTokenClaims, 'expiresAt'> & {
  bytes: Buffer | Uint8Array;
  metadata?: Record<string, unknown>;
  event?: unknown;
  binding?: SiteBinding;
  /**
   * W1 T1.3. Optional: the CMS object that owns this request id. Omitting it
   * is today's behaviour exactly — no pointer is written, and a content_item
   * whose id IS the request id still owns its artifacts implicitly.
   *
   * The owner object is NOT required to exist yet. Capture ingests a page's
   * imagery before the page object is created (a materialized artifact
   * reference is the only legal value a page's asset field can hold), so
   * demanding existence here would recreate the ordering deadlock this wave
   * removes. Existence, `status: active` and site are checked at media-op
   * time by `resolveArtifactBridgeScope`.
   */
  owner?: { object_type: ArtifactRequestOwnerType; object_id: string };
  /** Attribution stamped on the owner record; names the tool that registered it. */
  ownerRegisteredBy?: string;
};

export type SaveArtifactBytesResult =
  | {
      ok: true;
      artifact: ArtifactReference;
      deduped: boolean;
      restored?: boolean;
      /**
       * W2 T2.4: set when these exact bytes were ALREADY stored for this tenant under a
       * different request, so this upload wrote a reference (and its own public path)
       * but no second copy of the payload. Names the request that owns the blob.
       */
      dedupedFrom?: string;
    }
  | { ok: false; statusCode: number; error: string };

type BlobStore = Awaited<ReturnType<typeof getArtifactBlobStore>>;
type BinaryReadableBlobStore = Omit<BlobStore, 'get'> & {
  get: (key: string, options: { type: 'arrayBuffer' }) => Promise<ArrayBuffer | Buffer | string | null>;
};

const tokenVersion = 'v1';
export const defaultArtifactUploadTokenTtlMs = 15 * 60 * 1000;
export const defaultDirectArtifactUploadMaxBytes = 5_000_000;
const saneContentTypePattern =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[a-z0-9._-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"]*"))*$/i;

type NetlifyEnv = {
  env?: {
    get?: (key: string) => string | undefined;
  };
};

const getNetlifyEnvValue = (key: string) => {
  const netlify = (globalThis as typeof globalThis & { Netlify?: NetlifyEnv }).Netlify;
  return netlify?.env?.get?.(key);
};

export const getArtifactUploadTokenSecret = () =>
  getNetlifyEnvValue('ARTIFACT_UPLOAD_TOKEN_SECRET') || process.env.ARTIFACT_UPLOAD_TOKEN_SECRET || '';

/**
 * T16.5: the single predicate for "is artifact-upload token signing
 * configured" — both the real call path (createArtifactUploadToken /
 * verifyArtifactUploadToken above, via getArtifactUploadTokenSecret) and
 * capability-status.ts's `artifact_upload` family read this same function.
 */
export const artifactUploadMissingEnvVars = (): string[] =>
  getArtifactUploadTokenSecret() ? [] : ['ARTIFACT_UPLOAD_TOKEN_SECRET'];

export const isArtifactUploadConfigured = (): boolean => artifactUploadMissingEnvVars().length === 0;

export const getDirectArtifactUploadMaxBytes = () => {
  const raw = getNetlifyEnvValue('ARTIFACT_UPLOAD_MAX_BYTES') || process.env.ARTIFACT_UPLOAD_MAX_BYTES;
  if (!raw) return defaultDirectArtifactUploadMaxBytes;

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultDirectArtifactUploadMaxBytes;
};

/** T-dimension-bound: longest-edge ceiling (px) an uploaded raster image is
 * bounded to before saveArtifactBytes, mirroring pdf-tool's import-path
 * quotas.maxImportDimensionPx default. Env-configurable like
 * getDirectArtifactUploadMaxBytes above, so it can be tuned without a
 * deploy. */
export const defaultArtifactUploadMaxImageDimensionPx = 2048;

export const getArtifactUploadMaxImageDimensionPx = () => {
  const raw =
    getNetlifyEnvValue('ARTIFACT_UPLOAD_MAX_IMAGE_DIMENSION_PX') || process.env.ARTIFACT_UPLOAD_MAX_IMAGE_DIMENSION_PX;
  if (!raw) return defaultArtifactUploadMaxImageDimensionPx;

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultArtifactUploadMaxImageDimensionPx;
};

const base64UrlEncode = (value: string) => Buffer.from(value).toString('base64url');

const base64UrlJson = (value: unknown) => base64UrlEncode(JSON.stringify(value));

const signPayload = (encodedPayload: string, secret: string) =>
  createHmac('sha256', secret).update(`${tokenVersion}.${encodedPayload}`).digest('base64url');

const signaturesMatch = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const normalizeArtifactContentType = (contentType: string) =>
  contentType.toLowerCase().split(';')[0]?.trim() ?? '';

const isValidContentType = (contentType: string) => {
  const normalized = normalizeArtifactContentType(contentType);
  return normalized.length > 0 && normalized.length <= 120 && saneContentTypePattern.test(normalized);
};

const isValidSha256 = (value: string) => /^[a-f0-9]{64}$/i.test(value);

const validateTags = (tags: unknown): string[] | undefined => {
  if (tags === undefined) return undefined;
  if (!Array.isArray(tags) || tags.length > artifactReferenceLimits.tags) return undefined;

  const normalizedTags: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') return undefined;
    const normalized = tag.trim();
    if (!normalized || !isSafeArtifactText(normalized, artifactReferenceLimits.tag)) return undefined;
    normalizedTags.push(normalized);
  }

  return normalizedTags;
};

const validateTokenClaims = (value: unknown): ArtifactUploadTokenClaims | undefined => {
  if (!isRecord(value)) return undefined;

  const allowedKeys = new Set([
    'requestId',
    'artifactKind',
    'contentType',
    'filename',
    'label',
    'tags',
    'expectedSizeBytes',
    'expectedSha256',
    'expiresAt',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return undefined;

  const { requestId, artifactKind, contentType, filename, label, expectedSizeBytes, expectedSha256, expiresAt } = value;
  const tags = validateTags(value.tags);

  if (typeof requestId !== 'string' || !validateRequestId(requestId).ok) return undefined;
  if (typeof artifactKind !== 'string' || !artifactKindSet.has(artifactKind as ArtifactKind)) return undefined;
  if (typeof contentType !== 'string' || !isValidContentType(contentType)) return undefined;
  const filenameValidation = typeof filename === 'string' ? validateFilename(filename) : undefined;
  if (
    filename !== undefined &&
    (typeof filename !== 'string' || !isSafeArtifactFilename(filename) || !filenameValidation?.ok)
  )
    return undefined;
  if (label !== undefined && (typeof label !== 'string' || !isSafeArtifactText(label, artifactReferenceLimits.label))) {
    return undefined;
  }
  if (value.tags !== undefined && !tags) return undefined;
  if (typeof expectedSizeBytes !== 'number' || !Number.isInteger(expectedSizeBytes) || expectedSizeBytes < 0) {
    return undefined;
  }
  if (typeof expectedSha256 !== 'string' || !isValidSha256(expectedSha256)) return undefined;
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt <= 0) return undefined;

  const normalizedFilename = filenameValidation?.ok ? filenameValidation.value : undefined;
  const normalizedLabel = typeof label === 'string' ? label.trim() : undefined;

  return {
    requestId,
    artifactKind: artifactKind as ArtifactKind,
    contentType: normalizeArtifactContentType(contentType),
    ...(normalizedFilename ? { filename: normalizedFilename } : {}),
    ...(normalizedLabel ? { label: normalizedLabel } : {}),
    ...(tags ? { tags } : {}),
    expectedSizeBytes,
    expectedSha256: expectedSha256.toLowerCase(),
    expiresAt,
  };
};

const parseTokenPayload = (encodedPayload: string): ArtifactUploadTokenClaims | undefined => {
  try {
    return validateTokenClaims(JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as unknown);
  } catch {
    return undefined;
  }
};

const createClaimsFromIntent = (input: ArtifactUploadIntentInput): ArtifactUploadTokenClaims => {
  const { nowMs, secret, ttlMs, expiresAt: requestedExpiresAt, ...claimInput } = input;
  void secret;
  const expiresAt = requestedExpiresAt ?? (nowMs ?? Date.now()) + (ttlMs ?? defaultArtifactUploadTokenTtlMs);
  const claims = validateTokenClaims({
    ...claimInput,
    expectedSha256: claimInput.expectedSha256.toLowerCase(),
    expiresAt,
  });
  if (!claims) throw new Error('Invalid artifact upload token claims.');

  return claims;
};

export const createArtifactUploadToken = (
  input: ArtifactUploadIntentInput,
  secret = input.secret ?? getArtifactUploadTokenSecret()
) => {
  if (!secret) throw new Error('Artifact upload token signing is not configured.');

  const claims = createClaimsFromIntent(input);
  const encodedPayload = base64UrlJson(claims);
  const signature = signPayload(encodedPayload, secret);
  return `${tokenVersion}.${encodedPayload}.${signature}`;
};

export const verifyArtifactUploadToken = ({
  token,
  nowMs = Date.now(),
  secret = getArtifactUploadTokenSecret(),
}: {
  token: string;
  nowMs?: number;
  secret?: string;
}): ArtifactUploadValidationResult => {
  if (!secret) {
    return { ok: false, statusCode: 500, error: 'Artifact upload token validation is not configured.' };
  }

  const [version, encodedPayload, signature, extra] = token.split('.');
  if (version !== tokenVersion || !encodedPayload || !signature || extra !== undefined) {
    return { ok: false, statusCode: 401, error: 'Invalid artifact upload token.' };
  }

  const expectedSignature = signPayload(encodedPayload, secret);
  if (!signaturesMatch(signature, expectedSignature)) {
    return { ok: false, statusCode: 401, error: 'Invalid artifact upload token.' };
  }

  const claims = parseTokenPayload(encodedPayload);
  if (!claims) return { ok: false, statusCode: 401, error: 'Invalid artifact upload token.' };
  if (claims.expiresAt <= nowMs) return { ok: false, statusCode: 401, error: 'Artifact upload token has expired.' };

  return { ok: true, claims };
};

const toBuffer = (bytes: Buffer | Uint8Array) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));

const toBufferOrNull = (value: ArrayBuffer | Buffer | string | null) => {
  if (value === null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value);
};

const getArrayBuffer = async (store: BlobStore, key: string) => {
  const binaryStore = store as BinaryReadableBlobStore;
  return toBufferOrNull(await binaryStore.get(key, { type: 'arrayBuffer' }));
};

/** Exported so artifact-upload.ts's endpoint can re-run this exact check on
 * the ORIGINALLY UPLOADED bytes before the dimension bound (which stores a
 * different buffer than the one the client's signed token/headers describe)
 * — otherwise saveArtifactBytes below would only ever validate the bounded
 * bytes against themselves, silently dropping the original integrity check
 * that catches a caller lying about size/sha256 in its upload token. */
export const validateBytesAgainstIntent = (
  input: SaveArtifactBytesInput,
  bytes: Buffer
): SaveArtifactBytesResult | undefined => {
  const normalizedContentType = normalizeArtifactContentType(input.contentType);
  if (!isValidContentType(normalizedContentType)) {
    return { ok: false, statusCode: 400, error: 'contentType must be a non-empty valid MIME type.' };
  }

  if (bytes.byteLength !== input.expectedSizeBytes) {
    return {
      ok: false,
      statusCode: 400,
      error: `Artifact size mismatch: expected ${input.expectedSizeBytes} bytes, received ${bytes.byteLength} bytes.`,
    };
  }

  const actualSha256 = sha256Hex(bytes);
  if (actualSha256 !== input.expectedSha256.toLowerCase()) {
    return {
      ok: false,
      statusCode: 400,
      error: `Artifact sha256 mismatch: expected ${input.expectedSha256}, received ${actualSha256}.`,
    };
  }

  return undefined;
};

const validateArtifactBytes = async (
  input: SaveArtifactBytesInput,
  bytes: Buffer
): Promise<SaveArtifactBytesResult | undefined> => {
  const normalizedContentType = normalizeArtifactContentType(input.contentType);

  if (input.artifactKind === 'image' || normalizedContentType.startsWith('image/')) {
    try {
      await validatePublishImageBytes({
        bytes,
        contentType: normalizedContentType,
        filename: input.filename,
        path: input.filename ?? 'artifact',
      });
    } catch (error) {
      if (error instanceof ImageValidationError) return { ok: false, statusCode: 400, error: error.message };
      throw error;
    }
  }

  if (input.artifactKind === 'pdf' || normalizedContentType === 'application/pdf') {
    if (bytes.subarray(0, 5).toString('utf8') !== '%PDF-') {
      return { ok: false, statusCode: 400, error: 'Invalid PDF artifact: bytes must start with %PDF-.' };
    }
  }

  return undefined;
};

const existingBytesMatch = async (store: BlobStore, reference: ArtifactReference) => {
  // W2 T2.3: a deduplicated reference's bytes live under another request's blob.
  const existingBytes = await getArrayBuffer(store, artifactStorageKey(reference));
  if (!existingBytes) return false;

  return existingBytes.byteLength === reference.sizeBytes && sha256Hex(existingBytes) === reference.sha256;
};

/**
 * Writes the request-owner pointer for a successfully stored artifact.
 *
 * Deliberately NON-FATAL. The bytes are already stored and indexed by the
 * time this runs, so turning an owner conflict into a failed upload would
 * report a saved artifact as lost. A conflict means the request already
 * belongs to someone else — the conservative outcome is to keep the FIRST
 * owner and say so in the log, never to re-point the request.
 */
const recordArtifactRequestOwner = async (indexStore: ArtifactIndexStore, input: SaveArtifactBytesInput) => {
  if (!input.owner) return;

  const result = await writeRequestOwner(indexStore, input.requestId, {
    object_type: input.owner.object_type,
    object_id: input.owner.object_id,
    site: getSiteIdentity().siteId,
    registered_by: input.ownerRegisteredBy ?? 'save_artifact_bytes',
  });

  if (!result.ok) {
    console.warn(`[artifact-upload] request owner not registered for ${input.requestId}: ${result.error}`);
  }
};

/** First-write-wins by-sha entry for a reference whose bytes live at its OWN blobKey. */
const recordArtifactShaIndex = async (
  indexStore: ArtifactIndexStore,
  input: SaveArtifactBytesInput,
  reference: ArtifactReference
) => {
  try {
    await writeArtifactByShaIndex(indexStore, input.artifactKind, reference.sha256, {
      storageKey: reference.blobKey,
      contentType: reference.contentType,
      sizeBytes: reference.sizeBytes,
      firstRequestId: input.requestId,
      createdAtISO: reference.createdAtISO,
    });
  } catch (error) {
    // Best effort: a missing by-sha entry only costs a future duplicate blob. It must
    // never fail an upload whose bytes and reference are already written correctly.
    console.warn('[artifact-upload] by-sha index write failed.', { sha256: reference.sha256, error });
  }
};

export const saveArtifactBytes = async (input: SaveArtifactBytesInput): Promise<SaveArtifactBytesResult> => {
  const bytes = toBuffer(input.bytes);
  const intentError = validateBytesAgainstIntent(input, bytes);
  if (intentError) return intentError;

  const artifactValidationError = await validateArtifactBytes(input, bytes);
  if (artifactValidationError) return artifactValidationError;

  const reference = createArtifactReference({
    input: {
      requestId: input.requestId,
      artifactKind: input.artifactKind,
      contentType: normalizeArtifactContentType(input.contentType),
      filename: input.filename,
      label: input.label,
      tags: input.tags,
      metadata: input.metadata,
    },
    bytes,
  });

  const artifactStore = await getArtifactBlobStore(input.event, input.binding);
  const indexStore = (await getArtifactIndexBlobStore(input.event, input.binding)) as unknown as ArtifactIndexStore;
  const existingReference = await readArtifactReference(indexStore, input.requestId, reference.sha256);

  if (existingReference) {
    if (existingReference.blobKey !== reference.blobKey || existingReference.contentType !== reference.contentType) {
      return {
        ok: false,
        statusCode: 409,
        error: 'Artifact with the same requestId and sha256 already exists with different metadata.',
      };
    }

    if (!(await existingBytesMatch(artifactStore, existingReference))) {
      return {
        ok: false,
        statusCode: 409,
        error: 'Artifact index exists but stored bytes do not match the expected digest.',
      };
    }

    // Re-uploading the exact bytes restores a soft-deleted reference: a successful upload must
    // return an artifact that list_artifacts_for_request and the trust/publish paths accept,
    // and a reference carrying deletedAtISO is excluded from all of them.
    const restored = Boolean(existingReference.deletedAtISO || existingReference.deletedBy);
    const { deletedAtISO: _deletedAtISO, deletedBy: _deletedBy, ...restoredReference } = existingReference;

    await writeArtifactReferenceIndexes(indexStore, input.requestId, restoredReference);
    await recordArtifactRequestOwner(indexStore, input);
    return { ok: true, artifact: restoredReference, deduped: true, ...(restored ? { restored } : {}) };
  }

  // ── W2 T2.4: cross-request content dedupe. ───────────────────────────────────
  // The same-request checks above are untouched (including both 409s): they answer
  // "did THIS request already upload this sha", and their answer is the reference.
  // This answers a different question — "does this TENANT already store these exact
  // bytes, under any request" — and its answer is a byte-storage redirect.
  //
  // The request still gets its own reference and therefore its own request-scoped
  // blobKey and its own /img/<requestId>/<sha>.<ext> public path. Nothing existing
  // is rewritten; only the second copy of the payload is skipped.
  const shaHit = await readArtifactByShaIndex(indexStore, input.artifactKind, reference.sha256);
  if (shaHit && shaHit.storageKey !== reference.blobKey) {
    const hitBytes = await getArrayBuffer(artifactStore, shaHit.storageKey);

    // VERIFY, never trust the index: a by-sha entry pointing at bytes that are gone or
    // wrong must not be allowed to produce a reference that 404s. On any mismatch this
    // falls through to the ordinary write path, which stores the payload under this
    // request's own key — the safe outcome, at the cost of one duplicate blob.
    if (hitBytes && hitBytes.byteLength === reference.sizeBytes && sha256Hex(hitBytes) === reference.sha256) {
      const dedupedReference: ArtifactReference = { ...reference, storageKey: shaHit.storageKey };

      await writeArtifactReferenceIndexes(indexStore, input.requestId, dedupedReference);
      // The request is new even though the bytes are not, so its owner pointer is
      // still owed — a deduped artifact must resolve through the ownership wall
      // exactly like a freshly stored one.
      await recordArtifactRequestOwner(indexStore, input);
      return {
        ok: true,
        artifact: dedupedReference,
        deduped: true,
        dedupedFrom: shaHit.firstRequestId,
      };
    }

    console.warn('[artifact-upload] by-sha index hit did not verify; storing bytes under this request.', {
      sha256: reference.sha256,
      storageKey: shaHit.storageKey,
      firstRequestId: shaHit.firstRequestId,
    });
  }

  const existingBytes = await getArrayBuffer(artifactStore, artifactStorageKey(reference));
  if (existingBytes) {
    if (existingBytes.byteLength !== reference.sizeBytes || sha256Hex(existingBytes) !== reference.sha256) {
      return { ok: false, statusCode: 409, error: 'Artifact blob already exists with different bytes.' };
    }

    await recordArtifactShaIndex(indexStore, input, reference);
    await writeArtifactReferenceIndexes(indexStore, input.requestId, reference);
    await recordArtifactRequestOwner(indexStore, input);
    return { ok: true, artifact: reference, deduped: true };
  }

  await artifactStore.set(reference.blobKey, bytes, {
    onlyIfNew: true,
    metadata: {
      contentType: reference.contentType,
      sha256: reference.sha256,
      sizeBytes: String(reference.sizeBytes),
      createdAtISO: reference.createdAtISO,
      requestId: input.requestId,
      artifactKind: input.artifactKind,
    },
  });

  const storedBytes = await getArrayBuffer(artifactStore, artifactStorageKey(reference));
  if (!storedBytes || storedBytes.byteLength !== reference.sizeBytes || sha256Hex(storedBytes) !== reference.sha256) {
    return { ok: false, statusCode: 500, error: 'Artifact blob write failed integrity verification.' };
  }

  // T2.1: the by-sha entry is written on the FIRST byte write for this sha and never
  // rewritten, so `firstRequestId` stays the request whose blob everyone else redirects to.
  await recordArtifactShaIndex(indexStore, input, reference);
  await writeArtifactReferenceIndexes(indexStore, input.requestId, reference);
  await recordArtifactRequestOwner(indexStore, input);
  return { ok: true, artifact: reference, deduped: false };
};
