# 18 — Membership plan: user-management review & schema (W18)

> **Status (2026-08-17):** W18 plan, commissioned by Wolf ("review and find issues with user management … plan an optional schema"). Execution rows: `cms-pipeline/queue.tsv` (T18.x), briefs `cms-pipeline/T18.*.md`, run order in §10 below. Wolf's four §9 decisions carry the recommended defaults as **governing-unless-overridden** (R8) so the pipeline never parks on them; overriding one is a queue-comment edit, not a re-plan.

**Repo:** `vreich-ui/platform` (main, 2026-08-17). **Scope:** identity, roles, invitations, onboarding, profile, offboarding, and the AI/MCP surface for all of it — across `packages/core` and the four `sites/<client>` tenants (drlurie, platform, fernwell, zilberman).
**Audience:** Wolf + the agent that picks up the W18 rows this produces.

---

## 0. Executive summary

User management today is a thin **T9.4/T9.5 slice**: a per-site `users` Netlify Blobs store keyed by e-mail (`owner|admin`, `invited|active|disabled`), an Owner-only `/admin/settings/admins` page with invite / set-role / disable, `ADMIN_EMAILS` bootstrap Owners in env, and Netlify Identity (GoTrue) as the only credential provider. It works for a team of one Owner logging in with a pre-existing Identity account. Everything past that is broken or missing:

| # | Finding | Severity |
|---|---|---|
| F1 | **Invite links do not work.** The site uses a hand-rolled GoTrue client (`goTrueClient.ts`) instead of the Identity widget / `@netlify/identity`, and it never handles `#invite_token=` (or `#confirmation_token=`, `#email_change_token=`). Netlify's invite e-mail links to `{{ .SiteURL }}/#invite_token=…` → the invitee lands on the site home page (the "offer page"), the hash is silently ignored, there is nowhere to set a name or password, and the GoTrue user stays unconfirmed forever. | **Blocker** |
| F2 | **Platform-originated invites never send an e-mail** — `inviteUser()` POSTs to GoTrue `/admin/users`, which *creates* a user and requires a password (422 without one) and never sends mail. The invite endpoint is `POST /invite`. Today the store record is written, `invite.sent` is `false`, and the UI toasts "Record created; invite email pending" forever. | **Blocker** |
| F3 | **Password-recovery hash likely mismatched too.** `handleRecoveryCallback` looks for `#access_token=…&type=recovery` (a Supabase/`GET /verify`-redirect shape) while GoTrue's default recovery e-mail links to `#recovery_token=…`. Verify against your Emails settings; if the template is default, "forgot password" is dead as well. | High (verify) |
| F4 | **No AI / MCP surface for membership.** Neither the site `/mcp` tool list (≈70 tools) nor the admin-chat tool registry (`server/lib/agent/tools.ts`) has a single user/member/role/invite tool. Agents (`Principal.kind = 'agent'`) resolve to *no roles* by design, so a user tool would need the OAuth human principal path (W14 F10 — exists) — but none is wired. | High |
| F5 | **No delete / offboarding.** `disable` flips a store flag only: the GoTrue account, its refresh tokens, its OAuth grants (`mcp-oauth`), and any held object locks all survive. There is no delete, no purge, no "remove from Identity", no lock hand-off, and no way to re-activate except the invite verb — which (F6) doesn't reactivate. | High |
| F6 | **Re-invite doesn't reactivate.** `inviteUser` on an existing record keeps `status` as-is, so a `disabled` member who is "re-invited" (the UI copy promises exactly this) stays disabled with a new role. | Medium |
| F7 | **Roles are half-modelled.** The store knows `owner|admin`; `publisher|editor` exist only as env allowlists (`ROLE_EMAILS_*`) with no UI, no audit, no per-site management, and `list` shows them as `source: 'environment'` rows that no verb can change (409). GoTrue `app_metadata.roles` is written on invite but never read. There is no editor tier the UI can assign, and there is no notion of a *pending* role on an invitation vs an *effective* role on a membership. | Medium |
| F8 | **No name capture at onboarding.** `display_name` is derived from the e-mail (`friendlyNameFromEmail`) and only editable afterwards on `/admin/profile`; GoTrue `user_metadata.full_name` is never read or written; there is no "finish setting up your account" step. | Medium |
| F9 | **Invitations are not first-class.** No invitation object: no token/expiry, no revoke, no resend, no "who invited whom, when, accepted when", no idempotency guard against the same address being invited from Netlify UI *and* the platform (two sources of truth: GoTrue user list vs `users` blob store, reconciled only implicitly on first `me`). | Medium |
| F10 | **Bootstrap owners are unmanageable and invisible to audit.** `ADMIN_EMAILS` members are synthesised on every `list`, cannot be edited/disabled (409), and their `bootstrap_activate` is the only audit event they ever get. Fine as a break-glass, wrong as the *normal* way the first Owner exists (the provisioning runbook step 3 relies on invite, which is broken → today the runbook is not executable). | Medium |
| F11 | **Fleet parity gap (P1/P2).** Every tenant has its own Identity instance + `users` store; there is no cross-site person, no "Wolf is Owner on all four", no fleet-admin surface, and the capability probe does not check Identity wiring / e-mail template paths. | Low (V1) / High (V2) |
| F12 | Small things: `disable` copy says "immediately" but sessions live until the JWT expires (≤1h) and functions only re-check roles per call; `set_role` cannot demote the *last* Owner-check is missing (you can strip every non-env Owner); no rate-limit on `invite`; `list` is O(N) blob reads with no paging. | Low |

The reported symptoms map to F1 (+F3) for "link doesn't work / lands on offer page / can't add name or finalize", F2 for "invited from Netlify UI" being the only route that produces mail at all, and F4/F5 for "not possible to use AI to add or delete users, assign roles".

The rest of this document: §1 evidence per finding, §2 the proposed schema, §3 lifecycles/state machines, §4 the onboarding flows (with best-practice references), §5 offboarding/deletion, §6 admin/editor management + permission matrix, §7 the AI/MCP tool surface, §8 migration & task breakdown, §9 open decisions for Wolf.

---

## 1. Findings — evidence and root cause

Paths are under `packages/core/` unless stated.

### F1 — invite token never consumed (the "offer page" bug)

- Netlify Identity's invite mail defaults to `{{ .SiteURL }}/#invite_token={{ .Token }}` (GoTrue `mailer/template.go`; Netlify docs "Identity-generated emails"). The site root of every tenant is the public home/offer page.
- The site does **not** load the Identity widget or `@netlify/identity` anywhere: `app/utils/netlifyIdentityLoader.ts` exists but has **zero importers**. Auth is `lib/admin/goTrueClient.ts` (custom fetch to `/.netlify/identity/{token,user,recover,logout,authorize}`).
- The only hash handlers are `handleOAuthCallback` (`#access_token=` from Google) and `handleRecoveryCallback` (`type=recovery`), wired in `app/components/common/HeaderAuthButton.astro:308-330`. **`invite_token`, `confirmation_token`, `email_change_token` are not read by anything** (repo-wide grep).
- Consequence: the invitee's GoTrue user stays `invited/unconfirmed`, no password exists, `POST /token` fails, and the platform `users` record (if any) stays `invited` forever. There is no page that could collect a name — `LoginModal.astro` has sign-in / recovery only, no signup/accept mode.
- Correct acceptance is `POST {identity}/verify { type: 'signup', token: <invite_token>, password }` → GoTrue confirms the user, stores the password and returns a session (`api/verify.go`: "Invited users must specify a password"). Optionally `PUT /user { data: { full_name } }` afterwards, then `POST /admin-users me` to flip the store record.

### F2 — wrong GoTrue endpoint for platform invites

- `server/lib/user-invite.ts:74-84` → `POST ${identity.url}/admin/users` with `{ email, app_metadata }`.
- GoTrue `api/admin.go` `adminUserCreate`: **password mandatory** (`validatePassword` → 422), **sends no e-mail**. The mail-sending endpoint is `POST /invite { email, data }` (admin token) — `api/invite.go`.
- The unit test `tests/netlify/user-invite.test.ts:61` pins the *wrong* URL (`/admin/users`), so CI is green while production silently fails. `invite.sent` is `false` → toast "invite email pending" (`admin/AdminUsers.tsx:98`).
- Also: even with `/invite`, GoTrue's invite does not accept `app_metadata`; role must be set with `PUT /admin/users/{id}` after invite (or, better, not stored in GoTrue at all — see §2).

### F3 — recovery hash shape

- `lib/admin/goTrueClient.ts:254-266` expects `#access_token=…&type=recovery`. GoTrue's default recovery mail is `#recovery_token=…`, which must be exchanged via `POST /verify { type:'recovery', token }` to obtain the session used by `PUT /user { password }`. Unless the site's Emails settings were customised to a template that yields the `access_token` form, reset links are dead. **Action: check Project configuration → Identity → Emails on drlurie/platform.**

### F4 — no AI/MCP membership tools

- `server/lib/mcp-tool-definitions*.ts`: no `user_*`/`member_*`/`invite_*` tools. `server/lib/agent/tools.ts` (admin chat): `get_object … apply_theme, list_workspace_nodes …` — none.
- `server/lib/roles.ts` `resolveRolesForPrincipalAsync`: `principal.kind !== 'human' → []`. So even if a tool existed under the shared `MCP_HTTP_AUTH_TOKEN`, it would 403 (correct — membership is Owner-only). The OAuth 2.1 server (`server/lib/oauth-server.ts`) *does* bind an MCP session to a Netlify Identity human with admin/owner role → this is the path membership tools must require.

### F5 / F6 — disable is not offboarding; re-invite is not reactivation

- `server/functions/admin-users.ts` `disable`: sets `status:'disabled'`, appends audit. Nothing touches GoTrue (`DELETE /admin/users/{id}` exists — `api/admin.go adminUserDelete`), nothing revokes OAuth refresh/access tokens in `oauth-store`, nothing force-checks-in the member's held locks (`checkin{force}` exists for Owners but is not invoked).
- `user-invite.ts:44-55` `existing ? {...existing, role, audit:[…'reinvite']}` — `status` untouched.

### F7 — role model

- Store enum `userRoleSchema = ['owner','admin']` (`users-store.ts:19`); `Role = 'owner'|'admin'|'publisher'|'editor'` in `roles.ts`; `expandRole` maps store roles only. Env rows (`ROLE_EMAILS_*`) are unmanageable from the UI (`admin-users.ts` invite/set_role/disable → 409). Plan §8 of `10-admin-workspace-plan.md` acknowledged "a visible third tier = OQ-W9-4" — still open.
- `publish-gate.ts` reads `admin|publisher`; `canDecideReview` = any role. So a future `editor` tier already has a meaning server-side (can decide reviews, cannot publish) — it just cannot be assigned.

### F8 — name capture

- Record `display_name` defaults via `friendlyNameFromEmail` (`admin-users.ts` synthesizedRecord, `user-invite.ts` new-record branch). GoTrue `user_metadata.full_name` never read (`goTrueClient.ts` keeps `user_metadata` opaque). `ProfilePage.tsx` is the only place a name is set — after login. No "welcome / complete your profile" step exists.

### F9 — no invitation object

- The invitation *is* the user record with `status:'invited'`. No token, no expiry, no revoke, no resend counter, no `accepted_at`, no source (`netlify_ui | platform | mcp`). Two sources of truth: GoTrue's user table (what Netlify UI shows) and the `users` blob store. A member invited only from Netlify UI has *no* store record until first `me`, at which point `activateOnLogin` returns `null` and they get `synthesizedRecord(email, owner=false)` — i.e. any Identity user who somehow logs in becomes… nothing (roles from env only) — safe, but invisible in the members list until then.

### F10 — bootstrap owners

- `listUsersWithEnvironment` synthesises env rows on every list; `invite/set_role/disable` 409 for them. `me` materialises a bootstrap Owner record with `invited_by:'bootstrap'`. Fine as break-glass; but the runbook's "invite the first Owner from /admin/settings/admins" cannot currently work (F2), so every tenant is running on `ADMIN_EMAILS` alone.

### F11 — fleet

- One Identity instance + one `users` store per Netlify site (`getUsersBlobStore` → site-scoped blobs). No person↔sites mapping; `scripts/fleet-capability-probe.mjs` doesn't probe Identity enablement, invite-only registration, or e-mail template paths. `create-site.mjs` prints the `ADMIN_EMAILS` checklist row but nothing about Emails templates.

---

## 2. Proposed schema (V1.5 — additive over today's `users` store)

Design constraints honoured: Netlify Blobs (no SQL), per-site stores, zod-validated records with `schema_version`, audit arrays, env `ADMIN_EMAILS` remains the lockout-proof break-glass, `publish-gate.ts` byte-untouched, agents never get roles, humans reach MCP via OAuth. GoTrue stays the **credential** provider only (password / Google / sessions); **authorization state lives in our store**, never in `app_metadata`.

### 2.1 Entities (per site, blob store `users` → rename to `membership` or keep `users` with new prefixes)

```
users/            (store name unchanged: 'users')
  person/<person_id>.json            Person        — one per human, stable id, e-mail may change
  by-email/<email>                    → { person_id }   (index; today's key, kept for compat)
  by-identity/<gotrue_user_id>        → { person_id }   (index)
  membership/<person_id>.json        Membership    — this site's role/status for the person
  invitation/<invite_id>.json        Invitation    — pending/accepted/expired/revoked
  invitation-by-email/<email>        → { invite_id }   (one open invite per address)
  audit/<yyyy-mm>/<ulid>.json        AuditEvent    — append-only, per month (replaces per-record arrays; keep arrays for compat one release)
  policy.json                        MembershipPolicy — invite TTL, allowed domains, default role, min owners
```

#### Person
```ts
{ schema_version: 2,
  person_id: string,               // 'usr_' + ulid, minted server-side
  email: string,                   // normalized; unique via by-email index
  identity: { provider: 'netlify_identity', user_id?: string, confirmed_at?: string },
  display_name: string,            // required after onboarding; default friendlyNameFromEmail
  avatar_artifact?: string,        // image/<id>/<sha>.<ext> (isTrustedAvatarRef)
  locale?: string, timezone?: string,
  onboarding: { completed_at?: string, steps: { name?: string, password?: string, tour?: string } },
  created_at, updated_at, last_seen_at?
}
```

#### Membership  (the thing roles hang off)
```ts
{ schema_version: 2,
  person_id: string,
  site_id: string,                 // 'site_drlurie' — redundant per-store but explicit for fleet export
  role: 'owner'|'admin'|'publisher'|'editor'|'viewer',
  status: 'invited'|'active'|'suspended'|'removed',
  source: 'bootstrap_env'|'invitation'|'netlify_ui'|'mcp'|'import',
  invitation_id?: string,
  granted_by: { kind:'human', person_id } | { kind:'system', reason:'ADMIN_EMAILS' } | { kind:'agent', name, oauth_subject },
  suspended?: { at, by, reason? }, removed?: { at, by, reason?, purge_after: string },
  created_at, updated_at
}
```

#### Invitation
```ts
{ schema_version: 1,
  invite_id: string,               // 'inv_' + ulid
  email: string,
  role: Membership['role'],
  status: 'pending'|'accepted'|'expired'|'revoked',
  token_hash: string,              // sha256 of OUR opaque accept token (not the GoTrue token)
  gotrue: { invited: boolean, user_id?: string, error?: string, last_sent_at?: string, send_count: number },
  invited_by: { person_id, email }, message?: string,
  expires_at: string,              // policy.invite_ttl_hours (default 7 days)
  accepted?: { at, person_id }, revoked?: { at, by, reason? },
  created_at, updated_at
}
```

#### AuditEvent (append-only, immutable)
```ts
{ at, actor: Principal | {kind:'system'}, action:
   'invitation.create'|'invitation.resend'|'invitation.revoke'|'invitation.accept'|'invitation.expire'
  |'membership.activate'|'membership.role_change'|'membership.suspend'|'membership.reinstate'|'membership.remove'|'membership.purge'|'membership.transfer_ownership'
  |'person.update_profile'|'person.email_change'|'person.login'|'person.sessions_revoked',
  target: { person_id?, email, invite_id? }, detail?: Record<string,unknown>, request_id?: string, via: 'admin_ui'|'mcp'|'chat'|'system' }
```

#### MembershipPolicy (Owner-editable, committed default in `config/membership-policy.ts`)
```ts
{ invite_ttl_hours: 168, max_resends: 5, allowed_email_domains?: string[], default_role: 'admin',
  min_owners: 1, require_display_name: true, purge_grace_days: 30,
  who_can_invite: 'owner'|'owner_admin', roles_admin_may_grant: ['editor','publisher','admin'] }
```

### 2.2 Why this shape
- **Person ≠ Membership** so e-mail change, cross-site fleet view (V2 `fleet-admin`), and "removed but retained for audit" are representable. Today the record *is* the membership; renaming e-mail = losing the row.
- **Invitation as its own object** gives revoke/resend/expiry/idempotency and a place to store the GoTrue side-effect result, so Netlify-UI invites and platform invites converge (`source`).
- **`viewer` and `editor` tiers** make "admin/editor management" real without touching `publish-gate` (editor→`canDecideReview`, no publish; viewer→ read-only admin, chat read tools only).
- **Audit as a stream** — needed for "who did what across members", for the AI tools' `via` attribution, and for GDPR export.
- **Roles never in GoTrue `app_metadata`** — one source of truth; GoTrue is credentials only. (Keep writing `app_metadata.roles` *derived* if anything external reads it — nothing in this repo does.)

### 2.3 Compatibility
- `by-email/<email>` keeps working: read path tries v2 (`person`+`membership`), falls back to v1 record and lazily migrates on next write. `resolveRolesForPrincipalAsync` unchanged in signature; `expandRole` gains `publisher→['publisher']`, `editor→['editor']`, `viewer→['viewer']`.
- `ADMIN_EMAILS` precedence unchanged (bootstrap Owner always wins).
- **As built (T18.1, 2026-08-17):** store name stays `users`; keys exactly as §2.1 (`person/`, `by-email/` → `{ person_id }`, `by-identity/`, `membership/`, `invitation/`, `invitation-by-email/`, `audit/<yyyy-mm>/<ulid>.json`, `policy.json`). `users-store.ts` is the adapter (`getUserRecord`/`putUserRecord`/`listUserRecords` return a v1-shaped VIEW with `person_id`, `membership_status`, `membership_source` added; v2 `suspended`|`removed` both view as `disabled`). The per-record `audit[]` array is kept ON the membership (compat) and the stream gets `AuditEvent`s alongside; the committed policy default lives in `packages/core/lib/membership-policy.ts` (`DEFAULT_MEMBERSHIP_POLICY`, +`default_role_for_external`, `delete_identity_on_remove`). Membership `source` gained `legacy_v1` for rows upgraded from v1. `min_owners` counts stored ACTIVE owners + env bootstrap owners (`wouldBreachMinOwners`).

---

## 3. Lifecycles

### 3.1 Invitation
```
pending ──accept──▶ accepted (terminal; membership.status invited→active)
pending ──revoke──▶ revoked (terminal)
pending ──ttl─────▶ expired  (lazy on read + nightly sweep; resend creates NEW invite)
```
Rules: one `pending` per e-mail per site (409 with `existing_invite_id`); accepting requires GoTrue confirmation of the *same* address; accept is idempotent by token; expired tokens show a "request a new invite" page that pings the inviter (no self-service re-mint).

### 3.2 Membership
```
invited ──first verified login──▶ active
active  ──suspend──▶ suspended ──reinstate──▶ active
active|suspended|invited ──remove──▶ removed ──(purge_grace_days)──▶ purged (record tombstoned, audit kept)
removed ──reinvite──▶ new Invitation → invited (new membership row, old one stays removed for history)
```
Guards: cannot change own role/status (exists); cannot remove/demote the last active Owner (`min_owners`); env bootstrap Owners cannot be removed (409, existing) but **can be shown with an explicit "break-glass" badge and a "promote to stored Owner" action** so the env list can be emptied later.

### 3.3 Person / onboarding
```
(no person) ─invite/bootstrap─▶ person{onboarding: {}} ─accept: password+name─▶ steps.password, steps.name ─first /admin visit─▶ tour ─▶ onboarding.completed_at
```
`/admin` layout gate: if `require_display_name` and `onboarding.completed_at` missing → redirect to `/admin/welcome` (cannot be skipped except by Owner override).

---

## 4. Onboarding flows (what "best practice" looks like here)

Patterns borrowed (references at end): role assigned at invite time and copied onto the membership on accept (Clerk); pending/accepted/expired/revoked invitation states with resend + revoke, accept-as-verification, invite-only registration (WorkOS AuthKit / Netlify Identity "Invite only"); a dedicated **accept page** that consumes the token rather than the marketing home page (Netlify forum root-cause for exactly your symptom); minimal first-run: password → name → land in the workspace with a 3-step checklist; "removed ≠ deleted" with grace period and audit retention (GDPR-friendly), ownership transfer before removing an Owner.

### 4.1 Flow A — Owner invites from `/admin/settings/admins` (fixes F1/F2/F8/F9)
1. Owner: email + role (+ optional message). `POST admin-users {verb:'invite'}` →
   - create `Invitation{pending}` (409 if one pending; offer "resend" instead),
   - **GoTrue `POST /invite { email, data:{ invite_id } }`** with `context.clientContext.identity.token` (send mail); store result on `invitation.gotrue`,
   - upsert `Person` (no identity yet) + `Membership{invited}`; audit `invitation.create`.
2. E-mail template (**per site, Netlify → Identity → Emails → Invitation**) points to **`/admin/accept/#invite_token={{ .Token }}`** (custom template file committed at `packages/core/app/emails/invite.html`, path exported by `create-site` and checked by the capability probe — P2). Until templates are switched, `/` must *also* handle the hash (step 3 handles both).
3. New page **`/admin/accept`** (Astro, no auth gate) + a tiny root-level hash sniffer in `HeaderAuthButton.astro`: on any page, if `location.hash` has `invite_token|confirmation_token|recovery_token|email_change_token`, `location.replace('/admin/accept' + hash)`.
   `/admin/accept` reads the token, calls `GET /admin-users?verb=invite_preview&token=` (public, returns `{ email, site name, inviter, role, expired? }`) and renders **one form: full name, password (+confirm), Google alternative** ("Continue with Google" → `POST /verify {type:'signup', token}` is not possible for OAuth users; instead accept = `POST /invite`-created user logs in via provider → GoTrue links by e-mail. Keep password-first; Google is offered *after* acceptance).
   Submit → `POST {identity}/verify { type:'signup', token, password }` → session; then `PUT /user { data:{ full_name } }`; then `POST admin-users {verb:'accept', invite_id, display_name}` with the new JWT → membership `active`, invitation `accepted`, person `identity.user_id`, `onboarding.steps.{password,name}`; audit `invitation.accept`.
4. Redirect to `/admin/welcome` (name/avatar confirm, what your role can do, "open the canvas" CTA) → `onboarding.completed_at`.
5. `AdminUsers.tsx` members table gets an **Invitations tab**: pending rows with sent-time, expiry countdown, **Resend** (new GoTrue invite + `send_count++`), **Revoke**, and the GoTrue send status (so "email pending" is a real state with a fix button, not a dead toast).

### 4.2 Flow B — someone was invited from the Netlify UI (reconcile)
- Same `/admin/accept` page consumes `#invite_token` (works because it's GoTrue's token either way).
- On accept, `admin-users accept` finds no `Invitation` → creates `Membership{ status:'active', role: policy.default_role_for_external ('viewer'), source:'netlify_ui' }` and **flags it "needs role"** in the members list; Owner promotes. Nobody silently becomes admin because they were added in Netlify.
- Nightly/`list`-time reconcile (`GET {identity}/admin/users` with the injected admin token): show GoTrue users with no membership as "unmanaged identities" with actions *Grant role* / *Delete identity*.

### 4.3 Flow C — bootstrap Owner (first tenant login)
- Unchanged mechanics; add on first `me`: create Person + Membership `{source:'bootstrap_env'}` and route through `/admin/welcome` too (name capture). Members page shows a "Break-glass owner (env)" badge and **Promote to stored Owner** (creates a normal Owner membership so `ADMIN_EMAILS` can be emptied — the runbook then says: invite yourself, promote, remove env row).

### 4.4 Flow D — invited via AI (chat or MCP) — see §7
- Identical server path (`inviteUser` is the single implementation); the tool call is `ask`-class with an ApprovalCard "Invite **jane@x** as **Editor** to **Dr Lurié**"; `via:'chat'|'mcp'` on the audit.

### 4.5 Flow E — password recovery / e-mail change
- `/admin/accept` doubles as the callback page: `recovery_token` → `POST /verify {type:'recovery'}` → set-password form; `email_change_token` → `POST /verify`… then `admin-users {verb:'email_changed'}` re-indexes `by-email` (Person keeps `person_id`, Membership untouched, audit `person.email_change`).

---

## 5. Offboarding & deletion (F5)

Three verbs, all Owner-only, all audited, all idempotent with `idempotency_key`:

| Verb | Effect | Reversible |
|---|---|---|
| `suspend` (rename of `disable`) | membership `suspended` → roles `[]`; **revoke all OAuth access/refresh tokens for the person** (`oauth-store` by `subject_email`); GoTrue `PUT /admin/users/{id} { app_metadata:{ suspended:true } }` (informational) ; **force-checkin every lock held by the person** (`checkin{force}` under the actor's identity, history-attributed); optional GoTrue `POST /logout`-equivalent isn't available server-side → JWTs expire ≤ 60 min, functions already re-resolve roles per call, so effective lockout ≤ 1 h; document it | `reinstate` |
| `remove` | as suspend + membership `removed{purge_after}`; invitation (if pending) `revoked`; person stays for audit/attribution (history entries reference `person_id`); GoTrue account **kept** (other sites may use it — fleet) unless `--delete_identity` and the person has no other membership on this Identity instance (per-site instance today ⇒ safe to delete) | `reinvite` (new invitation) within grace; after purge only by new invite |
| `purge` (system, after `purge_grace_days`, or Owner "purge now") | Person PII scrubbed to `{ person_id, deleted:true }`, indexes removed, GoTrue `DELETE /admin/users/{id}`, avatar artifact soft-deleted (`soft_delete_artifact`), audit retained (actor becomes `person_id` only) | No |

Extra rules: `transfer_ownership` verb (Owner→Owner) required before the last stored Owner can be removed; removing yourself is 409 (exists); a GDPR **export** verb (`export_person`) returns Person + Memberships + audit slice + list of history entries authored (ids only).

---

## 6. Admin / editor management — permission matrix (v1.5)

| Capability | viewer | editor | publisher | admin | owner |
|---|---|---|---|---|---|
| Sign in to `/admin`, see objects, read chat history | ✓ | ✓ | ✓ | ✓ | ✓ |
| Chat with agents — read tools | ✓ | ✓ | ✓ | ✓ | ✓ |
| Checkout / patch / create drafts, chat write tools (ask-class) | — | ✓ | ✓ | ✓ | ✓ |
| Submit for review; **decide reviews** (`canDecideReview`) | — | ✓ | ✓ | ✓ | ✓ |
| Publish / release (`publish-gate` unchanged: admin|publisher) | — | — | ✓ | ✓ | ✓ |
| Recipes (template/theme create, apply_theme), guardrails, maintenance, force-checkin | — | — | — | — | ✓ |
| Members: list | — | — | — | ✓ (read) | ✓ |
| Members: invite `editor|viewer` | — | — | — | ✓ if `policy.who_can_invite='owner_admin'` | ✓ |
| Members: invite/set `publisher|admin|owner`, suspend/remove/purge, transfer ownership, policy | — | — | — | — | ✓ |
| Edit own profile / name / avatar | ✓ | ✓ | ✓ | ✓ | ✓ |

Server enforcement points: `admin-users` (all member verbs), `roles.ts expandRole` (new tiers), `admin-agent-chat` tool autonomy table (viewer = read-only registry), `AdminLayout.astro` (viewer/editor nav trimming), `mcp.ts` OAuth principal → same resolver.

---

## 7. AI / MCP surface (F4)

One implementation (`server/lib/membership/*.ts`), three front doors: `admin-users` function (UI), admin-chat tool registry (`server/lib/agent/tools.ts`), and MCP tool definitions (`mcp-tool-definitions-2.ts`) — like `handleObjectVerb` is for objects. All membership tools **require a human principal** (admin UI JWT, or MCP OAuth principal); the shared `MCP_HTTP_AUTH_TOKEN` agent principal gets `403 membership_requires_human` — this keeps "agents have no roles" intact while letting Wolf's Claude session (OAuth-bound) manage members.

| Tool | Class / autonomy | Min role | Args |
|---|---|---|---|
| `member_list` | read / auto | admin | `{ status?, role?, include_invitations? }` |
| `member_get` | read / auto | admin | `{ email | person_id }` |
| `member_audit` | read / auto | owner | `{ email?, since?, limit? }` |
| `member_invite` | write / **ask** | owner (admin for editor/viewer per policy) | `{ email, role, message?, idempotency_key? }` → `{ invitation, email_sent, accept_url_hint }` |
| `invitation_resend` / `invitation_revoke` | write / ask | owner | `{ invite_id | email }` |
| `member_set_role` | write / ask | owner | `{ email, role, reason? }` |
| `member_suspend` / `member_reinstate` | write / ask | owner | `{ email, reason? }` |
| `member_remove` | write / ask + typed confirm in UI, `confirm:true` in MCP | owner | `{ email, reason?, delete_identity?: boolean }` |
| `member_purge` | privileged / ask | owner | `{ email, confirm: 'PURGE <email>' }` |
| `ownership_transfer` | privileged / ask | owner | `{ to_email }` |
| `membership_policy_get/set` | read / privileged | owner | policy JSON |
| `member_export` | read | owner | `{ email }` (GDPR bundle) |

Chat approval cards render human copy ("Invite **jane@x** as **Editor**; an e-mail goes out from Netlify Identity") — dry-run first (`member_invite` with `dry_run:true` returns "would send / already pending / domain not allowed").
`object_contract`-style discoverability: add `membership_contract` (roles, verbs, policy, error catalogue: `invite_pending_exists`, `last_owner`, `env_managed_member`, `membership_requires_human`, `gotrue_invite_failed`, `invite_expired`, `invite_revoked`).

**Error-code catalogue as built (T18.1/T18.2, `admin-users` responses carry `error_code`; `InvitationError` in `membership/invitations.ts`):**

| code | HTTP | when |
|---|---|---|
| `invite_pending_exists` | 409 | an open invitation exists for the address (`existing_invite_id` returned) |
| `member_active` | 409 | inviting someone who is already an active member (`set_role` instead) |
| `member_exists` | 409 | `grant` for an address that already has a non-removed membership |
| `env_managed_member` | 409 | target is an `ADMIN_EMAILS`/`ROLE_EMAILS_*` principal |
| `last_owner` | 409 | `set_role`/`suspend` would leave < `policy.min_owners` (stored active + env bootstrap) |
| `invite_not_found` | 404 | no such `invite_id` / no open invitation for the e-mail |
| `invite_not_pending` | 409 | state is `accepted` |
| `invite_expired` | 409 | TTL passed (lazy-expired on read) — send a NEW invitation |
| `invite_revoked` | 409 | revoked; a new invitation is allowed |
| `resend_cap` | 429 | `gotrue.send_count ≥ policy.max_resends` (`send_count`, `max_resends` returned) |
| `domain_not_allowed` | 422 | `policy.allowed_email_domains` excludes the address |
| `invite_forbidden` | 403 | caller may not invite under `policy.who_can_invite` |
| `role_not_grantable` | 403 | an Admin invited a role outside `policy.roles_admin_may_grant` |
| `identity_admin_unavailable` | 200 (degraded) | `unmanaged_identities` had no injected admin token / GoTrue admin list failed → `identities: []` |
| `gotrue_invite_failed` | 200 (best-effort) | surfaced as `invite.error` / `invitation.gotrue.error`; the store record still exists |
| `already_invited` | 200 (best-effort) | GoTrue 422 "already registered/invited" — not a failure |

---

## 8. Migration & task breakdown (proposed W18 rows)

| Task | Scope | Notes |
|---|---|---|
| **T18.0 Hotfix — accept page + hash router + `/invite` endpoint** | `HeaderAuthButton.astro` hash sniffer; new `app/pages/admin/accept.astro` + `lib/admin/goTrueClient.ts` `acceptInvite(token,password)`, `verifyRecovery(token)`; `user-invite.ts` → `POST /invite`; fix `tests/netlify/user-invite.test.ts`; `admin-users accept` verb (activate + name). | Closes F1, F2, F3, F8-min. Ship first, alone. P1: applies to all four sites automatically (core); **per-site manual step**: Emails → Invitation/Recovery template path → `/admin/accept/#…` (add to provisioning runbook + `create-site` checklist + capability probe). |
| T18.1 Store v2 (Person / Membership / Invitation / Audit) with lazy migration; `expandRole` tiers; `min_owners`; reinvite reactivates | `server/lib/users-store.ts` → `membership/*.ts` | Closes F6, F7 (model), F9, F10 (promote), F12 |
| T18.2 Members UI: Invitations tab (resend/revoke/status), roles incl. editor/viewer, suspend/reinstate/remove, unmanaged-identity reconcile, break-glass badge | `admin/AdminUsers.tsx`, `lib/admin/users-client.ts` | |
| T18.3 Offboarding side-effects: OAuth token revocation, force-checkin, GoTrue delete/purge job, `transfer_ownership`, `export_person` | `oauth-store`, `object-verbs checkin{force}`, scheduled function | Closes F5 |
| T18.4 `/admin/welcome` onboarding + `require_display_name` gate + `bootstrap` through welcome | `AdminLayout.astro`, new page | Closes F8 |
| T18.5 Membership tools: chat registry + MCP definitions + `membership_contract`; human-principal gate; approval cards | `agent/tools.ts`, `mcp-tool-definitions-2.ts`, `mcp.ts` | Closes F4 |
| T18.6 Fleet: probe checks (Identity enabled, invite-only, template paths), `create-site` emits templates + checklist, FLEET-STATUS rows, `fleet-admin` cross-site person view (V2 seam only) | `scripts/fleet-capability-probe.mjs`, `cli/create-site.mjs`, docs | Closes F11 (V1 part) |
| T18.7 Docs: `docs/cms-architecture/18-membership-plan.md` (this), runbook §identity rewrite, KNOWN_ISSUES entries, queue.tsv rows | | R8: no parked questions except §9 |

Test plan highlights: accept-page E2E against a GoTrue mock (invite→verify→accept→me), env-precedence tests untouched, `publish-gate` pinned, `last_owner` guard, idempotent invite, resend cap, purge scrub, OAuth revoke on suspend, agent principal 403 on every member tool, MCP OAuth owner succeeds.

---

## 9. Decisions for Wolf (bounded — everything else is decided above)

1. **Provider:** stay on Netlify Identity (Netlify reversed the deprecation, Feb 2026, and recommends `@netlify/identity` for new work) vs. adopt `@netlify/identity` client in place of the hand-rolled `goTrueClient.ts` (it has `handleAuthCallback()` / `acceptInvite()` and would have prevented F1). Recommendation: **keep GoTrue endpoints, wrap them ourselves (T18.0), evaluate `@netlify/identity` for T18.1** — no MFA/SSO need today; Auth0 extension only if that changes.
2. **Who may invite editors/viewers** — Owner only (today) or Owner+Admin (`policy.who_can_invite`). Recommendation: Owner+Admin for `editor|viewer`, Owner for the rest.
3. **Delete identity on `remove`** — default on (per-site Identity instances make it safe) or off. Recommendation: on, behind `delete_identity` flag defaulting to true.
4. **Fleet person model** — keep per-site stores with a `person_id` that is *the same* across sites when Wolf's fleet-admin arrives (derive from `sha256(email)`-seeded ulid at first sight so it converges) — yes/no. Recommendation: yes; costs nothing now.

---

## References

- Repo evidence: `packages/core/server/lib/user-invite.ts`, `users-store.ts`, `roles.ts`, `admin-auth.ts`; `server/functions/admin-users.ts`; `lib/admin/goTrueClient.ts`; `app/components/common/{HeaderAuthButton,LoginModal}.astro`; `app/utils/netlifyIdentityLoader.ts` (unused); `admin/{AdminUsers,ProfilePage}.tsx`; `server/lib/agent/tools.ts`; `server/lib/mcp-tool-definitions*.ts`; `server/lib/oauth-server.ts`; `docs/cms-architecture/10-admin-workspace-plan.md` §6/§8; `docs/cms-architecture/site-provisioning-runbook.md` (identity steps); `tests/netlify/user-invite.test.ts`.
- GoTrue source: `api/invite.go` (POST /invite sends mail), `api/admin.go` (POST /admin/users requires password, sends nothing; DELETE/PUT admin users), `api/verify.go` (POST /verify type=signup with password accepts an invite), `mailer/template.go` (`#invite_token=`, `#confirmation_token=`, `#recovery_token=`, `#email_change_token=`).
- Netlify docs: [Registration and login](https://docs.netlify.com/manage/security/secure-access-to-sites/identity/registration-login/) (invite-only; `handleAuthCallback()` / `acceptInvite()` in `@netlify/identity`), [Identity-generated emails](https://docs.netlify.com/manage/security/secure-access-to-sites/identity/identity-generated-emails/) (custom template paths `{{ .SiteURL }}/some/path/#invite_token={{ .Token }}`), forum root-cause [“Accept the Invite” link always redirects to the home page](https://answers.netlify.com/t/accept-the-invite-link-always-redirects-to-the-home-page/107598), [Netlify Identity is staying (Feb 2026 reversal)](https://answers.netlify.com/t/netlify-identity-is-staying-feb-2026-reversal-what-changed-whos-affected-and-how-to-proceed/162733), [How do you programmatically invite Identity users with the GoTrue API?](https://answers.netlify.com/t/how-do-you-programmatically-invite-identity-users-with-the-gotrue-api/52121).
- Pattern references: [Clerk — organization invitations](https://clerk.com/docs/guides/organizations/add-members/invitations) (role at invite time, revoke, metadata → membership), [WorkOS AuthKit — invitations](https://workos.com/docs/user-management/invitations) (accept-as-verification, org-scoped invites), [WorkOS — developer's guide to user management](https://workos.com/guide/the-developers-guide-to-user-management).

---

## 10. Execution pipeline (W18 rows) — run order, models, gates

Rows live in `cms-pipeline/queue.tsv`; briefs in `cms-pipeline/T18.*.md`. Model tiering: **Fable (notify, interactive)** only where a wrong change over-grants, locks Wolf out, or leaves a removed member with a working token — T18.1 (store + resolver), T18.4 (revocation/lock/identity delete/purge), T18.6a (the human-principal gate for MCP/chat). **Opus 4.8** for auth-flow client code and definition work with blast radius (T18.0b, T18.2, T18.6b, T18.9). **Sonnet 5** for everything deterministic (T18.0a/c, T18.3a/b, T18.5, T18.7, T18.8).

| Wave | Task | Mode | Model · effort | Needs | Closes |
|---|---|---|---|---|---|
| **0 — hotfix (ship alone, release first)** | T18.0a invite endpoint + `accept`/`invite_preview` verbs | auto | sonnet-5 · medium | — | F2, F6-min |
| | T18.0b `/admin/accept` + site-wide token router + GoTrue client verbs | auto | opus-4-8 · high | 0a | F1, F3, F8-min |
| | T18.0c Identity e-mail templates, create-site checklist, parity audit, runbook | auto | sonnet-5 · low | 0b | F10-doc, F11-part |
| **1 — schema** | T18.1 store v2 (Person/Membership/Audit/Policy), five tiers, `last_owner`, lazy migration | **notify** | **fable-5 · high** | 0a | F6, F7, F10, F12 |
| **2 — invitations & UI** (T18.2 ∥ T18.3a in worktrees) | T18.2 Invitation object + verbs + reconcile | auto | opus-4-8 · medium | 1 | F9 |
| | T18.3a members page: tiers, suspend/reinstate/remove, break-glass, promote | auto | sonnet-5 · medium | 1 | F5-UI |
| | T18.3b invitations tab, unmanaged identities, accept preview | auto | sonnet-5 · medium | 2, 3a | F9-UI |
| | T18.5 `/admin/welcome` + name gate + bootstrap through welcome | auto | sonnet-5 · medium | 0b, 1 | F8 |
| **3 — offboarding** | T18.4 OAuth revocation, lock hand-off, identity delete, purge sweep, transfer, export | **notify** | **fable-5 · high** | 1, 2 | F5 |
| **4 — AI surface** | T18.6a `handleMembershipVerb` + human-principal gate + MCP/chat plumbing | **notify** | **fable-5 · xhigh** | 2, 4 | F4-core |
| | T18.6b tool definitions (MCP + chat), approval cards, `membership_contract` | auto | opus-4-8 · medium | 6a | F4 |
| **5 — fleet & closeout** | T18.7 probe family, create-site/migrate-site defaults, FLEET-STATUS, fleet person seam | auto | sonnet-5 · medium | 1, 4 | F11 |
| | T18.8 docs closeout, shim removal, CLAUDE.md W18 paragraph, defaults ruling file | auto | sonnet-5 · low | 3b, 5, 6b, 7 | — |
| **6 — acceptance** | T18.9 GoTrue-mock E2E harness (Part A) + **Wolf's credentialed run** (Part B, halts) | **notify** | opus-4-8 · high | 8 | W18 exit |

```
T18.0a ─▶ T18.0b ─▶ T18.0c                       (hotfix wave, releasable alone)
   └──▶ T18.1 (Fable) ─┬─▶ T18.2 ─┬─▶ T18.3b ──────────────┐
                       ├─▶ T18.3a ─┘                        │
                       ├─▶ T18.5 (needs 0b too)             │
                       └─▶ T18.4 (Fable, needs 2) ─┬─▶ T18.6a (Fable) ─▶ T18.6b ─┤
                                                   └─▶ T18.7 ──────────────────────┤
                                                                            T18.8 ─▶ T18.9 (Part B = Wolf)
```

Runner notes: every `auto` row fits the runner's circuit breakers (`--max-turns 60`, `--max-budget-usd 8` — raise to 12 for T18.0b/T18.2/T18.6b if a run stops on budget); the three Fable rows and T18.9 halt the runner by design. Nothing in W18 adds an env var (P2 asserted in T18.7). Every core change that touches a site's tree (templates, sweep shim + schedule) is applied to all four `sites/<client>` in the same commit (P1) — T18.0c, T18.4, T18.7 say so explicitly.

**What Wolf reviews when he comes back:** the hotfix wave diff (T18.0a–c) and the FLEET-STATUS console ticks; the three Fable commits' test files (they are the security boundary); T18.9 Part B, which is his run.
