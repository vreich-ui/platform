/**
 * The OAuth 2.1 authorization-server protocol (W14 F10) — metadata, dynamic
 * client registration, the authorization request, consent, and the token
 * endpoint. HTTP shaping lives in `functions/mcp-oauth.ts`; everything here is
 * a function from inputs to a `{ status, body }` (or a decision object), so the
 * whole flow is unit-testable against an in-memory store.
 *
 * Scope of the implementation, stated up front so nobody assumes more:
 *   - Grants: `authorization_code` (PKCE S256 REQUIRED) and `refresh_token`
 *     (rotating). No implicit, no password, no client_credentials — OAuth 2.1
 *     removes the first two, and the third would be a machine grant with no
 *     human in it, which is exactly what this exists to replace.
 *   - The user is authenticated by NETLIFY IDENTITY, the same login the /admin
 *     workspace uses, and must resolve to an admin/owner role. This server
 *     never sees a password: the consent page carries an Identity JWT and the
 *     approve call verifies it through the existing admin-auth seam.
 *   - Tokens are opaque and store-backed, not JWTs. A JWT would need a signing
 *     key, rotation, and a JWKS endpoint to buy statelessness this endpoint
 *     does not need — and store-backed tokens can be revoked the instant a
 *     record is deleted, which a stateless JWT cannot.
 *
 * The MCP authorization spec's hard requirements are each pinned by a test:
 * PKCE required, exact redirect-URI match, single-use codes, audience
 * (`resource`) binding and validation, and a `WWW-Authenticate` challenge
 * carrying `resource_metadata` on every 401 from the resource server.
 */
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  MCP_OAUTH_SCOPE,
  MCP_OAUTH_SCOPES,
  MCP_SCOPE,
  PENDING_AUTHORIZATION_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  clientSecretMatches,
  deleteAccessTokenRecord,
  deleteAuthorizationCode,
  deletePendingAuthorization,
  deleteRefreshTokenRecord,
  getAccessTokenRecord,
  getAuthorizationCode,
  getOAuthClient,
  getPendingAuthorization,
  getRefreshTokenRecord,
  hashOAuthValue,
  isAllowedRedirectUri,
  isExpired,
  mintOAuthValue,
  putAccessTokenRecord,
  putAuthorizationCode,
  putOAuthClient,
  putPendingAuthorization,
  putRefreshTokenRecord,
  redirectUriRegistered,
  verifyPkceS256,
  type AccessTokenRecord,
  type OAuthBlobStore,
  type OAuthClientRecord,
} from './oauth-store.js';

export type OAuthErrorBody = { error: string; error_description: string };
export type OAuthResult = { status: number; body: Record<string, unknown> };

const errorResult = (status: number, error: string, error_description: string): OAuthResult => ({
  status,
  body: { error, error_description },
});

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined;

// ─── request origin ──────────────────────────────────────────────────────────

const headerValue = (headers: Record<string, string | undefined> | undefined, name: string) => {
  const normalized = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === normalized)?.[1];
};

/**
 * The origin THIS request arrived on. RFC 8414 requires the metadata `issuer`
 * to equal the origin the client fetched it from, and the resource server has
 * to compute the SAME value when it validates a token's audience — so both
 * sides call this one function. A hardcoded canonical host would break every
 * deploy preview and every custom domain the day it is added.
 */
export const resolveRequestOrigin = (input: {
  headers?: Record<string, string | undefined>;
  rawUrl?: string;
  fallbackUrl?: string;
}): string => {
  const host = headerValue(input.headers, 'x-forwarded-host') ?? headerValue(input.headers, 'host');
  if (host) {
    const proto =
      headerValue(input.headers, 'x-forwarded-proto') ?? (/^localhost|^127\./.test(host) ? 'http' : 'https');
    return `${proto}://${host}`.replace(/\/+$/, '');
  }
  if (input.rawUrl) {
    try {
      return new URL(input.rawUrl).origin;
    } catch {
      /* fall through to the configured URL */
    }
  }
  return (input.fallbackUrl ?? '').replace(/\/+$/, '');
};

// ─── metadata ────────────────────────────────────────────────────────────────

/**
 * RFC 9728 protected-resource metadata. `resource` is the canonical MCP
 * endpoint URI (no trailing slash, per the spec's interoperability note) and
 * `authorization_servers` points back at this same origin — resource server
 * and authorization server are one deployment here, which is allowed and is
 * what keeps a new client to zero external dependencies.
 */
export const buildProtectedResourceMetadata = (input: { origin: string; resourceName: string }) => ({
  resource: `${input.origin}/mcp`,
  authorization_servers: [input.origin],
  scopes_supported: [...MCP_OAUTH_SCOPES],
  bearer_methods_supported: ['header'],
  resource_name: input.resourceName,
});

/** RFC 8414 authorization-server metadata. */
export const buildAuthorizationServerMetadata = (input: { origin: string }) => ({
  issuer: input.origin,
  authorization_endpoint: `${input.origin}/oauth/authorize`,
  token_endpoint: `${input.origin}/oauth/token`,
  registration_endpoint: `${input.origin}/oauth/register`,
  revocation_endpoint: `${input.origin}/oauth/revoke`,
  scopes_supported: [...MCP_OAUTH_SCOPES],
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
  revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
  // S256 ONLY. OAuth 2.1 removed `plain`, and advertising it would let a
  // client downgrade the one protection that stops code interception.
  code_challenge_methods_supported: ['S256'],
});

// ─── dynamic client registration (RFC 7591) ─────────────────────────────────

export type RegisterClientInput = {
  body: unknown;
  site: string;
  nowIso: string;
};

/**
 * Open registration, by design: RFC 7591 registration is how an MCP client
 * that has never seen this server obtains a client_id without a human
 * pre-provisioning one, and the MCP spec asks servers to support it.
 * Registration on its own grants NOTHING — a registered client still cannot
 * read a byte until a signed-in admin approves it at the consent screen. The
 * gate is consent, not registration.
 */
export const registerClient = async (store: OAuthBlobStore, input: RegisterClientInput): Promise<OAuthResult> => {
  const body = (input.body ?? {}) as Record<string, unknown>;
  const redirectUris = asStringArray(body.redirect_uris);

  if (!redirectUris || redirectUris.length === 0) {
    return {
      status: 400,
      body: {
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris is required and must be a non-empty array of strings.',
      },
    };
  }

  const invalid = redirectUris.find((uri) => !isAllowedRedirectUri(uri));
  if (invalid) {
    return {
      status: 400,
      body: {
        error: 'invalid_redirect_uri',
        error_description: `Redirect URI must be https, or http on loopback, and carry no fragment: ${invalid}`,
      },
    };
  }

  const requestedAuthMethod = asString(body.token_endpoint_auth_method) ?? 'none';
  if (!['none', 'client_secret_basic', 'client_secret_post'].includes(requestedAuthMethod)) {
    return {
      status: 400,
      body: {
        error: 'invalid_client_metadata',
        error_description: `Unsupported token_endpoint_auth_method: ${requestedAuthMethod}`,
      },
    };
  }

  const grantTypes = asStringArray(body.grant_types) ?? ['authorization_code', 'refresh_token'];
  const unsupportedGrant = grantTypes.find((grant) => !['authorization_code', 'refresh_token'].includes(grant));
  if (unsupportedGrant) {
    return {
      status: 400,
      body: {
        error: 'invalid_client_metadata',
        error_description: `Unsupported grant_type: ${unsupportedGrant}`,
      },
    };
  }

  const clientId = mintOAuthValue();
  const clientSecret = requestedAuthMethod === 'none' ? undefined : mintOAuthValue();
  const record: OAuthClientRecord = {
    schema_version: 'oauth-client.v1',
    client_id: clientId,
    ...(clientSecret ? { client_secret_hash: hashOAuthValue(clientSecret) } : {}),
    client_name: asString(body.client_name) ?? 'Unnamed MCP client',
    redirect_uris: redirectUris,
    token_endpoint_auth_method: requestedAuthMethod as OAuthClientRecord['token_endpoint_auth_method'],
    grant_types: grantTypes,
    response_types: asStringArray(body.response_types) ?? ['code'],
    scope: MCP_OAUTH_SCOPE,
    site: input.site,
    created_at: input.nowIso,
    registration: 'dynamic',
  };

  await putOAuthClient(store, record);

  return {
    status: 201,
    body: {
      client_id: record.client_id,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      client_id_issued_at: Math.floor(Date.parse(input.nowIso) / 1000),
      client_name: record.client_name,
      redirect_uris: record.redirect_uris,
      grant_types: record.grant_types,
      response_types: record.response_types,
      token_endpoint_auth_method: record.token_endpoint_auth_method,
      scope: record.scope,
    },
  };
};

// ─── authorization request ───────────────────────────────────────────────────

export type AuthorizeDecision =
  /** Parameters are sound; park the request and send the browser to the consent screen. */
  | { kind: 'consent'; request_id: string; client_name: string; redirect_uri: string }
  /** The client is known and its redirect_uri is registered, so the error goes BACK to the client. */
  | { kind: 'redirect'; url: string }
  /** The client or its redirect_uri could not be verified — never redirect, show the error here. */
  | { kind: 'fatal'; status: number; error: string; error_description: string };

const withParams = (base: string, params: Record<string, string | undefined>) => {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
};

export type BeginAuthorizationInput = {
  params: Record<string, string | undefined>;
  site: string;
  /** This deployment's canonical MCP resource URI, for RFC 8707 `resource` validation. */
  resourceUri: string;
  nowMs: number;
  nowIso: string;
};

/**
 * Validate an authorization request and park it. The ORDER of the checks is
 * the security property: client and redirect_uri are verified FIRST, because
 * an error may only be redirected to an address we have already proven the
 * client registered. Everything after that redirects the error back to the
 * client with `state` intact, which is what lets a connector show the user a
 * real message instead of hanging.
 */
export const beginAuthorization = async (
  store: OAuthBlobStore,
  input: BeginAuthorizationInput
): Promise<AuthorizeDecision> => {
  const { params } = input;
  const clientId = asString(params.client_id);
  const redirectUri = asString(params.redirect_uri);
  const state = asString(params.state);

  if (!clientId) {
    return { kind: 'fatal', status: 400, error: 'invalid_request', error_description: 'client_id is required.' };
  }

  const client = await getOAuthClient(store, clientId, input.site);
  if (!client) {
    return { kind: 'fatal', status: 400, error: 'invalid_client', error_description: 'Unknown client_id.' };
  }

  if (!redirectUri) {
    return { kind: 'fatal', status: 400, error: 'invalid_request', error_description: 'redirect_uri is required.' };
  }
  if (!redirectUriRegistered(client, redirectUri)) {
    // Deliberately NOT redirected: sending an error to an unregistered URI is
    // the open-redirect the spec warns about.
    return {
      kind: 'fatal',
      status: 400,
      error: 'invalid_request',
      error_description: 'redirect_uri does not exactly match a registered redirect URI for this client.',
    };
  }

  const fail = (error: string, description: string): AuthorizeDecision => ({
    kind: 'redirect',
    url: withParams(redirectUri, { error, error_description: description, state }),
  });

  if (asString(params.response_type) !== 'code') {
    return fail('unsupported_response_type', 'Only response_type=code is supported.');
  }

  const codeChallenge = asString(params.code_challenge);
  if (!codeChallenge) {
    return fail('invalid_request', 'PKCE is required: code_challenge is missing.');
  }
  if ((asString(params.code_challenge_method) ?? 'plain') !== 'S256') {
    return fail('invalid_request', 'Only code_challenge_method=S256 is supported.');
  }

  const resource = asString(params.resource);
  if (resource && !resourceMatches(resource, input.resourceUri)) {
    // RFC 8707: a token must not be mintable for somebody else's audience.
    return fail('invalid_target', `This server only issues tokens for ${input.resourceUri}.`);
  }

  const requestId = mintOAuthValue();
  await putPendingAuthorization(store, {
    schema_version: 'oauth-request.v1',
    request_id: requestId,
    client_id: client.client_id,
    redirect_uri: redirectUri,
    ...(state ? { state } : {}),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    // New registrations default to `mcp offline_access`, which is the signal
    // ChatGPT needs in order to retain and use the rotating refresh token.
    // Honor an explicit subset without widening it; ignore unknown names for
    // compatibility with clients that hardcode an extra scope.
    scope: (() => {
      const requested = (asString(params.scope) ?? client.scope).split(/\s+/);
      const granted = MCP_OAUTH_SCOPES.filter((scope) => requested.includes(scope));
      return granted.includes(MCP_SCOPE) ? granted.join(' ') : MCP_SCOPE;
    })(),
    ...(resource ? { resource } : {}),
    site: input.site,
    created_at: input.nowIso,
    expires_at: new Date(input.nowMs + PENDING_AUTHORIZATION_TTL_MS).toISOString(),
  });

  return { kind: 'consent', request_id: requestId, client_name: client.client_name, redirect_uri: redirectUri };
};

/**
 * `resource` comparison per RFC 8707 / MCP: scheme and host are
 * case-insensitive, a trailing slash is not significant, and the path must
 * match. Accepting the bare origin as well as `<origin>/mcp` is the
 * interoperability allowance the spec's canonical-URI note calls for.
 */
export const resourceMatches = (requested: string, canonical: string): boolean => {
  const normalize = (value: string) => {
    try {
      const url = new URL(value);
      const path = url.pathname.replace(/\/+$/, '');
      return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
    } catch {
      return '';
    }
  };
  const normalizedRequested = normalize(requested);
  const normalizedCanonical = normalize(canonical);
  if (!normalizedRequested || !normalizedCanonical) return false;
  if (normalizedRequested === normalizedCanonical) return true;
  // The bare origin identifies the same deployment as <origin>/mcp.
  return normalizedRequested === normalizedCanonical.replace(/\/mcp$/, '');
};

// ─── consent ─────────────────────────────────────────────────────────────────

export type ConsentSubject = { email: string; id: string };

export type CompleteAuthorizationInput = {
  request_id: string;
  decision: 'approve' | 'deny';
  subject: ConsentSubject;
  site: string;
  nowMs: number;
  nowIso: string;
};

export type CompleteAuthorizationResult =
  | { ok: true; redirect_to: string }
  | { ok: false; status: number; error: string; error_description: string };

/**
 * The human's decision. Approving mints a single-use authorization code bound
 * to the client, the redirect URI, the PKCE challenge, the audience, AND the
 * approving user — every later token traces back to a named person.
 */
export const completeAuthorization = async (
  store: OAuthBlobStore,
  input: CompleteAuthorizationInput
): Promise<CompleteAuthorizationResult> => {
  const pending = await getPendingAuthorization(store, input.request_id, input.site);
  if (!pending) {
    return { ok: false, status: 404, error: 'invalid_request', error_description: 'Unknown authorization request.' };
  }
  if (isExpired(pending, input.nowMs)) {
    await deletePendingAuthorization(store, input.request_id);
    return {
      ok: false,
      status: 400,
      error: 'invalid_request',
      error_description: 'This authorization request expired. Start the connection again.',
    };
  }

  // The parked request is consumed either way — an approval and a denial both
  // end it, so a leaked request_id cannot be replayed into a second grant.
  await deletePendingAuthorization(store, input.request_id);

  if (input.decision === 'deny') {
    return {
      ok: true,
      redirect_to: withParams(pending.redirect_uri, {
        error: 'access_denied',
        error_description: 'The request was denied.',
        state: pending.state,
      }),
    };
  }

  const code = mintOAuthValue();
  await putAuthorizationCode(store, code, {
    schema_version: 'oauth-code.v1',
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    code_challenge: pending.code_challenge,
    scope: pending.scope,
    ...(pending.resource ? { resource: pending.resource } : {}),
    subject_email: input.subject.email,
    subject_id: input.subject.id,
    site: input.site,
    approved_at: input.nowIso,
    expires_at: new Date(input.nowMs + AUTHORIZATION_CODE_TTL_MS).toISOString(),
  });

  return {
    ok: true,
    redirect_to: withParams(pending.redirect_uri, { code, state: pending.state }),
  };
};

/** What the consent screen shows the human before they decide. */
export const describePendingAuthorization = async (
  store: OAuthBlobStore,
  input: { request_id: string; site: string; nowMs: number }
): Promise<{ ok: true; client_name: string; redirect_host: string; scope: string } | { ok: false; status: number }> => {
  const pending = await getPendingAuthorization(store, input.request_id, input.site);
  if (!pending || isExpired(pending, input.nowMs)) return { ok: false, status: 404 };

  const client = await getOAuthClient(store, pending.client_id, input.site);
  let redirectHost = pending.redirect_uri;
  try {
    redirectHost = new URL(pending.redirect_uri).host;
  } catch {
    /* keep the raw value — it was validated at registration */
  }

  return {
    ok: true,
    client_name: client?.client_name ?? 'Unknown client',
    redirect_host: redirectHost,
    scope: pending.scope,
  };
};

// ─── token endpoint ──────────────────────────────────────────────────────────

export type TokenRequestInput = {
  params: Record<string, string | undefined>;
  /** Decoded HTTP Basic credentials, when the client authenticated that way. */
  basicAuth?: { client_id: string; client_secret: string };
  site: string;
  nowMs: number;
  nowIso: string;
};

const authenticateClient = async (
  store: OAuthBlobStore,
  input: TokenRequestInput
): Promise<{ ok: true; client: OAuthClientRecord } | { ok: false; result: OAuthResult }> => {
  const clientId = input.basicAuth?.client_id ?? asString(input.params.client_id);
  if (!clientId) {
    return { ok: false, result: errorResult(401, 'invalid_client', 'client_id is required.') };
  }

  const client = await getOAuthClient(store, clientId, input.site);
  if (!client) {
    return { ok: false, result: errorResult(401, 'invalid_client', 'Unknown client_id.') };
  }

  if (!client.client_secret_hash) {
    // A public client proves nothing by presenting its id; PKCE is what binds
    // the exchange to the party that started the flow.
    return { ok: true, client };
  }

  const providedSecret = input.basicAuth?.client_secret ?? asString(input.params.client_secret);
  if (!providedSecret || !clientSecretMatches(providedSecret, client.client_secret_hash)) {
    return { ok: false, result: errorResult(401, 'invalid_client', 'Client authentication failed.') };
  }

  return { ok: true, client };
};

const issueTokenPair = async (
  store: OAuthBlobStore,
  input: {
    client: OAuthClientRecord;
    subject_email: string;
    subject_id: string;
    scope: string;
    resource?: string;
    site: string;
    nowMs: number;
    nowIso: string;
  }
): Promise<OAuthResult> => {
  const accessToken = mintOAuthValue();
  const refreshToken = mintOAuthValue();
  const common = {
    client_id: input.client.client_id,
    client_name: input.client.client_name,
    subject_email: input.subject_email,
    subject_id: input.subject_id,
    scope: input.scope,
    ...(input.resource ? { resource: input.resource } : {}),
    site: input.site,
    issued_at: input.nowIso,
  };

  await putAccessTokenRecord(store, accessToken, {
    schema_version: 'oauth-access-token.v1',
    ...common,
    expires_at: new Date(input.nowMs + ACCESS_TOKEN_TTL_MS).toISOString(),
  });
  await putRefreshTokenRecord(store, refreshToken, {
    schema_version: 'oauth-refresh-token.v1',
    ...common,
    expires_at: new Date(input.nowMs + REFRESH_TOKEN_TTL_MS).toISOString(),
  });

  return {
    status: 200,
    body: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: input.scope,
    },
  };
};

export const handleTokenRequest = async (store: OAuthBlobStore, input: TokenRequestInput): Promise<OAuthResult> => {
  const grantType = asString(input.params.grant_type);
  if (!grantType) return errorResult(400, 'invalid_request', 'grant_type is required.');
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    return errorResult(400, 'unsupported_grant_type', `Unsupported grant_type: ${grantType}`);
  }

  const auth = await authenticateClient(store, input);
  if (!auth.ok) return auth.result;
  const { client } = auth;

  if (grantType === 'refresh_token') {
    const refreshToken = asString(input.params.refresh_token);
    if (!refreshToken) return errorResult(400, 'invalid_request', 'refresh_token is required.');

    const record = await getRefreshTokenRecord(store, refreshToken, input.site);
    if (!record || record.client_id !== client.client_id) {
      return errorResult(400, 'invalid_grant', 'Unknown or mismatched refresh token.');
    }
    // ROTATION (OAuth 2.1 §4.3.1, required for public clients): the presented
    // refresh token dies here whether or not the rest succeeds, so a replay of
    // a stolen one finds nothing.
    await deleteRefreshTokenRecord(store, refreshToken);
    if (isExpired(record, input.nowMs)) {
      return errorResult(400, 'invalid_grant', 'The refresh token has expired. Reconnect to authorize again.');
    }

    return issueTokenPair(store, {
      client,
      subject_email: record.subject_email,
      subject_id: record.subject_id,
      scope: record.scope,
      ...(record.resource ? { resource: record.resource } : {}),
      site: input.site,
      nowMs: input.nowMs,
      nowIso: input.nowIso,
    });
  }

  const code = asString(input.params.code);
  if (!code) return errorResult(400, 'invalid_request', 'code is required.');

  const record = await getAuthorizationCode(store, code, input.site);
  if (!record) return errorResult(400, 'invalid_grant', 'Unknown or already-used authorization code.');

  // Single use, consumed BEFORE any further check: a code that fails PKCE must
  // not survive for a second attempt.
  await deleteAuthorizationCode(store, code);

  if (isExpired(record, input.nowMs)) {
    return errorResult(400, 'invalid_grant', 'The authorization code has expired.');
  }
  if (record.client_id !== client.client_id) {
    return errorResult(400, 'invalid_grant', 'This authorization code was issued to a different client.');
  }

  const redirectUri = asString(input.params.redirect_uri);
  if (!redirectUri || redirectUri !== record.redirect_uri) {
    return errorResult(400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
  }

  const codeVerifier = asString(input.params.code_verifier);
  if (!codeVerifier || !verifyPkceS256(codeVerifier, record.code_challenge)) {
    return errorResult(400, 'invalid_grant', 'PKCE verification failed.');
  }

  const requestedResource = asString(input.params.resource);
  if (requestedResource && record.resource && !resourceMatches(requestedResource, record.resource)) {
    return errorResult(400, 'invalid_target', 'resource does not match the authorization request.');
  }

  return issueTokenPair(store, {
    client,
    subject_email: record.subject_email,
    subject_id: record.subject_id,
    scope: record.scope,
    ...(record.resource ? { resource: record.resource } : {}),
    site: input.site,
    nowMs: input.nowMs,
    nowIso: input.nowIso,
  });
};

/**
 * RFC 7009 revocation. Always 200, even for an unknown token — the spec's
 * requirement, and it keeps the endpoint from doubling as a token oracle.
 */
export const handleRevocation = async (
  store: OAuthBlobStore,
  input: { params: Record<string, string | undefined>; site: string }
): Promise<OAuthResult> => {
  const token = asString(input.params.token);
  if (token) {
    const hint = asString(input.params.token_type_hint);
    if (hint !== 'refresh_token') {
      const access = await getAccessTokenRecord(store, token, input.site);
      if (access) await deleteAccessTokenRecord(store, token);
    }
    if (hint !== 'access_token') {
      const refresh = await getRefreshTokenRecord(store, token, input.site);
      if (refresh) await deleteRefreshTokenRecord(store, token);
    }
  }
  return { status: 200, body: {} };
};

// ─── resource-server validation ──────────────────────────────────────────────

export type ResolvedOAuthPrincipal = {
  client_id: string;
  client_name: string;
  subject_email: string;
  /** W18 T18.6a: the GoTrue user id of the approving human — the membership core's human principal id. */
  subject_id: string;
  scope: string;
};

/**
 * The resource-server half: does this bearer token authorize THIS request?
 *
 * Three ways to fail, all of them silent to the caller (a 401 is a 401):
 * unknown token, expired token, or a token whose recorded audience is not this
 * deployment. The last one is the MCP spec's explicit MUST — a server that
 * skips it accepts tokens minted for someone else's resource.
 */
export const resolveOAuthPrincipal = async (
  store: OAuthBlobStore,
  input: { token: string; site: string; resourceUri: string; nowMs: number }
): Promise<ResolvedOAuthPrincipal | null> => {
  const record: AccessTokenRecord | null = await getAccessTokenRecord(store, input.token, input.site);
  if (!record) return null;
  if (isExpired(record, input.nowMs)) return null;
  if (record.resource && !resourceMatches(record.resource, input.resourceUri)) return null;

  return {
    client_id: record.client_id,
    client_name: record.client_name,
    subject_email: record.subject_email,
    subject_id: record.subject_id,
    scope: record.scope,
  };
};

/**
 * The RFC 9728 §5.1 challenge. Every 401 from the MCP endpoint carries this;
 * it is the ONLY thing that tells a client where to start an OAuth flow, and
 * without it a connector simply reports "unauthorized" forever.
 */
export const buildWwwAuthenticate = (input: { origin: string; realm: string; error?: string }): string => {
  const parts = [`Bearer realm="${input.realm}"`];
  if (input.error) parts.push(`error="${input.error}"`);
  parts.push(`resource_metadata="${input.origin}/.well-known/oauth-protected-resource"`);
  return parts.join(', ');
};
