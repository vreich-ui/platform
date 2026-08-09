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
  } catch {
    // ignored — nothing to invalidate if the module can't load
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

// Detect a Netlify Identity recovery hash and extract the token without persisting it.
// Clears the hash from the URL after reading.
export const handleRecoveryCallback = (): RecoveryCallbackResult | null => {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash.slice(1));
  if (params.get('type') !== 'recovery') return null;
  const accessToken = params.get('access_token');
  if (!accessToken) return null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return { recoveryToken: accessToken };
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
