# Data Contracts

> **Status:** verified against the `platform` repo commit `6789644` (2026-09-05). Code is truth; every claim cites a file path. Status tags: `[CURRENT]` `[INHERITED]` `[DEPRECATED]` `[EXPERIMENTAL]` `[GENERATED]` `[CANONICAL]` `[DOC-ONLY]`.
> Companion docs: [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`AI_CONTEXT.md`](AI_CONTEXT.md) · [`CONTENT_ARCHITECTURE.md`](CONTENT_ARCHITECTURE.md) · [`CMS_INTEGRATION.md`](CMS_INTEGRATION.md) · [`TRACKING_ARCHITECTURE.md`](TRACKING_ARCHITECTURE.md) · [`DEPLOYMENT.md`](DEPLOYMENT.md).

## 1. How to read this

**Authority vs schema owner.** Two different questions, answered separately in every table below.

- **Schema owner** — who is allowed to change the *shape*. Usually the repo that declares the zod
  schema or the OpenAPI/JSON-RPC surface.
- **Authority** — who is allowed to change the *data*. For CMS content the authority is always the
  per-site object record in Netlify Blobs (`packages/core/server/lib/blob-store.ts:getSiteObjectsBlobStore`);
  everything under `sites/<client>/data/site/**` is a derived mirror
  (`packages/core/server/lib/materializers/*`) and must never be hand-edited.

**Version-tag convention.** A contract carries a version only where the code declares a string
literal. Body schemas carry `schema_version` as a `z.literal` (`content_item.v1`, `page.v1`, …);
envelopes and helper shapes do not. `objectRecordSchema.schema_version` is a plain `z.string()`
(`packages/core/schema/object-record-v1.ts`), so nothing structurally stops a record carrying a body
tag its type's schema does not know — validation happens at write time in
`packages/core/server/lib/object-validate.ts:validateObject`, not at the envelope.

**Verified vs assumed tags.** Candidate tags in circulation, checked by exhaustive grep:

| Candidate tag | Exists in code? | Where |
|---|---|---|
| `content_item.v1` | yes | `packages/core/schema/bodies/content-item-v1.ts:44` |
| `article_body.v1` | yes | `packages/core/schema/article-content-v1.ts:202`, `schema/article-content-helpers.ts:28` |
| `content_source.v1`, `publication.v2` | yes — `[DEPRECATED]` | `packages/core/schema/schema-v1.ts:149,451` |
| `tracking_event.v1` / `tracking_batch.v1` | yes | `packages/core/schema/tracking-event-v1.ts:24-25` |
| `commerce_event.v1` | yes | `packages/core/server/lib/commerce-events.ts:36` |
| `editorial-request.v1` / `editorial-request-index.v1` | yes (hyphen, not underscore) | `packages/core/server/lib/requests/store.ts:41-42` |
| `plugin_manifest.v1` | yes | `packages/core/server/lib/plugin/manifest-types.ts:23` |
| `agent-keys.v1` | yes | `packages/core/server/lib/agent-keys.ts` (doc key in the `governance` store) |
| `client_manager.turn.v1` | yes — owned by CMS-Agent | pinned at `packages/core/server/lib/agent/cms-agent-client.ts:20` |
| `article_brochure_v1` | yes — a **template id**, not a schema version | `packages/core/lib/pdf/article-brochure-v1-render-data-schema.ts:20` |
| `rich_text.v1` | **prose only** | named in comments (`bodies/content-item-v1.ts:10`, `lib/richtext/rich-text-v1.ts:1`, `server/lib/plugin/render-skill.ts:289`); there is no `schema_version: 'rich_text.v1'` field and no exported constant — a document is identified structurally by `nodeType: 'document'` |
| `object_record.v1` | **does not exist** | `packages/core/schema/object-record-v1.ts` is module-identified; the version lives on each body |
| `article_content.v1` | **does not exist** | the file `article-content-v1.ts` declares `article_body.v1` |
| `materialization_spec.v1` | **does not exist** | the "spec" is the compile-time `MaterializeMeta` interface (`server/lib/materializers/shared.ts:25`), runtime-guarded by two hand-written checks (`shared.ts:82-96`) |
| `artifact_plan.v1` | **does not exist** | `artifact_plan` appears only as a CMS-Agent **node id** (`server/lib/requests/derive-status.test.ts`) |
| `marginalia.v1` | **does not exist** | `packages/core/schema/marginalia-v1.ts` carries no version constant — the only body-shaped schema in `schema/` without one |

---

## 2. Object envelope and the 13 governed body contracts

**Envelope** — `packages/core/schema/object-record-v1.ts:objectRecordSchema`:
`object_id, object_type, schema_version, site, created_at, updated_at, status('active'|'archived'),
body, publication{published_time, publish_receipt?}, review?, lock?, history[], version,
content_revision, workflow?`.

Envelope sub-contracts that matter to consumers:

| Field | Shape | Defined in | Rule |
|---|---|---|---|
| `Principal` | `{kind:'human'\|'agent'}` + `auth` + `attribution` | `object-record-v1.ts:33-45` | Precedence: OAuth grant → verified agent token → publish key + label → `unattributed-agent` (`server/lib/caller-actor.ts:16-23`). Absent `attribution` means "unknown", never "self-declared". `agent_name` is a label, not an identity. |
| `version` vs `content_revision` | two independent counters | `object-record-v1.ts`; invariant restated `server/lib/object-publish.ts:31-42` | `version` bumps on **every** write; `content_revision` **only** on body writes, so the publish stamp cannot invalidate the approval it just consumed. |
| `review` + `ApprovalPin` | `{state, decisions[]}`, pin `{published_time\|ISO\|null, artifact_set?, release_build?}` | `object-record-v1.ts:reviewStateSchema`, `server/lib/review-state.ts:approvalPinSchema` | Approval invalidation is **logical, not stored**: `publish-gate.ts:effectiveApproval` compares the pinned `content_revision` to the current one. Omitted pin fields are simply not enforced (`review-state.ts:51-55`). |
| `ProducerContext` | `{run_id, node_id, prompt_version, model}`, `.strict()` | `object-record-v1.ts:producerContextSchema` | Optional on publish for backwards compatibility, but all four fields are required together when present (`:91-96`). |
| `PublishReceipt` | `{kind:'object_export_commit', branch, commit_sha, tree_sha, no_op, attempts, files[], content_revision, exported_at, surface?, attribution?, prompt_version?}` | `object-record-v1.ts:publishReceiptSchema` | Non-strict on purpose — unknown fields from future writers parse fine (`:146-149`). **A receipt proves the export commit, never the deploy.** |

**The 13 governed types** (`objectTypes`, `object-record-v1.ts:7-20`). `<root>` = `SiteBinding.dataRoot`.

| Type | Version literal | Body schema file (`packages/core/schema/bodies/`) | Export path | Materializer (`server/lib/materializers/`) | Validation entry | Notes |
|---|---|---|---|---|---|---|
| `content_item` | `content_item.v1` | `content-item-v1.ts:44` | `<root>/articles/<id>.json` | `content-item.ts` | `object-validate.ts:validateObject` (body map at `:337`) | Imports four sub-schemas from `schema/article-content-v1.ts` verbatim rather than copying them; legacy `.md` posts are deliberately not migrated. |
| `page` | `page.v1` | `page-v1.ts:23` | `<root>/pages/<id>.json` | `page.ts` | same | Pages never live-inherit from templates; `page.template` is provenance only (`:11-12`). `pageTypeIds` = `home, standard, listing, content_detail, system, clone` (`page-v1.ts:33`). |
| `section` | `section.v1` | `section-v1.ts:38` | `<root>/sections/<id>.json` (shared only) | `section.ts` | same | Strict discriminated union on `type`; growth = one union member + one registry module. The `static` variant is retired. `shared_ref` carries only the target's id, never a shadow copy (`:11-12`). |
| `navigation` | `navigation.v1` | `navigation-v1.ts:31` | `<root>/navigation/<id>.json` | `navigation.ts` | same | Hosts the shared `RichText`/`NavTarget`/`LinkAction` vocabulary; `{kind:'route', href}` is a documented transitional member. |
| `taxonomy` | `taxonomy.v1` | `taxonomy-v1.ts:19` | `<root>/taxonomy.json` | `taxonomy.ts` | same | `term_id` is opaque and stable so slugs/labels rename safely; `merged_into` is the alias that keeps published references resolving. |
| `site` | `site.v1` | `site-v1.ts:19` | `<root>/site.json` | `site.ts` | same | `brandTokens`/`brandImagery` are additive-optional and **privileged-write-only** (`:211-216`). |
| `template` | `template.v1` | `template-v1.ts:22` | `<root>/templates/<id>.json` | `template.ts` | same | "Data-not-code"; instantiation copies, never binds (`:3-6`). |
| `section_template` | `section_template.v1` | `section-template-v1.ts:26` | `<root>/section-templates/<id>.json` | `section-template.ts` | same | The blueprint is a full `SectionInstance` so no parallel shape can drift; the `s_*` id is re-minted at instantiation. |
| `theme` | `theme.v1` | `theme-v1.ts:23` | `<root>/themes/<id>.json` | `theme.ts` | same | `tokens` reuses `site.v1`'s `brandTokensSchema`; applied **by copy** — deleting a theme has zero effect on the live site. |
| `product` | `product.v1` | `product-v1.ts:34` | `<root>/products/<id>.json` | `product.ts` | same | Polymorphism lives only in the union on `fulfillment.kind`; Stripe is canonical for amounts, `commerce.price` is a display cache. `require-approval` on all four tenants. |
| `tracking_config` | `tracking_config.v1` | `tracking-config-v1.ts:22` | `<root>/tracking.json` | `tracking-config.ts` | same | Singleton per site, id `trk_<siteShortId>`; a second active registry is refused 409. |
| `editorial_voice` | `editorial_voice.v1` | `editorial-voice-v1.ts:38` | `<root>/voice/<id>.json` | `editorial-voice.ts` | same | "DATA, NOT INSTRUCTIONS" — prompt-formatted text fails the `voice_not_a_prompt` criterion. **No Astro collection globs `voice/`**: agents only. |
| `visual_standard` | `visual_standard.v1` | `visual-standard-v1.ts:43` | **never materialized** | — (`server/lib/materialize.ts:68` throws) | same | Excluded from `governedObjectTypes` (`packages/core/lib/approval-policy.ts:41`), therefore never publishable. `brandImagery` is reused verbatim from `site-v1.ts`, never forked. |

**Two shapes are spread into bodies rather than duplicated** (they are not object types):

| Shape | Defined in | Spread into | Rule |
|---|---|---|---|
| `trackingAttributeShape` — `tracking {enabled?, label?, tags?, goals?}` | `bodies/tracking-attribute-v1.ts:48` | every governed body except `tracking_config`, `editorial_voice`, `visual_standard` (`TRACKING_ATTRIBUTE_EXEMPT_TYPES`, `:104`) | Single writer: the `set_tracking` op. Every field schema-optional so pre-W13 records keep parsing. Leak boundary: `label`/`tags` never render; `goals` reach the page inside `#trk-config`, hence `GOAL_KEY_RE`/`CONVERSION_LABEL_RE` force neutral slugs. |
| `recipeMetadataShape` | `bodies/recipe-metadata-v1.ts` | `template`, `section_template`, `theme` | All fields schema-optional but **required to publish** — the `recipe_metadata` criterion warns while drafting and blocks at publish (`:8-12`). |

---

## 3. Patch-op grammar

`packages/core/schema/object-patch-ops.ts` — a discriminated union on `op`, **44 ops**, applied by
`packages/core/lib/object-patch-apply.ts:applyPatchOps`, inverted by `derivePatchInverse`.

| Family | Ops |
|---|---|
| page | `set_page_meta` `upsert_section` `update_section_data` `move_section` `set_section_visibility` `remove_section` |
| navigation | `set_nav_meta` `upsert_group` `move_group` `remove_group` `upsert_item` `update_item` `move_item` `remove_item` `upsert_action` `remove_action` |
| taxonomy | `add_term` `update_term` `deprecate_term` `reactivate_term` `remove_term` |
| site | `set_site_fields` `set_site_brand_tokens` `set_site_brand_imagery` |
| product | `set_product_fields` `set_product_price` |
| content_item | `set_article_meta` `upsert_node` `update_node` `move_node` `set_node_visibility` `remove_node` |
| template | `set_template_meta` `upsert_slot` `move_slot` `remove_slot` |
| section_template | `set_section_template_meta` `replace_blueprint` `update_blueprint_data` |
| theme / tracking / voice / visual | `set_theme_fields` `set_tracking` `set_tracking_config_fields` `set_voice_fields` `set_visual_standard_fields` |

**Invertibility is the law.** Every op captures a `{before, after}` inverse at apply time; the
inverse is what `object_discard` re-applies (`server/lib/review-state.ts:discardProposal`). That
capture is also why `ObjectRecord.history` grows monotonically (KNOWN_ISSUES #3).

**Privileged ops.** `PRIVILEGED_PATCH_OPS = ['set_site_brand_tokens','set_site_brand_imagery']`
(`object-patch-ops.ts:863`) are valid grammar but in **no** type's agent-facing allowlist:
`applyPatchOps` accepts them only when a caller passes them as `privilegedOps`, so the palette
changes solely through `site_apply_theme` and imagery solely through `site_apply_brand_imagery`.
`set_product_price` is **not** privileged — it stays agent-submittable and leans on the product
review gate (`object-patch-ops.ts:858-861`). Per-type allowlists live at `object-patch-ops.ts:829+`.

---

## 4. Export file contract `[GENERATED]`

Every file under `sites/<client>/data/site/**` **except `redirects.json`** is
`{ "__generated": {…}, …body }`, serialized by `server/lib/materializers/shared.ts:renderExport`.

| Marker field | Required | Meaning |
|---|---|---|
| `from` | yes | `objects/<type>/by-id/<id>.json` — the store key this was derived from |
| `at` | yes | ISO; **equals the effective `published_time`**, never wall-clock |
| `record_version` | yes | `ObjectRecord.version` at materialize time |
| `producer` | optional | `{run_id, node_id, prompt_version, model}` from `ProducerContext` |
| `surface` | optional | e.g. `plugin:claude` — from the authenticated actor, never a tool argument |
| `attribution` | optional | e.g. `oauth` — how identity was established |

`producer`/`surface`/`attribution` are written into the **export**, not only the store, because the
export is what the owner analytics DB ingests (`shared.ts:32-43`).

- **Canonical JSON** — `canonicalJsonStringify` sorts object keys recursively, preserves array
  order, emits 2-space JSON plus a trailing newline. `at` / `record_version` / `exportRoot` are
  caller-supplied inputs, never generated in the module: that is what makes a retried publish
  produce the same blob sha and lets the committer no-op (`shared.ts:1-21`,
  `server/lib/object-git-committer.ts:22-27`). A runtime guard rejects the camelCase trap
  (`recordVersion`) rather than emitting an export that dies inside Astro (`shared.ts:82-96`).
- **`stripPrivate`** (`shared.ts:132`) removes every `private` key at any depth, for every type.
  Nothing else is removed. (This is why `node.private.strategy` never reaches the dims push — see
  KNOWN_ISSUES #11.)
- **Astro-side validation** (`packages/core/app/content/collections.ts:118-125`) asserts only the
  marker's three required fields via `z.object({__generated:{from,at,record_version}}).passthrough()`
  — deliberate, because `astro:content`'s `z` is Astro's zod v3 while the project is zod v4
  (`:109-116`).
- **`redirects.json` is the exception.** `server/lib/object-retire.ts:171-176` writes it with plain
  `JSON.stringify(…, null, 2)` — no `__generated`, no `renderExport`, no Astro collection. It is
  consumed by `packages/core/app/site-redirects-integration.ts` → `dist/_redirects`. See
  KNOWN_ISSUES #44.

**The export is validated three times with three strictnesses:** full body schema at write
(`object-validate.ts`), marker-only passthrough at collection load (`collections.ts`), full body
schema again at `packages/core/app/utils/blog.ts:164` — where a failure is a `console.warn` + skip,
not a build failure (KNOWN_ISSUES #45).

---

## 5. Cross-boundary contracts this repo PUBLISHES

| Contract (defined in) | Consumer | Authority | Transport | Evolution rule / failure posture |
|---|---|---|---|---|
| **MCP JSON-RPC server**, `PROTOCOL_VERSION = '2025-06-18'` (`server/functions/mcp.ts:325`) | Claude connectors, ChatGPT, CMS-Agent, `scripts/*.mjs` | this repo, per tenant | `POST /mcp` (JSON-RPC 2.0) | Fails closed on an unconfigured shim (`mcp.ts:78-86`). 401 always carries `WWW-Authenticate`. |
| **`serverInfo`** `{name, version:'0.1.0', tools_digest}` (`mcp.ts:1589-1602`) | every MCP client (clients key on `serverInfo.name`) | per-tenant `sites/*/config/site-identity.ts` | `initialize` result | Name is tenant config, not fleet law (`Dr_Lurie_MCP_Server` vs `Platform_MCP_Server` …). |
| **`McpWireTool`** `{name, description, inputSchema, annotations, _meta.schema_version}` (`server/lib/mcp-tool-annotations.ts:34-62`) | MCP clients | this repo | `tools/list` | Per-tool fingerprint `v<fnv1a(name + JSON(inputSchema))>` `[GENERATED]`; aggregate `tools_digest` from `plugin/build-tools.ts:toolSurfaceDigest`. Both exist so a cached client can detect drift — but see KNOWN_ISSUES #29 for a tenant where the aggregate is unreliable. |
| **Tool result envelope** `{content:[{type:'text',text}], structuredContent}` (`mcp.ts:422-425`) | MCP clients | this repo | `tools/call` result | Same payload twice, compact JSON. Cap `MAX_TOOL_RESULT_BYTES = 900_000` with a per-tool "narrower call" hint (`mcp.ts:441-459`). |
| **`plugin_manifest.v1`** (`server/lib/plugin/manifest-types.ts:23,188-201`) | ChatGPT / Claude / Gemini exports; the Actions charter | Owner/Admin promotion via `admin-plugin-manifest` | blob store `plugin-manifest`; `GET /api/plugin-install` | The promoted manifest **is** the charter on `/api/plugin/*`; a tool outside it is 403 `tool_not_in_plugin_charter` before auth resolution. |
| **Actions OpenAPI document** `[GENERATED]` (`server/lib/plugin/build-openapi.ts`, served `plugin-actions.ts:126-141`) | ChatGPT Custom GPT | derived from live `ToolDefinition`s | `GET /api/plugin/openapi.json` | `x-openai-isConsequential = toolClass !== 'read'`. Regenerated per request — never hand-authored. |
| **OAuth 2.1 AS + protected-resource metadata** (`server/lib/oauth-server.ts:138-158`) | any MCP client | this tenant's `governance` store (`oauth/` prefix) | `.well-known/oauth-authorization-server`, `…-protected-resource` | RFC 8414 / 9728 / 7591 / 7009. `scopes ['mcp','offline_access']`, PKCE `S256` only. |
| **`capability_status` report** `{site_id, families:Record<family,{configured,missing[]}>}` (`server/lib/capability-status.ts:39-121`) | `scripts/fleet-capability-probe.mjs`, FLEET-STATUS | this repo | `tools/call capability_status` | 11 families; reports on **env vars**, not on call paths (KNOWN_ISSUES #36). |
| **`whoami` payload** (`server/lib/whoami.ts`) | plugin install flow, connectors | derived from the caller's own grant | `tools/call whoami` | Never exempt from the surface kill switch. |
| **Committed site export** `[GENERATED]` (`server/lib/materializers/*`) | the Astro build; GitHub readers; `content-item-index.ts` | the object record — never hand-edit | GitHub commit carrying `[skip netlify]` | §4 above. |
| **`tracking_event.v1` / `tracking_batch.v1`** (`packages/core/schema/tracking-event-v1.ts:24-26`) | kugel-data `/api/tracking-sink` | this repo produces, kugel-data stores | NDJSON over HTTPS, 2 s timeout, **at-most-once** (no retries) | "commerce_event.v1 rules apply VERBATIM: append-only, additive-only; v2 only for breaking changes, dual-write during transition; PII-minimized" (`:4-8`). Max 25 events/batch; body cap 64 KB. Sink idempotency key is `event_id`. |
| **Tracking dimension push** `{project_id, object_version[], producer[], node_strategy[]}` (`scripts/tracking-dims-push.mjs`) | kugel-data `/api/tracking-sink/dims` | this repo | HTTPS at build time, Bearer, `\|\| true` | Best-effort: missing config → `skipped:"missing_configuration"`; never fails a build. Two declared columns are dropped by the sink (KNOWN_ISSUES #12). |
| **`commerce_event.v1`** (`server/lib/commerce-events.ts:36`) | kugel-data `/api/tracking-sink/commerce`; blob store `commerce-events` | Stripe webhook is authoritative; the browser beacon is best-effort | HTTPS + `sendBeacon` | "Evolution is additive-only: new `type` values and new OPTIONAL fields. Bump to `commerce_event.v2` only for breaking shape changes (and then dual-write)" (`:9-12`). Eight types, none of them `purchase` (KNOWN_ISSUES #9). |
| **Member-link record** `{project_id, shash, member_hash}` (`server/lib/member-link.ts:17-21,28`) | kugel-data `/link` | this repo | HTTPS POST, `TRACKING_SINK_TOKEN`, 2 s timeout | `member_hash` = `sha256(lowercased email)`; the raw email never leaves. |
| **`PublishReceipt`** (`object-record-v1.ts:publishReceiptSchema`) | `object_inventory`, release overview, the analytics join | this repo | inside the object record and `object_get` | Non-strict; `surface`/`attribution`/`prompt_version` optional. **Proves the export commit, not the deploy** — a consumer joining "published" to "live" must also read `DeployReceipt`. |
| **Exports consumed by Astro** (`packages/core/app/content/collections.ts`) | the tenant's own build | the object record | repo-relative globs under `<root>` | 10 CMS collections + the permanently empty `post` collection; `articleObject`/`productObject` pin `generateId` to the filename. |

---

## 6. Cross-boundary contracts this repo CONSUMES

| Contract | Owner | Read by | Transport | Failure posture |
|---|---|---|---|---|
| **`client_manager.turn.v1`** | CMS-Agent (`CLIENT-MANAGER-CONTRACT.md` at that repo's root) | `server/lib/agent/cms-agent-client.ts:20`; request built by `agent/engine.ts` | Streamable-HTTP MCP (`POST`+`DELETE`, `Mcp-Session-Id`), protocol `2025-06-18` / fallback `2025-03-26` | Admin chat **fails closed** — no provider fallback (`engine.ts:13-15`). |
| **`CMS_AGENT_BOUNDS`** — 200 msgs / 256 000 msg chars / **96 tools** (one-shot fallback 64) / 256 000 tool chars / 64 000 context chars / 32 000 tokens / 120 000 ms | contract-shared, pinned here | `cms-agent-client.ts:34-56`, pre-flight `checkConverseBounds:423-439` | request pre-flight | Exceeding → `invalid_turn_request` / `transcript_too_large` upstream. |
| **CMS-Agent wire error codes** — 15 frozen codes incl. `provider_quota`, `provider_rate_limit`, four `visual_identity_*` | CMS-Agent | `cms-agent-client.ts:68-107` | `error.data.error.code` | An unknown code degrades to `cms_agent_error`, never a crash. |
| **`agent_resolve` / `agent_converse`** `{role:'client_manager', project_id}` → `agent_ref` | CMS-Agent | `cms-agent-client.ts:401-402,838-864` | `tools/call` | `agent_ref` cached 5 min per (project, role); forgotten on `agent_unresolved`. |
| **`workflow_*` run state** — `run_id`, `stalled`, `nodes[{id,status}]`, `approvalsRequired`, publish evidence | CMS-Agent | `server/lib/requests/derive-status.ts`, `requests/publication-evidence.ts`, `agent/tools.ts:1014-1360` | `tools/call workflow_get_run` | `deriveRequestStatus` is **pure and must never throw**: an unreadable shape yields `running` + `status_reason`, never `failed`. |
| **`node_get_latest_output`** | CMS-Agent | `requests/publication-outputs.ts` | `tools/call` | Chosen over `workflow_get_run{detail:'full'}` (~1 MB) because these surfaces poll every few seconds. |
| **`brand_imagery_proposal.v1`** | CMS-Agent `visual_identity_propose` | `server/lib/brand-imagery-proxy.ts` | `tools/call` via `CmsAgentClient` | Validated against the shared `brandImagerySchema` — never forked. Four typed refusal codes; no object write happens in the proxy. |
| **`ProjectCapturePolicy`** | CMS-Agent project registry (ruling R-C2 v2 — the single operational source) | `server/lib/capture-bridge-policy.ts` | travels **with** the call: registry → bridge → pdf-tool | The bridge may never WIDEN; clamps `maxPages` to `CAPTURE_BRIDGE_MAX_PAGES`; requires `rights`/`designReferences`/`fidelity`. |
| **pdf-tool MCP tool surface + `ArtifactReference`** | pdf-tool (`vreich-ui/pdf-tool`) | `server/lib/pdf-tool-client.ts:91-160`; refs typed at `server/lib/artifacts.ts:32-52` | JSON-RPC `tools/call` to `<PDF_TOOL_BASE_URL>/.netlify/functions/mcp` | 503 unconfigured / 502 unreachable / 502 non-JSON. On error pdf-tool's status survives in `structuredContent.statusCode`; on success it collapses to 200. `sanitizePdfToolPayload` strips `storage`/`token`/`materializationProof`. |
| **pdf-tool job status** (`get_agent_artifact_job_status`, `get_image_search_job_status`) | pdf-tool | `pdf-tool-client.ts` | same bridge | Bytes never travel through MCP — only metadata handles. |
| **`PdfToolStorageGrant`** (this repo mints; pdf-tool consumes) `{grantVersion:1, grantType:'netlify-pat', projectId, siteId, token, stores, limits, expiresAt}` | this repo (`server/lib/pdf-tool-storage-grant.ts:44-65`) | pdf-tool, which holds no blob credentials of its own | embedded in the `storage` field of each bridged call | TTL 60 min, enforced upstream — agents must re-fetch per run. `grantType` is the migration seam for a future `'exchange'`. |
| **kugel-data `/stats` response** | kugel-data (`tracking-sink-stats.ts`) | `server/lib/own-tracker-stats.ts` | `GET ${TRACKING_SINK_URL}/stats` | Unauthenticated read, leak-guarded upstream; this repo attaches a Bearer it does not want (KNOWN_ISSUES #21). |
| **Netlify deploys API** — `state`/`status`/`deploy_state`, `commit_ref`, `context`, `published_deploy` | Netlify | `server/lib/netlify-deploys.ts` | `GET https://api.netlify.com/api/v1/sites/{id}/deploys` | Normalized to `DeployStatus`/`DeployReceipt`; an unconfigured lookup is *reported*, never thrown. |
| **Netlify build hook** — opaque URL, `POST` with no body | Netlify | `netlify-deploys.ts:77-93` | HTTPS | Non-2xx → `NetlifyBuildHookTriggerError`; unset → `build_hook_not_configured` returned as a tool **error**, not a `released:false` success. |
| **Netlify Analytics v2** — `/pageviews`, `/visitors` → `{"data":[[epochMs,count],…]}`; `/ranking/{pages,sources,not_found,countries}` | Netlify | `server/lib/netlify-analytics.ts` | `GET https://analytics.services.netlify.com/v2/{SITE_ID}` | 401/403/404 → "Analytics add-on not enabled". The former `api.netlify.com/.../analytics/*` host 404s on every path. |
| **GitHub Git Data API** — `/git/ref`, `/git/commits`, `/git/blobs`, `/git/trees`, `PATCH /git/refs/heads/<branch>`; `X-GitHub-Api-Version: 2022-11-28` | GitHub | `server/lib/object-git-committer.ts` | HTTPS | 422 "not a fast forward" / 409 → re-fetch head, rebuild, retry ×4 with `250ms·2^(n-1)`, then `non_fast_forward_exhausted` (loud). |
| **GitHub ref API** | GitHub | `server/lib/production-release.ts:98-118` | HTTPS | Silent `undefined` → `commit_unresolved`. |
| **GitHub contents API** — listing of `src/data/post` | GitHub | `server/lib/content-item-index.ts:60`, called from `object-validation-context.ts:247` | HTTPS | Degrades, never bricks: `undefined` reads as "cannot verify", stale cache served on a transient error. All three GitHub edges share one env contract (KNOWN_ISSUES #36). |
| **Netlify geo header** `x-nf-geo` (JSON, raw or base64) `{country:{code}, subdivision:{code}}`, `x-country` fallback | Netlify | `server/functions/track-ingest.ts:16-20,72` | request header | `city` is **never read** (OQ-W13-4). |
| **Stripe Checkout + webhook** `checkout.session.completed`, signature-verified | Stripe | `create-checkout-session.ts`, `stripe-webhook.ts` | HTTPS + signed webhook | Mode-selected keys; `STRIPE_MODE` defaults to `test` so a missing flag never charges. No tenant is live on Stripe today. |
| **Netlify Identity / GoTrue JWT** — `context.clientContext.user`, else `GET <IDENTITY_URL>/user` | Netlify | `server/lib/admin-auth.ts:62-119`, layered by `request-roles.ts` | injected context or HTTPS | Any failure → `{authenticated:false}`; never a 500. A suspended member's JWT stays valid ≤1 h; roles are re-resolved per call. |

---

## 7. Internal process-boundary contracts worth knowing

These look internal but cross a Lambda invocation, a blob store, or a header one process sets and
another trusts.

| Contract | Defined in | Producer → consumer | Note |
|---|---|---|---|
| `SiteBinding` | `server/lib/site-binding.ts`; instances at `sites/*/config/site-binding.ts` | per-site config → every function shim | `dataRoot` is caller-supplied and never defaulted — "`packages/core` must not hardcode any client's tree" (`materializers/shared.ts:16-21`). |
| `McpSiblingHandlers` | `server/functions/mcp.ts:47-52` | site shim → `mcp.ts` | DI seam: `saveArtifactHandler`, `objectStoreHandler`, `deployStatusHandler`, optional `verifyArticleImagesHandler`. Fails closed if never configured. |
| `x-publish-key` | `PLATFORM_ENV_NAMES.publishSecret` | `/mcp`, scripts → `object-store` / `save-artifact` / `deploy-status` | Constant-time compare everywhere except `admin-get-blob-pdf.ts:23-30` (KNOWN_ISSUES #26). |
| `x-cms-caller-actor` (`CALLER_ACTOR_HEADER`) | `server/lib/caller-actor.ts:41` | `/mcp` → `object-store` | Carries the derived `Principal`; honoured only on a request that already presented the publish key. A model controls arguments, not headers. |
| `capability_status` families (11) | `server/lib/capability-status.ts:39-121` | `/mcp` → probes, FLEET-STATUS | `blob_credentials`, `deploy_lookup`, `build_hook`, `git_committer`, `commerce`, `purchase_token`, `mail`, … Env-name coverage only. |
| `editorial-request.v1` / `-index.v1` | `server/lib/requests/store.ts:41-42` | admin chat + sweeper → admin surfaces | Id `req_<flow>_<topic>_<yyyymmdd>_<nn>` (also *is* the `content_item` object id). "Every optional field is genuinely schema-additive … no `.default()` anywhere" (`:78-80`); `status` is a plain string so a new value cannot break old docs. |
| Sweep token | `requests/store.ts:mintSweepToken` | `editorial-request-sweep` → `-background` | One-shot; minting a fresh token invalidates the previous one, so two passes cannot overlap. |
| Chat run trigger token | `admin-agent-chat.ts` → `admin-agent-chat-run-background.ts:47,136` | interactive lambda → background lambda | A background function is a public endpoint; the token is what stops an unauthenticated POST spending model budget. |
| `agent-keys.v1` | `server/lib/agent-keys.ts` (doc in `governance`) | Owner mints via `admin-governance` → `/mcp` `getAuthResult` | Site-scoped; one ACTIVE key per (agent_name, site); raw token returned once. Positive verifications memoized 60 s (KNOWN_ISSUES #27). |
| `pluginSurface` | `server/functions/mcp.ts:267`, set at `plugin-actions.ts:180` | Actions façade → `/mcp` | Deliberately an in-process event field, not a header: a client can set headers but cannot invent an event property. |
| Idempotency record | `server/lib/idempotency-store.ts:155` (`withIdempotentToolCall`) | `/mcp` → blob store `idempotency` | `(tool, idempotency_key)` → first successful result. Wraps `object_create`, `object_publish`, `release_to_production`, `create_agent_artifact_job`, membership tools. |
| Write-rate-limit key | `server/lib/write-rate-limit.ts:58-59` | `/mcp` → `governance` store | `ratelimit/write/<window>/<subject>`; 60 writes / 10 min per OAuth subject or verified agent name (KNOWN_ISSUES #25). |
| Marginalia thread/comment | `packages/core/schema/marginalia-v1.ts`, `server/lib/marginalia-store.ts` | `marginalia_*` verbs → admin canvas | Own blob store so comments never take the content object's edit lock (`blob-store.ts:312-325`); no version literal, no lock, last-write-wins. |
| Governance override doc | `server/lib/governance-store.ts:111-160` | `admin-governance` (read Admin, write Owner) → `resolveActivePolicies` | `overrides.v1` + `learning_mode`. Precedence: committed `sites/*/config/*-policy.ts` is the default, the governance doc is the runtime layer, and `PolicyProvenance` reports which won per field. |
| Policy configs | `packages/core/lib/{approval-policy,media-policy}.ts`; `sites/*/config/{approval,creation,media,membership}-policy.ts`, `site-identity.ts` | committed config → `publish-gate.ts`, `object-verbs.ts` create path, the pdf-tool grant, `membership/verbs.ts` | Malformed config **throws** rather than silently resolving to the permissive default (`approval-policy.ts:29-32`). `publishing-policy.ts` is read (`agent/registry.ts:13`) but **no tenant commits one** (KNOWN_ISSUES #30). |

---

## 8. Blob-store namespaces (per tenant)

`CORE_BLOB_STORES` (`packages/core/cli/create-site.mjs:405-443`) is the provisioning list — **17
stores**. `scripts/provision-pdf-tool-stores.mjs:25-32` provisions **6** for pdf-tool, of which
`artifacts` and `artifact-index` are shared, so a fully provisioned tenant has **21 distinct
namespaces**. `tests/scripts/admin-parity.test.mjs:155` fails when the core list under-covers the
store-name literals found in `packages/core`.

| # | Store | Key shape / doc | Owner module | Consistency |
|---|---|---|---|---|
| 1 | `site-objects` | `objects/{object_type}/by-id/{object_id}.json` + status index | `object-store-keys.ts`, `object-verbs.ts` | strong (requested; see KNOWN_ISSUES #4's note on Lambda name-lookup) |
| 2 | `artifacts` | `{image\|pdf}/{id}/{sha256}.{ext}` | `artifact-upload.ts`, `save-artifact.ts`; **also written by pdf-tool via grant** | strong |
| 3 | `artifact-index` | per-request reference indexes | `artifact-index.ts`; also pdf-tool | strong |
| 4 | `governance` | `overrides.v1`, `agent-keys.v1`, `oauth/*`, `ratelimit/write/*` | `governance-store.ts`, `agent-keys.ts`, `oauth-store.ts`, `write-rate-limit.ts` | strong |
| 5 | `users` | membership records + invitations | `users-store.ts`, `membership/store.ts` | strong |
| 6 | `agent-chats` | chat docs + run state | `agent/chat-store.ts:333` | strong |
| 7 | `agent-profiles` | named provider+model profiles | `agent/profiles.ts` | — |
| 8 | `agent-learning` | tagged Ask-AI proposal trail | `blob-store.ts:308` | — |
| 9 | `editorial-requests` | `editorial-request.v1` docs + index | `requests/store.ts:41-42` | strong (the sweeper is the single writer and must not read its own stale write) |
| 10 | `plugin-manifest` | `plugin_manifest.v1` draft/active pair | `plugin/manifest-store.ts` | strong |
| 11 | `marginalia` | threads + comments | `marginalia-store.ts` | — (no lock, no CAS, last-write-wins accepted) |
| 12 | `idempotency` | `(tool, key)` → first result | `idempotency-store.ts` | strong |
| 13 | `commerce` | order records (raw email lives here only) | `commerce-orders.ts`, `commerce-*.ts` | strong |
| 14 | `commerce-events` | append-only `commerce_event.v1`; no read helpers by design | `commerce-events.ts` | — |
| 15 | `opt-ins` | opt-in records | `opt-in-record.ts` | — |
| 16 | `tracking-events` | sink-failure mirror | `tracking-events.ts` | — |
| 17 | `workflows` | `[DEPRECATED]` legacy pipeline store; still provisioned, no shipping writer | `blob-store.ts:234-236` | strong |
| 18 | `pdf-templates` | pdf-tool template records | opened only by pdf-tool through the grant | — |
| 19 | `image-search` | pdf-tool image-search banks | same | — |
| 20 | `pdf-render-data` | pdf-tool render-data documents | same | — |
| 21 | `pdf-tool-jobs` | pdf-tool job records | same | — |

Site-scoped by construction: every store is opened with `getSiteIdentity().siteId`, so a key for one
tenant never resolves for another.

---

## 9. Duplicates, near-duplicates and drift

| # | Pair / drift | Where | Nature | KNOWN_ISSUES |
|---|---|---|---|---|
| 1 | `schema/schema-v1.ts` (legacy, ~770 lines, 18 block tags incl. `content_source.v1`, `publication.v2`) | `packages/core/schema/schema-v1.ts:149-298` | `[DEPRECATED]` but **undeletable**: `object-record-v1.ts:2,208` imports `workflowRecordSchema` from it purely for the lock-record shape. Only shipping importer otherwise is `admin-taxonomy.ts`. | #47 |
| 2 | `article_body.v1` vs `content_item.v1` | `schema/article-content-v1.ts` vs `schema/bodies/content-item-v1.ts` | Partially resolved: `content_item.v1` *imports* four sub-schemas rather than copying them, but re-declares the node/public shapes with one upgrade (`body: string \| rich_text.v1`, `images[]`, `sizeBytes`). Two node schemas must be kept in step by hand. | #47 |
| 3 | `articleNodePublicSchema` vs `contentItemNodePublicSchema` | `article-content-v1.ts:137` vs `content-item-v1.ts:85` | Near-duplicate: same seven scalars, differing only in `body`'s union, `media.sizeBytes`, `images[]`. | #47 |
| 4 | `ARTICLE_NODE_ID_RE` + `FORBIDDEN_NODE_ID_WORDS` | `content-item-v1.ts:48-51` vs the inline regex+refine at `article-content-v1.ts:164-179` | Literal duplication of the same rule and word list in two files. | #47 |
| 5 | `getPreferredArticleMarkdownSource` vs `getContentSourceMarkdown` | `schema/article-content-helpers.ts:45` vs `packages/core/lib/contentSourceBody.ts:8` | Two implementations of the same content-source→markdown step; **both orphaned** (`contentSourceBody.ts` is imported only by `lib/contentSourceImportFormData.ts`, which has zero importers). | #48 |
| 6 | `docs/agents/mcp-article-body-v1.md` vs the code | doc vs `bodies/content-item-v1.ts` | Self-marked HISTORICAL, still describes `save_json_blob_publish_by_time` and `input.publication.published_time` scheduling — both deleted 2026-07-29. | #50 |
| 7 | `tests/fixtures/tracking-events/pageview.json` vs `trackingEventSchema` | fixture vs `schema/tracking-event-v1.ts` | The one committed example of the wire format is **schema-invalid** (`url` a bare string; `consent` missing `gpc`). Only ever grepped for PII strings, so nothing catches it. | #18 |
| 8 | Tool definitions split three ways | `mcp-tool-definitions.ts` (49) + `-2.ts` (32) + `-membership.ts` (16), concatenated at `server/functions/mcp.ts:506-511` | `-2` is a **size** split, not a domain split (`deploy_status` in part 1, `object_publish` in part 2). Only the membership split is principled. | #51 |
| 9 | `exposure` / `variant_id` | `bodies/tracking-config-v1.ts:35` (18 kinds, no `exposure`) and `schema/tracking-event-v1.ts:53` (no `variant_id`) vs kugel-data `004_rollup_views.sql:v_variant_assignment` | The sink's entire experiment machinery keys on an event kind and prop this repo can neither emit nor accept. | #19 |
| 10 | `object_version.surface` / `.attribution` | `scripts/tracking-dims-push.mjs:60-75` ("SINK CONTRACT: two additional columns") vs kugel-data `002_…sql` + `tracking-sink-dims.ts:normalizeObjectVersion` | Declared, pushed, and defined nowhere downstream — silently dropped. | #12 |
| 11 | `commerce_events.kind` | `server/lib/commerce-events.ts:commerceSinkPayload` (`kind: event.type`, 8 values, none `purchase`) vs kugel-data's `kind = 'purchase'` filters | The producer and the consumer disagree on the vocabulary; kugel-data's own seed writes `purchase`, so its tests stay green. | #9 |
| 12 | `props.commerce_event_id` vs `commerce_event.event_id` | `checkout-session-status.ts:33,40` + `create-checkout-session.ts:121` (`randomUUID`) vs `stripe-webhook.ts:210,254` (`deterministicUuid`) | Two different generators for the join key kugel-data uses — they can never be equal. | #8 |
| 13 | `brandTokensSchema` in `site.v1` vs `theme.v1 tokens` | `bodies/site-v1.ts:31`, `bodies/theme-v1.ts` | **Resolved by reuse** — theme imports the site schema "so the two shapes cannot drift". | — |
| 14 | `brandImagery` in `site.v1` vs `visual_standard.v1` | `bodies/site-v1.ts:141`, `bodies/visual-standard-v1.ts:20` | **Resolved by reuse** — "REUSED verbatim from site-v1.ts, never forked". | — |
| 15 | Blog routing in `config.yaml` vs `site.json.blog` | `sites/drlurie/config.yaml` `apps.blog.*` vs `sites/drlurie/data/site/site.json:blog` | Same four values in two places. `config.yaml` is authoritative (Wolf B2, restated `site-astro-config.ts:24-27`); `site.json.blog` is read by nothing on the build path — a silent drift surface. | — |
| 16 | `site.config.ts:redirects` vs root `netlify.toml [[redirects]]` | — | Deliberate duplication, **drift-guarded** by `tests/netlify/site-config-drift.test.ts` — which omits zilberman. | #32 |
| 17 | `object-git-committer.ts` vs the deleted article publisher | `server/lib/object-git-committer.ts:1-20` | A deliberate ~60-line duplication (OQ-12) so "a change to one publish path can never silently break the other". The other path no longer exists, so the duplication is now unilateral and the header describes a hazard that is gone. | #23 |
| 18 | `contentSourceV1JsonSchema` (hand-maintained) vs `object-contract.ts` (derived) | `packages/core/lib/registry/object-contract.ts:7-15` | The derived contract exists explicitly as "the opposite of the article tools' hand-maintained `contentSourceV1JsonSchema`" — DERIVE, NEVER HAND-AUTHOR. | — |
| 19 | `workflow-contract.ts` agent names vs CMS-Agent node ids | `packages/core/schema/workflow-contract.ts:1-5` (`reader_insight, research, angle, draft, final_article`) | `[DEPRECATED]` fixed vocabulary; the live agent plane is CMS-Agent, whose node ids (`plugin:claude`, `artifact_plan`, …) do not come from this list. | — |
| 20 | `set_voice_fields` in `PLUGIN_TOOL_DENYLIST` | `server/lib/plugin/build-tools.ts:47` | Denies a **tool** name that does not exist (it is a patch op, not a tool) — dead entry. | — |
| 21 | `NETLIFY_PUBLISH_ENDPOINT`, `CLERK_SECRET_KEY`, `PUBLIC_CLERK_PUBLISHABLE_KEY`, `CMS_AGENT_CHAT_MODE` | `README.md:165-176` at commit `6789644` (since archived to `docs/history/README-astrowind-template.md`); asserted unused by `tests/netlify/publisher-repoint.test.ts:169`, `tests/netlify/agent-chat-protocol.test.ts:994` | `[DOC-ONLY]` env names with zero readers, still documented as live. | #56 |

**Contract-integrity notes.**

1. A publish receipt is an **export** receipt: `publish_receipt.commit_sha` names a commit carrying
   `[skip netlify]`, which did not deploy (`object-publish.ts:75-87`,
   `mcp-tool-handlers.ts:3318-3325`).
2. Records are read **without** envelope validation on the hot path — `object-publish.ts:loadRecord`,
   `object-retire.ts` and `object-verbs.ts` all use `JSON.parse(raw) as ObjectRecord`. A corrupt
   envelope surfaces as a runtime TypeError, not a parse error.
3. No contract carries a machine-readable deprecation marker. Every `[DEPRECATED]` above is inferred
   from importer counts and header comments.
4. Object ids have their own grammar (`packages/core/lib/object-ids.ts`, `object-ids-mint.ts`), and
   ingest re-validates with `isObjectIdForType` even where a schema keeps the shape loose.

## Unverified / open

- Field-level shapes on the CMS-Agent side (`client_manager.turn.v1`, `workflow_get_run`,
  `node_get_latest_output`, `visual_identity_propose`) — bounds and error codes are pinned here, the
  schemas live in `vreich-ui/cms-agent`.
- pdf-tool's `parseCapturePolicy`, `HARD_MAX_CAPTURE_PAGES_PER_JOB` and `docs/MCP_BRIDGE_PARITY.md`
  — cited by `capture-bridge-policy.ts` / `pdf-tool-client.ts:79-89`, not readable from this repo.
- kugel-data's stored column sets for `/api/tracking-sink`, `/dims`, `/stats`, `/commerce`, `/link`,
  `/rollups`, `/weights`. This repo only *produces* against them.
- Whether `sites/*/data/site/**` is read by anything besides the Astro build. `content-item-index.ts`
  reads committed content over the GitHub API, so at least one server-side reader exists; external
  readers cannot be enumerated from here.
