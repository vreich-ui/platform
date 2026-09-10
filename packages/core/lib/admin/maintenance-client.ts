/**
 * Maintenance client (T9.24 reskin of /admin/blobs) — browser wrappers over
 * admin-blob-manager (action-dispatched POST) and admin-blob-store-diagnostics
 * (GET). Both are Owner-only; the server 403s a non-owner on every call
 * (T9.4) — this client surfaces that as a thrown Error, same as users-client.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { BlobStoreSourceDiagnostics } from '../../server/lib/blob-store.js';

const MANAGER_ENDPOINT = '/.netlify/functions/admin-blob-manager';
const DIAGNOSTICS_ENDPOINT = '/.netlify/functions/admin-blob-store-diagnostics';

export interface BlobArtifactMetadata {
  label?: string;
  originalFilename?: string;
  tags?: string[];
  createdAtISO?: string;
  sizeBytes?: number;
  artifactKind?: 'image' | 'pdf' | 'video' | 'audio' | 'doc' | string;
  contentType?: string;
}

export interface BlobDetail {
  store: string;
  key: string;
  size: number;
  metadata: Record<string, unknown>;
  contentType?: string;
  encoding: 'text' | 'base64';
  truncated: boolean;
  content: string;
}

/**
 * Shape of `getBlobStoreSourceDiagnostics`'s `siteId` field (server:
 * packages/core/server/lib/blob-store.ts). It is NOT a string — it names the
 * env var the site id was read from, whether one was present, and a
 * last-4-chars redacted preview safe to show an operator. Named so it isn't
 * re-inlined (and re-mistyped as `string`) at another call site.
 */
export type StoreDiagnostic = BlobStoreSourceDiagnostics;
export type SiteIdDiagnostic = StoreDiagnostic['siteId'];

/**
 * Narrow a `siteId` diagnostic field to a renderable shape, regardless of
 * whether it arrived as the current structured object or (from an older
 * server build, or a stale cached response) a plain string. Never throws —
 * used directly as a React child input, so a render error here would
 * reproduce the exact crash this type fixes.
 */
export function normalizeSiteIdDiagnostic(value: unknown): SiteIdDiagnostic {
  if (typeof value === 'string') {
    return { envVar: undefined, present: value.length > 0, redacted: value };
  }
  if (value && typeof value === 'object') {
    const candidate = value as Partial<SiteIdDiagnostic>;
    return {
      envVar: candidate.envVar === 'NETLIFY_SITE_ID' || candidate.envVar === 'SITE_ID' ? candidate.envVar : undefined,
      present: Boolean(candidate.present),
      redacted: typeof candidate.redacted === 'string' ? candidate.redacted : '',
    };
  }
  return { envVar: undefined, present: false, redacted: '' };
}

async function callManager<T>(getToken: GetToken, action: string, payload: Record<string, unknown> = {}) {
  const token = await getToken();
  const res = await fetch(MANAGER_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json.ok === false) throw new Error((json.error as string) || `Request failed (${res.status}).`);
  return json as T;
}

export const listStores = (getToken: GetToken) => callManager<{ stores: string[] }>(getToken, 'list-stores');

export const listBlobs = (getToken: GetToken, store: string, search?: string) =>
  callManager<{ store: string; count: number; truncated: boolean; keys: string[] }>(getToken, 'list-blobs', {
    store,
    search: search ?? '',
  });

export const getBlob = (getToken: GetToken, store: string, key: string) =>
  callManager<BlobDetail>(getToken, 'get-blob', { store, key });

export const setBlob = (
  getToken: GetToken,
  params: { store: string; key: string; content: string; contentType?: string }
) => callManager<{ store: string; key: string }>(getToken, 'set-blob', { encoding: 'text', ...params });

export const deleteBlob = (getToken: GetToken, store: string, key: string) =>
  callManager<{ store: string; key: string }>(getToken, 'delete-blob', { store, key });

export const duplicateBlob = (getToken: GetToken, store: string, key: string, targetKey: string) =>
  callManager<{ store: string; key: string; targetKey: string }>(getToken, 'duplicate-blob', {
    store,
    key,
    targetKey,
  });

export const renameBlob = (getToken: GetToken, store: string, key: string, targetKey: string) =>
  callManager<{ store: string; key: string; targetKey: string }>(getToken, 'rename-blob', { store, key, targetKey });

export const wipeStore = (getToken: GetToken, store: string) =>
  callManager<{ store: string; deleted: number }>(getToken, 'wipe-store', { store });

export const wipeAll = (getToken: GetToken) =>
  callManager<{ stores: Array<{ store: string; deleted: number }>; totalDeleted: number }>(getToken, 'wipe-all', {
    confirm: 'WIPE ALL',
  });

export const getArtifactMetadata = (getToken: GetToken, blobKey: string) =>
  callManager<{ artifact: BlobArtifactMetadata }>(getToken, 'get-artifact-metadata', { blobKey });

export const fetchDiagnostics = async (getToken: GetToken, signal?: AbortSignal) => {
  const token = await getToken();
  const res = await fetch(DIAGNOSTICS_ENDPOINT, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(signal ? { signal } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json.ok === false) throw new Error((json.error as string) || `Request failed (${res.status}).`);
  return json as {
    diagnostics: {
      workflows: StoreDiagnostic;
      siteObjects: StoreDiagnostic;
      artifactIndex: StoreDiagnostic;
      artifacts: StoreDiagnostic;
    };
  };
};
