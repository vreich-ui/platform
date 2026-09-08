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
  getBlobStoreSourceDiagnostics,
  getCoreBlobStoreSourceDiagnostics,
  getPdfTemplateBlobStore,
} from '../lib/blob-store.js';
import { ImageValidationError, validatePublishImageBytes } from '../lib/image-validation.js';
import type sharpType from 'sharp';

/**
 * D1 — TWO ALLOW SHAPES, ONE STORE EACH. Everything this function will serve
 * must match exactly one of the two patterns below, and the pattern that
 * matched is what picks the backing store. The store is NEVER taken from the
 * caller (there is no `store=` parameter and there must never be one), so a
 * key of one shape can never be read out of the other's store.
 *
 * Mirrored on the browser side by lib/admin/artifact-preview.ts's
 * ADMIN_PREVIEWABLE_IMAGE_REF_RE / ADMIN_PREVIEWABLE_TEMPLATE_THUMBNAIL_REF_RE
 * (the gate that decides whether to render an <img> at all). Keep them in step.
 */

/** `image/<requestId>/<sha256>[.ext]` — a Major Key artifact, in the `artifacts` store. */
const artifactImageBlobKeyPattern = /^image\/[a-z0-9._-]+\/[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i;

/**
 * `thumbnails/<templateId>/v<n>.png` — a pdf-tool publish-time template
 * thumbnail, in the `pdf-templates` store (pdf-tool's own
 * `pdfTemplateThumbnailKey`; see server/lib/pdf-tool-storage-grant.ts for why
 * those bytes land in THIS site's blob namespace at all).
 *
 * Bounded far more tightly than pdf-tool's writer-side `safeSegment`, which
 * also permits `.`: no dot here means no `.`/`..` segment is expressible, and
 * no `/` in the id segment means the key can never carry a third path segment.
 * `thumbnails/../../secret.png`, `thumbnails/a/b/v1.png`, `thumbnails/x/v1.svg`
 * and `thumbnails/x/vlatest.png` all fail this test outright rather than
 * relying on anything downstream. The trade is deliberate: a template whose id
 * contains a dot is not servable here.
 */
const templateThumbnailBlobKeyPattern = /^thumbnails\/[a-z0-9][a-z0-9_-]{0,127}\/v\d{1,9}\.png$/i;

export type AdminBlobImageKeyShape = 'artifact' | 'template-thumbnail';

/** The single place a key becomes a store choice. Undefined = serve nothing. Exported so
 *  the refusals themselves are directly testable. */
export const classifyAdminBlobImageKey = (blobKey: string): AdminBlobImageKeyShape | undefined => {
  if (artifactImageBlobKeyPattern.test(blobKey)) return 'artifact';
  if (templateThumbnailBlobKeyPattern.test(blobKey)) return 'template-thumbnail';

  return undefined;
};

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

/** Same narrowing artifact-upload.ts uses: the shared BlobStore type declares the
 *  no-options `get`, while both real backends accept the binary read form. */
type PdfTemplateBlobStore = Omit<Awaited<ReturnType<typeof getPdfTemplateBlobStore>>, 'get'> & {
  get: (key: string, options: { type: 'arrayBuffer' }) => Promise<ArrayBuffer | Buffer | string | null>;
};

const toBufferOrNull = (value: unknown): Buffer | null => {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, 'binary');

  return null;
};

const createTemplateThumbnailDebugFields = (event: LambdaEvent, blobKey: string, extra: Record<string, unknown> = {}) => ({
  blobKey,
  store: 'pdf-templates',
  lookup: 'bytes',
  contentTypeSource: 'key-shape' as const,
  blobStoreDiagnostics: getBlobStoreSourceDiagnostics('pdf-templates', event),
  ...extra,
});

/**
 * D1: the `thumbnails/<templateId>/v<n>.png` path.
 *
 * Deliberately NOT routed through the artifact machinery above: a template
 * thumbnail has no artifact-index entry, no sha256 in its key and no request
 * id, so index lookup, reconciliation and sha recovery are all meaningless
 * here — running them would only invent stale-reference errors for bytes that
 * are either present or absent. Everything that MATTERS is kept: the same
 * admin gate in handlerImpl, the same site-scoped store resolution, the same
 * `validatePublishImageBytes` decode before any bytes are returned, and the
 * same optional `w` rendition over those validated bytes.
 *
 * The content type is fixed at image/png from the key shape itself (the
 * pattern only admits `.png`), never from the query string — a caller cannot
 * talk this path into labelling bytes as something else.
 */
export const readAdminTemplateThumbnail = async (event: LambdaEvent, blobKey: string) => {
  const contentType = 'image/png';

  try {
    const store = (await getPdfTemplateBlobStore(event)) as unknown as PdfTemplateBlobStore;
    const bytes = toBufferOrNull(await store.get(blobKey, { type: 'arrayBuffer' }));

    if (!bytes || bytes.byteLength === 0) {
      console.warn('PDF template thumbnail bytes are missing for a key a template record points at.', {
        blobKey,
        store: 'pdf-templates',
      });

      return jsonResponse(404, {
        ...createTemplateThumbnailDebugFields(event, blobKey),
        reason: 'missing-template-thumbnail-bytes',
      });
    }

    const filename = blobKey.split('/').pop() || blobKey;

    let decodedFormat: string | undefined;
    try {
      const metadata = await validatePublishImageBytes({ bytes, contentType, filename, path: blobKey });
      decodedFormat = metadata.format;
    } catch (error) {
      if (error instanceof ImageValidationError) {
        return jsonResponse(422, {
          ...createTemplateThumbnailDebugFields(event, blobKey),
          error: error.message,
          reason: error.code,
          validationReason: error.reason,
        });
      }

      throw error;
    }

    const renditionWidth = parseRenditionWidth(event.queryStringParameters?.w);
    const renditionBytes = renditionWidth
      ? await renderBoundedRendition(bytes, decodedFormat, renditionWidth)
      : undefined;
    const responseBytes = renditionBytes ?? bytes;

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
    console.error('Failed to read a PDF template thumbnail.', error);

    return jsonResponse(500, {
      error: 'PDF template thumbnail could not be read.',
      ...createTemplateThumbnailDebugFields(event, blobKey),
    });
  }
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

/**
 * D1 SCOPING AUDIT (recorded here because it is easy to mis-read the artifact
 * key shape as carrying a tenant):
 *
 * Both paths are scoped identically, and NEITHER derives its scope from the
 * key. Tenancy is the Netlify site (site-binding.ts's OQ-W11-4 note): every
 * deployment reads the same env-var NAMES (PLATFORM_ENV_NAMES) and the
 * platform supplies per-site VALUES, so `getArtifactBlobStore(event)` and
 * `getPdfTemplateBlobStore(event)` both open a store inside this deployment's
 * own blob namespace and cannot address another tenant's at all. The
 * `<requestId>` segment of an artifact key is an editorial request id within
 * one site — it is NOT a tenant discriminator, and nothing here treats it as
 * one — so the thumbnail shape's lack of an equivalent segment removes no
 * existing protection. Identity is the same single gate below for both shapes:
 * authenticated (Netlify Identity or a verified bearer token) AND resolving to
 * the `admin` role for THIS site (ADMIN_EMAILS ∪ this site's `users` store).
 * The store is chosen from the key shape and never from caller input.
 */
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
  const shape = classifyAdminBlobImageKey(blobKey);
  if (!shape) {
    return jsonResponse(400, {
      error: 'A valid image artifact blobKey is required.',
      ...createArtifactDebugFields(event, blobKey),
    });
  }

  // The shape picks the store, and nothing else does.
  return shape === 'template-thumbnail'
    ? readAdminTemplateThumbnail(event, blobKey)
    : readAdminBlobImage(event, blobKey);
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (_binding: SiteBinding) => handlerImpl;
