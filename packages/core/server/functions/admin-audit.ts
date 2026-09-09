/**
 * Function name: Admin_Audit
 * Required method: POST
 * Auth: Netlify Identity (Admin). Read-only.
 *
 * The home-page data source (T9.11): one sweep of the object store yields the
 * attention inbox (pending reviews, unpublished changes, held locks) and a
 * bounded newest-first activity feed. No writes, no new stored state — pure
 * aggregation over the `history[]` / `review` / `lock` / `publication` envelope
 * fields the verbs already persist.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { getGovernanceBlobStore, resolveActivePolicies } from '../lib/governance-store.js';
import { listAllObjectRecords, type ObjectVerbStore } from '../lib/object-verbs.js';
import { buildAuditFeed, buildAttentionInbox } from '../lib/audit-feed.js';

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

const parseLimit = (event: LambdaEvent): number => {
  if (!event.body) return 40;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const value = JSON.parse(raw) as { limit?: unknown };
    const limit = typeof value.limit === 'number' && Number.isFinite(value.limit) ? Math.floor(value.limit) : 40;
    return Math.max(1, Math.min(limit, 100));
  } catch {
    return 40;
  }
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const adminState = await resolveAdminAccessFromEvent(event, context, binding);
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });
  if (!adminState.isAdmin) return jsonResponse(403, { error: 'Admin access required' });

  const limit = parseLimit(event);
  const generatedAtMs = Date.now();

  try {
    const store = (await getSiteObjectsBlobStore(event, binding)) as unknown as ObjectVerbStore;
    // Runtime governance override (else committed) feeds requires_approval on
    // rows — the inbox itself is policy-independent, but we keep it consistent
    // with the rest of the admin surface.
    const { approval } = await resolveActivePolicies(await getGovernanceBlobStore(event, binding));

    const records = await listAllObjectRecords(store);
    const feed = buildAuditFeed(records, { limit });
    const inbox = buildAttentionInbox(records, { atMs: generatedAtMs, policy: approval });

    return jsonResponse(200, { feed, inbox, generated_at: new Date(generatedAtMs).toISOString() });
  } catch (error) {
    console.error('Admin_Audit request failed.', error);
    return jsonResponse(500, { error: 'Audit request could not be processed.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
