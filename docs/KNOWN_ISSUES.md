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
  matters more as the fleet's per-site object counts grow.
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
