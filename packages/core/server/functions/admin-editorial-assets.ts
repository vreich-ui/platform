import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { getArtifactIndexBlobStore } from '../lib/blob-store.js';
import { listArtifactIndexKeys, resolveArtifactPointer, type ArtifactIndexStore } from '../lib/artifact-index.js';
import { isArtifactReference, type ArtifactReference } from '../lib/artifacts.js';
import { buildPdfToolStorageGrant } from '../lib/pdf-tool-storage-grant.js';
import { listPlatformPdfTemplates } from '../lib/pdf-tool-client.js';
import { projectEditorialArtifact, projectPdfTemplate } from '../../lib/admin/editorial-assets.js';

type LambdaEvent = {
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
};

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});

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

  const access = await resolveAdminAccessFromEvent(event, context, binding);
  if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
  if (!access.isAdmin) return jsonResponse(403, { error: 'Admin access is required.' });

  try {
    const indexStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ArtifactIndexStore;
    const [images, pdfs] = await Promise.all([listKind(indexStore, 'image'), listKind(indexStore, 'pdf')]);
    const artifacts = [...images, ...pdfs]
      .map(projectEditorialArtifact)
      .filter((artifact) => artifact !== undefined)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    const grant = buildPdfToolStorageGrant();
    if (!grant.ok) {
      return jsonResponse(200, { pdf_templates: [], artifacts, pdf_templates_available: false });
    }
    const listed = await listPlatformPdfTemplates(grant.grant, { limit: 100 });
    if (!listed.ok) {
      return jsonResponse(200, { pdf_templates: [], artifacts, pdf_templates_available: false });
    }
    const rawTemplates = Array.isArray(listed.body.templates) ? listed.body.templates : [];
    const pdfTemplates = rawTemplates.map(projectPdfTemplate).filter((template) => template !== undefined);
    return jsonResponse(200, { pdf_templates: pdfTemplates, artifacts, pdf_templates_available: true });
  } catch (error) {
    console.error('Failed to load editorial assets.', error);
    return jsonResponse(500, { error: 'Templates and media could not be loaded.' });
  }
};

export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
