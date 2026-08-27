# T0.2 — Admin performance diagnosis

Repo: the platform monorepo, `main` @ `a21f05f`. Read-only static analysis; no source file was modified. Every claim below is cited `path:line` against this checkout.

---

## 0. Corrections to the task brief

The brief instructed me to read `docs/plan/admin-audit.md` (the T0.1 architecture audit) first and treat its findings as established. **That file does not exist.** `docs/plan/` contains only `ux-inventory.md`, which is T0.3 (attention & severity), not T0.1. I derived the route inventory, data-flow map and approval trace myself. Where I state an architectural fact below it is because I read the code, not because T0.1 said so.

Three of the brief's stated "key facts, do not re-derive" are correct; **two are wrong or importantly incomplete**, and one of them changes the answer to §5:

| Brief's assumption | Verdict |
|---|---|
| No TanStack Query / SWR / Zustand / Radix / shadcn installed | **Correct.** No matches anywhere outside `node_modules`. |
| State is plain `useState`/`useEffect` | **Mostly correct**, with one exception the brief misses: `use-current-user.ts:15-70` is a hand-rolled module-scope store consumed via `useSyncExternalStore` — a real external-store cache with in-flight dedupe, not component state. |
| The only cache layer is `packages/core/lib/admin/library-client.ts` | **Wrong — three exist.** (1) `library-client.ts:32-146` (TTL + sessionStorage + in-flight dedupe); (2) `use-current-user.ts:15-70` (module snapshot + in-flight dedupe, invalidated on `cms:login`/`cms:logout`); (3) **server-side**, `packages/core/server/lib/content-item-index.ts:48-81` (per-lambda-instance TTL cache with stale-if-error over a GitHub call). (3) matters: it is the existing in-repo precedent for the server-side memoization §3 recommends. |
| Admin components in `packages/core/admin/*.tsx`, clients in `lib/admin/*.ts`, handlers in `server/functions/*.ts` | Correct. |
| Netlify Blobs is the source of truth | Correct. |
| **(implied by the brief's §5 framing)** "full-page Astro navigations that discard React state entirely" | **Half wrong, and this is the load-bearing correction.** `packages/core/app/layouts/Layout.astro:20,44` mounts Astro's `<ClientRouter fallback="swap" />`, which AdminLayout inherits. A sidebar `<a href>` click is therefore a **client-side DOM swap**: the JS module registry, and every module-scope cache in it, **survives**. What discards everything is the **22 hard `window.location.assign(...)` calls** scattered through `packages/core/admin/*.tsx` (see F14) — the admin's own buttons bypass its own router. So the admin is *neither* "a fresh SPA island per route" *nor* "a persistent shell": it is a client-side-routed app whose primary in-app actions manually reload the document. That is a fixable bug, not an architectural constraint, and it is why the TanStack-Query prescription in §5 lands differently than the plan assumes. |

One more brief assumption worth naming: the brief asks me to count "server handlers that loop `getStore().get()` per object". They do, extensively — but the *wire* payloads are mostly lean. The cost is **server-side read amplification and latency**, not response bytes. I have kept those two separate throughout.

---

## 1. Per-surface load traces

Cost notation: **BR** = Netlify Blobs read, **BW** = Blobs write, **BL** = Blobs `list()`, **XHR** = extra outbound HTTP from the lambda (GitHub / Netlify API / CMS-Agent MCP). `N` = number of governed object records in the store. `C` = number of agent chat docs. `K` = number of distinct `publish_commit` values across objects.

Every one of the endpoints below first pays a **fixed auth toll**: `getAdminStateFromEvent` (`server/lib/admin-auth.ts:62-122` — a GoTrue `/user` **XHR** whenever Netlify does not inject `clientContext`) plus `resolveRolesForPrincipalAsync` → `getUserRecord` (**1 BR**). Call it **+1 BR (+1 XHR)** per request; it is never memoized, and it is paid on every poll tick.

### 1.1 `/admin/requests` (and `/admin/requests/<id>`)

Route: `packages/core/app/routes/admin/requests.astro:14` → `RequestsWorkspace client:load`. `/admin/requests/<id>` is the same island via the `netlify.toml:168` rewrite to `__request`, with the id read from `window.location.pathname` (`RequestsWorkspace.tsx:518-523`).

| # | Call | Site | Par/Ser | Cost |
|---|---|---|---|---|
| 1 | `GET admin-auth-state` | `AdminLayout.astro:175,183` via `admin-access-client.ts:33` | parallel with all React work (islands are `client:load`, they hydrate inside the still-`hidden` container) | 1 XHR |
| 2 | `POST admin-users {verb:'me'}` | `AdminShell.tsx:235` → `use-current-user.ts:39` → `users-client.ts:61` | parallel | 2 BR + **2 BW** (`admin-users.ts:280` → `invitations.ts:692-695` writes `last_seen_at` on *every* read; `admin-users.ts:282` appends an audit entry) |
| 3 | `POST admin-requests {action:'list',limit:100}` | `AdminShell.tsx:199` (RequestPulse) | parallel | 4 BR (auth 1 + `admin-requests.ts:157` index + `:171` notify state + `:172` seen ledger) |
| 4 | `POST admin-requests {action:'list', …filters}` | `RequestsWorkspace.tsx:313` | **parallel with #3 — same endpoint, same 4 BR, second time** | 4 BR |
| 5 | `POST admin-requests {action:'notify_ack'}` (conditional) | `useRequestNotifications.tsx:113` | serial after #3 | 2 BR + 1 BW |
| 6 | *(detail route only)* `POST admin-request-activity` | `RequestActivity.tsx:500` → `requests-client.ts:241` | parallel | 1 BR (`admin-request-activity.ts:111`) + **2 XHR to CMS-Agent** (`:186-193`, `workflow_get_run` + `workflow_get_run_cost`) |

**Paint** blocks on #4 (`rows === null` → `<Skeleton>` at `RequestsWorkspace.tsx:464`). #3 paints only the topbar pills.

**Steady state, one tab, one running job:** three independent poll chains —
- shell: fixed **15 s** (`AdminShell.tsx:215`),
- list body: **5 s / 15 s / 30 s** by liveness (`requests-client.ts:148-152`, rescheduled at `RequestsWorkspace.tsx:328`),
- activity: **3 s** while running (`requests-client.ts:293`).

≈ **32 requests/min → ≈128 BR/min + ≈40 CMS-Agent XHR/min** for a single idle-but-open browser tab. Nothing carries an `ETag`; every tick re-serialises the full list.

### 1.2 `/admin/agents`

Route: `agents.astro:17` → `AgentsHub client:load`.

| # | Call | Site | Par/Ser | Cost |
|---|---|---|---|---|
| 1 | `GET admin-auth-state` | `AdminLayout.astro:175` | parallel | 1 XHR |
| 2 | `POST admin-users {verb:'me'}` | `AdminShell.tsx:235` | parallel | 2 BR + 2 BW |
| 3 | `POST admin-requests {action:'list'}` + 15 s interval | `AdminShell.tsx:199,215` | parallel | 4 BR |
| 4 | `POST admin-agent-chat {action:'list_chats'}` | `AgentsHub.tsx:303` → `chat-client.ts:128` | parallel | 1 BL + **C BR** — `chat-store.ts:276-288` lists `chats/by-id/` then `store.get()`s **every** doc **serially in a `for` loop**, and each doc carries up to **800 events** (`chat-store.ts:33`) to produce an 8-field summary (`admin-agent-chat.ts:221-231`) |
| 5 | `POST admin-users {verb:'me'}` **again** | `AgentsHub.tsx:307` | parallel with #4, **duplicate of #2** | 2 BR + 2 BW |
| 6 | `POST admin-agent-chat {action:'list_chats',include_all:true}` | `AgentsHub.tsx:310` | **serial after #5**, and a strict superset of #4 | 1 BL + C BR |
| 7 | *(with `?chat=`)* `POST admin-agent-chat {action:'get_chat'}` | `chat.tsx:147` | parallel | 1 BR + 1 BR (`admin-agent-chat.ts:403`, first poll only) |
| 8 | *(once #7 reports `idle`)* `list_chats` **a third time** | `AgentsHub.tsx:318-320` | serial after #7 | 1 BL + C BR |

For an Owner (the common case on this surface) that is **`me` twice, `list_chats` two-to-three times**, i.e. **2–3 × (1 BL + C BR)** where each of the C reads pulls a whole transcript. **Paint** blocks on #4 (`chats === null` → skeleton, `AgentsHub.tsx:409`), then flashes again when #6 replaces the list.

**Steady state:** `useChat` polls `get_chat` at **1.2 s** while running, **2 s** awaiting approval, **5 s** idle (`chat-client.ts:206-211`) — but the response is delta'd by `since_seq` (`chat.tsx:147`, `admin-agent-chat.ts:419`), which is the one place in the codebase that does incremental transfer properly. Plus the shell's 15 s `listRequests`.

### 1.3 Editorial — `/admin` home

Route: `index.astro:18` → `AdminHome client:load`. This is the surface the sidebar labels "Editorial" (`AdminShell.tsx:75`); the editorial-state machinery itself is `lib/admin/editorial-state.ts` fed by `admin-release-state`.

| # | Call | Site | Par/Ser | Cost |
|---|---|---|---|---|
| 1 | `GET admin-auth-state` | `AdminLayout.astro:175` | parallel | 1 XHR |
| 2 | `POST admin-users {verb:'me'}` | `AdminShell.tsx:235` | parallel | 2 BR + 2 BW |
| 3 | `POST admin-requests {action:'list'}` + 15 s | `AdminShell.tsx:199` | parallel | 4 BR |
| 4 | `POST admin-object {action:'inventory'}` | `AdminHome.tsx:131` → `library-client.ts:105` | parallel (correctly `Promise.all`'d at `AdminHome.tsx:130`) | **13 BL + N BR** — `object-verbs.ts:888-907`: one `store.list()` per object type (13 types, `schema/object-record-v1.ts:7-23`) then `mapWithConcurrency(..., 8, loadRecordForSweep)`. Each BR pulls the **entire `ObjectRecord`** — full `body` node tree plus unbounded `history` — to compute ~15 scalars (`object-inventory.ts:148-189`) |
| 5 | `GET admin-release-state` | `AdminHome.tsx:132` → `release-client.ts:51` | parallel | **A second, independent 13 BL + N BR sweep** (`admin-release-state.ts:46-51` calls `handleObjectVerb inventory` itself, bypassing the client cache entirely) **+ 2 XHR** to the Netlify deploys API (`:56-58`) **+ K XHR** to GitHub `/compare`, one per distinct publish commit (`:66-73` → `production-release.ts:146-178`, **uncached**) |
| 6 | `POST admin-agent-chat {action:'list_chats'}` | `AdminHome.tsx:133` | parallel | 1 BL + C BR |

**Paint** blocks on all three of #4/#5/#6 (`Promise.all(...).finally(setLoading(false))`, `AdminHome.tsx:153`) — so the slowest, #5, gates the page. **Total: 2 full object-store sweeps + 1 full chat sweep + 2 Netlify API calls + K GitHub API calls for one page load.** At N=200, C=40, K=25 that is ≈ **26 BL + 240 BR + 27 XHR**, of which #5 alone is ~1.5–3 s.

### 1.4 `/admin/content` and `/admin/content/<objectId>`

**Library** (`content/index.astro:15` → `ContentLibrary`):

| # | Call | Site | Par/Ser | Cost |
|---|---|---|---|---|
| 1–3 | gate + `me` + `listRequests` | as above | parallel | 1 XHR + 6 BR + 2 BW |
| 4 | `POST admin-object {action:'inventory'}` | `ContentLibrary.tsx:158` | parallel; **paints instantly from `sessionStorage`** first (`:145-150`, `library-client.ts:98-102`) — the one genuinely good pattern on any of these surfaces | 13 BL + N BR (skipped entirely inside the 30 s TTL, `library-client.ts:139`) |
| 5 | `GET admin-release-state` | `ContentLibrary.tsx:184` (a **separate effect**, `:182-194`) | parallel with #4 | 13 BL + N BR + 2 XHR + K XHR — **recomputes the same inventory #4 just fetched, on the server, with no cache and no dedupe** |

**Object workspace** (`content/[objectId].astro:22` → `ObjectWorkspace`, desktop/expanded layout):

| # | Call | Site | Par/Ser | Cost |
|---|---|---|---|---|
| 1–3 | gate + `me` + `listRequests` | | parallel | 1 XHR + 6 BR + 2 BW |
| 4 | `resolveWorkspaceObjectType` | `ObjectWorkspace.tsx:529` → `object-type-resolve.ts:51-57` | **serial, first in the chain** | 0 for a prefixed id; **13 BL + N BR** for `req_*`/unprefixed ids (mitigated by the library-client cache) |
| 5 | `POST admin-object {action:'get'}` | `ObjectWorkspace.tsx:498` | **serial after #4** | 1 BR — returns the **whole record verbatim** (`object-verbs.ts:839-842`): both `public` and `private` body trees plus the entire `history` array |
| 6 | `GET admin-release-state` | `ObjectWorkspace.tsx:506` | **serial after #5 — no data dependency on it** | 13 BL + N BR + 2 XHR + K XHR |
| 7 | `POST admin-object {action:'validate'}` | `ObjectWorkspace.tsx:514` | **serial after #6 — no data dependency on it** | **A third sweep**: `admin-object.ts:99-111` → `object-validation-context.ts:185-220`, 13 BL + N BR, **+1 XHR** GitHub contents (`content-item-index.ts:59`, TTL-cached per lambda instance) |
| 8 | `POST admin-agent-chat {action:'create_chat'}` | `ObjectWorkspace.tsx:539` | serial after #5 (fired, not awaited) | 1 BR + 1 BW on first open |
| 9 | `POST admin-object {action:'get', object_type:'taxonomy'}` | `ObjectWorkspace.tsx:233` | parallel | 1 BR |
| 10 | `POST admin-agent-chat {action:'list_profiles'}` | `ObjectWorkspace.tsx:396` | parallel | 1–2 BR |
| 11 | `ObjectBrowser`: `inventory` + `admin-release-state` + `list_chats` | `ObjectBrowser.tsx:115-118`, mounted at `ObjectWorkspace.tsx:1008` once the media query resolves (`:476-488`) | parallel `Promise.all` among themselves | inventory served from cache; **`admin-release-state` for the SECOND time this page load** (13 BL + N BR + 2 XHR + K XHR); + 1 BL + C BR |
| 12 | `useChat` poll | `chat.tsx:170` | parallel | 1.2–5 s cadence |

**Paint**: `setLoading(false)` is at `ObjectWorkspace.tsx:511` — *after* #5 and #6, i.e. the release-state sweep is on the critical path to first content.

**Steady state:** whenever a lock is held, `ObjectWorkspace.tsx:576` runs `setInterval(refreshLock, 4000)` which re-fetches the **entire object record** (body + history) every 4 seconds to read one boolean.

**Total for one object open: 4 object-store sweeps** (release-state ×2, validate ×1, inventory ×1-or-cached) **+ 2 chat/profile sweeps + 4 Netlify API + 2K GitHub API calls**, three of them strictly serial.

---

## 2. Findings table

| # | `path:line` | Surface(s) | Class | What happens | Why it costs | Est. win |
|---|---|---|---|---|---|---|
| F1 | `ObjectWorkspace.tsx:490-520` | content/`<id>` | **BUG** | `load()` awaits `getObjectRecord` → then `fetchReleaseOverview` → then `validate`. #2 and #3 need only `type` + `loc.id`, both known before the function is entered. | Three round trips end-to-end, two of them full store sweeps, before `setLoading(false)` at `:511`. | **3 → 1 round trips**; ≈ **1.5–3 s** off first paint |
| F2 | `admin-release-state.ts:46-51` (+`ContentLibrary.tsx:184`, `AdminHome.tsx:132`, `ObjectWorkspace.tsx:506`, `ObjectBrowser.tsx:117`) | all four | **ARCHITECTURE** | The handler runs its own `handleObjectVerb inventory` — a full 13-list + N-get sweep — on every call, and four separate client call sites hit it with no shared cache. | `/admin` pays it once, `/admin/content/<id>` **twice**. N objects → **13 BL + N BR** per call, each read pulling a whole record envelope to derive one enum. `Cache-Control: no-store` at `:23`, no `ETag`. | Dedupe alone: **2 → 1** calls on the workspace. Adding a 15–30 s server memo: ≈ **1–3 s** off every affected mount |
| F3 | `admin-release-state.ts:66-73` → `production-release.ts:146-178` | `/admin`, content, content/`<id>` | **ARCHITECTURE** | One GitHub `/compare` REST call **per distinct `publish_commit`**, on every request, uncached. | K sequentialised-by-rate-limit XHRs at ~150–300 ms each; K grows monotonically with publish history. Also burns GitHub API quota per page view. | Cache commit-ancestry (immutable data — a commit's ancestry never changes): **K → 0** on warm instances, ≈ **0.5–3 s** |
| F4 | `chat-store.ts:276-288` | agents, `/admin`, content/`<id>` | **ARCHITECTURE** | `listChatDocs` lists `chats/by-id/` then `await store.get()` **inside a serial `for` loop**, parsing every doc's full 800-event log (`:33`) to build an 8-field summary (`admin-agent-chat.ts:221-231`). | C chats → **1 BL + C serial BR**, each read O(transcript). Not even `mapWithConcurrency`, which the object store already uses (`object-verbs.ts:905`). | Concurrency alone: **C → C/8** wall-clock. A `chats/index.json` summary doc (the pattern `admin-requests.ts:157` already proves): **C+1 → 1 BR** |
| F5 | `AgentsHub.tsx:302-315` | agents | **BUG** | Mount effect calls `reloadList()` (`:303`), then `fetchMe` (`:307`), then — for an Owner — `reloadList(true)` (`:310`), which is a strict superset of the first. | Two full `list_chats` sweeps per Owner mount, the second serialised behind `fetchMe`; the first's result is thrown away and causes a visible list flash. | **2 → 1** `list_chats`; ≈ **300–900 ms** and one less layout shift |
| F6 | `AgentsHub.tsx:307` vs `AdminShell.tsx:235` | agents | **BUG** | `HubBody` calls `fetchMe` directly instead of `useCurrentUser()`, which `AdminShell` — its own parent — already called. The module store at `use-current-user.ts:36-64` would have deduped it for free. | `admin-users {verb:'me'}` twice per mount, and `me` is a **write** (`invitations.ts:692-695` + audit append at `admin-users.ts:282`), so it is 2 extra BR + 2 extra BW. | **2 → 1**; removes 2 blob writes from every agents page load |
| F7 | `AdminShell.tsx:199` + `RequestsWorkspace.tsx:313` | requests | **BUG** | `RequestPulse` and `RequestsBody` both poll `admin-requests {action:'list'}` on the same page, on independent chains (15 s and 5 s), with different filters. | ~16 req/min to one endpoint = ~64 BR/min, for two views of the same index. | **2 → 1** chains; ≈ **50 %** of the surface's steady-state traffic |
| F8 | `RequestsWorkspace.tsx:337` (dep array) → `:308-338` | requests | **BUG** | `load` is a `useCallback` keyed on `query`, and `query` is bound to the Search `<Input>` (`:429`) with **no debounce**. Every keystroke bumps the generation (`:341`), tears down the poll chain, and fires a fresh request. | "brand voice" typed = 11 requests × 4 BR = 44 BR, plus 11 poll-chain restarts. | ~**11 → 1** requests per search; a 300 ms debounce is a 3-line change |
| F9 | `ObjectWorkspace.tsx:564-581` | content/`<id>` | **BUG** | `setInterval(refreshLock, 4000)` re-fetches the **whole** `ObjectRecord` (`:570`, → `object-verbs.ts:839-842`: full body + full history) every 4 s while any lock is visible. | 15 full-record reads/min to observe one boolean and an expiry timestamp. On a large article the body tree dominates the response. | A `refresh_lock`-shaped read, or 15 s cadence: ≈ **75–95 %** of that traffic |
| F10 | `object-verbs.ts:888-907`; `object-validation-context.ts:185-220` | all four | **ARCHITECTURE** | The two hot server paths both do `13 × store.list()` + `N × store.get()`, reading whole envelopes. `verbNeedsValidationContext` (`object-verbs.ts:391-413`) correctly exempts pure reads — but **`validate` is not exempt** (`:409-412`), so the workspace's readiness check pays a full sweep. | **N objects → 13 + N blob reads per call**, i.e. ~3N per object-workspace open across the three sweeps. Nothing is indexed; nothing is cached server-side. | An `objects/index.json` summary (the `admin-requests.ts:157` pattern): **13 + N → 1 BR**. This is the single largest structural win available. |
| F11 | `admin-users.ts:275-280` → `invitations.ts:692-695` | all four | **ARCHITECTURE** | `{verb:'me'}` — a read — unconditionally `saveMember`s to stamp `last_seen_at`, plus an audit append at `:282`. | Every admin page load performs 2 blob **writes** on the critical path to rendering the topbar user chip. Writes are the slowest Blobs operation. | Throttle `last_seen_at` to once per hour: **2 BW → ~0** per page load, ≈ **100–300 ms** |
| F12 | `admin-requests.ts:56`; `admin-object.ts:47`; `admin-agent-chat.ts` (`jsonHeaders`); `admin-release-state.ts:23`; `admin-request-activity.ts`; `admin-users.ts:62`; `admin-governance.ts:57`; `object-store.ts:41` | all four | **ARCHITECTURE** | Every admin JSON handler sets `Cache-Control: no-store`. **No handler anywhere emits an `ETag`** (zero matches across `server/functions/`). | `no-store` is defensible for authenticated admin data, but with no `ETag` there is no conditional revalidation either: a 15 s poll that returns byte-identical JSON still pays full serialisation + full transfer, every tick, forever. | `ETag` + `304` on the poll endpoints: ≈ **80–95 %** of steady-state poll bytes |
| F13 | `admin-request-activity.ts:186-193`; cadence `requests-client.ts:293` | requests detail | **ARCHITECTURE** | Every 3 s poll issues **two** CMS-Agent MCP calls and returns the **entire** node tree, tool-call list and cost ledger (`requests-client.ts:181-213`) with no `since`/delta parameter. | ~40 MCP round trips/min per open tab; the full activity document re-crosses the wire 20×/min unchanged. `useChat` next door already solves exactly this with `since_seq` (`chat.tsx:147`). | `since_seq` parity + `ETag`: ≈ **90 %** of the payload, **2 → 1** MCP calls when the cost ledger is unchanged |
| F14 | 22 sites, incl. `AdminShell.tsx:321,331,341,469,477`; `RequestsWorkspace.tsx:158,169,398`; `AdminHome.tsx:44`; `ObjectWorkspace.tsx:728,770`; `useRequestNotifications.tsx:60` | all four | **BUG** | `Layout.astro:44` mounts `<ClientRouter>`, so `<a href>` navigation is a client-side swap that preserves the module registry. But every in-app **button** navigates with `window.location.assign(...)` — a hard document reload. | Each one discards `library-client`'s memory cache, `use-current-user`'s snapshot, all React state, re-runs the auth gate, re-parses the bundle, and re-fires every mount fetch. Cmd-K → an object = a cold `/admin/content/<id>` (≈4 sweeps) that a swap would have served from cache. | Swap for `navigate()` from `astro:transitions/client`: **full cold mount → cache-warm mount** on every in-app jump; ≈ **1–3 s** per navigation |
| F15 | `AdminShell.tsx:288-304` + `library-client.ts:135` | all four | ARCHITECTURE *(already mitigated — noted so it is not "fixed" twice)* | Cmd-K lazily fetches inventory on first palette open, but goes through the shared cache. | Correct as written; `object-type-resolve.ts:16-21` documents this same class of bug being fixed point-locally three times. The recurrence is the signal: the codebase keeps re-solving "share one fetch" per call site. | — (evidence for §5, not a fix) |
| F16 | `overlays.tsx:312` | all four | **BUG** (minor) | `<ToastContext.Provider value={{ toast }}>` allocates a new object every `ToastProvider` render, and `items` changes on every toast show/expire. | Every toast re-renders **every** `useToast()` consumer in the tree — on the object workspace that is the whole page. `toast` itself is stable (`:301-309`), so a `useMemo` is a one-line fix. | Removes a full-tree re-render per toast |
| F17 | `RequestActivity.tsx:529-533` | requests detail | ARCHITECTURE *(correct as designed)* | `setInterval(setNowMs, 1000)` re-renders the activity tree once a second to animate elapsed time. | A local clock, no network — the comment at `:523-527` justifies it correctly. Flagged only because the brief asked for every timer: the cost is one React reconcile/sec over ~N-node subtree while expanded. | Memoize node rows; low priority |
| F18 | `netlify.toml:59-60` → `editorial-request-sweep-background.ts:158-163` | background | ARCHITECTURE | The 5-min sweeper iterates requests with `for (const id …) await sweepRequest(…)` — fully serial, one `workflow_get_run` MCP call plus blob reads/writes each. | Off the paint path, but it contends for the same Blobs throughput as a foreground poll, and a long sweep inflates p99 on concurrent admin reads. | `mapWithConcurrency`; low priority for T5.1 |

---

## 3. Ranked fix list (impact ÷ effort)

**R1 — `Promise.all` the object-workspace load. (F1)**
`ObjectWorkspace.tsx:490-520` awaits three independent calls in sequence. Hoist `type`/`loc.id` (already available), then `const [{record}, overview, validation] = await Promise.all([...])`, and move `setLoading(false)` to fire on `record` alone so the release/readiness data fills in progressively rather than gating paint. Also move `createObjectChat` (`:539`) into the same `Promise.all` — it depends on `record` only for a *display title*, which can be patched in after.
*Files:* `packages/core/admin/ObjectWorkspace.tsx`.
*Risk:* Low. The only real coupling is the display-name argument to `createObjectChat`; pass `undefined` and let the existing title stand.
*Where:* **Free during T2.3** if that task rebuilds the object workspace — this is a rewrite of the mount effect, which a rebuild rewrites anyway. Otherwise T5.1.

**R2 — Deduplicate `admin-release-state` per page, then memoize it server-side. (F2, F3)**
Two steps. Client: give `release-client.ts` the same shape `library-client.ts` already has — module-scope TTL + in-flight dedupe — so `ObjectWorkspace.tsx:506` and `ObjectBrowser.tsx:117` share one call instead of two. Server: add a short-TTL per-instance memo around the whole `admin-release-state` body (the `content-item-index.ts:48-81` pattern, already in-repo and proven), plus a **permanent** memo on `isCommitAncestorOrEqual` — commit ancestry is immutable, so it never needs invalidating.
*Files:* `packages/core/lib/admin/release-client.ts` (new cache), `packages/core/server/functions/admin-release-state.ts`, `packages/core/server/lib/production-release.ts`.
*Risk:* Low-medium. The TTL must be short (≤15 s) or an editor's own publish will not appear reflected; invalidate on the publish path to be safe. Commit-ancestry memoization is risk-free.
*Where:* **T5.1** — it is server work and cross-cuts all four surfaces, so it should not ride a single surface's rebuild.

**R3 — Build `objects/index.json`. (F10, and the ceiling on F2)**
The requests registry already proves the pattern: `admin-requests.ts:157` reads exactly one blob because a writer maintains an index (`requests/store.ts`, rebuilt once at `:120-127` when absent). Do the same for objects: every mutating verb in `object-verbs.ts` updates a summary index carrying the ~15 fields `InventoryRow` needs (`object-inventory.ts:89-123`); `inventory` reads one blob; `rebuildIndex`-style self-healing covers drift. This collapses **13 BL + N BR → 1 BR** for inventory, and — because `admin-release-state.ts:46` calls `handleObjectVerb inventory` — for release-state too.
*Files:* `packages/core/server/lib/object-verbs.ts`, a new `server/lib/objects/index-store.ts`, `packages/core/server/functions/admin-object.ts`.
*Risk:* **Medium-high** — an index that drifts from the store silently shows wrong state, which on this product means wrong *approval* state. Mitigate exactly as requests does: version/seq stamp, rebuild-on-miss, and a `rebuilt: true` flag on the response so drift is observable rather than silent.
*Where:* **T5.1.** Too large and too correctness-sensitive to ride a UI rebuild.

**R4 — Replace the 22 `window.location.assign` calls with Astro's `navigate()`. (F14)**
`ClientRouter` is already mounted (`Layout.astro:44`) and already services sidebar links. Import `navigate` from `astro:transitions/client` and use it in the command palette, the request rows, the workspace back-links and `AdminHome`'s create flow. This alone converts every in-app jump from "cold mount, all caches lost" to "swap, module caches warm" — and it is what makes any future SWR layer worth having (§5).
*Files:* `AdminShell.tsx`, `RequestsWorkspace.tsx`, `AdminHome.tsx`, `ObjectWorkspace.tsx`, `AgentsHub.tsx`, `Studio.tsx`, `useRequestNotifications.tsx`.
*Risk:* Low-medium. Two call sites must stay hard reloads on purpose: the logout redirect (`AdminShell.tsx:311`) and the welcome-gate `location.replace` (`:272`) — both need the module caches *destroyed*. Keep those; convert the rest.
*Where:* **T5.1**, but land it **before** T2.1/T2.2/T2.3 — those rebuilds will otherwise copy the `window.location.assign` idiom forward.

**R5 — Collapse the AgentsHub mount effect. (F5, F6)**
Replace `AgentsHub.tsx:302-315` with `useCurrentUser()` for the owner flag (it is already loaded by the parent `AdminShell`) and a single `listChats(getToken, owner)` that waits for the resolved role instead of firing twice. This removes one `list_chats` sweep, one `me` round trip, two blob writes, and the list flash.
*Files:* `packages/core/admin/AgentsHub.tsx`.
*Risk:* Very low.
*Where:* **Free during T2.2** if that task rebuilds the agents hub — it is a rewrite of the same effect.

**R6 — Debounce the requests search. (F8)**
`RequestsWorkspace.tsx:429`'s `onChange` feeds `query`, which is in `load`'s dep array at `:337`. Keep an immediate `queryInput` for the controlled input and a 300 ms-debounced `query` for the fetch key.
*Files:* `packages/core/admin/RequestsWorkspace.tsx`.
*Risk:* Very low.
*Where:* **Free during T2.1** if that task rebuilds the requests inbox.

**R7 — One poll chain per endpoint per page. (F7)**
`RequestPulse` (`AdminShell.tsx:185-223`) already owns "the one poll behind the shell's pills" and says so in its own docstring — but `RequestsBody` runs a second one. Lift the request list into a shared module store (the `use-current-user.ts` shape) that `RequestPulse` drives and `RequestsBody` subscribes to, with the body contributing the filter and the interval taking the faster of the two cadences.
*Files:* new `lib/admin/requests-store.ts`, `AdminShell.tsx`, `RequestsWorkspace.tsx`.
*Risk:* Medium — the generation-counter logic at `RequestsWorkspace.tsx:283-291` exists because of a real zombie-poll bug; whatever replaces it must preserve that guarantee.
*Where:* **T2.1** if the requests surface is rebuilt; otherwise T5.1.

**R8 — `ETag` + `304` on the four polled endpoints. (F12, F13)**
Hash the response body, emit `ETag`, honour `If-None-Match`. Keep `no-store` off these — use `Cache-Control: private, no-cache` (revalidate always, but *allow* revalidation), which is the correct header for authenticated data that is polled. Highest leverage on `admin-requests`, `admin-request-activity`, `admin-agent-chat get_chat`, `admin-release-state`.
*Files:* the four handlers, plus a shared `server/lib/json-response.ts` helper.
*Risk:* Low, but note it saves **bytes and serialisation, not blob reads** — the handler still does its work before it can hash. Pair with R2/R3 for the read savings.
*Where:* **T5.1.**

**R9 — Give `list_chats` an index, or at minimum concurrency. (F4)**
One-line first aid: swap `chat-store.ts:276-288`'s serial `for` loop for `mapWithConcurrency(items, STORE_READ_CONCURRENCY, …)`, which `blob-list.ts:49` already exports and `object-verbs.ts:905` already uses. Proper fix: a `chats/index.json` summary carrying exactly `chatSummary`'s eight fields (`admin-agent-chat.ts:221-231`), so listing never touches a transcript.
*Files:* `packages/core/server/lib/agent/chat-store.ts`, `packages/core/server/functions/admin-agent-chat.ts`.
*Risk:* Low for the concurrency change; medium for the index (same drift argument as R3, but far lower stakes — a stale chat title is cosmetic, a stale approval state is not).
*Where:* **T5.1.**

**R10 — Throttle the `last_seen_at` write. (F11)**
`invitations.ts:692-695` writes on every `me`. Skip the write when `last_seen_at` is within the last hour. Keeps the semantics ("when was this person last here") while removing two blob writes from every admin page load.
*Files:* `packages/core/server/lib/membership/invitations.ts`.
*Risk:* Low — the field is used for presence display, not for authorization.
*Where:* **T5.1.**

**R11 — Cheap lock refresh. (F9)**
`ObjectWorkspace.tsx:564-581` should poll something lock-shaped, not the whole record. Either add a lock-only read, or back off to 15 s and merge it into the existing `useChat` poll cadence.
*Files:* `packages/core/admin/ObjectWorkspace.tsx`, possibly a narrow verb in `object-verbs.ts`.
*Risk:* Low.
*Where:* **Free during T2.3.**

**R12 — `useMemo` the toast context value. (F16)**
`overlays.tsx:312`: `value={useMemo(() => ({ toast }), [toast])}`.
*Files:* `packages/core/admin/overlays.tsx`. *Risk:* none. *Where:* anywhere.

---

## 4. Top 5 causes

**1. `admin-release-state` is a full store sweep plus uncached third-party calls, and four call sites hit it with no sharing.**
`packages/core/server/functions/admin-release-state.ts:46-51` (own inventory sweep), `:56-58` (2 Netlify API calls), `:66-73` (one GitHub `/compare` per distinct publish commit, uncached, via `production-release.ts:146-178`). Called from `AdminHome.tsx:132`, `ContentLibrary.tsx:184`, `ObjectWorkspace.tsx:506`, `ObjectBrowser.tsx:117` — the last two on the *same page load*.
*Fix:* module-scope TTL + in-flight dedupe in `release-client.ts` (mirroring `library-client.ts:135-146`); a ≤15 s per-instance server memo on the handler; a permanent memo on commit ancestry, which is immutable data.
*Win:* **≈1.5–3 s off `/admin` and `/admin/content`; ≈3–5 s off `/admin/content/<id>`** (it is called twice there and sits on the serial critical path). Reduces GitHub API consumption from K-calls-per-page-view to near zero.

**2. The object workspace's mount is a three-hop serial waterfall with no data dependencies.**
`packages/core/admin/ObjectWorkspace.tsx:490-520` — `getObjectRecord` (`:498`) → `fetchReleaseOverview` (`:506`) → `validate` (`:514`), with `setLoading(false)` at `:511` sitting *after* the second hop. Both #2 and #3 need only `typeRef.current` and `loc.id`, known at `:491-492`.
*Fix:* one `Promise.all`; paint on `record` alone and let readiness/release state land progressively.
*Win:* **3 → 1 round trips, ≈1.5–3 s off first paint.** Combined with cause #1 the workspace goes from ~4 sweeps to ~1.

**3. Every object-store read is `13 × list()` + `N × get()` of whole record envelopes.**
`packages/core/server/lib/object-verbs.ts:888-907` (inventory) and `packages/core/server/lib/object-validation-context.ts:185-220` (validation context, which `admin-object.ts:99-111` builds for `validate` because `object-verbs.ts:391-413` does not exempt it). Each `get` pulls the full `body` node tree plus unbounded `history` to derive ~15 scalars (`object-inventory.ts:148-189`).
*Fix:* a writer-maintained `objects/index.json`, exactly as `admin-requests.ts:157` + `requests/store.ts` already do for requests — read one blob, rebuild once on miss, stamp `rebuilt: true` so drift is visible. Also exempt `validate` from the full context sweep where the verb only needs the self-record.
*Win:* **N objects → 1 blob read** instead of 13 + N. At N=200 that is ~213 reads → 1, per sweep, and there are 2–4 sweeps per admin page load.

**4. The admin's own buttons hard-reload the document, defeating the router it already ships.**
22 call sites: `AdminShell.tsx:321,331,341,469,477`; `RequestsWorkspace.tsx:158,169,398`; `AdminHome.tsx:44`; `ObjectWorkspace.tsx:728,770`; `AgentsHub.tsx:505`; `Studio.tsx:378,583`; `useRequestNotifications.tsx:60`; and others. `Layout.astro:44` already mounts `<ClientRouter fallback="swap" />`, so `<a href>` navigation preserves the module registry — and `library-client.ts`'s memory cache and `use-current-user.ts`'s snapshot with it. Every `window.location.assign` throws all of that away, re-runs the `AdminLayout.astro:175` auth gate, and re-fires every mount fetch cold.
*Fix:* `navigate()` from `astro:transitions/client`, keeping `AdminShell.tsx:311` (logout) and `:272` (welcome gate) as deliberate hard reloads.
*Win:* **cold mount → warm mount on every in-app jump, ≈1–3 s each.** It is also the precondition that makes any client cache — hand-rolled or TanStack — actually pay off across navigations.

**5. Three independent poll chains per page, no `ETag` anywhere, and `me` writes on every read.**
`AdminShell.tsx:215` (15 s `listRequests`) + `RequestsWorkspace.tsx:328` (5 s `listRequests`, same endpoint) + `RequestActivity.tsx` via `requests-client.ts:293` (3 s, two CMS-Agent MCP calls per tick at `admin-request-activity.ts:186-193`, full node tree every time). Zero `ETag` headers exist in `server/functions/` — every tick re-serialises and re-transfers identical JSON. Compounding it, `admin-users.ts:275-280` → `invitations.ts:692-695` turns the `me` read into **two blob writes** on every page load, and `AgentsHub.tsx:307` fires it a second time on that surface.
*Fix:* one shared request-list store driving both consumers (R7); `ETag`/`304` + `Cache-Control: private, no-cache` on the polled handlers; `since_seq` on `admin-request-activity` (copy `chat.tsx:147`, which already does this correctly); throttle `last_seen_at`.
*Win:* **≈50 % of steady-state requests, ≈80–95 % of steady-state bytes, and 2 blob writes off every page load.**

---

## 5. The SWR-layer recommendation — is "TanStack Query + one aggregate endpoint per view" right here?

**Short answer: the aggregate endpoints are right and should be built. TanStack Query is the wrong *first* move, and adopting it before R4 and R2/R3 would buy almost nothing while adding a dependency and a rewrite.**

### What this codebase actually is

Not "a single React SPA island per route" — and not a persistent shell either. It is a third thing the plan does not have a slot for:

- `Layout.astro:20,44` mounts `<ClientRouter fallback="swap" />`. AdminLayout inherits it. So a sidebar navigation is a **client-side body swap**: the document, the `window`, and the **ES module registry survive**. A module-scope cache written on `/admin` is still populated when `/admin/content` hydrates.
- But each route is a **separate `client:load` island** (`requests.astro:14`, `agents.astro:17`, `index.astro:18`, `content/index.astro:15`, `content/[objectId].astro:22`), each mounting its own `AdminShell`. So the **React tree is destroyed and rebuilt** on every navigation. Component state does not survive; module state does.
- And **22 in-app buttons call `window.location.assign`** (F14), which destroys even the module state.

So there is no persistent React root to hang a `QueryClientProvider` on. A `QueryClient` created inside a route island is born empty on every navigation and buys **nothing across routes** — the plan's own worry, and it is correct as far as it goes. But the plan draws the wrong conclusion from it, because it assumes hard navigations. The real situation is: **a module-scope client survives navigations today, and a per-island one does not.** That is a placement question, not a library question.

And placement is already solved, twice, in this repo without TanStack: `library-client.ts:49-50` (module cache + in-flight dedupe + `sessionStorage` mirror) and `use-current-user.ts:15-70` (module snapshot + in-flight dedupe + `useSyncExternalStore` + event-driven invalidation). Both survive `ClientRouter` swaps. `use-current-user.ts` in particular is, functionally, a single-key TanStack Query — subscription, dedupe, invalidation and all — in 97 lines.

### Why TanStack Query first would underdeliver

1. **It cannot fix the top two causes.** Causes #1 and #2 are a server-side sweep and a client-side `await` chain. A query cache does not turn three serial awaits into one, and it does not stop `admin-release-state` from sweeping the store. `Promise.all` and a server memo do.
2. **Its cross-navigation value is gated on R4.** Until the 22 `window.location.assign` calls become `navigate()`, the cache is destroyed on exactly the transitions where a cache would matter most (Cmd-K → object, request row → chat, request row → article). Do R4 first and *any* module-scope cache — including the two that already exist — starts paying. Do TanStack first and it inherits the same destruction.
3. **It duplicates working code.** Migrating `library-client` and `use-current-user` to TanStack is churn across every admin surface with no behavioural win; both already do dedupe, TTL and invalidation, and `library-client` additionally does `sessionStorage` stale-while-revalidate (`:98-102`), which TanStack needs a persister plugin to match.
4. **The hard part here is not client caching.** It is that `N objects → 13 + N blob reads` (cause #3) and that four call sites independently trigger a GitHub-fanout endpoint (cause #1). Both are server-side. A client cache hides them from a *repeat* view; it does nothing for the first view, which is the one editors experience.

### What I recommend instead

**Phase 1 — make caching worth having (no new dependencies).**
R4 (`navigate()`), R1 (`Promise.all`), R2 (dedupe + memo `admin-release-state`), R10 (`last_seen_at`). All four are small, local, and independently shippable. After R4 the two existing module caches start surviving in-app jumps, which is most of what an SWR layer would have delivered.

**Phase 2 — build the aggregate endpoints (§6).** This is the plan's genuinely correct instinct. It removes round trips *and* server work at once, which no client library can.

**Phase 3 — one shared client store, and only then decide on TanStack.**
Generalise `use-current-user.ts`'s shape into a tiny module-scope keyed store (`~120 lines`: key → `{data, fetchedAt, inflight, listeners}`, plus `useSyncExternalStore`). Mount it at **module scope, not inside an island**, so it survives `ClientRouter` swaps. Give it TTL, in-flight dedupe, event invalidation (`cms:login`/`cms:logout` already exist), and `sessionStorage` persistence for the two large slow keys (inventory, release overview).

Adopt TanStack Query **only if** one of these becomes true: (a) the admin consolidates onto a single persistent island so a `QueryClient` genuinely outlives routes; (b) you need infinite queries, optimistic-mutation rollback, or a devtools story that hand-rolled code cannot match; (c) the hand-rolled store's key count passes ~10 and its invalidation graph stops fitting in one file. Today none of the three holds. If TanStack *is* adopted, the non-negotiable detail is: **`new QueryClient()` at module scope, exported as a singleton, `<QueryClientProvider client={sharedClient}>` inside each island** — a per-island client is the failure mode the plan correctly fears, and it is easy to write by accident.

**Verdict on the plan's prescription:** half right. *"One aggregate endpoint per view"* — **yes, build it, it is the highest-value item after the serial-waterfall fix.** *"TanStack Query"* — **not yet, and not as the first move.** The blocker is not the absence of a query library; it is (a) the admin hard-reloading past its own router and (b) the server doing O(N) blob reads per view. Fix those two and the existing 200 lines of hand-rolled caching cover the need. Adopting TanStack first would produce a large diff, a new dependency, and a cache that is still thrown away on every button click.

---

## 6. Aggregate-endpoint proposal

One endpoint per surface, each replacing a fan-out of independent calls. All four should carry `ETag` + `Cache-Control: private, no-cache` (R8) and should be backed by R3's `objects/index.json` so the server cost is O(1) blob reads rather than O(N).

### 6.1 `POST /.netlify/functions/admin-requests-view`

Subsumes: `admin-requests {action:'list'}` ×2 (`AdminShell.tsx:199`, `RequestsWorkspace.tsx:313`), `admin-requests {action:'notify_ack'}` (`useRequestNotifications.tsx:113`), and — on the detail route — `admin-request-activity` (`RequestActivity.tsx:500`).

```jsonc
// request: { filters?: {status?, kind?, mine?, archived?, q?}, request_id?: string,
//            since_seq?: number, ack?: Record<string,string> }
{
  "seq": 4812,                       // client sends it back as since_seq; unchanged ⇒ 304
  "rows": [ /* RequestRowView[] — unchanged shape (requests-client.ts:27-40) */ ],
  "total": 37,
  "counts": { "working": 2, "needsYou": 1, "stalled": 0 },   // was summarizeRequestRows() client-side
  "notify": { "muted": [...], "last_notified": {...}, "email_mode": "immediate", "first_contact": false },
  "poll_after_ms": 5000,             // server decides cadence (requests-client.ts:148-152 moves server-side)
  "activity": null | { /* ActivityView, delta'd by since_seq — only changed nodes */ }
}
```
Notes: `counts` folds `summarizeRequestRows` server-side so the shell needs no second call. `ack` piggybacks on the poll instead of being its own POST. `poll_after_ms` lets the server damp the cadence under load — today the client hardcodes it. `activity` being in-band is what collapses three poll chains into one.
*Server cost:* 1 BR (index) + 1 BR (notify) + 1 BR (seen) + 2 MCP (only when `request_id` is set and the run moved). **~16 req/min → ~12, and 3 chains → 1.**

### 6.2 `POST /.netlify/functions/admin-agents-view`

Subsumes: `admin-agent-chat {action:'list_chats'}` ×2–3 (`AgentsHub.tsx:303,310,319`), `admin-users {verb:'me'}` (`AgentsHub.tsx:307`), and the first `get_chat` (`chat.tsx:147`).

```jsonc
// request: { active_chat_id?: string, since_seq?: number }
{
  "me": { "email": "...", "roles": ["owner","admin"], "display_name": "...", "avatar_artifact": "..." },
  "chats": [ /* ChatSummaryView[] — chat-client.ts:70-80, already scoped by resolved role */ ],
  "active": null | { /* ChatView delta: seq, events>since_seq, pending?, candidate_set?, agent, request? */ },
  "starters_allowed": ["article","page",...],   // was AGENT_STARTERS.filter(ownerOnly) client-side
  "poll_after_ms": 1200
}
```
Notes: `me` in-band removes the duplicate `fetchMe` (F6) *and* the visibility round trip that currently serialises the second `list_chats` (F5) — the server knows the caller's roles at `admin-agent-chat.ts:297` before it lists, so it returns the correctly-scoped list **once**. `active` preserves the existing `since_seq` delta, which is the one thing on these surfaces already done right.
*Server cost, with R9's `chats/index.json`:* 1 BR (index) + 1 BR (active chat) + 1 BR (user). **From `2×(1 BL + C BR)` down to 3 BR.**

### 6.3 `GET /.netlify/functions/admin-editorial-view`

Subsumes: `admin-object {action:'inventory'}` (`AdminHome.tsx:131`), `admin-release-state` (`:132`), `admin-agent-chat {action:'list_chats'}` (`:133`), and the shell's `admin-users {verb:'me'}`.

```jsonc
{
  "me": { "email": "...", "roles": [...], "display_name": "...", "onboarding": {...}, "require_display_name": true },
  "foundation": {                       // exactly the three FoundationSlots (AdminHome.tsx:206-229)
    "site":            { "row": {...}|null, "state": "published", "work": {...}|null },
    "editorial_voice": { "row": {...}|null, "state": "draft",     "work": null },
    "visual_identity": { "rows": [...],     "state": "review",    "work": null, "theme_count": 3 }
  },
  "families": {                         // exactly the five FamilySummary counts (AdminHome.tsx:237-279)
    "pages": 12, "navigation": 1, "templates": 6, "media": 48, "content": 31
  },
  "deploy": { "configured": true, "state": "ready", "live_commit": "...", "production_confirmed": true },
  "attention": { "needs_you": 1, "stalled": 0, "working": 2, "pending_approval": 3 }
}
```
Notes: **this endpoint should not return a row array at all.** `AdminHome` renders three slots and five integers — it currently downloads the entire inventory, the entire release overview and the entire chat list to compute eight numbers and three rows. Deriving them server-side is the single largest payload reduction available on any surface. `attention` also feeds the shell's three pills (`AdminShell.tsx:396-419`), removing the shell's separate `listRequests`.
*Server cost, with R3 + R2:* 1 BR (object index) + 1 BR (request index) + 1 BR (chat index) + 1 BR (user) + memoized deploy/ancestry. **From `2 sweeps + 1 chat sweep + 2 Netlify + K GitHub` down to 4 BR.**

### 6.4 `POST /.netlify/functions/admin-content-view`

One endpoint, two modes — the library and the workspace share almost all of their data, and today each re-fetches it independently.

**Library mode** — subsumes `admin-object {action:'inventory'}` (`ContentLibrary.tsx:158`) + `admin-release-state` (`:184`):
```jsonc
// request: { mode: "library" }
{
  "rows": [ { "object_id": "...", "object_type": "page", "display_name": "...",
              "updated_at": "...", "state": "published",        // editorial state folded in
              "readiness": "ready", "unpublished_changes": false } ],
  "type_counts": { "page": 12, "content_item": 31, ... },
  "deploy": { "state": "ready", "live_commit": "..." }
}
```
The row is trimmed to precisely the seven fields `LibraryTable` renders (`ContentLibrary.tsx:63-127`) — today it receives the full `InventoryRow` **and** a parallel full release-overview to merge one enum per row.

**Workspace mode** — subsumes `admin-object {action:'get'}` (`ObjectWorkspace.tsx:498`), `admin-release-state` (`:506`), `admin-object {action:'validate'}` (`:514`), `admin-agent-chat {action:'create_chat'}` (`:539`), `admin-object {action:'get', taxonomy}` (`:233`), `admin-agent-chat {action:'list_profiles'}` (`:396`), and `ObjectBrowser`'s whole triple (`ObjectBrowser.tsx:115-118`):
```jsonc
// request: { mode: "workspace", object_id: "...", object_type?: "..." }   // type resolved server-side
{
  "record": { /* full ObjectRecord — the workspace genuinely edits it */ },
  "release": { "state": "review", "review_state": "open", "approval_state": "approved_stale",
               "requires_approval": true, "can_publish": false, "can_approve": true },
  "readiness": { "ready": false, "criteria": [ {...} ] },
  "chat_id": "chat_...",
  "agent": { "assigned_profile_id": "...", "profiles": [ {"profile_id","name","status"} ] },
  "taxonomy": { "categories": [...], "tags": [...] },
  "browser": { "rows": [ /* the trimmed library rows above, for the tree */ ] },
  "lock": { "held": false }            // poll THIS shape at 4s, not the whole record (F9)
}
```
Notes: `object_type` resolution moves server-side, removing the first serial hop (`ObjectWorkspace.tsx:529`) for bare deep links. `can_publish`/`can_approve` are already decided server-side elsewhere in the codebase (`admin-request-activity.ts:213` does exactly this for approvals) — folding them in here means the UI can never offer a control the server would refuse, which is also a T0.3 finding. `lock` is broken out as its own key so the 4 s poll can request `{mode:"workspace", only:["lock"]}` instead of the whole envelope.
*Server cost, with R3 + R2:* 1 BR (object index) + 1 BR (the record) + 1 BR (chat) + 1 BR (governance) + memoized deploy. **From ~4 sweeps + 4 Netlify + 2K GitHub, three of them serial, down to ~5 BR in one round trip.**
