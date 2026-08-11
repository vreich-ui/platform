# CMS-Agent-Backed Admin Conversations — Roadmap

**Status:** IN PROGRESS. **CA track complete and deployed (2026-08-09/10). PF track not started.**
**Last verified:** 2026-08-10 against CMS-Agent main `3047992`, platform main `f819fe5`, and a live `agent_resolve` probe of the deployed Cloud Run MCP endpoint.
**Companion:** `cms-agent-chat-plan.md` (architecture — read first; this file only sequences it), `cms-agent-chat-done-criteria.md` (acceptance), `cms-agent-chat-STATE-2026-08-10.md` (evidence for the status below).
**Repos:** `vreich-ui/CMS-Agent` (CA track) and `vreich-ui/platform` (PF track). Two repos, one program — cross-repo dependency order is explicit below.

## Progress at a glance

| Track | State |
|---|---|
| CA1–CA5 + turn GC + deploy wiring | ✅ **done, merged, deployed** — see §CA track for commits |
| CA6 prompt parity | ⛔ **new, blocking required-mode cutover** |
| CA7 GC evidence producer + scheduling | ☐ new, non-blocking |
| PF0 scoped-token ops | ☐ **new, blocks PF2 integration proof** — Wolf, ~15 min |
| PF1–PF6 | ☐ not started — no commit, branch or file exists on drive or remote |

**Resume here:** PF0 (ops) in parallel with PF1 (client), then PF2. CA6 must land before any site flips to `required`.

**Program discipline (same as the completed admin-redesign program):** one bounded task per commit, commit messages prefixed with the task ID (`CA1:` / `PF2:` …); a 10–20-line implementation note naming expected files **before** each milestone, reviewed before coding; `npm run check` + `npm run test` (Platform) / `npm run test` + `npm run verify:deploy` (CMS-Agent) per milestone; all three Platform sites (`drlurie`, `fernwell`, `platform`) must build on every Platform milestone; browser evidence where a surface changes; **stop/review gates** (marked ⛔) between irreversible stages. Platform work: branch `codex/cms-agent-chat`; CMS-Agent work: PR-per-wave onto `main` (its auto-deploy trigger fires on main — an unreviewed push is a deploy, so nothing merges without the gate).

---

## Dependency graph

```
✅ CA1 ─ ✅ CA2 ─ ✅ CA3 (contract frozen in code, G1 unsigned) ─ ✅ CA4 ─ ✅ CA5 ─ ✅ turn GC ─ ✅ deployed
                                                     │
   ⛔ CA6 prompt parity ──────────────────────────────┤  (must land before any site flips to `required`)
   ☐ CA7 GC evidence producer + schedule ────────────┘  (non-blocking)

☐ PF0 scoped-token ops (Wolf) ──┐
☐ PF1 MCP client ───────────────┼─▶ ☐ PF2 TurnEngine seam ─▶ ☐ PF3 failure semantics
                                │        (integration proof ⛔ G2)
                                │                    ▼
                                │     ☐ PF4 orchestration tools (optional before cutover)
                                │                    │
                                └────────────────────┼─▶ ☐ PF5 staged cutover: platform → fernwell → drlurie
                                     (+ CA6)         │        (⛔ G3 per site, ⛔ G4 before drlurie)
                                                     ▼
                                              ☐ PF6 legacy retirement (⛔ G5)
```

Deployment ordering rule: **CMS-Agent lands and deploys first at every seam** (its changes are additive and dark until Platform calls them); Platform integrates second behind `CMS_AGENT_CHAT_MODE=off`; cutover is a config change, not a deploy; retirement is the only destructive commit and comes last.

---

## CA track — CMS-Agent repo — ✅ COMPLETE (2026-08-09/10)

All of CA1–CA5, the turn GC and the deploy wiring landed on `main` and are live. Milestone specs are retained below as the record of intent; the **as-built** deltas are captured in `cms-agent-chat-plan.md` §5A and the state report.

| Milestone | Commit (PR) | Notes on what actually shipped |
|---|---|---|
| CA1 turn records + repositories | `ed6bae0` (#116) | `src/agent/conversations/*`, blob + memory `ConversationTurnRepository`, 200-turn bound with `trim_marker` |
| CA1.2 terminal-status reconcile | in CA1 | now `HALTED_EXECUTION_STATUSES` in `executionTypes.ts:11`, consumed at `executor.ts:587`. **Nit left behind:** `tools.ts:36` still holds a third local `HALTED_RUN_STATUSES` array — fold it in opportunistically |
| CA1.3 `run_node.dependencies` | in CA1 | **removed** from `runNodeInput` (`tools.ts:121`) rather than wired — the honest option, as specified |
| CA2 `client_manager` + `agent_resolve` | `a00a127` (#117) | seeded into the workspace doc as `conversationalAgents[]`, ledgered `agent.seeded`, project-neutrality asserted by test |
| CA3 runner + `agent_converse` + contract | `641f9d8` (#118) | contract committed at repo **root** as `CLIENT-MANAGER-CONTRACT.md`, still marked "G1 REVIEW REQUIRED" |
| CA4 scoped bearer tokens | `56f1d03` (#119) | single env var `MCP_SCOPED_TOKENS_JSON`; see PF0 for the exact format |
| CA5 fernwell registration | `89c2921` (#120) | read-only tool set, `FERNWELL_MCP_ENDPOINT`/`FERNWELL_MCP_TOKEN`; **ships no publish executor** despite `publishEnabled: true` |
| Turn GC | `d16365e` (#121) | supersession-aware, dry-run by default — but **inert in production**, see CA7 |
| Deploy wiring | `4b7ca48` (#122), `eca2201` (#123), `17ac6e2` (#124) | secrets merged in; `/health` route; build now fails on a health-probe error |

**Live check any time (free, read-only):** `agent_resolve {role:"client_manager", project_id:"platform"}` → `agt_client_manager@1`, model `gpt-4.1`, status `active`.

### CA6 — Prompt parity ⛔ **NEW — blocks required-mode cutover**

**In plain terms.** Every time an editor sends a message today, Platform writes the agent a fresh job briefing. Over time that briefing accumulated the house rules: don't call something "Live" unless a deployment actually confirms it; don't show editors raw object ids, version numbers, internal schemas or model names; if the Owner explicitly asked for diagnostics, relax that for this one run; if a human declines something, adjust rather than re-submit the same call; when learning mode is on, offer 2–3 versions using this specific tool. The new design hands briefing duty to CMS-Agent, whose own permanent prompt takes over — but that prompt is currently four short paragraphs and contains none of those rules. Flip the switch as-is and the agent quietly forgets the house rules: editors start seeing raw ids and "gpt-4.1", and hearing "it's Live" when it is only published.

**What it delivers.** Required-mode cutover becomes safe. It also promotes these rules from something frozen in Platform's code into part of the agent's own definition — so they apply to every client automatically, appear in the change ledger when edited, and can be improved by the learning machinery like any other prompt.

**Why (technical).** Platform's `systemPrompt()` (`loop.ts:100-127`) has grown since the plan was written and now carries governance the four-paragraph `client_manager` prompt does not. Under the engine seam Platform stops sending its own system prompt (single prompt owner, by design), so these would be **silently dropped**:

- precise lifecycle vocabulary (Draft / Approved / Published / Live, and that publishing never proves Live without deploy evidence);
- the editor-facing-language rule — no raw ids, revision/version numbers, private strategy or intent, hidden prompts, internal schemas, **provider or model names**, credentials;
- the Owner-only `diagnostics_requested` branch that relaxes the above for one run;
- denial handling ("never re-submit the same call");
- focus is presentation context, never authorization;
- the learning-mode instruction naming `present_candidates` and its exact-args requirement.

**What needs to happen.** `CA6.1` port these into the canonical `client_manager` prompt in `agentDefinitions.ts`, keeping it project-neutral (the existing `not.toMatch(/dr-lurie|fernwell|platform/i)` test must still pass) and bumping `rev`. Add `diagnostics_requested` to `conversationContextSchema` as an optional boolean so the Owner branch is reachable — this is an **additive** contract change and must be versioned as such. `CA6.2` tests asserting each governance block is present in the assembled prompt, and that `diagnostics_requested: true` selects the relaxed branch. Update `CLIENT-MANAGER-CONTRACT.md` in the same commit.
**Model/effort:** Terra + high (prompt governance; a silent omission here is a live data-leak path).

### CA7 — Make the turn GC real ☐ (non-blocking)

**Why.** The GC is correct but currently a **no-op by construction**: nothing in `src/` ever calls `recordConversationTurnSupersession` or `recordConversationTurnReference`, so every turn evaluates `no_supersession_evidence`. It is also manual-CLI-only (`npm run job:conversation-turn-gc`), dry-run by default, and absent from every cloudbuild/scheduler file. Wolf's retention decision is documented but not operating.
**Tasks.** `CA7.1` an evidence producer — decide and implement where supersession is recorded (candidate: on `agent_converse` completion, when a later turn in the same conversation demonstrably supersedes an earlier one; or an explicit MCP tool the learner calls). `CA7.2` schedule the job (Cloud Scheduler → Cloud Run Job) with `--apply`, starting at a conservative `--max-deletes`. `CA7.3` a test that evidence written by the producer is actually consumed by the GC end to end.
**Model/effort:** Terra + medium.

### CA track — original milestone specs (retained for the record)

### CA1 — Turn records, actor, hygiene
**Goal:** somewhere durable and attributed for conversational turns to land; the two known traps closed before anything builds on them.
**Tasks/commits:**
- `CA1.1` `ConversationTurnRecord` type + `ConversationRepository` interface + GCS-backed impl (`registerCmsAgentStoreFactory` pattern), bounded per conversation (N=200, trim marker). Files: `src/agent/conversation/turnTypes.ts` (new), `src/agent/repository/interfaces/ConversationRepository.ts` (new), `src/agent/repository/blobs/BlobConversationRepository.ts` (new), `RepositoryManager` wiring.
- `CA1.2` Reconcile `TERMINAL_STATUSES` into one exported constant (`executor.ts:94` vs `runConductorJob.ts:18` disagree today) — prerequisite hygiene for any future status work, zero behavior change asserted by test.
- `CA1.3` Fix the dropped `workflow.run_node.dependencies` parameter (P6.2's latent bug): wire through `RunAdvanceOptions` into input assembly **or** remove from schema — decide in the implementation note; silently ignoring it stays forbidden.
**Model/effort:** Terra + high. **Tests:** repository CRUD + bounds + CAS; terminal-status equivalence; run_node dependencies reach node input (or schema no longer advertises them).

### CA2 — `client_manager` agent definition + seed
**Goal:** the project-neutral agent exists, store-backed, discoverable, deletion-guarded — no hardcoded ids anywhere.
**Tasks/commits:**
- `CA2.1` Conversational-agent object type (id, name, prompt, modelConfig, status, rev) in the workspace store, outside `publishingConductorNodes` and outside the conductor overlay; canonical seed with a project-neutral prompt; deletion guard (the `default_project_protected` pattern).
- `CA2.2` `agent_resolve` MCP tool (role + project_id → agent_ref/rev/status), resolution order per plan §5.2.
**Model/effort:** Terra + medium. **Tests:** seed idempotency; resolve returns canonical; unknown role/project → typed errors; workspace change-ledger records prompt edits with actor.

### CA3 — Conversational runner + `agent_converse` ⛔ **G1: contract freeze**
**Goal:** one model turn, pass-through tools, idempotent, attributed, metered. **This milestone must not weaken the schema-bound path** — new runner entry point, zero edits to `OpenAINodeRunner`/`AnthropicNodeRunner` dispatch semantics or `executor.ts` validation.
**Tasks/commits:**
- `CA3.1` `ConversationalRunner`: prompt assembly (canonical prompt + project knowledge/voice from the registry + `context` block), provider resolution via the existing `providerRegistry` (both OpenAI and Anthropic paths — tools are passed through, never executed, so the Anthropic tool-loop gap does not apply), timeout, usage capture.
- `CA3.2` `agent_converse` MCP tool: `.strict()` zod input (`client_manager.turn.v1`), idempotent replay on duplicate `(conversation_id, turn_id)`, turn-record persistence, `ModelUsageRecord` with `{conversationId, turnId, siteId}` metadata, error taxonomy per plan §5.5.
- `CA3.3` Contract document committed to the CMS-Agent repo (`docs/platform/CLIENT-MANAGER-CONTRACT.md`) — request/response schemas, error codes, bounds, idempotency. **⛔ G1: Wolf reviews and freezes the contract here; PF2 onward builds against the frozen version.**
**Model/effort:** Sol + high (the load-bearing new mode). **Tests:** two-turn memory via supplied transcript; tool defs surface as `tool_calls` unexecuted (both providers); duplicate turn returns cached response without a second model call (mock provider asserts call count); schema-bound node regression suite passes byte-identically; transcript bound enforcement; actor lands on turn records.

### CA4 — Scoped tokens, manifest, deploy
**Goal:** per-tenant credentials with tenant isolation; the surface ships.
**Tasks/commits:**
- `CA4.1` Scoped bearer tokens: token record → `{projects, toolAllowlist}`, enforced in `mcpEndpoint.authenticate`; `project_id` in a call must be within the token's scope. Existing `MCP_API_TOKEN` and OAuth paths unchanged.
- `CA4.2` `npm run drift:update` (manifest + surfaceHash for `agent_converse`/`agent_resolve`); extend `verify:deploy` to assert `agent_resolve` returns the canonical agent; cloudbuild secrets wiring for the three per-site tokens (**merge-style `--update-secrets` only** — the `--set-env-vars` wipe has happened twice; the deploy doc line is part of the commit).
**Model/effort:** Terra + high (auth). **Tests:** scoped token cannot call outside its allowlist or project; unscoped legacy token unaffected; manifest verify green.

### CA5 — Fernwell project registration (independent; anytime before its cutover stage)
`project.create` (or seeded module) for `fernwell`: `FERNWELL_MCP_ENDPOINT`/`FERNWELL_MCP_TOKEN` env names, dialect, publishing policy, Cloud Run env/secrets. **Model/effort:** Terra + medium. **Tests:** `repository_get_health` clean, `verify:deploy` reports the connection.

---

## PF track — Platform repo — ☐ NOT STARTED

Verified 2026-08-10: no PF commit, branch, or file exists on `origin/main`, on any local branch, in either worktree, or in the stash. `loop.ts:392` still calls `deps.adapter(...)` directly. The four planning docs are also **not** in `docs/admin-redesign/` — commit them first so Codex runs can cite them by path (the `CODEX-HANDOFF.md` loop assumes docs live in the repo).

**Good news for the estimate:** the frozen contract fits Platform's existing seams almost exactly. `WireTool { name, description, input_schema }` (`provider.ts:26-30`) is byte-identical to CMS-Agent's `conversationToolSchema`, and the `ProviderAdapter` signature `{system, transcript, tools} → {text?, toolCalls, outputTokens}` maps 1:1 onto `agent_converse`'s response. PF2 is a small, well-bounded change at one call site.

### PF0 — Scoped-token provisioning ☐ **NEW — Wolf, ~15 min, blocks the PF2 integration proof**

**In plain terms.** CMS-Agent has one master key today (`MCP_API_TOKEN`) that opens all 137 tools and every client's workspace. Handing that to three client websites would mean any one of them could reach into any other client's data — unacceptable. CA4 already built the limited-key system: a key can be stamped with which client it may act for and which tools it may call. PF0 is simply cutting the three keys and handing one to each site. Nothing is designed or coded here; it is a console task.

**What it delivers.** The client sites can talk to CMS-Agent at all — without it the Platform code can be written but never proven against the real service, so the G2 integration proof cannot happen. It also delivers hard tenant isolation as a side effect: Dr. Lurié's site is structurally incapable of acting as Fernwell, enforced at the door rather than by careful coding.

**What needs to happen.** Mint three opaque bearers (no whitespace, not equal to `MCP_API_TOKEN`) and set Secret Manager secret **`mcp-scoped-tokens-json`** to exactly this shape — the parser is strict (exactly the two keys `projects` and `toolAllowlist`, underscore tool names only, unique entries, `projects` matching `^[a-z0-9][a-z0-9-]{1,62}$`) and a malformed value fails the whole scoped path closed with no diagnostic:

```json
{
  "<bearer-platform>": { "projects": ["platform"], "toolAllowlist": ["agent_resolve","agent_converse"] },
  "<bearer-fernwell>": { "projects": ["fernwell"], "toolAllowlist": ["agent_resolve","agent_converse"] },
  "<bearer-drlurie>":  { "projects": ["dr-lurie"], "toolAllowlist": ["agent_resolve","agent_converse"] }
}
```

Then per Netlify site set `CMS_AGENT_MCP_ENDPOINT` (the Cloud Run `/mcp` URL), `CMS_AGENT_MCP_TOKEN` (that site's bearer) and `CMS_AGENT_CHAT_MODE=off`. Redeploy CMS-Agent so the new secret version is picked up (merge-style flags only). Optional: set `MCP_SCOPED_MCP_TOKEN` + `MCP_SCOPED_PROJECT_ID` in the operator shell so `npm run verify:deploy` exercises the scoped path.

### PF1 — `cms-agent-client.ts` — contract is frozen; build against it directly
**Goal:** a real Streamable-HTTP MCP client — the thing `pdf-tool-client.ts` is not.
**Tasks/commits:**
- `PF1.1` `packages/core/server/lib/agent/cms-agent-client.ts`: `initialize` handshake, `Mcp-Session-Id` propagation, `DELETE` on close, protocol-version header, `AbortController` timeouts (default 90s), typed error mapping, config from **new `SiteBindingEnvNames` keys** (`CMS_AGENT_MCP_ENDPOINT`/`CMS_AGENT_MCP_TOKEN`/`CMS_AGENT_CHAT_MODE`) read at call time, payload sanitizer (bearer + token-shaped keys) on every log/return path. Unconfigured → typed `cms_agent_not_configured`, never a throw at import time.
- `PF1.2` `create-site.mjs` + `admin-parity.mjs` env catalog entries; `site-identity.ts` gains `cmsAgentProjectId` (all three sites).
**Model/effort:** Terra + high. **Tests:** handshake/session/DELETE against a local mock server; timeout/abort; sanitizer; unconfigured behavior; no new value reachable from client bundles (extend the protected-env guard test).

### PF2 — TurnEngine seam ⛔ **G2: integration proof**
**Goal:** the chat loop's provider call becomes an interface; the CMS-Agent engine implements it; nothing below the seam changes.
**Tasks/commits:**
- `PF2.1` Extract `TurnEngine` from the `adapterForProfile`/`adapter.chat` call site in `loop.ts`; `providerEngine` wraps the existing adapters byte-identically (golden-transcript test).
- `PF2.2` `cmsAgentEngine`: builds `client_manager.turn.v1` from the run, calls `agent_converse` via PF1, maps response to the loop's expected shape; `ChatRun` gains `engine` + `agent_ref` (schema-additive, old docs parse); mode resolution `governanceOverride ?? env ?? 'off'`.

**As-built constraints this engine must satisfy — each verified against the deployed contract, all cheap to design in and expensive to discover at integration time:**

| # | Constraint | Consequence for `cmsAgentEngine` |
|---|---|---|
| 1 | `actor` is `{kind:"human", id}` — **strict**, no `email` field | Strip `principal.email`. Email-shaped `actor.id` is rejected (`invalid_turn_request`) |
| 2 | `actor.id` has `min(1)`, and `admin-agent-chat.ts:206` can produce `''` | Guard: refuse to start the turn with a clear error rather than sending an empty id |
| 3 | The idempotency claim is written **before** project/agent validation | After any validation-class failure, mint a **fresh `turn_id`**; reuse one only for a true transport retry. Reusing after `unknown_project`/`invalid_turn_request` returns `conflict` forever |
| 4 | Transcript ≤200 messages **and** ≤256KB serialized | Trim oldest-first before send (Platform already trims its own event log; this is a second, separate bound) |
| 5 | A `tool` message must answer a tool call in the **immediately preceding** assistant message | Preserve adjacency when trimming — never orphan a tool result |
| 6 | `constraints` is required: `max_tokens` ≤32000, `timeout_ms` ≤120000 | Send explicitly; the agent clamps to 16000 / 90s anyway |
| 7 | `context.object_type` and `object_id` must be sent together or not at all | Free chats send neither |
| 8 | `tools` ≤64 entries, ≤256KB; `description` `min(1).max(16000)` | Platform's 19 tools fit; assert non-empty descriptions in a test |
| 9 | Errors are read at `error.data.error.code`; wrong-project and bad-token are an **identical opaque 401** | Map to `cms_agent_auth_failed` without claiming to know which |
| 10 | `agent_ref` must resolve via `agent_resolve` and is not truly opaque (`agt_client_manager[@rev]`) | Cache per site with short TTL; re-resolve on `agent_unresolved` |
| 11 | `agent_rev` is a **number** in the response, a **string** in CMS-Agent's record | Store whichever you prefer, consistently; don't assume symmetry |
| 12 | OpenAI tool-call args that fail to parse degrade silently to `{}` | Platform's `tool.parse` will reject — ensure that surfaces as a normal tool error, not a crash |
| 13 | CMS-Agent owns the system prompt; Platform stops sending one | **Depends on CA6.** Do not flip any site to `required` until prompt parity lands |

**Model/effort:** Sol + high (the architectural run of this program). **Tests:** with a mocked `agent_converse`: full two-turn chat with an `ask` tool → approval card → approve → resume, transcript and events byte-compatible with the provider path; `auto` tool execution and write-refresh events unchanged; run caps still enforced; mode `off` leaves the provider path untouched; plus one test per constraint 1–8 above. **⛔ G2: live integration proof on a staging/branch deploy of the `platform` site against the deployed CMS-Agent — a real conversation with a real approval — reviewed by Wolf before any cutover work.**

### PF3 — Failure semantics, health, and honest UX
**Tasks/commits:** `PF3.1` required-mode fail-fast (`run_error` with `cms_agent_*` codes, human copy, chat remains usable, retry works); `fallback` mode emits a loud `engine_fallback` event; memoized health probe surfaced on an owner surface; send-time `cms_agent_not_configured` clear error. **Model/effort:** Terra + medium. **Tests:** downtime (connection refused), timeout, malformed response, auth failure, missing env — each produces its named code, no silent provider fallback in `required`, and a subsequent send succeeds when the service returns.

### PF4 — Workspace orchestration tools (P3.1's surviving half; before or during cutover, Wolf's call)
**Tasks/commits:** `PF4.1` `list_workspace_nodes` (read/auto) + `run_workspace_workflow` (privileged/ask, dry-run = input echo, riskLevel→autonomy floors: publish/admin never auto and excluded from the safe-run allow-list) + `get_workspace_run` (read/auto, bounded projection — never the ~500KB full record); raw CMS-Agent output rendered in a collapsed disclosure (P3.2's surviving idea); Guardrails catalog picks the tools up automatically. **Model/effort:** Terra + high. **Tests:** risk floors; dry-run card content; long-run polling across turns; blocked run surfaces as Needs-you.

### PF5 — Staged cutover ⛔ **G3 per site, G4 before drlurie**
**Prerequisites: PF0 done, CA6 landed and deployed.** Per site, in order **platform → fernwell (CA5 ✅ done) → drlurie**:
1. Set mode `fallback` (endpoint + token already set by PF0); deploy; soak (defaults: 3d/2d/5d — Wolf sets) with required evidence: `engine_fallback` count = 0, turn latency and cost sampled.
2. Flip governance override to `required`; authenticated browser walkthrough of **every** admin chat entry point (Object Room rail, Templates workspace rail, AgentsHub free chat) covering: two-turn memory, an approval cycle, a denial, a cancel, an error injection.
3. ⛔ **G3:** evidence reviewed, explicit go before the next site. ⛔ **G4:** before drlurie, additionally review cost per conversation and CMS-Agent usage rollups (the money-attention gate).
**Model/effort:** Terra + medium (ops + evidence). Rollback at any point: governance override → `off` (instant), env default corrected at next deploy.

### PF6 — Legacy retirement ⛔ **G5**
After all three sites soak clean in `required`: remove the `providerEngine` path from the chat loop (`loop.ts` no longer imports provider adapters — guard test), remove `fallback` mode, update docs (`CLAUDE.md`, `docs/agents/*`, admin-plan register), re-label the profile roster per the product decision in plan §14.2. `provider.ts` itself remains until the Ask-AI scope decision. **Model/effort:** Terra + medium. ⛔ **G5: Wolf approves the removal commit explicitly — this is the point of no cheap return.**

### PF7 (unscheduled, pending plan §14.1) — Ask-AI chips via `agent_converse`; `run-publisher-agent` disposition.

---

## Milestone → expected-files quick index

| Milestone | Repo | Principal files |
|---|---|---|
| CA1 | CMS-Agent | `src/agent/conversation/*` (new), `src/agent/repository/*`, `executor.ts`, `runConductorJob.ts`, `mcp/workspace/tools.ts` |
| CA2 | CMS-Agent | workspace store seed module (new), `mcp/workspace/tools.ts` (agent_resolve) |
| CA3 | CMS-Agent | `src/agent/execution/runners/ConversationalRunner.ts` (new), `mcp/workspace/tools.ts` (agent_converse), `docs/platform/CLIENT-MANAGER-CONTRACT.md` (new) |
| CA4 | CMS-Agent | `mcp/http/mcpEndpoint.ts`, `runtime/auth.ts`, `docs/mcp-tool-manifest.json`, `scripts/verifyDeployment.ts`, `cloudbuild.deploy.yaml` |
| CA5 | CMS-Agent | `src/agent/projects/defaultProjects.ts` (or live `project.create`), Cloud Run env/secrets |
| CA6 | CMS-Agent | `src/agent/conversations/agentDefinitions.ts`, `conversationContract.ts` (additive `diagnostics_requested`), `CLIENT-MANAGER-CONTRACT.md`, tests |
| CA7 | CMS-Agent | evidence producer (site TBD), `src/agent/entrypoints/conversationTurnGcJob*.ts`, Cloud Scheduler config |
| PF0 | ops | Secret Manager `mcp-scoped-tokens-json`; Netlify env per site |
| PF1 | platform | `packages/core/server/lib/agent/cms-agent-client.ts` (new), `site-binding.ts`, `sites/*/config/site-identity.ts`, `cli/create-site.mjs`, `cli/admin-parity.mjs` |
| PF2 | platform | `packages/core/server/lib/agent/loop.ts`, `engine.ts` (new), `chat-store.ts` (additive fields), `governance-store.ts` (mode override) |
| PF3 | platform | `loop.ts`, `admin-agent-chat.ts`, owner health surface, tests |
| PF4 | platform | `packages/core/server/lib/agent/tools.ts`, `chat.tsx` (disclosure rendering) |
| PF6 | platform | `loop.ts`, guard test, docs |
