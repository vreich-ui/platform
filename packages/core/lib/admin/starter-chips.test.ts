import assert from 'node:assert/strict';
import test from 'node:test';

import { nextAttachedStarter, starterChipsFromPatchOps, type PatchOpLike } from './starter-chips.js';

const op = (op: string, agentAuthored = true): PatchOpLike => ({ op, agent_authored: agentAuthored });

test('chips are derived from the real, agent-authored patch ops — not invented text', () => {
  const chips = starterChipsFromPatchOps([op('set_article_meta'), op('upsert_node'), op('move_node')]);
  assert.equal(chips.length, 3);
  assert.deepEqual(
    chips.map((chip) => chip.key),
    ['set_article_meta', 'upsert_node', 'move_node']
  );
  // Every chip's prompt names the exact capability it came from.
  assert.match(chips[0].prompt, /article meta/i);
  assert.match(chips[1].prompt, /node/i);
});

test('two object types with different capabilities get different chip sets', () => {
  const articleOps = [
    op('set_article_meta'),
    op('upsert_node'),
    op('update_node'),
    op('move_node'),
    op('set_node_visibility'),
  ];
  const visualStandardOps = [op('set_visual_standard_fields')];
  const articleChips = starterChipsFromPatchOps(articleOps);
  const visualStandardChips = starterChipsFromPatchOps(visualStandardOps);
  assert.notDeepEqual(
    articleChips.map((chip) => chip.key),
    visualStandardChips.map((chip) => chip.key)
  );
  // A type with a single real capability gets ONE chip, never padded to 3.
  assert.equal(visualStandardChips.length, 1);
  assert.equal(visualStandardChips[0].key, 'set_visual_standard_fields');
});

test('changing what a type can do changes its chips, with no per-type table to edit', () => {
  const before = starterChipsFromPatchOps([op('set_theme_fields'), op('set_tracking')]);
  // The engine's `agentAuthoredOps` filter (agent/context.ts) is the thing
  // that actually decides this list; simulate it revoking a capability.
  const after = starterChipsFromPatchOps([op('set_theme_fields'), op('set_tracking', false)]);
  assert.deepEqual(
    before.map((chip) => chip.key),
    ['set_theme_fields', 'set_tracking']
  );
  assert.deepEqual(
    after.map((chip) => chip.key),
    ['set_theme_fields']
  );
});

test('never more than 5 chips, even with many agent-authored ops', () => {
  const many = Array.from({ length: 8 }, (_, index) => op(`set_field_${index}`));
  const chips = starterChipsFromPatchOps(many);
  assert.equal(chips.length, 5);
  assert.deepEqual(
    chips.map((chip) => chip.key),
    many.slice(0, 5).map((entry) => entry.op)
  );
});

test('non-agent-authored ops (internal/inverse-only) never become chips', () => {
  const chips = starterChipsFromPatchOps([op('reactivate_term', false), op('add_term')]);
  assert.deepEqual(
    chips.map((chip) => chip.key),
    ['add_term']
  );
});

test('a chip key is short enough to survive as origin.starter (max 64 chars)', () => {
  const chips = starterChipsFromPatchOps([op('set_visual_standard_fields')]);
  assert.ok(chips[0].key.length <= 64);
});

// ─── the starter-key lifetime (ChatComposer's `attachedStarter`, extracted
//     into `nextAttachedStarter` so the policy is testable without a
//     renderer — this repo's test stack has none) ──────────────────────────

test('a chip click attaches its key — the composer FILLS, it never sends on its own', () => {
  // "Fills, never sends" is structural: a chip click only ever reaches
  // `nextAttachedStarter` (which returns a key to remember) — there is no
  // path from a chip click to `onSend`. This asserts the one thing a click
  // DOES do: mark the draft as coming from that chip.
  const attached = nextAttachedStarter(undefined, { type: 'chip', key: 'set_article_meta' });
  assert.equal(attached, 'set_article_meta');
});

test('editing the text after a chip click keeps the attribution', () => {
  const afterClick = nextAttachedStarter(undefined, { type: 'chip', key: 'upsert_node' });
  const afterTyping = nextAttachedStarter(afterClick, { type: 'edit', nextText: 'Help me add a node about pricing.' });
  assert.equal(afterTyping, 'upsert_node');
});

test('clearing the composer to empty drops the attribution — later text is unattributed', () => {
  const afterClick = nextAttachedStarter(undefined, { type: 'chip', key: 'upsert_node' });
  const afterClear = nextAttachedStarter(afterClick, { type: 'edit', nextText: '' });
  assert.equal(afterClear, undefined);
  const afterRetyping = nextAttachedStarter(afterClear, { type: 'edit', nextText: 'Something unrelated.' });
  assert.equal(afterRetyping, undefined, 'never silently re-attributes a fresh message to the old chip');
});

test('a wholesale overwrite from something other than a chip (quick context, a suggestion, a draft seed) drops the attribution', () => {
  const afterClick = nextAttachedStarter(undefined, { type: 'chip', key: 'set_page_meta' });
  assert.equal(nextAttachedStarter(afterClick, { type: 'overwrite' }), undefined);
});

test('sending is one-shot: the next draft starts clean', () => {
  const afterClick = nextAttachedStarter(undefined, { type: 'chip', key: 'set_page_meta' });
  assert.equal(nextAttachedStarter(afterClick, { type: 'sent' }), undefined);
});

test('typing a message with no chip ever clicked never attaches a starter key', () => {
  let attached: string | undefined;
  attached = nextAttachedStarter(attached, { type: 'edit', nextText: 'H' });
  attached = nextAttachedStarter(attached, { type: 'edit', nextText: 'Hi there' });
  assert.equal(attached, undefined);
});
