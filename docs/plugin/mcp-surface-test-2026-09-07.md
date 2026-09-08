# Dr-Lurie-Blog — MCP publishing system test

**Site:** `site_drlurie` / drluriescience.netlify.app · **Surface:** `plugin:claude` · **Date:** 2026-09-07
**Scope:** 5 full articles written and published TOP-of-funnel, with generated / gathered / composited media, one release, full live verification.
**Release commit:** `3aa554a58416baa5d9254f3f772b6dcd7f34ab59` — deployed, `productionConfirmed: true`.

---

> ## ⚠️ Corrections — filed the same evening, 2026-09-07
>
> This report was written from a live drive of the surface and its *observations*
> stand. Several of its **conclusions do not.** Three of the four P0s below are
> wrong in ways that matter, and one of them sent a repair session to the wrong
> repository for three and a half hours. Read the corrections before acting on
> anything here.
>
> | Claim in this report | What is actually true |
> |---|---|
> | **P0-1** `render_article_pdf` fails because the platform mapper never populates `coverImage` | **Wrong repo.** `packages/core/lib/pdf/render-data-mapper.ts` was last changed by PR #682 on 4 September and was never at fault. The failure was pdf-tool rejecting an **optional** slot as required; closed by pdf-tool **#83** (`1c0cdc2`, 2026-09-07 15:27 UTC), *"strict binding must catch missing REQUIRED data, not optional fields"*. Verified working at 15:20 UTC the same day. |
> | **P0-1** (cont.) the mapper "drops every hyperlink", so citations are silently lost from article PDFs | **Not a defect.** `dropped_link` means the hyperlink is flattened to its **visible text** — `flattenInline` recurses into the link and keeps its content; only the `href` is lost, because the target template has no link slot. Dr. Lurié's Sources blocks use the URL *as* the link text, so every citation URL reaches the PDF as readable text. Likewise `skipped_media:document` (a document is a download block, never a figure) and `skipped_node:action` (a CTA means nothing on paper) are deliberate and documented in the source. `unfilled[]` is the mapper honestly reporting a lossy mapping, not a bug list. |
> | **P0-4** no upload path exists for agent-produced image bytes | **Wrong.** `create_artifact_upload_intent` (+ `POST /api/artifacts/upload`), `create_artifact_from_url` and `save_artifact` all exist in this repo. They are simply absent from the `plugin:claude` charter, so a plugin-surface agent cannot reach them. That is a charter line, not a missing capability. Separately, pdf-tool **#82** shipped a deterministic annotation layer (`annotate_image`, `analyze_image_layout`, `preview_image_grid`, `check_image_text`) bridged through platform **#705** — composing labels server-side onto a generated base is the better answer to the same problem. |
> | **P0-2** framed as an ops task: "set the four image-search provider credentials" | **Out of scope, withdrawn.** This publication's pictures come from brandImagery generation plus the annotation layer; stock-photo search is not part of the pipeline. The credentials are only worth setting if stock sourcing is wanted, and nothing indicates it is. The genuine defect is narrower and stands: `search_images` returns `complete` when it is structurally unable to search. |
>
> **P0-3** (`operation: "edit"` unreachable) is the one P0 that survives intact.
>
> Everything under **P1** and **P2** below was verified against `main` and stands,
> except that `site_id` is now in the `required` array for the three policy tools
> and `get_pdf_template_validation` now accepts `validation_id` — both fixed
> before this correction was written.


---

## 1. What shipped

| # | Article | Framework | Media | Ask (one per piece) |
|---|---|---|---|---|
| 1 | [Skin Purging or a Breakout?](https://drluriescience.netlify.app/skin-purging-or-breakout) | fw_concern | generated hero + 5-page PDF (3 generated figures bound as assets) | Free PDF |
| 2 | [Fragrance-Free vs Unscented](https://drluriescience.netlify.app/fragrance-free-versus-unscented) | fw_ingredient | generated hero + in-body generated image w/ caption | Next article |
| 3 | [Collagen Supplements](https://drluriescience.netlify.app/collagen-supplements-what-the-trials-measured) | fw_myth | generated hero (after image-search failed) | Ask your dermatologist |
| 4 | [Slugging](https://drluriescience.netlify.app/slugging-overnight-occlusive-routine) | fw_routine | generated hero + **2-page PDF from a new template that crops/tones the hero in CSS and draws the diagram server-side** | Free PDF |
| 5 | [Hard Water and Your Skin](https://drluriescience.netlify.app/hard-water-and-your-skin) | fw_concern | generated hero + in-body generated image w/ caption | Next article |

**Verified live:** 8/8 images and 2/2 PDFs matched `exact`, `deployReady: true`, PDFs inspected clean (no blank pages, no unresolved images, no leaked tokens).

**New asset left on the site:** PDF template `00f541d9-944b-4509-b307-34dc29f820dc` v2 — *"Two-Page Routine Card"*, chromium, validated + published, reusable, with a hand-authored `renderDataSchema` carrying `maxLength` on every slot.

**Cost:** 9 image generations ≈ **$0.085**. PDF renders $0. One Netlify build.

---

## 2. Findings — severity ranked

### P0 — broken

| # | Finding | Evidence |
|---|---|---|
| 1 | ⚠️ **CORRECTED — see the banner above; the cause was in pdf-tool, not this repo.** **`render_article_pdf` fails 100% of the time.** The article→render-data mapper never populates `coverImage`, even though the article carries `body.image.src`. Fails identically on two templates with two different schema sources. The tool exposes no `assets` parameter, so there is no workaround. "Make a PDF of this article" is currently impossible. | `ASSET_MISSING: Template references 1 image asset that cannot be resolved: coverImage` on `bef0d7b0` (schemaSource `template`) **and** `674a43bd` (schemaSource `article_brochure_v1`) |
| 2 | ⚠️ **PARTLY WITHDRAWN — the credentials framing was out of scope; the silent-success defect stands.** **Image search is effectively dead and fails silently.** 3 of 5 providers have no credentials. Openverse returns 0 for descriptive queries and matches single keywords literally. Job status is `complete`, never `degraded`/`failed`. | Query *"collagen powder supplement scoop in a glass jar…"* → **0 candidates**. Query *"skin"* → 3 candidates, top-3 included **"Crispy Potato Skins with Sour Cream"** scored 0.628 and auto-`kept`. Diagnostics: `pexels/unsplash/google-cse skipped: missing credentials` |
| 3 | **`operation: "edit"` is structurally unreachable.** Server requires `sourceArtifact.artifactReference`, `sourceArtifact.expectedSha256`, `editMode`. None is in the MCP schema, which is `additionalProperties: false`. The enum advertises a capability that cannot be invoked. | Two attempts, identical validation error |
| 4 | ⚠️ **WRONG — see the banner above; upload tools exist, they are off-charter.** **No upload path for agent-produced image bytes.** Images can only enter via model generation, https URL import, or search. A chart, diagram, screenshot or client-supplied photo cannot become an image artifact. | `import_image_from_url` with a `data:` URI → `url must use https` |

> **Workaround found for #4:** PDF template `assets.images` *does* accept `{assetId, dataUri}`. Locally-produced bytes can reach production **inside a PDF only**, never as an article image.

### P1 — silent failure / correctness

| # | Finding | Evidence |
|---|---|---|
| 5 | **Template versioning silently broke the documented lead-magnet path.** `bef0d7b0` v1 was the 30-slot text-only guide; v2 added 3 *required* image slots. `create_agent_artifact_job` has no `version` parameter, so v1 is unreachable. This is almost certainly the root cause of #1. | v1 `label: "Generic Evidence Guide (4-page, text-only)"`, v2 requires `coverImage`/`figure1Image`/`figure2Image`; `latestActiveVersion: 2` |
| 6 | **`validate_pdf_template` reports `passed` while diagnostics show clipped content.** Page overflow and image-decode warnings do not affect the verdict. | v1 of my template: `status: "passed"` with `div.page` scrollHeight 1329 vs clientHeight 1123, plus `engineWarnings: ["image did not finish decoding before capture"]` |
| 7 | **Derived `renderDataSchema` has no length budgets,** so overflow is only discoverable by rendering. | The 4-page generic template rendered **5 pages** from realistic copy — silent overflow, `qualityGate.passed: true` |
| 8 | **Internal link targets are not validated.** I published a `ctaLink` to `/hard-water-and-your-skin` before that article existed and validation reported ready with zero blockers. | `validation_summary: {level: "ready", blockers: []}` |
| 9 | **`import_image_from_url` returns no `public_path`,** unlike every other artifact call — the caller must hand-build `/img/{requestId}/{sha256}.{ext}`, the exact string the `render_image_ref` constraint blocks you for getting wrong. | Response carries only `artifactReference` + `candidateId` |
| 10 | **Search imports bytes before you review them.** Candidates land as `state: "kept"` with artifacts written; a bad search consumes tenant storage until manually discarded. | 3 unusable images stored; cleared with `discarded` + `delete_artifact: true` |

### P2 — docs / schema mismatches

| # | Finding |
|---|---|
| 11 | `list_pdf_templates`, `get_image_model_policy`, `get_image_search_policy` declare **no required params** but the server rejects the call without `site_id`. |
| 12 | Returned `polling` blocks name the wrong arguments: `search_images` → `{projectId, jobId}`, `validate_pdf_template` → `{projectId, templateId, version}`; the actual tools take `site_id` / `job_id` / `template_id`. |
| 13 | `object_contract(content_item).workflow.sequence` states a direct `object_create` of a content_item **is refused** and articles must go through the CMS-Agent workflow. It succeeded here on `plugin:claude`. The contract, the plugin skill and the live permission model disagree. |
| 14 | Two docs contradict on image binding: the tool description says the slot value must be `https://render.assets.invalid/<assetId>`; the derived schema description says "supply the assetId". Only the former renders. |
| 15 | Skill `prompt_version` `dr-lurie-claude-20260903-f3506d7e` ≠ live `manifest_version` `dr-lurie-claude-20260906-7d8f89be`. |
| 16 | The plugin skill still describes `bef0d7b0` as *"text-only, no image slots"* — wrong since v2, and it is the template the skill tells you to reach for first. |
| 17 | `object_create` echoes the entire record back (~6k tokens for a 5-node article). No `projection` parameter. |

### What worked well — worth protecting

- **Idempotency is genuinely correct.** Two 502s (an image job and `release_to_production`). The image-job retry returned `replayed_from_idempotency_key: true` with the original receipt; the release had already fired and `deploy_status` showed it `building`. The skill's "don't retry a 502'd release, poll instead" rule is right and saved a duplicate build.
- **`verify_article_images`** deploy-correlation is excellent — no false negatives, exact URL matches, and it inspects PDF *content*, not just presence.
- **`rich_text.v1` renders faithfully** — bullets, bold lead-ins, live links, in-body image captions all confirmed on the live page.
- **Annotation privacy holds.** No strategy vocabulary (`hook`, `agitation`, `convert`) reached reader-visible HTML.
- **Lock/version discipline:** ~25 writes, zero 409s and zero 423s.
- **Template authoring path** (create → validate → poll → publish) worked first time, and diagnostics were detailed enough to fix the overflow in one iteration.

---

## 3. Improvements, in the order I'd do them

**Ship first (unblocks whole capabilities)**
1. Map `body.image.src` → `coverImage` in the article render-data mapper, **and** add an `assets` parameter to `render_article_pdf` as an escape hatch. Until fixed, make it fail at call time with a named reason instead of burning a render.
2. Add `PEXELS_API_KEY` / `UNSPLASH_ACCESS_KEY` / `GOOGLE_CSE_*`, or return `status: "degraded"` when providers are skipped so callers stop treating `complete` + 0 candidates as "nothing matched".
3. Add `sourceArtifact` + `editMode` to the `create_agent_artifact_job` schema — or drop `"edit"` from the enum so it stops advertising a dead path.
4. Add an image-bytes ingress: accept `data:` in `import_image_from_url` under a byte cap, or add `import_image_from_bytes`. **This is the biggest single limitation** — no agent can publish a chart, a diagram, or a client's own photograph today.

**Then (removes silent failure)**
5. Add `version` to template resolution on `create_agent_artifact_job` and `render_article_pdf`.
6. Make a `.page` overflow in `validate_pdf_template` diagnostics downgrade the verdict (`passed_with_warnings`), and surface it in `qualityGate`.
7. Emit `maxLength` per slot in derived `renderDataSchema`, measured from a probe render.
8. Warn (not block) on `ctaLink` / internal hrefs that match no known slug.
9. Return `public_path` from `import_image_from_url`.
10. Add `stage_only` to `search_images`, or auto-expire non-selected candidates, so a failed search costs no storage.

**Housekeeping**
11. Fix the four `site_id`-required schemas and the two wrong `polling` arg blocks.
12. Reconcile `object_contract.workflow.sequence` with what `plugin:claude` is actually permitted to do.
13. Align the imageRef slot description with the virtual-URL requirement.
14. Refresh the plugin skill: `bef0d7b0` description, `prompt_version`, and a note that image search is credential-limited on this site.
15. Add `projection` to `object_create`'s response.

---

## 4. Magnetic-marketing note — one real gap in this run

The site's aggression ceiling (`urgency: 0.10`, and 0.00 at TOP stage) deliberately forbids **Kennedy Rule 2 (a reason to respond right now)**. That is correct for a consumer-health publication and the constraint should keep winning. The funnel therefore rests on Rule 1 (always an offer), Rule 3 (one unambiguous path) and low-threshold lead magnets — which is what all five pieces do: exactly one ask each, three different ask types, no competing links.

**But Rule 4 — tracking and measurement — is not satisfied.** None of the five articles has a `tracking` block set, so PDF downloads and next-article clicks are unattributable. The `set_tracking` op exists and supports `cta_click` / `outbound_click` goals with provider conversion labels.

**Recommended next action:** batch a `set_tracking` patch across all five articles (goals: `guide_download` on `cta_click` for #1 and #4, `next_read` on `cta_click` for #2 and #5), republish, and release once — roughly 12 calls and one build. Without it the funnel is unmeasurable, which by Rule 9 means it cannot be improved.
