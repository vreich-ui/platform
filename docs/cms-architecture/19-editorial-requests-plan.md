# 19 — Editorial requests: progress, resumability, notifications (W19)

> **Status (2026-08-22):** W19 plan, commissioned by Wolf ("editorial admin AI chat improvement … the article drafting progress is not shown, there is no notifications … an editor should be able to close the window and still get back to the request … a list of running reqs, a logical intuitive way to get back to any of the reqs from one place"). Execution rows: `cms-pipeline/queue.tsv` (T19.x), briefs `cms-pipeline/T19.*.md`, run order in §10. Wolf's four scoping answers (§9) are **governing** under R8; the remaining defaults are rulings-by-default and are overridden by a queue comment, not a re-plan.

**Scope:** the editorial request lifecycle end-to-end — the registry that makes a job a first-class object, the one surface that lists every job, the chat that can talk about any one of them, and the three notification channels — across `packages/core` and all four `sites/<client>` tenants (drlurie, platform, fernwell, zilberman).
**Audience:** Wolf + the agent that picks up the W19 rows.

---

## 0. Executive summary

The machinery an editor needs already runs. **What is missing is the record of it and the reporting on it.**

An article is produced by a CMS-Agent `publishing_conductor` workflow run: 23 nodes, `input_triage → … → draft_writer → the four reviews → article_body → publish_payload → publication_controller`. Platform starts it from admin chat with `run_workspace_workflow`, which mints a request id (`req_agent_<slug>_<yyyymmdd>_<nn>`) and hands it to CMS-Agent. CMS-Agent then advances the run **on its own continuation driver** — a real production run completes eleven nodes without Platform touching it. Chat runs are already durable too: the loop lives in a Netlify background function driven by a one-shot trigger token, so closing the browser never kills a run.

So the substrate is right. Everything an editor actually experiences is wrong:

| # | Finding | Severity |
|---|---|---|
| F1 | **A finished run says nothing.** `ChatThread` renders `run_finished` as `null` (`admin/chat.tsx`). The only progress signal in the whole product is a pulsing dot with "Working…" while `status` is `queued`/`running`. When the run ends the dot disappears and the transcript is unchanged — indistinguishable from success, failure, and budget exhaustion. | **Blocker** |
| F2 | **The chat's own budget ends turns mid-job, silently.** `RUN_CAPS` (`agent/loop.ts`) is 12 provider turns / 16 tool calls / 60 k output tokens, and the loop stops starting turns with <60 s of the invocation left. `finishRun(…, 'caps', …)` then sets the doc back to `idle`. An article that needs more polling than that leaves the editor looking at an idle chat with no explanation and no way to know the job is still alive. | **Blocker** |
| F3 | **Nothing watches the job after the chat stops.** `run_workspace_workflow` advances a run for `WORKSPACE_RUN_BUDGET_MS` (45 s) per call and returns; CMS-Agent self-advances after that, but when a node **fails** the run stops dead and nobody is told. Live evidence from production on the day this plan was written: one `publishing_conductor` run failed at `reader_simulation` (`model_error`) leaving seven nodes queued; an earlier one failed at `article_body` (`output_validation_failed`); a third sits `blocked` at `publication_controller` with `approval_required` — waiting for a human who has no idea. | **Blocker** |
| F4 | **No registry ties the pieces together.** The request id is minted in `mintWorkspaceRequestId` and then survives only inside one `tool_result` event in one chat doc. CMS-Agent's `workflow_list_runs` rows carry `runId`/`workflowId`/`projectId`/`status`/`nodes` — **no request id and no originating chat**. Nothing in the system can answer "what is req_agent_x doing, who asked for it, and where is the conversation." | **Blocker** |
| F5 | **The list that exists is a chat list, in one page.** `/admin/agents` (`AgentsHub.tsx` `HubBody`) lists chat docs with a status pill and outcome chips, newest-updated first. No progress, no filters, no search, no archive, no paging, and it is the only place the list appears. The shell's own "Working · N" / "Needs you · N" pills (`AdminShell.tsx`) link to `/admin/release`, which is not a request list. | High |
| F6 | **Requests are private to whoever started them.** `visibleChatDocs` filters by `created_by` unless an Owner passes `include_all`. A stalled article belonging to a colleague is invisible to the desk. | High |
| F7 | **Listing is O(N) blob reads, polled.** `listChatDocs` GETs **every** chat blob on every call; `AdminShell` polls it every 15 s per signed-in admin, and `AdminHome` and the hub each call it again. There is no index, no paging, no cap. This is already the cheapest thing that could break as chat volume grows. | High |
| F8 | **No notification of any kind, on any channel.** No mail provider exists anywhere in the repo (no resend/sendgrid/postmark/nodemailer/mailgun dependency, no mail seam). The only mail the platform sends is Netlify Identity's invite/recovery templates. | High |
| F9 | **No archive and no end state.** `chatDocSchema.status` has no archived value, nothing prunes, and events trim at 800→600 while docs live forever. There is no way to take a finished job out of the list. | Medium |
| F10 | **The chat manager has no idea which request it is discussing.** The only per-run context is `focus` — a free-text string ≤500 chars threaded to CMS-Agent as `context.focus`. Nothing tells the agent "this conversation is about req_x, which is stalled at `article_body` with `output_validation_failed`, 19 of 23 nodes done." | Medium |

**The fix is a registry, a sweeper, a surface, and a mail seam** — in that order. §3 defines the request object, §4 the surfaces, §5 the lifecycle and the sweeper that makes "close the window and come back" true, §6 the three notification channels, §7 the agent contract, §8 permissions and archiving, §9 the decisions taken by default, §10 the task breakdown, §11 the honest difficulty read.

---

## 1. Findings — evidence

Paths are under `packages/core/` unless stated.

### F1 — a finished run says nothing

- `admin/chat.tsx`, the timeline renderer: `if (event.type === 'run_finished') return null;`. The next branch renders `run_error`. So a run that completes, exhausts its caps, or is cancelled all leave the transcript byte-identical.
- The only live affordance is the composer-adjacent line: `status === 'queued' ? 'Waking the agent…' : 'Working…'` with `animate-pulse`. It is bound to the chat doc's status, not to any job the chat started.
- `runSummarySchema.chips` exists ("created X", "published Y") and is surfaced only on the hub's session list — never in the transcript the editor is actually looking at.

### F2 — the caps path is invisible

- `agent/loop.ts`: `RUN_CAPS = { maxProviderTurns: 12, maxToolCalls: 16, maxOutputTokens: 60_000, minRemainingMs: 60_000 }`; the drain loop stops on `overCaps || outOfTime` and calls `finishRun(doc, now, 'caps', runChips(doc, run))`, which sets `doc.status = 'idle'` (caps is grouped with `completed`).
- The background hop is one Netlify background invocation (15-minute ceiling). Article production regularly exceeds one hop's worth of polling — see the durations in F3 — so `caps` is the *normal* ending for a long job, not an edge case.
- A `caps` ending produces a `run_finished` event, which F1 renders as nothing.

### F3 — nothing watches the job

- `agent/tools.ts`: `WORKSPACE_RUN_BUDGET_MS = 45_000`. `run_workspace_workflow` either starts a run (`workflow_start_dry_run`) or advances one (`workflow_run_all`, `budgetMs`), then returns the `projectWorkspaceRun` projection (`run_id`, `status`, `live_output`, `stalled`, `driver_note`, `nodes[{id,status}]`).
- CMS-Agent's own driver (`lastDispatch.driver: "continuation_tick"`) keeps advancing between calls, and `workflow_list_runs` rows carry a `stall` block on running rows saying whether anything is really in flight. **Platform never reads either after the chat turn ends.**
- Node durations from a real run: `research` 48 s, `draft_writer` 51 s, `brief_architect` 33 s, the four reviews ~25–33 s each in parallel. A clean end-to-end article is minutes; a stalled one is forever.
- Terminal states seen in production: `failed` (node `errors: ["model_error", …]`), `blocked` (`approvalsRequired: [{ nodeId: 'publication_controller', type: 'approval_required', … }]`), `completed`, `cancelled`, `skipped`, `paused`. Each needs a different sentence to the editor; today they all produce silence.

### F4 — no registry

- `mintWorkspaceRequestId` (`agent/tools.ts`) mints `req_agent_<slug>_<yyyymmdd>_<nn>`, bumping `nn` while a `content_item` with that id already exists — so **the request id is also the eventual article object id**, and it is the key `list_artifacts_by_request` uses for media. It is the natural correlation key for the whole job; it is simply never persisted as one.
- `workflow_list_runs` (CMS-Agent) is paged, status-filterable, time-filterable and returns per-node state — an excellent progress source — but its rows have no `requestId` and no notion of who asked. Platform must own that mapping.

### F5–F7 — the surfaces

- `AgentsHub.tsx` `HubBody`: `listChats` on mount, re-listed when `chat.status` becomes idle/error/cancelled; renders title + `StatusPill` + kind badge + outcome chips. No progress, filter, search, archive or paging.
- `AdminShell.tsx`: every 15 s it calls `listChats` **and** `fetchInventoryRows`, feeds `getWorkSummary` (`lib/admin/work-summary.ts`), and renders `Working · N` / `Needs you · N` pills — both `href="/admin/release"`.
- `agent/chat-visibility.ts` is nine lines: `created_by` equality unless `includeAll && owner`.
- `agent/chat-store.ts` `listChatDocs`: `store.list({prefix, paginate:true})` then `store.get()` per key, parse, sort by `updated_at`. No index doc, no summary projection at rest.

### F8–F10 — notifications, archive, agent context

- Repo-wide: no mail dependency, no mail module, no template directory. `docs/cms-architecture/18-membership-plan.md` §4 documents Netlify Identity's own templates as the only mail path, and those are GoTrue's, not ours.
- `chatDocSchema.status` enum: `idle|queued|running|awaiting_approval|awaiting_candidate|error|cancelled`. No `archived`, no `done`.
- `agent/engine.ts` builds the CMS-Agent turn request with `...(run.focus ? { focus: run.focus } : {})`; `cms-agent-client.ts` bounds `context.focus` to 500 chars. That single string is the entire channel for telling the agent what this conversation is about.

---

## 2. What we keep

This wave adds one store, one scheduled function, one page and one mail seam. It **does not** rewrite the agent chat.

Kept byte-untouched in behaviour: the single-writer chat state machine and its one-shot trigger tokens (`agent/loop.ts`, T9.12/T9.13 mechanics); the approval card and `RunApprovalControls`; the chat-controls protocol; the CMS-Agent engine seam (`agent/engine.ts`); `run_workspace_workflow`'s dry-run-first approval discipline; the publish/release human gates. A request is a **record about** those things, never a second way to drive them.

---

## 3. The model — an editorial request is a first-class object

**Decision (Wolf, 2026-08-22): a request is the editorial job, not the conversation.** Chats attach to a request; a request outlives any chat, and a second conversation about the same article attaches to the same request.

### 3.1 Identity

`request_id` is the key, and it already exists: `req_<flow>_<topic>_<yyyymmdd>_<nn>`, minted by Platform, handed to CMS-Agent as `requestId`, reused as the `content_item` object id, and used by `list_artifacts_by_request` for media. W19 persists it instead of discarding it. Requests that are not workflow-backed (a page built from a template, a retheme, a media job) get the same id shape with a different `<flow>` segment and simply carry no `workflow` block.

### 3.2 Store

New per-site Netlify Blobs store `editorial-requests`, strong consistency, same conventions as `agent-chats`:

```
requests/by-id/<request_id>.json     EditorialRequest   (one doc per job)
requests/index.json                  RequestIndex       (bounded summary list — what the UI polls)
requests/notify/<person_id>.json     NotifyState        (per-person delivery + mute state, §6)
```

`requests/index.json` is what fixes F7: one blob GET per list call instead of N. It is written by the same single writer that writes the request doc, carries a monotonic `seq`, and holds only the projection the list needs. The per-id docs stay authoritative; a rebuild verb regenerates the index from them.

### 3.3 Schema (`editorial-request.v1`)

```ts
{
  schema_version: 'editorial-request.v1',
  request_id: string,                 // req_<flow>_<topic>_<yyyymmdd>_<nn>
  kind: 'article' | 'page' | 'section' | 'theme' | 'media' | 'capture' | 'other',
  title: string,                      // human, editable; seeded from the brief
  brief_excerpt?: string,             // first ~240 chars of the editor's own words
  created_by: string,                 // e-mail of the human who asked
  created_at, updated_at: string,

  status: 'queued' | 'running' | 'needs_you' | 'stalled' | 'failed'
        | 'done' | 'cancelled' | 'archived',
  status_reason?: string,             // one editor-facing sentence, always set for the four unhappy states

  workflow?: {                        // absent for non-workflow requests
    run_id: string, workflow_id: string, project_id: string,
    node_total: number, node_done: number, node_failed: number,
    current_node?: string,            // human label, not the raw id, where one exists
    stalled: boolean,
    approvals_required?: Array<{ node_id: string, reason: string, requested_at: string }>,
    errors?: string[],                // '<node>:<code>' verbatim from CMS-Agent
    last_polled_at: string,
    nudges: number,                   // §5.3 bounded auto-advance counter
  },

  chats: Array<{ chat_id: string, kind: 'object' | 'free', attached_at: string }>,
  object?: { object_type: string, object_id: string },   // once the article object exists
  artifact_count?: number,

  archived_at?: string, archived_by?: string,
  history: Array<{ at: string, status: string, note?: string }>,   // bounded to 50
}
```

`RequestIndex` rows are `request_id, kind, title, status, status_reason, created_by, updated_at, progress {done,total}, current_node, chat_id (most recent), object_id, archived`. Nothing else — the index must stay small enough to poll.

### 3.4 Who writes it

Exactly one writer per transition, the same discipline `agent/loop.ts` proved:

| Transition | Writer |
|---|---|
| create + first `queued` | the chat tool that starts the job (`run_workspace_workflow`, `instantiate_template`, …), inside the background hop |
| `running` / progress / `needs_you` / `stalled` / `failed` / `done` | the sweeper (§5.3), and only the sweeper |
| `cancelled` | the cancel path (chat cancel, or an explicit request cancel) |
| `archived` | the archive verb (§8) |
| chat attach | the chat send path, when a chat first references a request |

No other code path writes a request doc. A read is always allowed.

---

## 4. Surfaces

### 4.1 `/admin/requests` — the one place

The list Wolf asked for. A row is a request, not a chat.

- **Row:** status dot (a spinner for `running`/`queued`), title, kind chip, progress (`14 / 23 · drafting`) for workflow requests, who asked, relative age, and the one-sentence `status_reason` for anything unhappy.
- **Actions per row:** *Open* (mounts the request in the AI window, §4.2), *Open article* (when `object` is set), *Retry* (a stalled/failed workflow request — one bounded nudge or a node retry), *Archive*.
- **Filters:** status (a default of "everything except archived", exactly as Wolf specified), kind, mine/everyone, and free-text search on title and request id. Archived is reachable, never default.
- **Sort:** attention-first — `needs_you`, then `stalled`/`failed`, then `running`, then the rest by `updated_at`.
- **Data:** one `admin-requests` `list` call against `requests/index.json`, polled on the existing cadence (fast while anything is live, slow when nothing is).

The route is the destination for the shell pills, which stop pointing at `/admin/release`. A third pill, **Stalled · N**, joins them; all three deep-link to the matching filter.

### 4.2 The request in the AI window

Opening a request mounts its most recent chat in the chat surface (the hub's panel, or the workspace rail when the request has an object) with a **request header card** above the transcript:

- title, status pill, progress bar with the current node label, `status_reason`, and the blockers verbatim when `needs_you`;
- the actions that make sense for the state (Approve & continue, Retry, Open article, Archive);
- a *New conversation about this request* affordance, which mints a fresh chat **attached to the same request** — Wolf's "ask for another request … and inquire on all running requests" without cross-contaminating one transcript.

Deep links: `/admin/requests/<request_id>` opens it directly; `?request=<id>` on the hub does the same in place. Both are shareable and both survive a closed window, because the state lives in the store, not the tab.

### 4.3 Progress inside the transcript

Two changes, both small and both load-bearing:

1. A new persisted chat event `request_progress`, appended by the sweeper on every meaningful transition (node completed, node failed, approval required, run finished). It renders as a compact timeline line — so an editor who reloads sees the history of the job, not just its current state.
2. `run_finished` stops rendering `null`. It renders one line keyed on the outcome, and the `caps` case says the true thing: *"I paused this turn — the article job is still running. It will keep going; I'll report when it moves."*

---

## 5. Lifecycle

### 5.1 Status derivation

The sweeper maps CMS-Agent run state onto the editor-facing status. The mapping is the product decision; keep it in one pure, tested function.

| Source | Request status |
|---|---|
| run `queued`, or created and not yet dispatched | `queued` |
| run `running`, `stall.stalled` false | `running` |
| run `running`, `stall.stalled` true, or `updated_at` older than `STALL_AFTER_MS` | `stalled` |
| run `blocked`, or `approvalsRequired` non-empty | `needs_you` |
| run `paused` | `needs_you` |
| run `failed`, or any node `failed` with the run not advancing | `failed` |
| run `completed`, publish decision still outstanding | `needs_you` |
| run `completed`, nothing outstanding | `done` |
| run `cancelled` | `cancelled` |
| attached chat `awaiting_approval` / `awaiting_candidate` | `needs_you` (chat approval wins — it is the nearer gate) |

`status_reason` is always populated for `needs_you`, `stalled`, `failed`, `cancelled`, in editor language, from the blocker or node error verbatim where CMS-Agent already gives editor copy.

### 5.2 Stall, honestly

`stalled` must mean *nothing is happening*, not *this is slow* — a false stall is worse than no signal. Three inputs, all available: CMS-Agent's own `stall` block (its dispatch heartbeat), the node's `lastDispatch.dispatchedAt`, and time since `updated_at`. Default `STALL_AFTER_MS` = 10 minutes with no node transition **and** no live dispatch heartbeat. The existing `STALE_RUN_MS` (15 min, `agent/chat-store.ts`) governs chat-run takeover and is left alone.

### 5.3 The sweeper — why "close the window" starts working

`editorial-request-sweep` (scheduled) + `editorial-request-sweep-background` (the worker, so a slow CMS-Agent call cannot blow the scheduled invocation). Every 5 minutes, matching the `mcp-keepalive` precedent:

1. read `requests/index.json`; take the non-terminal requests (`queued|running|needs_you|stalled`);
2. for each with a `workflow` block, `workflow_get_run(run_id)` through the existing `CmsAgentClient`;
3. derive the new status (§5.1); if it changed, write the request doc, update the index, append `request_progress` to the attached chats, and enqueue notifications (§6);
4. if `stalled` and `nudges < MAX_NUDGES` (default 3), call `workflow_run_all` once with a bounded `budgetMs` and increment `nudges` — CMS-Agent's driver usually only needs a push;
5. never nudge a `blocked`/`needs_you` request. A human gate is a human gate.

This is the whole resumability story. The editor closes the laptop; the sweeper keeps the record true; the badge and the mail land when something changes; the request is exactly where they left it when they come back.

Bounded by construction: the index caps how many requests a sweep considers, each request costs one CMS-Agent read, and `MAX_NUDGES` caps the write side.

---

## 6. Notifications

**Decision (Wolf, 2026-08-22): all three channels.** They share one event source — the sweeper's status transitions — and one preference record. Notification-worthy transitions are: `→ needs_you`, `→ stalled`, `→ failed`, `→ done`. Nothing else notifies, ever.

### 6.1 In-app (no new infrastructure)

The shell already polls; it just polls the wrong thing. Swap `listChats` for the request index (one blob, not N), then:

- pills become **Working · N**, **Needs you · N**, **Stalled · N**, all linking to the matching `/admin/requests` filter;
- a toast when a transition arrives while the tab is open, with an *Open* action;
- the unread count in `document.title` (`(2) Admin — …`), cleared on visit.

### 6.2 Browser notifications

`Notification` API, permission requested **once**, from an explicit control on `/admin/requests` — never on load. Fired from the same poll, deduplicated against `NotifyState.last_notified` so a reload does not re-announce. Clicking opens the deep link.

Honest limit: this only fires while an admin tab is open somewhere. True closed-browser push needs a service worker, VAPID keys and a subscription store — out of scope for W19 and noted as the V2 follow-up.

### 6.3 E-mail — the new dependency

There is no mail provider in the platform today (F8). W19 adds a **seam**, not a vendor lock-in: `server/lib/mail/` with a `MailSender` interface (`send({to, subject, text, html, tags})`), one HTTP adapter (Resend — a plain `fetch` to one endpoint, no SDK, no bundle cost), and a `NullMailSender` used when unconfigured.

New env, and P2 says what that costs:

| Var | Class | Note |
|---|---|---|
| `MAIL_PROVIDER` | per-site | `resend` \| `none` (default `none` → the null sender) |
| `MAIL_API_KEY` | fleet-shared | provider key |
| `MAIL_FROM` | per-site | verified sender for that tenant's domain |
| `MAIL_REPLY_TO` | per-site, optional | defaults to `MAIL_FROM` |

Every one of these lands, **in the same change**, in the T11.7 env table, `ENV_CHECKLIST` (`packages/core/cli/create-site.mjs`), all four sites' env, and the probe's env→family map (`scripts/fleet-capability-probe.mjs`) under a new `mail` family added to `CAPABILITY_FAMILIES` and `capability-status.ts`. Unconfigured is a **catalogued degrade**, not a failure: `error_code: 'mail_not_configured'`, in-app and browser channels unaffected, and the capability probe reports it plainly.

Per-person preference on the W18 `Person` record: `notify: { email: 'immediate' | 'daily' | 'off', browser: boolean }`, default `immediate` for `needs_you`/`failed` and `daily` for `done`, editable on `/admin/profile`. A digest is one extra scheduled pass over the same transition log — build the immediate path first.

Mail content is deliberately thin: what happened, which request, one link. No article content in e-mail.

**This unblocks T17.10.** The W17 row "Notifications / digests" is a `checkpoint` parked on exactly the question Wolf answered here — *what is the delivery channel?* Its option (b) is this seam, with the same P2 cost accounted for once. When T19.7 lands, T17.10 becomes "marginalia digests over the W19 mail seam" and its checkpoint clears; it must not build a second mail path. Note it in the queue when T19.7 ships.

---

## 7. The agent contract

Wolf: *"the chat manager should be able to distinguish and start to communicate about a specific req whether it is old or new, running or stale or paused."*

### 7.1 Context injection

When a chat is attached to a request, `send` composes `focus` from the request record rather than the workspace's free text — inside the existing 500-char bound, e.g.

```
request req_agent_retinol_20260822_01 · article "Retinol after 40" · status stalled ·
19/23 nodes · last node article_body failed (output_validation_failed) · asked by vreich@…
```

No wire change: `context.focus` already exists and is already bounded (`agent/engine.ts`, `cms-agent-client.ts`). This is the cheapest high-value item in the wave.

### 7.2 Request tools

Added to the chat registry (`agent/tools.ts`) and mirrored in the MCP definitions, per fleet law — tool surfaces stay uniform across tenants:

| Tool | Class | Autonomy | Purpose |
|---|---|---|---|
| `list_requests` | read | auto | the same index the UI reads, filterable by status/kind/mine |
| `get_request` | read | auto | one request with progress, blockers and attached chats |
| `retry_request` | privileged | ask | one bounded nudge / node retry on a stalled or failed run |
| `archive_request` | privileged | ask | take a finished request out of the list |

Descriptions must state, in the first sentence, that these are *records about* jobs — an agent that wants to *advance* a job still uses `run_workspace_workflow`, and publishing is still a separate human decision.

### 7.3 What the agent must be told to say

The system prompt gains one paragraph: when a request is stalled or failed, say what stopped and offer the retry; when it is `needs_you`, say what the human has to decide; when it is running, give the node, not a reassurance. Prompt ownership stays with CMS-Agent (PF5) — this lands as a Client Manager prompt change coordinated in the same wave, not as a Platform-side system string.

---

## 8. Permissions and archiving

**Decision (Wolf, 2026-08-22): team-wide, Owner can archive.**

- **Read:** any signed-in admin sees every request on the site. The `mine` filter is a view, not a wall. This replaces `chat-visibility.ts`'s creator rule *for requests*; the underlying chat transcript keeps its own rule until T19.5 aligns them, and aligning them is an explicit step, not a side effect.
- **Archive / unarchive:** Owner (and, by the W18 tiers, `publisher`) only. Archiving never deletes: the doc stays, the index row carries `archived: true`, and the archived filter shows it.
- **Cancel:** the request's creator or an Owner.
- **Mute:** personal, always — muting affects your notifications and nobody's list.
- **Agents:** read tools are open to any principal that can already read the site; `retry_request` and `archive_request` are `ask`-gated writes under the run's human principal, exactly like every other privileged chat tool.

---

## 9. Decisions

Wolf answered four scoping questions on 2026-08-22; these are **governing**:

1. **A request is the editorial job**, tracked in its own registry, with chats attached to it (§3).
2. **Team-wide visibility**, with an Owner-gated archive (§8).
3. **All three notification channels** — in-app, browser, e-mail — which makes the mail provider and its fleet-wide env a first-class part of this wave (§6).
4. **Deliverable:** this plan plus the W19 queue rows and briefs.

Taken by default under R8, overridable by a queue comment:

- **D1** Sweep cadence 5 minutes (matches `mcp-keepalive`; 1 minute is available if the desk finds 5 too slow).
- **D2** `STALL_AFTER_MS` 10 minutes, `MAX_NUDGES` 3.
- **D3** Resend as the first mail adapter, behind the seam; the seam is what matters, the vendor is one file.
- **D4** Immediate mail for `needs_you`/`failed`/`stalled`, daily digest for `done`, per-person overridable.
- **D5** Web Push (closed-browser) is V2. W19 ships the `Notification` API path only, and says so in the UI.
- **D6** The request registry is per site. A fleet-wide "all my clients' requests" view is V2, consistent with `13-separation-plan.md`.
- **D7** Non-workflow requests (page from template, retheme, media) are registered from day one with no `workflow` block, so the list is genuinely "every request" and not "every article".

---

## 10. Task breakdown

| Task | What | Mode / model / effort |
|---|---|---|
| **T19.1** | Request registry: `editorial-requests` store, `editorial-request.v1` schema, index doc + rebuild, single-writer rules, mint-on-start wiring from the chat tools | notify / fable / xhigh |
| **T19.2** | `admin-requests` function (list/get/archive/cancel/mute) + typed client; index-backed listing replaces the shell's `listChats` poll | auto / opus / high |
| **T19.3** | The sweeper: scheduled + background functions, status derivation (pure, tested), stall detection, bounded nudge, transition log | notify / fable / high |
| **T19.4** | `/admin/requests`: list, filters, search, spinner, progress, row actions, empty/error states; shell pills re-pointed + Stalled pill | auto / opus / high |
| **T19.5** | Request-aware chat: header card, chat↔request attach, `focus` injection, `request_progress` rendering, the `run_finished`/`caps` copy fix, deep links | auto / opus / high |
| **T19.6** | In-app + browser notifications: `NotifyState`, badges, toasts, tab title, `Notification` permission flow, per-person prefs on `/admin/profile` | auto / sonnet / medium |
| **T19.7** | Mail seam + Resend adapter + templates + degrade path; env in the T11.7 table, `ENV_CHECKLIST`, all four sites, probe `mail` family, `capability-status` | auto / opus / high |
| **T19.8** | Agent + MCP surface: `list_requests`, `get_request`, `retry_request`, `archive_request`; contract entries; Client Manager prompt paragraph | auto / opus / medium |
| **T19.9** | Fleet parity: shims in all four `sites/<client>`, schedule blocks in all four `netlify.toml`, create-site template, `admin-parity` check | auto / sonnet / medium |
| **T19.10** | Backfill + records: register existing jobs from `workflow_list_runs` + chat docs, `object-inventory.md` row, `state-of-play.md` entry | auto / sonnet / low |
| **T19.11** | E2E + credentialed run: an article start-to-finish with the window closed mid-run, a forced stall, a forced failure, and all three notifications observed | notify / opus / high |

**Run order.** T19.1 gates everything. Then T19.2. Then **T19.3 and T19.4 in parallel worktrees** (disjoint: server sweeper vs the React surface). T19.5 after both. Then **T19.6 and T19.8 in parallel**. T19.7 may start any time after T19.2 (it only needs the transition source) but must land before T19.11. T19.9 after T19.7 (it carries T19.7's env rows). T19.10 second-to-last. T19.11 last, and its mail-domain verification is Wolf's hands.

**First light.** T19.1 → T19.5 alone delivers the whole experience Wolf described — the list, the spinner, resumability, progress in the transcript, and the in-app badge. T19.6 → T19.11 is the notification breadth and the fleet law.

---

## 11. How hard this is, honestly

**Possible: yes, and mostly already built.** The durable background loop, the one-shot trigger discipline, CMS-Agent's self-advancing driver with per-node state and a stall heartbeat, the scheduled-function precedent, the shell's 15-second poll and its two pills, the chat-controls protocol, `focus` on the wire, the OAuth human principal — every hard mechanism this feature needs is in the tree and proven in production. W19 is mostly wiring, plus one genuinely new dependency.

**The three real difficulties, in order:**

1. **The registry's write discipline (T19.1).** Netlify Blobs has no compare-and-swap; this is exactly why `agent/loop.ts` is a single-writer state machine instead of a CAS loop. The request doc has more writers than a chat doc does (a chat tool, the sweeper, a human archive) and needs the same rigour. This is the Fable/xhigh row for a reason, and everything downstream is easy or wrong depending on it.
2. **Honest status (T19.3).** "Stalled" that fires on a slow node trains editors to ignore it; "running" on a dead run is the bug we are fixing. The derivation has three inputs and must be a pure function with real fixtures.
3. **E-mail, because of fleet law (T19.7).** The sending code is an afternoon. P2 turns it into a wave item: four env vars × four tenants, the T11.7 table, `ENV_CHECKLIST`, the probe's family map, `capability-status`, a catalogued degrade, plus a verified sending domain per tenant — which is Wolf's clicks, not an agent's.

**Not hard, despite appearances:** resumability. Nothing needs to be made durable — it already is. The window closing was never what stopped the work; the absence of anyone watching was.

**Risk to watch:** F7's O(N) listing gets worse before it gets better if the index lands late. T19.2 must ship the index-backed list in the same change that adds a second poller, or the 15-second shell poll doubles.

---

## 12. What shipped

| Finding | Closed by |
|---|---|
| F1 — a finished run said nothing | ✅ `RunFinishedLine` (activity wave); the `caps` ending says the job continues |
| F2 — the caps path was invisible | ✅ same |
| F3 — nothing watched the job | ✅ T19.3 sweeper (away path) + `admin-request-activity` (watch path) |
| F4 — no registry tied the pieces together | ✅ T19.1 `editorial-request.v1` + the index |
| F5 — the list was a chat list, in one page | ✅ T19.4 `/admin/requests`, attention-first, filtered, deep-linkable |
| F6 — requests were private to their creator | ✅ T19.2, team-wide read (plan §8) |
| F7 — listing was O(N) blob reads, polled | ✅ T19.2, one index GET; a test pins it |
| F8 — no notification on any channel | ✅ T19.6 in-app + browser · T19.7 e-mail behind a seam |
| F9 — no archive, no end state | ✅ T19.1 `archived` + the archive filter |
| F10 — the agent had no idea which request | ✅ T19.5 `focus` injection · T19.8 `list_requests` / `get_request` |

### Decisions recorded along the way (R8)

- **D7, partly deferred.** Only `run_workspace_workflow` registers a request.
  It is the one chat tool that starts work an editor then waits on; template
  instantiation, retheme and media jobs complete inline and have no `req_…`
  id of their own yet. They register when that minting is designed.
- **The e-mail preference lives on the W19 `NotifyState` doc**, not the W18
  `Person` record as §6.3 said. Same per-person key, already exists, already
  holds the mute list — every notification setting in one place, and no
  membership-schema migration.
- **T19.8c: `get_request_activity`.** Found in use, not in review. Asked "where
  is it up to?", the client manager could only say "still running, no errors
  reported" — because `get_workspace_run` handed it node ids and states and
  nothing else, and the request status says `running` without saying which of
  twenty-three steps. The activity projection the Requests page already draws
  its timeline from is now behind a chat tool, narrowed for a persisted tool
  result: every step in order, in editor words, with what it produced, how long
  it took against how long it usually takes, its warnings and its errors. The
  result carries a `how_to_answer` line — a tool description is read once at
  wire time against eighty others; a line inside the result is read at the
  moment it matters. `get_workspace_run`'s node projection gained the step
  label and timestamps for the same reason.
- **The MCP mirror of the request tools is deferred** to its own row (T19.8b).
  The chat surface answers the stated need ("inquire on all running requests");
  the MCP mirror serves external agents, is purely additive, and did not
  justify growing an already large change.
- **The per-person notification doc is split three ways, by writer.** One
  document had three writing components — the person's own settings, every
  open tab's delivery ack, and the sweeper's mail ledger. On a store with no
  compare-and-swap that is a read-modify-write race *between* components, not
  within one: a mute could be silently reverted by the person's other tab, and
  the mail ledger clobbered mid-send so the same e-mail went twice. Now
  `notify/` holds settings, `notify-seen/` the browser ledger, `notify-mailed/`
  the mail ledger, and each has exactly one writer. A pre-split doc is still
  read as the fallback for both ledgers, so nobody is re-notified about
  something they were already told.
- **`daily` is accepted but not offered.** The mail-mode API and the stored
  schema still take it, so an older setting keeps parsing, but no digest pass
  exists yet and `shouldMailNow` therefore treats it as silence. Offering it in
  the UI would be offering silence under another name, so `/admin/requests`
  offers two options — when a job needs me or stops, and never. The digest is
  T19.11's.
- **`retry_request` is `stalled` and `failed` only.** It refuses a `running` or
  `queued` request: there is nothing to retry on a job that has not stopped,
  and rewriting a live row's status from the human path can land inside a
  sweep's load→commit window and lose one of the two writes. §3.4's writer
  assignment is what makes the whole registry safe without CAS; a retry button
  is not worth an exception to it.
- **The backfill archives only rows it owns.** Every W19 request leaves the
  same `run_workspace_workflow` result in its chat — that is how one starts —
  so age alone would have buried live requests that had been sitting at an
  approval gate longer than the cutoff, permanently, since the sweeper skips
  archived rows. A row qualifies only if this run created it or a previous
  interrupted run left it untouched at `queued`, and the dry run now names
  every already-registered row it would file away rather than counting them.
- **First contact acks in silence.** An empty ledger and a never-written one
  look identical on the wire, and the browser treats every difference as news —
  so the day this ships, and every new team member's first visit, would have
  stacked a toast and a desktop notification for every finished, failed and
  waiting job on the site. The list response flags first contact and the first
  ingest records without announcing.
- **The conversation tool bound moved 64 → 96**, on both sides. Platform's
  registry had reached exactly 63 + the learning-mode tool: the old ceiling
  with no headroom, so the next capability added would have been silently
  sliced off the wire. Platform falls back to 64 once, automatically, if it
  meets a server still on the old bound.

### Still open

T19.9's remaining scope is absorbed (shims, schedule blocks, scaffold, probe
family and env all landed with the rows that needed them). T19.11 — the
credentialed end-to-end run, including the per-tenant mail domain verification
— is Wolf's, and is the wave's last step.
