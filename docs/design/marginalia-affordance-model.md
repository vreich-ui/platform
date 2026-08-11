# Marginalia — the canvas affordance model (one block, one affordance)

**Status:** Buildable specification, written by T17.14 (2026-08-11). Planning
artifact — no code changed in the commit that introduced it.

**BUILD STATE (2026-08-11).** §§3 and 4 (the chip's inventory, the single state
machine) and §2's R1–R4 plus the R5 shell are **BUILT by T17.14a**; the
deviations that task had to make where this document is silent are listed in
its build-log entry (`../cms-architecture/17-canvas-ux-plan.md` §7). §2's
remaining R5 rows, R3's selection strip and §5.1's panel↔rail coexistence are
T17.14b. §6 shipped early as T17.14c. §7 shipped as T17.6b, with Wolf's Q1
answered "keep 'exit' visible" — four pills, not three.

**Governing ruling (Wolf, 2026-08-11), verbatim.** Asked whether to retire the
W7 hover chip, fold it into the margin bubble, or keep both:

> *"Fold it into the bubble but it has to make sense so you need to consider
> needed functionality for this canvas. make it look native in the bubble. this
> might be a bigger task for one single chat too, so evaluate if it needs to be
> planned first."*

And, of the canvas generally, in the same session:

> *"make sure the main target objects don't move. the idea is to keep everything
> like it is published."*

**So the fold is decided.** This document is the design of it, and §11 is the
honest answer to "is this one session?" (no — three, plus one checkpoint).

**Governing target:** [`marginalia-concept-b-final.pdf`](marginalia-concept-b-final.pdf),
in full, per Wolf's 2026-08-10 scope ruling
([`../cms-architecture/decisions/2026-08-10-canvas-ux-scope-ruling.md`](../cms-architecture/decisions/2026-08-10-canvas-ux-scope-ruling.md)).

**Relationship to [`marginalia-interaction-model.md`](marginalia-interaction-model.md)
(the T17.0 spec):** that document remains the specification for the rail,
anchoring, attention, inline edit, narrow screens and accessibility. This
document **supersedes its §2.1** ("keep the chip") and **§11 row 3**, and
**settles its §10.1** (the toolbar). Exact retraction wording: §8 below. Where
this document is silent, the T17.0 spec still governs.

**Convention, inherited unchanged:** where the PDF does not settle something,
the text says **"the PDF does not specify X; proposed: Y"** in bold and the
proposal is what an implementing task builds. Every such place is indexed in
§10. There are no silent inventions here.

---

## 0. The rule this document exists to establish

> **One block shows one affordance.**
>
> Hovering, focusing or working on a block reveals **exactly one** surface for
> that block — its margin bubble — plus its gutter marker. Nothing else appears
> beside a block. There is no second floating control cluster, no competing
> state machine, and no block that shows two things at once.

Today the canvas breaks this in three ways at once:

1. **Two affordances.** The W7 hover chip (`renderChip`, `ui.ts` ~1426) and the
   T17.3 rail bubble (`buildBubble`, ~1776) both appear for the same block.
2. **Two state machines with no shared state.** The chip reveals at 0ms on
   `mouseover` and decays through `chipHideTimer`; the bubble reveals at
   `RAIL_REVEAL_MS` (120ms) through `railRevealTimer` and decays through
   `railHideTimer`. They coordinate only by `desiredTopFor` reading
   `chip.offsetHeight` to push the bubble down — a layout hack standing in for
   a shared model. `focusin` drives the rail only, so a **keyboard user gets a
   bubble and no chip**, i.e. no pencil, no image, no role, no delete: the
   canvas is mouse-only for every non-comment action.
3. **Two visual languages.** The chip is a dense icon strip with a monospace
   object id; the bubble is the concept's glass card. The PDF contains the
   second and nothing resembling the first.

Wolf's phrase *"make it look native in the bubble"* is the constraint that
decides every question below: the bubble must not become the chip with a
border round it. The resting bubble stays what the PDF shows — identity,
conversation, composer, footer — and everything the chip carried is either
(a) promoted to one text action, (b) demoted behind the footer's disclosure,
or (c) retired because a better carrier already exists.

---

## 1. What the PDF actually shows of the bubble

Read at 220dpi from page 1. The bubble is the only block affordance in the
render; there is no chip anywhere on either page.

| Row | Content, verbatim | Notes |
| --- | --- | --- |
| 1 | A rounded-square avatar `DL` (indigo), then `→ Dr. Lurié Article Agent · via CMS Agent` wrapping to two lines; at the row's **top right**, `✎ edit directly` with a dotted underline | The agent name is bold ink; `· via CMS Agent` is muted. `✎ edit directly` is a **text action with a glyph**, not an icon button. |
| 2 | A bordered, rounded multi-line input, placeholder `Comment — a question, a change, an ask`, with its own scrollbar thumb; to its right a filled indigo rounded-square button carrying a send glyph `➤` | The composer is the bubble's centre of gravity — it is the largest element. |
| — | A full-width hairline divider between rows 2 and 3 | The only internal divider in the card. |
| 3 | `Retinol Without the Flake ·` then a green pill `Published · Aug 2`; at the far right a small chevron `˅` | Object title, object publish state, and a disclosure control. |

Two honest observations about the render:

- **The bubble shown is the empty state.** No comment appears in it. The card
  in the PDF is what a block with no thread looks like when the editor is
  about to write the first one. Where a thread's comments render is therefore
  **not settled by the PDF** (see §2, row R2).
- **The render clips the card's right edge** at the page boundary. The chevron
  is the last fully visible element. Nothing in the visible area suggests
  further controls to its right, and the composer's send button is complete,
  so the clip costs no information — but it is a clip, not a full view.

Elsewhere on the page, and load-bearing for this document:

- a bare **speech-bubble affordance** (`💬`) in the rail beside the hovered
  checklist — a block with no thread, hovered: the ghost bubble that
  `buildGhostBubble` already implements;
- two **orange numeral gutter markers** (`1`) and small hollow dots on other
  blocks — `renderGutter`, already built;
- the inline **`· draft`** chip beside `The two-night rule` — `positionDraftChips`,
  already built, but marking the wrong set of blocks (§6);
- the three-pill toolbar `● Editing` / `Attention 2` / `Release` (§7).

---

## 2. Bubble anatomy

Top to bottom, at the rail's `--dlem-rail-w: 344px`. `R5` is the only part not
visible at rest.

```
┌──────────────────────────────────────────────────────┐  .dl-em-bubble
│ ⬤DL  → Dr. Lurié Article Agent ·      ✎ edit directly│  R1  identity row
│       via CMS Agent                                  │
│       Proof · educate · shared                       │
├──────────────────────────────────────────────────────┤
│  Wolf · 2 days ago                                   │  R2  thread log
│  Can we soften the "graveyard" line?                 │      (omitted entirely
│                                    ＋3 earlier       │       when the block has
│  Dr. Lurié Article Agent · 1 day ago                 │       no comments — the
│  Softened. Draft rev 24.               ✓ Resolve     │       PDF's state)
├──────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────┐   ┌───────┐ │  R3  composer
│ │ Comment — a question, a change,      │   │   ➤   │ │
│ │ an ask                               │   └───────┘ │
│ └──────────────────────────────────────┘             │
├──────────────────────────────────────────────────────┤
│ Retinol Without the Flake · ⟨Published · Aug 2⟩     ⌄│  R4  footer strip
└──────────────────────────────────────────────────────┘
                                                    ⌄ opens
┌──────────────────────────────────────────────────────┐  R5  block drawer
│  🖼  Image…                                           │      (only the rows
│  🏷  Role & intent…                                   │       that apply to
│  🏷  Article settings…                                │       this block)
│  ✨  Ask AI…                              interim     │
│  Related articles   ⟨Similar ▾⟩ ⟨4⟩ tiles ⟨2⟩ cols   │
│ ──────────────────────────────────────────────────── │
│  🗑  Delete block                                     │
└──────────────────────────────────────────────────────┘
```

### R1 — identity row: *who this is about, and who an ask goes to*

A two-slot flex row. Left column, top-aligned:

- **Line 1 — the agent route**, exactly the PDF: avatar (`avatar_artifact` from
  the resolved profile, initials fallback), `→ {profile.name}`, then muted
  `· via CMS Agent`. Resolution is `listProfiles(getToken)` →
  `assignments.objects[objectId] ?? assignments.types[objectType] ??
  assignments.site_default`, matched into `profiles` — a read-only call that
  creates nothing (T17.0 spec §6.3). **If no profile resolves, line 1 is
  omitted entirely.** Never a placeholder name.
- **Line 2 — the block identity**, muted, 10.5px: for an article node, the
  block's **role** (`Hook`, `Proof`, `Resolution` …) plus `· intent` — the
  string `roleOf()` already computes and today's chip shows as `Example ·
  educate`. For a section, the `sectionType`. Followed by a `· shared` /
  `· site-wide` token when `target.shared`, because that is a safety signal
  ("affects every page using it") and it must not be lost.
  **The PDF does not show a block identity line; proposed as stated** — the
  role at the moment of action is a standing Wolf ruling (2026-07-13,
  recorded in `renderChip`'s own comment) and the bubble is now the only place
  it can live.

Right slot, top-aligned: **`✎ edit directly`** — a text action with a pencil
glyph and a dotted underline, per the PDF. It is the pencil tool's new home and
it enters T17.8's inline editor on the anchored block (§5).

The **monospace `sec_…` / `req_…` object id the chip prints is retired from
the resting surface.** It moves to the `title` attribute of line 2 (the same
place `openPanel`'s header already keeps it: `title="${target.objectId}"`) and
to the drawer's own header. An id is provenance, not an affordance.

### R2 — thread log: *the conversation, when there is one*

Rendered by `mountMarginaliaPanel`'s existing log (`.dl-em-marg-log`),
unchanged in fetch/compose semantics. **Omitted entirely when the block has no
comments** — no "No comments on this block yet." line at rest; the PDF's card
has no empty-state text and the ghost bubble already means "nothing here yet".
`emptyLabel` stays in the API for list mode and orphan bubbles, which do need
it.

Three pieces of admin furniture in today's thread rendering are **deleted**:

| Deleted | Why it is safe |
| --- | --- |
| The per-thread `Open` status pill (`.dl-em-marg-status`) | Redundant on a canvas that already carries open-ness twice: the gutter marker's numeral and the footer's state. It is kept for **non-open** threads, where it reads `Resolved` / `Dismissed` and is genuine information. |
| The per-thread scope line (`describeMarginaliaAnchor` → `Section sec_x` / `Node req_y`) | The bubble *is* the scope — it hangs off the block, with a connector when packing displaced it. Printing the internal id beside every comment is the accordion's habit, not the concept's. `describeMarginaliaAnchor` stays exported and in use by `MarginaliaThreadList.tsx` (admin side, untouched) and by rail **list mode**, where rows genuinely need a "where". |
| The always-visible per-thread `Resolve` button (`.dl-em-marg-toggle`) | Becomes a quiet `✓ Resolve` text action on the thread's **last** comment row, revealed on `:hover`/`:focus-within` of the thread, and **always present in the tab order** (visually quiet ≠ absent from the a11y tree). Same handler, same `setMarginaliaThreadStatus` call. Reopen behaves identically on a resolved thread. |

Long threads keep T17.0 spec §8.4: first + last + `＋N earlier`
(`collapseThreadStack`, already built), `max-height: 38vh` as
`.dl-em-bubble .dl-em-log` already sets.

### R3 — composer

Verbatim from the PDF and already correct in code: the textarea's placeholder
is `Comment — a question, a change, an ask` (passed as `composerPlaceholder`
from `buildBubble`). Two changes:

- The `Send` **text button becomes the PDF's filled send glyph** — `ICON_SEND`
  already exists in `ui-chrome.ts`; the accessible name stays `Send comment`.
- **Selection scoping surfaces here.** When a text selection exists inside this
  bubble's block (`currentSelectionText` / `selectionRegion`, already tracked),
  a one-line quotation strip renders above the field — `“…first 60 chars…” ✕` —
  and the ask is scoped to it. Today that state is carried by the chip's
  `dl-em-sel` highlight on the sparkle button, which has nowhere else to go.
  **The PDF does not show a selection state; proposed as stated.** T17.4 (span
  anchoring) will make the same strip the anchor of a span-scoped thread; the
  strip is designed once, here, so T17.4 does not invent a second one.

The three composer **modes** (note / change request / question) are T17.7 and
are not built by the fold. Interim behaviour: §9.

### R4 — footer strip: *what object this is, and where it stands*

`{object title} · ⟨state pill⟩` and a disclosure chevron, exactly the PDF's
`Retinol Without the Flake · Published · Aug 2  ˅`.

- **Title:** `trayLabelFor`'s logic, which already renders a human name for all
  ten governed types (article title, page title/route, `Shared section: type`,
  `Header menu`, `Site settings`, …). One function, two callers — do not write
  a second one.
- **State pill:** `Published · {date}` (green) from the record's
  `published_time`; `Draft · unpublished` (gold, `--dlem-draft`) when the
  object's `PendingObjectRow.unpublished_changes` is true; `Never published`
  otherwise. Object-level, not block-level — matching the PDF, which shows the
  article's state, not the paragraph's. Per-block draft state is the inline
  `· draft` chip and the dashed outline (§6).
- **Chevron:** opens R5. **The PDF does not specify what the chevron does;
  proposed: it is the block drawer** — which is what makes the fold possible
  without turning the resting card into a control panel.

### R5 — the block drawer: *everything else the block can do*

Expanded in place, pushing the footer down; the packer (`packRailEntries`)
re-runs, so neighbouring bubbles move out of the way as they already do. Rows
are **labelled text rows with a leading glyph**, not an icon strip — that is
the difference between "native in the bubble" and "the chip, relocated".

Contents are computed per block, in this order, omitting what does not apply:

| Row | Condition | Action |
| --- | --- | --- |
| `Image…` | `region.dataset.cmsNodeKind === 'content'`, or `IMAGE_SECTION_TYPES.has(sectionType)` — the exact `hasImage` predicate `renderChip` uses today | `openPanel(target, region, 'image')` |
| `Role & intent…` | article nodes (`isNode`) | `openPanel(target, region, 'role')` |
| `Article settings…` | `content_item` blocks | `openPanel(target, region, 'meta')` |
| `Ask AI…` | not `isNav`; **interim only** — removed by T17.7 (§9) | `openPanel(target, region, 'ai')`, carrying the selection scope if one is armed |
| `Related articles` group | `region.dataset.cmsRelatedAlgorithm` present | the existing algorithm `<select>` + tiles + columns number inputs, with visible labels, wired to the unchanged `applyRelated` |
| — hairline — | | |
| `Delete block` | not `isNav` | `deleteRegion(target, region)`, unchanged, behind the existing confirm modal, styled with `--dlem-danger` (T17.1's corrected destructive rust) |

The drawer's own header line repeats the block identity with the object id
visible (`Proof · educate · req_…`), because a drawer is where provenance
belongs.

**Article settings is not a regression, it is a fix.** Today `'meta'` is
reachable **only** by opening the panel with some other tool and then clicking
the `Article settings` accordion head — it has no chip button at all. Giving it
a drawer row makes it reachable in one gesture for the first time.

---

## 3. Where every chip function goes

The full inventory of `renderChip`'s output, one line at a time. "Retired"
means the function stops existing as an affordance, with the reason it is safe.

| Chip element | Code today | New home |
| --- | --- | --- |
| Identity — `sectionType` / node kind, replaced async by the role (`Example · educate`) | `typeSlot` + `nodeRoles()` fill | **R1 line 2.** Same string, same `nodeRoles` cache, same async fill — the "stale fill" guard (`if (hotRegion !== region) return`) becomes `if (state.region !== region) return`. |
| Monospace object id | `idSlot` / `.dl-em-id` | **Retired from the resting surface.** Moves to R1 line 2's `title` and the drawer header. Safe: it is provenance an editor never acts on, it is one hover away, and `openPanel`'s header already treats it exactly this way. |
| `shared` / `site-wide` badge | `.dl-em-shared` | **R1 line 2**, as a `· shared` token. Not retired — it is a blast-radius warning. |
| Gold `draft` badge | `.dl-em-draftflag` | **Retired from the affordance.** Draft state has two better carriers already built and both are in the PDF: the inline `· draft` chip in the content flow (`positionDraftChips`) and the dashed `.dl-em-draft` outline. The bubble's R4 pill carries the *object's* state. Safe **only once §6 lands** — today the inline chip appears on every block of the article, so retiring the badge before §6 would make block-level draft state *less* precise, not more. Sequencing consequence: §6 ships in the same wave, and until it does the badge is retired but the outline stays. |
| Pencil — *Edit text* | `.dl-em-edit` → `openPanel(…, 'edit')` | **R1's `✎ edit directly`**, entering T17.8's inline editor. Blocks with no single primary copy field (image nodes, grids, string-array-only blocks — `derivePrimaryInlineField` returns `undefined`) fall through to `openPanel(…, 'edit')`, which is T17.8's existing documented rule (spec §5.1). |
| Image | `.dl-em-img` → `openPanel(…, 'image')` | **R5 drawer row.** |
| Tag — *Role & intent* | `.dl-em-role` → `openPanel(…, 'role')` | **R5 drawer row.** |
| Sparkle — *Ask AI* (+ `dl-em-sel` when a selection is armed) | `.dl-em-ask` → `openPanel(…, 'ai')` | **Retired at T17.7**, when the composer's *Ask for a change* / *Ask a question* modes become the canvas's way to put a request to the agent — the whole point of the concept's composer. **Interim: an `Ask AI…` drawer row** with identical behaviour, so no capability is lost for a single day. The selection highlight becomes R3's quotation strip. |
| Trash — *Delete* | `.dl-em-del` → `deleteRegion` | **R5 drawer row**, last, below a hairline, destructive-tokened. Confirm modal unchanged. |
| `content_grid` selection algorithm `<select>` | `[data-em-alg]` → `applyRelated` | **R5 `Related articles` group**, now with a visible label instead of a `title` attribute. |
| `content_grid` tile count | `[data-em-tiles]` | Same group, labelled `tiles`. |
| `content_grid` column count | `[data-em-cols]` | Same group, labelled `cols`. |
| The chip element itself, its positioning and its decay | `chip`, `positionChip`, `clearChipSoon`, `chipHideTimer`, `hotRegion`, `.dl-em-chip` CSS | **Deleted.** With them go: `positionChip`'s `railLeftPx + RAIL_W - width` right-alignment branch, `desiredTopFor`'s `chipOffset` term, `openPanel`'s `chip.style.display = 'none'`, `deleteRegion`'s `chip.style.display = 'none'`, the `chip.contains(element)` early returns in the `mouseover` and `mouseup` listeners, and `morphFromTile`'s source rect (§5). |

**Nothing in the chip is dropped without a home except three things**, and each
is deliberate: the monospace id (demoted to a tooltip), the gold `draft` badge
(replaced by two better carriers), and the Ask-AI *button* (replaced by the
composer at T17.7, with a drawer row bridging the gap).

---

## 4. The single hover/focus state machine

Two machines become one. The rail's model already has the right shape — it has
pinning, a single slot, and the keyboard path — so this is the chip's model
being deleted and the rail's being generalised to own the whole affordance.

### 4.1 The state

One object, replacing `hotRegion`, `chipHideTimer`, `revealedRegion`,
`pinnedRegion`, `pinnedKey`, `railRevealTimer` and `railHideTimer`:

```ts
type AffordancePhase = 'hidden' | 'revealed' | 'pinned';

type AffordanceState = {
  phase: AffordancePhase;
  /** The block the affordance addresses; undefined iff phase === 'hidden'. */
  region?: HTMLElement;
  /** Its anchor key — rail-layout.ts's marginaliaAnchorKey, already the rail's identity. */
  key?: string;
  /** What put it in this phase; drives timing (pointer waits, keyboard does not). */
  source: 'pointer' | 'keyboard' | 'programmatic';
  /** R5 open. Reset to false on every region change. */
  drawerOpen: boolean;
  revealTimer?: number;
  dismissTimer?: number;
};
```

Invariants, each of which is a test:

1. **At most one non-hidden region on the page.** (Today's `pinnedKey` single
   slot, extended to reveal.)
2. `phase === 'hidden'` ⟺ `region === undefined`.
3. `drawerOpen` implies `phase === 'pinned'` — a drawer cannot live on a
   surface that decays under the pointer.
4. While `inlineEdit` is active on region R, R is pinned and **no other region
   may leave `hidden`** (T17.0 spec §5.3, already implemented in
   `scheduleRailReveal`).
5. The gutter marker's rendered state (`gutterMarkerState`) reads
   `state.region === thisRegion || state.key === thisKey` — one source, so a
   marker can never disagree with a bubble again.

### 4.2 Timers

| Constant | Value | Applies to |
| --- | --- | --- |
| `REVEAL_MS` | **120** | pointer only. The chip's 0ms reveal is **deleted** — it is the flicker the 120ms existed to suppress, and running both meant the canvas flickered anyway. |
| `DISMISS_MS` | **250** | pointer only. Today's `RAIL_DISMISS_MS`, which `clearChipSoon` also used. Unchanged. |
| keyboard | **0** | `focusin` reveals immediately: a keyboard focus is deliberate, so there is nothing to debounce. |

### 4.3 Transitions

| Event | From | To | Notes |
| --- | --- | --- | --- |
| `mouseover` resolving to region R (innermost-first: `NODE_SELECTOR` → `REGION_SELECTOR` → `NAV_SELECTOR`, unchanged) | `hidden`, or `revealed(other)` | schedule reveal → `revealed(R, pointer)` | Cancels any pending dismiss. A pending reveal for a different region is replaced, not queued. |
| `mouseover` inside the rail, a bubble, the drawer, the gutter or the panel | any | unchanged | Cancels the dismiss timer. The `chip.contains(...)` arm of this guard is deleted with the chip. |
| `mouseover` resolving to no region | `revealed` | schedule dismiss → `hidden` | |
| `mouseover` resolving to no region | `pinned` | unchanged | Pinning is what survives hover-out. |
| `focusin` on R, on R's gutter marker, or on any descendant of R | not `pinned` | `revealed(R, keyboard)` immediately | Existing `focusin` listener, extended to also drive the marker's state (it drives the rail only today). |
| `Enter` / `Space` on the gutter marker | `revealed(R)` | `pinned(R)` + focus moves to R's composer | Existing marker `click` handler; `<button>` gives Space/Enter free. |
| `click` or `focusin` inside R's bubble | `revealed(R)` | `pinned(R)` | Existing `mousedown`/`focusin` handlers in `buildBubble`. |
| `click` on the gutter marker | `pinned(R)` | `hidden` | Toggle — today's behaviour. |
| `click` on the ghost bubble | `revealed(R)` | `pinned(R)`, composer focused | Today's `buildGhostBubble` handler plus the focus move. |
| `click` on the footer chevron | `pinned(R)` | `pinned(R)`, `drawerOpen = !drawerOpen` | On a `revealed` bubble the click pins first, then opens — one click, two effects, because a drawer on a decaying surface is invariant 3's violation. |
| `dblclick` on R, or `Enter` on focused R | any | `pinned(R)` + inline edit | T17.8's path, unchanged, with the pin made explicit rather than incidental. |
| `Escape` | `pinned` + `drawerOpen` | `pinned`, drawer closed | **First Escape closes the drawer.** |
| `Escape` | `pinned` | `hidden`, focus returns to R's gutter marker | Today's handler, plus focusing the marker rather than the region (a `display:contents` article wrapper may not be focusable — T17.8's build log flagged exactly this; the marker always is). |
| `Escape` | inline edit active | reverts the edit, stays `pinned(R)` | T17.8's rule wins; a second Escape then unpins. |
| `click` outside the bubble and outside R | `pinned` | `hidden` | Today's handler; the `chip.contains` arm is deleted. |
| pin a different region | `pinned(R)` | `pinned(R2)`, `drawerOpen = false` | |
| the panel opens for R | any | `pinned(R)`, rail yields (§5) | |

### 4.4 Keyboard parity — the whole point of doing this

The current split leaves keyboard users with no pencil, no image, no role, no
delete. After the fold **every action is in the bubble, and the bubble is
focus-revealed**, so parity is structural rather than something each action has
to remember.

- Every annotated block's **gutter marker is a real `<button>`** with
  `aria-label` from `markerAriaLabel`, `aria-expanded` reflecting
  `phase === 'pinned'`, and `aria-controls` naming the bubble (`bubbleDomId`) —
  all already built.
- **A block with no threads gets its marker rendered, and therefore focusable,
  whenever the block or its subtree has focus** (`gutterMarkerState`'s
  `hovered` input becomes `hovered || focusWithin`). So a keyboard user who
  lands anywhere in a block is one `Tab` from its affordance, and blocks with
  nothing to say do not each add a permanent tab stop to a 40-block article.
  **The T17.0 spec §9 does not settle tab-order volume; proposed as stated.**
- Inside a pinned bubble the tab order is R1's `✎ edit directly` → R2's
  `✓ Resolve` actions and `＋N earlier` → R3's composer → send → R4's chevron →
  R5's rows when open. `Shift+Tab` from the first control returns to the
  marker.
- Focus is **moved into the composer** on an explicit pin (Enter/Space on the
  marker, ghost-bubble click) and **not moved** on a hover reveal.
- The status line keeps `aria-live="polite"` wherever §7 re-homes it. This is a
  hard requirement, not a nicety: save/resolve confirmations are the only
  feedback some actions give.

---

## 5. Bubble, docked panel, inline editing — who owns the surface

Three surfaces survive the fold. They are not alternatives; each is right for a
different shape of work.

| Surface | Right when | Reached by |
| --- | --- | --- |
| **Inline edit** (`richtext-editor.ts` / contenteditable, in the block's own box) | Changing **one copy field** — the overwhelmingly common case | double-click, `Enter` on the focused block, `✎ edit directly` |
| **Bubble** (the rail) | Talking *about* the block: threads, routed asks; and choosing a less-common action from R5 | hover, focus, gutter marker, ghost bubble |
| **Docked panel** (`.dl-em-panel`) | **Multi-field or non-copy** work: image upload/selection, role & intent, article settings, the Ask-AI transcript with its accept/reject in-place preview, the navigation editor | **only** from R5, and from the gap layer's insert flow |

The panel is not retired and must not be: it hosts the Ask-AI proposal loop
(`log`, `suggestionActions`, `previewFieldChange`, accept → `EditSession.patch`),
the nav grammar editor, and the taxonomy pickers. None of those fit a 344px
margin card, and shrinking them into one would be the exact "control panel"
outcome Wolf's *make it look native* rules out.

### 5.1 When two want the same space

`anchorPanel` currently places the panel at `rect.right + 14` — **the rail's
exact slot** — with no rail awareness at all, so today a panel and a bubble can
be drawn on top of each other. Rule:

1. **The panel takes the rail's column.** `anchorPanel` becomes rail-aware:
   `left = railLeftPx ?? (clamped rect.right + 14)`, `top = max(RAIL_TOP,
   rect.top)`, width `min(372, RAIL_W)` so it never exceeds the column the rail
   already reserved. In `slide` mode the padding is already applied, so
   **nothing on the page moves when the panel opens** — Wolf's no-movement
   ruling, satisfied structurally rather than by care.
2. **The rail yields while a panel is open**: `rail` gets `dl-em-rail-yield`
   (bubbles hidden, gutter markers unaffected). The affordance state stays
   `pinned(R)`, so closing the panel restores exactly the bubble that was
   there.
3. **Precedence, highest first:** inline edit (occupies the block, not the
   column) > panel > pinned bubble > revealed bubble > ghost bubble. Only one
   of {panel, bubble} is ever painted in the column.
4. In `sheet` mode (`< 900px`) both are the bottom sheet already; the panel
   wins and the rail stays collapsed.
5. `morphFromTile` animated the panel out of the chip's rect. With the chip
   gone its source becomes **the drawer row's rect**, falling back to the
   bubble's rect, falling back to no morph. Reduced-motion gating unchanged.

---

## 6. Per-block draft provenance

**The defect.** `markDraftRegions` marks by **object id**:

```ts
const draftIds = new Set(pendingRows.filter((row) => row.unpublished_changes).map((row) => row.object_id));
… region.classList.toggle('dl-em-draft', Boolean(objectId && draftIds.has(objectId)));
```

An article is one object, so **one unpublished change marks every block in the
article** — a dashed outline on all of them and, since T17.6, a `· draft` chip
beside every heading. The PDF shows exactly one: `The two-night rule · draft`.

**The fix, and it needs no new data.** The Pending tray already reconstructs
per-op identity: `summarizeUnpublished` walks `record.history` backwards until
the last `publish` entry, and `phraseForEntry` reads
`entry.details.op.node_id` and `entry.details.op.section_id` off each op to say
"Text edited in Hook". The same walk yields the changed **set**.

Proposed: a new pure module `packages/core/lib/edit-mode/draft-provenance.ts`
exporting

```ts
export type ChangedUnits = {
  /** Ops that dirty the object as a whole (create, set_page_meta, set_site_fields, …). */
  wholeObject: boolean;
  nodeIds: Set<string>;
  sectionIds: Set<string>;
  /** False when history was unavailable/unreadable — caller falls back. */
  resolved: boolean;
};

export const changedUnitsSince = (history: readonly HistoryEntry[]): ChangedUnits;
```

with the identical loop shape as `summarizeUnpublished` (stop at `publish`,
skip `checkout`/`checkin`/`refresh_lock`, `create` ⇒ `wholeObject`). Op → unit
mapping: `update_node` / `upsert_node` / `remove_node` ⇒ `node_id`;
`update_section_data` / `upsert_section` / `remove_section` / `move_section` ⇒
`section_id`; `set_page_meta`, `set_site_fields`, `set_site_brand_tokens`,
every nav op, every product/term op ⇒ `wholeObject`.

`markDraftRegions` then marks a region iff its object is pending **and**
(`wholeObject` **or** its `nodeId`/`sectionId` is in the changed set). Records
are already warm — `preloadRecords` fetches every page object's record on
activation and `fillTrayRow` reads the same cache — so this costs no new
request.

**Fallbacks, stated so the behaviour is never a mystery:**

- `resolved === false` (no history on the record, or an unrecognised op shape)
  ⇒ mark the whole object, i.e. today's behaviour. The fix can only ever be
  more precise, never wrong in a new way.
- A `remove_node` names a block that no longer renders; it is already handled
  by `.dl-em-removed` and contributes nothing.
- Ops performed by an agent through MCP land in the same history, so the
  provenance is not canvas-only.

Consequences that ship with it: R4's state pill (object-level) and the
retirement of the chip's gold `draft` badge (§3) both depend on this being
correct, and the `· draft` chip finally means what the PDF shows it meaning.

---

## 7. The toolbar (T17.6b) — and the part Wolf must approve

### 7.1 Why this is newly urgent

The T17.0 spec parked the toolbar as "unassigned" (§10.1) and T17.6 explicitly
did not touch it. The in-flight no-movement change (branch `w17/fix1-no-move`)
removes all page movement and drops `body.dl-em-on { padding-top: 38px }`.
**The full-width bar will therefore overlay the page instead of pushing it
down** — a 38px strip of glass across the top of the article, permanently
covering whatever is under it. That is no longer a cosmetic mismatch with the
PDF; it is a layout defect the moment that change lands.

The PDF's answer is already drawn: **three floating pills at the top right** —
`● Editing`, `Attention 2`, `Release` — over the page, with the article
untouched beneath them.

### 7.2 What exists today

`.dl-em-bar`, `position: fixed; top/left/right: 0`, carrying, in order: an
accent dot, `Edit mode`, the signed-in email (`.dl-em-who`), a centred
flexible status line (`[data-em-status]`), `Pending N`
(`[data-em-tray-toggle]` → the tray), `Attention N` (`[data-em-attention]` →
rail list mode), `Release to production` (`[data-em-release]`, role-gated by
`canExecutePublish`), and `Exit` (`[data-em-exit]` → `setEditMode(false)`).

Seven things. The PDF has three.

### 7.3 The proposed reduction

The bar becomes a **floating pill cluster**: `position: fixed; top: 10px;
right: 10px; display: flex; gap: 8px`, glass-treated with the T17.2 tokens, no
full-width background, no border-bottom, and **no `padding-top` on `body`** —
consistent with the no-movement ruling.

| PDF pill | Carries | Detail |
| --- | --- | --- |
| **`● Editing`** | the accent dot + label, and it is a **`<button aria-haspopup="menu">`** | Opens a small popover anchored under it: the signed-in email; the last status line; `Pending N` (opening the existing tray, unchanged); and **`Exit`**. |
| **`Attention N`** | unchanged behaviour | Restyled as an outlined pill with the count badge; still toggles rail list mode. |
| **`Release`** | `Release to production`, shortened to the PDF's label | Full phrase kept as the `title`; disabled state and `canExecutePublish` gate unchanged. |

Re-homing, control by control — **nothing is deleted**:

- **`Pending N`** → a row in the `● Editing` popover, opening the same tray.
  The count also stays visible without opening the popover, as a small numeral
  on the `● Editing` pill when non-zero (the tray is where drafts are
  published, so its count must not become invisible).
- **Signed-in email** → the popover's first line. It is orientation, consulted
  approximately never; it is the single largest consumer of bar width today.
- **Status line** → a **transient toast** under the pill cluster, `role=status`
  `aria-live="polite"`, fading after ~4s, with the last message retained in the
  popover so a missed confirmation is still recoverable. The live region must
  exist continuously in the DOM, not be created per message, or screen readers
  will not announce it.
- **`Exit`** → the popover. **This is the one that needs Wolf's yes/no** (§7.4).

Two mechanical consequences for the rail:

- `RAIL_TOP` (46px, the rail's top clearance under the old bar) becomes
  *measured* from the pill cluster's bottom + 8px, so the first bubble and the
  first gutter marker never sit under the pills.
- The pills overlay page content at the top right. The PDF's pills do the same,
  so this is settled by the concept and needs no mitigation.

### 7.4 **Needs Wolf's yes/no before T17.6b starts**

Wolf approved *"fold the chip into the bubble"*. He did **not** approve
re-homing the toolbar's controls; the T17.0 spec deliberately parked that, and
the point below is a genuine usability trade, not an implementation detail.

> **Q1 — Where does `Exit` live?**
> **(a) In the `● Editing` popover** — one click, always the same place, and
> the toolbar matches the PDF exactly (three pills). *Proposed.*
> **(b) A fourth pill, `Exit`, always visible** — zero clicks, but the toolbar
> is then four pills where the concept shows three.
> Wolf's own instruction was "Exit especially must remain reachable"; both
> options keep it reachable, (a) at one click, (b) at zero. This document
> proposes (a) and will build (b) instead on one word.

Two lesser calls, defaulted so they do not block:

> **Q2 — `Pending N`:** into the popover with a numeral on the `● Editing`
> pill (proposed), or merged onto the `Release` pill as `Release · 3`?
> Defaulting to the former, because it does not change what clicking `Release`
> does.
>
> **Q3 — the status line as a fading toast** (proposed) or a permanently
> visible line under the pills? Defaulting to the toast, since a permanent line
> reintroduces the strip the PDF removes.

T17.6b is queued as **`checkpoint`** for exactly this reason: it does not start
until Q1 is answered.

---

## 8. What this contradicts, and the exact retraction

### 8.1 `marginalia-interaction-model.md` §2.1 — RETRACTED

The paragraph as written:

> The existing hover chip (pencil / image / role / Ask-AI / delete) is
> **unchanged** and continues to appear at the block's right. **The PDF does not
> show the hover chip at all;** it shows only the bubble. **Proposed: keep the
> chip.** It is the entry point for every non-comment canvas action and nothing
> in the concept replaces those. The two are laid out so they never collide: the
> chip keeps its current position (`rect.right + 14`, i.e. inside the rail gap),
> the rail bubble starts at `railLeft` — with a 344px rail and a 24px gap that is
> tight, so **the chip renders above the bubble, right-aligned to the rail, when
> both are visible for the same block.**

**Retraction wording, to replace it verbatim:**

> ~~**Proposed: keep the chip.**~~ **RETRACTED 2026-08-11 by Wolf's ruling: the
> chip is folded into the bubble** — *"Fold it into the bubble but it has to
> make sense so you need to consider needed functionality for this canvas. make
> it look native in the bubble."* The PDF shows one affordance per block and
> that is now the rule. The hover chip, its positioning, its decay timer and its
> five tools are retired; every function it carried has a named home in
> [`marginalia-affordance-model.md`](marginalia-affordance-model.md) §3, and the
> two hover state machines this section tried to lay out around each other
> become the single machine in that document's §4. This section's chip/bubble
> stacking rule, and the `chipOffset` term it produced in `desiredTopFor`, are
> void.

### 8.2 §11 row 3 — RETRACTED

| # | The PDF does not specify | Proposed |
| --- | --- | --- |
| 3 | ~~Whether the existing hover chip survives~~ | ~~Keep it; chip above bubble when both show (§2.1)~~ **RETRACTED 2026-08-11 — the chip is folded into the bubble; see `marginalia-affordance-model.md` §§2–4.** |

### 8.3 §10.1 — SETTLED, not retracted

The toolbar reduction is still a separate task (T17.6b) and nothing there was
wrong. It is now **designed** (§7 above) and **urgent** (the no-movement change
makes the full-width bar an overlay). §10.1 gains a pointer to §7 and the
statement that Q1 is a checkpoint.

### 8.4 Consequential, smaller contradictions

- **§9 (accessibility)** said focus reveals what hover reveals. True of the
  rail, false of the chip, and therefore false of the canvas. The fold makes
  the sentence true for the first time; the tab-order rule in §4.4 is new and
  additive.
- **§5.1** ("double-click on multi-field blocks falls through to the panel")
  is unchanged and is now also `✎ edit directly`'s fallback.
- **T17.7's brief** bullet *"Agent identity, resolved without creating
  anything"* is partly delivered early by the fold (R1 line 1 renders the
  resolved agent before T17.7 lands). Its brief's wording should become
  "verify, do not rebuild" — noted in §9 below and in T17.14a's brief.
- **T17.13's smoke test** must assert `.dl-em-chip` does not exist in the DOM
  in edit mode, and that a block shows exactly one affordance. Added as a scope
  line in T17.14b's brief rather than by rewriting T17.13.

---

## 9. Dependence on T17.7 (unbuilt), and the interim state

**The fold must not wait on the agent-routed composer**, and it does not have
to. The dependency is narrower than it looks:

| Thing | Needs T17.7? | Interim behaviour |
| --- | --- | --- |
| R1's `→ {agent} · via CMS Agent` line | **No.** `listProfiles(getToken)` already exists in `chat-client.ts`, is read-only, and creates nothing. | Rendered by the fold. Degrades to no line when nothing resolves. |
| R1's avatar | No — `avatar_artifact` comes from the same profile view | Initials fallback when absent. |
| R3's placeholder `Comment — a question, a change, an ask` | No — already shipped | Unchanged. |
| R3's **three modes** (note / change / question) | **Yes.** Both the routing (`createObjectChat` + `sendChatMessage(chatId, text, focus)`) and the per-message read-only intent are T17.7's genuinely new work | Composer stays **single-mode Note**, i.e. exactly `resolveComposerAction` today. The placeholder still reads as the concept intends; only the routing is absent. |
| R3's selection quotation strip | No | Built by the fold, scoping the interim `Ask AI…` row and, later, T17.4's span anchors. |
| R5's `Ask AI…` row | It is the *bridge*. | Exists until T17.7 lands, then is **deleted** by T17.7 — the composer's *Ask for a change* replaces it. Both briefs say so. |
| `✎ edit directly` | No — it is T17.8's inline editor, which has landed | Full behaviour from day one. |

Net: after the fold and before T17.7, the canvas loses **nothing** and gains
the concept's card. T17.7's own scope shrinks slightly (its header work is
done) and gains one deletion.

---

## 10. Index of ambiguities and proposals (this document only)

Numbering continues from the T17.0 spec's §11, which ends at 20.

| # | The PDF does not specify | Proposed |
| --- | --- | --- |
| 21 | Where the block's identity (role / section type / `shared`) lives once the chip is gone | R1 line 2, muted, under the agent route (§2) |
| 22 | Where the monospace object id lives | Retired from the resting surface → R1 line 2's `title` + the drawer header (§3) |
| 23 | What the footer chevron does | Opens the block drawer, R5 (§2) |
| 24 | Where the chip's image / role / article-settings / delete actions go | Labelled rows in R5, delete last and destructive-tokened (§2, §3) |
| 25 | Where `content_grid` configuration (algorithm, tiles, columns) goes | A labelled `Related articles` group in R5 (§2) |
| 26 | Whether a bubble shows an empty state at rest | No — R2 is omitted when the block has no comments; the ghost bubble already carries "nothing here yet" (§2) |
| 27 | Where the per-thread `Resolve` action goes once the status pill and scope line are dropped | A quiet `✓ Resolve` text action on the thread's last comment, always in the tab order (§2) |
| 28 | How a text selection is represented once the chip's `dl-em-sel` highlight is gone | A quotation strip above the composer, reused later by T17.4 (§2) |
| 29 | The single state machine's shape, phases and invariants | §4.1–§4.3 |
| 30 | Keyboard tab-order volume for blocks with no threads | Marker rendered and focusable on `focusWithin` as well as hover (§4.4) |
| 31 | What happens when the docked panel and a bubble want the same column | The panel takes the column, the rail yields, the pin survives (§5.1) |
| 32 | Which unit an unpublished change belongs to | Reconstructed from `record.history` by `changedUnitsSince`, exactly as the tray already does for its phrasing (§6) |
| 33 | Where `Pending`, `Exit`, the signed-in email and the status line go in a three-pill toolbar | The `● Editing` popover; status as a live-region toast (§7.3) — **and Q1 is Wolf's call** (§7.4) |

---

## 11. How this should be built — the split, and the honest size

Wolf asked whether this is too big for one chat. **It is.** The fold alone
rewrites `renderChip`, `positionChip`, `clearChipSoon`, `buildBubble`,
`desiredTopFor`, `anchorPanel`, `morphFromTile`, four document-level listeners
and the whole `.dl-em-chip` CSS block, while adding a drawer, a footer strip and
an identity row — in a 4,000-line file that three prior tasks have already
rewritten this month. One session doing all of that produces a diff nobody can
review and a bug surface nobody can bisect.

**Four briefs. Three sessions of work, plus one checkpoint.**

| ID | Brief | Depends on | mode | model | effort | Honest size |
| --- | --- | --- | --- | --- | --- | --- |
| **T17.14a** | [`T17.14a-affordance-state-machine.md`](../cms-architecture/cms-pipeline/T17.14a-affordance-state-machine.md) — the single state machine, the bubble's R1/R2/R3/R4 anatomy, the drawer shell with `✎ edit directly` + `Delete block`, the chip deleted | T17.3, T17.6, T17.8 (all landed) | auto | `claude-opus-5` | high | **One full session.** The state machine is the risk; the anatomy is the visible half. |
| **T17.14b** | [`T17.14b-block-actions-panel-coexistence.md`](../cms-architecture/cms-pipeline/T17.14b-block-actions-panel-coexistence.md) — the rest of R5 (image, role, article settings, interim Ask AI, `content_grid` group), the selection strip, panel↔rail coexistence, morph source | **T17.14a** | auto | `claude-opus-5` | high | **One full session.** Mostly mechanical, but `anchorPanel` + yielding is fiddly and must be got right before anyone judges the fold by eye. |
| **T17.14c** | [`T17.14c-per-block-draft-provenance.md`](../cms-architecture/cms-pipeline/T17.14c-per-block-draft-provenance.md) — `draft-provenance.ts`, `markDraftRegions`, R4's state pill | **T17.14a** (needs R4) | auto | `claude-sonnet-5` | medium | **Half a session.** Pure function + one caller + tests. |
| **T17.6b** | [`T17.6b-toolbar-reduction.md`](../cms-architecture/cms-pipeline/T17.6b-toolbar-reduction.md) — three pills, popover, toast, measured `RAIL_TOP` | the `w17/fix1-no-move` change; **Wolf's Q1** | **checkpoint** | `claude-sonnet-5` | medium | **Half a session** once unblocked. |

**Sequencing.**

- **T17.14a → T17.14b are strictly sequential, one session each, same agent
  strongly preferred.** They rewrite the same hunks of `ui.ts` and
  `ui-chrome.ts`; parallelising them across worktrees guarantees a textual and
  semantic conflict, exactly as plan §5 found for Batch B.
- **T17.14c may run in parallel with T17.14b** in a separate worktree. Its
  `ui.ts` hunks — `markDraftRegions`, `refreshPending`, `positionDraftChips` —
  do not overlap T17.14b's (`buildBubble`'s drawer, `anchorPanel`,
  `morphFromTile`, the `mouseup` selection listener). The only shared line is
  the import block. If a single agent is running both, just do them in order.
- **T17.6b is independent of all three** — it touches `.dl-em-bar` and
  `RAIL_TOP` only — but it must land **after** `w17/fix1-no-move`, because it
  is that change that makes the bar an overlay, and it must not start before
  Wolf answers Q1.
- **T17.13 (the smoke test) still runs last**, and gains the "exactly one
  affordance" assertions T17.14b adds to its brief.

**What this does to the existing W17 queue.** Nothing is reordered. T17.4,
T17.5, T17.9, T17.11, T17.12 and T17.7 are unaffected in scope, with two small
consequential edits noted in §8.4 (T17.7's header bullet becomes "verify, don't
rebuild"; T17.7 deletes the interim `Ask AI…` drawer row). Running the T17.14
wave **before** T17.7 is preferable — T17.7 then builds its composer modes into
the finished card rather than into a card that is about to change — but it is
not a hard dependency in either direction.

---

## 12. What Wolf must decide before the first brief starts

1. **Q1 — `Exit`'s home** (§7.4): inside the `● Editing` popover (three pills,
   matching the PDF) or a fourth always-visible pill. **T17.6b is blocked on
   this and only this.** T17.14a/b/c are not blocked by it.
2. *(Optional, defaulted — say nothing and the proposal stands.)* Q2 `Pending`'s
   home, Q3 the status line as a toast (§7.4).
3. *(Optional, defaulted.)* Whether the T17.14 wave runs **before** T17.7 as
   §11 recommends, or after.

Everything else in this document is inside the ruling Wolf already gave.
