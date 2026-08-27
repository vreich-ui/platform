# Admin Architecture Audit (T0.1)

Repo: the platform monorepo, snapshot at commit `a21f05f` ("Merge pull request
#617, branch t15-one-approval-truth"). Every claim below carries
`path:line` against that snapshot. Read-only audit — no source file was
modified to produce this document.

Scope note: `packages/core/` is fleet law (CLAUDE.md:13-20); `sites/drlurie`
is the worked example and the one this audit treats as canonical for
site-level facts (its `netlify/functions/` lives at the repo root, not under
`sites/drlurie/`). Per-site divergences are called out explicitly where found
(§11, §7).

---

## 1. Route inventory

All routes are under `packages/core/app/routes/admin/`. Every island entry
`app/admin/X.ts` is the same four-line shim (`import '@site/config/policy-bindings'; export { default } from '@core/admin/X';` — the W11/T11.5 site-binding seam) unless noted.

| Route | `.astro` | Island entry | Component | Purpose | Auth/role gate |
|---|---|---|---|---|---|
| `/admin` | `app/routes/admin/index.astro:1` | `app/admin/AdminHome.ts` | `admin/AdminHome.tsx` | Editorial home: object inventory + release status + in-flight chat badges | `AdminLayout` client gate (signed-in + any role) |
| `/admin/requests` | `app/routes/admin/requests.astro:1` | `app/admin/RequestsWorkspace.ts` | `admin/RequestsWorkspace.tsx` | Editorial request list (W19) | `AdminLayout` gate; server wall requires `admin` role (`admin-requests.ts`) |
| `/admin/requests/[requestId]` | `app/routes/admin/requests/[requestId].astro:1` | same island | same component, detail mode | One request, deep-linkable; `getStaticPaths` returns one placeholder `__request`, netlify.toml rewrites `/admin/requests/:id → /admin/requests/__request` (`netlify.toml:163-169`) | same |
| `/admin/content` | `app/routes/admin/content/index.astro:1` | `app/admin/ContentLibrary.ts` | `admin/ContentLibrary.tsx` | Object browse/library | `AdminLayout` gate |
| `/admin/content/[objectId]` | `app/routes/admin/content/[objectId].astro:1` | `app/admin/ObjectWorkspace.ts` | `admin/ObjectWorkspace.tsx` | Single-object chat-first workspace (checkout/edit/patch/review/publish) | `AdminLayout` gate; placeholder `__workspace`, rewrite at `netlify.toml:151-160` |
| `/admin/templates` | `app/routes/admin/templates.astro:1` | `app/admin/AdminSectionPage.ts` | `AdminSectionPage.tsx` (`section="templates"`) → `admin/TemplatesWorkspace.tsx` | Templates/section-templates/themes workspace | `AdminLayout` gate |
| `/admin/studio` | `app/routes/admin/studio.astro:1` | same island | same, `section="templates"` | Legacy alias — "Studio now opens the editor-facing Templates experience" (comment, `studio.astro:2`) | `AdminLayout` gate |
| `/admin/media` | `app/routes/admin/media.astro:1` | `AdminSectionPage.ts` | `AdminSectionPage.tsx` (`section="media"`) → `admin/MediaWorkspace.tsx` | Media asset library | `AdminLayout` gate |
| `/admin/release` | `app/routes/admin/release.astro:1` | `AdminSectionPage.ts` | `AdminSectionPage.tsx` (`section="release"`) → `admin/ReleaseWorkspace.tsx` | Release-to-production dashboard | `AdminLayout` gate |
| `/admin/agents` | `app/routes/admin/agents.astro:1` | `app/admin/AgentsHub.ts` | `admin/AgentsHub.tsx` | Free-form cross-object chat + agent roster/assignment | `AdminLayout` gate; server wall is `admin-agent-chat.ts` identity + admin allowlist. Nav-visible only under the `ownerOnly` Settings group (`AdminShell.tsx:85-94`) — **reachable by any admin via direct URL**, just not linked for non-owners |
| `/admin/settings/visual-identity` | `app/routes/admin/settings/visual-identity.astro:1` | `app/admin/VisualIdentityWorkspace.ts` | `admin/VisualIdentityWorkspace.tsx` | Brand/theme editing | `AdminLayout` gate; nav `ownerOnly` |
| `/admin/settings/guardrails` | `app/routes/admin/settings/guardrails.astro:1` | `app/admin/GovernancePage.ts` | `admin/GovernancePage.tsx` | Adjustable guardrails — "Owner-write / Admin-read" (comment, l.2) | `AdminLayout` gate; nav `ownerOnly`; read/write split enforced in `admin-governance.ts` |
| `/admin/settings/admins` | `app/routes/admin/settings/admins.astro:1` | `app/admin/AdminUsers.ts` | `admin/AdminUsers.tsx` | Member/invitation management (W18) | `AdminLayout` gate; nav `ownerOnly`; server wall Owner-tier for writes (`admin-users.ts`) |
| `/admin/profile` | `app/routes/admin/profile.astro:1` | `app/admin/ProfilePage.ts` | `admin/ProfilePage.tsx` | Self-service profile | `AdminLayout` gate; nav `ownerOnly` group (profile itself has no extra role) |
| `/admin/maintenance` | `app/routes/admin/maintenance.astro:1` | `app/admin/MaintenancePage.ts` | `admin/MaintenancePage.tsx` | Owner-only blob browser/diagnostics/wipe | `AdminLayout` gate + **Owner-only server-side** (`admin-blob-manager.ts`/`admin-blob-store-diagnostics.ts`) |
| `/admin/kit` | `app/routes/admin/kit.astro:1` | `app/admin/KitGallery.ts` | `admin/KitGallery.tsx` | Component-kit gallery (light/dark) | `AdminLayout` gate; nav `ownerOnly` |
| `/admin/welcome` | `app/routes/admin/welcome.astro:1` | `app/admin/Welcome.ts` | `admin/Welcome.tsx` | One-time onboarding (W18 T18.5): confirm display name, role tour | `AdminLayout` gate (needs session + role); AdminShell's welcome gate redirects incomplete members here, never away |
| `/admin/accept` | `app/routes/admin/accept.astro:1` | `app/admin/AcceptInvite.ts` | `admin/AcceptInvite.tsx` | Lands every Netlify Identity e-mail token (`#invite_token`, `#recovery_token`, `#confirmation_token`, `#email_change_token`) | **Deliberately NOT on `AdminLayout`** — no session exists yet (comment, l.6-8). `Layout.astro` (public), noindex |
| `/admin/authorize` | `app/routes/admin/authorize.astro:1` | `app/admin/OAuthConsent.ts` | `admin/OAuthConsent.tsx` | MCP-client OAuth consent screen | `AdminLayout` gate for the Identity check; real authority check is server-side in `/oauth/consent` (comment, l.3-4) |

`AdminLayout.astro` (`app/layouts/AdminLayout.astro:1-226`) is the one gate
implementation: three states — signed-out / signed-in-not-admin / signed-in
admin (shell + `<slot/>`) — driven client-side by
`fetchAdminAccessState`/`admin-access-client.ts:29-66` calling
`GET /.netlify/functions/admin-auth-state`
(`server/functions/admin-auth-state.ts:1-79`). **The client gate is cosmetic
only** — every mutating call re-authenticates and re-resolves roles
server-side per function (`getAdminStateFromEvent` / `resolveRolesForPrincipalAsync`), so a route with no extra gate in the table above is not
actually unprotected, only ungated *in the browser chrome*.

---

## 2. Nav & IA

`packages/core/lib/admin/admin-navigation.ts:1-9` is tiny — it exports exactly
one helper, `settingsNavigationLabel(brandName)`, which renders `"Settings ·
{brand}"` or `"Settings"`. **It does not build the nav tree.** The nav tree
itself is `AdminShell.tsx:70-95`'s `NAV` constant, a hardcoded, non-dynamic
array (no per-tenant, per-role, or per-feature-flag construction beyond the
`ownerOnly` group filter):

```
NAV = [
  { items: [Editorial(/admin), Requests(/admin/requests), Templates(/admin/templates),
             Media(/admin/media), Content(/admin/content), Release(/admin/release)] },
  { label: 'Settings', ownerOnly: true,
    items: [Visual identity, Guardrails, Admins, Profile, Maintenance,
             Component kit, Agents] }
]
```
(`AdminShell.tsx:73-95`). `NavList` filters `NAV.filter(g => !g.ownerOnly ||
owner)` (`AdminShell.tsx:115`) — this is a **display-only** filter; it does
not prevent direct navigation (see §1, `/admin/agents`). The group label
`"Settings"` is swapped for `settingsNavigationLabel(brandName)` at render
time (`AdminShell.tsx:122`) — the only place `admin-navigation.ts` is
consumed (`AdminShell.tsx:49`). `isActive` (`AdminShell.tsx:99-102`) does
prefix matching for the active-link highlight. The Cmd-K command palette
(`AdminShell.tsx:314-329`) is *derived from the same `NAV` array* plus one
hardcoded `"Release to production"` action — there is no separate command
registry.

---

## 3. Data flow per page

No page uses a shared query layer (see §4). Every page is: fetch on mount via
a dedicated `lib/admin/*-client.ts`, hold in local `useState`, and either
never refetch, refetch on an interval, or refetch via a self-scheduling
`setTimeout` poll loop.

| Page | Client(s) | Endpoint(s) | Lifecycle | Batched? | Caching |
|---|---|---|---|---|---|
| Editorial (`AdminHome.tsx:128-140`) | `library-client.ts` (`fetchInventoryRows`), `release-client.ts` (`fetchReleaseOverview`), `chat-client.ts` (`listChats`) | `admin-object.ts` (`inventory`), `admin-release-state.ts`, `admin-agent-chat.ts` (`list_chats`) | `useEffect` on mount only, `Promise.all` | Yes — 3 calls batched via `Promise.all` | `library-client.ts` in-memory + `localStorage`-persisted TTL cache, invalidated on mutation/logout (§4) |
| Requests (`RequestsWorkspace.tsx`) | `requests-client.ts` (`listRequests`) | `admin-requests.ts` | mount + refetch on filter change (URL param sync, l.299-337); row detail embeds `RequestActivity` which self-polls (below) | No explicit batching needed (one call) | None — `Cache-Control: no-store` server-side (`admin-request-activity.ts:33`) |
| Requests detail / any chat with a bound request (`RequestActivity.tsx:368-450`) | `requests-client.ts` (`getRequestActivity`, `decideRunPublish`) | `admin-request-activity.ts` | Self-scheduling `setTimeout` chain keyed by a **generation counter** (not a shared `live` flag — comment l.382-388 explicitly documents a prior bug from that pattern); cadence from server-decided `retry_ms` / `activityPollIntervalFor` (`requests-client.ts:296-303`: running/queued 3s, blocked/paused 15s, else stop) | No | `Cache-Control: no-store`; read-only by construction per the endpoint's own docstring (`admin-request-activity.ts:1-13`) except the `action` branch, which writes (see §6) |
| Agents (`AgentsHub.tsx`) | `chat-client.ts` (`createFreeChat`, `useChat` hook), `users-client.ts` (`fetchMe`) | `admin-agent-chat.ts` | `useChat` (`chat.tsx:90-230`) polls at `pollIntervalFor(status)` (`chat-client.ts:203-208`: queued/running 1.2s, awaiting_* 2s, else 5s) | No | None — chat state is append-only event log fetched via `since_seq` |
| Content/Objects — library (`ContentLibrary.tsx:143-190`) | `library-client.ts`, `release-client.ts` | `admin-object.ts` (`inventory`), `admin-release-state.ts` | mount only | Two sequential `useEffect`s (not `Promise.all`) | `library-client.ts` TTL cache |
| Content/Objects — single object (`ObjectWorkspace.tsx`) | `lib/edit-mode/verbs-client.ts` (`EditSession`, `getObjectRecord`, `callObjectVerb`) | `admin-object.ts` | mount + explicit user actions (checkout/patch/publish/etc., all dynamic `import()`ed per call site) | No | None — every `EditSession` call re-fetches; lock state cached only in the `LockManager` instance (`lib/admin/lock-manager.ts`) |
| Media (`MediaWorkspace.tsx:14-57`) | `editorial-assets-client.ts` (`fetchEditorialAssets`) | `admin-editorial-assets.ts` | mount only | Single call | None found |
| Templates (`TemplatesWorkspace.tsx:110-202`) | `studio-client.ts` (`fetchStudioData`), `editorial-assets-client.ts` | `admin-object.ts` (studio-scoped read), `admin-editorial-assets.ts` | mount, `Promise.all` (l.190) | Yes | None found |
| Release (`ReleaseWorkspace.tsx:151-174`) | `release-client.ts` (`fetchReleaseOverview`), `library-client.ts` (`fetchInventoryRows({force:true})`) | `admin-release-state.ts`, `admin-object.ts` | mount **+ `window.setInterval(..., 6000)`** (l.174) — the one page with a hard polling interval | `Promise.all` (l.151-152) | Bypasses the inventory cache with `force: true` |

---

## 4. State management

- **No state-management library.** `package.json` and `packages/core/package.json`
  were checked for TanStack Query / React Query / SWR / Zustand / Jotai /
  Redux / Radix UI / shadcn: none present (`package.json` deps list has only
  `react`/`react-dom` 18.3.1 as UI runtime deps; `packages/core/package.json`
  has just `react-markdown`+`remark-gfm`). The one `radix3` hit in
  `package-lock.json` is an unrelated transitive router-tree package, not
  Radix UI.
- **Pattern:** plain React `useState`/`useEffect`/`useCallback`/`useRef`, one
  bespoke hook per concern (`useChat` in `chat.tsx:90`, `useCurrentUser` in
  `lib/admin/use-current-user.ts`, `useRunApprovalMode`/`useTestMode` in
  `RunApprovalControls.tsx`, `useRequestNotifications` in
  `useRequestNotifications.tsx`). No context providers for server data;
  `ToastProvider` (`overlays.tsx`) is the only React Context in the admin
  tree, and it is UI-only (toasts), not a data cache.
- **Bespoke query cache:** `lib/admin/library-client.ts:1-150` hand-rolls
  exactly what a query library would give for free: an in-memory + `localStorage`
  TTL cache (`INVENTORY_CACHE_TTL_MS`), in-flight de-dupe (single shared
  promise), a `force` escape hatch, and manual invalidation on every mutating
  verb call site plus on `goTrueClient.logout()` (comment l.20-22). This is
  the one place in the codebase doing cache-with-invalidation; every other
  client (`requests-client.ts`, `chat-client.ts`, `editorial-assets-client.ts`,
  `studio-client.ts`, `release-client.ts`) refetches from a plain `fetch`
  wrapper with no cache layer.
- **Polling is hand-written everywhere it exists**: `setInterval` in
  `ReleaseWorkspace.tsx:174`; self-rescheduling `setTimeout` chains in
  `useChat` (`chat.tsx`) and `RequestActivity.tsx:414-431`, both using a
  **generation counter** ref (not a boolean `live` flag) to prevent a stale
  in-flight fetch from a torn-down chain writing state — documented as a
  fix for a real prior bug (`RequestActivity.tsx:382-388`).

---

## 5. State machines

### 5.1 Object review state machine (submit → decide → discard)
`schema/object-record-v1.ts:42-77` (`reviewStateSchema`) + logic in
`server/lib/review-state.ts:1-412`.

- States: `review.state ∈ {'open','changes_requested','approved'}`
  (`object-record-v1.ts:43`). No `'none'` on the wire — absent `review` means
  "never submitted."
- Transitions, all pure functions taking `(record, input) → ReviewOpResult`,
  wired only from `object-verbs.ts` (no other writer):
  - `submitReview` (`review-state.ts:122-153`) → `state:'open'`, bumps
    `version` only, never `content_revision` (invariant stated l.4-9).
  - `decideReview` (`review-state.ts:186-232`) → `approve` sets `'approved'`
    and pins `content_revision` at decision time (the approval-currency
    pin, M-6); `request_changes` sets `'changes_requested'`. Human callers
    need `canDecideReview(actorRoles)` (`server/lib/roles.ts`); **agent
    principals are allowed with no role check** (comment l.163-176 — a
    detached "approval agent" can self-approve over the shared publish-key
    MCP surface; a `TODO(editor-agents)` on l.176-179 flags this as an
    intentional-but-not-yet-tightened gap).
  - `discardProposal` (`review-state.ts:327-412`) → compensating inverse
    write, bumps `content_revision` (it is a real body write), with a
    "blind revert refused" guard (`409 discard_conflict`) if intervening
    accepted ops touched the same field.
  - `effectiveApproval(record)` (`review-state.ts:295-311`) is the ONE
    derivation the publish gate reads: `approved_current` only if the last
    approval's pinned `content_revision` equals the record's current one,
    else `approved_stale`.
- Who writes it: only `object-verbs.ts` cases `submit_review` (l.1818),
  `review_decide` (l.1838), `discard` (l.1858) — reachable from both
  `admin-object.ts` (human) and `object-store.ts` (agent/publish-key), i.e.
  the same core for both principals.

### 5.2 Presentation-layer editorial lifecycle (draft/approved/published/live)
`lib/admin/editorial-state.ts:1-142`. This is **not** the wire state machine
above — it is a derived, read-only presentation label computed from
`{review, publication}` plus the release/deploy view:
`getEditorialObjectState` (`editorial-state.ts:79-98`) → one of
`'draft' | 'approved' | 'published' | 'live'`
(`EditorialObjectState`, l.1). `'live'` requires the release view to confirm
the exact commit is in a **server-confirmed production deploy**
(`deployState.production_confirmed`), never inferred client-side — comment
l.79-81: "it never writes status and never treats a merely-ready build as
live." `resolveReleaseAwareLifecycle` (l.130-135) fails closed to `'unknown'`
when the release row is missing rather than fabricating a guess (a fixed
defect, per comment l.117-128).

### 5.3 Object lifecycle status (retire)
`status` is a top-level `ObjectRecord` field (default implicit/absent, or
`'archived'`). `server/lib/object-retire.ts:1-254`: `retire` sets
`record.status = 'archived'` (l.203-205) and — distinct from "delete" —
**removes the git export in the same commit** and writes a 301 redirect
record (l.17-23, l.175). `publish` already refuses an archived record
(comment l.7-8). There is no `'checked_out'` status field; checkout state
lives entirely in `record.lock` (`schema/schema-v1.ts:35-39`:
`{token, holder, expires_at, ...}`), enforced by `object-lock.ts` and
mirrored by `lib/admin/lock-manager.ts` client-side.

### 5.4 Chat/run state model
`ChatStatus` (`lib/admin/chat-client.ts:11-18`):
`'idle'|'queued'|'running'|'awaiting_approval'|'awaiting_candidate'|'error'|'cancelled'`.
Event union `ChatEventView.type` (`chat-client.ts:22-36`) is append-only:
`user_message, run_started, assistant_text, candidate_set, candidate_selected,
candidate_rejected, tool_call, tool_result, tool_approval_required,
tool_approved, tool_denied, run_finished, run_error, run_cancelled,
request_progress, events_trimmed`. Server-side driver:
`server/lib/agent/loop.ts` — `doc.status = 'awaiting_approval'` set at
l.488 when a call's resolved autonomy is `'ask'` (l.463-489, "the pause");
`doc.status = 'awaiting_candidate'` at l.402 for multi-candidate proposals.
W19's rule that "a run that ends must say so" (`run_finished → null` must
never render) is enforced by convention in `chat.tsx`, not by a type — worth
flagging as a soft invariant, not a compiler-checked one.

### 5.5 Editorial request status (W19)
`server/lib/requests/derive-status.ts` — **the one pure function**,
`deriveRequestStatus` (l.319-333, wrapping `derive` l.335+). States:
`queued, running, needs_you, stalled, failed, done, cancelled, archived`
(`requests-client.ts:15-23`, mirrored server-side). Only
`editorial-request-sweep.ts` (scheduled, every 5 min,
`server/functions/editorial-request-sweep.ts:1-65`) may write a *running*
request's derived status by hand — CLAUDE.md:126-128 states this as a
governing rule; no chat/tool/UI path may set `running|stalled|failed|done`
directly. `needs_you` is the status that a held gate (blocked run, non-empty
`approvalsRequired`, paused run) maps to (`derive-status.ts:396-410`) — this
is the request-list's rendering of "needs a decision," and it is a **read**
projection, not itself a decision endpoint.

---

## 6. THE APPROVAL DECISION PATH

**There is no single approval-decision endpoint.** The repo currently has
**three structurally separate decision mechanisms**, each with its own
endpoint, request shape, and UI surface. This was independently re-examined
and partly re-architected one day before this audit
(`docs/cms-architecture/decisions/2026-08-25-one-approval-truth.md`,
T15.8/#615/#617 — the branch merged as this repo's current HEAD), which
explicitly rules that **two** of the three are "deliberately two different
fields answering two different questions for two different surfaces" and
**not** a fork to close. The third (§6.3) predates and is not mentioned by
that ADR at all — see the contradiction flagged at the end of this section.

### 6.1 Object review decision — `review_decide`
- **Governs:** does *publishing this object* need a human OK, right now.
- **Deciding config layer:** `lib/approval-policy.ts` (`master`
  `'all-autonomous'|'all-require-approval'` + per-type override map,
  resolved by `publishRequiresApproval()`), **enforced** by
  `server/lib/publish-gate.ts`.
- **Endpoint:** `POST /.netlify/functions/admin-object`
  (`server/functions/admin-object.ts:1-15`, human/Identity path) — same core
  dispatcher as the agent/publish-key path `object-store.ts` — both call
  `handleObjectVerb`/`object-verbs.ts`. Request:
  `{ action:'review_decide', object_type, object_id, decision:'approve'|'request_changes', note?, publish_action?, approval_pin? }`
  (`review-state.ts:171-184`). Response: `{ review_state, version, content_revision }`
  (`object-verbs.ts:1846-1856`). MCP name: `object_review_decide`
  (`server/lib/mcp-tool-definitions.ts`).
- **Client call site(s):** `lib/edit-mode/verbs-client.ts:329-339`
  (`EditSession.approveReview()` — hardcodes `decision:'approve'`, no reject
  UI wired through this class) and the raw verb is reachable via
  `callObjectVerb` anywhere it's imported.
- **UI affordance:** the marginalia/edit-mode canvas
  (`lib/edit-mode/ui.ts`) and `ObjectWorkspace.tsx` (`checkout`/`patch`/
  `submitReview`/`approveReview` call sites at l.278-303, l.621-720).
  **No dedicated "reject" (request_changes) button was found in any `.tsx`** —
  only `approveReview()` exists client-side; `request_changes` is reachable
  only by calling `callObjectVerb` with a hand-built payload, which no
  component does.

### 6.2 Chat tool-call approval — `approve_tool` / `deny_tool`
- **Governs:** may an *admin-chat agent* execute one specific tool call it
  just proposed, right now, in this conversation.
- **Deciding config layer (new, T15.8):** `lib/publishing-policy.ts`'s
  `autonomyMode` (`'autonomous'|'operator-gated'`, absent ⇒
  `'operator-gated'` — fail-closed, l.1-45), **enforced** by
  `server/lib/agent/registry.ts:84-105` (`autonomyForCall`). Precedence
  table (from the ADR, matches the code): explicit `'off'` always wins →
  explicit `'ask'` always wins → `'auto'`/absent resolves to `'auto'` iff
  `autonomyMode === 'autonomous'`, else `'ask'`. **No fleet site registers a
  provider for `publishing-policy.ts` today** (comment,
  `publishing-policy.ts:33-38`) — every site is `'operator-gated'` by default,
  i.e. every `autonomyFloor:'ask'` tool (`object_create`, `object_publish`,
  both `instantiate_*`, `object_retire`, every membership write —
  `mcp-tool-definitions.test.ts:62`) pauses for a human today, fleet-wide.
- **The pause:** `server/lib/agent/loop.ts:463-489` — sets
  `doc.status='awaiting_approval'`, stores `run.pending`, appends a
  `tool_approval_required` event with a server-computed dry-run preview.
- **Endpoint:** `POST /.netlify/functions/admin-agent-chat.ts`
  (`admin-agent-chat.ts:1-15`), actions `approve_tool`/`deny_tool`
  (schema at l.133-141, dispatch at l.540-596). Request:
  `{action:'approve_tool', chat_id, call_id, edited_args?}` or
  `{action:'deny_tool', chat_id, call_id, reason?}`. Response:
  `{approved, executing}` — **execution is asynchronous**: "the tool's
  success/failure arrives later as a normal `tool_result` event via the poll,
  not on this response" (`chat-client.ts:184-186`).
- **Client call site(s):** `lib/admin/chat-client.ts:186-197`
  (`approveTool`/`denyTool`) → `chat.tsx`'s `useChat().approve/deny`
  (`chat.tsx:198-230`).
- **UI affordance:** `ApprovalCard` (`chat.tsx:639-770`) — renders inside
  `ChatThread` (`chat.tsx:808+`, `pending` block at l.1017-1024), which is
  embedded by `AgentsHub.tsx` directly and by `AgentRail.tsx` (used from
  `ObjectWorkspace.tsx` and `TemplatesWorkspace.tsx`). Auto-approval
  preference UI: `RunApprovalControls.tsx` ("Ask each time" /
  "Approve safe actions" toggle, driving `useRunApprovalMode` which
  auto-submits `chat.approve()` for tools `shouldAutoApproveRunTool`
  classifies as safe — `lib/admin/approval-mode.ts`). This toggle is a
  **client-side convenience only**; the server re-derives autonomy and roles
  on every call regardless (comment, `RunApprovalControls.tsx:74-79`).

### 6.3 Workflow publish-risk operator decision — `decideRunPublish`
- **Governs:** should a CMS-Agent **workflow run** (the editorial-request
  pipeline, W19) advance past its publish-risk node.
- **Deciding mechanism:** the CMS-Agent MCP tool
  `workflow_set_operator_publish_decision` (records the durable
  approve/withhold), immediately followed by `workflow_run_all` with
  `approved:true` to actually advance the run
  (`admin-request-activity.ts:140-176` — the docstring at l.50-58 explains
  why both calls are needed: "a run stopped at `publication_controller` needs
  both... giving only the first leaves the editor stuck one step later").
  **This mechanism is entirely outside `approval-policy.ts` and
  `publishing-policy.ts`** — it is CMS-Agent's own workflow-graph gate, called
  over the CMS-Agent MCP session (`server/lib/agent/cms-agent-client.ts`),
  not `object-verbs.ts` or `agent/registry.ts`.
- **Endpoint:** `POST /.netlify/functions/admin-request-activity.ts`
  (despite its own docstring calling itself "read-only and side-effect-free
  by construction," l.1-13 — true only when `action` is omitted; the
  `action` branch at l.140-183 writes). Request:
  `{request_id|run_id, action:'approve'|'withhold'}` (schema l.42-59).
  Response: refreshed `{activity, reason?, can_approve, error?}`.
- **Client call site:** `lib/admin/requests-client.ts:273-291`
  (`decideRunPublish`).
- **UI affordance:** `RequestActivity.tsx`'s "Approve and publish" /
  "Withhold" buttons (l.662-663, `decide()` at l.460-478), permission-gated
  by server-returned `can_approve` (never computed client-side — comment
  l.372-373, l.207-209 in `admin-request-activity.ts`: "one source of truth
  for the permission"). `RequestActivity` is embedded in three places:
  `RequestsWorkspace.tsx:457` (expanded, request detail page),
  `AgentsHub.tsx:493` and `AgentRail.tsx:58` (collapsed, inside a chat bound
  to a request via `chat.request`).

### 6.4 Surfaces that render a needs-decision state WITHOUT calling any decision endpoint
| Surface | What it shows | What it does NOT do |
|---|---|---|
| `AdminHome.tsx:143` | Filters chats to `['queued','running','awaiting_approval','awaiting_candidate','error']` and shows a badge/link per object | No approve/deny inline — links out to the object/chat |
| `ObjectBrowser.tsx:128` | Same filter, same badge pattern, in the object list | Same — read-only badge |
| `RequestsWorkspace.tsx` `RequestRow` (l.96-198) | `StatusPill` for `needs_you`/`stalled`/`failed` plus `status_reason` text (l.144-148) | **No inline approve/withhold** — only "Open chat" / "Article" / "Mute" / "Cancel" / "Archive" buttons (l.152-189); the decision UI only exists on the detail page (`RequestActivity`) |
| `AgentsHub.tsx` `STATUS_TONE` map (l.48-56) | Colors a chat's status chip `warning` for `awaiting_approval`/`awaiting_candidate` | Tone only; the actual `ApprovalCard` is a separate render further down the same tree, not this chip |

### 6.5 Contradiction to flag back to the requester
The 2026-08-25 ADR (`docs/cms-architecture/decisions/2026-08-25-one-approval-truth.md`)
states its "standing invariant": *"Exactly one config layer determines
approval for any given question... These are deliberately two different
fields answering two different questions for two different surfaces (object-
store write vs. chat-agent action) — that is not the fork this task exists to
delete."* That framing accounts for **mechanisms 6.1 and 6.2** but says
nothing about **6.3** (`workflow_set_operator_publish_decision`), which is a
**third** surface (the CMS-Agent workflow graph) answering a **third**
question ("may this workflow run's publish-risk node proceed") with its own
endpoint, its own client, and its own UI component — not derived from either
`approval-policy.ts` or `publishing-policy.ts`, and not mentioned by the ADR
at all. Whether this is an intentional third surface (workflow orchestration
is legitimately a different layer than either the object store or the
interactive chat) or an undocumented fork the ADR's authors were not aware
of is a genuine open question this audit surfaces but does not resolve — it
is exactly the kind of "third field re-deciding a question independently"
the ADR's closing paragraph says would be the actual problem.

---

## 7. MCP verb surface reachable from the UI

Three distinct verb surfaces exist in this repo: (a) `object-verbs.ts`'s
`ObjectVerbAction` union, dispatched identically from `admin-object.ts`
(human/Identity) and `object-store.ts` (agent/publish-key); (b) the external
`/mcp` tool catalogue (`mcp-tool-definitions.ts` +
`mcp-tool-definitions-membership.ts`, served by `mcp.ts`); (c) the admin-chat
agent's own tool registry (`server/lib/agent/tools.ts`, a curated subset of
(a)/(b) the in-app agent may call, gated by `autonomyFloor`/`autonomyForCall`,
§6.2). "UI call site" below means a `.tsx` component calling the verb
**directly** (a button/form), separate from "reachable via chat" (a human
types a request and the agent — if it has the tool — calls it, subject to
the approval pause in §6.2).

| Verb | Backend handler | Direct UI call site | Reachable via admin chat? |
|---|---|---|---|
| `object_create` | `object-verbs.ts:918` (`case 'create'`) | **NONE** — only used in `KitGallery.tsx:113` as a demo fixture, not real creation | Yes — `createObject` tool (`agent/tools.ts:415`), floored `'ask'`; entry point is `AgentsHub.tsx` starter prompts (`agent-starters.ts`) via `createFreeChat` |
| `object_patch` | `object-verbs.ts:1569` (`case 'patch'`) | `lib/edit-mode/verbs-client.ts:276` (`EditSession.patch`), used from `ObjectWorkspace.tsx` edit-mode canvas | Yes — `patch` tool (`agent/tools.ts:334`) |
| `object_validate` | `object-verbs.ts:1690` | `ObjectWorkspace.tsx:282,514`; `lib/edit-mode/ui.ts:1184,4570` | Yes — `validate` tool (`agent/tools.ts:275`) |
| `object_submit_review` | `review-state.ts:122` via `object-verbs.ts:1818` | `EditSession.submitReview()` (`verbs-client.ts:319-328`) | Yes — `submitReview` tool (`agent/tools.ts:540`) |
| `object_review_decide` | `review-state.ts:186` via `object-verbs.ts:1838` | `EditSession.approveReview()` (`verbs-client.ts:329-339`, **approve only**, no request-changes UI) | **No** — no `reviewDecide`/approve chat tool found in `agent/tools.ts` |
| `object_publish` (`publish_by_time`) | `object-verbs.ts:1927` | `EditSession.publish()` (`verbs-client.ts:303-317`) | Yes — `publish` tool (`agent/tools.ts:555`) |
| `object_checkout` | `object-verbs.ts:1523` | `EditSession.ensureCheckout()` (used from `ObjectWorkspace.tsx:301-306`) | Yes — `checkout` tool (`agent/tools.ts:312`) |
| `object_checkin` | `object-verbs.ts:1546` | `EditSession.checkin()` (`verbs-client.ts:341-344`) | Yes — `checkin` tool (`agent/tools.ts:375`) |
| `object_retire` | `object-retire.ts` via `object-verbs.ts:1889` | **NONE** — no `.tsx` calls `action:'retire'` | **No** — no `retire` chat tool exists in `agent/tools.ts` (checked full tool list, l.193-1496). **Reachable only via raw MCP by an external client**, e.g. CMS-Agent itself using the publish-key path. This is a genuine gap: the object lifecycle's terminal state has no admin-app path at all today |
| `object_create_variant` | `object-verbs.ts:999` | `ObjectWorkspace.tsx:721` | Yes — `createVariant` tool (`agent/tools.ts:438`) |
| `object_instantiate_template` | `object-verbs.ts:1080` (`case 'instantiate'`) | `Studio.tsx:112,140` (i.e. `TemplatesWorkspace`'s underlying Studio component) | Yes — `instantiateTemplate` tool (`agent/tools.ts:466`) |
| `object_instantiate_section_template` | `object-verbs.ts:1209` | `Studio.tsx:254,264` | Yes — `instantiateSectionTemplate` tool (`agent/tools.ts:509`) |
| `member_list`/`member_get`/`member_audit` | `admin-users.ts` (verb `list`/`me`/`member_audit`) | `AdminUsers.tsx` via `users-client.ts:69-169` | No chat tool; separate MCP defs in `mcp-tool-definitions-membership.ts:76-88` (human-only writes per W18, `CLAUDE.md:97-104`) |
| `member_invite`/`invitation_resend`/`invitation_revoke`/`member_set_role`/`member_suspend`/`member_reinstate`/`member_remove` | `admin-users.ts` (verbs `invite`/`resend`/`revoke`/`set_role`/`suspend`/`reinstate`/`remove`) | `AdminUsers.tsx` via `users-client.ts:112-154` | No — membership writes require a human principal by construction (`handleMembershipVerb`, `CLAUDE.md:97-100`); an agent bearer token gets `403 membership_requires_human` |
| `search_images` | `mcp-tool-definitions.ts` (MCP-only) | **NONE** | **No** — not in `agent/tools.ts`'s tool list; reachable only by an external MCP client with a scoped token |
| `import_images_from_url` | `mcp-tool-definitions.ts` (MCP-only) | **NONE** | **No** — same as above |
| `verify_article_images` | `netlify/functions/verify-article-images.ts` (root/drlurie only — see §11) | **NONE** | **No** — `OPTIONAL_HANDLER_TOOLS` (CLAUDE.md:60-61), MCP/agent-reachable only, and only on drlurie |
| `marginalia_create`/`_reply`/`_list`/`_resolve` | `object-verbs.ts:1961-2019` | `lib/admin/marginalia-client.ts`, consumed by the marginalia canvas (`lib/edit-mode/ui.ts`, `MarginaliaThreadList.tsx`) | Not in the checked `agent/tools.ts` list — canvas-only today |
| `release_to_production` | `admin-release.ts` ("the human mirror of the `release_to_production` MCP tool," comment l.7) | `ReleaseWorkspace.tsx` via `release-client.ts:58` | Yes — `releaseWorkspaceRun`/related tools (`agent/tools.ts:1229`); per the T15.8 ADU (§6, "Release is not a human gate structurally"), it is `'ask'`-floored like any privileged verb, autonomous only if a site opts into `autonomyMode:'autonomous'` |
| `commerce_orders` | **NONE found** — no `commerce_orders` tool name in `mcp-tool-definitions*.ts`; commerce is handled by separate, non-MCP functions (`create-checkout-session.ts`, `checkout-session-status.ts`, `save-commerce-event.ts`, `stripe-webhook.ts`) | **NONE** | **No** — commerce is not on the object-verb or MCP-tool surface at all in this repo; it is a Stripe-webhook-driven side channel. If `commerce_orders` is meant to be a real verb, it does not exist yet |

---

## 8. Component kit

`/admin/kit` → `KitGallery.tsx:1-50+`. It imports **every** exported
primitive/menu/overlay/data component from the barrel `admin/index.ts` and
renders each in a `<Section title="…">` block (`KitGallery.tsx:52-60` for the
`Section`/`Row` helpers) with fixed sample data (`FIXED_NOW`, `READINESS`
fixture at l.51-70+). Confirmed demoed: `Button, IconButton, Badge,
StatusPill, Card, StatCard, Avatar, Skeleton, EmptyState, Breadcrumbs, Input,
Textarea, Select, Switch, TaxonomyPicker, Tabs, DropdownMenu, CommandPalette,
Dialog, ConfirmDialog, Drawer, DataTable, DiffView, ReadinessList, LockBanner,
HistoryTimeline, Tree` plus the object-identity module demoed against sample
records of all object types (comment l.4-5). **To register a new demo:**
import the component from `./index` (which re-exports from the relevant
`admin/*.tsx` source file — `admin/index.ts` is the barrel to extend first if
the component is new) and add a `<Section title="...">…</Section>` block in
`KitGallery.tsx`. There is no registry/manifest — it is directly imperative
JSX in one file.

---

## 9. Styling system

- **Tailwind** — `tailwind.config.js:1-52`. `content` globs
  `packages/core`, `sites`, `src` (absolute paths, resolved against repo
  root — comment l.11-14 explains this was a real bug: Netlify builds from a
  site's *base directory*, not repo root, so a repo-relative glob matched
  nothing there). `darkMode: 'class'`. Theme `extend.colors` maps to
  `--aw-color-*` CSS vars (the **public-site** brand tokens), not admin
  tokens.
- **Admin design tokens** — `packages/core/app/styles/admin-tokens.css:1-290`,
  a `--adm-*` semantic layer **derived from** the `--aw-*` brand vars (l.4-8:
  "so the workspace inherits the brand's palette and fonts") plus
  admin-only roles (`--adm-danger/-success/-warning/-info`, each with a
  `-soft`/`-text` pair) that the public reader theme doesn't define. Light
  values on `:root`, dark under `.dark`. Consumed via Tailwind arbitrary
  values (`bg-[var(--adm-surface)]`) throughout `admin/*.tsx` — confirmed by
  grep density across every admin component file.
- **No shadcn/ui, no Radix UI, no Headless UI.** `tailwind-merge` is present
  (`package.json` devDependencies) and used by `admin/utils.ts`'s `cn()`
  helper — a hand-rolled `clsx`+`tailwind-merge` combinator, the only
  "component-library-adjacent" dependency in the stack. Every primitive in
  `admin/primitives.tsx`, `forms.tsx`, `overlays.tsx`, `menus.tsx` is
  hand-built (custom `Dialog`, `Drawer`, `DropdownMenu`, `CommandPalette`
  with manual focus-trap/Escape/outside-click handling per the `menus.tsx`
  header comment).
- **Admin CSS** lives in exactly one file:
  `packages/core/app/styles/admin-tokens.css`, imported only by admin routes
  (`AdminLayout.astro:7` — "This file is imported only by admin pages, so it
  never reaches public output," comment l.11-13, guarding a stated
  byte-identical-build invariant).

---

## 10. Test & CI

- **Runner:** Node's built-in `node --test`, no Jest/Vitest/Mocha. `.test.ts`
  files are compiled by a dedicated `tsconfig.test.json` (l.1-32) into
  `.tmp/ci-test`, then run. `npm test` script (`package.json`) chains three
  `node --test` invocations (compiled core+netlify+sites tests, `tests/scripts/*.test.mjs`, `packages/core/cli/capture/*.test.mjs`) and only exits 0 if
  all three pass.
- **Admin logic tests** (`lib/admin/*.test.ts`, ~35 files) are pure-function
  unit tests against the `.ts` logic modules (`activity-severity.test.ts`,
  `admin-navigation.test.ts`, `request-logic.test.ts`,
  `readiness-criteria.test.ts`, etc.) — plain `node:test` `describe`/`it`
  (or `test()`) blocks with `assert`, no React Testing Library, no DOM.
- **`.tsx` component files are explicitly excluded** from the test tsconfig
  (`tsconfig.test.json:26-27`: `packages/core/admin/**/*.tsx`,
  `packages/core/admin/index.ts` excluded) — **there are zero component-level
  or render tests for any admin `.tsx` file in this repo.** Every test in
  `lib/admin/` tests the logic that feeds a component's props, never the
  component's rendering/interaction.
- **E2E:** `tests/e2e/accept-router.browser.mjs`, run via `npm run
  test:e2e:browser` (Playwright-core is a devDependency but not wired into
  the main `npm test` chain — it's a separate script).
- **CI** (`.github/workflows/actions.yaml:1-80+`): `build` job matrixed over
  Node 20/22/24 (`npm ci && npm run build && npm test`); `check` job (Node
  22) runs `npm run check` (astro check + eslint + prettier) plus two
  additional gates — `scripts/build-diff.mjs --self-test` and
  `scripts/ci/schema-migration-gate.mjs`. A `fleet` job (referenced in the
  header comment, scales with site count) runs the per-site seed-drift guard
  and `scripts/audit-site-admin-parity.mjs --all` (the P1 fleet-parity
  check) and `scripts/fleet-capability-probe.mjs --all` (P2 env-var
  capability probe) — both directly relevant to §11's fleet-law risks.

---

## 11. Risks & landmines for the overhaul

1. **Fleet law P1** (`CLAUDE.md:55-58`): *any* change under `packages/core`
   that alters what a site's repo tree, `netlify.toml`, env set, or seed pack
   must contain is **incomplete** until applied to every existing
   `sites/<client>` (drlurie, platform, fernwell, zilberman) in the *same*
   change. Checked by `scripts/audit-site-admin-parity.mjs` in CI. A new
   admin route, a new scheduled function, or a new required env var all
   trigger this. **Already-observed exception:** `verify_article_images` is
   drlurie-only via `OPTIONAL_HANDLER_TOOLS`
   (`netlify/functions/verify-article-images.ts` exists at repo root but not
   under any `sites/<client>/netlify/functions/`, confirmed by directory
   diff — §11.6 below) — the one documented, ruled-on exception
   (`CLAUDE.md:60-61`: "Tool surfaces are uniform across tenants except via
   the documented `OPTIONAL_HANDLER_TOOLS` mechanism... today:
   `verify_article_images` only").
2. **Fleet law P2** (`CLAUDE.md:58-60`): any new env var read by core lands,
   in the same change, in the T11.7 env table + `ENV_CHECKLIST` + every
   site's env (or degrades with a catalogued `error_code`), covered by the
   capability probe (`scripts/fleet-capability-probe.mjs`).
3. **Secrets-scanner literal-string rule** (`CLAUDE.md:1-5`, expanded
   `CLAUDE.md:347`): never write a literal
   `https://github.com/vreich-ui/…` URL or the bare `vreich-ui/…` repo string
   into any committed file — Netlify's build-time secrets scanner fails the
   **entire build** on any appearance of `GITHUB_REPOSITORY`'s literal value
   in scanned files (hit for real once already, PR #470). Reference PRs by
   bare number (`#469`) only. This applies to any planning doc this audit's
   downstream tasks produce.
4. **W18 membership human-only writes** (`CLAUDE.md:90-104`): every
   membership verb goes through `handleMembershipVerb`; an agent principal
   (bearer token, chat run with no human) gets `403
   membership_requires_human` before anything else runs. Any admin-overhaul
   work touching `AdminUsers.tsx`/`admin-users.ts` must preserve this — it is
   not merely a role check, it is a principal-kind check.
5. **W19 severity source-of-truth rule** (`CLAUDE.md:106-126`,
   `lib/admin/activity-severity.ts:1-30`): `is_error` alone is never a reason
   to paint something red; severity comes from `activity-severity.ts` and
   **nowhere else**. A held gate (readiness `no_go`, an approval pending, a
   policy refusal) is `attention` (amber/warning), not `failure` (red). Any
   new UI rendering run/tool-call outcomes must route through this module,
   not invent its own red/yellow logic — this was the explicit subject of a
   Wolf ruling after a real production miscue.
6. **`verify_article_images` fleet-parity gap, independently confirmed**:
   directory diff (`ls netlify/functions` vs. `ls sites/{platform,fernwell,
   zilberman}/netlify/functions`) shows exactly one file present at root and
   absent from all three other sites' function directories:
   `verify-article-images.ts`. This matches the documented
   `OPTIONAL_HANDLER_TOOLS` exception, so it is *not* a bug — but it means
   any admin surface built to *call* this function must not assume it exists
   fleet-wide; it must degrade gracefully on platform/fernwell/zilberman.
7. **Two-different-but-similarly-named autonomy fields**: `approval-policy.ts`
   (object publish) and `publishing-policy.ts` (chat tool-call floor) look
   almost identical in shape (`master`/`autonomyMode`, both
   `'all-autonomous'`-ish) and are **deliberately not the same field** — see
   §6.5. Any overhaul work must not accidentally read one where the other is
   meant, and should not "simplify" them into one without re-litigating the
   ADR's stated reasoning (`publishing-policy.ts:9-24`).
8. **No component tests exist for `.tsx` admin files** (§10) — a UI overhaul
   has zero regression safety net beyond `astro check`/eslint/prettier and
   the pure-logic `.test.ts` suite. Any new logic extracted for testability
   should land in `lib/admin/*.ts`, mirroring the existing pattern, since
   that is the only tier with test coverage.
9. **The client-side `NAV` array and the `ownerOnly` ADMIN gate are
   independent** (§1, `/admin/agents`): a nav change does not change access;
   an access change does not change what's linked. Changing one without the
   other is easy to do by accident.
10. **`admin-request-activity.ts`'s self-description as "read-only... by
    construction"** is stale/misleading now that the `action` branch writes
    (§6.3) — a maintainer trusting the docstring could reasonably assume it
    is safe to call speculatively/for polling in new code, when the `action`
    branch is a real, consequential write (advances a live workflow run).

---

## 12. Task → file map

No task-definition document for `T0.2` through `T6.2` exists anywhere in
this repo (`docs/plan/` did not exist before this audit created it; `docs/
admin-redesign/roadmap.md` uses an unrelated `M1–M4` milestone numbering;
`docs/cms-architecture/cms-pipeline/queue.tsv`'s `T0.1–T6.2` IDs are a
**different, already-completed** pipeline from months ago — object-schema
build tasks, not this overhaul). The mapping below is therefore an
**inference from this audit's own findings**, grouped by the most plausible
phase intent given conventional numbering (0 = foundation/audit, 1 = IA/nav,
2 = data layer, 3 = approval unification — the highest-value finding above,
4 = MCP verb-surface gaps, 5 = component kit, 6 = ship/tests) — not a
citation to an existing plan. Treat every row as a **starting point to
verify against the actual task brief once written**, not a guarantee.

| Task | Likely files |
|---|---|
| T0.2, T0.3 | Whatever the next audit/spec deliverable is — likely `docs/plan/*.md` siblings to this file; if schema-adjacent, `packages/core/schema/object-record-v1.ts`, `packages/core/schema/bodies/*.ts` |
| T1.1, T1.2 (IA/nav) | `packages/core/admin/AdminShell.tsx` (`NAV` l.73-95, `NavList` l.104-135), `packages/core/lib/admin/admin-navigation.ts`, `packages/core/app/layouts/AdminLayout.astro`, the 18 route `.astro` files under `packages/core/app/routes/admin/` |
| T2.1, T2.2, T2.3 (data layer / state mgmt) | `packages/core/lib/admin/library-client.ts` (the one existing cache, likely the pattern to generalize or replace), `packages/core/lib/admin/requests-client.ts`, `packages/core/lib/admin/chat-client.ts`, `packages/core/admin/RequestActivity.tsx` (poll-chain pattern), `packages/core/admin/ReleaseWorkspace.tsx` (interval pattern), `package.json` (if a query library is introduced) |
| T3.1, T3.2, T3.3, T3.4 (approval unification — 3 mechanisms → fewer) | `packages/core/server/lib/review-state.ts`, `packages/core/server/lib/agent/registry.ts` (`autonomyForCall`), `packages/core/server/functions/admin-request-activity.ts`, `packages/core/lib/approval-policy.ts`, `packages/core/lib/publishing-policy.ts`, `packages/core/admin/chat.tsx` (`ApprovalCard`), `packages/core/admin/RequestActivity.tsx`, `packages/core/lib/edit-mode/verbs-client.ts` (`EditSession.approveReview`), `docs/cms-architecture/decisions/2026-08-25-one-approval-truth.md` (must be re-read and either extended or explicitly superseded, not silently contradicted) |
| T4.1–T4.4 (MCP verb-surface gaps) | `packages/core/server/lib/agent/tools.ts` (add `retire`/review-decide/search_images/import_images chat tools if in scope), `packages/core/server/lib/mcp-tool-definitions.ts`, `packages/core/admin/ObjectWorkspace.tsx` (retire affordance is genuinely missing, §7), `packages/core/lib/edit-mode/verbs-client.ts` |
| T5.1 (component kit) | `packages/core/admin/KitGallery.tsx`, `packages/core/admin/index.ts` (barrel) |
| T6.1, T6.2 (ship/tests) | `tests/*`, `packages/core/lib/admin/*.test.ts` (pattern to extend — this is the only tested tier, §10, §11.8), `.github/workflows/actions.yaml`, `scripts/audit-site-admin-parity.mjs`, `scripts/fleet-capability-probe.mjs` |

---

*End of audit. Read-only per task instructions — no source file listed above
was modified.*
