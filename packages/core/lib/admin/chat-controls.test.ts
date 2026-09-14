import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACTION_NOT_OFFERED_REASON,
  allowedAction,
  CONTROLS_FIELD_KINDS,
  controlsActionField,
  controlsActionValues,
  controlsDecisionLine,
  controlsMarker,
  controlsRanLine,
  controlsRanMessage,
  controlsSelectedLine,
  defaultControlsValues,
  findControlsSubmissionText,
  formatControlsBrief,
  isControlsActionField,
  isControlsSubmitted,
  parseControlsBrief,
  parseControlsJson,
  parseControlsReceipt,
  splitControlsSegments,
  validateControlsBlock,
  type ControlsBlock,
  type ControlsValues,
} from './chat-controls.js';
import { actionTraceLine, parseActionTraceLine } from './object-action-strip.js';

const VALID_JSON = JSON.stringify({
  id: 'tone-choice',
  title: 'Article setup',
  submit: 'Use these settings',
  fields: [
    {
      kind: 'radio',
      id: 'tone',
      label: 'Tone',
      options: [
        { value: 'warm', label: 'Warm' },
        { value: 'clinical', label: 'Clinical' },
      ],
      value: 'warm',
    },
    {
      kind: 'checkbox',
      id: 'include',
      label: 'Include sections',
      options: [
        { value: 'faq', label: 'FAQ' },
        { value: 'cta', label: 'CTA banner' },
      ],
      values: ['cta'],
    },
    { kind: 'toggle', id: 'hero', label: 'Generate hero image', on: false },
  ],
});

const validBlock = (): ControlsBlock => {
  const block = parseControlsJson(VALID_JSON);
  assert.ok(block, 'fixture JSON must parse');
  return block;
};

describe('validateControlsBlock — valid parse', () => {
  it('accepts the documented example shape', () => {
    const block = validBlock();
    assert.equal(block.id, 'tone-choice');
    assert.equal(block.title, 'Article setup');
    assert.equal(block.submit, 'Use these settings');
    assert.equal(block.fields.length, 3);
    assert.deepEqual(block.fields[0], {
      kind: 'radio',
      id: 'tone',
      label: 'Tone',
      options: [
        { value: 'warm', label: 'Warm' },
        { value: 'clinical', label: 'Clinical' },
      ],
      value: 'warm',
    });
  });

  it('accepts optional title/submit/defaults being absent', () => {
    const block = validateControlsBlock({
      id: 'minimal',
      fields: [{ kind: 'toggle', id: 'flag', label: 'Flag' }],
    });
    assert.ok(block);
    assert.equal(block.title, undefined);
    assert.equal(block.submit, undefined);
    assert.deepEqual(block.fields[0], { kind: 'toggle', id: 'flag', label: 'Flag' });
  });

  it('drops a default value that does not match any option instead of failing the block', () => {
    const block = validateControlsBlock({
      id: 'drift',
      fields: [
        {
          kind: 'radio',
          id: 'tone',
          label: 'Tone',
          options: [{ value: 'warm', label: 'Warm' }],
          value: 'nonexistent',
        },
      ],
    });
    assert.ok(block);
    const field = block.fields[0];
    assert.equal(field.kind === 'radio' ? field.value : undefined, undefined);
  });
});

describe('validateControlsBlock — malformed JSON / structure fallback', () => {
  it('rejects invalid JSON text (parseControlsJson returns null)', () => {
    assert.equal(parseControlsJson('{ this is not json'), null);
  });

  it('rejects a JSON value that is not an object', () => {
    assert.equal(validateControlsBlock('nope'), null);
    assert.equal(validateControlsBlock(null), null);
    assert.equal(validateControlsBlock([1, 2, 3]), null);
  });

  it('rejects a missing id', () => {
    assert.equal(validateControlsBlock({ fields: [{ kind: 'toggle', id: 'a', label: 'A' }] }), null);
  });

  it('rejects empty or missing fields', () => {
    assert.equal(validateControlsBlock({ id: 'x', fields: [] }), null);
    assert.equal(validateControlsBlock({ id: 'x' }), null);
  });

  it('rejects a radio/checkbox field with no options', () => {
    assert.equal(
      validateControlsBlock({ id: 'x', fields: [{ kind: 'radio', id: 'a', label: 'A', options: [] }] }),
      null
    );
  });

  it('rejects a field missing id or label', () => {
    assert.equal(validateControlsBlock({ id: 'x', fields: [{ kind: 'toggle', label: 'A' }] }), null);
    assert.equal(validateControlsBlock({ id: 'x', fields: [{ kind: 'toggle', id: 'a' }] }), null);
  });
});

describe('validateControlsBlock — unknown kind fallback', () => {
  it('rejects a field with an unrecognized kind', () => {
    assert.equal(
      validateControlsBlock({
        id: 'x',
        fields: [{ kind: 'slider', id: 'a', label: 'A', min: 0, max: 10 }],
      }),
      null
    );
  });

  it('fails the whole block when only one of several fields has an unknown kind', () => {
    assert.equal(
      validateControlsBlock({
        id: 'x',
        fields: [
          { kind: 'toggle', id: 'a', label: 'A' },
          { kind: 'dropdown', id: 'b', label: 'B' },
        ],
      }),
      null
    );
  });
});

describe('splitControlsSegments', () => {
  it('extracts a valid controls block from surrounding prose', () => {
    const text = `Here are some options:\n\n\`\`\`controls\n${VALID_JSON}\n\`\`\`\n\nLet me know!`;
    const segments = splitControlsSegments(text);
    assert.equal(segments.length, 3);
    assert.equal(segments[0]?.kind, 'text');
    assert.equal(segments[1]?.kind, 'controls');
    assert.equal(segments[2]?.kind, 'text');
    if (segments[1]?.kind === 'controls') assert.equal(segments[1].block.id, 'tone-choice');
  });

  it('leaves a malformed controls block as ordinary code-block text (never crashes, never half-renders)', () => {
    const text = '```controls\n{ not valid json\n```';
    const segments = splitControlsSegments(text);
    assert.deepEqual(segments, [{ kind: 'text', text }]);
  });

  it('leaves an unknown-kind controls block as ordinary code-block text', () => {
    const badJson = JSON.stringify({ id: 'x', fields: [{ kind: 'slider', id: 'a', label: 'A' }] });
    const text = `Pick one:\n\`\`\`controls\n${badJson}\n\`\`\``;
    const segments = splitControlsSegments(text);
    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.kind, 'text');
    assert.equal(segments[0]?.text, text);
  });

  it('returns a single text segment for plain text with no controls block', () => {
    assert.deepEqual(splitControlsSegments('just talking'), [{ kind: 'text', text: 'just talking' }]);
  });

  it('handles multiple valid blocks in one message', () => {
    const second = JSON.stringify({ id: 'second', fields: [{ kind: 'toggle', id: 'b', label: 'B' }] });
    const text = `\`\`\`controls\n${VALID_JSON}\n\`\`\`\n\n\`\`\`controls\n${second}\n\`\`\``;
    const segments = splitControlsSegments(text);
    const controlsSegments = segments.filter((segment) => segment.kind === 'controls');
    assert.equal(controlsSegments.length, 2);
  });
});

describe('defaultControlsValues', () => {
  it('seeds radio/checkbox/toggle defaults from the block', () => {
    const values = defaultControlsValues(validBlock());
    assert.deepEqual(values, { tone: 'warm', include: ['cta'], hero: false });
  });

  it('falls back to the first option for a radio field with no declared default', () => {
    const block = validateControlsBlock({
      id: 'x',
      fields: [
        {
          kind: 'radio',
          id: 'a',
          label: 'A',
          options: [
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' },
          ],
        },
      ],
    });
    assert.ok(block);
    assert.deepEqual(defaultControlsValues(block), { a: 'one' });
  });
});

describe('formatControlsBrief', () => {
  it('matches the documented brief format exactly', () => {
    const block = validBlock();
    const values: ControlsValues = { tone: 'warm', include: ['cta'], hero: false };
    assert.equal(
      formatControlsBrief(block, values),
      'Selections [controls:tone-choice] — Tone: Warm; Include sections: CTA banner; Generate hero image: off'
    );
  });

  it('renders an empty checkbox selection as "None" and toggle-on as "on"', () => {
    const block = validBlock();
    const values: ControlsValues = { tone: 'clinical', include: [], hero: true };
    assert.equal(
      formatControlsBrief(block, values),
      'Selections [controls:tone-choice] — Tone: Clinical; Include sections: None; Generate hero image: on'
    );
  });

  it('renders multiple checkbox selections joined by comma', () => {
    const block = validBlock();
    const values: ControlsValues = { tone: 'warm', include: ['faq', 'cta'], hero: false };
    assert.match(formatControlsBrief(block, values), /Include sections: FAQ, CTA banner/);
  });
});

describe('submitted-state derivation from the transcript', () => {
  it('is not submitted when no later message carries the marker', () => {
    assert.equal(isControlsSubmitted('tone-choice', ['hello', 'something else']), false);
  });

  it('is submitted when a later message carries the exact marker', () => {
    const brief =
      'Selections [controls:tone-choice] — Tone: Warm; Include sections: CTA banner; Generate hero image: off';
    assert.equal(isControlsSubmitted('tone-choice', ['unrelated', brief]), true);
    assert.equal(findControlsSubmissionText('tone-choice', ['unrelated', brief]), brief);
  });

  it('does not match a different block id (avoids prefix collisions)', () => {
    const brief = 'Selections [controls:tone-choice-2] — Tone: Warm';
    assert.equal(isControlsSubmitted('tone-choice', [brief]), false);
  });

  it('marker format is stable', () => {
    assert.equal(controlsMarker('abc'), '[controls:abc]');
  });
});

describe('parseControlsBrief (read-only display)', () => {
  it('parses our own formatted brief back into ordered label/display pairs', () => {
    const block = validBlock();
    const values: ControlsValues = { tone: 'warm', include: ['cta'], hero: false };
    const brief = formatControlsBrief(block, values);
    assert.deepEqual(parseControlsBrief(brief), [
      { label: 'Tone', display: 'Warm' },
      { label: 'Include sections', display: 'CTA banner' },
      { label: 'Generate hero image', display: 'off' },
    ]);
  });

  it('returns null for text that is not a controls brief', () => {
    assert.equal(parseControlsBrief('just a regular message'), null);
  });
});

// ─── v2 (§6) — action blocks ────────────────────────────────────────────────

const ACTIONS_JSON = JSON.stringify({
  id: 'next-step',
  title: 'Ready when you are',
  fields: [
    {
      kind: 'actions',
      id: 'next',
      label: 'What would you like to do?',
      actions: [
        { verb: 'object_validate', label: 'Validate' },
        { verb: 'object_submit_review', label: 'Submit for review', args: { note: 'ready' } },
        { verb: 'object_publish', label: 'Publish', tone: 'danger' },
      ],
    },
  ],
});

const SELECT_OBJECT_JSON = JSON.stringify({
  id: 'which-article',
  fields: [
    {
      kind: 'select_object',
      id: 'pick',
      label: 'Which article did you mean?',
      objects: [
        {
          object_type: 'content_item',
          object_id: 'req_evergreen_retinol_20260901_01',
          title: 'Retinol, by skin type',
          status: 'draft',
        },
      ],
    },
  ],
});

const CONFIRM_JSON = JSON.stringify({
  id: 'publish-now',
  fields: [
    {
      kind: 'confirm',
      id: 'go',
      label: 'Publish this now?',
      confirm_label: 'Publish',
      decline_label: 'Not yet',
      tone: 'danger',
    },
  ],
});

describe('§6 — the three v2 kinds parse as the spec spells them', () => {
  it('accepts §6.1’s documented `actions` block verbatim', () => {
    const block = parseControlsJson(ACTIONS_JSON);
    assert.ok(block);
    assert.equal(block.title, 'Ready when you are');
    assert.deepEqual(block.fields[0], {
      kind: 'actions',
      id: 'next',
      label: 'What would you like to do?',
      actions: [
        { verb: 'object_validate', label: 'Validate' },
        { verb: 'object_submit_review', label: 'Submit for review', args: { note: 'ready' } },
        { verb: 'object_publish', label: 'Publish', tone: 'danger' },
      ],
    });
  });

  it('accepts §6.2’s documented `select_object` block verbatim', () => {
    const block = parseControlsJson(SELECT_OBJECT_JSON);
    assert.ok(block);
    assert.deepEqual(block.fields[0], {
      kind: 'select_object',
      id: 'pick',
      label: 'Which article did you mean?',
      objects: [
        {
          object_type: 'content_item',
          object_id: 'req_evergreen_retinol_20260901_01',
          title: 'Retinol, by skin type',
          status: 'draft',
        },
      ],
    });
  });

  it('accepts §6.3’s documented `confirm` block verbatim, and defaults its labels away', () => {
    const block = parseControlsJson(CONFIRM_JSON);
    assert.ok(block);
    assert.deepEqual(block.fields[0], {
      kind: 'confirm',
      id: 'go',
      label: 'Publish this now?',
      confirm_label: 'Publish',
      decline_label: 'Not yet',
      tone: 'danger',
    });
    // Labels are optional — the renderer supplies "Confirm"/"Cancel".
    const bare = validateControlsBlock({
      id: 'x',
      fields: [{ kind: 'confirm', id: 'go', label: 'Sure?' }],
    });
    assert.ok(bare);
    assert.deepEqual(bare.fields[0], { kind: 'confirm', id: 'go', label: 'Sure?' });
  });

  it('an action field is recognisable as one, and a form field is not', () => {
    const actions = parseControlsJson(ACTIONS_JSON);
    const form = validBlock();
    assert.ok(actions);
    assert.equal(isControlsActionField(actions.fields[0]!), true);
    assert.equal(isControlsActionField(form.fields[0]!), false);
    assert.equal(controlsActionField(actions)?.kind, 'actions');
    assert.equal(controlsActionField(form), undefined);
  });

  it('renders as a card, not a code block, inside an assistant message', () => {
    const text = `Here is what I can do:\n\n\`\`\`controls\n${ACTIONS_JSON}\n\`\`\``;
    const segments = splitControlsSegments(text);
    assert.equal(segments.length, 2);
    assert.equal(segments[1]?.kind, 'controls');
    if (segments[1]?.kind === 'controls') assert.equal(segments[1].block.id, 'next-step');
  });
});

describe('§6 — the form-block vs action-block split', () => {
  it('rejects a block that mixes a form field with an action field', () => {
    assert.equal(
      validateControlsBlock({
        id: 'x',
        fields: [
          { kind: 'toggle', id: 'hero', label: 'Hero' },
          { kind: 'confirm', id: 'go', label: 'Go?' },
        ],
      }),
      null
    );
  });

  it('rejects two action fields in one block (exactly one, §6)', () => {
    assert.equal(
      validateControlsBlock({
        id: 'x',
        fields: [
          { kind: 'confirm', id: 'a', label: 'A?' },
          { kind: 'confirm', id: 'b', label: 'B?' },
        ],
      }),
      null
    );
  });

  it('rejects an action block that also carries a submit button', () => {
    assert.equal(
      validateControlsBlock({
        id: 'x',
        submit: 'Go',
        fields: [{ kind: 'confirm', id: 'go', label: 'Go?' }],
      }),
      null
    );
  });

  it('still accepts a multi-field FORM block with a submit button (v1 unchanged)', () => {
    assert.ok(validateControlsBlock(JSON.parse(VALID_JSON)));
  });
});

describe('§6 — bounds and shape violations fail the whole block', () => {
  const actionsField = (actions: unknown) => ({
    id: 'x',
    fields: [{ kind: 'actions', id: 'a', label: 'A', actions }],
  });

  it('rejects an empty or over-long actions list (§6.1: 1..6)', () => {
    assert.equal(validateControlsBlock(actionsField([])), null);
    const seven = Array.from({ length: 7 }, (_, i) => ({ verb: `v${i}`, label: `L${i}` }));
    assert.equal(validateControlsBlock(actionsField(seven)), null);
    const six = seven.slice(0, 6);
    assert.ok(validateControlsBlock(actionsField(six)));
  });

  it('rejects an action missing verb or label', () => {
    assert.equal(validateControlsBlock(actionsField([{ label: 'No verb' }])), null);
    assert.equal(validateControlsBlock(actionsField([{ verb: 'object_validate' }])), null);
  });

  it('rejects a non-object `args`', () => {
    assert.equal(validateControlsBlock(actionsField([{ verb: 'v', label: 'L', args: 'note' }])), null);
    assert.equal(validateControlsBlock(actionsField([{ verb: 'v', label: 'L', args: ['note'] }])), null);
  });

  it('rejects an unrecognized tone — an enum on the shape, not a droppable default', () => {
    assert.equal(validateControlsBlock(actionsField([{ verb: 'v', label: 'L', tone: 'warning' }])), null);
    assert.equal(
      validateControlsBlock({ id: 'x', fields: [{ kind: 'confirm', id: 'g', label: 'G?', tone: 'warning' }] }),
      null
    );
  });

  it('accepts the literal tone "default" and normalises it away', () => {
    const block = validateControlsBlock(actionsField([{ verb: 'v', label: 'L', tone: 'default' }]));
    assert.ok(block);
    const field = block.fields[0];
    assert.deepEqual(field.kind === 'actions' ? field.actions : undefined, [{ verb: 'v', label: 'L' }]);
  });

  it('rejects an empty or over-long objects list (§6.2: 1..12)', () => {
    const objects = (list: unknown) => ({ id: 'x', fields: [{ kind: 'select_object', id: 'p', label: 'P', objects: list }] });
    assert.equal(validateControlsBlock(objects([])), null);
    const thirteen = Array.from({ length: 13 }, (_, i) => ({ object_type: 'content_item', object_id: `id${i}` }));
    assert.equal(validateControlsBlock(objects(thirteen)), null);
    assert.ok(validateControlsBlock(objects(thirteen.slice(0, 12))));
  });

  it('rejects an object entry over the wire bounds, or missing the pair', () => {
    const objects = (entry: unknown) => ({ id: 'x', fields: [{ kind: 'select_object', id: 'p', label: 'P', objects: [entry] }] });
    assert.equal(validateControlsBlock(objects({ object_id: 'a' })), null);
    assert.equal(validateControlsBlock(objects({ object_type: 'content_item' })), null);
    assert.equal(validateControlsBlock(objects({ object_type: 'x'.repeat(129), object_id: 'a' })), null);
    assert.equal(validateControlsBlock(objects({ object_type: 'content_item', object_id: 'a'.repeat(257) })), null);
    assert.ok(validateControlsBlock(objects({ object_type: 'x'.repeat(128), object_id: 'a'.repeat(256) })));
  });

  it('drops an optional title/status that is not a usable string, without failing the block', () => {
    const block = validateControlsBlock({
      id: 'x',
      fields: [
        { kind: 'select_object', id: 'p', label: 'P', objects: [{ object_type: 't', object_id: 'i', title: 42, status: '' }] },
      ],
    });
    assert.ok(block);
    const field = block.fields[0];
    assert.deepEqual(field.kind === 'select_object' ? field.objects : undefined, [{ object_type: 't', object_id: 'i' }]);
  });

  it('a malformed action block falls back to an ordinary code block in the transcript', () => {
    const bad = JSON.stringify({ id: 'x', fields: [{ kind: 'actions', id: 'a', label: 'A', actions: [] }] });
    const text = `\`\`\`controls\n${bad}\n\`\`\``;
    assert.deepEqual(splitControlsSegments(text), [{ kind: 'text', text }]);
  });
});

describe('§6 — an action block gathers nothing', () => {
  it('has no default answer state', () => {
    const block = parseControlsJson(CONFIRM_JSON);
    assert.ok(block);
    assert.deepEqual(defaultControlsValues(block), {});
  });
});

// ─── v2 receipts (§6.1-§6.3) ───────────────────────────────────────────────

describe('§6 receipts — the transcript is still the whole record', () => {
  it('spells each receipt exactly as §6.1-§6.3 specify', () => {
    assert.equal(controlsRanLine('next-step', 'object_validate'), '[controls:next-step] ran object_validate');
    assert.equal(controlsSelectedLine('which-article', 'req_x_01'), '[controls:which-article] selected req_x_01');
    assert.equal(controlsDecisionLine('publish-now', true), '[controls:publish-now] confirmed');
    assert.equal(controlsDecisionLine('publish-now', false), '[controls:publish-now] declined');
  });

  it('posts the run receipt ALONGSIDE W3’s own trace line, as one message', () => {
    const trace = actionTraceLine({
      verb: 'object_validate',
      label: 'Validate',
      receipt: 'Validated — no blockers and no warnings.',
    });
    const message = controlsRanMessage('next-step', 'object_validate', trace);
    assert.equal(message, `[controls:next-step] ran object_validate\n${trace}`);
    // Both halves survive: the card derives answered, the trace line still parses on its own.
    assert.equal(isControlsSubmitted('next-step', [message]), true);
    assert.deepEqual(parseActionTraceLine(message.split('\n')[1]!), {
      verb: 'object_validate',
      label: 'Validate',
      receipt: 'Validated — no blockers and no warnings.',
    });
    // And the combined message is NOT mistaken for a bare trace line.
    assert.equal(parseActionTraceLine(message), undefined);
  });

  it('a hand-off run posts the receipt alone when there is no trace to carry', () => {
    assert.equal(controlsRanMessage('next-step', 'object_validate'), '[controls:next-step] ran object_validate');
  });

  it('every v2 receipt marks its block answered, and a reopened chat re-derives it', () => {
    const transcript = [
      'unrelated chatter',
      '[controls:next-step] ran object_validate\n[action:object_validate] Validate — Validated.',
      '[controls:which-article] selected req_x_01',
      '[controls:publish-now] declined',
    ];
    assert.equal(isControlsSubmitted('next-step', transcript), true);
    assert.equal(isControlsSubmitted('which-article', transcript), true);
    assert.equal(isControlsSubmitted('publish-now', transcript), true);
    assert.equal(isControlsSubmitted('never-sent', transcript), false);
    assert.equal(findControlsSubmissionText('publish-now', transcript), '[controls:publish-now] declined');
  });

  it('parses each receipt back for the read-only card', () => {
    assert.deepEqual(parseControlsReceipt('next-step', '[controls:next-step] ran object_validate\n[action:object_validate] Validate — Validated.'), {
      kind: 'ran',
      verb: 'object_validate',
    });
    assert.deepEqual(parseControlsReceipt('which-article', '[controls:which-article] selected req_x_01'), {
      kind: 'selected',
      object_id: 'req_x_01',
    });
    assert.deepEqual(parseControlsReceipt('publish-now', '[controls:publish-now] confirmed'), {
      kind: 'decision',
      confirmed: true,
    });
    assert.deepEqual(parseControlsReceipt('publish-now', '[controls:publish-now] declined'), {
      kind: 'decision',
      confirmed: false,
    });
  });

  it('still parses a v1 brief through the same door, delegating to parseControlsBrief', () => {
    const brief = formatControlsBrief(validBlock(), { tone: 'warm', include: ['cta'], hero: false });
    assert.deepEqual(parseControlsReceipt('tone-choice', brief), {
      kind: 'selections',
      entries: [
        { label: 'Tone', display: 'Warm' },
        { label: 'Include sections', display: 'CTA banner' },
        { label: 'Generate hero image', display: 'off' },
      ],
    });
  });

  it('returns null for a message that carries no receipt for this block', () => {
    assert.equal(parseControlsReceipt('next-step', 'just a regular message'), null);
    assert.equal(parseControlsReceipt('next-step', '[controls:other] confirmed'), null);
  });

  it('parseControlsBrief is unchanged and declines a v2 receipt rather than inventing pairs', () => {
    assert.equal(parseControlsBrief('[controls:next-step] ran object_validate'), null);
    assert.equal(parseControlsBrief('[controls:publish-now] confirmed'), null);
    assert.equal(
      parseControlsBrief('[controls:next-step] ran object_validate\n[action:object_validate] Validate — Validated.'),
      null
    );
  });
});

describe('§6.1 — pre-filled args', () => {
  it('keeps scalars, stringified, and drops what it cannot honestly pre-fill', () => {
    assert.deepEqual(
      controlsActionValues({ verb: 'v', label: 'L', args: { note: 'ready', count: 2, flag: true } }),
      { note: 'ready', count: '2', flag: 'true' }
    );
    assert.deepEqual(controlsActionValues({ verb: 'v', label: 'L', args: { nested: { a: 1 }, list: [1], nil: null } }), {});
    assert.deepEqual(controlsActionValues({ verb: 'v', label: 'L' }), {});
  });
});

// ─── §6.4 — the offered-verb gate ──────────────────────────────────────────

describe('§6.4 — allowedAction', () => {
  const manifest = { actions: [{ verb: 'object_validate' }, { verb: 'object_submit_review' }] };

  it('enables a verb the turn actually offered', () => {
    assert.deepEqual(allowedAction({ verb: 'object_validate' }, manifest), { enabled: true });
  });

  it('disables a verb absent from the manifest WITH THE REASON — never hidden', () => {
    assert.deepEqual(allowedAction({ verb: 'object_publish' }, manifest), {
      enabled: false,
      reason: ACTION_NOT_OFFERED_REASON,
    });
    assert.equal(ACTION_NOT_OFFERED_REASON, 'not available here');
  });

  it('disables EVERY button when no manifest reached the client for that turn', () => {
    const block = parseControlsJson(ACTIONS_JSON);
    assert.ok(block);
    const field = controlsActionField(block);
    assert.equal(field?.kind, 'actions');
    const states = field?.kind === 'actions' ? field.actions.map((action) => allowedAction(action, undefined)) : [];
    assert.equal(states.length, 3);
    for (const state of states) {
      assert.deepEqual(state, { enabled: false, reason: ACTION_NOT_OFFERED_REASON });
    }
  });

  it('an empty manifest (a free chat, or a caller who may run nothing) disables everything too', () => {
    assert.deepEqual(allowedAction({ verb: 'object_validate' }, { actions: [] }), {
      enabled: false,
      reason: ACTION_NOT_OFFERED_REASON,
    });
  });
});

// ─── the kinds array `ui-capabilities.ts` imports ──────────────────────────

describe('CONTROLS_FIELD_KINDS', () => {
  it('is the runtime list of every kind this parser accepts, in manifest order', () => {
    assert.deepEqual([...CONTROLS_FIELD_KINDS], ['radio', 'checkbox', 'toggle', 'actions', 'select_object', 'confirm']);
  });

  it('every listed kind actually validates, and nothing outside the list does', () => {
    const sample: Record<string, Record<string, unknown>> = {
      radio: { options: [{ value: 'a', label: 'A' }] },
      checkbox: { options: [{ value: 'a', label: 'A' }] },
      toggle: {},
      actions: { actions: [{ verb: 'object_validate', label: 'Validate' }] },
      select_object: { objects: [{ object_type: 'content_item', object_id: 'x' }] },
      confirm: {},
    };
    for (const kind of CONTROLS_FIELD_KINDS) {
      const block = validateControlsBlock({ id: 'x', fields: [{ kind, id: 'f', label: 'F', ...sample[kind] }] });
      assert.ok(block, `${kind} must validate`);
    }
    assert.equal(validateControlsBlock({ id: 'x', fields: [{ kind: 'slider', id: 'f', label: 'F' }] }), null);
  });
});
