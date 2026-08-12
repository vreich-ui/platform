import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  OBJECT_CONTEXT_ACTIONS,
  PDF_TEMPLATE_CONTEXT_ACTIONS,
  IMAGE_CONTEXT_ACTIONS,
  SECTION_CONTEXT_ACTIONS,
  contextActionsFor,
  createApprovalClaim,
  isNewPageSectionProposal,
  repeatableItemCount,
} from './object-context-actions.js';

const sectionContext = {
  focusKind: 'section' as const,
  focusLabel: 'Benefits',
  parentLabel: 'Homepage',
  itemCount: 3,
  repeatable: true,
};

describe('ObjectContextAction registry', () => {
  it('builds a scoped, human-readable instruction for every section action', () => {
    for (const action of SECTION_CONTEXT_ACTIONS) {
      const instruction = action.buildContext(sectionContext);
      assert.ok(instruction.length > 20, action.id);
      assert.match(instruction, /Benefits/);
      assert.match(instruction, /Homepage/);
    }
  });

  it('never exposes private strategy vocabulary in labels or generated text', () => {
    const banned = /\b(hook|agitation|offer mechanics?)\b/i;
    for (const action of OBJECT_CONTEXT_ACTIONS) {
      const context = action.appliesTo.includes('pdf-template')
        ? { focusKind: 'pdf-template' as const, focusLabel: 'Evidence guide' }
        : action.appliesTo.includes('image')
          ? { focusKind: 'image' as const, focusLabel: 'Product portrait' }
          : sectionContext;
      assert.doesNotMatch(action.label, banned, action.id);
      assert.doesNotMatch(action.buildContext(context), banned, action.id);
    }
  });

  it('provides sparse PDF and image intent controls without direct mutation', () => {
    const pdf = contextActionsFor({ focusKind: 'pdf-template', focusLabel: 'Evidence guide' });
    const image = contextActionsFor({ focusKind: 'image', focusLabel: 'Product portrait' });
    assert.deepStrictEqual(pdf, PDF_TEMPLATE_CONTEXT_ACTIONS);
    assert.deepStrictEqual(image, IMAGE_CONTEXT_ACTIONS);
    assert.ok(
      pdf.every((action) =>
        action.buildContext({ focusKind: 'pdf-template', focusLabel: 'Evidence guide' }).includes('Evidence guide')
      )
    );
    assert.ok(
      image.every((action) =>
        action.buildContext({ focusKind: 'image', focusLabel: 'Product portrait' }).includes('Product portrait')
      )
    );
  });

  it('shows collection controls only for repeatable sections', () => {
    const repeatable = contextActionsFor(sectionContext).map((action) => action.id);
    const prose = contextActionsFor({ ...sectionContext, repeatable: false, itemCount: undefined }).map(
      (action) => action.id
    );
    assert.ok(repeatable.includes('add-item'));
    assert.ok(repeatable.includes('reduce-items'));
    assert.ok(!prose.includes('add-item'));
    assert.ok(!prose.includes('reduce-items'));
  });
});

describe('repeatableItemCount', () => {
  it('recognizes known collections without treating arbitrary arrays as repeatable content', () => {
    assert.strictEqual(repeatableItemCount({ data: { items: [{}, {}, {}] } }), 3);
    assert.strictEqual(repeatableItemCount({ data: { source: { cards: [{}, {}] } } }), 2);
    assert.strictEqual(repeatableItemCount({ data: { privateNotes: ['x'] } }), undefined);
  });
});

describe('Page section sequential proposal', () => {
  it('accepts a new upsert or page-targeted section template and rejects updates to an existing section', () => {
    const existing = new Set(['s_existing']);
    assert.strictEqual(
      isNewPageSectionProposal(
        {
          call_id: 'call_new',
          tool: 'patch',
          args: {
            object_type: 'page',
            object_id: 'page_home',
            ops: [{ op: 'upsert_section', section: { id: 's_new', type: 'prose', data: {} } }],
          },
        },
        'page_home',
        existing
      ),
      true
    );
    assert.strictEqual(
      isNewPageSectionProposal(
        {
          call_id: 'call_existing',
          tool: 'patch',
          args: {
            object_type: 'page',
            object_id: 'page_home',
            ops: [{ op: 'upsert_section', section: { id: 's_existing', type: 'prose', data: {} } }],
          },
        },
        'page_home',
        existing
      ),
      false
    );
    assert.strictEqual(
      isNewPageSectionProposal(
        {
          call_id: 'call_template',
          tool: 'instantiate_section_template',
          args: { section_template_id: 'stpl_education', target: { kind: 'page', page_id: 'page_home' } },
        },
        'page_home',
        existing
      ),
      true
    );
  });

  it('claims the same approval call exactly once and permits an explicit retry after failure', () => {
    const gate = createApprovalClaim();
    assert.strictEqual(gate.claim('call_1'), true);
    assert.strictEqual(gate.claim('call_1'), false);
    gate.release('call_1');
    assert.strictEqual(gate.claim('call_1'), true);
  });

  it('has() reports membership without claiming, tracking claim/release exactly — the consumed-approval derivation', () => {
    const gate = createApprovalClaim();
    assert.strictEqual(gate.has('call_2'), false);
    assert.strictEqual(gate.claim('call_2'), true);
    assert.strictEqual(gate.has('call_2'), true, 'has() reflects a successful claim');
    assert.strictEqual(gate.has('call_2'), true, 'has() is read-only — repeated calls do not change state');
    assert.strictEqual(gate.claim('call_2'), false, 'a claimed call_id cannot be reclaimed');
    gate.release('call_2');
    assert.strictEqual(gate.has('call_2'), false, 'release() clears membership so the card can go interactive again');
    assert.strictEqual(gate.claim('call_2'), true, 'a released call_id can be reclaimed');
  });
});
