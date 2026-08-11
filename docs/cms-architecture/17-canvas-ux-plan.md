# W17 — Canvas UX: Marginalia concept build + edit-mode chrome modernization

**Status:** Plan of record, scheduled. §2's scope question is **ANSWERED —
Wolf chose (a), the full concept**, 2026-08-10
([`decisions/2026-08-10-canvas-ux-scope-ruling.md`](decisions/2026-08-10-canvas-ux-scope-ruling.md)).
T17.0 ran on that ruling and produced
[`../design/marginalia-interaction-model.md`](../design/marginalia-interaction-model.md)
plus the T17.3–T17.13 briefs; the `queue.tsv` rows exist with resolved
`briefPath`s. T17.1/T17.2 have landed. §2 below is kept as the record of what
was asked — it is no longer a gate.
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

## 2. Scope question for Wolf — ANSWERED 2026-08-10: **(a), the full concept**

> **Ruling (Wolf, 2026-08-10):** the concept PDF is the target, in full. Run
> all of T17.0–T17.13. Recorded, with its six consequences, in
> [`decisions/2026-08-10-canvas-ux-scope-ruling.md`](decisions/2026-08-10-canvas-ux-scope-ruling.md).
> The rest of this section is the question as it was put; it is history now.
> One correction the PDF forced once T17.0 read it against the code: **three
> further elements have no owner in §3's table** — the reduced three-pill
> toolbar, the inline `· draft` chip, and the `≈ $1.42 · 3 runs` cost chip
> (which has no data source anywhere in `packages/core`). See
> [`../design/marginalia-interaction-model.md`](../design/marginalia-interaction-model.md)
> §10.



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
| **T17.3** | Margin rail layout + hover-reveal bubbles + narrow-screen page-slide — *PDF, not in items 9–16* — **DONE 2026-08-10 (§7)** | auto | `claude-opus-5` | high |
| **T17.4** | Selected-text span anchoring (item 9) — schema fields already reserved in `marginalia-v1.ts` | auto | `claude-opus-5` | high |
| **T17.5** | Reply-threading UI (item 10) — `parentCommentId` already reserved, client renders flat today | auto | `claude-sonnet-5` | medium |
| **T17.6** | Gutter badges / dot counters + the global "Attention N" toolbar counter (item 11 + PDF) — **DONE 2026-08-10 (§7)** | auto | `claude-sonnet-5` | medium |
| **T17.7** | Agent-routed composer: note / change-request / question → CMS Agent — *PDF, not in items 9–16* | auto | `claude-opus-5` | high |
| **T17.8** | Double-click-to-edit block inline, no panel step — *PDF, not in items 9–16* — **DONE 2026-08-10 (§7)** | auto | `claude-opus-5` | high |
| **T17.9** | Image-ref-specific comments (item 12) | auto | `claude-sonnet-5` | medium |
| **T17.10** | Notifications / digests (item 13) — delivery channel is a product decision, not an agent one | checkpoint | `claude-sonnet-5` | medium |
| **T17.11** | Per-role comment-visibility policy (item 14) — follows the existing `isOwner`/`resolveRolesFromEvent` pattern | auto | `claude-sonnet-5` | medium |
| **T17.12** | Review-decision linking (item 15) — ties threads to `object_review_decide` | auto | `claude-sonnet-5` | medium |
| **T17.13** | Headless-browser smoke test for the canvas annotation surface (item 16) | auto | `claude-sonnet-5` | medium |

~~`briefPath` is deliberately omitted: **T17.0 writes the briefs.**~~ **Done
2026-08-10:** the T17.3–T17.13 briefs exist in
`docs/cms-architecture/cms-pipeline/` and the rows are appended to `queue.tsv`
with resolved `briefPath`s, in execution order (Batch B first). Model column
there uses `claude-opus-5` / `claude-sonnet-5` as this table specifies.

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

## 7. Build log — what has actually landed

One entry per task, added in the same commit as the work (repo law: no record,
not done). Machine truth for the code is the files named; this section says
what changed and where a later task should look first.

### T17.3 — margin rail + hover-reveal bubbles + page-slide (2026-08-10)

- **New:** `packages/core/lib/edit-mode/rail-layout.ts` (+ `.test.ts`, 25
  cases) — the pure half: layout-mode selection, slide padding, rail x,
  the §8.1 top-down packer, anchor keys, thread bucketing
  (blocks / whole-object / orphans), stack collapsing.
- **`ui.ts`:** a `.dl-em-rail` `<aside role="complementary">` singleton beside
  the existing chip/panel/tray; hover-reveal at 120ms with the existing 250ms
  dismissal; click-or-focus pinning, one pinned bubble at a time, `Esc` /
  outside-click / close-control unpin; whole-object bubbles at the rail top,
  orphan bubbles at the bottom (split into "not on this page anymore" and
  "block deleted in a draft"); rail x from the widest **in-viewport**
  annotated region, remeasured with the slide off so the mode decision can
  never oscillate.
- **`ui-chrome.ts`:** `--dlem-rail-w/-gap/-pad`, `--dlem-gutter-x`, the rail /
  bubble / ghost-bubble / connector CSS, `body.dl-em-slide`'s
  `padding-right` (transitioned 180ms, skipped under reduced motion), and the
  sheet-mode rail. The panel's bottom-sheet breakpoint moved 720px → 900px to
  match `slideFloor` (brief's instruction).
- **Retired:** the panel's `comments` accordion section, `PanelMode`'s
  `'comments'` member and `openPanel`'s `isNav && mode !== 'comments'` special
  case. `mountMarginaliaPanel` was **moved, not rewritten** — it now mounts per
  bubble and gained one optional `selectThreads` list-transform so a bubble can
  show only its own anchor's threads (and collapse a stack); omitting it
  reproduces the accordion's behaviour exactly. The marginalia cache,
  `preloadRecords` warm-up and `invalidateMarginaliaThreads` are unchanged.
- **Not verified in a browser** (no browser in the build environment): the
  three layout modes at real viewport widths, the reveal/dismiss feel, and
  whether the chip/bubble stacking reads as intended. Everything mechanical is
  covered by the pure tests; the rest wants T17.13's smoke test or a human.

### T17.8 — double-click to edit a block inline (2026-08-10)

- **New:** `packages/core/lib/edit-mode/inline-edit.ts` (+ `.test.ts`, 20
  cases) — primary-field derivation from a block's own data (never a per-type
  map), the `event.detail >= 2` selection-suppression predicate, and the
  value→ops mapping, which is `suggestionToOps` and nothing else.
- **`ui.ts`:** a `dblclick` (and `Enter`-on-focused-block) handler mounts an
  editing surface in the block's own box — the grammar-bound TipTap editor for
  a `rich_text.v1` document (dynamically imported, so @tiptap stays out of the
  canvas's base chunk), a plain-text `contenteditable` otherwise. `⌘/Ctrl+↵`,
  blur or an outside click commit; `Esc` reverts. The commit is
  `EditSession.ensureCheckout()` → `patch` → `invalidateRecord` →
  `dl-em-draft` → `refreshPending()` — the panel's own path, with the same
  lock-refusal message and the same learning-trail attachment.
- **The three collisions (spec §5.3):** the `mouseup` selection capture skips
  (and *clears*) on `event.detail >= 2`, so a double-click can never leave an
  Ask-AI scope armed; other blocks' hover-reveal is suppressed while a block
  is being edited, and the edited block's own bubble is pinned; in-content
  anchors are `preventDefault`-ed.
- **Also extracted:** `editableUnitFor(target, body)` — the section/node
  resolution `openPanel` used to inline. One function, two callers, so the
  panel and the inline editor can never disagree about what a region edits.

Deviations, and why:

- **Preferred-key ordering.** The spec says "the first field `formFieldsFor`
  would render". Object key order in a stored record is incidental, so that
  rule makes double-clicking a paragraph edit the block's *heading* whenever
  `title` happens to be serialised first. The derivation prefers
  `body`/`text`/`title`/`heading` and only then falls back to first-eligible.
- **String arrays are not eligible.** A bullet list is not one value; a block
  whose only copy is `items` falls through to the panel, like an image node.
- **The surface replaces the block's rendered content** rather than making the
  rendered element itself `contenteditable`. The value then round-trips
  exactly (what goes in is what comes back), which matters more than caret
  fidelity given none of this could be driven in a browser here; the caret is
  still placed at the pointer via `caretRangeFromPoint`.
- **Navigation chrome is exempt from the link `preventDefault`.** Trapping an
  editor on one page for the duration of edit mode is not what §5.3 is for.
- **A committed `rich_text.v1` document is not previewed in place** — it is
  saved, the block is marked draft, and the pre-edit rendering stays until
  publish + release. Re-rendering it here would mean a second renderer beside
  `render-nodes.ts`, which the repo forbids. Plain and HTML fields DO preview,
  through the existing `previewFieldChange`.
- **Not verified in a browser:** the caret placement, the feel of the editing
  surface, whether `contenteditable="plaintext-only"` is honoured in Wolf's
  browser (a paste handler backstops it), and whether `tabindex` on a
  `display:contents` article-node wrapper is focusable at all — if it is not,
  the `Enter` path still works from any focusable descendant, and T17.6's
  gutter buttons give every block a real focus target.

### T17.6 — attention badges + the `Attention N` counter (2026-08-10)

- **New:** `packages/core/lib/edit-mode/attention.ts` (+ `.test.ts`, 13 cases)
  — the one definition of "needs attention" (`status === 'open'`, nothing
  else), per-block tallies, the page total, the §4.2 marker-state table and
  the markers' accessible names.
- **`ui.ts`:** a `.dl-em-gutter` layer of `<button>` markers at
  `blockLeft - var(--dlem-gutter-x)`, aligned to the block's top and
  repositioned on the same pass as the rail's bubbles; `Attention N` in
  `.dl-em-bar` next to `Pending N`; rail **list mode** (whole-object first,
  block threads in DOM order, orphans last under "Not on this page anymore",
  a row scrolls its block into view and pins its bubble); and the inline
  `· draft` chip.
- **`ui-chrome.ts`:** the gutter, marker states (open = filled
  `--dlem-draft` dot with the numeral; resolved-only = hollow, on hover only;
  no threads + hovered = accent dot), the draft chip and the list rows.
  `--dlem-danger` is deliberately untouched — T17.1 repointed it to the
  destructive rust and it stays reserved for destruction.
- **Counts refresh** on edit-mode activation, after every thread write, and on
  an `Attention` click. No background polling: spec §8.5 makes that a cost
  decision, not a UI one.

Deviations, and why:

- **The `· draft` chip is drawn in the gutter layer**, positioned at the end
  of the block's title line via a `Range`, rather than injected into the
  heading. Injecting a node into rendered copy would change the heading's text
  content and break `previewFieldChange`'s exact-text match — the in-place
  preview both the panel and T17.8 rely on. Visually the same; the dashed
  `.dl-em-draft` outline is untouched, as the brief requires.
- **Markers use each block's own leading edge**, clamped to ≥ 4px, rather than
  one page-wide `columnLeft`: full-bleed sections start at x = 0 and a single
  shared column would push their marker off-screen. In `sheet` mode the clamp
  is what puts the marker inline at the block's leading edge.
- **`aria-controls` can name a bubble that is not mounted yet** (a bubble only
  exists while revealed or pinned). The alternative was no `aria-controls` at
  all; the id is stable and correct the moment the bubble appears.
- **Explicitly NOT done:** the toolbar reduction to three pills (T17.6b —
  spec §10.1 — needs Wolf's call on where `Pending`, `Exit`, identity and the
  status line go; nothing was dropped or re-homed here), and the
  `≈ $1.42 · 3 runs` chip (spec §10.3 — no data source exists in core).
- **Not verified in a browser:** marker alignment against real first-line
  boxes, the draft chip's placement at the end of a wrapped heading, and the
  screen-reader path. The counts, states and labels behind all of it are
  covered by the pure tests.

### T17.14c — per-block draft provenance (2026-08-11)

`markDraftRegions` used to mark by OBJECT id: one unpublished node edit on an
article dashed-outlined and `· draft`-chipped **every** block sharing that id
(every block in the article), because every node in a `content_item` shares
its object id. `docs/design/marginalia-concept-b-final.pdf` shows exactly one
block carrying the chip.

- **New:** `packages/core/lib/edit-mode/draft-provenance.ts` (+
  `.test.ts`, 17 cases) — `changedUnitsSince(history)`, the SAME backwards
  walk `summarizeUnpublished` (the Pending tray) already does — stop at the
  last `publish`, skip `checkout`/`checkin`/`refresh_lock`, `create` ⇒
  whole-object — generalised from a phrase to a `{ wholeObject, nodeIds,
  sectionIds, resolved }` set; `provenanceUnitFor(target, record)`, which
  unit (node/section id) a rendered region corresponds to, including a shared
  section's own inner `record.body.section.id` (the region's page-side
  `data-cms-section-id` is the PAGE's reference id, not useful for matching
  the shared object's own history); and `regionIsDraft(pending, changed,
  unit)`, the per-region decision, composing the two.
- **`ui.ts`:** `markDraftRegions` now marks a region iff its object is
  pending AND (the change is whole-object OR the region's own node/section id
  is in the changed set); it reads records from the existing `cachedRecord` —
  the tray already warms every visible object's record on activation, so this
  is no new fetch. It is now `async` (one `cachedRecord` read per distinct
  pending object, not per region); its two call sites already `await` or
  `void` it correctly.
- **Fallback, explicit and tested:** whenever provenance can't be narrowed —
  unresolved history (none/empty), an unrecognised op shape, a whole-object
  op (`set_page_meta`, `create`, nav/site/product/term ops, …), or a region
  whose own unit couldn't be read (e.g. a shared section with no readable
  inner id) — the WHOLE OBJECT is marked, i.e. exactly the pre-fix behaviour.
  The fix can only ever be more precise than that; it never marks less than
  an honest "don't know" would.
- **R4's footer state pill is NOT wired here.** The brief
  (`T17.14c-per-block-draft-provenance.md`) depends on T17.14a for that row's
  DOM stub; T17.14a has not landed on any branch as of this commit (only its
  planning doc, `marginalia-affordance-model.md`, exists). Per `CLAUDE.md`'s
  own rule — an unmet `depends_on` is a stop-and-say-so, not an
  assume-it-exists — this task ships only the part that does not depend on
  it: the provenance module and `markDraftRegions`. The state pill is left
  for whichever task lands T17.14a's R4 stub.
- **Not verified in a browser:** the fix's own acceptance render (one node
  edit → one chip, on the PDF's article) and the discard-preview repaint at
  the second `markDraftRegions` call site. The provenance logic itself —
  `changedUnitsSince`, `provenanceUnitFor`, `regionIsDraft` — is covered
  headlessly.
