import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  ACTION_TRACE_SEPARATOR,
  actionDispatchFor,
  actionRightsLabel,
  actionRightsReason,
  actionTraceDelivery,
  actionTraceLine,
  objectControlOverrides,
  parseActionTraceLine,
  resolveActionStrip,
} from './object-action-strip.js';
import { DEFAULT_QUICK_ACTION_REGISTRY, runQuickAction, type QuickActionHandlers } from './quick-actions.js';
import { resolveObjectControls } from './object-detail-actions.js';
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

const idsOf = (entries: ReadonlyArray<{ id: string }>): string[] => entries.map((entry) => entry.id);

const entryFor = (id: string, roles: readonly string[], target: LibraryRow = row) => {
  const entry = resolveActionStrip({ row: target, roles }).find((candidate) => candidate.id === id);
  assert.ok(entry, `expected a "${id}" entry`);
  return entry;
};

// ─── presence vs. permission ────────────────────────────────────────────────

describe('resolveActionStrip — disabled with a reason, never hidden', () => {
  it('keeps every action a role cannot run, disabled and with its reason', () => {
    const viewer = resolveActionStrip({ row: article, roles: ['viewer'] });
    assert.deepStrictEqual(idsOf(viewer), ['validate', 'submit_review', 'publish', 'new_variant', 'replace_image']);
    for (const entry of viewer) {
      assert.strictEqual(entry.state.enabled, false);
      assert.ok(entry.state.reason, `${entry.id} must say why it is disabled`);
    }
  });

  it('is the OPPOSITE of the chip registry, which omits what the caller may not use', () => {
    const handlers: QuickActionHandlers = { run: () => {}, openPopover: () => {}, handOff: () => {} };
    const chips = DEFAULT_QUICK_ACTION_REGISTRY.resolve({
      row: article,
      roles: ['editor'],
      getToken: async () => '',
      handlers,
    });
    assert.ok(!idsOf(chips).includes('publish'), 'the chip is absent for an editor');
    assert.strictEqual(entryFor('publish', ['editor'], article).state.enabled, false);
    assert.match(entryFor('publish', ['editor'], article).state.reason ?? '', /Publisher/);
  });

  it('names the roles that would fix it, rather than saying "no permission"', () => {
    assert.strictEqual(actionRightsLabel(['owner']), 'Owner');
    assert.strictEqual(actionRightsLabel(['owner', 'admin', 'publisher']), 'Owner, Admin or Publisher');
    assert.strictEqual(actionRightsReason(['owner', 'admin']), 'You need the Owner or Admin role to run this.');
  });

  it('enables what the caller may run', () => {
    const publisher = resolveActionStrip({ row, roles: ['publisher'] });
    const publish = publisher.find((entry) => entry.id === 'publish');
    assert.deepStrictEqual(publish?.state, { enabled: true });
  });

  it('treats the STATE gate as presence, not as a refusal', () => {
    // Nothing to publish: the action has no subject on this record, so it is
    // absent — rendering it disabled would claim the viewer lacks something.
    const published: LibraryRow = { ...row, published_time: '2026-07-01T00:00:00.000Z', unpublished_changes: false };
    assert.ok(!idsOf(resolveActionStrip({ row: published, roles: ['owner'] })).includes('publish'));
    // And an archived record admits none of them at all.
    assert.deepStrictEqual(resolveActionStrip({ row: { ...row, status: 'archived' }, roles: ['owner'] }), []);
  });

  it('drops what the surface already offers itself, and nothing else', () => {
    const entries = resolveActionStrip({ row: article, roles: ['owner'], exclude: ['publish', 'submit_review'] });
    assert.deepStrictEqual(idsOf(entries), ['validate', 'new_variant', 'replace_image']);
  });

  it('carries each entry through unchanged from the ONE registry', () => {
    const variant = entryFor('new_variant', ['owner'], article);
    assert.strictEqual(variant.verb, 'object_create_variant');
    assert.strictEqual(variant.execution, 'popover');
    assert.strictEqual(variant.params.length, 1);
    assert.strictEqual(entryFor('validate', ['owner'], article).execution, 'immediate');
    assert.strictEqual(entryFor('replace_image', ['owner'], article).execution, 'chat-handoff');
    assert.ok(entryFor('replace_image', ['owner'], article).prompt);
    assert.strictEqual(entryFor('validate', ['owner'], article).prompt, undefined);
  });
});

describe('resolveActionStrip — a surface override', () => {
  const disabled = { enabled: false, reason: 'This object type requires a current approval before it can be published.' };

  it('lets a surface with an authoritative gate supply the reason', () => {
    const entry = resolveActionStrip({ row, roles: ['owner'], overrides: { publish: disabled } }).find(
      (candidate) => candidate.id === 'publish'
    );
    assert.deepStrictEqual(entry?.state, disabled);
  });

  it('does not let an ENABLED override grant a right the caller lacks', () => {
    const entry = resolveActionStrip({
      row,
      roles: ['editor'],
      overrides: { publish: { enabled: true } },
    }).find((candidate) => candidate.id === 'publish');
    assert.strictEqual(entry?.state.enabled, false);
    assert.match(entry?.state.reason ?? '', /Publisher/);
  });

  it('maps the object workspace map onto the three ids the two gates share', () => {
    const controls = resolveObjectControls({
      objectType: 'content_item',
      roles: ['admin'],
      isOwner: false,
      releaseKnown: false,
      lockHeld: false,
      lockHeldByOther: false,
      contentRevision: 3,
      status: 'active',
    });
    const overrides = objectControlOverrides(controls);
    assert.deepStrictEqual(Object.keys(overrides).sort(), ['new_variant', 'publish', 'submit_review']);
    // `releaseKnown:false` fails publish closed — and the strip must say the
    // same thing the page's own Publish button says, not a second thing.
    assert.strictEqual(overrides.publish?.enabled, false);
    const entry = resolveActionStrip({ row: article, roles: ['admin'], overrides }).find((e) => e.id === 'publish');
    assert.deepStrictEqual(entry?.state, controls.publish);
  });
});

// ─── one registry, not two paths that agree ─────────────────────────────────

describe('the strip and the chip row execute the SAME verb', () => {
  const wireFor = async (id: string, verb: 'object_validate' | 'object_submit_review' | 'object_publish') => {
    const calls: Array<Record<string, unknown>> = [];
    const call = async (body: Record<string, unknown>): Promise<VerbResult> => {
      calls.push(body);
      return body.action === 'checkout' ? { status: 200, body: { lockToken: 'lk_1' } } : { status: 200, body: {} };
    };
    const entry = entryFor(id, ['owner'], article);
    assert.strictEqual(entry.verb, verb);
    const result = await runQuickAction(call, entry, article);
    assert.ok(result.ok, result.receipt);
    return calls.map((body) => body.action);
  };

  it('validates with the bare validate verb', async () => {
    assert.deepStrictEqual(await wireFor('validate', 'object_validate'), ['validate']);
  });

  it('submits a review under a lock it gives back', async () => {
    assert.deepStrictEqual(await wireFor('submit_review', 'object_submit_review'), [
      'checkout',
      'submit_review',
      'checkin',
    ]);
  });

  it('publishes through publish_by_time under a lock it gives back', async () => {
    assert.deepStrictEqual(await wireFor('publish', 'object_publish'), ['checkout', 'publish_by_time', 'checkin']);
  });
});

// ─── the trace line ─────────────────────────────────────────────────────────

describe('the [action:…] trace line', () => {
  it('is composed exactly as §6.1 of the controls protocol spells it', () => {
    assert.strictEqual(
      actionTraceLine({ verb: 'object_publish', label: 'Publish', receipt: 'Published — it goes live next release.' }),
      '[action:object_publish] Publish — Published — it goes live next release.'
    );
  });

  it('collapses a multi-line receipt into one transcript line', () => {
    const line = actionTraceLine({ verb: 'object_validate', label: 'Validate', receipt: '  two\n\nblockers  ' });
    assert.strictEqual(line, '[action:object_validate] Validate — two blockers');
    assert.ok(!line.includes('\n'));
  });

  it('round-trips, splitting at the FIRST separator so a receipt may contain one', () => {
    const fields = {
      verb: 'object_validate',
      label: 'Validate',
      receipt: 'Validated — no blockers and no warnings.',
    };
    assert.deepStrictEqual(parseActionTraceLine(actionTraceLine(fields)), fields);
  });

  it('reads a real receipt back off the wire', () => {
    const parsed = parseActionTraceLine('[action:object_publish] Publish — Published — A page is committed.');
    assert.deepStrictEqual(parsed, {
      verb: 'object_publish',
      label: 'Publish',
      receipt: 'Published — A page is committed.',
    });
  });

  it('refuses anything that is not a trace line', () => {
    for (const text of [
      'Publish — done',
      '[action:] Publish — done',
      '[action:object_publish] Publish',
      '[action:object_publish]  — done',
      '[controls:next] ran object_publish',
      '',
    ]) {
      assert.strictEqual(parseActionTraceLine(text), undefined, `parsed: ${text}`);
    }
  });

  it('uses the separator the module exports, so the two halves cannot drift', () => {
    assert.ok(actionTraceLine({ verb: 'v', label: 'L', receipt: 'R' }).includes(ACTION_TRACE_SEPARATOR));
  });
});

// ─── when the trace is NOT sent ─────────────────────────────────────────────

describe('actionTraceDelivery — a click never mints a chat', () => {
  const fields = { verb: 'object_validate', label: 'Validate', receipt: 'Validated — no blockers.' } as const;

  it('sends the line when a conversation already exists', () => {
    assert.deepStrictEqual(actionTraceDelivery({ ...fields, chatBound: true, execution: 'immediate' }), {
      kind: 'send',
      text: '[action:object_validate] Validate — Validated — no blockers.',
    });
  });

  it('sends it for a popover run too — the mode does not change the record', () => {
    const delivery = actionTraceDelivery({
      verb: 'object_create_variant',
      label: 'New variant',
      receipt: 'Created — a draft variant.',
      chatBound: true,
      execution: 'popover',
    });
    assert.strictEqual(delivery.kind, 'send');
  });

  it('SKIPS when no conversation is attached, rather than minting one', () => {
    const delivery = actionTraceDelivery({ ...fields, chatBound: false, execution: 'immediate' });
    assert.strictEqual(delivery.kind, 'skip');
    assert.match(delivery.kind === 'skip' ? delivery.reason : '', /must not mint/);
  });

  it('skips a hand-off, which writes its own message', () => {
    const delivery = actionTraceDelivery({ ...fields, chatBound: true, execution: 'chat-handoff' });
    assert.strictEqual(delivery.kind, 'skip');
  });

  it('skips a run that reported no receipt', () => {
    const delivery = actionTraceDelivery({ ...fields, receipt: '   ', chatBound: true, execution: 'immediate' });
    assert.strictEqual(delivery.kind, 'skip');
  });

  it('records a FAILED run too — the refusal is the half worth keeping', () => {
    const delivery = actionTraceDelivery({
      verb: 'object_publish',
      label: 'Publish',
      receipt: 'Someone else holds the edit lock.',
      chatBound: true,
      execution: 'immediate',
    });
    assert.deepStrictEqual(delivery, {
      kind: 'send',
      text: '[action:object_publish] Publish — Someone else holds the edit lock.',
    });
  });
});

// ─── ASV2-W5: §6.1's pre-filled args, and the hand-off exception ────────────

describe('actionDispatchFor', () => {
  const entry = (execution: 'immediate' | 'popover' | 'chat-handoff', paramIds: readonly string[]) => ({
    execution,
    params: paramIds.map((id) => ({ id, label: id })),
  });

  it('runs a popover action whose one parameter the block pre-filled', () => {
    assert.strictEqual(actionDispatchFor(entry('popover', ['mode']), { mode: 'preview' }), 'run');
  });

  it('collects when a parameter is still missing', () => {
    assert.strictEqual(actionDispatchFor(entry('popover', ['mode']), {}), 'collect');
  });

  it('collects a zero-parameter action — "immediate" is what collect means for it', () => {
    assert.strictEqual(actionDispatchFor(entry('immediate', []), {}), 'collect');
  });

  /**
   * The regression this function was extracted for. `agent_chat`
   * (`replace_image`) advertises three required string params in §7's
   * manifest, so an agent filling all three is doing what it was invited to
   * do — and dispatching that to the executor reaches `runQuickAction`'s
   * `agent_chat` arm, which answers `unsupported`.
   */
  it('NEVER runs a chat-handoff, however complete its pre-filled args are', () => {
    assert.strictEqual(
      actionDispatchFor(entry('chat-handoff', ['image', 'replacement', 'alt']), {
        image: 'the hero',
        replacement: 'the approved portrait',
        alt: 'Dr Lurie in clinic',
      }),
      'collect'
    );
  });
});
