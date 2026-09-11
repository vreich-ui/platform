/**
 * Function name: Get_Public_Image
 * Required method: GET/HEAD
 * Auth: none — PUBLIC, the image mirror of get-public-pdf.ts.
 *
 * Serves image artifacts from the blobs `artifacts` store at `/img/*`
 * (netlify.toml redirect → ?blobKey=image/:splat), so blob-stored images are
 * live-site citizens exactly like blob-stored PDFs are at /pdf/* — the
 * "pdf-tool" pattern Wolf asked the canvas image flow to follow. A section's
 * `src` holds the plain root-relative `/img/<requestId>/<sha256>.<ext>` path,
 * which passes deploy-safety (no forbidden hosts) and renders through the
 * existing components untouched.
 *
 * Safe to expose without auth for the same reason /pdf/* is: keys are
 * content-addressed Major-Key shapes (kind/requestId/sha256.ext) — unguessable
 * without the sha256 of the exact bytes, validated to an allowlisted image
 * extension, read-only. Content-addressing also makes responses immutable, so
 * the cache header is aggressive.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getArtifactBlobStore, getArtifactIndexBlobStore } from '../lib/blob-store.js';
import { normalizeArtifactBlobKey } from '../lib/artifacts.js';
import { requestArtifactReferenceKey, type ArtifactIndexStore } from '../lib/artifact-index.js';

type LambdaEvent = {
  httpMethod?: string;
  path?: string;
  rawUrl?: string;
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
const publicImagePathPattern = /\/img\/([a-z0-9._-]+\/[a-f0-9]{64}\.(?:png|jpg|jpeg|webp|gif|avif|svg))$/i;
const allowedImageBlobKeyPattern = /^image\/[a-z0-9._-]+\/[a-f0-9]{64}\.(?:png|jpg|jpeg|webp|gif|avif|svg)$/i;

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

const getBlobKeyFromPublicImageValue = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const directBlobKey = normalizeArtifactBlobKey(trimmed);
  if (allowedImageBlobKeyPattern.test(directBlobKey)) return directBlobKey;

  const pathMatch = trimmed.match(publicImagePathPattern);
  return pathMatch ? `image/${pathMatch[1]}` : '';
};

/**
 * W2 T2.5: the deduplicated-artifact fallback.
 *
 * The public path is and stays request-scoped — `/img/<requestId>/<sha256>.<ext>` — but a
 * reference created by the T2.4 dedupe path has NO blob of its own: its bytes live under
 * the first request's key, named by `storageKey`. This reads that one reference JSON
 * (`request-artifacts/<requestId>/<sha256>.json`) and returns its storage key.
 *
 * Only ever called on a BLOB MISS, so today's artifacts — which all hit directly — pay
 * nothing for it, and it fails open (any error ⇒ the ordinary 404).
 *
 * The redirect is re-validated here rather than trusted: the stored key must be a
 * servable image key AND must carry the SAME sha256 as the requested path, so a corrupt
 * or hostile index entry cannot make this endpoint serve bytes from another artifact.
 */
const resolveDedupedStorageKey = async (event: LambdaEvent, binding: SiteBinding, blobKey: string) => {
  const [, requestId = '', filename = ''] = blobKey.split('/');
  const sha256 = filename.match(/^[a-f0-9]{64}/i)?.[0]?.toLowerCase();
  if (!requestId || !sha256) return '';

  try {
    const indexStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ArtifactIndexStore;
    const text = await indexStore.get(requestArtifactReferenceKey(requestId, sha256));
    if (!text) return '';

    const reference = JSON.parse(text) as Record<string, unknown>;
    if (reference.blobKey !== blobKey) return '';
    if (typeof reference.storageKey !== 'string') return '';

    const storageKey = normalizeArtifactBlobKey(reference.storageKey);
    if (storageKey === blobKey) return '';
    if (!allowedImageBlobKeyPattern.test(storageKey)) return '';
    if (!storageKey.split('/').pop()?.toLowerCase().startsWith(sha256)) return '';

    return storageKey;
  } catch (error) {
    console.warn('Public image dedupe fallback could not read the artifact index.', { blobKey, error });
    return '';
  }
};

const getRequestedBlobKey = (event: LambdaEvent) =>
  getBlobKeyFromPublicImageValue(toText(event.queryStringParameters?.blobKey)) ||
  getBlobKeyFromPublicImageValue(toText(event.path)) ||
  getBlobKeyFromPublicImageValue(toText(event.rawUrl));

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const blobKey = getRequestedBlobKey(event);

  if (!allowedImageBlobKeyPattern.test(blobKey)) {
    return jsonResponse(400, { error: 'A valid image artifact blobKey is required.' });
  }

  try {
    const store = await getArtifactBlobStore(event, binding);
    const reader = store as { get: (key: string, options: { type: 'arrayBuffer' }) => Promise<ArrayBuffer | null> };
    let result = (await reader.get(blobKey, { type: 'arrayBuffer' })) as ArrayBuffer | null;

    if (!result) {
      const storageKey = await resolveDedupedStorageKey(event, binding, blobKey);
      if (storageKey) result = (await reader.get(storageKey, { type: 'arrayBuffer' })) as ArrayBuffer | null;
    }

    if (!result) {
      return jsonResponse(404, { error: 'Image artifact not found.' });
    }

    const buffer = Buffer.from(result);
    const extension = (blobKey.split('.').pop() ?? '').toLowerCase();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
        // Content-addressed key ⇒ the bytes for this URL can never change.
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Defense-in-depth for the svg case (no script execution as a page).
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
      },
      body: event.httpMethod === 'HEAD' ? '' : buffer.toString('base64'),
      isBase64Encoded: event.httpMethod !== 'HEAD',
    };
  } catch (error) {
    console.error('Failed to read public image artifact.', error);

    return jsonResponse(500, { error: 'Image artifact could not be read.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
