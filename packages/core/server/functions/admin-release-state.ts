/**
 * admin-release-state — the publication-state overview: every governed
 * object's editorial state plus the production deploy's identity.
 *
 * T5.1 R2 (T0.2 F2/F3). This was the most expensive read on the admin: an
 * object-store inventory sweep, two Netlify deploys-API calls, and one GitHub
 * `/compare` per distinct publish commit — on every request, uncached, from
 * seven client call sites, two of them on the SAME page load. T0.2 timed it as
 * the gate on `/admin`'s first paint.
 *
 * The work itself now lives in `server/lib/release-overview.ts`, behind a
 * warm-instance memo shared with `admin-editorial-view`, so whichever endpoint
 * runs first pays and the other is free. This file is the HTTP skin over it:
 *
 *  - `ETag` + `If-None-Match` -> `304`, following `admin-analytics.ts`'s
 *    precedent (T0.2 found zero ETags anywhere in `server/functions/`);
 *  - `Cache-Control: private, no-cache` — always revalidate, but ALLOW
 *    revalidation, which the old blanket `no-store` forbade, so a poll
 *    returning byte-identical JSON re-serialised and re-transferred all of it.
 *
 * The browser side pairs with `lib/admin/release-client.ts`, which dedupes
 * concurrent callers and TTL-caches the result at module scope so it survives
 * an Astro `ClientRouter` navigation.
 */
import { createHash } from 'node:crypto';

import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { loadReleaseOverview, ReleaseOverviewUnavailableError } from '../lib/release-overview.js';

type LambdaEvent = {
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
};

const jsonResponse = (
  statusCode: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});

/** R8: authenticated data that is polled — revalidate always, but ALLOW revalidation. */
const CACHE_CONTROL = 'private, no-cache';

const etagFor = (body: unknown): string => `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;

const buildHandlerImpl = (_binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });
  const access = await resolveAdminAccessFromEvent(event, context);
  if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
  if (!access.isAdmin || !access.email) return jsonResponse(403, { error: 'Admin access is required.' });

  try {
    const overview = await loadReleaseOverview(event, {
      userId: access.userId,
      email: access.email,
      roles: access.roles,
    });
    // `rows` is the raw inventory the overview was derived from — internal to
    // the shared builder, never part of this endpoint's wire contract.
    const body: Record<string, unknown> = {
      deploy: overview.deploy,
      objects: overview.objects,
      waiting_count: overview.waiting_count,
      pending_approval_count: overview.pending_approval_count,
    };
    const etag = etagFor(body);
    const ifNoneMatch = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      return { statusCode: 304, headers: { 'Cache-Control': CACHE_CONTROL, ETag: etag }, body: '' };
    }
    return jsonResponse(200, body, { 'Cache-Control': CACHE_CONTROL, ETag: etag });
  } catch (error) {
    if (error instanceof ReleaseOverviewUnavailableError) {
      return jsonResponse(500, { error: 'Publication state could not be loaded.' });
    }
    console.error('Failed to load release state.', error);
    return jsonResponse(500, { error: 'Release state could not be loaded.' });
  }
};

export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
