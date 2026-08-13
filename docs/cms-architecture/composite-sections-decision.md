# Composite sections — the OQ-W8-1…4 decision package (T10.7)

> **Status: MEMO FOR WOLF — decides nothing, builds nothing.** Assembled
> 2026-07-20 per the T10.7 brief from `09-template-system-plan.md` §8 (the
> spec + the four OQs), `block-tree.md` (the designed-never-built nested
> ops), and `design-vocabulary-gaps.md` §5 (the T10.3 composite evidence),
> re-checked AFTER the T10.5/T10.6 mints landed. The first real W12 capture
> run (2026-08-13, T12.6 prepared — disposition still open) produced 14 gaps;
> none is a third qualifying static-composite case, so the gate remains
> closed. Each OQ below ends with an explicit ANSWER line for Wolf.

## 0. The question being decided

§8's staged second act: a **composite** section whose child blocks agents
arrange — "template decides object position within section" in its full
form. It is SPEC-ONLY, gated on OQ-W8-1…4, and rule 1 (grown on demand,
never speculatively) is the standing bar: no build without named evidence.

## 1. OQ-W8-1 — the evidence gate ("name three real layouts the bounded palette cannot express")

The T10.3 survey produced three candidates. Re-checked against the palette
AS IT NOW STANDS (26-member union incl. `media`, `brand_row`, `stats`,
`timeline`, `comparison_table`, plus the five T10.6 variant fields):

| #   | Layout (survey ref)                                                                          | Still inexpressible after the mints?                                                                                       | Nature                                                                 |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | **Bento grid** (A11): heterogeneous tiles with per-child span presets (1×1/2×1/1×2)          | **YES** — no type arranges heterogeneous children with spans; `content_grid` cells are homogeneous cards                   | Static arrangement — exactly §8's case                                 |
| 2   | **Overlap hero** (survey §5.3): hero media bleeding behind a stats card overlapping the fold | **YES** — `hero.variant` moved actions, not layered children; `stats` exists but cannot be layered INTO another section    | Static arrangement (layering/offset presets — a large mapping surface) |
| 3   | **Pricing period toggle** (A9): one section, two child arrangements, user-switched           | YES, but **not by arrangement** — `comparison_table` renders the matrix; the monthly/annual SWITCH is client interactivity | Behavior, not composition — §8's static spec would NOT solve it        |

**Honest scoring: OQ-W8-1 is NOT cleanly cleared.** The gate asks for three
layouts the bounded palette cannot express; only **two** (bento, overlap)
are genuine static-composition cases the §8 spec would actually fix. The
third is an interactivity gap — building composite sections would leave it
exactly as inexpressible as today. Two archetype-derived cases, zero
qualifying capture-derived cases. The 2026-08-13 Zilberman capture produced
14 gaps, but they resolve to asset binding/semantic media normalization,
PageType placement, draft-preview infrastructure, and one event
behavior/content-model gap — none is a third static-composite layout.

**Recommendation: composite STAYS GATED.** Revisit when a future palette-gap
report supplies a third genuine static case from a real capture target — the
strongest possible evidence, and the exact demand rule 1 wants. If Wolf weighs
bento + overlap as sufficient on their own, the §2–§4 recommendations below
are build-ready answers.

**OQ-W8-1 ANSWER (Wolf):** ******************\_\_\_\_******************

## 2. OQ-W8-2 — child vocabulary + depth

**Recommendation (per §8's own lean):** start with **`card` + a small leaf
set** — `card`, `media` (single image item), `stats` (as a child band),
`prose` — NOT arbitrary section nesting. **Depth cap 2** (container →
children, no grandchildren): the navigation tree precedent
(`block-tree.md` — groups → items → dropdown items, depth ≤ 2, enforced and
battle-tested) and the bounded-composition machinery
(`src/lib/registry/block-tree.ts` `allowedChildren`/`childCount`) already
express exactly this. Arbitrary nesting multiplies the canvas-addressing
and inverse-derivation surface for no named demand.

**OQ-W8-2 ANSWER (Wolf):** ******************\_\_\_\_******************

## 3. OQ-W8-3 — the arrangement law

**Recommendation: confirm as specified.** Children are arranged ONLY via
bounded fields on the container — order (array position) + a span preset
enum (e.g. `span: '1x1' | '2x1' | '1x2'`) mapped to pre-built grid classes;
**never pixel positions, never CSS** (rule 6 verbatim, §8's inner law).
The overlap-hero case would additionally need a bounded offset/layer preset
— flag that as its own later ruling if that layout drives the build, since
layering presets are the largest mapping surface in the package.

**OQ-W8-3 ANSWER (Wolf):** ******************\_\_\_\_******************

## 4. OQ-W8-4 — `content_grid.cards` coexistence

**Recommendation: coexist (as §8 recommends).** `content_grid`'s `cards`
data cells stay the flat-data fast path for homogeneous card rows; the
composite container serves heterogeneous arrangement. Superseding `cards`
would force a migration of live converted sections for zero expressive
gain. The two are distinguishable at validation (`cards` is data inside one
type; composite children are typed blocks under `allowedChildren` bounds).

**OQ-W8-4 ANSWER (Wolf):** ******************\_\_\_\_******************

## 5. Build-cost sketch (what a YES actually commissions — §8's law list)

New LAW required before any composite build, none of it small:

1. **Path-addressed block patch ops with exact inverses** —
   `upsert_block` / `move_block` / `remove_block` (designed in
   `block-tree.md`, never built), including guard semantics and capture
   shapes for nested units (the nav-item precedent generalized).
2. **Renderer dispatch for children** — the component registry gains a
   child-render seam; `shared_ref`-in-children ruled in or out explicitly.
3. **Canvas addressing for nested blocks** — the edit-mode overlay and the
   `data-cms-*` identity attributes extended one level down (which also
   touches the W13 tracking loader's trackable-ref discovery).
4. **`validateBlockTree` wired into `checkStructuralInvariants`** — it
   exists (`src/lib/registry/block-tree.ts`) but is connected to nothing on
   the write path.
5. Registry/type work: the container union member, `allowedChildren` /
   `childCount` declarations, editor hints for child insertion, tests per
   op, and the build-diff-EMPTY gate throughout.

Estimate in queue terms: a T-wave of its own (≈ the section_template W8.1–
W8.2 footprint), not a rider on any existing task.

## 6. Disposition

Because §1 recommends the gate HOLDS, no queue rows are added by this memo.
If Wolf answers OQ-W8-1 affirmatively, the natural insertion is a new wave
after W13, briefed from §5's law list — and T12.2/T12.5's gap reports
should still be awaited first if W12 is near, so the child vocabulary is
sized against real captures rather than two archetype cases.
