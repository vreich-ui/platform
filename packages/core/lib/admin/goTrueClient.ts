import { getSiteIdentity } from '../site-identity.js';

// W11 T11.5: browser-persisted keys derived from the site slug at CALL time
// (lazy — the admin islands register the site identity provider before any
// auth call runs). For Dr-Lurie these resolve to the exact pre-W11 literals
// ('dr-lurie-…'), so existing signed-in admin sessions survive the change.
const STORAGE_KEY = () => `${getSiteIdentity().siteSlug}-gotrue-user`;
const KEEP_KEY = () => `${getSiteIdentity().siteSlug}-keep-signed-in`;

export type GoTrueUser = {
  id: string;
  email: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  token: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    token_type: string;
  };
};

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
};

type UserInfo = {
  id: string;
  email: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
};

const getBase = () => {
  try {
    return import.meta.env?.PUBLIC_NETLIFY_IDENTITY_URL || '/.netlify/identity';
  } catch {
    return '/.netlify/identity';
  }
};

const writeStorage = (user: GoTrueUser) => {
  try {
    localStorage.setItem(STORAGE_KEY(), JSON.stringify(user));
  } catch {
    // ignored
  }
};

const clearStorage = () => {
  try {
    localStorage.removeItem(STORAGE_KEY());
  } catch {
    // ignored
  }
};

export const currentUser = (): GoTrueUser | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY());
    if (!raw) return null;
    const user = JSON.parse(raw) as GoTrueUser;
    if (user.token.expires_at && Date.now() >= user.token.expires_at) return null;
    return user;
  } catch {
    return null;
  }
};

export const isKeepSignedIn = () => {
  try {
    return localStorage.getItem(KEEP_KEY()) === '1';
  } catch {
    return false;
  }
};

export const setKeepSignedIn = (keep: boolean) => {
  try {
    if (keep) localStorage.setItem(KEEP_KEY(), '1');
    else localStorage.removeItem(KEEP_KEY());
  } catch {
    // ignored
  }
};

const fetchUserInfo = async (accessToken: string): Promise<UserInfo> => {
  const res = await fetch(`${getBase()}/user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Could not fetch user info.');
  return res.json() as Promise<UserInfo>;
};

const buildUser = (info: UserInfo, tok: TokenResponse): GoTrueUser => ({
  id: info.id,
  email: info.email,
  user_metadata: info.user_metadata,
  app_metadata: info.app_metadata,
  token: {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + tok.expires_in * 1000,
    token_type: tok.token_type,
  },
});

export const loginWithPassword = async (email: string, password: string): Promise<GoTrueUser> => {
  const res = await fetch(`${getBase()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', username: email, password }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error_description?: string; msg?: string };
    throw new Error(err.error_description || err.msg || 'Invalid email or password.');
  }
  const tok = (await res.json()) as TokenResponse;
  const info = await fetchUserInfo(tok.access_token);
  const user = buildUser(info, tok);
  writeStorage(user);
  return user;
};

export const loginWithGoogle = (redirectTo?: string) => {
  const params = new URLSearchParams({ provider: 'google' });
  if (redirectTo) params.set('redirect_to', redirectTo);
  window.location.assign(`${getBase()}/authorize?${params}`);
};

export const logout = async (): Promise<void> => {
  const user = currentUser();
  clearStorage();
  setKeepSignedIn(false);
  // W-perf: the cached inventory rows (in-memory + sessionStorage) are keyed
  // by site slug only, not by user — clear them on sign-out so a shared
  // machine's next sign-in never paints the previous user's cached library
  // rows before its own fetch lands. Dynamic import: logout() itself has no
  // other reason to depend on the admin library-client module.
  try {
    const { invalidateInventoryCache } = await import('./library-client.js');
    invalidateInventoryCache();
    // T5.1 R2: the release overview is a module-scope cache too, and it
    // carries per-object approval affordances — it must not outlive a
    // sign-out any more than the inventory does.
    const { invalidateReleaseOverview } = await import('./release-client.js');
    invalidateReleaseOverview();
    const { invalidateEditorialView } = await import('./editorial-view-client.js');
    invalidateEditorialView();
  } catch {
    // ignored — nothing to invalidate if the module can't load
  }
  // W-approval-mode-persistence: the per-chat "Approve safe actions" choice
  // is sessionStorage-scoped by chat/object id, not by user — clear every
  // persisted scope on sign-out so a shared machine's next sign-in never
  // inherits the previous user's approval preference.
  try {
    const { clearAllPersistedRunApprovalModes } = await import('./approval-mode.js');
    clearAllPersistedRunApprovalModes();
  } catch {
    // ignored — nothing to clear if the module can't load
  }
  if (user?.token.access_token) {
    await fetch(`${getBase()}/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.token.access_token}` },
    }).catch(() => {});
  }
};

export const refreshUser = async (): Promise<GoTrueUser | null> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY());
    if (!raw) return null;
    const stored = JSON.parse(raw) as GoTrueUser;
    if (!stored.token.refresh_token) return null;
    const res = await fetch(`${getBase()}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.token.refresh_token,
      }),
    });
    if (!res.ok) {
      clearStorage();
      return null;
    }
    const tok = (await res.json()) as TokenResponse;
    const info = await fetchUserInfo(tok.access_token);
    const user = buildUser(info, tok);
    writeStorage(user);
    return user;
  } catch {
    clearStorage();
    return null;
  }
};

let oauthCallbackPromise: Promise<GoTrueUser | null> | null = null;

// Extract token from URL hash after Google OAuth redirect. The callback is a
// single-flight operation because the layout gate and React islands initialize
// concurrently; the first caller clears the hash, so an uncoordinated second
// caller could otherwise miss the token and issue an unauthenticated request.
const processOAuthCallback = async (): Promise<GoTrueUser | null> => {
  const hash = typeof window !== 'undefined' ? window.location.hash : '';
  if (!hash) return null;
  const params = new URLSearchParams(hash.slice(1));
  // Recovery hashes are handled by handleRecoveryCallback — leave them untouched here.
  if (params.get('type') === 'recovery') return null;
  // T18.0b: the four Identity mail tokens are consumed by /admin/accept only.
  if (detectIdentityToken(hash)) return null;
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token') ?? '';
  const expiresIn = parseInt(params.get('expires_in') ?? '3600', 10);
  if (!accessToken) return null;

  history.replaceState(null, '', window.location.pathname + window.location.search);

  const info = await fetchUserInfo(accessToken);
  const user: GoTrueUser = {
    id: info.id,
    email: info.email,
    user_metadata: info.user_metadata,
    app_metadata: info.app_metadata,
    token: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Date.now() + expiresIn * 1000,
      token_type: 'bearer',
    },
  };
  writeStorage(user);
  return user;
};

export const handleOAuthCallback = (): Promise<GoTrueUser | null> => {
  oauthCallbackPromise ??= processOAuthCallback();
  return oauthCallbackPromise;
};

/** Test seam for independent callback scenarios. */
export const resetOAuthCallbackStateForTests = (): void => {
  oauthCallbackPromise = null;
};

// Returns a valid access token, refreshing if expired. Returns null if not signed in.
export const getAccessToken = async (): Promise<string | null> => {
  // Wait for the shared OAuth callback before consulting storage. This gates
  // every admin island on the same readiness point as AdminLayout.
  let user = await handleOAuthCallback();
  if (!user) user = currentUser();
  if (!user) user = await refreshUser();
  return user?.token.access_token ?? null;
};

export type RecoveryCallbackResult = { recoveryToken: string };

// Detect a Netlify Identity recovery hash and extract a session token without
// persisting it. Two shapes (T18.0b): the customised `#access_token=…&type=recovery`
// form is returned as-is; GoTrue's default `#recovery_token=…` is exchanged via
// POST /verify {type:'recovery'} for a session whose access token is returned.
// Clears the hash from the URL after reading. The invite/confirmation/
// email_change hashes are NOT handled here — the site-wide router sends them
// to /admin/accept before this runs.
export const handleRecoveryCallback = async (): Promise<RecoveryCallbackResult | null> => {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash.slice(1));
  if (params.get('type') === 'recovery') {
    const accessToken = params.get('access_token');
    if (!accessToken) return null;
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return { recoveryToken: accessToken };
  }
  const detected = detectIdentityToken(hash);
  if (detected?.kind !== 'recovery') return null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  const user = await exchangeRecoveryToken(detected.token);
  return { recoveryToken: user.token.access_token };
};

// ── T18.0b: Identity mail-token consumption ─────────────────────────────────

export type IdentityTokenKind = 'invite' | 'confirmation' | 'recovery' | 'email_change';
export type DetectedIdentityToken = { kind: IdentityTokenKind; token: string };

const IDENTITY_TOKEN_HASH_KEYS: ReadonlyArray<[string, IdentityTokenKind]> = [
  ['invite_token', 'invite'],
  ['confirmation_token', 'confirmation'],
  ['recovery_token', 'recovery'],
  ['email_change_token', 'email_change'],
];

/**
 * Read one of GoTrue's four default mail hashes (`#invite_token=`,
 * `#confirmation_token=`, `#recovery_token=`, `#email_change_token=`).
 * Pure: does NOT clear the hash and never persists the token.
 */
export const detectIdentityToken = (
  hash: string = typeof window !== 'undefined' ? window.location.hash : ''
): DetectedIdentityToken | null => {
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  for (const [key, kind] of IDENTITY_TOKEN_HASH_KEYS) {
    const token = params.get(key)?.trim();
    if (token) return { kind, token };
  }
  return null;
};

export const ACCEPT_PATH = '/admin/accept';

/**
 * The site-wide router predicate (T18.0b): a page carrying an Identity mail
 * token in its hash must hand it to /admin/accept, unless it already is that
 * page. Pure so it is unit-testable without a DOM.
 */
export const shouldRouteToAccept = (pathname: string, hash: string): boolean => {
  if (!detectIdentityToken(hash)) return false;
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return normalized !== ACCEPT_PATH;
};

/** Where the router sends a token-carrying page (the hash survives `location.replace`). */
export const acceptRouteFor = (hash: string): string => `${ACCEPT_PATH}${hash}`;

type VerifyType = 'signup' | 'recovery' | 'email_change';

const identityVerifyError = async (res: Response, fallback: string): Promise<Error> => {
  const err = (await res.json().catch(() => ({}))) as { msg?: string; error_description?: string; code?: number };
  const message = err.msg || err.error_description || fallback;
  const e = new Error(message) as Error & { status?: number };
  e.status = res.status;
  return e;
};

/** POST /verify — the one GoTrue call that turns a mail token into a session. */
const verifyIdentityToken = async (type: VerifyType, token: string, password?: string): Promise<GoTrueUser> => {
  const body: Record<string, string> = { type, token };
  if (password !== undefined) body.password = password;
  const res = await fetch(`${getBase()}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await identityVerifyError(res, 'This link is no longer valid.');
  const tok = (await res.json()) as TokenResponse;
  const info = await fetchUserInfo(tok.access_token);
  const user = buildUser(info, tok);
  writeStorage(user);
  return user;
};

/**
 * Accept an invitation: `POST /verify {type:'signup', token, password}` (GoTrue:
 * "Invited users must specify a password"). On success the session is written
 * to storage exactly like the OAuth/password paths; the invite token never is.
 */
export const acceptInvite = async (token: string, password: string): Promise<GoTrueUser> => {
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  return verifyIdentityToken('signup', token, password);
};

/** Exchange a `#recovery_token=` for a session; the caller then sets the password. */
export const exchangeRecoveryToken = (token: string): Promise<GoTrueUser> => verifyIdentityToken('recovery', token);

/** Confirm a signup (`#confirmation_token=`) — same `/verify` shape as an invite, no password. */
export const confirmSignup = (token: string): Promise<GoTrueUser> => verifyIdentityToken('signup', token);

/** Confirm an e-mail change (`#email_change_token=`). */
export const confirmEmailChange = (token: string): Promise<GoTrueUser> => verifyIdentityToken('email_change', token);

/** `PUT /user { data: { full_name } }` with the current session (informational; the store is the source of truth). */
export const setFullName = async (fullName: string): Promise<void> => {
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error('Not signed in.');
  const res = await fetch(`${getBase()}/user`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { full_name: fullName } }),
  });
  if (!res.ok) throw await identityVerifyError(res, 'Could not save your name.');
  // keep the cached user in step so the header shows the new name
  const stored = currentUser();
  if (stored) writeStorage({ ...stored, user_metadata: { ...(stored.user_metadata ?? {}), full_name: fullName } });
};

// Request a password-reset email. Normalises the address before sending.
export const requestPasswordRecovery = async (email: string): Promise<void> => {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) throw new Error('Please enter your email address.');
  const res = await fetch(`${getBase()}/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: normalizedEmail }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { msg?: string; error_description?: string };
    throw new Error(err.msg || err.error_description || 'Could not send reset email. Please try again.');
  }
};

// Update the user's password using a recovery access token.
// The token must come from the recovery email hash — it is never stored in localStorage.
export const updatePasswordWithToken = async (
  accessToken: string,
  password: string
): Promise<{ id: string; email: string }> => {
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  const res = await fetch(`${getBase()}/user`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { msg?: string; error_description?: string };
    throw new Error(err.msg || err.error_description || 'Could not update password. Please try again.');
  }
  const info = (await res.json()) as { id: string; email: string };
  return { id: info.id, email: info.email };
};
