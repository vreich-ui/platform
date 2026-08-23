/**
 * Function name: Admin_Request_Activity (W19) — the live watch path.
 *
 * TWO CADENCES, and this is the fast one. `editorial-request-sweep` (5 min) is
 * the AWAY path: it keeps the record true when nobody is looking. This endpoint
 * is the WATCHING path: while an editor has the request open, the browser polls
 * it every few seconds and sees nodes move.
 *
 * Read-only and side-effect-free by construction: two CMS-Agent reads
 * (`workflow_get_run`, `workflow_get_run_cost`), projected through
 * `requests/activity.ts`. It never writes a request doc, never advances a run,
 * and never consumes a chat run — so watching costs nothing but the read, and
 * works whether or not a chat is open.
 */
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
const jsonResponse = (status: number, body: Record<string, unknown>) => ({
  statusCode: status,
  headers: jsonHeaders,
  body: JSON.stringify({ ok: status >= 200 && status < 300, status, ...body }),
});

/** One client per site process (the PF1 design): the MCP session survives warm invocations. */
const cmsAgentClient = new CmsAgentClient();

export const requestSchema = z.object({
  request_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
});

const buildHandlerImpl = (_binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  const adminState = await getAdminStateFromEvent(event, context);
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });

  const callerPrincipal: Principal = { kind: 'human', id: adminState.userId ?? '', email: adminState.email ?? '' };
  const callerRoles = await resolveRolesForPrincipalAsync(callerPrincipal, {
    getUserRecord: async (email) => getUserRecord(await getUsersBlobStore(event), email),
  });
  // Read-only, and requests are team-wide readable (plan §8) — the admin wall is the whole gate.
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
  if (!request.data.request_id && !request.data.run_id) {
    return jsonResponse(400, { error: 'Provide request_id or run_id.' });
  }

  try {
    let runId = request.data.run_id;
    let requestTitle: string | undefined;
    if (request.data.request_id) {
      const doc = await loadRequest(await getEditorialRequestsBlobStore(event), request.data.request_id);
      if (!doc) return jsonResponse(404, { error: 'Request not found.' });
      requestTitle = doc.title;
      runId = doc.workflow?.run_id ?? runId;
      if (!runId) {
        // A registered request with no workflow behind it has no activity to
        // show, and saying so is not an error. But "no run YET" and "no run
        // EVER" look identical from the browser, so the server — which knows
        // the request's own status — decides whether to come back: a job still
        // starting will have a run in a moment; a non-workflow request (plan
        // D7) or a closed one never will.
        const mayStillStart = doc.status === 'queued' || doc.status === 'running';
        return jsonResponse(200, {
          activity: null,
          title: requestTitle,
          reason: 'no_workflow_run',
          ...(mayStillStart ? { retry_ms: 10_000 } : {}),
        });
      }
    }

    if (!isCmsAgentConfigured()) {
      // Unconfigured is permanent for this deploy — there is nothing to wait for.
      return jsonResponse(200, {
        activity: null,
        ...(requestTitle ? { title: requestTitle } : {}),
        reason: 'cms_agent_unavailable',
      });
    }

    const [run, cost] = await Promise.all([
      cmsAgentClient.callTool<Record<string, unknown>>('workflow_get_run', { runId }),
      // The cost ledger carries the timing history the ETA is built from. It is
      // optional: an unavailable ledger costs the estimate, not the view.
      cmsAgentClient
        .callTool<Record<string, unknown>>('workflow_get_run_cost', { runId })
        .catch(() => ({ ok: false as const, code: 'cost_unavailable', message: '' })),
    ]);

    if (!run.ok) {
      // A read that failed is a fact about the bridge, not about the article —
      // it must never permanently freeze the live view of a running run.
      return jsonResponse(200, {
        activity: null,
        ...(requestTitle ? { title: requestTitle } : {}),
        reason: run.code || 'run_read_failed',
        retry_ms: 20_000,
      });
    }

    const activity = projectActivity(run.data, cost.ok ? cost.data : undefined);
    return jsonResponse(200, { activity: activity ?? null, ...(requestTitle ? { title: requestTitle } : {}) });
  } catch (error) {
    console.error('Admin_Request_Activity request failed.', error);
    return jsonResponse(500, { error: 'Activity could not be read.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
