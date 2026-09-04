# 2026-09-03 — PDF pipeline fortification (W2): the rulings that bind every task

**Status: RATIFIED** (Wolf, 2026-09-03). Recorded by T2.8, the wave's closing
cross-cutting task — no prior W2 task (T2.1–T2.7) touched `docs/`. Where a
task's own code comments cite "D-A"/"D-B"/"D-C"/"D-D" or "BRIEF-W2.md", this
is the doc that ruling now lives in.

## The four rulings

| # | Ruling | What it means | Where it's enforced |
|---|---|---|---|
| D-A | **Content quality WARNS, it never blocks.** | A PDF render that completes with quality-gate findings (`BLANK_PAGE`, `UNRESOLVED_IMAGE`, `UNRENDERED_TOKEN`) is a completed render — it attaches, and the findings ride the receipt. Only a typed pdf-tool failure (`RENDER_DATA_INVALID`, `ASSET_MISSING`, `DATA_BINDING_ERROR`, …) is a real failure. | `shouldAttachArticlePdf` / `buildRenderArticlePdfReceipt`, `packages/core/lib/pdf/article-pdf-render.ts`; `document-content-check.ts` |
| D-B | **`site.pdf.defaultTemplateId` is a seeded generic article template; the two hardcoded drlurie brochures move under `byKind.sales_brochure`.** | Every *new* tenant gets `article_brochure_v1` + `site.pdf` defaults automatically from the genesis hook — "genesis is never a manual step" holds for them. drlurie predates this wave, so its one-time retrofit is a standalone idempotent script, run once by hand; it is deliberately NOT part of the generic genesis path. Either way, the two pre-existing one-off brochure templates (`eca2337c-…`, the 6-page niacinamide brochure; `674a43bd-…`, the 5-page routine brochure) are reachable only via `byKind.sales_brochure` (the routine one is the one pinned as the kind default — the more general "sell our approach" piece) or an explicit `template_id`, never as `site.pdf.defaultTemplateId`. | `scripts/site-genesis-drive.mjs` (new tenants); `scripts/seed-drlurie-pdf-defaults.mjs` (drlurie's one-time retrofit); `packages/core/schema/bodies/site-v1.ts:165-183` (`pdf.defaultTemplateId` / `pdf.byKind`) |
| D-C | **The article → render-data mapper lives in `platform`**, at `packages/core/lib/pdf/render-data-mapper.ts`. | cms-agent has its own mapper in its workflow plane; this platform's plugin path cannot reach it, so this wave built a second, platform-owned one rather than reaching into cms-agent. cms-agent may adopt this one later — that is a future task, not this wave's. | `packages/core/lib/pdf/render-data-mapper.ts` (T2.1) |
| D-D | **A publish/release with a failing attached PDF WARNS, it never blocks.** | `object_validate` (and the standalone `validate_content_item`) emits a `pdf_quality` warning on the content_item when a prior content-quality check result is available for its attached PDF; absent one, it reports nothing rather than fabricating a pass. It never appears in `summary.blockers`. Shown in the admin PDF card and in the publish receipt. **The verdict is persisted, not live-fetched:** `render_article_pdf` files its quality-gate findings at attach time and `verify_pdf_content` files its inspection, each keyed by the PDF's own `/pdf/<requestId>/<sha256>.pdf` artifact, and the validation context preloads them in the artifact-index sweep it already runs — so a re-render never inherits the previous PDF's judgement, and validation never makes a network call. A clean quality gate deliberately files NOTHING: one pass over a render is not proof of a clean document, and `verify_pdf_content` is what proves that. | `object-validate.ts` (T2.5); `pdf-content-check-store.ts` + `object-validation-context.ts` (W2 review); `packages/core/lib/admin/article-pdf-card.ts` (T2.6) |

## The four bridge defaults these rulings imply (§3 of the wave plan)

Pure decision helpers, `packages/core/lib/pdf/pdf-bridge-defaults.ts` (T2.2),
run inside `callCreateAgentArtifactJob` (`mcp-tool-handlers.ts`) — and, by
extension, inside `render_article_pdf`'s one-call job creation:

| # | Default | Rule |
|---|---|---|
| D-1 | `template_id` | `site.pdf.byKind[kind] ?? site.pdf.defaultTemplateId` when the caller omits `template_id`. `kind` defaults to `'article'` (a `content_item` has no `kind` field today — every one is an article). |
| D-2 | `data` | `content_item_id` given and `data` omitted → run the D-C mapper instead of requiring a hand-authored `data` payload. |
| D-3 | `brand` injection | The slot written is ALWAYS `brand` — the one the template declares. Its TYPE follows the template's own `renderDataSchema.properties.brand`: the `{colors, fonts, logo?}` object for an object slot, the site's display name as a plain string for a string slot, nothing at all when the template declares neither. Never overwrites a caller-supplied key. This is the fix for the 2026-09-03 `[object Object]` defect — the bridge used to inject an object into a template that slotted `{{brand}}` as a string. **AMENDED 2026-09-04 (W2 review):** as originally written this ruling said a string slot gets a `brandName` key. It does not: these schemas are `additionalProperties: false`, so an undeclared `brandName` fails W1's `RENDER_DATA_INVALID` at job creation, and `{{ brand }}` stays unbound and fails strict binding with `DATA_BINDING_ERROR` — a hard double failure where the original defect merely rendered badly. The corrected rule is above. |
| D-4 | `filename` / `requirements` | `filename` ← the article's slug + `.pdf` when omitted. For `kind:"article"`, `requirements` ← `{format:"A4", orientation:"portrait", pageCount:{min:2}, maxBytes:8_000_000}` when the caller supplied no `requirements` at all — a caller who supplies even a partial object always wins, untouched. |

## Standing invariants

- **Genesis is never a manual step.** D-B's seeded default is a genesis/`site_duplicate` responsibility, not a human click, per the standing rule (`CLAUDE.md` W16 section).
- **A caller's explicit value always wins.** Every one of D-1/D-3/D-4 only fills an *absent* value; none ever overrides something the caller supplied — the same "derived layer reads, never re-decides" discipline as `2026-08-25-one-approval-truth.md`.
- **No new pdf-tool-side behavior.** pdf-tool (W1) is merged and out of scope for this wave; every ruling above is platform-side wiring onto W1's existing contract (`RENDER_DATA_INVALID`, `ASSET_MISSING`, `DATA_BINDING_ERROR`, the warn-only quality gate).

See [`../../agents/publishing-policy.md`](../../agents/publishing-policy.md) §6.4 and
[`../../agents/pdf-tool-artifacts.md`](../../agents/pdf-tool-artifacts.md) for the
end-to-end agent-facing path these rulings produce.
