import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  controlsMarker,
  defaultControlsValues,
  findControlsSubmissionText,
  formatControlsBrief,
  isControlsSubmitted,
  parseControlsBrief,
  parseControlsJson,
  splitControlsSegments,
  validateControlsBlock,
  type ControlsBlock,
  type ControlsValues,
} from './chat-controls.js';

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
