import type { SiteBinding } from '../lib/site-binding.js';
import { getArtifactBlobStore, getArtifactIndexBlobStore } from '../lib/blob-store.js';
import { normalizeArtifactBlobKey } from '../lib/artifacts.js';
import { readArtifactReference, type ArtifactIndexStore } from '../lib/artifact-index.js';
import { sanitizeFilename } from '../lib/artifact-filename.js';

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
const publicPdfPathPattern = /\/pdf\/([a-z0-9._-]+\/[a-f0-9]{64}\.pdf)$/i;
const allowedPdfBlobKeyPattern = /^pdf\/[a-z0-9._-]+\/[a-f0-9]{64}\.pdf$/i;

const getBlobKeyFromPublicPdfValue = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const directBlobKey = normalizeArtifactBlobKey(trimmed);
  if (allowedPdfBlobKeyPattern.test(directBlobKey)) return directBlobKey;

  const pathMatch = trimmed.match(publicPdfPathPattern);
  return pathMatch ? `pdf/${pathMatch[1]}` : '';
};

const getRequestedBlobKey = (event: LambdaEvent) =>
  getBlobKeyFromPublicPdfValue(toText(event.queryStringParameters?.blobKey)) ||
  getBlobKeyFromPublicPdfValue(toText(event.path)) ||
  getBlobKeyFromPublicPdfValue(toText(event.rawUrl));

type BlobMetadata = Record<string, string>;

type BinaryReadableBlobStoreWithMetadata = {
  getWithMetadata: (
    key: string,
    options: { type: 'arrayBuffer' }
  ) => Promise<{ data: ArrayBuffer | null; metadata?: BlobMetadata } | null>;
};

/**
 * requestId/sha256 pulled straight out of the content-addressed blobKey shape
 * `pdf/{requestId}/{sha256}.pdf` — the same split admin-blob-manager.ts's
 * get-artifact-metadata action uses to key into the artifact-index store.
 */
const getArtifactPointerFromBlobKey = (blobKey: string): { requestId: string; sha256: string } | undefined => {
  const [, requestId, filename] = blobKey.split('/');
  const sha256 = filename?.match(/^[a-f0-9]{64}/i)?.[0]?.toLowerCase();

  return requestId && sha256 ? { requestId, sha256 } : undefined;
};

const nameFromMetadata = (metadata: BlobMetadata | undefined): string =>
  toText(metadata?.originalFilename) || toText(metadata?.label);

/**
 * Resolve the download filename, first hit wins:
 *   1. the blob's own `originalFilename` metadata
 *   2. the blob's own `label` metadata
 *   3. the artifact-index reference for this blobKey's requestId/sha256 — read ONLY when
 *      1-2 produced nothing, so the common/warm case (the blob already carries a name) stays
 *      a single blob read and never touches the artifact-index store.
 *   4. `fallbackName` (the blobKey's basename — today's behavior)
 */
const resolveDownloadFilename = async (
  blobKey: string,
  fallbackName: string,
  metadata: BlobMetadata | undefined,
  event: LambdaEvent
): Promise<string> => {
  const metadataName = nameFromMetadata(metadata);
  if (metadataName) return metadataName;

  const pointer = getArtifactPointerFromBlobKey(blobKey);
  if (!pointer) return fallbackName;

  try {
    const indexStore = (await getArtifactIndexBlobStore(event)) as unknown as ArtifactIndexStore;
    const reference = await readArtifactReference(indexStore, pointer.requestId, pointer.sha256);
    const indexName = toText(reference?.originalFilename) || toText(reference?.label);
    if (indexName) return indexName;
  } catch (error) {
    console.error('Failed to read artifact-index reference for download filename.', error);
  }

  return fallbackName;
};

const ensurePdfExtension = (name: string): string => (/\.pdf$/i.test(name) ? name : `${name}.pdf`);

/**
 * RFC 5987 attr-char excludes `'`, `(`, `)`, and `*`, none of which
 * encodeURIComponent escapes on its own — widen it just enough to produce a
 * valid `filename*=UTF-8''...` value.
 */
const encodeRFC5987ValueChars = (value: string): string =>
  encodeURIComponent(value)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');

export type PdfDisposition = 'inline' | 'attachment';

/**
 * `inline` unless the caller explicitly asks to download.
 *
 * WHY INLINE IS THE DEFAULT (2026-09-07). An article body attaches its PDF as
 * `<iframe src="/pdf/{id}/{sha256}.pdf">` (article-object/render-nodes.ts's
 * `documentMediaHtml`), and every browser REFUSES to display an
 * attachment-dispositioned response in an embedded viewer. The response is a
 * clean 200, so the embed counts as loaded and no fallback is shown either —
 * which rendered the attached PDF as a blank bordered box on every article
 * carrying one, in the admin preview and on the live site alike. The bytes
 * were never the problem; this header was.
 *
 * `admin-get-blob-pdf.ts` (the admin sidebar's preview endpoint) has always
 * sent `inline` for the same reason, and its iframe has always worked — this
 * makes the public path agree with the one that was already right.
 *
 * The download path is unaffected either way: the article card's own link
 * carries the `download` attribute, which is same-origin here and forces a
 * save regardless of disposition. `?download=1` is for callers that cannot
 * set that attribute (a bare address pasted into a browser, an email link).
 */
const parseDisposition = (value: unknown): PdfDisposition => {
  const normalized = toText(value).toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' ? 'attachment' : 'inline';
};

/**
 * Emits BOTH Content-Disposition forms per RFC 6266 / RFC 5987 so non-ASCII
 * names degrade gracefully: an ASCII-safe `filename=` for legacy clients, and
 * the percent-encoded UTF-8 `filename*=` for everyone else. If sanitizing the
 * resolved name collapses it to an empty stem (e.g. an all-symbols name),
 * fall back to the sha-based name instead of serving a bare/underscore-only
 * filename.
 *
 * The filename travels on BOTH dispositions on purpose: `inline` still names
 * the file for a "save as" out of the browser's own PDF viewer, so switching
 * the default cost nothing in download-name quality.
 */
const buildContentDisposition = (
  resolvedName: string,
  fallbackName: string,
  disposition: PdfDisposition = 'inline'
): string => {
  const displayCandidate = ensurePdfExtension(resolvedName);
  const asciiCandidate = sanitizeFilename(displayCandidate);
  const stem = asciiCandidate.replace(/\.pdf$/i, '');

  const [displayName, asciiSafeName] = stem
    ? [displayCandidate, asciiCandidate]
    : [ensurePdfExtension(fallbackName), ensurePdfExtension(fallbackName)];

  return `${disposition}; filename="${asciiSafeName}"; filename*=UTF-8''${encodeRFC5987ValueChars(displayName)}`;
};

const handlerImpl = async (event: LambdaEvent) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const blobKey = getRequestedBlobKey(event);

  if (!allowedPdfBlobKeyPattern.test(blobKey)) {
    return jsonResponse(400, { error: 'A valid PDF artifact blobKey is required.' });
  }

  try {
    const store = await getArtifactBlobStore(event);
    const result = await (store as unknown as BinaryReadableBlobStoreWithMetadata).getWithMetadata(blobKey, {
      type: 'arrayBuffer',
    });

    if (!result || result.data === null || result.data === undefined) {
      return jsonResponse(404, { error: 'PDF artifact not found.' });
    }

    const buffer = Buffer.from(result.data);
    const fallbackName = blobKey.split('/').pop() || 'artifact.pdf';
    const resolvedName = await resolveDownloadFilename(blobKey, fallbackName, result.metadata, event);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        // Content-addressed key ⇒ the bytes for this URL can never change.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': buildContentDisposition(
          resolvedName,
          fallbackName,
          parseDisposition(event.queryStringParameters?.download)
        ),
      },
      body: event.httpMethod === 'HEAD' ? '' : buffer.toString('base64'),
      isBase64Encoded: event.httpMethod !== 'HEAD',
    };
  } catch (error) {
    console.error('Failed to read public PDF artifact.', error);

    return jsonResponse(500, { error: 'PDF artifact could not be read.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (_binding: SiteBinding) => handlerImpl;
