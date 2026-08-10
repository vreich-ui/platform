import { describe, it } from 'node:test';
import assert from 'node:assert';

import { derivePrimaryInlineField, inlineEditOps, isRichTextDocument, shouldCaptureSelection } from './inline-edit.js';
import type { EditTarget } from './targets.js';

const richTextDoc = { nodeType: 'document', data: {}, content: [] };

describe('isRichTextDocument', () => {
  it('recognises a rich_text.v1 document', () => {
    assert.strictEqual(isRichTextDocument(richTextDoc), true);
  });
  it('rejects strings, arrays, nulls and other objects', () => {
    assert.strictEqual(isRichTextDocument('<p>hi</p>'), false);
    assert.strictEqual(isRichTextDocument([richTextDoc]), false);
    assert.strictEqual(isRichTextDocument(null), false);
    assert.strictEqual(isRichTextDocument({ nodeType: 'paragraph', content: [] }), false);
    assert.strictEqual(isRichTextDocument({ nodeType: 'document' }), false);
  });
});

describe('derivePrimaryInlineField', () => {
  it('picks a plain string field on an article node', () => {
    assert.deepStrictEqual(derivePrimaryInlineField({ body: 'Two paragraphs.\n\nHere.' }, 'content_item'), {
      key: 'body',
      kind: 'plain',
    });
  });

  it('never calls an article body HTML, even when it contains angle brackets', () => {
    assert.deepStrictEqual(derivePrimaryInlineField({ body: 'a <b> tag, literally' }, 'content_item'), {
      key: 'body',
      kind: 'plain',
    });
  });

  it('treats a section body as rich-text HTML', () => {
    assert.deepStrictEqual(derivePrimaryInlineField({ body: '<p>Hello</p>' }, 'page'), { key: 'body', kind: 'html' });
  });

  it('treats a section single-line field as plain', () => {
    assert.deepStrictEqual(derivePrimaryInlineField({ title: 'A heading' }, 'page'), { key: 'title', kind: 'plain' });
  });

  it('prefers the body over an earlier heading key', () => {
    assert.deepStrictEqual(derivePrimaryInlineField({ title: 'Heading', body: 'Copy' }, 'content_item'), {
      key: 'body',
      kind: 'plain',
    });
  });

  it('falls back to the first eligible field when no preferred key is present', () => {
    assert.deepStrictEqual(derivePrimaryInlineField({ eyebrow: 'Kicker', ctaText: 'Go' }, 'page'), {
      key: 'eyebrow',
      kind: 'plain',
    });
  });

  it('picks a rich_text.v1 document, which the panel form cannot even see', () => {
    assert.deepStrictEqual(derivePrimaryInlineField({ body: richTextDoc }, 'content_item'), {
      key: 'body',
      kind: 'doc',
    });
  });

  it('skips non-copy keys (image/src/url/route/href families)', () => {
    assert.strictEqual(
      derivePrimaryInlineField(
        { media: { type: 'image', src: '/a.png' }, imageAlt: 'x', ogImage: '/og.png', route: '/x' },
        'content_item'
      ),
      undefined
    );
  });

  it('keeps ctaText/ctaLink editable, exactly as the panel form already treats them', () => {
    // NON_COPY_KEY_RE has never excluded `ctaLink` (FIELD_LABELS even labels
    // it "Button link"): inline edit must not invent a stricter rule than the
    // form it replaces for the common case.
    assert.deepStrictEqual(derivePrimaryInlineField({ ctaText: 'Read on', ctaLink: '/go' }, 'page'), {
      key: 'ctaText',
      kind: 'plain',
    });
  });

  it('is undefined for a block with no single primary copy field — the panel takes it', () => {
    assert.strictEqual(derivePrimaryInlineField({}, 'page'), undefined);
    assert.strictEqual(derivePrimaryInlineField({ images: [{ src: '/a.png' }] }, 'content_item'), undefined);
  });

  it('does not offer a string ARRAY (a bullet list is not one value)', () => {
    assert.strictEqual(derivePrimaryInlineField({ items: ['one', 'two'] }, 'content_item'), undefined);
  });
});

describe('shouldCaptureSelection', () => {
  it('captures a single-click drag selection', () => {
    assert.strictEqual(shouldCaptureSelection(1), true);
  });
  it('does NOT capture a double- or triple-click', () => {
    assert.strictEqual(shouldCaptureSelection(2), false);
    assert.strictEqual(shouldCaptureSelection(3), false);
  });
  it('captures when the event carries no click count (programmatic/keyboard)', () => {
    assert.strictEqual(shouldCaptureSelection(0), true);
  });
});

describe('inlineEditOps', () => {
  const nodeTarget: EditTarget = {
    objectType: 'content_item',
    objectId: 'req_a',
    nodeId: 'n_1',
    sectionType: 'article content',
    hostObjectId: 'req_a',
    shared: false,
  };
  const pageTarget: EditTarget = {
    objectType: 'page',
    objectId: 'page_home',
    sectionId: 's_hero',
    sectionType: 'hero',
    hostObjectId: 'page_home',
    shared: false,
  };
  const sharedTarget: EditTarget = {
    objectType: 'section',
    objectId: 'sec_cta',
    sectionType: 'cta',
    hostObjectId: 'page_home',
    shared: true,
  };

  it('maps an article-node commit to update_node under public fields', () => {
    assert.deepStrictEqual(inlineEditOps(nodeTarget, { key: 'body', kind: 'plain' }, 'New copy'), [
      { op: 'update_node', node_id: 'n_1', fields: { public: { body: 'New copy' } } },
    ]);
  });

  it('maps a page-section commit to update_section_data scoped by the instance id', () => {
    assert.deepStrictEqual(inlineEditOps(pageTarget, { key: 'title', kind: 'plain' }, 'Hi'), [
      { op: 'update_section_data', section_id: 's_hero', fields: { title: 'Hi' } },
    ]);
  });

  it('scopes a shared-section commit to the inner instance id it is given', () => {
    assert.deepStrictEqual(inlineEditOps(sharedTarget, { key: 'body', kind: 'html' }, '<p>x</p>', 's_inner'), [
      { op: 'update_section_data', section_id: 's_inner', fields: { body: '<p>x</p>' } },
    ]);
  });

  it('carries a rich_text.v1 document through unchanged', () => {
    assert.deepStrictEqual(inlineEditOps(nodeTarget, { key: 'body', kind: 'doc' }, richTextDoc), [
      { op: 'update_node', node_id: 'n_1', fields: { public: { body: richTextDoc } } },
    ]);
  });
});
