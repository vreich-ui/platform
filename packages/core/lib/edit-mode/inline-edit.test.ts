import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  derivePrimaryInlineField,
  inlineEditOps,
  inlineToolbarModeFor,
  inlineValueBlockTexts,
  isUpgradableBody,
  normalizePlainBody,
  upgradableCommitValue,
  isRichTextDocument,
  shouldCaptureSelection,
} from './inline-edit.js';
import { renderArticleNodes } from '../article-object/render-nodes.js';
import type { ContentItemBody } from '../../schema/bodies/content-item-v1.js';
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

describe('inlineToolbarModeFor', () => {
  it('gives a rich_text.v1 body the full grammar', () => {
    assert.strictEqual(inlineToolbarModeFor({ key: 'body', kind: 'doc' }, 'content_item'), 'rich');
    assert.strictEqual(inlineToolbarModeFor({ key: 'body', kind: 'doc' }, 'page'), 'rich');
  });

  it('gives a single-line string the muted "Plain text" hint, never buttons', () => {
    // A <strong> in a heading string is escaped by the renderer and ships as
    // literal markup — offering the button would be actively harmful.
    for (const key of ['title', 'heading', 'eyebrow', 'ctaText', 'label']) {
      assert.strictEqual(inlineToolbarModeFor({ key, kind: 'plain' }, 'content_item'), 'plain', key);
      assert.strictEqual(inlineToolbarModeFor({ key, kind: 'plain' }, 'page'), 'plain', key);
    }
  });

  it('gives a raw HTML section body no toolbar at all (out of scope here)', () => {
    assert.strictEqual(inlineToolbarModeFor({ key: 'body', kind: 'html' }, 'page'), 'none');
  });

  it('offers the full bar on an article body string — it may become a document', () => {
    // Wolf, 2026-08-11: "Yes — upgrade on first format."
    assert.strictEqual(inlineToolbarModeFor({ key: 'body', kind: 'plain' }, 'content_item'), 'upgrade');
    assert.strictEqual(isUpgradableBody({ key: 'body', kind: 'plain' }, 'content_item'), true);
  });

  it('does NOT offer it on a section body string, whose schema has no document shape', () => {
    assert.strictEqual(inlineToolbarModeFor({ key: 'body', kind: 'plain' }, 'page'), 'plain');
    assert.strictEqual(isUpgradableBody({ key: 'body', kind: 'plain' }, 'section'), false);
    assert.strictEqual(isUpgradableBody({ key: 'title', kind: 'plain' }, 'content_item'), false);
  });
});

describe('upgradableCommitValue — the shape changes on the first FORMAT, not the first edit', () => {
  const doc = { nodeType: 'document', data: {}, content: [] };

  it('returns the original string byte for byte when nothing textual changed', () => {
    // Opening a block and clicking away must never rewrite its whitespace.
    const before = 'One.\n\n\nTwo.   ';
    assert.strictEqual(upgradableCommitValue(before, doc, 'One.\n\nTwo.', false), before);
  });

  it('returns the edited plain string while no formatting has been applied', () => {
    assert.strictEqual(upgradableCommitValue('One.', doc, 'One, edited.', false), 'One, edited.');
  });

  it('returns the DOCUMENT the moment formatting appears — one update_node, one way', () => {
    assert.strictEqual(upgradableCommitValue('One.', doc, 'One.', true), doc);
  });

  it('upgrades even when the text is untouched: bolding a word IS the change', () => {
    assert.strictEqual(upgradableCommitValue('One.', doc, 'One.', true), doc);
  });
});

describe('normalizePlainBody', () => {
  it('collapses blank runs and trims paragraphs, exactly as the renderer does', () => {
    assert.strictEqual(normalizePlainBody('  a  \n\n\n  b\nc  '), 'a\n\nb\nc');
    assert.strictEqual(normalizePlainBody(''), '');
  });
});

describe('inlineValueBlockTexts — the key the editor mounts by', () => {
  /** The text each rendered <p> actually exposes as `textContent`. */
  const renderedParagraphTexts = (body: string): string[] => {
    const { html } = renderArticleNodes('req_a', {
      nodes: [{ id: 'n_1', kind: 'content', public: { body } }],
    } as unknown as ContentItemBody);
    return [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((match) =>
      match[1]
        .replace(/<[^>]*>/g, '')
        .replaceAll('&#39;', "'")
        .replaceAll('&quot;', '"')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&')
    );
  };

  it('splits a plain body exactly where the renderer splits paragraphs', () => {
    const body = 'First paragraph.\n\nSecond one.\n\n\nThird, after extra blank lines.';
    assert.deepStrictEqual(inlineValueBlockTexts({ key: 'body', kind: 'plain' }, body), [
      'First paragraph.',
      'Second one.',
      'Third, after extra blank lines.',
    ]);
    assert.deepStrictEqual(inlineValueBlockTexts({ key: 'body', kind: 'plain' }, body), renderedParagraphTexts(body));
  });

  it('drops single newlines, because the renderer emits them as <br/> (no text)', () => {
    const body = 'Line one\nline two';
    assert.deepStrictEqual(inlineValueBlockTexts({ key: 'body', kind: 'plain' }, body), ['Line oneline two']);
    assert.deepStrictEqual(inlineValueBlockTexts({ key: 'body', kind: 'plain' }, body), renderedParagraphTexts(body));
  });

  it('carries an escaped character through as the reader sees it', () => {
    const body = "Barrier & bounce — it's fine";
    assert.deepStrictEqual(inlineValueBlockTexts({ key: 'body', kind: 'plain' }, body), renderedParagraphTexts(body));
  });

  it('treats a single-line field as one block', () => {
    assert.deepStrictEqual(inlineValueBlockTexts({ key: 'title', kind: 'plain' }, 'A heading'), ['A heading']);
  });

  it('splits an HTML body on its real block boundaries', () => {
    assert.deepStrictEqual(
      inlineValueBlockTexts({ key: 'body', kind: 'html' }, '<p>One <strong>bold</strong>.</p><ul><li>a</li></ul>'),
      ['One bold.', 'a']
    );
  });

  it('reads a rich_text.v1 document block by block, lists concatenated like their <ul>', () => {
    const doc = {
      nodeType: 'document',
      data: {},
      content: [
        { nodeType: 'heading-2', data: {}, content: [{ nodeType: 'text', value: 'Title', marks: [], data: {} }] },
        {
          nodeType: 'unordered-list',
          data: {},
          content: [
            {
              nodeType: 'list-item',
              data: {},
              content: [
                { nodeType: 'paragraph', data: {}, content: [{ nodeType: 'text', value: 'one', marks: [], data: {} }] },
              ],
            },
            {
              nodeType: 'list-item',
              data: {},
              content: [
                { nodeType: 'paragraph', data: {}, content: [{ nodeType: 'text', value: 'two', marks: [], data: {} }] },
              ],
            },
          ],
        },
      ],
    };
    assert.deepStrictEqual(inlineValueBlockTexts({ key: 'body', kind: 'doc' }, doc), ['Title', 'onetwo']);
  });

  it('yields nothing for an empty or absent value — the caller falls back to the panel', () => {
    assert.deepStrictEqual(inlineValueBlockTexts({ key: 'body', kind: 'plain' }, ''), []);
    assert.deepStrictEqual(inlineValueBlockTexts({ key: 'body', kind: 'plain' }, undefined), []);
    assert.deepStrictEqual(
      inlineValueBlockTexts({ key: 'body', kind: 'doc' }, { nodeType: 'document', content: [] }),
      []
    );
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
