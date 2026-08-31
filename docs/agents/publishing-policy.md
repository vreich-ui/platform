# Dr. Lurie agent publishing policy

## TL;DR (for humans)

**What this is:** the rulebook an AI agent follows to publish an article to the Dr. Lurie site — everything it needs *beyond* the raw MCP tool list. The detail below is written for the agents; this box is the map for a person.

**How publishing actually works now:**
- Articles are **governed JSON objects** (`content_item`), not markdown files — created and edited through the object MCP verbs, validated, then committed. The old markdown pipeline is frozen and its post collection was wiped.
- An article is a sequence of **functional blocks** (hook, agitation, proof, resolution, …), each tagged with its persuasive role and written in rich text — never one wall of text.
- **Images are made by PDF-Tool and referenced by a public `/img/…` path.** Agents never invent storage keys or paste raw blob keys into the article body.
- **Publishing is free; releasing costs money.** Agents publish many articles as invisible commits, then trigger **one** Netlify build for the whole batch. *(Interim measure — a successor release policy is planned; see §7.)*
- **Four independent gates** guard go-live (tool access → publish enablement → object-store approval → content validation). Clearing one never clears another.
- Agents **look answers up** (`object_contract`, `object_inventory`, `object_validate`) instead of guessing and burning tokens on failed writes. §3 is that map.

**Why it exists:** both repos carried two generations of publishing machinery. This document names the one live path, cites the enforcing code for every rule, and registers the stale mechanisms to avoid — so an agent publishes correctly on the first try and a human can see the whole contract at a glance.

**Where you are:** this is the copy that lives *in the client repo* — the site whose object store, schemas, and MCP enforce every rule below. It is mirrored from `vreich-ui/CMS-Agent` (`docs/projects/dr-lurie-agent-publishing-policy.md`); keep the two in sync. Within this repo it **supersedes the tool sequences** in the older `docs/agents/` publishing docs (`publishing-instructions.md`, `mcp-final-agent-sequence.md`, `mcp-article-body-v1.md`), which describe the frozen `save_json_blob_*` pipeline — those remain useful only for artifact-safety semantics and the result-status taxonomy (§14). Paths written bare (`src/…`, `netlify/…`) are in this repo; cross-repo references are prefixed `CMS-Agent/`.

---

**Status: v2 proposed — 2026-07-22. Derived from code and docs in the `Dr-Lurie-Blog` repo (at PR #463) and the `CMS-Agent` repo. Every rule cites the enforcing code or the authoritative doc. Where this policy disagrees with an older doc in either repo, this policy names that doc stale and wins. v2 adds the operational layer (discovery map, locks/versions, error catalog, dedup/variants, taxonomy authoring, attribution, limits) so agents look answers up instead of burning tokens probing for them.**

This is the policy an agent needs *beyond* the MCP tool contract: which pipeline to use, where its JSON goes, what shape the content must have, what the gates are, how to recover from every error class, what costs money, and which mechanisms are stale and must never be used.

**Invariance principle.** Every rule in this policy holds for every publish — nothing here varies per article or per publication. The few things that *can* vary (policy knobs, environment flags, media budgets) are listed in §3 with the tool that reports their current value: agents check, never guess.

Authoritative upstream sources, in order:
1. Enforcing code in Dr-Lurie-Blog (`src/schema/bodies/content-item-v1.ts`, `src/schema/object-patch-ops.ts`, `src/lib/object-patch-apply.ts`, `netlify/lib/object-verbs.ts`, `object-lock.ts`, `object-validate.ts`, `publish-gate.ts`, `production-release.ts`, `artifact-trust.ts`, `src/lib/registry/object-contract.ts`).
2. `Dr-Lurie-Blog/docs/agents/cms-agent-contract-alignment.md` (2026-07-19, user-ratified) and `docs/agents/cms-agent-enablement-runbook.md`.
3. `Dr-Lurie-Blog/docs/cms-architecture/08-articles-plan.md`.
4. Older agent docs (`publishing-instructions.md`, `mcp-final-agent-sequence.md`, `mcp-article-body-v1.md`) remain authoritative **only** for artifact-safety semantics and the result-status taxonomy — their tool sequences are legacy (§12).

---

## 1. The mental model (read this first)

1. **Two grammars.** The agent *authors* `article_body.v1` (CMS-Agent's minimal sibling grammar). The client *stores* `content_item.v1` objects. They are related but not identical; a mapping step stands between them (§5.6). Never send `article_body.v1` fields (e.g. `schema_version`) into a `content_item` write.
2. **Blocks, not blobs.** An article is never one body of text. It is a sequence of **functional blocks** — nodes with a `private.strategy` role (hook, agitation, proof, resolution, …) forming a persuasion/education arc. One giant text node is a policy violation even when it validates (§5.3).
3. **Publish ≠ Release** *(interim — see §7)*. `object_publish` commits JSON with `[skip netlify]` — free and invisible to readers. `release_to_production` triggers the one paid Netlify build that ships *everything* accumulated. Batch publishes; release once.
4. **Artifacts are made by PDF-Tool, referenced by public path.** Agents never mint storage keys and never ship raw blob keys into renderable fields. Renderable `src` is always `/img/{id}/{sha}.ext` or `/pdf/{id}/{sha}.pdf` (§6).
5. **The request id is the spine.** `req_<flow>_<topic>_<yyyymmdd>_<nn>` is the workflow id, the artifact-trust scope, the content_item object id, and the committed filename. Get it right before doing anything else (§11).
6. **Look up, don't probe.** Every schema, op list, policy knob, and live state has a designated discovery tool (§3). Trial-and-error against the write path is a policy violation and a token sink: one `object_contract` call answers what five failed `object_patch` calls would.

## 2. System map — who owns what

| Concern | Owner | Enforcing location |
|---|---|---|
| Authoring workflow (ideation → draft → review → article body) | CMS-Agent workspace (Publishing Conductor nodes) | `CMS-Agent/src/agent/workspace/nodes.ts` |
| Authored grammar `article_body.v1` | CMS-Agent | `CMS-Agent/src/agent/mcp/workspace/store.ts` |
| Governed object store, `content_item.v1`, validation, review, publish, release | Dr-Lurie-Blog MCP (`Dr_Lurie_MCP_Server`, `netlify/functions/mcp.ts`) | `Dr-Lurie-Blog/netlify/lib/object-verbs.ts`, `object-validate.ts`, `object-publish.ts` |
| Artifact bytes (images/PDFs) | PDF-Tool via Platform's server-side artifact bridge | `create_agent_artifact_job` / `get_agent_artifact_job_status`; `packages/core/server/lib/artifact-trust.ts` |
| Serving images/PDFs to readers | Dr-Lurie-Blog Netlify redirects `/img/*`, `/pdf/*` → blob-backed functions | `Dr-Lurie-Blog/netlify.toml`, `netlify/functions/get-public-image.ts`, `get-public-pdf.ts` |
| Production deploys (the paid step) | Dr-Lurie-Blog `release_to_production` (agent) and `admin-release.ts` (human button) — same code path | `Dr-Lurie-Blog/netlify/lib/production-release.ts` |

The CMS-Agent workspace MCP is **not** the publishing backend and must not impersonate it. It prepares content and drives the Dr-Lurie MCP verbs through `project.call_tool`. That adapter is a pure pass-through (`CMS-Agent/src/agent/projects/projectMcpAdapter.ts`) — it adds nothing to the arguments, so everything below about argument shapes applies verbatim to calls made through it (including `agent_name`, §8.5).

## 3. Where answers live — the discovery map

Call the right tool once instead of probing the write path. This table is the token-efficiency core of the policy.

| Question | Answer source |
|---|---|
| Exact body schema, allowed patch ops (+arg schemas, minted ids), constraints (+severity, enforced-live), publish/creation/media policy, workflow sequence, patch error codes, auxiliary inputs — **per object type** | `object_contract {object_type}` — pure, in-process, derived from the enforcing schemas so it cannot drift (`mcp.ts:4247-4256`, `object-contract.ts:928-943`) |
| Does this object exist? Live version, lock holder, review state, unpublished changes | `object_inventory` (filters: `object_type, object_id, status, requires_approval, review_state, pending_changes`); thin listing via `object_list {object_type, status?}`; `object_get` → 404 `{not_found:true}` |
| Would this exact patch/create pass? | `object_validate {object_type, object_id, candidate_patch}` (dry-run, no lock, no write); create-family verbs also accept `dry_run:true` → returns `id_available` + would-be `object_id` without persisting |
| Section/component vocabulary, page types | `registry_get {registry: 'component'|'page_type'}` |
| Taxonomy terms available right now | `object_get`/`object_inventory` on `taxonomy`/`tax_drlurie` (§8.4) |
| Current media budget / preferred format / over-budget behavior | `object_contract` → `media_policy` (do not hardcode; §6.1 values are the committed defaults) |
| Is publishing gated for this type right now? Which denial codes? | `object_contract` → `publish_policy` (computed from live policy) |
| How hard may copy push on this site? (W6 §2 aggression ceiling) | `object_contract {object_type:"content_item"}` → `aggression_ceiling` (mirrored at `publish_policy.aggression_ceiling`) — see the note below this table |
| May an agent create this type? | `object_contract` → `creation_policy`; denial at write is 403 `creation_restricted` listing `allowed_agents` |
| Deploy state of a commit | `deploy_status {commit}` |
| Did my images / PDF attachments actually render on the live page? | `verify_article_images {url, expectedImages, expectedDocuments?, commit}` — documents (`type:"document"` media) are checked as `<a href>`/`<object data>` fetching `application/pdf`, never as `<img>` |
| Is the server cold? Am I paying a cold start? | `ping` → `{instance_age_ms, instance_invocations}`; unauthenticated probe `GET /mcp?health=1` |

**`aggression_ceiling` (content_item only; W6 §2, Wolf's standing ruling in CMS-Agent WORK-ORDER-2026-08-12).** The client contract DECLARES the site's aggression ceiling — a componentwise UPPER BOUND on four dials, each a finite number in `[0, 1]`: `claim_strength` (how absolute claims may read), `urgency` (time pressure / scarcity), `emotional_agitation` (fear / shame / FOMO stirring), `cta_density` (how many and how prominent the calls to action). It is a ceiling, not a target: copy may always be calmer. CMS-Agent's `contractReduction` reads it off the contract record and resolves the brief's intensity vector as `resolved = min(placement_target, ceiling)` per dial. Source of truth is the committed `sites/<client>/config/site-identity.ts` (`aggressionCeiling`), validated at resolve time — a malformed value fails the boot/build loudly. An ABSENT ceiling is a blocker upstream by design (CMS-Agent warns `aggression_ceiling_missing` and leaves the intensity vector unresolved), so `object_contract(content_item)` throws rather than ship a contract without it. JSON paths: `contract.aggression_ceiling` and `contract.publish_policy.aggression_ceiling` (identical).

**What `object_contract` does NOT answer — this policy owns it:** lock lease numbers and refresh semantics (§9.1), version-conflict recovery (§9.2), create-side error codes and the two-layer error envelope (§9.3), retry/idempotency rules and payload limits (§9.4–9.5), attribution (§8.5), review/discard argument shapes (§8.6, §10.3), and everything cross-cutting (naming, stale register, result classification).

**Environment/policy knobs that exist but must never be assumed** (check, or treat as operator concerns): approval posture and pins (`object_contract.publish_policy`), creation allowlists (`object_contract.creation_policy`), media budget (`object_contract.media_policy`), `HERO_IMAGE_REQUIRED` (operator flag — when on, a no-hero publish 422s `featured_image_required`), `NETLIFY_BUILD_HOOK_URL` (release fails `netlify_build_hook_not_configured` when unset), `ARTIFACT_UPLOAD_MAX_BYTES` (direct-upload cap override).

## 4. The one current pipeline (object path)

Everything below is the **only** sanctioned publish path. The `save_json_blob_*` pipeline is frozen legacy (§12).

```
0. Pick request id            req_<flow>_<topic>_<yyyymmdd>_<nn>   (§11; never auto-generated)
1. Reuse-first check          object_inventory / object_list — does the id or slug already exist? (§10.1)
2. Produce media FIRST        grant → PDF-Tool job → verify        (§6; fail-closed: media failure ⇒ no publish attempt)
3. object_create              content_item, object_id = request id, pass agent_name (403 creation_restricted if policy blocks)
4. object_checkout            take the lock (lease 900 s default; §9.1)
5. object_patch               node upserts, taxonomy, seo, hero — media as PUBLIC paths only (§5.7 ops)
6. object_validate            dry-run the exact candidate patch; fix every blocker before continuing
7. object_publish             dark commit: '[skip netlify]', production.live:false — NO deploy
8. (repeat 3–7 per article)   batch as many articles as the run intends
9. release_to_production      ONCE for the whole batch — the only paid step (interim policy, §7)
10. deploy_status {commit}    poll 10–15 s up to ~5 min until deployStatus:"ready" AND productionConfirmed:true
11. verify_article_images     with {url, expectedImages:['/img/…'], expectedDocuments:['/pdf/…'], commit} — PDFs are asserted as <a href>/<object data> + content-type application/pdf
12. object_checkin            release the lock
```

Enforcement anchors: dark-commit marker `NETLIFY_SKIP_MARKER = '[skip netlify]'` (`object-publish.ts:81`); single build trigger (`production-release.ts:119,158`); batch-release discipline stated in the tool contract itself (`mcp.ts:1108–1137`) and `cms-agent-contract-alignment.md:117`.

Expected non-errors an agent must not "fix":
- First `release_to_production` returning `build_not_confirmed_live` — the in-call wait is capped (~6 s); poll `deploy_status` instead of re-releasing.
- `verify_article_images` returning `inconclusive` before the deploy is live — deploy-aware by design; only `deployReady:true` verdicts are definitive.
- `build_ready_not_published` / `productionConfirmed:false` — Netlify Auto-Publishing is locked; a **human** unlocks or publishes the deploy. Stop and report; do not re-trigger builds.
- 200 `{idempotent:true}` from `object_checkin`/`object_refresh_lock` on a lock-less record — a no-op acknowledgement, not a failure (§9.4).

## 5. Where and what to add to the client's JSON

### 5.1 Where it lands

A published `content_item` materializes to **`sites/drlurie/data/site/articles/{request_id}.json`** in Dr-Lurie-Blog (W11 T11.6 relocated the export root out of `src/data/site`; the writer is `packages/core/server/lib/materializers/content-item.ts`, site-parameterized via `SiteBinding.dataRoot`). Agents never write this file — it is the server-side export of `object_publish`. The reader URL comes back in the publish response (`production.article_path`, `object-publish.ts`); use that plus `verify_after_release` — never hand-construct reader URLs (legacy `/post/<slug>` is dead, §12).

### 5.2 Body envelope (`content_item.v1` — `src/schema/bodies/content-item-v1.ts:233`)

All objects are zod `.strict()` — **unknown fields are rejected at every level**, and there is **no `schema_version` field** in the body.

| Field | Required | Rule |
|---|---|---|
| `slug` | ✔ | `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`; collision with committed content is a validation blocker (422 at write — no pre-check tool, so dedup via inventory first, §10.1) |
| `title` | ✔ | non-empty |
| `nodes` | ✔ | array of nodes (§5.3); ≥1 reader-visible node required to publish |
| `deck`, `description` | – | short standfirst / summary |
| `image` | – | hero `{src, alt}` — `src` must be `/img/…`; **a PDF can never be the hero** |
| `taxonomy` | – | `{category, tags[]}` — every term must resolve **active** in the `tax_drlurie` registry (§8.4) |
| `seo` | – | `{meta_title, meta_description, canonical_url}` |
| `editorial` | – | `{framework, writer_notes}` — framework names the arc (e.g. PAS); deviation **warns, never blocks** |
| `sources`, `claims`, `compliance`, `scores[]`, `lineage`, `emotional_strategy`, `publication_context` | – | judge/audit substrate; carried verbatim, never rendered |

### 5.3 Nodes — the functional-block rule (POLICY, stricter than schema)

Node anatomy (`content-item-v1.ts:99`): `id`, `kind ∈ {content, action, placement, interactive}`, `public` (required), `private`, `commercial`, `chat`, `rendering`, `visibility ∈ {public, internal, hidden}`.

**Policy requirements on top of the schema:**

1. **Decompose.** An article body is authored as multiple nodes, one functional block each. A single node carrying the whole article text is non-compliant even though the schema allows it.
2. **Every content node declares its function** in `private.strategy` — closed enum (`article-content-v1.ts:66`):
   `hook · agitation · context · explanation · proof · example · comparison · myth · step · recommendation · resolution · summary`
   and `private.intent` — `educate · persuade · reassure · convert · navigate`.
   Offers/CTAs are **not** a strategy value: express them as `kind:"action"` nodes (`ctaText`/`ctaLink`) with `intent:"convert"`, optionally with the `commercial` field.
3. **Arc, then blocks.** Pick the framework first (PAS `hook → agitation → resolution → recommendation`, AIDA, Before-After-Bridge, or a house arc — `08-articles-plan.md:243–245`), record it in `editorial.framework`, then write one node per beat. Live reference shape: `req_agent_niacinamide_barrier_after40_20260719_01.json` — seven nodes, `hook → context → explanation → proof → myth → step → summary`, each with `public.title` + rich `public.body`.
4. **`private` never renders.** Enforced twice: the renderer emits only `public` fields (`render-nodes.ts:280`) and the reader-safety check blocks the words `private, strategy, agentNotes, sourcePromptId, inputTemplateId` from the reader projection (`object-validate.ts:594`; `assert-reader-safe.ts:5`). Never copy strategy labels into visible text.
5. **Node ids are opaque.** `/^n_[a-z0-9]+$/i` **minus** the forbidden words `hook, agitation, cta, advert, offer` (`content-item-v1.ts:48–58`). Author **lowercase only** (`n_open`, `n_evidence`); the role lives in `private.strategy`, never in the id. You may omit the id on `upsert_node` — the server mints one (§5.7).

### 5.4 Rich text per block

`public.body` is `string | rich_text.v1` (`content-item-v1.ts:81`). **Prefer `rich_text.v1` for every content block**; use plain strings only for genuinely flat copy (they render escaped: blank line → paragraph, single `\n` → `<br/>`).

`rich_text.v1` (Contentful-shaped: `nodeType`/`content`/`value`/`marks`/`data` — `src/lib/richtext/rich-text-v1.ts`):
- **Blocks:** `paragraph`, `heading-2`, `heading-3`, `unordered-list`, `ordered-list`, `list-item`, `blockquote`.
- **Marks:** `bold`, `italic` — nothing else.
- **Inline:** `hyperlink` only; `data.uri` non-empty, no whitespace; **https-only survives render** (`SAFE_HREF_RE = /^https?:\/\//` in both `object-validate.ts:262` and `node-renderer.ts:56`; sanitizer tag set `p,br,strong,em,a,ul,ol,li,h2,h3`).
- **Embeds (`embedded-entry`/`embedded-asset`) are schema-legal but validation- and render-blocked** — do not author them. Inline images go through node `media`/`images[]`, not rich-text embeds (`cms-agent-contract-alignment.md:40`).

### 5.5 Media on a node

`public.media` = `{type ∈ image|video|audio|embed|document, src, alt, caption, title, contentType}`; multi-image via `public.images[]`. `src` rules in §6. Hero is body-level `image {src, alt}` — **not** a `featuredImage` publish argument (that is legacy, §12).

### 5.6 Mapping from the authored grammar (`article_body.v1` → `content_item`)

When CMS-Agent materializes its authored body into an `object_create`/`object_patch`:
- **Drop** `schema_version` (content_item has none; strict schema rejects it).
- **Root** `slug`, `title`, `deck`, `description`, `taxonomy`, `seo`, `image`, `editorial` at the body — they are not node fields.
- **Preserve** node ids (`n_*` lowercase), `kind`, `visibility`, `public.*`, and carry strategy annotations into `private.strategy`/`private.intent` (T9.22: "strategy annotations preserved into `private.*`").
- **Convert** every artifact reference to its public path before the write (§6.3).
- **Validate** with `object_validate` (candidate_patch dry-run) before `object_publish` — same checks, full report (`cms-agent-contract-alignment.md:75–76`).

### 5.7 Editing via `object_patch` — the content_item op set

Allowed ops (`object-patch-ops.ts:767–775`) — anything else on a content_item fails `op_not_applicable` (422):

| Op | Args | Notes |
|---|---|---|
| `set_article_meta` | `{fields}` | deep-merge on the envelope; **forbids** keys `nodes` and `tracking` |
| `upsert_node` | `{node, position?}` | `node.id` **server-minted when omitted**; same id replaces in place |
| `update_node` | `{node_id, fields}` | deep-merge over the node envelope; **forbids** `id` |
| `move_node` | `{node_id, to_index}` | |
| `set_node_visibility` | `{node_id, visibility}` | `'public'|'internal'|'hidden'|null` (null restores default public) |
| `remove_node` | `{node_id}` | |
| `set_tracking` | | tracking config wiring |

Every op additionally accepts an optional `guard: {expected: <snapshot>}` — deep-equality-checked before apply; mismatch → `blind_revert_refused` 409 (§9.3). Do not hand-author `reactivate_term`-style INTERNAL ops (inverse-only, `object-contract.ts:190`).

One routing note that has wasted probes before: `object_patch` **does** edit content_item via the ops above. The message "content_item is served by the existing article tool surface … generic patch ops do not apply" (`object-patch-apply.ts:1130`) is only the fall-through for an op *outside* this allowlist (e.g. `upsert_section` on an article) — not a blanket refusal.

## 6. Media and artifact policy

### 6.1 Production (fail-closed, server-bridged)

1. Call Platform `create_agent_artifact_job` with the owning `site_id` and existing content-item `request_id`; Platform resolves the canonical PDF-Tool project and injects the grant server-side. The raw grant RPC is removed, so grants and tokens never enter agent context (`docs/agents/pdf-tool-storage-grant.md`).
2. Poll Platform `get_agent_artifact_job_status` without recreating the job. Request `requirements.image.outputFormat:'webp'` and `requirements.maxBytes` within budget (may lower the cap, never raise it).
3. Image formats: **JPEG/PNG/WebP only** (server-decoded by sharp; GIF/AVIF/SVG rejected — `image-validation.ts:19`). Budget: committed defaults `maxImageBytes` 153,600 (~150 KB), `preferredImageFormat` webp, over-budget **warns** (`src/config/media-policy.ts`) — read the live values from `object_contract.media_policy`, and treat the warning as a defect to fix, not noise.
4. PDF jobs require a **published** PDF template — preflight `list_pdf_templates`, else `create_pdf_template` → `publish_pdf_template`.
5. Platform verifies materialization server-side before returning a completed reference; cross-check `list_artifacts_for_request` when needed **before** any object write. Media failure ⇒ stop; do not publish a degraded article.

### 6.2 Trust scope

Artifact references are trusted **per request id** only (`artifact-trust.ts:78`): uploaded for THIS request or already in `agent_outputs[*].output.artifactReferences`. Cross-request reuse is rejected by design; soft-deleted refs are untrusted until restored. Never synthesize a blobKey, repo path, or URL — store what the server returned, exactly.

### 6.3 The reference-form rule (the flip that broke builds)

- Raw blobKey ("Major Key"): `image/{req}/{sha256}.ext`, `pdf/{req}/{sha256}.pdf` (`MAJOR_KEY_ARTIFACT_REF_RE`, `artifact-trust.ts:5`). Belongs **only** in `*AssetRef` / `artifact_ref` carrier fields (`RAW_REF_CARRIER_KEY_RE`, `object-validate.ts:784`).
- Public renderable path: `/img/{req}/{sha}.ext`, `/pdf/{req}/{sha}.pdf` (`PUBLIC_ARTIFACT_PATH_RE`; served via `netlify.toml` redirects — a URL rewrite over the blob store, no committed asset needed).
- **A raw blobKey in any renderable field is a write-blocker** (`checkRenderableImageRefs`, `object-validate.ts:786`) — it 404s in the browser and can fail the whole Astro build. Convert with `publicPathForArtifactRef` semantics (`artifact-trust.ts:17`): prefix rewrite `image/… → /img/…`, `pdf/… → /pdf/…`.
- Also blocked in `media.src`: `data:` URIs and legacy repo paths (`src/assets/…`). Remote `https://` and bare site paths **warn** — avoid them; article media should be materialized artifacts.
- **A PDF can never be the hero** — write-blocked (`forbidPdf` on hero, `object-validate.ts:1843`); PDF belongs in `media {type:'document', src:'/pdf/…'}` or an action node's `ctaLink` with the exact artifact-derived path.

## 7. Release and build-cost policy — **INTERIM**

> **INTERIM POLICY.** The publish/release split and the batch-release cadence below are a temporary cost-control measure; a successor release policy is planned and will replace this section. Until it does, agents follow this exactly — and must treat release *cadence* as an external decision, never their own.

**The paid event is the Netlify production build. Everything before it is free.**

1. `object_publish` **never** deploys — every export commit carries `[skip netlify]` (`object-publish.ts:81`). Publish as many articles as the batch needs.
2. `release_to_production` is the **only** sanctioned build trigger for agents; it POSTs the build hook **once** and returns receipts (`released:true` only when the *published* production deploy matches the target commit — `production-release.ts:119–214`). One release ships **all** accumulated dark commits.
3. `trigger_netlify_build` is **not** for agents on this path (deliberately excluded from the enablement allowlist — it queues a build with no production confirmation). The human "Release to Production" admin button drives the same `releaseToProduction` code path, so batching discipline is identical for humans and agents.
4. A run must never emit more than one release; "publish 5, release 5×" is a policy violation with direct cost. Whether the run releases at all (vs leaving it to the human button) is decided by the run's instructions, not by the agent.
5. Scheduling/unpublish do **not** exist on this path: `published_time` future → `scheduling_not_supported`; `null` → `unpublish_not_supported` (`object-publish.ts:174–188`). A released article stays live until edited — **publish only go-live-acceptable content.** Timed drops are orchestrated upstream (CMS-Agent schedules the *batch*), not via the object verbs.
6. Rollback honesty: the build hook always builds branch HEAD. Content rollback = inverse patches → republish → re-release. Deploy rollback = human publishes an earlier deploy in Netlify UI. `release_to_production {commit:<old>}` can only *verify* an old commit, never rebuild it.

## 8. Gates — who may do what

Four independent gates stand between an agent and a live page. **Granting one never implies another**:

### 8.1 Access: tool allowlist (CMS-Agent project config)
The `dr-lurie` project connection currently exposes a **read-only + artifact** allowlist (`CMS-Agent/src/agent/projects/drLurie/definition.ts`) — **no object verbs, no release, no deploy_status**. Enabling the object path means a human expands the allowlist per `cms-agent-enablement-runbook.md`, which also names the **deliberate exclusions**: all `save_json_blob_*`, `trigger_netlify_build`, `save_artifact`, `create_artifact_upload_intent`, `create_artifact_from_url`, `object_review_decide`, `wipe_blob_stores` (stays needs-approval).

### 8.2 Policy: publish enablement (CMS-Agent side)
`publishingPolicy.publishEnabled` is server-enforced `false` and not patchable; the operator override is the env flag `DR_LURIE_PUBLISH_ENABLED=true` in the deployment (`CMS-Agent/src/agent/workspace/publisher.ts:56–62`). Even then, every `workflow_publish_run` needs `approved:true` **and** `live:true` **and** a GO from the readiness hook (verified media refs, taxonomy, pinned approval, hard constraints — `publishReadiness.ts`). The flag alone publishes nothing.

### 8.3 Object-store gates (Dr-Lurie side)
- **Creation policy** (`src/config/creation-policy.ts`): master `open`; `content_item` is agent-creatable; `tracking_config` restricted to its seed agent. Denial = 403 `creation_restricted` with `allowed_agents`.
- **Approval policy** (`src/config/approval-policy.ts`): master `all-autonomous`; `product` requires approval; `content_item` is Tier-1 autonomous **today** — the article flow goes checkout → patch → `object_publish` directly, with no review verbs. If the human flips the posture, the M-6 pin applies: approval pins `content_revision` + `publish_action` (`'immediate'` | ISO | `null`) and optionally `request_id` / `artifact_set` (exact set match) / `release_build` (`'defer'|'release'`). Any mismatch is a 403 with a specific denial code (`publish-gate.ts:84–96`: `approval_stale`, `publish_action_mismatch`, `publish_artifact_set_mismatch`, …). Further patches after approval make it stale by design. Read the live posture from `object_contract.publish_policy` — never assume.

### 8.4 Content gates — and the taxonomy registry is agent-editable
Strict schema; slug collisions block; raw blobKeys in renderable fields block; reader-safety leak check blocks; ≥1 reader-visible node to publish; media budget per policy.

Taxonomy: `body.taxonomy.category`/`tags[]` must resolve to **active** terms in `tax_drlurie` (by slug or `term_id`, `merged_into` aliases followed; unknown terms block — `object-validate.ts:394–418`; publish-side `taxonomy-enforcement.ts:70–119`). **When a term doesn't resolve, the sanctioned agent move is: prefer an existing term; otherwise extend the registry yourself** — `tax_drlurie` is a curated *agent-editable* vocabulary (`AGENTS.md:27`; creation policy `open`): `object_checkout` the taxonomy object and `object_patch` with `add_term {kind: 'category'|'tag', term {slug, label, description?}}` (`term_id` minted from the slug). Registry rules (`object-validate.ts:877–957`): term ids `t_[a-z0-9]+`, slugs kebab-case and unique per kind, `merged_into` must point at an existing active in-kind term with no cycles, deprecating a term in live use requires `merged_into`, slug renames auto-mint a deprecated alias. Do not remove terms to "clean up" — deprecate with a merge target.

### 8.5 Attribution — always pass `agent_name` where it exists
The object store records a self-declared principal: `agent_name` trimmed; empty/absent → **`'unattributed-agent'`** (`object-store.ts:71–74`). The MCP forwards `agent_name` **only on the create-family verbs** (`object_create`, `object_create_variant`, `object_instantiate_template`, `object_instantiate_section_template`, `site_apply_theme`, `product_set_price`, `order_reissue` — `mcp.ts:1356,1438,4056–4097`); other verbs (patch/checkout/publish/…) do not carry it and their history lands unattributed by design today. Policy: **always pass a stable `agent_name` on every verb that accepts it.** It is attribution, not authentication (a coordination seam until per-agent credentials — OQ-3); never treat it as a security control.

### 8.6 Review verbs (dormant for content_item — documented for when policy flips)
`object_submit_review {object_type, object_id, lock_token (required), note?, requested_publish_action?}` — needs a held lock; sets `review_state:'open'`. `object_review_decide {object_type, object_id, decision:'approve'|'request_changes', note?, publish_action?, approval_pin {request_id, artifact_set[], release_build}}` — no lock needed; an agent principal may decide over the publish key, while a human decider needs the review role (403 `review_role_required` otherwise — `review-state.ts:186–238`). Review writes bump `version`, never `content_revision`. States: `none | open | changes_requested | approved_stale | approved_current`.

### 8.7 Membership — a HUMAN-only family (W18 T18.6a/b)
Sixteen `member_*` / `invitation_*` / `ownership_transfer` / `membership_*` tools manage who may sign in to `/admin` and at what tier. They ride ONE core (`handleMembershipVerb`) whose first line refuses every agent principal with **403 `membership_requires_human`** — the shared site token, per-agent tokens and any `agent_name` are refused, and over `/mcp` the tools are not even *listed* to them. They work only for a **Netlify Identity human**: an OAuth connection that human approved (`/oauth/authorize` → consent) or the admin-chat human. Everything but the reads is Owner-tier (Admins may invite editor/viewer under the site policy), every write is `ask`-class with a floor no governance can lower, and every change is audited with the door it came through (`via: mcp | chat | admin_ui`). Identity e-mails still go out (GoTrue `POST /invite`) but Identity *deletes* from MCP/chat are queued until an admin-UI Owner request drains them (no GoTrue admin token off the Identity JWT).

**Recipe — "Manage members":** `membership_contract` (read the gate, tiers, verbs, live policy, error catalogue) → `member_list` → `member_invite { email, role, dry_run:true }` (see would: invite | reinvite | refuse:*) → `member_invite { email, role, message?, idempotency_key }` → later `member_set_role` / `member_suspend` / `member_remove { dry_run:true }` → `member_remove`. `ownership_transfer` before demoting the last Owner (`last_owner`).

## 9. Operational discipline — locks, versions, errors, retries, limits

### 9.1 Locks (`netlify/lib/object-lock.ts`)

- **Lease: default 900 s (15 min), max 3600 s** (`object-lock.ts:36–37`); invalid lease → 400. Size the lease to the work; refresh mid-run rather than requesting the max up front.
- **`object_refresh_lock` extends from the current expiry, not from now** (`object-lock.ts:246–249`) — refreshes stack. Requires the matching `lock_token`.
- **Busy lock → 423** with the sanitized holder (`owner_id, owner_label, acquired_at, expires_at` — never the token). This includes **your own** active lock: checkout never re-issues (`object-lock.ts:160`); the owner refreshes instead of re-checking-out.
- **Stale/wrong token** (`guardHeldLock`, `object-lock.ts:131–144`): missing token → 400; record has no lock → **200 `{idempotent:true}`** (no write); token mismatch → 423 (even if that lock already expired); matching token but expired → 423 `{error:'lock_expired'}` → checkout again.
- **Checkin is polite, not required** — lease expiry frees the object on its own. But `patch`/`publish`/`submit_review`/`discard` all require an *active* held lock (423 otherwise), so let the lease lapse only when abandoning work.
- **Agents cannot force-unlock.** Force release is `object_checkin {force:true}`, owner-role humans only (403 otherwise; the MCP tool schema doesn't even expose `force` — `object-verbs.ts:1197–1206`, `mcp.ts:1470–1476`). If someone else holds the lock: wait out their lease (visible in the 423 body / `object_inventory.lock.expires_at`), then checkout.
- Lock writes bump `version` (never `content_revision`) and return the new `record_version` — feed it forward as your next `expected_record_version` (`object-lock.ts:186–316`, `object-verbs.ts:349–357`).

### 9.2 Versions and conflicts

- Optimistic concurrency argument: **`expected_record_version`** (int ≥0; there is no `base_version`). Conflict → **409** `{error:'Record version conflict', expected_record_version, actual_record_version}` (`object-verbs.ts:1228–1234`). The lock check (423) runs **before** the version check (409).
- Each applied op bumps `version` by 1; `content_revision` bumps only for ops that actually changed the body (`object-patch-apply.ts:1166–1169`). Patch responses return both — track them.
- **Recovery from 409:** the lock is still yours. Take `actual_record_version` from the error (or `object_get`), re-derive the patch if needed, retry. No re-checkout.
- Element-level guard: any op's `guard:{expected}` mismatch → `blind_revert_refused` 409 → re-read that element and retry deliberately (never strip the guard to force the write).

### 9.3 Error catalog and the two-layer envelope

Agents must parse **both** layers: JSON-RPC `error {code, message}` for transport failures (`-32700` parse, `-32600` invalid request, `-32601` unknown method, `-32001` unauthorized, `-32000` internal), and — for domain failures — a *successful* JSON-RPC result with `isError:true` whose `structuredContent` carries `{error, statusCode, …}` plus the endpoint's own fields (lock holder, expected/actual versions, patch `code`, validation `blockers`) (`mcp.ts:201–205, 2898–2905`). A tool "success" with `isError:true` is a failure.

Patch error codes (`object-patch-apply.ts:62–70`; HTTP mapping `object-verbs.ts:417–421`; catalog also served in `object_contract.workflow.patch_error_codes`):

| Code | Status | Meaning → recovery |
|---|---|---|
| `invalid_op` | 400 | malformed op — fix the op shape; consult `object_contract.patch_ops` |
| `op_not_applicable` | 422 | op not allowed for this type — use the §5.7 allowlist |
| `invalid_body` | 422 | record body lacks the container — inspect via `object_get` |
| `target_not_found` | 422 | addressed node/term doesn't exist — re-read ids |
| `duplicate_target` | 409 | e.g. `add_term` for an existing `term_id` — reuse the existing element |
| `blind_revert_refused` | 409 | `guard.expected` stale — re-read and retry |
| `alias_required` / `alias_conflict` | 422 | slug-rename aliasing rules (§8.4) |

Other statuses to expect: create — invalid `requested_id` 400, **duplicate object id 409** `{error:'Object already exists'}`, `creation_restricted` 403; post-patch validation failure — **422** `{error:'Validation failed', blockers, record_version_unchanged}` (nothing persisted); busy/expired lock — 423 (§9.1); version conflict — 409 (§9.2); missing object — 404 `{not_found:true}`. Slug collision has **no dedicated code** — it surfaces as a 422 validation blocker.

### 9.4 Retries and idempotency

- **Idempotent (safe to blind-retry):** all reads (`object_get/list/inventory/contract/validate`, `deploy_status`, `verify_article_images`, `ping`); `object_checkin`/`object_refresh_lock` on a lock-less record (200 `{idempotent:true}`).
- **Guarded (retry with state):** `object_patch` (same lock + refreshed `expected_record_version`); `object_create` after a lost response — check `object_get`/`object_inventory` first: a 409 `Object already exists` on retry likely means the first call landed.
- **One-retry rules:** expired storage grant → fetch fresh, retry once (§6.1); first-call timeout on a cold instance → treat as warm-up, retry once (`ping` reports `instance_age_ms`; a scheduled keepalive warms `/mcp` every 5 min, but cold starts >60 s have been observed).
- 423 is not retryable-now: wait for `lock.expires_at`, then checkout. Do not poll a held lock aggressively — check `object_inventory` on the same cadence you'd poll a deploy (10–15 s at most, and only when you intend to take the lock).

### 9.5 Payload and infrastructure limits

- Direct artifact upload: **5 MB** (`artifact-upload.ts:58`; operator-overridable via `ARTIFACT_UPLOAD_MAX_BYTES`).
- Base64 single-shot artifact guidance: **≤750 KB** raw bytes; do not chunk small images (`mcp.ts:136,1190`).
- Per-image media budget: **150 KB / webp preferred** — live values via `object_contract.media_policy` (§6.1).
- Artifact list responses cap at **100** rows (`mcp.ts:133`).
- No server-side rate limiting exists in the MCP/object code — the byte and list caps above are the only hard limits; behave accordingly (§9.4 cadence rules).

## 10. Before you create — dedup, variants, discard

### 10.1 Reuse-first
Before `object_create`: check `object_inventory {object_type:'content_item'}` (rows carry `object_id, version, content_revision, review_state, lock{…}, published_time, unpublished_changes`) or `object_list`; `object_get` 404s `{not_found:true}` when absent; create-family verbs accept `dry_run:true` and return `id_available` + the would-be `object_id` without persisting. The 403 `creation_restricted` body itself says it: *"REUSE FIRST: object_inventory({object_type})…"* (`object-verbs.ts:459–461`). Slug uniqueness has no pre-check tool — dedup slugs via inventory before writing, or expect a 422 blocker.

### 10.2 Variants, not copies
For A/B, judge/score, or re-angle work on an existing article, use `object_create_variant` (content_item only): it deterministically re-mints every node id (idempotent per source→new pair), re-points `claims`/`compliance` node references, sets `lineage.parent_content_id`, defaults the slug to `<source-slug>-variant`, and **drops `scores`** (a variant starts unjudged) (`variant.ts:31–62`). It then flows through the standard create gates. Never clone an article by hand-copying its body into `object_create` — that severs lineage and duplicates node ids' history.

### 10.3 Discard (undo) — precise, not free-form
`object_discard` takes `entries: [{op, capture}]` **exactly as record history stored them** (min 1), applies inverses newest-first as one atomic batch, and requires a held lock. It is a body write: `content_revision` bumps and any pinned approval is invalidated. Codes: `nothing_to_discard` 400, `discard_invalid_entry` 400, `discard_privileged_unverified` 403, `discard_conflict` 409, `blind_revert_refused` 409 (intervening ops block the revert — resolve manually with forward patches instead) (`review-state.ts:327–400`).

## 11. Naming and identity

| Thing | Rule | Source |
|---|---|---|
| Request/object id | `req_<flow>_<topic>_<yyyymmdd>_<nn>`, lowercase snake, date = today, `nn` 01–99, **caller-supplied, never generated** | `src/lib/agents-naming.ts`; `content-item-v1.ts:27–31` |
| Node id | `n_` + lowercase alnum, opaque, no `hook/agitation/cta/advert/offer`; omit on `upsert_node` to have it minted | `content-item-v1.ts:48–58`; `object-contract.ts:178–186` |
| Slug | kebab-case `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` | `content-item-v1.ts:238` |
| Taxonomy term id | `t_[a-z0-9]+`, minted from slug on `add_term` | `taxonomy-v1.ts:21–52` |
| blobKey | `{image|pdf}/{requestId}/{sha256}.{ext}` — server-minted only | `artifacts.ts:434` |
| Public media path | `/img/{req}/{sha}.{ext}`, `/pdf/{req}/{sha}.pdf` | `artifact-trust.ts:8–23` |
| PDF template id | `tpl_<project>_<purpose>_<variant>_v<version>` | `naming-convention.md` |
| Artifact slot | role-named (`img_hero`, `pdf_guide`), never storage-named | `naming-convention.md` |

A malformed request id is accepted at create but hard-400s every later artifact operation with no recovery — start over with a correct id.

## 12. Stale mechanisms — never use (the pre-object-model register)

The blog's post collection was wiped (83 markdown posts deleted; `src/data/post/` holds one dry-run leftover) and the 5-agent pipeline's markdown terminus is a dead end (`T9.22-repoint-ai-publisher.md`). The following are **frozen or inverted**; an agent (or a doc it reads) using them is operating pre-v1:

| Stale mechanism | Status | Replacement |
|---|---|---|
| `save_json_blob_*` tool family (create/checkout/patch/publish_by_time/checkin, `{agent}_update_output`…) | Frozen legacy; zero new writes; **do not allowlist** | `object_create/checkout/patch/validate/publish/checkin` |
| `publish-article.ts` markdown commits to `src/data/post/{slug}.md`; reader URLs `/post/<slug>` | Collection wiped; dead end | content_item JSON export `sites/drlurie/data/site/articles/{req_id}.json` (W11 T11.6); URL from publish response `article_path` |
| `article_body.v1` `schema_version` label sent to the client | content_item body has **no** `schema_version`; strict schema rejects it | drop at mapping (§5.6) |
| Raw blobKey in `media.src` (old rule: "src MUST be the raw pointer") | **Inverted** — now a write-blocker in renderable fields | public `/img/…`, `/pdf/…` paths (§6.3) |
| `featuredImage` publish argument + frontmatter `image:` | Legacy publish payload | body-level `image {src, alt}` |
| `rendering.placement:"inline"` as the render gate (silent `image_not_rendered` drop) | Legacy markdown renderer semantics | object renderer renders `public` media directly; placement is optional metadata |
| `published_time` future scheduling / `null` unpublish | `scheduling_not_supported` / `unpublish_not_supported` on the object path | immediate publish only; batch timing upstream; unpublish does not exist |
| `trigger_netlify_build` as the agent's release verb | Excluded from allowlist; no production receipts | `release_to_production`, once per batch (interim, §7) |
| `save_artifact`, `create_artifact_upload_intent`, `create_artifact_from_url` | Legacy transports (server-bridge posture; CMS-Agent's executable policy already blocks them at call time) | Platform PDF-Tool bridge (§6.1) |
| Standalone `mcp/save-json-blob-mcp` mirror (auto-generates `req_<uuid>` ids!) | Legacy mirror of a frozen pipeline; its auto-ids violate the id contract | main MCP object verbs |

**Stale items inside CMS-Agent itself** (flagged for cleanup; this policy supersedes them):
- `agent-publishing-instructions.md` (repo root, 2026-07-03): documents the frozen `save_json_blob_*`/markdown pipeline as current, including raw-blobKey `media.src` and `featuredImage`. Superseded by this policy.
- `src/agent/workspace/publisher.ts` tool sequence (`save_json_blob_create_article_draft → checkout → publish_by_time → checkin`): drives the frozen pipeline. The gate logic around it (§8.2) is current; the tool sequence needs repointing at the object verbs before enablement.
- `src/agent/projects/drLurie/knowledge.ts` artifact rules: "Do not rewrite ArtifactReference blobKey values into reader-facing public URLs" and "top-level `output.artifactReferences[]`" are legacy-path rules — on the object path the public path **is** the renderable reference (§6.3). The "future CMS object model" framing is stale: the object model is live.
- `docs/projects/dr-lurie-integration-notes.md`: same "future architecture" framing; media/verification cautions remain valid.
- `DR_LURIE_ALLOWED_TOOLS` (`drLurie/definition.ts`) allowlists `save_artifact`/`create_artifact_upload_intent`/`create_artifact_from_url`, which `executablePolicy.ts` then blocks at call time — net-blocked but self-contradictory; align the allowlist with the enablement runbook's exclusions.
- `articleBodySchema` (`store.ts`): plain-string-only `public.body` (no `rich_text.v1`), and its rendered-src pattern accepts **both** raw `image/…` and `/img/…` forms — the mapping layer must convert explicitly (§5.6), and the authored grammar should gain rich-text support to stop flattening block content.

## 13. Known divergences and open items (for the human)

1. **Node-id case sensitivity.** Blog code: `/^n_[a-z0-9]+$/i` — the `/i` admits `n_Intro`. CMS-Agent standalone schemas: `^n_[A-Za-z0-9]+$`. Effective acceptance is the same today; the *convention* everywhere (docs + all live articles) is lowercase. Recommendation: standardize authored ids to lowercase (this policy, §5.3.5) and, if strictness is wanted, drop the `/i` in the blog schema and tighten CMS-Agent to `^n_[a-z0-9]+$` in the same change. Note CMS-Agent also lacks the forbidden-word check the blog enforces.
2. **`blocks_write` is not a tool** — it is a constraint-severity value in the object contract (`src/lib/registry/object-contract.ts:216`). Task briefs citing "blocks_write enforcement" mean write-time validation blockers generally.
3. **Node kinds:** code enforces 4 (`content/action/placement/interactive`); `article-content-structure.md` still lists 5 (`reference` is deferred). Code wins.
4. **Pinning docs divergence:** `03-mapping-and-agent-contract.md` describes the M-6 pin as `{content_revision, publish_action}`; the enablement runbook adds `{request_id, artifact_set, release_build}`. The code implements all of them together (`publish-gate.ts:116–290`); follow the runbook's fuller pin for content_item.
5. **`agent_name` is self-declared** over the shared publish key — attribution, not authentication, until per-agent credentials land (OQ-3). It is also only forwarded on create-family verbs (§8.5); patch/publish history is unattributed today — a gap the per-agent-credentials work should close.
6. **Hero materialization tension:** `08-articles-plan.md` describes materializing artifact bytes into `src/assets/**/uploads/{slug}/`, while the ratified contract serves media from blobs via `/img/*`. The serving redirects are live; treat committed-asset materialization as an export detail owned by the blog repo — agents only ever reference `/img/…` paths either way.
7. **CMS-Agent enablement sequencing:** repoint `publisher.ts` to the object verbs *before* expanding the allowlist (§8.1) or flipping `DR_LURIE_PUBLISH_ENABLED` (§8.2) — otherwise the first enabled publish drives the frozen pipeline. Track as the follow-up to the T9.22 repoint on the blog side.
8. **Release policy successor:** §7 is interim by decision (2026-07-22); the replacement policy should make release cadence deterministic (so agents never have to decide it) and update §4 steps 9–10 accordingly.

## 14. Result classification (report honestly, always)

Adopted verbatim from the ratified taxonomy (`publishing-instructions.md`, still authoritative for statuses):
- **PUBLISHED** — 2xx, no warnings, and conclusive live verification (`verified:true`, `deployReady:true`).
- **PUBLISHED_WITH_DEFECTS** — 2xx but warnings (e.g. media budget) or verification found missing media.
- **PUBLISHED_VERIFICATION_INCONCLUSIVE** — 2xx but the deploy never confirmed ready / verify stayed `inconclusive`.
- **PUBLISH_FAILED** — non-2xx; nothing committed.

Never report PUBLISHED without conclusive verification, and never call `release_to_production` a success without `productionConfirmed:true`. A tool result with `isError:true` is a failure even when the JSON-RPC layer returned 200 (§9.3).
