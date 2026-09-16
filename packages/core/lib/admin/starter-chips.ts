/**
 * PCL-P4 — composer starter chips.
 *
 * A chip is a running start for the FIRST message in an object-bound chat,
 * never a send of its own (the editor still presses Send — see
 * `ChatComposer` in `../../admin/chat.tsx`). What makes a chip legitimate is
 * where its text comes from: the object type's REAL, enforced capabilities,
 * not a per-surface guess.
 *
 * The house already has exactly one authoritative source for "what can an
 * agent actually do to this object type" — `buildObjectContract(objectType)
 * .patch_ops` (`lib/registry/object-contract.ts`), filtered to
 * `agent_authored` ops. That is the SAME filter `agent/context.ts`'s
 * `agentAuthoredOps` applies before the engine will let CMS-Agent propose a
 * patch op for a type, so a chip can never promise something the object
 * cannot really do, and a type that gains, loses, or reclassifies an op (a
 * schema change, never a change here) changes its chips for free.
 *
 * This module takes the already-derived, already-ordered `patch_ops` array
 * as plain data (`PatchOpLike`) rather than importing the registry itself —
 * `object-contract.ts` pulls in every body-schema zod tree, which is exactly
 * the weight `chat-client.ts`/`chat.tsx` (browser bundle) must not carry. The
 * SERVER derives the chips (`admin-agent-chat.ts`'s `chatSummary`, which
 * already has `buildObjectContract` in its module graph via
 * `agent/context.ts`) and ships them down as plain `StarterChip[]` on
 * `ChatSummaryView`; the browser only ever renders that data.
 */

export interface StarterChip {
  /** The op name this chip came from — carried verbatim as `origin.starter` (max 64 chars, enforced by `sendChatMessage`). */
  key: string;
  /** Chip button text. */
  label: string;
  /** What fills the composer on click. Still just a draft — the editor edits and sends it themselves. */
  prompt: string;
}

export interface PatchOpLike {
  op: string;
  agent_authored: boolean;
}

/** 3 to 5 chips (rule 2); never padded past what the type can really do (rule 4). */
const MAX_CHIPS = 5;

/**
 * `${verb}_${rest}` -> a plain-English verb phrase. Every patch op in the
 * house grammar (`schema/object-patch-ops.ts`) is named this way, so this
 * covers every type without a per-type or per-surface table.
 */
const VERB_PHRASES: Record<string, string> = {
  set: 'update',
  upsert: 'add or update',
  update: 'update',
  move: 'reorder',
  remove: 'remove',
  add: 'add',
  deprecate: 'retire',
  reactivate: 'reinstate',
  replace: 'replace',
};

const capitalize = (text: string): string => (text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text);

const chipForOp = (op: string): StarterChip => {
  const [verb, ...rest] = op.split('_');
  const phrase = VERB_PHRASES[verb] ?? verb;
  const noun = rest.join(' ');
  return {
    key: op,
    label: capitalize(noun ? `${phrase} ${noun}` : phrase),
    prompt: noun ? `Help me ${phrase} the ${noun}.` : `Help me ${phrase} this.`,
  };
};

/**
 * DERIVE, NEVER HAND-AUTHOR (object-contract.ts's own rule, followed here):
 * every chip traces back to one entry in `patchOps`. Only `agent_authored`
 * ops qualify — the same gate the engine itself enforces — and the type's
 * own order (already meaningful: meta-level ops before structural ones)
 * decides which ops make the cut when there are more than `MAX_CHIPS`.
 */
export const starterChipsFromPatchOps = (patchOps: readonly PatchOpLike[]): StarterChip[] =>
  patchOps
    .filter((op) => op.agent_authored)
    .slice(0, MAX_CHIPS)
    .map((op) => chipForOp(op.op));

// ─── the starter-key lifetime decision (rule 1's "carry the KEY" + the
//     "decide what happens on a wholesale overwrite" instruction) ──────────

/**
 * PCL-P4 — pure decision table for what a composer's `attachedStarter` (the
 * chip key the CURRENT draft still traces back to, or `undefined`) becomes
 * on each thing that can happen to the box, factored out of `ChatComposer`
 * (`admin/chat.tsx`) so the lifetime policy is unit-testable without a
 * renderer (this repo's test stack has none — see `use-current-user.test.ts`).
 *
 * The policy, stated once here rather than split across event handlers:
 *   - `chip`   — a chip click. Always wins; the box becomes that chip's text.
 *   - `edit`   — a keystroke/paste/cut inside the textarea. Keeps the
 *                current attribution UNLESS the box is now fully empty —
 *                emptying is the one unambiguous "I'm done with that start"
 *                a plain change event can read. (A select-all-and-paste that
 *                never passes through empty is a known, accepted gap — see
 *                `ChatComposer`'s doc comment on `attachedStarter`.)
 *   - `overwrite` — anything ELSE that fills the box wholesale and is not a
 *                starter chip (a quick-context chip, a legacy suggestion
 *                chip, an inbound `draftSeed`): always drops the attribution,
 *                because attributing that text to an unrelated chip would be
 *                exactly the silent misattribution rule 1 forbids.
 *   - `sent`   — the message went out. Attribution is one-shot; the next
 *                message starts clean.
 */
export type ComposerStarterEvent =
  | { type: 'chip'; key: string }
  | { type: 'edit'; nextText: string }
  | { type: 'overwrite' }
  | { type: 'sent' };

export const nextAttachedStarter = (current: string | undefined, event: ComposerStarterEvent): string | undefined => {
  switch (event.type) {
    case 'chip':
      return event.key;
    case 'edit':
      return event.nextText === '' ? undefined : current;
    case 'overwrite':
    case 'sent':
      return undefined;
  }
};
