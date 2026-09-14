/**
 * ASV2-W4.3 — the `ui_capabilities` manifest (chat-controls protocol §7).
 *
 * Chats on the `cmsAgentEngine` path get NO system prompt from Platform —
 * CMS-Agent owns the Client Manager prompt (engine.ts's header, CA6). So the
 * only per-turn channels Platform controls are `context.approval_note` (prose)
 * and this object (structured). It rides next to `approval_note` on every
 * `client_manager.turn.v1` request and answers one question for that turn:
 * **what can the surface on the other end actually render, and which
 * deterministic verbs may it fire?**
 *
 * It is a capability statement, never an authorization. Rights are enforced
 * where they always were — in the verb itself and in `resolveObjectControls`
 * — and §6.4's client-side `allowedAction` gate reads this manifest only to
 * decide whether a button renders *enabled* or *disabled with a reason*.
 *
 * Pure and dependency-light on purpose: it is imported by SERVER code
 * (`server/lib/agent/engine.ts`) as well as by the admin bundle, so it may
 * never reach for React, the DOM or `window`.
 *
 * ASV2-W5: it reads the two things it needs from their LEAF modules —
 * `controls-kinds.ts` and `quick-actions-registry.ts` — not from
 * `chat-controls.ts` / `quick-actions.ts`, which re-export them for every
 * client caller. Same single declaration of each; the client surfaces those
 * two files also contain (the parser, the executor, `inventory-chat.ts`) are
 * simply no longer on `admin-agent-chat`'s cold-start graph. Importing the
 * non-leaf spelling here silently re-adds ~55 KB — see
 * `tests/netlify/function-bundle-budget.test.ts`.
 */
import { CONTROLS_FIELD_KINDS } from './controls-kinds.js';
import { QUICK_ACTIONS, type QuickActionDefinition, type QuickActionParam } from './quick-actions-registry.js';

/** §7: the protocol version. An agent that does not recognise it ignores the object. */
export const UI_CAPABILITIES_VERSION = 2;

/**
 * The `controls` field kinds THIS client build renders.
 *
 * The first three are v1 (`chat-controls.ts`'s form fields); the last three are
 * §6's v2 action-block kinds. A kind absent from this list is not forbidden —
 * if the agent emits it anyway the block falls back to a plain code block (§7)
 * — so the list over-claiming is a cosmetic failure, never a wrong action.
 *
 * W4.3 had to hard-code this as a literal and asked a comment to keep it in
 * lockstep with the parser. W4.1 removed the reason: the kinds are a RUNTIME
 * array (`CONTROLS_FIELD_KINDS`, declared in `controls-kinds.ts` and
 * re-exported by `chat-controls.ts`) beside the union, so the manifest
 * Platform sends IS the list `validateField` accepts.
 * The dependency runs manifest → parser, which is the direction that does not
 * pull the manifest into the parser. `ui-capabilities.test.ts` still pins the
 * literal, so a deliberate change to either side has to be re-stated there.
 */
export const RENDERED_CONTROL_KINDS: readonly string[] = CONTROLS_FIELD_KINDS;

/** One parameter's schema, in the shape CMS-Agent's `uiCapabilityActionParamSchema` accepts (`.strict()`: `type` + optional `required`, nothing else). */
export interface UiCapabilityActionParam {
  /** 1..32 chars upstream. `enum` for a popover choice, `string` for free text. */
  type: string;
  required?: boolean;
}

/** One offered verb. `verb` must match `^[A-Za-z0-9_-]{1,64}$` and `label` 1..120 chars upstream. */
export interface UiCapabilityAction {
  verb: string;
  label: string;
  params?: Record<string, UiCapabilityActionParam>;
}

export interface UiCapabilities {
  v: typeof UI_CAPABILITIES_VERSION;
  controls: string[];
  actions: UiCapabilityAction[];
}

/**
 * One registry param → its wire schema.
 *
 * A param WITH a field is collectable in a popover and the registry requires
 * that field to carry a pre-selected `value` (`QuickActionChoiceField.value`),
 * so there is always an answer even if the editor supplies none: `required`
 * is false. A param WITHOUT a field is exactly the opposite — it is the record
 * of why the action is ambiguous and has to be answered before anything can
 * run (`quick-actions.ts`'s own note), so it is required free text.
 */
const paramSchema = (param: QuickActionParam): UiCapabilityActionParam =>
  param.field?.kind === 'choice' ? { type: 'enum', required: false } : { type: 'string', required: true };

const paramsFor = (params: readonly QuickActionParam[]): Record<string, UiCapabilityActionParam> =>
  Object.fromEntries(params.map((param) => [param.id, paramSchema(param)]));

const appliesToType = (definition: QuickActionDefinition, objectType: string): boolean =>
  definition.objectType === undefined || (definition.objectType as readonly string[]).includes(objectType);

const hasRight = (roles: readonly string[], definition: QuickActionDefinition): boolean =>
  definition.rights.some((right) => roles.includes(right));

/**
 * The focused object's quick actions, rights-filtered for the caller.
 *
 * Two deliberate non-filters, both recorded rather than silently applied:
 *
 * - **`appliesTo` (the state gate) is NOT evaluated here.** It takes a
 *   `LibraryRow` — status, review_state, published_time, unpublished_changes
 *   — and the turn wire carries only an `{object_type, object_id}` pair. §7
 *   asks for a *rights*-filtered list, and a manifest is a statement about the
 *   surface, not about this revision's state; the state gate still runs where
 *   it always did, in `definitionsForRow` on the client, and the verb refuses
 *   anything the state forbids. So the manifest can name `object_publish` on a
 *   record that cannot publish right now: the button renders, the verb answers
 *   with a receipt, and nothing is granted that was not already granted.
 * - **`agent_chat` entries are kept.** They are not dead buttons: §6.1 routes a
 *   click through the same `executionFor(params)` rule the action strip uses,
 *   and a 2+-param action hands back to chat rather than running a verb.
 *
 * `roles` is `readonly string[]` and not the `QuickActionRight` union on
 * purpose — the server resolves `Role[]` (`server/lib/roles.ts`) and the admin
 * resolves `UserRole[]`; comparing as strings keeps this module from binding
 * the two together for a membership test.
 */
export const uiCapabilityActionsFor = (
  objectType: string | undefined,
  roles: readonly string[]
): UiCapabilityAction[] => {
  // §7: "Empty array when no object is in focus (a free chat) or when the
  // caller may run none of them."
  if (!objectType) return [];
  return QUICK_ACTIONS.filter(
    (definition) => appliesToType(definition, objectType) && hasRight(roles, definition)
  ).map((definition) => ({
    verb: definition.verb,
    label: definition.label,
    params: paramsFor(definition.params),
  }));
};

/** The whole manifest for one turn. */
export const buildUiCapabilities = (objectType: string | undefined, roles: readonly string[]): UiCapabilities => ({
  v: UI_CAPABILITIES_VERSION,
  controls: [...RENDERED_CONTROL_KINDS],
  actions: uiCapabilityActionsFor(objectType, roles),
});
