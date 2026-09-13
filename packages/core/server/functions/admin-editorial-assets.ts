import { createHash } from 'node:crypto';

import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { getArtifactIndexBlobStore } from '../lib/blob-store.js';
import { listArtifactIndexKeys, resolveArtifactPointer, type ArtifactIndexStore } from '../lib/artifact-index.js';
import { isArtifactReference, type ArtifactReference } from '../lib/artifacts.js';
import { mapWithConcurrency, STORE_READ_CONCURRENCY } from '../lib/blob-list.js';
import { buildPdfToolStorageGrant } from '../lib/pdf-tool-storage-grant.js';
import { listPlatformPdfTemplates } from '../lib/pdf-tool-client.js';
import { projectEditorialArtifact, projectPdfTemplate } from '../../lib/admin/editorial-assets.js';
import { timeAuth, timeSection, timeSerialize, withServerTiming } from '../lib/server-timing.js';

type LambdaEvent = {
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
};

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: timeSerialize(() => JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body })),
});

/**
 * T2.3 — the whole function is one GET, one read, no mutation branch, so the
 * ETag applies to the entire success body (the templates+media listing an
 * editor's asset picker re-fetches on every navigation into it).
 */
const CACHE_CONTROL = 'private, no-cache';
/**
 * Hashes the ALREADY-SERIALIZED wire body, so a read response is
 * `JSON.stringify`d exactly ONCE per request. The digest is identical to
 * hashing the object (same input string), but the previous shape paid a
 * second full stringify of the whole body on every read — on a latency
 * branch, on this surface's hottest read paths.
 */
const etagForSerialized = (serialized: string): string =>
  `"${createHash('sha1').update(serialized).digest('hex')}"`;

const parseJson = async (store: ArtifactIndexStore, key: string): Promise<unknown> => {
  const raw = await store.get(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * The `by-kind/` sweep, bounded.
 *
 * Every key under `by-kind/<kind>/` costs TWO blob reads: the pointer, then
 * the full `request-artifacts/<requestId>/<sha>.json` reference the pointer
 * names (the pointer's ONLY job here is to supply that `requestId` — see
 * `ArtifactPointer` in lib/artifact-index.ts). Firing all of them through a
 * single `Promise.all` put `2 x A` reads in flight at once against one
 * Netlify Blobs store, which is precisely the fan-out the 2026-08-06 hotfix
 * comment on `STORE_READ_CONCURRENCY` (lib/blob-list.ts) was written about:
 * a burst that large does not go faster, it goes THROTTLED, and one rejected
 * read there aborts the whole listing.
 *
 * `mapWithConcurrency` is the repo's one helper for this and preserves input
 * order, so the dedupe/sort/slice below sees exactly the sequence it always
 * did.
 *
 * NOT fixed here, deliberately: this still reads every record to return at
 * most 100. The sort key (`createdAtISO`) and the liveness flag
 * (`deletedAtISO`) exist ONLY on the full reference — the `by-kind/` key
 * carries a sha256 and the pointer body carries `{ requestId, sha256,
 * artifactKind }` — so nothing available before the read can decide which
 * 100 records are the newest. Slicing before the read needs those two fields
 * on the pointer, i.e. an artifact-index schema bump, which is not this
 * change.
 *
 * Exported for tests/netlify/admin-editorial-assets.test.ts, which PINS the
 * read count for a fixture — the cost this function is judged on is "how
 * many blob reads per listed artifact", and that is not observable from the
 * handler's wire response. (Same reason `requestSchema` is exported from
 * admin-governance.ts.)
 */
export async function listKind(store: ArtifactIndexStore, kind: 'image' | 'pdf'): Promise<ArtifactReference[]> {
  const pointerKeys = await listArtifactIndexKeys(store, `by-kind/${kind}/`);
  const references = await mapWithConcurrency(pointerKeys, STORE_READ_CONCURRENCY, async (key) =>
    resolveArtifactPointer(store, await parseJson(store, key))
  );
  const unique = new Map<string, ArtifactReference>();
  for (const reference of references) {
    if (!reference || !isArtifactReference(reference) || reference.deletedAtISO) continue;
    if (!unique.has(reference.sha256)) unique.set(reference.sha256, reference);
  }
  return [...unique.values()].sort((a, b) => b.createdAtISO.localeCompare(a.createdAtISO)).slice(0, 100);
}

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });

  const access = await timeAuth(() => resolveAdminAccessFromEvent(event, context, binding));
  if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
  if (!access.isAdmin) return jsonResponse(403, { error: 'Admin access is required.' });

  const respond = (body: Record<string, unknown>) => {
    const serialized = timeSerialize(() => JSON.stringify({ ok: true, status: 200, ...body }));
    const etag = etagForSerialized(serialized);
    const ifNoneMatch = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      return { statusCode: 304, headers: { 'Cache-Control': CACHE_CONTROL, ETag: etag }, body: '' };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': CACHE_CONTROL, ETag: etag },
      body: serialized,
    };
  };

  try {
    const indexStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ArtifactIndexStore;

    /**
     * The two halves of this response are INDEPENDENT: the media listing is a
     * blob sweep of this tenant's artifact index, the template listing is one
     * cross-site HTTP POST to pdf-tool's `/mcp`. Running them back to back
     * paid for both in series on every load of the asset picker, and the
     * remote leg has no timeout of its own (lib/pdf-tool-client.ts) — a slow
     * pdf-tool cold start was added straight onto the sweep.
     *
     * `timeSection` splits the resulting `work` by QUESTION ASKED, so the
     * next Server-Timing read says which half is slow instead of leaving it
     * to another investigation.
     */
    const grant = buildPdfToolStorageGrant();
    const [images, pdfs, listed] = await Promise.all([
      timeSection('artifacts_image', () => listKind(indexStore, 'image')),
      timeSection('artifacts_pdf', () => listKind(indexStore, 'pdf')),
      // Same short-circuit as before: no grant, no call to pdf-tool at all.
      grant.ok ? timeSection('pdf_templates', () => listPlatformPdfTemplates(grant.grant, { limit: 100 })) : undefined,
    ]);

    const artifacts = [...images, ...pdfs]
      .map(projectEditorialArtifact)
      .filter((artifact) => artifact !== undefined)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    if (!grant.ok || !listed || !listed.ok) {
      return respond({ pdf_templates: [], artifacts, pdf_templates_available: false });
    }
    const rawTemplates = Array.isArray(listed.body.templates) ? listed.body.templates : [];
    const pdfTemplates = rawTemplates.map(projectPdfTemplate).filter((template) => template !== undefined);
    return respond({ pdf_templates: pdfTemplates, artifacts, pdf_templates_available: true });
  } catch (error) {
    console.error('Failed to load editorial assets.', error);
    return jsonResponse(500, { error: 'Templates and media could not be loaded.' });
  }
};

export const createHandler = (binding: SiteBinding) =>
  withServerTiming('admin-editorial-assets', buildHandlerImpl(binding));
