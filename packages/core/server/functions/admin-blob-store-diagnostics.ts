import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { getCoreBlobStoreSourceDiagnostics } from '../lib/blob-store.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { isOwner } from '../lib/roles.js';

type LambdaEvent = {
  blobs?: unknown;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
};

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});

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
    return jsonResponse(403, { error: 'This user is not authorized to inspect blob store diagnostics.' });
  }

  // T9.4/S1: maintenance/diagnostics tools are Owner-only — reuse the roles
  // resolveAdminAccessFromEvent already resolved above.
  if (!isOwner(adminState.roles)) {
    return jsonResponse(403, { error: 'Owner access is required for maintenance diagnostics.' });
  }

  return jsonResponse(200, {
    diagnostics: getCoreBlobStoreSourceDiagnostics(event, binding),
  });
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
