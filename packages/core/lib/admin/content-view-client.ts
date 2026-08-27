/**
 * Browser wrapper over `admin-content-view` (T5.1 Phase 2, T0.2 §6.4 / F9) —
 * the object workspace's lock heartbeat.
 *
 * `ObjectWorkspace.tsx` used to re-fetch the WHOLE object record every four
 * seconds while a lock was visible, just to read one boolean and an expiry
 * timestamp (T0.2 F9). This is the lock-only projection instead: `ETag` +
 * `If-None-Match` honoured the same way `requests-client.ts`'s
 * `listRequestsIfChanged` does, so an unmoved lock between two heartbeats
 * comes back as a bodyless `304`.
 *
 * No module-scope cache here on purpose — unlike `release-client.ts` and
 * `editorial-view-client.ts`, this is polled directly by one component's own
 * interval, not fanned out to multiple mount sites, so there is nothing to
 * dedupe.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { ObjectType } from '../../schema/object-record-v1.js';

const ENDPOINT = '/.netlify/functions/admin-content-view';

export interface ObjectLockSummary {
  owner_id: string;
  owner_label: string;
  acquired_at: string;
  expires_at: string;
}

export interface ObjectLockView {
  locked: boolean;
  lock?: ObjectLockSummary;
  version: number;
}

async function request(getToken: GetToken, objectType: ObjectType, objectId: string): Promise<Response> {
  const token = await getToken();
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ object_type: objectType, object_id: objectId }),
  });
}

export async function fetchObjectLockStatus(
  getToken: GetToken,
  objectType: ObjectType,
  objectId: string
): Promise<ObjectLockView> {
  const response = await request(getToken, objectType, objectId);
  const body = (await response.json().catch(() => ({}))) as ObjectLockView & { error?: string };
  if (!response.ok) throw new Error(body.error || `Lock status request failed (${response.status}).`);
  return body;
}

/**
 * The conditional form (F9 + R8): pass the previous response's `ETag` back as
 * `If-None-Match`; an unmoved lock comes back `304` with no body, and the
 * caller keeps the view it already has.
 */
export async function fetchObjectLockStatusIfChanged(
  getToken: GetToken,
  objectType: ObjectType,
  objectId: string,
  etag: string | undefined
): Promise<{ unchanged: true; etag: string | undefined } | { unchanged: false; view: ObjectLockView; etag?: string }> {
  const token = await getToken();
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(etag ? { 'If-None-Match': etag } : {}),
    },
    body: JSON.stringify({ object_type: objectType, object_id: objectId }),
  });
  if (response.status === 304) return { unchanged: true, etag: response.headers.get('etag') ?? etag };
  const body = (await response.json().catch(() => ({}))) as ObjectLockView & { error?: string };
  if (!response.ok) throw new Error(body.error || `Lock status request failed (${response.status}).`);
  const nextEtag = response.headers.get('etag');
  return { unchanged: false, view: body, ...(nextEtag ? { etag: nextEtag } : {}) };
}
