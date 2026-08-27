/**
 * OAuth 2.1 authorization-server storage (W14 F10) — records, hashing, and
 * the blob keys the flow runs on.
 *
 * Why this exists: F9 gave header-less clients a way to carry the SHARED site
 * token in a URL. That is a carrier fix, not an authorization model — one
 * secret, no per-client identity, no revocation short of rotating the site.
 * OAuth is the model: each client registers itself, a HUMAN approves it once
 * through Netlify Identity, and the resulting access token is per-client,
 * per-user, expiring, and individually revocable. claude.ai's custom-connector
 * form has exactly two fields beyond the URL — an OAuth client id and secret —
 * so this is also the only auth path that form can actually drive.
 *
 * Storage posture, inherited deliberately from agent-keys.ts (T11.10):
 *   - The RAW value of a token or code is NEVER persisted. Every record is
 *     keyed and matched by `sha256(value)`. A dump of the governance store
 *     yields nothing that can be presented to the endpoint.
 *   - ONE RECORD PER BLOB KEY, not one document holding a list. Two token
 *     exchanges can land in the same second; a read-modify-write over a shared
 *     doc would silently drop one of them, and Netlify Blobs on the
 *     name-lookup path is eventually consistent (W14 T14.4), which makes that
 *     race wider than it looks. Per-key records have no lost-update window.
 *   - `site` is stamped on every record and checked on every read. The
 *     governance store is already per-site, so this is belt-and-braces against
 *     a future shared store — the same multi-tenant reflex agent-keys applies.
 *
 * Everything here is either a pure function or a single-key store operation,
 * so the protocol logic in oauth-server.ts can be unit-tested against an
 * in-memory store with no network and no Netlify runtime.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import type { BlobListResponse } from './blob-list.js';

/** Every key this module owns lives under one prefix, so an operator can see the whole surface in one `list`. */
export const OAUTH_KEY_PREFIX = 'oauth/';

/**
 * Lifetimes. Short access tokens are the spec's own mitigation for token theft
 * (MCP authorization §Token Theft); the refresh token carries the long-lived
 * grant and ROTATES on every use, so a stolen refresh token is detectable and
 * single-use rather than a permanent key.
 */
export const PENDING_AUTHORIZATION_TTL_MS = 10 * 60_000;
/** An authorization code is redeemed within a second or two of being issued. */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/** Full access to this site's MCP surface. */
export const MCP_SCOPE = 'mcp';
/**
 * ChatGPT requires an advertised offline-access scope before it will retain
 * and use the rotating refresh token returned by this authorization server.
 * Without it, the one-hour access token expires and the app falls back to a
 * full reauthentication prompt even though `/oauth/token` supports refresh.
 */
export const OFFLINE_ACCESS_SCOPE = 'offline_access';
export const MCP_OAUTH_SCOPES = [MCP_SCOPE, OFFLINE_ACCESS_SCOPE] as const;
export const MCP_OAUTH_SCOPE = MCP_OAUTH_SCOPES.join(' ');

export const oauthClientRecordSchema = z.object({
  schema_version: z.literal('oauth-client.v1'),
  client_id: z.string().min(1),
  /** Absent for a PUBLIC client (`token_endpoint_auth_method: 'none'`), which PKCE alone protects. */
  client_secret_hash: z.string().min(1).optional(),
  client_name: z.string().min(1),
  /** Exact-match allowlist. An authorization request whose redirect_uri is not byte-equal to one of these is refused. */
  redirect_uris: z.array(z.string().min(1)).min(1),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_basic', 'client_secret_post']),
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
  scope: z.string(),
  site: z.string().min(1),
  created_at: z.string(),
  /** 'dynamic' = self-registered via RFC 7591. Kept so an operator can tell hand-provisioned clients apart. */
  registration: z.enum(['dynamic', 'manual']),
});
export type OAuthClientRecord = z.infer<typeof oauthClientRecordSchema>;

/**
 * An authorization request parked between `/oauth/authorize` and the human's
 * decision. The client's parameters are validated ONCE, here, and then live
 * server-side under an opaque id — the consent page carries only that id, so
 * nothing a browser can edit can widen the grant it approves.
 */
export const pendingAuthorizationSchema = z.object({
  schema_version: z.literal('oauth-request.v1'),
  request_id: z.string().min(1),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  state: z.string().optional(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal('S256'),
  scope: z.string(),
  /** RFC 8707 resource indicator — the MCP endpoint this token will be used against. */
  resource: z.string().optional(),
  site: z.string().min(1),
  created_at: z.string(),
  expires_at: z.string(),
});
export type PendingAuthorization = z.infer<typeof pendingAuthorizationSchema>;

export const authorizationCodeSchema = z.object({
  schema_version: z.literal('oauth-code.v1'),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().min(1),
  scope: z.string(),
  resource: z.string().optional(),
  /** WHO approved this grant — carried onto the token and into every audit line. */
  subject_email: z.string().min(1),
  subject_id: z.string().min(1),
  site: z.string().min(1),
  approved_at: z.string(),
  expires_at: z.string(),
});
export type AuthorizationCode = z.infer<typeof authorizationCodeSchema>;

export const accessTokenSchema = z.object({
  schema_version: z.literal('oauth-access-token.v1'),
  client_id: z.string().min(1),
  client_name: z.string().min(1),
  subject_email: z.string().min(1),
  subject_id: z.string().min(1),
  scope: z.string(),
  /** The audience this token was issued FOR. Validated on every resource request. */
  resource: z.string().optional(),
  site: z.string().min(1),
  issued_at: z.string(),
  expires_at: z.string(),
});
export type AccessTokenRecord = z.infer<typeof accessTokenSchema>;

export const refreshTokenSchema = z.object({
  schema_version: z.literal('oauth-refresh-token.v1'),
  client_id: z.string().min(1),
  client_name: z.string().min(1),
  subject_email: z.string().min(1),
  subject_id: z.string().min(1),
  scope: z.string(),
  resource: z.string().optional(),
  site: z.string().min(1),
  issued_at: z.string(),
  expires_at: z.string(),
});
export type RefreshTokenRecord = z.infer<typeof refreshTokenSchema>;

export interface OAuthBlobStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<void | { modified: boolean; etag?: string }>;
  /** Netlify Blobs exposes `delete`; the file-backed dev/test store exposes `del`. Either satisfies this module. */
  delete?(key: string): Promise<void>;
  del?(key: string): Promise<void>;
  /** W18 T18.4: needed only by revocation-by-subject (offboarding); absent on stores that cannot list. */
  /** MUST be consumed through `collectBlobListItems` — see blob-list.ts. */
  list?(options: {
    prefix: string;
    directories?: boolean;
    paginate?: boolean;
  }): BlobListResponse | Promise<BlobListResponse>;
}

/**
 * W18 T18.4 — the by-subject index. Token/refresh/code records are keyed by
 * sha256(value) and carry `subject_email`, but nothing could enumerate "every
 * grant this person holds" — so suspend/remove could not revoke them. Every
 * mint now ALSO writes `oauth/by-subject/<email>/<kind>-<hash>.json` →
 * `{ kind, key }`; `revokeOAuthGrantsForSubject` (membership/offboarding.ts)
 * lists that prefix and deletes both halves. Records minted before this
 * change are not indexed until they rotate (access tokens live 1h, refresh
 * tokens rotate on every use) — documented in plan §5.
 */
export const subjectIndexPrefix = (subjectEmail: string) =>
  `${OAUTH_KEY_PREFIX}by-subject/${subjectEmail.trim().toLowerCase()}/`;
export const subjectIndexKey = (subjectEmail: string, kind: 'token' | 'refresh' | 'code', recordKey: string) =>
  `${subjectIndexPrefix(subjectEmail)}${kind}-${recordKey.split('/').pop()}`;
export const subjectIndexEntrySchema = z.object({ kind: z.enum(['token', 'refresh', 'code']), key: z.string().min(1) });
export type SubjectIndexEntry = z.infer<typeof subjectIndexEntrySchema>;

const writeSubjectIndex = async (
  store: OAuthBlobStore,
  subjectEmail: string,
  kind: 'token' | 'refresh' | 'code',
  recordKey: string
): Promise<void> => {
  try {
    await store.setJSON(subjectIndexKey(subjectEmail, kind, recordKey), {
      kind,
      key: recordKey,
    } satisfies SubjectIndexEntry);
  } catch {
    // the index is an offboarding aid; a failure here must never fail a token mint
  }
};

export const hashOAuthValue = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** 256 bits, URL-safe. Long enough that guessing is not a threat model. */
export const mintOAuthValue = (): string => randomBytes(32).toString('base64url');

export const clientKey = (clientId: string) => `${OAUTH_KEY_PREFIX}clients/${clientId}.json`;
export const pendingAuthorizationKey = (requestId: string) => `${OAUTH_KEY_PREFIX}requests/${requestId}.json`;
export const authorizationCodeKey = (code: string) => `${OAUTH_KEY_PREFIX}codes/${hashOAuthValue(code)}.json`;
export const accessTokenKey = (token: string) => `${OAUTH_KEY_PREFIX}tokens/${hashOAuthValue(token)}.json`;
export const refreshTokenKey = (token: string) => `${OAUTH_KEY_PREFIX}refresh/${hashOAuthValue(token)}.json`;

const deleteKey = async (store: OAuthBlobStore, key: string): Promise<void> => {
  if (typeof store.delete === 'function') {
    await store.delete(key);
    return;
  }
  if (typeof store.del === 'function') await store.del(key);
};

/**
 * READ-AFTER-WRITE LAG (the reason every getter below retries).
 *
 * Every record in this module is written by ONE lambda invocation and read by
 * the NEXT one, seconds or milliseconds later, across the whole connect flow:
 *
 *   /oauth/register  writes the client   → /oauth/authorize reads it
 *   /oauth/authorize writes the request  → /oauth/consent   reads it
 *   /oauth/consent   writes the code     → /oauth/token     reads it  (~1s)
 *   /oauth/token     writes the token    → /mcp             reads it  (~100ms)
 *
 * `blob-store.ts` records the trap in full: on the Netlify Blobs NAME-LOOKUP
 * path (any site without an explicit `NETLIFY_SITE_ID` + blobs token pair) the
 * `consistency: 'strong'` this store asks for is SILENTLY DOWNGRADED to
 * eventual, and "read-after-write can lag tens of seconds". A lagging read here
 * is not a slow read — it is a MISSING record, which every caller correctly
 * reads as "this does not authorize you". The connector then reports
 * `Authorization with the MCP server failed` on a grant that was in fact just
 * approved, and the human is told to check credentials that were never wrong.
 *
 * So a miss is retried a few times before it is believed. The budget is small
 * and bounded (~200ms worst case) and is only ever paid on a MISS: a hit — the
 * overwhelmingly common case, since a live connector presents a token that
 * exists — returns on the first read with no added latency.
 *
 * This does not weaken anything. A record that is genuinely absent (unknown,
 * revoked, already-redeemed, wrong-site) is still absent after the last
 * attempt, so every refusal this module makes it still makes; the retry only
 * removes the window in which a PRESENT record reads as absent.
 */
const READ_RETRY_DELAYS_MS = [50, 150] as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read + validate one record. Missing OR corrupt OR wrong-site → null. A
 * malformed blob must never authenticate anyone, and must never throw a 500
 * into a protocol response either: absent is the safe reading of both.
 *
 * `retryOnMiss` (default: on) covers the consistency lag documented above. It
 * retries only the two outcomes a lagging store produces — a null body and a
 * throwing GET — never a corrupt or wrong-site record, which are decisions,
 * not transients, and re-reading them would only burn the budget.
 */
const readRecord = async <T extends z.ZodTypeAny>(
  store: OAuthBlobStore,
  key: string,
  schema: T,
  site: string,
  options: { retryOnMiss?: boolean } = {}
): Promise<z.infer<T> | null> => {
  const attempts = options.retryOnMiss === false ? 1 : READ_RETRY_DELAYS_MS.length + 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(READ_RETRY_DELAYS_MS[attempt - 1]);

    let raw: string | null = null;
    try {
      raw = await store.get(key);
    } catch {
      continue; // a store hiccup is a transient, not an answer
    }
    if (!raw) continue;

    try {
      const parsed = schema.parse(JSON.parse(raw)) as { site: string };
      return parsed.site === site ? (parsed as z.infer<T>) : null;
    } catch {
      return null; // corrupt: a decision, not a transient
    }
  }

  return null;
};

export const getOAuthClient = (store: OAuthBlobStore, clientId: string, site: string) =>
  readRecord(store, clientKey(clientId), oauthClientRecordSchema, site);

export const putOAuthClient = async (store: OAuthBlobStore, record: OAuthClientRecord): Promise<void> => {
  await store.setJSON(clientKey(record.client_id), oauthClientRecordSchema.parse(record));
};

export const getPendingAuthorization = (store: OAuthBlobStore, requestId: string, site: string) =>
  readRecord(store, pendingAuthorizationKey(requestId), pendingAuthorizationSchema, site);

export const putPendingAuthorization = async (store: OAuthBlobStore, record: PendingAuthorization): Promise<void> => {
  await store.setJSON(pendingAuthorizationKey(record.request_id), pendingAuthorizationSchema.parse(record));
};

export const deletePendingAuthorization = (store: OAuthBlobStore, requestId: string) =>
  deleteKey(store, pendingAuthorizationKey(requestId));

export const getAuthorizationCode = (store: OAuthBlobStore, code: string, site: string) =>
  readRecord(store, authorizationCodeKey(code), authorizationCodeSchema, site);

export const putAuthorizationCode = async (
  store: OAuthBlobStore,
  code: string,
  record: AuthorizationCode
): Promise<void> => {
  const key = authorizationCodeKey(code);
  await store.setJSON(key, authorizationCodeSchema.parse(record));
  await writeSubjectIndex(store, record.subject_email, 'code', key);
};

/** Codes are single-use: redemption deletes before the token is minted (OAuth 2.1 §7.5). */
export const deleteAuthorizationCode = (store: OAuthBlobStore, code: string) =>
  deleteKey(store, authorizationCodeKey(code));

export const getAccessTokenRecord = (store: OAuthBlobStore, token: string, site: string) =>
  readRecord(store, accessTokenKey(token), accessTokenSchema, site);

export const putAccessTokenRecord = async (
  store: OAuthBlobStore,
  token: string,
  record: AccessTokenRecord
): Promise<void> => {
  const key = accessTokenKey(token);
  await store.setJSON(key, accessTokenSchema.parse(record));
  await writeSubjectIndex(store, record.subject_email, 'token', key);
};

export const deleteAccessTokenRecord = (store: OAuthBlobStore, token: string) =>
  deleteKey(store, accessTokenKey(token));

export const getRefreshTokenRecord = (store: OAuthBlobStore, token: string, site: string) =>
  readRecord(store, refreshTokenKey(token), refreshTokenSchema, site);

export const putRefreshTokenRecord = async (
  store: OAuthBlobStore,
  token: string,
  record: RefreshTokenRecord
): Promise<void> => {
  const key = refreshTokenKey(token);
  await store.setJSON(key, refreshTokenSchema.parse(record));
  await writeSubjectIndex(store, record.subject_email, 'refresh', key);
};

export const deleteRefreshTokenRecord = (store: OAuthBlobStore, token: string) =>
  deleteKey(store, refreshTokenKey(token));

export const isExpired = (record: { expires_at: string }, nowMs: number): boolean => {
  const expiry = Date.parse(record.expires_at);
  return !Number.isFinite(expiry) || expiry <= nowMs;
};

/**
 * PKCE S256 (RFC 7636). `plain` is NOT supported — OAuth 2.1 removed it, and
 * an authorization server that still accepts it lets a client downgrade the
 * protection that stops code interception.
 */
export const verifyPkceS256 = (codeVerifier: string, codeChallenge: string): boolean => {
  if (!codeVerifier || !codeChallenge) return false;
  const computed = createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(codeChallenge, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/** Constant-time compare for a client secret against its stored hash. */
export const clientSecretMatches = (providedSecret: string, storedHash: string): boolean => {
  const a = Buffer.from(hashOAuthValue(providedSecret), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/**
 * Redirect URIs are matched EXACTLY, never by prefix (MCP authorization §Open
 * Redirection). Prefix matching is how an attacker turns a legitimate
 * registration into an open redirector.
 */
export const redirectUriRegistered = (client: OAuthClientRecord, redirectUri: string): boolean =>
  client.redirect_uris.includes(redirectUri);

/**
 * A registrable redirect URI: HTTPS anywhere, or plain HTTP only on loopback
 * (the native-app pattern OAuth 2.1 §1.5 still permits). Anything else —
 * `http://` on a real host, a custom scheme we cannot reason about, a URI
 * carrying a fragment — is refused at registration rather than at redirect
 * time, so a bad client fails while a human is watching.
 */
export const isAllowedRedirectUri = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
};
