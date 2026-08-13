# Capture runbook — seed a target, run the five stages, read the reports

**Status: current as of 2026-08-13 (T12.7).** Governing ruling:
[`decisions/2026-08-13-capture-productization-rulings.md`](decisions/2026-08-13-capture-productization-rulings.md)
(**R-C2 v2**). This is the operator's page: how to authorize a capture, how to
run it, and how to read what comes out. It assumes no knowledge of the
validator's internals — if you find yourself reverse-engineering one, that is a
defect in this file.

## 0. The one rulebook

There is exactly **one** capture policy shape in the system: CMS-Agent's
`ProjectCapturePolicy` (`src/agent/projects/projectTypes.ts`, validated by
`capturePolicySchema` in `projectAdmin.ts`). The engine in this repo is a
**consumer** of that shape, not the author of a second dialect. The same JSON
is read at every entry point:

| Entry point | Where | What it reads |
| --- | --- | --- |
| `validateCapturePolicy` | `packages/core/cli/capture/snapshot-v1.mjs` | the whole policy, as the crawl gate (CLI `--policy <file>`) |
| `parseCapturePolicy` | same file | the whole policy, shape only (deny-all is well-formed) |
| `readProjectCapturePolicy` | same file | resolves the policy out of a `project.get` response envelope |
| `capturePolicyFromProject` | `emit.mjs` | `rights.content` / `rights.media` / `delayMs` |
| `fidelityLimitsFromProject` | `score.mjs` | `fidelity.coverageRubricOverride` |

**Deny-all is the default.** A project with no explicit policy resolves to
`maxPages: 0`, empty origins, `rights` both `prohibited`. Nothing captures
until a project says otherwise, and a capture workflow can never widen a legacy
project's authority by omission.

The CMS-Agent `ProjectSummary` carries the policy as **`capturePolicy`**; the
snake_case `capture_policy` envelope spelling is also accepted, because reading
it costs nothing. There is no third spelling — an unrecognized shape stops the
run instead of degrading.

## 1. The policy, field by field

Copy [`packages/core/cli/capture/fixtures/capture-policy.template.json`](../../packages/core/cli/capture/fixtures/capture-policy.template.json)
and edit it. JSON has no comments, so the explanations live here. A test keeps
the template valid: it must pass `validateCapturePolicy` unchanged.

| Field | Type / allowed values | What it means |
| --- | --- | --- |
| `maxPages` | integer ≥ 0 | Per-project ceiling on captured pages for this target; `0` means deny-all and refuses to crawl. Not a system-wide cap. |
| `allowedCrawlOrigins` | array (≤ 32) of HTTPS origins, no path/query/fragment | The only origins any page may be fetched from; everything else is out of bounds. |
| `allowedPathPrefixes` | array (≤ 128) of absolute paths, no query/fragment | A URL must start with one of these to be crawled; `"/"` means the whole site. |
| `sameOriginOnly` | boolean | Confine the crawl to the seed URL's origin. The engine requires `true`. |
| `respectRobots` | boolean | Honor `robots.txt` (and its crawl-delay, which raises `delayMs` but never lowers it). The engine requires `true`. |
| `concurrency` | integer 1–32 | Parallel page fetches permitted. The current crawler runs strictly serial. |
| `delayMs` | integer 0–86,400,000 | Minimum politeness delay between requests; also throttles asset probes at emission. |
| `authenticatedAccess` | `"prohibited"` | Literal. Capture never signs in, never sends credentials, never touches gated content. |
| `rights.content` | `"prohibited"` \| `"retain_allowed_origin_content"` | Whether extracted copy may be carried into drafts. `prohibited` forces regeneration through an explicit `--model-adapter`. |
| `rights.media` | `"prohibited"` \| `"retain_referenced_allowed_origin_media"` | Whether referenced media may be materialized as first-party artifacts. `prohibited` skips artifact ingestion entirely. |
| `designReferences[]` | array (≤ 32) | Look-only references. Each entry is `{origin, purpose:"design_inspiration_only", crawlAllowed:false, contentReuse:"prohibited", mediaReuse:"prohibited"}` — the last four are literals, so a reference can never become a crawl target. |
| `fidelity.mode` | `"source_faithful"` \| `"design_inspired"` | Whether the duplication follows the source's own design or only its content. |
| `fidelity.sourceDesignTreatment` | `"source_content_and_design"` \| `"source_content_with_design_inspiration_only"` | The matching rights posture for the source's *design*, stated separately from its content. |
| `fidelity.coverageRubricOverride` | object, optional | Omit it and the pipeline's ratified rubric applies (90% coverage, complete tokens, enumerated gaps). Supply it and **all three** fields below are required — a partial override is a malformed contract, not a set of defaults. |
| `…minimumMappedBlockCoverage` | number 0–1 | The fraction of relevant source blocks that must map to governed sections. |
| `…requireCompleteTokens` | boolean | Whether a complete theme-token set is required to pass. |
| `…requireEnumeratedGaps` | boolean | Whether every unmapped block must carry an enumerated gap record. |

## 2. Seed a target

### 2a. Orchestrated runs — the CMS-Agent project registry

The registry is the operational source of bounds (R-C2 v2). Seeding a target is
an MCP call that exists today — `project.create` for a new client,
`project.update` for an existing one:

```jsonc
// project.update
{
  "project_id": "<target-project>",
  "patch": { "capturePolicy": { /* the JSON from §1, verbatim */ } }
}
```

Read it back with `project.get` and confirm `capturePolicy` matches what you
sent. That response — the whole `project.get` result — is what `emit.mjs` and
`score.mjs` take as `--project-policy`; save it to a file for a CLI run. It is
a *safe* summary: it contains env-var **names**, never endpoints or tokens.

### 2b. CLI runs — the same JSON in a file

For a local run, put the identical object in a file and pass it as `--policy`.
There is no separate CLI dialect. Keep the file out of the repo unless it is a
committed example; the template is the only one that belongs here.

## 3. The five stages

Run from the repo root. Each stage writes files the next one reads; nothing is
implicit. `npm run capture:spike|capture:map|capture:theme|capture:emit|capture:score`
are aliases for the same scripts.

### Stage 1 — capture (crawl + snapshot)

```bash
node packages/core/cli/capture/capture.mjs \
  --url https://www.example.com/ \
  --policy ./capture-policy.json \
  --out ./.tmp/capture-run \
  [--browser-executable "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] \
  [--redacted-fixture ./.tmp/capture-run/snapshot.redacted.json]
```

Writes `./.tmp/capture-run/snapshot.v1.json` plus per-page and per-block PNGs
under `pages/<pageId>/<viewport>/`. Uses a preinstalled Chromium — it never
downloads a browser; set `CAPTURE_BROWSER_EXECUTABLE` or pass
`--browser-executable` if discovery fails. Exits `2` if anything quarantined.
The validated policy is recorded verbatim into `capture.policy` in the
snapshot, so every downstream stage can see the bounds the run actually had.

### Stage 2 — map (blocks → governed section candidates)

```bash
node packages/core/cli/capture/map.mjs \
  --snapshot ./.tmp/capture-run/snapshot.v1.json \
  --out ./.tmp/capture-run/mapping.v1.json \
  [--assistance ./suggestions.json] [--threshold 0.6]
```

Deterministic heuristics first. `--assistance` accepts pre-computed
classifications for blocks the heuristics decline; `--threshold` is the
confidence floor for accepting a mapping.

### Stage 3 — theme (quantize tokens) — **positional arguments, not flags**

```bash
node packages/core/cli/capture/theme.mjs \
  ./.tmp/capture-run/snapshot.v1.json \
  ./.tmp/capture-run
```

Writes `theme.v1.json` and a human-readable `theme-report.html` into the output
directory. This is the one stage with positional args; it takes no flags.

### Stage 4 — emit (governed drafts)

Dry run first — it makes **no** MCP calls and accepts no endpoint:

```bash
node packages/core/cli/capture/emit.mjs \
  --target <target-project> \
  --mapping ./.tmp/capture-run/mapping.v1.json \
  --theme ./.tmp/capture-run/theme.v1.json \
  --dry-run [--repeat-threshold 2] \
  --out ./.tmp/capture-run/emission-plan.json
```

Live, once the plan reads correctly:

```bash
MCP_HTTP_AUTH_TOKEN=… node packages/core/cli/capture/emit.mjs \
  --target <target-project> \
  --project-policy ./.tmp/capture-run/project-get.json \
  --endpoint https://<target-site>/mcp \
  --mapping ./.tmp/capture-run/mapping.v1.json \
  --theme ./.tmp/capture-run/theme.v1.json \
  [--model-adapter ./adapter.mjs] \
  --out ./.tmp/capture-run/emission-report.json
```

`--project-policy` is mandatory in live mode and is read **before** any target
MCP call: the capture policy governs what emission may do, and the per-site MCP
deliberately does not expose it. Everything created is a **never-released
draft** — `object_publish`, `release_to_production`, `trigger_netlify_build`,
and `deploy` are refused at the transport. When `rights.content` is
`prohibited`, emission refuses to run without an explicit `--model-adapter`
rather than quietly carrying the source's copy across.

### Stage 4.5 — preview (render the drafts, screenshot the emission)

**T12.10.** Emitted drafts are unpublished objects, and unpublished objects do
not render — which is why the first acceptance run scored **0/34**. The preview
stage renders them anyway, without publishing anything:

```bash
node packages/core/cli/capture/preview.mjs \
  --target <target-project> \
  --plan ./.tmp/capture-run/emission-plan.json \
  --mapping ./.tmp/capture-run/mapping.v1.json \
  --theme ./.tmp/capture-run/theme.v1.json \
  --site sites/<landing-tenant> \
  --run-root ./.tmp/capture-run \
  --out ./.tmp/capture-run/capture-preview.v1.json \
  [--preview-site-dir .tmp/capture-preview-<target>] [--browser-executable <path>] [--keep]
```

How a draft renders without a publish: the tenant directory is **copied** to a
scratch directory under `.tmp/`, each emitted page body is written into the
COPY's export directory at a preview-only route (`/__draft-preview/<page object
id>` — never the emitted route, which the tenant may already own), the captured
theme is applied to the COPY's site object `brandTokens`, and the ordinary
Astro build runs against the copy. Drafts then render through the real
`PageObjectRenderer` → section-component path. Nothing is written to the store,
the working tree, git, or a deploy; `object_publish`, `release_to_production`,
`trigger_netlify_build`, and `deploy` are never called and are listed as
refused in the manifest.

Screenshots use the SAME browser plane and the SAME viewports as the capture
(`packages/core/cli/capture/browser.mjs` — mobile 390×844, desktop 1440×1000);
a preview shot at any other size makes the per-block diff meaningless. Each
emitted section is located by the identity annotation the renderer already
stamps (`data-cms-object-id` / `data-cms-section-id`), which is how a preview
screenshot is joined back to the SOURCE block the mapper mapped it from.

Output is `capture-preview.v1` — the manifest `score.mjs --preview` expects —
with preview PNGs under `<run-root>/preview/pages/…`. The CLI exits `3` if any
page or block could not be previewed; each reason is an enumerated defect
(`page_type_not_previewable`, `mapped_section_absent_from_emitted_page`,
`page_has_no_previewable_block`, `preview_block_screenshot_failed`,
`preview_page_render_failed`).

### Stage 5 — score (fidelity + gaps)

```bash
node packages/core/cli/capture/score.mjs \
  --target <target-project> \
  --snapshot ./.tmp/capture-run/snapshot.v1.json \
  --mapping ./.tmp/capture-run/mapping.v1.json \
  --theme ./.tmp/capture-run/theme.v1.json \
  [--project-policy ./.tmp/capture-run/project-get.json] \
  [--preview ./.tmp/capture-run/capture-preview.v1.json] \
  [--screenshot-root ./.tmp/capture-run] \
  --out ./.tmp/capture-run/fidelity-report.json \
  [--gap-out ./.tmp/capture-run/palette-gaps.json] \
  [--side-by-side ./.tmp/capture-run/side-by-side.html]
```

Omitting `--project-policy` applies the ratified default rubric. Omitting
`--preview` is legal and produces `unavailable` visual comparisons — it does
not fail the run, and it does not silently pass it either: every unavailable
comparison is an enumerated **defect** and the CLI exits `3` (see below).
`--side-by-side` writes the human review artifact: source block next to emitted
block, per page, per viewport, with each pair's score.

## 4. Reading the reports

`fidelity-report.json` (`capture-fidelity-report.v1`) is the verdict document.

- **`rubric.coverage`** — `mappedBlocks / relevantBlocks`. "Relevant" excludes
  blocks accounted as `duplicate`, `merged`, or `ignored_noncontent`, so the
  denominator is real content, not chrome. `met` compares it to
  `minimum` (the project override, else 0.9).
- **`rubric.tokensComplete`** — the theme carries every required color, font,
  layout, shape, and type token. A missing token is a real hole in the
  duplication, not a cosmetic detail.
- **`rubric.gapsEnumerated`** — every block statused `gap` or `mapped_with_gap`
  has a matching record in `gapReport`. This is what makes a miss auditable.
- **`rubric.verdict`** — `within_reasonable_limits` when all three are met,
  otherwise `needs_governed_iteration`. There is no partial pass.
- **`visual`** — `scoredCount` / `unavailableCount` / `aggregateScore`, plus
  (T12.10) `defects`, `defectCount`, `evidenceComplete`, and
  `pagesWithoutScoredComparison`. **Visual evidence explains, it never
  authorizes.** Zero scored comparisons does not lower the bar; a high pixel
  score does not raise a failing verdict.
- **`visual.defects`** — the 0/34 rule. An unavailable comparison is a DEFECT,
  never a neutral absence, and a page with no scored comparison at all is a
  defect in its own right; the CLI exits non-zero whenever
  `evidenceComplete` is false. Each defect names its block's mapping status, so
  "unavailable because the mapper never mapped this block (gap_…)" is
  distinguishable from "unavailable because the preview failed" — both are
  holes, neither is silent. The `rubric` object is untouched by any of it.
- **`visual.comparisons[].normalization`** — both sides are flattened onto
  white and resampled onto ONE comparison raster
  (`screenshot-normalize.mjs`) before a byte is compared. That drops
  antialiasing, font hinting, and compositing — differences a reader cannot see
  — and nothing else. It is the ceiling of allowed variance, not a place to
  hide a diff, and **no CSS or code change may be made to chase a pixel
  score**.
- **`gapReport.byCapability`** — gaps grouped by the missing capability, most
  frequent first. This is the backlog: each group is a capability to build, not
  a block to force through.

`palette-gaps.json` (`capture-palette-gaps.v1`) is the same gap set standalone,
for handing to the growth-loop backlog.

## 5. Worked example — Zilberman Foundation, 2026-08-13

The first acceptance run (T12.6), target project `platform`, source
`https://www.zilbermanfilmfoundation.com/`. Its policy is exactly the §1 shape:
20 pages, that one origin, `/`, same-origin, robots honored, concurrency 1,
1500 ms, authenticated access prohibited, content and media retention allowed,
one design-only reference (`https://prconsulting.net`, crawl and reuse
prohibited), `design_inspired` /
`source_content_with_design_inspiration_only`, **no** rubric override.

Committed evidence: the redacted snapshot and mapping under
[`packages/core/cli/capture/fixtures/`](../../packages/core/cli/capture/fixtures/)
— a text-redacted, byte-free subset kept for deterministic tests, so re-scoring
*it* yields its own smaller numbers, not the run's — and the live reports under
[`packages/core/cli/capture/reports/`](../../packages/core/cli/capture/reports/),
and the acceptance write-up in
[`cms-pipeline/reports/T12.6-zilberman-2026-08-13.md`](cms-pipeline/reports/T12.6-zilberman-2026-08-13.md).

| Measure | Result |
| --- | --- |
| Mapped relevant-block coverage | 9/17 = **52.94%** against a 90% minimum |
| Per-page coverage | `/` 2/6, `/blank-1/moye-sobytiye` 0/1, `/filmography` 1/4, `/partners` 5/5, `/book-online` 1/1 |
| Theme tokens complete | yes |
| Gaps enumerated | yes — **14/14** |
| Visual comparisons | **0 scored / 34 unavailable** (no draft-preview manifest existed) |
| Verdict | `needs_governed_iteration` |

The 14 gaps group into asset materialization (8), home PageType placement (3),
gallery semantics (2), and event modelling (1). Because `requireEnumeratedGaps`
was met, every one of those is a named capability rather than an unexplained
miss — which is the point of the rubric.

## 5b. Worked example — the offline draft-preview fixture (T12.10)

The Zilberman fixtures are text-redacted and **byte-free** — no screenshot
binaries — so nothing in the repo could produce a scored comparison. The
draft-preview fixture is the offline counterpart with real pixels on both
sides, over a SYNTHETIC two-page source site invented for the purpose
(`packages/core/cli/capture/fixtures/preview-fixture/source-site/`, served on
loopback; no third party's pixels are committed).

```bash
node scripts/capture-preview-fixture.mjs            # regenerates the whole run
```

It runs capture → map → theme → emit (dry run) → **preview** → score and writes
`packages/core/cli/capture/fixtures/preview-fixture/run/`: snapshot, mapping,
theme, emission plan, `capture-preview.v1.json`, the fidelity report, the
source and preview PNGs, and `side-by-side.html`. Result: 12 scored
comparisons, both pages scored at both viewports, aggregate 72.91%, 4
unavailable comparisons reported as defects (two home-page blocks the `home`
PageType does not allow, so nothing was emitted for them). Two full
regenerations produce byte-identical PNGs and an identical `visual` block.

**T12.6 remains a `human_gate`: the disposition is Wolf's.** The 2026-08-13
agent-authored disposition was withdrawn and stays withdrawn; nothing in this
runbook authorizes publication, release, or deployment.

## 6. Future — the deferred client-store consent object

R-C2 v2 **deferred, did not reject**, the idea of a governed `capture_config`
object living in the client's own store as a client-owned consent artifact.
Today the CMS-Agent project registry is the single operational home for capture
bounds: it already carries everything the engine reads, already gates the live
target, and its deny-all default means a capture workflow cannot widen a legacy
project's authority. Duplicating the same policy into a second home would buy
zero capability and cost drift risk. The client-store object becomes worth
building at the **consent-recording milestone** — when capture is marketed to
clients hosted elsewhere and the client, not the operator, needs to be the one
who recorded the permission. At that point the registry policy stays the
enforcement surface and the client-store object becomes the consent record it
is derived from; until then, this section is the whole design.
