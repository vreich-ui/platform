/**
 * session.ts — the `me` read, as a leaf.
 *
 * `me` is the one membership verb that is NOT a management verb: it acts on
 * the caller's own record, it is the read every admin page load makes, and it
 * stays outside `verbs.ts` for exactly that reason (see that file's header).
 * It lived inline in `functions/admin-users.ts` until `admin-shell.ts` needed
 * to answer it as one section of a single coalesced response — and importing
 * `admin-users.ts` to get at it would have dragged the whole management
 * surface (`membership/verbs.ts` → `offboarding.ts` → `oauth-store.ts`, plus
 * `artifact-soft-delete.ts` → `artifacts.ts`/`artifact-index.ts`: ~150 KB of
 * first-party cold start) into a function that cannot mutate anything.
 *
 * So the read moved down here, where both callers reach it and neither
 * reaches the other's write paths. The body is VERBATIM from
 * `admin-users.ts`'s `me` case (T9.5/T9.6 → T18.1/T18.5, and T5.1 R10's
 * throttled `last_seen_at`) apart from its shape: it returns
 * `{ status, body }` rather than a Lambda response, because one caller puts
 * it on the wire as the whole response and the other as one section of a
 * larger document.
 *
 * ONE deliberate payload change (T-shell): `policy` carries the WHOLE
 * membership policy, not just `require_display_name`. `getPolicy` already
 * read the whole record to answer that one field, so this costs no extra blob
 * read — and it is what removes the third `admin-users` call from
 * `/admin/settings/admins`, where `policy_get` was being asked for
 * separately for data this response was already holding. `policy_get` stays
 * exactly as it was for every other caller.
 */
import { friendlyNameFromEmail } from '../../../lib/admin/display-name.js';
import type { MembershipPolicy } from '../../../lib/membership-policy.js';
import type { Principal } from '../../../schema/object-record-v1.js';
import { environmentRoleForEmail, type Role } from '../roles.js';
import { getUserRecord, putUserRecord, type UserRecord, type UsersBlobStore } from '../users-store.js';
import { activateOnLoginDetailed } from './invitations.js';
import { auditActorFromPrincipal, personIdForEmail } from './store.js';
import { appendAudit, getPolicy } from './write.js';

const nowIso = () => new Date().toISOString();

/** A read-only view for a caller with no stored record yet (e.g. a bootstrap owner's first login). */
export const synthesizedRecord = (email: string, owner: boolean, ts = nowIso()): UserRecord => {
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

/** What a `me` read answers with, before either caller decides how to frame it. */
export interface MeSectionResult {
  status: number;
  body: {
    user: UserRecord | null;
    bootstrap: boolean;
    roles: Role[];
    /** T18.5: null = no stored record; the welcome gate reads this. */
    onboarding: UserRecord['onboarding'] | null;
    /** T-shell: the whole policy, from the read `getPolicy` was already making. */
    policy: MembershipPolicy;
  };
}

/**
 * The caller's own record, activated on login.
 *
 * `roles` is passed IN rather than resolved here: both callers have already
 * resolved the caller's tier to gate the request, and `admin-shell.ts`'s
 * entire reason to exist is that the tier is resolved exactly once per
 * invocation and shared across every section of the answer.
 */
export const resolveMeSection = async (args: {
  store: UsersBlobStore;
  email: string;
  userId?: string;
  roles: Role[];
  owner: boolean;
  principal: Principal;
}): Promise<MeSectionResult> => {
  const { store, email, userId, roles, owner, principal } = args;
  // T9.5/T9.6: first-login activation (invited → active + stamp user_id)
  // and last_seen on every self-read. Materialize a missing bootstrap
  // Owner deliberately so the members list reflects their real access.
  const at = nowIso();
  /**
   * T5.1 R10 (F11): `me` is a READ that every admin page load makes,
   * and it used to cost TWO blob writes — `saveMember` to stamp
   * `last_seen_at`, and an audit append. `activateOnLoginDetailed`
   * now reports whether it actually persisted anything (it throttles
   * `last_seen_at` to `LAST_SEEN_REFRESH_MS`), and the audit entry
   * rides that same decision so the two stay in step.
   *
   * BEHAVIOUR CHANGE, deliberate and disclosed: the `person.login`
   * audit entry is appended at most once an hour per person instead
   * of once per page load. `membership.activate` — the entry that
   * records a real state transition — is unaffected, because a
   * genuine activation always writes.
   */
  const activation = await activateOnLoginDetailed(store, email, userId, at);
  const activated = activation?.record ?? null;
  if (activated && activation?.wrote) {
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
  const policy = await getPolicy(store);
  if (!activated && environmentRoleForEmail(email) === 'owner') {
    const bootstrapOwner: UserRecord = {
      ...synthesizedRecord(email, true, at),
      user_id: userId,
      last_seen_at: at,
      audit: [{ at, actor_email: email, action: 'bootstrap_activate' }],
    };
    await putUserRecord(store, bootstrapOwner);
    const materialised = await getUserRecord(store, email);
    return {
      status: 200,
      body: {
        user: materialised ?? bootstrapOwner,
        bootstrap: true,
        roles,
        onboarding: materialised?.onboarding ?? { steps: {} },
        policy,
      },
    };
  }
  return {
    status: 200,
    body: {
      user: activated ?? synthesizedRecord(email, owner),
      bootstrap: !activated,
      roles,
      // T18.5: the welcome gate reads these (no record ⇒ no onboarding ⇒ the
      // layout's forbidden panel, never a redirect loop).
      onboarding: activated?.onboarding ?? null,
      policy,
    },
  };
};
