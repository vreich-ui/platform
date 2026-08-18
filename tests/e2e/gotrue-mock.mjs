/**
 * GoTrue mock (W18 T18.9 Part A) — an in-process, stateful HTTP mock of the
 * Netlify Identity / GoTrue endpoints THIS project uses, so the membership
 * flows can be driven end to end through the real functions without a
 * Netlify site, an inbox, or a browser:
 *
 *   POST /invite                     admin — creates an unconfirmed user, "sends" an invite mail
 *   POST /verify                     {type: signup|recovery|email_change, token, password?} → session
 *   POST /token                      grant_type=password | refresh_token → session
 *   GET  /user                       bearer → user
 *   PUT  /user                       bearer {password?, data?, email?} → user ("sends" email-change mail)
 *   POST /recover                    {email} → "sends" a recovery mail
 *   POST /logout                     bearer → 204
 *   GET  /admin/users[?per_page]     admin → {users:[…]}
 *   GET  /admin/users/:id            admin → user
 *   DELETE /admin/users/:id          admin → 200 ({}), 404 when unknown
 *   GET  /settings                   → {external:{…}} (what the widget would probe)
 *
 * Tokens are JWT-SHAPED (header.payload.signature, base64url, unsigned) so
 * anything that decodes `sub`/`email`/`exp` from them works; nothing here
 * verifies a signature — this is a test double. Every mail GoTrue would send
 * lands in `mock.outbox` as `{type, to, token, link}` with the link built the
 * way Netlify's default templates build it (`${siteUrl}/#<kind>_token=<token>`)
 * — the exact hash shape the T18.0b router consumes.
 *
 * Injection: `IDENTITY_URL=${mock.url}` for the functions' bearer-fallback
 * user lookup (`admin-auth.ts`), and `context.clientContext.identity =
 * {url: mock.url, token: mock.adminToken}` for the admin-token side effects
 * (invite, admin list, delete) — the two ways the runtime hands the functions
 * their GoTrue address.
 *
 * Usage:
 *   const mock = await startGoTrueMock({ siteUrl: 'https://tenant.example' });
 *   … process.env.IDENTITY_URL = mock.url …
 *   await mock.close();
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const nowIso = () => new Date().toISOString();
const newId = () => `mock-${randomBytes(8).toString('hex')}`;
const newToken = () => randomBytes(16).toString('hex');

/** header.payload.signature — decodable, unsigned. */
export const fakeJwt = (payload) =>
  `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.${b64url('mock-signature')}`;

export const decodeFakeJwt = (jwt) => {
  try {
    return JSON.parse(Buffer.from(String(jwt).split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const readJson = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!raw) return resolve({});
      const type = String(req.headers['content-type'] ?? '');
      if (type.includes('application/x-www-form-urlencoded'))
        return resolve(Object.fromEntries(new URLSearchParams(raw)));
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ __raw: raw });
      }
    });
  });

const send = (res, status, body, headers = {}) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
};

export const startGoTrueMock = async ({
  siteUrl = 'https://tenant.example',
  adminToken = `admin-${newToken()}`,
} = {}) => {
  /** @type {Map<string, any>} id → user */
  const users = new Map();
  /** @type {Map<string, {user_id: string, expires_at: number}>} access token → session */
  const sessions = new Map();
  /** @type {Map<string, string>} refresh token → user id */
  const refreshTokens = new Map();
  /** @type {Array<{type:string,to:string,token:string,link:string,at:string}>} */
  const outbox = [];
  const calls = [];

  const publicUser = (u) => ({
    id: u.id,
    aud: '',
    role: '',
    email: u.email,
    confirmed_at: u.confirmed_at ?? null,
    invited_at: u.invited_at ?? null,
    recovery_sent_at: u.recovery_sent_at ?? null,
    app_metadata: u.app_metadata ?? { provider: 'email' },
    user_metadata: u.user_metadata ?? {},
    created_at: u.created_at,
    updated_at: u.updated_at,
    last_sign_in_at: u.last_sign_in_at ?? null,
    ...(u.new_email ? { new_email: u.new_email } : {}),
  });

  const findByEmail = (email) => [...users.values()].find((u) => u.email === String(email).trim().toLowerCase());
  const findByToken = (field, token) => [...users.values()].find((u) => token && u[field] === token);

  const mail = (type, user, token, kind) => {
    const link = `${siteUrl}/#${kind}_token=${token}`;
    outbox.push({ type, to: user.email, token, link, at: nowIso() });
    return link;
  };

  const issueSession = (user) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access_token = fakeJwt({
      sub: user.id,
      email: user.email,
      exp,
      app_metadata: user.app_metadata ?? {},
      user_metadata: user.user_metadata ?? {},
    });
    const refresh_token = newToken();
    sessions.set(access_token, { user_id: user.id, expires_at: exp * 1000 });
    refreshTokens.set(refresh_token, user.id);
    user.last_sign_in_at = nowIso();
    return { access_token, token_type: 'bearer', expires_in: 3600, refresh_token, user: publicUser(user) };
  };

  const bearer = (req) => {
    const h = String(req.headers.authorization ?? '');
    return h.startsWith('Bearer ') ? h.slice(7) : '';
  };
  const isAdmin = (req) => bearer(req) === adminToken;
  const sessionUser = (req) => {
    const s = sessions.get(bearer(req));
    if (!s || s.expires_at < Date.now()) return null;
    return users.get(s.user_id) ?? null;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const method = req.method ?? 'GET';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readJson(req) : {};
    calls.push({ method, path, admin: isAdmin(req) });

    // ── admin-token endpoints ─────────────────────────────────────────────
    if (path === '/invite' && method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { code: 401, msg: 'This endpoint requires a Bearer token' });
      const email = String(body.email ?? '')
        .trim()
        .toLowerCase();
      if (!email) return send(res, 422, { code: 422, msg: 'Invite requires an email' });
      const existing = findByEmail(email);
      if (existing?.confirmed_at)
        return send(res, 422, { code: 422, msg: 'A user with this email address has already been registered' });
      const at = nowIso();
      const user = existing ?? {
        id: newId(),
        email,
        created_at: at,
        app_metadata: { provider: 'email' },
        user_metadata: {},
      };
      user.invited_at = at;
      user.updated_at = at;
      user.invite_token = newToken();
      if (body.data && typeof body.data === 'object') user.user_metadata = { ...user.user_metadata, ...body.data };
      users.set(user.id, user);
      mail('invite', user, user.invite_token, 'invite');
      return send(res, 200, publicUser(user));
    }
    if (path === '/admin/users' && method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { code: 401, msg: 'This endpoint requires a Bearer token' });
      const perPage = Number(url.searchParams.get('per_page') ?? 50);
      const list = [...users.values()].slice(0, perPage).map(publicUser);
      return send(res, 200, { aud: '', users: list });
    }
    const adminUser = /^\/admin\/users\/([^/]+)$/.exec(path);
    if (adminUser) {
      if (!isAdmin(req)) return send(res, 401, { code: 401, msg: 'This endpoint requires a Bearer token' });
      const user = users.get(adminUser[1]);
      if (method === 'GET')
        return user ? send(res, 200, publicUser(user)) : send(res, 404, { code: 404, msg: 'User not found' });
      if (method === 'DELETE') {
        if (!user) return send(res, 404, { code: 404, msg: 'User not found' });
        users.delete(user.id);
        for (const [tok, s] of sessions) if (s.user_id === user.id) sessions.delete(tok);
        for (const [tok, uid] of refreshTokens) if (uid === user.id) refreshTokens.delete(tok);
        return send(res, 200, {});
      }
    }

    // ── token flows ───────────────────────────────────────────────────────
    if (path === '/verify' && method === 'POST') {
      const type = String(body.type ?? '');
      const token = String(body.token ?? '');
      if (type === 'signup') {
        const user = findByToken('invite_token', token) ?? findByToken('confirmation_token', token);
        if (!user) return send(res, 404, { code: 404, msg: 'User not found' });
        if (!user.confirmed_at && !user.password && !body.password) {
          return send(res, 422, { code: 422, msg: 'Invited users must specify a password' });
        }
        if (body.password) user.password = String(body.password);
        user.confirmed_at = user.confirmed_at ?? nowIso();
        user.updated_at = nowIso();
        delete user.invite_token;
        delete user.confirmation_token;
        return send(res, 200, issueSession(user));
      }
      if (type === 'recovery') {
        const user = findByToken('recovery_token', token);
        if (!user) return send(res, 404, { code: 404, msg: 'User not found' });
        delete user.recovery_token;
        user.confirmed_at = user.confirmed_at ?? nowIso();
        return send(res, 200, issueSession(user));
      }
      if (type === 'email_change') {
        const user = findByToken('email_change_token', token);
        if (!user) return send(res, 404, { code: 404, msg: 'User not found' });
        user.email = user.new_email;
        delete user.new_email;
        delete user.email_change_token;
        user.updated_at = nowIso();
        return send(res, 200, issueSession(user));
      }
      return send(res, 400, { code: 400, msg: 'Verify requires a verification type' });
    }
    if (path === '/token' && method === 'POST') {
      const grant = String(body.grant_type ?? url.searchParams.get('grant_type') ?? '');
      if (grant === 'password') {
        const user = findByEmail(body.username ?? '');
        if (!user || !user.confirmed_at || user.password !== String(body.password ?? '')) {
          return send(res, 400, {
            error: 'invalid_grant',
            error_description: 'No user found with this email, or password invalid.',
          });
        }
        return send(res, 200, issueSession(user));
      }
      if (grant === 'refresh_token') {
        const uid = refreshTokens.get(String(body.refresh_token ?? ''));
        const user = uid ? users.get(uid) : null;
        if (!user) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
        refreshTokens.delete(String(body.refresh_token));
        return send(res, 200, issueSession(user));
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    if (path === '/recover' && method === 'POST') {
      const user = findByEmail(body.email ?? '');
      if (!user) return send(res, 404, { code: 404, msg: 'User not found' });
      user.recovery_token = newToken();
      user.recovery_sent_at = nowIso();
      mail('recovery', user, user.recovery_token, 'recovery');
      return send(res, 200, {});
    }
    if (path === '/user') {
      const user = sessionUser(req);
      if (!user) return send(res, 401, { code: 401, msg: 'Invalid token' });
      if (method === 'GET') return send(res, 200, publicUser(user));
      if (method === 'PUT') {
        if (body.password) user.password = String(body.password);
        if (body.data && typeof body.data === 'object') user.user_metadata = { ...user.user_metadata, ...body.data };
        if (body.email && String(body.email).toLowerCase() !== user.email) {
          user.new_email = String(body.email).trim().toLowerCase();
          user.email_change_token = newToken();
          mail('email_change', { ...user, email: user.new_email }, user.email_change_token, 'email_change');
        }
        user.updated_at = nowIso();
        return send(res, 200, publicUser(user));
      }
    }
    if (path === '/logout' && method === 'POST') {
      sessions.delete(bearer(req));
      res.writeHead(204);
      return res.end();
    }
    if (path === '/settings' && method === 'GET') {
      return send(res, 200, { external: { email: true, google: false }, disable_signup: true, autoconfirm: false });
    }
    return send(res, 404, { code: 404, msg: `mock: no route for ${method} ${path}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const urlBase = `http://127.0.0.1:${address.port}`;

  return {
    url: urlBase,
    adminToken,
    siteUrl,
    outbox,
    calls,
    /** Test-side helpers (what "the console" or "the inbox" would do). */
    users: () => [...users.values()].map(publicUser),
    userById: (id) => (users.get(id) ? publicUser(users.get(id)) : null),
    userByEmail: (email) => {
      const u = findByEmail(email);
      return u ? publicUser(u) : null;
    },
    /** The last mail of a type sent to an address — "open the e-mail". */
    lastMail: (to, type) =>
      [...outbox].reverse().find((m) => m.to === String(to).toLowerCase() && (!type || m.type === type)) ?? null,
    /** Simulate an invite made from the Netlify Identity tab (no platform record). */
    consoleInvite: async (email) => {
      const res = await fetch(`${urlBase}/invite`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      return res.json();
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};
