import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OBJECT_FIELDS_OP,
  TEXT_LIKE_OBJECT_TYPES,
  acceptIncomingField,
  buildFormPatchOps,
  dirtyFields,
  excerptFieldId,
  objectEditMode,
  objectFormFields,
  readFormValues,
  reconcileFormDraft,
  structuredFieldNote,
  titleFieldId,
  validateFormValues,
  type FormValues,
} from './object-detail-form.js';
import { objectTypes } from '../../schema/object-record-v1.js';
import { patchOpNamesByObjectType } from '../../schema/object-patch-ops.js';

const voiceBody = {
  name: 'Dr. Lurié',
  audience: 'Adults weighing an elective procedure.',
  tone: ['calm', 'precise'],
  cadence: 'Short sentences. Second person.',
  lexicon: { prefer: ['procedure'], avoid: ['cure'] },
  claim_policy: 'Every claim cites a source.',
  cta_policy: 'Invite, never push.',
  reader_safety_notes: 'No outcome guarantees.',
  frameworks: [{ framework_id: 'fw_explainer', label: 'Explainer' }],
  default_framework: 'fw_explainer',
};

const voiceRecord = { object_type: 'editorial_voice' as const, body: voiceBody as Record<string, unknown> };

describe('objectEditMode — which types get a direct form', () => {
  it('gives every text-like type a form and every other governed type chat only', () => {
    for (const type of objectTypes) {
      const expected = TEXT_LIKE_OBJECT_TYPES.includes(type) ? 'form' : 'chat-only';
      assert.equal(objectEditMode(type), expected, type);
    }
  });

  it('gives the brand voice a form (the acceptance criterion) and a media-stage product none', () => {
    assert.equal(objectEditMode('editorial_voice'), 'form');
    assert.equal(objectEditMode('product'), 'chat-only');
  });

  it('only declares a fields op that the type actually allows in the patch grammar', () => {
    for (const [type, op] of Object.entries(OBJECT_FIELDS_OP)) {
      const allowed = patchOpNamesByObjectType[type as keyof typeof patchOpNamesByObjectType] as readonly string[];
      assert.ok(allowed.includes(op!), `${type} must allow ${op}`);
    }
  });

  it('declares a fields op for exactly the types that render a form', () => {
    for (const type of objectTypes) {
      assert.equal(
        OBJECT_FIELDS_OP[type] !== undefined,
        objectEditMode(type) === 'form',
        `${type}: form mode and a fields op must agree`
      );
    }
  });

  it('resolves the inline title/excerpt fields per type, and neither for a chat-only type', () => {
    assert.equal(titleFieldId('content_item'), 'title');
    assert.equal(titleFieldId('page'), 'title');
    assert.equal(titleFieldId('editorial_voice'), 'name');
    assert.equal(titleFieldId('template'), 'name');
    assert.equal(titleFieldId('product'), undefined);
    assert.equal(excerptFieldId('content_item'), 'description');
    assert.equal(excerptFieldId('template'), 'description');
    assert.equal(excerptFieldId('page'), undefined, 'a page has only an SEO description, not a deck');
    assert.equal(excerptFieldId('product'), undefined);
  });

  it('names the structured children the form deliberately cannot edit', () => {
    for (const type of TEXT_LIKE_OBJECT_TYPES) {
      assert.ok(structuredFieldNote(type), `${type} needs a note explaining what chat edits instead`);
    }
    assert.equal(structuredFieldNote('product'), undefined);
  });
});

describe('readFormValues', () => {
  it('reads scalars, nested paths and list fields off the body', () => {
    const values = readFormValues(voiceRecord);
    assert.equal(values.name, 'Dr. Lurié');
    assert.equal(values['lexicon.prefer'], 'procedure');
    assert.equal(values.tone, 'calm\nprecise');
  });

  it('renders a missing optional field as the empty string, not "undefined"', () => {
    const values = readFormValues({ object_type: 'content_item', body: { title: 'T', slug: 't' } });
    assert.equal(values.author, '');
    assert.equal(values['seo.description'], '');
  });

  it('returns nothing for a chat-only type', () => {
    assert.deepEqual(readFormValues({ object_type: 'product', body: { slug: 'x' } }), {});
    assert.deepEqual(objectFormFields('product'), []);
  });
});

describe('buildFormPatchOps', () => {
  it('emits one deep-merge op carrying only the changed fields', () => {
    const base = readFormValues(voiceRecord);
    const draft = { ...base, cadence: 'Longer paragraphs now.' };
    const ops = buildFormPatchOps('editorial_voice', base, draft);
    assert.deepEqual(ops, [{ op: 'set_voice_fields', fields: { cadence: 'Longer paragraphs now.' } }]);
  });

  it('emits nothing when nothing changed', () => {
    const base = readFormValues(voiceRecord);
    assert.deepEqual(buildFormPatchOps('editorial_voice', base, { ...base }), []);
    assert.deepEqual(dirtyFields(base, { ...base }), []);
  });

  it('nests a dotted path so the merge lands inside the child object', () => {
    const base = readFormValues(voiceRecord);
    const ops = buildFormPatchOps('editorial_voice', base, { ...base, 'lexicon.avoid': 'cure\nmiracle' });
    assert.deepEqual(ops, [{ op: 'set_voice_fields', fields: { lexicon: { avoid: ['cure', 'miracle'] } } }]);
  });

  it('parses a lines field into a trimmed, blank-free array', () => {
    const base = readFormValues(voiceRecord);
    const ops = buildFormPatchOps('editorial_voice', base, { ...base, tone: ' calm \n\n direct \n' });
    assert.deepEqual(ops[0]!.fields, { tone: ['calm', 'direct'] });
  });

  it('unsets an emptied OPTIONAL field with null (the deep-merge trap), not an empty string', () => {
    const record = { object_type: 'content_item' as const, body: { title: 'T', slug: 't', author: 'Ada' } };
    const base = readFormValues(record);
    const ops = buildFormPatchOps('content_item', base, { ...base, author: '   ' });
    assert.deepEqual(ops, [{ op: 'set_article_meta', fields: { author: null } }]);
  });

  it('never emits an op for a type with no fields op', () => {
    assert.deepEqual(buildFormPatchOps('product', { a: '1' }, { a: '2' }), []);
  });
});

describe('validateFormValues', () => {
  it('refuses to empty a schema-required field', () => {
    const base = readFormValues(voiceRecord);
    const errors = validateFormValues('editorial_voice', { ...base, audience: '  ' });
    assert.deepEqual(
      errors.map((error) => error.id),
      ['audience']
    );
  });

  it('checks the article slug pattern and the page route prefix', () => {
    assert.equal(validateFormValues('content_item', { title: 'T', slug: 'Not A Slug' }).length, 1);
    assert.equal(validateFormValues('content_item', { title: 'T', slug: 'a-good-slug' }).length, 0);
    assert.equal(validateFormValues('page', { title: 'T', route: 'about' })[0]?.id, 'route');
    assert.equal(validateFormValues('page', { title: 'T', route: '/about' }).length, 0);
  });

  it('lets an optional field be empty', () => {
    assert.deepEqual(validateFormValues('content_item', { title: 'T', slug: 't', author: '' }), []);
  });
});

describe('reconcileFormDraft — form ⇄ chat round-tripping', () => {
  const base: FormValues = { title: 'Old', author: 'Ada', slug: 's' };

  it('adopts the agent’s value for a field the editor never touched', () => {
    const result = reconcileFormDraft({
      base,
      draft: { ...base },
      incoming: { ...base, title: 'Written by the agent' },
    });
    assert.equal(result.values.title, 'Written by the agent');
    assert.deepEqual(result.adopted, ['title']);
    assert.deepEqual(result.conflicts, []);
  });

  it('keeps the editor’s unsaved text when the agent did not touch that field', () => {
    const result = reconcileFormDraft({
      base,
      draft: { ...base, author: 'Grace' },
      incoming: { ...base, title: 'Agent title' },
    });
    assert.equal(result.values.author, 'Grace');
    assert.equal(result.values.title, 'Agent title');
    assert.deepEqual(result.conflicts, []);
  });

  it('reports a conflict — and does NOT overwrite the editor — when both changed the same field', () => {
    const result = reconcileFormDraft({
      base,
      draft: { ...base, title: 'Mine' },
      incoming: { ...base, title: 'Theirs' },
    });
    assert.equal(result.values.title, 'Mine', 'the editor’s in-progress text is never clobbered');
    assert.deepEqual(result.conflicts, [{ id: 'title', mine: 'Mine', theirs: 'Theirs' }]);
    assert.deepEqual(result.adopted, []);
  });

  it('treats an identical concurrent edit as agreement, not a conflict', () => {
    const result = reconcileFormDraft({
      base,
      draft: { ...base, title: 'Same' },
      incoming: { ...base, title: 'Same' },
    });
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.values.title, 'Same');
  });

  it('always rebases on the incoming record, so the next save diffs against reality', () => {
    const result = reconcileFormDraft({
      base,
      draft: { ...base, title: 'Mine' },
      incoming: { ...base, title: 'Theirs', author: 'Agent' },
    });
    assert.deepEqual(result.base, { title: 'Theirs', author: 'Agent', slug: 's' });
    // A save now sends only the field the editor actually still differs on.
    assert.deepEqual(buildFormPatchOps('content_item', result.base, result.values), [
      { op: 'set_article_meta', fields: { title: 'Mine' } },
    ]);
  });

  it('lets the editor take the agent’s side of a conflict', () => {
    const result = reconcileFormDraft({
      base,
      draft: { ...base, title: 'Mine' },
      incoming: { ...base, title: 'Theirs' },
    });
    const resolved = acceptIncomingField(result.values, 'title', result.conflicts[0]!.theirs);
    assert.equal(resolved.title, 'Theirs');
    assert.deepEqual(dirtyFields(result.base, resolved), []);
  });

  it('is idempotent — reconciling twice with no new writes changes nothing', () => {
    const once = reconcileFormDraft({ base, draft: { ...base, author: 'Grace' }, incoming: { ...base } });
    const twice = reconcileFormDraft({ base: once.base, draft: once.values, incoming: { ...base } });
    assert.deepEqual(twice.values, once.values);
    assert.deepEqual(twice.conflicts, []);
    assert.deepEqual(twice.adopted, []);
  });
});
