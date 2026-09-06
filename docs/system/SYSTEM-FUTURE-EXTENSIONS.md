# System future extensions — compatibility of the current identifiers and contracts with promotion, tracking, monetization and adaptive workflows

> Pins: `CMS_AGENT_SHA=44acb04a1f54281761ab3c34219913198d117950` · `PLATFORM_SHA=d5845dd6e855b434547430d6b0bb4d60b9f60a3c` · `PDF_TOOL_SHA=2c28a4b6430a9589b384dd634f08e9ace5c4e84b` · `KUGEL_DATA_SHA=d9723664521c97be87934874927e9e4603da68ba`.
> This is the only forward-looking document in the set. It names **identifiers and contract fields to preserve or add now**, not a system design. Nothing here is implemented; nothing here proposes streaming raw analytics into a model.

## 1. The correlation chain a future learner needs, and its status at the pins

```
project → content → revision → workflow/run → important agent decisions → publication → promotion/campaign → exposure → engagement → conversion → revenue/value → evaluation → evidence-backed learning observation → subsequent decision
```

| Link | Identifier | Present? | Where it lives / what is missing |
|---|---|---|---|
| project | tenant site ↔ CMS-Agent project ↔ tracking `project_id` ↔ pdf-tool `projectId` | four naming domains, no lookup record (S-21) | preserve: `siteShortId` as the tracking id; add a single mapping record (owner: platform site identity) |
| content | `object_id` | yes, everywhere | preserve the `req_…` grammar; settle the request-id rule (S-06) |
| revision | `version` / `content_revision` | on the record and the export; **not on events** (S-13) | add `object.version` to `tracking_event.v1` (optional) + `tracking_events.version` (nullable) |
| workflow / run | `run_id`, `node_id`, `prompt_version`, `model` (`producer`) | only when sent; dr-lurie conductor never sends it (S-05); no graph/workspace version | send `producer` on every CMS-Agent publish; add `workflow_version` (= CMS-Agent `workspaceRevisionId` at dispatch, which CMS-Agent's own audit recommends stamping) to `producerContextSchema` and the `producer` table |
| important agent decisions | `publication_controller` decision, `operatorPublishDecision`, node `provenance` | in the CMS-Agent run only | preserve; expose a top-level `publishedObjects[]` on the run (CMS-Agent recommendation) so an object → run join is one read |
| publication | `publish_receipt{commit_sha, content_revision, surface, attribution}` | yes; `surface`/`attribution` dropped by the sink (S-12) | add the two columns |
| promotion / campaign | none | **not implemented**; nothing should be invented ahead of it | reserve one bounded slug on the object ref (`placement_id`, same grammar as `section_id`) — only when promotion exists; `context.utm` stays the arrival signal |
| exposure | `exposure {experiment_id, variant_id}` (platform) vs arm keyed by event `object_id` + `variant_id` (kugel-data) | both sides exist; keys and the `/weights` envelope do not join (S-24, S-25); no tenant configures an experiment | decide the key once (`experiment_id` = control `content_item` id on both sides) before any tenant sets `experiments[]` |
| engagement | 18 kinds, node/section ids | yes | fix the per-article denominator (S-08) before any rate is trusted |
| conversion | `buy_click`, `goal`, `form_submit` + `commerce_event_id` | shape yes, value broken (S-01) | repair the id at checkout creation |
| revenue / value | `amount_cents`, `currency` | unreachable (S-02); multi-currency summed | one purchase kind; group by currency |
| evaluation | CMS-Agent rubrics/results (`evalId`) | yes, rubric-based | keep; outcome evidence is additive |
| learning observation | `LearningObservation{observation, metadata?, runId?, nodeId?}` | no evidence ids | add `evidence: {source, window:{from,to}, projectId, objectIds[], versions[], rowIds?, n}` as a typed field (not free `metadata`) |
| subsequent decision | playbook item `provenance{source, runIds?, evalIds?}` | yes for items; `source:'tracking'` exists | add `observationIds[]` to provenance so a playbook line can be traced to its evidence |

## 2. The minimal set of identifiers/contract fields to preserve or add now (ordered by value)

1. **`producer` on every publish that CMS-Agent performs** (dr-lurie hook today sends none). One-line change in `projects/drLurie/hooks.ts`; the value is already computed (`producerContextForPublish`). Without it the only tracked tenant's conductor content is invisible to the producer grain.
2. **Deterministic `commerce_event_id` at checkout creation** equal to the webhook's `deterministicUuid(session.id + ':checkout_completed')` (or carry Stripe `session.id` on the tracking event and join on `commerce_events.session_id`). No new column — the field is already indexed.
3. **One purchase `kind` literal** shared by `commerce-events.ts` and every sink predicate (`checkout_completed` is the platform-authoritative type).
4. **`object.version` on tracking events** stamped from the rendered export's `__generated.record_version`; nullable `version` column; `v_producer_window` joins on it instead of guessing the latest version.
5. **Public `node.strategy` / `node.intent`** (neutral slugs) on the export, or a dims push from the object store, so the strategy dimension survives the `private.*` strip.
6. **`surface` / `attribution` columns** on `object_version` (already pushed).
7. **`workflow_version` on `ProducerContext`** + `producer` table, filled from CMS-Agent's workspace revision at dispatch.
8. **The request-id rule** (S-06): either the content-item shell path becomes unconditional for live runs (object id = `run.requestId` always), or the platform request doc stores the published `objectId` from run receipts. Pick one; the platform "bump nn while a content_item exists" logic depends on it.
9. **`node_get_latest_output` (and the retry/budget/cancel/Insights tools platform already calls) in the tenant bearer scope, with run-addressed calls bound to the run's project** (S-07, S-26), so publication evidence — `commit_sha`, `article_path`, `deployedSha` — reaches the request record that a future evaluator will read.
10. **A `release_owed` / `released_at` fact on the object record** and `commit` passed by `release_executor`, so exposure can be joined to *when* a revision went live rather than when it was exported.
11. **Typed `evidence` on learning observations** and `observationIds[]` on playbook provenance (both CMS-Agent-internal, no cross-repo change).
12. **Make `exposure` join**: kugel-data reads `props.experiment_id` as the arm key (or platform stamps the control id as `object.object_id` on `exposure`), platform reads `body.experiments` from `/weights`, and a fixture replays one real `/weights` body through `buildExperimentMap` (S-24, S-25; contracts §F 6). Not before 1–4, and not before S-08 is decided, because the two share a key.
13. **Do not add** a promotion id, a campaign object type, an LLM-facing raw-event feed, or a new reporting surface until promotion exists; `/rollups` already emits the producer-grain vector.

## 3. Preferred future flow (shape only, for compatibility judgement)

```
raw immutable observations (tracking_events, commerce_events; append-only, event_id idempotent)
  → deterministic normalization/aggregation (kugel-data views; version-aware once #4 lands)
  → bounded evidence package (one HTTP read: /rollups?by=producer|object for a window; ≤ 5 000 rows; thresholds n ≥ 50/100 as CMS-Agent already encodes)
  → evaluation (rubric results + outcome records side by side; outcomes decide *what* to change, rubrics decide *whether* a change won — CMS-Agent's current split)
  → agent reasoning (the reflector/optimizer proposal, one bounded prompt)
  → provenance-preserving learning observation (typed evidence field) → playbook item (observationIds[])
  → subsequent decision (next dispatch reads the playbook)
```

What already fits this shape: kugel-data's model-free measurement half; CMS-Agent's bounded consumer, thresholds, "absent ≠ 0" aggregation, and the rubric/outcome separation; playbooks as the single behaviour-changing memory. What breaks it: every identifier gap in §1. What would break it later: putting raw event rows or the `/stats` payload into a prompt (not needed — the producer-grain vector is already the evidence package), or letting an agent write playbook items without `observationIds[]`.

## 4. Adaptive CMS workflows — what must stay stable for a workflow to learn about itself

- Node ids (`brief_architect`, `angle_strategy`, `draft_writer`, …) are the join key from playbooks and outcomes back to behaviour; renaming a node orphans its evidence. Treat node ids as a contract (they already are for `producer.node_id`).
- `prompt_version` (hash) and the proposed `workflow_version` are what make "did the change help" answerable across a republish.
- The `publication_controller` decision fingerprint and `operatorPublishDecision` are the record of the human/agent choice; keep them on the run and mirror the decision kind onto the published receipt (`publish_receipt.prompt_version` exists; a `decision_source` beside it would close the loop).
- Keep every autonomy switch (SYSTEM-PUBLISHING.md §5) readable from one place before adding a fourth.

## 5. Monetization — what to preserve so revenue can join later

`order_id`, Stripe `session.id`, `product_id`, `amount_cents` + `currency`, `member_hash`/`shash` link, and the object the buyer read (`v_session_object` any-touch today; a first-content-touch or last-touch rule should be a declared field on the row, e.g. `attribution: 'any_touch'`). All exist; the joins are what is broken (§2 items 2–3). Stripe stays the payment authority; the platform order record stays the canonical purchase; kugel-data holds a copy for analysis only.
