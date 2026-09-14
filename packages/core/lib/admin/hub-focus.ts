/**
 * ASV2-W1.2 — whether the "Start something / Conversations" rail is visible
 * on `AgentsHub.tsx` (the hub-focus design: the conversation is the point,
 * the rail is a guest). There is no DOM harness in this repo (AGENTS.md §4),
 * so the decision is a pure function here, asserted by `hub-focus.test.ts`
 * instead of by rendering.
 *
 * The rule, per the shared brief's design table:
 *   - No conversation open (`activeId` unset) → the rail is ALWAYS visible.
 *     There is nothing for it to steal width from yet, and it is how the
 *     hub offers "Recent sessions" before any conversation exists.
 *   - A conversation is open → the rail is hidden UNLESS the caller has
 *     explicitly asked for it back (the "Sessions" pill in the chat header,
 *     `userToggled === true`). `undefined` (never touched) and `false`
 *     (explicitly dismissed again) both mean hidden.
 *
 * DECISION — the toggle is scoped to the CURRENT conversation, not sticky
 * across a switch: `AgentsHub.tsx` resets `userToggled` back to `undefined`
 * in the same effect that notices `activeId` changed (including switching
 * via the rail itself, a starter, or the ⌘K "Switch conversation…" entries).
 * Without that reset, opening the rail once to jump between two chats would
 * leave it pinned open for the rest of the session — the opposite of what
 * focus mode is for. `railVisible` itself stays pure and does not know about
 * "the previous `activeId`"; the reset is the host component's job, and is
 * exercised here only as the decision table below (same `activeId`, `false`
 * after `true`) rather than as a lifecycle test — there is no DOM harness to
 * lifecycle-test against.
 */
export function railVisible(activeId: string | undefined, userToggled: boolean | undefined): boolean {
  if (!activeId) return true;
  return userToggled === true;
}
