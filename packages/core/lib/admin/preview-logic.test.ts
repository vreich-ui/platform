/**
 * T9.10 — preview leak-rule + derivation. The content_item preview reuses the
 * ONE public renderer, so a fixture carrying node.private (strategy/intent/
 * agentNotes) and envelope internals (editorial/emotional_strategy/scores)
 * must render ZERO of those strings into the preview HTML — the reader-safety
 * rule applies to the workspace too.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { contentItemPreview, productPreview, tokenSwatches, tokenFonts, pageSectionLabel } from './preview-logic.js';
import type { ObjectRecord } from '../../schema/object-record-v1.js';

const rec = (object_type: ObjectRecord['object_type'], body: unknown, object_id = 'obj_1') =>
  ({ object_id, object_type, body }) as Pick<ObjectRecord, 'object_id' | 'object_type' | 'body'>;

describe('contentItemPreview leak rule', () => {
  const secretStrings = [
    'SECRET_STRATEGY_HOOK',
    'SECRET_INTENT',
    'SECRET_AGENT_NOTES',
    'SECRET_WRITER_NOTES',
    'SECRET_TEXTURE',
    'SECRET_SCORE_RATIONALE',
  ];

  const leakyBody = {
    slug: 'barrier-repair',
    title: 'Barrier Repair Guide',
    deck: 'A public deck.',
    description: 'A public description.',
    nodes: [
      {
        id: 'node_1',
        kind: 'content',
        visibility: 'public',
        public: { body: 'The visible public prose of the article.' },
        private: {
          strategy: 'SECRET_STRATEGY_HOOK',
          intent: 'SECRET_INTENT',
          agentNotes: 'SECRET_AGENT_NOTES',
        },
      },
    ],
    editorial: { writer_notes: 'SECRET_WRITER_NOTES' },
    emotional_strategy: { overall_texture_assessment: 'SECRET_TEXTURE' },
    scores: [
      {
        scored_by: 'judge',
        at: '2026-07-17T00:00:00Z',
        framework: 'f',
        dimension: 'd',
        score: 5,
        rationale: 'SECRET_SCORE_RATIONALE',
      },
    ],
  };

  it('renders public copy and NONE of the private/envelope strings', () => {
    const p = contentItemPreview(rec('content_item', leakyBody));
    assert.equal(p.title, 'Barrier Repair Guide');
    assert.equal(p.deck, 'A public deck.');
    assert.ok(p.bodyHtml.includes('visible public prose'), 'public prose renders');
    const haystack = JSON.stringify(p);
    for (const secret of secretStrings) {
      assert.ok(!haystack.includes(secret), `must not leak ${secret}`);
    }
  });

  it('falls back gracefully when the body is too malformed to render', () => {
    const p = contentItemPreview(rec('content_item', { title: 'Draft', nodes: 'not-an-array' }));
    assert.equal(p.title, 'Draft');
    assert.ok(p.error, 'an unrenderable body reports an error instead of throwing');
  });

  it('drops an unresolvable hero src (artifact ref) but keeps a URL/absolute one', () => {
    const artifactHero = contentItemPreview(
      rec('content_item', { title: 'A', nodes: [], image: { src: 'image/abc/sha.jpg', alt: 'x' } })
    );
    assert.equal(artifactHero.image, undefined);
    const urlHero = contentItemPreview(
      rec('content_item', { title: 'A', nodes: [], image: { src: '/uploads/hero.jpg', alt: 'x' } })
    );
    assert.deepEqual(urlHero.image, { src: '/uploads/hero.jpg', alt: 'x' });
  });
});

describe('productPreview commerce summary', () => {
  it('formats a fixed price and surfaces the gate', () => {
    const p = productPreview(
      rec('product', {
        presentation: { title: 'Serum', excerpt: 'Nice serum' },
        commerce: { mode: 'fixed', price: { amount_cents: 4200, currency: 'usd' } },
        gate: { kind: 'members' },
      })
    );
    assert.equal(p.title, 'Serum');
    assert.equal(p.priceLabel, '42.00 USD');
    assert.equal(p.mode, 'fixed');
    assert.equal(p.gate, 'Gated: members');
  });

  it('labels pay-what-you-want with the minimum and free as free', () => {
    const pwyw = productPreview(
      rec('product', {
        presentation: { title: 'P' },
        commerce: { mode: 'pwyw', pwyw: { min_cents: 500, currency: 'usd' } },
      })
    );
    assert.ok(pwyw.priceLabel?.includes('5.00 USD'));
    const free = productPreview(rec('product', { presentation: { title: 'P' }, commerce: { mode: 'free' } }));
    assert.equal(free.priceLabel, 'Free');
  });
});

describe('token swatches', () => {
  it('extracts colors and fonts from brand tokens', () => {
    const tokens = { colors: { primary: '#123456', accent: '#abcdef' }, fonts: { sans: 'Inter', serif: 'Georgia' } };
    assert.deepEqual(
      tokenSwatches(tokens).sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'accent', value: '#abcdef' },
        { name: 'primary', value: '#123456' },
      ]
    );
    assert.equal(tokenFonts(tokens).length, 2);
  });

  it('is defensive against missing/garbage tokens', () => {
    assert.deepEqual(tokenSwatches(undefined), []);
    assert.deepEqual(tokenFonts({ fonts: 'nope' }), []);
  });
});

describe('pageSectionLabel (D3-sharedref)', () => {
  it('labels an ordinary section by its type', () => {
    const label = pageSectionLabel({ id: 's_1', type: 'hero', data: { heading: 'Hi' } }, 0);
    assert.equal(label, 'hero');
  });

  it('labels a shared_ref by its stamped denormalized name, NOT the literal "shared_ref"', () => {
    const label = pageSectionLabel(
      { id: 's_1', type: 'shared_ref', data: { section: 'sec_abc123', sectionName: 'Barrier Repair CTA' } },
      0
    );
    assert.equal(label, 'Barrier Repair CTA');
  });

  it('a shared_ref whose sectionName is somehow null at read time (defensive — the write path never stamps null; see object-verbs.ts) still degrades to the ref/index fallback, never "shared_ref" and never "null"', () => {
    const label = pageSectionLabel(
      { id: 's_1', type: 'shared_ref', data: { section: 'sec_gone', sectionName: null } },
      2
    );
    assert.equal(label, 'Section 3');
  });

  it('backward compat: an OLD-shape shared_ref with no sectionName field at all degrades to the ref/index fallback, never "shared_ref" and never crashes/undefined', () => {
    const oldShapeSection = { id: 's_1', type: 'shared_ref', data: { section: 'sec_abc123' } };
    assert.equal(pageSectionLabel(oldShapeSection, 4), 'Section 5');
    // Same fixture with a `ref` sibling field present still prefers it over the index fallback.
    const oldShapeWithRef = { id: 's_1', type: 'shared_ref', ref: 'sec_abc123', data: { section: 'sec_abc123' } };
    assert.equal(pageSectionLabel(oldShapeWithRef, 4), 'sec_abc123');
  });

  it('is defensive against a garbage/non-object entry — falls back to the index label, never throws', () => {
    assert.equal(pageSectionLabel(null, 1), 'Section 2');
    assert.equal(pageSectionLabel('not-an-object', 6), 'Section 7');
  });
});
