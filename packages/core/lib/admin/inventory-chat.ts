/**
 * Admin Inventory (T5) — the pure prompt builder behind "Send to chat".
 *
 * `InventoryPage.tsx` is the only caller: it collects a free-text intent from
 * the human plus the selected `InventoryHit`s (single row or bulk), and this
 * module turns that into ONE prompt string — routed to the chat through the
 * EXISTING `onSeedComposer`/`composerSeed` → `AgentRail`'s `draftSeed` path
 * (see that file's header). No React, no I/O, no verb calls: this file only
 * ever produces a string, which is what makes it testable under `node:test`
 * without a DOM (`packages/core/admin/**` is excluded from
 * `tsconfig.test.json` — anything decided there is decided where no test can
 * see it, so the decision lives here instead).
 *
 * Shape: one line of free text (the intent), then a fenced block listing
 * `{collection, id, label}` for each selected row — "collection" here is
 * always the canonical PLURAL spelling (`'objects' | 'artifacts' | 'stores'`,
 * `inventory-server-logic.ts`'s `InventoryCollection`), not a per-store kind.
 */

export interface InventoryChatSelectionItem {
  collection: string;
  id: string;
  label: string;
}

/** BRIEF.md: a hand-off cannot carry more than this many rows. */
export const INVENTORY_CHAT_SELECTION_CAP = 50;

export interface InventoryChatPromptResult {
  /** The full seeded composer text. */
  prompt: string;
  /** How many rows the fenced block actually lists (≤ the cap). */
  includedCount: number;
  /** True when `selection` was longer than the cap and had to be trimmed. */
  truncated: boolean;
}

/**
 * Fenced blocks end at a line of backticks. A label carrying its own
 * backticks — pasted markdown, a filename, an attacker-crafted tag — could
 * otherwise close the fence early and let the rest of the row (or a forged
 * "intent" appended after it) escape into the prompt as text the agent reads
 * as ITS OWN instructions rather than untrusted row data. Replacing every
 * backtick with the visually-identical fullwidth grave accent (｀, U+FF40 —
 * FULLWIDTH GRAVE ACCENT) removes every substring of a formatted row that
 * could ever equal a fence line, while leaving the row readable. A literal
 * newline is likewise collapsed to a space — not a security requirement on
 * its own (no fence can form without a backtick), but the fenced block is
 * documented as one row per line and a label that already spans lines would
 * otherwise silently break that.
 */
function escapeForFence(value: string): string {
  return value.replace(/`/g, '｀').replace(/\r\n|\r|\n/g, ' ');
}

function formatRow(item: InventoryChatSelectionItem): string {
  return `${escapeForFence(item.collection)} | ${escapeForFence(item.id)} | ${escapeForFence(item.label)}`;
}

/**
 * Builds the seeded prompt: the human's free-text intent (untouched — it is
 * the message's own words, never inside the fence), then a fenced,
 * mechanically-parseable list of the selection. Selections longer than
 * `INVENTORY_CHAT_SELECTION_CAP` are trimmed to the first N rows and the
 * prompt says so, rather than silently dropping rows with no record of it.
 */
export function buildInventoryChatPrompt(
  intent: string,
  selection: readonly InventoryChatSelectionItem[]
): InventoryChatPromptResult {
  const trimmedIntent = intent.trim();
  const included = selection.slice(0, INVENTORY_CHAT_SELECTION_CAP);
  const truncated = selection.length > included.length;

  const lines: string[] = [
    trimmedIntent || 'Look at these inventory rows.',
    '',
    '```',
    'collection | id | label',
    ...included.map(formatRow),
    '```',
  ];
  if (truncated) {
    lines.push(
      '',
      `(Selection capped at ${INVENTORY_CHAT_SELECTION_CAP} — ${
        selection.length - included.length
      } more row(s) not listed.)`
    );
  }

  return { prompt: lines.join('\n'), includedCount: included.length, truncated };
}
