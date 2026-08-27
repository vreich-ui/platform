/**
 * Function name: MCP_OAuth
 * Required methods: GET (metadata, authorize), POST (register, consent, token, revoke)
 * Auth: none on the public protocol endpoints; NETLIFY IDENTITY on /oauth/consent.
 *
 * The site's own OAuth 2.1 authorization server (W14 F10), sitting beside the
 * MCP resource server it protects. One function serves every endpoint because
 * they are one protocol and one store; the per-endpoint split lives in the
 * redirect table, which hands each path in with an explicit `oauth_endpoint`
 * hint (the path is still authoritative — the hint is the fallback).
 *
 * Endpoints, exactly as the metadata advertises them:
 *
 *   GET  /.well-known/oauth-protected-resource   → RFC 9728 resource metadata
 *   GET  /.well-known/oauth-authorization-server → RFC 8414 server metadata
 *   POST /oauth/register                         → RFC 7591 dynamic registration
 *   GET  /oauth/authorize                        → validate + park + send to consent
 *   POST /oauth/consent                          → the human's decision (Identity-gated)
 *   POST /oauth/token                            → code → token, refresh → token
 *   POST /oauth/revoke                           → RFC 7009
 *
 * The consent SCREEN is not here: it is `/admin/authorize`, a shell route
 * inside the admin workspace, so the login it needs is the login the workspace
 * already has (Netlify Identity, including whichever external providers a site
 * has enabled) instead of a second password surface invented in a function.
 * This endpoint only verifies the resulting Identity token and decides.
 */
import { getSiteIdentity } from '../../lib/site-identity.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { getNetlifyBlobStore } from '../lib/blob-store.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import type { SiteBinding } from '../lib/site-binding.js';
import {
  beginAuthorization,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  completeAuthorization,
  describePendingAuthorization,
  handleRevocation,
  handleTokenRequest,
  registerClient,
  resolveRequestOrigin,
  type OAuthLog,
} from '../lib/oauth-server.js';
import type { OAuthBlobStore } from '../lib/oauth-store.js';

type LambdaEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
  path?: string;
  queryStringParameters?: Record<string, string | undefined>;
  rawUrl?: string;
};

type OAuthEndpoint =
  | 'protected-resource-metadata'
  | 'authorization-server-metadata'
  | 'register'
  | 'authorize'
  | 'consent'
  | 'token'
  | 'revoke';

const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
};

const JSON_HEADERS = { ...CORS_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
/** Metadata is public, static, and fetched by every client on every connect. */
const METADATA_HEADERS = {
  ...CORS_HEADERS,
  'Cache-Control': 'public, max-age=300',
  'Content-Type': 'application/json',
};

const json = (statusCode: number, body: unknown, headers: Record<string, string> = JSON_HEADERS) => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

const html = (statusCode: number, body: string) => ({
  statusCode,
  headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' },
  body,
});

const redirect = (location: string) => ({
  statusCode: 302,
  headers: { 'Cache-Control': 'no-store', Location: location },
  body: '',
});

const getHeader = (headers: LambdaEvent['headers'], name: string) => {
  const normalized = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === normalized)?.[1];
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[char] ?? char;
  });

/** Shared with the resource server so both compute the same audience — see oauth-server.ts. */
const resolveOrigin = (event: LambdaEvent): string =>
  resolveRequestOrigin({
    ...(event.headers ? { headers: event.headers } : {}),
    ...(event.rawUrl ? { rawUrl: event.rawUrl } : {}),
    ...(process.env.URL ? { fallbackUrl: process.env.URL } : {}),
  });

/**
 * Path first, redirect hint second. The redirect table sets `oauth_endpoint`
 * so a rewrite whose original path the runtime does not surface still lands on
 * the right handler; the path wins when it is recognizable so a client cannot
 * steer this by inventing a query parameter.
 */
export const resolveEndpoint = (event: LambdaEvent): OAuthEndpoint | undefined => {
  const path = (event.path ?? '').replace(/\/+$/, '');
  if (path.startsWith('/.well-known/oauth-protected-resource')) return 'protected-resource-metadata';
  if (path.startsWith('/.well-known/oauth-authorization-server')) return 'authorization-server-metadata';
  if (path === '/oauth/register') return 'register';
  if (path === '/oauth/authorize') return 'authorize';
  if (path === '/oauth/consent') return 'consent';
  if (path === '/oauth/token') return 'token';
  if (path === '/oauth/revoke') return 'revoke';

  const hint = event.queryStringParameters?.oauth_endpoint;
  const known: OAuthEndpoint[] = [
    'protected-resource-metadata',
    'authorization-server-metadata',
    'register',
    'authorize',
    'consent',
    'token',
    'revoke',
  ];
  return known.find((endpoint) => endpoint === hint);
};

const decodeBody = (event: LambdaEvent): string =>
  event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';

/** The token endpoint speaks form-encoding; registration and consent speak JSON. Accept both anywhere. */
const parseRequestParams = (event: LambdaEvent): Record<string, string | undefined> => {
  const raw = decodeBody(event);
  if (!raw) return {};
  const contentType = (getHeader(event.headers, 'content-type') ?? '').toLowerCase();

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [key, typeof value === 'string' ? value : undefined])
      );
    } catch {
      return {};
    }
  }

  return Object.fromEntries(new URLSearchParams(raw).entries());
};

const parseJsonBody = (event: LambdaEvent): unknown => {
  const raw = decodeBody(event);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
};

/** RFC 6749 §2.3.1 client authentication over HTTP Basic. */
export const parseBasicAuth = (
  header: string | undefined
): { client_id: string; client_secret: string } | undefined => {
  const match = header?.match(/^Basic\s+(.+)$/i);
  if (!match) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1].trim(), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return undefined;
  return {
    client_id: decodeURIComponent(decoded.slice(0, separator)),
    client_secret: decodeURIComponent(decoded.slice(separator + 1)),
  };
};

const errorPage = (title: string, detail: string) =>
  html(
    400,
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      '<style>body{font:16px/1.6 system-ui,sans-serif;margin:4rem auto;max-width:34rem;padding:0 1.5rem;color:#1c1f23}' +
      'h1{font-size:1.25rem}code{background:#f3f4f6;padding:.1rem .3rem;border-radius:.2rem}</style>' +
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>` +
      '<p>Nothing was authorized. You can close this window.</p>'
  );

const getOAuthStore = (event: unknown): Promise<OAuthBlobStore> =>
  getNetlifyBlobStore({ name: 'governance', consistency: 'strong' }, event) as unknown as Promise<OAuthBlobStore>;

const handlerImpl = async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' }, body: '' };
  }

  const endpoint = resolveEndpoint(event);
  if (!endpoint) return json(404, { error: 'not_found', error_description: 'Unknown OAuth endpoint.' });

  const identity = getSiteIdentity();
  const origin = resolveOrigin(event);
  const resourceUri = `${origin}/mcp`;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (endpoint === 'protected-resource-metadata') {
    return json(200, buildProtectedResourceMetadata({ origin, resourceName: identity.brandName }), METADATA_HEADERS);
  }
  if (endpoint === 'authorization-server-metadata') {
    return json(200, buildAuthorizationServerMetadata({ origin }), METADATA_HEADERS);
  }

  const store = await getOAuthStore(event);
  const site = identity.siteId;

  /**
   * The operator's channel. Everything here is a SERVER-side condition the
   * client is deliberately not told about — a write that could not be
   * confirmed, a detected refresh reuse — and each one used to be invisible,
   * which is how they got debugged as credential problems.
   */
  const log: OAuthLog = (name, detail) =>
    console.warn(JSON.stringify({ ts: nowIso, event: name, endpoint, site, ...detail }));

  if (endpoint === 'authorize') {
    if (event.httpMethod !== 'GET') return json(405, { error: 'invalid_request', error_description: 'Use GET.' });

    const decision = await beginAuthorization(store, {
      params: event.queryStringParameters ?? {},
      site,
      resourceUri,
      nowMs,
      nowIso,
    });

    if (decision.kind === 'fatal') return errorPage('This connection request is not valid', decision.error_description);
    if (decision.kind === 'redirect') return redirect(decision.url);

    // Hand off to the admin-workspace consent screen. Only the opaque
    // request id travels through the browser — every parameter that decides
    // what gets granted stays server-side.
    return redirect(`${origin}/admin/authorize?request_id=${encodeURIComponent(decision.request_id)}`);
  }

  if (endpoint === 'register') {
    if (event.httpMethod !== 'POST') return json(405, { error: 'invalid_request', error_description: 'Use POST.' });
    const result = await registerClient(store, { body: parseJsonBody(event), site, nowIso });
    return json(result.status, result.body);
  }

  if (endpoint === 'token') {
    if (event.httpMethod !== 'POST') return json(405, { error: 'invalid_request', error_description: 'Use POST.' });
    const basicAuth = parseBasicAuth(getHeader(event.headers, 'authorization'));
    const result = await handleTokenRequest(store, {
      params: parseRequestParams(event),
      ...(basicAuth ? { basicAuth } : {}),
      site,
      nowMs,
      nowIso,
      log,
    });
    return json(result.status, result.body);
  }

  if (endpoint === 'revoke') {
    if (event.httpMethod !== 'POST') return json(405, { error: 'invalid_request', error_description: 'Use POST.' });
    const result = await handleRevocation(store, { params: parseRequestParams(event), site });
    return json(result.status, result.body);
  }

  // ─── consent: the one Identity-gated endpoint ────────────────────────────
  if (event.httpMethod !== 'POST') return json(405, { error: 'invalid_request', error_description: 'Use POST.' });

  const adminState = await resolveAdminAccessFromEvent(event, context);
  if (!adminState.authenticated || !adminState.email || !adminState.userId) {
    return json(401, { error: 'unauthorized', error_description: 'Sign in to the admin workspace first.' });
  }

  // S1 auth-dedupe: adminState.isAdmin is already the resolved role set
  // (env bootstrap owners ∪ users-store tier) — no need to re-resolve roles
  // a second time just to OR in an owner check.
  const mayApprove = adminState.isAdmin || adminState.roles.includes('owner');
  if (!mayApprove) {
    // Authenticated but not an administrator: a reader account must not be
    // able to hand an external client the keys to the whole MCP surface.
    return json(403, {
      error: 'forbidden',
      error_description: 'Only an admin or owner of this site can approve a connection.',
    });
  }

  const params = parseRequestParams(event);
  const requestId = params.request_id;
  if (!requestId) return json(400, { error: 'invalid_request', error_description: 'request_id is required.' });

  if (params.action === 'info') {
    const described = await describePendingAuthorization(store, { request_id: requestId, site, nowMs });
    if (!described.ok) {
      return json(404, {
        error: 'invalid_request',
        error_description: 'This connection request has expired or was already answered.',
      });
    }
    return json(200, {
      client_name: described.client_name,
      redirect_host: described.redirect_host,
      scope: described.scope,
      site_name: identity.brandName,
      approver_email: adminState.email,
    });
  }

  const decision = params.action === 'deny' ? 'deny' : 'approve';
  const completed = await completeAuthorization(store, {
    request_id: requestId,
    decision,
    subject: { email: adminState.email, id: adminState.userId },
    site,
    nowMs,
    nowIso,
    log,
  });

  if (!completed.ok) {
    return json(completed.status, { error: completed.error, error_description: completed.error_description });
  }
  return json(200, { redirect_to: completed.redirect_to, decision });
};

/**
 * Nothing above may throw out of the function.
 *
 * Every endpoint here reaches the governance blob store, and `blob-store.ts`
 * throws outright when Blobs is unavailable in a production runtime (its
 * deliberate fail-closed guard). Unhandled, that leaves the Netlify runtime to
 * answer a bare 502 with an HTML body — and an OAuth client reading a 502 from
 * `/oauth/token` reports only "authorization failed", which is how an
 * infrastructure outage gets debugged as a credentials problem. RFC 6749 §5.2
 * has a shape for exactly this: answer `server_error` as JSON, so the client
 * says something true and the operator gets one log line naming the endpoint
 * that failed.
 *
 * The catch deliberately does NOT swallow anything into a success: every path
 * out of here is either the endpoint's own answer or an explicit 500.
 */
const guardedHandler = async (event: LambdaEvent, context?: LambdaContext) => {
  try {
    return await handlerImpl(event, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'mcp_oauth_unhandled_error',
        endpoint: resolveEndpoint(event) ?? 'unknown',
        httpMethod: event.httpMethod ?? null,
        error: message,
      })
    );

    return json(500, {
      error: 'server_error',
      error_description:
        'This authorization server could not complete the request. This is a fault on the server, not with your credentials — retry, and if it persists check the site function logs for mcp_oauth_unhandled_error.',
    });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (_binding?: SiteBinding) => guardedHandler;
