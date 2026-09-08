import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { isArtifactReference, isDeletedArtifactReference, type ArtifactReference } from '../lib/artifacts.js';
import { listArtifactIndexKeys, resolveArtifactPointer, type ArtifactIndexStore } from '../lib/artifact-index.js';
import { getArtifactIndexBlobStore } from '../lib/blob-store.js';

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

type LambdaEvent = {
  blobs?: string;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
};

const requestArtifactPrefix = 'request-artifacts/';
const imageArtifactKind = 'image';

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: jsonHeaders,
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});

const getRequestArtifactPrefix = (requestId: string | undefined) => {
  const trimmed = requestId?.trim();

  return trimmed ? `${requestArtifactPrefix}${encodeURIComponent(trimmed)}/` : requestArtifactPrefix;
};

const getImageArtifactPointerPrefix = (requestId: string | undefined) => {
  const trimmed = requestId?.trim();

  return trimmed ? `by-request/${encodeURIComponent(trimmed)}/${imageArtifactKind}/` : `by-kind/${imageArtifactKind}/`;
};

const parseJsonBlob = async (store: ArtifactIndexStore, key: string) => {
  const raw = await store.get(key);
  if (!raw) return undefined;

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

const isImageArtifactReference = (reference: ArtifactReference) => {
  return reference.contentType.toLowerCase().startsWith('image/') || reference.blobKey.startsWith('image/');
};

const listImageArtifacts = async (indexStore: ArtifactIndexStore, requestId: string | undefined) => {
  const pointerKeys = await listArtifactIndexKeys(indexStore, getImageArtifactPointerPrefix(requestId));
  const candidates = pointerKeys.length
    ? await Promise.all(
        pointerKeys.map(async (key) => resolveArtifactPointer(indexStore, await parseJsonBlob(indexStore, key)))
      )
    : await Promise.all(
        (await listArtifactIndexKeys(indexStore, getRequestArtifactPrefix(requestId))).map(async (key) => {
          const parsed = await parseJsonBlob(indexStore, key);
          return isArtifactReference(parsed) ? parsed : undefined;
        })
      );

  return candidates.filter((reference): reference is ArtifactReference =>
    Boolean(reference && !isDeletedArtifactReference(reference) && isImageArtifactReference(reference))
  );
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const adminState = await resolveAdminAccessFromEvent(event, context, binding);
  if (!adminState.authenticated) {
    return jsonResponse(401, {
      error: adminState.error || 'Authentication is required.',
    });
  }

  if (!adminState.isAdmin) {
    return jsonResponse(403, { error: 'This user is not authorized to list blob image artifacts.' });
  }

  try {
    const indexStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ArtifactIndexStore;
    const images = await listImageArtifacts(indexStore, event.queryStringParameters?.requestId);

    return jsonResponse(200, { images, skipped: 0 });
  } catch (error) {
    console.error('Failed to list admin blob image artifacts.', error);

    return jsonResponse(500, { error: 'Blob image artifacts could not be listed.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
