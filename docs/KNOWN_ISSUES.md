# Known Issues — deferred / to be addressed later

This file tracks issues that were identified during work on the platform but
deliberately NOT fixed in the same change — either because the fix is a
larger design decision than the triggering bug warranted, or because it
requires a human call this repo's code cannot make on its own. Each entry
should stay here until it is either fixed (link the PR that closes it) or
explicitly decided against (note the decision and who made it).

> **Entries 7 and above** were added by the 2026-09-05 architecture-documentation pass
> (`ARCHITECTURE.md`, `CONTENT_ARCHITECTURE.md`, `CMS_INTEGRATION.md`, `TRACKING_ARCHITECTURE.md`,
> `DEPLOYMENT.md`, `DATA_CONTRACTS.md`, `GLOSSARY.md`), verified against commit `6789644`. They are
> all `[OPEN]` unless an entry says otherwise, and none has been triaged with Wolf yet. Entries 1–6
> above carry their own status and history and are unchanged.

## 1. QA-W16-1 follow-up: write-timeout root cause not investigated

**Status:** open. **Landed so far:** `fix/qa-w16-bridge-hardening` (PR #529)
added a client-suppliable `idempotency_key` bridge
(`packages/core/server/lib/idempotency-store.ts`, wired into `mcp.ts`'s
`callTool` switch) so a same-key retry after a client-visible timeout/502
replays the original result instead of re-running the write. That is
mitigation **(a)** from the original QA-W16-1 ask. Mitigations **(b)** and
**(c)** below were NOT done.

**The bug:** `object_create`, `object_publish`, `create_pdf_template`,
`create_agent_artifact_job`, and `release_to_production` returned a
client-facing Cloudflare 502 / hit a ~60s timeout ceiling at least 14 times
in the 2026-08-06 QA session — every single time, the underlying write had
already landed server-side by the time the client saw the failure. The
idempotency-key fix makes a *retry* safe; it does nothing to make the
original call finish inside its timeout budget, or to explain why these five
calls specifically are the ones that blow it.

**What still needs doing:**
- Instrument (or manually trace) how long each of the five calls' actual
  underlying work takes end-to-end, against the serverless function's real
  timeout budget:
  - `object_publish` / `release_to_production`: git export commit(s) to the
    content repo, plus (for `release_to_production`) the Netlify build-hook
    trigger and `deploy_status` polling loop it may wait on synchronously
    (see `packages/core/server/lib/production-release.ts`,
    `resolveReleaseWaitBudgetSeconds` in
    `packages/core/server/lib/mcp-tool-handlers.ts`).
  - `create_pdf_template` / `create_agent_artifact_job`: the render-dispatch
    round trip to the separate pdf-tool service (`packages/core/server/lib/
    pdf-tool-client.ts`) — check whether pdf-tool's own render latency
    (rather than this platform's serverless budget) is the actual ceiling.
  - `object_create`: usually fast, but worth confirming it isn't incidentally
    paying for a synchronous validation-context build across every object
    type (see `packages/core/server/lib/object-validation-context.ts` and
    related perf work in PR #527) on some sites.
- Once the actual bottleneck is identified, consider mitigation **(b)** from
  the original QA-W16-1 ask: move the genuinely slow paths
  (`object_publish`, `release_to_production`) off the synchronous
  request/response path the way `create_agent_artifact_job` already does —
  return a job/receipt id immediately, let the caller poll
  (`get_agent_artifact_job_status`-style) for completion, instead of holding
  the MCP HTTP connection open for the full duration of the underlying work.
- Mitigation **(c)**: reconcile the serverless function's actual timeout
  ceiling (Netlify Functions invocation limit) against the platform's own
  release-wait budget config (`resolveReleaseWaitBudgetSeconds`) — if the
  function's own hard timeout is shorter than the wait budget it's
  configured to honor, the mismatch itself is a bug independent of pdf-tool
  or git-export latency.

**D2a note (2026-08-17):** the two chat verbs `publish_workspace_run` and
`release_workspace_run` execute in the chat run's BACKGROUND hop
(`admin-agent-chat-run-background.ts`, after approval), never inline in the
interactive function — so the write-timeout ceiling above applies to that
hop's budget, not the approve request. `release_workspace_run` reuses the
`release_to_production` idempotency ledger (`release:<runId|commit>`) and
`publish_workspace_run` stores `publish:<runId>` through the same store, so a
timed-out hop can be re-approved safely.

## 2. QA-W16-3 follow-up: four destructive admin tools share the same broken auth — RESOLVED (Option B)

**Status:** RESOLVED 2026-08-10 on branch `fix/qa-w16-3-admin-gate`. Wolf
chose **Option B**: the four tools stay admin-only; the gate itself was fixed
so it fails closed *correctly*. `requireAdminToolAccess`
(`packages/core/server/lib/mcp-artifact-admin.ts`) now (a) refuses an
MCP-gated caller up front with the catalogued `error_code: 'admin_required'`
and a message that says the tool is admin-only — no more doomed
`${IDENTITY_URL}/user` round trip impersonating a credential failure — and
(b) resolves the human path through `resolveAdminAccessFromEvent`
(`packages/core/server/lib/request-roles.ts`), the W15 S1 single admin
resolver, instead of `getAdminStateFromEvent`'s older ADMIN_EMAILS-only
`isAdmin`, which wrongly denied an admin granted the tier by store invite.
Option A (widening these four to any MCP-authenticated caller) was
explicitly NOT taken; do not add an `event.mcpGateAuthenticated` bypass to
this gate. Covered by `tests/netlify/mcp-artifact-admin-gate.test.ts`.

**One correction to the diagnosis below:** the gate never failed *open*, and
it did already attach `error_code: 'admin_required'` to the structured
payload — what was wrong was the human-readable message (it forwarded
`getAdminStateFromEvent`'s "Authentication token could not be verified.")
and the fact that authority was resolved from a role source no MCP caller
can ever satisfy. There is also no HTTP `403` involved: an MCP tool
refusal is an `isError` tool result with an `error_code`, not a status code.

**Original entry, for the record. Related fix already landed:**
PR #529 fixed the identical broken-auth bug for `list_artifacts_by_kind`,
`search_artifacts`, and `list_artifacts_by_request` via a new
`requireArtifactBrowseAccess` helper in
`packages/core/server/lib/mcp-artifact-admin.ts`, which trusts the
`event.mcpGateAuthenticated` flag (set once per request in
`packages/core/server/functions/mcp.ts`'s `handler`, immediately after
`getAuthResult` succeeds) instead of re-checking an unrelated Netlify
Identity/GoTrue browser session — a check that always fails for an MCP
caller regardless of how valid their MCP credentials are.

**The bug (as originally described):** `soft_delete_artifact`, `restore_artifact`,
`migrate_artifact_indexes`, and `reconcile_artifact_indexes` (all in
`packages/core/server/lib/mcp-artifact-admin.ts`, dispatched from
`packages/core/server/functions/mcp.ts`'s `callTool`) still call the
stricter, unchanged `requireAdminToolAccess` gate, which has the same
Netlify-Identity-session check at its root and will surface the same
generic "Authentication token could not be verified" error for any MCP
caller who isn't also carrying a valid browser session cookie — which no
MCP agent ever is.

**Why it was left unfixed:** unlike the three read-only browsing tools,
these four are destructive or index-mutating. Applying the same
`event.mcpGateAuthenticated` trust fix would make them callable by *any*
authenticated MCP caller (same shared-secret/verified-agent-token/OAuth
surface as every other tool), not just an admin. That is a real widening of
who can soft-delete an artifact, restore one, or rewrite the artifact index
— a security-relevant decision, not a pure bug fix, so it was deliberately
left for a human to decide rather than auto-applied alongside the read-tool
fix.

**The decision a human needs to make:**
- **Option A** — apply the same `requireArtifactBrowseAccess`-style fix
  (trust `event.mcpGateAuthenticated`) to these four tools too, accepting
  that any MCP-authenticated caller (not just an "admin") can then
  soft-delete/restore artifacts or trigger index migration/reconciliation.
- **Option B** — keep these four admin-only, but fix `requireAdminToolAccess`
  so a caller who fails the *admin* check gets a correct, clear `403` /
  `admin_required` response instead of the current broken-auth error that
  looks identical to "your MCP credentials are invalid" (which they are not
  — the caller may be a perfectly valid MCP caller who simply isn't an
  admin).

**Decision:** Wolf, 2026-08-10 — **Option B**, as recorded at the top of this
entry. The security posture stays tight: these four remain privileged.

## 3. Admin-content perf follow-up: unbounded `history[]` makes every store sweep heavier over time

**Status:** open, deferred pending measurement. **Related fix already
landed:** PRs #527/#528/#530 cut `/admin/content`'s read path from ~166
serial blob round trips to ~26 parallel batches, skip the validation-context
build entirely for reads/lock verbs, cache+dedupe the client's inventory
fetch, and warm `admin-object`/`admin-audit` on the existing `/mcp` keepalive
schedule. That fixes the *request-count* and *cold-start* cost. It does
nothing about the *per-record payload* cost below, which grows
monotonically with usage and will eventually erode the win.

**The problem:** `ObjectRecord.history` (`packages/core/schema/object-record-v1.ts`)
is append-only with no cap. Patch entries embed a `{before, after}` content
snapshot per op (`packages/core/lib/object-patch-apply.ts`); checkout,
checkin, refresh_lock, and publish all append their own entries too
(`packages/core/server/lib/object-lock.ts`, `object-publish.ts`). Every full
sweep — `inventory`, `listAllObjectRecords` (the audit feed), and
`buildStoreValidationContext` when it does run — downloads and JSON-parses
the *entire* record, including all of `history[]`, then uses none of it (row
derivation in `packages/core/server/lib/object-inventory.ts` only touches a
handful of top-level fields).

On the live Dr-Lurie store, measured 2026-08-06: `page_home` is at
`version: 117`, `history_length: 117` for a body that exports to 5.5 KB;
`nav_header` is at version 96. Neither number trends down — it is pure
audit-log growth, and it will keep raising the byte cost of every sweep
regardless of how parallel or well-cached the request pattern is.

**What still needs doing:**
- **Measure first**, against the real store, before committing to a design —
  a one-off script under `scripts/` that reports, per object: body bytes,
  history entry count, history bytes, total record bytes. Quantify the win
  before assuming one is needed at the current object count (~70); this
  matters more as the fleet's per-site object counts grow. **Delivered:**
  `scripts/measure-object-history.mjs` (see Findings below) — the fix itself
  remains deferred pending a credentialed run.
- If the numbers justify it: cap live `history[]` at N most-recent entries
  (50 is a reasonable starting point) and spill the older tail to a sidecar
  blob (e.g. `objects/<type>/history/<object_id>.json`), written on the same
  op as the record write. Add a key helper beside `objectRecordKey` in
  `packages/core/server/lib/object-store-keys.ts`.
- Anything that needs the *full* history must keep working without a
  behavior change: the audit feed (`packages/core/server/lib/audit-feed.ts`),
  `inventory` detail's `history_length` (must report the TRUE total — live +
  spilled — so store a running counter on the record rather than deriving it
  from `history.length` after capping), and the discard/inverse-op path
  (confirm it never needs an entry old enough to have been spilled; if it
  can, either exempt those entries from spilling or teach that path to read
  the sidecar).
- Ship the cap as an idempotent migration script runnable against an
  existing store, with tests, not as a schema change that silently breaks
  old records.

**Why it was left unfixed:** it's a schema/data-model change (spilling
history out of the live record) rather than a pure query-path fix, it needs
production data to size correctly, and #527/#528/#530 already deliver most
of the near-term latency win — this is follow-up work, not a blocker.

**Findings (2026-08-10):** `scripts/measure-object-history.mjs` was written
this session and run in its offline mode (its `--live` mode was also
invoked, but this sandbox had no `MCP_HTTP_AUTH_TOKEN__<SLUG>` set, so it
only exercised the token-missing skip path — see below). A few real
production reads were separately gathered by hand in this same session, via
the MCP tools already connected to it (not via the script — noted
explicitly so the two sources are never confused).

*How to run:*
- Offline (always safe, no credentials, reads the committed exports):
  `node scripts/measure-object-history.mjs [--site sites/<slug>] [--json <path>]`
- Live (needs `MCP_HTTP_AUTH_TOKEN__<SLUG>` per site, same convention as
  `fleet-capability-probe.mjs`): `node scripts/measure-object-history.mjs
  --live --all [--limit N] [--all-objects] [--json <path>]`

*Offline run, this session (committed exports, all three sites, 138 objects):*
- history entry-count distribution — exact, taken from each export's
  `__generated.record_version`, which is a proven 1:1 proxy for
  `history.length` (every code path that appends a history entry bumps
  `version` by the same count in the same write; see the script header for
  the exact source citations, e.g. `review-state.ts`'s own comment "it bumps
  `version` (every write does)"): min=2, median=6, p90=27, max=108.
- worst offenders by entry count: `page_home` 108, `nav_header` 94,
  `nav_footer` 88, `sec_about_intro` 48, `nav_footer_home` 39, `tpl_interior`
  33, `tpl_landing` 32.
- total committed export bytes across all 138 objects: 397,203 B; total
  lifetime history-entry count summed across all objects: 1,581.
- offline mode cannot report history byte size, the history/total-bytes
  fraction, or real sweep timing — committed exports never carry
  `history[]` (documented limitation, not a bug in the script).

*Live spot-check, this session, 2026-08-10 (two real production objects read
in full via the connected MCP tool, saved and measured exactly — NOT via the
script, since the script itself had no token in this sandbox):*
- `page_home` (version/entry_count 120): total record 93,546 B, history
  88,756 B (**94.9%** of the record), body 3,879 B → ~740 B/history entry.
- `site_drlurie` (version/entry_count 30): total record 24,500 B, history
  22,351 B (**91.2%** of the record), body 1,496 B → ~745 B/history entry.
- (A third read, `nav_header` at version 96, was also fetched live and
  visibly matched the same order of magnitude, but wasn't saved to a file
  for exact byte counting in this pass.)
- Two independent samples landing in the same ~740 B/entry range, both
  showing history at ~91–95% of total record bytes at their current version
  counts, is the first REAL (not inferred) confirmation of this issue's
  premise on the live store.
- A full unfiltered `object_inventory` sweep (the same call `/admin/content`
  makes, and the same one this script's `--live` mode issues first) was
  attempted live by hand and did not return within the tool's 60s timeout;
  this session also saw one unrelated transient 502 from a different site's
  MCP endpoint. Neither is reported as a real sweep-latency number — both
  conflate connector/transport overhead with actual blob-store latency, and
  no isolated retry was run before writing this down.
- Order-of-magnitude only, extrapolating the ~740 B/entry ratio onto the
  offline distribution's max (108 entries) and p90 (27 entries) puts those
  records around 80 KB and 20 KB of history respectively — not a
  measurement, and not something to design a spill threshold from; bytes/
  entry plainly varies by object type (a `nav_header` op captures a whole
  `{before, after}` group/brandTokens-shaped payload; a plain single-field
  patch is much smaller).

**What still needs a credentialed run before #4 (maintained inventory index)
can be decided:**
- The real per-object `history_bytes`/`total_bytes` for every object in the
  store, via `node scripts/measure-object-history.mjs --live --all
  --all-objects` run end-to-end with real tokens — this session's own
  `--live` invocation only reached the token-missing skip path and was never
  exercised for real.
- A real full-inventory-sweep wall-clock + bytes-fetched number from one
  clean run (the 60s timeout hit by hand above cannot stand in for it).
- Confirmation the ~740 B/entry ratio (n=2: one page, one site singleton)
  holds across object types with much larger or smaller per-op captures
  (`content_item` node ops, `nav_header` group/item patches, a plain
  single-field `set_*_fields` patch) before it's used for anything beyond
  order-of-magnitude framing.

## 4. Admin-content perf follow-up: inventory sweep could become a maintained index instead of a live sweep

**Status:** open, deferred — try this only if #527/#528/#530 (and #3 above,
if it lands) turn out not to be enough. **Related fix already landed:** see
#3 above; this is the next tier up if the read path is still too slow after
those.

**The idea:** `inventory`'s list form
(`packages/core/server/lib/object-verbs.ts`, `case 'inventory'`) still does a
live sweep of every record even after #527/#528/#530 (it's now parallel and
skips the validation-context duplicate work, but it still touches every
object). Every field an inventory *row* needs
(`inventoryRowFromRecord` in `packages/core/server/lib/object-inventory.ts`
— object_id, object_type, display_name, updated_at, status,
requires_approval, version, content_revision, review_state, lock,
published_time, published_content_revision, unpublished_changes, the recipe
summary) is cheap to compute at write time. A maintained index blob
(`objects/_index/inventory.json`, written on every mutating verb alongside
the record write, following the existing `objectStatusIndexKey` precedent in
`object-store-keys.ts`) would turn list-form `inventory` into one blob read
instead of an N-record sweep.

**Why it was left undone:** it's real complexity for a win that may not be
needed once #527/#528/#530 land — validate the live impact of those first.
It also has sharp edges that need explicit design, not a quick patch:
- Must be rebuildable from scratch (`rebuildInventoryIndex()` + a `scripts/`
  entry point) with a safe fallback to the current full-sweep path if the
  index is missing or its schema version doesn't match — never serve a
  silently-stale index.
- Per the consistency note already in
  `packages/core/server/lib/blob-store.ts`, the site-objects store's
  requested `'strong'` consistency is silently EVENTUAL on the Lambda
  name-lookup path (no blobs-scoped token configured). The index write must
  happen on the exact same code path as the record write, and a
  read-after-write in the admin UI must not show a stale row — if that can't
  be guaranteed, the write path should return the updated row to the client
  directly instead of relying on a re-read of the index.
- `requires_approval` depends on the runtime governance policy
  (`packages/core/lib/approval-policy.ts`), which can change with no object
  write at all. The index must either recompute that field at read time from
  the live policy, or be invalidated whenever the policy changes — a stored,
  never-recomputed value would silently drift from the truth.
- Single-object `inventory` detail (with `object_id`) should keep reading the
  record directly, not the index — it needs review decisions, the publish
  receipt, and history length, none of which belong in a lightweight list
  index.

Whoever picks this up should re-measure `/admin/content` load time against
production after #527/#528/#530 (and #3, if done) are live, and only build
this if the sweep is still the bottleneck.

## 5. Membership: invite link lands on the offer page / platform invites send no mail / reset link dead — FIXED-BY T18.0a/b/c

**Status:** fixed (W18 wave 0, 2026-08-17). Kept here so support searches find
the symptoms.

- **F1 — "the invite link lands on the home/offer page and nothing happens; I
  can't set a name or password."** Netlify Identity's invite mail links to
  `{{ .SiteURL }}/#invite_token=…`; nothing read that hash. **FIXED-BY
  T18.0b:** every page routes an Identity token hash to `/admin/accept`,
  which sets name + password and activates the membership.
- **F2 — "I invited someone from `/admin/settings/admins` and the toast says
  'invite email pending' forever; no e-mail ever arrives."** The platform
  called GoTrue `POST /admin/users` (creates a user, needs a password, sends
  nothing) instead of `POST /invite`. **FIXED-BY T18.0a.** Invites made
  before the fix: re-send from the Netlify Identity tab (runbook §admin,
  "Recovering a stuck invite").
- **F3 — "Forgot password link does nothing."** The client expected
  `#access_token=…&type=recovery`; GoTrue's default recovery mail sends
  `#recovery_token=…`. **FIXED-BY T18.0b:** both shapes are consumed
  (`/admin/accept` for the default, the modal for the customised form).
- **Templates** — the default Netlify templates still work via the router;
  the branded ones core publishes at `/emails/identity/*.html` need their
  paths set once per site in the console. **T18.0c** wrote the checklist,
  audit row (`identity-console-settings`) and FLEET-STATUS tick-box block.

**W18 closeout (T18.8, 2026-08-17) — the rest of the plan's findings are
CLOSED too** (`18-membership-plan.md` §1 status line, §8 what-shipped table):
no AI/MCP membership surface (F4 → T18.6a/b, human principal required —
agents get `membership_requires_human`), disable ≠ offboarding (F5 → T18.4:
OAuth grants revoked, locks handed off, identity deleted-or-queued, purge
sweep), re-invite didn't reactivate (F6), half-modelled roles (F7 → five
tiers), no name capture (F8 → `/admin/welcome`), invitations not first-class
(F9), bootstrap owners unmanageable (F10 → `promote_bootstrap`), fleet parity
(F11 → T18.7). Still human: the per-tenant console clicks and the first
stored Owner per site — FLEET-STATUS "Membership footing per tenant", T18.9
Part B. Known-and-accepted (not an issue): a suspended/removed member's JWT
stays valid ≤ 1 h; every function re-resolves roles per call, so they cannot
act — there is no server-side GoTrue logout.

## 6. OAuth refresh-token rotation has no grace window — a retried refresh kills the grant — FIXED

**Status:** CLOSED. Fixed as described under "If it is taken" below: a 90s
reuse grace window plus family revocation, in `handleTokenRequest`
(`oauth-server.ts`), with `family_id` and `rotated_at` added schema-additively
to `refreshTokenSchema`. The pinned test in `mcp-oauth.test.ts` changed from
"the replay is dead" to "the replay inside the window succeeds"; the
after-the-window replay and its family revocation are pinned in
`mcp-oauth-hardening.test.ts` §4. The original analysis is kept below because
it is the reason the shape of the fix is what it is.

---

**Original (open) writeup:**

`handleTokenRequest`'s `refresh_token` branch (`oauth-server.ts`) deletes the
presented refresh token BEFORE it issues the replacement pair, and a second
presentation of that same token is `invalid_grant` forever after. That is
OAuth 2.1 §4.3.1 rotation done strictly, and `mcp-oauth.test.ts` pins it: *"a
rotated refresh token must be dead"*.

**The cost:** rotation with no grace period cannot tell a stolen token from a
RETRIED one. A connector whose refresh POST times out, is retried by its own
HTTP layer, or is issued twice concurrently (two tabs, two workers) presents
the same refresh token twice — the second attempt is refused, the grant is
destroyed, and the human is told to reconnect. Nothing distinguishes that from
a genuine credential failure at the client, and the connector's message for it
is the same "Authorization with the MCP server failed" that every other cause
produces.

**The usual fix** is a short reuse grace window: mark the record `rotated_at`
instead of deleting it, honour a re-presentation within ~60s, and treat one
after that as reuse — refusing it AND revoking the rest of the family (the
reuse-detection half of the same spec section, which strict deletion does not
implement either, since a deleted record cannot detect anything).

**Why it was not done here:** it inverts a security property this repo
deliberately pinned with a test. Widening it is a call about how much replay
tolerance the fleet wants, not a bug fix, and it should be made explicitly
rather than arrive inside a change about something else.

**If it is taken:** the grace window goes in `handleTokenRequest`, the
`rotated_at` field is schema-additive on `refreshTokenSchema`, and the pinned
test changes from "the replay is dead" to "the replay inside the window
succeeds, the one after it is dead AND revokes the family."

## Architecture defects found 2026-09-05

56 deduplicated entries consolidated from the five investigation reports (74 raw findings;
overlaps merged, every source cited). All `[OPEN]`. Sources are abbreviated **A** (repo
classification), **CA** (`CONTENT_ARCHITECTURE.md`), **CI** (`CMS_INTEGRATION.md`), **TR**
(`TRACKING_ARCHITECTURE.md` §13), **DE** (`DEPLOYMENT.md`). A scan-friendly summary table is at the
end.

### 7. `SITE_NOT_YET_LIVE` forces `noindex,nofollow` on every page of every tenant

**Category:** seo · **Severity:** high · **Sources:** CA#1
**Evidence:** `packages/core/app/components/common/Metadata.astro:33,89-92` (hardcoded `true`,
applied *after* merging `config.yaml` + `site.json` + per-page props); contradicted by
`sites/drlurie/config.yaml` (`robots:{index:true,follow:true}`), `sites/drlurie/public/robots.txt`
(`Disallow:` = allow all) and `@astrojs/sitemap` (`site-astro-config.ts:99`).
**Impact:** every published article is invisible to search engines while the sitemap advertises it,
fleet-wide, with no per-site override.
**Direction:** make it a per-site config value rather than a shell constant — **decision needed by
Wolf** on which tenants flip to indexable and when.

### 8. The purchase→event join key can never match

**Category:** tracking-id-instability · **Severity:** blocking · **Sources:** TR#1
**Evidence:** `packages/core/server/functions/checkout-session-status.ts:33,40` returns
`X-CEID: session.metadata.event_id`, minted as a fresh `randomUUID()` at
`create-checkout-session.ts:121`; every `commerce_event` the webhook writes uses
`deterministicUuid(\`${session.id}:${type}\`)` (`stripe-webhook.ts:210,254`); kugel-data joins
`ce.event_id::text = te.props->>'commerce_event_id'` (`004/005_*.sql`).
**Impact:** `purchase_rate`, `revenue_cents` and `v_sessions.purchased` are structurally always
zero — the whole engagement→revenue link is dead.
**Direction:** make one generator authoritative for the checkout's event id and echo that same id
on both sides.

### 9. `commerce_events.kind` is never `'purchase'`

**Category:** tracking-schema · **Severity:** blocking · **Sources:** TR#2
**Evidence:** `packages/core/server/lib/commerce-events.ts:commerceSinkPayload` sets
`kind: event.type` from `commerceEventTypes` (`checkout_completed`, `fulfillment_issued`, …; no
`purchase` member); kugel-data filters `kind = 'purchase'` in `tracking-sink-stats.ts`,
`v_attributed_purchases` and `v_sessions`, and its own seed (`scripts/seed-rollups.mjs`) writes
`purchase`, so its tests stay green.
**Impact:** the admin "Purchases" KPI and `daily[].purchases` are always 0 even when orders exist.
Independent of #8 — both must be fixed.
**Direction:** agree one vocabulary across the boundary and pin it with a contract test on both
sides.

### 10. `buy_click` never carries `commerce_event_id`

**Category:** tracking-id-instability · **Severity:** high · **Sources:** TR#8
**Evidence:** `packages/core/lib/tracking/loader/index.ts:121-136` reads `X-CEID` off the
create-checkout response; `create-checkout-session.ts:147` returns `event_id` in the JSON **body**
and sets no such header. The loader test stubs a fake `X-CEID`
(`tests/netlify/tracking-loader.test.ts:420,428`), so CI cannot see the gap.
**Impact:** the one event that could tie an intent click to a checkout carries no correlation id.
**Direction:** have the loader read the id from the response body it already parses (and fix the
test's stub to match production).

### 11. `node_strategy.strategy` / `.intent` are NULL for all new content

**Category:** tracking-schema · **Severity:** high · **Sources:** TR#3
**Evidence:** `packages/core/server/lib/materializers/shared.ts:132 stripPrivate` drops every
`private` key from every export (W6 Q, 2026-08-31), but `scripts/tracking-dims-push.mjs:88-90` reads
`node.private?.strategy` / `.intent` from those exports; every committed article with
`__generated.at >= 2026-09-03` has zero nodes carrying `private`. The unit test stays green because
`tests/scripts/tracking-dims-push.test.mjs:30` hand-builds an export that still has `private`.
**Impact:** the blessed "engagement × strategy" join — the entire reason `node_strategy` exists —
degrades to nulls for everything published from now on.
**Direction:** source the dimension from the object record (or a materializer-emitted allowlisted
field) instead of from the stripped export.

### 12. `object_version.surface` / `.attribution` are pushed and thrown away

**Category:** tracking-schema · **Severity:** medium · **Sources:** TR#4
**Evidence:** `scripts/tracking-dims-push.mjs:60-75` sends both columns and declares a "SINK
CONTRACT"; kugel-data's `002_*.sql` defines neither and `tracking-sink-dims.ts
normalizeObjectVersion` does not read them.
**Impact:** "do plugin-written articles perform differently from workflow-written ones" is
answerable only inside the CMS admin (top-N objects), never from the owner DB.
**Direction:** either add the two columns downstream or delete the claim from the push script's
contract comment.

### 13. Publish attribution is inconsistent between exports written the same day

**Category:** data-quality · **Severity:** medium · **Sources:** CA#14
**Evidence:** `sites/drlurie/data/site/articles/req_plugin_azelaic_acid_20260904_01.json` carries
`__generated.surface:"plugin:claude"` + `attribution:"oauth"`, while
`req_plugin_dark_circles_20260904_01.json` — same surface, same day, same `prompt_version` — carries
`producer` but neither; `object-publish.ts:publishProvenance` copies both from `input.actor`.
**Impact:** the learning join rests on export dimensions that are silently absent for some
revisions, and ingest cannot distinguish "absent" from "not applicable".
**Direction:** decide whether `surface`/`attribution` are required at publish and enforce (or record
an explicit `unknown`) rather than omitting the keys.

### 14. A tenant that never opted into first-party collection is collecting

**Category:** privacy · **Severity:** high · **Sources:** TR#6
**Evidence:** `packages/core/app/components/tracking/TrackingScripts.astro:105-113` gates only on
"a `tracking_config` export exists"; `lib/tracking/assemble.ts:124` then defaults `ingest_path` to
`/api/t`. `sites/platform/data/site/tracking.json` has `"providers": {}` — no `own` block — yet the
platform tenant ships the loader and beacons. `adapters/own.ts` contributes its `connect-src 'self'`
CSP entry only when `own.enabled === true`, so collection and CSP declaration disagree.
**Impact:** collection without an opt-in, and the documented "flip a switch" contract for
`own.enabled` does nothing.
**Direction:** gate the loader on `providers.own?.enabled === true`, not on the export's existence.

### 15. Tracking retention is documented and tooled but never enforced

**Category:** privacy · **Severity:** high · **Sources:** TR#10
**Evidence:** `packages/core/server/lib/tracking-events.ts:16` states 90 days;
`scripts/tracking-mirror-prune.mjs` implements it but is dry-run by default, needs a manual `tsc`
step, is in no npm script and in no `[functions."…"] schedule` block of any `netlify.toml`.
kugel-data has no purge job (its only schedule is `experiment-weights @daily`).
**Impact:** an unbounded, growing store of hashed-but-personal event data under a written 90-day
policy nobody applies.
**Direction:** schedule the prune on both sides — **policy call by Wolf** on the real retention
window first.

### 16. The CSP-drift gate is blind to the tenant most likely to enable an ad provider

**Category:** privacy · **Severity:** high · **Sources:** TR#5
**Evidence:** `tests/netlify/csp-drift.test.ts:139` lists drlurie as "root netlify.toml — no
committed tracking export" with **no** `trackingPath`, but `sites/drlurie/data/site/tracking.json`
exists (`record_version: 8`, 2026-08-31); zilberman and fernwell are absent from the table
entirely.
**Impact:** the one gate making "enabling a provider must ship its CSP hosts in the same change"
enforceable cannot see drlurie — the exact failure T16.6 fixed for platform, reintroduced.
**Direction:** derive the tenant table from the fleet discovery list instead of hand-maintaining it.

### 17. `/admin` paths are excluded from the own feed but not the Netlify feed

**Category:** privacy · **Severity:** medium · **Sources:** TR#12
**Evidence:** `/admin` is dropped at the loader (`lib/tracking/loader/core.ts:310`) and at ingest
(`server/functions/track-ingest.ts:249`), but `packages/core/lib/admin/analytics-logic.ts
normalizePathLabel:202` applies no exclusion, so Netlify's `/ranking/pages` lists `/admin/...` rows.
`analytics-dashboard-spec.md` R6.4 requires "no admin path in any rendered ranking, both feeds".
**Impact:** admin URLs (including object ids in paths) surface in a rendered dashboard.
**Direction:** apply the same path exclusion in the Netlify-feed normalizer.

### 18. The one committed example of the tracking wire format is schema-invalid

**Category:** tracking-schema · **Severity:** medium · **Sources:** TR#9
**Evidence:** `tests/fixtures/tracking-events/pageview.json` has `url` as a bare string and
`consent:{analytics, marketing}`; `trackingEventSchema` requires `url:{path, route?}` and
`consent:{analytics, ads, gpc}`. The fixture is only ever grepped for PII strings
(`tests/netlify/tracking-pii-leak.test.ts`), so nothing validates it.
**Impact:** anyone reading the fixture to build a consumer builds the wrong consumer.
**Direction:** parse every tracking fixture through `trackingEventSchema` in the test that uses it.

### 19. The experiments subsystem is complete and structurally inert

**Category:** tracking-schema · **Severity:** medium · **Sources:** TR#14
**Evidence:** kugel-data's `v_variant_assignment` needs `event = 'exposure'` carrying
`props->>'variant_id'`; `exposure` is not in `TRACKING_EVENT_KINDS`
(`packages/core/schema/bodies/tracking-config-v1.ts:35`) and `variant_id` is not in
`trackingPropsSchema` (`schema/tracking-event-v1.ts:53`), so the sink would reject such an event.
`005_rollups_on_baseline_traffic.sql` works around it with a synthetic `'control'` arm;
`experiment-weights` filters `arms.some(a => a.exposures > 0)` and therefore decides nothing;
`packages/core/lib/admin/variant-experiments.ts:17-27` states the same from the CMS side.
**Impact:** an entire experiment/weights pipeline that cannot ever produce a decision.
**Direction:** either add `exposure` + `variant_id` to the event contract or retire the downstream
views — **product call**.

### 20. `data-cms-buy-product` is classified but never emitted

**Category:** dead-code · **Severity:** low · **Sources:** TR#7
**Evidence:** `packages/core/lib/tracking/loader/dom.ts:46-57` classifies `buy_click` from
`[data-cms-buy-product]`; repo-wide grep finds no emitter. Real buy clicks come from the
`#buy-box` + `[data-role="buy"]` path (`loader/index.ts:251-253`), which exists only in
`sites/drlurie/app/pages/shop/[slug].astro:97,104`.
**Impact:** a dead branch that reads as coverage; a non-drlurie shop page would emit no `buy_click`.
**Direction:** delete the branch, or emit the attribute from the section renderer so it is real.

### 21. `/stats` is called with a write token it does not want

**Category:** security · **Severity:** low · **Sources:** TR#13
**Evidence:** `packages/core/server/lib/own-tracker-stats.ts:67-68` attaches
`Authorization: Bearer ${TRACKING_SINK_TOKEN}`; kugel-data's `tracking-sink-stats.ts` has no
`requireBearer`.
**Impact:** the fleet-shared write token travels to an endpoint that ignores it — needless exposure.
**Direction:** drop the header on the `/stats` call.

### 22. Publish and release are unordered, unsynchronised and not isolated per publisher

**Category:** publishing-race · **Severity:** high · **Sources:** CA#13, CI#3
**Evidence:** `object_publish` commits with `[skip netlify]` and returns `production.live = false`;
nothing records that a release is owed. `packages/core/server/lib/production-release.ts:98-120`
resolves the target as **branch HEAD**, so whoever releases first deploys everyone's pending
exports. `packages/core/server/lib/plugin/render-skill.ts:369-375` records an observed failure: the
hook fired before `release_to_production` returned, `idempotency_key` did not suppress a second
build, and a 502-then-retry produced two production builds for one release.
**Impact:** an agent that publishes and stops leaves the export dark; the next agent's release ships
it unreviewed; a retry can double-build. The only guard is prose in `OBJECT_PUBLISH_LIVE_NOTE`
(`mcp-tool-handlers.ts:3324`).
**Direction:** make the release target the caller's own commit and record an owed-release marker on
the record, so the pairing is a mechanism rather than an instruction.

### 23. Two commit streams still race one ref, and the code comment names a hazard that no longer exists

**Category:** publishing-race · **Severity:** medium · **Sources:** CI#4
**Evidence:** `packages/core/server/lib/object-git-committer.ts:12-20` documents this committer and
"the article publisher" as two streams racing to PATCH `refs/heads/{branch}` (OQ-13); the article
side was deleted 2026-07-29. The real remaining race — two tenants' lambdas, or two concurrent
publishes on one tenant, all PATCHing `main` of the **one shared** `GITHUB_REPOSITORY` — is bounded
only by `maxAttempts: 4` × 250 ms backoff.
**Impact:** a fleet-wide publish burst is a plausible `non_fast_forward_exhausted`; the comment
misdirects whoever tunes it.
**Direction:** re-describe the real race and raise/serialize the retry budget against measured
fleet concurrency.

### 24. A publish receipt proves the export, not the deploy — and one boolean hides two situations

**Category:** build-deploy-mismatch · **Severity:** medium · **Sources:** CI#5
**Evidence:** `publish_receipt` carries `commit_sha` for a `[skip netlify]` commit
(`object-publish.ts:75-87`); `released`/`productionConfirmed` come from a different call, and
`production-release.ts:71-78` documents that `productionConfirmed:false` with `released:true` means
either "production serves something else" **or** "the published-deploy lookup was unavailable".
**Impact:** the receipt is what surfaces first, so "published" reads as "live"; and an operator
cannot tell a stale deploy from a missing credential.
**Direction:** split the ambiguous boolean into an explicit status enum and label receipts as
export-only in every surface that renders them.

### 25. A shared-token caller has no write budget at all

**Category:** security · **Severity:** high · **Sources:** CI#7
**Evidence:** `packages/core/server/functions/mcp.ts:1544-1545` derives the rate-limit subject from
`oauthPrincipal.subject_id ?? verifiedAgentName`; with neither — i.e. the shared
`MCP_HTTP_AUTH_TOKEN` path — it returns `undefined` and skips the limit entirely
(`write-rate-limit.ts:26-35` is never reached).
**Impact:** the runaway-loop protection is absent on exactly the credential most likely to be pasted
into a script.
**Direction:** fall back to a per-token (or per-IP) subject so the 60-writes/10-min ceiling always
applies.

### 26. `admin-get-blob-pdf` compares the publish key with `===`

**Category:** security · **Severity:** medium · **Sources:** CI#9
**Evidence:** `packages/core/server/functions/admin-get-blob-pdf.ts:23-30`; every other publish-key
check uses `timingSafeEqual` (`object-store.ts:63-68`, `deploy-status.ts`, `mcp.ts:355-362`). It is
also the only `admin-*` function that accepts the publish key at all.
**Impact:** a timing side channel on a fleet secret, on a surface otherwise gated by browser auth.
**Direction:** use the shared constant-time comparator, and reconsider whether this function should
accept the publish key.

### 27. Agent-key revocation is up to 60 s late while OAuth revocation is immediate

**Category:** security · **Severity:** medium · **Sources:** CI#8
**Evidence:** `verifiedAgentNameMemo` caches positive resolutions for `AUTH_MEMO_TTL_MS = 60_000`
(`packages/core/server/functions/mcp.ts:613,699-714`); `admin-governance`'s `agent_keys_revoke`
gives an Owner a revoke button whose effect is silently delayed.
**Impact:** a revoked agent can keep writing for up to a minute, with no UI signal.
**Direction:** either invalidate the memo on revoke or state the delay in the revoke confirmation.

### 28. `run-publisher-agent` is deployed on four tenants with no live caller

**Category:** security · **Severity:** high · **Sources:** A#4, CI#10
**Evidence:** `packages/core/server/functions/run-publisher-agent.ts` plus root
`netlify/functions/run-publisher-agent.ts` and three tenant shims; a full `@openai/agents` runtime
(`package.json:52`) reachable behind `x-publish-key` that writes real `content_item` objects through
`handleObjectVerb`. Zero callers (`rg -n "run-publisher-agent" packages/core/{admin,lib,app}` →
empty); its historical caller (`admin/agent-admin.astro` + the ChatKit widget under `src/chatkit/`)
is deleted; `docs/admin-redesign/cms-agent-chat-plan.md:234` still records the disposition as
"Wolf's call".
**Impact:** an authenticated, object-writing endpoint no product surface uses — attack surface and
maintenance debt at once.
**Direction:** retire the function and its shims — **decision needed by Wolf**.

### 29. `verify_article_images` breaks fleet parity and permanently falsifies the stale-export signal

**Category:** parity · **Severity:** high · **Sources:** CI#2, CI#16
**Evidence:** only `netlify/functions/mcp.ts:31` injects `verifyArticleImagesHandler` and only the
root (drlurie) deploy ships `netlify/functions/verify-article-images.ts`, but
`plugin-actions.ts:106` and `admin-plugin-manifest.ts:155` call `ensureMcpSiblings`
(`agent/mcp-siblings.ts:44-50`), which injects only the governed trio. So on drlurie
`/api/plugin/verify_article_images` is refused 403 `tool_not_in_plugin_charter` even though `/mcp`
advertises the tool, and `liveToolsDigest()` computed in the `/mcp` lambda differs from the one
`admin-plugin-manifest.ts:172` computes. Existing tests miss it because they import the shim that
*does* inject (`tests/netlify/plugin-actions-facade.test.ts:5,11`). The `OPTIONAL_HANDLER_TOOLS`
exception is sanctioned (`16-genesis-parity-plan.md:155-158`) but half-built — nothing copies the
function into `sites/*/netlify/functions/`.
**Impact:** "your installed export is stale" is permanently and falsely true on drlurie, and the
fleet's `tools/list` genuinely differs.
**Direction:** make `ensureMcpSiblings` aware of optional handlers, and either ship the function
fleet-wide or exclude it from the digest.

### 30. `autonomyMode` is wired into the approval floor and configured nowhere

**Category:** dead-code · **Severity:** medium · **Sources:** CI#6
**Evidence:** `packages/core/server/lib/agent/registry.ts:13` resolves `activeAutonomyMode()` to
decide whether an `ask` floor can be satisfied without a human, but no
`sites/*/config/publishing-policy.ts` exists and no `policy-bindings.ts` registers a provider, so
every tenant is permanently `'operator-gated'`.
**Impact:** the safe default holds, but the whole "one approval truth" mechanism is dead weight and
has no counterpart to CMS-Agent's own `autonomyMode`.
**Direction:** commit the policy file per tenant (even if it just restates the default) or delete
the resolver — **product call**.

### 31. Per-tenant policy and identity drift on zilberman

**Category:** parity · **Severity:** medium · **Sources:** CI#15
**Evidence:** `sites/zilberman/config/approval-policy.ts:12` pins only
`{product:'require-approval'}` while the other three also pin `editorial_voice:'require-approval'`
with a recorded D1 (2026-07-28) rationale; `sites/zilberman/config/site-identity.ts:20-21` still
carries the placeholder `assetHost:'https://example-assets.netlify.app'`; zilberman is the only
tenant with no explicit `cmsAgentProjectId` (it falls back to the slug, which happens to be right).
**Impact:** a governed type is autonomous on one tenant and gated on three, by omission rather than
by decision.
**Direction:** bring zilberman's config to fleet baseline in one change (law P1/P5).

### 32. `site-config-drift.test.ts` silently omits zilberman

**Category:** parity · **Severity:** medium · **Sources:** DE#1
**Evidence:** `tests/netlify/site-config-drift.test.ts:40-62`'s `TENANTS` array covers only
drlurie, platform and fernwell, though `sites/zilberman/site.config.ts` and
`sites/zilberman/netlify.toml` exist and are structurally identical to the others'.
**Impact:** zilberman's redirect table and site URL can drift from its `netlify.toml` with no test
catching it — the exact class of drift this test exists to prevent.
**Direction:** derive `TENANTS` from the fleet discovery list rather than a literal array.

### 33. Fleet CI and typecheck only ever exercise drlurie

**Category:** build-deploy-mismatch · **Severity:** high · **Sources:** CA#16, DE#2, DE#3, DE#6
**Evidence:** `tsconfig.json:9-12` maps `~/assets/*` → `sites/drlurie/assets/*` and `@site/*` →
`sites/drlurie/*` for the whole monorepo; `check:astro` is a bare `astro check` (`package.json:22`)
which loads the default (drlurie) config; `.github/workflows/actions.yaml:141-143` runs
`check:astro` / `build` / `test` inside a `strategy.matrix.site` loop whose commands never
reference `${{ matrix.site }}`. Root `astro.config.ts` re-exports drlurie's config; the real
per-tenant resolution happens only inside `site-astro-config.ts`'s Vite `resolve.alias` at build
time.
**Impact:** the `fleet` job runs the identical drlurie build N times under N site labels; a type
error confined to `sites/{platform,zilberman,fernwell}/app/**` is invisible to local checks and to
CI; `@site/data/site/site.json` always type-resolves to drlurie's export.
**Direction:** pass `--config sites/<site>/astro.config.ts` in the matrix leg and add per-site
`check:astro:*` scripts (or a tsconfig per site).

### 34. Root `postbuild` pushes drlurie's tracking dimensions regardless of tenant

**Category:** build-deploy-mismatch · **Severity:** low · **Sources:** CA#17, TR#15, DE#6
**Evidence:** `package.json:18` — `"postbuild": "node scripts/tracking-dims-push.mjs --export-root
sites/drlurie/data/site"`. The other three tenants correctly append their own
`--export-root data/site` inside `sites/*/netlify.toml:31`, so deployed behaviour is right per
tenant.
**Impact:** a root `npm run build` executed with another tenant's env (exactly what CI's `build` job
runs) files drlurie's rows under that tenant's `project_id`.
**Direction:** resolve the export root from the active site binding instead of a literal path.

### 35. The CMS-Agent bridge has no `capability_status` family

**Category:** parity · **Severity:** medium · **Sources:** DE#4
**Evidence:** `packages/core/server/lib/agent/cms-agent-client.ts:206-223` implements
`cmsAgentMissingEnvVars`/`isCmsAgentConfigured` in the same single-predicate style as every gated
family, but `CAPABILITY_FAMILIES` (`capability-status.ts:39-50`) has 11 entries and none is
`cms_agent`; `T11_7_ENV_COVERAGE` in `scripts/fleet-capability-probe.mjs` never mentions
`CMS_AGENT_MCP_ENDPOINT`/`CMS_AGENT_MCP_TOKEN`.
**Impact:** a tenant with an expired CMS-Agent bearer is invisible to both `capability_status` and
`fleet:capability`; it surfaces only when admin chat fails closed.
**Direction:** add the family — the predicate already exists.

### 36. Three GitHub APIs, three failure postures, one env contract, and `capability_status` reads green

**Category:** parity · **Severity:** medium · **Sources:** CI#19
**Evidence:** `object-git-committer.ts` uses the **Git Data** API (retry ×4, loud);
`production-release.ts:98-118` uses the **ref** API (silent `undefined` → `commit_unresolved`);
`content-item-index.ts:60` uses the **contents** API (silent `undefined` → "cannot verify" + stale
cache). All three read `GITHUB_CONTENT_TOKEN`/`GITHUB_REPOSITORY`/`GITHUB_BRANCH`, and
`capability-status.ts:117`'s `git_committer` family reports on the env vars, not the call paths.
**Impact:** a token whose scope covers one API but not another fails in three unrelated-looking
ways while the health probe stays green.
**Direction:** give the family one cheap live read per API path (law P3).

### 37. Every validating verb pays a GitHub round-trip for a directory that is empty

**Category:** dead-code · **Severity:** medium · **Sources:** CI#18
**Evidence:** `packages/core/server/lib/object-validation-context.ts:247` calls
`loadContentItemIds()` on create/patch/validate/publish, which lists `src/data/post` over the GitHub
contents API — a directory now holding only `.gitkeep`. With GitHub configured it reliably returns
an empty set (`{exists:false}`), a different answer from the `undefined` "cannot verify" it returns
when GitHub is unreachable. `packages/core/app/content/collections.ts:66-72` still describes that
directory as what "the off-limits legacy publish stack (`publish-article.ts`,
`content-item-index.ts`) writes to and therefore cannot be moved" — naming a file deleted in
2026-07.
**Impact:** pure latency on every write path, plus a stale comment asserting a live constraint.
**Direction:** drop the lookup (or make it lazy) now that no legacy posts remain, and fix the
comment.

### 38. The prebuild image gate scans directories that no longer exist

**Category:** build-deploy-mismatch · **Severity:** medium · **Sources:** CA#6
**Evidence:** `package.json`'s `"build": "node scripts/validate-upload-images.mjs && astro build"`
passes no arguments, so the script uses its defaults `src/assets/images/uploads` and `src/data/post`
(`scripts/validate-upload-images.mjs:9-10`); neither exists (uploads live at
`sites/drlurie/assets/images/uploads`). `collectUploadImageFiles` swallows `ENOENT`, so the gate
reports "0 images checked" and always passes — confirmed in the verified build log. The other three
tenants pass explicit roots (`sites/*/netlify.toml:31`).
**Impact:** the corrupt-image guard is inert on the flagship site.
**Direction:** pass the site's real upload root at the root build too, or delete the gate.

### 39. 139 orphaned committed upload assets

**Category:** stale-generated-files · **Severity:** medium · **Sources:** A#1, CA#7
**Evidence:** `sites/drlurie/assets/images/uploads/**` + `sites/drlurie/assets/documents/uploads/**`
(139 files); no file under `sites/drlurie/data/site/**` references either path. Many directory names
are self-identifying test residue (`smoke-t3-inline-image-only`,
`smoke-t8-hero-collision-guardrail`, …). `object-validate.ts:classifyArticleImageSrc` now **blocks**
`src/assets/…` outright, so nothing can ever reference them again.
**Impact:** committed dead weight from the pipeline retired 2026-07-29, and a trap for any agent
that mistakes them for live media.
**Direction:** delete the two trees in one change once #38 no longer points at them.

### 40. Two published page objects are unreachable because route ownership is not checked across namespaces

**Category:** content-contract-drift · **Severity:** medium · **Sources:** CA#8, CA#9
**Evidence:** (a) `sites/drlurie/data/site/pages/page_skincare_is_not_self_worth.json` has
`route:"/skincare-is-not-self-worth"` while
`articles/req_agent_not_self_worth_20260713_01.json` has the same slug;
`app/utils/object-page-routes.ts:computeObjectPageRoutes` skips the page as `blog_slug` and
`[...objectPage].astro:50` warns at every build. (b) `pages/page_shop.json` has `route:"/shop"`
while `sites/drlurie/site.config.ts` and root `netlify.toml` declare
`{from:'/shop', to:'/solutions/shop-preview', status:301}`, and toml redirects beat static files.
`isRouteTaken` (pages) and `isArticleSlugTaken` (articles) are separate resolvers, neither checks
the other's namespace, and neither knows the redirect table (`reservedPrefixes`,
`[...objectPage].astro:39`, lists only blog bases and `/admin`).
**Impact:** two published, released pages that no reader can reach, one of them with no build
warning at all.
**Direction:** teach one route resolver about all three namespaces (pages, article slugs, redirect
table) and enforce it at write time.

### 41. Absolute host-qualified media URLs are baked into published bodies

**Category:** image-url-assumption · **Severity:** high · **Sources:** CA#10, CA#11
**Evidence:** `articles/req_agent_niacinamide_barrier_after40_20260719_01.json` carries six
`https://drluriescience.netlify.app/img|pdf/...` values (hero `image.src`, three node media, two
`ctaLink`s) — `object-validate.ts:classifyArticleImageSrc` only **warns** on a remote URL. Separately
`https://kugelmedia.netlify.app/drlurieblog/...` appears in
`pages/page_services.json:37`, `pages/page_topics_index.json:23` and twice in
`page_skincare_is_not_self_worth.json`, seeded from
`sites/drlurie/seeds/{page-about,pages-w5,pages-listing}-seed-data.mjs`; that host is declared as
`assetHost` in `sites/drlurie/config/site-identity.ts:36` for "favicon + editor hints", not content
images. `tests/scripts/core-no-site-literals.test.mjs` guards `packages/core` against such literals
but not `sites/*/data` or `sites/*/seeds`.
**Impact:** a domain change silently breaks published content; every such request leaves the CDN
edge and re-enters through DNS; reader images depend on a third Netlify site outside artifact
governance (no sha256, no index, no existence check); and `verify_article_images`'s verbatim
`/img/...` matching is defeated.
**Direction:** normalize to root-relative `/img|/pdf` at write time and extend the no-site-literals
guard to `sites/*/data` and `sites/*/seeds`.

### 42. 10 of 26 published articles carry no taxonomy

**Category:** data-quality · **Severity:** medium · **Sources:** CA#12
**Evidence:** `req_agent_retinol_vs_bakuchiol_sensitive_skin_20260831_01`,
`req_agent_simple_skincare_routine_id_choose_20260802_01`,
`req_agent_snake_oil_skincare_scams_history_20260828_03`, all four `req_conductor_*`,
`req_conductor_two_grams_20260831_02`, `req_fwconcern_obscurefolkingskincare_20240711_01`,
`req_plugin_moisturizer_functions_20260903_01` have no `taxonomy` key;
`contentItemBodySchema.taxonomy` is optional and no criterion requires it at publish.
**Impact:** those articles never appear on any `/category/*` or `/tag/*` page, and
`rankRelatedPosts` (`app/utils/blog.ts:375`) scores them 0 against everything, so they are reachable
only from the library index.
**Direction:** add a publish criterion requiring at least one category — **decision needed** on
whether to backfill the ten.

### 43. Two demo/fixture articles are live in production

**Category:** data-quality · **Severity:** medium · **Sources:** CA#18
**Evidence:** `articles/req_agent_object_model_demo_20260713_01.json` (slug `object-model-demo`) and
`…_variant_20260831_01.json` (`object-model-demo-variant`); the seed header
(`sites/drlurie/seeds/articles-seed-data.mjs:1-22`) calls them "honest DEMONSTRATION content" and
warns "unpublish is not supported yet — once published + released this article is live at
/object-model-demo".
**Impact:** indexable demo URLs on a commercial DTC site.
**Direction:** `object_retire` them (which now exists, unlike when the seed was written) —
**decision needed by Wolf**.

### 44. `redirects.json` opts out of the export contract and a failed read silently truncates it

**Category:** stale-generated-files · **Severity:** high · **Sources:** CA#15
**Evidence:** `packages/core/server/lib/object-retire.ts:171-176` writes it with plain
`JSON.stringify(…, null, 2)` rather than `renderExport`, so it is the only file under `data/site/`
with no `__generated` marker — and `app/content/collections.ts:125` defines every derived export as
`z.object({__generated:…}).passthrough()`, so it would fail if ever globbed. `upsertRedirect`
rewrites the **whole** file from `deps.existingRedirects`, while
`server/lib/site-redirects.ts:loadSiteRedirects` returns `[]` on *any* error by design.
**Impact:** one unreadable store read during a retire silently drops every previously written
content redirect — an invisible, fleet-visible 404 event.
**Direction:** distinguish "empty" from "unreadable" in the loader and refuse to rewrite the file on
the latter.

### 45. The build's article loader degrades silently in the case that matters most

**Category:** build-deploy-mismatch · **Severity:** high · **Sources:** CA#21
**Evidence:** `packages/core/app/utils/blog.ts:164-176` `console.warn`s and **skips** any export
failing `contentItemBodySchema.safeParse` ("Loud skip, never a build failure: a bad export is healed
store-side"), and the slug-collision branch below it does the same.
**Impact:** a schema change that invalidates existing exports removes articles from the live site
with no build failure, no deploy failure, and nothing but a line in a build log.
**Direction:** fail the build (or emit a machine-readable count the release surface checks) when the
skip count is non-zero.

### 46. `checkReaderSafety` blocks the bare words "private" and "strategy" in article prose

**Category:** content-contract-drift · **Severity:** medium · **Sources:** CA#20
**Evidence:** `packages/core/lib/article-content/assert-reader-safe.ts:5,15` — for `content_item`
only, `scanProseWords` is true, so an article containing either word fails validation and cannot
publish. W14 finding F4 already carved plain pages out of this rule for exactly this reason;
articles were left in.
**Impact:** a false blocker on legitimate copy, reported as "Found forbidden internal keyword",
which reads as a data leak rather than a word-choice constraint.
**Direction:** scan for the structural leak (a `private` *key* reaching the projection), not for the
words.

### 47. Two article-content schemas coexist, with duplicated node rules and an undeletable legacy file

**Category:** duplicate-schema · **Severity:** medium · **Sources:** CA#4, DATA_CONTRACTS §9.2-9.4
**Evidence:** `packages/core/schema/article-content-v1.ts` declares `article_body.v1`;
`schema/bodies/content-item-v1.ts` declares `content_item.v1` and imports four sub-schemas from it
(intended) but re-declares `articleNodePublicSchema` (`article-content-v1.ts:137` vs
`content-item-v1.ts:85`), `ARTICLE_NODE_ID_RE` and `FORBIDDEN_NODE_ID_WORDS`
(`content-item-v1.ts:48-51` vs the inline regex+refine at `article-content-v1.ts:164-179`).
`articleBodyV1Schema` itself is used only inside `schema/schema-v1.ts`, which has no live consumers
— except that `schema/object-record-v1.ts:2,208` imports `workflowRecordSchema` from it for the
lock-record shape.
**Impact:** two node schemas that must be kept in step by hand, and a ~770-line legacy file that
cannot be deleted because one line of the current envelope depends on it.
**Direction:** move `workflowLockRecordSchema` into `object-record-v1.ts`, then delete
`schema-v1.ts` and collapse the duplicated node rules to one source.

### 48. The `article_body.v1` → Markdown chain is dead code

**Category:** dead-code · **Severity:** low · **Sources:** CA#2
**Evidence:** `packages/core/lib/article-content/to-markdown.ts` is imported only by
`schema/article-content-helpers.ts` and `lib/contentSourceBody.ts`; `article-content-helpers.ts` has
zero importers and `contentSourceBody.ts` is imported only by `lib/contentSourceImportFormData.ts`,
which also has zero importers. `lib/article-content/input-bank.ts` is likewise orphaned (superseded
by `lib/registry/components/types.ts:38`).
**Impact:** ~400 lines of article-serialization logic — including the `~/assets/...` path
normalization `site-astro-config.ts:182` still cites as a live constraint on the alias table —
cannot execute.
**Direction:** delete the chain and the stale alias-table comment together.

### 49. `taxonomy-enforcement.ts` is orphaned, so no publish-time slug normalization exists

**Category:** dead-code · **Severity:** medium · **Sources:** CA#3
**Evidence:** `packages/core/server/lib/taxonomy-enforcement.ts:enforceTaxonomy` is referenced only
by `tests/netlify/taxonomy-enforcement.test.ts`; its header calls it the "bounded exception to the
publish-article off-limits rule" and `publish-article.ts` no longer exists.
**Impact:** the object publish path has only reference integrity (`object-validate.ts:496`, and only
when a resolver is injected); the documented "stale strings are normalized on every republish"
guarantee is delivered nowhere.
**Direction:** either wire the normalizer into the object publish path or delete it and drop the
guarantee from the docs.

### 50. The only publication-timestamp test covers a schema no production path touches

**Category:** obsolete-docs · **Severity:** medium · **Sources:** CA#5
**Evidence:** `tests/netlify/publication-timestamp-contract.test.ts:23` parses `content_source.v1` +
`publication.v2` and admits its scans "have no subject"; `docs/agents/mcp-article-body-v1.md` is
marked HISTORICAL yet still describes `save_json_blob_publish_by_time` and
`input.publication.published_time` scheduling, both deleted.
**Impact:** the real contract — `__generated.at` == `published_time` == `receipt.exported_at` — is
untested, while a passing test suggests otherwise.
**Direction:** rewrite the test against the object publish path; mark the doc superseded with a
pointer to `CONTENT_ARCHITECTURE.md` §6.

### 51. The MCP tool surface is split across three files by size, not by domain

**Category:** ambiguous-canonical-source · **Severity:** low · **Sources:** CI#1
**Evidence:** `mcp-tool-definitions.ts` (49 tools), `mcp-tool-definitions-2.ts` (32) and
`mcp-tool-definitions-membership.ts` (16), concatenated verbatim at
`packages/core/server/functions/mcp.ts:506-511`. `deploy_status` sits in part 1 and `object_publish`
in part 2; only the membership split is principled (it is the one filtered per-principal).
**Impact:** the file name carries no meaning, so new tools land wherever, and the 97-tool count test
is the only thing holding the set together.
**Direction:** split by domain or merge and let the count test stand alone.

### 52. The capability-family count is stated three different ways

**Category:** obsolete-docs · **Severity:** low · **Sources:** CI#14
**Evidence:** `packages/core/server/lib/capability-status.ts:39` says "ten gated families" above an
array of eleven (`mail` was appended in W19 T19.7 without updating the sentence);
`docs/cms-architecture/FLEET-STATUS.md:103` says nine.
**Impact:** three numbers for one list, in the document operators use to judge fleet readiness.
**Direction:** derive the count from `CAPABILITY_FAMILIES.length` wherever it is printed.

### 53. FLEET-STATUS's capability matrix has never actually been run

**Category:** parity · **Severity:** medium · **Sources:** CI#20
**Evidence:** `docs/cms-architecture/FLEET-STATUS.md:3` — "_NOT a live capability probe; the full
`npm run fleet:capability` run described in the 'Tenant capability matrix' section below still has
not been done_"; law P3 (`16-genesis-parity-plan.md:149-153`) says capability truth is live, not
repo.
**Impact:** the fleet's headline parity document does not satisfy the fleet's own law, and its
"fixed"/"live" claims are unproven.
**Direction:** run `npm run fleet:capability --all` with real tokens and paste the output, or label
every row unverified.

### 54. `CLAUDE.md` contradicts itself and cites deleted paths

**Category:** obsolete-docs · **Severity:** medium · **Sources:** A#2, A#3, CI#11
**Evidence:** `CLAUDE.md:344` records the off-limits rule as "**VOID since 2026-07-29** …
`publish-article.ts`, `admin-workflow-lock.ts` … are gone"; `CLAUDE.md:406-408` still asserts "The
publish-safety stack (`publish-article.ts`, `admin-workflow-lock.ts`) is untouched and off-limits as
always" — neither file exists. `CLAUDE.md:369-372` names `src/components/admin-ui/`,
`netlify/lib/object-validate.ts`, `netlify/lib/roles.ts` and `netlify/lib/request-roles.js`; the
real locations are `packages/core/admin/*.tsx` and
`packages/core/server/lib/{object-validate,roles,request-roles}.ts`. `AGENTS.md:144-148` has only
the VOID form.
**Impact:** CLAUDE.md is a primary instruction file for every agent that touches this repo; an agent
trusting it looks for files that do not exist.
**Direction:** delete the superseded sections and repoint the paths in one pass.
**Note (working tree, same 2026-09-05 pass):** the root `CLAUDE.md` has since been archived to
`docs/history/CLAUDE-2026-09-05.md`. The line citations above are to the file as it stood at commit
`6789644`; the contradictions travel with the archived copy, so this entry closes only when a
replacement instruction file exists and is correct.

### 55. Agent instruction files carry superseded operational rules

**Category:** obsolete-docs · **Severity:** medium · **Sources:** CI#12, CI#13, CI#17
**Evidence:** (a) `CLAUDE.md:366` forbids writing the repo's **pre-rename** `owner/name` slug into
committed content "because that is `GITHUB_REPOSITORY`'s value" — the repo has since been renamed, and FLEET-STATUS is
full of full PR links against the current name; what actually keeps builds green is
`SECRETS_SCAN_OMIT_KEYS = "GITHUB_REPOSITORY"` in all four `netlify.toml`s. (b) `AGENTS.md:176` pins
the connector name `Dr_Lurie_MCP_Server`, true only for drlurie
(`sites/drlurie/config/site-identity.ts:34`; the others are `Platform_`/`Zilberman_`/`Fernwell_`).
(c) `CLAUDE.md:349-354` describes delivery as a zip with a `land.command` because "access does not
exist from the sandbox" — this wave's agents had direct clone and connector access.
**Impact:** three rules that read as current fleet law while describing a renamed repo, one tenant,
and a superseded workflow.
**Direction:** restate (a) against the real mitigation, label (b) as a drlurie example, and delete
or re-scope (c).
**Note (working tree, same 2026-09-05 pass):** `CLAUDE.md` and `AGENTS.md` have since been archived
to `docs/history/{CLAUDE,AGENTS}-2026-09-05.md`; citations above are to commit `6789644`. Rule (a)
still needs restating wherever the secrets-scanner guidance lands next — the `SECRETS_SCAN_OMIT_KEYS`
mitigation in the four `netlify.toml`s is unaffected either way.

### 56. `README.md` and `package.json` still identify the repo as AstroWind and document a retired publish flow

**Category:** obsolete-docs · **Severity:** medium · **Sources:** A#6, A (stale-docs table), DE#5
**Evidence:** `README.md:6-33` is the unmodified upstream AstroWind marketing README, and
`README.md:150-217` documents a `netlify/functions/publish-article.ts` Clerk-authenticated publish
flow driven by `NETLIFY_PUBLISH_ENDPOINT`/`CLERK_SECRET_KEY`/`PUBLIC_CLERK_PUBLISHABLE_KEY` — none
of which exist (`tests/netlify/publisher-repoint.test.ts:169` asserts the env is unused).
`README.md:153` claims `@netlify/blobs` is an `optionalDependency`; it is a normal dependency and
`package.json` has no `optionalDependencies` key. The one hand-added banner cites
`src/components/common/Metadata.astro`, which moved to `packages/core/app/components/common/`.
`package.json:2` / `:4` still carry the template's name (`@onwidget/astrowind`) and description.
**Impact:** a maintainer or agent reading only the README builds against a publish mechanism that
cannot work; tooling that reads package metadata mis-identifies the project.
**Direction:** replace the README with a pointer to `docs/ARCHITECTURE.md` + the companion docs, and
rename the package.
**Note (working tree, same 2026-09-05 pass):** the template README has since been archived to
`docs/history/README-astrowind-template.md`; citations above are to commit `6789644`. The
`package.json` name/description half of this entry is untouched and still open.

### 57. Three-way Node version disagreement

**Category:** build-deploy-mismatch · **Severity:** low · **Sources:** A#5, DE#8
**Evidence:** `.nvmrc` pins `24`; `package.json engines.node` allows `>=20.9.0`; every
`netlify.toml` sets `NODE_VERSION = "20"`; `.github/workflows/actions.yaml`'s `build` matrix is
`[20, 22, 24]` while `check`/`discover-fleet`/`fleet`/`fleet-build-diff` pin `22`.
**Impact:** a contributor running `nvm use` is two majors ahead of production. CI does cover 20 in
the `build` job, so this is a DX rough edge, not a proven live bug.
**Direction:** decide the intended local version and make `.nvmrc` agree with `NODE_VERSION`.

### 58. The `admin-traffic` compatibility shim is still deployed on all four tenants

**Category:** dead-code · **Severity:** low · **Sources:** TR#11, DE#7
**Evidence:** `netlify/functions/admin-traffic.ts` (a one-line re-export of `admin-analytics.ts`)
plus `sites/*/netlify/functions/admin-traffic.ts`; the file itself says "Remove this file once the
old path has had a full deploy cycle with no traffic" (T21.9b). The renaming PR (#688) is this
clone's HEAD, so the shim is at most one release old.
**Impact:** none today — noted so the next cleanup pass does not miss it.
**Direction:** delete all four copies one deploy cycle after #688.

### 59. Inherited AstroWind dead code: 19 widgets reachable only from 3 orphaned demo pages

**Category:** dead-code · **Severity:** low · **Sources:** A#7, A#9, A (classification table)
**Evidence:** `sites/drlurie/app/pages/homes/{personal,mobile-app,startup}.astro` have zero
references (no nav link, no route table entry) and are the sole importers of `Announcement`,
`BlogLatestPosts`, `Brands`, `CallToAction`, `Contact`, `Content`, `FAQs`, `Features`, `Features2`,
`Features3`, `Hero`, `Hero2`, `HeroText`, `Note`, `Pricing`, `Stats`, `Steps`, `Steps2`,
`Testimonials` under
`packages/core/app/components/widgets/` — i.e. every widget except `Header`, `Footer` (both reached
through `layouts/PageLayout.astro` and `components/cms/PageObjectRenderer.astro`) and
`BlogHighlightedPosts` (reached through `components/blog/RelatedPosts.astro`) — plus transitively `ui/ItemGrid2.astro`, `ui/Timeline.astro`
and `ui/DListItem.astro`. Also dead: `packages/core/app/layouts/MarkdownLayout.astro` (zero
importers), `packages/core/app/utils/directories.ts` (zero importers), and
`sites/drlurie/public/decapcms/{index.html,config.yml}` (zero code references; its `config.yml`
points at `src/content/post`, a path that never existed here).
**Impact:** ~25 files of carry weight that read as candidate building blocks for new pages when they
are pre-CMS template artifacts.
**Direction:** delete in one clearly-labelled change; the current section renderers
(`packages/core/components/sections/*.astro`) are the real building blocks.

### 60. Unreferenced alternate-deploy configs

**Category:** dead-code · **Severity:** low · **Sources:** DE#9, A (inherited inventory)
**Evidence:** `Dockerfile`, `docker-compose.yml` (container literally named `astrowind`),
`nginx/nginx.conf`, `vercel.json`, `sandbox.config.json`, `.stackblitzrc`,
`.vscode/astrowind/config-schema.json`, `vscode.tailwind.json` — none appear in
`.github/workflows/actions.yaml`, any `scripts/**` file or any `netlify.toml`.
**Impact:** the Docker image's static-nginx model has no equivalent for the Netlify Functions this
system needs (`/mcp`, `/admin/*`, tracking ingest, Blobs), so building it would produce a
non-functional deployment that looks like a supported target.
**Direction:** delete, or add a one-line "not a deployment target" header to each.

### 61. `Social/` exists twice and the root copy is dead weight

**Category:** dead-code · **Severity:** low · **Sources:** CA#19
**Evidence:** `Social/{og-default,og-home}.jpg` (3.5 MB) sit at the repo root, but `publicDir` is
`sites/drlurie/public` (`packages/core/app/site-astro-config.ts:83`), which has its own `Social/`.
**Impact:** the root copy is never served — a trap for anyone updating an OG image.
**Direction:** delete the root copy.

### 62. Fleet vocabulary lists `tracking_attribute` as a governed object type

**Category:** obsolete-docs · **Severity:** low · **Sources:** A#8
**Evidence:** `objectTypes` (`packages/core/schema/object-record-v1.ts:7-20`) has **13** entries and
does not include `tracking_attribute`; it is the shared per-object block spread into governed bodies
(`packages/core/schema/bodies/tracking-attribute-v1.ts:1-15,48`), written only by the `set_tracking`
op.
**Impact:** an agent following the vocabulary looks for an object type that cannot exist, and may
try `object_create` on it.
**Direction:** already corrected in `DATA_CONTRACTS.md` §2 and `GLOSSARY.md`; propagate to any
briefing text that still lists it.

## Summary table

Sorted by severity, then by id.

| id | Severity | Category | Title | Source |
|---|---|---|---|---|
| 8 | blocking | tracking-id-instability | The purchase→event join key can never match | TR#1 |
| 9 | blocking | tracking-schema | `commerce_events.kind` is never `'purchase'` | TR#2 |
| 7 | high | seo | `SITE_NOT_YET_LIVE` forces `noindex` fleet-wide | CA#1 |
| 10 | high | tracking-id-instability | `buy_click` never carries `commerce_event_id` | TR#8 |
| 11 | high | tracking-schema | `node_strategy.strategy`/`.intent` NULL for all new content | TR#3 |
| 14 | high | privacy | Platform tenant collects with no `providers.own` | TR#6 |
| 15 | high | privacy | Tracking retention documented, never enforced | TR#10 |
| 16 | high | privacy | CSP-drift gate blind to drlurie (and 2 tenants absent) | TR#5 |
| 22 | high | publishing-race | Publish/release unordered; release deploys branch HEAD | CA#13, CI#3 |
| 25 | high | security | Shared-token callers bypass the write rate limit | CI#7 |
| 28 | high | security | `run-publisher-agent` deployed fleet-wide, no caller | A#4, CI#10 |
| 29 | high | parity | `verify_article_images` breaks parity + falsifies the digest | CI#2, CI#16 |
| 33 | high | build-deploy-mismatch | Fleet CI and typecheck only ever exercise drlurie | CA#16, DE#2/3/6 |
| 41 | high | image-url-assumption | Absolute host-qualified media URLs in published bodies | CA#10, CA#11 |
| 44 | high | stale-generated-files | `redirects.json` opts out of the export contract; silent truncation | CA#15 |
| 45 | high | build-deploy-mismatch | Article loader silently skips invalid exports | CA#21 |
| 12 | medium | tracking-schema | `object_version.surface`/`.attribution` dropped by the sink | TR#4 |
| 13 | medium | data-quality | Publish attribution inconsistent between same-day exports | CA#14 |
| 17 | medium | privacy | Admin paths excluded from own feed but not Netlify feed | TR#12 |
| 18 | medium | tracking-schema | The committed tracking fixture is schema-invalid | TR#9 |
| 19 | medium | tracking-schema | Experiments subsystem complete and structurally inert | TR#14 |
| 23 | medium | publishing-race | Two commit streams race one ref; comment names a dead hazard | CI#4 |
| 24 | medium | build-deploy-mismatch | Receipt proves export not deploy; one boolean, two situations | CI#5 |
| 26 | medium | security | `admin-get-blob-pdf` uses `===` on the publish key | CI#9 |
| 27 | medium | security | Agent-key revocation up to 60 s late | CI#8 |
| 30 | medium | dead-code | `autonomyMode` wired in, configured nowhere | CI#6 |
| 31 | medium | parity | Per-tenant policy/identity drift on zilberman | CI#15 |
| 32 | medium | parity | `site-config-drift.test.ts` omits zilberman | DE#1 |
| 35 | medium | parity | CMS-Agent bridge has no `capability_status` family | DE#4 |
| 36 | medium | parity | Three GitHub APIs, three postures, probe reads green | CI#19 |
| 37 | medium | dead-code | Every validating verb round-trips GitHub for an empty dir | CI#18 |
| 38 | medium | build-deploy-mismatch | Prebuild image gate scans directories that no longer exist | CA#6 |
| 39 | medium | stale-generated-files | 139 orphaned committed upload assets | A#1, CA#7 |
| 40 | medium | content-contract-drift | Two published pages unreachable; route ownership unchecked | CA#8, CA#9 |
| 42 | medium | data-quality | 10 of 26 published articles carry no taxonomy | CA#12 |
| 43 | medium | data-quality | Two demo articles live in production | CA#18 |
| 46 | medium | content-contract-drift | Reader-safety blocks the words "private"/"strategy" | CA#20 |
| 47 | medium | duplicate-schema | Two article schemas; duplicated node rules; undeletable legacy | CA#4 |
| 49 | medium | dead-code | `taxonomy-enforcement.ts` orphaned; no slug normalization | CA#3 |
| 50 | medium | obsolete-docs | Publication-timestamp test covers a dead schema | CA#5 |
| 53 | medium | parity | FLEET-STATUS capability matrix never run (breaks law P3) | CI#20 |
| 54 | medium | obsolete-docs | `CLAUDE.md` self-contradicts and cites deleted paths | A#2/3, CI#11 |
| 55 | medium | obsolete-docs | Agent instruction files carry superseded operational rules | CI#12/13/17 |
| 56 | medium | obsolete-docs | README + `package.json` still describe AstroWind and a retired flow | A#6, DE#5 |
| 20 | low | dead-code | `data-cms-buy-product` classified, never emitted | TR#7 |
| 21 | low | security | `/stats` called with a write bearer it ignores | TR#13 |
| 34 | low | build-deploy-mismatch | Root `postbuild` pushes drlurie's dims regardless of tenant | CA#17, TR#15, DE#6 |
| 48 | low | dead-code | `article_body.v1` → Markdown chain is dead code | CA#2 |
| 51 | low | ambiguous-canonical-source | Tool surface split across three files by size | CI#1 |
| 52 | low | obsolete-docs | Capability-family count stated three ways | CI#14 |
| 57 | low | build-deploy-mismatch | Three-way Node version disagreement | A#5, DE#8 |
| 58 | low | dead-code | `admin-traffic` shim still deployed on four tenants | TR#11, DE#7 |
| 59 | low | dead-code | 18 inherited widgets + 3 orphaned demo pages + 4 more dead files | A#7, A#9 |
| 60 | low | dead-code | Unreferenced Docker/nginx/Vercel/StackBlitz configs | DE#9 |
| 61 | low | dead-code | `Social/` exists twice; the root copy is dead | CA#19 |
| 62 | low | obsolete-docs | Vocabulary lists `tracking_attribute` as an object type | A#8 |
