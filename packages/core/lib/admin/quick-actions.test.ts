import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  DEFAULT_QUICK_ACTION_REGISTRY,
  QUICK_ACTIONS,
  buildQuickActionPrompt,
  definitionsForRow,
  executionFor,
  runQuickAction,
  type QuickActionChip,
  type QuickActionHandlers,
} from './quick-actions.js';
import type { VerbResult } from './bulk-object-ops.js';
import type { LibraryRow } from './library-logic.js';

const row: LibraryRow = {
  object_id: 'page_x',
  object_type: 'page',
  display_name: 'A page',
  updated_at: '2026-07-10T00:00:00.000Z',
  status: 'active',
  review_state: 'none',
  published_time: null,
  unpublished_changes: false,
};

const article: LibraryRow = {
  ...row,
  object_id: 'ci_20260710_kelp',
  object_type: 'content_item',
  display_name: 'Kelp, revisited',
};

const noopHandlers: QuickActionHandlers = { run: () => {}, openPopover: () => {}, handOff: () => {} };

const ids = (roles: readonly string[], target: LibraryRow = row, handlers = noopHandlers): string[] =>
  DEFAULT_QUICK_ACTION_REGISTRY.resolve({ row: target, roles, getToken: async () => '', handlers }).map(
    (chip) => chip.id
  );

const chipFor = (id: string, target: LibraryRow, roles: readonly string[] = ['admin']): QuickActionChip => {
  const chip = DEFAULT_QUICK_ACTION_REGISTRY.resolve({
    row: target,
    roles,
    getToken: async () => '',
    handlers: noopHandlers,
  }).find((candidate) => candidate.id === id);
  assert.ok(chip, `expected a "${id}" chip`);
  return chip;
};

/** A `VerbCaller` that records what it was asked and replays canned answers. */
const fakeVerbs = (replies: Record<string, VerbResult>) => {
  const calls: Array<Record<string, unknown>> = [];
  const call = async (body: Record<string, unknown>): Promise<VerbResult> => {
    calls.push(body);
    return replies[String(body.action)] ?? { status: 200, body: {} };
  };
  return { call, calls };
};

// ─── resolution ─────────────────────────────────────────────────────────────

describe('quick-action resolution', () => {
  it('offers the shared lifecycle chips on any governed type', () => {
    assert.deepStrictEqual(ids(['admin']), ['validate', 'submit_review', 'publish', 'replace_image']);
  });

  it('offers the article-only variant chip on content_item and nowhere else', () => {
    assert.ok(ids(['admin'], article).includes('new_variant'));
    assert.ok(!ids(['admin'], row).includes('new_variant'));
  });

  it('offers no image chip on a type that carries no images', () => {
    const theme: LibraryRow = { ...row, object_type: 'theme', object_id: 'thm_house' };
    assert.ok(!ids(['admin'], theme).includes('replace_image'));
  });

  it('drops a chip whose state gate does not apply — an archived row is not publishable', () => {
    const archived: LibraryRow = { ...row, status: 'archived' };
    assert.deepStrictEqual(ids(['admin'], archived), []);
  });

  it('drops Submit for review while a review is already open, and Publish with it', () => {
    const inReview: LibraryRow = { ...row, review_state: 'open' };
    assert.deepStrictEqual(ids(['admin'], inReview), ['validate', 'replace_image']);
  });

  it('drops Publish on a published row with nothing new to publish', () => {
    const clean: LibraryRow = { ...row, published_time: '2026-07-01T00:00:00.000Z', unpublished_changes: false };
    assert.ok(!ids(['admin'], clean).includes('publish'));
    const dirty: LibraryRow = { ...clean, unpublished_changes: true };
    assert.ok(ids(['admin'], dirty).includes('publish'));
  });

  it('every definition names a verb the audit table records as existing', () => {
    const known = new Set([
      'object_validate',
      'object_submit_review',
      'object_publish',
      'object_create_variant',
      'agent_chat',
    ]);
    for (const definition of QUICK_ACTIONS) assert.ok(known.has(definition.verb), definition.id);
  });
});

// ─── rights gating: no rights, no chip ──────────────────────────────────────

describe('quick-action rights gating', () => {
  it('resolves to nothing at all for a caller with no roles', () => {
    assert.deepStrictEqual(ids([]), []);
  });

  it('resolves to nothing for a viewer — read-only is not a chip-less-one-chip case', () => {
    assert.deepStrictEqual(ids(['viewer']), []);
  });

  it('omits Publish for an editor rather than rendering it disabled', () => {
    const editorChips = ids(['editor']);
    assert.ok(editorChips.includes('submit_review'));
    assert.ok(!editorChips.includes('publish'), 'a chip the editor may never use is absent, not disabled');
  });

  it('gives a publisher the publish chip', () => {
    assert.ok(ids(['publisher']).includes('publish'));
  });

  it('resolves to nothing without handlers — never a chip that does nothing when clicked', () => {
    assert.deepStrictEqual(
      DEFAULT_QUICK_ACTION_REGISTRY.resolve({ row, roles: ['owner', 'admin'], getToken: async () => '' }),
      []
    );
  });
});

// ─── execution mode follows the parameter count ─────────────────────────────

describe('quick-action execution mode', () => {
  it('maps parameter count to mode: 0 → immediate, 1 → popover, 2+ → chat-handoff', () => {
    assert.strictEqual(executionFor([]), 'immediate');
    assert.strictEqual(executionFor([{ id: 'a', label: 'A' }]), 'popover');
    assert.strictEqual(
      executionFor([
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ]),
      'chat-handoff'
    );
  });

  it('applies that rule to the real chips', () => {
    assert.strictEqual(chipFor('publish', row).execution, 'immediate');
    assert.strictEqual(chipFor('new_variant', article).execution, 'popover');
    assert.strictEqual(chipFor('replace_image', row).execution, 'chat-handoff');
  });

  it('gives the popover chip exactly one answerable field and the others none', () => {
    const variant = chipFor('new_variant', article);
    assert.strictEqual(variant.params.length, 1);
    assert.strictEqual(variant.params[0]?.field?.kind, 'choice');
    assert.deepStrictEqual(
      variant.params[0]?.field?.options.map((option) => option.value),
      ['create', 'preview']
    );
    // A hand-off's params record WHY it is ambiguous; none of them is a field.
    for (const param of chipFor('replace_image', row).params) assert.strictEqual(param.field, undefined);
  });

  it('routes onSelect to the handler its mode names', () => {
    const seen: string[] = [];
    const handlers: QuickActionHandlers = {
      run: (chip) => seen.push(`run:${chip.id}`),
      openPopover: (chip) => seen.push(`popover:${chip.id}`),
      handOff: (chip) => seen.push(`handoff:${chip.id}`),
    };
    for (const chip of DEFAULT_QUICK_ACTION_REGISTRY.resolve({
      row: article,
      roles: ['admin'],
      getToken: async () => '',
      handlers,
    })) {
      chip.onSelect();
    }
    assert.deepStrictEqual(seen, [
      'run:validate',
      'run:submit_review',
      'run:publish',
      'popover:new_variant',
      'handoff:replace_image',
    ]);
  });

  it('carries a prompt on the hand-off chip and on no other', () => {
    assert.ok(chipFor('replace_image', article).prompt);
    assert.strictEqual(chipFor('validate', article).prompt, undefined);
  });
});

// ─── the chat hand-off prompt ───────────────────────────────────────────────

describe('buildQuickActionPrompt', () => {
  const definition = QUICK_ACTIONS.find((entry) => entry.id === 'replace_image');
  assert.ok(definition);

  it('names the object the way the rest of the admin does — display name, then the raw id', () => {
    const prompt = buildQuickActionPrompt(definition, article);
    assert.ok(prompt.includes('"Kelp, revisited"'));
    assert.ok(prompt.includes('(content_item ci_20260710_kelp)'));
  });

  it('asks for the answer as a controls block, so the follow-up renders as buttons', () => {
    const prompt = buildQuickActionPrompt(definition, article);
    assert.ok(prompt.includes('`controls` block'));
    assert.ok(prompt.includes('radio field'));
  });

  it('tells the agent what it cannot do, so it never offers to source a new image', () => {
    const prompt = buildQuickActionPrompt(definition, article);
    assert.ok(prompt.includes('image search or import tool'));
  });

  it('is what the resolved chip carries', () => {
    assert.strictEqual(chipFor('replace_image', article).prompt, buildQuickActionPrompt(definition, article));
  });
});

// ─── execution ──────────────────────────────────────────────────────────────

describe('runQuickAction', () => {
  it('validates without taking a lock and reports the counts', async () => {
    const verbs = fakeVerbs({
      validate: { status: 200, body: { summary: { blockers: ['no title'], warnings: ['thin alt text'] } } },
    });
    const result = await runQuickAction(verbs.call, chipFor('validate', row), row);
    assert.strictEqual(result.ok, true);
    assert.match(result.receipt, /1 blocker and 1 warning/);
    assert.deepStrictEqual(
      verbs.calls.map((call) => call.action),
      ['validate']
    );
  });

  it('says so plainly when a record is clean', async () => {
    const verbs = fakeVerbs({ validate: { status: 200, body: { summary: { blockers: [], warnings: [] } } } });
    const result = await runQuickAction(verbs.call, chipFor('validate', row), row);
    assert.match(result.receipt, /no blockers and no warnings/);
  });

  it('publishes under a lock it takes and gives back', async () => {
    const verbs = fakeVerbs({
      checkout: { status: 200, body: { lockToken: 'lock-1' } },
      publish_by_time: { status: 200, body: { published: true } },
    });
    const result = await runQuickAction(verbs.call, chipFor('publish', row), row);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(
      verbs.calls.map((call) => call.action),
      ['checkout', 'publish_by_time', 'checkin']
    );
    // Nothing here can schedule — `published_time` is never sent (OQ-2).
    assert.strictEqual(verbs.calls[1]?.published_time, undefined);
    assert.strictEqual(verbs.calls[1]?.lock_token, 'lock-1');
  });

  it('releases the lock when the publish is refused, so no row is left checked out', async () => {
    const verbs = fakeVerbs({
      checkout: { status: 200, body: { lockToken: 'lock-1' } },
      publish_by_time: { status: 409, body: { error: 'Approval is required before publishing.' } },
    });
    const result = await runQuickAction(verbs.call, chipFor('publish', row), row);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'rejected_by_server');
    assert.strictEqual(result.error, 'Approval is required before publishing.');
    assert.deepStrictEqual(
      verbs.calls.map((call) => call.action),
      ['checkout', 'publish_by_time', 'checkin']
    );
  });

  it('reports a lock held elsewhere as locked, and never reaches the verb', async () => {
    const verbs = fakeVerbs({ checkout: { status: 423, body: {} } });
    const result = await runQuickAction(verbs.call, chipFor('submit_review', row), row);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'locked');
    assert.deepStrictEqual(
      verbs.calls.map((call) => call.action),
      ['checkout']
    );
  });

  it('submits a review pinned to an immediate publish, then hands the lock to the reviewer', async () => {
    const verbs = fakeVerbs({
      checkout: { status: 200, body: { lockToken: 'lock-2' } },
      submit_review: { status: 200, body: { review_state: 'open' } },
    });
    const result = await runQuickAction(verbs.call, chipFor('submit_review', row), row);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(verbs.calls[1]?.requested_publish_action, { published_time: 'immediate' });
    assert.match(result.receipt, /edit lock is released/);
  });

  it('creates a variant, or previews one without writing, per the popover answer', async () => {
    const created = fakeVerbs({ create_variant: { status: 200, body: { object_id: 'ci_20260710_kelp_variant' } } });
    const chip = chipFor('new_variant', article);
    const madeIt = await runQuickAction(created.call, chip, article, { mode: 'create' });
    assert.strictEqual(created.calls[0]?.dry_run, undefined);
    assert.match(madeIt.receipt, /Created — ci_20260710_kelp_variant/);

    const previewed = fakeVerbs({
      create_variant: {
        status: 200,
        body: { dry_run: true, object_id: 'ci_20260710_kelp_variant', id_available: true, summary: { blockers: [] } },
      },
    });
    const preview = await runQuickAction(previewed.call, chip, article, { mode: 'preview' });
    assert.strictEqual(previewed.calls[0]?.dry_run, true);
    assert.match(preview.receipt, /Nothing was created/);
  });

  it('refuses to "run" a chat hand-off rather than doing something adjacent', async () => {
    const verbs = fakeVerbs({});
    const result = await runQuickAction(verbs.call, chipFor('replace_image', row), row);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'unsupported');
    assert.deepStrictEqual(verbs.calls, []);
  });

  it('turns a transport failure into a receipt instead of throwing', async () => {
    const result = await runQuickAction(
      async () => {
        throw new Error('offline');
      },
      chipFor('validate', row),
      row
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'transport');
    assert.strictEqual(result.receipt, 'offline');
  });
});

// ─── the state gate, independent of rights ──────────────────────────────────

describe('definitionsForRow', () => {
  it('is rights-blind — it answers "does this apply", not "may you"', () => {
    assert.deepStrictEqual(
      definitionsForRow(article).map((definition) => definition.id),
      ['validate', 'submit_review', 'publish', 'new_variant', 'replace_image']
    );
  });
});
