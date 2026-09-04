import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import {
  getImageArtifactReadDiagnostics,
  reconcileImageArtifactReference,
  type ArtifactReference,
} from '../lib/artifacts.js';
import {
  listArtifactIndexKeys,
  readArtifactReference,
  resolveArtifactPointer,
  type ArtifactIndexStore,
} from '../lib/artifact-index.js';
import {
  getArtifactBlobStore,
  getArtifactIndexBlobStore,
  getCoreBlobStoreSourceDiagnostics,
} from '../lib/blob-store.js';
import { ImageValidationError, validatePublishImageBytes } from '../lib/image-validation.js';
import type sharpType from 'sharp';

const allowedImageBlobKeyPattern = /^image\/[a-z0-9._-]+\/[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i;

// D-preview-rendition: a card-sized `<img>` (mood board, examples strip, the
// library picker) never needs the ORIGINAL bytes — it was the bulk of "24
// authenticated full-size downloads at once" being slow/often-failing. `w`
// bounds the longest edge of a resize done here, server-side, over the SAME
// authenticated read path and the SAME validated bytes — never a second,
// unauthenticated way to reach an artifact. Clamped well below what any
// legitimate card size asks for; a resize that fails for any reason (a
// format sharp can't touch, a corrupt install) falls back to the original
// bytes rather than failing the request.
const MIN_RENDITION_WIDTH = 16;
const MAX_RENDITION_WIDTH = 1024;
const RENDITION_FORMATS = new Set(['jpeg', 'png', 'webp']);

const parseRenditionWidth = (value: unknown): number | undefined => {
  const parsed = Number(typeof value === 'string' ? value.trim() : value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return undefined;
  return Math.min(MAX_RENDITION_WIDTH, Math.max(MIN_RENDITION_WIDTH, parsed));
};

// Loaded lazily, same reasoning as image-validation.ts's own loadSharp: sharp's
// native binding is expensive at module-evaluation time for every function
// that bundles this file, so it is only paid for on an actual rendition
// request, cached per runtime instance.
let cachedSharp: typeof sharpType | undefined;
const loadSharp = async (): Promise<typeof sharpType> => {
  if (!cachedSharp) cachedSharp = (await import('sharp')).default;
  return cachedSharp;
};

/**
 * Best-effort width-bounded rendition of already-validated image bytes.
 * Returns undefined (never throws) on anything that isn't a clean resize —
 * an unsupported decoded format, a broken sharp install, a corrupt-but-passed
 * decode — so the caller's fallback is always "serve the original bytes",
 * never a broken response.
 */
const renderBoundedRendition = async (
  bytes: Buffer,
  decodedFormat: string | undefined,
  width: number
): Promise<Buffer | undefined> => {
  if (!decodedFormat || !RENDITION_FORMATS.has(decodedFormat)) return undefined;
  try {
    const sharp = await loadSharp();
    const pipeline = sharp(bytes, { failOn: 'error' }).resize({
      width,
      height: width,
      fit: 'inside',
      withoutEnlargement: true,
    });
    const format = decodedFormat as 'jpeg' | 'png' | 'webp';
    return await pipeline.toFormat(format).toBuffer();
  } catch (error) {
    console.warn('Preview rendition failed; falling back to the original image bytes.', { width, decodedFormat, error });
    return undefined;
  }
};
const contentTypeByExtension: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

type LambdaEvent = {
  blobs?: string;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
};

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});

const toText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const getConcreteImageContentType = (value: unknown) => {
  const normalized = toText(value).toLowerCase().split(';')[0]?.trim() || '';
  if (!/^image\/[a-z0-9.+-]+$/.test(normalized) || normalized === 'image/*') return '';

  return normalized;
};

const getContentTypeFromExtension = (blobKey: string) => {
  const extension = blobKey.split('.').pop()?.toLowerCase() || '';
  return contentTypeByExtension[extension] || '';
};

type ContentTypeSource = 'artifact-index' | 'query-string' | 'extension' | 'missing';

type ResolvedArtifactContentType = {
  contentType: string;
  source: ContentTypeSource;
};

const shouldIncludeArtifactReadDiagnostics = () => process.env.CONTEXT !== 'production';

const createArtifactDebugFields = (
  event: LambdaEvent,
  blobKey: string,
  contentTypeSource: ContentTypeSource = 'missing',
  extra: Record<string, unknown> = {}
) => ({
  blobKey,
  store: 'artifacts',
  lookup: 'bytes',
  contentTypeSource,
  blobStoreDiagnostics: getCoreBlobStoreSourceDiagnostics(event),
  ...extra,
});

const getShaFromBlobKey = (blobKey: string) => {
  const [, , filename = ''] = blobKey.split('/');
  const match = filename.match(/^[a-f0-9]{64}/i);

  return match?.[0]?.toLowerCase() || '';
};

const getRequestIdFromBlobKey = (blobKey: string) => {
  const [, requestId = ''] = blobKey.split('/');

  return requestId.trim();
};

const findArtifactReferenceByBlobKey = async (store: ArtifactIndexStore, blobKey: string) => {
  const requestId = getRequestIdFromBlobKey(blobKey);
  const sha = getShaFromBlobKey(blobKey);

  if (requestId && sha) {
    const directReference = await readArtifactReference(store, requestId, sha);
    if (directReference?.blobKey === blobKey) return directReference;
  }

  const keys = await listArtifactIndexKeys(store, 'request-artifacts/');

  for (const key of keys) {
    const reference = await resolveArtifactPointer(store, {
      requestId: key.split('/')[1] ? decodeURIComponent(key.split('/')[1]) : '',
      sha256: key.split('/').pop()?.replace('.json', '') ?? '',
    });
    if (reference?.blobKey === blobKey) return reference;
  }

  return undefined;
};

const resolveArtifactContentType = async (
  event: LambdaEvent,
  blobKey: string,
  reference?: ArtifactReference
): Promise<ResolvedArtifactContentType> => {
  try {
    let indexedContentType = getConcreteImageContentType(reference?.contentType);
    if (!indexedContentType) {
      const indexStore = (await getArtifactIndexBlobStore(event)) as unknown as ArtifactIndexStore;
      reference = await findArtifactReferenceByBlobKey(indexStore, blobKey);
      indexedContentType = getConcreteImageContentType(reference?.contentType);
    }
    if (indexedContentType) return { contentType: indexedContentType, source: 'artifact-index' };
  } catch (error) {
    console.warn('Artifact index lookup failed while resolving image content type.', { blobKey, error });
  }

  const queryContentType = getConcreteImageContentType(event.queryStringParameters?.contentType);
  if (queryContentType) return { contentType: queryContentType, source: 'query-string' };

  const extensionContentType = getContentTypeFromExtension(blobKey);
  if (extensionContentType) return { contentType: extensionContentType, source: 'extension' };

  return { contentType: '', source: 'missing' };
};

export const readAdminBlobImage = async (event: LambdaEvent, blobKey: string) => {
  let contentTypeSource: ContentTypeSource = 'missing';

  try {
    const indexStore = (await getArtifactIndexBlobStore(event)) as unknown as ArtifactIndexStore;
    const indexedReference = await findArtifactReferenceByBlobKey(indexStore, blobKey);
    const resolvedContentType = await resolveArtifactContentType(event, blobKey, indexedReference);
    const { contentType } = resolvedContentType;
    contentTypeSource = resolvedContentType.source;
    if (!contentType) {
      return jsonResponse(400, {
        error: 'A concrete image content type is required for this artifact.',
        ...createArtifactDebugFields(event, blobKey, contentTypeSource),
      });
    }

    const reference: ArtifactReference = indexedReference ?? {
      blobKey,
      sha256: getShaFromBlobKey(blobKey),
      sizeBytes: 0,
      contentType,
      createdAtISO: new Date(0).toISOString(),
    };
    const store = await getArtifactBlobStore(event);
    const reconciliation = await reconcileImageArtifactReference(
      reference,
      store,
      indexedReference ? indexStore : undefined
    );

    if (reconciliation.status === 'missing') {
      const diagnostics = await getImageArtifactReadDiagnostics(store, blobKey, reconciliation.nearbyKeys);
      console.warn('Saved image artifact JSON reference is stale: backing bytes are missing.', {
        blobKey,
        store: 'artifacts',
        exactFilenameExists: diagnostics.exactFilenameExists,
        nearbyKeys: diagnostics.nearbyKeys,
      });

      return jsonResponse(404, {
        ...createArtifactDebugFields(event, blobKey, contentTypeSource),
        reason: 'missing-artifact-bytes',
        blobKey,
        store: 'artifacts',
        ...(shouldIncludeArtifactReadDiagnostics() ? { diagnostics } : {}),
      });
    }

    if (reconciliation.status === 'ambiguous') {
      console.warn('Saved image artifact recovery found multiple possible backing blobs.', {
        blobKey,
        store: 'artifacts',
        matchingKeys: reconciliation.matchingKeys,
        nearbyKeys: reconciliation.nearbyKeys,
      });

      return jsonResponse(409, {
        ...createArtifactDebugFields(event, blobKey, contentTypeSource),
        error: 'Saved image artifact bytes are ambiguous.',
        reason: 'ambiguous-artifact-bytes',
        blobKey,
        store: 'artifacts',
        ...(shouldIncludeArtifactReadDiagnostics()
          ? { diagnostics: { matchingKeys: reconciliation.matchingKeys, nearbyKeys: reconciliation.nearbyKeys } }
          : {}),
      });
    }

    const buffer = reconciliation.bytes;
    const filename = blobKey.split('/').pop() || blobKey;

    let decodedFormat: string | undefined;
    try {
      const metadata = await validatePublishImageBytes({
        bytes: buffer,
        contentType,
        filename,
        path: blobKey,
      });
      decodedFormat = metadata.format;
    } catch (error) {
      if (error instanceof ImageValidationError) {
        return jsonResponse(422, {
          ...createArtifactDebugFields(event, blobKey, contentTypeSource),
          error: error.message,
          reason: error.code,
          validationReason: error.reason,
          blobKey,
          store: 'artifacts',
        });
      }

      throw error;
    }

    // D-preview-rendition: `w` is optional and additive. Absent (every
    // full-size view and every download path — neither passes it), behavior
    // is byte-for-byte what it always was. Present, this is still the SAME
    // authenticated read of the SAME validated bytes above — only the body
    // written to the response differs.
    const renditionWidth = parseRenditionWidth(event.queryStringParameters?.w);
    const renditionBytes = renditionWidth
      ? await renderBoundedRendition(buffer, decodedFormat, renditionWidth)
      : undefined;
    const responseBytes = renditionBytes ?? buffer;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=300',
      },
      body: responseBytes.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    console.error('Failed to read saved image artifact.', error);

    return jsonResponse(500, {
      error: 'Saved image artifact could not be read.',
      ...createArtifactDebugFields(event, blobKey, contentTypeSource),
    });
  }
};

const handlerImpl = async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const adminState = await resolveAdminAccessFromEvent(event, context);
  if (!adminState.authenticated) {
    return jsonResponse(401, {
      error: adminState.error || 'Authentication is required.',
    });
  }

  if (!adminState.isAdmin) {
    return jsonResponse(403, { error: 'This user is not authorized to read saved image artifacts.' });
  }

  const blobKey = toText(event.queryStringParameters?.blobKey);
  if (!allowedImageBlobKeyPattern.test(blobKey)) {
    return jsonResponse(400, {
      error: 'A valid image artifact blobKey is required.',
      ...createArtifactDebugFields(event, blobKey),
    });
  }

  return readAdminBlobImage(event, blobKey);
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (_binding: SiteBinding) => handlerImpl;
