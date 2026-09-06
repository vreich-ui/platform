# System tracking, attribution and the (absent) learning loop

> Pins: `CMS_AGENT_SHA=44acb04a1f54281761ab3c34219913198d117950` · `PLATFORM_SHA=d5845dd6e855b434547430d6b0bb4d60b9f60a3c` · `PDF_TOOL_SHA=2c28a4b6430a9589b384dd634f08e9ace5c4e84b` · `KUGEL_DATA_SHA=d9723664521c97be87934874927e9e4603da68ba`.
> Everything below was verified on both the producer (platform / CMS-Agent) and consumer (kugel-data / CMS-Agent) side. Repository-level findings appear here only after that re-test. Production observations quoted from the kugel-data audit (public `/stats` for `drlurie`, 90 d to 2026-09-06) are marked PROD-OBSERVED and are not re-fetched here.

## 1. Producer: what a tenant emits

| Feed | Producer code | Shape | Transport | Sink endpoint | Consumer validation |
|---|---|---|---|---|---|
| Engagement events | browser loader `lib/tracking/loader/*` → `server/functions/track-ingest.ts` | `tracking_event.v1` (strict; 19 kinds — 18 + `exposure {experiment_id, variant_id}` since #694, emitted once per page-load from the `data-cms-experiment`/`data-cms-variant` DOM marker, never while every tenant ships `experiments: []`; props allowlist per kind; server stamps `project_id`, `vhash`, `shash`, `context.ua`, `context.geo{country, subdivision}`) | NDJSON, bearer `TRACKING_SINK_TOKEN`, 2 s, no retry; mirror on failure | `POST /api/tracking-sink` | requires `event_id, project_id, ts, event, url_path, visitor_mode, vhash, shash`; `event` any string; `props` passthrough; `schema` dropped |
| Dimensions | `scripts/tracking-dims-push.mjs` at build | `object_version[]`, `producer[]`, `node_strategy[]` from committed exports | JSON, bearer, 2 s, `\|\| true` | `POST /api/tracking-sink/dims` | `normalizeObjectVersion/Producer/NodeStrategy`; `surface`/`attribution` not read |
| Commerce | `server/lib/commerce-events.ts` (webhook, `save-commerce-event`, reissue) | `{event_id, project_id, ts, kind: event.type, product_id, order_id, session_id, amount_cents, currency, payload}` | NDJSON, bearer, 2 s, fire-and-forget | `POST /api/tracking-sink/commerce` | requires `event_id, project_id, ts, kind`; `kind` any string |
| Member link | `server/lib/member-link.ts` (opt-in, Stripe buyer) | `{project_id, shash, member_hash}` | JSON, bearer, 2 s | `POST /api/tracking-sink/link` | all three required |

Only **drlurie** has a committed `tracking_config` export with `own.enabled:true`; the `platform` tenant ships the loader with `providers: {}` (collection without a declared provider — platform #6); zilberman and fernwell mount no loader. Whether `TRACKING_SINK_URL`/`TOKEN`/`SALT`/`PROJECT_ID` are set per tenant is UNKNOWN from code; PROD-OBSERVED events exist only for `project_id = drlurie`.

## 2. Consumer: what kugel-data stores and derives

Tables: `tracking_events` (no `version` column), `commerce_events`, `member_link`, `object_version` (no `surface`/`attribution`), `producer` (no `workflow_version`), `node_strategy`, `experiment_weights`. Views (migration 005 final): `v_variant_assignment` (`event='exposure'` + `props->>'variant_id'`), `v_session_object`, `v_attributed_events` (LEFT JOIN; synthetic `'control'`), `v_attributed_purchases` (`ce.event_id::text = props->>'commerce_event_id' AND ce.kind='purchase'`), `v_sessions`, `v_object_window` (grain `(project_id, object_id, variant_id, day)`), `v_producer_window` (grain `(project_id, run_id, node_id, prompt_version, day)`, joined through the **latest** published version per object). Reads: `/stats` (no auth, leak guard), `/rollups?by=object|producer` (bearer), `/weights` (no auth), `experiment-weights` `@daily`.

## 3. Trace: Platform event → transport → ingestion → tables → dimensions → rollups → commerce joins → revenue

| Stage | Holds? | Both-sides evidence |
|---|---|---|
| browser → `/api/t` | yes | `loader/index.ts`, `track-ingest.ts` |
| `/api/t` → sink insert | yes, at-most-once | `forwardToSink` → `insertRows … ON CONFLICT (event_id) DO NOTHING` |
| event → object (node kinds) | yes | `objectOf(ref)` attaches the article id only to node refs |
| event → object (page kinds: `pageview`, `engagement`, `scroll_depth`, `cta_click`, section kinds) | **names the page object** (`page_article`), not the article | `loader/index.ts:68-79` (`[data-cms-object-id^="page_"]` preferred) vs `v_object_window` denominators `COALESCE(NULLIF(exposures,0), pageviews)` — per-article `pageviews = 0`, `cta_ctr = 0`, `purchase_rate = 0` (S-08) |
| event → dimensions | `object_version` yes; `producer` only for objects published with a `producer` context; `node_strategy` rows exist but `strategy`/`intent` are null for exports ≥ 2026-09-03 (S-03) | `tracking-dims-push.mjs:86-100`, `materializers/shared.ts:132` |
| event → revision | **no** — no `version` on events; `v_producer_window` attributes all history to the latest version (S-13) | `004:23-25`, `005:194-296` |
| rollups by object | yes (with the zero denominators above) | `_shared/rollups.ts` |
| rollups by producer | shape yes; population: plugin-published objects only on drlurie (CMS-Agent's dr-lurie hook sends no `producer`, S-05) | `drLurie/hooks.ts:162`, `platform/hooks.ts:157-165` |
| rollups by strategy | **400** — not implemented on the sink (S-04) | `_shared/rollups.ts:32-36` |
| event → commerce event | **never** — `props.commerce_event_id` (= checkout `metadata.event_id`, `randomUUID()`) ≠ any `commerce_events.event_id` (`deterministicUuid(session.id:type)` or a second `randomUUID()`) (S-01) | `create-checkout-session.ts:121`, `checkout-session-status.ts:33-40`, `stripe-webhook.ts:69-75,210`, `commerce-events.ts:123`, `005:109-124` |
| commerce → purchase / revenue | **never** — `kind = event.type ∈ {checkout_completed, …}`; sink filters `kind = 'purchase'` (S-02) | `commerce-events.ts:187`, `tracking-sink-stats.ts:97`, `005:119-121` |
| `buy_click` → commerce id | never carries one: `create-checkout` returns `event_id` in the body, no `X-CEID`; only `checkout-session-status` sets the header, landing on `goal` (platform #8, re-verified) | `loader/index.ts:121-136`, `create-checkout-session.ts:147` |
| revenue currency | summed across currencies (kugel-data KI-06) | views `sum(amount_cents)` |
| purchase attribution | any-touch per session, non-additive across objects (kugel-data KI-07) | `v_session_object` |
| PROD-OBSERVED | 0 commerce events, 0 member links, 0 `buy_click`/`goal`/`exposure` in 90 d — every commerce defect is latent in production; no tenant is live on Stripe | kugel-data audit |

Re-tested platform-audit bugs, disposition: #1/#8 commerce id — CONFIRMED both sides (three generators, not two); #2 kind — CONFIRMED; #3 strategy nulls — CONFIRMED (empirically, exports ≥ 2026-09-03 have no `private`); #4 surface/attribution dropped — CONFIRMED (`002` columns, `normalizeObjectVersion`); #13 bearer on `/stats` — CONFIRMED, harmless; #14 experiments inert — CONFIRMED (`exposure` absent from the enum; PR #694 pending); #9 stale fixture — CONFIRMED and the sink's own acceptance test uses `page_view` (kugel-data KI-19).

## 4. Identifiers that reach the sink (and which are dead there)

| Identifier | On events? | On dims? | Joined by any sink query? |
|---|---|---|---|
| `object_id` | yes (node kinds: article; page kinds: page) | yes | yes |
| `node_id` (article node) | yes | `node_strategy.node_id` | yes (completion proxy) — note `producer.node_id` is a **different** id domain (CMS-Agent workspace node / plugin label) |
| `section_id`, `section_type`, `term_id`, `node_kind` | yes | partly | no |
| `version` | **no** | yes | via latest-version guess only |
| `run_id`, `prompt_version`, `model` (producer) | no | yes | `run_id`, `prompt_version` grouped; `model` dead |
| `surface`, `attribution` | no | sent, dropped | no |
| `commerce_event_id` | `buy_click`/`goal` props | — | yes, never matches |
| `session_id` (Stripe) | — | commerce | dead |
| `member_hash` | — | link | counted only |
| `vid` | consented only | — | `consented_sessions` |
| `variant_id`, `experiment_id` | yes, on `exposure` only (both = `content_item` ids; `variant_id === experiment_id` for the control arm) — no event at the pins because no experiment is configured | `props->>'variant_id'` on the first `exposure` per (`shash`, **event `object_id`**) — `experiment_id` is never read | `v_variant_assignment`, arm rollups, `experiment_weights` — keyed by the page shell's `object_id`, not the control id (S-25) |
| `schema` | sent | — | dropped |

## 5. Analytics surfaces

- `/admin/analytics?source=own` → platform `admin-analytics.ts` → `own-tracker-stats.ts` → `/stats?project_id&from&to[&exclude_test&country&source&object_id]` + local `publishingSurfaces()` join on publish receipts; 5-min memo. kugel-data at the pin reads `project_id` and `days` only, so every window and filter is silently the 7-day default (S-23). `resource=raw_export` → `${TRACKING_SINK_URL}/api/tracking-sink/export` — absent on kugel-data and doubled under the relay-URL convention (S-22); degrades to "not available on this sink yet".
- `/admin/analytics/object/<id>` and the Variants workspace → `own-tracker-rollups.ts` → `/rollups?by=object` (bearer) and `/weights` — per-object rows keyed by `page_*` ids for every page-level kind (S-08).
- `/admin/analytics` **Insights** tab → `analytics-insights.ts` → CMS-Agent `feedback_list {kind:'outcome'}`, `playbook_get {nodeId}`, `optimizer_status`, `learning_list_observations` with the tenant chat bearer — all four outside the 11-tool scope, refused before dispatch (S-07); each section degrades to empty.
- Three MCP tools `analytics_summary`, `analytics_top_content`, `analytics_object` (`mcp-analytics-handlers.ts`, since #694) proxy `/stats` server-side for agents and the plugin skill (`render-skill.ts` names `analytics_top_content`) — same S-23 window caveat.
- `/admin/analytics` (default) → Netlify Analytics v2 (`/pageviews`, `/visitors`, `/ranking/pages`, `/ranking/sources`).
- `/weights` at build time: `scripts/tracking-experiments-build.mjs` → `fetchWeights` → `${TRACKING_SINK_URL}/weights?project_id` (2 s, best effort) — reads `body.weights`, kugel-data answers `{project_id, experiments}` (S-24), so weights are always equal.

## 6. Privacy and retention (system-level facts)

Raw IP dies inside `track-ingest.ts`; `vhash` rotates daily; `shash` is a fixed 30-min window; consent is recorded on every event and enforced nowhere server-side (both sides); `TRACKING_SALT` has no rotation path; kugel-data stores `context` (UA ≤ 512, referrer, geo) and commerce `payload` (email hash, UA, referrer) verbatim with **no retention, TTL, purge or deletion path**; platform's mirror prune script is unscheduled; one fleet-wide `TRACKING_SINK_TOKEN` authorises every project's writes and `/rollups` reads (kugel-data KI-13); `/stats` and `/weights` are enumerable by `project_id`.

## 7. The current learning loop — reconstructed, not designed

### 7.1 What exists in code

| Layer | Exists? | Where | Deterministic? |
|---|---|---|---|
| Raw measurement | yes | browser observers → `tracking_events` | yes (no model) |
| Normalized evidence | yes | `track-ingest.ts` enrichment; sink views; `/stats`, `/rollups` | yes |
| Attribution | partial | object-level yes; revision-level no; producer-level only where `producer` was sent; purchase never | yes |
| Evaluation | yes, **rubric-based, not outcome-based** | CMS-Agent `evaluation/*` (rubrics, judge, regression) | model-judged |
| Outcome ingestion | code only | CMS-Agent `feedback.ingest_tracking` / `job:tracking-ingest` → `FeedbackRecord{kind:'outcome', outcome:{source:'tracking:engagement.v1', metrics}}` keyed by `(nodeId, runId)` from `by=producer` rows | yes |
| Engagement evidence in diagnosis | code only | `optimizer.analyze` → `engagement` block (floor `sessions ≥ 50`, site median from `by=object`, shortfall ratio 0.8) → `proposeImprovement` cause `engagement_below_site_median`; trials stay rubric-judged | yes, then a model turn |
| Strategy learning | code only | `job:strategy-learning` → `by=strategy` rows → `tracking:strategy.v1` observations → playbook items for six writer/planning nodes at `n ≥ 100` over ≥ 2 windows (`provenance.source:'tracking'`, **no feature flag**) | yes |
| Strategy review | code only | `job:strategy-review` weekly → `marginalia_create` proposal on an `editorial_strategy` object named by env (`EDITORIAL_STRATEGY_*`); `STRATEGY_REVIEW_AUTOPATCH` enables nothing (`applied:false` is a type literal) | yes, then a model turn |
| Learning observation | yes | `workspace/current.json.learningObservations[]` via `learning_record_observation`, publisher, W21 | stored; **not injected into any prompt** |
| Agent memory that changes behaviour | yes | per-node playbooks, injected on every dispatch | curated / promoted |
| Future decision | — | the next run reads the playbook | — |

### 7.2 Why no closed loop exists at the pins

**NO CLOSED FEEDBACK LOOP CURRENTLY EXISTS.** The chain from a reader's behaviour to a changed agent decision is broken at every one of these points, each verified on both sides:

1. **Not running.** None of `job:tracking-ingest`, `job:strategy-learning`, `job:strategy-review` has a Cloud Run job, schedule or env in any deploy artifact (`cloudbuild.deploy.yaml:44,101-102`, `scripts/deploy-*.sh`). `TRACKING_SINK_URL/TOKEN` appear in no CMS-Agent deploy file; genesis reads them from the service's own env to install them on new tenant sites (`capture/siteGenesis.ts:266-272`), so they may be hand-set on the service — UNKNOWN. Whether an operator runs the jobs by hand is UNKNOWN.
2. **No producer rows for CMS-Agent's own content.** The dr-lurie publish hook sends no `producer`; the platform-tenant hook does, but that tenant has no `own` tracking provider. So `v_producer_window` on the only tracked tenant contains **plugin** content only, keyed by LLM-authored labels (`plugin:claude`, `plugin_claude_<request>`) that are not CMS-Agent nodes or runs (S-05). `feedback.ingest_tracking` would file outcomes under `nodeId = 'plugin:claude'`, which `optimizer.analyze` for a real node never reads.
3. **Zero denominators.** Per-article `pageviews`/`exposures` are 0 because page-level events name the page object; `cta_ctr`, `buy_click_rate`, `purchase_rate` are structurally 0 for every article (S-08); only `sessions`, `completion_rate`, `p75_dwell_ms` carry information. The experiment half added by #694 inherits the same key: an `exposure` names the page shell, kugel-data keys the arm by it, the build looks weights up by the control content_item id, and the weights envelope does not match either way (S-24, S-25) — so even a configured experiment would run at equal weights with rollups the platform cannot read back.
4. **Strategy grain does not exist** on the sink (400), and the `strategy`/`intent` dimensions it would group by are null for all new content (S-03, S-04). `strategy-review` reads `funnel_stage`/`topic`/`n` fields that `by=object` rows never carry (`strategyReview.ts:163-180`), so it always ends `no_rows`.
5. **Revenue is unreachable** (S-01, S-02), so `purchase_rate`/`revenue_cents` in `TRACKING_METRIC_KEYS` are always 0 even with sales.
6. **No revision on events**; a republish rewrites the producer attribution of history (S-13), so an outcome once ingested for `run_old` is not reproducible.
7. **Observations carry no evidence ids.** `LearningObservation{observation, metadata?, runId?, nodeId?}` has no field naming the sink window, rows, objects or versions it was derived from; `tracking:strategy.v1` puts them in free-form `metadata`. Stored observations are not self-learning — they are text a curation step may later promote.

The admin Insights tab added by platform #694 does not change this verdict: it *displays* CMS-Agent feedback outcomes, playbooks, optimizer status and observations (read-only), writes nothing back, and is refused on the genesis-minted bearer (S-07); its header's claim that outcome records keyed by `plugin:claude` exist is UNKNOWN from the four repositories.

What does hold: the measurement half is model-free and deterministic end to end; `/rollups?by=producer` emits the producer-grain vector a learner wants; the CMS-Agent consumer is bounded (`MAX_ROWS 500`, thresholds, "absent ≠ 0"); playbooks are the one mechanism that changes a future run, and they are injected deterministically.

### 7.3 Where a stored observation could come from today

| Writer | Trigger | Evidence attached |
|---|---|---|
| publisher (`publish_executed` / `publish_failed`) | every live publish attempt | `{type, projectId, requestId, runId}` |
| `learning_record_observation` tool | any full-bearer caller (human, connector, node via controlled tool) | caller-supplied `metadata` (free) |
| termination observations | run terminal states | run ids |
| W21 `tracking:strategy.v1` | `job:strategy-learning` (unscheduled; grain absent) | `{source, projectId, strategy, intent, window, n, days, metrics, siteFigures, findings}` in `metadata` |

None is produced by a deterministic path from a tracking outcome for CMS-Agent-authored content at the pins.
