/**
 * admin-content-view (T5.1 Phase 2, T0.2 §6.4) — the object workspace's
 * lock-refresh poll, projected to what it actually needs.
 *
 * ## What it replaces
 *
 * `ObjectWorkspace.tsx`'s `setInterval(refreshLock, 4000)` (T0.2 F9) re-read
 * the WHOLE `ObjectRecord` — full body node tree, full unbounded `history` —
 * every four seconds while a lock was visible on screen, to observe one
 * boolean and an expiry timestamp. `object-lock.ts`'s `objectLockStatus`
 * already existed for exactly this projection (`{action:'status', locked,
 * lock, version}`) but was never wired to any HTTP endpoint or object-verb
 * action — dead code. This file wires it up.
 *
 * ## What it deliberately does NOT do
 *
 * T0.2 §6.4 sketches a much larger `admin-content-view`: a "library" mode
 * (folding `admin-object {action:'inventory'}` and `admin-release-state`
 * together) and a "workspace" mode (record + release + validate + chat +
 * taxonomy + browser, all in one call). Both are re-derived here against
 * CURRENT `main`, not built, because both are already close to free:
 *
 *   - `ContentLibrary`'s two mount calls (`fetchInventoryRows`,
 *     `fetchReleaseOverview`) already hit T5.1 R3's etag-verified index
 *     projection and R2's memoized + module-deduped release overview — 1 BR
 *     each on a warm path, both already parallel, both already module-scope
 *     cached across an Astro `ClientRouter` navigation (T5.1 R4). Merging them
 *     into one HTTP round trip would save one network hop, not blob reads.
 *   - `ObjectWorkspace`'s mount (`record` + `release overview` + `validate` +
 *     `createObjectChat`) already fires as one `Promise.all` (T5.1 R1) — the
 *     three-hop serial waterfall T0.2 F1 found is gone. What is left is
 *     already-parallel round trips against already-cheap (R2/R3-backed)
 *     reads, not a sweep.
 *
 * Building the full merge on top of that would mostly re-package a win R1/R2/
 * R3 already banked, for "N round trips → 1" where N is already 1–2 and
 * parallel rather than serial. The one part of this surface that is NOT
 * already at its floor — nothing before this task touched it — is the lock
 * poll, so this endpoint is scoped to exactly that rather than shipping a
 * wider aggregate that would mostly duplicate existing, working code.
 *
 * ## Cost
 *
 * Server: unchanged at 1 BR. The lock lives inside the `ObjectRecord`
 * envelope — there is no separate lock document — so `objectLockStatus` still
 * has to load the record once, same as the old poll. What changes is the
 * WIRE: the response drops from the whole envelope (unbounded body tree +
 * unbounded history) to four fixed fields (`action`, `locked`, `lock`,
 * `version`). `ETag` + `If-None-Match` -> `304` on top of that, since two
 * editors' 4 s heartbeats overwhelmingly find the lock unmoved between ticks.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { objectLockStatus, type ObjectLockStore } from '../lib/object-lock.js';
import { objectRecordKey } from '../lib/object-store-keys.js';
import { objectTypeSchema } from '../../schema/object-record-v1.js';

type LambdaEvent = {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
};

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const jsonResponse = (
  statusCode: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
) => ({
  statusCode,
  headers: { ...jsonHeaders, ...extraHeaders },
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});

/** R8's shape: authenticated data that is polled — revalidate always, but ALLOW revalidation. */
const CACHE_CONTROL = 'private, no-cache';
const etagFor = (body: unknown): string => `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;

export const requestSchema = z.object({
  object_type: objectTypeSchema,
  object_id: z.string().min(1),
});

const buildHandlerImpl = (_binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  const access = await resolveAdminAccessFromEvent(event, context);
  if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
  if (!access.isAdmin) return jsonResponse(403, { error: 'Admin access is required.' });

  let parsedBody: unknown;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    parsedBody = JSON.parse(raw);
  } catch {
    return jsonResponse(400, { error: 'Invalid request body.' });
  }
  const request = requestSchema.safeParse(parsedBody);
  if (!request.success) return jsonResponse(400, { error: 'Invalid request fields.', issues: request.error.issues });

  try {
    const store = (await getSiteObjectsBlobStore(event)) as unknown as ObjectLockStore;
    const key = objectRecordKey(request.data.object_type, request.data.object_id);
    const result = await objectLockStatus(store, key);
    if (result.status !== 200) return jsonResponse(result.status, result.body);

    const etag = etagFor(result.body);
    const ifNoneMatch = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      return { statusCode: 304, headers: { 'Cache-Control': CACHE_CONTROL, ETag: etag }, body: '' };
    }
    return jsonResponse(200, result.body, { 'Cache-Control': CACHE_CONTROL, ETag: etag });
  } catch (error) {
    console.error('Failed to read the object lock status.', error);
    return jsonResponse(500, { error: 'Lock status could not be read.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
