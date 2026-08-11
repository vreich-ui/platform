/**
 * T9.19 — grammar binding + round-trip. Pins:
 *   - TipTap doc → rich_text.v1 → TipTap doc is stable across the grammar
 *     (paragraphs, h2/h3, bold/italic, https links, hard breaks, lists), and the
 *     rich_text.v1 intermediate validates against the store schema;
 *   - the client sanitizer strips out-of-grammar structure from arbitrary
 *     (pasted) ProseMirror JSON — non-https links, extra marks, h1/h4,
 *     blockquote, unknown blocks — and the result serializes without throwing;
 *   - a hand-built out-of-grammar rich_text.v1 doc is rejected by the store
 *     schema (the server-side half of the defense).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  sanitizeProseMirrorDoc,
  serializeToRichTextV1,
  deserializeFromRichTextV1,
  GRAMMAR_MARKS,
  INLINE_FORBIDDEN_CONTROLS,
  INLINE_FORMAT_COMMANDS,
  INLINE_TOOLBAR_BUTTONS,
  inlineToolbarPlacement,
  plainStringToRichTextV1,
  richTextV1HasFormatting,
  richTextV1ToPlainString,
} from './richtext-editor.js';
import { renderArticleNodes } from '../article-object/render-nodes.js';
import type { ContentItemBody } from '../../schema/bodies/content-item-v1.js';
import { richTextV1Schema } from '../../lib/richtext/rich-text-v1.js';
import type { ProseMirrorNode } from '../richtext/prosemirror.js';
import { BLOCKS, INLINES, MARKS } from '@contentful/rich-text-types';

// rich_text.v1 fixture builders (for schema assertions)
const rtText = (value: string, marks: Array<{ type: string }> = []) => ({ nodeType: 'text', value, marks, data: {} });
const rtLink = (uri: string, ...content: unknown[]) => ({ nodeType: INLINES.HYPERLINK, data: { uri }, content });

// ProseMirror/TipTap fixture builders
const pmDoc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: 'doc', content });
const pmText = (text: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>): ProseMirrorNode => ({
  type: 'text',
  text,
  ...(marks ? { marks } : {}),
});
const pmPara = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: 'paragraph', content });

describe('round-trip: TipTap doc → rich_text.v1 → TipTap doc is stable across the grammar', () => {
  const cases: Array<[string, ProseMirrorNode]> = [
    ['a plain paragraph', pmDoc(pmPara(pmText('Hello world.')))],
    ['bold + italic runs', pmDoc(pmPara(pmText('a', [{ type: 'bold' }]), pmText('b', [{ type: 'italic' }])))],
    ['an h2 heading', pmDoc({ type: 'heading', attrs: { level: 2 }, content: [pmText('Section title')] })],
    ['an https link', pmDoc(pmPara(pmText('anchor', [{ type: 'link', attrs: { href: 'https://example.com' } }])))],
    ['a hard break', pmDoc(pmPara(pmText('line one'), { type: 'hardBreak' }, pmText('line two')))],
    [
      'a bullet list',
      pmDoc({
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [pmPara(pmText('first'))] },
          { type: 'listItem', content: [pmPara(pmText('second'))] },
        ],
      }),
    ],
  ];

  for (const [label, pm] of cases) {
    it(label, () => {
      const rt = serializeToRichTextV1(pm);
      // The intermediate rich_text.v1 validates against the store schema…
      assert.doesNotThrow(() => richTextV1Schema.parse(rt), `${label}: rt is schema-valid`);
      // …and loading it back yields the same TipTap document (the brief's invariant).
      const back = deserializeFromRichTextV1(rt);
      assert.deepEqual(back, pm, `${label} must round-trip identically`);
    });
  }

  it('the rich_text.v1 intermediates carry the expected marks/links', () => {
    const rt = serializeToRichTextV1(pmDoc(pmPara(pmText('x', [{ type: 'bold' }]))));
    assert.deepEqual(rt.content[0], {
      nodeType: BLOCKS.PARAGRAPH,
      data: {},
      content: [rtText('x', [{ type: MARKS.BOLD }])],
    });
    const linked = serializeToRichTextV1(
      pmDoc(pmPara(pmText('anchor', [{ type: 'link', attrs: { href: 'https://ok.example' } }])))
    );
    assert.deepEqual(linked.content[0], {
      nodeType: BLOCKS.PARAGRAPH,
      data: {},
      content: [rtLink('https://ok.example', rtText('anchor'))],
    });
  });
});

describe('sanitizer strips out-of-grammar ProseMirror structure', () => {
  it('drops a non-https link mark but keeps the text', () => {
    const pasted: ProseMirrorNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'http://insecure.example' } }] },
          ],
        },
      ],
    };
    const rt = serializeToRichTextV1(sanitizeProseMirrorDoc(pasted));
    const json = JSON.stringify(rt);
    assert.ok(json.includes('click'), 'text is preserved');
    assert.ok(!json.includes('insecure.example'), 'the non-https href is stripped');
    assert.ok(!json.includes(INLINES.HYPERLINK), 'no hyperlink node survives');
  });

  it('keeps an https link mark', () => {
    const pasted: ProseMirrorNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'go', marks: [{ type: 'link', attrs: { href: 'https://ok.example' } }] }],
        },
      ],
    };
    const rt = serializeToRichTextV1(sanitizeProseMirrorDoc(pasted));
    assert.ok(JSON.stringify(rt).includes('https://ok.example'));
  });

  it('drops an out-of-grammar mark (strike) but keeps the text', () => {
    const pasted: ProseMirrorNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kept', marks: [{ type: 'strike' }] }] }],
    };
    const rt = serializeToRichTextV1(sanitizeProseMirrorDoc(pasted));
    assert.ok(JSON.stringify(rt).includes('kept'));
    assert.ok(!JSON.stringify(rt).includes('strike'), 'strike is stripped');
    assert.ok(!GRAMMAR_MARKS.has('strike'), 'strike is not a grammar mark');
  });

  it('keeps the code mark (inline code display, widened alongside rich-text-v1.ts)', () => {
    const pasted: ProseMirrorNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'const x', marks: [{ type: 'code' }] }] }],
    };
    const rt = serializeToRichTextV1(sanitizeProseMirrorDoc(pasted));
    assert.deepEqual(rt.content[0], {
      nodeType: BLOCKS.PARAGRAPH,
      data: {},
      content: [rtText('const x', [{ type: MARKS.CODE }])],
    });
    assert.ok(GRAMMAR_MARKS.has('code'), 'code is a grammar mark');
  });

  it('demotes h1/h4 to paragraphs and unwraps blockquote', () => {
    const pasted: ProseMirrorNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'big' }] },
        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'small' }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
      ],
    };
    const clean = sanitizeProseMirrorDoc(pasted);
    assert.deepEqual(
      clean.content?.map((b) => b.type),
      ['paragraph', 'paragraph', 'paragraph'],
      'h1/h4 demote to paragraph; blockquote unwraps to its paragraph'
    );
    assert.doesNotThrow(() => serializeToRichTextV1(clean));
  });

  it('flattens an unknown block (codeBlock) to a paragraph of its text', () => {
    const pasted: ProseMirrorNode = {
      type: 'doc',
      content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x = 1' }] }],
    };
    const rt = serializeToRichTextV1(sanitizeProseMirrorDoc(pasted));
    assert.ok(JSON.stringify(rt).includes('x = 1'));
  });

  it('is total: any garbage doc yields a schema-valid rich_text.v1', () => {
    const garbage: ProseMirrorNode = {
      type: 'doc',
      content: [
        { type: 'horizontalRule' },
        { type: 'table', content: [{ type: 'tableRow', content: [] }] },
        { type: 'paragraph', content: [{ type: 'image', attrs: { src: 'x' } } as unknown as ProseMirrorNode] },
      ],
    };
    const rt = serializeToRichTextV1(sanitizeProseMirrorDoc(garbage));
    assert.doesNotThrow(() => richTextV1Schema.parse(rt));
  });
});

describe('server-side half: the store schema rejects a hand-built violation', () => {
  it('rejects an unknown mark that bypassed the client sanitizer', () => {
    const violation = {
      nodeType: BLOCKS.DOCUMENT,
      data: {},
      content: [{ nodeType: BLOCKS.PARAGRAPH, data: {}, content: [rtText('x', [{ type: 'underline' }])] }],
    };
    assert.throws(() => richTextV1Schema.parse(violation), /invalid|underline|enum/i);
  });
});

// ── the inline formatting toolbar ────────────────────────────────────────────

describe('the toolbar offers exactly what the grammar can hold', () => {
  it('offers no control the store has no representation for', () => {
    const forbidden = new Set<string>(INLINE_FORBIDDEN_CONTROLS);
    for (const control of INLINE_FORMAT_COMMANDS) {
      assert.ok(!forbidden.has(control), `${control} is offered AND forbidden`);
    }
    for (const mode of ['rich', 'upgrade', 'plain', 'none'] as const) {
      for (const control of INLINE_TOOLBAR_BUTTONS[mode]) {
        assert.ok(!forbidden.has(control), `${mode} draws a button for the forbidden ${control}`);
        assert.ok(
          (INLINE_FORMAT_COMMANDS as readonly string[]).includes(control),
          `${mode} draws ${control}, which is not a declared command`
        );
      }
    }
  });

  it('names strikethrough, underline, code blocks, h1 and alignment as forbidden', () => {
    // The list is the contract: these would either be stripped by the
    // sanitizer on save or rejected by the store schema outright.
    for (const banned of ['strike', 'underline', 'codeBlock', 'horizontalRule', 'h1', 'textAlign', 'blockquote']) {
      assert.ok((INLINE_FORBIDDEN_CONTROLS as readonly string[]).includes(banned), `${banned} must stay off the bar`);
    }
  });

  it('draws every mark and block the grammar allows, and only those', () => {
    const marks = new Set(GRAMMAR_MARKS); // bold, italic, code, link
    for (const control of ['bold', 'italic', 'code', 'link']) {
      assert.ok(marks.has(control), `${control} must be a grammar mark`);
    }
    assert.deepStrictEqual(
      [...INLINE_TOOLBAR_BUTTONS.rich],
      ['bold', 'italic', 'code', 'bulletList', 'orderedList', 'h2', 'h3', 'paragraph', 'link', 'undo', 'redo'],
      'the shipped control list'
    );
  });

  it('gives an upgradable plain body the same controls as a rich one', () => {
    assert.deepStrictEqual([...INLINE_TOOLBAR_BUTTONS.upgrade], [...INLINE_TOOLBAR_BUTTONS.rich]);
  });

  it('gives a plain single-line field NO buttons — the muted hint instead', () => {
    assert.deepStrictEqual([...INLINE_TOOLBAR_BUTTONS.plain], []);
    assert.deepStrictEqual([...INLINE_TOOLBAR_BUTTONS.none], []);
  });
});

describe('inlineToolbarPlacement', () => {
  const size = { width: 300, height: 32 };
  const viewport = { width: 1200, height: 800 };

  it('sits 8px above the selection, centred on it', () => {
    const at = inlineToolbarPlacement({ top: 400, bottom: 420, left: 500, width: 100 }, size, viewport, 46);
    assert.strictEqual(at.top, 400 - 8 - 32);
    assert.strictEqual(at.left, 500 + 50 - 150);
    assert.strictEqual(at.flipped, false);
  });

  it('flips below when it would collide with the top bar', () => {
    const at = inlineToolbarPlacement({ top: 60, bottom: 90, left: 500, width: 100 }, size, viewport, 46);
    assert.strictEqual(at.flipped, true);
    assert.strictEqual(at.top, 98);
  });

  it('never rides under the top bar, even flipped', () => {
    for (let top = -50; top < 200; top += 1) {
      const at = inlineToolbarPlacement({ top, bottom: top + 20, left: 40, width: 80 }, size, viewport, 46);
      assert.ok(at.top >= 46, `top ${at.top} for a selection at ${top}`);
    }
  });

  it('clamps to the viewport on both edges', () => {
    const left = inlineToolbarPlacement({ top: 400, bottom: 420, left: 0, width: 10 }, size, viewport, 46);
    assert.strictEqual(left.left, 8);
    const right = inlineToolbarPlacement({ top: 400, bottom: 420, left: 1190, width: 10 }, size, viewport, 46);
    assert.strictEqual(right.left, 1200 - 300 - 8);
    const bottom = inlineToolbarPlacement({ top: 790, bottom: 799, left: 500, width: 10 }, size, viewport, 46);
    assert.ok(bottom.top + size.height <= viewport.height, 'never below the fold');
  });

  it('stays inside a viewport too small for it rather than going negative', () => {
    const viewportTiny = { width: 200, height: 90 };
    const tiny = inlineToolbarPlacement({ top: 20, bottom: 40, left: 5, width: 10 }, size, viewportTiny, 46);
    assert.strictEqual(tiny.left, 8, 'wider than the viewport: pinned to the left edge, never negative');
    assert.ok(tiny.top >= 46 && tiny.top + size.height <= viewportTiny.height, `top ${tiny.top} stays in the band`);
  });
});

// ── plain string → rich_text.v1 (the fix-3 upgrade, Wolf: "upgrade on first format")

describe('plainStringToRichTextV1 is the exact inverse of the plain-text renderer', () => {
  const asArticleHtml = (body: unknown): string =>
    renderArticleNodes('req_a', {
      nodes: [{ id: 'n_1', kind: 'content', public: { body } }],
    } as unknown as ContentItemBody).html;

  const bodies = [
    'One paragraph.',
    'First.\n\nSecond.',
    'Line one\nline two',
    'First.\n\n\n  Padded second.  ',
    "Ampersands & angle <brackets> and 'quotes'.",
    'Trailing break\n\nlast.',
  ];

  for (const body of bodies) {
    it(`renders identically to the string it replaces: ${JSON.stringify(body)}`, () => {
      const doc = plainStringToRichTextV1(body);
      // The document validates against the store schema…
      assert.doesNotThrow(() => richTextV1Schema.parse(doc));
      // …and the article renders byte-identically either way, which is what
      // makes the upgrade invisible to a reader.
      assert.strictEqual(asArticleHtml(doc), asArticleHtml(body));
    });
  }

  it('gives an empty body one empty paragraph, so the editor has a caret home', () => {
    assert.deepStrictEqual(plainStringToRichTextV1(''), {
      nodeType: 'document',
      data: {},
      content: [{ nodeType: 'paragraph', data: {}, content: [] }],
    });
  });

  it('round-trips back to the normalized plain string', () => {
    assert.strictEqual(richTextV1ToPlainString(plainStringToRichTextV1('a\n\n\n b ')), 'a\n\nb');
    assert.strictEqual(richTextV1ToPlainString(plainStringToRichTextV1('one\ntwo')), 'one\ntwo');
  });
});

describe('richTextV1HasFormatting — what decides the shape upgrade', () => {
  const para = (...content: unknown[]) => ({ nodeType: 'paragraph', data: {}, content });
  const text = (value: string, marks: Array<{ type: string }> = []) => ({
    nodeType: 'text',
    value,
    marks,
    data: {},
  });
  const doc = (...content: unknown[]) => ({ nodeType: 'document', data: {}, content }) as never;

  it('is false for paragraphs of unmarked text — including hard breaks', () => {
    assert.strictEqual(richTextV1HasFormatting(doc(para(text('a\nb')), para(text('c')))), false);
    assert.strictEqual(richTextV1HasFormatting(doc()), false);
  });

  it('is true for a mark', () => {
    assert.strictEqual(richTextV1HasFormatting(doc(para(text('a', [{ type: 'bold' }])))), true);
    assert.strictEqual(richTextV1HasFormatting(doc(para(text('a', [{ type: 'code' }])))), true);
  });

  it('is true for a link', () => {
    const link = { nodeType: 'hyperlink', data: { uri: 'https://example.com' }, content: [text('a')] };
    assert.strictEqual(richTextV1HasFormatting(doc(para(link))), true);
  });

  it('is true for a heading or a list', () => {
    assert.strictEqual(richTextV1HasFormatting(doc({ nodeType: 'heading-2', data: {}, content: [text('a')] })), true);
    assert.strictEqual(
      richTextV1HasFormatting(
        doc({
          nodeType: 'unordered-list',
          data: {},
          content: [{ nodeType: 'list-item', data: {}, content: [para(text('a'))] }],
        })
      ),
      true
    );
  });
});
