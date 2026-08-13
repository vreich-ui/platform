# Design-vocabulary survey — reference targets → mint list + gap report (T10.3)

## 8. W12 capture evidence — Zilberman Foundation (T12.5/T12.6, 2026-08-13)

The first capture-fed gap artifact is
[`zilberman.palette-gap-report.v1.golden.json`](../../packages/core/cli/capture/fixtures/zilberman.palette-gap-report.v1.golden.json).
It is generated from the authorized Zilberman snapshot and mapper output; it
records unexpressible source blocks as evidence only, and does not mint a new
section type or relax PageType law. The capture policy classifies the separate
PR Consulting reference as design inspiration only: it was not crawled and no
copy or media from it is present in this evidence.

The companion fidelity fixture uses the ratified coverage-based rubric rather
than a pixel threshold. Its screenshot paths are retained as evidence but the
fixture intentionally has no image binaries, so unavailable visual comparisons
remain explicit rather than being invented or treated as a pass.

Wolf reviewed the first live run at T12.6 and selected **not accepted — record
the misses**. The committed live
[`fidelity report`](../../packages/core/cli/capture/reports/zilberman.2026-08-13.fidelity-report.v1.json)
records 9/17 mapped relevant blocks (52.94%, below the 90% default), complete
tokens, all gaps enumerated, and 0/34 visual comparisons available because no
draft-preview screenshot manifest existed. The companion
[`palette-gap report`](../../packages/core/cli/capture/reports/zilberman.2026-08-13.palette-gaps.v1.json)
contains all 14 source-block findings.

### 8.1 W10 growth-loop backlog from the live run

| Evidence group | Count | Disposition |
| --- | ---: | --- |
| Materialized asset refs must be rebound into schema-safe image/media fields | 6 | Mapping/emission follow-up; no new type and no hotlinks |
| Gallery needs first-party assets plus item-level text | 2 | Use the existing governed `media` vocabulary; improve asset-aware mapping |
| Embedded builder style payload cannot be retained | 2 | Normalize into semantic gallery/media data; never import CSS |
| Home PageType refuses prose/contact form | 3 | Placement/PageType-policy decision; keep quarantined and do not widen merely to pass |
| Event detail mixes metadata, body, registration, and sharing | 1 | Governed event/workflow content-model backlog; behavior gap, not static-composite evidence |
| Draft-preview screenshots absent | 34 comparisons | Capture infrastructure backlog; generate a reviewable preview before rescoring |

This first real capture therefore adds **no third qualifying static-composite
case**: the event finding needs behavior and content modeling, while the other
findings are asset binding, semantic normalization, PageType placement, or
preview infrastructure. The composite gate remains closed. A future acceptance
run must address these items and meet the unchanged rubric; this evidence does
not mint vocabulary or loosen validation.

> **Original T10.3 survey status (historic): PROPOSAL — awaiting Wolf's T10.4
> ratification (OQ-W10-1 + OQ-W10-2).**
> Produced 2026-07-19 per `11-platformization-plan.md` §1.2. This document
> mints NOTHING: it is the evidence and the proposal. Rule 1 grows the palette
> on demand — the multi-site/capture ambition (W11/W12) is the demand — and
> rule 6 keeps every proposed option bounded (enumerated data → pre-built
> class/var mappings; no CSS in schema fields, ever).
>
> **Reference basis (disclosure).** Wolf named no reference sites in the
> session context, so per the brief this survey analyzes three representative,
> publicly documented site archetypes instead of crawling specific targets
> (nothing was crawled; W12 owns capture tooling): **(A)** the SaaS/product
> marketing homepage pattern (hero → social proof → feature grid → metrics →
> pricing → CTA — the pattern family documented in every major component
> library and marketing-site teardown), **(B)** the editorial/health content
> publisher pattern (topic hubs, expert bios, media-led features, newsletter
> capture — the family Dr-Lurie itself belongs to), and **(C)** the
> local-practice / services brochure pattern (services menu, team, gallery,
> credentials, FAQ, contact — the likeliest early capture/tenant profile for
> W11/W12). If Wolf names concrete reference sites at T10.4, re-running this
> survey against them is a small follow-up, not a redo — the disposition
> framework below is target-independent.

## 0. Current expressive range (the baseline being measured against)

- **21-member section union** = 19 component-bound types (`hero`, `lede`,
  `prose`, `checklist`, `content_grid`, `bio`, `newsletter_signup`,
  `testimonial`, `cta_banner`, `faq`, `link_list`, `product_preview`,
  `contact_form`, `search`, `content_embed`, `form_confirmation`, `steps`,
  `content_split`, `pricing_table`) + `card` (grid-cell leaf, not standalone)
  - `shared_ref` (pointer, renderer-dereferenced).
- **Existing bounded layout fields** (rule 6 today): `content_grid.columns`
  (1–4) + `limit` + source kinds (`manual`/`query`/`related`/`cards`),
  `content_split.reverse`, section `visibility`. The §5 (09-plan) named-but-
  unbuilt candidates: `steps.columns (2|3|4)`, `cta_banner.compact?`,
  `content_split.imageLayout ('stagger'|'stack')`.
- **Token axes** (T10.1, shipped as the OQ-W10-2 default sketch):
  `layout.containerWidth`, `layout.sectionRhythm`, `shape.radius`,
  `shape.buttonShape`, `shape.shadow`, `type.scale`, `type.headingWeight`.

## 1. Observed section shapes → disposition

Legend: **(a)** expressible today (type + config named) · **(b)** bounded
variant field on an existing type · **(c)** new reusable type (mint) ·
**(d)** inexpressible without composite arrangement → OQ-W8-1 evidence.

### Archetype A — SaaS/product marketing homepage

| #   | Observed shape                                                           | Disposition                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Full-bleed hero: headline, subhead, 1–2 CTAs, product image below/beside | **(a)** `hero` (title/subtitle/actions/image today) — but the center/split/background placement distinction is **(b)**: `hero.variant: 'center'\|'split'\|'background'` (plan §1.2's own example) |
| A2  | Logo strip / "trusted by" brand row                                      | **(c)** `brand_row` — already named "maybe" in conversion-map; a row of small image refs + optional heading; reusable for press logos, certification badges, partner marks                        |
| A3  | 3–4 column feature grid with icon + title + blurb                        | **(a)** `content_grid` (source `cards`, `columns: 3`)                                                                                                                                             |
| A4  | Metrics/stats band ("10k users · 99.9% uptime · 4.9★")                   | **(c)** `stats` — N bounded stat items (value, label, optional sublabel); nothing today renders large-number-plus-label semantics; `checklist`/`cards` misuse would be a replica                  |
| A5  | Alternating image/text feature rows                                      | **(a)** repeated `content_split` with alternating `reverse` — the sequence is page composition, not a new type                                                                                    |
| A6  | Single spotlight testimonial with portrait                               | **(a)** `testimonial`                                                                                                                                                                             |
| A7  | Testimonial wall (masonry of quote cards)                                | **(b)** `testimonial.layout: 'single'\|'wall'` with bounded item list — the wall is the same data plural, not a new semantic                                                                      |
| A8  | Pricing table with plan columns                                          | **(a)** `pricing_table` (product-object-driven)                                                                                                                                                   |
| A9  | Monthly/annual toggle switching the visible pricing set                  | **(d)** interactive state switching two child arrangements — composite/behavior territory, not bounded data on one type. OQ-W8-1 evidence #1                                                      |
| A10 | Closing CTA banner                                                       | **(a)** `cta_banner`; the slim variant is the §5 candidate `cta_banner.compact?: boolean` → **(b)**                                                                                               |
| A11 | Bento grid (mixed 1×1/2×1/1×2 tiles of heterogeneous content)            | **(d)** per-child span arrangement inside one section — exactly §8's bounded-arrangement composite. OQ-W8-1 evidence #2                                                                           |
| A12 | Comparison table (us-vs-them feature matrix)                             | **(c)** `comparison_table` — bounded rows (feature label + per-column yes/no/text), N columns ≤ 4; `pricing_table` is product-bound and `prose` tables are not agent-configurable data            |

### Archetype B — editorial / health-content publisher (Dr-Lurie's own family)

| #   | Observed shape                                                | Disposition                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Topic hub header + curated article river                      | **(a)** `lede` + `content_grid` (source `query`/`related`) — live today on the listing PageTypes                                                                                                                                                                                                   |
| B2  | Inline image / figure with caption, standalone gallery strip  | **(c)** `media` — single image OR bounded gallery (1–8 asset refs, captions, `layout: 'single'\|'grid'\|'strip'`); today images live only inside rich text, heroes, bios, and cards — no standalone, agent-pointable media section                                                                 |
| B3  | Video feature (hosted embed with poster + caption)            | **(c)** `video_embed` — provider-allowlisted (the `content_embed` iframe posture reused), poster asset ref, caption. Distinct from `media` (playback semantics + CSP posture); could fold INTO `media` as `kind: 'video'` if Wolf prefers a smaller mint list — flagged as a T10.4 decision toggle |
| B4  | Expert/author bio card with credentials                       | **(a)** `bio`                                                                                                                                                                                                                                                                                      |
| B5  | Newsletter capture band                                       | **(a)** `newsletter_signup`                                                                                                                                                                                                                                                                        |
| B6  | "How to" step sequence                                        | **(a)** `steps`; the 2–4 column layout is the §5 candidate `steps.columns` → **(b)**                                                                                                                                                                                                               |
| B7  | Condition/treatment timeline ("what to expect over 12 weeks") | **(c)** `timeline` — ordered bounded milestones (label, period, rich blurb); `steps` implies procedure, `checklist` implies completion; a time-axis semantic is its own reusable thing                                                                                                             |
| B8  | FAQ accordion                                                 | **(a)** `faq`                                                                                                                                                                                                                                                                                      |
| B9  | Big pull-quote between prose blocks                           | **(b)** `testimonial.variant: 'pullquote'` OR a `prose` sub-style — recommend the testimonial variant (same data: quote + attribution optional)                                                                                                                                                    |
| B10 | Product recommendation inline ("what I'd use")                | **(a)** `product_preview`                                                                                                                                                                                                                                                                          |
| B11 | Sticky sub-nav / in-page table of contents rail               | **(d)** page-chrome behavior bound to document structure, not a section an agent places — OUT of the palette (navigation/template territory), recorded so capture doesn't misfile it. Not composite evidence; simply out of scope                                                                  |

### Archetype C — local practice / services brochure (the W11/W12 tenant profile)

| #   | Observed shape                                    | Disposition                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Services menu (name + blurb + price-from)         | **(a)** `content_grid` cards; if per-service routing grows, cards already link                                                                                                                                                              |
| C2  | Team grid                                         | **(a)** `content_grid` of `bio`-style cards (cards carry image+title+body+link today)                                                                                                                                                       |
| C3  | Before/after or portfolio gallery                 | **(c)** `media` again (the `'grid'`/`'strip'` layouts) — same mint as B2, second demand signal                                                                                                                                              |
| C4  | Credentials/accreditation logo row                | **(c)** `brand_row` — same mint as A2, second demand signal                                                                                                                                                                                 |
| C5  | Opening hours / contact info block with map embed | **(a)** `contact_form` + `content_embed` (map iframe) + `prose` for hours; a dedicated `hours` type fails the litmus test's reuse bar on today's evidence — one archetype, one placement. Revisit only if capture (W12) meets it repeatedly |
| C6  | Star-rating / review summary band                 | **(c)** `stats` covers the number band presentation (A4's mint, second demand signal); full review-feed integration is data-source work, not a section shape                                                                                |
| C7  | Emergency/announcement banner                     | **(a)** site chrome `announcement` (site object) — already governed                                                                                                                                                                         |

### Litmus check (design-principles rule 1)

Every **(c)** proposal above is agent-repointable without a code change: a
`media` section points at any artifact refs; `brand_row` at any logo set;
`stats` at any number set; `timeline` at any milestone list;
`comparison_table` at any feature matrix; `video_embed` at any allowlisted
provider URL. None encodes a specific page. Shapes that FAILED the litmus
test were kept out: `hours` (C5, single-use), "pricing toggle" (A9, behavior
not data), "TOC rail" (B11, chrome not content).

## 2. Proposed mint list (OQ-W10-1) — 6 candidates, batched ×2

Recommended per plan §1.2 (each mint = union member + registry module +
component + editor hints + `useWhen` + tests, build-diff EMPTY):

**Batch 1 (T10.5) — strongest demand, simplest schemas:**

1. `media` — standalone image/gallery (B2 + C3; two archetypes). Data:
   1–8 asset refs + captions, `layout: 'single'|'grid'|'strip'`.
2. `brand_row` — logo strip (A2 + C4; two archetypes; conversion-map "maybe"
   already). Data: 2–8 small image refs + optional label + optional links.
3. `stats` — number band (A4 + C6; two archetypes). Data: 2–6 items of
   value/label/optional sublabel.

**Batch 2 (T10.6) — richer schemas, single-archetype-but-capture-relevant:**

4. `timeline` — ordered milestones (B7). Data: 2–8 milestones of
   label/period/rich blurb.
5. `comparison_table` — bounded feature matrix (A12). Data: 2–4 columns,
   ≤ 12 rows of label + per-column cell (boolean or short text).
6. `video_embed` — provider-allowlisted video (B3). **Decision toggle for
   Wolf:** mint standalone OR fold into `media` as `kind: 'video'` (shrinks
   the list to 5). Recommendation: fold it in — one media surface, one CSP
   posture — unless the provider allowlist wants its own contract copy.

## 3. Proposed bounded-variant list (OQ-W10-1)

All rule-6: enum/boolean fields rendered through pre-built class mappings.

1. `hero.variant: 'center' | 'split' | 'background'` (A1; plan §1.2's
   example). Default `'center'` = today's render, byte-identical.
2. `cta_banner.compact?: boolean` (A10; 09-plan §5 named candidate).
3. `content_split.imageLayout: 'stagger' | 'stack'` (A5 refinement; 09-plan
   §5 named candidate).
4. `steps.columns: 2 | 3 | 4` (B6; 09-plan §5 named candidate).
5. `testimonial.layout: 'single' | 'wall'` (A7) and
   `testimonial.variant: 'quote' | 'pullquote'` (B9) — one type, two bounded
   fields, defaults = today's render.

Batch 2 (T10.6) carries the variant work alongside its mints per the queue's
task naming.

## 4. Token-axis gaps vs T10.1's shipped set (OQ-W10-2 input)

Observed in the archetypes but NOT covered by the shipped seven axes:

- **`layout.surfaceAlternation`** (`'none' | 'banded'`) — archetypes A and C
  routinely alternate white/tinted section backgrounds. Today that's
  per-component `bg` handling. A bounded axis would let a theme flip banding
  globally. _Recommendation: DEFER — the mapping surface (which sections
  count as "even") is ambiguous until the mint list settles; name it, don't
  build it._
- **`type.measure`** (`'narrow' | 'default' | 'wide'` reading measure — the
  720px prose width) — distinct from `containerWidth` (section shell). Cheap
  to add (one var), real archetype-B variance. _Recommendation: ADD to the
  axis set at T10.4 if Wolf wants any amendment; otherwise defer to first
  real theme demand._
- **`shape.cardStyle`** (`'outlined' | 'shadowed' | 'flat'`) — C-archetype
  sites often run borderless flat cards. Partially covered by
  `shape.shadow: 'none'` + existing border; a full style axis is
  _deferred — shadow axis first, evidence later._

No other axis gaps surfaced: color/font are governed; radius/shadow/rhythm/
scale/weight/width cover the rest of the observed theme variance.

## 5. Composite evidence (feeds T10.7's decision package — OQ-W8-1)

Real observed layouts the bounded palette + rule-6 fields cannot express:

1. **Pricing period toggle** (A9): one section, two child arrangements,
   user-switched. Needs child blocks + interactive state — beyond bounded
   data on a flat type.
2. **Bento grid** (A11): heterogeneous children with per-child span presets
   (1×1/2×1/1×2). Exactly §8's "bounded arrangement fields on children" —
   the cleanest composite justification observed.
3. **Overlap hero** (A-family variant: hero image bleeding behind a stats
   card that overlaps the fold): per-child layering/offset. Expressible only
   with composite children + bounded offset presets; NOT recommended as an
   early target (layering presets are a big mapping surface).

Two of three are static-arrangement cases (2, 3) and one is interactivity
(1). §8's static composite spec covers 2 and 3; case 1 additionally needs a
behavior story — worth splitting in the OQ-W8 discussion (T10.7 assembles
this).

## 6. OQ-W10-1 + OQ-W10-2 — the questions for Wolf (T10.4 checkpoint)

**OQ-W10-1a (mints):** Approve the 6-candidate list (§2) as batched? Per
entry: approve / defer / reject. One named toggle: fold `video_embed` into
`media` (list of 5, recommended) or keep it standalone?

**OQ-W10-1b (variants):** Approve the 5-entry bounded-variant list (§3)?
Per entry: approve / defer / reject.

**OQ-W10-2 (axes):** Ratify the T10.1 shipped axis set + enum values as-is,
or amend? Named amendment candidate from this survey: add `type.measure`
(§4). (Any amendment files as a delta on T10.5's brief per the T10.4
protocol — the schema edit rides the next build task.)

**Also carried to T10.4:** if Wolf names concrete reference sites, say so —
the survey re-runs against them as a small follow-up before T10.5 builds.

## 7. RATIFIED (Wolf, 2026-07-19 — T10.4 checkpoint record, collected interactively in-session)

Rulings on the §6 questions, verbatim-in-intent:

- **OQ-W10-1a (mints): APPROVED — all, with `video_embed` FOLDED INTO
  `media`.** The mint list is FIVE types: batch 1 (T10.5) = `media`
  (image/gallery, including `kind: 'video'` with the provider-allowlisted
  embed posture), `brand_row`, `stats`; batch 2 (T10.6) = `timeline`,
  `comparison_table`. No standalone `video_embed` type.
- **OQ-W10-1b (variants): APPROVED — all five.** `hero.variant
('center'|'split'|'background')`, `cta_banner.compact?: boolean`,
  `content_split.imageLayout ('stagger'|'stack')`, `steps.columns (2|3|4)`,
  `testimonial.layout ('single'|'wall')` + `testimonial.variant
('quote'|'pullquote')`. Defaults = today's render, byte-identical. Built
  in T10.6 per the queue's task naming.
- **OQ-W10-2 (axes): RATIFIED AS SHIPPED.** The T10.1 seven-axis set and
  enum values stand unamended; `type.measure` stays deferred to first real
  theme demand (no delta rides T10.5). `11-platformization-plan.md` §1
  needs no update.

Per-entry disposition table (approved / deferred / rejected):

| Entry                                          | Ruling                                     |
| ---------------------------------------------- | ------------------------------------------ |
| `media` (incl. video kind)                     | APPROVED — batch 1                         |
| `brand_row`                                    | APPROVED — batch 1                         |
| `stats`                                        | APPROVED — batch 1                         |
| `timeline`                                     | APPROVED — batch 2                         |
| `comparison_table`                             | APPROVED — batch 2                         |
| `video_embed` (standalone)                     | REJECTED as standalone — folded into media |
| All 5 variant fields                           | APPROVED — batch 2                         |
| `type.measure` axis                            | DEFERRED — first real theme demand         |
| `layout.surfaceAlternation`, `shape.cardStyle` | DEFERRED (per survey recommendation)       |

No reference sites were named — the archetype basis stands; no survey
re-run required before T10.5. **T10.5 and T10.6 are unblocked against this
record.**
