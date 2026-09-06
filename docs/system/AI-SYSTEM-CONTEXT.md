# AI-SYSTEM-CONTEXT — bootstrap for any agent changing the Kugel system

> Pins: `CMS_AGENT_SHA=0d1dfa43f827aae3b5b9ffdfaf71868a8076ffd3` · `PLATFORM_SHA=99fb36993f156fbdc6a91cb717e890ca2c2adfef` · `PDF_TOOL_SHA=2c28a4b6430a9589b384dd634f08e9ace5c4e84b` · `KUGEL_DATA_SHA=6c9c7129467bdb947ce76c0f52876b135aa24a61`.
> If `git rev-parse origin/main` in the repository you are about to change differs from its pin, read [SYSTEM-OPERATIONS.md §6](SYSTEM-OPERATIONS.md#6-revalidation-when-a-pin-moves) first and run `node scripts/docs/system-contracts.mjs --check` (platform). Then read the repository's own `docs/AI_CONTEXT.md` — it carries the repo-internal rules; this file carries the cross-repository ones.

## 1. Which repo do I change?

| I want to change… | Repository | Because |
|---|---|---|
| a workflow node, prompt, schema, tool grant, gate, retry, budget, run driver | `vreich-ui/CMS-Agent` (`src/agent/workspace/*`, store rows via `workspace_*` tools) | the workspace and runs are canonical there; remember `WORKSPACE_NODES_SOURCE` defaults to `store`, so a literal edit needs `nodes:update` + redeploy + `store:update` |
| how CMS-Agent reaches a tenant (endpoint, token ref, tool policy, autonomy) | CMS-Agent `src/agent/projects/*` + `project_update` on the live registry | project registry is canonical there; env names override records at call time |
| the tenant chat's behaviour (which tools, approval floors) | platform `packages/core/server/lib/agent/*` (execution, floors) **and** CMS-Agent `conversations/*` + `client_manager` prompt (reasoning) | split runtime: CMS-Agent reasons, platform executes |
| which CMS-Agent tools the tenant bearer may call | CMS-Agent `capture/siteGenesis.ts` `SITE_CLIENT_MANAGER_TOOLS` + `npm run scope:update` + reconciler `--apply` | the scope lock, not platform, decides (S-07 is what happens otherwise) |
| an object type, body schema, patch op, validation rule, materializer, publish gate, release | platform `packages/core/schema/*`, `server/lib/object-*.ts`, `publish-gate.ts`, `materializers/*`, `production-release.ts` | content is canonical on the tenant; then apply parity to every `sites/<client>` |
| what a tenant looks like (bindings, policies, config, exports) | platform `sites/<client>/**` — **never** `data/site/**` by hand | exports are `[GENERATED]` by `object_publish` |
| image/PDF generation, templates, rendering, import, capture crawl | `vreich-ui/pdf-tool` | bytes plane; but the **bridge** (scope, grant, public path, `ArtifactReference` allowlist) is platform `server/lib/{pdf-tool-client,pdf-tool-storage-grant,artifacts,artifact-trust}.ts` |
| how an artifact is referenced in a workflow / verified before publish | CMS-Agent `workspace/artifactMaterialization.ts`, `publisher.ts`, `projects/readinessContentChecks.ts` | workflow reference is CMS-Agent's |
| tracking event vocabulary, props, consent, enrichment, relay | platform `packages/core/schema/{tracking-event-v1,bodies/tracking-config-v1}.ts`, `lib/tracking/**`, `server/functions/track-ingest.ts`, `server/lib/tracking-events.ts` | producer owns the vocabulary; the sink validates nothing |
| tables, views, `/stats`, `/rollups`, weights | `vreich-ui/kugel-data` | and write the row contract down in SYSTEM-CONTRACTS.md before CMS-Agent consumes it |
| what CMS-Agent learns from tracking | CMS-Agent `src/agent/improvement/{trackingIngest,engagement,strategyLearning,strategyReview}.ts` — after fixing S-05/S-08 on the producer side, or the numbers are structurally zero | |
| commerce, Stripe, orders | platform `server/functions/{create-checkout-session,stripe-webhook,…}.ts`, `server/lib/commerce-*.ts` | and S-01/S-02 before any revenue number is believed |
| deploy of CMS-Agent | `cloudbuild.deploy.yaml` (trigger) **and** `scripts/deploy-mcp.sh` in lockstep; jobs need their own artifact | two artifacts already disagree |
| system-level documentation | platform `docs/system/*` (this set) + the pointer files in the other three repos | decision recorded in SYSTEM-ARCHITECTURE.md §0 |

## 2. Who owns this data? (the short table — full matrix in SYSTEM-AUTHORITY-MATRIX.md)

| Data | Owner | Canonical store | Everything else is |
|---|---|---|---|
| workspace, runs, stage outputs, receipts, evaluations, playbooks, observations, project registry, chat bearers | CMS-Agent | GCS `cms-agent-503015-cms-agent-state` | derived (workspace mirrors, `artifacts/*.json`, platform request status) |
| content objects (13 types), publish receipt, governance policy, editorial requests (status derived), orders, commerce events, users, chats | tenant (platform) | per-tenant Netlify Blobs | the git export, the CDN, the sink copies |
| artifact bytes + `request-artifacts` index | tenant store, pdf-tool layout, **two writers** | tenant Blobs `artifacts`, `artifact-index` | `ArtifactReference` copies in tool results and runs; public paths in bodies |
| job records, templates, render data, image-search state | pdf-tool (in the tenant's stores) | tenant Blobs `pdf-tool-jobs`, `pdf-templates`, `pdf-render-data`, `image-search` | — |
| sessions, OAuth, capture output | pdf-tool (own site `pdf-x`) | pdf-x Blobs | — |
| raw events, dims, commerce copy, links, aggregates | kugel-data | Netlify DB | platform mirror (replay only), admin memo |
| deploy state | Netlify | — | `DeployReceipt`, CMS-Agent `releaseLedger` |
| export commit | GitHub — the `platform` repository, branch `main` | — | receipt |
| payment | Stripe | — | order record |
| publishing autonomy | **ambiguous** — CMS-Agent project record and platform policy module both hold one | — | — |
| revenue aggregate, promotion | nobody (not implemented) | — | — |

## 3. Where is the canonical schema?

| Thing | File |
|---|---|
| object envelope, receipt, producer, approval pin | platform `packages/core/schema/object-record-v1.ts` |
| bodies (`content_item.v1` …) | platform `packages/core/schema/bodies/<type>-v1.ts` |
| patch grammar (44 ops) | platform `packages/core/schema/object-patch-ops.ts` |
| tracking event / batch / kinds / props | platform `schema/tracking-event-v1.ts`, `schema/bodies/tracking-config-v1.ts:35-54`, `server/lib/tracking-events.ts:34-53` |
| commerce event | platform `server/lib/commerce-events.ts` |
| chat turn (`client_manager.turn.v1`) | CMS-Agent `src/agent/conversations/conversationContract.ts` (+ `CLIENT-MANAGER-CONTRACT.md`) |
| CMS-Agent tools (151) | CMS-Agent `src/agent/mcp/workspace/*.ts` zod; wire lock `docs/mcp-tool-manifest.json` |
| tenant tools (100) | platform `server/lib/mcp-tool-definitions{,-2,-membership,-analytics}.ts` |
| pdf-tool tools (32) | pdf-tool `netlify/lib/mcp-tool-schemas.ts` + `agent-artifact-jobs.ts:519-646` |
| `ArtifactReference` | producer pdf-tool `netlify/lib/artifact-core/artifacts.ts:6-28`; consumer allowlist platform `server/lib/artifacts.ts:32-56,336-351` |
| storage grant | platform `server/lib/pdf-tool-storage-grant.ts` (mint); pdf-tool `netlify/lib/storage-grant.ts` (parse) |
| `snapshot.v1` | pdf-tool `netlify/lib/capture/worker.ts:447-476` |
| sink tables / views | kugel-data `schema.sql`, `netlify/database/migrations/001–005` |
| `/rollups` rows | kugel-data `netlify/functions/_shared/rollups.ts:176-226` |
| `/stats` payload | kugel-data `tracking-sink-stats.ts:152-168`; platform copy `lib/admin/own-analytics-logic.ts:116` |

## 4. Which API may mutate it?

| Data | Only through |
|---|---|
| a run | CMS-Agent `executor.ts` under `withRunLock` (`workflow_*`, tick, conductor job) — never write `runs/*.json` |
| the workspace document | `WorkspaceStateStore.mutate()` (validation, version, revision, change event together) |
| a content object | platform `handleObjectVerb` (three doors: `/mcp`, `object-store` REST + publish key, `admin-object` + Identity) |
| the export | `object_publish` only (`object_retire` for `redirects.json`) |
| a production build | `release_to_production` / `admin-release` (build hook) only |
| artifact bytes | pdf-tool `saveArtifactBytes` under a grant; platform upload/ingest functions |
| sink tables | the four `POST /api/tracking-sink*` endpoints; migrations for views |
| tenant env vars | CMS-Agent genesis/reconciler via Netlify API (and the Netlify UI) |

## 5. Which copy is derived? What must not be edited directly?

Derived, never edit: `sites/<client>/data/site/**` (git export); CMS-Agent `workspace/current.json.stageOutputs[]` mirror and `artifacts/{id}.json`; platform `editorial-requests` `status` (sweep-derived from the run); platform `tracking-events` mirror; kugel-data `commerce_events` (copy of the tenant's store); `DeployReceipt`; `releaseLedger` (CMS-Agent's own attempt record); the admin analytics memo; `ArtifactReference` copies inside runs and tool results (the index record is the durable one); `run-index/*`.

Never edit directly even though you can: CMS-Agent canonical node literals without `nodes:update`; `docs/mcp-tool-manifest.json`, `docs/site-credential-scope-lock.json` (regenerate); platform tool counts/tiers (extend the pinned tests); kugel-data migration files after creation (add a new one; `CREATE OR REPLACE`, columns last); pdf-tool `templateJson` of an existing version.

## 6. Which paths are legacy?

CMS-Agent: `netlify/functions/*` except `session`; `src/agent/runtime/{runAgent,createAgent}.ts` + `skills/{contentDraft,editorialReview,seo,publish}.ts`; Netlify Blobs backend; `WORKSPACE_STORE=json`; the `pdf-tool`/`monetizer` project rows for anything but reads. Platform: `run-publisher-agent.ts`, `save_artifact`, `admin-traffic`, `netlify/lib/*` shims, `schema/schema-v1.ts` (undeletable import), `workflow-contract.ts`, `src/chatkit/`, `lib/publishing-policy.ts` (inert). pdf-tool: `agent-artifact-job*` HTTP, `by-kind/`/`by-request/`/`latest-by-slot/` indexes (written, unread), `docs/MCP_BRIDGE_PARITY.md`. kugel-data: none; `tests/sink.test.mjs` literal `page_view` is wrong.

## 7. What does publishing actually mean?

`object_publish` = export commit to GitHub with `[skip netlify]` + receipt; **nothing is live**. `release_to_production` = build hook + poll; live only when `productionConfirmed:true`. CMS-Agent's `publish_executor` success = the six verbs ran (`published_pending_release`); `release_executor` does the release. Authority is split: CMS-Agent gates decide whether a run attempts; platform's approval policy decides whether the object may be published; release is available to anyone with a tenant credential that sees the tool; Netlify decides go-live. Three unsynchronised autonomy switches exist. Full vocabulary: SYSTEM-PUBLISHING.md.

## 8. How are artifacts represented?

Bytes at `{kind}/{safeRequestId}/{sha256}{ext}` in the tenant store (pdf-tool layout, two writers) → pdf-tool `ArtifactReference` (layer A) + per-call `materializationProof` → platform bridge re-validates (13-key allowlist), verifies once with pdf-tool, strips the proof, adds `public_path` + `verified` → CMS-Agent stores `{artifactReference, publicPath, verification}` per slot → the `article_body` **model** binds `{src: publicPath}` into the body → platform `object_validate` enforces the `/img|/pdf` grammar and index existence → the export and the page carry the path verbatim → `/img/*` serves the bytes. The proof is stored by nobody; the durable evidence is the `request-artifacts/{requestId}/{sha256}.json` index record. Capture output lives on pdf-tool's own site and only the snapshot JSON comes back. Full detail: SYSTEM-ARTIFACTS.md.

## 9. How do I correlate a run to content and results?

Today: run → object via `stageOutputs.publish_executor.receipts.objectId` (nested); object → run via `producer.run_id` only if `producer` was sent (platform-tenant hook, plugins — not dr-lurie conductor publishes); platform request → run via `run_id` on the request doc; request → object via `object_id = requestId`, which holds only on the content-item-shell path; object → export via `publish_receipt.commit_sha`; export → live via deploy ancestry; object → engagement via `object_id` (node kinds only; page kinds name the page); anything → revision: impossible (no version on events); engagement → purchase → revenue: impossible (S-01, S-02); run → outcome: only through `/rollups?by=producer` for objects with a producer row. Full join table: SYSTEM-IDENTIFIERS.md §2.

## 10. What is implemented versus planned?

Implemented: conductor publishing (dr-lurie, platform tenants), clone/capture object publishing, plugin publishing, two-step go-live, artifact generation through the tenant bridge, capture through the bridge, first-party tracking to kugel-data and the admin dashboard (drlurie), rubric evaluation and playbooks in CMS-Agent. Code-only / not running: CMS-Agent W21 tracking ingest, strategy learning, strategy review (no deploy artifact; joins broken). Not working: commerce → revenue. Implemented but not operational: experiments/exposure (edge arm serving, `exposure` event, `/weights` read at build — every tenant ships `experiments: []`, and the producer and sink do not agree on the arm key or the weights envelope, S-24/S-25); the admin analytics window/filters and raw export (the deployed sink reads `days` only and has no `/export`, S-23); the admin Insights tab and the `analytics_*` MCP tools' upstream learning reads (refused on the tenant bearer, S-07). Not implemented: promotion/campaigns, per-gate manual-approval UI, publishing for fernwell/zilberman/minted tenants, closed learning loop (**NO CLOSED FEEDBACK LOOP CURRENTLY EXISTS**). Pending, not on main: platform PR #695 (docs), kugel-data PR #9 (docs) and the kugel-data branch `runner/w21-r116` that platform's `/stats`/`/export` readers code against.

## 11. Ten cross-repo rules (MUST)

1. A publish receipt proves an export commit, never a deploy; only `productionConfirmed:true` means live.
2. Content is canonical on the tenant from `object_create` onward; CMS-Agent keeps receipts, never content.
3. Never hand-edit `sites/<client>/data/site/**`, `runs/*.json`, or migration files.
4. `run.requestId` is the platform join key; the publish id is `artifact_plan`'s / the shell's / `publishRequestId` — do not conflate (S-06).
5. Any new pdf-tool `ArtifactReference` field must be allowlisted in platform `artifacts.ts` in the same change, or every reference is rejected.
6. Any CMS-Agent tool platform calls with the tenant bearer must be in `SITE_CLIENT_MANAGER_TOOLS` (+ `scope:update` + reconciler) in the same change, and every run-addressed call must pass `projectId` (the scope check binds by argument, not by run — S-26).
7. Any new tracking kind or prop must be in the platform enum/allowlist first; the sink accepts anything and validates nothing.
8. Any new `/rollups` grain, `/stats` parameter or sink endpoint needs its shape written in SYSTEM-CONTRACTS.md before a reader codes against it; a missing grain or endpoint must answer a status the consumer treats as absent — the deployed sink ignores unknown query parameters silently (S-23).
9. Bytes never travel through MCP; grants never leave the platform bridge; `materializationProof` is never stored.
10. Run `node scripts/docs/system-contracts.mjs --check` (platform) after touching any literal in the lock; regenerate with `--write` and re-read the affected system doc.
