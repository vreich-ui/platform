/**
 * ASV2-W5 — the `controls` field KINDS, as a leaf module.
 *
 * Split out of `chat-controls.ts` (which re-exports every name below, so no
 * call site changed) for one reason, recorded in
 * `tests/netlify/function-bundle-budget.test.ts`'s header as "THE CUT":
 * `ui-capabilities.ts` is imported by SERVER code (`server/lib/agent/engine.ts`)
 * and reads exactly this array out of a 25 KB module whose other ~90% is the
 * client-side parser, the brief formatter and its prose. The bundle budget
 * counts SOURCE bytes, so that import cost all 25 KB of cold start however
 * well it tree-shakes. Pointing `ui-capabilities.ts` here instead reclaims it
 * with no behaviour change and, crucially, NO SECOND LIST — the kinds are
 * still declared once, and both the parser and the §7 manifest derive from
 * this file.
 *
 * Nothing but data and types belongs here. It must stay importable by the
 * server: no React, no DOM, no `window`, and no runtime import of its own.
 */

/** §1–§3's form fields — the v1 kinds. */
export const CONTROLS_FORM_KINDS = ['radio', 'checkbox', 'toggle'] as const;
/** §6.1–§6.3's action fields — the v2 kinds. */
export const CONTROLS_ACTION_KINDS = ['actions', 'select_object', 'confirm'] as const;

export type ControlsFieldKind = (typeof CONTROLS_FORM_KINDS)[number] | (typeof CONTROLS_ACTION_KINDS)[number];

/**
 * Every field kind `chat-controls.ts` parses — and therefore every kind the
 * client can render. `ui-capabilities.ts` re-exports this as
 * `RENDERED_CONTROL_KINDS` so §7's manifest and the parser cannot drift: the
 * list Platform sends IS the list `validateField` accepts, derived rather
 * than re-typed.
 */
export const CONTROLS_FIELD_KINDS: readonly ControlsFieldKind[] = [...CONTROLS_FORM_KINDS, ...CONTROLS_ACTION_KINDS];
