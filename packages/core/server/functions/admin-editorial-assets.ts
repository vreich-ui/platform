import { createHash } from 'node:crypto';

import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { getArtifactIndexBlobStore } from '../lib/blob-store.js';
import { listArtifactIndexKeys, resolveArtifactPointer, type ArtifactIndexStore } from '../lib/artifact-index.js';
import { isArtifactReference, type ArtifactReference } from '../lib/artifacts.js';
import { buildPdfToolStorageGrant } from '../lib/pdf-tool-storage-grant.js';
import { listPlatformPdfTemplates } from '../lib/pdf-tool-client.js';
import { projectEditorialArtifact, projectPdfTemplate } from '../../lib/admin/editorial-assets.js';
import { timeAuth, timeSerialize, withServerTiming } from '../lib/server-timing.js';

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

async function listKind(store: ArtifactIndexStore, kind: 'image' | 'pdf'): Promise<ArtifactReference[]> {
  const pointerKeys = await listArtifactIndexKeys(store, `by-kind/${kind}/`);
  const references = await Promise.all(
    pointerKeys.map(async (key) => resolveArtifactPointer(store, await parseJson(store, key)))
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
    const [images, pdfs] = await Promise.all([listKind(indexStore, 'image'), listKind(indexStore, 'pdf')]);
    const artifacts = [...images, ...pdfs]
      .map(projectEditorialArtifact)
      .filter((artifact) => artifact !== undefined)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    const grant = buildPdfToolStorageGrant();
    if (!grant.ok) {
      return respond({ pdf_templates: [], artifacts, pdf_templates_available: false });
    }
    const listed = await listPlatformPdfTemplates(grant.grant, { limit: 100 });
    if (!listed.ok) {
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
