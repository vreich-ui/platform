# CMS-Agent-Backed Admin Conversations — Architecture Plan

**Status:** ACCEPTED — **CMS-Agent side built and deployed 2026-08-09/10; Platform side not started.**
**Date:** 2026-08-09, revised 2026-08-10 against the as-built implementation.
**Verified against:** `vreich-ui/platform` main `e0c8827` (architecture audit) and `f819fe5` (2026-08-10 re-check); `vreich-ui/CMS-Agent` main `c519f02` (audit) and `3047992` (as-built), plus a live `agent_resolve` probe of the deployed Cloud Run endpoint.
**Companions:** `cms-agent-chat-roadmap.md` (execution order and current progress), `cms-agent-chat-done-criteria.md` (acceptance), `cms-agent-chat-STATE-2026-08-10.md` (state evidence), and the mirrored CMS-Agent handoff.

> **PF5 amendment (2026-08-18).** Admin chat is permanently Client
> Manager-only. The transitional `off → fallback → required` ladder and its
> provider rollback have been retired. `CMS_AGENT_MCP_ENDPOINT` and the
> per-site scoped `CMS_AGENT_MCP_TOKEN` are mandatory; missing or unhealthy
> CMS-Agent configuration fails closed with a coded chat error. Historical
> mode fields remain readable only so existing governance documents parse.

> **Reading order note.** §5 below is the *designed* contract. It shipped essentially intact, but the implementation is stricter in several places and differs in a few. **§5A records the as-built deltas and is authoritative where the two disagree.**

---

## 1. Requirement

Every Platform admin conversation runs through CMS-Agent. No normal admin chat silently falls back to Platform's generic provider loop. One reusable, project-neutral client-management agent (`client_manager`) serves every tenant; tenant identity, project id and object context come from configuration; nothing client-specific in shared code; integration lands in `packages/core/**`; credentials never reach the browser; existing object-scoped conversations, approvals, permissions, locking, lifecycle refresh and agent-rail UX are preserved; missing or unhealthy CMS-Agent configuration fails clearly; existing autonomous, schema-bound CMS-Agent nodes are unaffected.

## 2. Verified current architecture (condensed; file-level)

### Platform (`e0c8827`)

- The admin chat is entirely home-grown. Loop: `packages/core/server/lib/agent/loop.ts`; persistence: Netlify Blobs store `agent-chats`, one `ChatDoc` per chat (`packages/core/server/lib/agent/chat-store.ts`); endpoints: `packages/core/server/functions/admin-agent-chat.ts` (13 actions) + `admin-agent-chat-run-background.ts` (15-min background hop, trigger-token protocol); UI polls `get_chat?since_seq` (1.2s/2s/5s).
- Providers are called **directly**: `packages/core/server/lib/agent/provider.ts` — `new Anthropic(...)` (:106), `new OpenAI(...)` (:188), keys from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Provider+model come from the resolved `AgentProfile` (`profiles.ts`, seeds `prof_site_default_anthropic` / `prof_site_default_openai`).
- 18 CMS tools execute **in-process** (`tools.ts` → `ToolContext.verb` → `handleObjectVerb`); autonomy resolves `profileOverrides ?? governance.chat_tools ?? classDefault`; `ask` tools pause the run with `pending {call_id, tool, args, args_hash}` and `status: 'awaiting_approval'`; approve re-verifies `args_hash` (`forged_resume` 409), executes inline under the **run's human principal with roles re-resolved fresh**, and re-queues the background hop. Chat kinds are exactly `object | free` (`chat-store.ts:180`); chat statuses `idle|queued|running|awaiting_approval|awaiting_candidate|error|cancelled` (:187).
- UX invariants a replacement backend must satisfy: `ObjectWorkspace` refreshes the object on any non-error `tool_result` whose `detail.tool` is in `WRITE_TOOLS` (`ObjectWorkspace.tsx:508-520` via `useChat.writeStamp`); lock icon re-polls every 4s while a lock is visible; `resultObjectRef` stamps created-object routing onto `tool_result` events; `ApprovalCard` renders `pending.summary` + args + dry-run; `AgentRail` safe-run mode auto-approves an allow-list client-side.
- Multi-tenancy: env-var **names** per site via `SiteBinding` (`site-binding.ts` — "names, never values; read at call time"), committed non-secret identity in `sites/<site>/config/site-identity.ts` (precedent: `pdfToolProjectId`). Outbound-client precedent: `pdf-tool-client.ts` (single-POST JSON-RPC, config from env names, 503 `pdf_tool_bridge_not_configured` when unset, payload sanitizer).
- **P3.1/P3.2 have not landed** — no `cms-agent-client.ts`, no `run_workspace_node`/`list_workspace_nodes` tools, no `node:` chat kind, no `CMS_AGENT_*` env name anywhere. `client_manager` appears nowhere in either repo.
- Two other direct-provider surfaces exist outside the chat loop: `admin-ask-ai-object.ts` (canvas chips) and `run-publisher-agent.ts` (`@openai/agents`). See §14 (open questions).

### CMS-Agent (`c519f02`)

- The starting finding is **confirmed**: nodes are one-shot, schema-bound JSON executions. Output is forced (`OpenAINodeRunner.ts:193` json_schema output type; `AnthropicNodeRunner.ts:91-92` forced `emit_output` tool), validated twice (runner + `executor.ts:893-908`), and prose fails closed as `output_schema_violation`. No message/turn/thread entity exists anywhere in `src/` (`awaiting_input`, `messageHistory`, `client_manager`: zero hits). `resume_run` carries only `{runId, budgetUsd}` (`tools.ts:125`). `workflow.run_node`'s `dependencies` parameter is parsed and silently dropped (`tools.ts:120` vs handler) — the latent bug P6.2 names.
- Run model: `WorkflowExecutionRecord` statuses `queued|running|paused|completed|failed|blocked|cancelled`; CAS `rev` + per-run mutex; **`requestId` is the documented Platform↔workspace join key**; `run.projectId` required. Runs carry **no actor** — `WorkspaceActor {kind: human|agent|system}` exists only for workspace mutations, stamped from the `x-workspace-actor` header ("attribution, not authorization").
- MCP: Streamable HTTP, POST+DELETE only (GET → 405), sessions `mcps_*` (30-min idle / 12-h max), protocol versions 2025-06-18 / 2025-03-26. Auth: workspace-wide `MCP_API_TOKEN` bearer **or** OAuth 2.1 — **no per-caller or per-project tool scoping**; the only lever is deployment-wide `MCP_EXPOSED_TOOL_PREFIXES`. 135-tool manifest is CI-locked (`docs/mcp-tool-manifest.json` `surfaceHash`; `npm run drift:update`; `npm run verify:deploy`).
- Multi-client: `ProjectConnectionConfig` registry (`dr-lurie`, `platform`, `pdf-tool`, `monetizer` — **no `fernwell`**), env-var-name pattern, per-project hooks behind `getProjectHooks`; generic core never imports a client folder. Executor injects `clientProjectId` into every node input and refuses an empty `run.projectId`.
- Deployment: Cloud Run service `cms-agent-mcp` (auto-deploy on push to main; merge-style `--update-env-vars`/`--update-secrets` mandatory — `--set-env-vars` has wiped client vars twice) + Cloud Run Job for long conductor runs; `GET /healthz` unauthenticated.

## 3. Options considered

**Option A — CMS-Agent hosts the conversation.** The chat run (transcript, awaiting state, tool execution) moves into CMS-Agent; Platform becomes a rendering proxy; tenant tools execute via CMS-Agent's outbound `project.call_tool` against each tenant's `/mcp`. This is the literal reading of the expected 10-step sequence. Rejected as V1: it re-implements, on the CMS-Agent side, machinery that is mature and security-load-bearing on the Platform side — per-editor principal execution with fresh role re-resolution at approval time, `args_hash` forged-resume protection, dry-runs computed by the tool implementations themselves, lock-token threading, write-refresh eventing, per-user chat visibility — and it doubles every tool call's network path (Platform → CMS-Agent → Platform `/mcp`). It also requires migrating or dual-homing every existing chat transcript, makes editor attribution at the object store depend on new tenant-MCP actor plumbing, and puts the human-facing wait state behind a poller with no push channel. Each of those is solvable; together they are months of risk on the critical path to the actual requirement, which is about **who reasons**, not **where the transcript sits**.

**Option B — CMS-Agent owns the mind, Platform keeps the hands (RECOMMENDED).** The chat loop's *provider adapter* is replaced by a CMS-Agent **conversational turn call**. Platform keeps: transcript persistence, the tool registry and in-process execution, autonomy/approval/locking/visibility, the background-hop machinery, and all UI. CMS-Agent gains: a first-class, project-neutral `client_manager` agent definition (prompt, model config, skills — managed and improved through the existing workspace machinery), a conversational runner mode that executes **one model turn with pass-through tools** (it never executes tools itself), per-turn persistence for learning and audit, actor attribution on turns, and per-tenant scoped credentials. In required mode Platform makes **zero** direct Anthropic/OpenAI calls for admin chat — every turn of every admin conversation is reasoned by CMS-Agent's agent, with CMS-Agent's prompt, model policy, budget metering and learning capture. This is not "a generic model interpreting node output": the model call itself happens inside CMS-Agent, under CMS-Agent's agent definition; Platform supplies context and executes the resulting tool calls under its own law.

**Option C — P3.1/P3.2 as written (node tool + `node:` chat kind).** Confirmed insufficient alone, exactly as the handoff suspected: it leaves Platform's generic provider loop as the conversationalist and adds CMS-Agent as a callee. It does not satisfy "every admin chat uses CMS-Agent." Its useful half (server-side MCP client; workspace orchestration tools with risk mapping) survives inside Option B as PF1 and PF4.

**Why B is the pushback the handoff invited.** The expected sequence's steps 2, 3 and 5 (persistent turns *in CMS-Agent as the wait-state of record*, input-bearing resume *of a run*, queryable waiting-run polling) exist to let a CMS-Agent-hosted conversation wait for a human. Under B the conversation waits where it already waits today — in Platform's `ChatDoc` — so those steps shrink to: turn *records* (not wait states) in CMS-Agent, and idempotent turn submission. The full awaiting_input/resume machinery remains the right design for the **workflow** human-in-the-loop track (P6.1–P6.4, unchanged in scope, decoupled from this cutover). Smaller surface, fewer irreversible schema changes, no transcript migration, and the requirement is met in full.

## 4. Target architecture

```
Browser (admin rail)                    Platform (Netlify fns, packages/core)                 CMS-Agent (Cloud Run)
────────────────────                    ─────────────────────────────────────                 ─────────────────────
ChatThread / ApprovalCard  ──poll──▶    admin-agent-chat.ts        (unchanged actions)
                                        chat-store.ts              (ChatDoc = authority)
                                        loop.ts                    (turn driver, approvals)
                                          │ TurnEngine seam (new)
                                          └─ cmsAgentEngine ────MCP agent_converse────▶      conversational runner
                                               (the only admin-chat engine)                    client_manager agent def
                                                                                              (store-backed: prompt,
                                                                                               modelConfig, skills)
                                        tools.ts + ToolContext     (tool exec stays local)    turn records + usage
                                        site-binding (env NAMES)                              project registry (knowledge)
```

**One chat turn (happy path).** `send` → Platform resolves profile/governance/autonomy/principal, stamps the run, queues the background hop (all unchanged) → background hop calls `TurnEngine.turn()` → `cmsAgentEngine` opens/reuses an MCP session and calls `agent_converse` with `{agent_ref, project_id, conversation_id, turn_id, actor, context, messages, tools, constraints}` → CMS-Agent's conversational runner assembles the prompt (canonical `client_manager` prompt + project knowledge/voice + Platform's context block), calls the configured provider **with the tool definitions passed through, executing none**, persists a turn record + usage, returns `{assistant_text?, tool_calls?, usage, agent_rev}` → Platform appends to the transcript and drains `call_queue` exactly as today: `auto` tools execute in-process; `ask` tools mint the pending approval card; approve/deny/resume unchanged → next provider turn repeats until final text. Every downstream invariant (write-refresh events, lock semantics, candidate stage, run caps) is untouched because the loop is untouched below the engine seam.

**Deep work from chat.** `client_manager` is also given Platform-side orchestration tools (PF4: `list_workspace_nodes`, `run_workspace_workflow`, `get_workspace_run`) wrapping the same MCP client — so "write me an article about X" becomes: the agent starts a conductor dry-run (approval-gated), later turns poll the run and surface publish gates as normal approval cards. Long node/workflow executions therefore never block a chat turn.

## 5. Contracts

### 5.1 `agent_converse` (new CMS-Agent MCP tool; namespace `agent`)

Request (`client_manager.turn.v1`; zod `.strict()` on the CMS-Agent side):

```jsonc
{
  "agent_ref": "agt_client_manager@<rev>",     // from agent_resolve; rev optional pin
  "project_id": "dr-lurie",                    // must be an active registered project
  "conversation_id": "obj:page_home",          // Platform chat_id, opaque to CMS-Agent
  "turn_id": "t_<runId>_<providerTurnIndex>",  // idempotency key, minted by Platform
  "actor": { "kind": "human", "id": "<stable userId — no email; see §8.5>" },
  "context": {                                  // structured, never free-form secrets
    "site_id": "site_drlurie",
    "object_type": "page", "object_id": "page_home",   // absent for free chats
    "focus": "Homepage → Education section",
    "learning_mode": false,
    "approval_note": "Some tools require human approval; propose, do not assume execution."
  },
  "messages": [ /* Platform's provider-neutral ChatMsg[] (user/assistant/tool), bounded */ ],
  "tools": [ /* wire tool defs exactly as Platform builds them today (wireTools output) */ ],
  "constraints": { "max_tokens": 16000, "timeout_ms": 90000 }
}
```

Response:

```jsonc
{
  "turn": {
    "assistant_text": "…",                       // optional
    "tool_calls": [{ "id": "…", "name": "patch", "args": { } }],  // optional
    "usage": { "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0 },
    "agent_rev": "<workspace revision of the agent definition used>",
    "model": "<resolved model id>"               // for owner diagnostics; never rendered to editors
  }
}
```

Rules: the runner **must not execute tools** — `tool_calls` are returned verbatim for Platform to gate and execute. Duplicate `(conversation_id, turn_id)` returns the stored response without a model call (idempotent replay — protects against background-hop retry and stale-takeover). Unknown `project_id`, disabled project, or missing `agent_ref` → typed JSON-RPC tool error (`unknown_project`, `project_disabled`, `agent_unresolved`), never a silent default. Message list over the bound (see 5.4) → `transcript_too_large` telling the caller to trim (Platform trims oldest-first exactly as its provider adapters do today).

### 5.2 `agent_resolve` (discovery — no hardcoded node ids anywhere)

Request `{ "role": "client_manager", "project_id": "dr-lurie" }` → response `{ "agent_ref", "name", "rev", "model", "status" }`. Resolution order: project-specific override (if a project ever defines one) → canonical seeded `client_manager` → error `agent_unresolved`. Platform caches the ref per site with a short TTL and re-resolves on `agent_unresolved`. Deployments therefore resolve the correct agent with **zero identifiers in config** — provisioning seeds it (5.3), discovery finds it.

### 5.3 `client_manager` runtime object (CMS-Agent side)

A **workspace-stored conversational agent definition** — a new object kind, not a conductor DAG node, not a Platform agent profile, not a workflow entry point. Fields: id (seeded, deletion-guarded like `defaultProjects`), name, prompt (project-neutral; interpolation slots for project knowledge/voice), modelConfig (provider/model/timeout/maxOutputTokens/budget — the existing provider registry resolves it), status, rev. It is deliberately **outside** `publishingConductorNodes` and outside `resolveConductorNodes`' overlay, so the conductor's topology pinning and the existing schema-bound execution paths are untouched. Because it lives in the workspace store, the existing management surface applies: prompt edits are ledgered `WorkspaceChangeEvent`s with actor attribution, and the improvement machinery (evaluations, prompt optimization, model ladder) can target it — this is what makes the agent *manageable and self-improving* rather than a hardcoded proxy prompt.

### 5.4 Turn records (CMS-Agent side)

`ConversationTurnRecord { turnId, conversationId, projectId, agentRef, agentRev, actor, requestPreview (bounded), assistantText?, toolCalls?, usage, createdAt }`, stored via a new repository (GCS backend, same `registerCmsAgentStoreFactory` pattern), bounded per conversation (keep last N=200, trim oldest, emit a trim marker — mirrors Platform's `EVENTS_MAX/EVENTS_KEEP` discipline). These records are the **learning/audit mirror, not the conversation authority**: Platform's `ChatDoc` remains the single human-facing truth (visibility rules, approval security, UI). `ModelUsageRecord.metadata` gains `{conversationId, turnId, siteId}` so cost rolls up per tenant per conversation.

### 5.5 Error taxonomy (wire)

`unknown_project | project_disabled | agent_unresolved | transcript_too_large | model_timeout | model_error | budget_exceeded | invalid_turn_request`. Platform maps any of these — and transport failure, auth failure, timeout — to a `run_error` event with a stable `code: 'cms_agent_<reason>'` and human copy ("The Publishing Agent service is unavailable — nothing was changed. Try again or contact the owner."). There is **no fallback**; the run errors cleanly and the chat stays usable for retry.

## 5A. As-built deltas (authoritative — verified at CMS-Agent `3047992`)

The contract shipped as designed, with these differences. Canonical source: `CLIENT-MANAGER-CONTRACT.md` at the **root** of the CMS-Agent repo (note: root, not `docs/platform/`), still headed "Status: G1 REVIEW REQUIRED" — the code deployed ahead of the formal gate.

**Stricter than designed.** Everything is `.strict()` — unknown properties are `invalid_turn_request`. `actor` is `{kind:"human", id}` with **no `email` field at all** (the stable-id decision is enforced twice: a parse-time regex rejecting email-shaped ids, and a repository-boundary assertion `conversation_turn_actor_id_must_be_a_stable_id_not_email`). All nine top-level fields are required, including `tools` (may be `[]`) and `constraints` (`max_tokens` ≤32000, `timeout_ms` ≤120000 — then clamped down by the agent definition to 16000 / 90s). Bounds: messages ≤200 **and** ≤256KB; context ≤64KB; tools ≤64 **and** ≤256KB; tool `description` `min(1).max(16000)`; `object_type`/`object_id` must be paired. A transcript sequencing rule is enforced: a `tool` message must answer a tool call in the **immediately preceding** assistant message.

**Different from designed.**

1. **Claim-before-validation.** The idempotency claim is written before project/agent checks (`conversationalRunner.ts:93` precedes `:106`), so a validation-class rejection permanently pins that `turn_id` to the bad request hash. **Platform must mint a fresh `turn_id` after any validation failure** — reuse only for a genuine transport retry. This is the single most important integration consequence and did not exist in the design.
2. **`agent_ref` is not fully opaque** — it must match `agt_client_manager[@rev]`; a second role would need a code change.
3. **`agent_rev` is a number in the response, a string in the stored record.**
4. **`agent_resolve` errors** are raised by a different class and a malformed payload surfaces as `validation_error`, which sits outside the frozen code list.
5. **Denials are opaque:** wrong-project and bad-token both return a byte-identical 401 (`{"error":{"code":"unauthorized","message":"Missing or invalid bearer token."}}`). Platform cannot distinguish them and must not imply it can.
6. **Machine error codes are read at `error.data.error.code`.** `budget_exceeded` is only ever produced by a provider echoing that code — CMS-Agent enforces no ceiling of its own, consistent with the metering-only decision.
7. **Claims are keyed by `(conversation_id, turn_id)` without project scoping** — cross-tenant id reuse fails closed as a hash `conflict` rather than leaking.
8. **Provider reality:** the agent is `openai` / `gpt-4.1`, and **`ANTHROPIC_API_KEY` is not set on the deployed service** — so it is OpenAI-only in practice until a deploy adds it. `google`/`openai_compatible` resolve but route through the OpenAI branch, untested. OpenAI tool-call arguments that fail to parse degrade silently to `{}`.
9. **Prompt assembly** injects the project's **static hook fallback voice**, not the live `voice_<project>` object; `client_manager.skills` is stored but never read. Caller `context` is explicitly framed as untrusted data between markers, with no templating — the injection posture is sound.
10. **The turn GC is inert in production.** The supersession logic is correct and conservative, but nothing in `src/` writes supersession evidence, and the job is manual-CLI, dry-run-by-default, unscheduled. Wolf's retention decision is documented but not operating — tracked as roadmap CA7.

**The one substantive gap — prompt parity (roadmap CA6, blocking).** Platform's `systemPrompt()` (`loop.ts:100-127`) has grown since this plan was written and now carries governance the four-paragraph `client_manager` prompt does not: precise Draft/Approved/Published/Live vocabulary; the editor-facing-language rule forbidding raw ids, revision numbers, private strategy, internal schemas and **provider/model names**; the Owner-only `diagnostics_requested` branch; denial handling; focus-is-not-authorization; and the `present_candidates` learning-mode instruction. Because prompt ownership is single-sided by design, cutting over without porting these first would silently drop live guardrails — including the one preventing model-name leakage into editor-facing replies. It must land CMS-Agent-side (with `diagnostics_requested` added to `context` as an additive change) before any site flips to `required`.

## 6. Ownership matrix

| Concern | Owner | Notes |
|---|---|---|
| Conversation authority (transcript, statuses, visibility) | **Platform** (`agent-chats` blobs) | Unchanged; no migration |
| Reasoning: prompt, model choice, skills, turn execution | **CMS-Agent** (`client_manager` + conversational runner) | Improvable via workspace machinery |
| Tool registry, autonomy, approvals, dry-run, execution | **Platform** | Unchanged, including `args_hash` protocol |
| CMS-Agent-side actions from chat (run workflows/nodes) | Shared: Platform gates (risk→autonomy floor), CMS-Agent enforces (`toolPolicies`, publish gates) | Two walls, as today for publishing |
| Editor identity | Platform authenticates; CMS-Agent records (attribution-not-authorization) | §8 |
| Tenant identity / project mapping | Config: `site-identity.cmsAgentProjectId` ↔ CMS-Agent project registry | §9 |
| Cost metering per tenant/conversation | **CMS-Agent** (usage records); Platform keeps run caps | |
| Learning corpus (turns, preference pairs) | **CMS-Agent**; Platform's M2b preference events export unchanged | |

## 7. Approval and risk mapping

Tenant CMS tools (the 18 in `CHAT_TOOLS` + `present_candidates`): **Platform's model is authoritative and unchanged** — governance `chat_tools`, profile overrides, class defaults, Owner-gates (`apply_theme`), dry-runs, edit-and-approve. CMS-Agent proposes; Platform disposes.

CMS-Agent orchestration tools (PF4) map `WorkspaceRiskLevel` onto Platform autonomy with hard floors, per P3.1's rule: `read` → may default `auto`; `write` → default `ask`; `publish`/`admin` → **always `ask`, never eligible for `auto` or the client-side safe-run allow-list, regardless of governance settings**. The approval card for `run_workspace_workflow` shows the exact input JSON (dry-run = input echo + node/workflow description). CMS-Agent's own server-side gates (project `toolPolicies`, `PUBLISH_GATE_NAMES`, `*_PUBLISH_ENABLED` kill-switches) remain the second wall — Platform approval is necessary, not sufficient, for a publish.

## 8. Security decisions

1. **Credentials are server-side only, by construction.** The CMS-Agent bearer lives in Netlify env vars named through `SiteBindingEnvNames`; the client lives in `packages/core/server/lib/`; the browser talks only to `admin-agent-chat`. A sanitizer (pattern: `sanitizePdfToolPayload`) strips/redacts the bearer and any `token`-shaped keys from every logged or returned payload. A test asserts no `CMS_AGENT` value can appear in a client bundle (mirror of the protected-env write-guard in `object-validate.ts`).
2. **Per-tenant scoped tokens on the CMS-Agent side.** Today `MCP_API_TOKEN` grants all 135 tools. Handing that to three Netlify sites is an unacceptable blast radius (any tenant deployment could mutate the workspace). CA4 adds scoped bearer tokens: token → `{projects: [id], toolAllowlist: ['agent_converse','agent_resolve', 'workflow_get_run', …]}`, checked in `mcpEndpoint.authenticate` alongside the existing credentials. Each site gets its own token (secret `CMS_AGENT_MCP_TOKEN` per Netlify site), scoped to its own `project_id` — which also makes `project_id` spoofing across tenants impossible at the auth layer, giving hard tenant isolation.
3. **Actor attribution, not authorization.** `actor` on turns extends the existing `x-workspace-actor` doctrine and inherits its written caveat verbatim: a bearer holder can self-describe; turn records are attribution for learning/audit, never an access decision. Authorization remains: Netlify Identity + roles on the Platform side, scoped bearer on the CMS-Agent side.
4. **Prompt-injection posture unchanged.** Tool results and object content already flow through the model today; the trust boundary (every write gated by Platform validation + autonomy + approval) is preserved. CMS-Agent's prompt assembly must treat `context` fields as data (no template execution).
5. **PII minimization — resolved (Wolf, 2026-08-09): stable id only.** Turn records store a stable editor id, never an email; email is establishable from the id via Platform's user store when a human-readable join is needed, so the learning corpus carries no direct PII. The `actor` block sent to `agent_converse` carries `{kind, id}` only. No auth tokens, no full env, bounded request previews.

## 9. Tenant configuration and provisioning

**Platform, per site:**

| Item | Where | Values |
|---|---|---|
| `cmsAgentEndpoint: ['CMS_AGENT_MCP_ENDPOINT']` | new keys in `PLATFORM_ENV_NAMES` (`site-binding.ts`) | Cloud Run `/mcp` URL |
| `cmsAgentToken: ['CMS_AGENT_MCP_TOKEN']` | same | per-site scoped bearer |
| `cmsAgentProjectId` | `sites/<site>/config/site-identity.ts` (committed, non-secret — the `pdfToolProjectId` precedent) | `dr-lurie`, `platform`, `fernwell` |
| Provisioning catalog | `packages/core/cli/create-site.mjs` + `admin-parity.mjs` | new vars documented |

**CMS-Agent — ✅ all done as of `3047992`.** `client_manager` seeded and deletion-guarded; `fernwell` registered (`FERNWELL_MCP_ENDPOINT`/`FERNWELL_MCP_TOKEN`, read-only tool set — but no publish executor, so a live publish there would hit `no_publish_executor`); manifest regenerated (137 tools); `verify:deploy` now asserts `agent_resolve` returns an active definition for both `dr-lurie` and `fernwell`; deploy uses merge-style flags only and fails the build on a health-probe error.

**Scoped tokens — the as-built mechanism (supersedes the sketch above).** One env var, `MCP_SCOPED_TOKENS_JSON`, from Secret Manager secret **`mcp-scoped-tokens-json`**, holding a JSON map of raw bearer → `{ "projects": [...], "toolAllowlist": [...] }`. The parser is strict: exactly those two keys, non-empty unique arrays, project ids matching `^[a-z0-9][a-z0-9-]{1,62}$`, **underscore wire tool names only** (`agent.resolve` is rejected), bearer with no whitespace and not equal to `MCP_API_TOKEN`; any violation disables the scoped path entirely with no diagnostic. A scoped token may call only `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`; `prompts/*` and `resources/*` are 401. On `tools/call` the tool name must be allowlisted and any `projectId`/`project_id` argument must be in scope — which is what gives hard per-tenant isolation. Provisioning this is roadmap **PF0** and is the remaining ops prerequisite.

## 10. The twelve questions, answered

1. **Conversation history:** Platform is authoritative (`agent-chats` ChatDoc — visibility, approval security, UI); CMS-Agent keeps bounded per-turn mirror records for learning/audit, joined by `conversation_id` + `turn_id` (and `requestId` when a chat spawns a workflow run). Both, with a single named authority.
2. **Schemas:** `client_manager.turn.v1` request/response (§5.1); `ConversationTurnRecord` (§5.4); actor = existing `WorkspaceActor` shape; approval/resume schemas are Platform's existing `pendingCallSchema`/event protocol, unchanged. Versioned; additive evolution only.
3. **`client_manager` is a new runtime object:** a workspace-stored conversational agent definition executed by a dedicated conversational runner via `agent_converse` — not a conductor node, not a Platform profile, not a workflow entry point (§5.3).
4. **One agent, many tenants:** the definition is project-neutral; every call is parameterized by `project_id`; project knowledge/voice/dialect come from the project registry at prompt-assembly time; scoped tokens pin each caller to its project (§8.2); client-specific behavior lives only in project records and hooks, never in the agent prompt or shared code.
5. **Object context and editor identity:** Platform sends a structured `context` block (site, object type/id, focus, learning-mode) and an `actor` block per turn; CMS-Agent stamps both onto turn records; the object *binding* sentence the model sees is composed CMS-Agent-side from `context`, so prompt ownership is single-sided.
6. **Approval mapping:** tenant tools — Platform's existing model, untouched; CMS-Agent orchestration tools — riskLevel floors (`publish`/`admin` never auto, never safe-run); CMS-Agent server-side gates remain the second wall (§7).
7. **Long-running work:** a chat *turn* is one bounded model call (≤ ~90s, well inside every budget). Node/workflow executions are started by an approval-gated tool that returns `{runId}` immediately; later turns (or the user) poll via `get_workspace_run`; publish gates surface as approval cards; cancellation maps to `workflow.pause_run`/`cancel`; blocked/waiting runs appear in the existing "Needs you" surface. Nothing ever holds a Netlify function open across a 1–5-minute node run.
8. **Downtime / missing config:** typed `run_error`, no fallback, and the chat remains usable for retry. Health is surfaced to owners through the memoized `agent_resolve` probe. Missing endpoint/token makes the send action return a clear 503-style `cms_agent_not_configured` error before a run is created.
9. **Existing chats:** retained in place; zero transcript migration (the neutral `ChatMsg` shape is already what `agent_converse` consumes). New runs on old chats simply use the new engine; `ChatRun` gains `engine: 'cms-agent' | 'provider'` + `agent_ref` stamped at `startRun`, so history is honestly labeled.
10. **Disabling legacy:** PF5 makes Client Manager the only construction path for admin-chat turns. Old mode env values and stored governance overrides cannot select Platform providers.
11. **Env & bindings:** table in §9.
12. **Deployment order & rollback:** CMS-Agent first (additive tools + manifest + seeds + scoped tokens), then the Platform revision with its permanent Client Manager route. Rollback is a Platform revision rollback or CMS-Agent previous-revision pin, followed by fresh health and chat verification (§11).

## 11. Cutover and rollback (summary; full sequencing in the roadmap)

PF5 now deploys one fleet-wide behavior: **platform**, **fernwell**, and
**drlurie** admin chat all require the canonical Client Manager. Deployment
readiness is therefore endpoint/token configuration plus a healthy
`agent_resolve` for each site's committed project id, followed by an
authenticated walkthrough of Object Room, Templates, and AgentsHub chat.
Rollback is a code/revision rollback, not a mode switch. `provider.ts` remains
for non-chat AI surfaces until the Ask-AI decision (§14) is made.

## 12. What this does NOT change

Schema-bound autonomous nodes, the conductor DAG, the publish gates, `workflow.start_dry_run`, the improvement pipeline, the Netlify frozen plane, LibreChat, Platform's object verbs/locking/validation, the M0–M4 admin UI, the candidate/learning-mode flow, and the preference-export pair shape. Regression suites for all of these are named in the done-criteria doc.

## 13. Staleness ruling on P3/P6 (requested)

- **P3.1** — half superseded, half absorbed: the MCP client spec (Streamable HTTP, `Mcp-Session-Id`, DELETE, binding-pattern config, bearer-never-in-browser) becomes **PF1** verbatim; the `run_workspace_node`/`list_workspace_nodes` tools become **PF4** with the same risk mapping. Its framing ("we are not replacing the chat loop with CMS-Agent") described the pre-requirement world and is superseded by this plan's engine seam.
- **P3.2 (`node:` chat kind)** — **replace.** With `client_manager` behind every chat, a third chat kind per node is redundant; editors ask the agent, the agent runs nodes. The one surviving idea — showing raw node output in a collapsed disclosure when a node result enters chat — moves into PF4's tool-result rendering.
- **P6.1–P6.4** — **still valid, re-scoped**: they are the *workflow* human-in-the-loop track (a conductor run asking a question mid-pipeline), now decoupled from the chat cutover. P6.2's dropped-`dependencies` bug fix is folded into CA-track hygiene. P6.4's "queryable waiting-run list" lands naturally as PF4's `get_workspace_run` + the existing Needs-you surface.
- **P6.3 (prose runner mode)** — **superseded in design** by CA3's conversational runner: same goal, different mechanism (pass-through tools, one turn per call, no message history inside CMS-Agent's runner because Platform supplies the transcript). Do not also build P6.3 as written.
- **P6.5 (actor identity)** — **partially delivered** by CA1 (actor on turns); actor on *workflow runs* and the auto-approved-publish default remain open and belong to the P6 track.

## 14. Open questions that genuinely require product authority

1. **Scope of "every admin conversation":** do `admin-ask-ai-object.ts` (canvas Ask-AI chips) and `run-publisher-agent.ts` count? Recommendation: route Ask-AI through `agent_converse` as a follow-on milestone (PF7, listed unscheduled); confirm whether `run-publisher-agent` is live or retirable. Wolf's call.
2. **Future of Platform agent profiles:** under `required` mode the model/provider choice moves to `client_manager.modelConfig`. Do profiles survive as persona/system-prompt add-ons passed in `context`, or retire to owner diagnostics? Plan assumes: profiles stop supplying provider/model for chat; their system prompts are **not** sent (single prompt owner); the roster UI is re-labeled at PF6. Needs Wolf's confirmation because it changes an Owner-facing surface.
3. ~~Learning-mode candidates~~ — **resolved (Wolf, 2026-08-09): CMS-Agent owns the candidate instruction.** The "produce 2–3 candidates" behavior lives in the `client_manager` prompt; Platform sends only `learning_mode: true` in context. The `present_candidates` wire tool passes through and Platform's candidate UI/preference capture are unchanged.
4. ~~Turn-record PII and retention~~ — **resolved (Wolf, 2026-08-09), both halves.** Turn records store a **stable id only** (email establishable from it via Platform's user store); retention is learning-driven, not time-boxed — turns persist while they carry learning value (interactions span sessions), a superseding interaction makes the earlier one deletable, and the CMS-Agent learning layer owns staleness determination and deletion (supersession-aware turn GC, CA-track follow-on; the ~200-turn hard bound stays as backstop).
5. ~~Per-conversation budget~~ — **resolved (Wolf, 2026-08-09): metering-only.** No stored per-conversation `budgetUsd` ceiling; spend is derivable from usage metering, and any future ceiling is computed from metering rather than persisted.
6. **Soak windows** per cutover stage (plan default: 3 days platform, 2 days fernwell, 5 days drlurie) — Wolf sets the actual numbers.
