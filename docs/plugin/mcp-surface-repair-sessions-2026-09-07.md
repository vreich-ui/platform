# Repair sessions — Dr-Lurie MCP publishing stack

Source: `dr-lurie-mcp-test-report.md` (2026-09-07 system test, site `site_drlurie`).
Five standalone briefs. Each is copy-paste-ready into a fresh runner chat — no prior context assumed.
Run **S3 first**; everything else is parallel-safe (S1/S2 touch pdf-tool, S3/S4/S5 touch platform — S3 and S4 both touch bridge files, so S4 waits for S3 to merge).

| Session | Repo | Model | Reasoning effort | Blocks |
|---|---|---|---|---|
| S3 · render_article_pdf repair | `vreich-ui/platform` | Opus | high | — (run first) |
| S1 · image ingress + search truthfulness | `vreich-ui/pdf-tool` | Opus | high | — |
| S2 · contract-gate hardening | `vreich-ui/pdf-tool` | Sonnet | high | — |
| S4 · MCP bridge schema truth | `vreich-ui/platform` | Sonnet | medium | after S3 merges |
| S5 · validation + contract truth | `vreich-ui/platform` | Sonnet | medium | — |
| S0 · ops, no code | — | — | — | do today, 10 min |

Standing conventions to repeat in every brief: **no new dependencies**; extract each decision into a pure module and test it with `node:test`; deliver as a squashed `land.command` patch zip (`patch-delivery` skill), one branch per session.

---

## S0 — Ops, no code session (Wolf, ~10 min)

Two of the P0s are configuration, not defects.

1. **Set image-search provider credentials** on the pdf-tool Netlify site (`pdf-x.netlify.app`): `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY`, `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX`. Without these, `search_images` on every tenant falls back to Openverse alone. The code half of this is S1.
2. **Decide the fate of PDF template `bef0d7b0-a042-4221-aa03-7870f1deb879`.** v1 was the 30-slot text-only generic guide; v2 added three *required* image slots and is now active. There is no `version` parameter anywhere in the bridge, so v1 is unreachable. Recommended: let S3 seed a proper article template rather than reverting v2 — v2 is a good lead-magnet template, it is just wrong as the article default.

---

## S1 — pdf-tool: image ingress + honest search status

**Repo** `vreich-ui/pdf-tool` · **Model** Opus · **Effort** high · **Branch** `image-ingress-truth`

### Defect 1 — no ingress path for caller-supplied image bytes (P0)
An agent cannot put a chart, diagram, screenshot, or client-supplied photograph into the artifact store. The only image inputs are model generation, https URL import, and provider search.

Reproduce: `import_image_from_url` with a `data:image/png;base64,…` URL → `url must use https`.

Note the inconsistency that proves this is an oversight, not a policy: PDF render jobs **already accept** caller bytes via `assets.images[].dataUri`. Images are the only artifact kind with no bytes path.

Fix: add bytes ingress. Preferred shape is a new `import_image_from_bytes` (`{projectId, requestId, dataUri | base64+contentType, filename, label, tags, slot?, license?}`) returning the same `{artifactReference, candidateId, public_path}` envelope as the other import. Reuse the existing import pipeline for format normalisation, dimension caps (`maxImportDimensionPx: 2048`) and byte caps (`maxImportBytes: 5000000`). Accepting `data:` inside `import_image_from_url` is acceptable as a smaller change, but the parameter name then lies.

### Defect 2 — search reports `complete` when it is structurally unable to search (P0)
`search_images` returned `status: "complete"`, `newCandidates: 0`, with diagnostics `provider pexels skipped: missing credentials (PEXELS_API_KEY)` and the same for unsplash and google-cse. A caller cannot distinguish "no images match" from "three of five providers are switched off".

Fix: add a terminal status `degraded` (or a top-level `providersUnavailable: string[]` plus `searchable: boolean`) when any policy-enabled provider was skipped for a non-query reason. `complete` must mean the configured search actually ran.

Also worth surfacing: Openverse relevance is literal keyword matching. Query `"skin"` returned **"Crispy Potato Skins with Sour Cream and Sweet Chilli Sauce"** at score 0.628, above the 0.35 `minScore` floor, auto-`kept`. A descriptive query (`"collagen powder supplement scoop in a glass jar on a plain kitchen counter"`) returned zero. If Openverse is to remain the only free provider, the search job should reduce a descriptive query to keywords before querying it, and say in diagnostics that it did.

### Defect 3 — candidates are imported before review (P1)
Search writes artifact bytes for every candidate with `state: "kept"` before the caller has seen them. A bad search silently consumes tenant storage; clearing it took three `update_image_search_candidate` calls with `delete_artifact: true`.

Fix: add `stage_only: true` to `search_images` (bank metadata + thumbnail only, import bytes on first `selected`/`kept` transition), or expire non-selected candidates on a TTL. Default behaviour may stay as-is; the option must exist.

### Acceptance
- `import_image_from_bytes` round-trips a 1024×683 WebP and the returned `public_path` resolves after a tenant release.
- A search on a site with a disabled provider returns `degraded` and names the provider.
- With `stage_only: true`, `list_artifacts_for_request` shows no new blobs until a candidate is selected.
- Pure modules + `node:test`, no new deps.

---

## S2 — pdf-tool: contract-gate hardening

**Repo** `vreich-ui/pdf-tool` · **Model** Sonnet · **Effort** high · **Branch** `contract-gate-overflow`

Context: the Sep 3 2026 ruling stands — the PDF quality gate **warns, never blocks**. Nothing here changes that. These are about the *validation* verdict and the *derived contract*, which are upstream of the gate.

### Defect 1 — `validate_pdf_template` returns `passed` while diagnostics show clipped content (P1)
Observed on a real template: `status: "passed"` alongside
`overflows: [{selector: "div.page", scrollHeightPx: 1329, clientHeightPx: 1123}]`
and `engineWarnings: ["image did not finish decoding before capture and may be incomplete in the output"]`.

`.page` has `overflow: hidden`, so that overflow is content silently cut off the trim. A template author who trusts `passed` ships a truncated lead magnet.

Fix: introduce `passed_with_warnings` as a terminal status. A `.page`-level (or `@page`-box-level) overflow and an image-decode warning both downgrade to it. `publish_pdf_template` continues to accept it — this is information, not a block, consistent with the standing warn-only rule. Ignore the `html` selector row: it is a viewport artefact and always present.

### Defect 2 — derived `renderDataSchema` carries no length budgets (P1)
A derived contract types every slot as bare `{"type": "string"}`. Overflow is therefore undiscoverable until render. Real consequence: the 4-page generic guide rendered **5 pages** from realistic copy, with `qualityGate.passed: true`.

Fix: during validation, measure each slot's rendered box and emit a `maxLength` (and, where a slot is single-line, `maxLength` plus a `x-slotLines` hint) into the derived schema. A hand-authored schema always wins. Confirm the derived-vs-authored precedence is preserved — the test run's hand-authored schema with `maxLength` on all 35 slots survived create → validate → publish intact, so the authored path is already correct.

### Defect 3 — imageRef slot description contradicts the render contract (P2)
The derived schema says *"Supply the assetId of an entry in the render job's `assets.images`"*. The render only resolves the **virtual URL** `https://render.assets.invalid/<assetId>`, which is what `create_agent_artifact_job.data` documents. Passing a bare assetId fails the asset precheck with `ASSET_MISSING` naming the *slot*, which sends the author looking in the wrong place.

Fix: one-line description change to state the virtual URL form, matching the tool description.

### Acceptance
- Re-validating template `00f541d9-944b-4509-b307-34dc29f820dc` v1 (deliberately overflowing) returns `passed_with_warnings`, v2 returns `passed`.
- A derived schema for a text template emits non-null `maxLength` on every string slot.
- Pure modules + `node:test`, no new deps.

---

## S3 — platform: repair `render_article_pdf` (run first)

**Repo** `vreich-ui/platform` · **Model** Opus · **Effort** high · **Branch** `article-pdf-repair`

### The defect (P0)
`render_article_pdf` fails 100% of the time on `site_drlurie`. It is the documented one-call path for "make a PDF of this article" and it produces nothing.

Reproduce, on a published article that has a hero image:
```
render_article_pdf { site_id: "site_drlurie",
                     content_item_id: "req_plugin_collagen_supplements_20260907_01" }
→ status: "failed"
  error.code: "ASSET_MISSING"
  error.message: "Template references 1 image asset that cannot be resolved: coverImage"
```
The article carries `body.image.src = /img/req_plugin_collagen_supplements_20260907_01/ed07e0ce….webp`. The mapper never maps it.

Two templates, two different schema sources, identical failure — so this is the mapper, not one bad template:
- `bef0d7b0-a042-4221-aa03-7870f1deb879` → `schemaSource: "template"`
- `674a43bd-40c0-40ed-847a-67a9e0b4ec2c` → `schemaSource: "article_brochure_v1"`

### The deeper problem the `unfilled[]` list exposes
```
unfilled: ["dropped_link:n_known", "dropped_link:n_origin", "skipped_node:action:n_ask",
           "dropped_link:n_sources", "missing:pullQuotes", "missing:brand",
           "unsupported_slot:sections", "unsupported_slot:pullQuotes",
           "unsupported_slot:sources", "unsupported_slot:author", "unsupported_slot:date"]
```
Neither template's slot contract matches what the mapper emits. Even with `coverImage` resolved, the output would be a thin PDF with every hyperlink dropped and the Sources block missing — on an evidence-led publication, silently dropping citations from the PDF is the worst failure mode in this whole report.

Per the Jul/Sep 2026 plan rulings, the mapper lives at `packages/core/lib/pdf/render-data-mapper.ts` and a generic article template was supposed to be seeded as drlurie's `defaultTemplateId`, with the two hardcoded brochures moved under `byKind.sales_brochure`. That seeding either did not land or is pointed at the wrong template — verify first, and say which.

### Scope
1. Map the article hero (`body.image.src`) into `coverImage`, supplied to the render job as an `assets.images` entry keyed on the artifact's blobKey. Where an article has no hero, the article template must tolerate the slot being absent — do not fabricate an image.
2. Seed (or repoint) a **generic article template** whose slot contract matches the mapper's actual output: `sections`, `sources`, `author`, `date`, `brand`, `pullQuotes`, optional `coverImage`. Set it as `site.pdf.byKind.article` for drlurie; leave `bef0d7b0` available as a lead-magnet template (it works correctly when driven with explicit `data` + `assets` — two PDFs shipped from it in the test run).
3. **Stop dropping hyperlinks.** `dropped_link:*` on a Sources node is a correctness bug for this publication. Render links as visible URL text at minimum.
4. Add an `assets` parameter to `render_article_pdf` as an operator escape hatch, so a caller can supply an image the mapper cannot derive.
5. Fail fast: if the resolved template requires an image slot the mapper cannot fill, refuse at call time with a named reason rather than burning a render.
6. Add a `version` parameter to template resolution on both `render_article_pdf` and `create_agent_artifact_job`, so a template version can be pinned. Its absence is why the text-only v1 of `bef0d7b0` is unreachable today.

### Acceptance
Run end-to-end from Claude, the same shape as the W6 acceptance run — render → attach → publish → `release_to_production` → `deploy_status` → `verify_article_images` with `expectedDocuments`, recorded as `docs/plugin/article-pdf-acceptance-<date>.md`. The attached PDF must contain the article's Sources section with its four URLs visible.

---

## S4 — platform: MCP bridge schema truth

**Repo** `vreich-ui/platform` · **Model** Sonnet · **Effort** medium · **Branch** `bridge-schema-truth` · **After S3 merges**

Four defects in what the bridge tells its callers. All mechanical; none needs deep reasoning, but every one of them cost real calls during the test run.

| # | Defect | Detail |
|---|---|---|
| 1 | **`operation: "edit"` is unreachable** (P0) | Server rejects with `sourceArtifact.artifactReference: edit jobs require…; sourceArtifact.expectedSha256: …; editMode: edit jobs require editMode`. None of those three is in the `create_agent_artifact_job` MCP schema, which is `additionalProperties: false` — so they cannot be sent. Either add them to the schema or remove `"edit"` from the `operation` enum. Do not leave a dead enum value advertised. |
| 2 | **`import_image_from_url` returns no `public_path`** (P1) | Every other artifact call returns it. Callers must hand-build `/img/{requestId}/{sha256}.{ext}` — the exact string the `render_image_ref` constraint rejects them for getting wrong. Return it. |
| 3 | **Three tools declare no required params but reject the call without `site_id`** (P2) | `list_pdf_templates`, `get_image_model_policy`, `get_image_search_policy`. Add `site_id` to `required`. |
| 4 | **Returned `polling` blocks name arguments that do not exist** (P2) | `search_images` returns `polling.input: {projectId, jobId}`; the tool takes `{site_id, job_id}`. `validate_pdf_template` returns `polling.args: {projectId, templateId, version}`; the tool takes `{site_id, template_id, version}`. This is pdf-tool's internal shape leaking through the bridge unrewritten — rewrite it at the bridge boundary. |

Also fold in the known skill-level bug while you are here: `get_pdf_template_validation` rejects a `validation_id` argument with `Invalid input`; polling works only on `template_id` + `version`. Either accept `validation_id` or drop it from the schema.

### Acceptance
A schema-conformance test that, for every bridge tool, asserts the returned `polling` block's argument names exist in that tool's own input schema. That test is what stops this class of drift returning.

---

## S5 — platform: validation and contract truth

**Repo** `vreich-ui/platform` · **Model** Sonnet · **Effort** medium · **Branch** `validation-contract-truth`

### Defect 1 — internal link targets are never validated (P1)
An article was published with `ctaLink: "/hard-water-and-your-skin"` pointing at an article that did not exist yet. `object_patch` returned `validation_summary: {level: "ready", eligible: true, blockers: []}`. It resolved only because the target happened to be published in the same batch.

Fix: at patch/publish time, resolve internal `ctaLink` and rich-text `hyperlink` hrefs that are site-relative against known article slugs, page routes and `/img|/pdf` artifact paths. **Warn, never block** — consistent with the standing warn-only stance on sources and the PDF gate. Cross-links between two articles in the same unreleased batch must not warn, so resolve against the object store, not the live site.

### Defect 2 — `object_contract` describes a workflow that is not the one in force (P2)
`object_contract("content_item").workflow.sequence` states, in capitals, that a new article must be produced by the publishing workflow and that *"A direct object_create of a content_item is REFUSED in admin chat"*. On the `plugin:claude` surface it succeeded — five times. `creation_policy.agents` reads `"open"` in the same response.

The contract is the machine-readable source of truth an agent reads before writing. It currently contradicts both `creation_policy` in its own payload and the live permission model. Make the sequence text surface-aware, or scope the refusal statement to the surfaces where it is true.

### Defect 3 — `object_create` echoes the entire record (P2)
No `projection` parameter, unlike `object_get`. A five-node article create returns roughly 6k tokens of body the caller just sent. On a batch of five articles that is pure waste. Add `projection: "summary" | "full"`, defaulting to `full` for compatibility.

### Acceptance
- Publishing an article whose `ctaLink` targets an unknown slug produces a warning, not a blocker, and the message names the unresolved path.
- Two articles cross-linking within one unreleased batch produce no warning.
- `object_contract("content_item")` read from `plugin:claude` no longer asserts a refusal that surface does not enforce.

---

## Not in scope for a code session

**Plugin skill `dr-lurie-publisher` refresh** — text only, handle it in the plugin, not a repo:
- `prompt_version` in the skill says `dr-lurie-claude-20260903-f3506d7e`; live `manifest_version` is `dr-lurie-claude-20260906-7d8f89be`.
- §4 step 5 still calls `bef0d7b0` *"the reusable one — all text, no image slots"*. That has been false since v2; it now requires `coverImage`, `figure1Image`, `figure2Image`.
- Add: image search is credential-limited on this site — do not plan an article's hero around `search_images` until S0 and S1 land.

---

## Status at end of day, 2026-09-07

Recorded after all five sessions finished, so the briefs above are read with their outcome attached.

| Session | Ran | Outcome |
|---|---|---|
| S3 · render_article_pdf | 10:29 → 13:50 UTC (3h21m, Opus) | Finished. **Not landed** — no `article-pdf-repair` branch, no article-PDF commit on `main`. `render_article_pdf` is still broken in production. |
| S1 · pdf-tool image ingress + search truth | 08:22 → 09:16 UTC (Opus) | Finished. Very likely landed as pdf-tool **#81**, "six defects found probing the MCP surface directly" (`b18973a`). |
| S2 · pdf-tool contract gate | 08:30 → 08:47 UTC (Sonnet) | Finished. Same PR window as S1; see the caveat below. |
| S5 · platform validation + contract truth | 08:38 → 09:02 UTC (Sonnet) | Finished. **Not landed.** |
| S4 · platform bridge schema truth | Gated twice (11:29, 14:36 UTC) | Correctly refused to start — S3 is not on `main`. Still to run. |

### Superseded by work that shipped the same day

**P0-4 (no ingress for agent-produced image bytes) should not be fixed as proposed.** The brief asked for an `import_image_from_bytes` upload path. pdf-tool **#82** (`d2a2d08`) instead shipped a deterministic annotation layer — `annotate_image`, `analyze_image_layout`, `preview_image_grid`, `check_image_text` — which lets an agent compose text, arrows and badges onto a generated base *server-side* rather than uploading pixels it drew itself. Platform **#705** (`ac02e6a`) bridges all four so no tenant storage grant is needed. That is the better answer to the same problem: during the test, a locally-composed diagram could only reach production smuggled inside a PDF.

Two consequences carried forward rather than closed:
- `annotate_image` and `check_image_text` fail closed with `RENDER_SERVICE_UNAVAILABLE` / `OCR_UNAVAILABLE` until the manual **Deploy render-service** workflow runs.
- A connector added against the older tool surface will not see the four bridged tools. `whoami` reports `tools_digest_matches: false` in that state — re-add the connector.

### Caveat on S2, Defect 3

The brief told S2 to rewrite the derived imageRef slot description toward the `https://render.assets.invalid/<assetId>` virtual-URL form. A ruling made later the same day went the other way: **bare `assetId` is the canonical image-slot form and pdf-tool normalizes it**, with the platform mapper unchanged. If S2's change rode into #81, that description now contradicts the ruling and should be reverted to the bare-assetId wording.

### Still open

- Image-search provider credentials (`PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY`, `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX`) on `pdf-x.netlify.app`. Re-probed at 15:12 UTC: same three providers skipped, and Openverse now also times out at 20s.
- None of the five published test articles carries a `tracking` block, so lead-magnet downloads and next-article clicks are unattributable.
