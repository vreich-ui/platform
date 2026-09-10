import { createHash } from 'node:crypto';

import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { timeAuth, timeSerialize, withServerTiming } from '../lib/server-timing.js';
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

/**
 * `image/<requestId>/<sha256>[.ext]` — a Major Key artifact, in the
 * `artifacts` store.
 *
 * The `<requestId>` segment's charset stays loose ON PURPOSE and is NOT
 * narrowed to the platform's own request-id grammar: bytes in this store are
 * written both by `createArtifactBlobKey` (which validates the segment with
 * `agents-naming.ts`'s `validateRequestId`) and by pdf-tool through a storage
 * grant, which sanitises with its own `safeRequestSegment` and enforces a
 * request-id grammar only when a project descriptor declares
 * `requestIdPattern`. Tightening the charset here would refuse existing,
 * legitimate keys. Traversal is a different question, and is guarded: the
 * segment goes through `isTraversalSafePathSegment` below, the same predicate
 * the thumbnail id segment uses.
 */
const artifactImageBlobKeyPattern = /^image\/[a-z0-9._-]+\/[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i;

/**
 * `thumbnails/<templateId>/v<n>.png` — a pdf-tool publish-time template
 * thumbnail, in the `pdf-templates` store (pdf-tool's own
 * `pdfTemplateThumbnailKey`; see server/lib/pdf-tool-storage-grant.ts for why
 * those bytes land in THIS site's blob namespace at all).
 *
 * The id segment covers pdf-tool's writer-side `safeSegment` charset
 * (`[a-zA-Z0-9._-]`, dots included), because a real template id like
 * `drlurie.article.v1` is one this reader must be able to serve. The dot is
 * admitted by the pattern; the two spellings a dot makes dangerous — a `.`/
 * `..` segment, or `..` anywhere inside the segment — are refused by
 * `isTraversalSafePathSegment` below, deliberately as a separate,
 * readable predicate rather than as regex trickery, and refused OUTRIGHT
 * (never sanitised-and-served) before any store is opened.
 *
 * Everything else stays exactly as narrow: the first character must be a
 * letter or digit, the id is length-bounded, and no `/` in the id segment
 * means the key can never carry a third path segment. `thumbnails/a/b/v1.png`,
 * `thumbnails/x/v1.svg` and `thumbnails/x/vlatest.png` still fail this test
 * outright rather than relying on anything downstream.
 *
 * Mirrored (pattern, guard and refusal list) by lib/admin/artifact-preview.ts,
 * which also carries the FOLLOW-UP note about converging this shape with
 * pdf-tool's id minting instead of widening the reader again.
 */
const templateThumbnailBlobKeyPattern = /^thumbnails\/[a-z0-9][a-z0-9._-]{0,127}\/v\d{1,9}\.png$/i;

/**
 * The traversal guard, held apart from the patterns on purpose so it is
 * legible and testable on its own, and applied to BOTH shapes' middle segment
 * — the artifact key's `<requestId>` and the thumbnail key's `<templateId>`
 * are the same kind of caller-influenced path segment, and neither may
 * express traversal. An all-dots segment is covered by the same three
 * clauses: `.` is named, and every longer run of dots contains `..`. Mirrors
 * artifact-preview.ts's `isTraversalSafePathSegment` verbatim — keep the two
 * in step.
 */
export const isTraversalSafePathSegment = (segment: string): boolean =>
  segment !== '.' && segment !== '..' && !segment.includes('..');

/** The middle segment of a `<prefix>/<id>/<filename>` blob key (empty when there is none). */
const blobKeyIdSegment = (blobKey: string): string => blobKey.split('/')[1] ?? '';

/** Shape AND traversal guard — both must hold before this key names a store. */
const isServableArtifactImageKey = (blobKey: string): boolean =>
  artifactImageBlobKeyPattern.test(blobKey) && isTraversalSafePathSegment(blobKeyIdSegment(blobKey));

/** Shape AND traversal guard — both must hold before this key names a store. */
const isServableTemplateThumbnailKey = (blobKey: string): boolean =>
  templateThumbnailBlobKeyPattern.test(blobKey) && isTraversalSafePathSegment(blobKeyIdSegment(blobKey));

export type AdminBlobImageKeyShape = 'artifact' | 'template-thumbnail';

/** The single place a key becomes a store choice. Undefined = serve nothing. Exported so
 *  the refusals themselves are directly testable. */
export const classifyAdminBlobImageKey = (blobKey: string): AdminBlobImageKeyShape | undefined => {
  if (isServableArtifactImageKey(blobKey)) return 'artifact';
  if (isServableTemplateThumbnailKey(blobKey)) return 'template-thumbnail';

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
    console.warn('Preview rendition failed; falling back to the original image bytes.', {
      width,
      decodedFormat,
      error,
    });
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
  body: timeSerialize(() => JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body })),
});

// T1.5: served bytes are private (admin-only, authenticated read) but stable
// once written — an artifact's bytes at a given blobKey+width never change
// underneath the same key, so a full day of browser-side caching is safe,
// unlike the 5-minute ceiling this replaces. `ETag` + `If-None-Match` on top
// of that turns a revisit into a 304 (headers only) instead of a full
// re-render-and-re-download, which is the actual point: max-age alone only
// helps within one page session, not across the reloads admin actually does.
const CACHE_CONTROL = 'private, max-age=86400';

/** Same shape as every other admin function's `etagFor` (grep `etagFor` — this
 *  is deliberately not a shared import; each caller hashes its own body). */
const etagFor = (body: unknown): string => `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;

/**
 * The ETag is computed over the ACTUAL RESPONSE BYTES (post-rendition, base64
 * — the same string the body sends), never over the source blob alone: a 512px
 * rendition and a 96px rendition of the same artifact are different response
 * bodies and MUST carry different ETags, or a browser holding the 96px
 * `If-None-Match` would get served a 304 that means "still 512px" instead of
 * the fresh, smaller request it actually made. Content type is not part of
 * the input on purpose — a decoded image's bytes and format are already fixed
 * together upstream of this call, so content type never varies independently
 * of the bytes it is computed from.
 */
const etagForResponseBytes = (base64Body: string): string => etagFor(base64Body);

const ifNoneMatchFrom = (event: LambdaEvent): string | undefined =>
  event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];

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
  extra: Record<string, unknown> = {},
  binding?: SiteBinding
) => ({
  blobKey,
  store: 'artifacts',
  lookup: 'bytes',
  contentTypeSource,
  blobStoreDiagnostics: getCoreBlobStoreSourceDiagnostics(event, binding),
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
  reference?: ArtifactReference,
  binding?: SiteBinding
): Promise<ResolvedArtifactContentType> => {
  try {
    let indexedContentType = getConcreteImageContentType(reference?.contentType);
    if (!indexedContentType) {
      const indexStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ArtifactIndexStore;
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

const createTemplateThumbnailDebugFields = (
  event: LambdaEvent,
  blobKey: string,
  extra: Record<string, unknown> = {},
  binding?: SiteBinding
) => ({
  blobKey,
  store: 'pdf-templates',
  lookup: 'bytes',
  contentTypeSource: 'key-shape' as const,
  blobStoreDiagnostics: getBlobStoreSourceDiagnostics('pdf-templates', event, binding),
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
export const readAdminTemplateThumbnail = async (event: LambdaEvent, blobKey: string, binding?: SiteBinding) => {
  const contentType = 'image/png';

  try {
    const store = (await getPdfTemplateBlobStore(event, binding)) as unknown as PdfTemplateBlobStore;
    const bytes = toBufferOrNull(await store.get(blobKey, { type: 'arrayBuffer' }));

    if (!bytes || bytes.byteLength === 0) {
      console.warn('PDF template thumbnail bytes are missing for a key a template record points at.', {
        blobKey,
        store: 'pdf-templates',
      });

      return jsonResponse(404, {
        ...createTemplateThumbnailDebugFields(event, blobKey, {}, binding),
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
          ...createTemplateThumbnailDebugFields(event, blobKey, {}, binding),
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
    const bodyBase64 = responseBytes.toString('base64');
    const etag = etagForResponseBytes(bodyBase64);

    if (ifNoneMatchFrom(event) === etag) {
      return { statusCode: 304, headers: { 'Cache-Control': CACHE_CONTROL, ETag: etag }, body: '' };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': CACHE_CONTROL,
        ETag: etag,
      },
      body: bodyBase64,
      isBase64Encoded: true,
    };
  } catch (error) {
    console.error('Failed to read a PDF template thumbnail.', error);

    return jsonResponse(500, {
      error: 'PDF template thumbnail could not be read.',
      ...createTemplateThumbnailDebugFields(event, blobKey, {}, binding),
    });
  }
};

export const readAdminBlobImage = async (event: LambdaEvent, blobKey: string, binding?: SiteBinding) => {
  let contentTypeSource: ContentTypeSource = 'missing';

  try {
    const indexStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ArtifactIndexStore;
    const indexedReference = await findArtifactReferenceByBlobKey(indexStore, blobKey);
    const resolvedContentType = await resolveArtifactContentType(event, blobKey, indexedReference, binding);
    const { contentType } = resolvedContentType;
    contentTypeSource = resolvedContentType.source;
    if (!contentType) {
      return jsonResponse(400, {
        error: 'A concrete image content type is required for this artifact.',
        ...createArtifactDebugFields(event, blobKey, contentTypeSource, {}, binding),
      });
    }

    const reference: ArtifactReference = indexedReference ?? {
      blobKey,
      sha256: getShaFromBlobKey(blobKey),
      sizeBytes: 0,
      contentType,
      createdAtISO: new Date(0).toISOString(),
    };
    const store = await getArtifactBlobStore(event, binding);
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
        ...createArtifactDebugFields(event, blobKey, contentTypeSource, {}, binding),
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
        ...createArtifactDebugFields(event, blobKey, contentTypeSource, {}, binding),
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
          ...createArtifactDebugFields(event, blobKey, contentTypeSource, {}, binding),
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
    const bodyBase64 = responseBytes.toString('base64');
    const etag = etagForResponseBytes(bodyBase64);

    if (ifNoneMatchFrom(event) === etag) {
      return { statusCode: 304, headers: { 'Cache-Control': CACHE_CONTROL, ETag: etag }, body: '' };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': CACHE_CONTROL,
        ETag: etag,
      },
      body: bodyBase64,
      isBase64Encoded: true,
    };
  } catch (error) {
    console.error('Failed to read saved image artifact.', error);

    return jsonResponse(500, {
      error: 'Saved image artifact could not be read.',
      ...createArtifactDebugFields(event, blobKey, contentTypeSource, {}, binding),
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
const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const adminState = await timeAuth(() => resolveAdminAccessFromEvent(event, context, binding));
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
      ...createArtifactDebugFields(event, blobKey, undefined, {}, binding),
    });
  }

  // The shape picks the store, and nothing else does.
  return shape === 'template-thumbnail'
    ? readAdminTemplateThumbnail(event, blobKey, binding)
    : readAdminBlobImage(event, blobKey, binding);
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding.
 *  T0.1: Server-Timing wrap only — the ETag work on the binary read paths
 *  below (`readAdminTemplateThumbnail`/`readAdminBlobImage`) is another
 *  agent's and is left untouched; `serialize` here only covers the JSON
 *  error/4xx responses `jsonResponse` builds, not the base64 image bodies. */
export const createHandler = (binding: SiteBinding) =>
  withServerTiming('admin-get-blob-image', buildHandlerImpl(binding));
