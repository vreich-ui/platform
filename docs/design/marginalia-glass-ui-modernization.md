# Canvas Edit-Mode UI Modernization — Glass Look + Danger-Color Fix

**Status:** Proposed spec, ready to implement. Live-prototyped and screenshot-verified
against production (`packages/core/lib/edit-mode/ui-chrome.ts`'s `STYLES` export) via an
in-browser CSS override on `drluriescience.netlify.app`. Nothing in this document has been
applied to the repo yet — this is the spec to implement against.

**Origin:** Wolf, 2026-08-10 — "the colors need to fit current visual template being used
but the actions, warnings and cards need to look more modern. I have a problem with low
visibility and the look which doesn't match design and color. I want to try glass look for
this accordion card/modal and everything else associated with it."

**Target components (the docked panel/accordion "card/modal" and everything associated
with it):** `.dl-em-panel` (the edit-mode docked panel, all accordion sections including
Comments/Marginalia), `.dl-em-confirmcard` (delete-confirmation modal), `.dl-em-tray`
(bottom action tray), `.dl-em-chip` (already partially glass — extended here for
consistency), message bubbles (`.dl-em-msg`, `.dl-em-diff`), and the danger/warning
button and badge system throughout.

---

## 1. Root cause of the low-visibility complaint: `--dlem-danger` resolves to blue, not red

This is a real bug, not a subjective styling gap. Confirmed by reading the live computed
CSS custom properties on a production page (`getComputedStyle`, `drluriescience.netlify.app/niacinamide-aging-skin-barrier`):

The variable chain in `ui-chrome.ts` is:

```css
--dlem-danger: var(--adm-danger, var(--aw-color-secondary, #b91c1c));
```

`--adm-danger` is only defined inside the admin workspace (`/admin/*`), not on public
pages — so on the canvas edit surface it falls through to `--aw-color-secondary`. That
variable IS defined site-wide by `CustomStyles.astro` from `site.brandTokens`, so the
`#b91c1c` red literal never gets a chance to apply. The live computed value of
`--dlem-danger` on the canvas is:

```
rgb(37 90 120)   /* the site's dark-blue SECONDARY brand color */
```

Any UI element using `--dlem-danger` — the danger button text, the confirm-modal
"Delete" icon, warning outlines — renders in the same blue-teal family as everything
else on the page. That's the low-visibility problem: nothing marked as a warning or
destructive action visually stands out.

**Compounding second bug:** the actual delete-confirmation button doesn't even use
`--dlem-danger`. It uses the draft/warning token instead:

```css
.dl-em-btn.dl-em-danger { background: var(--dlem-draft) /* the gold/warning color */ ... }
```

So today, "Delete" and "this needs your attention" render as the same gold tone, and the
one truly reserved alert-color variable is silently dead — it resolves to blue and is
never actually painted anywhere that matters.

### Fix: a real danger token, in-palette

`THEME_COLOR_KEYS` (`packages/core/lib/registry/theme-tokens.ts`) has no dedicated
danger/alert key — by design the theme system doesn't ship one, so we shouldn't invent a
raw hex outside the brand palette either (Wolf: "colors need to fit current visual
template"). Proposal: derive danger from the theme's own **gold** (already the warm
accent used for warnings) blended toward a rust/terracotta, via `color-mix`, so it stays
a first-class derived brand color rather than an arbitrary red:

```css
--dlem-danger-fix: color-mix(in srgb, var(--aw-color-gold) 40%, #7a2e22 60%);
```

Live-verified: this renders as a warm, clearly-distinguishable rust-red that reads as
"stop/delete" against the site's blue/teal/cream palette, without introducing a color
family that doesn't already exist in the brand tokens. Apply it to `.dl-em-btn.dl-em-danger`
(replacing the current `--dlem-draft` mismatch) and to `--dlem-danger` itself so every
future consumer of that variable gets the corrected value for free.

---

## 2. Glass treatment

Precedent already exists in the codebase: `.dl-em-chip` already uses
`backdrop-filter: blur(9px) saturate(1.3)` with a semi-transparent `color-mix` background.
Nothing else in the canvas chrome does. This proposal extends that same treatment,
consistently, to the panel, the accordion headers, the confirm modal, and the tray — so
the whole edit-mode surface reads as one coherent glass layer floating over the page
rather than one glass chip plus several flat opaque cards.

All values below use the site's own `--aw-color-*` tokens via `color-mix`, not new
literals, so the glass tint always follows whatever theme/brand palette is active
(default theme today, but this travels correctly if a client site's theme changes).

```css
.dl-em-panel {
  background: color-mix(in srgb, var(--aw-color-bg-surface) 78%, transparent);
  backdrop-filter: blur(16px) saturate(1.4);
  -webkit-backdrop-filter: blur(16px) saturate(1.4);
  border: 1px solid color-mix(in srgb, var(--aw-color-primary) 18%, transparent);
}

.dl-em-panel header,
.dl-em-acc.dl-em-open > .dl-em-acc-head {
  background: color-mix(in srgb, var(--aw-color-bg-surface) 65%, transparent);
  backdrop-filter: blur(12px) saturate(1.3);
  -webkit-backdrop-filter: blur(12px) saturate(1.3);
}

.dl-em-confirmcard {
  background: color-mix(in srgb, var(--aw-color-bg-surface) 82%, transparent);
  backdrop-filter: blur(20px) saturate(1.5);
  -webkit-backdrop-filter: blur(20px) saturate(1.5);
  border: 1px solid color-mix(in srgb, var(--dlem-danger-fix) 25%, transparent);
}

.dl-em-tray {
  background: color-mix(in srgb, var(--aw-color-bg-surface) 70%, transparent);
  backdrop-filter: blur(14px) saturate(1.3);
  -webkit-backdrop-filter: blur(14px) saturate(1.3);
}

.dl-em-msg.dl-em-ai,
.dl-em-diff {
  background: color-mix(in srgb, var(--aw-color-bg-surface) 60%, transparent);
  backdrop-filter: blur(10px) saturate(1.2);
  -webkit-backdrop-filter: blur(10px) saturate(1.2);
}
```

`-webkit-backdrop-filter` is included alongside the unprefixed property for Safari
compatibility, matching how `.dl-em-chip` is already written elsewhere in the file.

---

## 3. Live verification

Prototyped directly in production via a temporary injected `<style>` override (never
written to a file, purely a browser-session test) and screenshot-verified on
`/niacinamide-aging-skin-barrier`:

- Edit chip → panel open, Comments accordion expanded: panel header and accordion header
  show the intended glass tint/blur, page content is legible but softened underneath —
  no loss of text contrast in the panel body itself.
- Delete-confirmation modal (triggered via the trash icon, then **cancelled** — nothing
  was actually deleted during this test): confirm card shows the blurred glass
  background, and the "Delete" button renders in the corrected warm rust-red, clearly
  distinct from every other blue/teal/gold control on the page.

Screenshots from this session are attached alongside this document.

---

## 4. Implementation scope

All changes are confined to the `STYLES` template literal in
`packages/core/lib/edit-mode/ui-chrome.ts`:

1. Add `--dlem-danger-fix` derivation and repoint `--dlem-danger` to it (or replace its
   fallback chain outright — repointing is lower-risk since anything already reading
   `--dlem-danger` picks up the fix automatically).
2. Fix `.dl-em-btn.dl-em-danger` to use `--dlem-danger` (or `--dlem-danger-fix` directly)
   instead of `--dlem-draft`.
3. Add the five glass rules above (`.dl-em-panel`, panel header / open accordion head,
   `.dl-em-confirmcard`, `.dl-em-tray`, AI message/diff bubbles).
4. No JS/TS logic changes required — this is CSS-only inside one existing file.
5. Suggested follow-up (not in this pass): confirm glass rendering doesn't regress
   perceived contrast for accessibility (WCAG contrast ratio) once applied — a quick
   manual check with the corrected danger color against its blurred background before
   shipping.

This is a single, minimal, one-file diff consistent with the repo's "one task, one
commit, minimal diff" rule.
