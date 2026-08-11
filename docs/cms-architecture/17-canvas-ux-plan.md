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
| **T17.14a** | Canvas affordance consolidation: the single hover/focus state machine + the bubble's anatomy, chip deleted — *Wolf's 2026-08-11 fold ruling; see §8* | auto | `claude-opus-5` | high |
| **T17.14b** | The block drawer's actions, the selection strip, panel↔rail coexistence — *the wave is not shippable without it* | auto | `claude-opus-5` | high |
| **T17.14c** | Per-block draft provenance — `· draft` on the block that actually changed | auto | `claude-sonnet-5` | medium |
| **T17.6b** | Toolbar reduction to the concept's three floating pills (spec §10.1, now urgent) | checkpoint | `claude-sonnet-5` | medium |

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

### W17 Fix 4 — the page moves again, in register (2026-08-11)

**Wolf's revision, verbatim**, on the displacement W17 Fix 1 had retracted that
morning:

> *"i think that text move the way it is done in canvas is not bad. my only
> concern is left side placed objects. so they can't all move the same way but
> they can move."*

Asked which "left side placed objects", he selected all three — left-aligned /
full-bleed page content, two-column / split sections, and the top bar and its
controls — and chose **"Keep it, fix the registration."** That supersedes the
morning's *"The article must never move"* and its articles-only carve-out. The
requirement is now: **the page may move to open the rail's margin; everything
must move with it.**

- **`rail-layout.ts`:** the `slide` rung is back, between `compact` and
  `inset`, gated on `railMayDisplaceContent(surface)` — the seam Fix 1 left
  behind, now `true` for both surfaces, still the only place an exemption
  would go. `railDisplacementFor(mode, metrics)` is the displacement: one
  rail + gap + pad (376px) or nothing, a function of the TOKENS alone.
  `slide` applies only while the page keeps a whole `sheetFloor` (900px) for
  itself, so `compact`/`markers` still serve genuinely narrow windows. Also
  new: `createRelayoutPass`, the named registry of positioners.
- **`ui.ts`:** `--dlem-shift` has exactly one writer; `applyDisplacement` has
  exactly one caller (`remeasureRail`, i.e. activation and resize).
  `measureNaturalColumnRight` lifts the displacement for the one synchronous
  reflow the measurement needs — without it the ladder reads back its own
  output and oscillates, and the test proves that loop is real.
  `contentChildren` skips out-of-flow children, which is what finally makes
  `contentRect` reach the content column on widget sections (`WidgetWrapper`
  renders an `absolute inset-0` background band as a second child, so the
  descent used to stop at the full-bleed `<section>`); `positionChip` and
  `desiredTopFor` now use `contentRect` like `markerPosition` already did, and
  the gap `+` takes its x from the content column.
- **`ui-chrome.ts`:** `body.dl-em-on{padding-right:var(--dlem-shift,0px)}` with
  a 180ms transition and the `dl-em-measuring` suppression; `--dlem-shift`
  compensation on every fixed surface that pins to the right edge (bar, fab,
  panel, tray, confirm — offsets and max-widths); `.dl-em-settling`, the hide
  used while the page is in flight.
- **`BackToTop.astro`:** the known straggler — `position:fixed` AND centred on
  the 720px column via `100vw`. The shift comes off the width the centring is
  computed from and back onto the offset; the variable defaults to `0px`, so a
  visitor's page is unchanged.
- **Nothing is positioned mid-transition**, both ways: every positioner returns
  early while the page is moving and the anchored overlays are hidden, AND the
  whole pass re-runs on `transitionend`/`transitioncancel`, with a timer
  backstop for `prefers-reduced-motion` (no transition, so no end event).
- **The invariant test was rewritten, not deleted:**
  `no-page-movement.test.ts` → `displacement-registration.test.ts`. It pins the
  new invariant — one displacement value, decided by geometry, written in one
  place, consumed by page, overlays and fixed chrome alike, unreachable from
  any hover/focus/pin/thread-write path, and every registered positioner run on
  one pass. Each assertion was mutation-checked (break the code, watch the
  named assertion fail, restore).

**Not verified in a browser** (there is none in this environment): the glide
itself at real viewport widths; whether the settle's hide-and-replace reads as
clean or as a flicker; the actual alignment of markers, bubbles, chips and gap
`+`s against real boxes after the page has moved; whether `transitionend` fires
where expected in Wolf's browser (the timer backstop covers it if not); and the
one-reflow cost of `measureNaturalColumnRight` on a large page. Everything
mechanical — the ladder, the displacement value, the writer's reachability, the
pass — is covered headlessly; the rest wants T17.13's smoke test or a human.

### T17.6b — the toolbar's reduction to floating pills (2026-08-11)

The PDF draws three pills at the viewport's top right — `● Editing`,
`Attention N`, `Release` — over the page. Today's `.dl-em-bar` was a
full-width sticky strip carrying seven things and pushing the page down
(`body.dl-em-on{padding-top:38px}`); W17 Fix 1 dropped that padding, which
turned the strip into an overlay covering the top of the article — the layout
defect that made this task urgent rather than cosmetic (spec:
`docs/design/marginalia-affordance-model.md` §7). **Wolf's ruling on the
brief's Q1, 2026-08-11: "keep 'exit' visible."** So the built toolbar is the
four-pill variant, not the PDF's three: `Exit` is its own always-visible pill,
never folded into the `● Editing` popover, a menu, or a hover state.

- **New:** `packages/core/lib/edit-mode/toolbar-layout.ts` (+ `.test.ts`, 12
  cases) — the pure half. `toolbarLayout({ pendingCount, attentionCount,
  canPublish })` returns the pill/popover row plan (`● Editing` ·
  `Attention N` · `Release` · `Exit`, in that order); `Release`'s disabled
  state and `title` (`Release to production` enabled, `Requires publisher
  role` disabled) come from `canPublish`, unchanged from today's role gate.
  `postStatus`/`fadeToast` are the toast's timing model: fading only ever
  flips `visible`, the `message` is never cleared — the retention rule a
  missed confirmation depends on.
- **`ui.ts`:** `.dl-em-bar`'s markup is now four `.dl-em-pill` buttons.
  Displaced controls' new homes — **nothing is deleted**:
  - **`Pending N`** → a row in the `● Editing` popover (`[data-em-tray-toggle]`,
    same tray, same behaviour), plus a numeral on the `● Editing` pill itself
    when the count is non-zero (Q2, built as proposed) — never hidden without
    opening anything.
  - **The signed-in email** → the popover's first row.
  - **The status line** → a transient toast (`role="status"
    aria-live="polite"`, `TOAST_VISIBLE_MS` = 4s), created once and never
    removed from the DOM so a screen reader announces every text change
    (Q3, built as proposed); the popover's status row keeps the same text
    unfaded, so a missed confirmation stays readable. `setStatus`'s
    signature is unchanged — only its sink is.
  - **`Exit`** → its own pill (Q1, Wolf's ruling above).
  - `Attention N` and `Release`'s role gate / confirm / release path are
    untouched.
  - The popover opens on the `● Editing` pill (`aria-haspopup="menu"
    aria-expanded`) and closes on `Escape`, an outside click, or activating
    the Pending row.
  - `RAIL_TOP` (the 46px constant) is now `railTopPx`, MEASURED off the pill
    cluster's `getBoundingClientRect().bottom + 8` inside `remeasureRail` —
    the same activation/resize cadence that decides everything else about the
    rail's layout — so it moves with the cluster instead of assuming its
    height. Fed through the existing `desiredTopFor` / `markerPosition` /
    `positionChip` / `anchorPanel` call sites; no second clearance constant
    was added.
- **`ui-chrome.ts`:** `.dl-em-bar` is now just the fixed positioning cluster
  (`top:10px;right:calc(10px + var(--dlem-shift,0px))`) — no background, no
  border, no padding of its own; every visible surface is a `.dl-em-pill`
  (glass-treated with the T17.2 tokens) or the `.dl-em-popover`/`.dl-em-toast`
  hung off it. Both the popover and the toast are children of `.dl-em-bar`
  and positioned `position:absolute`, so they inherit the cluster's fixed
  positioning — and its `--dlem-shift` compensation — for free, with no
  second `position:fixed` rule for `displacement-registration.test.ts`'s
  "every fixed surface is placed against the same displacement" guard to
  check. `.dl-em-panel`/`.dl-em-tray`'s own top offsets are untouched — out of
  this task's scope (`.dl-em-bar` and `RAIL_TOP` only).
- **Docs:** this entry; `marginalia-interaction-model.md` §10.1's banner moves
  from DESIGNED to BUILT.
- **Not verified in a browser:** the pills' actual visual placement and
  spacing; whether the cluster clears the site header at every viewport
  width; the popover's and toast's alignment under the cluster; the toast's
  fade timing as experienced, versus as tested. Everything mechanical — the
  plan `toolbarLayout` produces, the toast's retention rule, the
  `--dlem-shift` consumption, and the never-move/registration guard suite —
  is covered headlessly; `npm test` is 2150 + 144 green (was 2138 + 144; 12
  new cases), the never-move/registration suite included.

### T17.14a — one block, one affordance: the chip folded into the bubble (2026-08-11)

**Wolf's ruling, verbatim (2026-08-11):** *"Fold it into the bubble but it has
to make sense so you need to consider needed functionality for this canvas.
make it look native in the bubble."* Spec:
`docs/design/marginalia-affordance-model.md` §§2–4.

The canvas showed a block **two** affordances driven by **two** hover machines
that shared no state: the W7 chip (`hotRegion`, 0ms reveal, `chipHideTimer`)
and the T17.3 rail bubble (`revealedRegion`/`pinnedRegion`/`pinnedKey`, 120ms,
two more timers), coordinating only through `desiredTopFor` reading
`chip.offsetHeight`. `focusin` drove the rail alone, so a keyboard user got a
bubble and no chip — no pencil, no image, no role, no delete. The PDF contains
the bubble and nothing resembling the chip.

- **New:** `packages/core/lib/edit-mode/affordance-state.ts` (+ `.test.ts`, 23
  cases) — the pure half. `affordanceReduce(state, event, context)` implements
  §4.3's transition table and returns the next state plus what to do with the
  two timers and the focus; `revealDelayFor` is §4.2 (pointer 120ms, keyboard
  and programmatic 0ms — a focus is deliberate, so there is nothing to
  debounce); `DISMISS_MS` is T17.3's unchanged 250ms;
  `affordanceInvariantViolations` names §4.1's invariants so a test can say
  which one broke. ui.ts performs the effects; nothing here touches the DOM.
- **`ui.ts` — the chip is deleted.** `chip`, `renderChip`, `positionChip`,
  `clearChipSoon`, `chipHideTimer` and `hotRegion` are gone, and with them
  `desiredTopFor`'s `chipOffset` term (spec §8.1 declares it void), the two
  `positionChip` calls inside `layoutRail`, the `chip` entry in
  `anchoredSurfaces` and on the re-layout pass, `openPanel`'s and
  `deleteRegion`'s and `startInlineEdit`'s `chip.style.display = 'none'`, and
  every `chip.contains(...)` guard in the `mouseover` / `mouseup` / `focusin` /
  outside-click / `dblclick` / `Enter` listeners (now one `onCanvasSurface`
  helper). `nodeRoles`, `roleOf`, `ALGORITHM_LABELS`, `applyRelated` and
  `deleteRegion` stay — they are reused, not deleted; the two the drawer does
  not call yet carry a one-line `eslint-disable` naming T17.14b.
- **`ui.ts` — one machine.** `affordance` + `revealTimer`/`dismissTimer`
  replace all seven of the old state variables. `dispatchAffordance` is the
  single entry point (nothing else writes the state), fed by `mouseover`,
  `focusin`, click, the gutter marker, the ghost bubble, the footer chevron,
  the panel and the inline editor alike. Consequences worth naming: at most
  ONE block bubble exists at a time (the old revealed+pinned pair could paint
  two cards for two different blocks); the block's `dl-em-hot` outline is
  driven by the same state, so it can no longer disagree with the bubble; and
  a pending reveal for the block already being waited on is not restarted by
  the next `mouseover` on a child element.
- **`ui.ts` — the bubble's anatomy (§2).** `buildBubble` replaces the old head
  (title + `N open` + close) with:
  - **R1 identity row** — line 1 the resolved agent (`avatar` + `→ {name}` +
    muted `· via CMS Agent`) from `listProfiles` →
    `assignments.objects[objectId] ?? assignments.types[objectType] ??
    assignments.site_default`, one read-only cached call per mount that
    **creates nothing**, omitted entirely when nothing resolves; line 2 the
    block identity — the article node's kind, replaced by its ROLE
    (`Proof · educate`) when the record answers, or the section type — plus a
    `· shared` / `· site-wide` token. The monospace object id is retired from
    the resting surface to that line's `title` and to the drawer's header.
    Right slot: **`✎ edit directly`**, a dotted-underlined text action routing
    into T17.8's `startInlineEdit`, which already falls through to
    `openPanel(…, 'edit')` for a block with no single primary copy field —
    there is exactly one edit path, not two.
  - **R2 thread log** — `marginalia-panel.ts`'s log, with §2's three deletions:
    the per-thread status pill is kept only for non-open threads, the
    per-thread scope line is dropped (`describeMarginaliaAnchor` stays
    exported for list surfaces), and the always-visible `Resolve` button
    becomes a quiet `✓ Resolve` text action on the thread's LAST comment,
    revealed on hover/focus-within and **always in the tab order** (opacity,
    never `display:none`). The whole log is omitted when a block has no
    comments — the PDF's card has no empty-state line; `emptyLabel` stays in
    the API for list mode and orphan bubbles, which are lists and do need it.
  - **R3 composer** — placeholder unchanged; the `Send` word becomes the PDF's
    filled `ICON_SEND` glyph with the accessible name `Send comment` unchanged.
  - **R4 footer strip** — `{object title} · ⟨state pill⟩ ⌄`. Title from
    `trayLabelFor` (one function, two callers — its parameter is now
    `Pick<PendingObjectRow, 'object_type' | 'object_id'>` so a bubble can call
    it without inventing a pending row). Pill: `Draft · unpublished` from
    `PendingObjectRow.unpublished_changes`, else `Published · {date}` from the
    record's `publication.published_time`, else `Never published` — object
    level, matching the PDF; re-applied on every render, because a bubble
    outlives the save that changes it. This closes T17.14c's parked item.
  - **R5 the drawer shell** — behind the chevron, which pins first and opens
    second (a drawer on a surface that decays under the pointer is invariant
    3's violation). Its own header repeats the identity WITH the object id
    visible; T17.14a ships only `Delete block` (`deleteRegion` unchanged,
    same confirm modal, `--dlem-danger`), built on first open.
- **Keyboard parity (§4.4)** — the point of the exercise. `focusin` now feeds
  the same machine as `mouseover`, so focus reveals exactly what hover
  reveals. `gutterMarkerState`'s `hovered` input is `key === affordance.key ||
  focusWithin || markerFocused`: a block whose subtree has focus gets its
  marker (one `Tab` from the affordance) without every block adding a
  permanent tab stop, and a marker that has focus stays on screen, so the
  second `Escape` has something to return focus to. The marker is a real
  `<button>`, so Enter/Space come free and dispatch `markerActivate`
  (toggle + composer focus). Focus moves into the composer on an EXPLICIT pin
  only — marker, ghost bubble — and never on a hover reveal, a click inside
  the bubble, or the inline editor's own pin.
- **`ui-chrome.ts`:** the whole `.dl-em-chip` block is deleted; `.dl-em-alg` /
  `.dl-em-num` survive it because the drawer's `content_grid` group (T17.14b)
  reuses them. New: `.dl-em-bubble-id` / `-who` / `-agent` / `-block` /
  `-shared`, `.dl-em-avatar(-initials)`, `.dl-em-editlink`,
  `.dl-em-bubble-foot`, `.dl-em-foot-title`, `.dl-em-statepill` (+ its three
  states), `.dl-em-drawer-toggle`, `.dl-em-drawer` and its rows,
  `.dl-em-marg-resolve`. `.dl-em-bubble-head`/`-title` survive as list mode's
  only remaining users; `.dl-em-bubble-open` is gone with the head.
- **Guards:** `displacement-registration.test.ts`'s `POINTER_DRIVEN` list drops
  the three chip functions and the two rail hover timers and names
  `dispatchAffordance`, `pinRail` and `buildBubble` instead — the list is
  self-checking (a name that does not exist in ui.ts fails the test), so the
  "no pointer path may reach the displacement writer" invariant still covers
  every hover path. Nothing else about the displacement, the positioner
  registration or the fixed-rule compensation changed.
- **Deviations from the spec, and why:**
  - **`Escape` on a `revealed` bubble hides it.** §4.3 lists Escape only from
    `pinned`; leaving a focus-revealed bubble un-dismissable by keyboard was
    the wrong reading of silence.
  - **A hover on another block while one is PINNED does nothing.** §4.3 has no
    row for it; invariant 1 ("at most one non-hidden region") decides it.
    Clicking that block unpins AND reveals it in the same gesture, so the
    canvas is never left blank waiting for a pointer move.
  - **The bubble has no close `×`.** §2's anatomy has none and neither does the
    PDF; Escape, an outside click and the marker toggle all close it. List
    mode keeps its own close control — a list is not a block.
  - **The `N open` badge on the bubble head is gone** with the head. The
    gutter marker's numeral is the same quantity, in the PDF.
  - **A nav object's identity line reads `Menu`** — §2 says "for a section, the
    `sectionType`", and a navigation object has none.
  - **The block's hover outline now appears at 120ms, not 0ms**, because it is
    part of the one affordance. §4.2 deletes the 0ms reveal explicitly.
- **Deliberately unreachable for exactly one task:** image swap, role & intent,
  article settings, Ask AI and the `content_grid` algorithm/tiles/columns
  controls left with the chip. **T17.14b re-homes every one of them as drawer
  rows — the wave is not shippable without it.**
- **Not verified in a browser:** the card's actual look against the PDF (row
  order, spacing, the glass treatment of the new footer and drawer); whether
  the agent line wraps to two lines as the render shows; the drawer's push-down
  on the packer; the `✓ Resolve` action's reveal-on-hover; focus order inside a
  pinned bubble as experienced. What would verify it: T17.13's smoke test,
  which T17.14b extends with the fold's assertions. Everything mechanical —
  the transition table, the timer selection, the invariants, and the whole
  displacement/registration guard suite — is covered headlessly; `npm test` is
  2174 + 144 green (was 2151 + 144; 23 new cases).

## 8. T17.14 — canvas affordance consolidation (planned 2026-08-11)

**Wolf's ruling, verbatim**, asked whether to retire the W7 hover chip, fold it
into the margin bubble, or keep both:

> *"Fold it into the bubble but it has to make sense so you need to consider
> needed functionality for this canvas. make it look native in the bubble. this
> might be a bigger task for one single chat too, so evaluate if it needs to be
> planned first."*

And, of the canvas generally, the same day: *"make sure the main target objects
don't move. the idea is to keep everything like it is published."*

The design is [`../design/marginalia-affordance-model.md`](../design/marginalia-affordance-model.md).
It establishes **one block, one affordance**, specifies the bubble that can
carry the fold (identity row / thread / composer / footer strip / block
drawer), replaces the canvas's **two** independent hover state machines with
one, fixes per-block draft provenance, and designs the toolbar reduction. It
**supersedes [`../design/marginalia-interaction-model.md`](../design/marginalia-interaction-model.md)
§2.1 and §11 row 3** (which proposed keeping the chip) and **settles its
§10.1**.

**Sequencing (binding, same shape of argument as §5's Batch B).** T17.14a →
T17.14b are **strictly sequential, one session each, same agent** — they
rewrite the same hunks of `ui.ts` / `ui-chrome.ts`. **T17.14c may run in
parallel with T17.14b** in a separate worktree (disjoint hunks: `markDraftRegions`
/ `refreshPending` / `positionDraftChips` versus the drawer, `anchorPanel` and
`morphFromTile`), never before T17.14a. **The wave is not shippable without
T17.14b** — T17.14a removes the chip's image / role & intent / article-settings
/ Ask-AI / `content_grid` controls and T17.14b is what re-homes them. **T17.6b**
is independent of all three, must land **after** the `w17/fix1-no-move` change
(which drops `body.dl-em-on { padding-top: 38px }` and turns the full-width bar
into a page overlay), and is a `checkpoint` on **one** question: whether `Exit`
lives in the `● Editing` popover (three pills, as the PDF draws) or as a fourth
always-visible pill. T17.13 still runs last and gains the wave's assertions.

Honest sizing: **three sessions of work plus one checkpoint** — one full session
each for T17.14a and T17.14b, half a session for T17.14c, half for T17.6b once
unblocked. Running the wave **before** T17.7 is preferable (T17.7 then builds
its composer modes into the finished card), but it is not a hard dependency in
either direction; T17.7's brief gains two consequential edits either way — its
agent-identity bullet becomes "verify, don't rebuild" (T17.14a renders the
resolved agent already) and it **deletes** T17.14b's interim `Ask AI…` drawer
row.
