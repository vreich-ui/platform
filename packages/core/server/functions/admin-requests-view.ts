/**
 * admin-requests-view (T5.1 Phase 2, T0.2 §6.1 / F13) — the request detail
 * page's live watch, read-only and conditional.
 *
 * ## What it replaces
 *
 * `RequestActivity.tsx` polls a run's activity every 3 s while it is live
 * (`activityPollIntervalFor`). Each tick paid THREE reads that never changed
 * after the first one — the request doc, just to re-learn a `run_id` and
 * `title` this browser already knows — plus the two CMS-Agent calls the run
 * itself needs (`workflow_get_run`, `workflow_get_run_cost`), and the whole
 * node tree crossed the wire again even when nothing had moved. T0.2 named
 * this F13 and R8 explicitly scoped it in ("Highest leverage on
 * `admin-requests`, `admin-request-activity`, …") but it was never done for
 * this endpoint — `admin-requests` and `admin-release-state` got their `ETag`
 * (R8), this one did not.
 *
 * This endpoint is that fix, landed as a new file rather than an in-place
 * edit to `admin-request-activity.ts` on purpose: THAT endpoint also carries
 * the approve/withhold decision (`workflow_set_operator_publish_decision` +
 * `workflow_run_all`) — a WRITE — and W19's law is that only the sweeper
 * writes a running request's status; an aggregate VIEW must never become a
 * second writer. Keeping the read and the decision on two different files
 * makes that boundary a file boundary, not just a convention. The decision
 * path is untouched; `RequestActivity.tsx`'s poll switches to this one.
 *
 * ## The caching win
 *
 * The client caches `run_id` and `title` after the first response — neither
 * ever changes for a given request — and sends `run_id` back on every
 * following poll. When `run_id` is present this handler skips `loadRequest`
 * entirely: **1 BR → 0 BR on every tick but the first**, for the whole
 * lifetime of a run being watched (T0.2 measured this surface at ~20
 * ticks/minute per open tab). `ETag` + `If-None-Match` -> `304` on top of
 * that (R8's shape), so an unmoved run also stops re-serialising and
 * re-transferring its node tree every 3 s.
 *
 * What this does NOT reduce: the two CMS-Agent reads. There is no
 * "has anything changed" probe on that bridge cheaper than reading the run,
 * so both calls still happen every tick — the saving is the request-doc BR
 * and, when unchanged, the response bytes, not the MCP round trips.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { SiteBinding } from '../lib/site-binding.js';
import { getAdminStateFromEvent, type LambdaContext } from '../lib/admin-auth.js';
import { getEditorialRequestsBlobStore } from '../lib/blob-store.js';
import { resolveRolesForPrincipalAsync } from '../lib/roles.js';
import { getUsersBlobStore, getUserRecord } from '../lib/users-store.js';
import type { Principal } from '../../schema/object-record-v1.js';
import { CmsAgentClient, isCmsAgentConfigured } from '../lib/agent/cms-agent-client.js';
import { loadRequest } from '../lib/requests/store.js';
import { projectActivity } from '../lib/requests/activity.js';

type LambdaEvent = {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
};

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const jsonResponse = (status: number, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) => ({
  statusCode: status,
  headers: { ...jsonHeaders, ...extraHeaders },
  body: JSON.stringify({ ok: status >= 200 && status < 300, status, ...body }),
});

/** R8's shape: authenticated data that is polled — revalidate always, but ALLOW revalidation. */
const CACHE_CONTROL = 'private, no-cache';
const etagFor = (body: unknown): string => `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;

/** One client per site process (the PF1 design), matching `admin-request-activity.ts`. */
const cmsAgentClient = new CmsAgentClient();

export const requestSchema = z
  .object({
    request_id: z.string().min(1).optional(),
    /** Cached client-side from a previous response — when present, skips the request-doc read. */
    run_id: z.string().min(1).optional(),
  })
  // W19: only the sweeper writes a running request's status. `.strict()`
  // rejects an `action` field (or anything else) outright rather than
  // silently dropping it — this endpoint has no code path that could act on
  // one even if it arrived, and the schema is the enforced proof of that,
  // not just the implementation's current shape. Decisions stay on
  // `admin-request-activity`.
  .strict()
  .refine((data) => Boolean(data.request_id || data.run_id), { message: 'Provide request_id or run_id.' });

const buildHandlerImpl = (_binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  const adminState = await getAdminStateFromEvent(event, context);
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });

  const callerPrincipal: Principal = { kind: 'human', id: adminState.userId ?? '', email: adminState.email ?? '' };
  const callerRoles = await resolveRolesForPrincipalAsync(callerPrincipal, {
    getUserRecord: async (email) => getUserRecord(await getUsersBlobStore(event), email),
  });
  // Read-only, and requests are team-wide readable (plan §8, admin-requests.ts's own precedent).
  if (!callerRoles.includes('admin')) return jsonResponse(403, { error: 'Admin access required' });

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
    let runId = request.data.run_id;
    let requestTitle: string | undefined;

    // The caching win: a `run_id` the client already has means this request's
    // identity is already resolved — no need to read the doc again to
    // re-learn a fact that cannot change.
    if (!runId && request.data.request_id) {
      const doc = await loadRequest(await getEditorialRequestsBlobStore(event), request.data.request_id);
      if (!doc) return jsonResponse(404, { error: 'Request not found.' });
      requestTitle = doc.title;
      runId = doc.workflow?.run_id;
      if (!runId) {
        // Same "no run YET vs no run EVER" distinction as admin-request-activity.ts.
        const mayStillStart = doc.status === 'queued' || doc.status === 'running';
        const body: Record<string, unknown> = {
          activity: null,
          title: requestTitle,
          reason: 'no_workflow_run',
          ...(mayStillStart ? { retry_ms: 10_000 } : {}),
        };
        return jsonResponse(200, body);
      }
    }

    if (!isCmsAgentConfigured()) {
      return jsonResponse(200, {
        activity: null,
        ...(requestTitle ? { title: requestTitle } : {}),
        ...(runId ? { run_id: runId } : {}),
        reason: 'cms_agent_unavailable',
      });
    }

    const [run, cost] = await Promise.all([
      cmsAgentClient.callTool<Record<string, unknown>>('workflow_get_run', { runId }),
      cmsAgentClient
        .callTool<Record<string, unknown>>('workflow_get_run_cost', { runId })
        .catch(() => ({ ok: false as const, code: 'cost_unavailable', message: '' })),
    ]);

    if (!run.ok) {
      return jsonResponse(200, {
        activity: null,
        ...(requestTitle ? { title: requestTitle } : {}),
        ...(runId ? { run_id: runId } : {}),
        reason: run.code || 'run_read_failed',
        retry_ms: 20_000,
      });
    }

    const activity = projectActivity(run.data, cost.ok ? cost.data : undefined);
    const body: Record<string, unknown> = {
      activity: activity ?? null,
      ...(requestTitle ? { title: requestTitle } : {}),
      // Handed back so the client can cache it and skip `loadRequest` next tick.
      ...(runId ? { run_id: runId } : {}),
      can_approve: callerRoles.includes('admin'),
    };

    const etag = etagFor(body);
    const ifNoneMatch = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      return { statusCode: 304, headers: { 'Cache-Control': CACHE_CONTROL, ETag: etag }, body: '' };
    }
    return jsonResponse(200, body, { 'Cache-Control': CACHE_CONTROL, ETag: etag });
  } catch (error) {
    console.error('Admin_Requests_View request failed.', error);
    return jsonResponse(500, { error: 'Activity could not be read.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
