# System operations — deploy artifacts, environment, jobs, revalidation, drift prevention

> Pins: `CMS_AGENT_SHA=44acb04a1f54281761ab3c34219913198d117950` · `PLATFORM_SHA=d5845dd6e855b434547430d6b0bb4d60b9f60a3c` · `PDF_TOOL_SHA=2c28a4b6430a9589b384dd634f08e9ace5c4e84b` · `KUGEL_DATA_SHA=d9723664521c97be87934874927e9e4603da68ba`.

## 1. Deployables and how they deploy

| Deployable | Trigger | Artifact | Verification gate | Known drift |
|---|---|---|---|---|
| CMS-Agent service `cms-agent-mcp` | Cloud Build trigger on push to `main` (`cloudbuild.deploy.yaml`) | `Dockerfile.mcp` | typecheck + tests + drift/glossary/object-docs/scope locks in GitHub CI; post-deploy image ancestry + 11 client vars + `/health` | second path `scripts/deploy-mcp.sh` differs (memory 512Mi vs 1Gi, min-instances 0 vs 1, SA, env sets, `MCP_ALLOWED_ORIGINS` only there) — CMS-Agent C-12 |
| CMS-Agent jobs | `continuation-tick`: image synced by the trigger (`_EXECUTOR_JOBS`), Scheduler `*/2`; `site-credential-reconciler`: `scripts/deploy-site-credential-reconciler*.sh`, daily 06:00 UTC; `conductor-run`: by hand, image **not** synced (C-10); `migrate-store`, `conversation-turn-gc`, `monetizer-ingest`, `tracking-ingest`, `strategy-learning`, `strategy-review`: **no deploy artifact** | same image | — | W21 jobs unscheduled; `TASK_TIMEOUT_MS` set nowhere (C-11) |
| CMS-Agent SPAs (`ui/`, `workbench/`) | Netlify site `cms-agent` | static | CI `test:ui` | `workbench-broker` code-complete, deployment unconfirmed |
| Tenant sites ×4 | Netlify build per site; `object_publish` never triggers a build (`[skip netlify]`); `release_to_production` posts the hook | `astro build` of the shared `packages/core` with `sites/<client>/astro.config.ts`; plus, per site, the Netlify Edge Function `variant-serve` (`path = "/*"`, `netlify.toml`) with a build-vendored `edge-core.ts` and `_experiments.generated.json` written by `scripts/tracking-experiments-build.mjs` | platform `npm test` (~3 min, offline); CI `fleet` matrix loads the drlurie config (platform audit) | root `postbuild` pins `--export-root sites/drlurie/data/site`; `verify-article-images` only at root |
| pdf-tool `pdf-x` | Netlify auto-deploy from `main` | functions + background workers | **none** (no CI test gate) | scheduled `warm-ping-scheduled` `*/5` |
| pdf-tool render service | manual GitHub workflow → Cloud Run `pdf-tool-render` (`pdf-tool-gc`, europe-west1) | container | workflow asserts `/health.build.gitSha` | — |
| kugel-data | Netlify auto-deploy from `main` (`/ship` merges directly; no branch protection) | 9 functions; migrations applied on every deploy and preview | `npm test` = `tsc` + 4 `node:test` files | no retention job; `experiment-weights` `@daily` |

## 2. Environment variables that cross a repository boundary

| Name | Set on | Read by | Must equal |
|---|---|---|---|
| `CMS_AGENT_MCP_ENDPOINT`, `CMS_AGENT_MCP_TOKEN` | each tenant site (installed by CMS-Agent genesis/reconciler via Netlify API) | platform `site-binding.ts:87-88` | a bearer whose digest is in CMS-Agent `auth/managed-scoped-bearers.v1.json` for that project |
| `CMS_AGENT_PROJECT_ID` | tenant | platform `site-identity.ts:240` | the CMS-Agent project id (`dr-lurie`, `platform`, `fernwell`, …) — note the hyphen/slug difference from the tracking `project_id` |
| `DR_LURIE_MCP_ENDPOINT`, `PLATFORM_MCP_ENDPOINT`, `FERNWELL_MCP_ENDPOINT`, `PDF_TOOL_MCP_ENDPOINT` (+ `*_MCP_TOKEN` from Secret Manager) | CMS-Agent Cloud Run (`cloudbuild.deploy.yaml:101-102`) | CMS-Agent `ProjectMcpAdapter` (env first, registry second) | the tenant's `/mcp` URL; a credential the tenant accepts. **No `MONETIZER_MCP_*` in any deploy artifact.** Genesis-minted tenants rely on the registry record instead |
| `PDF_TOOL_BASE_URL`, `PDF_TOOL_AGENT_RUN_TOKEN` | tenant | platform `pdf-tool-client.ts:28-29` | `https://pdf-x.netlify.app`; pdf-tool `AGENT_RUN_TOKEN` |
| `PDF_TOOL_STORAGE_TOKEN`, `PDF_TOOL_STORAGE_SITE_ID`, `PDF_TOOL_PROJECT_ID` | tenant | platform grant minting | a Netlify PAT + the tenant's site id; `PDF_TOOL_PROJECT_ID` value per tenant UNKNOWN (fallback: site slug) |
| `TRACKING_SINK_URL`, `TRACKING_SINK_TOKEN` | tenant. Two provisioning paths disagree: CMS-Agent genesis installs them per site with build+functions scope, copied from CMS-Agent's own env (`capture/siteGenesis.ts:266-272`); platform's `create-site.mjs` (R8.1, since #694) no longer copies them and instead expects **team-level** Netlify env that every site inherits (`env-audit.mjs` checks the account env by name). **CMS-Agent: in no deploy artifact**, so presence on the Cloud Run service is a hand-set fact (UNKNOWN) | platform relay/dims/commerce/link/stats/rollups/weights/export; CMS-Agent genesis + W21 jobs | kugel-data's URL (endpoint value used **verbatim** by the relay — it must be the full `/api/tracking-sink` URL — while `/stats`, `/dims`, `/commerce`, `/link`, `/rollups` are appended by their callers) and kugel-data `TRACKING_SINK_TOKEN` |
| `TRACKING_PROJECT_ID` | tenant; CMS-Agent | platform stamps events; CMS-Agent queries rollups | the bare site slug on both — equality UNKNOWN |
| `TRACKING_SALT` | tenant | platform hashing | per-site, no rotation path |
| `GITHUB_CONTENT_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_BRANCH` | each tenant | platform committer / release / index | all four tenants point at one repository (implied by the committed tree; values UNKNOWN) |
| `NETLIFY_BUILD_HOOK_URL`, `NETLIFY_AUTH_TOKEN`/`NETLIFY_BLOBS_TOKEN`, `NETLIFY_SITE_ID` | each tenant | platform release/deploy lookup/blobs/analytics | — |
| `PUBLISH_SECRET` | each tenant | platform in-process siblings + scripts | — |
| `AGENT_RUN_TOKEN`, `ARTIFACT_ATTESTATION_SECRET`, `MCP_OAUTH_SIGNING_SECRET`, `RENDER_SERVICE_URL`/`SECRET`, `PDF_TOOL_SITE_ID`/`BLOBS_TOKEN` | pdf-x | pdf-tool | which attestation secret is set decides whether proofs are forgeable |
| `NETLIFY_DATABASE_URL` (→ `NETLIFY_DB_URL` → `DATABASE_URL`) | kugel-data | `_shared/db.ts` | — |

A relay convention to know: platform uses `TRACKING_SINK_URL` **verbatim** for the event relay but strips trailing slashes and appends `/stats`, `/dims`, `/commerce`, `/link`, `/rollups`, `/weights` (and CMS-Agent appends `/rollups`) for the others — so the variable must be the full `…/api/tracking-sink` URL, and the readers land on `…/api/tracking-sink/<route>` only because kugel-data nests every route there. The raw-export reader added by #694 breaks the convention: it appends `/api/tracking-sink/export` (S-22). VERIFIED-BOTH-SIDES.

## 3. Scheduled work across the system

| Schedule | System | Job | Effect on other systems |
|---|---|---|---|
| `*/2 * * * *` | CMS-Agent | continuation-tick | drives runs → tenant `/mcp` calls, pdf-tool jobs (via tenant) |
| daily 06:00 UTC | CMS-Agent | site-credential-reconciler | rewrites tenant `CMS_AGENT_MCP_TOKEN` env via Netlify API |
| `*/5 * * * *` | tenant | `mcp-keepalive`, `editorial-request-sweep` (→ CMS-Agent `workflow_get_run`) | CMS-Agent read load; request status writes |
| `17 3 * * *` | tenant | `membership-sweep` | — |
| `*/5 * * * *` | pdf-x | `warm-ping-scheduled` | — |
| `@daily` | kugel-data | `experiment-weights` (inert until a tenant sets `experiments[]`; every tenant ships `experiments: []` at `PLATFORM_SHA`; the weights it would write are never consumed — S-24/S-25) | — |
| none | CMS-Agent | tracking-ingest / strategy-learning / strategy-review | would read kugel-data `/rollups`, write CMS-Agent feedback/playbooks, and call tenant `marginalia_create` |
| none | tenant | `tracking-mirror-prune.mjs`, `tracking-mirror-replay.mjs` | manual only |
| build time | tenant | `scripts/tracking-experiments-build.mjs` (Netlify build) | reads kugel-data `/weights?project_id` (2 s, best effort) and writes `netlify/edge-functions/_experiments.generated.json` + `public/_trk/experiments.json` |

## 4. Health and observability across boundaries

- CMS-Agent `/health` is shallow (no store, no client check); no application-level request log for MCP calls (K-O1); `SERVICE_GIT_SHA` never stamped.
- Tenant `capability_status` reports env-var **names** per family, not call-path health (platform #36/#19); `fleet-capability-probe.mjs --all` is the live probe and has not been run (platform #20).
- pdf-tool `/health` probes its **own** store only.
- kugel-data `/health` pings the DB.
- Nothing correlates a CMS-Agent `runId` with a tenant function invocation or a pdf-tool `jobId` in logs; the only cross-system trace is the run record's receipts.

## 5. Legacy components still callable (see SYSTEM-KNOWN-ISSUES.md §Legacy)

CMS-Agent Netlify functions `agent`, `mcp`, `oauth-*` (502 since 2026-08-14 but routed); CMS-Agent `/api/agent` scaffold; platform `run-publisher-agent.ts` (four tenants), `save_artifact`, `admin-traffic` shim, `netlify/lib/{admin-auth,netlify-deploys}.ts` shims; pdf-tool `agent-artifact-job`, `agent-artifact-job-status` HTTP; kugel-data none.

## 6. Revalidation when a pin moves

Any of the four SHAs changing invalidates specific claims. Before trusting these documents against a newer commit:

| If this moved | Re-verify |
|---|---|
| CMS-Agent `main` | scope lock (`docs/site-credential-scope-lock.json`) vs platform's call list; `MAX_CONVERSATION_TOOLS`; hook argument keys (`drLurie/hooks.ts`, `platform/hooks.ts`); `fetchRollupRows` params and `GRAIN_UNAVAILABLE_STATUS`; `CREDENTIAL_SHAPED_KEYS`; `REQUEST_ID_PATTERN`; whether W21 jobs gained a deploy artifact; `publishExecutorDeterministic` handling |
| platform `main` | `CMS_AGENT_BOUNDS`; `TRACKING_EVENT_KINDS` and `trackingPropsSchema` (does `exposure`/`variant_id` exist now?); `own-tracker-stats.ts` query shape (`days` vs `from/to`); any `/rollups`, `/weights`, `/export` consumer; `allowedArtifactReferenceKeys`; grant shape; `commerce-events.ts` `kind`; checkout id generators; `tracking-dims-push.mjs`; hooks' consumers (`object_publish` inputs, `producer`); the tool count (100) and any new tool platform calls on CMS-Agent (the Insights tab and the analytics MCP tools call CMS-Agent too — SYSTEM-KNOWN-ISSUES.md S-07) |
| pdf-tool `main` | `ArtifactReference` interface (any new field must be allowlisted on platform); `parseStorageGrant`; index key templates; tool input schemas platform maps to; `snapshot.v1` keys |
| kugel-data `main` | `parseBy` allowed values; migrations beyond 005 (`version` column? `surface`/`attribution`? strategy view?); `/stats` params; new endpoints (`/export`); `kind='purchase'` predicate |
| kugel-data `runner/w21-r116` published or merged | rerun every kugel-data row above — it is what platform's `/stats`/`/export` readers code against (S-23); re-decide S-24/S-25 against its `/weights` and exposure keying |

`node scripts/docs/system-contracts.mjs --check` performs the literal part of this table automatically for whichever repositories are present.
### 6.1 What moved during the audit, and what was revalidated

Three `main`s moved between the repository audits and the end of this synthesis. Each was re-pinned and the table below records what changed and what was re-verified from code (VERIFIED-BOTH-SIDES unless stated):

| Repository | Old → new pin | What moved | Revalidated |
|---|---|---|---|
| platform | `420afbd` → `99fb369` (PR #694 W21 tracking; PR #695 docs is still open) | `CMS_AGENT_BOUNDS.maxTools` 96→99; `exposure` kind + `experiment_id`/`variant_id` props; `own-tracker-stats.ts` `/stats?from&to[&exclude_test&country&source&object_id]`; new `/api/tracking-sink/export` reader; `/rollups?by=object` and `/weights` readers; Netlify Edge Function `variant-serve` + `_dlab` cookie on every tenant (`experiments: []` everywhere); admin Insights tab calling CMS-Agent `feedback_list`/`playbook_get`/`optimizer_status`/`learning_list_observations`; three `analytics_*` MCP tools (97→100); `create-site.mjs` stops copying `TRACKING_SINK_URL/TOKEN` into new sites (team-level env expected) | L-24 resolved (99 = 99); S-07 widened; S-09 rewritten (producer side exists; keys do not join — S-25); S-22 made concrete (`/export` URL doubles `/api/tracking-sink`); S-23, S-24, S-25 added; C-11 note; C-25/C-27 consumer columns filled; tool count and deployment topology updated |
| CMS-Agent | `4b618b7` → `0d1dfa4` (PR #267) | docs only (`AI_CONTEXT` §7e, `ARCHITECTURE` §9 external-contracts tables, `KNOWN_ISSUES` K-M9/K-A9–K-A11/D-13–D-16) + `scripts/repro/knownIssues.ts` + tool-reference generator; **no runtime change** | scope lock unchanged (11 tools); `isScopedMessageAllowed` re-read — K-M9 confirmed from code and carried as S-26 with the platform call shape; L-08 **not** resolved — `ARCHITECTURE.md` §2 still draws `MCP --> PdfTool` and `Jobs --> PdfTool`, and the new §9 cites `artifactMaterialization.ts`/`captureEngine.ts` as evidence of a direct PDF-Tool contract although both call the run's tenant `/mcp` (S-DOC-04 stands, widened); S-DOC-03 stands (`AI_CONTEXT.md` at `0d1dfa4` still names no tracking consumer) |
| pdf-tool | `60bdb98` → `2c28a4b` (PR #78) | descriptions, annotations and comments only (`health`/`status` annotations, "no TENANT credentials" wording); **no runtime change** | `ArtifactReference` fields, `parseStorageGrant`, index templates and `snapshot.v1` keys unchanged (lock identical); line citations re-checked |
| kugel-data | unchanged `6c9c712` | — | — |

Second move (after the repository audits were all merged):

| Repository | Old → new pin | What moved | Revalidated |
|---|---|---|---|
| platform | `99fb369` → `d5845dd` | PR #695 (docs corrections at `420afbd`, now **with** `docs/generated/INVENTORY.md`, `scripts/docs/inventory.mjs` and `tests/scripts/docs-inventory-fresh.test.mjs`); PR #697 (Issue 29: `verify_article_images` injected through one `netlify/lib/mcp-siblings.ts` bootstrap for `/mcp`, the plugin manifest, the Actions facade and admin chat on drlurie); PR #696 (the first eight documents of this set, byte-identical to this branch); four `Publish content_item` commits, one of them the traced article (`record_version` 53→55, body unchanged) | L-17 / S-DOC-02 resolved; drlurie-only `verify_article_images` still true (now consistent across its entry points); SYSTEM-DATA-FLOW.md §1 notes the republish; lock unchanged apart from pins (no literal moved) |
| CMS-Agent | `0d1dfa4` → `44acb04` (PR #268) | `siteCredentialReconciler.ts` installs `CMS_AGENT_MCP_TOKEN` for all secret contexts (production, deploy-preview, branch-deploy) instead of production only; scope lock, `SITE_CLIENT_MANAGER_TOOLS`, `isScopedMessageAllowed` unchanged | C-11 note; the PR's statement that the Insights tab works in production is recorded under S-07 / UNKNOWN 9 (it cannot with an 11-tool bearer) |
| pdf-tool | unchanged `2c28a4b` | — | — |
| kugel-data | `6c9c712` → `d972366` (PRs #9, #10, #11) | documentation only: `docs/` audit + correction passes 4B/4C + one KNOWN_ISSUES restore; `netlify/functions/**`, `_shared/**`, migrations 001–005 byte-identical (blob SHAs compared) | nothing to revalidate on the runtime; S-DOC-05 re-read against the corrected KI-28 wording (see SYSTEM-KNOWN-ISSUES.md §B) |

Everything CMS-Agent's PR #267 asserts about the other three repositories is labelled by that PR itself as "asserted here, owned elsewhere"; nothing from it was carried into these documents without a code read on the other side.


## 7. Drift prevention

Added by this change set (platform repo):

- `scripts/docs/system-contracts.mjs` — extracts the literals the system docs depend on from **each repository present on disk** (platform always; CMS-Agent, pdf-tool, kugel-data when `KUGEL_SIBLINGS` or the default sibling paths `../cms-agent`, `../CMS-Agent`, `../pdf-tool`, `../kugel-data` exist) and compares them with `docs/system/system-contracts.lock.json`. `--write` regenerates the lock; `--check` fails on any difference and prints the field.
- `docs/system/system-contracts.lock.json` — the generated record: pins, tool bounds, event kinds, props allowlist, commerce kinds, allowlisted reference keys, grant store names, scoped-bearer allowlist, `parseBy` values, request-id regexes, replay-marker shape, and the CMS-Agent tools platform calls.
- `tests/scripts/system-docs.test.mjs` — runs in `npm test`: (a) every `docs/system/*.md` carries all four pins in its header; (b) every relative link in `docs/system` resolves; (c) `system-contracts.mjs --check` passes for the platform-local fields (sibling fields are checked only when the sibling repositories are present, so CI stays green without them, and a maintainer with all four clones gets the full cross-repo check).

What each lock field detects:

| Field | Drift it catches |
|---|---|
| `platform.cmsAgentBounds.maxTools` vs `cmsAgent.maxConversationTools` | chat tool bound divergence (L-24) |
| `platform.cmsAgentToolsCalled` vs `cmsAgent.siteClientManagerTools` | a platform call outside the scoped-bearer allowlist (S-07) |
| `platform.trackingEventKinds` vs `kugelData.eventKindLiterals` | a sink literal not in the producer enum (fired for `exposure` until #694; now clean) |
| `platform.ownStatsParams` vs `kugelData.statsParamsRead` | a `/stats` parameter the reader sends and the sink never reads (S-23) |
| `platform.rawExportPath` vs `kugelData.functions` | a sink route the reader targets that the sink does not serve (`/export`, S-23) |
| `platform.weightsEnvelopeKey` vs `kugelData.weightsEnvelopeKeys` | the `/weights` envelope mismatch (S-24) |
| `platform.commerceEventTypes` vs `kugelData.purchaseKindLiteral` | the purchase vocabulary gap (S-02) |
| `platform.allowedArtifactReferenceKeys` vs `pdfTool.artifactReferenceFields` | a pdf-tool field platform would reject (`filename` class) |
| `platform.grantStores` vs `pdfTool.canonicalStorageStores` | store-name divergence |
| `cmsAgent.rollupsByValues` vs `kugelData.parseByValues` | a grain the consumer requests and the sink rejects (S-04) |
| `platform.requestIdRegexes`, `cmsAgent.requestIdRegexes` | request-id grammar copies diverging |
| `platform.idempotencyReplayMarkerType` vs `cmsAgent.replayMarkerRead` | S-11 |
| `platform.trackingPropsAllowlist`, `platform.dimsRowKeys` vs `kugelData.dimsReadKeys` | props/dims keys sent but not stored |
| `platform.mcpToolCount`, `cmsAgent.mcpToolCount`, `pdfTool.mcpToolCount` | exact-count drift (the counts each repo's own tests pin) |

Recommended, not added here (each belongs in the repo it tests): the eight fixtures in SYSTEM-CONTRACTS.md §F; a CMS-Agent test asserting `docs/site-credential-scope-lock.json ⊇` the tool names in platform's `agent/tools.ts` (needs the platform checkout); a kugel-data test that replays a real platform `buildTrackingEvent` output; a pdf-tool test that replays a real platform grant through `parseStorageGrant` and asserts `overBudget` is either consumed or explicitly ignored.
