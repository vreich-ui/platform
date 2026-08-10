# 2026-08-10 — Canvas UX scope ruling (W17): the full Marginalia concept

**Status: RULED by Wolf, 2026-08-10, in session.** This doc is the recorded
result; it unblocks T17.0 and everything below it in
[`../17-canvas-ux-plan.md`](../17-canvas-ux-plan.md).

## The question that was asked

`17-canvas-ux-plan.md` §2 put three scopes to Wolf, after a live verification
session found that the approved concept PDF
([`../../design/marginalia-concept-b-final.pdf`](../../design/marginalia-concept-b-final.pdf))
requires four things that were never itemized in the deferred items 9–16, in
`KNOWN_ISSUES.md`, or in `FLEET-STATUS.md`:

- a **margin rail** — comments live beside the block, not in a docked panel;
- **hover-reveal bubbles** — a comment surfaces on hovering its block;
- an **agent-routed composer** — note / change request / question to the
  assigned article agent;
- **double-click-to-edit** the block directly, with no panel step;
- (plus the narrow-screen page-slide.)

The three scopes were **(a)** the full concept, **(b)** items 9–16 only keeping
the docked panel, **(c)** the concept's interaction model first with the
features deferred.

## The ruling

> **(a) — the full concept. The PDF is the acceptance standard, in full.**

Run all of T17.0–T17.13 as written in §3's table. Multi-session,
opus-weighted. The docked-panel outcome of (b) is explicitly rejected: it is
the outcome that produced the current mismatch once already.

## What follows from it

| # | Consequence |
| --- | --- |
| R1 | **The PDF, not any prose list, is what a W17 task is measured against.** Where the PDF is silent, [`../../design/marginalia-interaction-model.md`](../../design/marginalia-interaction-model.md) (written by T17.0) is the specification, and every place it went past the PDF is marked as a proposal in its §11 index. Neither document may be quietly reinterpreted mid-wave. |
| R2 | **This is a rewrite of the canvas annotation surface, not eight bolt-on features.** T17.3, T17.7 and T17.8 are new work no prior plan document accounts for. Estimating W17 as "the rest of Marginalia" understates it. |
| R3 | **The Comments accordion section is retired by T17.3**, not kept in parallel. The rest of the edit-mode panel (Ask AI / Edit text / Image / Role / Article settings) is unaffected. The admin-side `MarginaliaThreadList.tsx` tab — the surface that gives 12/12 object-type coverage — is untouched by W17. |
| R4 | **The four `marginalia_*` verbs, their store and their permission gate stay as they are.** W17 is a client-surface wave. The one schema change it sanctions is additive and optional (`selectionOccurrence` on the anchor, T17.4); no migration, no change to existing threads. |
| R5 | **Three PDF elements have no owner in §3's table** and are recorded rather than silently absorbed: the reduced three-pill toolbar (proposed T17.6b), the inline `· draft` chip (folded into T17.6), and the `≈ $1.42 · 3 runs` cost chip (**no data source exists in `packages/core`** — proposed out of W17 scope). See the interaction model §10. |
| R6 | **§5's sequencing is binding.** Batch B (T17.3 → T17.8 → T17.6) runs sequentially in one session with one agent — those three rewrite the same positioning and event-handling code and will conflict both textually and semantically if parallelised. T17.4 runs before Batch C. T17.13 runs last. T17.10 stays parked on its delivery-channel decision. |

## Supersessions

- `17-canvas-ux-plan.md` **§2 is answered and closed** by this doc. The section
  stays in place as the record of what was asked; it is no longer a gate.
- T17.0's own `checkpoint` mode is discharged by this ruling.
- The plan's note that `briefPath` is deliberately omitted from `queue.tsv` is
  discharged: T17.0 wrote the T17.3–T17.13 briefs and added the rows.
