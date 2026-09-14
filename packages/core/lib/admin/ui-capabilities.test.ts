/**
 * ASV2-W4.3 — the `ui_capabilities` manifest (chat-controls protocol §7).
 *
 * The wire itself (when the field rides, and when it does not) is pinned in
 * `server/lib/agent/engine.test.ts`; this file pins the manifest's CONTENT:
 * the control-kind list, the type+rights filter, and the parameter schemas.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { QUICK_ACTIONS } from './quick-actions.js';
import {
  buildUiCapabilities,
  RENDERED_CONTROL_KINDS,
  UI_CAPABILITIES_VERSION,
  uiCapabilityActionsFor,
} from './ui-capabilities.js';

test('the manifest declares protocol v2 and exactly the control kinds this build renders', () => {
  const manifest = buildUiCapabilities(undefined, []);
  assert.equal(manifest.v, 2);
  assert.equal(UI_CAPABILITIES_VERSION, 2);
  // v1's three form kinds + §6's three action kinds. A drift here means the
  // manifest claims a card the client cannot draw (or hides one it can).
  assert.deepEqual(manifest.controls, ['radio', 'checkbox', 'toggle', 'actions', 'select_object', 'confirm']);
  assert.deepEqual([...RENDERED_CONTROL_KINDS], manifest.controls);
});

test('a free chat (no focused object) carries an empty actions list, whatever the caller may do', () => {
  assert.deepEqual(uiCapabilityActionsFor(undefined, ['owner', 'admin']), []);
  assert.deepEqual(buildUiCapabilities(undefined, ['owner']).actions, []);
});

test('a caller with no standing gets an empty list even with an object in focus', () => {
  assert.deepEqual(uiCapabilityActionsFor('content_item', ['viewer']), []);
  assert.deepEqual(uiCapabilityActionsFor('content_item', []), []);
});

test("a focused object's actions are its QUICK_ACTIONS, type-filtered and rights-filtered", () => {
  // An editor may move a record along but not publish it (PUBLISHING vs EDITORIAL).
  const editor = uiCapabilityActionsFor('content_item', ['editor']);
  assert.deepEqual(
    editor.map((action) => action.verb),
    ['object_validate', 'object_submit_review', 'object_create_variant', 'agent_chat']
  );

  const publisher = uiCapabilityActionsFor('content_item', ['publisher']);
  assert.ok(publisher.some((action) => action.verb === 'object_publish'));

  // `new_variant` is content_item-only; `replace_image` only for image-bearing types.
  const theme = uiCapabilityActionsFor('theme', ['owner']);
  assert.deepEqual(
    theme.map((action) => action.verb),
    ['object_validate', 'object_submit_review', 'object_publish']
  );
  const page = uiCapabilityActionsFor('page', ['owner']).map((action) => action.verb);
  assert.ok(!page.includes('object_create_variant'));
  assert.ok(page.includes('agent_chat'), 'the chat hand-off is an offered action, routed by executionFor (§6.1)');
});

test('every offered verb comes from the one registry — the manifest never widens the verb surface', () => {
  const registryVerbs = new Set<string>(QUICK_ACTIONS.map((definition) => definition.verb));
  for (const objectType of ['content_item', 'page', 'product', 'theme', 'section_template']) {
    for (const action of uiCapabilityActionsFor(objectType, ['owner', 'admin', 'publisher', 'editor'])) {
      assert.ok(registryVerbs.has(action.verb), `${action.verb} is not a quick-actions.ts verb`);
      assert.match(action.verb, /^[A-Za-z0-9_-]{1,64}$/, 'upstream verb pattern');
      assert.ok(action.label.length >= 1 && action.label.length <= 120, 'upstream label bound');
    }
  }
});

test('parameter schemas travel with each action: enumerable answers are optional, free-text answers are required', () => {
  const owner = uiCapabilityActionsFor('content_item', ['owner']);
  const byVerb = new Map(owner.map((action) => [action.verb, action]));

  // Zero human parameters — run immediately.
  assert.deepEqual(byVerb.get('object_validate')?.params, {});
  assert.deepEqual(byVerb.get('object_publish')?.params, {});

  // One enumerable parameter with a pre-selected value — the popover case.
  assert.deepEqual(byVerb.get('object_create_variant')?.params, { mode: { type: 'enum', required: false } });

  // Three open questions — the chat hand-off case; each one must be answered.
  assert.deepEqual(byVerb.get('agent_chat')?.params, {
    image: { type: 'string', required: true },
    replacement: { type: 'string', required: true },
    alt: { type: 'string', required: true },
  });
});

test('the manifest stays inside the §7 bounds for every object type and the widest role set', () => {
  const widest = ['owner', 'admin', 'publisher', 'editor'];
  for (const objectType of ['content_item', 'page', 'product', 'theme']) {
    const manifest = buildUiCapabilities(objectType, widest);
    assert.ok(manifest.actions.length <= 24, 'at most 24 actions');
    assert.ok(manifest.controls.length <= 32, 'at most 32 control kinds');
    assert.ok(JSON.stringify(manifest).length <= 4000, 'at most 4000 serialized characters');
  }
});
