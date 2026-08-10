import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  artifactKindSet,
  artifactReferenceLimits,
  createArtifactReference,
  isSafeArtifactFilename,
  isSafeArtifactText,
  type ArtifactKind,
  type ArtifactReference,
} from './artifacts.js';
import { validateFilename, validateRequestId } from '../../lib/agents-naming.js';
import { readArtifactReference, writeArtifactReferenceIndexes, type ArtifactIndexStore } from './artifact-index.js';
import { getArtifactBlobStore, getArtifactIndexBlobStore } from './blob-store.js';
import { sha256Hex } from './crypto.js';
import { ImageValidationError, validatePublishImageBytes } from './image-validation.js';

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
};

export type SaveArtifactBytesResult =
  | { ok: true; artifact: ArtifactReference; deduped: boolean; restored?: boolean }
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

const validateBytesAgainstIntent = (
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
  const existingBytes = await getArrayBuffer(store, reference.blobKey);
  if (!existingBytes) return false;

  return existingBytes.byteLength === reference.sizeBytes && sha256Hex(existingBytes) === reference.sha256;
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

  const artifactStore = await getArtifactBlobStore(input.event);
  const indexStore = (await getArtifactIndexBlobStore(input.event)) as unknown as ArtifactIndexStore;
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
    return { ok: true, artifact: restoredReference, deduped: true, ...(restored ? { restored } : {}) };
  }

  const existingBytes = await getArrayBuffer(artifactStore, reference.blobKey);
  if (existingBytes) {
    if (existingBytes.byteLength !== reference.sizeBytes || sha256Hex(existingBytes) !== reference.sha256) {
      return { ok: false, statusCode: 409, error: 'Artifact blob already exists with different bytes.' };
    }

    await writeArtifactReferenceIndexes(indexStore, input.requestId, reference);
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

  const storedBytes = await getArrayBuffer(artifactStore, reference.blobKey);
  if (!storedBytes || storedBytes.byteLength !== reference.sizeBytes || sha256Hex(storedBytes) !== reference.sha256) {
    return { ok: false, statusCode: 500, error: 'Artifact blob write failed integrity verification.' };
  }

  await writeArtifactReferenceIndexes(indexStore, input.requestId, reference);
  return { ok: true, artifact: reference, deduped: false };
};
