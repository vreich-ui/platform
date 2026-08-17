# 2026-08-17 — Membership defaults (W18): the four §9 decisions, ruled by default under R8

**Status: RULED-BY-DEFAULT (R8), 2026-08-17 — awaiting Wolf's signature or
override.** [`../18-membership-plan.md`](../18-membership-plan.md) §9 put four
bounded decisions to Wolf. W18 ran end-to-end (T18.0a → T18.7, one session,
"execute this pipeline fully unless there is full blockage") and none of the
four is an account-authority gate, so under **R8** (CLAUDE.md — "agents make
reasonable decisions, record them, and keep moving") each was taken as its
recommended default, built that way, and is recorded here. Every one is a
one-line config or verb-flag change to reverse; nothing was locked in.

## The four defaults, as built

| # | Question (plan §9) | Default taken | Where it lives | To override |
|---|---|---|---|---|
| 1 | **Provider** — stay on Netlify Identity / GoTrue endpoints wrapped by our own client, or adopt `@netlify/identity` | **Keep GoTrue endpoints, wrapped ourselves.** `lib/admin/goTrueClient.ts` gained `acceptInvite`, `exchangeRecoveryToken`, `confirmSignup`, `confirmEmailChange`, `setFullName`; `/admin/accept` consumes every Identity token shape (T18.0b). `@netlify/identity` was NOT adopted (no MFA/SSO need; the hand-rolled client is now token-complete and tested against a GoTrue mock in T18.9). | `packages/core/lib/admin/goTrueClient.ts`, `app/routes/admin/accept.astro` | A future row swaps the client behind the same verbs; the accept page and the store are provider-agnostic. |
| 2 | **Who may invite editors/viewers** — Owner only, or Owner+Admin | **Owner+Admin for `editor` and `viewer`; Owner alone for `admin`, `publisher`, `owner`.** `policy.who_can_invite = 'owner_admin'`, `roles_admin_may_grant = ['editor','viewer']` (T18.1/T18.2 `assertMayInvite`). | `packages/core/lib/membership-policy.ts` `DEFAULT_MEMBERSHIP_POLICY` | Per site: `sites/<client>/config/membership-policy.ts` (committed, T18.7) or an Owner's `membership_policy_set` (runtime `policy.json`). |
| 3 | **Delete the Identity login on `remove`** — on or off | **On, behind a flag defaulting to true.** `policy.delete_identity_on_remove = true`; `remove` accepts `delete_identity?: boolean`. Per-site Identity instances make it safe (the person's login on OTHER tenants is untouched — one Identity instance per site). Deleted at request time when the Owner's request carries an Identity JWT, otherwise queued and drained on the next such request (T18.4, plan §5). | same as #2 + `membership/offboarding.ts` | Same two levers as #2, or `delete_identity:false` per call. |
| 4 | **Fleet person model** — one deterministic `person_id` across sites, or per-site ids | **Yes — deterministic.** `person_id = 'usr_' + base32(sha256(lower-cased e-mail))[:20]` at first sight (T18.1 `personIdForEmail`), so the same human converges on the same id in every tenant's `users` store with no shared table; `membership/fleet.ts` `listMembershipsForPerson` is the (caller-less) seam (T18.7, plan §2.2). | `packages/core/server/lib/membership/store.ts`, `fleet.ts` | Reversing this later means re-keying stores; the cost of keeping it is zero. Recommend leaving as is. |

## The override mechanism

Wolf overrides any row by **a comment on the W18 rows in
`cms-pipeline/queue.tsv`** (the same channel every earlier ruling used):
`# W18 ruling <date>: §9-<n> → <choice>`. The follow-up is a one-task row
(`T18.x: apply ruling §9-n`) that flips the named default; for #2 and #3
that is a config edit plus a test-expectation change, for #1 a client swap,
for #4 a migration (not recommended).

## Signature

Wolf: ______________________  date: __________  ☐ accept all four as ruled ☐ override: ______

