/**
 * Function name: Admin_Artifact_Upload_Intent
 * Required method: POST
 * Auth: Netlify Identity (admin email allowlist).
 *
 * Mints a short-lived artifact upload token for the edit-mode canvas image
 * tool, so a logged-in admin's browser can push image bytes into the blobs
 * `artifacts` store through the SAME tokened path agents use
 * (/api/artifacts/upload) — the pdf-tool pattern, applied to images.
 *
 * This endpoint writes nothing itself. It authenticates the admin, validates
 * the declared upload (type/size/sha256), and signs the claims; the upload
 * endpoint independently re-verifies the actual bytes against those claims.
 * The uploaded image is then publicly served at the returned `publicPath`
 * (/img/* → get-public-image.ts), which is the value the canvas puts in the
 * section's `src` through the normal reviewable draft path.
 *
 * POST body: { object_id, content_type, size_bytes, sha256 }
 * Response:  { token, claims, maxBytes, publicPath }
 */
import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { createCanvasUploadIntent, parseCanvasUploadIntentRequest } from '../lib/canvas-upload-intent.js';

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

type LambdaEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
};

const jsonResponse = (status: number, body: Record<string, unknown>) => ({
  statusCode: status,
  headers: jsonHeaders,
  body: JSON.stringify({ ok: status >= 200 && status < 300, status, ...body }),
});

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const adminState = await resolveAdminAccessFromEvent(event, context, binding);
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });
  if (!adminState.isAdmin) return jsonResponse(403, { error: 'Admin access required' });

  let rawBody: unknown;
  try {
    const text =
      event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');
    rawBody = JSON.parse(text);
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const request = parseCanvasUploadIntentRequest(rawBody);
  if (!request) {
    return jsonResponse(400, { error: 'Invalid request — expected { object_id, content_type, size_bytes, sha256 }.' });
  }

  const result = createCanvasUploadIntent(request);
  if (!result.ok) return jsonResponse(result.statusCode, { error: result.error });

  return jsonResponse(200, {
    token: result.token,
    claims: result.claims,
    maxBytes: result.maxBytes,
    publicPath: result.publicPath,
  });
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
