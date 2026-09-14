/**
 * ASV2-W3 — the OBJECT ACTION STRIP's decisions.
 *
 * The strip is a row of deterministic verbs the agent sits next to, so an
 * editor clicks the verb instead of describing it. It renders in two places
 * (`admin/ObjectActionStrip.tsx`): beside the dock's composer, and as a row
 * `⋯` menu in the object list. Both read THIS module, which reads
 * `quick-actions.ts`. There is one verb registry in this repo and this is not
 * a second one — nothing here names a verb, a label or a wire body.
 *
 * ## Why this module exists at all, given `DEFAULT_QUICK_ACTION_REGISTRY`
 *
 * One rule differs, deliberately, and it is the whole reason for the file.
 * The chip registry's documented doctrine is "no rights, no chip": it OMITS
 * an action the caller may not use, because a chip is an optional shortcut
 * whose absence reads as nothing at all. The strip is not that. It is the
 * surface's statement of what can be done to this object, so it follows the
 * `resolveObjectControls` convention instead — DISABLED WITH A REASON, NEVER
 * HIDDEN — and that is a different resolution, not a different registry.
 *
 * ## Presence vs. permission (the line this module draws)
 *
 * - `appliesTo` (the STATE gate) stays a PRESENCE gate: an action that does
 *   not apply to this record right now is absent. "Publish" on an object with
 *   nothing to publish is not a control the editor is being refused, it is a
 *   control that has no subject; rendering it disabled would say the viewer
 *   lacks something they do not lack. This matches the registry's own reading
 *   and `resolveObjectControls`'s, whose every entry describes an action that
 *   exists for the record it is looking at.
 * - `rights` (the PERMISSION gate) becomes a DISABLED STATE with the reason
 *   in the tooltip. That is what a viewer must see rather than a gap.
 *
 * DISPLAY ONLY, like every other rights mirror in `lib/admin` — the server
 * re-derives authority on every call. A bug here can disable a control the
 * caller was entitled to; it can never grant a write.
 */
import type { LibraryRow } from './library-logic.js';
import type { ControlState, ObjectControlMap } from './object-detail-actions.js';
import {
  buildQuickActionPrompt,
  definitionsForRow,
  executionFor,
  type QuickActionExecution,
  type QuickActionParam,
  type QuickActionRight,
  type QuickActionVerb,
} from './quick-actions.js';

// ─── entries ────────────────────────────────────────────────────────────────

/**
 * One button on the strip (or one item in the `⋯` menu). Everything the two
 * renderers need, and nothing either of them decides for itself.
 */
export interface ActionStripEntry {
  id: string;
  label: string;
  /** Tooltip while enabled: what this is about to do. */
  title: string;
  verb: QuickActionVerb;
  execution: QuickActionExecution;
  rights: readonly QuickActionRight[];
  params: readonly QuickActionParam[];
  /** Set on `chat-handoff` entries only: the prompt the composer is seeded with. */
  prompt?: string;
  /** `{enabled:true}`, or `{enabled:false, reason}` — the `ControlState` convention. */
  state: ControlState;
}

export interface ActionStripInput {
  row: LibraryRow;
  /** The signed-in caller's roles, as `useCurrentUser()` reports them. */
  roles: readonly string[];
  /**
   * Ids this surface already offers through its OWN controls, so the strip
   * does not grow a second copy of a button that is already on screen. A
   * surface-level fact, exactly like `QuickActionChips`' prop of the same
   * name — and, like it, excluding hides nothing: the control that owns the
   * id is still on screen with its own reason.
   */
  exclude?: readonly string[];
  /**
   * A surface's AUTHORITATIVE state for an entry, when it holds one the
   * registry cannot see. The object workspace resolves publish-shaped gates
   * from the release row (`resolveObjectControls`), which knows about
   * approval policy and unconfirmed release state; the registry knows none of
   * that. An override that is DISABLED wins over everything, and its reason
   * is the one shown — so the strip's Publish and the page's own Publish
   * button can never disagree about whether publishing is possible.
   *
   * An override that is ENABLED does not override the rights gate: authority
   * is still authority.
   */
  overrides?: Readonly<Partial<Record<string, ControlState>>>;
}

const ROLE_LABEL: Record<QuickActionRight, string> = {
  owner: 'Owner',
  admin: 'Admin',
  publisher: 'Publisher',
  editor: 'Editor',
};

/** "Owner, Admin or Publisher" — the same list the entry is gated on, spelled for a human. */
export function actionRightsLabel(rights: readonly QuickActionRight[]): string {
  const labels = rights.map((right) => ROLE_LABEL[right] ?? right);
  if (labels.length === 0) return 'a role you do not hold';
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/**
 * The reason a viewer sees on a control they may not run. One sentence, in
 * the same voice as `object-detail-actions.ts`'s `NO_ROLE_REASON`, and it
 * names the roles rather than saying "you lack permission" — a reason that
 * does not say what would fix it is not a reason.
 */
export const actionRightsReason = (rights: readonly QuickActionRight[]): string =>
  `You need the ${actionRightsLabel(rights)} role to run this.`;

const hasRight = (roles: readonly string[], rights: readonly QuickActionRight[]): boolean =>
  rights.some((right) => roles.includes(right));

/**
 * Every action this record admits, each with its enabled state and — when
 * disabled — the reason for the tooltip. Ordering is the registry's.
 */
export function resolveActionStrip(input: ActionStripInput): ActionStripEntry[] {
  const excluded = new Set(input.exclude ?? []);
  return definitionsForRow(input.row)
    .filter((definition) => !excluded.has(definition.id))
    .map((definition) => {
      const execution = executionFor(definition.params);
      const override = input.overrides?.[definition.id];
      const state: ControlState =
        override && !override.enabled
          ? override
          : hasRight(input.roles, definition.rights)
            ? { enabled: true }
            : { enabled: false, reason: actionRightsReason(definition.rights) };
      return {
        id: definition.id,
        label: definition.label,
        title: definition.title,
        verb: definition.verb,
        execution,
        rights: definition.rights,
        params: definition.params,
        ...(execution === 'chat-handoff' ? { prompt: buildQuickActionPrompt(definition, input.row) } : {}),
        state,
      };
    });
}

/**
 * The object workspace's own control map, narrowed to the ids the strip also
 * offers. Kept here rather than inline in the `.tsx` so the mapping between
 * the two vocabularies is one tested statement: three ids are the SAME
 * action seen by two gates, and the rest of either map is not.
 *
 * `validate` and `replace_image` have no `ObjectControlId` at all — there is
 * nothing to override, and inventing an entry for them would be inventing a
 * gate.
 */
export function objectControlOverrides(
  controls: Pick<ObjectControlMap, 'submit_review' | 'publish' | 'new_variant'>
): Record<string, ControlState> {
  return {
    submit_review: controls.submit_review,
    publish: controls.publish,
    new_variant: controls.new_variant,
  };
}

// ─── the trace line ─────────────────────────────────────────────────────────

/**
 * THE SEP 7 MANDATE, in one line of text: the transcript stays the record.
 *
 * A button that changes a governed object and leaves no mark in the
 * conversation makes the transcript a partial account of what happened to
 * that object. So a run appends an ordinary USER message through the chat
 * path that already exists — no new event type, no server change, no new
 * API — spelled exactly as `docs/cms-architecture/chat-controls-protocol.md`
 * §6.1 specifies:
 *
 *     [action:<verb>] <label> — <receipt>
 */
export const ACTION_TRACE_SEPARATOR = ' — ';

export interface ActionTraceFields {
  verb: string;
  label: string;
  /** `QuickActionResult.receipt` — one sentence, success or failure. */
  receipt: string;
}

/** Collapsed to one line: a trace is a single transcript line, whatever the receipt did. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function actionTraceLine(fields: ActionTraceFields): string {
  return `[action:${oneLine(fields.verb)}] ${oneLine(fields.label)}${ACTION_TRACE_SEPARATOR}${oneLine(fields.receipt)}`;
}

/**
 * The inverse, so the format is provable rather than asserted. Splits at the
 * FIRST separator on purpose: receipts contain em dashes of their own
 * ("Validated — no blockers and no warnings."), and the label never does.
 */
export function parseActionTraceLine(text: string): ActionTraceFields | undefined {
  const match = /^\[action:([^\]\s]+)\]\s+([\s\S]+)$/.exec(text.trim());
  if (!match) return undefined;
  const verb = match[1]!;
  const rest = match[2]!;
  const at = rest.indexOf(ACTION_TRACE_SEPARATOR);
  if (at <= 0) return undefined;
  const label = rest.slice(0, at).trim();
  const receipt = rest.slice(at + ACTION_TRACE_SEPARATOR.length).trim();
  if (!label || !receipt) return undefined;
  return { verb, label, receipt };
}

// ─── delivering the trace (and when NOT to) ─────────────────────────────────

export type ActionTraceDelivery =
  | { kind: 'send'; text: string }
  | { kind: 'skip'; reason: string };

export interface ActionTraceInput extends ActionTraceFields {
  /**
   * Whether a conversation for this object ALREADY EXISTS — the surface's
   * own answer, from the same decision W2 wrote: `dockChatIntent('send', …)`
   * returning `attach` on the list surfaces, a held `chatId` on the object
   * workspace.
   */
  chatBound: boolean;
  /** Which mode produced this — a hand-off has no receipt to record. */
  execution: QuickActionExecution;
}

/**
 * THE RULE THAT PROTECTS THE HARD INVARIANT: a click never mints a chat doc.
 *
 * The trace rides `chat.send`, and on both list surfaces `send` is the lazy
 * binding — it calls `createObjectChat` when no conversation exists yet. So a
 * trace fired into an unbound object would mint a conversation as a SIDE
 * EFFECT of clicking Validate, which is exactly the thing W2 built
 * `dockChatIntent` to prevent. The decision, therefore:
 *
 *   **No conversation yet → no trace, and nothing is created.**
 *
 * The run still happened and the editor still sees its receipt (the toast),
 * and the object's own activity record is unaffected — what is given up is
 * one line in a transcript that does not exist. Nothing is backfilled when a
 * conversation is later opened: a trace claims to be a record of the moment
 * it was written, and a line inserted after the fact next to messages it did
 * not precede would be a worse record than none.
 *
 * Both outcomes are traced, not just successes. A refused publish is the half
 * of the record an editor most needs afterwards, and the receipt already says
 * what happened in one sentence either way.
 */
export function actionTraceDelivery(input: ActionTraceInput): ActionTraceDelivery {
  if (input.execution === 'chat-handoff') {
    return { kind: 'skip', reason: 'A hand-off writes its own message; nothing ran here to record.' };
  }
  if (!oneLine(input.receipt)) {
    return { kind: 'skip', reason: 'The run reported no receipt, so there is nothing to record.' };
  }
  if (!input.chatBound) {
    return {
      kind: 'skip',
      reason: 'No conversation is attached to this object yet, and a trace must not mint one.',
    };
  }
  return { kind: 'send', text: actionTraceLine(input) };
}

// ─── §6.1: pre-filled args — run now, or collect first ──────────────────────

export type ActionDispatch =
  /** Everything this entry needs is answered: run the verb. */
  | 'run'
  /** Go through the entry's own execution mode — immediate, popover, or hand-off. */
  | 'collect';

/**
 * ASV2-W5 — what an §6.1 `actions` button does when the block pre-fills `args`.
 *
 * §6.1 says the block's `args` are PRE-FILLED parameters, so a button whose
 * every parameter is already answered has nothing left to ask for. The
 * exception, and the reason this is a tested function rather than an
 * expression inside `ControlsCard.tsx`:
 *
 * **A `chat-handoff` entry is NEVER `run`, however complete its args are.**
 * `agent_chat` is a real registry entry (`replace_image`), §7's manifest
 * deliberately keeps it, and its three parameters are advertised as required
 * strings — so an agent that fills all three is doing exactly what the
 * manifest invites. Dispatching that to `runQuickAction` reaches its
 * `agent_chat` arm, which answers `unsupported` ("… is a conversation with
 * the agent, not a direct verb"): a danger toast, and a `ran <verb>` receipt
 * for something that never ran. A hand-off seeds the composer whatever its
 * args say — that is what `executionFor` decided, and what the manifest
 * promises the agent.
 *
 * A zero-parameter entry is `collect` too, and that is not a special case:
 * `collect` for an `immediate` entry means "run it immediately", through the
 * one path that owns what immediate means.
 */
export function actionDispatchFor(
  entry: Pick<ActionStripEntry, 'execution' | 'params'>,
  values: Readonly<Record<string, string>>
): ActionDispatch {
  if (entry.execution === 'chat-handoff') return 'collect';
  if (entry.params.length === 0) return 'collect';
  return entry.params.every((param) => values[param.id] !== undefined) ? 'run' : 'collect';
}
