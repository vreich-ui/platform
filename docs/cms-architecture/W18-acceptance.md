# W18 acceptance — Wolf's credentialed membership run (T18.9 Part B)

**Status: PREPARED, UNTICKED — 2026-08-17. Halts here: "T18.9 Part B — Wolf's turn".**
Part A (the GoTrue-mock harness) is green in `npm test`
(`tests/e2e/membership.e2e.test.ts`, 4 flows, ~0.7 s) and the browser router
smoke passed on a real Chromium against the built platform site
(`npm run test:e2e:browser`, 7/7). What follows is the human half: real
Netlify Identity e-mails, real console clicks, a real inbox — account
authority by nature (R8's one permitted halt).

**Read this first — one known defect, queued, not hidden.** The harness found
**D1** (queue row **T18.10**, brief
[`cms-pipeline/T18.10-tier-access-gates.md`](./cms-pipeline/T18.10-tier-access-gates.md)):
every admin function's sign-in gate is still the pre-W18
`roles.includes('admin')`, so an invited **editor / publisher / viewer** can
accept, gets an active membership with the right role — and then cannot load
`/admin` ("Admin access required"), so step 3 below stops at "lands in
`/admin` with Editor nav". Owners and Admins are unaffected; every other flow
(invite mail, accept page, welcome for Owner/Admin, suspend/remove/purge,
MCP/chat tools, recovery) is fully live. **Recommended order: run T18.10 (Fable,
notify) first, then this checklist in one sitting.** If you would rather see
the invite/accept mail land today, run steps 1–2 and step 3 up to the accept
page now, and finish after T18.10.

Per tenant — start with **`sites/platform`**, then **drlurie**; fernwell and
zilberman are the same clicks. Tick the boxes here and in
[`FLEET-STATUS.md`](./FLEET-STATUS.md) → "Membership footing per tenant" and
"Identity e-mail templates set".

---

## 1. Console (Netlify → the site → Project configuration → Identity)

- [ ] Identity **enabled** (zilberman already is, via API).
- [ ] Registration → **Invite only**.
- [ ] Emails → Invitation template path `/emails/identity/invitation.html`
- [ ] Emails → Confirmation template path `/emails/identity/confirmation.html`
- [ ] Emails → Recovery template path `/emails/identity/recovery.html`
- [ ] Emails → Email change template path `/emails/identity/email-change.html`
- [ ] External providers → Google (optional, as you prefer).
- [ ] `ADMIN_EMAILS` on the site holds your address (it does on platform/drlurie today).

*Until the paths are set the default templates still work — every token hash
is routed to `/admin/accept` by the site (proved in the browser smoke).*

## 2. First Owner sign-in + welcome

- [ ] Sign in at `https://<site>/admin` with the `ADMIN_EMAILS` address.
- [ ] `/admin/welcome` appears once → set your name → tour (or skip) → lands in `/admin`.
- [ ] Reload: welcome does not reappear (`?skip_welcome=1` also bypasses).

## 3. Invite an Editor from the members page (F1/F2 live)

- [ ] `/admin/settings/admins` → **Invite** → a second address of yours, role **Editor**.
- [ ] Toast says **invitation sent** (not "email pending"). Invitations tab shows it *pending*, with expiry.
- [ ] The e-mail arrives (branded template if step 1 done, default otherwise).
- [ ] The link lands on **`/admin/accept`** (not the home page) showing the invitation preview (site name, role).
- [ ] Set name + password → **`/admin`** opens; Invitations tab shows *accepted*; the member is *active / editor*.
- [ ] **⚠ D1:** as the editor you will see "Admin access required" until T18.10 lands. After T18.10: Editor nav (no Publish); `/admin/welcome` for the tour.
- [ ] Owner promotes the editor to **Publisher** → after T18.10, publish works for them.

## 4. AI paths

- [ ] Admin chat as Owner: *"invite &lt;third address&gt; as viewer"* → approval card → approve → e-mail arrives; the member shows *invited / viewer*, source chat.
- [ ] From an **OAuth-bound MCP client** (Claude connected to the site's `/mcp` via OAuth as you): `membership_contract`, `member_list`, `member_invite` with `dry_run:true` → the dry-run report; the 16 membership tools are in `tools/list`.
- [ ] From a **shared-token** MCP client (bearer `MCP_HTTP_AUTH_TOKEN`): the membership tools are **absent** from `tools/list`; a direct `member_list` call → `membership_requires_human`.

## 5. Suspend / reinstate / remove / purge

- [ ] Give the editor an MCP OAuth grant (connect once as them) and have them hold a lock (open an object in the workspace).
- [ ] Owner **Suspend** → their MCP calls fail within a minute (grant revoked); the object's lock is released with a `lock_forced_on_offboarding` history entry naming you (`on_behalf_of` them); their `/admin` shows the forbidden panel.
- [ ] **Reinstate** → they are back.
- [ ] **Remove** → the Netlify Identity tab no longer lists them (identity deleted at request time — you carried a token); the members page shows *removed*; any pending invitation for them shows *revoked*.
- [ ] Purge: wait for the sweep (`17 3 * * *`; check the function log next morning) or Owner **Purge now** with the typed `PURGE <email>` → person PII scrubbed, audit retained (`member_audit` still lists the events).

## 6. Password recovery

- [ ] Login modal → *Forgot password* → e-mail arrives → link lands on `/admin/accept#recovery_token=…` → set new password → sign in works.

## 7. Break-glass check (platform only)

- [ ] `/admin/settings/admins` → **Promote** yourself to a stored Owner (`promote_bootstrap`) → the badge flips from break-glass to stored.
- [ ] Remove your address from `ADMIN_EMAILS` on **sites/platform only** → still Owner (stored) → put it back (break-glass stays for V1).

## 8. Record

- [ ] Tick FLEET-STATUS "Membership footing per tenant" (Identity enabled / invite-only / templates set / first stored Owner; `ADMIN_EMAILS` still relied on → ☐ once promoted).
- [ ] Run the live probe once a token is at hand: `MCP_HTTP_AUTH_TOKEN__PLATFORM=… node scripts/fleet-capability-probe.mjs --site platform --endpoint https://kugel-platform.netlify.app/.netlify/functions/mcp` → the `membership/*` lines (users_store reachable, policy provenance, `HEAD /admin/accept → 200`); paste into state-of-play.
- [ ] `state-of-play.md`: entry **"W18 acceptance run <date>"** — what passed, what did not; any new defect → a `T18.11+` row + brief.

---

### Sign-off

Wolf: ______________________  date: __________  tenants run: ☐ platform ☐ drlurie ☐ fernwell ☐ zilberman
