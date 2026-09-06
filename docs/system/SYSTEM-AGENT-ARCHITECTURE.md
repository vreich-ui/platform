# System agent architecture — three agent planes, one content authority

> Pins: `CMS_AGENT_SHA=44acb04a1f54281761ab3c34219913198d117950` · `PLATFORM_SHA=d5845dd6e855b434547430d6b0bb4d60b9f60a3c` · `PDF_TOOL_SHA=2c28a4b6430a9589b384dd634f08e9ace5c4e84b` · `KUGEL_DATA_SHA=d9723664521c97be87934874927e9e4603da68ba`.

## 1. The three planes

| Plane | Where the model runs | Where tools execute | Who holds credentials | Canonical record of what happened | Status |
|---|---|---|---|---|---|
| **Conductor** (CMS-Agent workflows: `publishing_conductor` 25 nodes, `capture_conductor` 16, `clone_conductor` 18, `visual_identity` 2) | CMS-Agent node runners (OpenAI Agents SDK, Anthropic Messages, Mock) | inside CMS-Agent: 49 controlled tools; tenant verbs via `project.call_tool` / `project.call_read_tool` → `ProjectMcpAdapter`; deterministic routes for the publishing tail and artifact materialization | CMS-Agent (Secret Manager `<tenant>-mcp-token`) | CMS-Agent run record; tenant object record after publish | IMPLEMENTED; four drivers (request window, tick, conductor job, `run_all` callers) |
| **Client manager chat** (tenant admin chat) | CMS-Agent `agent_converse` (one provider request per turn, `client_manager` prompt + project knowledge + editorial voice + caller context as untrusted JSON) | **platform** `loop.ts` → `registry.ts` → `generated-tools.ts` → the same verb handlers `tools/call` uses; CMS-Agent returns proposals only | platform (site-scoped bearer to CMS-Agent; its own object store) | platform `ChatDoc` (human record); CMS-Agent conversation mirror ≤ 200 turns | IMPLEMENTED; chat fails closed without CMS-Agent |
| **Publishing plugin** (ChatGPT Agent Studio agent, Claude skill, Gemini gem) | the external chat app | tenant `/mcp` over OAuth 2.1 (or `/api/plugin/*` façade for ChatGPT Actions); the operator reports pdf-tool's MCP is also attached directly to the ChatGPT agent (operator configuration, not visible in any repository — UNKNOWN from code) | the human's OAuth grant on the tenant; pdf-tool credentials held by the chat app if attached | tenant object record + `history[]` with `surface`/`attribution` on the receipt; `producer` authored by the LLM per the skill text | IMPLEMENTED (ruling ART-1: bypasses CMS-Agent by design) |

Legacy planes still deployed and callable with no live caller: CMS-Agent `/api/agent` base-agent scaffold (never calls a model, never publishes), platform `run-publisher-agent.ts` (full Agents SDK runtime behind `x-publish-key`, writes real `content_item`s), pdf-tool image jobs run an Agents-SDK loop internally (pdf-tool KI-28 — not a plane, an implementation detail).

## 2. Where "agent intent" is recorded, per plane

| Plane | Intent | Decision trail | Publication link |
|---|---|---|---|
| Conductor | `run.initialInput`, `run.requestId`, `publishingPolicySnapshot` | `run.nodes[].output`, `stageOutputs`, `provenance.promptVersion`/`model` per node, `publication_controller` decision, `operatorPublishDecision`, `releaseLedger` | `stageOutputs.publish_executor.receipts.objectId/commitSha`; tenant record carries `producer` only from the platform-tenant hook |
| Chat | `ChatDoc` messages; `editorial-requests` doc (`brief_excerpt`, `run_id`) | chat tool approvals (`approve_tool`/`deny_tool`), `history[]` on the request doc (≤ 50) | `doc.object.object_id` (assumed = `requestId`, S-06); `recordPublicationEvidence` from run outputs |
| Plugin | none on the Kugel side except the object itself | `history[]` actions with actor `{kind:'human', surface:'plugin:…', attribution:'oauth'}` | `publish_receipt.surface/attribution`; `producer` self-declared |

## 3. Tool surfaces and their authority (callable ≠ authorised)

| Surface | Tools | Gate before execution | Notes |
|---|---|---|---|
| CMS-Agent `/mcp` | 151 (`docs/mcp-tool-manifest.json`), namespaces exposed per credential (`MCP_EXPOSED_TOOL_PREFIXES`) | static token → scoped bearer (allowlist + project binding, `mcpEndpoint.ts:97-125`) → OAuth; `workflow_*` mutate runs; `workspace_update_node_tools` can grant `project.call_tool` to any node with only change history as guard (CMS-Agent K-M5) | the admin chat's bearer sees 11 tools |
| CMS-Agent controlled tools (node-facing) | 49; `project.call_tool` (write, approval-gated by node metadata + project policy), `project.call_read_tool` (15-verb allowlist) | tool policy in the project record; per-project executable policy hooks are **not** applied by `ProjectMcpAdapter.callTool` nor by the controlled `project.call_tool` (CMS-Agent audit) | a model node is bounded only by the tenant's own gates |
| Tenant `/mcp` | 100 (97 + `analytics_summary`, `analytics_top_content`, `analytics_object` — server-side `/stats` proxies); 14 internal-only; membership only to OAuth humans; `verify_article_images` drlurie only | auth path; kill switch per surface; write budget 60/10 min per OAuth subject or agent key (**not** for the shared token); idempotency wrapper on `object_create`, `object_publish`, `release_to_production`, `create_agent_artifact_job`, membership | governance classes drive **chat** autonomy only |
| Tenant `/api/plugin/*` | the promoted manifest's charter | 403 `tool_not_in_plugin_charter` before auth | `release_to_production` is in the charter |
| pdf-tool `/mcp` | 32 | bearer `AGENT_RUN_TOKEN` / OAuth / connector key; storage grant required except six tools; operator secret for blocked-job resume | no approval policy of its own |

## 4. Prompt inputs that are learned or configured (what can change an agent's behaviour without a code change)

| Input | Source | Injected where | Governance |
|---|---|---|---|
| Node prompt, schemas, tool grants, model config | CMS-Agent store rows (`workspace/current.json`) — default node source | every dispatch | `WorkspaceStateStore.mutate` + change history; canonical literals locked by `nodes:check` |
| Per-node playbook | `improvement/playbooks/{nodeId}.json` | every dispatch, both runners | `apply_delta`/`curate`/`migrate_observations`, `optimizer_promote`, W21 strategy promotion (unflagged) |
| Client knowledge + editorial voice | CMS-Agent `projects/<tenant>/{knowledge,editorialVoice}.ts` fallback; tenant `editorial_voice` object ("data, not instructions", `voice_not_a_prompt` criterion) | `client_manager` prompt | tenant object governed (`require-approval` on three tenants) |
| Reduced object contract | tenant `object_contract` (derived, never hand-authored) cached in the workspace document | contract-aware nodes | platform schema |
| brandImagery / visual standard | tenant `site.v1.brandImagery`, `visual_standard` objects; proposals from CMS-Agent `visual_identity_propose` | pdf-tool image jobs (assembled server-side by platform); `style` override channel behind an owner guardrail | privileged patch ops (`site_apply_brand_imagery`) |
| Learning observations | CMS-Agent workspace document | **nowhere** | archive tools |
| Engagement evidence | W21 `optimizer.analyze` (unscheduled, joins broken) | reflector prompt only | none |

## 5. Concurrency and failure at the plane boundaries (both sides read)

- Conductor: four drivers compete for one run via CAS; claims expire at `timeout + 90 s` and a slow node can be re-dispatched (K-D1); a publish hook re-run collides on `object_checkout` (lock) — the tenant's lock is the effective mutual exclusion.
- Chat: one turn = one provider request; `(conversation_id, turn_id)` claim on CMS-Agent; a stuck claim is permanent (C-8) and platform must mint a new `turn_id`.
- Sweep: platform `editorial-request-sweep` every 5 min reads `workflow_get_run` (+ `node_get_latest_output`, refused by scope — S-07, as are the admin "raise budget and retry" calls `workflow_set_node_budget_override`/`workspace_update_node_model_config`/`workflow_retry_node`, `workflow_cancel_run`, and the Insights tab's four learning reads); the scope check does not bind `workflow_get_run`/`workflow_set_operator_publish_decision`/`workflow_publish_run` to the run's project (S-26); rules: only the sweep writes a running request's status; unreachable CMS-Agent leaves status untouched.
- Plugin: no coordination with the conductor; two planes can publish the same tenant concurrently; the object lock is the only guard; `release_to_production` from either ships the other's dark exports.
