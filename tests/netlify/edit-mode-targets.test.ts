import assert from 'node:assert/strict';
import test from 'node:test';

import {
  changedFieldsOnly,
  deriveEditTarget,
  suggestionToOps,
  summarizeFieldChanges,
} from '../../packages/core/lib/edit-mode/targets.js';
import { blockText, richTextToBlocks } from '../../packages/core/lib/edit-mode/preview.js';

// ── target routing (the shared_ref rule) ─────────────────────────────────────

test('an inline section routes to its page, scoped by the instance id', () => {
  const target = deriveEditTarget({ cmsObjectId: 'page_home', cmsSectionId: 's_hero', cmsSectionType: 'hero' });
  assert.deepEqual(target, {
    objectType: 'page',
    objectId: 'page_home',
    sectionId: 's_hero',
    sectionType: 'hero',
    hostObjectId: 'page_home',
    shared: false,
  });
});

test('a shared_ref-derived section routes to the SHARED OBJECT, never the page', () => {
  const target = deriveEditTarget({
    cmsObjectId: 'page_home',
    cmsSectionId: 's_newsletter',
    cmsSectionType: 'newsletter_signup',
    cmsSharedObject: 'sec_newsletter_signup',
  });
  assert.equal(target?.objectType, 'section');
  assert.equal(target?.objectId, 'sec_newsletter_signup');
  assert.equal(target?.sectionId, undefined, 'the page instance id must not scope a shared-object request');
  assert.equal(target?.hostObjectId, 'page_home');
  assert.equal(target?.shared, true);
});

test('an incomplete annotation derives no target (never guess)', () => {
  assert.equal(deriveEditTarget({ cmsObjectId: 'page_home' }), undefined);
  assert.equal(deriveEditTarget({}), undefined);
});

// ── suggestion → ops ─────────────────────────────────────────────────────────

test('a page suggestion becomes update_section_data scoped by the page instance id', () => {
  const target = deriveEditTarget({ cmsObjectId: 'page_home', cmsSectionId: 's_prose', cmsSectionType: 'prose' });
  const ops = suggestionToOps(target!, { body: '<p>New.</p>' });
  assert.deepEqual(ops, [{ op: 'update_section_data', section_id: 's_prose', fields: { body: '<p>New.</p>' } }]);
});

test('a shared suggestion scopes by the INNER instance id from the Ask-AI response', () => {
  const target = deriveEditTarget({
    cmsObjectId: 'page_home',
    cmsSectionId: 's_newsletter',
    cmsSectionType: 'newsletter_signup',
    cmsSharedObject: 'sec_newsletter_signup',
  });
  const ops = suggestionToOps(target!, { heading: 'New heading' }, 's_signup');
  assert.deepEqual(ops, [{ op: 'update_section_data', section_id: 's_signup', fields: { heading: 'New heading' } }]);
  assert.throws(() => suggestionToOps(target!, { heading: 'x' }), /no section instance id/);
});

// ── field-change summary (draft record is the baseline) ─────────────────────

test('unchanged fields are dropped; kinds classify plain, html, and structured values', () => {
  const current = {
    heading: 'Old heading',
    body: '<p>Old body.</p>',
    actions: [{ label: 'Go' }],
    formName: 'newsletter',
  };
  const suggestion = {
    heading: 'New heading',
    body: '<p>New body.</p>',
    actions: [{ label: 'Go' }], // identical → dropped
    formName: 'newsletter', // identical → dropped
  };
  const changes = summarizeFieldChanges(current, suggestion);
  assert.deepEqual(
    changes.map((change) => [change.field, change.kind]),
    [
      ['heading', 'string'],
      ['body', 'html'],
    ]
  );
  assert.deepEqual(changedFieldsOnly(changes), { heading: 'New heading', body: '<p>New body.</p>' });
});

test('a structured value change is kind json', () => {
  const changes = summarizeFieldChanges({ actions: [{ label: 'Go' }] }, { actions: [{ label: 'Stop' }] });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'json');
});

test('a plain body upgrading to a rich_text.v1 document is kind json, both directions', () => {
  // The T17.8 fix-3 transition: `content_item` bodies accept either shape, so
  // a field's value can flip from string to document (and an Ask-AI reply can
  // propose the reverse). Neither may be mistaken for a rich-text HTML string,
  // whose preview path would try to splice it into the page as markup.
  const doc = {
    nodeType: 'document',
    data: {},
    content: [{ nodeType: 'paragraph', data: {}, content: [{ nodeType: 'text', value: 'Hi', marks: [], data: {} }] }],
  };
  const upgrade = summarizeFieldChanges({ body: 'Hi' }, { body: doc });
  assert.deepEqual(
    upgrade.map((change) => [change.field, change.kind]),
    [['body', 'json']]
  );
  const downgrade = summarizeFieldChanges({ body: doc }, { body: 'Hi' });
  assert.deepEqual(
    downgrade.map((change) => [change.field, change.kind]),
    [['body', 'json']]
  );
  // …and an unchanged document is still dropped by the deep compare.
  assert.deepEqual(summarizeFieldChanges({ body: doc }, { body: structuredClone(doc) }), []);
});

// ── rich-text block helpers (built on the REAL splitters) ────────────────────

test('richTextToBlocks splits mixed blocks via the real splitter and tolerates paragraphs-only', () => {
  const mixed = richTextToBlocks('<h2>Title</h2><p>One <strong>two</strong>.</p>');
  assert.deepEqual(
    mixed?.map((block) => block.tag),
    ['h2', 'p']
  );
  const paragraphs = richTextToBlocks('<p>A.</p><p>B.</p>');
  assert.deepEqual(
    paragraphs?.map((block) => block.tag),
    ['p', 'p']
  );
  assert.equal(richTextToBlocks('not html at all'), undefined);
});

test('blockText strips markup down to comparable text', () => {
  assert.equal(blockText('One <strong>two</strong>&nbsp; three.'.replace('&nbsp;', ' ')), 'One two three.');
  assert.equal(blockText('<em>  spaced  </em>'), 'spaced');
});

// ── article node targets (W7.8) ──────────────────────────────────────────────

test('an annotated article node routes to its content_item object, scoped by node id', async () => {
  const { deriveNodeTarget } = await import('../../packages/core/lib/edit-mode/targets.js');
  const target = deriveNodeTarget({
    cmsObjectId: 'req_agent_barrier_myths_20260713_01',
    cmsNodeId: 'n_a1',
    cmsNodeKind: 'content',
  });
  assert.deepEqual(target, {
    objectType: 'content_item',
    objectId: 'req_agent_barrier_myths_20260713_01',
    nodeId: 'n_a1',
    sectionType: 'article content',
    hostObjectId: 'req_agent_barrier_myths_20260713_01',
    shared: false,
  });
  assert.equal(deriveNodeTarget({ cmsObjectId: 'req_x' }), undefined, 'no node id → no target');
});

test('a node suggestion persists as update_node with fields under public', async () => {
  const { deriveNodeTarget } = await import('../../packages/core/lib/edit-mode/targets.js');
  const target = deriveNodeTarget({
    cmsObjectId: 'req_agent_barrier_myths_20260713_01',
    cmsNodeId: 'n_a1',
    cmsNodeKind: 'content',
  });
  assert.ok(target);
  assert.deepEqual(suggestionToOps(target, { title: 'Sharper', body: 'New copy.' }), [
    { op: 'update_node', node_id: 'n_a1', fields: { public: { title: 'Sharper', body: 'New copy.' } } },
  ]);
});
