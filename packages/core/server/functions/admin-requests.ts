/**
 * Function name: Admin_Requests (W19 T19.2) — the editorial request registry's
 * read/manage door.
 *
 * `list` is deliberately ONE blob GET: it reads `requests/index.json` and never
 * falls back to an N-read scan (plan F7 — the shell polls this). A missing or
 * unparseable index is rebuilt ONCE and the response says so (`rebuilt: true`)
 * rather than degrading to O(N) silently.
 *
 * VISIBILITY (plan §8, a deliberate departure from `agent/chat-visibility.ts`):
 * requests are TEAM-WIDE readable. Any signed-in admin sees every request on
 * the site; `mine` is a view, not a wall. Archive/unarchive is Owner or
 * publisher; cancel is the creator or an Owner; mute is self-only. Do not
 * "fix" the read rule back to creator-scoped — a stalled article belonging to
 * a colleague is the desk's problem, which is the whole point of the surface.
 */
import { z } from 'zod';

import type { SiteBinding } from '../lib/site-binding.js';
import { CmsAgentClient, isCmsAgentConfigured } from '../lib/agent/cms-agent-client.js';
import { getAdminStateFromEvent, type LambdaContext } from '../lib/admin-auth.js';
import { getEditorialRequestsBlobStore } from '../lib/blob-store.js';
import { isOwner, resolveRolesForPrincipalAsync, type Role } from '../lib/roles.js';
import { getUsersBlobStore, getUserRecord } from '../lib/users-store.js';
import type { Principal } from '../../schema/object-record-v1.js';
import {
  archiveRequest,
  cancelRequest,
  loadIndex,
  loadRequest,
  rebuildIndex,
  unarchiveRequest,
  requestStatusSchema,
  type EditorialRequestStore,
  type RequestIndexRow,
} from '../lib/requests/store.js';
import { filterRequestRows, sortRequestRows, type RequestListFilters } from '../../lib/admin/request-logic.js';
import { loadNotifyState, muteRequest, unmuteRequest } from '../lib/requests/notify-state.js';

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

/** Page size for `list`. The index is bounded already; this bounds the wire. */
export const REQUEST_PAGE_SIZE = 100;

/** One client per site process (the PF1 design), so a cancel can reach the run. */
const cmsAgentClient = new CmsAgentClient();

/**
 * Cancelling the RECORD without cancelling the RUN would leave the workflow
 * executing — spending budget, and still walking toward its publish gate —
 * while the desk reads "Cancelled". Best-effort by design: an unreachable
 * bridge must not block a human from closing a request, so the failure is
 * recorded in the request's own history rather than thrown at the caller.
 */
const cancelWorkflowRun = async (runId: string): Promise<string | undefined> => {
  if (!isCmsAgentConfigured()) return 'cms_agent_unavailable';
  try {
    const result = await cmsAgentClient.callTool('workflow_cancel_run', { runId });
    return result.ok ? undefined : result.code || 'cancel_failed';
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 120) : 'cancel_threw';
  }
};

/** Exported for the contract test (the admin-governance.test.ts precedent: no auth-injection seam exists). */
export const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list'),
    status: z.array(requestStatusSchema).optional(),
    kind: z.array(z.string().min(1)).optional(),
    mine: z.boolean().optional(),
    archived: z.boolean().optional(),
    q: z.string().max(200).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.number().int().positive().max(REQUEST_PAGE_SIZE).optional(),
  }),
  z.object({ action: z.literal('get'), request_id: z.string().min(1) }),
  z.object({ action: z.literal('archive'), request_id: z.string().min(1) }),
  z.object({ action: z.literal('unarchive'), request_id: z.string().min(1) }),
  z.object({ action: z.literal('cancel'), request_id: z.string().min(1), reason: z.string().max(2000).optional() }),
  z.object({ action: z.literal('mute'), request_id: z.string().min(1) }),
  z.object({ action: z.literal('unmute'), request_id: z.string().min(1) }),
]);

/** Archive/unarchive: Owner, or the W18 publisher tier (plan §8). Exported for the gating test. */
export const canArchive = (roles: readonly Role[]): boolean => isOwner(roles) || roles.includes('publisher');

/**
 * The index, rebuilding ONCE when it is absent or unreadable. Never scans on
 * the happy path — see the module header.
 */
const readIndex = async (
  store: EditorialRequestStore
): Promise<{ rows: RequestIndexRow[]; seq: number; rebuilt: boolean }> => {
  const existing = await loadIndex(store);
  if (existing) return { rows: existing.rows, seq: existing.seq, rebuilt: false };
  const rebuilt = await rebuildIndex(store);
  return { rows: rebuilt.rows, seq: rebuilt.seq, rebuilt: true };
};

const buildHandlerImpl = (_binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  const adminState = await getAdminStateFromEvent(event, context);
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });

  const callerPrincipal: Principal = { kind: 'human', id: adminState.userId ?? '', email: adminState.email ?? '' };
  const callerRoles = await resolveRolesForPrincipalAsync(callerPrincipal, {
    getUserRecord: async (email) => getUserRecord(await getUsersBlobStore(event), email),
  });
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

  const callerEmail = (adminState.email ?? '').trim().toLowerCase();

  try {
    const store = await getEditorialRequestsBlobStore(event);

    switch (request.data.action) {
      case 'list': {
        const { rows, seq, rebuilt } = await readIndex(store);
        const filters: RequestListFilters = {
          ...(request.data.status ? { status: request.data.status } : {}),
          ...(request.data.kind ? { kind: request.data.kind } : {}),
          ...(request.data.mine !== undefined ? { mine: request.data.mine } : {}),
          ...(request.data.archived !== undefined ? { archived: request.data.archived } : {}),
          ...(request.data.q ? { q: request.data.q } : {}),
          callerEmail,
        };
        const matched = sortRequestRows(filterRequestRows(rows, filters));
        const limit = request.data.limit ?? REQUEST_PAGE_SIZE;
        const start = request.data.cursor ? Math.max(0, Number.parseInt(request.data.cursor, 10) || 0) : 0;
        const page = matched.slice(start, start + limit);
        const nextCursor = start + limit < matched.length ? String(start + limit) : undefined;
        const notify = await loadNotifyState(store, callerEmail);
        return jsonResponse(200, {
          requests: page,
          total: matched.length,
          seq,
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
          ...(rebuilt ? { rebuilt: true } : {}),
          muted: notify?.muted ?? [],
        });
      }

      case 'get': {
        const doc = await loadRequest(store, request.data.request_id);
        if (!doc) return jsonResponse(404, { error: 'Request not found.' });
        return jsonResponse(200, { request: doc });
      }

      case 'archive':
      case 'unarchive': {
        if (!canArchive(callerRoles)) {
          return jsonResponse(403, { error: 'Owner or publisher access required to archive a request.' });
        }
        const doc =
          request.data.action === 'archive'
            ? await archiveRequest(store, request.data.request_id, callerEmail)
            : await unarchiveRequest(store, request.data.request_id, callerEmail);
        if (!doc) return jsonResponse(404, { error: 'Request not found.' });
        return jsonResponse(200, { request: doc });
      }

      case 'cancel': {
        const existing = await loadRequest(store, request.data.request_id);
        if (!existing) return jsonResponse(404, { error: 'Request not found.' });
        const isCreator = existing.created_by.trim().toLowerCase() === callerEmail;
        if (!isCreator && !isOwner(callerRoles)) {
          return jsonResponse(403, { error: 'Only the editor who asked for this, or an Owner, can cancel it.' });
        }
        const runCancelFailure = existing.workflow?.run_id
          ? await cancelWorkflowRun(existing.workflow.run_id)
          : undefined;
        const reason = request.data.reason
          ? request.data.reason
          : runCancelFailure
            ? `Cancelled by ${callerEmail}. The workflow run could not be stopped (${runCancelFailure}) — check it on the workspace surface.`
            : undefined;
        const doc = await cancelRequest(store, request.data.request_id, {
          by: callerEmail,
          ...(reason ? { reason } : {}),
        });
        return jsonResponse(200, {
          request: doc,
          ...(runCancelFailure ? { run_cancel_failed: runCancelFailure } : {}),
        });
      }

      case 'mute':
      case 'unmute': {
        const state =
          request.data.action === 'mute'
            ? await muteRequest(store, callerEmail, request.data.request_id)
            : await unmuteRequest(store, callerEmail, request.data.request_id);
        return jsonResponse(200, { muted: state.muted });
      }
    }
  } catch (error) {
    console.error('Admin_Requests request failed.', error);
    return jsonResponse(500, { error: 'Request registry call could not be processed.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
