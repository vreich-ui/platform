/**
 * Function name: Save_Artifact
 * Required method: POST
 * Required header: x-publish-key
 * Stores:
 * - artifacts: final binary artifact bytes
 * - artifact-index: JSON request artifact reference indexes
 */
import { readBoundEnv, type SiteBinding } from '../lib/site-binding.js';
import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import {
  ArtifactKind,
  artifactReferenceLimits,
  artifactKindValues,
  artifactStorageKey,
  createArtifactReference,
  isSafeArtifactFilename,
  isSafeArtifactText,
  type ArtifactReference,
  type ArtifactUploadInput,
} from '../lib/artifacts.js';
import {
  readArtifactByShaIndex,
  readArtifactReference,
  writeArtifactByShaIndex,
  writeArtifactReferenceIndexes,
  type ArtifactIndexStore,
} from '../lib/artifact-index.js';
import { getHeader } from '../lib/admin-auth.js';
import { getArtifactBlobStore, getArtifactIndexBlobStore } from '../lib/blob-store.js';
import { sha256Hex } from '../lib/crypto.js';
import { ImageValidationError, validatePublishImageBytes } from '../lib/image-validation.js';

// artifactStore holds binary blobs (final artifacts and obsolete temporary chunks); indexStore holds JSON references and indexes.

type LambdaEvent = {
  blobs?: string;
  body?: string | null;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
  log?: (payload: { event: string; rpcMethod?: string | null; slug?: string | null; [key: string]: unknown }) => void;
  requestId?: string;
  rpcMethod?: string | null;
  slug?: string | null;
};

type UploadRequest = ArtifactUploadInput & {
  expectedSizeBytes?: number;
  expectedSha256?: string;
  localSizeBytes?: number;
  localSha256?: string;
};

type BlobStore = Awaited<ReturnType<typeof getArtifactBlobStore>>;
type BinaryReadableBlobStore = Omit<BlobStore, 'get'> & {
  get: (key: string, options: { type: 'arrayBuffer' }) => Promise<ArrayBuffer | null>;
};

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const safeArtifactFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(artifactReferenceLimits.originalFilename)
  .refine((value) => isSafeArtifactFilename(value), {
    message: 'filename must not contain control characters, angle brackets, or path separators.',
  });

const safeArtifactLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(artifactReferenceLimits.label)
  .refine((value) => isSafeArtifactText(value, artifactReferenceLimits.label), {
    message: 'label must not contain control characters or angle brackets.',
  });

const safeArtifactTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(artifactReferenceLimits.tag)
  .refine((value) => isSafeArtifactText(value, artifactReferenceLimits.tag), {
    message: 'tags must not contain control characters or angle brackets.',
  });

const uploadSchema = z
  .object({
    requestId: z.string().min(1),
    artifactKind: z.enum(artifactKindValues),
    contentType: z.string().min(1),
    filename: safeArtifactFilenameSchema.optional(),
    encoding: z.enum(['base64', 'binary']).optional(),
    expectedSizeBytes: z.number().int().nonnegative().optional(),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    localSizeBytes: z.number().int().nonnegative().optional(),
    localSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    payload: z.string(),
    label: safeArtifactLabelSchema.optional(),
    tags: z.array(safeArtifactTagSchema).max(artifactReferenceLimits.tags).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.expectedSizeBytes !== undefined &&
      value.localSizeBytes !== undefined &&
      value.expectedSizeBytes !== value.localSizeBytes
    ) {
      context.addIssue({
        code: 'custom',
        path: ['localSizeBytes'],
        message: 'localSizeBytes must match expectedSizeBytes when both are supplied.',
      });
    }

    if (
      value.expectedSha256 !== undefined &&
      value.localSha256 !== undefined &&
      value.expectedSha256.toLowerCase() !== value.localSha256.toLowerCase()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['localSha256'],
        message: 'localSha256 must match expectedSha256 when both are supplied.',
      });
    }
  });

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: jsonHeaders,
  body: JSON.stringify(body),
});

const parseBody = (event: LambdaEvent): unknown => {
  if (!event.body) return undefined;

  const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  return JSON.parse(body) as unknown;
};

const secretsMatch = (provided: string, expected: string) => {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
};

const verifyPublishKey = (event: LambdaEvent, binding: SiteBinding) => {
  const provided = getHeader(event.headers, 'x-publish-key');
  const expected = readBoundEnv(binding.env.publishSecret) ?? '';

  if (!provided || !expected || !secretsMatch(provided, expected)) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  return undefined;
};

const decodePayload = (input: Pick<UploadRequest, 'encoding' | 'payload'>) => {
  if (input.encoding === 'binary') return Buffer.from(input.payload, 'binary');

  return Buffer.from(input.payload, 'base64');
};

const getTruncatedSha256 = (sha256: string | undefined) => sha256?.slice(0, 8);

const getExpectedSizeBytes = (input: UploadRequest) => input.expectedSizeBytes ?? input.localSizeBytes;

const getExpectedSha256 = (input: UploadRequest) => input.expectedSha256 ?? input.localSha256;

const logArtifactUpload = (
  event: LambdaEvent,
  input: UploadRequest,
  logEvent: string,
  details: Record<string, unknown> = {}
) => {
  const payload = typeof input.payload === 'string' ? input.payload : undefined;

  event.log?.({
    event: logEvent,
    requestId: event.requestId ?? input.requestId,
    rpcMethod: event.rpcMethod ?? null,
    slug: event.slug ?? null,
    uploadId: null,
    encoding: input.encoding ?? 'base64',
    payloadChars: payload?.length ?? null,
    payloadUtf8Bytes: payload === undefined ? null : Buffer.byteLength(payload, 'utf8'),
    decodedBytes: null,
    expectedSizeBytes: getExpectedSizeBytes(input) ?? null,
    expectedSha256: getTruncatedSha256(getExpectedSha256(input)) ?? null,
    ...details,
  });
};

const validateArtifactIntegrity = (event: LambdaEvent, input: UploadRequest, bytes: Buffer, uploadId?: string) => {
  const sizeBytes = bytes.byteLength;
  const sha256 = sha256Hex(bytes);
  const expectedSizeBytes = getExpectedSizeBytes(input);
  const expectedSha256 = getExpectedSha256(input);

  if (expectedSizeBytes !== undefined && expectedSizeBytes !== sizeBytes) {
    logArtifactUpload(event, input, 'artifact_upload_size_mismatch', {
      uploadId: uploadId ?? null,
      decodedBytes: bytes.length,
      receivedSizeBytes: sizeBytes,
    });

    return jsonResponse(400, {
      error: `Artifact size mismatch: expected ${expectedSizeBytes} bytes, received ${sizeBytes} bytes.`,
    });
  }

  if (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== sha256) {
    return jsonResponse(400, {
      error: `Artifact sha256 mismatch: expected ${expectedSha256}, received ${sha256}.`,
    });
  }

  return undefined;
};

const normalizeUploadContentType = (contentType: string) => contentType.toLowerCase().split(';')[0]?.trim() ?? '';

const validateImageArtifact = async (input: UploadRequest, bytes: Buffer) => {
  // Match the direct-upload path (artifact-upload.ts validateArtifactBytes): image bytes are
  // validated whenever EITHER the declared kind or the content type says image. Keying off the
  // kind alone let image/* payloads uploaded under e.g. kind "attachment" skip sharp validation.
  if (
    input.artifactKind !== ArtifactKind.Image &&
    !normalizeUploadContentType(input.contentType).startsWith('image/')
  ) {
    return undefined;
  }

  try {
    await validatePublishImageBytes({
      bytes,
      contentType: input.contentType,
      filename: input.filename,
      path: input.filename ?? 'artifact',
    });
  } catch (error) {
    if (error instanceof ImageValidationError) {
      return jsonResponse(400, { error: error.message });
    }

    throw error;
  }

  return undefined;
};

const validatePdfArtifact = (input: UploadRequest, bytes: Buffer) => {
  if (input.artifactKind !== ArtifactKind.Pdf && normalizeUploadContentType(input.contentType) !== 'application/pdf') {
    return undefined;
  }

  if (bytes.subarray(0, 5).toString('utf8') !== '%PDF-') {
    return jsonResponse(400, { error: 'Invalid PDF artifact: bytes must start with %PDF-.' });
  }

  return undefined;
};

const validateFinalArtifact = async (event: LambdaEvent, input: UploadRequest, bytes: Buffer, uploadId?: string) => {
  const integrityError = validateArtifactIntegrity(event, input, bytes, uploadId);

  if (integrityError) return integrityError;

  const imageError = await validateImageArtifact(input, bytes);
  if (imageError) return imageError;

  return validatePdfArtifact(input, bytes);
};

const getArrayBuffer = async (store: BlobStore, key: string) => {
  const binaryStore = store as BinaryReadableBlobStore;
  const value = await binaryStore.get(key, { type: 'arrayBuffer' });

  return value ? Buffer.from(value) : null;
};

const waitForStoredBytesRetry = (attemptIndex: number) => {
  const baseDelayMs = 25 * 2 ** attemptIndex;
  const jitterMs = Math.floor(Math.random() * 10);

  return new Promise((resolve) => setTimeout(resolve, baseDelayMs + jitterMs));
};

const readStoredBytes = async (store: BlobStore, key: string, options: { retry?: boolean } = {}) => {
  const maxAttempts = options.retry === false ? 1 : 5;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    const storedBytes = await getArrayBuffer(store, key);

    if (storedBytes) return storedBytes;
    if (attemptIndex < maxAttempts - 1) await waitForStoredBytesRetry(attemptIndex);
  }

  return null;
};

const validateStoredBytes = async (store: BlobStore, reference: ArtifactReference) => {
  // W2 T2.3: bytes may live under another request's blob (storageKey). The clean-up
  // `del` below is therefore gated on us OWNING the blob — never delete a shared one.
  const storageKey = artifactStorageKey(reference);
  const ownsBytes = storageKey === reference.blobKey;
  const storedBytes = await readStoredBytes(store, storageKey);

  if (!storedBytes) {
    if (ownsBytes) await store.del(storageKey);

    return jsonResponse(500, { error: 'Artifact blob write failed: stored bytes could not be read back.' });
  }

  const storedSizeBytes = storedBytes.byteLength;
  const storedSha256 = sha256Hex(storedBytes);

  if (storedSizeBytes !== reference.sizeBytes || storedSha256 !== reference.sha256) {
    if (ownsBytes) await store.del(storageKey);

    return jsonResponse(500, {
      error: `Artifact blob write failed integrity verification: expected ${reference.sizeBytes} bytes/${reference.sha256}, stored ${storedSizeBytes} bytes/${storedSha256}.`,
    });
  }

  return undefined;
};

/**
 * W2 T2.4 parity for the direct-upload endpoint.
 *
 * `saveArtifactBytes` in artifact-upload.ts is not the only byte writer — this
 * function is the second one, and until now it wrote a fresh blob for bytes
 * that already existed under another request AND never registered a by-sha
 * entry, so its blobs could never become a dedupe target either. Both halves
 * are fixed here, with the same rule as the other path: VERIFY the candidate
 * bytes before reusing them, and on any mismatch fall through to an ordinary
 * write rather than mint a reference that would 404.
 *
 * Returns `storageKey` when the bytes were reused from another request; the
 * caller must stamp it onto the reference it writes to the index.
 */
const dedupeFinalArtifactBySha = async (
  store: BlobStore,
  indexStore: ArtifactIndexStore,
  artifactKind: ArtifactKind,
  reference: ArtifactReference
): Promise<{ storageKey: string; dedupedFrom: string } | undefined> => {
  const hit = await readArtifactByShaIndex(indexStore, artifactKind, reference.sha256);
  if (!hit || hit.storageKey === reference.blobKey) return undefined;

  const hitBytes = await readStoredBytes(store, hit.storageKey, { retry: false });

  if (hitBytes && hitBytes.byteLength === reference.sizeBytes && sha256Hex(hitBytes) === reference.sha256) {
    return { storageKey: hit.storageKey, dedupedFrom: hit.firstRequestId };
  }

  console.warn('[save-artifact] by-sha index hit did not verify; storing bytes under this request.', {
    sha256: reference.sha256,
    storageKey: hit.storageKey,
    firstRequestId: hit.firstRequestId,
  });

  return undefined;
};

/** First-write-wins by-sha entry for bytes that live at this reference's OWN blobKey. */
const recordFinalArtifactShaIndex = async (
  indexStore: ArtifactIndexStore,
  artifactKind: ArtifactKind,
  requestId: string,
  reference: ArtifactReference
) => {
  try {
    await writeArtifactByShaIndex(indexStore, artifactKind, reference.sha256, {
      storageKey: reference.blobKey,
      contentType: reference.contentType,
      sizeBytes: reference.sizeBytes,
      firstRequestId: requestId,
      createdAtISO: reference.createdAtISO,
    });
  } catch (error) {
    // Best effort: a missing by-sha entry only costs a future duplicate blob. It must
    // never fail an upload whose bytes and reference are already written correctly.
    console.warn('[save-artifact] by-sha index write failed.', { sha256: reference.sha256, error });
  }
};

const saveFinalArtifact = async (
  store: BlobStore,
  indexStore: ArtifactIndexStore,
  artifactKind: ArtifactKind,
  requestId: string,
  reference: ArtifactReference,
  bytes: Buffer
): Promise<{
  deduped: boolean;
  integrityError?: ReturnType<typeof jsonResponse>;
  storageKey?: string;
  dedupedFrom?: string;
}> => {
  if (await readStoredBytes(store, artifactStorageKey(reference), { retry: false })) {
    const existingIntegrityError = await validateStoredBytes(store, reference);

    if (existingIntegrityError) return { deduped: true, integrityError: existingIntegrityError };

    return { deduped: true };
  }

  const shaHit = await dedupeFinalArtifactBySha(store, indexStore, artifactKind, reference);

  if (shaHit) {
    const dedupedReference: ArtifactReference = { ...reference, storageKey: shaHit.storageKey };
    const integrityError = await validateStoredBytes(store, dedupedReference);

    if (integrityError) return { deduped: true, integrityError };

    return { deduped: true, storageKey: shaHit.storageKey, dedupedFrom: shaHit.dedupedFrom };
  }

  await store.set(reference.blobKey, bytes, {
    onlyIfNew: true,
    metadata: {
      contentType: reference.contentType,
      sha256: reference.sha256,
      sizeBytes: String(reference.sizeBytes),
      createdAtISO: reference.createdAtISO,
      // Mirrors the pdf-tool-side artifact metadata so directly-uploaded
      // artifacts get the same human Content-Disposition filename behavior
      // as pdf-tool-generated ones in get-public-pdf.ts.
      ...(reference.originalFilename ? { originalFilename: reference.originalFilename } : {}),
      ...(reference.label ? { label: reference.label } : {}),
    },
  });

  const integrityError = await validateStoredBytes(store, reference);

  if (!integrityError) await recordFinalArtifactShaIndex(indexStore, artifactKind, requestId, reference);

  return { deduped: false, integrityError };
};

const mergeArtifactReferenceDisplayFields = (
  existingReference: ArtifactReference,
  newReference: ArtifactReference
) => ({
  ...existingReference,
  originalFilename: existingReference.originalFilename ?? newReference.originalFilename,
  label: existingReference.label ?? newReference.label,
  tags: existingReference.tags ?? newReference.tags,
});

/**
 * A re-upload of the exact bytes restores a soft-deleted reference. Returning the deleted
 * reference as a successful upload would leave the artifact invisible to
 * list_artifacts_for_request and untrusted by patch/publish — a success response must mean
 * the artifact is usable.
 */
const stripSoftDeleteMarkers = (reference: ArtifactReference): { reference: ArtifactReference; restored: boolean } => {
  if (!reference.deletedAtISO && !reference.deletedBy) return { reference, restored: false };

  const { deletedAtISO: _deletedAtISO, deletedBy: _deletedBy, ...restored } = reference;
  return { reference: restored, restored: true };
};

export const finalizeUpload = async (
  event: LambdaEvent,
  input: UploadRequest,
  finalBytes: Buffer,
  binding: SiteBinding
) => {
  const reference = createArtifactReference({ input, bytes: finalBytes });
  logArtifactUpload(event, input, 'artifact_upload_finalize_started', {
    uploadId: reference.blobKey,
    decodedBytes: finalBytes.length,
  });

  const validationError = await validateFinalArtifact(event, input, finalBytes, reference.blobKey);

  if (validationError) return validationError;

  const artifactStore = await getArtifactBlobStore(event, binding);
  const indexStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ArtifactIndexStore;
  const { deduped, integrityError, storageKey, dedupedFrom } = await saveFinalArtifact(
    artifactStore,
    indexStore,
    input.artifactKind,
    input.requestId,
    reference,
    finalBytes
  );

  if (integrityError) return integrityError;

  // Cross-request dedupe: the bytes live under another request's blob, so the
  // reference we persist has to carry the redirect. blobKey is IDENTITY and is
  // never rewritten — this request keeps its own public path.
  const existingReference = deduped
    ? await readArtifactReference(indexStore, input.requestId, reference.sha256)
    : undefined;
  const merged =
    existingReference?.blobKey === reference.blobKey
      ? mergeArtifactReferenceDisplayFields(existingReference, reference)
      : reference;
  const mergedReference: ArtifactReference = storageKey ? { ...merged, storageKey } : merged;
  const { reference: responseReference, restored } = stripSoftDeleteMarkers(mergedReference);

  await writeArtifactReferenceIndexes(indexStore, input.requestId, responseReference);

  logArtifactUpload(event, input, 'artifact_upload_finalize_completed', {
    uploadId: responseReference.blobKey,
    decodedBytes: finalBytes.length,
    ...(restored ? { restoredSoftDeletedReference: true } : {}),
  });

  return jsonResponse(deduped ? 200 : 201, {
    ok: true,
    complete: true,
    deduped,
    ...(dedupedFrom ? { dedupedFrom } : {}),
    ...(restored ? { restored } : {}),
    artifact: responseReference,
  });
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const unauthorized = verifyPublishKey(event, binding);

  if (unauthorized) return unauthorized;

  let parsedBody: unknown;

  try {
    parsedBody = parseBody(event);
  } catch {
    return jsonResponse(400, { error: 'Invalid request body' });
  }

  const parsedInput = uploadSchema.safeParse(parsedBody);

  if (!parsedInput.success) {
    return jsonResponse(400, { error: 'Invalid artifact upload input', issues: parsedInput.error.issues });
  }

  const input = parsedInput.data;
  logArtifactUpload(event, input, 'artifact_upload_decode_started');
  const bytes = decodePayload(input);

  const reference = createArtifactReference({ input, bytes });
  logArtifactUpload(event, input, 'artifact_upload_decode_completed', {
    uploadId: reference.blobKey,
    decodedBytes: bytes.length,
  });

  return finalizeUpload(event, input, bytes, binding);
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
