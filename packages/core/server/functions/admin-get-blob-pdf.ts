import { readBoundEnv, type SiteBinding } from '../lib/site-binding.js';
import { getHeader, type LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { getArtifactBlobStore } from '../lib/blob-store.js';

type LambdaEvent = {
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
};

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});

const toText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const hasValidNetlifyPublishSecret = (event: LambdaEvent, binding: SiteBinding) => {
  const expected = toText(readBoundEnv(binding.env.publishSecret));
  if (!expected) return false;

  const provided = toText(getHeader(event.headers, 'x-publish-key'));

  return Boolean(provided && provided === expected);
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  if (!hasValidNetlifyPublishSecret(event, binding)) {
    const adminState = await resolveAdminAccessFromEvent(event, context, binding);
    if (!adminState.authenticated) {
      return jsonResponse(401, {
        error: adminState.error || 'Authentication is required.',
      });
    }

    if (!adminState.isAdmin) {
      return jsonResponse(403, { error: 'This user is not authorized to read saved PDF artifacts.' });
    }
  }

  const blobKey = toText(event.queryStringParameters?.blobKey);
  if (!blobKey) {
    return jsonResponse(400, { error: 'A blobKey query parameter is required.' });
  }

  // Basic safety check: only allow keys that look like PDF artifacts.
  if (!/^pdf\/[a-z0-9._-]+\/[a-f0-9]{64}(\.pdf)?$/i.test(blobKey)) {
    return jsonResponse(400, { error: 'A valid PDF artifact blobKey is required.' });
  }

  try {
    const store = await getArtifactBlobStore(event, binding);
    const result = (await (
      store as { get: (key: string, options: { type: 'arrayBuffer' }) => Promise<ArrayBuffer | null> }
    ).get(blobKey, { type: 'arrayBuffer' })) as ArrayBuffer | null;

    if (!result) {
      return jsonResponse(404, { error: 'PDF artifact not found.' });
    }

    const buffer = Buffer.from(result);
    const filename = blobKey.split('/').pop() || 'artifact.pdf';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': `inline; filename="${filename}"`,
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    console.error('Failed to read saved PDF artifact.', error);

    return jsonResponse(500, { error: 'Saved PDF artifact could not be read.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
