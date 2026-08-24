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
  /**
   * W19: the approval a run is waiting on, taken from the surface that shows
   * it. Absent = the read this function has always been.
   *
   * `approve` is TWO facts, not one, because a run stopped at
   * publication_controller needs both and giving only the first leaves the
   * editor stuck one step later with no new button to press: the durable
   * operator decision (`workflow.set_operator_publish_decision`), then the
   * advance that lets the publish-risk nodes execute
   * (`workflow.run_all` with `approved`). `withhold` records the operator VETO,
   * which is what makes this decision reversible rather than a one-way door.
   */
  action: z.enum(['approve', 'withhold']).optional(),
});

/**
 * CMS-Agent answers a scoped site token the SAME 401 whether the token is wrong
 * or whether the token is fine and the tool is simply not on its allowlist
 * (`MCP_SCOPED_TOKENS_JSON` → `toolAllowlist`, enforced by the endpoint's
 * `isScopedMessageAllowed` before dispatch). That sameness is deliberate on
 * their side — it stops a caller enumerating which tools a stolen token can
 * reach — so this side must not try to tell the two apart.
 *
 * What this side CAN do is say what it just asked for. Hit for real on the
 * first press of the approve button: reads through the site token worked, the
 * write came back "CMS-Agent rejected the credential", and the operator went
 * hunting a credential that was never broken — the actual cause was one tool
 * name missing from an allowlist. On an auth failure the message now names the
 * tools the request attempted; on anything else the bridge's copy stands.
 */
const scopeAwareMessage = (code: string | undefined, message: string, attempted: readonly string[]): string =>
  code === 'cms_agent_auth_failed'
    ? `${message} Also check that this site's CMS-Agent token allows ${attempted.join(', ')} — a tool missing from the token's allowlist is refused with this same response.`
    : message;

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

    // The decision, before the read — so the activity returned below is the
    // state AFTER the approval, and the editor sees the run move rather than
    // the same "waiting for you" card until the next poll.
    if (request.data.action) {
      if (!runId) return jsonResponse(400, { error: 'That request has no run to act on yet.' });
      const decision = request.data.action === 'approve' ? 'approved' : 'withheld';
      const decided = await cmsAgentClient.callTool<Record<string, unknown>>(
        'workflow_set_operator_publish_decision',
        { runId, decision }
      );
      if (!decided.ok) {
        return jsonResponse(200, {
          activity: null,
          ...(requestTitle ? { title: requestTitle } : {}),
          reason: decided.code || 'decision_failed',
          error: scopeAwareMessage(decided.code, decided.message, ['workflow_set_operator_publish_decision']),
        });
      }
      if (request.data.action === 'approve') {
        // Bounded on purpose: this is an interactive request, and the run
        // continues on the scheduled tick if the driver runs out of budget.
        // A failure here is reported but does NOT undo the decision above —
        // the operator's approval is durable and the next advance picks it up.
        const advanced = await cmsAgentClient.callTool<Record<string, unknown>>('workflow_run_all', {
          runId,
          budgetMs: 20_000,
          approved: true,
        });
        if (!advanced.ok) {
          return jsonResponse(200, {
            activity: null,
            ...(requestTitle ? { title: requestTitle } : {}),
            reason: advanced.code || 'advance_failed',
            error: scopeAwareMessage(advanced.code, advanced.message, ['workflow_run_all']),
            retry_ms: 10_000,
          });
        }
      }
      console.info('Admin_Request_Activity publish decision', {
        runId,
        decision,
        by: callerPrincipal.email,
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
    return jsonResponse(200, {
      activity: activity ?? null,
      ...(requestTitle ? { title: requestTitle } : {}),
      // The browser offers the button exactly when this function would accept
      // it — one source of truth for the permission, so a surface can never
      // show an approve control that the server then refuses.
      can_approve: callerRoles.includes('admin'),
    });
  } catch (error) {
    console.error('Admin_Request_Activity request failed.', error);
    return jsonResponse(500, { error: 'Activity could not be read.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
