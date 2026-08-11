# Marginalia — interaction model specification

**Status:** Buildable specification, written by T17.0 (2026-08-10). This is the
translation layer between the approved concept and the code: the PDF is the
acceptance standard, this doc is what an implementing task is measured against
when the PDF is silent.

**Governing target:** [`marginalia-concept-b-final.pdf`](marginalia-concept-b-final.pdf)
(Wolf's approved "Marginalia — final"), scoped by Wolf's 2026-08-10 ruling
**(a) — the full concept**
([`../cms-architecture/decisions/2026-08-10-canvas-ux-scope-ruling.md`](../cms-architecture/decisions/2026-08-10-canvas-ux-scope-ruling.md)).

**Sibling specs:** [`marginalia-glass-ui-modernization.md`](marginalia-glass-ui-modernization.md)
(T17.1/T17.2 — the danger-token fix and the glass treatment, already landed) and
[`../cms-architecture/17-canvas-ux-plan.md`](../cms-architecture/17-canvas-ux-plan.md)
(the plan of record: task table §3, sequencing §5).

**Convention used throughout:** where the PDF does not settle something, the
text says **"the PDF does not specify X; proposed: Y"** in bold and the
proposal is the thing an implementing task builds. There are no silent
inventions in this document and no unmarked holes. Every ambiguity found is
also listed in §11 as a single index.

---

## 0. What the PDF actually shows (the source of every requirement below)

One page of a `content_item` article in edit mode, plus a second page that is
the same overlay over the tail of the article. The legend, verbatim, is the
concept's own one-sentence summary:

> **Marginalia — final.** Hover a block → margin bubble · badge = items needing
> you · select text → ask about it · double-click to edit directly. The thread
> lives in the margin — the text stays readable; on narrow screens the page
> slides over to make room.

Everything visible in the render:

| # | Element | Where |
| --- | --- | --- |
| 1 | Left-gutter markers beside blocks: small hollow dots on most blocks, **filled orange dots carrying a numeral (`1`)** on two blocks, one filled accent dot on the hovered block | left of the content column |
| 2 | A **margin rail** on the right holding a thread card: avatar `DL`, header `→ Dr. Lurié Article Agent · via CMS Agent`, an `✎ edit directly` action, a composer with placeholder `Comment — a question, a change, an ask`, a send button, and a footer strip `Retinol Without the Flake · Published · Aug 2` with a disclosure chevron | right of the content column |
| 3 | A small **speech-bubble affordance** in the rail beside the block under the cursor (the checklist), where no thread card exists | rail, block-aligned |
| 4 | A top-right toolbar of three pills: `● Editing`, `Attention 2`, `Release` | viewport top-right |
| 5 | An inline `· draft` chip beside a heading (`The two-night rule · draft`) | in the content flow |
| 6 | A metadata line `Aug 2, 2026 · Dr. N. Lurié · Skincare · retinol sensitive-skin` with `≈ $1.42 · 3 runs` right-aligned | in the content flow |
| 7 | The content column sits **left of centre**, not centred — the page is already slid | whole layout |

Items 1–4 are specified in this document. **Item 7 is RETRACTED** (Wolf,
2026-08-11 — see §1.3): the article never moves, so the page is never slid and
the render's off-centre column is not a requirement. Items 5 and 6 have no owner in
the §3 task table and no data source in core; they are recorded in §10 as
**unassigned PDF requirements** so they are not lost.

Measured proportions from the render, expressed against the content-column
width (scale-free, so they survive the 720px column the real article layout
uses — `packages/core/app/components/blog/SinglePost.astro`, `max-w-[720px]
mx-auto`):

| Measure | Ratio of column width | At a 720px column |
| --- | --- | --- |
| Gutter badge centre, left of column | 0.040 | 28px |
| Column → rail gap | 0.036 | 24px |
| Rail width | 0.482 | 344px |
| Rail → viewport right edge | 0.084 | 60px (soft) |

---

## 1. Layout: the margin rail

### 1.1 What the rail is

A single fixed-position column, mounted once per document by the edit-mode
overlay (`packages/core/lib/edit-mode/ui.ts`'s `mountEditMode`, alongside the
existing `.dl-em-chip` / `.dl-em-panel` / `.dl-em-tray` singletons), holding
**block-aligned bubbles**. It is not a panel and it does not scroll
independently: bubbles are positioned against their anchor block's box and move
with the page, exactly as `positionChip` already does for the hover chip.

New tokens, declared in `ui-chrome.ts`'s `STYLES` `:root` block beside the
existing `--dlem-*` set:

```
--dlem-rail-w: 344px;
--dlem-rail-gap: 24px;
--dlem-rail-pad: 8px;     /* minimum rail → viewport right edge */
--dlem-gutter-x: 28px;    /* badge centre, left of the content column */
```

### 1.2 Anchor geometry

> **Retracted and rewritten by W17 Fix 1 (2026-08-11).** The original §1.2
> measured `columnRight` as the maximum `regionRect(...).right` over every
> annotated region in the viewport. `[data-cms-nav-object]` wraps the sticky,
> full-bleed site header, which is in the viewport at every scroll position on
> every page, so `columnRight` was always the viewport width, the natural
> margin always read as the scrollbar's width, and §1.3's `slide` fired
> everywhere. That defect is what this fix exists to remove.

The rail's left edge and its width are derived from the **content column**, not
the viewport:

```
columnRight = max(contentRect(region).right)   // over CONTENT columns only
railLeft    = columnRight + railGap
```

`contentRect` (`ui.ts`) starts from `regionRect` — still load-bearing, because
article node wrappers are `display:contents`
(`packages/core/lib/article-object/render-nodes.ts` emits
`<div style="display:contents" data-cms-object-id … data-cms-node-id …>`), so
they generate no box of their own and a naive `getBoundingClientRect()` returns
zeroes — and then **walks down through single-child full-bleed wrappers** to the
first box narrower than 90% of the viewport. A full-bleed section band is page
chrome; the `max-w-*` column inside it is the content. The same function places
the gutter markers, which is what stops a marker on a full-bleed section from
pinning to the x=4 clamp.

Two classes of box are never columns and are excluded from the measurement:

- **navigation regions** (`[data-cms-nav-object]`, and anything inside one) —
  the site header and footer, which are chrome by definition;
- **any box still ≥ 90% of the viewport after the descent** — a band, not a
  column.

The viewport is `document.documentElement.clientWidth`, never
`window.innerWidth`: the latter includes the classic scrollbar, which is enough
on its own to turn a fitting margin into a non-fitting one.

Because different sections have different widths, the rail uses **one** column
edge for the whole page, not per block: the **maximum** over the content
columns currently in the viewport, recomputed on resize and on the same
`scheduleGapRebuild` cadence the gap layer already uses. **The PDF does
not specify what happens on a page whose sections have different widths;
proposed: one rail x-position per page, taken from the widest in-viewport
content column, so bubbles never form a ragged edge.**

### 1.3 The layout ladder — the page never moves

> **Retracted and rewritten by W17 Fix 1 (2026-08-11).** The original §1.3
> specified a **slide** mode: `padding-right: 376px` on `<body>`, so the
> `mx-auto` column re-centred in the narrowed area and the article moved 188px
> left. Because the rail plan is empty until something is revealed, that fired
> **on hover** and reversed on hover-out — the page bounced under the pointer.
> The slide is **retracted in full**, along with the `body.dl-em-slide`,
> `body.dl-em-measuring` and `body.dl-em-on{padding-top:38px}` rules, the
> `padding-right` transition, `railSlidePadding`, and the measure-with-the-
> slide-removed dance the slide made necessary. The PDF's own render is drawn
> in the slid state and its legend says "on narrow screens the page slides over
> to make room"; **that part of the concept does not ship.**

**Wolf's ruling (2026-08-11), governing:**

> **The article must never move.** "Keep everything like it is published."
>
> On the narrow-window case: *"let's keep this rule for articles only. if it
> doesn't fit move other objects."*

What that means here: **on article/content pages the reading column and the
block being worked on never move, at any width — the rail adapts instead.** On
non-article surfaces, if the rail genuinely cannot fit, other objects may be
displaced to make room. No mode in the ladder below displaces anything today,
on any surface, so the second half of the ruling has no implementation yet; the
single seam where it will be gated is `railMayDisplaceContent(surface)` in
`rail-layout.ts`, which answers `false` for every surface. Nothing else in the
canvas is allowed to ask the question.

Let `naturalMargin = viewportWidth - columnRight` and
`chrome = railGap + railPad`.

| Mode | Condition | Behaviour |
| --- | --- | --- |
| **inset** | `naturalMargin ≥ railW + chrome` | The rail floats at full width in the margin the page already has. This is the "the text stays readable" case. |
| **compact** | `naturalMargin ≥ railMinW + chrome` | The rail **narrows to the real margin** — `--dlem-rail-w` is written to `naturalMargin − chrome`, floor `railMinW` — and sits at `right: railPad`. The page does not move. |
| **markers** | `viewportWidth ≥ sheetFloor`, margin below the floor | **No rail.** Gutter markers only; clicking a marker opens that block's bubble as a popover anchored to the marker, overlaying the page rather than displacing it. |
| **sheet** | `viewportWidth < sheetFloor` | No rail. Threads open as the existing bottom sheet (`ui-chrome.ts`'s `@media (max-width:720px)` rule on `.dl-em-panel`). Gutter badges still render, inline at the block's leading edge rather than in a gutter. |

Tokens: `railW = 344`, `railMinW = 260`, `railGap = 24`, `railPad = 8`,
`sheetFloor = 900`. **The PDF does not specify the narrow-screen breakpoint or
what replaces the slide; the ladder above is proposed,** with `sheetFloor = 900`
kept from the original §1.3.

**Hysteresis.** A mode narrows the moment its threshold is crossed and widens
again only `RAIL_MODE_HYSTERESIS = 24px` past it, so a viewport parked on a
boundary cannot flap. The mode is re-evaluated **on resize (and on the content
rebuild cadence) only — never on hover, focus, pin or thread write.** A pointer
must not be able to change the page's layout at all; that, not the geometry, is
what made the original defect so visible.

**The invariant, pinned by tests** (`no-page-movement.test.ts`): no edit-mode
code path may change any box-model property on `<body>` or `<html>`. The rail
being up or down, wide or narrow, changes nothing about where the article sits.

### 1.4 Relationship to the existing panel

The rail **does not replace** `.dl-em-panel`. The panel keeps the Ask AI / Edit
text / Image / Role / Article-settings sections. What moves out of it is the
**Comments accordion section**: after T17.3 the panel's `comments` section is
retired from the accordion and `mountMarginaliaPanel` is re-mounted, per
bubble, into the rail. `PanelMode`'s `'comments'` member and the `isNav &&
mode !== 'comments'` special case in `openPanel` go with it. The `marginalia`
cache, the preload in `preloadRecords`, and `invalidateMarginaliaThreads` are
kept as-is — the rail consumes the same warmed promise the accordion did.

---

## 2. Hover-reveal

### 2.1 What reveals

Hovering an annotated region (`[data-cms-node-id]`, then `[data-cms-section-id]`,
then `[data-cms-nav-object]` — the exact innermost-first resolution order
`ui.ts`'s existing `mouseover` listener uses) reveals, for that block only:

- its gutter badge in full form (see §4);
- **if the block has ≥1 open thread:** its bubble in the rail, top-aligned to
  the block;
- **if it has none:** a ghost bubble — a single speech-bubble button (the PDF's
  💬 beside the hovered checklist) that opens an empty composer for that block
  on click.

The existing hover chip (pencil / image / role / Ask-AI / delete) is
**unchanged** and continues to appear at the block's right. **The PDF does not
show the hover chip at all;** it shows only the bubble. **Proposed: keep the
chip.** It is the entry point for every non-comment canvas action and nothing
in the concept replaces those. The two are laid out so they never collide: the
chip keeps its current position (`rect.right + 14`, i.e. inside the rail gap),
the rail bubble starts at `railLeft` — with a 344px rail and a 24px gap that is
tight, so **the chip renders above the bubble, right-aligned to the rail, when
both are visible for the same block.**

### 2.2 Timing

| Event | Delay | Rationale |
| --- | --- | --- |
| Reveal on pointer enter | **120ms** | Suppresses flicker when the pointer crosses blocks on its way somewhere else. |
| Dismiss on pointer leave | **250ms** | The exact value `clearChipSoon` already uses, so chip and bubble decay together. |
| Pointer enters the rail/bubble | cancel pending dismiss | Same guard shape as today's `if (chip.contains(element))` early return. |

**The PDF does not specify timings; the two values above are proposed,** with
the dismissal one chosen to match existing behaviour rather than to be new.

### 2.3 Pinning and dismissal

A bubble is in one of three states:

- **hidden** — no hover, no pin;
- **revealed** — hover-driven, decays after 250ms;
- **pinned** — survives hover-out.

Pinning: click the bubble, click the gutter badge, keyboard-activate the badge,
or focus anything inside the bubble (the composer). Unpinning: `Esc`, a click
outside both bubble and its block, pinning a different bubble, or the bubble's
close control. **At most one pinned bubble at a time** — the same single-slot
discipline `hotRegion` and `panelRegion` already enforce. **The PDF does not
specify pinning; proposed as above,** because a hover-only bubble cannot host a
composer (moving the pointer to type would dismiss it).

Opening a bubble does **not** close the panel and vice versa; they address
different actions. If both are open and would overlap, the panel wins its
position and the rail bubble offsets below it.

---

## 3. Anchoring: what attaches to what

### 3.1 Today (unchanged by T17.3)

`MarginaliaAnchor` (`packages/core/schema/marginalia-v1.ts`) is
`{objectType, objectId, sectionId?, nodeId?, field?, selectedText?}`. Threads
are block-scoped: `sectionId` for a page section instance, `nodeId` for an
article node, neither for a whole-object thread. `field` and `selectedText`
are reserved and set by no client.

Rail placement by anchor kind:

| Anchor | Bubble position |
| --- | --- |
| `nodeId` / `sectionId` present and the block is in the DOM | Top-aligned to that block's `regionRect`. |
| Neither (whole-object) | Pinned to the top of the rail, above every block bubble, under a `Whole article` label. |
| Anchored block absent from the DOM | Orphan — see §8.2. |

### 3.2 Span anchoring (T17.4)

`selectedText` becomes real. The capture path already exists:
`captureObjectSelection` (`packages/core/lib/admin/ask-ai-object-selection.ts`,
used today for Ask-AI scoping) yields the selected string and the region it
came from; `MarginaliaAnchorInput` and `marginalia_create`'s `selected_text`
parameter already carry it end to end.

Re-locating a span on a later render is the hard part, and the stored data is
text, not offsets:

1. Search the anchored block's text content for the **first exact occurrence**
   of `selectedText`.
2. If the block's text contains it more than once, occurrence 1 is not
   necessarily right.

**The PDF does not specify span rehydration; proposed:** store, alongside
`selectedText`, (a) the existing reserved `field` — the section/node field the
selection came from — and (b) a **new optional** `selectionOccurrence: number`
(1-based) on `marginaliaAnchorSchema`. Both optional and additive, so no
migration and no change to existing threads. Resolution order: exact match at
`selectionOccurrence` → first exact match → normalized-whitespace match →
**drift** (§8.3).

A span-anchored bubble aligns to the **top of the first client rect of the
matched range**, not the block top, and the matched range gets a highlight
(`background: color-mix(in srgb, var(--dlem-accent) 14%, transparent)`) while
its bubble is revealed or pinned.

---

## 4. The attention model

### 4.1 What "needs attention" means

**An open thread.** `status === 'open'`. `resolved` and `dismissed` never
count. This is the whole definition — deliberately not "unread", because the
store has no per-user read state and inventing one is out of scope.

### 4.2 Per-block badges (T17.6)

One gutter marker per annotated block, at `columnLeft - 28px`, vertically
aligned to the top of the block's first line box:

| Block state | Marker |
| --- | --- |
| ≥1 open thread | Filled **warning/attention** dot carrying the count numeral (the PDF's orange `1`). Uses `--dlem-draft` (the gold attention token) — **not** `--dlem-danger`, which T17.1 has now correctly repointed to the destructive rust-red and must stay reserved for destruction. |
| Only resolved/dismissed threads | Hollow dot, muted ink, **revealed on hover only**. |
| No threads, block hovered | Filled accent dot (the PDF's teal marker on the hovered checklist). |
| No threads, not hovered | Nothing. |

Each marker is a real `<button>` (see §9). The count is per **block**, summing
every open thread anchored to it, span-anchored threads included.

### 4.3 The global `Attention N` counter (T17.6)

`N` = **the number of open threads anchored anywhere on the current page**,
including whole-object threads with no block anchor and orphaned threads
(§8.2). In the PDF, `Attention 2` sits above exactly two orange `1` badges,
which fixes the definition: it is a sum of the page's open threads, **not** the
pending-changes count the existing `Pending N` control shows.

`Pending N` and `Attention N` are different quantities and both must exist.
**The PDF shows only `Attention`;** it does not show `Pending`, `Exit`, the
signed-in email, or the status line that today's `.dl-em-bar` carries. See
§10.1 — the toolbar reduction is an unassigned PDF requirement, not something
T17.6 should silently perform.

**The PDF does not specify what clicking `Attention N` does; proposed:** it
opens the rail in **list mode** — every open thread on the page in document
order, whole-object threads first, orphans last under their own heading.
Clicking a row scrolls its block into view and pins its bubble. Clicking
`Attention` again returns the rail to block-aligned mode.

---

## 5. Double-click to edit (T17.8)

### 5.1 The interaction

Double-clicking an annotated block enters **inline edit** of that block's
primary copy field, in place, with no panel step:

- `content_item` nodes whose body is `rich_text.v1` → the existing TipTap
  editor from `packages/core/lib/edit-mode/richtext-editor.ts`
  (`createRichTextEditor`), mounted over the rendered block. The grammar
  allowlist, the paste sanitizer and the https-only link rule come with it
  unchanged.
- Plain-string bodies and single-line section fields (heading, eyebrow, …) →
  a contenteditable bound to the same field, no toolbar.
- Blocks with no single primary copy field (an image node, a grid) → **no
  inline edit**; double-click opens the panel on the mode it would have opened
  anyway. **The PDF does not specify multi-field blocks; proposed as stated.**

Which field is "primary" is derived, not hardcoded: the first field the
existing `formFieldsFor` (`ui.ts`) would render for that block in `edit` mode,
skipping non-copy keys (`NON_COPY_KEY_RE` already encodes that rule).

### 5.2 Persistence

Identical to the panel's save path — there is no second write path. `Cmd/Ctrl+Enter`
or blur commits through `EditSession` (`verbs-client.ts`): `ensureCheckout()` →
`patch([{op: 'update_node' …}])` or `update_section_data`, `invalidateRecord`,
mark the region `dl-em-draft`, `refreshPending()`. `Esc` reverts to the value
at entry and exits without a write. A held lock refuses with the existing
`Locked by X — try again when the lock frees.` status, and the block returns to
read-only.

### 5.3 Coexistence with hover and with selection

Three real collisions, each with a rule:

1. **Double-click produces a text selection.** `ui.ts`'s `mouseup` listener
   would capture it as an Ask-AI scope. Rule: **skip selection capture when
   `event.detail >= 2`.**
2. **Hover bubbles during editing.** While a block is in inline edit, its own
   bubble stays pinned (comments about the thing you are editing are the point)
   but *other* blocks' hover-reveal is suppressed, and the gutter markers stop
   responding to hover until edit exits.
3. **Links inside the content.** A double-click on an anchor must not
   navigate. Rule: in edit mode, `click` on an in-content anchor is
   `preventDefault()`-ed. **The PDF does not specify link behaviour in edit
   mode; proposed as stated** — an editor clicking a link inside their own
   article almost always meant to place a cursor.

**The PDF does not specify how inline edit ends without a keyboard;** proposed:
clicking outside the edited block commits (blur), matching every other
autosaving inline editor, with the status line reporting the save.

---

## 6. The agent-routed composer (T17.7)

### 6.1 The three modes

The composer's placeholder in the PDF — `Comment — a question, a change, an
ask` — is the mode list, and the card header `→ Dr. Lurié Article Agent · via
CMS Agent` is where a routed request goes.

| Mode | Label | On submit |
| --- | --- | --- |
| **Note** | *Note* | `marginalia_create` (new thread) or `marginalia_reply` (existing thread at this anchor — `resolveComposerAction` already decides which). No agent involvement. Exactly today's behaviour. |
| **Change request** | *Ask for a change* | **Both:** (1) the same `marginalia_create`/`_reply` write, so the ask is recorded, attributable and resolvable; (2) an object-scoped agent chat — `createObjectChat(objectType, objectId)` then `sendChatMessage(chatId, text, focus)` (`packages/core/lib/admin/chat-client.ts` → `admin-agent-chat`), with `focus` naming the anchor (`sectionId`/`nodeId`/`field`/`selectedText`). The agent's proposal returns through the existing approval path (`tool_approval_required` → `approveTool`), unchanged. |
| **Question** | *Ask a question* | Same two writes, with the request marked read-only in intent: the agent is expected to answer in the thread, not to patch. |

The thread write happens **first** and is what the UI confirms on; the chat
start is best-effort and its failure is reported into the thread as a system
line, never as a lost comment.

### 6.2 Returning the agent's answer to the thread

**The PDF does not specify how an agent's reply lands in the thread; proposed:**
the run's final `assistant_text` event is posted back as a `marginalia_reply`
authored by the **agent principal** — `principalSchema`'s agent variant is
already what `marginaliaDenied` (`object-verbs.ts`) explicitly permits
(`if (principal.kind === 'agent') return undefined;`), so no new permission
surface is needed. For a change request, the reply also names the resulting
draft revision so the thread reads as a record of what was asked and what
happened.

### 6.3 Naming the agent (no invention required)

`Dr. Lurié Article Agent` is the assigned agent **profile's `name`**;
`via CMS Agent` is the fixed transport label for the in-house agent endpoint.
Resolution is already implemented and already exposed:
`listProfiles(getToken)` returns `{profiles, assignments}` and assignments
resolve object → type → site default (`resolveProfile`, T9.26 roster). The rail
computes the label client-side as
`assignments.objects[objectId] ?? assignments.types[objectType] ?? assignments.site_default`,
matched into `profiles`, with `avatar_artifact` supplying the `DL` avatar. **No
chat needs to be created to render the header** — which matters, because
rendering a header must not create objects.

If no profile resolves, the header degrades to `via CMS Agent` alone and the
**Change request / Question modes are disabled with a reason**, rather than
routed nowhere.

### 6.4 `✎ edit directly`

The header's escape hatch: leaves the agent route and enters §5's inline editor
on the anchored block. It is a shortcut to T17.8, not a second edit path.

### 6.5 What has no precedent

**A "read-only intent" run does not exist today.** `sendChatMessage` has no
flag for it; the nearest mechanism is the per-profile
`tool_autonomy_overrides` map (`'auto' | 'ask' | 'off'`) on the agent profile,
which is profile-scoped, not message-scoped. **Proposed:** T17.7 adds an
optional per-message intent to the `send` action that maps write-capable tools
to `ask` for that run only. This is genuinely new server work and the brief
says so.

---

## 7. Narrow screens

Covered by §1.3's mode table. Restated as behaviour, because the PDF legend
calls it out explicitly:

- **Wide:** the rail lives in the margin the page already has; the article does
  not move; text stays at its natural measure.
- **Narrow (`≥ 900px`, some margin):** the rail narrows to the margin the page
  has, down to 260px. The article still does not move.
- **Narrower (`≥ 900px`, no usable margin):** no rail. Gutter markers carry the
  attention signal, and a marker click opens its bubble as a popover over the
  page. The article still does not move.
- **Very narrow (`< 900px`):** no rail; the bottom sheet. Gutter badges become
  inline leading markers so the attention signal survives.

Nothing on this ladder moves the page (§1.3, Wolf 2026-08-11). Below `inset`
the bubble surface does overlay the text — that is the cost of never moving the
article, and it is the trade Wolf chose.

---

## 8. Interaction states and edge cases

### 8.1 Overlapping and colliding anchors

- **Several threads on one block:** their bubbles stack in the rail at that
  block's top, newest last. Beyond three, the stack collapses to the newest
  plus a `+N` control that expands in place.
- **Two blocks whose bubbles would overlap:** the rail runs a top-down packing
  pass — `top = max(desiredTop, previousBottom + 8)` — the standard sidenote
  algorithm. A displaced bubble draws a 1px connector back to its block's
  gutter marker so the association stays visible. **The PDF does not show
  collisions; proposed as stated.**
- **Nested anchors** (a span thread inside a block that also has a block
  thread): the block thread sorts first, spans after, in document order of
  their matched ranges.

### 8.2 A comment on a block that no longer exists

Two ways it happens: a draft delete (`.dl-em-removed`, which sets
`display:none`) and a published edit that removed the node.

Rule: **never auto-resolve, never drop.** The thread becomes an **orphan** —
it renders in the rail's list mode (§4.3) under `Not on this page anymore`,
carries its original anchor ids verbatim, and counts toward `Attention N`. A
draft-deleted block's thread additionally shows `block deleted in a draft`,
because the block may come back if the draft is discarded.

### 8.3 Anchor drift (span anchoring)

A span whose `selectedText` no longer matches (§3.2) degrades to its block
anchor, is labelled `anchor moved` in the bubble, and keeps the original
`selectedText` visible as a quotation so the reader can see what was being
discussed. No write happens on drift — the stored anchor is not rewritten,
because rewriting would destroy the evidence of what changed.

### 8.4 Long threads

A bubble renders the first comment, the last comment, and `N more` between
them; expanding scrolls internally at `max-height: 44vh` (the value
`.dl-em-log` already uses). Pinned bubbles taller than the viewport scroll
within themselves; the rail never becomes a scroll container of its own.

### 8.5 Concurrency and staleness

The marginalia store has **no CAS and no locking** — last-write-wins is a
documented, accepted trade-off (`marginalia-store.ts`). Consequences the UI
must respect:

- Every write re-lists (`refresh()` + the existing `onWrite` invalidation), so
  the rail and the badges recompute from the server's view, not optimistically.
- Badge counts can be stale between actions. **No background polling in V1**
  (the canvas has no polling anywhere today and adding one is a cost decision,
  not a UI one). Counts refresh on edit-mode activation, on any thread write,
  and on `Attention` click.
- Two people resolving the same thread is idempotent; two people replying is
  additive. Neither can lose data.

### 8.6 Non-article surfaces

Pages, sections and navigation chrome get the identical rail. `navigation`
targets have no meaningful "primary copy field" for §5 in most cases, so
double-click falls through to the panel there. All twelve governed object types
keep their existing admin-side coverage via `MarginaliaThreadList.tsx`, which
this work does not touch.

---

## 9. Keyboard and accessibility

The current comments UI is mouse-only inside a dialog. The rail is a persistent
surface and must not be.

- The rail is `<aside role="complementary" aria-label="Comments">`, placed in
  DOM order **after** the main content so a screen reader reaches the article
  first.
- Every gutter marker is a `<button>` with
  `aria-label="{N} open comments on {block label}"`, `aria-expanded`, and
  `aria-controls` pointing at its bubble. Block label reuses the chip's
  existing identity string (node kind / section type).
- **Focus reveals exactly what hover reveals.** Keyboard users are not second
  class: `Tab` to a marker → the bubble reveals; `Enter`/`Space` → pins and
  moves focus into the bubble; `Esc` → unpins and returns focus to the marker.
- Markers are in document order in the tab sequence, interleaved with content,
  so their position is meaningful.
- **Double-click has a keyboard equivalent:** `Enter` on a focused block enters
  inline edit; `Esc` reverts and exits; `Cmd/Ctrl+Enter` commits. **The PDF
  does not specify a keyboard path for direct editing; proposed as stated** —
  a mouse-only editing gesture would be the only one in the canvas.
- Live region: the status line already in `.dl-em-bar` gains
  `aria-live="polite"` for save/resolve confirmations.
- Motion: the bubble reveal and any morph respect
  `prefers-reduced-motion` (existing precedent in `morphFromTile`).
- Contrast: the attention badge is a filled token-derived dot with a numeral —
  colour is never the only carrier of "needs attention", the numeral is. The
  glass surfaces from T17.2 sit under text that must still meet contrast; the
  T17.2 spec's own §4.5 follow-up (a manual WCAG check against the blurred
  background) applies to the rail as well.

---

## 10. PDF requirements with no owner in the plan's task table

Recorded here so they are not lost. **None of these are assigned to
T17.3–T17.13 by [`17-canvas-ux-plan.md`](../cms-architecture/17-canvas-ux-plan.md) §3.**

### 10.1 The reduced toolbar

The PDF's toolbar is three floating pills at the viewport's top right —
`● Editing`, `Attention 2`, `Release`. Today's `.dl-em-bar` is a full-width
sticky bar carrying a dot, `Edit mode`, the signed-in email, a centred status
line, `Pending N`, `Release to production` and `Exit`, and it pushes the page
down (`body.dl-em-on { padding-top: 38px }`).

Reconciling those is a real change — it drops or re-homes four controls and
changes document flow — and it is not the same task as adding the `Attention`
counter. T17.6 adds the counter into whatever bar exists. **Proposed: a
separate task (T17.6b) for the toolbar reduction**, with `Pending`, `Exit`,
identity and status re-homed rather than deleted (an editor cannot leave edit
mode without `Exit`).

### 10.2 The inline `· draft` chip

The PDF shows `The two-night rule · draft` — an unpublished-draft marker
rendered *inline beside the heading in the content flow*. Today draft state
shows as a dashed outline on the region (`.dl-em-draft`) plus a `draft` flag
inside the hover chip. Small, but it is a visible difference from the target.
**Proposed: fold into T17.6** (it is the same "status markers in the margin/flow"
family as the badges) and say so in that brief.

### 10.3 `≈ $1.42 · 3 runs`

The PDF's metadata line carries a cost-and-runs provenance chip. **There is no
data source for it in core** — no cost field on `content_item`'s envelope
(`packages/core/schema/bodies/content-item-v1.ts` has `lineage` and `scores`,
not spend), and no per-object run accounting anywhere in `packages/core`. The
CMS-Agent side has usage/cost tooling, but nothing in this repo reads it.

Building it means: a data source decision, a store surface, and a render
surface. **Proposed: out of W17 scope, recorded as a follow-up**, rather than
inventing a number on the canvas. Flagged to Wolf explicitly.

---

## 11. Index of ambiguities and proposals

Every place this document went past the PDF, in one list:

| # | The PDF does not specify | Proposed |
| --- | --- | --- |
| 1 | Rail x-position on pages with unequal section widths | One rail position per page, from the widest in-viewport content column, navigation and full-bleed bands excluded (§1.2) |
| 2 | Narrow-screen breakpoint and what replaces the slide | `sheetFloor = 900px`; the inset → compact → markers → sheet ladder, none of which moves the page (§1.3, Wolf 2026-08-11) |
| 3 | Whether the existing hover chip survives | Keep it; chip above bubble when both show (§2.1) |
| 4 | Hover reveal/dismiss timings | 120ms reveal, 250ms dismiss (matching `clearChipSoon`) (§2.2) |
| 5 | Pinning | Click/focus pins; `Esc`/outside-click/another pin unpins; one at a time (§2.3) |
| 6 | Span rehydration when text changed or repeats | `field` + new optional `selectionOccurrence`; four-step resolution; drift state (§3.2, §8.3) |
| 7 | What `Attention N` does on click | Rail list mode, document order, orphans last (§4.3) |
| 8 | Inline edit of multi-field blocks | Falls through to the panel (§5.1) |
| 9 | Link clicks in edit mode | `preventDefault` on in-content anchors (§5.3) |
| 10 | How inline edit ends without a keyboard | Outside click commits (§5.3) |
| 11 | How an agent's answer reaches the thread | Posted as a `marginalia_reply` authored by the agent principal (§6.2) |
| 12 | Read-only ("question") agent runs | New per-message intent mapping write tools to `ask` (§6.5) — genuinely new server work |
| 13 | Bubble collisions | Top-down packing with connectors (§8.1) |
| 14 | Comment on a deleted block | Orphan, never auto-resolved, still counted (§8.2) |
| 15 | Long-thread rendering | First + last + `N more`, `max-height: 44vh` (§8.4) |
| 16 | Freshness/polling | No background poll in V1; refresh on write/activate/attention (§8.5) |
| 17 | Keyboard path for direct editing | `Enter` on a focused block (§9) |
| 18 | Toolbar reduction | Separate task T17.6b; nothing deleted, only re-homed (§10.1) |
| 19 | The inline `· draft` chip | Fold into T17.6 (§10.2) |
| 20 | `≈ $1.42 · 3 runs` | No data source exists; out of W17 scope, flagged (§10.3) |

---

## 12. Files this specification governs

Real paths, for the tasks that implement it:

| Concern | File |
| --- | --- |
| Canvas overlay, mounting, hover, panel, caches | `packages/core/lib/edit-mode/ui.ts` |
| Canvas CSS + icons (`STYLES`, `ICON_*`) | `packages/core/lib/edit-mode/ui-chrome.ts` |
| Comments render/compose logic, `resolveComposerAction` | `packages/core/lib/edit-mode/marginalia-panel.ts` |
| Anchor/target derivation (`deriveNodeTarget`, `deriveEditTarget`, `deriveNavTarget`, `regionRect`) | `packages/core/lib/edit-mode/targets.ts`, `ui.ts` |
| Inline rich-text editing | `packages/core/lib/edit-mode/richtext-editor.ts` |
| Selection capture | `packages/core/lib/admin/ask-ai-object-selection.ts` |
| Thread/comment schema | `packages/core/schema/marginalia-v1.ts` |
| Browser client for the four verbs | `packages/core/lib/admin/marginalia-client.ts` |
| Verb dispatch + permission gate (`marginaliaDenied`) | `packages/core/server/lib/object-verbs.ts` |
| Blob persistence | `packages/core/server/lib/marginalia-store.ts`, `marginalia-store-keys.ts` |
| MCP tool definitions | `packages/core/server/lib/mcp-tool-definitions-2.ts` |
| Agent chat transport + roster | `packages/core/lib/admin/chat-client.ts`, `packages/core/server/functions/admin-agent-chat.ts` |
| Admin-side thread list (12/12 type coverage, untouched by W17) | `packages/core/admin/MarginaliaThreadList.tsx` |
| Article node annotation emission | `packages/core/lib/article-object/render-nodes.ts` |
| Article content column geometry | `packages/core/app/components/blog/SinglePost.astro` |
