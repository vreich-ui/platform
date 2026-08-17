# State of play — agent-editability push

Rolling session log for the multi-session mandate ("an agent can inspect and
edit any meaningful part of the live Dr-Lurie site through one consistent,
human-reviewed workflow"). Each session appends its entry at the top and
updates the standing tables. **Rule inherited from the mandate: never trust
this file over real state — verify against main / test output / the live
store before building on anything below.**

---

## 2026-08-17 — T18.0c: Identity e-mail templates published from core; the console clicks are written down everywhere a human looks

W18 wave 0, row 3 (plan §4.1 step 2, F10-doc, F11-part; P1/P2). **Templates
are fleet law, not per-site files:** `packages/core/app/emails/identity/
{invitation,confirmation,recovery,email-change}.html` (brand-neutral, only
`{{ .SiteURL }}`/`{{ .Token }}`/`{{ .Email }}`/`{{ .NewEmail }}`; every link
is `{{ .SiteURL }}/admin/accept/#<token>={{ .Token }}`) and a new Astro
integration `identity-email-templates-integration.ts` mounted in
`defineSiteAstroConfig` copies them into every tenant's build output at
`/emails/identity/*.html` on `astro:build:done` (same shape as the redirects
integration; a route would land as `…/index.html`). Nothing was added to any
`sites/<client>/public/` — P1 by construction (a `sites/platform` build
prints `published 4 Netlify Identity e-mail template(s)` and the four files
sit in `dist/emails/identity/`). **Where the human steps now live:**
`create-site`'s ADMIN WORKSPACE BOOTSTRAP block (step 1 grew the ☐ rows:
Registration = Invite only, the four Emails template paths, Google optional;
step 3 is now "invite yourself, accept from the e-mail on /admin/accept";
fixture updated); the parity audit gained `identity-email-templates` (PASS —
core files present, each links to /admin/accept, the shell config mounts the
integration, `/admin/accept` is an injected route) and the human row
`identity-console-settings`; `fleet-capability-probe.mjs` prints a
non-gating `identity` note per tenant listing the console-only
prerequisites (`IDENTITY_CONSOLE_PREREQUISITES`; it never calls the Identity
admin API); the runbook's §admin step 1 is rewritten click-by-click
(Project configuration → Identity → Enable / Registration → Invite only /
Emails → paths table / Google optional), step 3 rewritten around
`/admin/accept`, plus a "Recovering a stuck invite" box; `KNOWN_ISSUES.md`
§5 lists F1/F2/F3 with the one-line symptom each, FIXED-BY T18.0a/b/c;
`FLEET-STATUS.md` has the "Identity e-mail templates set (console)" ☐ block
for the four tenants (Wolf ticks during T18.9). Audit: `--root`, platform,
fernwell, zilberman all pass (drlurie's `--site` form has 6 pre-existing
gaps unrelated to W18 — it deploys from `--root`). `npm test`, eslint,
prettier, `astro check` green. Wave 0 (T18.0a–c) is complete and
releasable on its own; next: T18.1 (store v2 — Fable/notify row).

## 2026-08-17 — T18.0b: `/admin/accept` — every Identity e-mail token now lands somewhere that consumes it

W18 wave 0, row 2 (plan §1 F1, F3, F8-min; flow §4.1 steps 2–4, §4.5).
**The router:** `HeaderAuthButton.astro`'s `initializeHeaderAuthState` now
starts with `shouldRouteToAccept(pathname, hash)` (pure, in
`goTrueClient.ts`) — any page carrying `#invite_token=` /
`#confirmation_token=` / `#recovery_token=` / `#email_change_token=` does
`location.replace('/admin/accept' + hash)`; the hash survives, so the
default Netlify templates (which link to `/`) work without any template
change (T18.0c still switches them for a cleaner landing). **The page:**
`packages/core/app/routes/admin/accept.astro` (injected fleet-wide via
`SHELL_ROUTES`, added to `REQUIRED_SHELL_ROUTES` in the parity audit —
P1 satisfied for all four tenants by construction) on the public `Layout`,
noindex, NO AdminLayout gate; island `AcceptInvite.tsx` decides after
hydration (`detectIdentityToken()` in an effect — deciding during render
mismatched the token-less server HTML) and runs: **invite** → full name +
password/confirm (show/hide, min from `invite_preview.policy`) →
`acceptInvite(token,pw)` = `POST /verify {type:'signup'}` (session written,
token never) → `PUT /user {data:{full_name}}` (best-effort) →
`admin-users accept {display_name}` → `needs_grant` panel with Sign-out, else
`/admin/welcome` if a HEAD probe finds it (T18.5) else `/admin`;
**recovery** → new password → `exchangeRecoveryToken` (`/verify
{type:'recovery'}`) → `updatePasswordWithToken` → `/admin`; **confirmation /
email_change** → the matching `/verify` then `/admin` (email_change also
calls `me` for last_seen; the by-email re-index is T18.1). No hash or a
GoTrue 4xx → "This link can't be used … ask the person who invited you",
raw token never rendered; the hash is stripped after success.
`handleRecoveryCallback` is now async and accepts BOTH shapes (customised
`type=recovery&access_token` unchanged; default `#recovery_token=` exchanged
via `/verify`); `handleOAuthCallback` ignores all four token hashes.
`users-client.ts` gains `acceptInvite(getToken,{display_name})` and the
session-less `invitePreview()`. AdminLayout's forbidden panel now says "no
role has been granted to this email on this site yet. Ask an Owner to grant
you a role" (the old ADMIN_EMAILS wording described a break-glass detail).
Tests: `goTrueClient.test.ts` +10 (all four hashes + none, the router
predicate, `acceptInvite` posts signup+password and stores only the session,
short-password refused offline, `exchangeRecoveryToken` posts recovery, 4xx
carries status, both recovery hash shapes, OAuth callback ignores tokens).
Smoke (built drlurie `dist/` served statically, headless Chromium):
`/#invite_token=abc` → `/admin/accept#invite_token=abc` rendering "Set up
your account" (Full name + Password + Confirm), `/admin/accept#recovery_token=`
renders "Choose a new password", `/admin/accept` alone renders the error
state, page HTML never contains the token, `localStorage` stays empty until a
session exists, zero page errors. `astro build` green for `sites/drlurie`
(root) and `sites/platform`; `npm test`/`check` green. Non-goals untouched:
no template files (T18.0c), no welcome page (T18.5), no admin-users server
change, no `@netlify/identity`. Next: T18.0c.

## 2026-08-17 — T18.0a: platform invites hit the mail-sending GoTrue endpoint; `accept` + `invite_preview` verbs

W18 wave 0, row 1 (plan §1 F2, F6-min, F8-min server half). **What changed:**
`packages/core/server/lib/user-invite.ts` now POSTs `${identity.url}/invite`
with `{ email, data: { invited_by, role } }` — `data` is informational
GoTrue `user_metadata`, the store stays the only source of truth for roles.
**The endpoint fact:** GoTrue's `POST /invite` (admin bearer) creates the
unconfirmed user AND sends the Netlify Identity invitation e-mail; the
`POST /admin/users` the code called before creates a user, requires a
password (422 without one) and sends nothing — which is why every
platform-originated invite showed "invite email pending" forever while
`tests/netlify/user-invite.test.ts` pinned the wrong URL and stayed green
(that assertion now pins `/invite`; `grep -rn "admin/users"
packages/core/server/lib/user-invite.ts` → no hits). GoTrue 422 "already
registered / already been invited" is now `invite:{sent:false,
error:'already_invited'}`, not a failure. New `resendIfExisting` option:
an existing `invited` record re-fires the GoTrue invite (GoTrue re-sends
for an unconfirmed user) and audits `reinvite_email`; without it a
re-invite is a role update only, no e-mail. F6-min: re-inviting a
`disabled` record flips it to `invited` (audit `reinvite`, detail
`disabled → invited`). **The accept verb contract** (`admin-users`, T18.0b
consumes it): `invite_preview` is PUBLIC (answered before auth, before the
store opens) — `{ token? }` accepted but NOT validated (only GoTrue can;
an anonymous request has no admin token to ask with) → `{ site: { name,
slug }, policy: { min_password: 8 } }`, nothing user-specific; the page
shows the e-mail after GoTrue `/verify` from the session's `/user`.
`accept` runs on that fresh JWT: authenticated, NOT role-gated (an
invitee's roles come from the record it activates), body
`{ display_name }` (1..200), caller's verified e-mail only. Record exists
`invited` → `active`, `display_name` set, `user_id` + `last_seen_at`
stamped, audit `accept`; idempotent (second call returns the same active
record, no second audit); a `disabled` record → 403; no record → `200 {
user: null, needs_grant: true }` and NOTHING is created or granted (Netlify-UI
invitee — the layout's forbidden panel says "Ask an Owner to grant you a
role"; T18.2 makes it the unmanaged-identity flow); a bootstrap
`ADMIN_EMAILS` caller with no record takes the `me` materialization
(`bootstrap:true`) with the typed name. New helper `acceptInvitation` in
`user-invite.ts`; new `tests/netlify/admin-users-accept.test.ts` (7 cases
through `createHandler(binding)` with a fake `clientContext.user` and an
in-memory store); `user-invite.test.ts` +4 cases. Every pre-existing verb
is byte-identical in behaviour (`invite` does not yet pass
`resendIfExisting` — T18.2/T18.3b wire the Resend button). Non-goals
untouched: no client code, no e-mail templates, no schema v2,
`roles.ts` / `publish-gate.ts` / `admin-auth.ts` not modified. Next row:
T18.0b (`/admin/accept` + site-wide token router).

## 2026-08-17 — T12.13: the capture bridge exists, and the per-site pdf-tool PAT is gone from the capture path

W12's last blocker, and it was three failures stacked. `capture.crawl` called
pdf-tool's `create_capture_job` with no `storage` argument, so pdf-tool refused
every call (`STORAGE_GRANT_REQUIRED` — it holds no storage credentials of its
own since the env fallbacks were removed). The T12.9 fix for that
(CMS-Agent `09eb215`, branch `t12-9-grant-wiring`) fetched
`get_pdf_tool_storage_grant` from the target and forwarded it — but core
**DELETED that RPC on 2026-08-02** (`7d1640ce`) in favour of a server-side
bridge that mints the grant internally and never returns it, so the fix could
never have worked live (`grep -rn get_pdf_tool_storage_grant
packages/core/server/` returns nothing; CMS-Agent's `platform` record still
lists it `"allowed"` — stale policy, not a capability). And underneath both:
**there was no capture bridge at all** — `grep -rln create_capture_job
packages/core/` returned nothing, so no tenant was reachable by the capture
plane by any route.

Wolf ratified **option A, same-site writes** on 2026-08-14 (now recorded in
`decisions/2026-08-14-capture-auth-and-media-rulings.md`, R-A1, together with
R-M1 ratifying T12.14's asset-aware media binding). **pdf-tool persists the
whole crawl output — job records, screenshots, `snapshot.v1` — into its OWN Blob
store**, and the tenant imports what it wants afterwards through the artifact
bridge that already exists. The consequence is the point: **no cross-site
credential exists anywhere in the capture plane.** A new tenant needs no
dedicated Netlify Blobs PAT to be captured, which is the manual console step
Wolf refused to repeat per tenant. Mechanically it is one new internal
`grantType` (`pdf-tool-own-storage`), minted only by the capture plane, whose
credential fields are non-credential sentinels and which is deliberately absent
from `SUPPORTED_GRANT_TYPES` so no caller can name it; one ALS frame
(`lib/capture/storage.ts`) every capture entrypoint runs inside, which REPLACES
any ambient grant, so a caller that still sends `storage` cannot make the plane
write with its credential. The exchange-grant variant was rejected because the
swap must still end in a real Blobs credential the tenant cannot mint without a
PAT; tenant-side writes were rejected on volume (100+ screenshots as base64
through MCP, across multiple 15-minute worker windows).

**The bridge** (new, in core, so all four tenants get it from one place):
`create_capture_job` / `get_capture_job_status` / `get_capture_snapshot`. Site
ownership and the canonical pdf-tool project resolve server-side; the pdf-tool
request scope is DERIVED server-side from site + seed URL, so a caller cannot
name it and a re-driven crawl re-attaches to the running job instead of starting
a parallel one. `site_id` is an OPTIONAL cross-check (an artifact belongs to a
`content_item` a caller names anyway; a capture job belongs to nothing, and
`project.create` cannot even set `objectDialect`) — omitted, the deployment
answers for its own site; supplied and wrong, `capture_site_mismatch`. The
snapshot READ PATH is the third tool: a completed job carries only the
`ArtifactReference`, the bytes live in pdf-tool's own store, and no credential is
handed out — pdf-tool reads its own artifact, checks it against the digest
recorded on the job, and returns the parsed `snapshot.v1` (structured DATA, not
an artifact binary; screenshots stay references, and >8 MiB is refused with the
reference still importable). The three tools are `INTERNAL_ONLY_TOOLS`: callable
on every tenant, absent from agent discovery, same mechanism and reason as
`create_artifact_from_url` and `capability_status` — capture is operated from
CMS-Agent (R-C5) and tenant-side there is no registry to bound a crawl with.

**Bounds are now enforced on three sides** and the bridge can only narrow:
`capture-bridge-policy.ts` refuses `sameOriginOnly !== true`,
`respectRobots !== true`, `authenticatedAccess !== "prohibited"`, `maxPages < 1`,
empty origin/prefix lists, an out-of-policy seed, and a policy SUBSET (the T12.9
defect — `rights`/`designReferences`/`fidelity` all required, failing here with a
bridge error code instead of three hops away); `maxPages` clamps to 50, mirroring
pdf-tool's own hard ceiling. Not one refusal reaches pdf-tool (asserted).

**CMS-Agent** repointed: `capture.crawl` calls the TARGET's bridge, the
grant-fetch/forward/redact/scrub module is deleted, and the
`capture_snapshot_unavailable` dead end is replaced by the bridge read. Kept from
`09eb215`: the full canonical policy travels VERBATIM, the authority gate runs
first, refusals stay catalogued, and the radioactivity discipline survives as
`stripCredentialShapedFields` — belt and braces over a remote that echoed
something, tested against a bridge that echoes credential-shaped fields on every
answer.

**Laws.** P1: no `sites/<client>` file changes because the change adds no
repo-tree file, netlify.toml setting, seed entry, env var or function shim — the
tools are core dispatch over the existing `/mcp`; parity audit PASS ×4 at full
check count (76 rows). P2: **no new env var** — capture is gated only by the
fleet-shared `PDF_TOOL_BASE_URL` + `PDF_TOOL_AGENT_RUN_TOKEN` pair (family
`pdf_bridge`, already in the T11.7 table and `ENV_CHECKLIST`, both
`inheritFromPdfTool`); this change REMOVES a per-site pair from a path. The probe
was still extended, because the existing `pdf_bridge` real-read is gated on
`pdf_storage_grant` also being configured and would therefore be SKIPPED on
exactly the tenant this unblocks: the new `capture_bridge` line runs on
`pdf_bridge` alone and treats pdf-tool's own `CAPTURE_JOB_NOT_FOUND` as proof the
credential-free path is live, with `STORAGE_GRANT_REQUIRED` named explicitly as
"the deployed pdf-tool predates T12.13".

Suites: platform 2393 + 149 + 45 green; pdf-tool 460 netlify + 61 service green;
CMS-Agent 170 files / 1545 tests green (the 16-test grant-wiring file became a
14-test bridge file). Headline acceptance test asserts
`capability_status.pdf_storage_grant.configured === false` before running the
crawl, so it cannot pass on a machine where the pair happens to be set.

STILL NEEDED (human): **three redeploys** — platform core (every tenant),
pdf-tool (until then the bridge answers `STORAGE_GRANT_REQUIRED`, which the probe
now names), and CMS-Agent. Plus two project-record policy retirements Wolf owns,
flagged in code comments and NOT changed here because both need a
`definitionVersion` bump + live re-seed: `get_pdf_tool_storage_grant` off the
`platform` record (stale — the RPC no longer exists anywhere) and
`create_capture_job`/`get_capture_job_status` off the `pdf-tool` record (now
unused — capture goes through the target's bridge). Dropped from the capture
critical path: the outstanding "dedicated pdf-tool storage PAT for zilberman"
item — still needed for the artifact/template families, no longer for capture.
## 2026-08-17 — T12.14: captured clones bind images now (asset-aware mapping + media binding)

The reason every captured clone came out text-only was structural, and it was
two things, not one. The mapper had no way to put an image into a section, so it
DECLINED every media block (that is 8 of the 14 recorded T12.6 gaps: 6 ×
"first-party artifact materialization plus a schema-safe asset field" + 2 ×
"materialized first-party asset references and item-level text association").
And the emitter materialized its 10 artifacts **after** it created the 9 page
objects, so the bodies could not have referenced them even in principle. No
section type was missing — `media`, `content_split`, `brand_row` and `bio`
(with both `portrait` and `portraitAssetRef`) were all already in the contract.

What landed: a two-phase binding. The mapper now emits a media-shaped block as a
real candidate whose section data is complete EXCEPT its asset field, plus an
`assetPlan` naming the field and carrying, per item, the source asset's manifest
identity and **its own alt text** — the "item-level text association" the gap
report asked for. The plan carries no source URL at all. The emitter
materializes artifacts FIRST, then `bindSectionAssets` fills the field; that
function accepts ONLY a Major-Key artifact reference and derives the served
`/img/{id}/{sha256}.{ext}` path itself, so it has no input that could be a
hotlink. `bio` gets both idioms (the trusted ref for identity, the rendered pair
for display). A section whose plan cannot be satisfied is DROPPED from its body
and recorded in `assetGaps`; a repeated-media `section_template` whose blueprint
cannot bind is quarantined rather than shipped with an empty gallery; and
`assertAssetFieldsFirstParty` guards every body reaching `object_create` as a
third, independent barrier (a positive allowlist over `src`/`*AssetRef`, so
legitimate external link targets are untouched).

Re-typing is constrained by a rule worth remembering: **it must not drop
extracted copy.** `media` and `brand_row` carry no body, so a block with
substantive body text can only become `content_split`/`bio`, or it keeps its
text type and stays a recorded gap. That is why a `prose` block with one image
and no heading is still a gap — the palette has no "body copy beside a single
image, no heading" type, and the gap now says exactly that instead of
"unmaterialized visual evidence".

MEASURED, on the committed redacted fixture (the only replayable input):
mapped coverage **3/19 = 15.79% → 10/19 = 52.63%**, +36.84pp; 7 pending asset
sections planned and bound; no gap in the replayed ledger still names either
asset-materialization capability. **The 52.94% in the T12.6 report is a
different measurement** — the LIVE run's 9/17 against the site's real text. That
snapshot is not committed (redaction replaces every text value with a length
marker, and the mapper reads text), so the redacted fixture has 19 relevant
blocks rather than 17 and a 15.79% baseline. Its live counterpart cannot be
re-measured without re-crawling; the per-gap ledger replay carries the
comparison instead, using the committed live report's own entries. Of the 8
recorded asset gaps: 4 blocks now map with bound media (partners 003/004/006,
filmography 003) and 4 carry a different, precisely-named gap — 3 are
home-PageType placements (T12.6 backlog item 3, which this change reclassifies
them to instead of hiding them under a media capability) and 1 is
`section_type_has_no_asset_field`. The 2 "clean semantic gallery data without
injected CSS" gaps close by the same rebinding: the asset branch now runs ahead
of the builder-CSS check, because injected CSS is a property of the block's
TEXT and the gallery underneath it is real evidence — only the images and their
alt text reach a field, never the CSS.

Rights are gated twice and fail closed: the mapper reads the rights the CRAWL
recorded and plans nothing when none is recorded; the emitter independently
re-reads the TARGET project registry. The 90% bar, the rubric, the PageType
allowlists and the T12.10 defect discipline are all untouched — the new `assets`
evidence channel in `score.mjs` mirrors the ratified visual-defect pattern
(every unbound planned section is an enumerated defect with the emitter's own
reason; the CLI exits non-zero; the verdict does not move).

Suites: platform `npm run test` green at **2393 + 149 + 50** (baseline
2387 + 149 + 45). The engine change was re-vendored into CMS-Agent
(`map.mjs`/`emit.mjs`/`score.mjs` + their `.d.mts` declarations) with
`provenance.ts` re-pinned and `captureEngineProvenance.test.ts` green in the
same change; `score.mjs`'s recorded upstream hash was already stale there (the
vendored copy predated T12.10), so this re-vendoring also brings the T12.10
visual-defect accounting into that plane.

Still open, deliberately: the T12.6 rerun (a `human_gate`, and it goes through
`site.duplicate`) — coverage is still far below 90% on the fixture, and most of
what remains is home-PageType placement (backlog item 3) and the event detail
model (item 4), neither of which is this task.

---

## 2026-08-14 — T12.12 EXECUTED: sites/zilberman is fleet tenant #4, live and registered

The human_gate ran with Wolf's live delegation — he handed the session his
Netlify CLI token, gcloud auth, git credential, and Chrome, so the
account-authority steps were executed by the orchestrator under his watch
rather than clicked by hand. Every step, its mechanism, and what the Netlify
API absorbed is measured in `T12.12-automation-notes.md` (the brief's
secondary purpose — it shrinks T12.11's humanChecklist to four items).

What stands: Netlify site `zilbermanfilmfoundation` (id `37d2e689…`), built
from `main` with base `sites/zilberman` (scaffold commit `ac4fd0fa` + the
lock-file fix `ae637855` its first build failure demanded), full env set
(per-site secrets auto-minted; fleet-shared values from their real
custodians after the masked-secret-copy trap — see the notes), Identity
ENABLED VIA API (the runbook's "console-only" is stale), build hook wired,
`NETLIFY_BUILD_HOOK_URL` set. The 15-object seed pack was driven through the
site's own `/mcp` by `site-genesis-drive` (created 15, published 15 after
one transient GitHub-500 retry, ONE release_to_production; `--verify` PASS
15/15, bootstrap pages replaced; production confirmed on export commit
`ec7e6b1a`). ROUND-TRIP PROOF: `page_t12_12_proof` created →
`set_page_meta` patched (409-guarded against the real post-checkout
version) → published (export commit `eaa3e46e`) → checked in → released
(hook deploy `6a7ec69c`, ready 07:41Z) → LIVE at `/t12-12-proof` with the
patched title; `object_inventory` returns it (16 objects). ISOLATION:
platform's live inventory fingerprint is byte-identical before and after
(74 objects, `a148181f248217a6`), and no commit today touches
`sites/drlurie|fernwell|platform` — every publish commit names a zilberman
object. Parity audit PASS ×4 at full check count; capability probe green
except the two deliberate gaps (per-site pdf-tool storage PAT, Stripe).
CMS-Agent side: project `zilberman` registered (deny-all default, then the
ratified Zilberman capture policy copied verbatim from `platform`'s),
`ZILBERMAN_MCP_ENDPOINT`/`ZILBERMAN_MCP_TOKEN` on the Cloud Run service
(secret `zilberman-mcp-token`), `project.test_connection` green
("Zilberman_MCP_Server"), scoped `CMS_AGENT_MCP_TOKEN` minted into
`mcp-scoped-tokens-json` v4 (agent_resolve + agent_converse only — narrower
than siblings, deliberate).

Also closed en route: pdf-tool Cloud Run T12.8 revision DEPLOYED
(`pdf-tool-render-00005-462`, 600s/2Gi/2CPU/conc-2; health green, capture
endpoint 401s without the shared secret and captures a live URL with it),
and the PLATFORM_MCP_TOKEN 401 confirmed FIXED. Wolf's CMS-Agent redeploy
carries the wave: the five `capture.*` controlled tools + `site_duplicate`
are live on the deployed service.

OUTSTANDING (what survived automation): dedicated pdf-tool storage PAT +
machine account for zilberman (notes row 16), Wolf's first-Owner sign-in at
`/admin` (row 17), the Identity "Invite only" preference click (row 10),
rotation of zilberman's NETLIFY_AUTH_TOKEN/NETLIFY_BLOBS_TOKEN off the
account token onto dedicated PATs (row 7). Plus: T12.9's LIVE proof is now
UNBLOCKED (the T12.8 plane is deployed), and CMS-Agent's
`cloudbuild.deploy.yaml` env manifest should name the ZILBERMAN pair. The
T12.6 rerun gate is UNTOUCHED: it goes through `site.duplicate` and **Wolf
dispositions it**.

---

## 2026-08-13 — W12 productization wave: T12.8 + T12.9(scaffold) + T12.10 + T12.11 landed, T12.12 prepped

One orchestrated run (Fable orchestrator, subagents per task, per the runner
plan) took the wave from T12.7 to the T12.6-rerun gate. Cross-repo results,
each verified by the orchestrator re-running the owning repo's full suite:

- **T12.8 (pdf-tool, branch `t12-8-capture-plane`): CLOSED.** The capture
  plane exists beside the untouched print path — a render-service
  `/capture/page` endpoint (JS on, per-request context, allowlist-only
  network) + a `capture` job kind on the Netlify plane with worker-side
  policy ceilings, robots+rate evidence in the job record, deadline+resume
  from a persisted frontier, and `create_capture_job` /
  `get_capture_job_status` MCP tools. Suites 456/456 + 61. Deploying the
  raised Cloud Run revision (600s/2Gi/2CPU) is Wolf's; `docs/CAPTURE_OPS.md`
  in pdf-tool carries the exact command + cost estimate (~$0.02–0.03 per
  20-page crawl).
- **T12.9 (CMS-Agent, branch `t12-9-capture-conductor`): scaffolding + mock
  proof landed, row OPEN.** `capture_conductor` is workflow #2 through the
  built seam: five `capture.*` controlled tools, deterministic fast-path
  nodes, exactly three AI nodes, drafts-only with the forbidden-verb set
  refused pre-transport, engine vendored byte-faithfully from this repo
  @2feb0001 (hash-pinned provenance test). Mock e2e run completes with zero
  model spend outside the three AI nodes; 14-gap replay proves the
  reject-never-coerce path. Suite 164 files/1515 → green. PENDING: live proof
  vs the deployed T12.8 plane, `nodes:update` + redeploy (Wolf),
  PLATFORM_MCP_TOKEN rotation.
- **T12.10 (this repo): CLOSED** — see the entry below.
- **T12.11 (CMS-Agent, branch `t12-11-site-duplicate`, on top of T12.9):
  CLOSED.** `site.duplicate` is the one-call entry (target resolution →
  genesis where `newSite` → `workflow.start_dry_run` + long-run kick in one
  call) with `site.duplicate_status`, catalogued refusals (unreachable /
  deny-all / `netlify_token_missing` / budget), and a genesis driver proven
  against a dry-run Netlify API mode emitting the 14-item runbook-verbatim
  human checklist. Plus the small platform seam in this wave:
  `create-site.mjs --json` (T12.11 seam commit). Suites: CMS-Agent 169
  files/1531; platform 2387+149+45. LIVE genesis waits on
  `NETLIFY_API_TOKEN` with site-create rights (standing).
- **T12.12: agent prep complete, human_gate OPEN.** Dry-run mint of
  `sites/zilberman` is clean (80 files, env table matches T11.7, seed pack
  matches fernwell/platform), parity audit passes ×3 existing tenants, zero
  genesis-stage defects. Wolf's 22-item account-authority checklist + the
  automation-notes template (feeds T12.11's live genesis) delivered as
  session output.

Nothing was pushed and no PRs were opened (per convention); the wave reaches
main via Wolf's land script. The T12.6 rerun gate is untouched: rerun waits
on T12.9-live + T12.12, goes through `site.duplicate`, and **Wolf
dispositions it**.

---

## 2026-08-13 — T12.10: drafts render without publishing; the visual half of the fidelity loop exists

The T12.6 run scored **0 visual comparisons out of 34** because a captured
draft is an unpublished object graph and unpublished objects do not render.
`score.mjs` had `--preview` / `--screenshot-root` inputs nothing had ever fed.
Both halves are now built.

**The preview render path (`packages/core/cli/capture/preview.mjs`).** Of the
three stages between a draft and a reader — `object_publish` (derived export),
`release_to_production` (commit into `sites/<client>/data/site/pages/`), deploy
(build) — only the last makes HTML. So the preview keeps the build and replaces
the governance stages with a throwaway tenant: `sites/<client>` is COPIED into
`.tmp/`, each emitted page body is written into the copy's export directory at
a preview-only route `/__draft-preview/<page object id>` (never the emitted
route — a captured home page claims `/`, which is what quarantined a page in
T12.6), the captured theme is applied to the copy's site object `brandTokens`,
and an ordinary Astro build runs against the copy. Drafts render through the
real `PageObjectRenderer` → section-component path; there is no second
renderer, nothing touches the store, the working tree, git, or a deploy, and
`object_publish` / `release_to_production` / `trigger_netlify_build` / `deploy`
are recorded as refused in the manifest. Local build, per the brief's own
allowance.

**One screenshot implementation (`browser.mjs`).** `capture.mjs`'s private
middle — viewports, DOM extraction, per-viewport measurement, screenshot
writers, settle rules — moved into a shared module both planes use, at exactly
the capture viewports (mobile 390×844, desktop 1440×1000). It is the module
pdf-tool's T12.8 `render-service/src/capture.ts` was ported from; pdf-tool's
plane is https-and-DNS-only by design and cannot be pointed at a loopback
preview build, which is why the local plane exists. Emitted sections are
located by the annotation the renderer already stamps
(`data-cms-object-id`/`data-cms-section-id`), which is how a preview shot is
filed under the SOURCE block's ref — the key `previewLookup` already read.

**Normalization (`screenshot-normalize.mjs`)** is the pixel twin of
`html-normalize.mjs`: flatten alpha onto white, resample BOTH sides onto one
comparison raster (pinned width + kernel, derived from the source aspect).
That fixes a real defect — the old code resized only the preview, so a one-pixel
height difference sheared every row below it — and averages away antialiasing.
No blur, no per-channel tolerance, no ignore-regions; no CSS was touched to
chase a pixel.

**The 0/34 rule.** Every `unavailable` comparison is now an enumerated
**defect** carrying its block's mapping status, a page with no scored
comparison is itself a defect, and `score.mjs` exits `3` when
`visual.evidenceComplete` is false. `rubric` is untouched — visual evidence
explains, it never authorizes. Re-scoring the committed Zilberman fixture in
the suite yields 0 scored / 38 unavailable → **43 defects**.

**Fixture (`fixtures/preview-fixture/`).** The Zilberman fixtures are redacted
and byte-free, so nothing in the repo could score a comparison. A synthetic
two-page publisher (invented copy, no third-party pixels) is served on loopback
and run through capture → map → theme → emit → preview → score by
`scripts/capture-preview-fixture.mjs`, landing on `sites/fernwell`. Result:
**12 scored / 4 unavailable**, both pages scored at both viewports, aggregate
**72.91%**, per-block 32.65%–95.38%; the 4 defects are the two home blocks the
`home` PageType does not allow (nothing was emitted, so there is nothing to
photograph — said plainly instead of scored away). Two full regenerations give
byte-identical PNGs (all 36) and an identical `visual` block. Committed
side-by-side artifact: `fixtures/preview-fixture/run/side-by-side.html`.

Report: `cms-pipeline/reports/T12.10-draft-preview-2026-08-13.md`. Runbook
gained Stage 4.5 + the defect/normalization reading rules. Tests: 2387 + 147 +
45 pass (capture leg 32 → 45). **This reruns nothing**: a Zilberman rerun needs
a fresh capture (no committed bytes) and a live emission into `sites/zilberman`
(T12.12), through `site.duplicate` (T12.11). T12.6 stays a `human_gate`
awaiting Wolf.

---

## 2026-08-13 — T12.7: capture policy unified on ProjectCapturePolicy; seed kit committed

CMS-Agent's `ProjectCapturePolicy` is now the ONE capture policy shape; the
engine is a consumer of it at every entry point. `snapshot-v1.mjs` gained
`parseCapturePolicy` (full canonical validation — enums, bounds, strict keys,
`rights`/`designReferences`/`fidelity` all required) and
`readProjectCapturePolicy` (envelope reader: `capturePolicy`, with
`capture_policy` still read); `validateCapturePolicy` is that parse plus the
crawl gate, so the registry's deny-all default (`maxPages: 0`) is well-formed
but authorizes no run. `emit.mjs` and `score.mjs` read through the same reader
— **fixing a real defect: `score.mjs` read only `capture_policy`, so a live
CMS-Agent `project.get` (which emits `capturePolicy`) silently fell back to the
default rubric.** `emit.mjs` lost its invented `governance.capture` spelling and
now validates `rights` against the canonical enum.

Committed: `fixtures/capture-policy.template.json` (test-proven to pass
`validateCapturePolicy`) and `docs/cms-architecture/capture-runbook.md`
(seeding via `project.update` or the CLI JSON, all five stages with exact
commands, the field table, how to read coverage/gaps/verdict, the Zilberman
worked example — 52.94%, 14 gaps, 0/34 visual — and the deferred client-store
consent object per R-C2 v2). A test proves the recorded 2026-08-13 Zilberman
policy round-trips through the new validation unchanged. Tests: 2387 + 147 + 32
pass (capture leg 26 → 32). No crawler/mapper/emit behavior change beyond the
field-shape alignment; T12.6 stays a `human_gate` awaiting Wolf.

---

## 2026-08-13 — W12 T12.6 PREPARED, NOT DISPOSED: evidence assembled, awaiting Wolf

**Commit ref:** `refs/tags/w12-t12-6` (the `T12.6: …` records commit).

> **CORRECTION (2026-08-13, same day).** The original form of this entry — and
> the T12.6 report, the plan-doc status header, and the queue row committed
> with it — asserted a **Wolf disposition of "not accepted — record the
> misses."** Wolf made no such call. The executing agent completed a
> `human_gate` step itself, which the mode forbids. T12.6 is **PREPARED ONLY**:
> the evidence below is agent-produced and stands on its own, but the
> disposition line is withdrawn and the queue row is reopened. No publication,
> release, or deployment was authorized or performed by anything in this entry.

The agent-recommended disposition, for Wolf to accept or overrule, is
**"not accepted — record the misses."** The measured result is
`needs_governed_iteration`:
9/17 relevant blocks mapped (52.94% versus the unchanged 90% default), theme
tokens complete, all 14 gaps enumerated, and 0/34 visual comparisons scored
because no rendered draft-preview screenshot manifest exists.

The project contract bounds were re-read and recorded with the run:
20 pages for this project/run (not a global cap), exact Zilberman origin and
`/` path, same-origin/robots, concurrency 1, 1500 ms delay, no authenticated
access, and allowed-origin content/media retention. PR Consulting remained a
non-crawl design-only reference with content/media reuse prohibited.

The machine-readable live fidelity and gap reports are now committed under
`packages/core/cli/capture/reports/`. The W10 growth-loop backlog groups the
14 gaps into asset-aware semantic mapping (10), home PageType placement (3),
and governed event behavior/content modeling (1), plus the missing 34-preview-
comparison infrastructure item. The real capture adds no third qualifying
static-composite case, so the composite gate remains closed. The
platformization plan marks the W12 exit criterion NOT MET on the evidence —
independent of the withdrawn disposition, coverage of 52.94% cannot clear a
90% bar — pending remediation and an acceptance run Wolf actually dispositions.

Live inventory read-back still showed exactly nine capture records — one
theme, two section templates, two navigations, and four pages — all with
`published_time: null` and `unpublished_changes: true`. The `/` collision
remains quarantined. No publish, release, deployment, merge, or push was
performed. T12.5's merged-and-deployed dependency and the reviewable-preview
precondition were absent at run time and are preserved as missing
evidence rather than claimed as satisfied.

**Wolf's open step:** review the committed evidence and record a real
disposition. Until then T12.6 stays queued.

## 2026-08-13 — W12 T12.5 governed fidelity scoring complete

**Closing commit ref:** `refs/tags/w12-t12-5` (the single `T12.5: …` task commit).

`packages/core/cli/capture/score.mjs` now produces deterministic structural,
visual-evidence, rubric, iteration, and consolidated palette-gap reports. It
reads only the exact CMS-Agent
`capture_policy.fidelity.coverageRubricOverride` seam, defaults to the ratified
90% mapped-block coverage plus complete-token and enumerated-gap requirements,
and rejects malformed or unknown overrides. Aggregate coverage is computed
from total mapped relevant blocks over total relevant blocks. Theme
completeness covers all T12.3 token roles and axes. Every relevant source block
gets a visual-evidence entry; missing source or draft-preview binaries stay
explicitly unavailable and never become a passing score.

The bounded runner permits at most three rounds and only schema-validated
`section_variant`, `theme_axis`, or `section_config` draft-data proposals.
Invalid proposals quarantine, nested CSS/HTML/script fields are refused, and
screenshot paths cannot leave the run evidence root. The scorer has no MCP
write or publication implementation. The committed Zilberman redacted fixture
is reproducible byte-for-byte across two runs, and its consolidated gap report
is linked from `design-vocabulary-gaps.md` without minting vocabulary.

The live `platform` evidence did **not** meet the bar: 9 of 17 relevant blocks
mapped (52.94%, minimum 90%), complete theme tokens passed, all 14 gaps were
enumerated, and the verdict is `needs_governed_iteration`. All 34 block/viewport
visual entries are explicitly unavailable because no rendered draft-preview
screenshot manifest exists. No speculative data edits were applied without
that evidence, and the threshold was not loosened. T12.4's nine records remain
never-published drafts; T12.5 performed no MCP writes and no publish, release,
or deployment action.

Nineteen focused emitter/scorer tests pass; `npm run check` passes with the 27
pre-existing Astro hints and `git diff --check` passes. A bounded full
`npm test` attempt reached the capture suite (26/26 passing, including all
T12.5 tests) but was interrupted after the repository's compiled test process
retained handles instead of terminating; it is not recorded as a full-suite
pass.

## 2026-08-13 — W12 T12.4 governed draft emission complete

**Closing commit ref:** `refs/tags/w12-t12-4` (the single `T12.4: …` task commit).

`packages/core/cli/capture/emit.mjs` now turns the T12.2 mapping and T12.3
theme artifacts into a deterministic, inspectable MCP-only draft plan. Live
execution resolves the exact CMS-Agent project policy before touching the
target MCP, derives the sole active site from inventory, reads creation
contracts and reuse inventories, resolves every existing page body for route
collision checks, validates the exact requested id and body before create,
passes an idempotency key on every create, retries an ambiguous timeout/502
only with that same key, and revalidates every created object. Validation
eligibility must be explicit; missing or failed validation quarantines rather
than passing open. Publish, release, deploy, direct-store, hotlink, and
placeholder paths are absent and guarded as forbidden verbs.

The live `platform` run used the contract-owned Zilberman content/media rights
posture and `site_platform`. It created one theme, two section templates, two
navigations, and four pages. All nine records are active, validator-eligible,
carry `published_time: null`, and report unpublished changes. The captured
homepage was not written because `/` is owned by `page_home`; the collision is
an explicit quarantine. The remaining source page with zero mapped sections
was allowed as a draft with a validation warning and no blockers. Ten mapped
assets were fetched within the 1500 ms project delay, byte-counted and
SHA-256-verified, then materialized through the target artifact pipeline under
their owning page request ids: nine images and one DOCX. A final request-index
read resolved all ten with `portable:false`; no source URL was placed in an
object body.

The committed fixture report is a full zero-write dry run. Twelve focused
emitter tests cover deterministic planning, project/site binding, reuse-first,
route-body probes, exact-id prevalidation, explicit validation eligibility,
post-create quarantine, draft proof, same-key retry, scoped media, request-id
grammar, and forbidden verbs. The complete capture suite has 19 passing tests;
`npm run check` and `git diff --check` pass.

## 2026-08-13 — W12 T12.3 theme extraction complete

**Closing commit ref:** `refs/tags/w12-t12-3` (the single `T12.3: …` task commit).

`packages/core/cli/capture/theme.mjs` now turns a valid, quarantine-free
`snapshot.v1` into a complete `theme.v1` draft plus an escaped HTML
swatch/typography/axis specimen. All ten required renderer color roles are
present. Missing color evidence uses the registry fallbacks and is visibly
marked fallback at confidence zero; computed font families are reduced to safe
stacks without shipping font files; layout, shape, and type measurements are
quantized only to the W10 enums. Imagery-style observations remain report-only
and never touch `brandImagery`.

The Zilberman run produced one evidence-backed color role and nine explicit
fallback roles from the sparse outer-block computed-style sample; six axes had
bounded measurement evidence and shadow correctly stayed at its default with
zero confidence. The fixture theme and HTML specimen are checked in for human
review. No theme was applied and no store write occurred.

Verification: three focused compiled tests pass, covering registry/schema
validation, checked-in golden artifacts, inert-data HTML escaping, invalid and
quarantined input refusal, and the real `site_apply_theme` dry-run path. The
dry run emitted a clean exact-replace operation, explicitly unset every stale
dark key, and made zero writes. Existing 147 script tests and seven capture
tests pass; `npm run check` passes with 0 errors and 0 warnings (27 pre-existing
hints); `git diff --check` clean.

## 2026-08-13 — W12 T12.2 decomposition mapper complete

**Closing commit ref:** `refs/tags/w12-t12-2` (the single `T12.2: …` task commit).

`packages/core/cli/capture/map.mjs` now deterministically maps `snapshot.v1`
pages into ordered, schema-ready page/section candidates and header/footer
`navigation.v1` candidates. Every candidate exposes
`{ sectionType, data, confidence }`, source-block/screenshot evidence, and
field-level `source: 'extracted'` provenance. Optional model assistance can
suggest only a registered type; it cannot inject data. Links are classified as
route/external targets and media remains in manifest bindings pending artifact
materialization, never as source hotlinks in section data.

The mapper accounts for every source block and enumerates unexpressed,
below-threshold, or PageType-disallowed evidence using the documented gap
contract. It refuses input with quarantined pages and has no store, publish, or
release path. The full local Zilberman snapshot produced nine section
candidates, two navigation candidates, 14 explicit gaps, and 33/33 accounted
blocks. The checked-in redacted golden produces three section candidates, two
navigation candidates, 17 gaps, and 33/33 accounted blocks; lower semantic
coverage is expected because source copy is intentionally redacted. The home
PageType allowlist is pinned fail-closed and drift-tested against the live
registry, so disallowed evidence becomes an explicit gap rather than being
coerced into an invalid draft.

Verification: the six new compiled golden/schema/safety tests pass; every
emitted page, section, and navigation body parses against the live Zod schemas;
the existing 147 script tests and seven capture tests pass; `npm run check`
passes with 0 errors and 0 warnings (27 pre-existing hints); `git diff --check`
clean. The default unbounded-concurrency compiled-suite runner was also tried
and reached the new tests green, but did not terminate because unrelated
pre-existing server test workers retained handles; the immediately preceding
T12.1 full baseline was green.

## 2026-08-13 — W12 T12.1 capture spike complete

**Closing commit ref:** `refs/tags/w12-t12-1` (the single `T12.1: …` task commit).

The live CMS-Agent `platform` capture contract was verified before the run:
Zilberman-only origin, `/` scope, project-local max 20 pages, same-origin,
robots required, concurrency 1, 1,500 ms delay, no authentication, source
content/referenced-media retention allowed. PR Consulting remained a non-crawl,
design-inspiration-only reference with content/media reuse prohibited.

The Playwright-core spike in `packages/core/cli/capture/` ran locally against
the robots-declared sitemap and captured all five unique HTML pages: 67 outline
nodes, 33 candidate blocks, 43 asset references (35 unique URLs), and 76/76
mobile+desktop screenshots. Zero pages were quarantined; one document link was
kept as an asset and one legacy route was deduplicated after redirect. No CMS
or store write occurred. Full text/screenshots remain ignored under `.tmp/`;
the committed fixture has structure and asset URLs only, with text redacted and
no media bytes.

Verification: live end-to-end capture `ok: true`; `npm test` passed 2,378
compiled tests + 147 script tests + 6 capture tests, then the final focused
capture suite passed 7/7 after adding the fixture-byte guard; `npm run check`
completed with 0 errors and 0 warnings (27 pre-existing hints);
`git diff --check` clean.
Format limits and the T12.2 mapper-input recommendation are recorded in
`docs/cms-architecture/capture-spike-findings.md`.

## 2026-08-10 — W16 executed: genesis scope + fleet parity (T16.0–T16.8, T16.10 landed; T16.9 partial)

Mandate: `docs/cms-architecture/16-genesis-parity-plan.md` (same-day plan, ratified same day).
All repo-side W16 tasks were implemented in one session by Sonnet/Opus subagents in three
concurrency waves and landed as one commit per task (plus one fixup); full suite green at every
merge point (final: 1965 compiled + 144 script tests, 0 fail, 0 todo), `audit-site-admin-parity
--all` PASS at 16 checks per tenant (13 + toml-posture + binding-capability + the two genesis
checks folded in W15/S3 numbering).

What landed, in queue order: **T16.0** genesis manifest (`packages/core/cli/genesis-manifest.mjs`)
now feeds `buildPlan()`, `DATA_SITE_SUBDIRS`, and the drive's `SEED_MODULES`, with a drift test
(`tests/scripts/genesis-manifest.test.mjs`) and the W16 law section in CLAUDE.md. **T16.1** voice +
tracking-config are onboarding-stage manifest entries; create-site emits both skeletons
(`ONBOARDING_FILL_MARKER`, nothing invented); platform gained templates + tracking seeds, fernwell
its voice export dir + tracking seed; dry-run fixture 77 → 80 files; zero expected-failure rows
remain. **T16.2** `CANONICAL_TOML_POSTURE` (pretty_urls, `/_astro/*` immutable cache, CSP-RO,
image-validation build step — `validate-upload-images.mjs` grew a postRoot arg) on all three
deploys + the template + a `toml-posture` parity check; the csp-drift platform row runs for real
now; drlurie's duplicate `public/_headers` deleted. **T16.3** `warmAdminKeepalive: true` fleet-wide
+ `binding-capability` check; finding: adminLabel/committer identity live on the site-identity
seam with sane fallbacks, NOT on SiteBinding — plan §1.2 item 5 conflated the two seams, no change
needed there. **T16.4** `/rss.xml` + `/search.json` are core-injected shell routes with an explicit
site-override probe (Astro does NOT dedupe file vs injected routes — collision is a logged warning
today, a hard error in a future Astro; the probe skips injection when the site owns the file);
drlurie output byte-identical, fernwell serves a valid empty feed + `[]` index. **T16.5**
`capability_status` internal-only MCP tool + `scripts/fleet-capability-probe.mjs` + the
FLEET-STATUS live matrix section; every gated family's "is configured" check refactored to a
single shared predicate; flagged: `PURCHASE_TOKEN_SECRET` is missing from T11.7's env table (P2
gap, doc fix pending). **T16.6** the site-literal lint now strips strings before comments (the
glob-`/*` blind spot that hid 40 % of create-site.mjs is regression-tested), walks core
package.json files, and the CSP gate reads per-site truth; object-page-routes derives from
committed exports instead of a hand-list. **T16.7** `@drlurie/core` → `@fleet/core` everywhere
incl. lockfile (link-shaped delta) and the create-site stamp; lint allowlist EMPTY. **T16.8**
`site-genesis-drive --verify` — read-only (write verbs structurally unreachable), OK/MISSING/
DRIFTED with merge-aware field diffs, bootstrap-marker check, `--json`; 18 tests. **T16.10**
`npm run site:create / site:genesis / site:verify / fleet:parity / fleet:capability` + 
`docs/cms-architecture/new-client-acceptance.md` as the one genesis spine.

**T16.9 ran PARTIALLY (session MCP connectors only) and is the open half:**
- Platform: `tpl_interior` / `tpl_landing` / `tpl_legal` CREATED in the store from the T16.1 seed
  (v1, active, unpublished). **Publish is BLOCKED: `object_publish` → `Export commit failed` on 4
  attempts (~11:10Z)** — the git-committer family (`GITHUB_CONTENT_TOKEN` on `kugel-platform`) is
  the prime suspect; drlurie's auto-publisher committed fine 2026-08-09 18:20Z, so it is
  platform-scoped, and it blocks EVERY publish there, not just templates. Locks released cleanly.
- Platform `trk_platform` exists, published — the tracking seed↔export inversion is closed
  store-side; the T16.1 seed skeleton matches the committed export.
- Dr-Lurie `tracking_config` store is EMPTY: the drlurie tracking seed is onboarding-stage
  not-yet-run (recorded, per the T16.9 brief — no action).
- Fernwell: NOT touched — no fernwell connector in the executing session. Its template
  instantiation, admin-nav-link fix, and voice INFO check remain.
- The full `fleet:capability` probe + `site:verify` on all three need the W16 code DEPLOYED and
  per-site `MCP_HTTP_AUTH_TOKEN__<SLUG>` values — rerun T16.9 to completion after this lands and
  builds.

Next actions, in order: (1) land + release this wave (deploys all three sites), (2) fix
`kugel-platform`'s export-commit env and re-run the three template publishes + one release,
(3) re-run T16.9 with a fernwell connector or tokens: verify × 3, probe × 3, fernwell backfills,
replace the FLEET-STATUS matrix stub with real output, (4) the two doc follow-ups: add
`PURCHASE_TOKEN_SECRET` to T11.7's table; decide drlurie's tracking onboarding timing.

## Session 2026-08-04 (W15 S3 — existing tenants retrofitted to admin parity; the whole W15 stack landed on main)

Every EXISTING tenant now matches what `create-site` emits for a new client,
and the W15 stack is MERGED: main carries S1 (partial, 1/4), S2 (audit
machinery + genesis completeness), S3 (this retrofit, landed as PR #505),
plus the PDF template bridge (was draft PR #501) and an S4x Ask-AI context
enrichment (PR #504) that rode the same landing window.

**Session-topology note (nothing hidden):** this stage ran as MULTIPLE
concurrent sessions racing on the same branch. One session pushed the
retrofit in four commits off S1 and opened PR #503 — unaware S2's branch and
PR #502 had surfaced mid-flight. A second session verified that work end to
end, merged `w15/s2-fleet-admin-genesis` into the branch, and re-verified
the union. A third actor restacked and landed everything: it recreated
S1+S2 on main, redid the S3 content against that base
(`w15/s3-resolved`, PR #505, squash-merged 15:30 +03), and closed the
morning's PR queue. The result on main was then INDEPENDENTLY verified by
the second session (below). The S3 retrofit content on main and the
verified reconciliation tree agree file-for-file; the only casualties of
the race were process, not content. Stale branches from the race
(`w15/s3-tenant-retrofit` with post-restack reconcile commits,
`w15/s1-admin-core-repairs` with a dead-end #503 merge) can be deleted —
nothing on them is missing from main except this entry and the checklist
refinements landed alongside it.

**The retrofit itself (what W15 S3 changed):** fernwell's four missing
`[...blog]` reader loaders (now byte-identical to
`site-reader-route-templates.mjs`'s F14 block-body output); the `postDir`
pin on platform + fernwell (`buildSiteCollections` defaulted to
`src/data/post` — Dr-Lurie's preserved legacy shelf — so Dr-Lurie's
committed `test-article-dry-run` was PUBLICLY SERVED on kugel-platform's
`/test-article-dry-run` and listed on `/library`; each tenant now has its
own empty `data/post/` shelf and `create-site` emits the pin); per-site
`SECRETS_SCAN_OMIT_KEYS = "GITHUB_REPOSITORY"` (root parity, the T9.24
lesson); and the site-config drift test widened from Dr-Lurie-only to all
three tenants. Fernwell is NOT retired — F6 was a page-retire drill ON
fernwell, and T14.9 leaves it up for feature testing — so it was
retrofitted like the rest. Client sites outside this repo: none
(13-separation-plan is design-only; the monorepo is the whole fleet).

**Verification at current main (084198b), independent of the landing
actor:** `npm run check` clean (astro check 0 errors); full suite
**1647 + 102 pass, 0 fail** (includes S2's 13 admin-parity tests, which run
the audit against every real tenant on every `npm test`, the widened drift
guards, the PDF-bridge tests, and the S4x test);
`audit-site-admin-parity.mjs --all` — **12/12 automatable checks PASS ×3
tenants**; `migrate-site --admin-parity` — nothing automatable to fix; all
three builds green (root 75 pages, platform 43, fernwell 15 incl.
`/learn/library`), every `/admin` route present in each dist. **Build-diff
discipline:** root reader pages byte-identical; platform/fernwell reader
pages identical EXCEPT the documented leak removal (`/test-article-dry-run`
+ library listing + sitemap). One pre-existing oddity worth its own look:
the admin `_astro` chunk hashes churn on every same-tree rebuild (verified
by building an identical tree twice) — build nondeterminism in the admin
React bundles, not a W15 change.

**What the parity machinery should learn** (recorded in
`15-tenant-retrofit-checklist.md`): the `postDir` pin and the per-site
secrets-scan omission as `admin-parity.mjs` audit checks + `--write` fixes.
**Wolf's remaining human steps** are in that checklist — first-Owner
sign-in confirmation on platform/fernwell, one 12-store probe run per
tenant (4 stores were never probed pre-S2 — use `--netlify-site-name`, see
the checklist warning), and verifying the three post-merge production
deploys went green. The audit ran twice over (by hand against `create-site`
emissions, and via S2's script) and the two agree everywhere they overlap.

## Session 2026-08-04 (W15 S6 — fleet verification + status)

Final stage of the scheduled [W15-fleet] sequence: an autonomous verification
pass over everything the earlier sessions produced, run against a fresh
clone of `main` and the live GitHub PR/branch state (read-only — nothing in
this session merged, deployed, or released anything).

**Headline finding: two PRs report "merged" on GitHub but their commits are
NOT reachable from `main`.** `git merge-base --is-ancestor` against
`origin/main` was run for every [W15-fleet] PR's head commit:

- **#500 (S1)** — squashed into `main` as `27696ed`. Confirmed present.
- **#502 (S2)** — squashed into `main` as `776e59e` (current `main` HEAD at
  the time of this session). Confirmed present.
- **#503 (S3 — tenant retrofit)** — GitHub reports `merged: true`,
  `merged_at: 2026-08-04T12:08:17Z`. Its head commit
  `676de97ff207f991ba1a666ee3e7fb35ef91f171` is **not an ancestor of
  `main`** and no `w15/*` branch remains that contains it — the commit only
  still exists because GitHub hasn't garbage-collected it yet (fetchable by
  SHA). S3's own PR body already flagged the risk: it was based on
  `w15/s1-admin-core-repairs` because "S2 never ran" at the time it was
  authored; S2 landed 17 minutes later and squash-merged/deleted that base
  branch out from under it. The apparent GitHub merge afterward did not
  bring the diff into `main`.
- **#504 (S4x — canvas Ask-AI context enrichment, NOT the Marginalia
  editor)** — same pattern. `merged: true`, `merged_at: 2026-08-04T12:19:31Z`,
  head `6dd7f4d3dde2be6d23d488aa4b4a2f65d79a0266`, **not an ancestor of
  `main`**. This PR was not part of the originally scheduled S1–S5 sequence
  — it appears to be additional prompt-assembly work for canvas Ask-AI
  (folds `editorial_voice`, claims/compliance, section notes, and review
  state into the AI suggestion prompt; explicitly out-of-scope for
  Marginalia/canvas UI). Scoped, tested (5 new tests, 1640+89 passing per
  its own PR body), and by its own account inert in production today (no
  site has a live `editorial_voice` object yet) — but it is also orphaned
  and needs the same recovery action as S3.

Recovery for both is mechanical (cherry-pick or re-branch from the orphaned
SHA and re-open a PR against current `main`) but is a human/next-session
decision, not something this read-only verification session should do.

**What's actually verified in `main` (S1 + S2 only):**

- `npm ci` — clean, 1050 packages.
- `npm run check` — 0 errors, 0 warnings (12 pre-existing `ts(6133)`/`ts(7043)`
  hints, unrelated to W15).
- `npm test` — 1636 + 102 pass, 0 fail.
- `npm run build` (root, Dr-Lurie) — 75 pages, success.
- `astro build --config sites/platform/astro.config.ts` — 44 pages, success.
- `node scripts/audit-site-admin-parity.mjs --all` — PASS for all three
  tenants (`sites/fernwell`, `sites/platform`, root/drlurie): 12/12
  automatable checks, 3 human-gated rows each (Identity enablement,
  admin env values, live store probe — all account-authority actions,
  expected).
- `node packages/core/cli/create-site.mjs --name w15s6probe --dry-run` — full
  73-file genesis plan printed (shell routes, 34 function shims, 14 infra
  redirects, blog reader loaders, blob-store probe list, ADMIN WORKSPACE
  BOOTSTRAP checklist), zero files written. Proves a **future** client is
  born at admin parity by construction, not just the three current tenants.
- 7-assertion headless-Chromium drive (Playwright, mocked GoTrue session +
  `/.netlify/functions/admin-*` endpoints, replicating
  `sites/platform/netlify.toml`'s actual S1 rewrite rule byte-for-byte)
  against the built `sites/platform` output — **7/7 checks pass**:
  `/admin` reachable; `/admin/content` (library) loads; the S1 regression
  target `/admin/content/page_home` resolves **without** a `?type=` param;
  "Back to library" returns to the static library index with no loop;
  a signed-out visitor triggers zero admin/identity network calls and never
  fetches the real edit-mode bundle (only the ~600B always-present
  pre-check script loads, confirmed by content-matching the bundle that
  actually exports `bootEditMode`, not just filename substrings — the
  naive filename check false-positived on `policy-bindings.*.js`, which
  customer-facing header/login components also import).

**Still-open bug confirmed live**: S3 diagnosed that `sites/platform`
inherits Dr-Lurie's committed `src/data/post/test-article-dry-run.md` via
shared `postDir`, so `kugel-platform` serves a leaked test post at
`/test-article-dry-run` (and lists it on `/library`). Because S3's fix never
reached `main`, this is **still present** in the current `sites/platform`
build — confirmed by building it fresh this session: 44 pages, including
`dist-platform/test-article-dry-run/`. This is a real, currently-live defect
on the public site, not a stale audit finding.

**Deferred stages, as scheduled — not failures:**

- **S4 (Marginalia editor)** — no PR, no branch. Deferred for cost per
  standing instruction. (Not to be confused with #504/S4x above, a
  different and much narrower piece of work.)
- **S5 (client publishing chat / LibreChat)** — no PR in `platform`, and no
  `[W15-fleet]`-tagged PR in `vreich-ui/CMS-Agent` (checked both
  `search_pull_requests` and a full recent `list_pull_requests`). Deferred
  for cost per standing instruction; `deploy/librechat/librechat.yaml`
  validation and per-client publisher-agent-preset checks were skipped
  because there is nothing to check.

**Fleet parity, current state:** all three tenants (Dr-Lurie/root, Platform,
Fernwell) pass the S2 audit at 12/12. A fourth, throwaway scaffold proves
future-client genesis at the same parity. No fleet-wide gap is open on the
audit's own terms — the open items are the two orphaned PRs above and the
one live leak they would have fixed.

Full write-up, with per-stage table and the ordered human checklist:
`docs/cms-architecture/FLEET-STATUS.md`.

## Session 2026-08-04 (W15 S2 — fleet admin genesis: provisioning completeness + parity audit)

Wolf's W15 mandate: every tenant — current and future — gets the full admin
workspace and canvas editor, not just Dr. Lurie. The surface was already
fleet law; the LAST MILE (shims, rewrites, Identity, ADMIN_EMAILS, blob
stores, pre-wave scaffolds) was tribal knowledge. This session made
admin/editor completeness a **checked property of site genesis**.

**The machinery.** `packages/core/cli/admin-parity.mjs` is the single source
of truth: the canonical 14-rule infra redirect table (pdf/img, `/mcp`, the
nine OAuth-AS rules, `/api/t`, and the S1 single-segment unforced
`/admin/content/:objectId` rewrite — any `/admin/content/*` splat is stale
by definition), the admin-critical env inventory, the store expectations,
and every automatable check. Two consumers:
`scripts/audit-site-admin-parity.mjs` (read-only pass/gap table per tenant —
`--site sites/<slug>`, `--root` for the drlurie deploy, `--all`; exit 1 on
any gap) and `migrate-site --admin-parity [--write]` (retrofit an older
site: adds missing shims/redirect rules/keepalive schedule/reader loaders,
replaces the stale admin splat in netlify.toml AND site.config.ts, never
overwrites an existing file, provably idempotent). The schema half of
migrate-site now lazy-loads its compiled-tree imports so the parity half
runs on a raw checkout. Human-readable inventory with per-requirement
provisioner (scaffold | migrate-site | Netlify console | env):
`docs/cms-architecture/15-fleet-admin-parity.md`.

**Genesis completeness.** `create-site` now: probes **all 12** core blob
stores (the audit caught the probe list covering 8 — `agent-profiles`, the
W9 §4a dedicated-agent store the admin chat resolves profiles from, plus
`opt-ins`/`commerce-events`/`tracking-events` were used by core but never
probed; the list is now CHECKED against the store literals via
`scanCoreBlobStoreNames`); prints an ADMIN WORKSPACE BOOTSTRAP human-gate
checklist (enable Identity → set ADMIN_EMAILS → invite first Owner) with
every plan and run; carries sharpened ADMIN_EMAILS/IDENTITY_URL checklist
rows; and dropped the stale `OPENAI_CHATKIT_WORKFLOW_ID` row (ChatKit
retired T9.24; zero code consumers). The dry-run fixture was regenerated.
The provisioning runbook gained **§3a — the admin human gate**: exact
console steps, marked as the only part of admin bootstrap a CLI cannot do.

**Fleet state, from the audit.** sites/platform: 12/12 automatable checks
PASS. Root drlurie wiring: 12/12 PASS (S1's rewrite fix verified in place;
`verify-article-images` correctly reported as a site-local extra).
sites/fernwell: 1 gap — it predated W14 F11 and was missing all four
`[...blog]` reader route loaders (published articles and their canvas chips
unreachable); repaired in this change via
`migrate-site --site sites/fernwell --admin-parity --write`, re-audit clean,
fernwell build verified green locally (15 pages, zero-article corpus).
`tests/scripts/admin-parity.test.mjs` (13 tests) pins
genesis-parity-by-construction, the degrade→repair→no-op loop,
never-overwrite, and runs the audit against every real tenant on every
`npm test` — the fleet cannot silently drift below admin parity again.

**F14 (found and fixed en route).** `create-site`'s emitted article loader
(`site-reader-route-templates.mjs`, the F11 addition) used the
single-expression form "(async () => await getStaticPathsBlogPost())
satisfies GetStaticPaths" — which makes the Astro compiler's hoist pass drag
the adjacent "const { post } = Astro.props" up to MODULE scope. The compiled
route then throws "Cannot destructure property 'post' of 'Astro.props'" at
import time and fails the ENTIRE build — reproduced on fernwell's
zero-article tree; every fresh scaffold since F11 would have failed its
first build the same way (the F11 session's local builds were recorded
infrastructure-inconclusive, so this never surfaced). All four loader
templates now use the block-body + blank-line shape sites/platform's proven
committed loaders use, with the finding documented at the template site;
fernwell's committed loaders are the fixed templates' output, build-proven.

**Residual human gates (unchanged in kind, now visible per-run):** enabling
Identity, ADMIN_EMAILS/env values, first-Owner invite, and the credentialed
store probe need account authority — the audit prints them as HUMAN rows;
§3a has the clicks.

## Session 2026-08-03 (Platform README integration and forward-contract cleanup)

PR #499 carries the Platform README routing and template-contract fixes. Its
first CI run exposed two downstream assumptions that were intentionally
removed rather than preserved: template instantiation still compiled against
the broad page-section union, and a legacy test still constructed a
`shared_ref` recipe even though V1 recipes now advertise concrete registered
components only. Instantiation now narrows referenced recipe types through the
same component-bound predicate and the obsolete fixture is gone.

The fleet build also exposed F13: the shared image optimizer calculated a
responsive height for public/remote string images, then omitted that height
from Astro's `getImage` request. New object-backed article images could
therefore validate and publish but break a listing page at static generation.
The Astro and CDN paths now share a pure breakpoint-dimension helper; focused
template, body-schema, and image tests pass 33/33. Full fleet CI remains the
merge gate.

## Session 2026-08-02 (Platform README corpus + live object/fleet audit)

The Platform tenant was expanded from a sparse shell into executable product
documentation through the production MCP. The live store now has **45 records
across all 12 governed types**: 26 pages, 2 navigation objects, 1 taxonomy, 1
site singleton, 1 shared section, 1 page template, 6 section templates, 2
themes, 1 product, 2 content items, 1 tracking config, and 1 editorial voice.
All 45 pass `object_validate` with no blocker, warning, or held lock. Product
and editorial voice exercised the approval gate and remain in human review;
the other changed objects were published dark and released once at commit
`41784071cfedbf719307f7fc2689074477b96442` (Netlify deploy
`6a6f8ffb76955a0008e9a141`, ready and production-confirmed).

The manual now covers architecture, V1 publishing, multisite generation,
testing, known gaps, a DTC launch object map, every object type, and two
object-backed articles. The drive exercised create, candidate validation,
checkout, typed patch, theme apply, page-template instantiation,
section-template stamping, publish, checkin, approval refusal, batch release,
and public route verification. It also corrected Platform's canonical host,
blog-path metadata, taxonomy vocabulary, header, and footer.

Two code defects surfaced. **F11:** generated sites omitted the blog route
loaders, leaving valid `content_item` records and the listing object
unreachable even though the build succeeded. Platform and `create-site` now
carry the four route loaders, and Platform's routing file agrees with its site
object at `/library`. **F12:** the template schema advertised `shared_ref` and
`card` as allowed slot types although the structural validator rejects them;
the slot enum now derives from the registered concrete component list. Both
fixes have focused regression coverage and are recorded in `w14-findings.md`.
The create-site suite is green (14/14) and the body-schema suite is green
(20/20). Two local Platform build attempts spent 80 and 100 minutes hydrating
dependencies through macOS File Provider, emitted no Astro diagnostic, and
created no `dist`; the full render gate is therefore recorded as
infrastructure-inconclusive, not passed.

## Session 2026-08-02 (platform Netlify build incident — NavTarget renderability closed)

An autonomous publish added `Library` to platform `nav_header` with the
schema-valid target `{kind:"page", page:"page_library"}`, after publishing the
referenced Page object. `object_validate` accepted it because the page existed
and was published. The subsequent `release_to_production` build failed while
rendering `/404`: the shared navigation adapter still threw on every page-kind
target. The article published in the same batch was unrelated to the failure.

**Root cause:** the governed write contract and the build renderer disagreed.
The schema/reference gate advertised published Page targets as legal, but the
Astro adapter still implemented only the old route-kind bridge. This was a
system defect, not an agent-content mistake.

**Fix and guardrail:** the site-bound resolver now derives a Page-id → route map
from the site's committed `pageObject` collection and injects it everywhere a
NavTarget renders (default header/footer, footer overrides, 404 alternatives,
and section actions). The published platform target therefore resolves to
`/library` without editing the generated export or desynchronizing it
from the object store. Taxonomy targets remain schema-level vocabulary without
a route resolver; `render_nav_targets` now rejects them through the common
validation pipeline used by create, candidate validate, patch, and publish.
They must remain route-kind until resolution exists, so another agent cannot
turn that known renderer mismatch into a release-time build failure. The same
renderability gate requires every page-kind target in page, section, and
template actions to reference an already-published Page before the containing
object may publish; that guarantees the route export the resolver consumes is
already committed.

**Verification:** the exact platform Netlify command
`npx --no-install astro build --config sites/platform/astro.config.ts` is green
with the incident export unchanged (28 pages); the Dr-Lurie fleet build is
green (75 pages); `npm test` is green (1621 core/netlify + 89 script tests);
`astro check` reports 0 errors.

## Session 2026-07-31 (Dr. Lurie ChatGPT connection expiry + agent tool-surface cleanup)

The reported connect-then-drop behavior was reproduced through the live app:
`ping` waited for credential recovery and returned
`run_with_credentials_failed_token_refresh_not_supported` /
`TRIGGER_REAUTHENTICATION`. The live authorization-server metadata advertised
only `mcp`, while access tokens expire after one hour. ChatGPT's documented MCP
OAuth behavior requires `offline_access` (or the provider equivalent) to be
advertised/requested so it will retain and use a refresh token. The server was
already issuing rotating refresh tokens, but its discovery contract did not
tell ChatGPT that offline access was available.

**Fix.** Both OAuth discovery documents now advertise `mcp` and
`offline_access`; new dynamic registrations default to `mcp offline_access`;
the authorization path carries the requested supported subset without widening
an explicit `mcp`-only request. The existing one-hour access-token and rotating
30-day refresh-token security posture is unchanged. Existing ChatGPT app
registrations must be recreated once after deployment so ChatGPT rescans the
updated metadata and stores a refresh-capable grant.

**Agent action surface.** `tools/list` no longer advertises the operational
artifact/upload/deletion/maintenance actions (`create_artifact_*`,
`save_artifact`, `soft_delete_artifact`, `restore_artifact`, artifact index
migration/reconciliation, blob wipe, pdf-tool storage grant, or the redundant
manual build trigger). Their guarded implementations remain available to
explicit internal/admin callers. Read-only artifact metadata, deploy status,
the governed object verbs, registry/commerce tools, release, verification, and
diagnostic actions remain visible; normal information exchange is unchanged.

## Session 2026-07-29 (the legacy `save_json_blob` article pipeline is RETIRED and DELETED)

OQ-W11-6 said retire-with-the-legacy-pipeline, importer-check first. Its last
consumer moved to the object dialect, so this session executed the retirement.

**Precondition, verified before touching code.** CMS-Agent's `dr-lurie` project
allowlists **zero** `save_json_blob_*` tools: every one of them, plus all ten
per-stage helpers (`reader_insight_*`/`research_*`/`angle_*`/`draft_*`/
`final_article_*`), is explicitly `blocked` in its `toolPolicies`, and the
controlled-tool registry carries no entry for any of them. `verify_article_images`
stays `allowed` — it serves the object path.

**What was deleted.**

- The **11 `save_json_blob_*` MCP tools** and the **10 per-stage workflow
  tools**, with their dispatch cases, the `ALLOWED_AGENTS` stage vocabulary,
  `STAGE_TRANSITIONS`, and the whole `content_source.v1` JSON-schema tree that
  existed only to describe their inputs. `packages/core/server/functions/mcp.ts`
  went 4,796 → ~3,400 lines.
- `mcp/save-json-blob-mcp/` (the whole module), `netlify/functions/save-json-blob.ts`,
  `publish-article.ts`, `admin-workflow-lock.ts`, and
  `packages/core/lib/publishArticleFromPayload.ts` + its `Window` declaration.
- `scripts/agent-builder-publish-dry-run.mjs` and the `agent:publish*` npm
  scripts — a client of the deleted endpoint.
- The eight `netlify/lib/*` re-export shims and the five `src/schema/`+`src/lib/`
  FROZEN-PATH stubs that existed **only** to keep the deleted functions'
  imports resolving. (Those stub headers said, verbatim, "Delete when the legacy
  article path retires.") `src/schema/` and `src/lib/` are gone entirely.
- ~20 legacy test files. Net: **46 files deleted, ~16.5k lines removed.**

**Importer check — two live couplings surfaced, neither silently broken.**
`LockManager`'s default config pointed at `admin-workflow-lock`; its only live
caller (`EditSession`) always passed an explicit object-endpoint config, so the
default was removed and `config` became required. `publishArticleFromPayload`
had no runtime caller at all — only a leftover `Window` type from the T9.24
vanilla-JS admin — so it went with the endpoint it called.

**What was PRESERVED, deliberately.** This retired the WRITE pipeline, not
published content: the committed posts under `src/data/post/` and their
rendering are untouched (build verified: 74 pages, the committed post still
renders); the `content_item` slug-uniqueness check still runs against committed
legacy posts; and `verify_article_images` keeps its legacy committed-asset
`filename-stem` matching branch, because published pages still serve
`/_astro/`-hashed committed assets.

`verify_article_images` also keeps the per-site INJECTION seam it shared with
the legacy trio — it is a per-site function and serves the object path
(post-release image verification), so `configureMcp` now takes one optional
handler instead of three. Sites that do not inject it still advertise zero of
its tools rather than a tool that cannot run.

**Guardrail.** `tests/netlify/mcp-legacy-tool-surface.test.ts` was inverted from
"hidden on sites without the legacy path" to "gone everywhere": no site
advertises a retired tool, and the retired names must not reappear as quoted
strings in `mcp.ts` at all.

**Docs.** `docs/agents/publishing-instructions.md`, `mcp-article-body-v1.md`,
and `docs/mcp-final-agent-sequence.md` carry HISTORICAL banners pointing at
`docs/agents/publishing-policy.md` (the object-path runbook).

**Still open — the blob wipe is NOT part of this change.** Wiping the legacy
workflow records with `wipe_blob_stores` is a separate, human-approved
operation to run after this PR deploys; `wipe_blob_stores` stays admin-gated.
The cross-reference it requires (no published `content_item` media path
resolving into a wiped prefix) must be done against the live store first,
because the artifact stores are SHARED with the object path — only legacy
workflow records may go.

Full check: `npm test` 1,606 + 89 pass / 0 fail, `eslint .` clean, `prettier
--check` clean, `astro build` clean.

## Session 2026-07-27 (F10 — every site is now its own OAuth 2.1 authorization server)

Wolf's call on the F9 options: **build OAuth** (option 2), and keep the URL key
so neither delivery is lost. Both ride one branch.

**What landed.** One new core function (`mcp-oauth.ts`) and two libs
(`oauth-store.ts`, `oauth-server.ts`) make each site an authorization server
beside the MCP resource server it already runs:

- RFC 9728 protected-resource metadata and RFC 8414 server metadata, both
  served for the bare path AND the `/mcp`-suffixed probe clients try first.
- RFC 7591 dynamic registration, so a client that has never seen this server
  can obtain a `client_id` with no human pre-provisioning. Registration grants
  NOTHING on its own.
- `/oauth/authorize` validates and **parks the request server-side**; only an
  opaque `request_id` travels through the browser, so nothing a user can edit
  in the URL bar can widen what gets approved.
- The consent screen is `/admin/authorize` — a shell route inside the admin
  workspace, so the login is the Identity login the workspace already has
  (Google included) and the approver is a named admin. Reader accounts 403.
- `/oauth/token` (code + rotating refresh), `/oauth/revoke`.
- `/mcp` became a resource server: OAuth bearer accepted as a third
  independent path, and every 401 now carries
  `WWW-Authenticate: Bearer … resource_metadata=…` — the header without which a
  connector can never discover any of the above.

**Security posture, deliberate:** tokens are opaque and store-backed (revoke
means gone, not "wait for the JWT to expire"); one blob key per record, never a
list doc (concurrent exchanges + eventual consistency would drop grants); raw
tokens and codes are never persisted, only their sha256; PKCE S256 required and
`plain` neither advertised nor accepted; redirect URIs matched exactly, with an
unverified client refused IN PLACE rather than redirected; codes single-use,
consumed before PKCE is checked; refresh tokens rotate. **F1 is not weakened** —
OAuth is additive and the fail-closed behaviour is still pinned by its test.

**Honest limit:** an OAuth token grants the SAME surface as the shared key.
Per-client scope narrowing is dispatcher work and is post-V1. What this buys
today is identity, expiry, and revocation.

25 new tests drive the whole flow against the real handlers (register →
authorize → consent → exchange → call `/mcp` → revoke → 401). Suites: 1761 core

- 89 script + 1358 opt-in, and a platform build verified the consent route
  renders.

**Wolf's action:** in the connector's Advanced settings there is now nothing to
paste — the URL alone (`https://drluriescience.netlify.app/mcp`) is enough once
this deploys; claude.ai discovers the auth server, registers itself, and sends
him to a consent screen he approves while signed in as owner. The `?key=` URL
from F9 keeps working for anything that cannot do OAuth.

## Session 2026-07-27 (F9 — the connector could not carry the token F1 started requiring)

Wolf asked where to put Dr-Lurié's connector bearer. The honest answer was
**nowhere**: claude.ai's custom-connector form takes a URL and OAuth
credentials, and nothing else. No bearer field, no custom-header field. His
connector had worked only because the endpoint was fail-open — and F1 closed
that, correctly, without my checking who was calling.

Rather than park it (R8), the shared token gained a third carrier:

- `Authorization: Bearer <token>` — preferred, unchanged.
- `X-MCP-Auth-Token: <token>` — preferred, unchanged.
- **`/mcp?key=<token>`** (alias `?mcp_key=`) — new, last in the list, for
  clients that cannot send headers at all.

All three compare against the same `MCP_HTTP_AUTH_TOKEN` with the same
constant-time `safeSecretsMatch`. The key is never logged: the 401 diagnostic
gained `hasUrlKey` (presence only), alongside the two existing header flags.

**F1 is not reopened, and that is pinned by a test:** with the shared token
unset in a lambda runtime, `?key=anything` still 401s `mcp_auth_missing_token`.
A URL key is a carrier for the secret, not a substitute for one. Six new tests
in `tests/netlify/mcp-auth.test.ts` (correct key, alias, wrong key + no secret
echo in body or log, whitespace-only key reads as absent, fail-closed).

**The tradeoff is real and written down** in the finding and the runbook: query
strings are logged by proxies and CDNs; the connector URL _is_ the secret.
Headers stay the recommendation. The durable fix is an OAuth server on the site
— post-V1, riding T14.8's per-agent keys.

**Wolf's action:** in claude.ai → Settings → Connectors, edit the Dr-Lurié
connector's URL to append `?key=<the token I minted>` (the token itself is in
the chat message, not in this repo). Nothing else to change.

## Session 2026-07-27 (F6 PROVEN LIVE — the retire path, end to end on Fernwell)

**The last unproven piece of V1 is proven.** F6 was built and unit-tested but had
never run against a real site; Fernwell's genesis had already shown that live
runs surface what tests do not. Drilled on the synthetic site, in order:

1. Created `page_drill_retire` at `/drill-retire` through `/mcp`, published,
   released → **live, 200**.
2. `object_checkout` → **`object_retire`** (`redirect_to: '/'`). Response carried
   `export_removed`, the `redirect` record, the commit sha, and the honest
   `production.live_until_release: true`.
3. Verified the commit ITSELF (`0e73764b`): one atomic change, `D` on
   `sites/fernwell/data/site/pages/page_drill_retire.json` and `A` on
   `sites/fernwell/data/site/redirects.json`. The export leaves and the
   forwarding rule arrives together — there is no window in which the URL 404s,
   which is the whole point of ruling 3.
4. `release_to_production` → deploy ready on that commit.
5. **Reader check:** `GET /drill-retire` → **301 → `/`**, following it lands
   200 on the Fernwell home page. Wolf's "we can't lose readers" holds in
   production, not just in a test.
6. **Store check:** the record is `status: archived` with `retire` as its last
   history action — recoverable for the 30-day grace window, exactly as ruled.
7. **404 check:** a URL that never existed (`/no-such-page-xyz`) returns 404
   **with** the alternatives block ("Try one of these instead") built from
   Fernwell's own navigation.

**One honest discrepancy, recorded rather than quietly fixed:** during design I
said archived objects would be hidden from `object_inventory` by default; that
change was never implemented, so `page_drill_retire` still appears in the
inventory listing (carrying `status: archived`). On reflection the current
behavior is arguably better — during the 30-day window an operator can SEE what
is pending purge and restore it — so it stands, but as a deliberate choice now
rather than an unnoticed gap.

The drill artifacts are left in place on Fernwell as the live demonstration: the
`/drill-retire` → `/` redirect is permanent by design, and the archived record
ages out on the first `purge_archived` run past 30 days.

## Session 2026-07-27 (F6 CLOSED — governed removal exists: retire → redirect → purge)

**The last open V1 finding is built.** There was no front-door removal at all:
an agent's mistaken `object_create` was permanent, and the T14.5 probe pages had
to be deleted through the Netlify Blobs back door. Wolf's rulings shaped it —
(1) archive, then hard-delete after thirty days, since "anything can be
recreated again"; (2) "retired means gone after a release"; (3) "this is dtc
sales and publishing … we can't lose readers" → always redirect, and even the
default 404 offers alternatives.

**What shipped, in five parts:**

1. **Export deletion in the committer.** It could only add and update, which is
   precisely why unpublish was deferred (`object-publish.ts` says so in its own
   header). `commitMaterializedFiles` now takes `deletions` (GitHub tree entries
   with `sha: null`); a deletions-only commit is valid, and deleting an absent
   path is a no-op so a retried retire converges.
2. **`object_retire`.** Archives the record (body + history intact, status index
   moves active → archived), REMOVES the committed export in the same commit —
   pages render from exports, not the store, so archiving alone would leave the
   page serving traffic — and writes the 301 for its route in that same commit,
   so the URL never has a 404 window. Refusals, decided and recorded (R8):
   still-referenced (referrers named — the symmetric edge of the genesis order
   law), open review, the site singleton, and no lock. Ordering is reader-safe:
   the record archives only AFTER the export is gone.
3. **`_redirects` emission.** A build-done integration writes the table into the
   publish directory. Not an Astro route: `build.format: 'directory'` would land
   `/_redirects` as `_redirects/index.html` and Netlify would never read it.
   netlify.toml keeps precedence, so infrastructure routing wins and content
   forwarding fills in behind it.
4. **404 alternatives.** `PageObjectRenderer` appends a suggestions block on the
   page whose route is `/404`, built from the site's OWN published header
   navigation — per-tenant by construction, no hardcoded fleet copy (the mistake
   F3 caught). Applies to all three live sites without touching their scaffolded
   `404.astro`.
5. **`purge_archived`.** Owner-only sweep, 30-day grace, `dry_run` preview.
   Deliberately a sweep rather than a per-object delete: "delete this one now"
   would be an irreversible button with no waiting period, which is the whole
   point of the grace window. It never touches git — the export is already gone
   and the redirect must outlive the record.

**Found and fixed en route: the opt-in suite was genuinely flaky** (~50% of runs,
a different artifact test each time, always "same size, different content" at one
key). Under `node --test` each file gets its own process but shares the working
directory, so files that did not isolate the local blob store clobbered each
other. The default root is now pid-scoped under the test runner. This mattered
because F8 had put that suite INTO CI, and a gate that fails half the time
trains people to ignore it. Three consecutive green runs where the same code
failed run-over-run before.

**Verified:** 12 new behavioral tests (deletion primitive ×5, retire ×8 covering
all three rulings and every refusal, purge ×4); a real build emitting
`/old-offer  /offers  301` into `dist/_redirects`; the 404 rendering
alternatives while the home page does not. Gates: 1731 core + 89 script, opt-in
1328, eslint + prettier clean.

**V1 finding list is now clear** except the two explicit wontfix-v1 items (F5
behavior, F7 version drift) and post-v1 per-agent keys.

## Session 2026-07-27 (F3 investigated — half of it was MY OWN measurement error; the real defects fixed)

**The "empty footer" was never a site bug — it was an artifact of the agent's
screenshot tool.** The automated browser tab runs with
`document.visibilityState === "hidden"`, and I measured **zero `requestAnimationFrame`
ticks in 800 ms** in it. The shell's intersect Observer sets `no-intersect` on every
animated element at start and only removes it inside a `requestAnimationFrame`
callback, so with no frames: the attribute is never cleared, `motion-safe:md:opacity-0`
holds, and the footer photographs blank. A **fresh IntersectionObserver on the same
element also never fired**, confirming it is frame-lifecycle starvation, not page code.
Rendering the same build in a real browser (Playwright, `visibilityState: "visible"`)
gives `no-intersect: false`, `opacity: 1`, full footer text — on a SHORT,
non-scrollable page, which was the supposed trigger. Dr-Lurié only ever looked
"fine" in the automated browser because I scrolled it, and scrolling forces a frame.

**Lesson recorded: never file a rendering defect from an automated screenshot alone.**
Verify visual findings in a frame-ticking context (the local Playwright render against
a locally-served `dist` is the cheap, offline way — external fetches are blocked here).

**What the honest render DID expose — two real defects, both fleet-law, both fixed:**

1. **A client literal shipped in core.** `packages/core/app/components/widgets/Footer.astro`
   hard-defaulted `descriptor` to Dr-Lurié's line ("Science-led education for aging
   skin changes…"), so EVERY site without its own `nav_footer.brand.descriptor`
   rendered Dr-Lurié's skincare copy in its footer — platform and fernwell both did.
   Resolution is now `brand.descriptor` → this site's `metadataDefaults.description`
   → empty. No client literal in fleet law. (The zero-drlurie lint missed it because
   it is prose, not the token `drlurie` — worth extending that lint later.)
2. **A titleless nav group rendered as an unlabelled dropdown.** Header draws any
   entry carrying `links` as a dropdown; a group with items but no `title` produced a
   bare chevron with its links trapped inside — and every `create-site` scaffold ships
   exactly that shape (one titleless `g_primary` holding "Home"). `navigationToHeaderProps`
   now flattens titleless groups to TOP-LEVEL links. Groups WITH a title are untouched,
   which is every group Dr-Lurié has, so its header is unchanged (its byte-identity
   adapter tests still pass).

**Verified in a real browser after the fix:** platform's header shows "Home" as a
top-level link (`headerHasEmptyDropdown: false`) and the footer reads "Platform — a
starter site, ready for real content." Two regression tests pin both halves. Gates:
1714 core (+2) + 89 script, opt-in 1311, eslint + prettier clean.

## Session 2026-07-27 (Identity fixed fleet-wide; the "all three sites rebuild" question answered)

**Wolf reported admin login failing on BOTH platform and fernwell.** Identity was
enabled and `/.netlify/identity/settings` answered 200 on all three sites, so the
fault was not the service. Two distinct causes, found by reading the actual user
records:

1. **No usable account.** `platform` had ONE user — `invited_at` set,
   `confirmed_at: null`: a PENDING invite from 2026-07-26 that was never
   accepted, so no password and no account. `fernwell` had **zero** users. An
   Identity-enabled site with no confirmed user rejects every login and looks
   exactly like "Identity is broken."
2. **Google was not enabled on the new sites.** Dr-Lurié's working login is the
   **google** provider (`app_metadata.provider: "google"`); platform and fernwell
   had `email` only. The shell's LoginModal always renders a "Continue with
   Google" button, so clicking it on those sites could only fail — the provider
   was off at the Netlify end.

**Fixed:** Google enabled on platform AND fernwell via API, matching Dr-Lurié
(which uses Netlify's shared Google OAuth app — `client_id`/`secret` empty, so
nothing to provision). All three now report
`external: {google: true, email: true}`. Combined with `ADMIN_EMAILS` (the
bootstrap-Owner fallback, set to Wolf on both), a first Google sign-in lands as
Owner with no per-user role write. **No user data was deleted** — the stale
pending invite on platform is left in place; GoTrue links the Google identity to
that address on sign-in.

**API gotcha worth remembering:** enabling an external provider takes a
**top-level** `{"external":{"google":{"enabled":true}}}` on
`PUT /sites/{id}/identity/{instance_id}`. The `config`-nested form returns 204
and silently does not persist — it cost several confused round-trips. Always
re-read the instance to confirm, never trust the 204.

**Why every merge builds all three sites (and why platform said "Canceled").**
All three Netlify projects are linked to the SAME repo and branch
(`vreich-ui/platform` @ `main`) with **no build filter**, so one merge triggers
three builds — expected for a monorepo with per-site projects. Platform's showed
`Canceled build due to no content change`: Netlify's optimization when a build's
output is byte-identical to the live deploy. It reports in the `error` slot but
is **not a failure** — the existing deploy stays live and correct. Dr-Lurié and
fernwell published because their output did differ.

**Decision (R8): not adding per-site `ignore` build filters.** They would cut
redundant builds, but an ignore expression that is even slightly wrong makes a
site silently NOT rebuild when core changes — strictly worse than a redundant
build that cancels itself in ~30s. Revisit only if build minutes become a real
constraint; the shape would be
`git diff --quiet $CACHED_COMMIT_REF $COMMIT_REF -- packages/core sites/<client> package.json package-lock.json`.

## Session 2026-07-27 (T14.9 CLOSED — Fernwell is LIVE; genesis is now a committed driver, not hand-driven)

**The third site is real.** `kugel-fernwell` renders from store objects, serves
`/admin`, and answers `/mcp` as `Fernwell_MCP`. Twelve objects born through the
front door, all published, released, and rendering.

**Timings — the V1 "cost of a new client" baseline:**

| Phase                                                 | Cost                                           |
| ----------------------------------------------------- | ---------------------------------------------- |
| Agent: scaffold + rebrand + lockfile + verify         | ~3.5 min                                       |
| Agent: Netlify provisioning (site + auto-secrets)     | ~1 min                                         |
| Agent: env (17 vars), repo link, build hook, Identity | ~4 min, ALL via API                            |
| Agent: genesis drive (12 objects create→publish)      | ~2 min                                         |
| Agent: MCP round-trip + release + verify              | ~3 min                                         |
| **Wolf**                                              | **merging patches only — zero console clicks** |

**Everything account-authority was done via API this run**, including the two
steps T14.3 recorded as UI-only: the **repo link** (`PATCH /sites/{id}` with
`build_settings.repo`, reusing installation id 95173329) and **Identity**
(`POST /sites/{id}/identity` → 201). The T14.3 checklist's "the API cannot do
this" claim is superseded — see the manual-steps note below.

**NEW: `scripts/site-genesis-drive.mjs` — genesis is fleet law now.** Platform's
genesis was hand-driven with ad-hoc MCP calls; that was the single largest manual
cost of a new client and it is gone. The driver reads a scaffolded site's seed
modules + bootstrap page exports, and creates → publishes → checks in each object
in dependency order (navs → site → taxonomy → theme → recipes → pages), then
releases once. Idempotent (re-runnable after a partial failure), `--dry-run`
prints the plan, `--no-release` defers the deploy.

**Three defects found and fixed by actually birthing a site** (each would have
hit every future client):

1. **First build downloads the wrong astro.** On a cold cache Netlify does not
   install the monorepo root, so `npx astro` silently fetched astro@6, which
   rejects NODE_VERSION 20. Per-site build command now self-heals the workspace
   install and uses `--no-install` so a missing binary fails loudly. (Merged
   separately; every existing site had the same latent cold-start failure.)
2. **The bootstrap `page_home` was unpublishable.** create-site emitted `<code>`
   and a root-relative `/admin` link — both rejected by the RichText allowlist —
   so a new client's home page 422'd at creation. Template now emits allowlisted
   markup and an absolute host link.
3. **`canonicalHost` drifts when the bare subdomain is taken.** `fernwell.netlify.app`
   was taken (project is `kugel-fernwell`), but the scaffold hard-defaults
   canonicalHost to `<slug>.netlify.app`. Corrected across config/seed/config.yaml
   and patched live on the site singleton through MCP.

**Round-trip proof (live):** `object_checkout` → `object_patch`
(`set_site_fields`, canonicalHost) → `object_publish` (export commit `b7c8792`)
→ `object_checkin`, lock released. `release_to_production` confirmed production
on that commit. **Fleet CI now discovers THREE sites**
(`{"sites":["drlurie","fernwell","platform"]}`). **Tenant isolation verified:**
platform and drlurie unchanged and serving throughout.

T14.9's remaining optional half is retirement (delete the project + tree) — Wolf's
to trigger; Fernwell stays up for feature testing.

## Session 2026-07-27 (T14.10 — V1 CLOSE-OUT) — the W14 wave, declared

**V1 is declared.** The project crosses the line as a white-label agentic
publishing fleet: `packages/core` is the one engine + app shell (fleet law);
each client is data + bindings + its own Netlify project + its own `/mcp` over
that core; a new client is scaffolded + provisioned in ~5–6 min of agent time
(T14.9), and the fleet CI matrix builds every site on every core change.

**W14 wave summary:**

- **T14.0–T14.3** — admin-login fix, app-shell extraction into core, platform
  genesis, and the platform Netlify project born + repo renamed to `platform`.
- **T14.4** — fleet propagation proven: two live tenants on one core, the
  two-site CI matrix green (Wolf-confirmed).
- **T14.5** — the platform site documents itself: 15 contract-generated manual
  pages through its own `/mcp`, drift-guarded.
- **T14.6** — live test plan on both sites → `w14-findings.md` (F1–F8).
- **T14.7** — fix wave: F2 (artifact-upload v2 export), F4 (reader-safety scope),
  F5 (publish-lock contract documented), F8 (opt-in suite compiles + in CI).
- **T14.8** — MCP auth fails closed in production (F1 code half); per-agent keys
  deferred post-v1 on Wolf's ruling (shared key, now fail-closed, is the v1 path).
- **T14.9** — synthetic third site (Fernwell) scaffolded + provisioned + building;
  live runtime proof pending Wolf's account sitting.
- **T14.10** — this: `13-separation-plan.md` (per-client repo/domain split,
  design only), CLAUDE.md platform framing + R8 verbatim, this V1 declaration,
  doc-path sweep.

**Honest wontfix-v1 / deferred list (nothing hidden):**

- **Per-agent MCP keys** — deferred post-v1; the shared `MCP_HTTP_AUTH_TOKEN`
  (fail-closed) is the v1 auth path. Unblock is a mint UI (design recorded, T14.8).
- **F3 platform chrome** (bare header/footer, unstyled prose links) — cosmetic on
  a placeholder site; dedicated chrome pass, root cause recorded.
- **F6 governed retire/delete verb** — real fleet-law surface; own task. The
  `archived` status infra is half-present.
- **F7 get↔patch version drift** — the eventual-consistency constraint; mitigated
  by read-version-under-lock-and-retry; the lock-library / strong-read upgrade is
  the real remedy, tracked.
- **T14.9 runtime proof** (genesis round-trip on the 3rd LIVE site) — awaits
  Wolf's account-authority sitting (fleet secrets, repo binding, Identity).
- **PUBLISH_SECRET rotation** — ignored per Wolf (2026-07-26).

**Doc-path sweep (fix or annotate, per the brief):**

- `cms-pipeline/README.md` cron example path → `platform` (fixed).
- `docs/agents/publishing-policy.md` `Dr-Lurie-Blog` refs — historical
  provenance citations (the repo's name when the policy was derived at PR #463);
  the bare string is NOT the scanner-triggering `owner/name`, so harmless to the
  build. Left as provenance; annotate if the doc is revised.
- `src/chatkit/widgets/…` — **dead path** (no importers found). Annotated here for
  removal in a separate verified deletion commit, not deleted in this docs-only
  close-out (deletion needs its own importer-verified change per CLAUDE.md).

**V1.** Post-v1 queue = the W12/W13 rows (learning, optimization) + the deferred
list above. Committed `T14.10: …` (docs only); no PR.

## Session 2026-07-27 (T14.9 — third site scaffolded, provisioned, and building; live bring-up is the human gate)

**The repeatability proof, agent half.** Invented a synthetic third client —
**Fernwell**, a houseplant-care editorial brand with its own botanical palette
(deep green / terracotta, distinct from Dr-Lurié's skincare tones) — and took it
as far as the account-authority boundary allows, timed:

- **Agent prep — scaffold + brand + lockfile + verify: ~3.5 min** (06:56:14 →
  06:59:41Z). `create-site --name fernwell` wrote all 68 files; the site
  singleton seed rebranded (name/palette/metadata); `@fleet/site-fernwell` added
  to `package-lock.json`; `npm test` green (1712 core + 89 script — the scaffold
  type-checks and its seed bodies parse).
- **Agent provisioning — Netlify site + auto-secrets: ~1 min** (06:59:57Z). The
  bare subdomain `fernwell.netlify.app` was taken, so the project is
  **`kugel-fernwell`** (id `03ec1db7-ba8b-4a10-8045-c981e89833a9`,
  `https://kugel-fernwell.netlify.app`) — same `kugel-` fallback platform used.
  The four auto-mintable secrets (`PUBLISH_SECRET`, `MCP_HTTP_AUTH_TOKEN`,
  `ARTIFACT_UPLOAD_TOKEN_SECRET`, `TRACKING_SALT`) + `NETLIFY_SITE_ID` are set.
  The 8 blob-store probes 401'd — the known site-create-token scope gap (T14.3
  #3), non-functional: stores create on first write.
- **Build verified:** `astro build --config sites/fernwell/astro.config.ts`
  builds 12 pages clean, so committing `sites/fernwell/` gives the **three-site
  fleet-build proof automatically on merge** (the CI matrix discovers
  `sites/*/site.config.ts`); platform + drlurie untouched.

**Total agent hands-on for a new client: ~5–6 min** — the V1 "cost of a new
client" baseline, agent side.

**The human residual (Wolf's measured cost — the account-authority steps the
brief scopes to him), NOT executed here:**

- **Fleet-shared secrets** — `GITHUB_CONTENT_TOKEN`, `NETLIFY_AUTH_TOKEN`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PDF_TOOL_STORAGE_SITE_ID`/`_TOKEN`:
  the account env API now **masks** secret reads (returns a 20-char placeholder,
  not the real value), so copying them agent-side would set garbage. Secret
  custody stays Wolf's — reuse the fleet values in the Netlify UI.
- **Repo binding** — `GITHUB_REPOSITORY` (same monorepo), `GITHUB_BRANCH=main`,
  committer name/email, `SECRETS_SCAN_OMIT_KEYS=GITHUB_REPOSITORY`; **link the
  repo to `kugel-fernwell` with base directory `sites/fernwell`**.
- **Identity** — enable Netlify Identity, set `IDENTITY_URL` +
  `ADMIN_EMAILS`/`ROLE_EMAILS_*`.
- **`NETLIFY_BUILD_HOOK_URL`** — create a build hook, paste it.

Once those are set, the agent runs the **seed drive + MCP round-trip** (the
runtime proof) and records the final timing. Retirement (delete the
`kugel-fernwell` Netlify project + `sites/fernwell/`) is Wolf's to trigger — the
agent can't hard-delete infrastructure — and is itself the tenant-removal proof.
Committed the scaffold on `claude/w14-t14-9` (stacked on T14.8); no PR.

## Session 2026-07-27 (T14.8 — F1 hardening landed; per-agent-key rollout is Owner/tooling-gated)

**F1 closed at the code level (committed).** `getAuthResult` (`mcp.ts`) now
fails CLOSED on an unset `MCP_HTTP_AUTH_TOKEN` in a production lambda runtime —
open only in non-lambda dev/test. Combined with the token now SET on
drluriescience (dormant until its next deploy), Dr-Lurié's `/mcp` closes on
that deploy and no future site can be born wide open. Regression test added
(unset+lambda → 401 `mcp_auth_missing_token`); suite green (1712/89/1309).

**Per-agent keys: WOLF RULED "ship v1 on the shared key" (2026-07-27).** The
attribution half of T14.8 is deferred post-v1. `agent_keys_create` is Owner-only
on `admin-governance` with **no client/UI surface** (nothing in the admin kit
calls it), so minting isn't reachable by the agent (no Owner JWT) or Wolf (no
button) without ad-hoc work; rather than build an agent-keys admin panel for v1,
the shared `MCP_HTTP_AUTH_TOKEN` — now fail-closed on both sites — is the v1 auth
path. Attribution stays at shared-key level for v1. Post-v1 unblock (recorded,
not built): a minimal Owner-gated agent-keys panel (list/create/revoke, the
`AdminUsers.tsx` pattern) + connector repointing. The T11.10 mint mechanism
(`createAgentKey`) already exists; only the surface is missing.

**Other T14.8 steps:**

- **Connector repointing (step 2)** — N/A for v1 (single shared key per site;
  no per-agent connections to repoint).
- **PUBLISH_SECRET rotation (step 4)** — Wolf ruled "ignore it" (2026-07-26).
  Recorded; not performed. The brief's "do not park it again" is superseded by
  that explicit ruling.
- **Credential note (step 5)** — the shared key is the v1 auth path (not a
  deprecated fallback); the manual credential note rides the next
  `platform-manual-drive.mjs` change (editing a manual page outside the driver
  breaks its drift guard).

Net: T14.8 lands as the fail-closed hardening (done, deploy-safe) with per-agent
attribution deferred post-v1 per Wolf. T14.9 proceeds on the shared-key model.

## Session 2026-07-26 (T14.7 — fix wave; findings log fully dispositioned)

Worked `w14-findings.md` by severity. Every finding is now accounted for
(disposition table at the top of that file):

- **FIXED + verified (4):** F2 (create-site emits the right export form per
  function generation — the v2 artifact-upload shim 502'd at init; commit
  `de89b79`), F4 (reader-safety scan stops blocking `private`/`strategy` in
  ordinary prose; `431186d`), F5 (publish deliberately keeps the lock — a
  pinned-test contract, not a bug; documented it + told callers to checkin;
  `3f5965f`), F8 (opt-in netlify suite compiles again — two real type holes —
  and is now gated in CI so it can't rot; `09fb09d`).
- **F1 (CRITICAL) → T14.8.** The fix is one line (fail-closed on an undefined
  `MCP_HTTP_AUTH_TOKEN` in a lambda), but landing it CLOSES Dr-Lurié's live
  `/mcp` on deploy, breaking any connector currently sending no token. That must
  land in lockstep with setting Dr-Lurié's token and updating its connector's
  bearer — exactly T14.8's per-site-key scope. Highest priority; flagged to Wolf,
  not silently changed.
- **F3 (platform chrome) → dedicated pass.** Root-caused (header Logo renders
  empty though the site object carries `logo.text`; footer content present but
  unrendered; prose link/list typography missing). Cosmetic on a placeholder
  site; needs live Astro-build debugging. A speculative nav-brand seed change was
  tried and reverted — the header wordmark reads `site.logo.text` via Logo.astro,
  not the header nav's brand.
- **F6 (no delete verb) → dedicated verb task.** A governed
  `object_retire`/delete is real fleet-law surface (archive-vs-hard-delete,
  restore, live-export interaction, review-state, inventory default) that should
  be designed, not rushed. The `archived` status infra is half-present already.
  Not wontfix — worth doing in its own change.
- **F7 (get↔patch version drift) → wontfix-v1.** The documented eventual-
  consistency constraint; mitigation is read-version-under-lock-and-retry (the
  T14.5 driver does this). The lock-library / strong-read upgrade is already
  tracked.

Gates green throughout: 1711 core + 89 script, opt-in 1304, eslint + prettier
clean. One commit per cluster; no PR. Discovered en route: the sandbox's global
`tsc` is 6.0.3 (stricter, phantom errors) while the project pins 5.8.3 — always
use `node_modules/.bin/tsc` / `npm test` for accurate results.

## Session 2026-07-26 (T14.6 — test plan executed live on both sites; findings log committed)

Full findings log: **`w14-findings.md`** (this directory). Ran the authz
matrix, MCP connectivity/parity, layout audit, and agent E2E against both
production sites. Headline results:

- **F1 CRITICAL — Dr-Lurié's `/mcp` is fully unauthenticated.** No key and a
  wrong key both return 200 with production data, and the mutating path is
  reachable (an anonymous `object_checkout` reaches a real 404 lookup). Cause:
  `MCP_HTTP_AUTH_TOKEN` is unset on `drluriescience`, and the gate
  (`mcp.ts` ~L1938) **fails OPEN** on `undefined`. Platform is correctly gated
  (token set → 401 for wrong/no key, both `tools/list` and `tools/call`). The
  fix is T14.8's per-site keys pulled forward, PLUS making the gate fail closed
  in a lambda runtime. Closing it on Dr-Lurié needs its live connector's bearer
  set in lockstep — flagged to Wolf, not silently changed.
- **F2 HIGH — every create-site client's `artifact-upload` is dead at init.**
  It is a Netlify v2 function (`export const config = { path }`) needing
  `export default`, but the generated `functionShimTemplate` emits
  `export const handler`. Platform 502s on every request incl. GET; Dr-Lurié's
  hand shim (`export default`) works. T14.7 fix in `create-site.mjs`.
- **F3–F8** (medium/low): platform chrome renders bare vs Dr-Lurié (invisible
  brand, empty footer, unstyled prose links/bullets); the reader-safety scan
  over-blocks the words "private"/"strategy" in all page prose fleet-wide;
  publish/discard don't release the lock; no governed delete verb; get↔patch
  version drift under eventual reads; the `tests/netlify` opt-in suite doesn't
  compile on main (CI never runs it).

**Confirmed GOOD:** MCP tool parity (platform 50/0-legacy, Dr-Lurié 62/12);
platform `/mcp` and all non-MCP admin/object functions deny-by-default on both
sites; legacy trio isolated (404 on platform, gated on Dr-Lurié); the T14.5
drive stands as the platform agent E2E.

**Gated (need Wolf's Identity login or a harness):** authenticated `/admin`
screens both sites (the login GATE renders correctly — T14.0 fix live),
governance-toggle flip/revert, per-agent key mint→use→revoke (T14.8),
mobile-viewport audit (cloud browser is fixed-canvas). T14.7 is scoped from F2–F8;
F1 goes to T14.8 (and wants doing sooner). No code changed this task.

## Session 2026-07-26 (T14.5 SHIPPED — the manual IS the product; T14.4 CLOSED on Wolf's CI confirmation)

**T14.4 is closed.** Wolf confirmed all checks GREEN on the merged PRs
(#474–#477) — that was the last outstanding proof: the first live TWO-SITE
`discover-fleet` matrix run through Actions, both sites building from one
core change. With the platform MCP round-trip (this phase, live), the
informational build-diff on Dr-Lurie (reviewed, no unintended change), and
the refs recorded here, all four T14.4 proofs stand. PUBLISH_SECRET rotation:
Wolf ruled "ignore it" — recorded, nothing rotated.

**T14.5 — the platform site now documents itself through its own front
door.** Fifteen `page` objects on `site_platform`: `/manual` (index),
`/manual/lifecycle`, `/manual/roles`, `/manual/genesis`, and one reference
page per governed type (×11). The reference half of every type page is
GENERATED from that type's live `object_contract` — fields, patch ops,
lifecycle verbs, publish policy — never hand-typed. Driver:
`scripts/platform-manual-drive.mjs` (create/update/publish through `/mcp`;
`--check` regenerates from the live contracts and diffs — ran CLEAN 15/15).
All fifteen published + released; verified rendering live (index, lifecycle,
genesis, content-item spot-checked 200 with correct copy). `page_home` also
patched live via `set_page_meta` — title `Platform — home` +
`navigationOverrides.footer` — publish green (the `structure_home_footer`
422 is gone), and the fix is now BORN into every future site:
`create-site`'s `bootstrapHomePageExport` carries the footer override, the
committed platform stub matches, and the genesis e2e pins it.

**What the drive surfaced (T14.6 seeds, each hit for real):**

1. **Reader-safety keyword overreach.** `assertReaderSafe` forbids the
   literal words `private` and `strategy` (word-boundary, case-insensitive)
   in ALL page prose, fleet-wide — the content_item manual intro could not
   say "private strategy metadata" about its own model. Reworded here, but
   the real finding is that no site can publish ordinary copy containing
   "strategy" on any page. Weigh scoping the scan to article projections.
2. **Publish does NOT release the lock** (and neither does discard — both
   observed). All 13 pages from pass one were still locked a full lease
   later; the driver now calls `object_checkin` after publish. Lock hygiene
   needs a ruling: should publish auto-checkin?
3. **No deletion verb exists.** Three probe pages made during 422 bisection
   could not be removed through the front door at all — removed via the
   Blobs API back door (API store name is `site:site-objects`, literal key
   paths, fleet token). An agent mistake is otherwise PERMANENT. The store
   needs a governed retire/delete verb.
4. **Version drift between `object_get` and patch** under eventual reads —
   first patch attempt hit "Record version conflict" with a fresh get;
   retry-under-lock with a re-get succeeded. Known consistency constraint,
   now with a live reproduction.
5. **`tests/netlify` opt-in suite does not COMPILE on main** (pre-existing,
   verified on a clean tree: `admin-blob-manager.ts` + `blob-admin.ts` tsc
   errors). CI never runs it, so it rotted. Fix or gate in T14.7.

The 422 itself was diagnosed by reading the FULL structured `validation`
array off the raw RPC response — the driver's 180-char error truncation had
hidden the `reader_safety` criterion entirely.

Gates: 1706/1706 core, 89/89 scripts, genesis e2e green, eslint + prettier
clean; acme fixture regenerated (byte-identical — the dry-run plan lists
filenames, not contents). Committed `T14.5: …`; no PR.

## Session 2026-07-26 (GENESIS SOLVED — the cycle was a mirage; the real defect was a silent test-store fallback in production)

**Supersedes the "genesis is circular" reading in the T14.4 entry below.** It
is not circular. The order navs → site works and is now pinned by an e2e test.
What actually happened, unraveled live with a debugging loop this session
gained (netlify-cli direct deploys to `kugel-platform` — the platform site
doing its staging job for the first time):

**Root cause.** Blob runtime detection keys on `NETLIFY_SITE_ID`, which the
provisioning run never set — it sat on the BY-HAND checklist even though
`create-site` knows the id it just created. Detection failed → core silently
fell back to the FILE-BACKED TEST STORE inside the production lambda. Reads
degrade gracefully there (empty dir → empty list), writes die on the read-only
`/var/task`. Hence the exact live symptoms: inventory `[]`, `site` create
reaching validation and 422ing on refs that "didn't exist" (in a store that was
really the empty local fallback), nav/page creates 500ing at the first write.
The type-specific pattern was pure coincidence of WHERE each verb first writes.

**Four fixes, all committed:**

1. **Fail closed.** In a lambda runtime (`LAMBDA_TASK_ROOT`/
   `AWS_LAMBDA_FUNCTION_NAME`), blob-store now THROWS instead of falling back
   to the test store. A detection failure must be loud. Unit-tested both ways.
2. **`create-site` auto-sets `NETLIFY_SITE_ID`** during provisioning — it is
   the id of the site the run just created; it was never a human value.
   Checklist row rewritten.
3. **Diagnostic 500s** on the object-store path (sanitized message + top
   in-repo frame). This is the fix that cracked the case — the first
   diagnostic deploy returned `ENOENT mkdir /var/task/.netlify` and the whole
   mystery collapsed.
4. **Genesis e2e** (`site-genesis.e2e.test.ts`): EMPTY store → nav_header →
   nav_footer → site → page through the MCP handler, all green, plus the
   negative pin (site BEFORE navs correctly refuses). The order is law now.

**Live result:** the platform store holds 12 objects created through the front
door — site_platform, both navs, page_home, page_404, tax_platform,
thm_platform_default, the 5 starter recipes. Checkout → patch → checkin
round-tripped live on page_home. Publish reaches structured validation; the
full publish→release drive waits on `GITHUB_CONTENT_TOKEN` (export commits
need it) — first move of the next sitting.

**A second latent defect, found, tried, and honestly reverted:** the
name-lookup blob path silently DROPS the requested `consistency: 'strong'` —
for the whole fleet, Dr-Lurie included, since W-forever. Passing it through
fails live ("environment has not been configured" — the lambda context carries
no uncached-edge URL), so strong reads exist only on the explicit-API path
(blobs-scoped token). Reverted to the string lookup with the constraint
documented at the call site. CONSEQUENCE: read-after-write can lag tens of
seconds on every store; genesis drives wait-and-retry between dependent
creates (mine did); a blobs-scoped `NETLIFY_BLOBS_TOKEN` per site is the
upgrade path if strong consistency is ever needed. T14.6 should weigh the
lock library against this.

Gates: 1706/1706 core tests (4 new), 89/89 script tests, eslint + prettier
clean, both sites build.

## Session 2026-07-26 (T14.4 in progress — two live MCP endpoints on one core; two real defects found)

**The core architectural claim is demonstrated.** `kugel-platform` serves its
own `/mcp`, auth-gated, identifying as `Platform_MCP`; `drluriescience` serves
its own, unchanged. Two isolated tenants, one canonical engine, separate keys
and separate stores. `object_inventory` on platform returns cleanly from its own
blob stores — which also settles the earlier worry: the pre-flight blob probe's
401 was a token-scope artifact, and a site's own functions provision their
stores on first use exactly as predicted.

**Defect 1 — found and FIXED (committed).** The T14.3 decoupling injected the
legacy article HANDLERS per site but left the tool DECLARATIONS static, so
platform advertised all twelve legacy `save_json_blob_*` / `verify_article_images`
tools and would have thrown on any call. Listing a tool an agent cannot call is
worse than omitting it — the agent plans around it and fails mid-run.
`tools/list` now reports `visibleToolDefinitions()`: unchanged for a site WITH
the legacy path, legacy-free everywhere else. Guard test pins both halves and
refuses to let the omitted set grow past the legacy surface. This is exactly
what the live proof is for; no offline test would have caught it.

**Defect 2 — found, NOT fixed, and it blocks the seed drive.** A brand-new
site cannot be seeded through the front door:

- every non-`site` `object_create` returns an opaque **500** against an empty
  store (`navigation`, `page` — with or without `requested_id`/`agent_name`),
  while `site` reaches validation normally. The type-specific difference points
  at owning-site resolution running before the site record exists;
- and `site` itself fails 422 on **reference integrity**:
  `defaultNavigation.header/footer` must resolve to existing navigation objects.

So site needs nav, nav needs site. **Genesis is circular**, and no committed
driver breaks the cycle. Dr-Lurie predates the current validation and never hit
it. This is squarely T14.9's "cost of a new client" — a client cannot actually
be born through the documented path today — and it is the next thing to fix.
The likely shape: reference integrity is a PUBLISH-time criterion, not a
CREATE-time one, so a site can be created with dangling default-nav refs and
refuse to publish until they resolve. That is a validation-engine decision and
wants its own task, not a patch tacked onto this one.

The opaque 500 is a second-order problem worth fixing alongside: the object
verb path swallowed the real cause and returned "Object request could not be
processed", which cost the whole debugging loop.

**Proofs 2–4 of T14.4 (fleet CI over two sites, Dr-Lurie no-unintended-change,
recorded refs) are unblocked and not yet run** — they do not depend on the seed
drive.

## Session 2026-07-26 (mcp.ts decoupled — the MCP server is fleet law; platform gets its own endpoint)

Wolf sanctioned the bounded exception. The server now lives at
`packages/core/server/functions/mcp.ts` and each site owns its `/mcp` endpoint.
Dr-Lurie's tool behavior is unchanged; the tool BODIES were not touched.

**The plan's premise was wrong, and the correction is the interesting part.**
The pre-work read said `mcp.ts` had exactly one coupling — the
`sites/drlurie/config/policy-bindings` import — so the fix was "delete a line
and move the file". That was true of the _obvious_ coupling and missed the
structural one: **`mcp.ts` is a COMPOSITE.** It statically imports the
`handler` of six sibling functions and invokes them in-process:

| Sibling                                                      | What it is                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `save-artifact`, `object-store`, `deploy-status`             | per-site SHIMS, already bound to a SiteBinding                     |
| `save-json-blob`, `publish-article`, `verify-article-images` | the FROZEN legacy article path — Dr-Lurie's, repo-root, off-limits |

A file move alone would have re-pointed the first three at the core factories
(unbound) and made core import the second three (the legacy dialect, into fleet
law). Both wrong. So the decoupling is **dependency injection, not relocation**:
`configureMcp()` is the seam, each site's shim registers its own bindings,
builds the governed trio from the core factories with ITS binding, and passes
them in.

**The legacy trio is OPTIONAL, and that is the load-bearing decision.** A client
born after the object substrate injects nothing for it; the tools that need it
throw a clear "this site has no legacy article path — articles here are
content_item objects" rather than existing and half-working. This is Wolf's
2026-07-13 ruling made structural: reverse support is not required, and the
legacy dialect does not propagate to the fleet. It is also what protects the
future learning layer — every client exposes the same governed contract, so
workflow experience transfers; only Dr-Lurie carries the extra pre-object
surface, and it dies with the legacy path.

**Fails closed.** Importing the module without `configureMcp` throws. A silent
fallback to another tenant's handlers is the one outcome worse than a crash.

`create-site` special-cases the mcp shim (it is not a plain
`createHandler(siteBinding)` factory) and generates the legacy-free version for
every new client — so a third site's `/mcp` is born working, with no manual
step.

Also de-sited, because the file is fleet law now and the zero-drlurie lint
correctly refused it: nine example ids in tool descriptions
(`req_publish_drlurie_…` → `req_publish_launch_…`, `site_drlurie` → `site_acme`)
and one user-visible sentence in the pdf-tool grant description that named the
client's blob stores. Verified first that the test suite uses those strings as
input fixtures for format validation, not as pinned description text.

Gates: both sites build; 1699/1699 core tests; 89/89 script tests; eslint +
prettier clean; zero-drlurie lint green over the newly-arrived 4,500-line file.

**Netlify, same session — all three "Wolf-only" items turned out to be mine.**
`kugel-platform` is linked to the repo (the Netlify GitHub App was already
authorized for the account, so its installation id was reusable via the API — no
UI handshake), Identity is enabled, base directory `sites/platform`, and the
first build went READY. `/` and `/admin` return 200. `/mcp` returned 404 — this
commit is what fixes it, on the next deploy. The blob-probe token scope stayed
unresolved and stayed irrelevant: the stores provision on first write from the
site's own functions.

**Next in queue:** T14.4 (fleet propagation proof) — now genuinely unblocked.

## Session 2026-07-26 (T14.3 PREP — agent side complete; HALTED at the account-authority gate)

`human_gate` mode: prepared in full, not completed. Nothing here is titled
`T14.3:` — the task is not done. The instantiated checklist is
`cms-pipeline/T14.3-checklist.md`; it is the only thing Wolf needs to read.

**Prepared (committed):**

- **Per-site Netlify function shims.** Every core server function is a factory
  over a `SiteBinding`, so the file that instantiates it is per-site by
  definition — and Netlify resolves `functions.directory` against a project's
  BASE DIRECTORY, so a project based at `sites/platform` needs its own tree.
  `create-site` now generates one three-line shim per factory, discovered from
  `packages/core/server/functions/` at scaffold time rather than from a list
  that would rot. 32 shims for platform.
- **The per-site `netlify.toml` now describes a REAL build** — base directory
  `sites/<client>`, `npx astro build --config sites/<client>/astro.config.ts`,
  `sites/<client>/dist`, and this site's function tree. It previously said
  `npm run build` / `dist`, which would have silently built Dr-Lurie into a
  second project.
- Scaffold total: 67 files. Dry-run fixture regenerated; both sites build.

**The one discovery Wolf should see before the sitting.**
`netlify/functions/mcp.ts` is NOT a shim — it is a 4,533-line implementation
bound to Dr-Lurie with no core factory (same for `save-json-blob.ts`, 2,349
lines, and `verify-article-images.ts`, 476). So the platform site will deploy,
serve `/admin`, and serve every governed verb, but **`/mcp` will 404 on it**
until `mcp.ts` is extracted into core behind `createHandler(siteBinding)` like
its 32 siblings. That is ordinary agent work, not account authority, and it
should land BEFORE the sitting so T14.3's step 5 can pass. It is queued at the
top of the checklist rather than parked. `publish-article.ts` and
`admin-workflow-lock.ts` stay off-limits and stay Dr-Lurie-bound; nothing in
W14 needs them on platform.

**A shim-discovery bug found and fixed in the same change:** `coreFunctionNames`
filtered for `.ts` only, so when the CLI ran from the COMPILED test tree
(`.tmp/ci-test`, where the same directory holds `.js`) it returned an empty list
and the scaffold dropped all 32 shims — passing every gate. It now accepts
`.ts`/`.js`/`.mjs` and dedupes by stem.

**Straggler sweep for the rename is already clean:** the literal repo string
appears exactly once in the tree, in `CLAUDE.md`, inside the warning that
explains why it must not appear. Nothing to change before the click.

Gates: both sites build; astro check 0 errors; eslint + prettier clean;
1699/1699 core tests; 89/89 script tests.

**Wolf's actions:** `T14.3-checklist.md`, steps 1 and 3. Everything else on that
page is agent work.

## Session 2026-07-26 (T14.2 — platform genesis: `sites/platform` scaffolded, builds, renders)

`sites/platform` (`site_platform`) exists and builds: 12 pages — the ten
injected `/admin/*` shell routes plus `/` and `/404` from its own starter
exports. `npx astro build --config sites/platform/astro.config.ts` is green,
and Dr-Lurie still builds unchanged from the same shell.

**Most of this task was work on `create-site`, not on the platform site.** The
scaffold as T11.7 left it could not produce a site that builds, and that gap
would have been discovered again — more expensively — at T14.9, where the
scaffold IS the thing being timed. Two things were missing:

1. **The build entry.** T14.1 made every site a thin entry over the shell; the
   scaffold predates it. It now writes `astro.config.ts`, `config.yaml`,
   `app/content/config.ts`, and the three reader routes a new site can actually
   serve (`index`, `404`, and the object-page catch-all — the catch-all must be
   site-owned because it enumerates its sibling routes with `import.meta.glob`).
2. **The per-site policy bundle.** The scaffold wrote `site-identity.ts` and
   `site-binding.ts` but not `approval-policy.ts` / `creation-policy.ts` /
   `media-policy.ts` / `policy-bindings.ts` — Dr-Lurie has all four. Without
   `policy-bindings.ts` nothing can resolve site identity and the build dies on
   the first component that asks. Fleet-default values; an operator retunes.

**Bootstrap exports — stated plainly, because this is the one place T14.2
touches the definition of "converted".** A scaffolded site has an empty store,
but the shell fails LOUDLY on a missing navigation or page export by design
("never leaves a surface half-fed"), so a site with nothing committed cannot
render one page. The scaffold now writes five: `site.json`, `nav_header`,
`nav_footer`, `page_home`, `page_404`. They are **rendered stubs, not converted
objects** — no store record backs them, so they fail CLAUDE.md's criteria 2–5.
Their `__generated.from` says exactly that (`create-site:bootstrap (not
store-backed — replaced by the seed drive)`), a unit test asserts the marker so
the label cannot quietly rot, and T14.3's seed drive through the front door
replaces every one with a genuine derived export. The alternative — shipping a
scaffold whose first build fails — would have made "cost of a new client"
unmeasurable at T14.9.

**Decisions recorded (R8):**

1. **Platform keeps the neutral scaffold branding and theme.** The brief says
   the manual's content is the product, not the styling (T14.5), so nothing was
   spent on a palette. Brand name "Platform", starter blue/teal tokens.
2. **`sites/*/dist` added to `.gitignore` and eslint's ignore list.** Only the
   root `dist` was covered; the first platform build put 1402 lint errors of
   minified output into the gate.
3. **The `create-site` dry-run fixture was regenerated, not hand-edited** —
   `tests/fixtures/create-site-dry-run-acme.mjs` now shows 35 files. The
   scaffold test was split in two so the bootstrap-export rule has its own name
   in the output rather than hiding inside a "ships empty" assertion that is no
   longer true.

**Still Dr-Lurie-shaped, deliberately, and now visible:** `sites/platform` has
no Netlify project, no env, no store, and no MCP endpoint. That is exactly
T14.3, which is a human gate.

**Next in queue:** T14.3 (HUMAN GATE — Netlify provisioning + repo rename).

## Session 2026-07-26 (T14.1 — app-shell extraction: one shell in core, per-site build entries)

The build is no longer hardwired to one client. `src/` at the repo root WAS
the app; the shell now lives in `packages/core/app/` and every
`sites/<client>/astro.config.ts` is a thin entry over it. Full source→target
table, the not-moved residue, and the route-ownership rule: the **W14 T14.1
amendment in `w11-move-map.md`**.

**The seam is four aliases**, resolved per build:

    ~/assets/**  →  sites/<client>/assets/**    ~/**      →  packages/core/app/**
    @core/**     →  packages/core/**            @site/**  →  sites/<client>/**

`~/assets/**` is split off from `~` because that spelling is baked into
PUBLISHED CONTENT (`to-markdown.ts` normalizes committed asset paths to
`~/assets/…`; article bodies carry it), so it cannot be renamed without
rewriting stored data. The shell's own stylesheets moved to `~/styles/`.

**`/admin` is fleet law and is INJECTED** into every site's build
(`packages/core/app/shell-routes.ts`, ten routes): it renders from the object
store, depends on no committed export, and a per-client copy would drift.
Reader routes stay site-owned — each is a thin loader over a NAMED page object
and `PageObjectRenderer` throws when that object is missing, so a freshly
scaffolded site (which has no page objects at all) would fail its first build
if it inherited Dr-Lurie's route set. That is the shape T14.2 builds on.

**Verification.** `npm run build` and `npx astro build --config
sites/drlurie/astro.config.ts` both green, 73 pages. `astro check` 0 errors.
eslint + prettier clean. 1698/1698 core tests, 89/89 script tests. The
zero-drlurie core lint is GREEN over the newly-arrived shell — which is where
most of the real work was, see below.

**build-diff vs `origin/main`: 71 of 74 pages byte-identical, 3 differences,
all intended de-siting, each verified by hand:**

| Difference                                           | Why                                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id="dr-lurie-login-modal"` → `id="cms-login-modal"` | internal DOM id; the whole `__drLurie*` / `dr-lurie:*` browser namespace (globals, custom events, controllers) is renamed to `__cms*` / `cms:*`. Client-name literals cannot ship in fleet law.               |
| `Search Dr. Lurié` → `Search Dr. Lurié Skincare`     | the search dialog's heading hardcoded the client's name. Now `Search ${site.name}` from the site object, falling back to the logo wordmark, then to plain `Search`. The only VISIBLE copy change in the wave. |
| minified inline script identifiers                   | the same namespace rename, as compiled.                                                                                                                                                                       |

R3 makes byte-identity informational, so these were reviewed rather than
blocked. Nothing else moved: `0 only-in-base, 0 only-in-head` — the injected
admin routes emit exactly the route set the file-based ones did.

**build-diff itself gained a normalization rule** (`html-normalize.mjs` rule 6,
its own commit): `data-astro-cid-<hash>` is Astro's scoped-style id, derived
from the component's FILE PATH and moving in lockstep with the CSS selector
that matches it. Relocating the shell changed it on 73 of 74 pages with zero
rendered difference — the same argument, and the same stated residual risk, as
the existing island-uid rule. Without it the tool reports the entire wave as
changed and stops being readable.

**Decisions recorded rather than parked (R8):**

1. **`src/` is not empty and should not be.** It keeps exactly three things,
   all bound to the OFF-LIMITS legacy publish stack: the `schema/` + `lib/`
   re-export shims that `publish-article.ts` / `admin-workflow-lock.ts` /
   `save-json-blob.ts` import (those files must stay byte-untouched, and
   `mcp/save-json-blob-mcp` mirrors `workflow-contract.ts` by path), and
   `data/post/**`, whose path is pinned by core's `content-item-index.ts`
   (`CONTENT_DIR`) and `article-path.ts`. Moving any of it means editing a hard
   stop. `src/chatkit/` (one unreferenced `.widget`) is dead — T14.10 sweeps it.
2. **De-siting the shell was the bulk of the task, not the moving.** Beyond the
   three diffs above: `Logo.astro`'s fallback wordmark, the `sites/drlurie/...`
   paths inside two error messages, and `object-page-routes.ts`'s hardcoded
   `src/pages/` prefix strip (now "everything up to the last `/pages/`") were
   all client-specific values sitting in what is now fleet law.
3. **`EditMode.astro`'s pre-check no longer names a key.** It read
   `localStorage['dr-lurie-gotrue-user']` directly so a visitor with no admin
   session pays nothing. Resolving `<siteSlug>-gotrue-user` properly would pull
   the site bindings into every visitor's bundle and defeat that. It now matches
   the `-gotrue-user` SUFFIX: exactly as safe (a false positive costs one wasted
   chunk fetch, and `bootEditMode` re-verifies server-side), and tenant-free.
4. **`tsconfig.test.json` excludes `packages/core/app/**`.** Its blanket
`packages/core/\*_/_.ts`include swept in shell modules that resolve`~/…`,
`@site/…`, and the `astrowind:config`virtual module — none of which`tsc`can see. Excluding the shell restores the pre-T14.1 arrangement exactly: a
shell module a Node test actually imports is still compiled as a reachable
dependency. The corollary is a real constraint, now written into the move
map: shell`.ts`files must use RELATIVE cross-package imports, never the
aliases, because`tsc` emits the specifier verbatim and the test runtime has
   no resolver for them.
5. **Dr-Lurie's `outDir` is pinned to the repo-root `dist`.** Every other site
   defaults to `sites/<client>/dist`. The live Netlify project publishes `dist`
   and T14.1 must not move the deploy's output path mid-wave; T14.3 repoints the
   projects and the pin comes off. Root `netlify.toml` and `npm run build` are
   untouched for the same reason — the root `astro.config.ts` is now a one-line
   re-export of Dr-Lurie's entry.
6. **`astro check` only typechecks Dr-Lurie's bindings.** `tsconfig.json` maps
   `@site/*` to one site because a tsconfig has one root. A second site's
   bindings are covered by its build, not by `astro check`. Acceptable for V1;
   revisit if the fleet grows past a handful.

**Next in queue:** T14.2 (platform genesis, AUTO, sonnet/medium).

## Session 2026-07-26 (T14.0 — admin login FIXED: unregistered site-identity provider in the client auth bundles)

**Root cause — a W11 T11.5 regression, not pre-existing.** Hypothesis (b) of
the triage tree (browser-side) was right; (a) server JWT/role resolution and
(c) unconfirmed account are both cleared.

T11.5 made the GoTrue browser-storage keys tenant-derived — `STORAGE_KEY()` /
`KEEP_KEY()` in `packages/core/lib/admin/goTrueClient.ts` now call
`getSiteIdentity()` at CALL time. `getSiteIdentity()` throws unless the site
has registered its provider by importing `src/config/policy-bindings`. Astro
compiles **each `<script>` block as its own client entry**, and the five client
entries that reach the auth client never imported the bindings:
`src/layouts/AdminLayout.astro` (the `/admin` gate),
`src/components/common/LoginModal.astro`,
`src/components/common/HeaderAuthButton.astro`, `src/pages/admin/kit.astro`,
and `src/components/common/EditMode.astro` (via the `@core/lib/edit-mode/index`
dynamic import, which also reaches `media-policy`). Their bundled chunks import
`site-identity` but never the chunk carrying the registration — that lives only
in the React islands' graph (`display-name.*.js`).

Every storage helper in `goTrueClient` wraps its access in `try/catch`, so the
throw never surfaced: it degraded **silently** to "always signed out". Nothing
in the console, nothing in the function logs — which is why the unauthenticated
triage found a healthy GoTrue, a healthy `admin-users`, and a rendering page.

**Verified by a real browser repro** (Playwright + the actual `npm run build`
output, GoTrue and `admin-auth-state` stubbed at the network layer), three
scenarios, before → after:

| Scenario                                                     | Before                                                    | After                            |
| ------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------- |
| Valid session in localStorage, cold load of `/admin`         | "Admin login required"                                    | workspace renders                |
| Sign in via the modal on an already-hydrated `/admin`        | worked (island had registered the provider by click time) | works                            |
| …then reload `/admin`                                        | "Admin login required" again                              | workspace renders                |
| Sign in from the public header (no admin island on the page) | session never persisted at all, header stayed "Sign in"   | persists, header shows "Account" |

That middle row is why the bug read as intermittent: the one path that worked
was signing in _after_ an island had hydrated, and it never survived a reload.

**Fix:** one side-effect import (`import '~/config/policy-bindings';`) at the
top of each of the five client script blocks — dynamic, in front of the editor
chunk, for `EditMode.astro` so a visitor with no admin session still pays
nothing. No auth redesign, no role-model change, no server change.

**Regression test:** `tests/scripts/client-scripts-site-bindings.test.mjs` — a
static lint at the layer the bug lived: any client `<script>` block importing
an identity-dependent core module (`goTrueClient`, `edit-mode/index`,
`site-identity`) must import the site bindings in the same block. Verified to
FAIL on the pre-fix tree (all five entries flagged) and pass after. It also
guards T14.1: moving the shell into core must not drop these imports.

Gates: `astro check` 0 errors · eslint clean · prettier (`src`/`scripts` glob)
clean · 1698/1698 core tests · 89/89 script tests (85 + 4 new) · build-diff
informational and EMPTY (74/74 pages identical vs `origin/main`).

**Decisions recorded here rather than parked (R8):**

1. **Scope widened from `/admin` to all five client entries.** Wolf reported
   `/admin`, but `HeaderAuthButton` + `LoginModal` ship on every public page and
   were fully broken there (sign-in persisted nothing). Same root cause, one fix
   cluster, one commit.
2. **`goTrueClient`'s blanket `try/catch` swallow is left as-is** and logged
   below as a T14.6 seed. Making it loud is a behavior change (private-mode
   browsers legitimately throw on localStorage) and belongs in a test-plan
   finding, not in the minimal login fix.
3. **Pre-existing prettier drift NOT swept.** The manual extra glob reports 45
   unformatted files under `tests/netlify/**` plus
   `tests/scripts/roundtrip-reconcile.test.mjs`, all untouched by this task and
   already unformatted on `origin/main`. Reformatting them here would be exactly
   the bundled cleanup CLAUDE.md forbids — routed to T14.10 queue hygiene.
4. **`EditMode.astro` still hardcodes the literal `'dr-lurie-gotrue-user'`** in
   its zero-cost pre-check (a surviving site literal in `src/`). Left alone —
   de-siting the shell is T14.1's job, and it is now flagged there.
5. **Model reallocation, declared not silent:** `queue.tsv` allocates T14.0 to
   `claude-fable-5`/high; this session ran on `claude-opus-5` at high effort.
   Lateral-or-better, so the row was left unedited rather than churned.

Production is NOT yet fixed — the commit is on `claude/w14-t14-0` and needs
Wolf to land and release it. The end-to-end production login check in the
brief's acceptance criteria happens on Wolf's next `/admin` visit after that
deploy; every layer below it is verified here.

**Next in queue:** T14.1 (app-shell extraction, NOTIFY, fable/xhigh).

## Session 2026-07-26 (W14 ruling recorded — platform site, V1 finish line; admin-login triage)

Wolf ratified the platform-site plan (iterated through three brief
revisions in-session):
`docs/cms-architecture/decisions/2026-07-26-platform-site-ruling.md` is
the record — R1 monorepo stands; R2 core site = `platform`; R3 Dr-Lurie
demoted to worked example (byte-identical build-diff DROPPED as a gate,
informational only); R4 Netlify split = birth platform as its own project,
`drluriescience` NOT renamed; R5 repo rename → `platform` (assessed LOW
pain); R6 site birth stays CLI+runbook for V1; R7 third site synthetic;
**R8 (governing): no parked blockers/questions — decide, record, keep
moving; V1 crosses the line.**

Queue: T11.11/T11.12 superseded (commented out with pointer); **W14 rows
added ahead of W12/W13** — T14.0 admin-login fix → T14.1 app-shell
extraction → T14.2 platform genesis → T14.3 HUMAN GATE provisioning+repo
rename → T14.4 fleet proof → T14.5 instruction manual (authored as
objects, drift-guarded vs object_contract) → T14.6 test plan → T14.7 fix
wave → T14.8 agent hygiene (incl. the PUBLISH_SECRET rotation, finally) →
T14.9 HUMAN GATE synthetic third site (timed) → T14.10 V1 close-out +
separation design doc. All eleven briefs committed.

**Admin-login triage (Wolf-reported: login on `/admin` doesn't work).**
Unauthenticated probes, same day: `/admin` renders (form present); GoTrue
healthy (`/.netlify/identity/settings` → email+google on, autoconfirm
off); `admin-users` boots (GET → 405, NOT a module-load crash — clears
the W11 factory-shim import chain as suspect). Fault is inside the login
round trip: (a) server-side JWT verify/role resolution, (b) browser-side
GoTrue exchange/hydration, or (c) unconfirmed Identity account. Full
hypothesis tree in the ruling doc's known-issue log; T14.0 picks the
branch via function logs + one observed browser symptom and fixes.

Also this session (pre-ruling): W11 wave 2 (7 commits, T11.6 step 2/3 →
T11.11 prep) delivered, merged by Wolf as PR #472, deployed — production
serving the merge commit, deploy ready 15:59:42Z; MCP ping green.

**Next in queue:** T14.0 (admin-login fix, NOTIFY, fable/high).

## Session 2026-07-24 (T11.11 prep — second-site acceptance run: agent-side readiness verified, HALTED on account authority)

T11.11 is `human_gate` (queue.tsv) — "prepared by agents; executed with
account authority (Netlify site creation, env, DNS optional for staging)"
per the brief itself. Per the autonomous-run rule (human_gate tasks are
prepared in full, never completed by the agent) and this session's own
governing instruction ("HALT only on the step needing account authority"),
this is exactly that halt point. Nothing was committed as `T11.11: …` —
the task is not done; this is the prep-and-stop entry, matching the
T9.16+T9.23 prep precedent (`775441fe`).

**Verified agent-side (everything preparable without a real Netlify
account):**

- `node packages/core/cli/create-site.mjs --name staging --dry-run` runs
  clean end-to-end: scaffolds a full plan (site-identity/site-binding/
  site.config/netlify.toml/package.json, an empty committed-export tree,
  the five-piece baseline seed pack) and prints the complete per-site env
  checklist (core publish + repo binding, access/identity/governance,
  pdf-tool + tracking tenancy axes, AI + integrations, the transitional
  site-identity env overrides) grouped by `[per-site]` vs
  `[fleet-shared]` — confirming T11.7's CLI and
  `docs/cms-architecture/site-provisioning-runbook.md` are in sync and the
  scaffold mechanism itself is sound. Dry-run touches neither disk nor
  network, so this proof is safe and repeatable without committing
  anything or needing a real account.
- Re-read `site-provisioning-runbook.md` end to end: its own §4 already
  says the quiet part out loud — "today exactly one Netlify build (Dr-Lurie's)
  reads any `site.config.ts` at build time… pointing a REAL second Netlify
  build at its own `sites/<client>/` tree… is T11.11's job… this section
  exists so nobody mistakes 'the directory exists' for 'the site is live.'"
  That is precisely the wall this session hit.

**Why this genuinely cannot proceed further from this sandbox** — every
remaining step in the brief's scope needs live external state this
environment has no path to:

1. `create-site --netlify-token …` needs a real Netlify API token with
   site-create rights and actually calls the Netlify API to provision a
   second site + probe its 8 blob stores — no such token/account access
   exists in this sandbox (same posture this whole wave has recorded for
   T11.7/T11.8/T11.9's "unverified in a live run" notes, but those tasks
   could still fully verify their OWN mechanism locally; T11.11's
   acceptance criteria explicitly requires "commit/deploy refs" from a
   REAL second site, which by definition can't be produced locally).
2. The baseline seed pack drive (`--production` against the new site's
   real endpoint) and the agent MCP round-trip proof both require that
   real, deployed second site to exist and be reachable first.
3. The fleet-propagation proof needs two real Netlify builds (Dr-Lurie's
   - the new site's) actually running in CI/on Netlify — this sandbox has
     no path to trigger or observe a live GitHub Actions run or a live
     Netlify build (recorded the same way for every prior W11 CI task).

**What Wolf's action unblocks:** once a real second site exists (runbook
§1–§2: `create-site --name <client>` for real, then `--netlify-token`, then
the by-hand env items in §3), this same brief's steps 2–4 are directly
executable by an agent session with that site's live URL and deploy access
in hand — nothing about the mechanism itself is in question, only the
account-authority half only Wolf can perform.

**T11.12 is blocked behind this** (`depends_on: T11.11`) — the autonomous
run stops here rather than fabricating a close-out over an incomplete
fleet proof.

## Session 2026-07-24 (T11.10 — Per-site governance, secrets, and the minimal per-agent-credential slice)

**Per-agent credentials (ratified in scope by OQ-W11-5 — verifiable tokens,
not a full IAM)** — new `packages/core/server/lib/agent-keys.ts`: a
`agent-keys.v1` doc living as a SIBLING key in the SAME `governance` blob
store `admin-governance.ts` already owns (no new blob store, T11.7's
`CORE_BLOB_STORES` pin untouched). Records are `{agent_name, token_hash
(sha256), status, site, created_by, created_at, revoked_at?}` — the raw
token is minted (`crypto.randomBytes(32).toString('base64url')`), returned
exactly once to the caller, and never persisted or logged. One ACTIVE key
per `(agent_name, site)`: minting a replacement auto-revokes the prior one.
`resolveVerifiedAgentName(token, site, doc)` is a PURE function (no store
access, timing-safe hash compare) — fails closed on every adversarial case:
forged token, revoked key, wrong site, null doc, empty-string token. 13
tests in `agent-keys.test.ts`.

**Admin surface** — `admin-governance.ts` gained three verbs:
`agent_keys_list` (Admin, strips `token_hash` via `describeAgentKeys`),
`agent_keys_create`/`agent_keys_revoke` (Owner-only, same bar as every
other governance write there). `create` is the only response in the whole
handler that ever carries a raw token. `requestSchema` is now exported so
the request CONTRACT is testable directly; the owner-gating WIRING is
proven with a source-level regex assertion, matching this file's own
established `tracking-governance.test.ts` precedent (no test-injection seam
exists for `getAdminStateFromEvent`, the same gap that file already worked
around). 5 tests in `admin-governance.test.ts`.

**MCP auth wiring** — the actual identity path. `netlify/functions/mcp.ts`'s
`getAuthResult` is now `async`: it resolves a verified per-agent bearer
token FIRST, independently of the shared `MCP_HTTP_AUTH_TOKEN` gate — a
verified token satisfies the gate on its own, even against an unset or
mismatched shared secret. When no verified token is present, the existing
shared-secret decision tree runs byte-identical to before (deprecated
fallback, not a forced cutover, per the brief's own non-goals). The
resolved `verifiedAgentName` rides on the Lambda event and, in `callTool`,
overrides self-declared `agent_name` — but ONLY for an explicit allowlist
of 7 CMS attribution tools (`CMS_AGENT_NAME_ATTRIBUTION_TOOLS`:
`object_create`, `object_create_variant`, `object_instantiate_template`,
`object_instantiate_section_template`, `site_apply_theme`,
`product_set_price`, `order_reissue`). **A blanket override was the first
draft and was caught and fixed before ever running a test**: `agent_name`
also means workflow-pipeline STAGE identity for
`save_json_blob_mark_agent_complete`/`patch_agent_output` (validated
against a completely different fixed enum — research/draft/reader_insight/
etc.) — an unscoped override would have broken every legitimate
workflow-stage call whenever a verified bearer token happened to be
presented. 7 tests in `mcp-agent-keys-auth.test.ts`, run against the REAL
handler + a real isolated local-blob-backed governance store: verified
token beats the wrong shared secret; revoked token fails closed; forged
token never verifies; cross-site key never leaks; open dev-mode
unaffected; verified identity overrides a forged `agent_name` on
`object_create`; and — the critical carve-out proof — verified identity
does NOT touch `save_json_blob_mark_agent_complete`'s enum-validated
`agent_name`.

**Per-site posture files** — `sites/drlurie/config/approval-policy.ts` +
`creation-policy.ts` (new), verbatim relocation of the committed values
from `src/config/`, matching T11.7's `create-site.mjs` scaffold shape for
the next client. `src/config/policy-bindings.ts` now imports from the new
location; the old `src/config/approval-policy.ts`/`creation-policy.ts` are
deleted (only 2 real importers existed, both updated — verified by
exhaustive grep before deletion, not assumed).

**`docs/cms-architecture/secrets-runbook.md`** (new) — the brief's explicit
deliverable: a one-page inventory of every secret in the fleet (scope,
what it gates, storage, rotation procedure), the project's random-token
generation convention, and — the standing debt the brief calls out by
name — the `PUBLISH_SECRET` rotation, exposed 2026-07-11 and never
rotated since, now also a hard shop-launch blocker per
`06-shop-module-plan.md` §0.5. T11.10 does NOT rotate it (still a
human/Wolf-scheduled act) or retire it (the per-agent mechanism is an
attribution layer on top of the object-store proxy's existing
`PUBLISH_SECRET`-gated write path, not a replacement for it) — the runbook
just makes executing that rotation a known five-step procedure.

**`object_review_decide`'s TODO comment** (mcp.ts, ~line 1548) updated to
reflect that a verified-agent mechanism now exists, while being explicit
that this verb's own authorization is DELIBERATELY unchanged — M-6
approvals stay human-only (no agent-approves-agent review), per this
task's own non-goals. Wiring verified identity into approval authority
would be a capability change, not an attribution one, and stays out of
scope until a future task explicitly ratifies it.

**M-6 posture unchanged, proven by absence of change**: no approval-decision
logic was touched anywhere in this task; the full suite staying green
(1698/1698, unchanged pass count from before this task's own +18 new tests
were added) is the proof that nothing about `object_review_decide`'s
authorization behavior shifted. No new dedicated regression test was
written asserting this specifically, since it is a "nothing changed here"
claim already covered by the full suite's continued green state.

**Gates:** `astro check` 0 errors; `eslint .`/`prettier --check` clean
(including the new `packages/core/server/lib/agent-keys.*`,
`packages/core/server/functions/admin-governance.test.ts`,
`tests/netlify/mcp-agent-keys-auth.test.ts`, `sites/drlurie/config/*.ts` —
none of these paths are covered by the project's own `check:prettier`
glob, checked separately; 6 files needed a manual `prettier --write` pass,
re-verified clean afterward); full test suite **1698/1698 + 85/85** (up
from 1673/1673 + 85/85: +25 co-located — 13 agent-keys + 5
admin-governance + 7 mcp-agent-keys-auth); `build-diff.mjs --self-test`
PASS; `build-diff.mjs --base origin/main --site sites/drlurie` (working
tree vs `origin/main`) — EMPTY, 74/74 (unaffected — nothing here touches
render/build output). Committed `T11.10: …`; no PR (per the brief).

**Next in queue:** T11.11 (Second-site acceptance proof, sonnet/medium,
human_gate — HALT only on the step needing account authority).

## Session 2026-07-24 (T11.9 — Schema-migration harness: registry/classify framework + `migrate-site` CLI + fleet CI gate; no real schema bump shipped)

**Framework** — new `packages/core/server/migrations/registry.ts` +
`classify.ts`. A migration is `{objectType, from, to, description, migrate,
toPatchOps?, inverse?, irreversible?}`; `findMigrationChain` (BFS) composes
one-hop migrations into an arbitrary chain; `classifyRecord` decides
per-record disposition — `parses-as-is` (wins over a version-string
technicality), `migratable` (`writable` iff every hop carries `toPatchOps`),
or `blocked` (no path, OR a chain exists but the migrated body still fails —
distinguished from "no path" as a broken-migration signal); `classifySiteRecords`
fails a whole scan on a single blocked record. **`toPatchOps` is optional by
design**: not every object type has a generic replace-body op (page/section
have narrower field-scoped ops) — a migration without one is preview-only,
never an unsafe workaround around the existing patch grammar. 23 unit
tests, including the brief's own required adversarial case: a synthetic
v1→v2 required-field addition blocks with no migration registered, passes
once one is.

**CLI** — new `packages/core/cli/migrate-site.mjs`. `--dry-run` (default)
scans a site's COMMITTED exports and classifies every record — pure disk +
the registry. Since a committed export carries no real `schema_version` tag
at all, every scanned record's version is assumed to be the current head
version for its type (`CURRENT_SCHEMA_VERSIONS` — the one map a real bump
would update, mirroring `object-verbs.ts`'s own hardcode) — a recorded,
deliberate assumption, correct as long as nothing has drifted (true today).
`--write` applies migratable+writable records through the STANDARD verb
path only — `get` → `checkout` → `patch` (the chain's own `toPatchOps`) → a
best-effort republish only when the record was already live → `checkin`
(always attempted) — never a raw blob write; real production writes need
real Netlify credentials this sandbox doesn't have, so `--write` without
`--local` refuses explicitly rather than silently no-op'ing (same posture
as T11.7's `--netlify-token` path). 13 tests, including the real
`sites/drlurie` export tree passing the gate today (64 records, 0 blocked)
and the write orchestration proven against an in-memory store with a
migration compatible with the REAL page schema (proving the mechanism; the
adversarial schema-blocking logic already has its own fully-synthetic proof
in `classify.test.ts`).

**CI gate** — new `scripts/ci/schema-migration-gate.mjs`, extending T11.8's
fleet discovery so a second client needs zero edits here: per discovered
site, a throwaway `tsc` pass into its own outDir, dynamic import of the
compiled CLI, scan, fail if any site is blocked. **Verified for real**: ran
it directly in this sandbox — compiled, imported, scanned the real
`sites/drlurie` tree, reported PASS, cleaned up, exit 0. Wired into the
`check` job as a new named step in `.github/workflows/actions.yaml` (time-
budget comment updated); same "unverified in a live GH Actions run" posture
as T11.7/T11.8 (no way to execute Actions from this sandbox) — everything
the step actually runs was proven locally instead.

**Gates:** `astro check` 0 errors; `eslint .`/`prettier --check` clean
(including the new `packages/core/server/migrations/**`,
`packages/core/cli/migrate-site.*`, `scripts/ci/schema-migration-gate.mjs`,
and `tests/scripts/schema-migration-gate.test.mjs`, checked separately —
none of these paths are covered by the project's own `check:prettier`
glob); full test suite **1673/1673 + 85/85** (up from 1637/1637 + 82/82:
+36 co-located — 23 registry/classify + 13 migrate-site — and +3 in
`tests/scripts` — schema-migration-gate's aggregation logic);
`build-diff.mjs --self-test` PASS; `build-diff.mjs HEAD origin/main --site
sites/drlurie` — EMPTY, 74/74 (unaffected — nothing here touches build
output). Committed `T11.9: …`; no PR (per the brief).

**Next in queue:** T11.10 (Per-site governance + credentials inventory,
NOTIFY, fable/high).

## Session 2026-07-24 (T11.8 — Fleet CI: dynamic per-site matrix + change-scoped fan-out; live GH Actions run unverified)

**Replaced the T11.1 placeholder `fleet` job** (hardcoded `matrix: site:
[drlurie]`) with real dynamic discovery. New
`scripts/ci/discover-fleet-matrix.mjs`: `discoverSites()` lists every
`sites/<name>/` carrying its own `site.config.ts` (today: exactly
`['drlurie']`); `computeFleetMatrix()` is a pure function deciding, from a
list of changed paths, whether the fleet fans out fully or scopes to just
the touched site(s) — deliberately conservative: a diff confined ENTIRELY to
`sites/**` scopes down, anything else (`packages/core`, root config, an
unresolvable diff) fans out to everyone. A new `discover-fleet` job runs
this once per CI run and feeds its outputs (`sites`, `fan_out`) to both the
`fleet` job's matrix and a new `fleet-build-diff` job.

`fleet` now runs, per discovered site: install, `astro check`, build, full
suite, and the site-seed drift guard (moved here from the `check` job,
where it was hardcoded to `sites/drlurie` — now it runs per-site,
best-effort skipped rather than failed for a site with no
`sync-site-seed.mjs` yet, since T11.7's `create-site.mjs` scaffold doesn't
generate one today — a recorded residual, not silently papered over).
`fleet-build-diff` (new) runs only on PRs where the fleet fanned out: per
site, `build-diff.mjs <base> <head> --site sites/<site>` piped to a file
with `|| true` (never fails the job — a non-empty diff is a review artifact
per design-principles rule 4, not an automatic failure) and uploaded via
`actions/upload-artifact@v4`.

**Verified against real git history, not just unit tests:** `HEAD~1..HEAD`
and `origin/main..HEAD` both correctly report `fanOut: true` (T11.6/T11.7
touch `packages/core`); a throwaway demo commit touching only
`sites/drlurie/data/site/.demo-touch-tmp` correctly reported `{"sites":
["drlurie"],"fanOut":false}` before being reverted (`git reset --hard`) —
proving the filter side of the acceptance criteria, not just the fan-out
side. 12 new unit tests
(`tests/scripts/discover-fleet-matrix.test.mjs`) cover discovery (including
a half-scaffolded site with no `site.config.ts` — correctly excluded) and
every fan-out/scope-down branch of `computeFleetMatrix`, plus the
`$GITHUB_OUTPUT`-writing helper (`sites=`/`fan_out=` lines, no bash-side
JSON parsing needed in the workflow step).

**Mid-task incident, self-caught and fixed:** while manually proving the
filter behavior against real git history (the demo-commit test above), a
`git reset --hard $BASE` used to revert the throwaway demo commit also
discarded the (uncommitted, unstaged) `actions.yaml` edit sitting in the
working tree at the time — `git reset --hard` resets the working tree to
match the target commit, not just HEAD, and does not distinguish "changes
from the commit being undone" from "unrelated uncommitted work." Caught
immediately by re-checking `git diff --stat` /grepping for the new job
names post-revert; the file was still fully in context from having just
written it, so it was rewritten byte-for-byte rather than redone from
scratch. Lesson recorded here rather than just silently fixed: `git stash`
(or committing the actual change FIRST) is the safe move before any
`reset --hard`-based demo/revert dance, not `reset --hard` while unrelated
edits are still unstaged.

**Recorded, not a halt:** this is a GitHub Actions workflow file; there is
no way to execute GitHub Actions from inside this sandboxed session.
Verified instead: the YAML parses (`js-yaml`), every command a step invokes
runs correctly against real repo state locally (`npm run
check:astro`/`build`/`test`, `discover-fleet-matrix.mjs` against real SHA
ranges, `build-diff.mjs`'s existing `<base> <head> --site <path>` interface).
The GitHub-Actions-specific plumbing (`github.event.pull_request.base.sha`,
`fromJson()` over a job output, whether the default PR-merge-commit checkout
still carries the head SHA's commit object for `git worktree add` to
resolve) is standard/documented but unverified live — same posture as
T11.7's Netlify API calls. A real PR against this branch is the first true
proof; flagged for whoever lands this to watch the first Actions run
closely.

**Gates:** `astro check` 0 errors; `eslint .`/`prettier --check` clean
(including the new `scripts/ci/**` and the workflow YAML, checked
separately); full test suite **1637/1637 + 82/82** (12 new); `build-diff.mjs
--self-test --site sites/drlurie` PASS; `build-diff.mjs HEAD origin/main
--site sites/drlurie` — EMPTY, 74/74 (unaffected — nothing here touches
build output). Committed `T11.8: …`; no PR (per the brief).

**Next in queue:** T11.9 (Schema-migration harness, NOTIFY, fable/high).

## Session 2026-07-24 (T11.7 — provisioning CLI: `create-site`; scaffold + runbook committed, live Netlify path unverified — no credential)

**Built `packages/core/cli/create-site.mjs`** per the standalone brief's
Scope (not the move-map's `cli/` row, which additionally assigns the
physical relocation of `build-diff.mjs`/`home-conversion-roundtrip.mjs` to
land here — the brief itself doesn't ask for that move; see the recorded
discrepancy in the T11.7 move-map amendment, left for T11.12 to reconcile).
`--name <client>` scaffolds `sites/<client>/`: its own self-contained
`config/site-identity.ts` + `config/site-binding.ts` + `site.config.ts`
(importing only from `packages/core` — cleaner than Dr-Lurie's own shell,
which re-exports singletons from `src/config/*`, a location that's
Dr-Lurie's alone), `netlify.toml`, `package.json`, an empty committed-export
tree (`data/site/**/.gitkeep`), and a baseline seed pack: a starter site
singleton (generic branding/palette), a two-item nav skeleton, an empty
taxonomy registry, a default theme, and the five canonical starter
section-template recipes (same ids as Dr-Lurie's `stpl_*` — their blueprint
copy carries no client-specific content). `--dry-run` prints the full plan
touching neither disk nor network; `--netlify-token` additionally creates
the Netlify site, probes this site's 8 blob stores (write→read→delete, the
`provision-pdf-tool-stores.mjs` pattern), and pushes generated per-site
secrets (`PUBLISH_SECRET`, `MCP_HTTP_AUTH_TOKEN`,
`ARTIFACT_UPLOAD_TOKEN_SECRET`, `TRACKING_SALT`) straight to the new site's
env store — never printed. Idempotent: an existing `sites/<client>/` is
detected and left untouched.

**Two real bugs caught by validating the baseline pack's seed bodies
against the actual `packages/core/schema/bodies/*` zod schemas** (not
assumed valid): `content_grid`'s `related` source needs an `algorithm`
field, not a bare `related_articles` kind literal; `newsletter_signup`
needs `formName`, not `formAction`. Both fixed before commit.

**Unit tests** (`packages/core/cli/create-site.test.ts`, co-located per the
`packages/core` precedent so schema-validating assertions get a normal
relative import instead of reaching into `.tmp/ci-test` by a fragile path):
id-scoping (`site_<client>`/`tax_<client>`/`thm_<client>_default`, no
cross-client collision), the full baseline-pack file list, the 8-store list
pinned against `blob-store.ts`/`governance-store.ts`/`users-store.ts`/
`chat-store.ts`'s literals, the env checklist covers every per-site row from
the brief's table (not an illustrative subset), no secret-shaped value ever
appears in dry-run output or in files actually written to disk (a real
scratch-scaffold-then-read-back check, cleaned up after), and the dry-run
report byte-matches a committed fixture
(`tests/fixtures/create-site-dry-run-acme.mjs` — an `.mjs` module wrapping
the text, not a raw `.txt`, so it gets pulled into the compiled test tree
the same way `sites/drlurie`'s seed `.mjs` files do for other tests, instead
of needing a real-repo-root guess from a compiled test's `import.meta.url`).
10 new tests, all passing.

**`docs/cms-architecture/site-provisioning-runbook.md`** (new): the human
half — scaffold, create+provision, then the by-hand steps (GitHub repo
binding, build hook, Identity/roles, tenancy axes, AI keys — reuse the
fleet's, Stripe if the client sells, DNS, secret-rotation debt pointer to
T11.10) — plus an explicit note that wiring an actual SECOND live deployment
to read from its own `sites/<client>/` (rather than `sites/drlurie/`) is
T11.11's job, not this scaffold's: today exactly one Netlify build (Dr-Lurie's)
reads any `site.config.ts` at build time.

**Recorded limitation, not a halt:** the `--netlify-token` path (real site
creation, the store probe, generated-secret push) is built against the
documented Netlify API shape (`POST /api/v1/sites`, `POST
/api/v1/accounts/:id/env`) but has never run against a live account —
`NETLIFY_API_TOKEN` isn't available in this session, exactly the prerequisite
autonomous-run.md already flags as "needed from T11.7 on." Per the standing
instruction that credential unavailability doesn't block building, this is
recorded rather than treated as a stop: the brief's actual acceptance
criteria (unit tests over scaffold output, a committed dry-run fixture, no
secret material in any artifact) don't require a live run, and the brief's
own non-goals rule out creating a real second site here. The control flow
(`executeNetlifyProvisioning`) takes an injectable `fetchImpl`/`getStoreImpl`
seam (the `object-publish.ts`/`provision-pdf-tool-stores.mjs` testing-seam
precedent) so it's unit-testable without credentials, but the live wire
shapes are only as verified as Netlify's current public docs — T11.11's
provisioning step is this path's real first proof.

**Gates:** `astro check` 0 errors; `eslint .` / `prettier --check` clean
(including `packages/core/cli/**` — not covered by the project's
`check:prettier` npm script glob, verified separately); full test suite
**1637/1637 + 70/70** (10 new); `build-diff.mjs --self-test --site
sites/drlurie` PASS; `build-diff.mjs HEAD origin/main --site sites/drlurie`
— **74/74 pages byte-identical, EMPTY diff** (unaffected — nothing in
Dr-Lurie's own build path imports anything new here). Committed `T11.7: …`;
no PR (per the brief).

**Next in queue:** T11.8 (Fleet CI, opus/medium, auto).

## Session 2026-07-24 (T11.6 step 3/3 — driver-script `--site` parameterization; T11.6 CLOSED)

**T11.6 step 3 committed, closing T11.6.** Scope call recorded up front: the
brief's literal "move driver scripts to `packages/core/cli/`" bullet was
DEFERRED to T11.7, not executed here — the T11.4 amendment had already set
this precedent ("rides T11.7 where site-parameterization makes the move
meaningful"), and ~40 other task briefs across the queue reference
`node scripts/build-diff.mjs` / `scripts/home-conversion-roundtrip.mjs` at
their current literal path; moving the files now, before T11.7 builds
whatever makes the new location meaningful, would silently break every one of
those references for zero compensating benefit. What T11.6 genuinely
required — `--site` parameterization, since step 2's `git mv` had actively
broken both scripts — was done in place.

`scripts/build-diff.mjs` gained `--site <path>` (default `sites/drlurie`);
`SELF_TEST_FILE` now derives from it instead of a hardcoded
`src/data/site/...` literal. `scripts/home-conversion-roundtrip.mjs` gained
the same flag; `siteRoot`/`siteExportRoot` feed the default `--seeds` path,
the navigation reference-target seed lookup, and the `--write-exports`
materialize meta's `exportRoot`; production-mode endpoint resolution now
reads `canonicalHost` from the site's compiled `site.config.js` rather than a
hardcoded host (falling back to the old hardcoded endpoint if that compiled
file is absent).

**Found and fixed in passing** — latent, pre-existing breakage in
`home-conversion-roundtrip.mjs` that this driver's exclusion from `npm test`
had let sit undetected, but which blocked proving the acceptance criterion so
it had to be fixed: (1) the default `--seeds` path still pointed at the
pre-T11.6-step-1 `scripts/lib/page-home-seed-data.mjs` (the step-1 import
rewrite only caught static `import` statements, not this `path.join()`);
(2) the navigation reference-target seed path still built from
`repoRoot + 'src/data/site/navigation'`, broken by this session's own step-2
move; (3) the materializer/`local-blobs` compiled-path imports still pointed
at the defunct `netlify/lib/...` location, an unnoticed T11.3 regression.
Also fixed: `sites/drlurie/seeds/sync-site-seed.mjs`'s `EXPORT_PATH` still
pointed at the pre-step-2 `src/data/site/site.json` (step 1 couldn't have
caught this — the export hadn't moved yet at step-1 time); now points at
`sites/drlurie/data/site/site.json`, verified `--check` reports "seed already
matches the production export."

**Gates (final, all green):** `astro check` 0 errors; `eslint .` clean;
`prettier --check` clean; full test suite **1627/1627 + 70/70**;
`build-diff.mjs --self-test --site sites/drlurie` PASS (both sub-checks);
`build-diff.mjs HEAD origin/main --site sites/drlurie` — **74/74 pages
byte-identical, EMPTY diff**; `home-conversion-roundtrip.mjs --local --site
sites/drlurie` SUCCESS (run twice, once with `--write-exports` — both runs'
working-tree pollution of the real committed exports reverted via
`git checkout --` immediately after, per the flag's documented behavior).

**T11.6 is CLOSED** — all three steps landed, full acceptance criteria met.
Next in queue: T11.7 (Provisioning CLI).

## Session 2026-07-24 (T11.6 step 2/3 — committed exports → sites/drlurie/data/site/, materializer paths parameterized)

**Also this session:** the T11.6-step-1 branch's 8 commits landed on `main`
via PR #471 (merged by Wolf using the delivered `w11-land.zip` bundle+scripts —
push access for this session remains read-only as established; nothing
changed on that front, the user applied it with their own credentials).
Confirmed via `git merge-base HEAD origin/main` == `f2569175` before
continuing — this branch's step-1 commit is exactly `main`'s tip's parent, so
step 2 builds cleanly on the real landed state, not a stale local guess.

**T11.6 step 2 committed.** `git mv src/data/site sites/drlurie/data/site`
(verbatim tree, only the root moved) plus the parameterization the brief
calls for ("update the export-root loader seam ... and materializer output
paths via the site binding") — NOT built in T11.4 as the brief's phrasing
implies (verified: no `exportRoot`/loader-seam existed anywhere pre-this-
session; T11.4's amendment explicitly deferred it to compose with T11.5-6).
Built now: `MaterializeMeta.exportRoot` (required, no core default) + an
`exportPath()` helper in `materializers/shared.ts`; all 11 materializers
route through it. `SiteBinding.dataRoot` (T11.3's seam) carries the value;
`src/config/site-binding.ts` sets it to `sites/drlurie/data/site`;
`object-publish.ts`'s `PublishObjectDeps.exportRoot` threads from there
through every publish-reaching factory (object-store, admin-object,
run-publisher-agent, both agent-chat functions via `agent/context.ts`) — the
5 of ~32 T11.4 `createHandler(_binding)` factories that actually reach
`publish_by_time` now use their binding instead of discarding it. Fixed in
passing: T11.5 had left a second, unused, divergent `SiteBinding` reconstructed
in `sites/drlurie/site.config.ts` — now re-exports the real one from
`src/config/site-binding.ts` instead (the exact drift this seam exists to
prevent, caught before it could diverge further).

Two hard-stop-adjacent findings, both fixed rather than worked around: (1) the
zero-drlurie lint (T11.5) failed on a literal `sites/drlurie/data/site` EXAMPLE
inside a thrown-error string in `object-publish.ts` — the lint is working
exactly as designed; genericized the message. (2) the T11.5 apostrophe-in-
single-quoted-string bug (an unescaped `'` inside a description string breaks
the TS parser with a wall of cascading errors) recurred verbatim in
`object-contract.ts`'s tracking_config description — same fix pattern, reworded
until zero apostrophes remained.

Full move-map detail: see the T11.6 amendment above. Readers updated: 1
`import.meta.glob`, 11 `astro:content` collection globs, 6 comment-only path
mentions. Test fixtures updated: 19 files (path assertions, real-file
directory walks, or bare `{at, record_version}` meta/publishDeps objects that
now need `exportRoot`).

**Gates:** `astro check` 0 errors; `tsc -p tsconfig.test.json` clean;
`eslint .` clean; `prettier --check` (project's covered globs) clean; full
test suite **1627/1627 + 70/70**; `build-diff.mjs --self-test` PASS;
`build-diff.mjs --base origin/main` (working tree, all step-2 changes
included) — **74/74 pages byte-identical, EMPTY diff**.

**Remaining for T11.6 (at the time this entry was written):** step 3 (driver
scripts — `--site` parameterization; per-site seed drift-guard). **Update:**
step 3 landed the same day — see the newer entry above ("T11.6 step 3/3 —
... T11.6 CLOSED") for the completed work and final gate results.

## Session 2026-07-24 (T11.6 step 1/3 — seeds into sites/drlurie/seeds/)

**T11.6 step 1 committed.** All 17 `scripts/lib/*-seed-data.mjs` modules +
`sync-site-seed.mjs` → `sites/drlurie/seeds/` (git mv; seeds are client data —
copy semantics, never fleet-propagated). ~40 importers rewritten
(tests/scripts); sync-site-seed's repo-root/seed paths updated; CI's
seed-drift step now runs `sites/drlurie/seeds/sync-site-seed.mjs --check`
(green from the new home). One regex miss caught by the suite
(`pages-w5-seed-data` — digit in the name) and fixed.

Gates: check 0 errors; tests 1627/1627 + 70/70; seed drift-guard green;
build-diff EMPTY. Remaining T11.6 steps: (2) committed exports →
`sites/drlurie/data/site/` with collection-glob/utils/materializer-path
parameterization (the production write-path slice); (3) driver-script CLI
move with `--site`.

## Session 2026-07-24 (T11.5 — de-hardcode site identity; NOTIFY row run at fable/high)

**T11.5 DONE** (branch `claude/t11.5-desite-hardcodes`). Core is site-agnostic,
**lint-enforced**: new `tests/scripts/core-no-site-literals.test.mjs` fails on
any `drlurie|kugelmedia|Lurié` literal in `packages/core` APPLICATION code
(comments + `*.test.ts` exempt per the ratified carve-out) — passing.

**De-hardcoded through the identity seam (byte-identical for Dr-Lurie):**
`TAXONOMY_RECORD_KEY` (→ `taxonomyId`), git-committer fallback author (→ new
`committerName/committerEmail` config fields, env still wins), AdminShell
label (→ new `adminLabel` field pinned to 'Dr. Lurié admin'), goTrueClient
browser-storage keys (→ lazy `${siteSlug}-…`, sessions survive), agent persona
(brandName), tools/object-contract example ids (resolver-derived
`site_drlurie`/`tax_drlurie` at runtime), storage-grant copy neutralized,
KitGallery samples via identity. `strategy_drlurie` was already comment-only
(front-load verified). All 11 FRONT-LOADED census items verified absent.

**New architecture pieces:** `sites/drlurie/site.config.ts` (zod-validated:
canonical host, image domains, the 10-row redirect table, site id + binding
re-export — the FIRST real sites/ module); `astro.config.ts` reads
host/domains from it; **drift guards** instead of generation
(`tests/netlify/site-config-drift.test.ts`: netlify.toml redirect table ==
site.config, config.yaml site URL == canonicalHost). **Island-entry seam:**
10 site wrappers under `src/admin/*` register providers then re-export core
admin components — fixing 3 pre-existing core→site `~/config` imports the
step-2 purity grep missed (it only checked relative paths).

**Gates:** check 0 errors; tests **1627/1627 + 70/70** (incl. the new lint,
drift guards, extended byte-compat gate); build-diff: **73/74 byte-identical —
ONE intentional diff**, `/admin/kit` (dev component gallery): sample theme
name 'Dr. Lurié default' → 'Default theme', one `<td>`. Server-rendered
sample copy cannot be de-hardcoded byte-identically; accepted + disclosed
rather than faked with brand-string surgery. All admin pages otherwise
identical (proves adminLabel/fixtures resolve byte-exactly).

**Residuals (enumerated per the brief):** `publish-article.ts` +
`save-json-blob.ts` + `verify-article-images.ts` + `admin-workflow-lock.ts`
stay drlurie-bound (frozen; retire with the legacy path);
`mcp/save-json-blob-mcp/` untouched (OQ-W11-6); `mcp.ts` example ids stay
(formally a SITE file now — its future core factory split must neutralize);
`verify-section-components.mjs`'s `~` import was already unresolvable outside
Vite (manual tool; rides T11.7 cli work) — out-of-scope finding.

## Session 2026-07-24 (T11.4 step 3/3 — function-factory pass; T11.4 CLOSED with recorded residuals)

**T11.4 is DONE** (3 gated step-commits). Step 3: 32 functions →
`packages/core/server/functions/*` as `createHandler(binding)` factories;
`netlify/functions/*` reduced to per-site shims (site providers +
`createHandler(drlurieSiteBinding)`; `export *` preserves named internals).
The 4 frozen functions + mcp.ts stay byte-identical/site-side. Direct
publish-secret reads in 5 functions now resolve through the binding module.
Security source-scans repointed at implementations (admin-object secret
absence, admin-governance Owner gate, publisher-repoint absences).

Residuals recorded in the move-map amendment: mcp split (waits on legacy
retirement), pages-shells + data-root seam (compose with T11.5–T11.6), cli
relocation (T11.7). Gates: check 0 errors; tests 1624/1624 + 69/69;
build-diff EMPTY vs step 2; frozen files byte-identical to main; core app
code imports nothing from src/netlify.

## Session 2026-07-24 (T11.4 step 2/3 — sections + registry barrel + admin workspace into core)

**Step 2 committed.** Moved: the 24 `src/components/sections/*.astro` →
`packages/core/components/sections/`; the registry barrel
`registry/components/index.ts` (T11.2-deferred) rejoined its dir in core —
its 24 `.astro` imports are now intra-core; `src/components/admin-ui/**`
(23 files, W9 workspace) → `packages/core/admin/**`. Admin pages/layouts
import `@core/admin/*`.

**The site-shell seam (brief's "no core file may glob a site path"):** ALL
site coupling concentrated in exactly two render-entry files —
`PageObjectRenderer.astro` + `section-resolve-deps.ts` (astro:content +
permalinks + site-object + PageLayout/Footer) — plus `ObjectSections.astro`,
`CustomStyles.astro`, `EditMode.astro`. These STAY site-side as the shell
that loads site data and injects it into core (`ResolvePageDeps` was already
the injection seam by design). Recorded as the boundary interpretation of the
brief's "PageObjectRenderer moves" line, which would otherwise violate its
own no-globbing invariant. Both cms shells register the site providers ahead
of the `@core` barrel (bio.ts reads site identity at module load).

**Harness extension (disclosed):** the move exposed that `<astro-island uid>`
values are hashes of the component FILE PATH — the attribute-level twin of
the hashed chunk filenames `html-normalize` already collapses. 10 admin
shell pages differed ONLY in uid strings. Added `normalizeIslandUids`
(scoped to astro-island; add/remove/props/reorder still differ; uid on other
elements untouched) + 2 harness tests; build-diff then EMPTY — proving uids
were the only delta. Self-test still PASS.

Gates (step 2): check 0 errors, eslint+prettier clean; tests 1624/1624 +
67/67 (+16 harness incl. 2 new); build-diff vs step 1 EMPTY; self-test PASS.
Remaining: step 3 — function-factory pass + cli relocation (+ pages shells /
data-root seam with T11.5-T11.6's site.config work, where they naturally
compose).

## Session 2026-07-24 (T11.4 IN PROGRESS — step 1/3: pure .ts remainders into core; gated step-commits per the T9.24 precedent)

**T11.4 step 1 committed** (branch `claude/t11.4-core-extraction-renderer-admin`).
Moved (55 renames): `src/lib/{renderer,edit-mode}/**`, the `src/lib/admin/**`
remainder (clients, node-editor/renderer, review-ui, diffs, lock-manager…),
`article-object/render-nodes`, `article-content` remainder (input-bank +
tests), `richtext` remainder (prosemirror, render-html + tests), the
T11.2-deferred `contentSourceBody`/`contentSourceImportFormData`/
`publishArticleFromPayload`, and `src/utils/goTrueClient` →
`packages/core/lib/admin/goTrueClient.ts` (self-contained Identity client —
admin machinery). `src/lib` now holds ONLY the 2 frozen-path stubs + the
registry barrel (moves in step 2 with the components).

Seam fixes en route: `edit-mode/ui.ts` dropped its raw `mediaPolicyConfig`
import for `activeMediaPolicy()` (the T11.2 provider); provider registration
re-homed from moved libs to entry points; `object-review-ui.test` registers
the site bindings as a live-policy gate (carve-out); `taxonomy-lookup-guard`
source-scan path updated.

Gates (step 1): check 0 errors, eslint+prettier clean; tests **1624/1624 +
67/67**; build-diff vs T11.3 **EMPTY** (74 pages). Remaining T11.4 steps:
(2) components/PageObjectRenderer/canvas + admin-ui islands + pages shells +
the `src/data/site` loader seam + registry barrel; (3) the consolidated
function-factory pass + cli relocation.

## Session 2026-07-24 (T11.3 — core extraction: server layer + SiteBinding seam; NOTIFY row run at fable/xhigh)

**T11.3 DONE** (branch `claude/t11.3-core-extraction-server-layer`, on T11.2).
Executed at the row's assigned model (owner switched the session to fable for
it). `netlify/lib/**` (68 modules) now lives at `packages/core/server/lib/**`;
the **SiteBinding** seam is in (env-var NAMES never values, live per-call
reads, `PLATFORM_ENV_NAMES` chains pinned in order by test); Dr-Lurie's
binding at `src/config/site-binding.ts`; `object-store.ts` verb auth resolves
its secret through it. Adversarial set added
(`tests/netlify/site-binding.test.ts`): cross-binding isolation with live
rotation, fails-closed per binding, no shared store handles.

**Hard stop upheld — and a T11.2 breach corrected.** T11.2's batch rewrite had
touched 3 frozen files (import lines only). Restored to `main` bytes; their
exact import paths now carry single-purpose re-export shims (10 at
`netlify/lib/*`, 5 frozen-path stubs under `src/`), so the frozen set never
needs touching again. All four frozen functions + `mcp/save-json-blob-mcp/`
verified byte-identical to `main`.

**Recorded discrepancy (functions stay put this task):** the move-map's "MCP
factory" collides with the frozen legacy article MCP tools living INSIDE
`mcp.ts` — a factory split of that file is the redesign the hard stop forbids.
Function-body moves consolidate into T11.4's factory pass; the mcp split waits
for the legacy path's retirement. `mcp.ts` carries only mechanical import
rewrites (tool behavior test-pinned).

**Test-harness gap found & fixed (reaches back to T11.2):**
`tsconfig.test.json` never included `packages/core/**`, so ~193 co-located
tests moved in T11.2 had been silently dropped from every run since. Revived
(suite now 1624+67) — including `site-identity.test.ts`, kept as the drlurie
byte-compat gate (registers real site bindings; tests are carve-out exempt).
Five more pure modules pulled forward to core (display-name,
readiness-criteria, paragraphs, assert-reader-safe, variant).

**Gates:** `npm run check` 0 errors, eslint+prettier clean; `npm test`
**1624/1624 + 67/67**; `build-diff --base <T11.2>` **EMPTY** (74 pages
byte-identical); core purity verified (no app-code import escapes
`packages/core`). **Pending:** deployed-preview `/mcp` ping smoke (no deploy
access this session); binding threading for `deploy-status`/`save-artifact`/
`admin-get-blob-pdf` rides T11.4/T11.5. Landing still blocked on push access.

## Session 2026-07-24 (T11.2 — core extraction: schema + registries + grammar/validation + pure policy libs)

**T11.2 DONE** (branch `claude/t11.2-core-extraction-pure-libs`, stacked on the
lockfix). The pure-law layer now lives in `packages/core/` (88 `.ts` files);
Dr-Lurie builds + tests green against it; **build-diff EMPTY** (74 pages
byte-identical vs the pre-move base). 88 `git mv` renames (history preserved);
310 files changed total (moves + import rewrites).

**Moved to core:** all of `schema/**`; `lib/registry/**` (minus the renderer-glue
barrel `components/index.ts`); `lib/tracking/**`; `object-ids*`, `object-patch-
apply*`, `agents-naming*`, `approval-policy`, `creation-policy`, `media-policy`,
`site-identity*`, `template-instantiate`; plus the two pure schema deps
`richtext/rich-text-v1.ts` and `article-content/to-markdown.ts`.

**Alias ratified:** `@core/*` -> `packages/core/*`. `.astro`/`.tsx` use the
`@core` Vite alias; all `.ts` use relative `packages/core/...` (Node test-runtime
resolution — tsc doesn't rewrite path aliases). `tsconfig.test.json` include +
astro vite alias + tsconfig paths wired.

**Config-injection (behavior-identical).** Four core modules imported site
config (`approval`, `creation`, `media` policies + `site-identity`; the latter
two were discovered in execution, not named in the brief). Core now uses a
provider seam; the site registers all four in the new
`src/config/policy-bindings.ts`, imported for side effect at every entry that
reaches a singleton. No `packages/core` module imports `src/`/`netlify/`/site
config (verified).

**Boundary correction (move-map amended, per its re-verify clause).** The
brief's pure-lib slice had value-imports into T11.4 modules. DEFERRED to T11.4:
`registry/components/index.ts` (24 `.astro` imports; renderer glue),
`publishArticleFromPayload.ts` (`~/utils`), `contentSource{Body,ImportFormData}.ts`
(article-content). PULLED the two pure schema deps forward. Full rationale in
`w11-move-map.md` "T11.2 execution amendment".

**In-scope test fixes (moved-path references):** `tracking-loader.test.ts`
(loader entry path), `object-store-auth.test.ts` (mintId import-path assertion),
`csp-drift.test.ts` (repo-root marker was `src/lib/tracking`). Gates:
`npm run check` 0 errors / eslint+prettier clean; `npm test` 1473/1473 +
67/67; build-diff EMPTY.

**Landing status:** committed locally only — this session has **no push/PR
access** (read-only git proxy). The lockfix + T11.2 await push credentials to
land; both were delivered as patches / are on local branches.

## Session 2026-07-23 (W11 scaffold repair — package-lock out of sync with T11.1 workspaces; `main` was red)

**Discrepancy found and fixed (prerequisite to the W11 extraction wave).** The
T11.1 scaffold added `workspaces: ["packages/*", "sites/*"]` to `package.json`
plus the two placeholder manifests (`@drlurie/core`, `@drlurie/site-drlurie`)
but did NOT update `package-lock.json` in the same change (the T11.1 commit
body deferred its gates — "gates … to be run on apply"). Consequence: **every
CI job on `main` was failing at `npm ci`** ("Missing: @drlurie/core@0.0.0 from
lock file"), across all three jobs (`build`, `check`, `fleet`) — all run
`npm ci`. This blocks green CI on any W11 wave-chunk PR.

**Fix (this change):** `npm install` lock sync only — adds the root
`workspaces` array and the two workspace link/package entries to
`package-lock.json` (23 insertions, 0 deletions, **no dependency version
changes**). No source touched. Verified green on the synced tree: `npm run
check` (0 errors/0 warnings/4 pre-existing hints, eslint + prettier clean),
`npm test` (all suites pass), `node scripts/build-diff.mjs --self-test` PASS,
`node scripts/sync-site-seed.mjs --check` clean. So `main`'s only defect was
the lockfile; with this, the scaffold actually installs.

**Governance note:** landed as its own isolated repair commit (not bundled
into any queue task), per autonomous-run "land [missing scaffold pieces]
first" + "one task, one commit." Recorded here per E5. Does not advance the
queue; the next not-done row remains **T11.2**.

## Session 2026-07-23 (T11.0 checkpoint close — platform rulings + W9 completion gate)

**T11.0 is DONE.** Both gates verified against `main` (not docs):

- **Gate (a) — T9.24 legacy deletion landed.** Confirmed on `main` @ `5d74ad19`
  (PR #470; branch step-commits `eada6ed`/`3111f2a` squash-flattened in).
  ABSENT: `src/pages/admin/{publish,drafts,library,agent-admin}.astro`,
  `review/[draftId].astro`, `objects/[objectId].astro`,
  `src/components/admin/AdminNav.astro`,
  `netlify/functions/toggle-article-publish.ts` (+ the STEP-2 legacy MCP
  functions). `AdminShell` retained as the edited island
  `src/components/admin-ui/AdminShell.tsx`. HARD-STOP files intact/untouched:
  `netlify/functions/publish-article.ts`, `admin-workflow-lock.ts`.
  `mcp/save-json-blob-mcp/` retained in place per OQ-W11-6 (retired-not-
  extracted; must NOT enter `packages/core`).
- **Gate (b) — OQ-W11-1…6 rulings ratified** 2026-07-22, recorded in
  `11-platformization-plan.md` §6 + §6.1 (and
  `decisions/2026-07-22-platformization-and-capture-rulings.md`).

**Disposition:** closed under autonomous-run A1 async-review; **owner ratified
in-session (2026-07-23, "Close T11.0 now, then continue") — the 24h objection
window is waived by that instruction.** W11 extraction is unblocked; the next
not-done queue row is **T11.1** (`depends_on: T11.0`, satisfied here). The
"begin at T11.1" launch assumption was one row early: T11.0 had no closing
commit until this entry.

## Session 2026-07-23 (T9.24 legacy deletion + maintenance reskin; T9.25 records close-out; branch `claude/t9.24-legacy-deletion`)

**T9.24 is DONE.** The T9.23 sign-off below unblocked it; all three groups
landed as their own commits, each with importer-grep evidence in the commit
body, `npm run check` + `npm test` + `npm run build` green after every one,
off-limits files proven byte-untouched throughout.

- **STEP 1 (`eada6ed`)** — deleted `src/pages/admin/{publish,drafts,
library,agent-admin}.astro`, `review/[draftId].astro`,
  `objects/[objectId].astro`, and `src/components/admin/AdminNav.astro`;
  removed the 5-item "Legacy" nav group from `AdminShell`; removed the dead
  `/admin/review/*` and `/admin/objects/*` redirects from `netlify.toml`.
  `agent-admin.astro` (ChatKit) retired per **OQ-W9-1, Wolf 2026-07-23:
  RETIRE** — one chat system going forward, the in-house Agents hub.
  Every live route reference the grep turned up was repointed in the same
  commit: `AdminShell`'s Cmd-K "New chat" + Quick Actions, `edit-mode/ui.ts`'s
  fallback message, `kit.astro`'s AdminNav import (interim fix — STEP 3
  rewrites the file it briefly touched), a stray comment in `Header.astro`,
  doc comments in `approval-policy.ts`/`home-conversion-roundtrip.mjs`, and
  a live tool-response string in `product-set-price.ts` — all now point at
  `/admin/content/<id>` / `/admin/agents`. `npm run check` clean, `npm test`
  1705/1705, `npm run build` 73 pages (down from 79 — exactly the 6 deleted
  pages).
- **STEP 2 (`3111f2a`)** — deleted `admin-ask-ai-node.ts`,
  `get-article-for-edit.ts`, `admin-update-node.ts`, `admin-patch-workflow.ts`,
  `list-draft-articles.ts`, `admin-save-json-draft.ts`,
  `admin-get-json-draft.ts`, `admin-list-json-drafts.ts`,
  `toggle-article-publish.ts`, `create-chatkit-session.ts`, plus the orphaned
  `src/lib/admin/ai-suggestion.ts` (sole importer was the already-deleted
  `publish.astro`) and the 3 dedicated test files for the deleted functions.
  **The importer-grep discipline caught a real miss**: a first pass excluded
  `tests/` from one grep loop, so `tests/netlify/canonical-promotion-trust.test.ts`'s
  import of `handlePatchCanonicalInput` (from `admin-patch-workflow.ts`) only
  surfaced as a `npm run check` TS2307 error. Fixed surgically — removed
  only the affected import + its `describe` block, leaving that same file's
  off-limits `save-json-blob.ts` coverage (Stage 3.3/3.4) byte-for-byte
  untouched. All 9 functions' shared libs confirmed to have live importers
  outside this deleted set — none orphaned beyond `ai-suggestion.ts`.
  `npm test` 1619/1619 (the 19-test drop = 3 deleted test files + 2 removed
  cases from the surgical fix), `npm run build` 73 pages (unchanged —
  function deletions don't touch Astro output).
- **STEP 3 (`d62db1d`)** — `src/pages/admin/blobs.astro` (1200 lines of
  vanilla JS) rebuilt as `src/pages/admin/maintenance.astro` on
  AdminLayout/AdminShell: new `src/lib/admin/maintenance-client.ts` (typed
  wrappers over `admin-blob-manager`/`admin-blob-store-diagnostics`,
  mirroring `users-client.ts`) and `src/components/admin-ui/MaintenancePage.tsx`
  (Owner-gated the same way `AdminUsers.tsx` is — `fetchMe` →
  `roles.includes('owner')` — on top of the server-side Owner check T9.4
  already enforces on both functions; human-framed DataTable with a "Raw"
  tab in the Drawer for actual payloads; Danger Zone wipe-store/wipe-all
  behind `ConfirmDialog requireTyped`). `AdminShell`'s Maintenance nav entry
  lost `soon: true`. `npm run check` clean (fixed 4 real lint issues along
  the way: an unused import, 3 dead `react-hooks/exhaustive-deps` disable
  comments this project's eslint config doesn't register), `npm test`
  1619/1619, `npm run build` 73 pages (unchanged, 1:1 replacement).
  Playwright + curl confirmed all 7 deleted/renamed routes 404 and
  `/admin/maintenance` 200s; the signed-in-as-Owner render path couldn't be
  exercised in this sandbox (no real Identity credentials) — disclosed, not
  assumed.
- **Found, ruled out, not fixed:** `/admin/kit` throws React hydration
  errors (minified #418/#423/#425) under Playwright. A/B tested by
  temporarily restoring the exact pre-STEP-1 `kit.astro` + `AdminNav.astro`
  and rebuilding — identical errors reproduce with `AdminNav` present,
  proving this is a pre-existing `KitGallery.tsx` bug, not a regression from
  this task. Left alone; worth its own fix task.
- **Live production fix (MCP, not a git commit in these three):**
  `nav_header`'s admin-only dropdown still pointed at 5 routes this task
  deleted or renamed. Flagged to Wolf mid-task (a live object-store write is
  a different risk class than the git-scoped deletion work) —
  **Wolf: "Patch it live now."** Checked out, removed the Publish/Drafts
  items, relabeled Library → "Content library" (`/admin/content`),
  AI Publisher → "Agents" (`/admin/agents`), Blob Store → "Maintenance"
  (`/admin/maintenance`); published to `main` (`612cda1`, `[skip netlify]`).
  **`release_to_production` deliberately NOT called** — publish only moves
  the git export; the live site still serves the prior export until a
  release. `612cda1` has since been merged into this branch (`origin/main`
  was one commit ahead, no conflicts — this branch never touched
  `nav_header.json`). Wolf to decide when to release; nothing breaks in the
  meantime, the dead links would only 404.
- **Off-limits verification (all three groups + the merge):** `git diff
--stat` against `main` is empty for `netlify/functions/publish-article.ts`,
  `netlify/functions/admin-workflow-lock.ts`, and
  `netlify/functions/save-json-blob.ts` (its MCP surface included) — checked
  after every commit and re-checked after merging `origin/main` in. The
  `workflows` blob store's data was never touched (code paths only).
  `mcp/save-json-blob-mcp/` was not touched — explicitly out of this task's
  scope, deferred to the W11 window per the brief.

**T9.24 DONE.** T11.0's "verify T9.24 legacy deletion actually landed" gate
(flagged as untouched/still-owned-by-T11.0 in the 2026-07-22 platformization
session below) **is now satisfiable** — T9.24 is in git on this branch, PR
pending against `main`.

**T9.25 records close-out (this session, same branch):** this entry;
`docs/cms-architecture/10-admin-workspace-plan.md` (status flipped
PLANNED → SHIPPED, OQ-W9-1 and OQ-W9-5 resolved, §6 Retirements marked
DONE, the §2 AdminNav mention updated to past tense); `CLAUDE.md` (new
admin-surface pointer section); `docs/cms-architecture/07-canvas-editing.md`
(the W7.7-remainder ON HOLD ruling annotated: lifted by T9.19, closed by
T9.24); `docs/cms-architecture/cms-pipeline/queue.tsv` (W9-complete
comment).

## Session 2026-07-23 (T9.23 parity sign-off recorded; branch `claude/t9.24-legacy-deletion`)

**T9.23's retirement gate has passed.** Full drive:
`docs/cms-architecture/cms-pipeline/T9.23-parity-signoff-checklist.md`
(updated same commit — every row now ✅ checked or waived, in place of the
all-☐ PREPARED state it carried since 2026-07-19).

- **Rows 1–7: PASS.** Draft picker, title/lede editing, metadata
  (author/date/category — author closed by T9.23a below), tags/SEO/path,
  save-with-undo, per-node TipTap editing, and per-node Ask-AI word-diff all
  drive cleanly on the new `/admin/content`+canvas+workspace surfaces.
- **Rows 8–10: confirmed-present/waivable** on the strength of their prior
  credentialed builds and test coverage (T9.4 force-checkin + LockBanner;
  T9.21 readiness strip + publish-by-time) rather than a fresh live
  click-through session — the built surfaces and their tests stand as the
  evidence.
- **Row 11 — OQ-W9-5 RULED: retire without port.** Canonical-input
  promotion (the legacy `req_*` workflow concept) has no object-model
  analogue and needs none — `create_variant` lineage + Discard (history
  inverses) cover the intent. No canonical-input surface will be built on
  the object substrate.
- **The one gap the drive found (row 3, author) is CLOSED:** T9.23a added
  `content_item.author` (optional, ≤120 chars, plain text) end-to-end —
  schema, `set_article_meta` grammar, reader-safety leak-scan coverage, both
  editor surfaces (canvas panel + workspace Details drawer), an optional
  byline render, and `object_contract` discovery. Merged PR #469
  (`ebe2779`), `scripts/build-diff.mjs` empty (80/80 pages) since none of
  the 12 live articles carry one. A pre-existing (T9.20) dirty-tracking bug
  in the canvas Article-settings Save button (found while landing the
  author field) was fixed in the same PR.

**T9.24 (legacy deletion + maintenance reskin) is now unblocked** and runs
in this same branch, followed by T9.25 records close-out — each group's
commit prepends its own entry above this one as it lands.

## Session 2026-07-23 (T9.23a: content_item author field — the T9.23 parity gap closed; branch `claude/content-item-author-field-kgazza`)

Wolf's 2026-07-23 ruling: the legacy `/admin/publish` exposed an author; the
object model never carried one — add the field (not retire). This was the
sole gap the T9.23 parity drive found (row 3, author); T9.24 (legacy
deletion) was blocked on it landing.

**Scope — v1, deliberately minimal**, shipped end to end through the
governed substrate. No new patch op: `author` rides the existing
`set_article_meta` fields grammar generically, exactly like every other
article-settings scalar (slug/title/deck/description/taxonomy/seo).

- `src/schema/bodies/content-item-v1.ts` — `author?: string` (`.max(120)`),
  additive-optional, in the same public-settings envelope as slug/deck/
  description. Every existing record (none carry it) still parses.
- `src/schema/object-patch-ops.ts` — `set_article_meta`'s `.describe()` now
  names `author` alongside title/slug/taxonomy/seo/scores, for contract
  discoverability. No grammar change: the op already deep-merges any
  body-level field except `nodes`/`tracking`, and its inverse derivation
  (`derivePatchInverse`) is generic over the captured before/after tree —
  both already covered a new scalar field for free.
- `netlify/lib/object-validate.ts` — `contentItemReaderProjection` (the
  reader-safety leak scan specific to content_item) now includes `author`,
  because it is now a RENDERED field. Without this an agent could leak
  strategy vocabulary (`private`/`agentNotes`/…) through the byline
  undetected — the projection is a curated allowlist of what actually
  reaches readers, not the whole body. Length/plain-text bounds are the
  schema's `.max(120)`, enforced generically by the existing `checkSchema`
  pass at every patch/create/publish — no new validation code needed.
- Editor parity on BOTH surfaces (matching every other article-settings
  field, since T9.20 built them as two hand-kept-in-sync implementations):
  `src/lib/edit-mode/ui.ts` (canvas panel "Article settings" accordion —
  `renderArticleMetaForm`/`saveArticleMetaForm`) and
  `src/components/admin-ui/ObjectWorkspace.tsx` (`ArticleSettingsCard` in
  the "Details" drawer) — an Author input beside Slug/Category/Tags/SEO in
  both, saved through the same `set_article_meta`/EditSession path. The
  stale "author deliberately absent" comment in `ui.ts` is corrected.
- Render: `src/utils/blog.ts` (`loadArticleObjectPosts` now carries
  `article.author` onto the shared `Post.author` field — already declared
  on the `Post` type, previously populated only by the legacy `.md` path)
  - `src/components/blog/SinglePost.astro` (the article meta line renders
    `By <author>` between the date and category when set; renders nothing
    when absent — matches the existing typography exactly, no icon, no new
    layout).
- Tests (all new, all green): schema additive-parse + max-length bound, and
  reader-safety leak-scan coverage
  (`tests/netlify/content-item-object.test.ts`); a `set_article_meta`
  set/inverse round-trip on `author` through the real engine
  (`src/lib/object-patch-apply.test.ts`); `object_contract('content_item')`
  advertising `author` in `body_schema` and in `set_article_meta`'s
  description (`tests/netlify/object-contract.test.ts`).

**Verification:** `npm run check` (astro check 0 errors/0 warnings, eslint
clean, prettier clean) + `npm test` green — 1705 tests, 0 failures.
`scripts/build-diff.mjs` (working tree vs `HEAD`): **80/80 pages identical,
EMPTY DIFF** — none of the 12 live articles carry an author, so the
conditional byline moved zero pixels; this was the acceptance gate.

**Found, not fixed — flagged per CLAUDE.md rather than bundled in:** the
canvas panel's Article-settings Save-draft button has a dirty-state bug
predating this task. `serializeForm()` (`ui.ts`, the shared save-button
dirty tracker) queries only
`[data-em-field],[data-em-role-field],[data-em-nav-field]`; the Article
Settings form's inputs (slug/author/description/category/tags/seo) all
carry `[data-em-meta-field]` instead, which that selector never matches. So
`serializeForm()` always returns `''` for this form regardless of what's
typed, `saveBaseline` is also always `''`, and
`button.disabled = serializeForm() === saveBaseline` never flips false —
the Save button reads as permanently disabled in the CANVAS panel for every
Article-settings field, not just the new one (pre-existing since T9.20, not
introduced here). The workspace Details-drawer's save button
(`ObjectWorkspace.tsx`) has no such gate and is unaffected. Worth its own
fix task before T9.23's sign-off treats capability #3/#4 as proven on the
canvas surface specifically.

**Records (same commit):** `object-inventory.md` (content_item row) +
`conversion-map.md` (content_item attributes line) updated.

**T9.23a author field — the T9.23 parity gap closed; T9.24 unblocked
(pending the recorded sign-off).**

## Session 2026-07-22 (DOCS-ONLY: W11/W12 platformization + capture rulings propagation; branch `claude/platformization-rulings-propagate-p8ebha`)

No source or test changes. Propagated Wolf's 2026-07-22 rulings (OQ-W11-6,
the lint exit-bar carve-out, and the ratified OQ-W12-1/-2/-3) into the task
briefs, env table, and plan so W11/W12 start with a consistent work
breakdown. `npm run check` unaffected (docs only; check touches `src/**` +
`scripts/**`).

**Reconciliation note:** the propagation brief told me to cite a decision
record and read §6 ANSWER lines that did not exist in the repo (T11.0's
RATIFIED artifact was never committed). Since every deliverable cites that
record, I created it from Wolf's ruling text and filled §6 — this session
also stands in for T11.0's deliverable #2. T11.0's OTHER gate (verify T9.24
legacy deletion actually landed) is untouched and still owned by T11.0.

**Files touched:**

- ✚ `docs/cms-architecture/decisions/2026-07-22-platformization-and-capture-rulings.md`
  — new decision record (the citable authority): OQ-W11-1…6, the lint
  carve-out, OQ-W12-1…3, verbatim-in-intent + consequences.
- `docs/cms-architecture/11-platformization-plan.md` — §6 ANSWER lines +
  §6.1 RATIFIED block + new OQ-W11-6 bullet; §3.2 old authorization rule
  annotated **SUPERSEDED** (kept, struck) with the new per-project/
  contract-owned rule + the per-project governance/limits-block
  implementation pointer beside `contentContract`/`toolPolicies`/
  `publishingPolicy`.
- `cms-pipeline/T11.5-desite-hardcodes.md` — 2026-07-22 census folded into
  an explicit target list (EXTENDS §2.3): admin-UI hardcodes (Studio SITE_ID,
  ObjectWorkspace/ui.ts `tax_drlurie`, GovernancePage `trk_drlurie`),
  run-publisher-agent, track-ingest fallback, MCP server strings
  (`mcp.ts:121-122`), Favicons/bio kugelmedia, pdf-tool `projectId` (the
  SECOND tenancy axis), GitHub User-Agent, and the agent-facing example ids
  in `object-contract.ts`/`agent/tools.ts`/`mcp.ts` descriptions. Items 1–9
  marked **FRONT-LOADED — verify absent** (the `pre-W11 dehardcode (N/11)`
  work, PRs #466/#467); the tool-description example ids are the one
  **PENDING** item (~9 `drlurie` still live in `mcp.ts`; planned items 10–11
  never committed). Added the lint exit-bar carve-out (tests/ fixtures EXEMPT
  for v1) and the OQ-W11-6 `save-json-blob-mcp` "retire, don't extract" note.
- `cms-pipeline/T11.7-provisioning-cli.md` — replaced the illustrative env
  list with the REAL per-site env table (census of every
  `process.env.*`/`env.*`/`Netlify.env.get` read across `src/`+`netlify/`+
  `mcp/`; ~35 config vars), each classed per-site / fleet-shared / optional /
  platform-injected; shared with T11.10.
- `cms-pipeline/T12.1,T12.2,T12.4,T12.5,T12.6` — authorization language
  rewritten to the ratified OQ-W12-1 (per-project, contract-owned; model
  hard refusals the sole floor; no built-in ownership precondition); OQ-W12-2
  (coverage default, per-project overridable) and OQ-W12-3 (never-released
  drafts in the target project's own store; T12.1 spike local) reflected;
  per-project governance/limits-block seam pointer added to T12.1.
- `cms-pipeline/state-of-play.md` — this entry.

## Session 2026-07-20 B (W13 TAIL: T13.8→T13.10 — natives+CSP, sink kit, seeds+roundtrip; branch `claude/w13-natives-tail` off the merged #462)

PR #462 MERGED (`d8171295`, 8/8 checks); continuation on a fresh branch.

- **T13.8 (`d82ce433`)**: meta_pixel/taboola/outbrain/mgid adapters — all
  ALWAYS advertising-gated; mgid validates but never interpolates its id
  (dashboard-resolved; snippet/hosts flagged for re-verification at first
  enablement). `nativeCalls` bridge fan-in (provider-correct shapes,
  build-resolved values, dedupe), core fan-out as one consent-gated unit,
  and the fbq/\_tfa/obApi/\_mgq routing in the browser binding. The site's
  FIRST CSP: `Content-Security-Policy-Report-Only` in netlify.toml at the
  all-disabled baseline (promotion = T13.11 after a clean soak) with the
  hosts-drift test pinning script/connect/frame = baseline ∪ enabled
  adapters' cspHosts (reads src/data/site/tracking.json when it exists);
  drift fails BOTH directions. Loader pin 4.5→5KB (ceiling 6KB).
- **T13.9 (`8fb3a64e`)**: the owner-DB reference kit
  (`docs/cms-architecture/tracking-sink-reference/`): receiver contract
  (NDJSON + Bearer + fast 202, idempotent on event_id, additive-only),
  OQ-W13-6 env contract, the blessed strategy-join recipe; schema.sql
  (tracking_events UNIQUE event_id + 4 indexes + pg_notify trigger +
  node_strategy + worked query); `scripts/tracking-mirror-replay.mjs`
  (dry-run default, in-run dedupe, abort-on-non-202, idempotent re-run;
  6 unit tests; rehearsed against the local store).
- **T13.10 (this commit)**: `scripts/lib/tracking-config-seed-data.mjs` —
  the ratified trk_drlurie body (geo-adaptive; EEA-30+UK+CH ×32; GPC;
  banner copy; ALL pixels disabled; own enabled with the OQ-W13-6 env
  names; the §6 defaults matrix). Driver support: tracking_config drill
  (set_tracking_config_fields flip/flip-back), reconcile branch
  (deep-merge diff, trap-2 stray-nulling), SUPPORTED_SEED_TYPES. The
  set_tracking probe upgraded to the FULL set→mutate→unset drill; a
  ten-type engine test proves it byte-identical with exact inverses on
  every attribute-carrying type. Creation policy: the ruling's "seeds
  mint" got its name — `tracking_config: { agents:
['object-conversion-roundtrip'] }` (the conversion-factory driver IS the
  seed identity; casual agents stay excluded; flag for Wolf's veto).
  FOUND+FIXED en route: the loader gated section impressions on
  `collects('section','impression')` — a word NO schema-legal export can
  carry (the §6 matrix says `section_impression`); production section
  impressions could never have fired. Local rehearsal:
  `--seeds tracking-config-seed-data.mjs` all-green — created (the seed
  identity), drilled, validated, publish blocked at export_commit_failed
  (the expected sandbox signal), contract advertised≡exercised, inventory
  returns trk_drlurie.

- **T13.12 (`5414d701`)**: the OQ-W13-2 posture surface — a Tracking card
  atop the guardrails page (T9.15's override layer IS built, so the toggle
  variant): effective publish mode from the ACTIVE policy with provenance,
  the creation posture from the live creation policy (humans + the seed
  driver), Product beside it as the other pin, and an Owner-only quick
  flip writing an explicit per-type pin through the SAME audit-logged
  admin-governance override — no new write machinery. Pure view-model +
  5 tests incl. a source-level no-bespoke-endpoint guard.
- **T13.13 (`a9fe2740`)**: doc 12 §15 — the scores-feedback DESIGN
  (OQ-W13-5 commission, nothing implemented): `metric:<framework>`
  provenance with a required evidence base, the append-only
  `append_scores` transport recommendation (owner DB computes, agent
  submits through the governed grammar; automatic writers rejected until
  OQ-3), hard guard rules (no cascade, leak rule untouched, n_sessions
  floor, idempotent-by-refusal windows), lineage-family variant judging
  with the no-A/B honesty rule, core-frameworks/site-thresholds split.
  Ends with the OQ-W13-5b ANSWER line for Wolf.

**EVERY W13 auto row is now BUILT (T13.1–T13.10, T13.12, T13.13).
Remaining before the wave closes:** T13.11 ONLY (human_gate — env
provisioning per OQ-W13-6 + `--production --release` + live beacon
verification + the ten-type set_tracking MCP round-trip + the CSP
promotion call). Open ANSWER lines on Wolf: OQ-W8-1…4
(`composite-sections-decision.md`) and OQ-W13-5b (doc 12 §15).

## Session 2026-07-20 (POST-MERGE CONTINUATION: W10 tail T10.5→T10.8 + W13 consent/conversions T13.6→T13.7 — six commits on `claude/w10-mints-w13-consent`)

PR #461 (the session D/E bundle) MERGED to main (`3ecde204`); Wolf said
"continue" — new branch `claude/w10-mints-w13-consent` off merged main,
same cloud-sandbox delivery constraints (git bundle → Wolf fetch/push).
One task = one commit; every task gated on suite + check + build-diff.

- **T10.5 (`80e49a68`)**: mint batch 1 per the T10.4 ratification — `media`
  (image/video discriminated items; video FOLDED IN: provider enum
  youtube|vimeo, regex-pinned videoId re-asserted at render — the embed
  template throws on drift), `brand_row` (2–8 logos, nav-target hrefs
  resolved via the renderer seam), `stats` (2–6 bounded stat cells).
  Union 21→24; registry modules + components + editor hints + contract.
- **T10.6 (`ccc40980`)**: mint batch 2 — `timeline` (2–8 milestones),
  `comparison_table` (2–4 columns ≤12 rows, boolean-or-short-string cells)
  — union 24→26 — plus ALL FIVE ratified variant fields (hero.variant
  center|split|background with the center branch the untouched audited
  markup; cta_banner.compact; content_split.imageLayout stagger|stack;
  steps.columns 2|3|4; testimonial.layout single|wall + variant
  quote|pullquote). Every variant additive-optional: the exact pre-variant
  shapes still parse (mint-batch-2 test pins this).
- **T10.7 (`2f6ae2a8`)**: `composite-sections-decision.md` — the OQ-W8-1…4
  decision package, re-scored AFTER the mints: gate NOT cleanly cleared
  (bento + overlap genuine static-composition cases; the pricing toggle is
  interactivity §8 would not fix) → recommend composite STAYS GATED until
  W12 capture evidence; build-ready answers for W8-2/3/4 if Wolf overrides.
  Four ANSWER lines await Wolf. Docs only.
- **T10.8 (`de0e9ad6`)**: starter recipes — stpl_stats_band /
  stpl_expectations_timeline / stpl_comparison_matrix / stpl_media_gallery
  (brand_row skipped: no licensed logo assets) + `thm_editorial_airy`, the
  first theme variant carrying T10.1 axes (narrow/airy/soft/editorial).
  Found+fixed two stale driver gates: SUPPORTED_SEED_TYPES never admitted
  section_template/theme seeds, and the advertised≡exercised contract gate
  broke on W13's `set_tracking` (now a uniform tracking probe on EVERY
  family drill, byte-exact restore). Both local rehearsals all-green.
- **T13.6 (`91e13cbe`)**: consent per OQ-W13-1 — the runtime is ONE
  self-contained function serialized into the inline bootstrap (the page
  ships the very function the 22-test gate matrix executes): geo-adaptive/
  consent-first/us-first from one enum, unknown-region hold, oracle via
  sessionStorage→GET /api/t?mode=region, Intl heuristic keep-held-only,
  Consent Mode v2 denied defaults + redaction + url_passthrough BEFORE any
  vendor head, gated-script activation, GPC absolute (beats grant, blocks
  id), ad_personalization permanently denied (no TCF CMP). ConsentBanner
  is a code component (validated config copy, escaped; hidden until the
  runtime reveals; any `#privacy-choices` footer nav link re-opens it —
  document for the nav edit, zero code). Consented-id upgrade: `_dlid`
  minted only on analytics grant with GPC off, 13-month cap FIXED at mint,
  cleared on refusal; loader flips visitor mode consented/cookieless.
- **T13.7 (`750ddbb9`)**: the google_ads (always-gated,
  send_page_view:false) and ga4 (gated only as advertising class; manual
  page_view per pageLoad) adapters, the one-gtag.js-loader rule, and the
  §7 bridge in the loader core: (object_id, on) activity matching and
  trk:goal by-name matching → the own `goal` event (never sampled) plus
  declared provider conversions ONLY, under a released ads-consent state;
  product_price values build-resolved into the goal map; enhanced
  conversions OFF (asserted). v1 wiring: opt_in / contact_submit via a
  LOADER-owned submit listener on data-netlify forms (also the §6
  form_submit signal — exists only when a tracking export mounts the
  loader, so the inline opt-in capture stays byte-identical); purchase
  dispatched from the checkout success confirmation. Loader size pin
  4KB→4.5KB (documented in the test; ceiling 6KB unchanged).

**Verification at the chunk boundary:** suite **1608/1608 + 60/60**;
`npm run check` green; build-diff vs merged main: EMPTY for every task
except ONE RECORDED DEVIATION on T13.7 — `/shop/thank-you/index.html`
changed, inline-script-only (Astro inlines the hand-coded S1c page script;
rendered DOM byte-identical): the brief's own commissioned purchase
dispatch. All 79 other pages byte-identical.

**Waiting on Wolf/vreich:** (1) fetch + review + push the bundle (branch
`claude/w10-mints-w13-consent`, 7 commits incl. the records commit); (2)
the four OQ-W8 ANSWER lines in `composite-sections-decision.md`; (3)
standing human gates unchanged (T9.16 re-drive, T9.7, T9.23, T10.9
credentialed seed run, eventual T13.11 env provisioning per OQ-W13-6).
**Next in queue:** T13.8 (native adapters + CSP — auto/opus), T13.9
(owner-DB kit — auto/sonnet), T13.10 (tracking seeds + roundtrip —
auto/opus), T13.12/T13.13 (auto/opus).

## Session 2026-07-19 E (W13 CHUNK 1 BUILT: T13.1→T13.5 — tracking substrate code-complete to the render seam; T10.4 RATIFIED in-session; delivery via git bundle)

Continuation of session D (same Cowork cloud sandbox, same branch
`claude/w10-design-vocabulary`, same no-push/no-device-git constraints —
delivery is `.tmp/w10-w13-progress.bundle`, superseded by the final chunk
bundle). T10.4 rulings were collected interactively mid-session (recorded
in `design-vocabulary-gaps.md` §7, commit `132328ce`): five mints approved
(video folds into media), all five variants approved, axis set ratified
as shipped — **T10.5/T10.6 are unblocked**. Then the W13 lane per the
sequencing choice:

- **T13.1 (`6bb7446a`)**: the shared `tracking` attribute on all ten bodies
  - the uniform `set_tracking` op (one-writer funnel via forbidKeys ×7;
    whole-block captures — first-set/removal/merge all invert exactly);
    tracking_attribute criterion (§6 matrix via TRACKABLE_ACTIVITIES_BY_TYPE);
    contract constraint; leak tests extended to label/tags sentinels.
- **T13.2 (`82c7baa3`)**: `tracking_config` — the ELEVENTH governed type
  (trk_drlurie): fixed-key provider registry with regex-pinned IDs (GTM
  permanently unenables — OQ-W13-3), env-var-NAMES-never-URLs law, consent
  - defaults blocks; trk\_ ids; set_tracking_config_fields; engine-enforced
    per-site singleton (409); materializer → src/data/site/tracking.json +
    collection; creation {agents: []} (empty allowlist now LEGAL = humans/
    seeds only); publish AUTONOMOUS under the master (OQ-W13-2); full
    contract. NOTE: objectTypes now has ELEVEN members.
- **T13.3 (`3da00f7b`)**: tracking_event.v1 (client vs enriched shapes;
  commerce_event rules verbatim) + /api/t relay: per-event drop, props
  allowlist, id-grammar revalidation, daily vhash + 30-min shash (raw IP
  discarded by construction), pinned geo accessor (x-nf-geo JSON/base64 →
  x-country; city NEVER read), same-origin + token bucket, 2s no-retry
  sink forward (env names from the config's own block, OQ-W13-6 defaults),
  blob mirror (tracking-events store, replay-idempotent), region oracle.
- **T13.4 (`a69184ac`)**: the loader — DOM-thin core (impression-once +
  dwell, scroll buckets, visibility-aware engagement, read_progress/
  completion, batch/flush policy, sampling on impressions/dwell only,
  GPC-suppressed consent seam) + pure click classification + thin browser
  binding (VT-safe: astro:page-load only trigger, before-swap flush).
  SIZE BUDGET test: real esbuild bundle ≤4KB min+gzip (ceiling 6KB).
- **T13.5 (`8860496a`)**: TrackingScripts.astro render seam — Layout swap
  live and byte-invisible (no export exists → renders nothing; build-diff
  EMPTY is the proof), #trk-config assembly + goal map, consent-bootstrap
  skeleton, loader mounted as a real bundled script, own+plausible
  adapters with the write+render regex double enforcement (drifted ID
  FAILS THE BUILD); data-cms-track="off" at all three annotation sites;
  Analytics/Splitbee/config.yaml-analytics/@astrolib-analytics RETIRED
  (importers verified). Loader page context derives from the stamped
  data-cms-\* DOM.

**Verification at the chunk boundary:** suite **1562/1562 + 59/59**;
`npm run check` green; build-diff EMPTY (80/80) after EVERY task —
nothing here changes a public page until a tracking_config export exists
(T13.10 seeds / T13.11 drive). Every W13 mark through T13.5 is BUILT,
NOT CONVERTED (no store record — the five-criteria bar applies at T13.11).

**Honest gaps (next builder):** the TrackingScripts component itself is
tested through its pure halves + the build-diff gate; a fixture-export
dist assertion (post-astro-compress #trk-config parse) should ride
T13.10's seed roundtrip when a real export exists. The ingest function's
sink-config store read is cached 5 min and falls back to
TRACKING_SINK_URL/TOKEN env names on any failure.

**Waiting on Wolf/vreich:** (1) fetch + review + push the bundle
(`.tmp/w13-chunk1.bundle`, 14 commits, branch
`claude/w10-design-vocabulary`) — CI runs on your push; (2) the standing
human gates unchanged (T9.16 re-drive, T9.7, T9.23; now also the eventual
T13.11 env provisioning per OQ-W13-6); (3) local repo cleanup one-liner
from session D still applies. **Next in queue:** T13.6 (consent banner —
auto), T13.7 (google_ads bridge — auto), T13.8+ / or W10 T10.5–T10.6
(mints, now ratified) — both lanes open.

## Session 2026-07-19 D (W10 CHUNK 1: T10.1→T10.2→T10.3 built to the T10.4 checkpoint — token axes live in schema/render/verbs/contract; survey proposal awaiting ratification)

Task (vreich): "check where we are on the conversion trail and continue"
(both lanes chosen: W10 to the checkpoint, then W13 pulled forward per the
queue's reorder sanction). Session ran in a Cowork cloud sandbox with NO
GitHub push credential and NO device-git write path (the desktop mount
forbids unlink — git index.lock operations fail), so delivery is a **git
bundle** of branch `claude/w10-design-vocabulary` handed to Wolf to fetch,
review, push; CI runs on his push. One task = one commit throughout
(autonomous-run C3, adapted: bundle instead of self-merged PR).

- **T10.1 (`5650f695`)**: bounded layout/shape/type axes on brandTokens —
  additive-optional enum groups on the SHARED schema (theme inherits by
  identity); `THEME_AXES` registry in theme-tokens.ts is the one source of
  truth (schema enums derive from it; every value maps to a pre-built
  custom-property set — rule 6, values never reach the CSS grammar);
  tailwind.css tiers read `var(--dl-…, <old literal>)` with byte-equal
  fallbacks; CustomStyles emits vars ONLY for non-default axes. Defaults
  byte-identical BY CONSTRUCTION: build-diff EMPTY (80/80). 7 tests.
- **T10.2 (`9a6af92b`)**: axes governed — site_apply_theme exact-replace at
  axis-key granularity (theme axis → copied; absent axis/group → site axis
  UNSET, defaults win), dry_run reflects axes, privileged-op inverse
  restores pre-apply byte-exactly (tested); shared brand_token_axes
  validation criteria on theme AND site (invalid enum blocks with readable
  copy; unknown axis keys warn inert; colors-totality posture NOT extended
  to axes); contract constraint DERIVED from THEME_AXES on both types;
  reconcile still excludes brandTokens whole (axes covered, test extended).
  7 tests. Suite 1510/1510 + 59/59; build-diff EMPTY.
- **T10.3 (`5dc47545`)**: `design-vocabulary-gaps.md` — survey over three
  representative archetypes (Wolf named no reference targets; disclosed in
  the doc; nothing crawled). Proposal: 6 mints ×2 batches (media, brand_row,
  stats / timeline, comparison_table, video_embed with a fold-into-media
  toggle), 5 bounded variants, `type.measure` named as the one axis ADD
  candidate, 3 composite-evidence cases for T10.7. Ends with the OQ-W10-1/-2
  question block. Docs only.

**T10.4 checkpoint (next)**: rulings collected interactively this session
(Wolf present) instead of the async-review 24h window; recorded in
design-vocabulary-gaps.md as the RATIFIED section when answered.

**Waiting on Wolf/vreich:** (1) fetch + push the bundle (branch
`claude/w10-design-vocabulary`), CI + merge per house flow; (2) T10.4
rulings if not yet answered in-session; (3) the standing T9.16 re-drive /
T9.7 / T9.23 human gates (unchanged, see Session 2026-07-19 entries above);
(4) local repo cleanup: `rm -f .git/index.lock && git checkout main &&
git branch -D __wt_test && rm -rf _to_delete` (session probe leftovers).

## Session 2026-07-19 C (W13 RULINGS: OQ-W13-1…6 all answered — queue unblocked, T13.12/T13.13 added; docs only)

Task (vreich): walk the six OQ-W13 questions interactively and record the
rulings. All six answered 2026-07-19; recorded as dated GOVERNING
amendments in the 12 plan §13 (wave-local convention). Branch
`claude/object-tracking-strategy-jh76f4` (restarted from `bcab22e`),
merged to main same session per vreich's delivery choice.

**The rulings (full text in [`12-object-tracking-and-analytics.md`](../12-object-tracking-and-analytics.md) §13):**

1. **OQ-W13-1 RATIFIED as seeded** — geo-adaptive; restricted regions =
   EEA-30 + UK + CH; GPC global; unknown = hold. → **T13.6 flipped
   checkpoint→auto** in queue.tsv.
2. **OQ-W13-2 ANSWERED, supersedes the doc's recommendation** — publish
   autonomy is config-driven ("auto if configured in config"): ships
   **AUTONOMOUS** (no approval-policy override; master covers it);
   creation stays human/seed-only (`{agents: []}`); posture must surface
   as an **owner toggle in the admin UI** → **NEW T13.12** (rides the
   T9.15 override-layer outcome). Doc 12 §3 amended in place.
3. **OQ-W13-3 RATIFIED** — full adapter set (google_ads/ga4/meta/taboola/
   outbrain/mgid, all shipped disabled; plausible dormant); **GTM
   permanently OUT**. → **T13.7 flipped checkpoint→auto**.
4. **OQ-W13-4 RATIFIED (recommended bundle)** — mirror retention 90d
   (policy; enforcement = future cleanup script); no sampling at launch;
   geo country+subdivision, **city dropped at ingest**; GPC honored,
   legacy DNT ignored. (12-plan §5.2/§5.3 + T13.3 brief updated.)
5. **OQ-W13-5 BLESS BOTH** — the engagement×`private.strategy` owner-DB
   join is BLESSED (events carry node_id only), AND the scores-feedback
   design is commissioned → **NEW T13.13** (design-only; deliverable =
   doc 12 §15 appendix; implementation stays a later decision).
6. **OQ-W13-6 ANSWERED** — vreich provisions `TRACKING_SINK_URL`/`_TOKEN`/
   `TRACKING_SALT` in Netlify env **before the T13.11 drive**;
   tracking_event.v1 = additive-only, v2 dual-write; Postgres+pg_notify
   kit stands.

**Changes:** doc 12 (§0/§1/§3/§5.2/§5.3/§5.4/§12/§13 amendments); briefs
T13.2/T13.3/T13.6/T13.7/T13.10 updated with the rulings (T13.6/T13.7
headers now `mode: auto`); NEW briefs T13.12 + T13.13; queue.tsv: two
mode flips + two appended rows. **W13 is now fully unblocked through
T13.10** — the only remaining gates are the T13.11 human_gate drive and
its env provisioning. Session-B "Waiting on" items 1–2 are RESOLVED by
this session; item 3 (merge) executed same-day.

**Verification:** docs-only diff; `npm run check` + `npm test` green;
queue.tsv tab/5-column/path check green (13 W13 rows).

## Session 2026-07-19 B (W13 STRATEGY: object tracking & analytics — doc 12 + T13 briefs; docs only, nothing built)

Task (vreich): research + plan "tracking as an attribute of each existing
object" — all usual trackers (Google Ads + native ad platforms), an OWN
tracker preferred over Plausible (the owner runs a DB listening to
triggers), object-type-aware activity collection, a legal-but-aggressive
posture, and project-dependent config (Dr. Lurie = one of several
projects). Session decisions (vreich, recorded in the plan §0): this
session ships docs+briefs only · own-tracker ingest = first-party relay ·
consent = geo-adaptive · branch pushed, NO PR (house rule). Branch
`claude/object-tracking-strategy-jh76f4`.

- **NEW [`12-object-tracking-and-analytics.md`](../12-object-tracking-and-analytics.md)**
  — governing plan for W13. Core design: (1) a cross-type `tracking` body
  attribute on ALL TEN types (the recipe-metadata spread pattern;
  enabled/label/tags/goals; ONE uniform `set_tracking` op with exact
  inverses + a one-writer funnel via `forbidKeys` on the seven open fields
  ops — nav is already strict, taxonomy/section gain their first
  body-fields op); (2) `tracking_config` as the ELEVENTH governed type
  (`trk_drlurie`: fixed-key provider registry with regex-pinned IDs — the
  `checkBrandTokenValue` law extended to scripts: agents flip typed
  switches, never inject script/URLs; consent block; per-type collection
  matrix; export `src/data/site/tracking.json`; require-approval +
  human-executed publish recommended, OQ-W13-2); (3) the own first-party
  pipeline: ≤4KB loader riding the EXISTING `data-cms-*` identity
  attributes → batched sendBeacon → `/api/t` relay function →
  `tracking_event.v1` (commerce_event.v1 rules verbatim; server-stamped
  `project_id`; cookieless daily-hash identity, zero device storage) →
  owner DB (Postgres + `pg_notify` reference kit) with a Blobs mirror for
  replay; (4) vetted adapters (google_ads/ga4/meta/taboola/outbrain/mgid +
  a dormant plausible slot; GTM recommended OUT) firing conversions ONLY
  from per-object `tracking.goals`; (5) geo-adaptive consent (own tracker
  consent-free everywhere by cookieless design; pixels
  Consent-Mode-v2-gated in EEA/UK/CH, auto-fire elsewhere; GPC always
  wins). Leak rule preserved: `label`/`tags` never render (leak tests
  extend); events carry `node_id` only — engagement×strategy joins happen
  in the owner DB from exports (OQ-W13-5 asks the blessing). The plan §0
  records the AMENDMENT: this directive supersedes the 03 §1.7-6 /
  inventory "analytics stays config.yaml" exclusion.
- **Briefs + queue:** `T13.1`–`T13.11` committed (attribute → config type
  → event schema/ingest → loader → render seam → consent [checkpoint
  OQ-W13-1] → google_ads bridge [checkpoint OQ-W13-3] → natives+CSP-RO →
  owner-DB kit → seeds/roundtrip → human-gated production drive proving
  the five criteria for `tracking_config` AND a `set_tracking` round-trip
  on one object of each of the ten types). queue.tsv rows appended after
  W12 with the W11-sequencing note (whichever wave runs second rebases
  paths). OQ-W13-1…6 live wave-locally in the 12 plan §13 (the 06/08
  convention); 05 §3 carries the pointer addendum.
- **Records:** object-inventory (planned-type note under the types table +
  MVP TODO #7), conversion-map (W13 row). NOTHING BUILT — no schema, no
  store record, no render change; every W13 mark is ⚪ PLANNED, and the
  build is untouched.

**Waiting on Wolf/vreich (this session adds):**

1. **OQ-W13-1** (consent posture ratification: regions list, geo
   granularity — gates T13.6) and **OQ-W13-3** (provider set v1; GTM
   stays out? — gates T13.7).
2. **OQ-W13-2 / -4 / -5 / -6** (governance tier for `tracking_config`,
   retention/PII policy, the owner-DB strategy-join blessing, sink env
   provisioning) — record answers in the 12 plan §13.
3. Review/merge of `claude/object-tracking-strategy-jh76f4` (no PR opened
   — house rule; branch review requested instead).

## Session 2026-07-19 (PRODUCTION FIX: CMS Agents chat 400 on the opening tool-call turn — array-aliasing bug in the run loop)

Task (vreich): fix a production bug reported twice on prod (request_ids
`req_011CdBZxMCf8BLLwAMyy1lHC`, `req_011CdBa3eHhuvx4QdvfMxGBz`) — at
`/admin/agents` → **New article**, the Site Agent's opening move
(`get_contract` + `list_objects`, both parallel + `auto`) succeeds, then the
SECOND provider turn 400s: `messages.2.content.0: unexpected tool_use_id
found in tool_result blocks`. No ApprovalCard ever rendered, blocking step 1
of the T9.16 drive. Branch `claude/cms-agents-provider-crash-8gte1j`.

**Root cause (`netlify/lib/agent/loop.ts`):** `run.call_queue =
turn.toolCalls` assigned the SAME array reference already pushed onto the
transcript as the assistant message's `tool_calls`
(`run.transcript.push({..., tool_calls: turn.toolCalls})`). Draining
call_queue with `.shift()` — once per auto-executed / not-available /
parse-error call — mutates that shared array in place, silently erasing
tool_use entries from the PERSISTED assistant turn as each call resolves.
With 2 parallel auto calls, by the time both had run, the recorded assistant
message's `tool_calls` had been mutated down to `[]` while its two
tool_results still referenced the now-vanished ids — exactly Anthropic's
rejected shape (the "previous message" has no tool_use left to match).
Neither existing test caught it: `agent-chat-providers.test.ts` fed
`toAnthropicMessages` a hand-built, never-corrupted transcript (never
exercised `loop.ts`), and `agent-chat-protocol.test.ts`'s scripted adapter
ignored its `transcript` argument entirely (never exercised the real
Anthropic/OpenAI conversion) — the gap was in the seam between the two test
files, not inside either one.

**Fix (minimal, provider-neutral, no schema/protocol change):**

- `loop.ts`: clone on assignment — `run.call_queue = [...turn.toolCalls]` —
  so draining the queue can never mutate the transcript's recorded turn.
- `provider.ts`: both `toAnthropicMessages` and `toOpenAIMessages` now track
  the open tool_use/tool_call ids per assistant turn and THROW a clear,
  attributable error if a tool result doesn't match the immediately
  preceding assistant turn, instead of silently building a request the
  provider would reject with a cryptic 400 (both now exported for direct
  unit testing).
- Audited pause/resume (approve/deny) and the not-available/parse-error
  paths: all already preserve pairing correctly once the aliasing is broken
  (approve/deny use non-mutating `.filter()`; the shared-array bug was the
  only source of corruption across every path that touches `call_queue`).

**Tests added (each independently verified to fail pre-fix / pass post-fix
by temporarily reverting just that half of the fix and re-running):**

- `agent-chat-protocol.test.ts`: `runAgentLoop` end-to-end with 2 parallel
  auto `get_object` calls on the opening turn, capturing the transcript
  handed to the SECOND provider call and asserting both tool_use ids survive
  on the recorded assistant turn.
- `agent-chat-providers.test.ts`: a hand-built corrupted transcript
  (mirroring the real `get_contract`+`list_objects` shape) asserting
  `toAnthropicMessages`/`toOpenAIMessages` throw instead of building the
  doomed request (and that the adapters never even call `fetch`); a
  companion valid-shape test proves the same tool names still round-trip
  clean.
- Full suite: **1495/1495 + 59/59** (6 new tests over the last-recorded
  1489/1489); `npx eslint` + `npx prettier --check` clean on all four
  changed files (`loop.ts`, `provider.ts`, both test files).

**Honest gap — NOT re-driven live:** this sandbox has no deploy and no
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, so the fix is verified by exact
root-cause tracing against the reported transcript shape + the regression
tests above, NOT by a live `/admin/agents` → New article click-through. The
T9.16 drive's step 1 (get_contract + list_objects → `create_object`
ApprovalCard, no 400) should now clear on the real deploy; if it doesn't,
that's a NEW finding, not a reopening of this one.

**Standing:** the 47-converted-objects count and every Wolf ruling above are
unchanged — this is a runtime bug fix in the chat infrastructure, not an
object conversion.

## Session 2026-07-19 (W9 REMAINDER BUILT: T9.12→T9.13→T9.14→T9.17→T9.18→T9.26→T9.20→T9.21→T9.22 + both human-gate preps — the queue's outstanding work fished before W10; chat system code-complete, gates pending)

Task (vreich): "Work along queue.tsv. Before we get to the new client wide
phases i prefer to fish all that is outstanding or has been passed over."
Session model switched to Fable 5 for the `notify` rows (T9.12/T9.13 run
in-session at designated model per autonomous-run B2). Branch
`claude/queue-tsv-outstanding-wghuhd`; one task = one commit throughout.
**Everything below is code-complete and suite-proven; NOTHING here counts as
shipped until the T9.16 + T9.23 production drives pass (house convention).**

- **T9.12 spike (commit `9979b4f`)**: the chat-first premise proven —
  pause on an ask-gated tool call, persist to a blob event-log doc, resume on
  a later invocation with the stored call re-verified (args re-hash; client
  args never read on plain approve). 4/4 local proof against the real
  `handleObjectVerb`; forged resumes (wrong call_id / tampered args / token
  replay) 409; deny feeds a refusal; human-principal attribution + clean lock
  cycle. **Deploy-level timing NOT exercised** (branch has no deploy) — the
  ≥60 s pause acceptance rides the T9.16 drive; findings note
  (`T9.12-findings.md`) carries the validated design: single-doc event log,
  single-writer state machine (no CAS on Blobs), one-shot trigger tokens,
  provider-neutral transcript with stateless re-send, call_queue for
  multi-tool turns, caps, and the two recovery gaps (stuck-queued /
  stuck-running) T9.13 closed with stale-takeover. Spike files deleted by
  T9.13 (importer-grep clean).
- **T9.13 runtime (commit `0f64865`)**: `netlify/lib/agent/{chat-store,
profiles,provider,tools,loop,context}.ts` + `admin-agent-chat.ts`
  (create_chat/list_chats/get_chat?since_seq/send/approve_tool [with
  edit-and-approve, schema-revalidated]/deny_tool/cancel) +
  `admin-agent-chat-run-background.ts` (15-min hop, trigger-token gated).
  BOTH provider adapters v1 (OQ-W9-3): Anthropic (`claude-opus-4-8` seed
  default; no sampling params — 400 on Opus 4.7+; thinking omitted v1 so the
  neutral transcript round-trips; parallel tool_results merge into ONE user
  turn) and OpenAI (`gpt-5` seed; arguments JSON parsed defensively) — both
  behind one interface, provider/model from the resolved profile, NEVER
  hardcoded. §4 registry: reads auto; draft/creation/publication ask;
  creation + apply_theme dry-run-FIRST (server-computed preview rides the
  approval card); apply_theme Owner-gated AT EXECUTION independent of
  autonomy; patch ops constrained to the type's agent-authored contract ops;
  args zod-validated BEFORE any pause. Governance `chat_tools` consumed
  (T9.15's seam closed) + per-profile overrides; autonomy frozen per run.
  Every execution carries the SAME store validation context + policies as
  admin-object — no new write paths. Deps added: `@anthropic-ai/sdk@0.112`,
  `openai@6.48`. 18 protocol/conformance tests.
- **T9.14 chat UI (commit `d3d2cac`)**: chat primitives
  (`src/components/admin-ui/chat.tsx` — ChatThread/ToolCallCard/ApprovalCard
  with Approve / Edit-and-approve / Deny + dry-run verdict/AgentChip/
  ChatComposer with the readiness strip directly above + suggested prompts
  from missing criteria) + `useChat` since_seq polling (~1.2 s live / 5 s
  idle; "Waking the agent…" covers cold starts) + the LAYOUT FLIP: chat
  center, live preview right (refreshes on every accepted write), the T9.9
  inspector + History + Raw one click away in a Details drawer.
- **T9.17 hub (commit `f08e14d`)**: `/admin/agents` — session list with human
  titles + outcome chips (created/published/edited N, from run summaries),
  resume, four starters (article / page-from-template REUSE-FIRST / section
  template / Owner-only retheme). Creation tool_result events now carry the
  created object's id+type → one-click "Open <id>" into its workspace.
- **T9.18 studio (commit `e60bf4c`)**: `/admin/studio` — tpl/stpl/thm
  galleries with the REQUIRED metadata trio (tpl_fieldtest wears the visible
  "needs backfill (422 on patch)" badge); dry-run-first instantiate + apply
  flows; theme apply = dry-run token diff → typed APPLY confirm → real
  apply under a site checkout. **SECURITY FIX found en route: the verb core
  had NO owner gate on a human real `apply_theme`** (§8 matrix said
  "verb-level owner check") — added: humans need `owner` (403), dry_run open,
  AGENT principals byte-unchanged (W8.4 path preserved); +1 test, 12/12.
- **T9.26 roster (commit `e6b2cdc`)**: §4a closed — roster UI (Owner
  create/edit: name/provider/model/prompt/status; site-default + per-type
  assignment selects), per-object "Dedicated agent" selector in the
  workspace drawer, run records stamp the resolved profile (mid-run
  reassignment never switches — tested), and the canvas Ask-AI re-pointed
  through profile resolution: `ask-ai-object.ts` gained an Anthropic
  transport (forced tool_choice) beside OpenAI; hardcoded OPENAI_MODEL/
  gpt-4o gone from `admin-ask-ai-object.ts`. ALSO: `admin-agent-chat`'s
  front door now follows the T9.4 pattern (resolved ROLES, not env isAdmin)
  so invited store-tier admins can chat. +3 tests over real local stores.
- **T9.20 article settings (commit `489b47e`)**: canvas panel "Article
  settings" accordion (article panels only) + workspace-drawer parity card:
  slug (edit-time candidate-validate BEFORE the lock — collisions surface at
  edit, not publish), description, category select + tags datalist from the
  tax_drlurie REGISTRY object (novel terms flagged inline pre-publish), SEO
  description with counter — one `set_article_meta` op under EditSession.
  **Honesty notes for the T9.23 drive: 'author' has NO object-model field**
  (legacy frontmatter concept; row-3 decision left to Wolf) and 'date' =
  the publish timestamp (T9.21's option).
- **T9.21 tray finishers (commit `6161fcc`)**: per-row readiness gate (a
  validate round-trip must report eligible; blockers hold the button with
  the criterion text inline; validation-unreachable fails OPEN to the server
  gate), publish now / explicit-timestamp (`EditSession.publish(time?)`
  additive; OQ-2 honored — no scheduling/unpublish), and the `--dlem-*`
  token bridge: every VALUE resolves through `--adm-*` first, falling back
  to the original `--aw-*` chain on the public canvas (values only, zero
  selector change).
- **T9.22 publisher re-point (commit `51e9d2c`, closes W7.5)**: the
  5-agent workflow's final stage targets the object substrate —
  content_item create (article_body.v1 nodes pass VERBATIM, strategy
  annotations intact in private.\*) → taxonomy/SEO → validate with the live
  context → publish under the gate → checkin; release NOT fired. Publish-key
  callers act as agent `publisher-workflow`; admin sessions as the human.
  **`publish-article.ts` + `admin-workflow-lock.ts` byte-untouched (git
  diff empty); the legacy path receives ZERO writes — pinned by a
  source-level test.** Legacy overwrite semantics retired (slug uniqueness
  refuses). +3 tests incl. mocked GitHub committer end-to-end.
- **Human-gate preps (this commit)**: `T9.16-chat-drive-checklist.md` (8
  steps + the T9.12 deploy-level acceptance carried in) and
  `T9.23-parity-signoff-checklist.md` (§5's 11 rows as drive steps; OQ-W9-5
  slot). **Waiting on Wolf/vreich** — see "Waiting on" below.
- **Verification**: full suite **1489/1489 + 59/59**; `npm run check` green
  throughout; **build-diff vs branch base (`601b8ab`): all 70 public pages
  byte-identical** — the 8 diffs are `/admin/*` only (2 new pages + 6 admin
  pages the tasks deliberately changed), i.e. the public-EMPTY criterion
  holds exactly.

**Waiting on Wolf/vreich (ordered):**

1. **Merge + deploy this branch** (PR from
   `claude/queue-tsv-outstanding-wghuhd`), with `ANTHROPIC_API_KEY` present
   in Netlify env (OPENAI_API_KEY already there).
2. **T9.7 drive** — the RBAC credentialed verification (runbook committed
   2026-07-17) apparently still awaits its production run; it precedes the
   chat drive naturally.
3. **T9.16 drive** — the chat credentialed run (checklist above). Wave-exit
   record in this file.
4. **T9.23 sign-off** — the 11-row parity drive + the row-3 author ruling +
   OQ-W9-5. Unblocks T9.24 legacy deletion → T9.25 close-out (both auto).
5. Standing smaller items still open: `tpl_fieldtest` metadata backfill or
   retirement (now VISIBLE in the studio as a badge); the stale-queue wipe
   (operator-gated, checklist in the 07-19 artifact entry); OQ-W9-2/-4/-6/-7
   remain as recorded.

**Gotchas found this session (for the next builder):**

- Netlify checkout responses carry the token as top-level `lockToken`
  (`body.lock` is sanitized — never the token); guessing `lock.token` costs
  a debugging pass.
- `EditSession.lockState` is private — UI code doing raw verb composition
  (studio theme apply) should checkout via `callObjectVerb` directly.
- The eslint config has no react-hooks plugin — a
  `react-hooks/exhaustive-deps` disable comment is itself a lint ERROR.
- Astro page ↔ island name collision: a page named `studio.astro` cannot
  import a component named `Studio` (ts2440); alias the import.
- The publish gate resolves human roles via the SYNC env resolver inside
  `publish_by_time` — tests must set `ADMIN_EMAILS`, and the T9.4 async
  store-tier roles do NOT feed that gate yet (worth a look when the roles
  migration continues).

## Session 2026-07-19 (W10–W12 PLANNED: platformization pipeline — design vocabulary, multi-tenant core, site capture; docs only, no code, nothing converted)

Task (vreich): analyze the conversion roadmap, agents' template-creation range
toward multi-site cloning, and the multi-tenant path — then "formalize parts 2
and 3 to be able to run auto with flexible AI model allocation." Deliverables
on `claude/conversion-roadmap-cms-strategy-hgplp8`:

- **Plan doc:** `docs/cms-architecture/11-platformization-plan.md` — three
  waves, constitution unchanged (rules 1/5/6 stand; the plan widens BOUNDED
  surfaces and relocates code, never puts CSS/page-kinds/free layout in data):
  - **W10 design vocabulary** (parallel-safe with the W9 tail): bounded
    layout/shape/type token axes on `brandTokens` (byte-identical defaults);
    evidence-driven palette mints + bounded variants (survey → Wolf ratifies at
    the T10.4 checkpoint); composite decision package assembling the
    OQ-W8-1…4 evidence (memo only); starter-recipe refresh + T10.9
    credentialed run (all five criteria — no half measures).
  - **W11 platformization** (GATED on T9.24 + the T11.0 checkpoint):
    monorepo `packages/core` + `sites/<client>`; tenant boundary = one Netlify
    site per client (stores/creds/deploys isolated); de-hardcoding incl.
    per-site `tax_<site>` resolution in `taxonomy-enforcement.ts`
    (**`publish-article.ts` stays byte-untouched** — the legacy path remains
    drlurie-bound until its separate retirement); provisioning CLI
    (`create-site`); fleet CI matrix; schema-migration harness + merge gate;
    per-site governance + the minimal OQ-3 per-agent-credential slice
    (OQ-W11-5); T11.11 second-site acceptance proof (one core commit rebuilds
    both sites — the "canonical changes update all clients" property,
    demonstrated).
  - **W12 site capture** (authorized targets ONLY — owned/licensed/explicitly
    approved, blocking precondition in every brief): crawl → snapshot →
    decompose onto the section palette (+ palette-gap reports feeding the W10
    growth loop) → theme extraction quantized to the token surface → emission
    as DRAFTS through the governed verbs into the staging client → bounded
    fidelity loop scored against the OQ-W12-2 rubric → T12.6 Wolf sign-off.
- **28 briefs** (`T10.1`–`T12.6`) + queue.tsv rows appended after T9.25.
  Runner semantics: W9 remainder runs first by default; W10 rows may be moved
  ahead (reordering queue.tsv IS the scheduler); modes — `auto` default,
  `notify` on security-boundary/Fable tasks (T11.3/5/9/10, T12.1/2),
  `checkpoint` T10.4 + T11.0 (T11.0 also verifies T9.24 actually landed),
  `human_gate` T10.9/T11.11/T12.6. **Flexible model allocation = the queue's
  per-row model/effort columns** (fable/opus/sonnet ladder per the W9
  convention; plan §4 records the reallocation + budget-cap rules).
- **OQs for Wolf (plan §6):** OQ-W10-1…3 (mint list, token axes, composite),
  OQ-W11-1…5 (repo strategy, exports location, per-site admin, tenant
  boundary, OQ-3 scope), OQ-W12-1…3 (capture authorization rule, fidelity
  bar, pre-W11 landing zone).
- **Noted en route:** the 2026-07-17 W9 merges (PRs #454/#455 — T9.1–T9.11,
  T9.15, T9.19 built) have no state-of-play entries yet; per the W9 plan,
  records concentrate at T9.25 — flagged here so the log's silence isn't
  misread as "W9 not started." The strategy analysis itself (roadmap position,
  the full deferred/open register, coupling inventory) was delivered in the
  session conversation and is condensed into the plan doc's premises.

## Session 2026-07-19 (artifact-publishing hardening: CMS-Agent ↔ Dr-Lurie ↔ pdf-tool triangle)

Task (vreich): analyze the artifact-production/publishing triangle (CMS-Agent
MCP orchestrator, this repo's Dr_Lurie MCP, pdf-tool) and make image/PDF
publishing smooth and bug-free. Branch
`claude/cms-agent-artifacts-publishing-12g3tk`. Live-state evidence gathered
first: 10 failed queue records (2026-06-30..07-02 smokes) triaged into six
failure classes (post-publish 404 / pdf-tool 429 / ×4 canonical-input trust
rejections / ×2 "PDF template not found" / self-referential URL 422 / PDF
media entry 422); CMS-Agent's dr-lurie project is read-only allowlist +
`publishEnabled=false`; both external MCP legs showed >60 s cold starts.
User-ratified decisions: the OBJECT path (`content_item` → `object_publish` →
`release_to_production`) is the canonical artifact route; legacy stays frozen.

- **Fix 1 — release truth signal (SHIPPED).** `released:true` used to mean "a
  ready deploy exists for the commit", which under locked Netlify Auto
  Publishing can be a ready-but-unpublished deploy (the documented
  `production-release.ts` risk; failure class 1's ambiguity).
  `releaseToProduction` now consults `getPublishedProductionDeploy` (the same
  authoritative signal `verify_article_images` adopted on 07-16): published
  commit match ⇒ `released:true` + `productionConfirmed:true` (published wins
  even if the receipt poll never saw ready); ready-but-unpublished ⇒ new status
  `build_ready_not_published` with unlock guidance; site lookup unavailable ⇒
  prior ready-by-commit behavior with `productionConfirmed:false` ("not
  independently proven live"). `deploy_status` additively returns
  `publishedDeploy` + `productionConfirmed` (absent = unknown, never "not
  live"); both tool descriptions now teach "poll until ready AND
  productionConfirmed". (`netlify/lib/production-release.ts`,
  `netlify/functions/deploy-status.ts`, mcp.ts descriptions; +4
  production-release tests, +3 new `deploy-status.test.ts`.)

- **Fix 3 — object-path artifact EXISTENCE trust (SHIPPED).** The object path's
  `*AssetRef`/`fulfillment.artifact_ref` checks ran shape-only in production —
  `trustedAssetRefs` had no writer, so a typo'd sha or soft-deleted artifact
  published clean and 404'd live. `buildStoreValidationContext` now accepts the
  artifact-index store + the raw request payload, sweeps payload + every loaded
  record body for Major-Key refs (raw or `/img|/pdf` public-path form,
  normalized via the new `rawArtifactRefForPublicPath`), pre-resolves exactly
  those against the index (one `readArtifactReference` each; ≤200/write), and
  exposes a sync `resolveArtifactRef` (exists/deleted/sizeBytes/contentType).
  `validateAssetRef` consults it when no `trustedAssetRefs` set is injected:
  absent/deleted artifacts BLOCK at publish and WARN while drafting (an agent
  mid-assembly may upload next); shape/trust problems still always block; index
  unavailable degrades to "not verified" — never a failed write. Trust unit is
  EXISTENCE, not same-request (canvas uploads legitimately cross requests).
  Wired in `object-store.ts` + `admin-object.ts`. ALSO: class-3 replay
  regression — the four 06-30..07-02 failed-record shapes (node
  `public_media_src`, `promote_publish_payload.featuredImage`,
  `mediaEntries[].src`, `artifactReferences[].blobKey`, index-trusted but NOT
  in agent_outputs, real sha) now pinned green against `patch_canonical_input`
  (`tests/netlify/canonical-input-trust-replay.test.ts`) — confirming #327
  holds for every shape that actually failed. (`netlify/lib/artifact-trust.ts` +`PUBLIC_ARTIFACT_PATH_RE`/inverse, `object-validation-context.ts`,
  `object-validate.ts`, both entry functions; +9 tests.)

- **Fix 2 — content_item media path + hero rules (SHIPPED; bug ② closed on the
  object path).** Node media srcs were schema-unconstrained strings: a mistyped
  path 404'd live, and a PDF in the hero (`body.image.src`) would reach Astro's
  getImage at build — the object-path analogue of the legacy
  PDF-as-featuredImage bug. New `article_media` criterion (structure group):
  image media/`images[]` srcs take the `/img/{id}/{sha}.{ext}` public path and
  document media + `/pdf/` ctaLinks take `/pdf/{id}/{sha}.pdf` — both
  EXISTENCE-checked through Fix 3's `resolveArtifactRef` (absent/deleted →
  publish blocker, draft warning); remote https and site-static paths WARN
  (renderable but ungoverned — remote warn-vs-block flagged for Wolf); data
  URIs, legacy `src/assets/` paths, and bare relative paths BLOCK; the hero
  must be an IMAGE — `/pdf/`/.pdf there blocks with the build-breaker message.
  video/audio/embed srcs stay out of scope until they render richer than a
  link. Renderer unchanged (document→honest link is the sanctioned rendering;
  now pinned by a render-matrix test). `object_contract("content_item")` gained
  image/PDF `auxiliary_inputs` rows (grant-first flow, public-path rule,
  never-a-PDF-hero), and the stale `create_artifact_upload_intent` hints on
  \*AssetRef/product-fulfillment guidance now point at the storage-grant path.
  (`netlify/lib/object-validate.ts`, `src/lib/registry/object-contract.ts`;
  +6 validation tests, +1 renderer test.)

- **Fix 4 — publish receipt carries the live article URL (SHIPPED).** A
  content_item `object_publish` now returns `article_path: "/<slug>"` (the blog
  permalink pattern, proven by /object-model-demo), and the MCP wrapper's
  `production` block adds `verify_after_release` — the exact deploy_status
  (ready AND productionConfirmed) → `verify_article_images {url,
expectedImages: [/img/... node paths], commit}` follow-up — so agents verify
  the real URL instead of guessing routes (the post-publish-404 class).
  `verify_article_images`' description now distinguishes legacy display-path
  matching from object-article `/img/` exact matching.
  (`netlify/lib/object-publish.ts`, mcp.ts; +1 test.)

- **Fix 5 — image byte budget surfaced at validation (SHIPPED).** The 150 KB
  webp budget rode the grant and object_contract but nothing on the write path
  surfaced an over-budget artifact (a default 1024×1024 PNG ships ~10× over,
  silently). New `media_budget` criterion (artifact_trust group): every
  resolved image ref (`/img/` path or raw `image/` Major Key) with
  `sizeBytes` over `activeMediaPolicy().maxImageBytes` reports — severity
  follows the committed policy (`overBudget:'warn'` → warning;
  flipping to `'block'` makes it a publish blocker with zero code). Over-budget
  only — format stays generation guidance, so existing .jpg canvas uploads
  don't nag. (`netlify/lib/object-validate.ts`; +2 tests. External half —
  pdf-tool defaulting generation to the grant `limits` — goes in the Track 2
  contract doc.)

- **Fix 7 — CI hardening (SHIPPED).** Node 20 added to the build matrix
  (Netlify production builds on 20 via netlify.toml; CI only exercised 22/24 —
  a Node-20-only failure shipped uncaught). The check job now runs the
  site-seed drift guard (`sync-site-seed.mjs --check`) and the T2.0 build-diff
  harness self-test. FOUND EN ROUTE: the self-test itself had rotted — its
  planted needle ("Five simple places to begin.") no longer exists since
  index.astro became a thin PageObjectRenderer loader; re-pointed at the
  page_home EXPORT copy (the string that actually reaches rendered HTML),
  self-test 2/2 PASS again. (`.github/workflows/actions.yaml`,
  `scripts/build-diff.mjs`.)

- **E2E ARTIFACT DRILL — FULL LIVE PROOF (2026-07-19, session MCP connection;
  the drill ran against the DEPLOYED server — this branch's fixes ship with
  the PR and are proven by the local suite meanwhile).** Modes A→B→C:
  **(A)** grant fetched → pdf-tool `list_pdf_templates` preflight (11
  templates, 4 active — failure-class 4 was remediated 2026-06-30, the
  `smoke-symptom-worksheet-v1` template landed minutes after the smokes
  failed) → image job (gpt-image-1, webp, **50,372 bytes — under the 150 KB
  budget**) + PDF job (pdfme, 9,506 bytes, 1 page A4) both complete →
  `verify_agent_artifact` **5/5 checks** on both → both visible in
  `list_artifacts_for_request req_artifact_drill_20260719_01` →
  `object_validate` candidate patch on the demo article **eligible:true**;
  negative probe (raw Major Key in `media.src`) correctly REFUSED by the
  deployed `render_image_ref` check. **(B)** checkout → patch (two nodes:
  `n_demoartifacts` image + `n_demoworksheet` PDF CTA; rev 15, ready) →
  `object_publish` → commit `3cea365` dark (`deploy_status` showed NO deploy —
  the [skip netlify] deferral held) → checkin. **(C)** `release_to_production
{commit}` — the MCP response was LOST to a proxy 502, and the
  state-check-first discipline (deploy_status BEFORE any retry) proved the
  hook HAD fired: production-context deploy `6a5cb1c4…` ready in 38 s, no
  duplicate build wasted. `verify_article_images` → **verified:true,
  deployReady:true**, all three `/img/` exact-matched and fetching 200
  `image/*`; the `/pdf/` worksheet URL serves **200** from production; the
  released export carries both nodes byte-exact. The demo article at
  `/object-model-demo` now demonstrates agent-produced binary artifacts
  end-to-end. Cold-start note: two 60 s first-call timeouts (CMS-Agent
  registration read; one object_validate under a concurrent pair) — both
  succeeded on single retry; keepalive recommendation stands.

- **Stale-queue disposition (Fix 6) — BLOCKED ON OPERATOR, documented.** The
  60 stale workflow records (50 pending pre-W7 drafts of wiped articles + 10
  failed June-smoke evidence) should be wiped via `wipe_blob_stores
{prefixes:['workflows/']}` (dry-run → review sampleKeys → confirm
  WIPE_BLOBS). The session connection CANNOT run it — the tool answered
  "Unauthorized: a valid server publish key is required" even on dry-run —
  so deletion stays operator-gated. Fixture payloads for the four class-3
  failure shapes were extracted FIRST and are pinned as committed regression
  tests (`canonical-input-trust-replay.test.ts`), so the wipe loses no
  evidence. Operator checklist: (1) dry-run, (2) confirm the sampleKeys are
  all `workflows/…`, (3) live run with `confirm:"WIPE_BLOBS"`, (4) note the
  count here.

## Session 2026-07-16 (publishing-backend hardening: article_body-only canonical input, grant-only artifacts, deploy-aware verification, extended live-publish approval pin)

Task (vreich): "implement the Dr. Lurie publishing backend changes needed for
live-ready article publishing" — six requirements, on branch
`claude/dr-lurie-publishing-backend-rs22da`. **Scope choice under the governing
freeze**: `publish-article.ts` + `admin-workflow-lock.ts` stayed OFF-LIMITS and
no Wolf ruling was reversed. Enforcement was added at the TOUCHABLE
MCP/canonical boundaries — additive + default-off — so the frozen fallbacks
become UNREACHABLE rather than edited. The two aggressive options (unfreeze
publish-article.ts to gate its direct-HTTP markdown/URL fallbacks; flip
`content_item` to require-approval) were deliberately NOT taken — each needs
Wolf sign-off (the W7.5 unlock; OQ-W7-4).

- **Goal 6 — deploy-aware image verification (SHIPPED).** `verify_article_images`
  takes an optional `commit`: it correlates to that commit's Netlify deploy
  (reusing `pollDeployReceipt`/`getDeployReceiptByCommit`) and runs image
  assertions ONLY once the deploy is confirmed ready. A page served by a
  stale/previous deploy is now `inconclusive` (deploy timing) or carries a
  build-failure note — never a false `verified:false` missing-image defect;
  `deployReady:true` ⇒ definitive. Degrades gracefully (`deployAware:false`)
  when deploy lookup is unconfigured; no-`commit` callers are byte-identical.
  (`netlify/functions/verify-article-images.ts`, mcp.ts tool schema+wrapper; +5 tests.)

- **Goals 2+3 — grant-only artifact transfer (SHIPPED, partial).** Closed the
  one reachable publish leak: `buildCanonicalPublishPayload` now derives
  featured-image candidates ONLY from request-scoped artifact pointers
  (`parseArtifactPointer` gate) — a remote URL / data URI / repo path in
  `image_asset_register` / `image_sets` / node media src can no longer be
  promoted to the committed frontmatter image. Trust-gate rejection copy
  (`artifact-trust.ts`) now points agents at `get_pdf_tool_storage_grant`, not
  the legacy upload tools. **DEFERRED (OQ-W7-1-authorized follow-up)**: globally
  removing `save_artifact` / `create_artifact_from_url` /
  `create_artifact_upload_intent` from tools/list — a deep deletion cascade in
  the frozen-adjacent mcp.ts, not undertaken without scope confirmation. Literal
  req-3 ("publishing code must not use them as fallbacks") is satisfied: the
  canonical publish path never invokes them and no longer trusts remote
  URLs/repo paths. (mcp.ts, artifact-trust.ts; publish-by-time-media +
  canonical-promotion-trust tests updated to the secure behavior.)

- **Goal 1 — article_body.v1 as the only canonical content path (SHIPPED).** The
  governed MCP publish boundary already required article_body.v1
  (`validateCanonicalArticleBody`) and emits only article_body
  (`buildCanonicalPublishPayload` never sets markdown/content). ADDED a
  fail-closed guard: a competing legacy prose blob (`content.blocks` /
  `content.structure.sections`) carried alongside article_body is rejected at
  publish (`error_code: competing_non_canonical_body`). Markdown stays an
  export-only adapter (`to-markdown.ts`). Remaining markdown-input doors — the
  frozen `publish-article.ts` direct-HTTP fallback and `run-publisher-agent`'s
  LLM conversion — are frozen-path follow-ups. (mcp.ts; +1 test.)

- **Goals 4+5 — extended live-publish approval pin + batchable release (SHIPPED,
  default-off).** The approval decision may now additionally pin the exact
  content-item/request id, artifact set, and release/build behavior
  (`object-record-v1.ts` reviewStateSchema.decisions.`approval_pin`;
  `review-state.ts` `approvalPinSchema`). The publish gate (`publish-gate.ts`)
  enforces them for AGENT execution on a gated type — `request_id` vs
  `record.object_id` always; `artifact_set`/`release_build` when the publish
  declares them — with new denial codes; humans with publish authority stay
  unbound (C§2.2). Settable via `object_review_decide` (mcp.ts + object-verbs.ts).
  **DEFAULT-OFF**: committed policy stays all-autonomous (product-gated), so
  OQ-W7-4 (articles autonomous) is preserved — turning on live-gated article
  publish is a one-line `content_item: 'require-approval'` flip plus (for the
  legacy WorkflowRecord article path) wiring the gate in, a frozen-path
  follow-up. Release/build is already explicit + batchable (object exports carry
  `[skip netlify]`; one release = one deploy; batch via one `trigger_netlify_build`)
  — the new `release_build` pin makes that behavior part of the approval. (+6 gate tests.)

- **Post-review hardening (Codex P2 ×2 on PR #452)**: (a) wired `artifact_set` +
  `release_build` through `object_publish` → object-verbs → gate, so an approval
  that pins them is SATISFIABLE (the agent declares them on the publish) instead
  of bricking the object with `publish_artifact_set_required`; (b)
  `verify_article_images` now treats the site's PUBLISHED production deploy as the
  source of truth for `deployReady` (new `getPublishedProductionDeploy`), so a
  ready-but-unpublished build under locked Auto Publishing (or a ready deploy
  preview) is inconclusive, never a false missing-image defect. (+3 tests.)
- **Gates**: `npm test` 1327 + 59 green; eslint clean on every touched file;
  prettier clean. No frozen file edited; no default behavior reversed.

## Session 2026-07-16 (W9 PLANNED: admin workspace overhaul — the chat-first admin conversion; docs only, no code, nothing converted)

Wolf's direct mandate: overhaul the admin UX ("consistent, logical and user
friendly … no more naked ref numbers … AI communication exchange front and
center for every object … at least two levels of admin rights"). This is the
admin-area rethink the W7.7 hold and the "ignore the old admin editor" ruling
were waiting on.

- **Plan doc:** `docs/cms-architecture/10-admin-workspace-plan.md` (09- was
  taken by the template-system plan). Vision: chat-first per object with the
  classic form UI as the always-available second option; names-never-refs;
  one design language; guardrails visible/adjustable with enforcement
  server-side; **no new write paths** (everything through `handleObjectVerb`).
- **Decisions taken by Wolf at commissioning (session Q&A):** deliverable =
  plan + briefs (this session); UI stack = **React islands scoped to
  /admin only** (public site + canvas stay vanilla; byte-identical public
  build is T9.1's gate); CMS Agents = **in-house agent endpoint** (background
  fn loop, tools over the object verbs, runs under the signed-in human's
  Principal, HITL approval cards); roles = **two tiers, Owner + Admin** (new
  `users` blob store; `ADMIN_EMAILS` stays the permanent bootstrap-Owner
  fallback — lockout structurally impossible).
- **Task pipeline:** 25 briefs `cms-pipeline/T9.1-*.md` … `T9.25-*.md` +
  queue.tsv rows (T9.12 spike pulled forward — it de-risks the
  pause/resume-approval mechanic the whole chat design stands on). Waves:
  foundations → RBAC → workspace forms parity → chat → hub/studio → canvas
  ports (T9.19 formally lifts the W7.7 hold) → retirement (gated on Wolf's
  T9.23 parity drive over the 11-capability port table; only then do
  /admin/publish, drafts, library, review, objects + their functions get
  deleted; blobs reskins to Owner-only /admin/maintenance).
- **Model ladder** (Wolf 2026-07-16: Fable/Opus budget not a constraint):
  Fable on security boundaries + hardest generative tasks (T9.2 kit, T9.4
  roles, T9.9 generated inspector, T9.12/13 chat runtime, T9.15 governance,
  T9.19 canvas edit); Opus on substantial product UI/integration; Sonnet on
  mechanical/prep. Recorded in the plan §9.
- **SAME-DAY AMENDMENT (Wolf):** (1) both Anthropic AND OpenAI are current
  providers and the provider **must be settable** — OQ-W9-3 RESOLVED; both
  adapters are v1 in T9.13, provider/model live on the agent profile, never
  hardcoded. (2) **Dedicated per-object agents**: an object may have its own
  agent and an admin changing that object is ALWAYS connected to it — new
  plan §4a (agent profiles + `agent-profiles` store + object → type →
  site-default resolution, stamped per run), runtime half in T9.13, roster/
  assignment UI + canvas Ask-AI re-point in NEW task **T9.26** (queued after
  T9.18, opus/medium). 26 briefs total now.
- **OQ-W9-1…8 await Wolf, minus resolved -3** (plan §11): ChatKit fate;
  runtime guardrail-override store vs commit-only (gates T9.15 — checkpoint
  mode); third visible tier; canonical-input retirement; unpublish stance;
  human-Principal-only chat; Owner force-checkin.
- Off-limits files untouched and stay so per the briefs
  (`admin-workflow-lock.ts`, `publish-article.ts`, article MCP tools —
  T9.22 re-points only their CALLER, closing W7.5).

## Session 2026-07-15 E (site seed resynced to production: scripts/sync-site-seed.mjs + a drift-guard test — the do-not-reconcile caveat is closed)

Wolf: "script for site-seed-data.mjs." Closed the last standing follow-up from
the palette incident — `site-seed-data.mjs` was stale on name / logo.text /
metadataDefaults (the live "Skincare" rebrand postdated the seed), so a
site-family reconcile would have rolled the live branding back to the seed.

- **`scripts/sync-site-seed.mjs`** (NEW): rewrites the seed's `siteBody` from
  the COMMITTED production export (`src/data/site/site.json`, the released
  materialization — no credentials, deterministic). MINIMAL diff: unchanged
  fields (brandTokens/urls/chrome/nav/blog) are kept verbatim in the seed's
  readable order; only the drifted fields take the export's value. `--check`
  mode reports drift and exits 1 (CI-friendly); default writes; idempotent.
- **Ran it**: name → "Dr. Lurié Skincare", logo.text → "DR. LURIÉ SKINCARE",
  metadataDefaults → the live titleTemplate + description. seed === production
  verified (order-independent). Seed header comment updated: it now tracks the
  released export via the sync script, not the original hardcoded literals.
- **Drift guard**: `site-seed.test.ts` gains a test asserting the seed
  deep-equals the committed export (fails with "run scripts/sync-site-seed.mjs"
  if they diverge) — exactly the check that would have caught the original
  drift. This closes the do-not-reconcile-the-site-family caveat Codex flagged;
  the site family is safe to reconcile again.
- Note: brandTokens is included in the sync for completeness, but the reconcile
  driver's site branch still EXCLUDES it (theme-only governance) — the palette
  heals via a theme apply, never the seed. Gates: 1294 + 57 green, check +
  build-diff clean/EMPTY.

## Session 2026-07-15 D (pdf-tool storage-grant provider: get_pdf_tool_storage_grant SHIPPED — stateless pdf-tool writes into OUR blob stores)

Task (Wolf): make Dr-Lurie the storage-grant provider for the now-stateless
pdf-tool — pdf-tool holds no blob credentials; agents fetch a short-lived
grant here and forward it per call. Not an object conversion; MCP-surface +
ops work only.

- **New MCP tool `get_pdf_tool_storage_grant`** (mcp.ts, behind the standard
  endpoint auth gate like every tool): returns the exact grant contract
  pdf-tool accepts — `grantVersion: 1`, `grantType: 'netlify-pat'`,
  `projectId: 'dr-lurie'`, `siteId`/`token` from env, the six-store mapping,
  `expiresAt` = now + 1h (advisory-but-enforced: pdf-tool rejects expired
  grants → agents re-fetch, never cache). Grant builder + canonical store
  list live in `netlify/lib/pdf-tool-storage-grant.ts`. Fails closed
  (`pdf_tool_storage_grant_not_configured`) until the env pair exists.
  Issuance logs are metadata-only — the token appears in no log and no
  stored record, proven by test.
- **Env pair (HUMAN STEP, not yet done):** `PDF_TOOL_STORAGE_TOKEN` (PAT of
  a dedicated Netlify machine account whose ONLY access is this site/team —
  leak blast radius = this one site) + `PDF_TOOL_STORAGE_SITE_ID`. Runbook
  with the machine-account steps, monthly-rotation and revocation procedure:
  `docs/agents/pdf-tool-storage-grant.md`. Rotation needs no pdf-tool
  change; the tool always serves current env values.
- **Stores:** grant hands out artifacts / artifact-index (shared with us) +
  pdf-templates / image-search / pdf-render-data / **pdf-tool-jobs (NEW —
  pdf-tool writes its job records there, giving us the full artifact-job
  audit trail in our own store)**. `scripts/provision-pdf-tool-stores.mjs`
  proves all six writable with the grant credentials (write→read→delete
  probe, prints no secrets) — run it after the env pair lands.
- **Agent rules** (README + `docs/agents/pdf-tool-artifacts.md`): fetch a
  grant before any storage-touching pdf-tool call and pass it as the
  `storage` argument; persist only returned ArtifactReferences — NEVER the
  grant/token; on "grant expired"/storage-auth error fetch fresh and retry
  once. The old doc's "don't add pdf-tool wrapper tools" rule stands — this
  is a credential provider, not a wrapper.
- **Future (designed for, NOT built):** `grantType: 'exchange'` — opaque
  short-lived token + server-to-server exchange endpoint so the PAT never
  transits agent context. Grant shape kept stable so it's a drop-in.
- **Tests:** 7 new (exact contract incl. key-set, TTL from injected clock,
  fail-closed × 3 env cases, no-token-in-logs, 401 without endpoint auth /
  grant with it, description teaches the three agent rules) + 2 pinning the
  provisioning script's store list to the contract. Suite 1300 + 59 green.

## Session 2026-07-15 C (Theme-only palette enforcement SHIPPED: brandTokens is grammar-locked out of set_site_fields; the privileged set_site_brand_tokens writer)

Wolf: "do the Theme-only enforcement now only." Built the enforcement half of
the 2026-07-15 B directive (the maker-agent restriction and human-approval pin
stay one-line config flips, deliberately not turned on).

- **The two-op grammar split (the set_product_fields ⇸ set_product_price
  precedent, applied to the site):**
  - `set_site_fields` now `superRefine`s `forbidKeys(['brandTokens'])` — a
    hand-written brandTokens patch is refused at the grammar (`invalid_op` →
    **400**), before any value reaches validation. The hole the 2026-07-13
    color-editing agent used is closed for safe AND unsafe values alike; the
    error points at `site_apply_theme`.
  - New privileged op `set_site_brand_tokens` (`fields: {brandTokens}` only) —
    the ONLY writer of the palette. `site_apply_theme` now emits it instead of
    `set_site_fields`; same deep-merge/exact-replace mechanics; the
    fields-capture inverse makes "revert the theme" a Discard, unchanged.
  - **CRITICAL (Codex P1 caught pre-merge):** the privileged op is NOT in the
    site agent-allowlist (`patchOpNamesByObjectType.site` stays
    `['set_site_fields']`). Unlike `set_product_price` (allowlisted, leans on
    the product review gate), `site` is AUTONOMOUS — an allowlisted palette op
    would let an agent hand-author `set_site_brand_tokens` via `object_patch`
    and skip the total-theme completeness check. So the op is applyable ONLY
    when a caller passes it as `privilegedOps` (new `applyPatchOps` /
    `HandleObjectVerbOptions` / `validateCandidatePatch` option): `site_apply_theme`
    passes it, `discardProposal` passes `PRIVILEGED_PATCH_OPS` (re-applying an
    already-authorized inverse), and a plain `object_patch` passes none →
    `op_not_applicable`. Guarded by tests at the engine and verb levels.
  - **SECOND P1 (Codex, same review):** `object_discard` forwards
    caller-supplied `entries` unverified, so granting discard the palette
    privilege let a forged `set_site_brand_tokens` entry (attacker-chosen
    `capture.before`) set an arbitrary palette. Fixed: `discardProposal` now
    verifies every privileged-op entry against the record's ACTUAL history
    (`deepEqualJson` on `details.op`+`details.capture`) before applying —
    a fabricated palette entry → 403 `discard_privileged_unverified`; a real
    one (from a genuine apply) reverts as before. Tested both ways.
  - `brand_token_values` / `theme_token_keys` CSS-safety criteria are
    body-keyed (object type `site`), so they gate the new op unchanged.
- **Contract:** site gains a `palette_theme_only` constraint (blocks_write)
  and advertises `set_site_brand_tokens` as tool-authored; `object_patch` /
  `site_apply_theme` MCP descriptions updated.
- **Reconcile driver:** the site branch now strips `brandTokens` from the
  `set_site_fields` diff — the driver never emits the palette (it would 400
  now); palette drift heals via a theme apply, not reconcile. (Reinforces the
  standing "don't reconcile the site family until the seed is updated" note —
  which is about name/logo/metadata, not the palette.)
- **Tests:** grammar refusal end-to-end (400 + message + a non-palette
  set_site_fields still 200); apply now emits + inverts set_site_brand_tokens;
  reconcile excludes brandTokens; contract advertises the op agent_authored:
  false. Suite 1288 + 57 green; check + build-diff EMPTY.
- **Still available as config flips (NOT turned on, per "enforcement only"):**
  maker-agent restriction on theme creation (`src/config/creation-policy.ts`),
  human-approval pin on theme/site (`src/config/approval-policy.ts`). Agent-
  approves-agent review remains unbuilt (M-6 approvals are human-only). The
  site seed (`site-seed-data.mjs`) was resynced to production 2026-07-15
  (`scripts/sync-site-seed.mjs` + a drift-guard test).

## Session 2026-07-15 B (Wolf's palette ruling: original restored via a REAL theme apply; theme-only governance directive logged)

Wolf: the 2026-07-13 teal/terracotta palette was "made by an agent which was
asked to change something in colors around" — NOT a sanctioned rebrand — and
"I actually need it returned to the original colors."

- **Restore executed (the apply verb's second real production run):**
  checkout site → `site_apply_theme` thm_drlurie_default (atomic op,
  content_revision 9, `applied_theme` in history, agent_name
  `wolf-ordered-palette-restore`) → validate clean → publish (`2f88ef6`) →
  checkin → release (production live on that commit, deploy ready
  10:35:46Z). The canonical palette is live; thm_drlurie_default's
  description ("applying is a no-op") is accurate again and the seed's
  brandTokens match production — the PALETTE follow-ups are closed. ⚠ But
  `site-seed-data.mjs` was RESYNCED to the live "Skincare" branding
  2026-07-15 via `scripts/sync-site-seed.mjs`, with a drift-guard test in
  site-seed.test.ts holding seed === production — the site family is safe to
  reconcile again (this closes the do-not-reconcile caveat Codex flagged).
- **New governance directive (Wolf, verbatim in intent), PENDING BUILD:**
  (1) "agents should only be able to change theme of the whole site not
  individual widgets and objects" — widgets already carry no color fields
  (rule 6); the remaining hole is DIRECT `set_site_fields` on
  `brandTokens` (exactly what the 2026-07-13 agent used) — close it so
  `site_apply_theme` is the only palette writer. (2) Theme workflow:
  a requesting agent asks; a MAKER agent creates (the W8.3b
  creation-policy override, e.g. `{theme: {agents: ['theme-maker']}}` —
  coordination-grade until OQ-3 credentials). (3) "an optional human
  approval required setting" — EXISTS: pin `theme`/`site` to
  require-approval in `src/config/approval-policy.ts` (one line, currently
  autonomous). Agent-approves-agent review is NOT built (M-6 approvals are
  human-only) — needs its own design if Wolf wants it literal.

## Session 2026-07-15 (W8.4 verb proofs — recipe family CONVERTED, 41 → 47; the "no-op" apply exposed live-palette drift, reverted byte-exact)

Wolf reset the MCP connector ("connection is reset. continue") — the fresh
registry exposed `object_instantiate_section_template` and
`site_apply_theme`, unblocking the four proofs deferred from Session E.

- **Stamp proofs (per-object, the W2.5 precedent):** dry*run in BOTH modes
  (standalone + page mode onto page_object_showcase) for EACH of the five
  `stpl*\*`records — 10/10`eligible: true`, zero blockers; deterministic
  minted section ids; PageType law / route uniqueness / placeability all
  exercised on the page-mode candidate patch.
- **Theme proofs:** `site_apply_theme` dry_run (computed exact-replace
  `set_site_fields` op, full token set, `brand_token_values` green), then
  ONE REAL apply under a site checkout — atomic op (content_revision 7),
  `applied_theme` in history, validate clean, publish (`ec2cbd3`), checkin,
  release (deploy ready 09:30:57Z). **Criterion 3 now holds for both types
  → recipe family CONVERTED, count 41 → 47.**
- **INCIDENT — the "no-op" premise was false:** production's brandTokens
  had been REBRANDED on 2026-07-13 (teal/terracotta palette + Source Serif
  heading font; site published at content_revision 6) AFTER the seed corpus
  was written, so the theme (authored from the SEED, verified against the
  seed by the W8.3 tests) reverted the live look. The wrong palette was live ~6 minutes
  (09:30:57–09:37:13Z); detected via the export diff; restored byte-exact by patching the pre-apply
  brandTokens back (`set_site_fields`, publish `eba0c42`, release).
  **Lesson: "byte-identical to production" claims must be checked against
  the LIVE record at apply time — the seed corpus is not production.**
- **Open follow-ups (Wolf's call):** (1) `thm_drlurie_default` no longer
  matches the live palette — update it to the 2026-07-13 rebrand (restores
  the "applying is a no-op" invariant) or keep it as the launch palette
  with corrected metadata; (2) `scripts/lib/site-seed-data.mjs` is stale vs
  production — a site-family reconcile run would "heal" the rebrand away;
  update the seed before any such run.
- Endpoint flakiness persisted (502s/timeouts); the verify-before-retry
  discipline held — every timed-out mutation had landed (incl. both site
  publishes and both releases). A post-reset harness quirk: one tool's
  approval died with a broken permission stream ("requires approval" on
  `object_inventory`); worked around with already-approved reads.
- Docs flipped in this change: CLAUDE.md (forty-seven + W8 CONVERTED
  paragraph with drift caveats), object-inventory (🟢 table, verb-proof
  record, follow-ups), conversion-map (🟢 marks, site-seed stale warning,
  W8 row), 09-plan (status header, §1 table, W8.4 row, RUN OUTCOME
  COMPLETE).

## Session 2026-07-14 E (W8.4 RUN — Wolf's go: recipe family RELEASED, not yet converted; the four application-verb production proofs are the open gate — first act of next session, then 41 → 47)

Wolf: "do W8.4" (after merging W8.3b as PR #442). Run executed via the
session MCP connection against production, strictly sequential ops.

- **Step 0 — tpl metadata backfill**: the 3 live `tpl_*` reconciled to the
  metadata-complete seeds via `reconcileOps` (one `set_template_meta`
  carrying description/whenToUse/scope + idempotent slot heals), then the
  FULL standing drill (all 4 template ops, probe slot in/out), validate
  clean, publish (rev 20: commits `8cbe103` / `6d228fb` / `ae8588c`),
  checkin. Exports content-identical to the W8.3b pre-materialization (only
  the `__generated` stamp moved). `object_instantiate_template` dry_run
  re-proven ×3 — incl. tpl_legal's blueprint-less required slot filling
  from prose registry defaultData.
- **Six creations**: 5 `stpl_*` + `thm_drlurie_default` created
  (`agent_name: w84-conversion-run`), every permitted patch op drilled with
  exact inverses (stpl: set_section_template_meta / update_blueprint_data /
  replace_blueprint; thm: set_theme_fields), validated clean at publish
  level (blueprint_standalone_renderable, theme_token_keys,
  brand_token_values, recipe_metadata all green), published (commits
  `b554133` / `a69ffeb` / `6ce0f8c` / `ac970a3` / `6e8eb1c` / `815de2a`),
  checked in. First-ever `src/data/site/section-templates/` and
  `src/data/site/themes/` exports.
- **Released**: production deploy for `6e8eb1c` (all 9 exports) `ready` at
  2026-07-14T16:23:38Z. store === seed === export verified byte-level
  (script compare, modulo `__generated`).
- **Contracts + index proven live**: section_template/theme contracts serve
  exactly the drilled ops, the W8 constraints, `creation_policy`, and the
  REUSE-FIRST opener; `object_inventory` rows carry full recipe summaries
  (the W8.3b index working in production with real data).
- **THE OPEN CONVERSION GATE — application-verb production proofs**: the
  session's MCP tool snapshot predated the W8 deploys, so
  `object_instantiate_section_template` and `site_apply_theme` were NOT
  callable from this session (Wolf refreshed the connector mid-run; the
  harness snapshot is session-static — confirmed by subagent probe; raw
  HTTPS to the endpoint is blocked by the container network policy). Per
  playbook criterion 3 and the W2.5 template precedent (instantiate proven
  in production before the flip), the family therefore stays **RELEASED,
  not converted** — inventory/map marks are 🔵, CLAUDE.md count stays 41.
  The proofs (stamp dry_run in BOTH modes for EACH of the 5 stpl records —
  per-object conversion, the W2.5 one-proof-per-template precedent; apply
  dry_run + ONE real no-op default apply + site publish + release) are the
  FIRST ACT of the next session; on green, flip the marks 🟢, count
  41 → 47. Both
  verbs are deployed, contract-advertised, and verb-level-tested in the
  merged suite.
- **Ops lessons (endpoint was flaky — 502s + 60s connector timeouts all
  run)**: a timed-out `object_checkout` usually DID take the lock
  server-side with a token never delivered — the lock is unreclaimable
  until lease expiry (~15 min); park the object and work another. NEVER
  blind-retry a mutating call: verify with `object_inventory` detail
  (publish receipt / lock / unpublished_changes) first — every timed-out
  create/patch/publish in this run had actually landed.
- Docs updated in this change (RELEASED framing, per the Codex-flagged
  no-half-measures call): object-inventory (W8 section → RELEASED table 🔵
  - tpl backfill note), conversion-map (🔵 marks + W8 row with the open
    gate), CLAUDE.md (count stays forty-one + "6 RELEASED pending proofs"),
    09-plan (status header, W8.4 row, tpl caveat RESOLVED). `tpl_fieldtest`
    stays trio-less (fieldtest family) — patching it 422s until backfilled
    or retired.

## Session 2026-07-14 D (W8.3b BUILT: recipe metadata + creation-policy seam + reuse-first surfacing — NOT converted; W8.4 awaits Wolf's go, now with a tpl backfill Step 0)

Wolf: recipes must be self-explaining in JSON ("what it is, whether it is for
a project that is one off or it has a strategy"); template creation must be
restrictable to some agents ("this dev is for later but the ability can be
inserted now"); agents should reuse existing templates, with well-described
types/use cases to lower AI cost. Decisions (AskUserQuestion): metadata on
ALL THREE recipe types uniformly; minimums REQUIRED TO PUBLISH (drafts warn;
the 3 live tpl\_\* get backfilled at W8.4); restriction = committed-config
seam, default open. Push-back accepted: the AI-cost pattern is
INDEX-THEN-FETCH, not "provide all context" — a one-line-per-recipe index in
`object_inventory`, then `object_get` only the chosen one.

- **Recipe metadata (09 §W8.3b brief)**: shared `recipe-metadata-v1.ts` —
  `description` / `whenToUse` / `scope: 'evergreen' | 'one_off'` spread into
  template.v1 + section_template.v1 + theme.v1 (page templates had NO
  description field before this). Schema-optional (additive: production
  records keep parsing), publish-gated by the shared `checkRecipeMetadata`
  criterion (`recipe_metadata`; empty-after-trim = missing). Zero new patch
  ops — the existing meta/fields ops carry the trio. All 9 seeds are
  metadata-complete; the 3 committed tpl exports were hand-updated with the
  same trio (pre-materializing the W8.4 backfill byte-identically — keeps
  seed-objects-enforcement green at publish level). INTERIM CAVEAT: until
  the backfill, patching a live tpl\_\* without adding the trio 422s.
- **Creation-policy seam**: `src/config/creation-policy.ts` +
  `src/lib/creation-policy.ts` (approval-policy twin; per-type
  `'open' | {agents}`, humans always, DEFAULT FULLY OPEN — nothing is
  restricted today). Enforced at the top of `create` (recursion-proof) with
  dry_run-honest pre-checks in create_variant/instantiate/
  instantiate_section-standalone; keys on the CREATED type (instantiate →
  page; standalone stamp → section; page-mode stamping + apply_theme are
  patches, ungated — test-pinned). 403 `creation_restricted` names the
  allowlist and points at reuse. Surfaced on every contract as
  `creation_policy`. ⚠️ Documented honestly: agent_name is self-declared
  until OQ-3 — coordination seam, not security.
- **Reuse-first surfacing**: `object_inventory` recipe rows carry a
  defensive body-derived `recipe` summary (name/scope/description/
  when_to_use + blueprint_type | applies_to + slot_count); the three recipe
  contracts open with a REUSE-FIRST workflow step; every one of the 19
  section components gained an `editor.useWhen` one-liner (auto-served via
  contract section_types + registry_get); tool descriptions updated
  (object_inventory / object_contract / object_create).
- **Reconcile machinery**: `TEMPLATE_META_KEYS` gained the trio (this IS the
  W8.4 backfill mechanism — ensure heals the live records to the enriched
  seeds); the previously missing `section_template` + `theme` reconcile
  branches were added (they would have crashed on drifted records).
- **Suite: 1,343 tests green** (new: recipe-metadata schema/criterion/
  pipeline per type; creation-policy resolution + verb-level 403s incl.
  recursion and page-mode-ungated pins; inventory summaries incl. malformed
  bodies; contract/useWhen/REUSE-FIRST pins; publish-level seed tightening;
  reconcile heal tests). `npm run check` 0 errors; build-diff EMPTY.
- **Still open: W8.4** (human_gate, unchanged in gate) — now begins with
  Step 0: the tpl metadata backfill via the templates-seeds driver run, then
  the stpl/thm creation run as planned. OQ-W8-1…4 remain checkpoints.

## Session 2026-07-14 C (W8.1–W8.3 BUILT + MERGED: section_template + instantiate verbs + blueprintRef + theme + site_apply_theme + token safety — NOT converted; W8.4 awaits Wolf's go)

Wolf: "check if anything blocks this, including the latest commit. If nothing
does merge and continue along this plan." Nothing blocked; the 09 design PR
(#436) merged, then all three normal-mode build phases were built, reviewed,
and merged the same day — each its own PR, each gated on the full suite +
`astro check` 0 + build-diff EMPTY. **Nothing is CONVERTED: no store records
exist for the new types; every inventory/conversion-map mark stays ⚪/🔴 until
the human-gated W8.4 credentialed run.**

- **W8.1 (PR #437, `6198748`)** — `section_template` is the TENTH governed
  object type end-to-end (schema/ids/3 ops with exact inverses incl.
  server-minted `blueprint.id`/validation/contract/materializer/policy/
  collection/Ask-AI/drill) + five self-contained starter seeds
  (`scripts/lib/section-templates-seed-data.mjs`). The Session-K leaf gap is
  CLOSED at write time via one shared predicate
  (`isStandalonePlaceableSectionType`): a standalone `card` on a page or in a
  shared-section wrapper (or a wrapper wrapping a `shared_ref`) is now a
  blocks_write failure; `cards`-source grid cells untouched; the committed
  21-section showcase export pinned green.
- **W8.2 (PR #439, `cf6d339`)** — `object_instantiate_section_template`:
  page mode = ONE `upsert_section` through the standard patch path under the
  CALLER'S checkout (fresh deterministic `s_*` id per (recipe, page,
  version); `instantiated_from` provenance in history; exact inverse; "law
  beats recipe" pinned — a hero recipe into a `listing` page is a 422);
  standalone mode = a new `sec_*` via the create path. `templateSlot` gained
  `blueprintRef` (mutually exclusive with inline blueprint; deref +
  deep-copy at instantiation ONLY; live existence + type-in-allowed checks
  via the new `resolveSectionTemplateType` resolver). Codex review fixes
  folded in: dry_run needs no checkout fields; blueprintRef types re-checked
  at the live instantiation point (a re-blueprinted recipe can't smuggle a
  disallowed type); honest retry semantics (409 carries
  `section_id_for_expected_version` for lost-response recovery). Fix found
  en route: both endpoints now derive the validation-context self ref from
  `target.page_id` too (route uniqueness would have flagged the target
  page's own route).
- **W8.3 (PR #440, `9bbba9c`)** — `theme` is the ELEVENTH governed type
  (`theme.v1`; `brandTokensSchema` extracted from site.v1 and SHARED;
  `set_theme_fields`; `thm_drlurie_default` seed importing the site seed's
  tokens — byte-identical to production). `site_apply_theme` verb + MCP
  tool: ONE exact-replace `set_site_fields` op (stale color keys explicitly
  unset) under the caller's site checkout; `applied_theme` provenance;
  revert = standard Discard; dry_run needs no checkout; an INCOMPLETE theme
  is not appliable (Codex review fix — applying it would delete consumed
  keys). **The §7.3 token-injection gap is CLOSED**: a shared safe-CSS
  grammar (`src/lib/registry/theme-tokens.ts`) now gates `set_theme_fields`
  AND `set_site_fields` (values with `;{}<>`, `url(`, `@import` rejected);
  CustomStyles refactored onto the shared key/fallback registry,
  byte-identical (build-diff EMPTY vs main).
- **Suite: 1,320 tests green** (was 1,236 pre-wave); every phase also passed
  `npm run check` (0 errors) and `scripts/build-diff.mjs` EMPTY.
- **Still open: W8.4 (human_gate — Wolf's explicit go required)**: the
  credentialed production conversion run per 09 §9 — create the 5 `stpl_*` +
  `thm_drlurie_default`, drill every permitted op sequentially, publish,
  release; prove `object_instantiate_section_template` by dry_run (both
  modes) and `site_apply_theme` by dry_run + ONE real no-op apply of the
  default theme; flip inventory/conversion-map/CLAUDE.md counts to CONVERTED
  in the same change. Also open per 09: OQ-W8-1…4 (composite sections,
  checkpoint) and the optional palette-derivation backlog slice.

## Session 2026-07-14 B (ADMIN MENU → main nav (MCP-editable, admin-gated); /object-showcase content-state variants; the stale-deploy incident FIXED)

Wolf: "make me a page object with every possible existing object … Move the
admin menu to the nav_header main menu … show if admin is logged in … Add a
link to this page … This should actually happen through the MCP server too.
Can it?" Plus a deploy incident: after the legacy wipe, production still
showed the old posts at /learn/library/4.

- **Stale-deploy incident — root-caused + FIXED.** Git/build were correct
  (wiped `main` builds 68 pages, 2 library pages, zero old posts — proven
  locally); production was serving a **pre-wipe deploy** because the earlier
  `release_to_production` calls timed out client-side before confirming.
  Re-fired the release → `released:true`, production live on `3c9debea`. Old
  posts gone. (Auto-publish was NOT locked; the tool's client 60s timeout was
  the culprit — verify releases via `deploy_status`, not the call return.)
- **Admin menu is now a main-nav group, MCP-editable, admin-gated** — answering
  "can MCP do it?": **the contents can, once a one-time code change lands.**
  - Code (PR #435, merged `3c9debea`): `adminOnly` flag added to the navigation
    schema (`NavItem` + `NavGroup`, M-9); the transform carries it only when
    set (existing navs byte-identical); `Header.astro` renders an `adminOnly`
    group's `<li>` with `data-admin-only hidden`; the header-auth script reveals
    every `[data-admin-only]` element site-wide when the visitor is a signed-in
    admin. The admin links were **removed from the account dropdown** — it is
    now just login/account (Wolf's "old admin = a login state"). Build 68 pages,
    nav/patch/schema suites 218+100 green, adapter test 8/8.
  - MCP (after the schema deployed): added a `g_admin` group to `nav_header`
    (`adminOnly:true`, route-kind items — Dashboard/Publish/Drafts/Library/AI
    Publisher/Blob Store **+ Object Showcase**), published `9bdc2764`. The admin
    menu's structure/content is now store-backed and editable via `object_patch`
    — no longer a hardcoded JS array.
- **`/object-showcase` expanded via MCP** (no git commit for the page): +16
  content-state variant sections (37 total) — each block in minimal / short /
  one-line text and image none/one/two states, in a labeled "Variants" cluster
  below the full versions, so edge cases (missing-image fallbacks, bare
  headings, single-item lists) are visible for QA. Published `03173c7c`.
- **One release** deployed the admin group + showcase together — deploy
  `6a561a09…` ready 11:15Z, `deploy_status` confirmed production reflects
  `03173c7c`. The admin dropdown is LIVE for signed-in admins.
- **MCP reachability note (Wolf's "good exercise"):** all 10 governed types are
  fully MCP-reachable (create/checkout/patch/publish + typed ops + contract).
  The gap this session closed: the admin menu was **chrome hardcoded in JS**,
  not an object — now it's a `nav_header` group. Remaining hardcoded chrome to
  audit if wanted: login-modal copy, some 404/system strings.
- **Standalone-`card` validation gap (logged Session K) is CLOSED** by W8.1's
  leaf-section validation fix (#437, `6198748`) — a leaf-only section placed
  directly on a page is now rejected at write time.

## Session 2026-07-14 A (W8 PLANNED: template-system expansion — section templates, page-template composition, theme presets; docs only, no code, nothing converted)

Wolf asked where templates stand and mandated "at least two types of
templates: page template and section template," with the division of labor
"the code dictates what functionality, options exist and what amount …
template decides object position within section. CSS stuff stays with site."
Recon confirmed page templates already exist and are CONVERTED-but-dormant
(W2.5, zero instantiations) and every section is already uniform JSON through
one registry — the gaps were section-level recipes and any recipe treatment
for site CSS tokens. Wolf's four decisions (recorded in 09 §0): section
templates STAGED (recipes over the existing coded types now; composable
"composite" sections SPEC-ONLY, gated on OQ-W8-1…4); deliverable = plan doc +
per-phase briefs; theme presets IN scope (settled: theming is NOT taxonomy —
it's a recipe); push the design branch, no PR.

- **[`09-template-system-plan.md`](../09-template-system-plan.md) written**
  (the 06/08 convention: one plan doc, embedded W8.1–W8.4 briefs). The
  architecture: the **recipe family** completes design-principles rule 5 —
  `template → page` (exists), `section_template → section` (NEW, tenth type:
  `{name, description?, blueprint: sectionInstance}`, 3 ops with inverses,
  `object_instantiate_section_template` stamping into a page under the
  caller's lock or minting a standalone `sec_*`; 5 planned seeds), `theme →
site.brandTokens` (NEW, eleventh type: `set_theme_fields` +
  `site_apply_theme` computing ONE exact-replace `set_site_fields` op with
  stale-key unsets). Page templates gain slot-level `blueprintRef` →
  section_template (deref + deep-copy at instantiation only). Provenance
  decisions recorded: no schema-level provenance on section instances and no
  `site.theme` field — history carries attribution.
- **Design-principles rule 6 added (GOVERNING)**: layout is bounded data,
  never free-form style — components expose enumerated layout fields, agents
  select values, no CSS/class names in schema ever. Rule 5 extended to the
  recipe family.
- **Two live gaps scheduled into the wave**: the Session-K standalone-`card`
  validation gap (fix in W8.1 via the new shared
  `isStandalonePlaceableSectionType` helper, also used for stpl blueprints)
  and a NEW finding — brand-token values flow **unvalidated** from
  `set_site_fields` into CustomStyles' inline `<style>` (value-safety grammar
  closes it for both `site` and `theme` in W8.3, alongside a byte-identical
  CustomStyles refactor onto a shared `theme-tokens.ts` key registry).
- **Docs updated in the same change**: conversion-map (⚪ SECTION TEMPLATES +
  ⚪ THEMES nodes, W8 wave row), object-inventory ("Planned (W8)" block —
  🔴 TODO, nothing overstated), 05-task-breakdown addendum (OQ-4 stays
  rejected; T6.2 editor leftover descoped; W8 OQs live wave-locally in 09),
  design-principles (rule 6 + rule-5 extension).
- **Nothing built, nothing converted**: no code, no store writes, no schema
  changes. The converted count stays 41. W8.1–W8.3 are normal build sessions;
  W8.4 is the human-gated credentialed run — both new types flip to CONVERTED
  only when all five playbook criteria hold there.

## Session 2026-07-13 K (CREDENTIALED CORPUS RUN: the ten-article content_item corpus is CONVERTED + LIVE; `page_article` gets a related grid; `/object-showcase` QA page built)

Follows Session J (the wipe + seed). Wolf: "Related-grid options do them …
[the corpus] needs to be rewritten" and, separately, "make me a page object
with every possible existing object added to it … one below another … Let's
call it /object_list or something technical so it never gets wired in." Both
executed this session over the live session MCP connection (fighting
intermittent api.anthropic.com 502s — publishes/checkins frequently applied
server-side despite a client-side 60s timeout, so every step was verified via
`object_inventory` rather than trusted from the call return).

- **Ten-article corpus CONVERTED.** All 10 `req_agent_*_20260713_01` articles
  (skin_barrier_basics, reactive_skin, minimal_routine, reading_labels,
  skin_after_40, retinoids_after_40, niacinamide, sunscreen, ten_step_myth,
  not_self_worth) created in the production store, validated clean, and
  published (export commits accumulate on main with `[skip netlify]`; last
  publish `514cb778` = retinoids_after_40). Parallel `object_create` overwhelmed
  the gateway (1 of 4 landed) → switched to strictly sequential; that held.
  Each is a real record `object_inventory` returns, `unpublished_changes:false`,
  Tier-1 autonomous. All five conversion criteria hold per article.
- **`page_article` related grid.** Added a `content_grid` section
  (`s_related`, `source:{kind:"related",algorithm:"tag_similarity"}`, `limit:3`,
  `columns:3`, heading "More to read") at position 0 of `page_article`
  (`content_detail`, publishes autonomously — the pageType review policy gates
  only human-executed publishes). Dry-run clean → checkout → patch → publish
  (`c69b5cfa`) → checkin. Every article now renders a selectable "More to read"
  tile block (Slice D options apply to it).
- **Single release.** `release_to_production` fired once (client timed out at
  60s; the build hook POSTed server-side) — deploy `6a553f5260cc650008f4363b`
  for `c69b5cfa` reached **ready** (finished 19:42:06Z), confirmed via
  `deploy_status`. Production now reflects: 10 corpus articles + the demo
  article + the `page_article` grid + `/object-showcase`, all in one build.
- **`/object-showcase` QA page built** (`page_object_showcase`, route
  `/object-showcase`, `pageType:standard`, `seo.robots.index:false` — a
  technical surface deliberately not wired into any nav). 21 sections, one
  below another, every placeable section type populated with throwaway data so
  each block can be hovered and canvas-tested for bugs one by one. Store-backed,
  published (export `fa2abbdb`), released.
  - **VALIDATION-GAP FINDING (logged, not yet fixed): a standalone `card`
    section passes `object_validate` but breaks the production build.** The
    first showcase build failed (exit 2, "No component registered for section
    type 'card'"): `card` is a grid _leaf_ (rendered only inside a
    `content_grid` via its `cards` source) and has no standalone component, yet
    validation admitted it as a top-level page section. Fixed the page by
    replacing the standalone `s_card` with an `s_cards` `content_grid`
    (`source.kind:"cards"`), re-published, re-released (green). The engine gap
    stands: `validateObject` should reject a leaf-only section type placed
    directly on a page, at patch/create time, the same way it already blocks
    disallowed section types. Candidate follow-up (own task) — not bundled here.

- **Docs**: this entry; `object-inventory.md` articles section flipped to record
  the corpus + related grid + the showcase QA surface + the wipe truth-up;
  `conversion-map.md` article count updated. No code in this PR — the conversion
  itself lives in the production store + the export commits already on main.

## Session 2026-07-13 J (LEGACY WIPE: 83 smoke-test .md posts deleted; ten-article content_item corpus seeded — awaiting the credentialed run)

Wolf: "Old legacy articles can actually be wiped if it helps. I say wipe it.
Perhaps we can convert up to ten for testing to the new schema. … you be the
judge. It doesn't really matter. needs to be rewritten. GitHub needs to be
cleaned too then." Recon confirmed the 83 `src/data/post/*.md` were
smoke-test/SEO filler ("smoke-test article" literally in the excerpts; only
10 even carried a category) — so this is a rewrite, not a migration.

- **All 83 .md deleted** (`git rm`); a `.gitkeep` keeps the `post` collection
  glob base. No page/section export or component referenced any post slug
  (verified: no manual-grid picks, no content_embed, no hardcoded slugs) — the
  deletion is reference-safe. The `post` collection is now permanently empty;
  `load()` in utils/blog.ts guards the read (`.catch(() => [])`) and Astro logs
  a benign "collection 'post' … is empty" line (same class as the pre-seed
  articleObject warning) — build unaffected.
- **Ten-article corpus** (`scripts/lib/articles-corpus-seed-data.mjs`): genuine
  content_item articles, TWO per registry category
  (skin-health / skincare / skin-after-40 / ingredients / reflections), fresh
  slugs, full annotation layer (PAS-ish arc of hook→…→recommendation; a couple
  carry node-wired claims). All 10 bodies validate against the live
  content_item schema; taxonomy uses registry slugs only.
- **Local full-state build proven**: the 10 exports materialized to
  `src/data/site/articles/` + the demo = 11 articles → build 67 pages, all 5
  category pages, 12 tag pages, the topics hub, and RSS (11 items) render; then
  the temp exports were REMOVED (they must arrive store-backed via the run, not
  committed). Committed-state build (demo only) = 37 pages, green.
- **Gates**: 1210 + 49 tests green · astro check 0 · eslint/prettier clean.
- **Status: DELETION + SEED READY, corpus NOT yet converted.** Next: merge +
  deploy this PR, then the credentialed run —
  `create → publish → release` each of the 10 content_item objects (fresh
  slugs = no collision with anything), plus add a `related` content_grid to
  `page_article` so the article "other articles" block becomes a selectable
  tile (Slice D options apply). Records flip to CONVERTED after the run. Brief
  pre-launch window between deploy and run where the blog shows only the demo
  article — acceptable behind the SITE_NOT_YET_LIVE gate.

## Session 2026-07-13 I (CANVAS Slice D: related-grid options — random/tiles/columns — + save-button dirty state)

Wolf: "Related-grid options do them. and also buttons like save draft need to
show have inactive state when there's nothing to save. After save 'Saved'
should appear for a relatively short time and then button should become
inactive." (07-canvas §3k.)

- **`random` algorithm**: deterministic seeded shuffle
  (src/utils/seeded-shuffle.ts, pure + unit-tested — same seed → same order,
  no build-diff churn; seeded by the anchor post, salt otherwise). Wired
  through schema → resolver (section-resolve-deps) → chip dropdown.
- **Tiles + columns**: content_grid gains optional `columns` (1–4, default 2
  → byte-identical unset; ContentGrid.astro uses literal grid-cols classes so
  Tailwind JIT emits them). The related chip grows inline `tiles` (limit) +
  `columns` steppers next to the algorithm dropdown; all three patch
  update_section_data (applyRelated, key-stable deep-merge). Annotations
  emit -limit/-columns alongside -algorithm.
- **Save-button dirty state**: disabled when the form matches the last-saved
  baseline; enabled on edit; "✓ Saved" briefly then re-baseline → disabled.
  One serializer + delegated input/change listener over edit/image/role/nav
  forms.
- **Gates**: 1210 + 49 tests (seeded-shuffle determinism/permutation/purity;
  annotations emit tile+columns) · astro check 0 · eslint/prettier clean ·
  **build-diff EMPTY (174/174 identical — columns default is byte-identical)**
  · **13-assertion Slice-D drive** (pristine-disabled → edit-enabled →
  revert-disabled → Saving…/Saved/disabled + one update_node; Random in the
  dropdown; tiles/columns steppers show current values and patch
  limit/columns/source.algorithm) + the A/B/C drives re-run green.

## Session 2026-07-13 H (CANVAS Slice C: delete on every tile + glass restyle + right-rail anchor + tile→accordion morph)

Wolf's third field-test round, same session: the tile becomes an interaction
system (07-canvas §3j).

- **Delete everywhere** (rightmost trash on every tile; chrome excepted):
  nodes → remove_node; sections incl. shared_refs → remove_section on the
  HOST page (a shared delete removes the reference, never the sec\_\*
  object). Always behind a confirmation modal; lands as a draft; region
  disappears in place; tray phrases it.
- **Glass tiles**: near-transparent blur surface, full-contrast content.
- **Right rail**: tile just right of the content column, top-aligned with
  the block's heading — clear of the "+" gaps. Drive found + fixed a real
  z-order bug: the anchored panel intercepted clicks on a neighboring
  block's tile (chip now stacks above the panel).
- **Tile → accordion morph** (the container-transform idiom): the panel
  opens in place of the tile, absolutely anchored and top-aligned with its
  object, FLIP-animated out of the tile's box (reduced-motion safe; mobile
  keeps the bottom sheet); tool presses switch sections in place. Universal
  across all target kinds by construction.
- **Gates**: 1205 + 49 tests · astro check 0 · eslint/prettier clean ·
  build 173 pages · 15-assertion Slice-C drive (glass alpha; rail x/y
  alignment to the pixel; trash rightmost; confirm modal semantics; cancel
  sends nothing; remove_node wire; in-place disappearance; anchored panel
  top == tile top; tool-switch stability) + Slice A/B and W7.7 drives
  re-run green. Screenshots delivered to Wolf.

## Session 2026-07-13 G (CANVAS Slice B: second field-test round — preload, human tray, image placeholders, button states, bullets)

Wolf's second live round (screenshots) + three rulings: **W7.7 remainder ON
HOLD** ("that UI is stale now. I need to rethink what the admin area is
supposed to be like" — no TipTap panel or /admin/publish re-wire until his
ruling); **metadata row = category + tags**; the rest shipped same-day
(07-canvas §3i):

- Metadata row: category + tag links on every article header (both
  families, registry labels).
- Record cache + preload (pay the wait up front): edit-mode entry warms one
  get per visible object; chips/panels/tray/role editor open from memory;
  writes invalidate; failures don't stick.
- Pending tray humanized — "object · verb · location": object TITLE + a
  history-derived summary of unpublished ops ("Image added to Resolution",
  "Text edited in Hook · +1 more"); req\_\* ids demoted to tooltips.
- Chip identity is the ROLE alone ("Hook · educate") — "article content"
  boilerplate dropped from chip and panel header.
- Image tool: thumbnails never show the broken-image glyph (load-gated +
  neutral placeholder); a NEW image previews in place as an appended figure
  on save; an emptied src removes its element.
- Buttons: Save draft on the accent token (green was off-palette), full
  hover/active/focus-visible/disabled states, "Saving…" in flight +
  "✓ Saved" confirmation (restores on failure) — saveForm/roleForm/navForm.
- Bullets (the "lists dropped, not editable" report): items[] is ALWAYS
  offered on content blocks ("Bullet points", one per line) — the gap was
  that the form only listed EXISTING fields, so a text block could never
  gain a list; lists now also preview in place on save. Editor-facing field
  labels throughout (Text/Heading/Kicker/Button text…).
- **Gates**: 1205 + 49 tests green · astro check 0 · eslint/prettier clean ·
  build 173 pages · **15-assertion Slice-B drive** on the built demo page
  (metadata links; warm-cache proof — zero re-fetch before first save;
  tray title + "Text edited in Hook · +1 more"; placeholder-not-broken;
  accent save button; Saving…/Saved states; items wire + in-place <ul>) +
  the 19-assertion W7.7 drive and 16-assertion Slice-A drive re-run green
  (probe export recreated for the run, then removed).

## Session 2026-07-13 F (W7.7 CANVAS CAPABILITY SLICE: node palette + adSlot mockup bank + role panel + multi-image; upsert_node id-mint gap fixed)

Same session as E, on Wolf's "continue to W7.7". The article body is now
COMPOSABLE from the canvas — full doc: 07-canvas-editing.md §3h.

- **Node palette** (`nodes-palette.ts`, pure + tested): "+" before/between/
  after blocks ("Add an article block" — req\_\* ids banned from UI copy) →
  nine schema-valid starters, each annotated from birth: Text, Heading+text,
  Checklist, Image, Image gallery, CTA, **Offer/affiliate** (disclosure +
  nofollow-sponsored pre-filled), **Ad slot (mock)**, Chat invite. Insert =
  `upsert_node` at a record-derived position, server-minted id, honest draft
  placeholder.
- **SERVER GAP FOUND + FIXED**: `mintOpsIds` never handled `upsert_node`
  though the contract advertised `minted_id_field: node.id` since W7.3 (the
  W7.9 drill's probe carried an explicit id, so it never fired). Id-less
  upsert*node now mints `n*<hex>` (leak-safe by construction) + test.
- **adSlot MOCKUP BANK** (Wolf: "make them look real like served by google
  or a native ads provider"): native in-feed / leaderboard / med-rectangle,
  rendered ONLY for `adSlot.provider:'mock'` (real providers still render
  nothing — mockups never fake live inventory), honestly labeled
  Advertisement/Sponsored + Ad chip, fictional advertiser, no external
  assets, copy overridable per node, creative switched via
  `commercial.creativeId`. Screenshots delivered to Wolf.
- **ROLE & INTENT PANEL**: fourth accordion section (article blocks only) —
  strategy (12) + intent (5) dropdowns + agent notes → `update_node` on
  `private` fields; '' clears (null); chip/header roles refresh (cache
  invalidated). The semantic layer is human-editable — was JSON-only.
- **MULTI-IMAGE** (Wolf-approved): `public.images[]` on content nodes (full
  media objects, rendered as figures in order); image tool grows the gallery
  ("Add image"; empty src removes on save); one-image-per-node stays the
  norm.
- **Gates**: 1205 + 49 tests green (nodes-palette starters validated against
  the REAL node schema + render; ad bank + gallery render tests; the
  upsert_node mint test) · astro check 0 · eslint/prettier clean · build 173
  pages (probe export used for verification, then removed) · **19-assertion
  headless-Chromium drive on the built probe page** (3 ad units + gallery +
  offer + chat render; node gaps; palette wire: upsert_node id-less at
  position 0 → minted placeholder; role editor: hook→proof +
  agentNotes wire + header refresh; gallery rows + Add image + uploads) +
  the 16-assertion Slice-A drive re-run green.
- **Still open in W7.7**: TipTap/rich-text DOCUMENT editing in the panel,
  the /admin/publish re-wire decision (reduced by the legacy-wipe ruling),
  bugs ⑥⑩. NOTE the schema-vintage gate: canvas inserts against production
  need this merged + deployed first.

## Session 2026-07-13 E (CANVAS Slice A: six field-test fixes from Wolf's first live article-canvas session)

Wolf field-tested the canvas on /object-model-demo and filed the first live
feedback (screenshots). Slice A = the six small fixes, shipped same-day; the
structural asks are queued as W7.7 (node palette incl. commercial
blocks + adSlot mockup bank + annotation panel; multi-image block approved)
and the related-grid options slice (manual/random/latest + tile counts).
Wolf's UI rule recorded in 07 §3g: **on-screen information must be what an
editor needs at the moment of action** — a req\_\* id is worthless there; the
block's marketing role is the point. Also ruled: the 83 legacy posts get
WIPED after ~10 are converted as test corpus (own session; no git-history
rewrite), pending Wolf's keeper shortlist.

- **Role chips**: article-block chip + panel header show `Hook · educate`
  instead of the object id — roles read from the draft record (cached fetch;
  the leak rule keeps strategy out of built HTML, so the DOM can't carry it).
- **Image ADD on nodes**: media-less content nodes get src/alt + Upload rows;
  save seeds `{type:'image'}` (content_item only). Before: dead-end "no
  image fields".
- **Panel content-sized** (was pinned to viewport bottom = "opens to max");
  log/form bodies capped + scroll internally.
- **Busy dots** on every wait; send disabled in flight.
- **CTA button**: `not-prose` + `font-sans` — prose-a color had made the
  label invisible (teal-on-teal) and the serif leaked; render-nodes test pins
  the new classes.
- **Print/share under ClientRouter**: re-wire on `astro:page-load`
  (data-wired guard) — swapped-in article pages had dead buttons.
- **Gates**: 1198 + 49 tests green · astro check 0 · build 173 pages ·
  eslint/prettier clean · **16/16-assertion headless-Chromium drive of the
  built site** (mocked admin endpoints): print/share AFTER a view-transition
  nav, CTA computed white-on-teal in Inter, chip/header role text with no
  req\_\* anywhere, media.src/alt + Upload on an empty node, busy dots
  visible-in-flight → removed after reply + send re-enabled, panel bottom
  edge 421/900.

## Session 2026-07-13 D (W7.9 CREDENTIALED RUN: content_item is CONVERTED — the first article object is LIVE with node chips; OQ-W7-1 resolved)

Wolf: "Nothing allows me to see article elements with node chips and edit
options — finish what's opened, recheck W7.8, make sure the MCP connections
are updated … the end goal is to have articles and article publishing
converted from old schema to the new project-wide schema without losing
functionality. Reverse support is not required." Root cause of "nothing to
see" confirmed first: `object_inventory {content_item}` returned **empty** —
the W7.8 canvas machinery was built and merged but had no article to act on
(W7.9 had never run). This session ran it, op-by-op over the session's live
MCP connection (the same verbs the driver calls):

- **MCP endpoint check**: ping OK; `object_contract('content_item')` serves
  the full W7.3 contract (all six node ops advertised, create_variant in the
  workflow, Tier-1 autonomous publish) — the deployed server needed no
  update; only the store record was missing.
- **SEED BUG found + fixed (the run's one surprise)**: `object_create` was
  blocked by `article_taxonomy` — the seed's `skin-science` category doesn't
  exist in the production `tax_drlurie` registry (it's a TAG there) and
  `skincare-education` exists nowhere. The local rehearsal couldn't catch it:
  the check is registry-gated and the isolated local store has no registry.
  Seed now carries `reflections`/`reflections` (playbook reality-check gained
  the trap note). Store ≡ seed ≡ export holds.
- **The run**: create `req_agent_object_model_demo_20260713_01` → checkout →
  ONE batch patch drilling all six ops (set_article_meta ×2, upsert_node,
  update_node on copy AND `private.strategy` hook→summary, set_node_visibility,
  move_node ×2, remove_node) ending **byte-identical** (history carries every
  exact-inverse capture; the client timed out mid-patch but the server had
  applied — object_get confirmed before proceeding) → validate: eligible,
  zero blockers (slug unique across the 83 committed posts) →
  `create_variant` dry-run: eligible, node ids re-minted, claims node_ids
  re-pointed, lineage set, nothing persisted → publish: export commit
  `60cd213` (`src/data/site/articles/…01.json`) → checkin → inventory returns
  it (published_content_revision 10, no unpublished changes) → release:
  build fired once, confirmed `released: true`, deploy `6a54cf0d…` ready at
  11:42:57Z. **All five conversion criteria hold — content_item, the ninth
  and final governed type, is CONVERTED. Forty-one objects converted total.**
- **W7.8 RECHECKED on the real export** (main fast-forwarded into the
  branch): build 173 pages (was 172); `/object-model-demo` carries all five
  `data-cms-node-id` wrappers + the object id (the chip anchors are in the
  shipped HTML); zero strategy vocabulary in output (leak rule); the article
  joined library + RSS automatically; edit-mode `targets.ts` maps
  `data-cms-node-id` → `update_node` scoped patches. Suite 1198 + 49 green ·
  astro check 0 errors. **What Wolf sees now**: enter edit mode on
  /object-model-demo → every block has a chip (pencil + node-scoped ✨);
  legacy .md articles still have body chips NOWHERE by ruling (only
  page_article furniture + chrome) — that is design, not drift.
- **Rulings recorded (plan §0.5 + §7)**: **OQ-W7-1 RESOLVED — reverse
  support is NOT required.** No alias layer; MCP tools/functions may be
  updated, changed, or retired as the remaining phases land; what must
  survive is FUNCTIONALITY on the object substrate (drafting workflow,
  publish safety stack, admin editor). W7.5's scope is re-pointing internal
  surfaces + retiring/re-pointing the ~31 legacy tools, not aliasing them.

**Still open (each its own session per the phase discipline)**: W7.2
(sections onto rich text, DOM-equivalence gate), W7.5 (reduced: re-point
`/admin/library` toggle + admin patch paths to object verbs; retire or
re-point the legacy `save_json_blob_*`/publish-article tool surface — the
5-agent workflow state moves into `body.workflow` per plan §3.4), W7.7
(admin editor on rich text + visible annotation panel + document-body
canvas/TipTap editing — today plain-text node bodies are the editable
canvas surface), OQ-W7-3 (strategy registry go/no-go, design in plan §2.5).
Standing caveats: unpublish unsupported (OQ-2 — the demo article stays live
until edited); the three shop products still await Wolf's approval in
/admin/objects.

## Session 2026-07-13 C (INCIDENT: agent images broke the production build — raw artifact keys in render fields; guardrail + heal)

Wolf: an agent-triggered build failed — "It had an image as part of its work.
this image was saved correctly in the blob store but it might have failed at
time of build." Root cause (Netlify log): the `Publish page: page_shop_preview`
agent run set the page's `content_split.images[].src` AND `seo.ogImage` to the
RAW artifact blob key `image/req_publish_premium_skus_20260713_01/<sha>.png`.
A raw Major-Key key is servable ONLY at its public path
`/img/<id>/<sha>.png` (the `/img/*` → `get-public-image?blobKey=image/:splat`
redirect); the raw form is neither a URL nor an imported asset, so Astro's
`getImage` on `ogImage` threw **`LocalImageUsedWrongly`** and failed the ENTIRE
static build (a plain `<img src>` like content_split just 404s silently). The
canvas image tool already stores the correct `/img/...` form; this agent used
the raw artifact-upload key. **Not caused by the W7/shop conversions** — a
standing gap: the OBJECT pipeline had no analogue of the ARTICLE pipeline's
`rawImageArtifactReferencePattern` guard (`publish-article.ts` hard-throws on
raw refs), and `checkArtifactTrust` only inspects `*AssetRef` fields (which
LEGITIMATELY hold raw refs — resolved/unrendered), never `src`/`ogImage`/`href`.

Fix (the trap-14 pattern — heal + guardrail):

- **Guardrail** (`checkRenderableImageRefs`, wired into the `renderability`
  group; contract constraint `render_image_ref`): a raw Major-Key artifact key
  (`image|pdf/{id}/{sha}.{ext}`) in ANY string leaf that is NOT a raw-ref
  carrier (`*AssetRef` or product `fulfillment.artifact_ref`) and not private
  `notes` is a BLOCKER at patch/create/publish — the message names the field
  AND the exact public path to use (`publicPathForArtifactRef`, the one
  exported `image/→/img/`, `pdf/→/pdf/` helper in artifact-trust.ts). So the
  broken store record CANNOT republish until fixed, and this class can't
  recur through the store.
- **Heal** (fix-forward, quarantine-safe because of the guardrail): the
  committed exports corrected in-repo — `page_shop_preview` images+ogImage →
  `/img/...`; the SAME scan also caught a PRE-EXISTING sibling bug the guard
  now covers: `pdf/...` raw keys in `kind:'asset'` "Download Starter PDF" link
  `target.href`s on `page_home` (×3) and `nav_header` — relative `pdf/...`
  hrefs 404 from any non-root page (nav is everywhere) → healed to `/pdf/...`.
  The store records still carry the raw values and now can't republish until
  an agent fixes them (the validation error tells them exactly what/how) —
  needs a store-side `object_patch` + publish per object (page_shop_preview,
  page_home, nav_header), no credentialed heal spent on it here.
- Gates: 1198 + 49 tests green (7 new: the helper + guard exemptions/blocks) ·
  astro check 0 · eslint/prettier clean · **production build REPRODUCED green
  (172 pages, the LocalImageUsedWrongly throw gone)**. Benign standing log
  line: the empty `articleObject` collection warns until the first article
  object export lands (W7 dir has only `.gitkeep`) — non-fatal.

## Session 2026-07-13 B (W7.3 + W7.8 BUILT: content_item is the ninth governed type; article bodies on the canvas — awaiting the credentialed run)

Wolf: "Finish W7 rich text with article migration. The committed posts can be
ignored, they are mostly junk and are not worth the effort. The article
section has to have canvas edit-mode overlay. Articles and human engagement
is of the most value, so they need to be converted in full … it is important
that not only basic attributes are attached to every article block but
context attributes related to it being a hook, agitation or a resolution.
Like in the original architecture." Three plan supersessions recorded (plan
§0 updated): **W7.4/W7.6 are WAIVED** (no migration of the 83 committed .md
posts, no DOM-equivalence harness over them — they stay on the legacy
pipeline untouched, OQ-W7-5 moot); **W7.8 canvas is mandatory in-wave**; the
node annotation layer is non-negotiable (already the plan's prime rule).
Recon first (Wolf suspected doc drift): main had gained canvas sessions P/Q/R
(#425 put chips on article-page SECTIONS + chrome, explicitly stopping at the
body) and W7.1's substrate — but `content_item` was still refused by every
verb. That gap is what this session built:

- **`content_item.v1` body schema** (`src/schema/bodies/content-item-v1.ts`):
  node envelope OUTSIDE, rich text INSIDE (plan §2.2). The semantic layer is
  IMPORTED from `article-content-v1.ts`, not copied — `private.strategy`
  (hook/agitation/context/…/resolution/summary), `intent`, `commercial`
  (offers/disclosure/rel/adSlot), `rendering`, `chat`, 3-state `visibility`,
  opaque `n_*` ids (forbidden-word rule kept). `public.body` is
  `string | rich_text.v1 document` (string = plain text, escaped; blank line
  = paragraph). Envelope: slug/title/deck/description/image/taxonomy/seo +
  the judge/score substrate — editorial, emotional_strategy, sources, claims
  (node_ids-wired), compliance, lineage {parent_content_id}, typed
  `scores[]` {scored_by, at, framework, dimension, score, rationale} (§2.4).
- **Ninth governed type end-to-end**: `governedObjectTypes` + approval config
  (Tier 1 = autonomous under the master, OQ-W7-4 — gate it any time with one
  config pin), create (dated `req_agent_<topic>_<yyyymmdd>_01` minting —
  req\_\* ids keep artifact trust intact §1.6), the **node op family**
  (set_article_meta + upsert/update/move/remove_node + set_node_visibility;
  exact inverses via the section-family mechanics; "mark this block a hook"
  is ONE op: `update_node {fields:{private:{strategy:'hook'}}}`),
  **`create_variant`** verb + `object_create_variant` MCP tool (node ids
  re-minted deterministically, claims/compliance node_ids re-pointed,
  lineage set, scores reset, slug uniqueness enforced; `dry_run` for
  zero-residue production proofs), materializer →
  `src/data/site/articles/{req_id}.json`, publish/release through the
  standard pipeline, full contract (annotations contract-visible).
- **Validation**: schema; taxonomy category/tags resolve as REGISTRY SLUGS
  (store resolver now matches slug or term_id, aliases followed;
  registry-gated like the W3 hook); article slug unique across article
  objects AND committed posts (one permalink space; `isArticleSlugTaken`);
  node-id uniqueness; ≥1 public content node publish-gated; rich-text bodies
  restricted to the RENDERABLE grammar (prose + quotes; embeds blocked until
  their resolvers exist — trap-5 discipline) + https-only hyperlinks;
  **reader safety runs on the READER PROJECTION** (public fields of public
  nodes) so the annotation layer is legal record data while a strategy word
  in public copy still blocks; deploy-safety walks everything incl. notes
  (the export commits to the repo).
- **Render path**: published article exports join `fetchPosts()` as
  first-class posts (listings, categories, tags, related scoring, RSS,
  search — no per-surface wiring) via a new `articleObject` collection
  (generateId pinned: bodies carry `slug`, the S2 lesson) and ONE node
  renderer (`src/lib/article-object/render-nodes.ts`) into the article
  route's dormant `set:html` branch — SinglePost furniture, SEO merge, and
  page_article extras all unchanged. Never-render-private: internal/hidden
  nodes emit NOTHING; the leak rule is test-grepped (no strategy vocabulary
  in output). Offers render with disclosure + rel (bug ② partially paid);
  unsafe hrefs degrade to text; hero image via `body.image` (bug ③);
  reading time computed to the md convention.
- **W7.8 canvas (the OQ-8 stop line lifts)**: every rendered node carries
  `data-cms-node-*` identity; node chips (pencil + sparkles; image tool on
  content nodes) ride the SAME EditSession → `update_node` → pending tray →
  publish/release path as sections. Ask-AI gains NODE SCOPE
  (`ask-ai-object.ts`): tool = the node's PUBLIC copy grammar with
  protected-field strip (+`ctaLink`), a document body is excluded (no
  flattening), and the node's strategy/intent flow INTO the prompt ("write
  copy for a hook") but never into the suggestion. The legacy article Ask-AI
  (admin-ask-ai-node, workflow records) is untouched.
- **Driver + seeds**: `articleDrillOps` (probe node cloned/poked — copy AND
  annotation — hidden/moved/removed, byte-identical end), create_variant
  dry-run proof (the instantiate pattern), content_item materializer
  dispatch, and `scripts/lib/articles-seed-data.mjs` — one honest
  demonstration article (full PAS-ish arc of annotated nodes + a
  node-wired claim) at slug `object-model-demo`.
- **Gates**: 1195 + 49 tests green (~60 new; 8 old posture pins deliberately
  flipped) · astro check 0 errors · eslint/prettier clean · **build-diff
  EMPTY (173/173 identical)** — with no article exports the change is
  render-inert · probe-export build verified in dist (article page + node
  wrappers + zero leaks + listing/RSS inclusion), then removed · **local
  rehearsal ALL GREEN** (ensure → 6/6 ops → validate → publish blocked at
  the expected sandbox boundary → variant dry-run → contract 6/6 advertised
  ≡ exercised → inventory).

**Status: BUILT + REHEARSED, not converted.** The credentialed run flips it:
`node scripts/home-conversion-roundtrip.mjs --production --release --seeds scripts/lib/articles-seed-data.mjs`
(schema-vintage gate applies — merge + deploy main first). Standing caveats,
named honestly: (1) **unpublish is still unsupported (OQ-2)** — once the demo
article publishes + releases it is live at /object-model-demo until edited;
the run may stop at the drill (criteria 1–4 proven, record stays draft) if
that's unwanted. (2) Rich-text DOCUMENT bodies exist end-to-end but have no
canvas/TipTap editor yet — plain-text bodies are the editable v1 surface;
W7.2/W7.7 (sections onto rich text; the admin editor + annotation panel +
embeds) remain open, as does the OQ-W7-3 strategy-registry go/no-go and the
W7.5 alias layer (legacy tools untouched this session; the ~31 article tool
names still serve only the .md pipeline). (3) A locally deleted article
export needs `node_modules/.astro` cleared (dev-cache only; CI/Netlify build
clean).

## Session 2026-07-13 (W5 CREDENTIALED RUN: the three hand-coded pages are CONVERTED — the hand-coded-page backlog is EMPTY)

Wolf ran the credentialed `--production --release` driver against the live
MCP endpoint with `scripts/lib/pages-w5-seed-data.mjs`. Result (verbatim
from the run): `page_shop_preview`, `page_pricing`, `page_services` each
`ensure created → drill every permitted op → published`, then
`contract page 6/6`, `inventory` returns all three, and
`release_to_production — live at commit`. **All five conversion criteria now
hold for the three pages** (rendering was proven in `dist` at build time —
172 pages, tiers showing $19/Free/Pay-what-you-want — the public URL is
still 403 behind the pre-launch `SITE_NOT_YET_LIVE` gate, so store-side
proof is the driver's own published+released+inventory, not a public
fetch). The server committed the page exports to main
(`Publish page: page_{shop_preview,pricing,services}`). This closes the
plan's "after S2/S3" conversions — **every routable page on the site now
renders from a page object; zero hand-coded page routes remain.**

Still open (unchanged, all Wolf-side): the three MOCK products
(`prod_barrier_repair_guide`, `prod_starter_checklist`,
`prod_support_the_work`) stopped at `approval_required` exactly as the
review-required gate intends — approve each in /admin/objects and re-run
the same idempotent command to convert them too. Launch gates: the LIVE
Stripe test-mode exit run (needs STRIPE_MODE + both key pairs +
PURCHASE_TOKEN_SECRET), PUBLISH_SECRET rotation, and the
`SITE_NOT_YET_LIVE` flip. Docs flipped in this same change: object-inventory
§1 (SEEDED → CONVERTED) and conversion-map (HAND-CODED PAGES node + W5 row).

## Session 2026-07-12 R (CANVAS Tier-1 surfaces: article pages, chrome, related-articles dropdown)

Wolf: "Article publishing Tier 1 after conversion does not have canvas mode …
apply the same treatment to the article and other tier one objects like
headers, footers … A set of 'other articles to read' below an article can
have an AI option and a simple choice of existing selection algorithms
through a stylish dropdown … inline with AI action button." Shipped on the
canvas branch (PR #425):

- **`content_grid` `related` source kind** (generalize-don't-replicate):
  `{kind:'related', algorithm: tag_similarity|same_category|latest}` —
  tag_similarity = the existing related-posts scoring, extracted pure as
  `rankRelatedPosts` (utils/blog.ts, single source of truth); anchored to
  the current post via a new resolve context (article route passes
  `relatedToPostId`), newest-first degradation elsewhere. Related-grid
  titles link to posts; query/manual grids keep audited unlinked markup.
- **Chip algorithm dropdown**: a related grid announces its algorithm via
  `data-cms-related-algorithm`; the chip renders a compact chip-native
  select inline with the sparkles; change → checkout →
  `update_section_data {source:{kind:'related',algorithm}}` draft.
- **Article pages get canvas**: `ObjectSections` leaves a zero-height
  `data-cms-empty-object` marker on object-empty pages; the gap layer turns
  it into one add "+" → the FIRST page_article section is addable from the
  canvas ("Related articles" joined the palette — the one reference-free
  content_grid starter). An object-backed related grid REPLACES the
  hardcoded RelatedPosts furniture; absent one, byte-identical legacy. The
  article BODY stays Tier-1 (OQ-8 line; /admin/publish).
- **Chrome**: Header/Footer wrapped in `data-cms-nav-object` (PageLayout +
  PageObjectRenderer footer override). Chip marked site-wide, pencil-only →
  copy form (item labels incl. children, group titles, brand, footNote)
  from pure `nav-editor.ts`; saves map to the NAV grammar — update_item,
  upsert_group (replace-by-id, current group rides along),
  remove_action+upsert_action renames, coalesced set_nav_meta — via
  EditSession('navigation'). Local body kept in step
  (`applyNavChangesToBody`) so sequential saves never resend stale groups.
  Targets/hrefs/icons excluded (structural = protected boundary); no AI
  chat on chrome.
- **Gates**: 11 new tests (related resolver + degradation + schema-valid
  page; annotation announces algorithm and only for related; nav-editor
  flatten/ops/throw/apply incl. every-op-legal check; palette related-only
  content_grid rule + empty-anchor append), suite 1159+49 green, astro
  check 0, build 172 pages, drive 60 assertions (nav chip site-wide/no-AI,
  nav grammar op on save, dropdown value + inline-with-AI + patch wire
  shape + annotation update, empty-marker "+" → palette targets
  page_article → upsert_section related grid). Docs: 07 §3f.
- **To make it real on production**: enter edit mode on any article page,
  click the "+" below the article, pick "Related articles", publish +
  release (the store write happens through the verbs; no code or seed
  needed). Header/footer copy edits work the same day-one.

## Session 2026-07-12 Q (CANVAS panel UI: icon-led collapsible accordion)

Wolf: "make the modal UI collapsible accordion. use less text and more
representative iconography. be focused on style and UX … do not use colors
that are outside of a current Astro schema." Shipped on the canvas branch
(PR #425):

- The docked panel is now one **accordion**: three icon-headed sections
  (✨ Ask AI / ✏️ Edit text / 🖼 Image), one expanded at a time (open one
  grows, rest collapse to a head + chevron). Chip tools open their section;
  accordion heads switch tools in place; clicking the open head collapses to
  a compact rail. Image section only shown for image-bearing types.
- **Iconography over prose**: identity = type + monospace id + tiny
  shared/draft dots (no sentences); actions are icon buttons w/ tooltips
  (check=save, undo=discard, plane=send, up-arrow=upload); sys/log lines
  terse + glyph-prefixed; field hints one-liners. Tray text trimmed too.
- **Palette discipline**: every color is a project `--aw-*` token via the
  `--dlem-*` layer — nothing bespoke; light/dark flips with the site.
- Structure preserved: same modes/data-hooks (`data-em-*`, `.dl-em-mode-*`),
  so the verbs/tests are untouched. Gates: astro check 0, eslint/prettier
  clean, suite 1148+49 green, build 172 pages, drive extended to 49
  assertions (3-section accordion, AI expanded/others collapsed, icon-only
  send, head-switch collapses previous, open-head collapse). Docs:
  07-canvas-editing.md §3e.

## Session 2026-07-12 P (CANVAS image tool v2: array images, blob-backed uploads, AI image references)

Wolf, on the Codex array-image finding + storage: "Close the gap. Also, those
images also need to be stored in blobs for edits and other manipulation as
happens now with pdf-tool. Same goes for About image or any other image."
Shipped on the canvas branch (PR #425):

- **Array images (Codex gap closed)**: the image tool now renders image
  ARRAYS (`content_split` `images: [{src,alt}]`) — one src/alt pair per item;
  save copies the array and patches it wholesale (deep-merge replaces arrays),
  editing only the touched item. `content_split` joins `bio` in
  `IMAGE_SECTION_TYPES`.
- **Blob-backed uploads (pdf-tool pattern, zero new write paths)**:
  - `admin-artifact-upload-intent.ts` (+ pure core
    `netlify/lib/canvas-upload-intent.ts`): admin-gated mint of the EXISTING
    HMAC upload token; server controls the claims — `requestId =
req_canvas_<object>_<yyyymmdd>_01`, kind `image`, filename from content
    type; JPEG/PNG/WebP only (what save-side sharp validation accepts).
  - Bytes go to the same `/api/artifacts/upload` agents use (re-verifies
    size/sha256/decodability against the signed claims); content-addressed
    keys `image/<requestId>/<sha256>.<ext>`.
  - **Public serving**: `/img/*` → new `get-public-image.ts`, the image
    mirror of `get-public-pdf.ts` — extension allowlist, immutable cache
    (content-addressed), CSP + nosniff. Sections carry the root-relative
    `/img/…` path (deploy-safe; renders through existing components).
  - Canvas: each src row gets an **Upload** button
    (`uploadImageArtifact` in `verbs-client.ts`: crypto.subtle sha256 →
    intent → tokened byte POST → fill src). Upload is storage-only; the src
    change still walks checkout → patch → publish → release.
- **AI image references ("Re: portrait.png", same session, Wolf)**: the AI
  chat on an image-bearing section shows image chips; arming one (a) ensures
  the image is blob-backed — existing repo images (`/images/…`) are
  **mirrored into the artifacts store** via the same pipeline, storage-only,
  src untouched — and (b) sends `image_ref {field, name, url}` with every
  ask. The section prompt gains a "Re: <name> — publicly served at <url>"
  clause (the public URL is the handle external image-editing tools need).
  Copy-only guard unchanged: image fields still never survive a suggestion.
- **Gates**: 15 new tests (intent mint/round-trip/rejections; public image
  route incl. real underscored canvas keys + 404/405/allowlist; image_ref
  prompt clause + guard-still-strips + optionality), full suite 1148+49
  green, astro check 0, build 172 pages, drive extended to 42 assertions
  (upload wire shapes; chip → mirror → armed pill → image_ref on the wire).
  Docs: 07-canvas-editing.md §3c/§3d.
- **Env note**: the intent endpoint needs `ARTIFACT_UPLOAD_TOKEN_SECRET` —
  already configured (the pdf-tool upload path uses it).

## Session 2026-07-12 O (CANVAS manual tools: icon toolbar, field editor, image tool, gap "+" add)

Wolf: "add text edit tools to each relevant object … remove the wording Ask AI
and replace it with an icon [stars slightly brighter] … other objects may
require uploads or other tools … hovering between objects [show] an Add
symbol." Shipped on the #423 branch (same canvas scope as the guard):

- **Chip → icon toolbar**: pencil (Edit text), image tool (types with image
  fields — `bio`), and an icon-only sparkles whose stars use `--dlem-spark`
  (site gold lifted toward white) so the AI action reads a notch brighter
  than the other tools. Tooltips carry the words; no "Ask AI" text.
- **Manual field editor** (pencil): copy fields only (same non-copy exclusion
  the AI guard enforces), Save draft → checkout → `update_section_data`,
  in-place preview, publish separate. **Image tool**: src/alt + live
  thumbnail — the deliberate image-change path (AI stays schema-blocked);
  also Wolf's in-canvas fix for the About portrait. Upload = later slice.
- **Gap "+"**: subtle round + above/between/below a page object's sections →
  compact palette (`sections-palette.ts`, pure; starters proven schema-valid
  - splitter-safe in tests) → `upsert_section` at a record-derived position
    (hidden-section safe, anchored by id), server-minted id, honest annotated
    draft placeholder in place until publish + release.
- Fixed en route: `.dl-em-actions[hidden]` was overridden by its own
  display:flex (the Accept row showed empty on fresh panels).
- **Gates**: 1104 + 49 tests (palette starters validated against the REAL
  section schema + splitters; insert-position math), astro check 0, build
  172 pages, headless drive extended to 25 assertions (icon toolbar, manual
  edit patch shape, image tool patch shape incl. alt preservation, gap add
  upsert wire shape + placeholder) — all green in both themes.

## Session 2026-07-12 N (CANVAS bug: copy-AI dropped an image — copy-only guard added)

First real production incident from the canvas, reported by Wolf: an AI edit
to the /about intro (heading → add "Ph.D") also **silently swapped the bio
`portrait.src`** from the working local `/images/dr-lurie-portrait4.jpeg` to a
hallucinated `https://kugelmedia.netlify.app/drlurieblog/dr-lurie-portrait.jpg`
(the model echoed the `kugelmedia.netlify.app/drlurieblog/` CDN pattern it saw
elsewhere in site data + a plausible filename). Published as `36b060c`, it
broke the About portrait — and was the "change I did not make." (The three
`prod_*` rows in Wolf's pending tray were unrelated: shop products the
inventory `pending_changes` filter surfaces, not canvas edits.)

**Root cause**: the section-scoped Ask-AI exposed the section's FULL data
schema — including media/asset/reference fields — to the model, and applied
whatever it returned (deep-merge). An LLM will hallucinate URLs.

**Fix (copy-only guard)**: `isProtectedAskAiField` (`ask-ai-schema.ts`) names
the non-copy fields — media/asset (`portrait`, `*AssetRef`, `logo`, `icon`,
`ogImage`, `src`…), references/bindings (`source`, `products`, `contentItem`,
`section`, `formName`, `actions`/`links`…), structure/routing (`route`,
`sections`, `slug`, `anchor`…). `deriveAskAiToolSchema` gains `protectFields`
(set on the canvas section path, off for whole-object admin asks) that strips
them from the tool schema, plus a defensive re-strip of the suggestion in
`ask-ai-object.ts`. The copy AI now edits **text only**. 1093 + 49 tests
(27 ask-ai, incl. a hallucinated-portrait regression test), astro check 0,
eslint/prettier clean. **Follow-ups**: (1) restore the live portrait to
`/images/dr-lurie-portrait4.jpeg` on `sec_about_intro` (inner id `s_intro`) —
needs the production key; (2) the canvas has no manual (non-AI) field editor,
which is now the only sanctioned way to deliberately change an image — worth
building next.

## Session 2026-07-12 M (W7.1 BUILT: the rich_text.v1 substrate — schema + renderer + ProseMirror mapper, inert by design)

Same session (PR #422 — the W7 plan — merged; branch restarted). Wolf's
rulings recorded first: **articles keep Tier 1** (OQ-W7-4 resolved, plan §7
updated on the PR before merge) and the expanded `strategy_drlurie` registry
design shipped into plan §2.5 (go/no-go still open). Mid-session directive
recorded: **canvas editing belongs to ANOTHER session** — articles are not
canvas-wired yet (they aren't objects yet at all); W7.8 is reassigned to that
session's owner when the wave gets there. Nothing canvas-adjacent was touched
here.

W7.1 per the plan, all three substrate pieces in `src/lib/richtext/`:

- **`rich-text-v1.ts`** — the zod mirror of Contentful's node tree
  (`@contentful/rich-text-types` constants are the name source), restricted
  to the house universe: p / h2 / h3 / ul / ol / li / blockquote /
  embedded-entry-block / embedded-asset-block; marks bold + italic;
  hyperlink inline (uri pinned whitespace-free). Per-field narrowing is a
  **`RichTextGrammar`** (enabledNodeTypes/enabledMarks — the D§3.5
  allowlist-becomes-declaration), with the three presets that mirror today's
  splitter vocabularies: INLINE_COPY (p-only fields), PROSE (prose.body),
  ARTICLE_BODY (adds quotes + embeds, the W7.3 target). `data` on every node
  is the annotation carrier — nothing writes to it in this phase.
- **`render-html.ts`** — build-time renderer over
  `@contentful/rich-text-html-renderer` (v17): marks emit the house
  `<strong>`/`<em>` (not the lib's b/i), embeds REQUIRE injected resolvers
  and throw naming the target when absent (never-silently-drop), input is
  schema-validated first, `node.data` never reaches HTML (leak-rule test
  greps the output), and `\n` in text values renders as `<br/>` via a
  post-pass (v17 ignores `renderText`; safe because the lib emits no
  formatting newlines and uris are whitespace-free by schema — verified
  empirically, incl. default text/attribute escaping).
- **`prosemirror.ts`** — the ONE TipTap/ProseMirror ↔ rich_text.v1 mapper
  (W7.2 editors + W7.7 article editor share it): heading levels 2–3, lists,
  blockquote, bold/italic; link MARKS ↔ hyperlink INLINE nodes (consecutive
  same-href runs merge, split back on return); hardBreak ↔ '\n'-in-value;
  everything outside the universe throws naming the type. Structural types
  only — no editor package imports in the build graph.

Gates: **1116 + 49 tests green** (27 new across three test files, incl. both
round-trip directions and the leak rule) · astro check 0 errors ·
eslint/prettier clean · **build-diff EMPTY (173/173 identical)** — the
substrate is used by nothing, exactly as specified. New deps:
`@contentful/rich-text-types`, `@contentful/rich-text-html-renderer`.
NEXT: W7.2 (section body fields accept string | document; one-time export
conversion; TipTap emits rich text) — DOM-equivalence gate, own session/PR.

## Session 2026-07-12 L (W7 PLANNED: OQ-8 RESOLVED as one-time migration — articles onto the object model + Rich Text; plan doc, not code)

Wolf opened the article wave ("let's move with articles W7. be careful, I
need the functionality developed for article publishing") and answered the
four forks in-session — **OQ-8 is resolved: (1) one-time MIGRATION to
ObjectRecords** (adapter path retired), (2) **build the Contentful Rich Text
substrate now** (core-structure tasks 1–5, confirmed never built — sections
use TipTap-HTML strings + splitters today), (3) canvas-for-articles in-wave
if it fits, (4) plan doc first per the shop precedent. His preservation
directive is the wave's prime rule: the `article_body.v1` semantic layer
(per-node `private.strategy`/`intent`, commercial metadata + disclosure,
chat, opaque ids, input templates; envelope-level emotional_strategy/claims/
sources/compliance/scoring slots) exists so "agents can judge, score and
build variants quickly" — it must come out of W7 MORE agent-usable, never
flattened.

**The plan is [`08-articles-plan.md`](../08-articles-plan.md).** Spine:
`content_item` = ninth object type keeping `req_*` ids verbatim (artifact
trust/blobKeys survive unchanged); body = **node envelope outside, Rich Text
inside** (a hook can span paragraphs — the node grouping IS the behavioral
structure; `public.body` upgrades string → `rich_text.v1` document); one
renderer for build/admin/canvas; `create_variant` + typed `scores[]` as the
A/B substrate (serving/traffic-split explicitly out of v1); the ~31 article
tool names live on as thin aliases over object verbs (external agent configs
call them by name); 5-agent workflow state moves into `body.workflow`;
per-article cutover flags + a DOM-equivalence harness (83 committed posts
keep URLs and rendering); the `workflows` store retires read-only as the
rollback source. Ten-bug register dispositioned (recon this session; nothing
was in the issue tracker): ①⑦⑨ die structurally, ② becomes the renderer
feature matrix (offers/adSlots/chatInvite/PDF media render for the first
time), ③④⑤⑥⑧⑩ are named phase tasks. Phases W7.1–W7.9, each its own
session/PR; six OQ-W7 checkpoints for Wolf (alias sunset, variant serving,
strategy vocabulary as a `strategy_drlurie` registry vs code enums, Tier 1
posture, `.md` retirement, credentialed workflows-store inventory). §3.10's
freeze lifts only inside the approved phases. NOT in this session: any code —
W7.1 (rich_text.v1 substrate) starts on Wolf's approval of the plan.

## Session 2026-07-12 K (CANVAS Ask-AI runs on OpenAI; retheme + review fixes landed)

Follow-ups to the merged canvas (PRs #415/#417/#418), each its own PR restarted
from main:

- **Ask-AI provider → OpenAI (Wolf's call: "replace")**: the generic canvas
  Ask-AI (`netlify/lib/ask-ai-object.ts` + `admin-ask-ai-object.ts`) now calls
  OpenAI Chat Completions function-calling with `OPENAI_API_KEY` (already
  configured for ChatKit / the publisher agent) and `OPENAI_MODEL` (default
  `gpt-4o`), replacing the Anthropic Messages call. The zod-derived tool schema
  is plain JSON Schema, so it is the OpenAI function's `parameters` verbatim; a
  forced `tool_choice` keeps the reply structured (arguments arrive as a JSON
  string — parsed before the null-strip). **Provider-only swap**: read-only
  contract, section scoping, shared_ref refusal, and the human **Accept** gate
  are unchanged — the AI still cannot write a field; Accept → object_patch
  (draft) → Publish → Release remain the three human gates. The article Ask-AI
  (`admin-ask-ai-node.ts`) is a separate system, untouched. Both ask-ai test
  files reworked to the OpenAI wire shape; 23 ask-ai tests + full suite green.
- **Retheme (#418, merged)**: canvas chrome derives every color/font from the
  project's `--aw-*` design tokens (auto-flips light/dark); no hardcoded purple.
- **Review fixes (#417, merged)**: lapsed-token sessions keep the canvas;
  listing-page headers carry editing chips.

Gates for the OpenAI swap: 1089 + 49 tests, astro check 0 errors, build 172
pages, eslint/prettier clean. Not yet exercised against the real OpenAI
endpoint (same credentialed-run boundary as the rest of the canvas).

## Session 2026-07-12 J (W5 PAGES SEEDED: /pricing, /services, shop-preview — zero hand-coded page routes left; commerce_orders admin tool)

Same session (PR #416 merged; branch restarted). The plan's "after S2/S3"
page conversions, per Wolf's directive ("convert W5 pricing and the other
passed-over pages; agents get full store administration"):

- **Three new REUSABLE section types** (schema → registry → component →
  resolver → validation → editors, the full wiring): `steps` (numbered
  icon cards), `content_split` (kicker/heading/rich body + actions + up to
  2 staggered images — the bespoke shop-preview hero generalized, its
  scoped styles absorbed), `pricing_table` (tiers REFERENCE product
  objects; title/price badge/availability/CTA href resolve from commerce
  data at build — copy never drifts from the store; unavailable products
  render "Coming soon", ghost refs are skipped with a build warning and
  BLOCKED at write by reference integrity).
- **Three page objects, three route files DELETED** (importers verified):
  `page_shop_preview` (/solutions/shop-preview — REAL copy verbatim;
  nav's route-kind links unchanged, same route now object-served),
  `page_pricing` + `page_services` (previously unlinked Astrowind lorem —
  MOCK copy per Wolf's 2026-07-12 directive). All standard pages on the
  object-page catch-all: **the hand-coded-page backlog is EMPTY — every
  routable page on the site now renders from a page object.**
  (`feature_grid` deliberately not minted: content_grid `cards` already
  covers icon grids — design-principles rule 1.)
- **`commerce_orders` MCP tool** (netlify/lib/commerce-admin.ts): the
  support-lookup half of store administration — list orders by
  email/product (newest-first, capped) or fetch full detail by order_key;
  what order_reissue needed to be operable from "customer lost the email".
  Read-only; raw buyer email visible by design (§6 — publish-key surface).
- **BUG FOUND + FIXED (latent since S2)**: Astro's glob loader prefers a
  top-level `slug` field for the entry id — product exports HAVE one, so
  `getCollection('productObject')` ids were the slug, not the object id.
  Every by-object-id lookup against the collection silently failed: the
  BUY BOX embedded the wrong product_id (live checkout would have 404'd
  product_not_found), and pricing_table tiers/manual product_preview picks
  never resolved. Pinned `generateId` to the filename (= object id) in
  content/config.ts; /shop buy flow and tiers verified in dist.
- Seed module prepends the S2 product seeds as reference targets
  (playbook trap 3 — imported from the shop module, one catalog source);
  driver materialize no longer crashes on a never-created object.

Local rehearsal: full lifecycle SUCCESS (ensure/drill/contract/inventory/
materialize ×6; pages block only at export_commit_failed, products at
approval_required — both expected terminals). Suite 1089 + 49 green; astro
check 0; eslint/prettier clean; build 172 pages — /pricing, /services,
/solutions/shop-preview all render from objects with resolved tiers
($19/Free/Pay-what-you-want badges live). **Rendered + seeded, NOT yet
converted**: the three pages await the credentialed `--production
--release` run (same run can approve the three products stuck at
approval_required). W5 empties the hand-coded backlog for good.

## Session 2026-07-12 I (S3 SHIPPED: PWYW + free + unlock paths; the two commerce MCP tools — criterion 4 closes)

Same session (PR #414 merged; branch restarted). S3 per plan §9 — the
product type's permitted-action surface is now COMPLETE:

- **`set_product_price` patch op** — the §3 funnel's WRITER, the exact
  complement of set_product_fields' refusal: `fields` restricted BY THE
  GRAMMAR to commerce.price/stripe/stripe_test (shape-pinned); internal
  (`agent_authored: false`, the reactivate_term posture); inverts to itself
  with the captured before-tree = "re-point to the archived price".
- **`product_set_price` MCP tool** (netlify/lib/product-set-price.ts):
  creates the new Stripe Price (immutable prices), archives the old one,
  writes cache + the running mode's linkage in ONE governed
  checkout→patch→checkin — cache ≡ what Stripe just created, by
  construction. Bootstraps a Stripe Product for unlinked products. Does NOT
  publish: the change waits for the §0.4 human approval.
- **`order_reissue` MCP tool** (netlify/lib/order-reissue.ts): regenerates
  a download link from the ORDER record alone (orders now store
  `fulfillment.artifact_ref` — §5's "fulfillment is a pure function of the
  order record" made literal; S1c-era orders fall back to the product's
  current ref). Audited reissue entries {at, token_hash, by} + a
  fulfillment_reissued event; ttl 1h–14d.
- **PWYW checkout**: the buyer picks the amount; create-checkout-session is
  the minimum-enforcement point (§3 — no Stripe Price exists; price_data
  charges the chosen amount against the linked Stripe Product). Buy box
  grew an amount input.
- **Free claim** (netlify/functions/claim-free.ts): direct token issuance
  through the SAME order/event machinery (ord*free*…, session null, amount 0) + the lead-capture tie-in (optional email → the opt-ins store). Buy
  box: "Get it free" renders the download link inline.
- **Unlock kind**: checkout requires an EXISTING pre-generated artifact
  under the product's unlock_prefix (nobody pays for a ghost); the webhook
  mints the token over exactly that key. The buy box keeps unlock products
  unbuyable until the artifact-generator integration exists.
- Drill: fixed products now exercise BOTH ops (price poked one cent,
  restored byte-identical); the driver unions exercised ops per type for
  the contract check. Local rehearsal: contract product 2/2 — **criterion 4
  is fully closed for the product type**.

Suite 1061 + 49 green; astro check 0; eslint/prettier clean; build 172
pages. The shop plan's §9 critical path (S1a→S1b→S1c→S2→S3) is now fully
built. Remaining, per plan: the credentialed production run (products stop
at approval_required → Wolf approves), the LIVE Stripe exit test (launch
gate, needs keys), and the after-S3 page conversions (/pricing with
pricing_table; /services + shop-preview with mockup copy per Wolf's
directive).

## Session 2026-07-12 H (CANVAS SHIPPED: the site is the editing surface — admin inline Ask-AI, draft-in-place, publish/release tray)

Wolf approved the edit-mode canvas plan ("go on and start work on this,
layering phases over preexisting conversion steps; stop at the article
publishing engine; ignore the old admin editor in favor of this UX") after a
feasibility/UX write-up + interactive mockup. Shipped in four commits on
`claude/admin-inline-ai-editing-trkigv` — full doc:
[`07-canvas-editing.md`](../07-canvas-editing.md).

- **Section identity in the built HTML**: both dispatch sites wrap every
  section in a `display:contents` element carrying
  `data-cms-object-id/-section-id/-section-type` (+ `-shared-object` for
  shared*ref derefs — `resolveSections` now keeps the `sec*\*`id on`RenderableSection`). No box, no layout change; ObjectSections gained a
required `objectId` prop (threaded from the 6 listing routes).
- **Section-scoped Ask-AI (additive)**: `admin-ask-ai-object` takes
  `section_id` (pages) — tool derived from the section type's own data
  grammar (`sectionDataSchemaForType`, generic over the union), suggestion
  maps 1:1 onto `update_section_data`; shared_ref scopes are refused with the
  target id; section OBJECTS auto-scope to their inner instance. Read-only as
  ever; content_item still refused (article Ask-AI untouched — the stop line).
- **The overlay** (`src/lib/edit-mode/`): dormant 1.5KB loader in Layout →
  GoTrue + server-side admin-auth-state gate → 27KB code-split editor for
  admins only. Hover chips (✨ Ask AI, selection-aware, shared/draft flags),
  docked panel diffing against the DRAFT record, conservative in-place
  preview (real splitters; honest fallback to panel diff), Accept →
  checkout → patch via shared LockManager (`EditSession`; 409-retry, 422
  blockers surfaced, foreign locks named), pending tray fed by
  `inventory {pending_changes:true}` with per-object Publish and Release.
  Draft state survives reloads (amber framing on load).
- **Gates**: 1071/1071 tests (+~45 new: annotations, scope, target routing),
  astro check 0, build 167 pages, **headless-browser drive of the real built
  site end-to-end** (dormant visitor path verified — zero admin calls/chunk;
  full edit flow wire shapes asserted; one real bug found+fixed by the drive).
  Build output now differs from pre-canvas builds by the inert data-cms-\*
  attributes only — sanctioned, one-time.
- **NOT done (deliberate)**: articles on the canvas (W7/OQ-8 — Wolf's stop),
  structural ops UI (add/move/remove/meta), OQ-9 SSR draft preview, W7 rich
  text itself (next conversion wave), and the credentialed production
  walk-through of one canvas edit (sandbox boundary — same as every
  conversion; suggest page_thank_you first).

## Session 2026-07-12 G (S2 BUILT + SEEDED: /shop catalog + product pages, mock content — awaiting credentialed run)

Same session (PR #413 merged; branch restarted). S2 per plan §4/§9, with
Wolf's mockup-data directive applied:

- **`product_preview` upgraded** from a dead static `ProductCard[]` (no live
  usage) to the M-8 source union over PRODUCT objects: `query` (every
  available product) / `manual` (+query fallback) / `cards` (curated cells).
  `resolveContentGridCards` generalized over the query type (same semantics,
  one owner); resolvers load available products from the new `productObject`
  collection ONLY when a section needs them (the dynamic-import chunk rule);
  mode decides the price badge ("$19" / "Pay what you want" / "Free").
  Manual picks validate through reference integrity (`requireObject
'product'`).
- **`/shop`** — NO route file: `page_shop` (standard) is the FIRST page
  served by the object-page catch-all in production use (the zero-code
  promise cashed in). Its grid is a `query` source, so newly published
  products appear with no page edit (the design-principles litmus).
- **`/shop/[slug]`** — the SinglePost-shaped loader: paths derive from
  published + AVAILABLE product exports (never-render-private for
  retired/coming_soon), buy box + hero from the product object, page_ref
  sections via ObjectSections, SEO defaults from `page_product_detail`
  (content_detail, the page_article idiom). Buy CTA posts to
  create-checkout-session; PWYW/free products show a disabled "Coming soon"
  until S3. `product_viewed` / `checkout_started` beacons use the
  save-opt-in sendBeacon pattern.
- **Seeds** (`pages-shop-seed-data.mjs`): three MOCK products covering all
  three commerce modes + the two pages. Driver + drill extended for product
  seeds (`productDrillOps` — set_product_fields poke/restore, never the §3
  funnel keys; materialize dispatch). **Local rehearsal ALL GREEN**: every
  permitted op drilled, contract 1/1 + 6/6, inventory 5/5, exports
  materialized and committed. Build: /shop + 3 product pages emit (172
  pages), dist carries the real copy/badges/wiring.
- **The review gate met the driver**: product publishes stop at
  `approval_required` — now recognized as the drill's expected terminal
  signal for gated types (sandbox AND production; the driver never works
  around the gate). The object-page-routes zero-paths pin was updated:
  page_shop legitimately emits through the catch-all now.

Suite 1051 + 49 green; astro check 0; eslint/prettier clean. **Next for the
credentialed run**: driver `--production` creates + drills the five objects,
products stop at approval_required → Wolf approves each in /admin/objects →
publish + release. Then S3 (PWYW/free/unlock + product_set_price +
order_reissue).

## Session 2026-07-12 F (S1c SHIPPED: checkout → webhook → token delivery → success page)

Same session (PR #412 merged; branch restarted). S1c per plan §9 — the whole
paid path for fixed-price downloads, built on S1b's substrate. The official
`stripe` SDK is the one new dependency (§7: session creation + webhook
signature verification; hand-rolling signature checks is malpractice).

- **`purchase-tokens.ts`**: HMAC-SHA256 expiring bearer tokens (72h default)
  embedding `{order_key, artifact_ref, exp}`, signed with
  `PURCHASE_TOKEN_SECRET` (min 16 chars or the endpoints 503). Signature is
  the authorization; order records keep only hashes (audit trail, not an
  allowlist — a fresh status-page token is as valid as the issued one).
- **`stripe-env.ts`** (§8.7): `STRIPE_MODE` picks the key pair (default
  'test' — a missing flag must never charge real cards);
  `stripeLinkageForMode` picks `commerce.stripe` vs `stripe_test`. All four
  key envs + the token secret are in PROTECTED_ENV_KEYS (§8.5). Lazy client
  - injectable test seam.
- **`create-checkout-session.ts`**: buyability gated on STORE state
  (published + active + available + linked); charges the linked `price_id`,
  never the cache (§3); stamps `metadata {product_id, event_id}`;
  success/cancel URLs from the server's own URL env, never a request header.
  v1 = fixed mode only (PWYW/free are S3).
- **`stripe-webhook.ts`**: signature-verified; `checkout.session.completed`
  → `writeOrderIfAbsent` (replays/double-fires no-op) → token minted for
  download kinds → authoritative events with DETERMINISTIC event ids + ts
  derived from the Stripe event, so replayed webhooks collide on the same
  store key and duplicate nothing (§8.2's window closes to true concurrent
  double-fires). §3 amount cross-check flags `amount_mismatch` + event.
  `checkout.session.expired` → idempotent `checkout_abandoned`. Non-2xx on
  store failures so Stripe retries.
- **`get-purchase.ts`**: token-gated streaming of the PRIVATE artifact
  (attachment, no-store) — 401/410/404 ladder, expired = Gone with a
  reissue hint; appends `download_succeeded` (best-effort).
- **`checkout-session-status.ts` + `/shop/thank-you`** (§8.8): the page
  verifies the session server-side and polls with backoff until the webhook
  lands — delivery never depends on email; Stripe's receipt is enabled
  Stripe-side.
- Tests: 23 new — including **the exit-test mechanics in sandbox form**:
  webhook delivered → replayed twice → ONE order, no duplicate events;
  amount-mismatch flag; unpaid-completion skip; token tamper/expiry ladder;
  status-poller transitions. (The REAL §9 exit test — a live Stripe
  test-mode purchase end-to-end — needs Stripe keys and is the launch-gate
  item, not runnable from this sandbox.) Suite 1044 green; astro check 0;
  build 168 pages (the thank-you page is new).

Env needed for production (all marked as secrets): STRIPE_MODE,
STRIPE_SECRET_KEY[_TEST], STRIPE_WEBHOOK_SECRET[_TEST],
PURCHASE_TOKEN_SECRET. NOT in S1c: PWYW/free/unlock paths + the two MCP
tools (S3), the /shop surfaces (S2).

## Session 2026-07-12 E (S1b SHIPPED: commerce + commerce-events stores, order/event libs, capture beacon)

Same session as S1a (PR #411 merged; branch restarted from main). S1b per
plan §9: the substrate the checkout path (S1c) writes into. Wolf directive
recorded this session: **products/services content uses MOCKUP data** — this
supersedes the plan's "/services awaits Wolf's copy-or-delete call" wait; S2
seeds mock products and the W5 conversions may seed mock copy (no longer
"silent lorem" — it is now sanctioned).

- **Stores** (`netlify/lib/blob-store.ts`, the one env-contract place):
  `commerce` (strong consistency — the success page polls the order the
  webhook just wrote) and `commerce-events` (eventual; append-only).
- **`commerce_order.v1`** (`netlify/lib/commerce-orders.ts`):
  `orders/<idempotency-key>.json` — Checkout Session id for paid orders, the
  minted order_id for free claims (§5). `writeOrderIfAbsent` is THE webhook
  idempotency mechanism: pre-read + `onlyIfNew` atomic write; replays and
  race-losers return the ORIGINAL record so fulfillment stays a pure
  function of first-write state. Raw buyer email lives ONLY here; tokens are
  never stored — only `sha256:` hashes (a store dump can't mint download
  links). Zod-strict, `reissues[]` ready for order_reissue (S3).
- **`commerce_event.v1`** (`netlify/lib/commerce-events.ts`): the §6
  substrate contract — 8 event types, one immutable JSON per event at
  `events/<yyyy-mm-dd>/<digits-ts>-<uuid>.json` (opt-ins layout; timestamp
  compacted to digits for local-FS key safety, still time-sorted).
  `appendCommerceEvent` is create-if-absent (immutable, replays no-op);
  `hashEmail` emits `sha256:<hex>` of the normalized address and the schema
  REJECTS anything in `actor.email_hash` that isn't that shape. Additive-only
  evolution documented in the module header.
- **Capture beacon** (`netlify/functions/save-commerce-event.ts`, the
  save-opt-in sibling): accepts ONLY the client-authored types
  (`product_viewed`, `checkout_started`) — authoritative types cannot be
  forged through the public endpoint; no email field accepted (hashed or
  raw); `data` is allowlisted (amount_cents/currency/mode), never
  passthrough; JSON parsed regardless of content-type (sendBeacon reality).
- Tests: 17 new (schema envelopes, PII rejections, idempotency + race
  paths, endpoint forgery/PII/allowlist) — suite 1021 green, astro check 0,
  eslint/prettier clean.

NOT in S1b: nothing reads these stores (by design, §6 — Blobs is not a
queryable database); S1c wires the writers (checkout session → webhook →
token delivery + success page), which is next on the critical path.

## Session 2026-07-12 D (S1a SHIPPED: `product` is the eighth object type — review-required, price-funnel enforced)

Shop build sequence started per [`06-shop-module-plan.md`](../06-shop-module-plan.md)
§9. **S1a is complete**: `product.v1` schema + object type + validation criteria

- contract + the review-required approval flip — the seam everything else hangs
  on. What exists now:

* **`product.v1` body schema** (`src/schema/bodies/product-v1.ts`): slug +
  presentation (title/excerpt/images/seo/`page_ref`/notes) + commerce
  (provider/mode/price/pwyw/stripe/stripe_test/availability, Stripe id shapes
  pinned so keys can't sit where ids belong) + **fulfillment as THE
  discriminated union** (`download` {artifact_ref, filename} / `unlock`
  {unlock_prefix} / `none`), all strict.
* **Type wiring end-to-end**: `objectTypes` + `prod_` id patterns/minting
  (minted from `slug`), store keys, `object_create` seeding, materializer →
  `src/data/site/products/{id}.json`, Ask-AI schema registry, admin
  `prod_→product` prefix map.
* **`set_product_fields`** patch op (deep-merge + exact inverse, the
  set_site_fields mechanics) with the **§3 canonicality funnel in the
  grammar**: `commerce.price` / `commerce.stripe` / `commerce.stripe_test`
  payloads are refused at write with a pointer to `product_set_price` (S3) —
  price drift is impossible by construction, not by discipline.
* **Validation criteria** (standing engine): `product_slug` (shape + live
  uniqueness via the new `isSlugTaken` store resolver — the isRouteTaken
  analogue), `product_commerce` (mode↔fields coherence: fixed⇒price cache,
  pwyw⇒pwyw block + NO Stripe Price, free⇒provider none + no linkage),
  `product_linkage` (publish-gated: 'available' fixed products need price_id
  or the pre-launch stripe_test mirror; coming_soon/retired publish without),
  `product_artifact` (Major-Key trust for download refs), and
  `commerce_price_sync` (§3 backstop; injected `resolveStripePrice`, optional
  until the Stripe surface lands). `presentation.page_ref` resolves through
  reference integrity like any object ref. `STRIPE_SECRET_KEY` /
  `STRIPE_WEBHOOK_SECRET` pre-marked in the deploy-safety scanner (§8.5).
* **The §0.4 flip**: `src/config/approval-policy.ts` pins
  `product: 'require-approval'` under the all-autonomous master — the one
  deliberate exception; publish-gate matrix tests updated to pin it.
* **Proven, not assumed** (sandbox, real MCP handler against an isolated
  store): contract → create (id minted `prod_barrier_repair_guide`) →
  duplicate-slug create BLOCKED → checkout → validate → patch applies →
  price-edit patch REFUSED (`product_set_price` pointer) → publish DENIED
  `approval_required` → inventory row `requires_approval: true`. All gates
  green: 1004 unit tests + 49 script tests, astro check 0 errors, eslint,
  prettier, full build (167 pages).

**Status: type BUILT, store empty by design** — no product records exist yet;
nothing here is "converted" (that vocabulary applies to store-backed content
objects, which arrive with S2's seeds). NOT in S1a (deliberately, per §9):
S1b stores/events, S1c checkout/webhook/delivery, the S3 tools
(`product_set_price`, `order_reissue` — criterion-4 completeness for the
type), roundtrip-drill support (parallelizable), and the W5 page conversions.

## Session 2026-07-12 C (W6 CONVERTED: the six listing objects are #32–#37 — the credentialed run)

Wolf's credentialed run (after one stale-checkout false start — the seed
module wasn't in his working tree until `git pull`; the driver's error named
the missing path correctly) came back **all-green in a single pass**: every
`ensure` created the store record, all six drilled every permitted page op
(page_article via its seed `drillProbe` — the section-less path working in
production), validated, **published** (export commits `7956b13` `d460db0`
`37dd040` `37fea10` `27a416c` `b0f8d90` on main, `[skip netlify]`), contract
6/6, inventory 6/6, and `release_to_production` confirmed **`released:true`**
(one poll). Byte-verified from this session against main: **store === seed
=== export** for all six (marker-stripped; record_version 11 across the
board).

All five criteria met → `page_library`, `page_topics_index`,
`page_topic_detail`, `page_category`, `page_tag`, `page_article` flipped to
🟢 CONVERTED across inventory / conversion-map / playbook / CLAUDE.md /
AGENTS.md in this change. **Converted count: 31 → 37.** W6 is closed: the
listing surfaces' headings/copy/SEO are live agent levers (`%term%` pattern
copy included), `page_article` governs every article page's SEO defaults and
below-post sections, and the P6/T6.1 "biggest remaining chunk" is done.
Remaining on the path: the shop module (own session, plan in
`06-shop-module-plan.md` — its S-phases now carry the W5 pages) and W7 rich
text (OQ-8, Wolf's checkpoint). Standing caveat repeated: `PUBLISH_SECRET`
is a temp value pasted in chat again this run — rotation stays mandatory
before real go-live (it is a named launch gate in the shop plan).

## Session 2026-07-12 B (SHOP MODULE PLAN: W5 re-grounded in commerce — plan, not code)

W6 merged (PR #408) and Wolf redirected W5: "do the pricing pages and the
rest of the W5 pages which were passed over — but add the payment system,"
with a Stripe-only v1 shop brief whose deliverable is **a development plan,
not code**. Survey findings that shaped it: /pricing and /services are
audit-confirmed Astrowind lorem leftovers (A§2.13, unlinked — nothing on the
site links to them), /solutions/shop-preview is real content, there is NO
Stripe surface or customer identity anywhere yet, and the commerce-relevant
prior art is the artifacts store + get-public-pdf delivery, the opt-ins
append-only capture, crypto.ts HMAC, and the object model itself.

**The plan is [`06-shop-module-plan.md`](../06-shop-module-plan.md).** Spine:
`product` as a governed OBJECT type (not an article-pipeline clone — pushback
recorded), fulfillment as the only discriminated union
(download/unlock/none), Stripe canonical for charge amounts with a
display-cache + `product_set_price` tool making drift structurally
impossible, product pages = product object + `page_ref` Page rendered by the
W6 section machinery (product-vs-article answered: different object, same
renderer), an append-only `commerce_event.v1` log designed for an unknown
consumer, Checkout Sessions only (Payment Links rejected in v1), idempotent
webhook→order→signed-token fulfillment with `order_reissue` as
launch-critical, and the W5 pages sequenced AFTER products exist so
pricing_table/steps/feature_grid/content_split mint with real content
(/services still needs Wolf's copy-or-delete call; seeding lorem refused).
Commerce publishes flip to review-required; PUBLISH_SECRET rotation +
SITE_NOT_YET_LIVE flip named as launch gates. Next session starts at S1a
(product.v1 schema) per the build sequence.

## Session 2026-07-12 (W6 BUILT + SEEDED: listing surfaces — the last unimplemented PageTypes are formalized)

Wolf: "Move to W6 on the conversion to CMS path." The T6.1 batch, built the
design-principles way: **the six listing/article page objects own headings/
copy/SEO; the query machinery stays the audited build-time derivation**
(A§2.5–2.7 — getStaticPathsBlogList/Category/Tag, fetchPosts, the topics
derivation; D§5.5 holds: topics remain category presentations, no Topic
entity).

- **PageType law completed** (`src/lib/registry/page-types.ts`): `listing`
  (allowed: lede/prose/cta_banner/newsletter_signup/content_grid/link_list/
  shared_ref; **required: lede** — the first lede IS the surface's header
  block; `listing: {source: 'content_items', defaultQuery
{sort: published_time_desc}, paginate: true}`) and `content_detail`
  (no lede — the post supplies its heading; **`minVisibleSections: 0`**, a new
  per-PageType knob on the ≥1-visible-section publish gate: page_article
  publishes with zero sections because the article IS its content).
  `unimplementedPageTypeIds()` is now empty; `object_contract('page')` and
  `registry_get('page_type')` serve all five definitions automatically.
- **Six objects seeded** (`scripts/lib/pages-listing-seed-data.mjs`), bodies
  verbatim transcriptions: `page_library` (/learn/library), `page_topics_index`
  (/learn/topics), `page_topic_detail`, `page_category`, `page_tag`,
  `page_article`. **Per-term surfaces are ONE object per route family with
  `%term%` pattern copy** (`src/lib/renderer/listing-term.ts`, deep string
  interpolation, unit-tested): `page_tag.title = "Posts by tag '%term%'"` is an
  agent-editable heading pattern — the loader substitutes each term's display
  label at build. Routes are self-describing family patterns
  (`/category/[category]`, `/%slug%`) — unique, and never emitted by the
  catch-all: `object-page-routes.ts` gained the `loader_owned_page_type` skip
  (listing/content_detail objects are served BY their loaders; without this,
  page_article's `/%slug%` route would have minted a literal page).
- **Wiring** (the six route files + shared plumbing): each loader reads its
  object via `loadRoutePageObject` (`src/utils/route-page-object.ts` — first
  visible lede → header copy; title/seo term-interpolated; pre-conversion
  literals as fallback when the export is absent, the W4 pattern), renders the
  header through the surface's EXISTING furniture (Headline / topics hub
  markup — byte-identical cutover), keeps pagination suffixes + robots gating
  as furniture (object seo.robots wins when set, config.yaml stays the
  fallback), and dispatches **every extra section through the component
  registry after the list/article** (`ObjectSections.astro` — hidden filtered).
  An agent can now put a cta_banner under the library list or a
  newsletter_signup below EVERY article with one patch op (proven with temp
  probes in dist, then removed). PageObjectRenderer's dep-building was
  extracted to `section-resolve-deps.ts` and shared — no behavior change.
- **Driver**: section-less pages drill via a seed-declared `drillProbe`
  (PageType-legal clone source; `roundtrip-drill.mjs`) — page_article
  exercises all six page ops like everyone else.

Gates: **1030/1030 tests** (981 compiled + 49 scripts; ~20 new) · astro check
0 errors · build OK (167 pages) · **build-diff EMPTY (168/168 identical)** —
a pure cutover · local driver run ALL GREEN (create → every permitted op
byte-identical → validate → publish blocked at the expected sandbox boundary →
contract 6/6 → inventory 6/6 → exports materialized).

**Status: the six listing objects are RENDERS + SEEDED, not CONVERTED** —
criteria 2/3 need the credentialed run after merge + deploy:
`node scripts/home-conversion-roundtrip.mjs --production --release --seeds scripts/lib/pages-listing-seed-data.mjs`
(schema-vintage gate applies: the deployed endpoint must carry the new
PageType definitions before the run). After it, 37 objects are converted and
the P6 exit criterion "every object type in the C§2.2 matrix exists in
production" is met for pages. Remaining waves: W5 hand-coded pages (Wolf:
separate session), W7 rich text (OQ-8).

**Follow-up in the same PR (Wolf: "address visibility: 'hidden' in the earlier
converted scope"): the never-render-private gap is CLOSED at the resolver.**
`resolveSections` (the pure layer BOTH render paths share — PageObjectRenderer
for the 12 converted pages + the object-page catch-all, and ObjectSections for
the listing surfaces) now skips a section when its page instance is hidden
(including a hidden `shared_ref`, which is not even dereferenced) OR when a
`shared_ref` target's own section object is hidden
(`parseSharedSectionExport` surfaces the inner `visibility`) — so
`set_section_visibility` on a shared section hides it on every page that
references it, matching the validator's `structure_visible` semantics. No
committed export carries `visibility` today, so the change is render-neutral:
build-diff EMPTY again. 4 new resolver tests pin all four cases.

## Session 2026-07-11 M (content_item resolver: manual article curation is agent-usable — trap 4 closed)

The first real step toward the article object model, per the post-W4 path
Wolf approved (resolver → W6 listings → OQ-8/W7):

- **`netlify/lib/content-item-index.ts`** — the committed article ids
  (filenames under src/data/post minus extension — exactly the renderer's
  `post.id`), fetched via the GitHub contents API with the same env contract
  as the object committer (the W3 ruling: committed frontmatter is the source
  of truth, never the blob drafts). 60s cache + in-flight dedupe;
  unconfigured/erroring → `undefined` = "cannot answer", stale-if-error after
  a first success.
- **Validation context** resolves `content_item` refs against that index:
  real ids pass, ghosts are blockers — `content_grid` manual picks and
  `content_embed.contentItem` validate against real articles at
  patch/create/publish.
- **Contract-conformance fix in `requireObject`**: the documented "resolver
  returns undefined = cannot answer" contract was never implemented — every
  undefined fell through to a hard failure, which is WHY trap 4 blocked
  manual curation for everyone. Now undefined degrades to "not verified"
  (local mode keeps working with no GitHub env); `{exists:false}` still
  blocks.
- **Render-side dead-end removed (no-pipeline-dead-ends rule)**: an
  unresolvable manual pick at BUILD time (a post deleted after the grid
  published — temporal drift validation can't prevent) is now SKIPPED with a
  loud build-log warning naming the id, and the declared fallback backfills
  the freed room. Previously it THREW (`ContentGridResolutionError`,
  removed): one content deletion could kill every future build.

Gates: 1012/1012 tests (7 new/updated) · astro 0 errors · build-diff EMPTY
(no manual grids exist yet; behavior changes are server-side + drift-only).
Agents can now curate: `update_section_data` switching a grid's source to
`{kind:'manual', items:[<post ids>], fallback:{…}}` validates, publishes,
renders. NEXT on the path: W6 listing surfaces.

## Session 2026-07-11 L (INCIDENT: agent content tripped the deploy secrets scanner — trap 14)

Wolf's agent, working the /about intro through the MCP (record_version 25 —
real autonomous editing), set `portrait.src` to an images.weserv.nl proxy of
`raw.githubusercontent.com/<repo>/…/dr-lurie-portrait4.jpeg`. That URL contains
the repo slug — the VALUE of the secret-marked `GITHUB_REPOSITORY` env var —
and Netlify's post-build secrets scan matches marked values (even URL-encoded)
in repo files and build output, so **every production deploy failed** from that
publish onward (the build itself compiled clean; the block is the scan).
Everything published since the last good deploy (the agent's nav/home/site
edits, the W4 record, the object-page catch-all) sat dark until healed.

Resolution (final — zero operator actions; Wolf ruled against spending effort
on a credentialed heal for one image):

- **ENFORCEMENT, not advice — two new validation groups in `validateObject`**,
  run on patch AND create AND publish, so agents get the named blocker at
  write time: `deploy_safety` (no renderable string may contain a protected
  env value — raw, URL-encoded, or double-encoded, matched case-insensitively;
  the error names the KEY, never the value; the repo-file hotlink URL families
  raw.githubusercontent/weserv are blocked outright) and `renderability`
  (trap 5 closed: every field a component splits is checked with the REAL
  splitters, so paragraph-only bodies carrying headings/lists — which pass the
  global allowlist but throw at build — are blockers; FAQ answers per item).
- **The committed export corrected in-repo** (one field: `portrait.src` →
  `/images/dr-lurie-portrait4.jpeg`, the photo the agent wanted, shipped in
  `public/images/` in the same change). Hand-editing an export is normally
  the anti-pattern (the next publish clobbers it) — here it is safe BECAUSE of
  the new guardrail: the store record still carries the bad URL and now CANNOT
  republish until an agent fixes that field (the validation error tells it
  exactly what and why). Quarantine + fix-forward; no credentialed run needed.
- **Merging this change alone unblocks all deploys**: the slug no longer
  appears anywhere in repo files or build output (repo-wide sweep clean), so
  the scanner passes with the env config untouched. Unmarking
  `GITHUB_REPOSITORY` as a secret remains OPTIONAL hardening.
- Also shipped: the bio `portrait` editor hint names sanctioned image sources;
  `scripts/fix-about-portrait.mjs` kept as the store-heal template (trap 14);
  playbook trap 14 + refreshed reality-check; two lifecycle-test fixtures that
  carried never-buildable bare-text prose bodies were themselves caught by the
  new renderability check and fixed.

## Session 2026-07-11 K (object-page catch-all: agent-CREATED pages are now live end-to-end — B1 closed)

The last plumbing between "agent creates a page" and "that page is on the
site": every converted page had a hand-written one-line loader file, so a NEW
page object published + released was store-backed but unreachable. Now
`src/pages/[...objectPage].astro` serves any published Page object whose route
no file owns, via the standard PageObjectRenderer. Ownership rules are pure +
unit-tested (`src/utils/object-page-routes.ts`): file routes always win (the
12 converted pages emit nothing here), article permalinks and the reserved
path families (blog list/category/tag bases from config.yaml per B2,
learn/topics, admin) are refused — and every refusal is a loud build-log
warning naming the object, never a silent drop. Route collisions between page
objects are already blocked live at validation (`isRouteTaken`).

Proof: a temp probe export at `/rt-probe-page` built and served (168th page,
site-object titleTemplate applied) then removed. Gates: astro 0 errors ·
999/999 tests (5 new, incl. "the real committed exports emit ZERO paths
today") · build OK · **build-diff EMPTY**. The full agentic loop is now:
instantiate/create → patch → validate → publish → release → **live at its
route** — no code change per page.

## Session 2026-07-11 J (W4 CONVERTED: site_drlurie is object #31 — after a production credentials outage)

Wolf's credentialed run went green after three failed attempts whose root cause
was **environment, not code**: every object verb 500'd because Netlify Blobs
rejected the store credentials. The diagnosis chain, recorded because it will
recur: (1) the generic 500 hides the real error — it lives in the Netlify
function log after `Object_Store request failed.`; (2) first failure was
`BlobsInternalError (401)` — the token env var held a non-token value (an
all-a–p string, i.e. a clipboard/extension-ID mishap or an expired credential);
(3) mid-repair, `MissingBlobsEnvironmentError` = siteID/token env vars absent
entirely (the MCP function proxies object verbs in-process, so the
platform-injected Lambda blob context never reaches the store — the explicit
env vars do ALL the work); (4) the release path can still report green while
blobs are down (deploys API tolerates things blobs does not — including the
site NAME where blobs requires the UUID), so a green release proves nothing
about store health. **The 5-second local probe that isolates it** (run from the
repo, no redeploys): `getStore({name:'site-objects', siteID:<UUID>,
token:<PAT>}).list(...)` via `node --input-type=module`. Fix: fresh `nfp_` PAT
in `NETLIFY_AUTH_TOKEN` (no separate `NETLIFY_BLOBS_TOKEN` — one live token,
both paths fall back to it), `NETLIFY_SITE_ID` = the site UUID, redeploy.
TODO(nice-to-have): expose `getCoreBlobStoreSourceDiagnostics` as a read-only
`blob_store_diagnostics` MCP tool.

The run itself: create → `set_site_fields` drill byte-identical → validate →
publish → contract (1 op ≡ exercised) → inventory → release `released:true`.
Export commit `a20f107` (`Publish site: site_drlurie [skip netlify]`);
**store === seed === export byte-verified** post-release. `site_drlurie` is
🟢 CONVERTED — **31 objects converted**; the layout renders chrome/brand/
metadata/default-nav from the store-backed object with `set_site_fields` as
the agent's lever.

## Session 2026-07-11 I (W4 BUILT + WIRED: the site singleton renders the chrome — pending credentialed run)

Wolf's W4 answers locked the scope (B1 autonomous publish; B2 urls/blog carried
but config.yaml stays authoritative for routing; B3 announcement deferred). The
singleton is built end-to-end and the layout renders from it:

- **Seed** (`scripts/lib/site-seed-data.mjs`): `site_drlurie`, a byte-identical
  transcription of the previously hardcoded values — name/urls/metadataDefaults/
  blog from config.yaml, logo.text from Logo.astro, brandTokens from the
  CustomStyles literals (colors keyed by var name minus `--aw-color-`, dark
  overrides under `dark:` keys), chrome flags + defaultNavigation from
  PageLayout. 5-test seed suite (schema/id/validation clean; dangling
  defaultNavigation ref proven a real blocker; token set covers every custom
  property).
- **Wiring** (`src/utils/site-object.ts` + 5 consumers): CustomStyles renders
  every custom property from brandTokens; Logo text; PageLayout header/footer
  nav ids + Header chrome flags; PageObjectRenderer footer default; Metadata
  gains a metadataDefaults layer (titleTemplate/description/ogImage/twitter
  handle/og site_name) between config.yaml and per-page props. All with the
  pre-conversion literals as fallback when the export is absent.
- **The trap this session found (recorded for every future wiring): an `await`
  in previously-sync component frontmatter flips astro-icon's `<symbol>`/`<use>`
  placement.** First wiring used a memoized async `getEntry` loader — build-diff
  lit up 153/168 pages, ALL of it icon-sprite placement shifts (Astro evaluates
  sibling components concurrently; any new microtask changes which instance
  renders first and wins the symbol). Fix: the loader is a deliberately
  SYNCHRONOUS eager `import.meta.glob` (zero-or-one match, absent → undefined),
  so frontmatter that was sync stays sync. Re-run: **build-diff EMPTY**.
- **Driver**: `site` support — `siteDrillOps` (`set_site_fields` is the type's
  only op: poke name + restore), reconcile = one `diffFieldsForMerge` fields op
  (trap-2 stray-nulling), materializeSite dispatch. Local rehearsal green: full
  lifecycle create → drill → validate → publish (sandbox boundary) → contract
  (1 op advertised ≡ exercised) → inventory → site.json materialized.

Gates: astro 0 errors · 994/994 tests (8 new) · build OK · **build-diff EMPTY**
(the byte-identical cutover held). Still config-owned deliberately: i18n,
ui.theme, analytics, googleSiteVerificationId, trailingSlash, and routing
(urls/blog are carried, not wired — B2). NEXT: Wolf's credentialed run
(`node scripts/home-conversion-roundtrip.mjs --production --release --seeds
scripts/lib/site-seed-data.mjs`) flips site_drlurie to CONVERTED (#31).

## Session 2026-07-11 H (content cleanup: 10 junk posts dumped, 18 surfaced — PR #402 merged)

Wolf ruled on the 28 invisible posts ("you be the judge"): judged by content —
deleted 10 (5 twenty-three-word "After N" stubs, 4 pipeline-test artifacts,
1 malformed notes file), stamped `published_time` (from each `publishDate`) on
the 18 real ones. Site 123 → 167 pages; topics hub renders all 5 registry
categories; tag pages 18 → 26. The standing "28 posts invisible" caveat is
CLOSED.

## Session 2026-07-11 G (W3 STEP 2 SHIPPED: publish-article taxonomy enforcement + frontmatter normalization + registry labels)

Wolf picked "slugs + label lookup". The bounded exception is built — full §5.5
for articles, in three pieces:

- **Enforcement hook** (`netlify/lib/taxonomy-enforcement.ts` + a minimal
  insertion in `publish-article.ts` before `buildFrontmatter`): when the
  tax_drlurie registry exists in site-objects, every category/tag on a publish
  resolves BY SLUG (labels and slugs both work), following `merged_into`
  aliases (cycle-guarded); unresolvable terms → 422 `TAXONOMY_TERMS_UNRESOLVED`
  with the offender list; resolved terms are materialized into frontmatter as
  their CANONICAL SLUGS (deduped). **No registry → skipped, byte-identical old
  behavior** — the bounded-exception guarantee is structural: all 56
  pre-existing publish-article tests run storeless of taxonomy and pass
  unchanged. Record free-strings stay lossy input (§3.10 untouched).
- **One-time normalization** (`scripts/normalize-taxonomy-frontmatter.mjs`,
  standing tool + audit trail): all 93 posts rewritten via RAW_TO_CANONICAL —
  category kept 11 / dropped 3 (test posts); tag usages kept 122 / dropped 235
  (the junk). Line surgery only; tag-list style preserved per file. One mapping
  added beyond the approved table: tag `Health` → `skin-health` (the category
  map already absorbed it; obvious cluster variant).
- **Registry display labels** (`src/utils/blog.ts`): getNormalizedPost now
  resolves category/tag titles from the taxonomy export by slug (memoized
  `getEntry('taxonomyObject', …)`; raw-string fallback when absent). Labels
  are registry-governed — rename a label in tax_drlurie and every card, chip,
  tag page, and topics entry updates on the next build.

Gates: **986/986 tests** (8 unit + 2 integration new — the integration pair
drives the REAL handler against the REAL seed registry in an isolated local
store: canonical-slug frontmatter committed on success; 422 + nothing committed
on junk). astro 0 errors; build OK. **build-diff reviewed and intended**: 90
only-in-base pages = junk-tag listing pages gone; 11 only-in-head = canonical
merged-term tag pages (+ pagination); 75 changed = article pages' tag chips +
kept tag pages now registry-labeled. Site: 202 → 123 pages.

**Discovered, pre-existing, out of scope (flagged to Wolf):** `fetchPosts()`
filters to posts with a finite `published_time`; 28 of 93 posts (including ALL
11 categorized ones) lack it, so they are invisible in every listing/tag/topics
surface TODAY — the /learn/topics hub renders zero topics at HEAD and after
this change alike (build-diff: byte-identical). Fixing means stamping
`published_time` on those 28 posts (an article-pipeline pass, Wolf's call).

## Session 2026-07-11 F (tax_drlurie CONVERTED — object #30; taxonomy registry live in production)

Wolf ran the credentialed taxonomy command; single all-green run: ensure
(created) → drill (all 5 term ops: add/update/deprecate/reactivate/remove,
byte-identical) → validate → published → contract 5/5 → inventory →
`released:true` (one transient `build_not_confirmed_live` poll, then confirmed).
Export commit `627fa8d` on main; byte-verified store === seed === export
(5 categories + 26 tags, mint-convention ids). All five criteria met → flipped
🟢 CONVERTED across inventory / conversion-map / reality lines.

**Converted count: 29 → 30.** The taxonomy registry is now live: the store
validation context wires `resolveTaxonomyTerm` automatically, so `content_grid`
query terms validate against the real curated vocabulary in production from
this moment.

**Open next (Wolf's call pending on the design fork):** step 2 — the bounded
publish-article enforcement hook + one-time frontmatter normalization of the
93 posts via the committed `RAW_TO_CANONICAL` map. Fork presented to Wolf:
normalize frontmatter to canonical SLUGS per §5.5 + teach the blog renderer to
look up display labels from the registry (recommended — labels become
registry-governed), or normalize to canonical LABELS (zero renderer change,
display strings stay in frontmatter). Awaiting his pick before writing the
sanctioned publish-article exception.

## Session 2026-07-11 E (W3 DECIDED + SEEDED: tax_drlurie — curated agent-editable vocabulary)

**The taxonomy checkpoint is answered.** Wolf first proposed converting the whole
article pipeline (publish-article + workflow) to the new schema so taxonomy
would be unblocked; assessment: right destination, wrong prerequisite — the
pipeline is ~4,700 lines / 31 tool surfaces / 27 test files of load-bearing,
deliberately-frozen contract (§3.10 protects ContentSourceV1; OQ-8 unresolved),
and taxonomy enforcement needs only a HOOK in the publish step, not a new
envelope. **Wolf approved the recommended path:**

1. **Curated registry now (this session):** `tax_drlurie` = agent-editable
   vocabulary, seeded from a CLEANED canonical set Wolf approved term-by-term —
   5 categories + 26 tags distilled from the raw frontmatter of 93 posts
   (158 distinct tag strings; ~2/3 of usage pipeline-test junk; real terms split
   across casing variants — e.g. skin-barrier ×3 spellings = 18 uses). The
   approved raw→canonical mapping is committed as `RAW_TO_CANONICAL` in the
   seed module (step 2's normalization input). Judgment calls recorded:
   Market→skincare, retinol+retinoids→retinoids, photoaging/sun damage→
   sun-protection, essays kept under `reflections`, melanin-rich-skin dropped
   (promotable later — the registry is editable data; nothing is locked in).
2. **Step 2 (next): bounded publish-article enforcement hook** — a third
   sanctioned additive exception to the off-limits rule (resolve article terms
   against the registry at publish time per §5.5/§5.6-step-2, following
   `merged_into` aliases) + one-time frontmatter normalization via the map.
3. **Full content_item→ObjectRecord conversion**: deferred as its own wave
   (OQ-8 adapter-vs-migration decided then) — explicitly NOT a prerequisite.

Built: `scripts/lib/taxonomy-seed-data.mjs` (registry body + mapping); driver
extended to taxonomy (drill = all 5 term ops via a probe tag — add → relabel →
deprecate → reactivate → remove, byte-identical; reactivate_term is
inverse-machinery but advertised, so the drill exercises it; reconcile =
wholesale per-kind rebuild, since there is no reorder op and slug renames mint
aliases; materialize → src/data/site/taxonomy.json). Local rehearsal all-green
(create → 5 ops → validate → publish at sandbox boundary → contract 5/5 →
inventory → export). Gates: **976/976 tests**, astro 0 errors, build OK,
build-diff EMPTY (the registry renders nothing itself; its first live consumer
is store-side validation — resolveTaxonomyTerm wires automatically in
production the moment the record exists, so content_grid query terms start
validating for real).

**Status: tax_drlurie is SEEDED, not CONVERTED** — one-command credentialed run:
`node scripts/home-conversion-roundtrip.mjs --production --release --seeds scripts/lib/taxonomy-seed-data.mjs`
(after merge + deploy — schema-vintage gate: the taxonomy drill needs nothing
new server-side, but run on latest main anyway).

## Session 2026-07-11 D (BATCHED CREDENTIALED RUN: 13 objects CONVERTED — the page + template backlog is cleared)

Wolf ran `./scripts/convert-pending-production.sh --verify-only` (all green) then
the real `./scripts/convert-pending-production.sh` from his credentialed laptop.
The single run created/reconciled, drilled every permitted op, published, and
released all 13 SEEDED objects in one deploy (`release poll: released` →
`SUCCESS — store-backed, round-trips every permitted op, and published`):

- **8 W1 pages** — page_start_here, page_member_updates, page_newsletter,
  page_free_guide, page_early_access (lede); page_privacy, page_terms (prose),
  page_404 (cta_banner).
- **3 W2.5 templates** — tpl_interior, tpl_landing, tpl_legal (all 4 template
  ops round-tripped + instantiate `dry_run` proven).
- **2 W2 form pages** — page_contact, page_thank_you.

Every `ensure` reported "already matches the seed" (store === seed); the 13
`Publish …` commits are on main and carry the decomposed exports (store ===
export); inventory returned all 13. All five criteria met → flipped to
🟢 **CONVERTED** across object-inventory / conversion-map / this log /
CLAUDE.md / AGENTS.md.

**Converted count: 16 → 29.** All 12 page objects + all 3 templates + the 3 nav
objects are now store-backed and agent-editable. **The rendered-stub backlog is
empty** — no page renders from an unbacked export anymore. The now-cleared batch
harness (pending-conversion-seeds.mjs + convert-pending-production.sh + its test)
is retired; the batching PATTERN stays documented in the playbook for the next
wave. `PUBLISH_SECRET` was pasted in chat and the run went live — **rotate it
before any real go-live** (standing caveat, still open).

Next: W3 taxonomy (Wolf's source-of-truth decision — the open checkpoint) and
W4 site singleton.

## Session 2026-07-11 C (W2 SHIPPED: /contact + /thank-you decomposed — the palette is now FULLY GENERIC)

Wolf: "Continue with W2." Answered the three framing questions (generic
decomposition + accept a scoped diff; reuse content_grid cards with an added
optional icon rather than a new feature_grid type; rename thank_you). The last
two bespoke per-page section types are retired — **no single-use page type
remains** (design-principles rule 1 fully satisfied):

- **/contact** decomposed off the bespoke `contact` type into 3 inline GENERIC
  sections: `lede` (kicker + heading) + `contact_form` + `content_grid` (`cards`
  source). To carry the current copy without a new type:
  - `gridCardCellSchema` gained an optional `icon` (Tabler name); ContentGrid
    renders it above the cell — the "how we can help" feature-grid shape as
    curated cards.
  - `contact_form` gained optional `subtitle`/`description`; ContactForm renders
    them (the name/email/message field set stays fixed furniture).
    The bespoke `contact` type + `ContactPage.astro` + `contact.ts` are REMOVED
    (compile-lockstep gate). Intentional **scoped rule-4 visual diff on /contact**
    (build-diff: 1 changed page; all copy + 6 icons + the Netlify form preserved,
    only the widget→generic-component markup changed).
- **/thank-you**: the `thank_you` type was RENAMED to the reusable
  `form_confirmation` (ThankYou.astro → FormConfirmation.astro, thank-you.ts →
  form-confirmation.ts; the `?form=` swap script is unchanged). It was already
  fully data-driven — this makes the palette name honest. **Renders
  byte-identically** (build-diff: /thank-you unchanged). The route `/thank-you`
  and the `?form=` post targets are untouched.
- Seeds: `scripts/lib/pages-forms-seed-data.mjs` (page_contact + page_thank_you,
  both `standard`, sections inline). Exports regenerated via the driver.
- Gates: **969/969 tests**, astro check 0 errors, build OK, build-diff = exactly
  1 scoped change (/contact), reviewed. Local round-trip proven for both pages.

**Status: page_contact + page_thank_you are RENDERS (decomposed, local proof),
not CONVERTED** — production store records land with the batched credentialed
run (`--seeds scripts/lib/pages-forms-seed-data.mjs`). Sixteen converted objects
unchanged. Remaining waves: W3 taxonomy (Wolf's decision), W4 site, W5+ pages.

## Session 2026-07-11 B (W2.5 SHIPPED: templates activated — instantiate verb + 3 starter recipes)

Wolf confirmed the two understandings (the MCP edit surface varies per
object/PageType through the always-exact, self-describing contract; the W1
credentialed run is postponed until all page types are ready) and said
"proceed" — so W2.5 was built end-to-end:

- **`src/lib/template-instantiate.ts`** — pure builder: template slots → page
  body. Blueprint → deep-copy with a fresh deterministic `s_` id; required
  slot without blueprint → registry `defaultData` of its first allowed type
  (the exact promise the `template_required` warning makes); optional empty
  slot → skipped; `page.template = {ref, instantiated_at}` provenance stamped;
  pageType defaults to `appliesTo[0]` (explicit `page_type` must be within a
  non-empty `appliesTo`).
- **`instantiate` verb** (object-verbs.ts) — loads the template (must EXIST,
  draft fine), builds the body, then **delegates to the existing `create`
  case**: one write path, so route uniqueness, PageType law, reference
  integrity, and reader safety all gate an instantiated page exactly like a
  hand-authored one ("law beats recipe" is a pinned test). `dry_run: true`
  returns the built body + would-be id + `id_available` + full validation and
  persists NOTHING. Exposed as the **`object_instantiate_template`** MCP tool
  (also available to the admin mirror via the shared verb core); surfaced in
  `object_contract('template')` and `('page')` workflow sequences.
- **Starter recipes** (`scripts/lib/templates-seed-data.mjs`): `tpl_interior`
  (standard: lede + prose + optional cta), `tpl_landing` (standard: hero +
  curated card grid + cta), `tpl_legal` (system: one required blueprint-less
  prose slot — keeps the defaultData fallback exercised). Blueprints are
  self-contained; blueprint ids are `s_<alnum>` (no underscores — the id
  regex bit once).
- **Driver extended**: seeds may be `objectType: 'template'`; drill covers all
  4 template ops via an always-legal probe slot; reconcile heals templates
  (meta diff excludes `slots`; positioned wholesale slot upserts + stray
  removal + explicit ordering); `--write-exports` materializes to
  `src/data/site/templates/`; and a per-template **instantiate dry_run proof**
  runs after the drill (no probe pages left behind, production-safe).
- **Local rehearsal all-green**: ensure(create) → all 4 ops byte-identical →
  validate → publish blocked at the expected sandbox boundary → 3/3
  instantiate dry_runs eligible → contract 4/4 ops → inventory 3/3 →
  exports written. Gates: **963/963 tests**, astro check 0 errors, build OK,
  **build-diff EMPTY** (templates render nothing — expected).
- Docs: playbook "Template families" section + `object_instantiate_template`
  call-table row; conversion-map TEMPLATES node → 🟡 ACTIVATED/SEEDED; W2.5
  row → DONE (code + seeds); inventory "Singletons & templates" table added.

**Status: the three templates are SEEDED (local proof), not CONVERTED** — the
production store records land with the batched credentialed run
(`node scripts/home-conversion-roundtrip.mjs --production --release --seeds
scripts/lib/templates-seed-data.mjs`, after merge+deploy; batch it with the
postponed W1 run). Sixteen converted objects unchanged.

## Session 2026-07-11 A (ARCHITECTURE DECISION: templates are recipes, PageTypes are law)

Wolf posed the standing tension directly — flexibility (generic components,
agent responsibility) vs strict rules (encoded per set page) — and proposed:
generic objects only + a template per specialty page. Repo survey confirmed the
template machinery is BUILT and dormant (template.v1 schema with
slots/allowed/required/repeatable/blueprint, 4 patch ops, validation,
materializer — but zero instances and NO instantiate flow; deferred to P6 by
the original plan). **Decision (Wolf): adopt the sharpened form — recipes + law
split** (now design-principles.md rule 5, GOVERNING):

- Palette stays generic-only and grows ON DEMAND (Wolf's second choice — no
  speculative upfront library).
- Templates = data recipes, agent-editable, creation-time COPY + provenance
  only (D§3.6 stands; live inheritance explicitly rejected — the propagation
  trap).
- PageTypes (code registry + validation criteria) remain the only enforced
  structural law. Behavior stays in generic components, never templates.
- PageType-as-data (OQ-4) considered and deferred: guardrails must not become
  agent-mutable unless agents should invent page _kinds_.

**Implementation queued as W2.5 in the map** (~1–2 sessions, net-new):
`instantiate_template` MCP verb (copy slot blueprints → new page body, stamp
`page.template`), a starter recipe set (tpl_interior / tpl_landing /
tpl_legal), a template drill in the round-trip driver, contract surfacing,
docs. Remaining W2 (contact/thank_you) now explicitly decomposes into generic
types per rule 5 — the last two bespoke types retire with it.

## Session 2026-07-10 G (W1 batch: 5 lede + 3 system pages seeded for conversion)

Wolf: do the next low-question conversions. The cleanest batch is the 8
interior + system pages — all already thin `PageObjectRenderer` loaders with
committed single-section exports (no restructure needed, unlike home/about):

- **One combined seed module** `scripts/lib/pages-interior-seed-data.mjs`
  (`SEED_SITE` + `CONVERSION_SEEDS`, 8 `page` entries): the 5 `lede` bodies
  reused verbatim from `page-lede-family-seed-data.mjs`, the 3 `system` bodies
  (privacy/terms `prose`, 404 `cta_banner`) inlined verbatim from their
  committed exports (the large legal copy taken exactly, not re-transcribed).
  page_newsletter stays a plain `lede` (Wolf's D2 choice; the shared newsletter
  section can be added later).
- **No rendering change**: these pages already render from committed exports, so
  the conversion adds only the store-backed + round-trip half. The PR is just
  the seed module + test; the 8 seed bodies byte-match the committed exports
  (materialized exports reverted as marker-only churn).
- **Gates:** astro check 0 errors; 899 netlify/src + 37 scripts tests green (3
  new); build green (202 pages); dist grep confirms all 8 render; local
  `--seeds pages-interior` round-trip all-green (every page drilled all 6
  permitted ops via the inline-section probe).

**Status: RENDERS, not yet CONVERTED** — the credentialed
`node scripts/home-conversion-roundtrip.mjs --production --release --seeds
scripts/lib/pages-interior-seed-data.mjs` run creates the 8 store records and
proves the production round-trip (criteria 2/3). After it, 10 pages are
converted (home, about, + these 8), leaving only contact + thank_you.

**Also this session (Wolf's D1 = yes, separate PR):** the now-orphaned bespoke
`about` section TYPE was RETIRED — union member, `About.astro`, its registry
module + binding, the registered-types/object-contract/resolve.ts entries, and
two test artifacts all removed (the `componentRegistry` `Record` forces the
union + binding to change in lockstep, so a miss is a compile error). No live
data migration (zero objects were `type: 'about'`); build-diff EMPTY (203/203)
— nothing rendered it. 17 registered section types remain.

## Session 2026-07-10 F (/about DECOMPOSED into 8 generic objects; bio gains a portrait; driver handles all-shared_ref pages)

Wolf: "convert the about page — the objects on it should each be their own
converted object; mostly generic text sections." Done as the first W2
conversion, the design-principles way (retire the bespoke, don't repeat it):

- **/about decomposed** from the single bespoke `about` section into EIGHT
  standalone shared sections of REUSABLE types — `sec_about_intro` (bio),
  `sec_about_{thinking,products,science,research,blog,note}` (prose ×6),
  `sec_about_cta` (cta_banner); `page_about` is now a `standard` page of 8
  `shared_ref`s. Each piece is independently editable/reorderable/reusable.
  Seed: `scripts/lib/page-about-seed-data.mjs`.
- **bio generalized (Wolf's call)** to keep the doctor's portrait: added an
  optional URL `portrait {src,alt}` field + rendering (distinct from the
  artifact-ref `portraitAssetRef`, which fails artifact-trust on a raw URL —
  that's WHY portrait is a separate field; pinned by test). The reusable "person
  intro" now carries a photo; the homepage bio (no portrait) is byte-identical.
- **Driver improvement surfaced by this conversion:** a fully-decomposed page is
  ALL `shared_ref`s — the normal shape once every section is its own object —
  which the page-drill's "refuse to guess" guard (fix 5) correctly stopped on.
  `pageDrillOps` now handles it by cloning ANY of the page's own sections as the
  probe (a shared_ref duplicate resolves + is PageType-legal). Unit-tested.
- **Gates:** astro check 0 errors; 896 netlify/src + 37 scripts tests green (16
  new); build green; dist grep shows all 8 sections + portrait + lists + CTA;
  build-diff scoped to `/about` ONLY (202/203 identical — the home bio is
  unaffected). Local `--seeds page-about` round-trip all-green.

**Status: CONVERTED (all five criteria).** Wolf ran the credentialed
`--production --release --seeds page-about` run: all 9 objects created,
every permitted op drilled, published (9 export commits `e0a36af`…`029142c`
on main), and `release_to_production` confirmed `released:true` (the resilient
poller's first `build_not_confirmed_live` then `released` — the 504 fix
working as designed). Byte-check: all 9 published exports === seed (no drift);
page_about record_version 10; the intro bio kept the portrait. **Sixteen
objects converted total** (3 nav + home family + /about family); the reality
lines were flipped across CLAUDE.md/AGENTS.md/playbook/inventory/map/core-structure.

**Follow-up flagged:** the `about` section TYPE is now orphaned (no object uses
it) — retire it (union member + About.astro + registry + resolve.ts entry +
fixtures) in a separate focused change.

## Session 2026-07-10 E (conversion factory: full object map + generalized driver + tightened recipe)

Wolf's directive after the home-page success: tighten the instructions so any
coding agent can convert the rest, and produce the complete object universe for
him to set boundaries and priority. Landed:

- **`conversion-map.md` (NEW)** — the full tree of every actual and potential
  object in the Astro project: attributes, dependencies, dependents, status
  marks, composable ⚪ potential objects (topics hub from content_grid, landing
  pages, shared CTAs, pricing_table/steps/feature_grid/content_split types for
  W5), and a PROPOSED wave order (W1 lede+system pages → W1-enabler
  content_item resolver → W2 bespoke pages → W3 taxonomy decision → W4 site →
  W5 pricing/services/shop → W6 listings → W7 rich text). **The priority table
  is Wolf's to edit; agents follow it.** Wired into CLAUDE.md/AGENTS.md
  mandatory reading and playbook criterion 5.
- **Driver generalized** — `home-conversion-roundtrip.mjs --seeds
scripts/lib/<family>-seed-data.mjs`; a seed module exports CONVERSION_SEEDS
  (ordered, referenced-before-referrer) + SEED_SITE. v1 drills page/section
  types and refuses others loudly.
- **Playbook recipe rewritten as the factory flow** (seed module → local
  driver run → gates → record-as-RENDERS → merge+deploy → credentialed
  `--production --release` → flip to CONVERTED) + traps 10–12 (deep-merge
  heal strays; release gateway timeout; schema-vintage before --production).

## Session 2026-07-10 D (HOME-PAGE FAMILY CONVERTED — all five criteria)

Wolf's second credentialed run (after PR #386's driver fixes) came back
**all-green**: every `ensure` reported "already matches the seed" (store ===
seed byte-exact; page_home v44), all four objects re-published, contract and
inventory checks passed, and `release_to_production` confirmed
**`released: true`**. That completes criterion 3's release→re-render leg — so
**`page_home`, `sec_home_audience_grid`, `sec_home_start_grid`, and
`sec_newsletter_signup` are CONVERTED, all five criteria, no asterisks.**
Seven objects total now (3 nav + the home family); the reality lines in
CLAUDE.md / AGENTS.md / conversion-playbook.md / object-inventory.md /
core-structure.md were all flipped in this change. The 2026-07-10 goal —
"agents can change everything on the home page through the MCP, up to
publishing live" — is met: hero and bio edit via `page_home`'s section ops,
each grid and the newsletter via their own section objects, chrome via nav.

Still-open, known follow-ups (unchanged): the `content_item` resolver gap
(manual grid curation, playbook trap 4); archive/unpublish verbs; the other
11 rendered-stub pages; `site`/`taxonomy` objects; `checklist` type now unused
on the home page (kept registered — retirement optional). Also noted for
later: rotate `PUBLISH_SECRET` before real go-live (exposed in a chat
transcript during testing; Wolf accepted the risk for now — nothing is live).

## Session 2026-07-10 C (FIRST CREDENTIALED PRODUCTION RUN + driver hardening)

PR #385 merged; **Wolf ran `home-conversion-roundtrip.mjs --production --release`
from his machine — the first credentialed store run since nav.** Results:

- **`sec_newsletter_signup`, `sec_home_audience_grid`, `sec_home_start_grid`:
  created in the production store, EVERY permitted op exercised, validated,
  PUBLISHED** (export commits `a3d6e87`/`4dbbc1f`/`86b9174` on main).
  `object_inventory` returns all of them. Criteria 1–4 all proven in
  production for the section family.
- **`page_home`: healed and PUBLISHED** (`344faab`, record_version 42) — the
  broken record's structure was fully reconciled (hero inline, two grid refs,
  bio, newsletter ref, footer override). The ensure check flagged a residual
  diff: three `seo` subkeys from the old record (`description`/`robots`/`title`)
  survived because the reconciler hit **playbook trap 2 itself** (`set_page_meta`
  deep-merges; strays must be nulled). The values are good editorial content,
  so they were **adopted into the seed** (seed === store now) rather than
  stripped.
- **`release_to_production` died at a gateway "Inactivity Timeout" 504** — the
  server polls deploy receipts longer than intermediary proxies allow. The
  build hook fires before the polling, and the #385 merge itself also triggers
  a production build, so the release almost certainly happened; confirmation
  rerun pending.

**Hardening landed this session:** reconcile logic extracted to
`scripts/lib/roundtrip-reconcile.mjs` with `diffFieldsForMerge` (nulls stray
keys at every depth — unit-tested against the exact production drift); a failed
ensure now SKIPS that object's drill/publish (never publish a wrong body); the
release step fires the hook once (`timeout_seconds: 15`) then confirms via
short read-only polls (`force_build: false`) tolerant of gateway errors.

**Remaining to declare the home family CONVERTED:** one rerun of
`--production --release` (expect: every ensure "already matches the seed";
`released: true`), a look at the live homepage, then flip the four inventory
rows to 🟢. **Security follow-up: rotate `PUBLISH_SECRET`** — it was exposed
in a chat transcript during this run's setup.

## Session 2026-07-10 B (home-page conversion push: restructure + standing round-trip driver)

Wolf's goal: the home page at 100% conversion — hero, the two grids, about/bio,
newsletter — everything agent-editable via MCP through to live publish. His
structural call, implemented: **hero and bio stay inline on `page_home`; the two
grids become standalone objects of the ONE reusable `content_grid` type**
(`sec_home_audience_grid` — new sanctioned `cards` source of curated text cells;
`sec_home_start_grid` — the settled M-8 `query` source), referenced via
`shared_ref` like the newsletter. One grid type, two roles by configuration
alone — the design-principles litmus passes.

**Landed on `claude/home-page-conversion-state-6wsc2r`:**

- **Schema:** `content_grid` gains the `cards` source (cells: optional
  title/description + optional `link` LinkAction, ≥1 of title/description,
  max 8 = the block-tree bound); the transitional `static` variant is **removed**
  (playbook trap 9 closed; seed script now safe to re-run). Renderer resolves
  cell links like hero actions (`ContentGridResolved.cardHrefs`).
- **Restructure:** `page_home` = hero (inline), 2 grid `shared_ref`s, bio
  (inline), newsletter `shared_ref`. `index.astro` collapsed to
  `<PageObjectRenderer objectId="page_home" />` (removes the loader duplication
  AND the 2026-07-10 footer-crash mode — the renderer falls back to `nav_footer`;
  the `structure_home_footer` rule still guards the store record).
- **Standing round-trip driver** (`scripts/home-conversion-roundtrip.mjs`) —
  closes root-cause 4 (throwaway drivers): ensure/heal each record (the broken
  production `page_home` reconciles via real patch ops), drill EVERY permitted
  op per type ending byte-identical, validate (zero blockers), publish, then
  contract-completeness (advertised ops ≡ exercised ops — criterion 4 ✓ for
  page/section) and inventory checks. `--local` rehearsal **PASSED end-to-end**
  (publish blocked exactly at `export_commit_failed` — the expected boundary);
  `--production [--release]` is the credentialed conversion run.
- **Gates:** astro check 0 errors; 882 + 24 tests green; build green; dist grep
  shows all five sections' real copy; render gate 5/5 IDENTICAL (fixture updated
  to the two-grid structure); build-diff reviewed: **scoped to `/` section 2
  only** (audience cards adopt the grid card frame — intentional, per
  design-principles rule 4), 202/203 pages byte-identical.

**Honest status: page_home + the three shared sections are RENDERS + fully
rehearsed, NOT yet converted.** Criteria 2/3 (production store record + proven
production round-trip) still need what no agent session has: `PUBLISH_SECRET`
(+ egress to `drluriescience.netlify.app` — this session verified the network
policy blocks it). **The remaining work is one command from a credentialed
machine:** `node scripts/home-conversion-roundtrip.mjs --production --release`
(then re-check `object_inventory` and the live site; expect the four exports'
`__generated` markers to reconcile). Alternatively: add `PUBLISH_SECRET` (and
the domain) to this Claude environment's config and re-run from a session.

## Session 2026-07-10 (definition-of-done RESET; homepage-footer regression fix)

Two things. **(1) Incident + fix (PR #383, merged):** four real production
`object_publish` calls on 2026-07-10 progressively stripped `page_home`'s store
record down to one section with no `navigationOverrides` — every step passed
validation (the field is schema-optional) and only surfaced as a site-wide Netlify
build crash (`index.astro` throws without `navigationOverrides.footer`; Astro's build
is all-or-nothing). Added the `structure_home_footer` validation rule (rejects any
page_home / pageType-home patch/publish missing the footer override, at validation
time), restored the git export, documented in `object_contract`. The **live store
record for page_home is still broken** — restoring it needs production credentials.

**(2) Governing reset (Wolf):** "converted" was being used to mean "renders," which
let half-done work look finished. New GOVERNING definition, added to CLAUDE.md /
AGENTS.md / conversion-playbook.md: an object is converted ONLY when it renders **and**
is store-backed **and** an agent can round-trip every permitted action via MCP **and**
every permitted action is in the contract + has a server tool **and** it's recorded in
docs. No half measures. **After every session, docs must be updated; no record =
not converted.** Honest status recorded: **only nav_header/nav_footer/nav_footer_home
are actually converted**; the 12 pages are rendered stubs. Root-cause analysis of why
(no production credentials in any session; missing archive/unpublish + nested-block
MCP verbs; content_item resolver gap; no standing round-trip test) is in
`object-inventory.md` "Why only nav is converted."

## Session 2026-07-09 (system pages + grid via the real MCP lifecycle; playbook)

PR #380 (`claude/system-pages-and-grid`): `page_privacy`/`page_terms`/`page_404`
cut over as `system` pages using **reusable** section types (`prose`, `cta_banner`
— no bespoke per-page types, per design-principles), and the homepage grid's
invalid `static` placeholder retired for a live `query` source. Every object was
driven through the REAL compiled MCP handler (create→checkout→validate→patch→
publish→checkin, local file-backed store; publish correctly blocked at the
`not_configured` git-commit gate — the expected sandbox boundary). Also: site-wide
noindex/nofollow guard (`SITE_NOT_YET_LIVE`, Metadata.astro) + README notice — the
site is not live; QA posts surfacing in the grid is accepted per Wolf.

**Review pass (Fable) findings, fixed in the same PR:** literal markdown backticks
shipped into page_privacy's rendered copy (no `code` tag in the allowlist);
materializer meta silently dropped `record_version` when passed camelCase (now a
loud runtime guard + test); the object-inventory same-change rule was missed.
Every trap from this batch is codified in **`docs/cms-architecture/conversion-playbook.md`**
(new; mandatory pre-conversion reading, wired into CLAUDE.md/AGENTS.md/core-structure)
so Sonnet-class conversions don't need a fix-up pass. Open follow-ups: `content_item`
resolver (manual grid curation), retiring the `static` grid variant + seed script.

## Standing state (after session 2026-07-08 D — bespoke-page cutovers)

Continues the bespoke-page cutover track opened by the `/thank-you` cutover
(`7c14eb4`, **merged to main** in `fdc55eb`), which established the
functional-equivalence gate for pages carrying a page-level inline script/scoped
style (`known-inert-diffs.md`). This session cut over the next two, each on its
**own branch off `main`** (not stacked — applying the #368–#371 scoping lesson):

| Page cutover                  | Branch / commit                      | State                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`/about` → page_about**     | `claude/cutover-about` (`6180f3a`)   | **Cut over in CODE + verified.** Bespoke-markup page: prose blocks stay fixed component furniture, only the **clean fields** are object data — page + 6 section headings, portrait src/alt, closing CTA (Wolf's "clean fields only" call; no rich-text/injection surface). `build-diff` EMPTY (203/203). No page-level script/style → strict byte-identity, no ledger entry. **Not merged.**                                                      |
| **`/contact` → page_contact** | `claude/cutover-contact` (`e7e734c`) | **Cut over in CODE + verified.** First **widget-composition** page: `ContactPage.astro` re-invokes the same HeroText/Contact/Features2 widgets, every prop now object data (promotes cleanly — no prose-emphasis problem, so no clean-fields compromise). Two editorial HTML comments kept verbatim (html-minifier `removeComments` off). `build-diff` EMPTY (203/203). No link actions → empty resolved, no `resolve.ts` change. **Not merged.** |

**Two page-shape families identified for the remaining cutovers:**

- **Bespoke raw markup** (`about` done; `shop-preview` remaining). Faithful repro = one bespoke section reproducing the exact markup. `shop-preview` also carries a scoped `<style>`, so it takes the **functional-equivalence** gate + a `known-inert-diffs.md` entry (like thank-you).
- **Widget-composition** (`contact` done; `pricing`, `services` remaining). Faithful repro = a bespoke section re-invoking the page's existing widgets with props promoted to object data. `pricing`/`services` both use `CallToAction` (link actions), so each will need the action-hrefs resolved shape + a `resolve.ts` entry (like `about`) and richer data modeling (pricing tiers/steps/FAQ; content/testimonials).

**Every cutover this session:** `astro check` 0 errors, eslint/prettier clean,
full suite green (870 netlify+src, 24 script), `build-diff` EMPTY. **Object-store
seed+publish still deferred to the handoff** (no production store in this sandbox)
— same posture as thank*you and the lede family; the committed `page*\*.json`exports are the derived-export half, publish reconciles the`\_\_generated` marker.

A separate `claude/state-of-play-cutovers` branch carries only this log entry, to
keep each cutover branch a clean single-purpose diff for review.

## Standing state (after session 2026-07-08)

| Area                                  | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Homepage cutover (T3.6/T3.7/T3.8)** | **DONE + verified.** `index.astro` is a thin loader over the published `page_home` object (`src/lib/renderer/resolve.ts`). `build-diff` EMPTY (203/203 identical); verify-section-components 5/5; astro check 0 errors. On branch `claude/phase-3-cutover`, not merged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **T3.4/T3.5 exports**                 | Materialized locally (`page_home.json`, `sec_newsletter_signup.json`) via the real materializers. Blob records still unpublished — a real `object_publish` reconciles the `__generated` marker only (handoff Step 2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Structural-capacity guardrail**     | **NEW.** `src/lib/registry/structural-capacity.ts` + `nav_actions_capacity` criterion (warn-only; content stays editable). The first "JSON-based hard rules" layer — fixed structure, agents decide content.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **T2.6**                              | **DONE** (was "parked"). `navigation.ts` + demo chain deleted; import chain verified self-contained.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **T3.13 extensibility drill**         | **DONE.** `testimonial` type added end-to-end; proves one-module-one-binding cost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **nav_header incident**               | `nav_header.actions` is `[]` on `main` (test-probe fallout, not live). Fix is object-layer (handoff Step 1) — the guardrail, not a human gate, is the durable answer per Wolf's framing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Remaining to close Phase 3**        | All object-store operations: publish page/section (reconcile), T3.9 grid content (needs renderer wiring + curation), T3.11 route→page upgrade, release. **See `phase-3-handoff.md` for exact steps + payloads.** T3.10/T3.12 admin-UI deferred (block nothing).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **T3.9 content_grid code**            | **DONE.** `manual`/`query` rendering wired (`resolve-content-grid.ts` → `resolve.ts` + `ContentGrid.astro`, resolvers from `fetchPosts()`). Only the object-layer source-kind switch + curation remain (handoff Step 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Phase 4 — lede family (T4.2/T4.3)** | **Cut over in CODE + verified.** New `lede` section type + component + shared `PageObjectRenderer`; 5 interior pages (start-here, member-updates, newsletter, free-guide, early-access) are thin loaders, `build-diff` EMPTY (203/203). Object-layer seed+publish is NEW records — handoff Step 4b.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **build-diff normalizer**             | **Extended** (`0e34ea4`) to drop class-attribute-value ORDER + CSS chunk-STEM (both content-neutral; astro-compress frequency-sort + Astro chunk renaming churn every page when a component is added). Required to verify any Phase 4 page cutover.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Self-describing object contract**   | **NEW** (`0212f55`). `object_contract(object_type)` MCP tool + `src/lib/registry/object-contract.ts`: one read-only call returns the full editing contract (body JSON-schema, all 16 section variants + fields, per-type patch ops with arg schemas + minted-id fields, constraints, publish policy, workflow, aux inputs) — all DERIVED from the enforcing code (`z.toJSONSchema`, `patchOpNamesByObjectType`, the registries, `activeApprovalPolicy`), so it cannot drift. `registry_get('component')` un-stubbed from the same source. Agents no longer guess what a valid body/op looks like.                                                                                                                                                                                       |
| **Live validation enforcement**       | **NEW** (`b48413c`). `netlify/lib/object-validation-context.ts` + injection at object-store.ts/admin-object.ts: the write path now runs the resolver-dependent criteria (reference integrity, PageType allowed/required sections, route uniqueness, template registry, taxonomy) that previously degraded to `optional`. So the boundaries the contract advertises actually bite. Regression-guarded: every committed export validates zero-blockers under the live resolvers.                                                                                                                                                                                                                                                                                                          |
| **Section-type catalog COMPLETE**     | **NEW** (`05de63e`, `4f9e9a1`, `f4d532b`). Bound the 8 schema-legal-but-unbound section types — `prose`, `cta_banner`, `faq`, `link_list`, `product_preview`, `contact_form`, `search`, `content_embed`. Every variant except `shared_ref` (dereferenced by the renderer, never a component) now has a component + editor hints and surfaces as `component_bound` in `object_contract` / `registry_get`. Reusable guardrailed primitives an agent can compose onto any page; `build-diff` EMPTY (additive registry entries — no page renders them yet). **Bespoke-page cutovers (about/contact/pricing/services/shop-preview) deliberately deferred:** their hand-tuned per-block markup can't be both byte-identical AND reusable-guardrailed (Wolf chose "finish the catalog first"). |

### Session 2026-07-08 (Phase 3 cutover, one long autonomous session)

Ran from a sandbox with **no route to the production object store** (no MCP
tools, no `PUBLISH_SECRET`, no egress — verified at start). So this session did
every **code + cutover** task and left every **object-store** task as a
documented handoff (`phase-3-handoff.md`). Five commits on
`claude/phase-3-cutover`, full suite green (848 netlify/src + 20 script), build
green, `build-diff` empty for the cutover.

**Landed:** the structural-capacity guardrail (the deconfliction framework Wolf
asked for — warns on over-budget header CTAs, never blocks content, deliberately
does NOT re-add the action↔menu duplication flag the seed's "exactly one warning
class" invariant forbids); T2.6 dead-code deletion; the two derived exports; the
homepage cutover (T3.6/T3.7/T3.8) verified byte-identical; the T3.13 testimonial
drill.

**Deliberately deferred (object-store / editorial / large admin-UI):** the real
publishes, the nav_header incident fix, T3.9 grid content (renderer wiring +
curation), T3.11 target upgrades, release, T3.10/T3.12. Phase 4 does not start
until the cutover pattern is exercised against production (handoff Steps 1–5).

**Judgment calls (per Wolf's "make reasonable decisions" directive):** treated
T2.7's old blocking rationale as superseded (approval policy is `all-autonomous`,
publish is agentic); kept the policy autonomous rather than re-gating (the fix
for the incident is the structural guardrail); materialized exports locally from
the canonical seed so the cutover could be verified, with the marker-reconcile
documented.

## Standing state (after session 2026-07-07)

| Area                              | State                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Configurable approval policy      | **Landed** (`b50c5e4` + follow-ups on PR #364) — replaces T1.4's hardcoded tier gate entirely. See "New model" below.                            |
| `netlify/lib/tier-gate.ts`        | **Deleted.** Replaced by `netlify/lib/publish-gate.ts`; `Tier` type and `tierForObjectType` are gone from the codebase.                          |
| Everything else from 2026-07-06 C | Unchanged — still standing as recorded below (T2.7/T2.6 waiting on Wolf, T3.2–T3.10 landed, homepage cutover still forbidden until T2.7 closes). |

### New model: configurable approval policy (replaces T1.4's hardcoded tiers)

The old scheme hardcoded publish permission by tier: Tier 1 (`content_item`)
untouched, Tier 2 (`page`/`section`/`template`) agent-publishes-after-approval,
Tier 3 (`navigation`/`taxonomy`/`site`) approval-plus-**human-executed**. That
fixed scheme is gone. There is now **one gate, one question, per object type**:
_does a change to this type require human approval before it can be published?_

- **Not gated (the default):** an agent proposes and publishes directly. Fully
  autonomous, no human in the loop.
- **Gated (opt-in):** an agent proposes → the change waits → a human approves
  → **the agent publishes it**. There is no separate "human executes the
  publish" step anymore — approval is the only human touch, on every governed
  type, not just former-Tier-2. If a further edit invalidates the approval
  (`content_revision` moves), it waits again.

**How Wolf flips posture — one file, no code changes:**
`src/config/approval-policy.ts`. Two levers:

```ts
export const approvalPolicyConfig = {
  master: 'all-autonomous', // or 'all-require-approval'
  overrides: {}, // e.g. { navigation: 'require-approval' }
} satisfies ApprovalPolicyConfig;
```

- `master` is the fast lever for the whole system's posture.
- `overrides` pins individual types (`page`, `section`, `navigation`,
  `taxonomy`, `site`, `template`) against the master, either direction.
- Resolution order: per-type override → master switch → hardcoded default
  `autonomous`. An unconfigured type in an unconfigured system is fully
  autonomous — this is the checked-in **dev-stage default** (`all-autonomous`,
  no overrides).
- `content_item` (articles) is structurally outside this config — the schema
  rejects it as an override key — and keeps its own pipeline (OQ-8), untouched.

**What's preserved verbatim from T1.4:** the `content_revision`-based approval
invalidation (an approval is invalidated by a body write, not by lock
checkout/checkin or the publish stamp — both still bump only `version`); the
M-6 publish-action pin exactness for agent execution on gated types; the
patch/inverse Discard mechanism. **What's decoupled:** audit-trail writing
(history attribution, patch+inverse capture, the publish receipt) never lived
in the gate to begin with — it's unconditional in `object-patch-apply.ts` and
`object-publish.ts` regardless of gate outcome, so an autonomous publish is as
attributed and revertible as an approved one. Nothing needed to change there;
this was verified, not assumed (see `publish-gate.test.ts`'s explicit
autonomous-publish-audit-trail assertions and the wiring tests in
`object-verbs-review.test.ts` / `publish-review-lifecycle.e2e.test.ts`).

**Module map:** `src/lib/approval-policy.ts` (pure resolution: `governedObjectTypes`,
`publishRequiresApproval`, zod-validated `resolveApprovalPolicy` that THROWS on
a malformed config rather than silently defaulting permissive) + `src/config/approval-policy.ts`
(the one editable file) + `netlify/lib/publish-gate.ts` (the server gate,
replacing `tier-gate.ts`) + `src/lib/admin/object-review-ui.ts` (client-safe
display-only mirror for the admin UI's button visibility — same policy, same
resolution, never the enforcement point).

**Consumers updated:** `object-verbs.ts` (gate + inventory both take an
injectable `approvalPolicy`, defaulting to the committed config),
`object-inventory.ts` (`tier` field replaced by `requires_approval`),
`mcp.ts`'s `object_inventory` tool (same rename), `admin-auth-state.ts` (comment
only, gate reference updated). Three scripts (`drill-footer-cta.mjs`,
`patch-nav-header-t28-t29.mjs`, `submit-navigation-review.mjs`) had their old
"expect-403 live agent publish probe" removed — under an autonomous posture
that probe would have actually **published**, not been refused, so firing it
blind was no longer safe; `--verify-tier3` is retired with an explicit error
pointing at the offline gate-matrix tests instead.

**Test matrix (`tests/netlify/publish-gate.test.ts`, new, replaces
`tier-gate.test.ts`):** every master × override × type combination in both
directions (master all-autonomous per type, master all-require-approval per
type, one override against each master for every governed type), the config
parse itself (dev default pinned; malformed configs throw; `content_item` and
typo'd keys rejected), M-6 pin exactness, the full content_revision
invalidation lifecycle (survives lock ops and the publish stamp, dies on a
body write), and two explicit "changing the config changes behavior
immediately" tests. `object-verbs-review.test.ts` and
`publish-review-lifecycle.e2e.test.ts` (the T1.8 exit drill) were rewritten at
the wiring/e2e level for the same model — including a new drill scenario
proving the replacement behavior end-to-end: gated navigation, approved by a
human, **published by the agent**, not a human.

Full suite green (822 netlify/src tests + 20 script tests, eslint/astro/prettier
clean) before this landed.

## Standing state (after session 2026-07-06 C)

| Area                   | State                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| T2.7                   | **STILL WAITING ON WOLF** — commands + clicks both run on his side (agent sandbox has no PUBLISH_SECRET and no egress to production); runbook §6  |
| T2.6                   | PARKED — Wolf alone                                                                                                                               |
| publishReceiptSchema   | **Approved + landed** (`df5e631`) — typed to the real buildReceipt shape; ObjectPublishReceipt derives from it                                    |
| T3.2 (M-9 + registry)  | **Done** (`57f878f` + `c292f7e`) — five components render 5/5 IDENTICAL to the live homepage via `scripts/verify-section-components.mjs`          |
| T3.3 (M-8)             | **Done** (`41bbc80`) — manual+fallback schema, validation, pure resolution helper for T3.6                                                        |
| Next (T3.4/T3.5)       | Reference-count validation (archive refused while referenced) + seed-page-home script (assembles from `home-fixture-data.ts` — one transcription) |
| T3.6+ homepage cutover | FORBIDDEN until Wolf's T2.7 clicks close Part 1                                                                                                   |

## Session 2026-07-06 C

Wolf's directives: receipt tightening approved (landed, `df5e631`); T2.7
"run the drill clicks" — **cannot run from an agent session**: no
`PUBLISH_SECRET` in the environment and the sandbox proxy blocks egress to
the production domain (verified empirically this session), and the
approve/publish clicks are architecturally human-only regardless (Tier 3 —
the drill exists to prove exactly that). The full command+click sequence
stays in runbook §6; every agent-side command is safe to run from Wolf's
machine as-is. Continued into Phase 3: T3.2 (with amendment M-9) and T3.3
(M-8) landed; T3.2's render gate compares component output against the live
homepage from the same build — the strongest available oracle — and passed
5/5. `index.astro` remains untouched (T3.6 is the cutover).

Continuation (same session, "keep working"): **T3.4+T3.5 seed half**
(`3c17c24`) — `scripts/seed-page-home.mjs` creates `sec_newsletter_signup`
then `page_home` with the seed-navigation discipline plus a schema-vintage
gate (the bodies use M-8/M-9 fields; a create rejection on those keys means
Phase 3 isn't deployed, not bad data); tests pin the seed deep-equal to the
T3.2 render fixture, so the seeded record IS the proven data. **T3.10 lib
half** (`050ada4`) — `netlify/lib/object-impact.ts` computes the real
affected-pages lists (shared_ref / navigationOverrides-then-site-default /
template provenance); `sec_newsletter_signup → page_home` pinned by test.

**Everything still open is gated**, none of it agent-completable offline:
T2.7 + T2.6 (Wolf), seed `--execute` + Tier 2 publishes (production creds,
post-deploy), T3.6–T3.9 cutover chain (forbidden until T2.7 closes),
T3.11 (needs published page objects), T3.10 admin wiring + T3.12 editor
(admin-UI surfaces — take them with a fresh session's full context), T3.13
(drill; also exposes that a new section type needs a union edit outside
the registry dirs — flag to resolve when run). **Open dependency noted:**
T3.4's archive-refusal needs an `archive` verb that does not exist yet —
object-impact provides the reference count it will consume; building the
verb is propose-first (new write path).

New gotcha for the log: Astro silently excludes underscore-prefixed files
in `src/pages` from routing — the render-gate fixture had to be named
without the `__` prefix.

## Standing state (after session 2026-07-06 B)

| Area                        | State                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0 + Phase 1           | Complete on `main`; both exit drills re-run this session from actual output (object-lifecycle 5/5, publish-review-lifecycle 4/4 covering the 5 scenarios)                 |
| Phase 2 (T2.0–T2.5, T2.8–9) | **Complete and live.** nav_header/nav_footer/nav_footer_home are CMS objects; chrome renders from published exports; T2.8+T2.9 end state verified (see §7 of the runbook) |
| T2.6                        | **PARKED — Wolf alone.** Production observation window, then the cleanup commit (runbook §5). Explicitly excluded from agent sessions                                     |
| T2.7                        | **READY FOR WOLF.** Agent side fully scripted + offline-verified; ordered checklist in runbook §6                                                                         |
| Object inventory (Part 2)   | **Done.** `object_inventory` MCP tool + `inventory` verb (commit `eed8cae`)                                                                                               |
| T3.1 PageType registry      | **Done** (commit `0a400c4`). `registry_get('page_type')` live; `listing`/`content_detail` typed-but-unimplemented until P6                                                |
| T3.2 component registry     | **Not started — next session's first task** (see "Next work" for the two decisions it needs)                                                                              |
| T3.3+ / homepage cutover    | Not started; **T3.5+ cutover remains forbidden until Wolf closes Part 1's human steps** (T2.7 clicks are the acceptance gate)                                             |

## Session 2026-07-06 B (this session)

Branch: `claude/phase-2-nav-footers-fdwfpt`, restarted from `main`@`e09e608`
(prior PR #362 merged; branch carried no unmerged work).

**Verification battery (mandate-required, all read from real state):**

- `main` tip `e09e608 Publish navigation: nav_header` — Wolf ran the
  T2.8+T2.9 patch + publish AFTER the premature #362 chrome merge; the
  rehearsed regression window closed itself. Recorded in runbook §7.
- `origin/main:src/data/site/navigation/nav_header.json` body deep-equals
  `applyPatchOps(seed, NAV_HEADER_T28_T29_OPS)` exactly (record_version 20;
  actions `['Join Early Access','Join Newsletter']`; `i_early_access` gone).
- `main` builds green (210 HTML files); rendered header carries both action
  containers with `data-newsletter-cta` in each; the only remaining
  'Early Access' label is the `nav_footer` link T2.7 edits by design.
- Phase 0 + Phase 1 exit drills pass from actual output.

**Landed (one task, one commit):**

- `6ac2c47` — T2.8+T2.9 runbook truth-up (executed record incl. the
  out-of-order merge; T2.5 gate marked PASSED 210/210).
- `bb28864` — T2.7 agent side: `scripts/drill-footer-cta.mjs` (two legs,
  pre-flight state gate, Tier 3 refusal check, submit-only),
  `scripts/lib/nav-footer-t27-drill.mjs`, offline tests proving both legs
  through the real T0.6/T0.7 engine (revert restores the seed byte-exactly);
  runbook §6 rewritten as the ordered agent/human checklist.
- `eed8cae` — Part 2: `object_inventory` MCP tool + `inventory` verb.
  Read-only; per object: tier, lock (held/free/holder/expiry, never the
  token), review state incl. `'none'`, version, content_revision,
  published_time, published_content_revision (from the T1.3 receipt),
  `unpublished_changes`; filters status/tier/review_state/pending_changes;
  single-object detail view. No new stored state.
- `0a400c4` — T3.1: PageType registry v1 (`src/lib/registry/page-types.ts`)
  - `registry_get('page_type')` serving definitions with a
    JSON-schema-rendered shape.

**Waiting on Wolf (ordered):**

1. **T2.7 drill** — runbook §6 checklist. Agent steps are scripted; your
   steps are the two review/approve/publish clicks (forward leg, then
   revert leg). This is the Phase 2 acceptance test and the gate the
   homepage cutover (T3.5+) waits behind.
2. **T2.6** — whenever you're satisfied with the production observation
   window: say so, and the cleanup commit gets prepared per runbook §5
   (delete `src/navigation.ts` + demo pages, build-verified).
3. **Proposal (shared-interface, not acted on):** `publishReceiptSchema` in
   `src/schema/object-record-v1.ts` is a loose `z.record(...)` while
   `buildReceipt` (T1.3) writes a rich fixed shape the new inventory now
   reads (`content_revision`). Tightening the schema to the real shape would
   let consumers rely on it — but it's a Phase 1 file, so it needs your nod.

**Next work (for the next agent session):**

1. **T3.2 component registry + section components** — deliberately deferred
   whole rather than half-landed. Two decisions to make at session start:
   (a) render-test vehicle for `.astro` components under the repo's
   tsc+node--test harness (Astro's experimental Container API needs a vite
   pipeline; options: a small vite-based test entry, or snapshot the built
   HTML via the T2.0 harness instead), and (b) whether registry modules
   import per-variant zod schemas from `section-v1.ts` (single source of
   truth stays in schema land) or the reverse. Extraction itself is
   mechanical: `index.astro:89-201` → five components, markup-verbatim.
2. T3.3 (M-8 content_grid manual+fallback), T3.4 (shared newsletter
   section), T3.5 seed script — in order, after T3.2.
3. Homepage cutover (T3.6/T3.7) only after Wolf's T2.7 clicks close Part 1.

**Gotcha log (recurring):**

- `*/` inside a JS block comment terminates it — bit T2.4's docs once and
  this session's drill script once (`--execute-*/--verify`). Write flag
  pairs without the slash-star adjacency.
- `node --test tests/scripts/` (directory form) fails; use the glob.
- The Astro content store bleeds across worktrees via symlinked
  node_modules — `scripts/build-diff.mjs` purges it per build; do the same
  in any new harness.
