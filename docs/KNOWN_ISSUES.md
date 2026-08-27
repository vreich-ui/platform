# Known Issues — deferred / to be addressed later

This file tracks issues that were identified during work on the platform but
deliberately NOT fixed in the same change — either because the fix is a
larger design decision than the triggering bug warranted, or because it
requires a human call this repo's code cannot make on its own. Each entry
should stay here until it is either fixed (link the PR that closes it) or
explicitly decided against (note the decision and who made it).

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
