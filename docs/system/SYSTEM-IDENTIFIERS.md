# System identifiers — who mints what, and what joins to what

> Pins: `CMS_AGENT_SHA=44acb04a1f54281761ab3c34219913198d117950` · `PLATFORM_SHA=d5845dd6e855b434547430d6b0bb4d60b9f60a3c` · `PDF_TOOL_SHA=2c28a4b6430a9589b384dd634f08e9ace5c4e84b` · `KUGEL_DATA_SHA=d9723664521c97be87934874927e9e4603da68ba`.

## 1. Identifier catalogue

| Identifier | Format | Minted by (generator) | Random / deterministic | Scope | Crosses into | Evidence |
|---|---|---|---|---|---|---|
| CMS-Agent run id | `run_<epochMs>_<6 base36>` | CMS-Agent `executor.ts:207` | random | one run | platform (`workflow_*` args, request doc, `derive-status`), conductor publish id tail (last 6 chars) | VERIFIED |
| independent node run id | `node_run_<epochMs>_<6 base36>` | CMS-Agent `nodeRuntime.ts:26` | random | `node_execute` runs | — | VERIFIED |
| CMS-Agent store ids (`rev_`, `evt_`, `learning_`, `stage_`, `fb_`, `prop_`, `trial_`, `pb_`) | `<prefix>_<epochMs>_<6 base36>` | `store.ts:114`, `improvementTypes.ts:7` | random | CMS-Agent | — | VERIFIED |
| MCP request id (CMS-Agent, per JSON-RPC call) | `req_<epochMs>_<rand>` | `mcpEndpoint.ts:70` | random | one call; **never logged** (CMS-Agent K-O1) | — | VERIFIED; collides visually with editorial request ids — never confuse |
| **Editorial request id** = platform request registry key | `req_<flow>_<topic>_<yyyymmdd>_<nn>`; chat mint `req_agent_<slug>_<yyyymmdd>_<nn>` (nn bumped while a `content_item` with that id exists) | platform `agent/tools.ts:1069-1083` (chat); operators by hand; plugins per skill text | deterministic in (slug, day) + existence probe | tenant + CMS-Agent | CMS-Agent `run.requestId` (`workflow_start_dry_run.requestId`); content-item shell `requested_id`; tenant object id **when the shell path holds** | VERIFIED-BOTH-SIDES |
| **Publish request id** (CMS-Agent) | same grammar; conductor-minted form `req_conductor_<topic≤32>_<run tail 6>_<yyyymmdd>_01` | `artifact_plan` output (model) → `artifact_materializer` (shell id wins) → `run.publishRequestId` (operator or executor mint at `no_media_slots`, `executor.ts:1676-1690`) | derived | one run | tenant object id (dr-lurie `requested_id`), pdf-tool `requestId`, `/img` `/pdf` path segment, `release:<runId>:<…>` ledger key | VERIFIED |
| Tenant object id | `^(site\|page\|tpl\|stpl\|sec\|nav\|tax\|thm\|prod\|req\|trk\|voice\|vis)_[a-z0-9_]+$`, ≤ 200; `content_item` ids are `req_…`; singletons `trk_<site>`, `voice_<site>`, `vis_<site>` | platform `object-ids.ts`, `object-ids-mint.ts`; `requested_id` accepted from callers for `content_item` | deterministic (seeded) or caller-supplied | tenant | tracking `object.object_id`; dims rows; kugel-data joins | VERIFIED-BOTH-SIDES (sink re-checks nothing; platform re-checks `isObjectIdForType` at ingest) |
| section instance id / node id / term id | `s_<12 hex of sha256(seed)>`, `n_<12 hex>` (forbidden words `hook\|agitation\|cta\|advert\|offer`), `t_<alnum>` | platform `object-ids-mint.ts:136-149` | deterministic hash | body | tracking `object.section_id/node_id/term_id`; `node_strategy.node_id` | VERIFIED-BOTH-SIDES |
| `version` / `content_revision` | integers | platform verbs (every write / body writes only) | monotonic | object record | export `__generated.record_version` → `object_version.version`, `producer.version`; **never on a tracking event** | VERIFIED-BOTH-SIDES |
| `producer` context | `{run_id, node_id, prompt_version, model}` each ≤ 128, all-or-nothing | CMS-Agent platform-tenant hook (`nodeExecutionProvenance.ts:38-60`: run id, node id, prompt hash, model); plugin LLM per `render-skill.ts:313` (`run_id:"plugin_<actor>_<request_id>", node_id:"plugin:<actor>"`); **nobody for dr-lurie conductor publishes** | mixed domains | object record history → export → `producer` table → `/rollups?by=producer` → CMS-Agent `FeedbackRecord.nodeId/runId` | VERIFIED-BOTH-SIDES; S-05 |
| Artifact request id (pdf-tool `requestId`) | any non-empty string on pdf-tool (`z.string().min(1)`; optional descriptor pattern); platform validates `validateRequestId` before bridging; internal example jobs `req_visimg_<vs>_<ctx>_<yyyymmdd>_<nn>` | platform bridge (from `request_id` = content_item id) | caller-supplied | tenant + pdf-tool | blob key segment (lossy `safePathSegment`), index key segment (`encodeURIComponent`), public path segment | VERIFIED-BOTH-SIDES; three encodings of one value (§4) |
| Artifact slot | platform `PDF_SLOT_RE /^(?:pdf\|download)_…/`, `IMAGE_SLOT_RE /^img_…(?:_\d{2})?$/`, `GENERIC_SLOT_RE`; pdf-tool `/^[a-zA-Z0-9._-]+$/`; CMS-Agent free-form from `brief_architect` (sanitised for filenames only) | CMS-Agent model node | free | run → tenant → pdf-tool `by-slot/` key | VERIFIED-BOTH-SIDES; grammar strictest on platform |
| `blobKey` (Major Key) | `{image\|pdf\|binary}/{safeRequestId}/{sha256}{ext}` | pdf-tool `artifact-layout.ts` and platform `artifacts.ts:427-455` (own uploads) | content-addressed | tenant `artifacts` store | `ArtifactReference.blobKey`, `verifiedMediaRefs`, public path | VERIFIED-BOTH-SIDES (duplicate grammar) |
| Public path | `/img/{requestId}/{sha256}.{ext}`, `/pdf/{requestId}/{sha256}.pdf` | platform `publicPathForArtifactRef` | derived from `blobKey` | tenant site | `content_item` body `media.src`/`image.src`; CMS-Agent `publicPath`; `verify_article_images.expectedImages` | VERIFIED-BOTH-SIDES |
| pdf-tool `jobId`, `validationId`, `previewId` | uuid-like strings | pdf-tool | random | tenant `pdf-tool-jobs` store | platform `polling.input.job_id`; CMS-Agent `SlotJobState.jobId` | VERIFIED |
| `materializationProof` | `v1.<b64url payload>.<b64url hmac>` over `{projectId, requestId, blobKey, sha256, …}` | pdf-tool | deterministic per (secret, tuple) | one read | platform (transient) | VERIFIED-BOTH-SIDES; never stored |
| Capture job id / request id | pdf-tool `jobId`; `requestId = captureBridgeRequestId(siteId, url)` (platform) | platform bridge | deterministic in (site, url) | pdf-tool own store `capture-jobs/by-request/{requestId}` | CMS-Agent capture engine (`job_id` only) | VERIFIED-BOTH-SIDES |
| Tracking `event_id` | uuid v4 | browser `env.uuid()` (`loader/core.ts:182`) | random | one event | kugel-data `event_id UNIQUE` (idempotency law); mirror key | VERIFIED-BOTH-SIDES |
| Tracking `project_id` | bare site slug (`drlurie`) | tenant env `TRACKING_PROJECT_ID`, fallback `siteShortId` | deterministic | tenant | partition key on every kugel-data table; CMS-Agent `TRACKING_PROJECT_ID` (must equal the tenant's) | VERIFIED-BOTH-SIDES; equality of the two env values is UNKNOWN |
| `vhash` / `shash` | sha256 hex | platform `tracking-events.ts:118-123`: `sha256(salt+utcDate+ip+ua+project_id)`, `sha256(salt+vhash+floor(now/30min))` | deterministic, rotates daily / every 30 min | visitor-day / 30-min window | `member_link.shash`; kugel-data sessions/visitors | VERIFIED-BOTH-SIDES |
| `vid` (`_dlid`) | uuid in localStorage, ≤ 396 days, consent-only | browser | random | consented browser | `tracking_events.visitor_vid` | VERIFIED |
| `member_hash` | sha256 of lowercased e-mail | platform `member-link.ts:63` | deterministic | member | `member_link` | VERIFIED-BOTH-SIDES |
| `commerce_event.event_id` | uuid | **(A)** `randomUUID()` — `commerce-events.ts:123`, `order-reissue.ts:104`; **(B)** `deterministicUuid(session.id:type)` — `stripe-webhook.ts:69-75,210,254` | mixed | one commerce event | kugel-data `commerce_events.event_id` | VERIFIED-BOTH-SIDES |
| Stripe `metadata.event_id` → `X-CEID` → `props.commerce_event_id` | uuid | `create-checkout-session.ts:121` `randomUUID()` **(C)**; echoed by `checkout-session-status.ts:33-40` | random, ≠ A, ≠ B | one checkout | `tracking_events.props.commerce_event_id` (indexed) | VERIFIED-BOTH-SIDES; join structurally impossible (S-01) |
| Stripe `session_id` | `cs_…` | Stripe | — | one checkout | `commerce_events.session_id` (never joined) | VERIFIED |
| `idempotency_key` (tenant tools) | free string ≤ 200, stored as `idem:<tool>:<key>` | callers: CMS-Agent `artifact:<runId>:<requestId>:<slotId>`, `release:<runId>:<commitSha\|objectId\|requestId>`; platform chat `publish:<runId>`, `release:<runRef\|commit\|head>` | deterministic | tenant idempotency store | — | VERIFIED-BOTH-SIDES |
| Chat `conversation_id` / `turn_id` | platform-minted | platform `agent/engine.ts` | — | one chat / one turn | CMS-Agent claim key `(conversation_id, turn_id)`; stuck claims are permanent (CMS-Agent C-8) | VERIFIED-BOTH-SIDES |
| Scoped bearer digest | sha256 of the token | CMS-Agent `managedScopedBearerCredentials.ts:89` | deterministic | tenant chat credential | `auth/managed-scoped-bearers.v1.json` | VERIFIED |
| `variant_id` / `experiment_id` | platform `exposure` props (both `content_item` ids: `experiment_id` = control, `variant_id` = served arm, equal for the control) — emitted only when a tenant configures `experiments[]`; none does at the pins | kugel-data reads `variant_id` only and keys the arm by the event's `object_id` (the page shell — S-25); platform's build keys by `experiment_id` | `experiment_id` ↔ sink arm key: **does not join** | — | — | CONTRADICTED |
| Promotion / campaign / placement id | none | nobody | — | — | — | not implemented |

## 2. What joins to what today (both sides read)

| Join | Key | Holds? | Where it breaks |
|---|---|---|---|
| platform editorial request → CMS-Agent run | `run_id` stored on the request doc (from `workflow_start_dry_run`) | yes | — |
| CMS-Agent run → published tenant object | `stageOutputs.publish_executor.receipts.objectId` (nested) | yes, from the run side only | no top-level `publishedObjects[]` (CMS-Agent recommendation); the tenant record carries no run id unless `producer` was sent |
| platform request → tenant object | `doc.object.object_id = requestId` (sweep assumption) | **conditional** (§3) | S-06 |
| tenant object → CMS-Agent run | `history[].details.producer.run_id` / export `__generated.producer.run_id` | only when `producer` was sent (platform-tenant hook, plugins) | dr-lurie conductor publishes: never (S-05) |
| tenant object → export commit | `publication.publish_receipt.commit_sha` | yes | receipt ≠ deploy |
| export commit → production deploy | `deploy.commit_ref` ancestry (`isCommitAncestorOrEqual`) | yes, when lookup configured | `productionConfirmed:false` is ambiguous |
| run → release | `releaseLedger[runId:requestId]`, `idempotency_key release:<runId>:<commitSha>` | yes (CMS-Agent side) | replay marker unreadable (S-11) |
| artifact → owning content item | `requestId` segment of `blobKey`, `request-artifacts/{requestId}/` index | yes | `requestId` is lossy in the blob key, injective in the index |
| artifact → job | `SlotJobState.jobId` (CMS-Agent), job record (tenant store) | yes | job records have no CAS (pdf-tool KI-06) |
| tracking event → object | `object.object_id` | yes for node-level kinds; page-level kinds name the **page** object | S-08 |
| tracking event → revision | none — `tracking_events` has no `version` | **no** | S-13 |
| tracking event → producer (run, node, prompt) | `object_version`/`producer` by object, **latest published version** | approximate; rewritten on republish | S-13 |
| tracking event → session / visitor | `shash` / `vhash` | yes (30-min windows, daily rotation) | semantics, not a break |
| session → member | `member_link(project_id, shash, member_hash)` | yes | dead identifier: never joined by any report (kugel-data KI-24) |
| tracking event → purchase | `props.commerce_event_id = commerce_events.event_id` | **never** | S-01 |
| purchase → revenue | `commerce_events.kind = 'purchase'` | **never** | S-02 |
| rollup producer row → CMS-Agent node/run | `(run_id, node_id)` → `FeedbackRecord.nodeId/runId` | shape holds; population empty for CMS-Agent's own dr-lurie content; plugin rows carry `node_id = 'plugin:claude'` which is not a workspace node | S-05 |
| strategy rows → anything | none | **no** (`by=strategy` rejected; `node_strategy.strategy` null) | S-03, S-04 |
| CMS-Agent learning observation → evidence | `metadata` free text; `runId?`, `nodeId?` | no evidence ids | SYSTEM-TRACKING-AND-ATTRIBUTION.md §7 |

## 3. The request-id rule (three ids that are sometimes one)

Three identifiers share the grammar `req_<flow>_<topic>_<yyyymmdd>_<nn>`:

1. **`run.requestId`** — the platform/workspace join key, supplied to `workflow_start_dry_run` (platform mints `req_agent_…`). CMS-Agent: "never a source for the publish id" (`publishRequestId.ts` rule 3; `runContext.ts:95-133`).
2. **the publish request id** — authored by `artifact_plan`, overridden by the content-item shell's id (`artifactMaterialization.ts:772-779`), else `run.publishRequestId` (operator, or executor-minted `req_conductor_…` at a `no_media_slots` skip).
3. **the tenant object id** — dr-lurie: `requested_id` on `object_create` (`objectIdSource: 'request_id'`); platform tenant: server-minted.

They coincide **only** on the shell path: a live (`executionMode: 'openai'`) run, with a `requestId` that matches the project's `requestIdPattern`, whose `artifact_materializer` node dispatched (creating the shell under `run.requestId`) — then id 2 = id 1 and, for dr-lurie, id 3 = id 1. Otherwise id 2 ≠ id 1 and the tenant object id follows id 2. The platform sweep writes `object.object_id = requestId` regardless (`requests/sweep.ts:395-413`), and `mintWorkspaceRequestId` bumps `nn` on the assumption that the id will be taken by a content item. Consequence and fix direction: S-06.

Grammar copies: platform `agents-naming.ts:2` (strict two-segment form), `requests/store.ts:45` and `agent/tools.ts:1066` (looser `^req_[a-z0-9_]+_\d{8}_\d{2}$`), CMS-Agent `publisher.ts:47` and `publishRequestId.ts:38` (same loose form) plus the per-project `objectDialect.requestIdPattern` string on both dr-lurie and platform project records (`"^req_[a-z0-9_]+_\\d{8}_\\d{2}$"`). pdf-tool has none. Five declarations, two shapes.

## 4. Duplicated grammars (drift surfaces)

| Grammar | Declarations | Divergence today |
|---|---|---|
| Artifact blob key | pdf-tool `artifact-layout.ts:43-51` (`/^([a-z]+)\/(.+)\/([a-f0-9]{64})(\.[a-z0-9]+)?$/`), platform `artifact-trust.ts:5` (`/^(image\|pdf)\/[^/]+\/[0-9a-f]{64}\.[a-z]+$/i`), platform `artifacts.ts:492-504` (`validateRequestId` on the segment) | platform rejects `binary/` kind (capture output) and unvalidated request segments; pdf-tool accepts both — consistent with capture bytes never reaching a tenant |
| `safePathSegment` | pdf-tool `artifact-layout.ts:30-34` (regex collapse, lossy), pdf-tool `artifact-index.ts:15-17` (`encodeURIComponent`), pdf-tool `safePart` ×2, platform `artifacts.ts` `safePathSegment` (lowercases) | the same `requestId` appears in up to three encodings; `verify_agent_artifact` treats the blob-key form as a pre-filter only |
| Public path | platform `artifact-trust.ts:17-23` (write), `get-public-image.ts:41-42` / `get-public-pdf.ts:24-25` (serve, `[a-z0-9._-]+` id segment), `object-validate.ts:1961-1962` (validate), pdf-tool `parsePublicArtifactPath` (8 kinds) | serving accepts ids `validateRequestId` would refuse; pdf-tool's parser knows kinds platform never serves |
| `ArtifactReference` field set | pdf-tool interface (19 fields incl. aliases), platform allowlist (13), CMS-Agent tolerant reader | an added pdf-tool field is rejected by platform until allowlisted |
| Tracking kinds | platform enum (19, incl. `exposure`), kugel-data literals (`pageview`, `node_impression`, `buy_click`, `cta_click`, `exposure`) | `exposure` now on both sides but joined on different keys (S-25); sink test fixture `page_view` |
| Commerce kinds | platform `commerceEventTypes` (8), kugel-data `'purchase'` | disjoint |
| Storage grant | platform type (`grantVersion`, `overBudget`), pdf-tool parser (aliases) | two keys sent and ignored |
| Request-id form | five declarations (§3) | two shapes |

## 5. Deterministic vs random — the identifiers a future learner needs to be stable

Stable and deterministic today: object ids, node/section/term ids, `version`/`content_revision`, `blobKey`/`sha256`, public paths, `vhash`/`shash` (within their windows), conductor publish ids (given run id + topic + day), CMS-Agent idempotency keys.

Random today: run ids, every CMS-Agent record id, tracking `event_id` (correct — it is an idempotency key), commerce event ids on two of three paths, checkout `metadata.event_id`, chat turn ids, pdf-tool job ids.

Random where determinism is required for a join: **`create-checkout-session` `metadata.event_id`** (C) must equal the webhook's `deterministicUuid(session.id + ':checkout_completed')` (B), or the webhook must carry C — SYSTEM-FUTURE-EXTENSIONS.md §2 item 2.
