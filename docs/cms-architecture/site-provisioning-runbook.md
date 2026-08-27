# Site provisioning runbook — the human half of `create-site`

W11 T11.7 built `packages/core/cli/create-site.mjs`: "new client" as close to
one command as the account-authority boundary allows. This doc is the other
half — the steps that need a human with Netlify/GitHub/DNS/secret custody,
because no CLI can hold those on an agent's behalf. Read
`docs/cms-architecture/cms-pipeline/T11.7-provisioning-cli.md` first for the
full per-site env table this runbook and the CLI's checklist both draw from
(kept in sync with the T11.10 governance/secrets inventory).

**Birthing a client end to end?** Start at
[`new-client-acceptance.md`](./new-client-acceptance.md) instead — the
ordered checklist (npm scripts, proofs, agent-vs-human authority) that this
runbook's detail tables feed into.

## 1. Scaffold the client

```
node packages/core/cli/create-site.mjs --name <client> --dry-run   # review the plan first
node packages/core/cli/create-site.mjs --name <client>              # write sites/<client>/
```

This creates `sites/<client>/` — its own `config/site-identity.ts` +
`config/site-binding.ts` + `site.config.ts` + `netlify.toml` +
`package.json`, an empty committed-export tree (`data/site/**/.gitkeep`), and
a baseline seed pack (`seeds/*-seed-data.mjs`: a starter site singleton, a
two-item nav skeleton, an empty taxonomy registry, a default theme, and the
five canonical starter section-template recipes). It is idempotent — re-run
it any time; an existing `sites/<client>/` is left untouched, never
overwritten.

Edit `config/site-identity.ts`'s `assetHost`/`assetFolder` and
`seeds/site-seed-data.mjs`'s `siteBody` (name, palette, metadata) to the
client's real brand before going further — the scaffold is a valid starting
point, not finished content.

## 2. Create the Netlify site + provision stores

```
node packages/core/cli/create-site.mjs --name <client> --netlify-token $NETLIFY_API_TOKEN
```

(If `sites/<client>/` already exists, add `--provision-only`; the command
reuses the existing Netlify site instead of creating a duplicate.) This calls
the Netlify API to create or resolve the site, probes this site's 8 blob stores
(`site-objects`, `workflows`, `artifacts`, `artifact-index`, `commerce`,
`agent-chats`, `governance`, `users` — a write→read→delete round trip per
store, the same pattern `scripts/provision-pdf-tool-stores.mjs` uses for the
separate shared pdf-tool stores), and generates + pushes the per-site secrets
that are safe to mint automatically (`PUBLISH_SECRET`,
`MCP_HTTP_AUTH_TOKEN`, `ARTIFACT_UPLOAD_TOKEN_SECRET`, `TRACKING_SALT`)
straight to the new site's env store — their values are never printed or
committed.

The same run also resolves the shared `pdf-x` Netlify service and automatically
sets `PDF_TOOL_BASE_URL` plus `PDF_TOOL_AGENT_RUN_TOKEN` on the new client.
Both are scoped to Functions in production; the bearer is stored as a Netlify
secret and never appears in the scaffold, result object, or terminal output.
Provisioning fails closed if either required bridge value cannot be installed,
so a site cannot look successfully provisioned while artifact publishing is
silently broken.

Normally the command reads `AGENT_RUN_TOKEN` from the `pdf-x` service through
the Netlify API. If that source value has been marked secret (and is therefore
not readable), inject `PDF_TOOL_AGENT_RUN_TOKEN` into the provisioning process;
`PDF_TOOL_BASE_URL` can be supplied the same way to override service discovery.
These are server-side provisioning inputs, not values to add to generated files.

`NETLIFY_API_TOKEN` needs site-create rights on the Netlify account/team the
client belongs to. If you don't have one yet: Netlify → User settings →
Applications → New access token.

## 3. What's still yours to do by hand

The checklist `create-site` prints groups every per-site env var by class.
For everything NOT auto-generated in step 2:

- **GitHub repo binding** (`GITHUB_REPOSITORY`, `GITHUB_BRANCH`,
  `GITHUB_CONTENT_TOKEN`, `GITHUB_COMMIT_AUTHOR_EMAIL/NAME`): create or pick
  the client's content repo, mint a write token scoped to it (a fleet
  machine account with per-repo scope is fine — T11.10 decides the final
  posture), set the four vars on the new Netlify site.
- **`NETLIFY_BUILD_HOOK_URL`**: Netlify site → Build & deploy → Build hooks →
  add one, paste the URL.
- **Identity / roles** (`ADMIN_EMAILS`, `ROLE_EMAILS_ADMIN/EDITOR/PUBLISHER`,
  `IDENTITY_URL`): enable Netlify Identity on the site, set the allowlists to
  the real humans who administer this client — **exact click-by-click steps
  in §3a below (the admin-workspace human gate)**.
- **`ARTIFACT_URL_INGEST_ALLOWED_HOSTS`**: the hosts this client's agents may
  pull artifact images from — a policy choice, not a secret.
- **Tenancy axes** (`PDF_TOOL_PROJECT_ID`, `TRACKING_PROJECT_ID`,
  `TRACKING_SINK_URL`/`_TOKEN`): `PDF_TOOL_PROJECT_ID` defaults to the site
  slug — only set it if it must differ. The bridge URL/token are installed
  automatically in step 2. `PDF_TOOL_STORAGE_SITE_ID`/`_TOKEN` are **per-site**
  — provision a NEW dedicated Netlify machine account + Blobs-scoped PAT for
  THIS client (`docs/agents/pdf-tool-storage-grant.md`'s "Credential
  provisioning" steps); do not reuse another tenant's value. (Historically
  every tenant read one shared pair pointed at Dr-Lurie's site — `platform`
  moved off that arrangement 2026-08-04, `fernwell` followed 2026-08-05
  (live-verified via a real create/list/deactivate round trip). `dr-lurie`'s
  `SITE_ID` has always resolved to itself, so it already passes the letter of
  the rule; rotating its token off the old fleet-shared credential is an open
  hygiene question, not a confirmed gap — treat the shared pair as legacy,
  not the default for a new client.) Tracking sink may be one shared owner-DB
  (partitioned by `TRACKING_PROJECT_ID`) or per-site — your call.

  **This is enforced, not just documented, as of 2026-08-05.** Re-run step 2
  with `--known-tenant-site <name>` (repeatable — every other live tenant's
  Netlify site name) after setting the two vars by hand, and provisioning
  refuses to finish if this site's value collides with a sibling's. To check
  an already-live fleet without provisioning anything:
  `node scripts/audit-storage-grant-parity.mjs --site <name> --site <name> …`
  (needs a Netlify token; exits 1 on any collision). See
  `docs/agents/pdf-tool-storage-grant.md`'s "Parity enforcement" section.
- **AI keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `NETLIFY_AUTH_TOKEN`):
  fleet-shared — reuse the existing fleet values, never mint per-client
  copies. Admin chat does not use a per-site model key: CMS-Agent
  genesis/cloning installs `CMS_AGENT_MCP_ENDPOINT` and mints the site's own
  scoped `CMS_AGENT_MCP_TOKEN` directly into Netlify as a secret/function-only
  value. Only its digest and `{project, toolAllowlist}` policy persist in
  CMS-Agent; the raw bearer is never printed, returned, committed, or handed
  to an operator. The same CMS-Agent reconciliation job rotates every existing
  registered tenant, so this is a fleet birth/retrofit invariant rather than a
  per-site console step.
- **Shop, only if this client sells** (`STRIPE_SECRET_KEY[_TEST]`,
  `STRIPE_WEBHOOK_SECRET[_TEST]`, `STRIPE_MODE`): the client's own Stripe
  account, not the fleet's.
- **DNS**: point the client's domain at the Netlify site (`custom_domain` in
  Netlify site settings, or a CNAME to the generated `<name>.netlify.app`),
  then update `sites/<client>/site.config.ts`'s `canonicalHost` and
  `data/site/site.json`'s `urls.canonicalHost` to match once the domain
  resolves.
- **Connecting an agent to this site's `/mcp`** — the endpoint is fail-closed,
  and there are now three ways in, in order of preference:
  1. **OAuth** (W14 F10, nothing to provision): the site IS its own
     authorization server. Point any OAuth-capable MCP client — a claude.ai
     custom connector included — at `https://<site>/mcp` and leave the client
     id/secret blank. It discovers the metadata, registers itself, and sends
     the user to `https://<site>/admin/authorize`, where a signed-in **admin or
     owner** approves it. Approval is per client and revocable; access tokens
     last an hour and refresh automatically. Nothing is pasted, nothing is
     stored on the client's side that a rotation invalidates.
  2. **Header carriers**, for scripts and SDKs: `Authorization: Bearer <token>`
     or `X-MCP-Auth-Token: <token>` with the site's `MCP_HTTP_AUTH_TOKEN`.
  3. **The URL key** (W14 F9), only for clients that can do neither:
     `https://<site>/mcp?key=<token>`. Treat that URL as the secret it contains
     — query strings land in proxy and CDN logs — and note that rotating
     `MCP_HTTP_AUTH_TOKEN` means re-pasting it everywhere.

- **When a connector says "Authorization with the MCP server failed"** — that
  message is what a client shows for ANY 401 or 5xx anywhere in the flow, so it
  is not evidence that the credentials are wrong. Ask the endpoint before
  changing anything:

  ```
  curl -s "https://<site>/mcp?health=auth"
  ```

  It answers unauthenticated with `oauth.accepted_audiences` (every host this
  deploy will honour a token for) and `oauth.token_store_reachable`. Two
  failures that look identical from the client are separated here:

  - **The host is not in `accepted_audiences`.** A token approved through one
    of the site's names and presented on another is refused, permanently. The
    list is the request host plus Netlify's own `URL` and `DEPLOY_URL`, so this
    now covers apex/`www.`/`*.netlify.app`/deploy aliases automatically —
    if a host is still missing, the connector is pointed at a name this
    deployment does not serve. The refusal also names itself: the 401 body
    carries `oauth_failure: "audience_mismatch"` and the function log carries
    an `mcp_auth_rejected` line with the audiences it compared against.
  - **`token_store_reachable: false`.** The governance blob store is down or
    unconfigured, so no OAuth token can resolve. This is an outage, not a
    credential problem; the 401 body says `oauth_failure: "store_error"` and
    the log carries `mcp_oauth_store_error` with the underlying message.

  If both look right, the function logs for that site carry one
  `mcp_auth_rejected` line per refusal with a `reason` and (whenever a bearer
  was presented) an `oauthFailure` of `no_record` / `expired` /
  `audience_mismatch` / `store_error`. `no_record` after a fresh approval is
  the only one that should ever be transient — see the read-after-write note in
  `oauth-store.ts`.

- **Secret rotation**: `PUBLISH_SECRET`'s rotation runbook is standing debt
  tracked at T11.10 — this scaffold mints an initial value but does not
  automate rotation.

## 3a. Admin workspace & canvas editor bootstrap — §admin (HUMAN GATE)

Every tenant gets the full `/admin` workspace and the edit-mode canvas by
construction (W15 mandate; requirement inventory + audit:
`docs/cms-architecture/15-fleet-admin-parity.md` and
`scripts/audit-site-admin-parity.mjs`). The build ships all of it — but the
site's admin is a locked door until a human does these three console steps.
They are `human_gate` in the pipeline's sense: an agent can prepare
everything else, only you can click these.

1. **Enable Netlify Identity (GoTrue) and point its e-mails at the accept
   page.** Netlify console → the site → **Project configuration → Identity**
   (older consoles: Site configuration → Identity, or Integrations → Identity)
   → **Enable Identity**. This is what stands up
   `https://<site>/.netlify/identity`; the `/admin` login widget and every
   function-side token check point at it. Without it, `/admin` shows a login
   that cannot complete and every admin function returns 401. Then, on the
   same Identity page (T18.0c):
   - **Registration → Invite only** — this is a workspace, not a signup page.
   - **Emails** → for each of the four templates, tick *Custom template* and
     set the **path** (relative to the publish directory; every tenant's
     build publishes these files from core, nothing to copy):
     | Template | Path |
     |---|---|
     | Invitation | `/emails/identity/invitation.html` |
     | Confirmation | `/emails/identity/confirmation.html` |
     | Recovery | `/emails/identity/recovery.html` |
     | Email change | `/emails/identity/email-change.html` |
     Each template links to `https://<site>/admin/accept/#<token>=…`, the one
     page that consumes an Identity token (T18.0b): invitees set a name and
     password there, recoveries set a new password. **Until the paths are
     set, the default Netlify templates still work** — they link to `/`, and
     the site-wide router forwards the token to `/admin/accept` — the custom
     ones just land cleanly and read like the site.
   - **External providers → Google** (optional; offered as a sign-in method
     after acceptance, never as the accept step itself).
2. **Set `ADMIN_EMAILS`** on the site (Site settings → Environment
   variables) to the operator's real email address(es), comma-separated.
   These are **bootstrap Owners** (`roles.ts`): implicit Owner forever, the
   fallback that makes it impossible for an empty or wiped `users` store to
   lock you out. Until the first invite exists this is the ONLY way in. The
   scaffold's checklist prints this row with a placeholder — replace it, do
   not skip it. (Optional: `IDENTITY_URL` only if the default
   `<site URL>/.netlify/identity` must be overridden; `ROLE_EMAILS_*` for
   the extra publish-gate vocabulary.)
3. **Sign in, invite the first Owner, accept from the e-mail.** Sign in at
   `https://<site>/admin` with an `ADMIN_EMAILS` address (Identity → your
   first login), then `/admin/settings/admins` → **Invite** (email + role
   Owner). The invite rides GoTrue's `POST /invite` with the identity context
   Netlify injects — no extra secrets — and Netlify Identity sends the
   invitation e-mail (T18.0a; before it, the platform hit the wrong endpoint
   and no mail was ever sent). The invitee opens the link → `/admin/accept`
   → full name + password → lands in the workspace with an active
   membership. Then (T18.1) promote the stored Owner and remove the env row,
   so `ADMIN_EMAILS` goes back to being break-glass only. A team of one can
   stop after step 2; `ADMIN_EMAILS` alone is a complete bootstrap.
   Invitations expire after 7 days by default and can be resent/revoked from
   the **Invitations** tab (T18.3b); anyone invited from the Netlify Identity
   tab instead shows under **Identities** and is granted a role from there.
   The same verbs are available to a signed-in human over MCP/chat
   (`member_invite` etc., T18.6b) — agents on the bearer token are refused
   with `membership_requires_human` by design.
4. **(Optional) Membership policy.** The fleet defaults apply (Owner+Admin
   may invite editor|viewer, Owner alone the rest; `min_owners` 1; 7-day
   invites; 30-day purge grace; the Identity login is deleted on remove).
   Narrow them per site in `sites/<client>/config/membership-policy.ts`
   (committed, T18.7) or at runtime as an Owner (`membership_policy_set`).
   Fleet check without a token: `node scripts/fleet-capability-probe.mjs
   --all --repo-only`.

> **Recovering a stuck invite.** Someone was invited before T18.0a/b (the
> link landed on the home page, nothing happened), or the mail never came:
> Netlify console → the site → **Identity** tab → find the user → **Resend
> invitation** (or delete and re-invite from `/admin/settings/admins`). The
> new link now lands on `/admin/accept`. A member who already exists in
> Identity but shows as *invited* on `/admin/settings/admins` just needs to
> sign in once — first login activates the record.

What you do NOT need to do (verified by the audit, not remembered): the
`/admin/*` routes, admin styles, the EditMode canvas, all 35 function shims (incl. the daily `membership-sweep`),
the S1 `/admin/content/:objectId` rewrite, the OAuth authorization-server
rewrites, and the blob-store expectations are scaffold/provisioning-owned.
After the three steps above, verify the wiring any time with:

```
node scripts/audit-site-admin-parity.mjs --site sites/<client>
```

and bring an OLDER site (scaffolded before the admin waves) to parity with:

```
node packages/core/cli/migrate-site.mjs --site sites/<client> --admin-parity --write
```

Note the store expectation behind the workspace: `users`, `agent-chats`,
`agent-profiles`, `governance` (plus the object/artifact/tracking stores)
must round-trip on THIS site — step 2 of this runbook probes all of them
when run with a token; re-run with `--provision-only` if provisioning ever
reported a store failure.

## 4. Wiring an actual second deployment (not this task)

Today exactly one Netlify build (Dr-Lurie's) reads any `site.config.ts` at
build time — `sites/<client>/` is data + bindings sitting in the monorepo,
not yet a live deployment. Pointing a REAL second Netlify build at its own
`sites/<client>/` tree (rather than `sites/drlurie/`) is T11.11's job (the
second-site acceptance proof), not this runbook's — this section exists so
nobody mistakes "the directory exists" for "the site is live."

## 5. Verifying the scaffold before any of the above

`node packages/core/cli/create-site.mjs --name <client> --dry-run` never
touches disk or network — safe to run repeatedly while deciding on a name.
Once scaffolded, `npm test` type-checks everything under `sites/**/*.ts`
(the project's `tsconfig.test.json` already includes it), and the new
client's seed bodies parse against the same `packages/core/schema/bodies/*`
zod schemas Dr-Lurie's do — `tests/scripts/create-site.test.mjs` checks both
for every scaffold this CLI can produce.

## Mail (W19 T19.7) — optional, one human step

Editorial-request notifications can reach an editor by e-mail. This is the one
step in the wave that needs a console and cannot be automated: the sending
DOMAIN must be verified with the provider before anything sends.

1. Verify the tenant's sending domain with the mail provider (Resend today).
2. Set `MAIL_PROVIDER=resend`, `MAIL_FROM=<verified sender on that domain>`,
   and the fleet-shared `MAIL_API_KEY` on the tenant site. `MAIL_REPLY_TO` is
   optional and defaults to `MAIL_FROM`.
3. `node scripts/fleet-capability-probe.mjs --site sites/<client>` — the `mail`
   family should read configured.

**Skipping this is a supported outcome.** A tenant with no mail provider
behaves exactly as it did before W19: the in-app toasts, the tab-title count
and the browser notification all work, and the capability probe reports `mail`
as unconfigured rather than failing.
