/**
 * Function name: Admin_Users
 * Required method: POST
 * Auth: Netlify Identity. Verbs: me / update_me (self, any admin);
 *       list / set_role / suspend (alias: disable) / reinstate /
 *       promote_bootstrap (Owner). Invite is T9.5.
 *       T18.0a: invite_preview (PUBLIC, no auth) and accept (any
 *       authenticated Identity user — the fresh JWT GoTrue's /verify returned;
 *       no role gate, because an invitee has no roles yet).
 *       T18.1: the store behind every verb is membership v2 (person +
 *       membership + audit stream) read/written through the users-store
 *       adapter; five tiers; the `last_owner` guard (409) on set_role/suspend.
 *
 * The workspace identity surface (T9.4). Roles are resolved server-side via
 * the async resolver (users store + ADMIN_EMAILS bootstrap owners); owner-only
 * verbs 403 for a non-owner. Every mutation appends to the member's audit array.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { z } from 'zod';

import { getAdminStateFromEvent, type LambdaContext } from '../lib/admin-auth.js';
import { environmentRoleForEmail, resolveRolesForPrincipalAsync, isOwner } from '../lib/roles.js';
import {
  getUsersBlobStore,
  getUserRecord,
  putUserRecord,
  normalizeUserEmail,
  type UserRecord,
  type UsersBlobStore,
} from '../lib/users-store.js';
import { MAJOR_KEY_ARTIFACT_REF_RE } from '../lib/artifact-trust.js';
import {
  acceptInvitation,
  activateOnLogin,
  previewInvitationByToken,
  type GoTrueIdentity,
} from '../lib/membership/invitations.js';
import { appendAudit, getPolicy, stampOnboarding } from '../lib/membership/write.js';
import { auditActorFromPrincipal, personIdForEmail } from '../lib/membership/store.js';
import { handleMembershipVerb } from '../lib/membership/verbs.js';
import { getNetlifyBlobStore, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import type { OAuthBlobStore } from '../lib/oauth-store.js';
import { softDeleteArtifact } from '../lib/mcp-artifact-admin.js';
import type { Principal } from '../../schema/object-record-v1.js';
import { friendlyNameFromEmail } from '../../lib/admin/display-name.js';
import { getSiteIdentity } from '../../lib/site-identity.js';

/** T18.0a: the accept page's password policy (mirrors GoTrue's default minimum). */
export const ACCEPT_MIN_PASSWORD = 8;

/** An avatar must be an uploaded IMAGE artifact reference, not a URL/data URI. */
export const isTrustedAvatarRef = (ref: string): boolean =>
  ref.startsWith('image/') && MAJOR_KEY_ARTIFACT_REF_RE.test(ref);

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

/**
 * The SESSION verbs this function handles itself (they act on the caller's own
 * record with their own auth shapes). Every other verb is a membership
 * management verb and is parsed + executed by `handleMembershipVerb`
 * (T18.6a) — this schema is only the front-door split.
 */
const sessionRequestSchema = z.discriminatedUnion('verb', [
  z.object({ verb: z.literal('me') }),
  z.object({
    verb: z.literal('update_me'),
    display_name: z.string().min(1).max(200).optional(),
    avatar_artifact: z.string().min(1).optional(),
    // T18.5: the welcome page's onboarding stamps — 'name' (step), 'tour' /
    // 'skipped' (step + completed_at).
    onboarding_step: z.enum(['name', 'tour', 'skipped']).optional(),
  }),
  // T18.0a — the accept page's two verbs. `token` is accepted but NOT
  // validated: only GoTrue can validate an invite token, and an unauthenticated
  // request has no admin token to ask with. See the verb handler comment.
  z.object({ verb: z.literal('invite_preview'), token: z.string().optional(), inv: z.string().optional() }),
  z.object({ verb: z.literal('accept'), display_name: z.string().min(1).max(200) }),
]);
const SESSION_VERBS = new Set(['me', 'update_me', 'invite_preview', 'accept']);
const managementRequestSchema = z.object({ verb: z.string().min(1) }).passthrough();
const requestSchema = z.union([sessionRequestSchema, managementRequestSchema]);

const safeJsonParse = (event: LambdaEvent): { ok: true; value: unknown } | { ok: false } => {
  if (!event.body) return { ok: false };
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
};

const nowIso = () => new Date().toISOString();

/** A read-only view for a caller with no stored record yet (e.g. a bootstrap owner's first login). */
const synthesizedRecord = (email: string, owner: boolean, ts = nowIso()): UserRecord => {
  return {
    schema_version: 1,
    email,
    // D3 (2026-08-06): a friendly default, not the raw email — this only
    // ever runs when NO record exists yet (first login before any
    // update_me), so it can never clobber a display name a user set
    // (getUserRecord/`existing` short-circuits this call once one exists).
    display_name: friendlyNameFromEmail(email),
    role: owner ? 'owner' : 'admin',
    status: 'active',
    invited_by: 'bootstrap',
    created_at: ts,
    updated_at: ts,
    audit: [],
  };
};

// T18.6a: `ListedUser` / `listUsersWithEnvironment` moved to membership/verbs.ts; re-exported for callers.
export { listUsersWithEnvironment, type ListedUser } from '../lib/membership/verbs.js';

const handlerImpl = async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  // T18.0a: `invite_preview` is PUBLIC — the accept page calls it before the
  // invitee has any session. It is answered before auth and before the store
  // is opened, and returns nothing user-specific. Limitation, by design: the
  // GoTrue invite token cannot be validated here (only GoTrue can, and an
  // unauthenticated request carries no admin token to ask with), so `token`
  // is accepted and ignored; the page shows the e-mail AFTER GoTrue accepts,
  // from the new session's `/user`.
  const parsed = safeJsonParse(event);
  if (parsed.ok) {
    const peek = parsed.value as { verb?: unknown } | null;
    if (peek && typeof peek === 'object' && peek.verb === 'invite_preview') {
      const request = requestSchema.safeParse(parsed.value);
      if (!request.success) {
        return jsonResponse(400, { error: 'Invalid request fields.', issues: request.error.issues });
      }
      const identity = getSiteIdentity();
      // T18.2 path 2: an Owner-shared link may carry OUR accept token (`inv`),
      // which previews inviter/role before GoTrue accepts. Optional sugar.
      let invitation: Record<string, unknown> | undefined;
      const inv = (request.data as { inv?: string }).inv;
      if (inv) {
        try {
          const preview = await previewInvitationByToken(await getUsersBlobStore(event), inv);
          if (preview) invitation = preview;
        } catch {
          invitation = undefined;
        }
      }
      return jsonResponse(200, {
        site: { name: identity.brandName, slug: identity.siteSlug },
        policy: { min_password: ACCEPT_MIN_PASSWORD },
        ...(invitation ? { invitation } : {}),
      });
    }
  }

  const adminState = await getAdminStateFromEvent(event, context);
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });

  const email = normalizeUserEmail(adminState.email ?? '');
  if (!email) return jsonResponse(403, { error: 'A verified email is required.' });
  const principal: Principal = { kind: 'human', id: adminState.userId ?? '', email };

  if (!parsed.ok) return jsonResponse(400, { error: 'Invalid request body.' });
  const request = requestSchema.safeParse(parsed.value);
  if (!request.success) return jsonResponse(400, { error: 'Invalid request fields.', issues: request.error.issues });

  try {
    const store = await getUsersBlobStore(event);

    // T18.0a: `accept` runs on the fresh JWT GoTrue's /verify returned. It is
    // authenticated (verified e-mail from the token) but NOT role-gated: an
    // invitee's roles come from the very record this verb activates, and a
    // Netlify-UI invitee has no record (and no roles) at all. Uses the
    // caller's verified e-mail — never a body-supplied one.
    if (request.data.verb === 'accept') {
      const at = nowIso();
      const acceptParsed = sessionRequestSchema.safeParse(request.data);
      if (!acceptParsed.success) {
        return jsonResponse(400, { error: 'Invalid request fields.', issues: acceptParsed.error.issues });
      }
      const acceptArgs = acceptParsed.data as { verb: 'accept'; display_name: string };
      const accepted = await acceptInvitation(store, email, adminState.userId, acceptArgs.display_name, at);
      if (accepted) {
        if (accepted.status === 'disabled') return jsonResponse(403, { error: 'This membership is disabled.' });
        // T18.1/T18.2: acceptInvitation stamped onboarding (password + name),
        // closed the pending invitation and wrote the audit event.
        return jsonResponse(200, { user: accepted, needs_grant: false });
      }
      if (environmentRoleForEmail(email) === 'owner') {
        // Bootstrap ADMIN_EMAILS caller: the existing `me` materialization,
        // unchanged (plus the name they just typed).
        const bootstrapOwner: UserRecord = {
          ...synthesizedRecord(email, true, at),
          display_name: acceptArgs.display_name,
          user_id: adminState.userId,
          last_seen_at: at,
          audit: [{ at, actor_email: email, action: 'bootstrap_activate' }],
        };
        await putUserRecord(store, bootstrapOwner);
        return jsonResponse(200, { user: bootstrapOwner, bootstrap: true, needs_grant: false });
      }
      // No record: invited from the Netlify UI (plan §4.2). Create nothing,
      // grant nothing — the layout shows "Ask an Owner to grant you a role"
      // (T18.0b renders it; T18.2 turns it into the unmanaged-identity flow).
      return jsonResponse(200, { user: null, needs_grant: true });
    }

    const roles = await resolveRolesForPrincipalAsync(principal, {
      getUserRecord: (e) => getUserRecord(store, e),
    });
    if (!roles.includes('admin')) return jsonResponse(403, { error: 'Admin access required' });
    const owner = isOwner(roles);

    // T18.4/T18.6a: the GoTrue admin token Netlify injects into Identity-JWT
    // requests, the platform fetch, and the offboarding side-effect deps the
    // membership core takes (opened lazily).
    const identityCtx = (context as { clientContext?: { identity?: GoTrueIdentity } } | undefined)?.clientContext
      ?.identity;
    const fetchImpl = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
      fetch(url, init);
    const oauthStore = () =>
      getNetlifyBlobStore({ name: 'governance', consistency: 'strong' }, event) as unknown as Promise<OAuthBlobStore>;
    const objectStore = () => getSiteObjectsBlobStore(event);
    // avatar ref is image/<requestId>/<sha256>.<ext> (isTrustedAvatarRef) → soft-delete that artifact
    const softDeleteAvatar = async (ref: string) => {
      const m = /^image\/([^/]+)\/([0-9a-f]{64})\./i.exec(ref);
      if (!m) return;
      await softDeleteArtifact(event as never, { requestId: m[1], sha256: m[2], deletedBy: email });
    };

    const req = request.data;
    const sessionParsed = SESSION_VERBS.has(req.verb) ? sessionRequestSchema.safeParse(req) : undefined;
    if (sessionParsed && !sessionParsed.success) {
      return jsonResponse(400, { error: 'Invalid request fields.', issues: sessionParsed.error.issues });
    }
    if (!sessionParsed) {
      // W18 T18.6a: every management verb runs in the membership core with
      // the human principal this function authenticated (`via:'admin_ui'`).
      // The gate, tier checks, guards, side effects and audit live there.
      const result = await handleMembershipVerb({
        verb: req.verb,
        args: parsed.value as Record<string, unknown>,
        principal: { kind: 'human', id: adminState.userId ?? '', email, via: 'admin_ui' },
        deps: {
          store,
          identity: identityCtx,
          fetchImpl,
          oauthStore,
          objectStore: objectStore as never,
          softDeleteAvatar,
        },
      });
      return jsonResponse(result.status, result.body);
    }
    const session = sessionParsed.data;
    switch (session.verb) {
      // (req narrowed to the session union above)
      case 'invite_preview':
        // Answered above, before auth (and `accept` is narrowed out above);
        // unreachable — kept so the switch stays exhaustive.
        return jsonResponse(400, { error: 'Invalid request fields.' });

      case 'me': {
        // T9.5/T9.6: first-login activation (invited → active + stamp user_id)
        // and last_seen on every self-read. Materialize a missing bootstrap
        // Owner deliberately so the members list reflects their real access.
        const at = nowIso();
        const activated = await activateOnLogin(store, email, adminState.userId, at);
        if (activated) {
          await appendAudit(store, {
            at,
            actor: auditActorFromPrincipal(principal),
            action:
              activated.status === 'active' && activated.audit.at(-1)?.action === 'activate'
                ? 'membership.activate'
                : 'person.login',
            target: { person_id: activated.person_id ?? personIdForEmail(email), email },
            via: 'admin_ui',
          }).catch(() => undefined);
        }
        if (!activated && environmentRoleForEmail(email) === 'owner') {
          const bootstrapOwner: UserRecord = {
            ...synthesizedRecord(email, true, at),
            user_id: adminState.userId,
            last_seen_at: at,
            audit: [{ at, actor_email: email, action: 'bootstrap_activate' }],
          };
          await putUserRecord(store, bootstrapOwner);
          const materialised = await getUserRecord(store, email);
          return jsonResponse(200, {
            user: materialised ?? bootstrapOwner,
            bootstrap: true,
            roles,
            onboarding: materialised?.onboarding ?? { steps: {} },
            policy: { require_display_name: (await getPolicy(store)).require_display_name },
          });
        }
        return jsonResponse(200, {
          user: activated ?? synthesizedRecord(email, owner),
          bootstrap: !activated,
          roles,
          // T18.5: the welcome gate reads these (no record ⇒ no onboarding ⇒ the
          // layout's forbidden panel, never a redirect loop).
          onboarding: activated?.onboarding ?? null,
          policy: { require_display_name: (await getPolicy(store)).require_display_name },
        });
      }

      case 'update_me': {
        // T9.6: an avatar must be an uploaded image artifact reference
        // (image/<id>/<sha256>.<ext>) — never an arbitrary URL or data URI.
        if (session.avatar_artifact !== undefined && !isTrustedAvatarRef(session.avatar_artifact)) {
          return jsonResponse(400, {
            error: 'Avatar must be an uploaded image artifact reference, not a URL.',
          });
        }
        const base = (await getUserRecord(store, email)) ?? synthesizedRecord(email, owner);
        const updated: UserRecord = {
          ...base,
          display_name: session.display_name ?? base.display_name,
          avatar_artifact: session.avatar_artifact ?? base.avatar_artifact,
          updated_at: nowIso(),
          last_seen_at: nowIso(),
          audit: [...base.audit, { at: nowIso(), actor_email: email, action: 'update_profile' }],
        };
        await putUserRecord(store, updated);
        if (session.display_name) {
          await stampOnboarding(store, email, { steps: { name: nowIso() }, at: nowIso() }).catch(() => undefined);
        }
        if (session.onboarding_step) {
          const at = nowIso();
          await stampOnboarding(store, email, {
            steps:
              session.onboarding_step === 'name'
                ? { name: at }
                : { tour: session.onboarding_step === 'skipped' ? 'skipped' : at },
            ...(session.onboarding_step === 'name' ? {} : { completed_at: at }),
            at,
          }).catch(() => undefined);
        }
        await appendAudit(store, {
          at: nowIso(),
          actor: auditActorFromPrincipal(principal),
          action: 'person.update_profile',
          target: { person_id: updated.person_id ?? personIdForEmail(email), email },
          via: 'admin_ui',
        }).catch(() => undefined);
        return jsonResponse(200, { user: (await getUserRecord(store, email)) ?? updated });
      }
    }
    return jsonResponse(400, { error: 'Invalid request fields.' });
  } catch (error) {
    console.error('Admin_Users request failed.', error);
    return jsonResponse(500, { error: 'User request could not be processed.' });
  }
};

// Re-export for tests that exercise the store surface directly.
export type { UsersBlobStore };

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (_binding: SiteBinding) => handlerImpl;
