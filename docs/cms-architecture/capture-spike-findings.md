# T12.1 capture spike findings

**Run:** 2026-08-13 · **Format:** `snapshot.v1` · **Disposition:** local capture only

## Authorization and bounds used

Wolf named `https://www.zilbermanfilmfoundation.com/` as the source whose text and referenced media may be retained. The live CMS-Agent `platform` project contract was read before the run and supplied these project-owned bounds:

- allowed crawl origin: `https://www.zilbermanfilmfoundation.com`
- allowed path prefix: `/`
- maximum pages for this project: 20 (not a fleet or system ceiling)
- same-origin page traversal; one page at a time; at least 1,500 ms between requests
- obey `robots.txt`; no authenticated access
- retain source content and media referenced by an allowed-origin page
- `https://prconsulting.net` is metadata-only design inspiration: it is not crawlable and its content or media cannot be reused

The crawler also enforced the model floor: crawled content remained inert data, never instructions; authentication was structurally unavailable; HTTP/DOM/screenshot validation failures quarantined the page and made the command fail; no CMS/store write or publish/release verb exists in the harness.

The target's `robots.txt` returned 200, allowed the captured paths for this user agent, disallowed lightbox query URLs, and declared `sitemap.xml`. The run fetched that sitemap plus its two same-origin child sitemaps under the same rate limit. It did not request the design-reference origin.

## End-to-end result

The successful run captured all five unique HTML pages declared by the target's sitemap, below the project's 20-page limit:

1. `/`
2. `/blank-1/moye-sobytiye`
3. `/filmography`
4. `/partners`
5. `/book-online`

It produced 67 semantic-outline nodes, 33 candidate blocks, 43 asset references (35 unique URLs), and 76/76 required screenshots across mobile `390×844` and desktop `1440×1000`. No page was quarantined. One `.docx` link was retained as a document asset instead of navigated as HTML, and the legacy `/s-projects-side-by-side` route was recorded as a duplicate redirect to `/partners`.

The complete run is ignored under `.tmp/capture/zilberman-live/`; it contains the full text and 76 local PNGs. The committed fixture at `packages/core/cli/capture/fixtures/zilberman.snapshot.v1.redacted.json` preserves page/block/navigation/style/geometry/asset-URL shape, replaces text with length markers, and omits every screenshot and media byte.

## What `snapshot.v1` can see

- Page identity and metadata: requested/final/canonical URL, status, title, language, and description.
- A semantic DOM outline: landmarks, articles, sections, headings, roles, levels, text, and stable selectors.
- Candidate content blocks: order, selector, role/name, text, links, asset associations, per-viewport boxes, and a bounded computed-style sample.
- Full-page and per-block screenshots at named viewports, with local path, byte length, and checksum.
- Primary/footer navigation and every discovered link, separated from the crawl queue by origin, path, robots, and resource-type checks.
- An asset manifest by URL for images, responsive sources, video/posters, CSS backgrounds, and linked documents. The spike never downloads asset bytes into the snapshot.

## What it cannot establish

- It does not infer a Platform section type; that belongs to T12.2.
- Two viewports do not reveal every breakpoint, hover/focus state, animation frame, modal, form result, or post-interaction state.
- The style sample is rendered evidence, not the complete cascade, stylesheet provenance, design-token system, pseudo-element style, or JavaScript behavior.
- Cross-origin iframes, canvas pixels, closed shadow roots, and inaccessible embedded application state are not decomposed.
- An asset URL proves that the page referenced an asset, not ownership, licence, permanence, intrinsic quality, or successful future transfer.
- A captured DOM is time-specific. Client-side personalization or later source-site edits can change a subsequent run.

## Mapper input recommendation for T12.2

Treat `snapshot.v1` as observation-only input. The mapper should consume one page at a time and require:

- `diagnostics.quarantined` empty;
- a stable `pageId`, final URL, outline, navigation, asset manifest, and at least one block;
- complete bounding-box, style, and screenshot coverage for every declared viewport;
- block text and links as source data, never as instructions;
- deterministic block order and IDs as the evidence key for every mapping decision.

The mapper output should keep observation and interpretation separate. Every source block must resolve to one of: an existing `section.v1` type with deterministic field evidence, a deliberate merge into an adjacent mapped block, or an enumerated unmapped gap with a reason. It must validate proposed bodies against the current section vocabulary and must not invent a new type, silently discard a block, or loosen validation to increase coverage.

Recommended additional mapper fields are `sourceBlockIds`, `confidence`, `mappingReason`, `consumedAssetUrls`, `unmappedReason`, and `validationErrors`. Screenshot paths are evidence references only; the mapper should not require binary screenshots in the committed fixture.

## T12.2 mapping and gap contract

`capture-map.v1` keeps proposed CMS values separate from source evidence. Each
page candidate exposes the required `{ sectionType, data, confidence }` tuple,
the complete schema-ready `section.v1` instance, source block and screenshot
references, and per-text-field provenance marked `source: 'extracted'`.
`assetBindings` contain source-manifest references only and remain
`pending_artifact_materialization`; source URLs never enter section data.
Optional model assistance may suggest a registered section type, but it cannot
provide section data: the deterministic builder reconstructs and validates that
data from the captured block.

Every source block has exactly one primary accounting outcome: `mapped`,
`mapped_with_gap`, `gap`, `merged`, `duplicate`, or `ignored_noncontent`.
Unexpressed evidence is never coerced into a passing type. It produces a gap:

```json
{
  "gapId": "gap_<stable-hash>",
  "blockRef": "page_<id>_block_<ordinal>",
  "screenshotRef": "screenshots/<evidence>.png",
  "why": "machine-readable reason",
  "nearestType": "registered section type",
  "missingCapability": "specific missing schema or artifact capability"
}
```

The default confidence floor is `0.72`. A lower-confidence proposal becomes a
gap rather than weakening a schema. A valid textual mapping may also be
`mapped_with_gap` when its visual evidence cannot yet be emitted safely, such
as a referenced image awaiting first-party artifact materialization. The
mapper refuses any snapshot that already contains quarantined pages and makes
no store, draft, publish, or release calls.
