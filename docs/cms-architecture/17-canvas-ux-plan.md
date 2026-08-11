# W17 — Canvas UX: Marginalia concept build + edit-mode chrome modernization

**Status:** Plan, not yet scheduled. T17.0 is a `checkpoint` — it does not start
until Wolf answers the scope question in §2.
**Written:** 2026-08-10, from a live verification session driven against
production (`drluriescience.netlify.app`, signed in, network-traced).
**Governing target:** [`docs/design/marginalia-concept-b-final.pdf`](../design/marginalia-concept-b-final.pdf)
— Wolf's approved "Marginalia — final" concept. That PDF, not any prose list,
is the acceptance standard for T17.3–T17.9.

---

## 1. The goal, restated

The canvas edit surface is where Wolf actually works on articles. Two things are
wrong with it today, and they are independent problems that got conflated:

1. **It doesn't do what the approved design says it should.** What shipped in the
   S4 MVP (#521) is a generic docked panel; the concept is a margin-anchored,
   hover-revealed, agent-routed annotation surface. Different interaction model,
   not a subset.
2. **It doesn't look or read like the rest of the site,** and destructive/warning
   actions are visually indistinguishable from ordinary ones — a real
   colour-token bug, not a taste question (§4, T17.1).

W17 closes both. §3's table is the full task set with per-task model and effort;
§5 says which of them can share a session and which must not.

## 2. Scope question for Wolf (blocks T17.0, and therefore T17.3–T17.9)

**Correction to what was said earlier in the 2026-08-10 session:** when asked
"is 9–16 it?", the answer given was yes. That was right about the *deferred
feature list* and wrong about the *size of the gap*. The authoritative items
9–16 (from `FLEET-STATUS.md`, matching #521's body) are:

> 9 selected-text span anchoring · 10 reply-threading UI · 11 gutter badges/dot
> counters · 12 image-ref-specific comments · 13 notifications/digests · 14
> per-role comment-visibility policy · 15 review-decision linking · 16
> headless-browser smoke test

Reading the concept PDF against that list, **four of its requirements were never
itemized anywhere** — they are not in 9–16, not in `KNOWN_ISSUES.md`, not in
`FLEET-STATUS.md`:

- **Margin rail layout** — comments live *in the margin*, spatially beside the
  block they annotate, not in a docked panel. Item 11's "gutter badges" implies a
  gutter that does not exist yet.
- **Hover-reveal bubbles** — a comment surfaces on hovering its block, rather
  than requiring a panel open.
- **Agent-routed composer** — a comment can be a plain note, a change request, or
  a question put to "Dr. Lurié Article Agent · via CMS Agent". Today's composer
  is a bare textarea with no routing at all.
- **Double-click-to-edit the block directly** — no separate panel step.
- (Plus: on narrow screens the page *slides over* to make room for the margin
  instead of being covered.)

**So the honest scoping statement is: the concept is roughly a rewrite of the
canvas annotation surface, not eight bolt-on features.** T17.3, T17.7 and T17.8
below are new work that no existing plan document accounts for.

**The question:** is the concept PDF still the target, in full? Three answers,
each leading somewhere different:

- **(a) Full concept.** Run all of T17.0–T17.13. Multi-session, opus-weighted.
- **(b) Items 9–16 only,** keeping the docked panel. Skips T17.3/T17.7/T17.8 —
  cheaper, but the result still won't look like the PDF, and this is the
  outcome that produced the current mismatch once already.
- **(c) Concept interaction model first, features later.** T17.0 → T17.3 →
  T17.8 → T17.6 (the parts you *see*), defer the rest. Gets the surface looking
  and behaving like the design fastest, at the cost of a longer tail.

Nothing below T17.2 should start before this is answered.

## 3. Task table

Model/effort columns use `queue.tsv`'s vocabulary. **Model note:** older rows in
`queue.tsv` use `claude-opus-4-8`; `claude-opus-5` supersedes it for new work and
is what these rows specify. Sonnet is assigned where the task is a bounded change
against an existing pattern; opus where it requires designing an interaction
model or touching layout/anchoring logic with no existing precedent in the file.

| ID | Task | mode | model | effort |
| --- | --- | --- | --- | --- |
| **T17.1** | `--dlem-danger` colour-chain bug fix — resolves to the site's blue secondary, and the delete button doesn't even use it (§4) | auto | `claude-sonnet-5` | low |
| **T17.2** | Glass treatment for panel / accordion heads / confirm modal / tray / message bubbles, per the spec doc | auto | `claude-sonnet-5` | medium |
| **T17.0** | Concept-to-brief decomposition: read the PDF, write the interaction-model spec + per-task briefs for everything below | checkpoint | `claude-opus-5` | high |
| **T17.3** | Margin rail layout + hover-reveal bubbles + narrow-screen page-slide — *PDF, not in items 9–16* | auto | `claude-opus-5` | high |
| **T17.4** | Selected-text span anchoring (item 9) — schema fields already reserved in `marginalia-v1.ts` | auto | `claude-opus-5` | high |
| **T17.5** | Reply-threading UI (item 10) — `parentCommentId` already reserved, client renders flat today | auto | `claude-sonnet-5` | medium |
| **T17.6** | Gutter badges / dot counters + the global "Attention N" toolbar counter (item 11 + PDF) | auto | `claude-sonnet-5` | medium |
| **T17.7** | Agent-routed composer: note / change-request / question → CMS Agent — *PDF, not in items 9–16* | auto | `claude-opus-5` | high |
| **T17.8** | Double-click-to-edit block inline, no panel step — *PDF, not in items 9–16* | auto | `claude-opus-5` | high |
| **T17.9** | Image-ref-specific comments (item 12) | auto | `claude-sonnet-5` | medium |
| **T17.10** | Notifications / digests (item 13) — delivery channel is a product decision, not an agent one | checkpoint | `claude-sonnet-5` | medium |
| **T17.11** | Per-role comment-visibility policy (item 14) — follows the existing `isOwner`/`resolveRolesFromEvent` pattern | auto | `claude-sonnet-5` | medium |
| **T17.12** | Review-decision linking (item 15) — ties threads to `object_review_decide` | auto | `claude-sonnet-5` | medium |
| **T17.13** | Headless-browser smoke test for the canvas annotation surface (item 16) | auto | `claude-sonnet-5` | medium |

`briefPath` is deliberately omitted: **T17.0 writes the briefs.** Do not paste
these rows into `queue.tsv` before those brief files exist — the runner resolves
`briefPath` and will fail or, worse, run a task with no spec.

## 4. T17.1 and T17.2 are ready now and depend on nothing above

Full spec, with the live-computed values that prove the bug and the exact CSS:
[`docs/design/marginalia-glass-ui-modernization.md`](../design/marginalia-glass-ui-modernization.md).

Short version: `--dlem-danger` is declared as
`var(--adm-danger, var(--aw-color-secondary, #b91c1c))`. `--adm-danger` only
exists under `/admin/*`, so on the public canvas it falls through to
`--aw-color-secondary`, which *is* defined site-wide — the red literal is
unreachable. Live computed value: `rgb(37 90 120)`, the site's dark blue.
Separately, `.dl-em-btn.dl-em-danger` uses `--dlem-draft` (the gold warning
token) rather than the danger token at all, so "delete" and "needs attention"
render identically. This is the mechanical cause of the low-visibility
complaint. Both fixes are CSS-only inside `ui-chrome.ts`'s `STYLES` export.

**These two are safe to land immediately, before the §2 decision** — they
improve the current surface and none of the work is thrown away if the panel is
later replaced, because the danger token and the glass tokens are consumed by
whatever chrome exists. Land them as **two commits** (bug fix, then style), per
the repo's one-task-one-commit rule.

## 5. Sequencing — what runs together, what must not

**Batch A — ship now, one session, no decision needed.** T17.1 + T17.2. Both are
CSS-only in the same file. Sonnet, ~low cost. This is the cheapest visible
improvement available and it is not blocked on anything.

**Gate — T17.0.** Blocks on Wolf's §2 answer. Once answered it is a single opus
session producing briefs; nothing else should run concurrently with it, because
its output determines whether the tasks below are even in scope.

**Batch B — the layout core. Must run SEQUENTIALLY, in one session, same agent.**
T17.3 → T17.8 → T17.6, in that order. All three rewrite canvas positioning and
event handling in `ui-chrome.ts` / `ui.ts`; T17.6's badges are positioned in the
rail T17.3 creates, and T17.8's double-click handler competes with T17.3's hover
handlers for the same events. **Do not parallelise these across worktrees** —
they will conflict textually and semantically. Opus, high effort, expect this to
be the bulk of W17.

**Batch C — data-model features, safe to parallelise** *after* Batch B lands.
T17.5, T17.9, T17.11, T17.12 touch mostly separate concerns (threading render,
image refs, role gating, review linkage) and can run as concurrent agents in
separate worktrees. T17.4 (span anchoring) is the exception — it changes what a
thread *is* anchored to, so run it **before** this batch, not inside it.

**Batch D — T17.7** (agent-routed composer) is largely independent of Batch B/C:
it replaces the composer's submit path, not the layout. Can run in parallel with
Batch C.

**Last — T17.13.** The smoke test is written against the finished surface. Any
earlier and it tests something that no longer exists.

**T17.10** stays parked until its delivery channel is decided; it is the one
item here with no obvious default.

## 6. Verified-and-closed during the same session — do not re-investigate

- **Edit-mode preload is working.** A suspected regression (article text no
  longer warming at the moment canvas mode activates) was checked live: 15
  parallel preload calls fire on `setEditMode(true)`, `preloadRecords()` is
  intact in `ui.ts`, and #543's touch to that file (Learning Mode wiring) does
  not affect it. The Marginalia panel opens from cache with no cold fetch and no
  console errors. **Nothing to fix — this line of investigation is closed.**
- **The hover-chip toolbar Wolf recognised as "my earlier dev" is exactly that**
  — the pre-existing W7 chip UI. Marginalia's Comments accordion sits one level
  deeper inside the panel it opens. Not a regression, not a missing feature;
  it's the layer the concept PDF replaces (T17.3).
