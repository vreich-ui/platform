import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFocus, selectionKey, withFocus } from './object-selection.js';

test('parseFocus reads a paired type:id out of a query string, with or without the leading ?', () => {
  assert.deepEqual(parseFocus('?focus=content_item:req_evergreen_retinol_20260901_01'), {
    object_type: 'content_item',
    object_id: 'req_evergreen_retinol_20260901_01',
  });
  assert.deepEqual(parseFocus('focus=page:home'), { object_type: 'page', object_id: 'home' });
});

test('parseFocus keeps other parameters out of it and survives their presence', () => {
  assert.deepEqual(parseFocus('?status=open&focus=media:img_42&page=2'), { object_type: 'media', object_id: 'img_42' });
});

test('an unpaired, empty or absent focus is NO selection — Constraint 7 sends the pair or nothing', () => {
  for (const search of ['', '?', '?focus=', '?focus=content_item', '?focus=:home', '?focus=page:', '?other=1']) {
    assert.equal(parseFocus(search), undefined, `expected no selection from ${JSON.stringify(search)}`);
  }
  assert.equal(parseFocus(undefined), undefined);
  assert.equal(parseFocus(null), undefined);
});

test('a pair over the wire bounds is no selection, not a malformed one (128 / 256, cms-agent-client checkConverseBounds)', () => {
  assert.equal(parseFocus(`?focus=${'t'.repeat(129)}:ok`), undefined);
  assert.equal(parseFocus(`?focus=page:${'i'.repeat(257)}`), undefined);
  assert.deepEqual(parseFocus(`?focus=${'t'.repeat(128)}:${'i'.repeat(256)}`), {
    object_type: 't'.repeat(128),
    object_id: 'i'.repeat(256),
  });
});

test('an id containing a colon splits on the FIRST one', () => {
  assert.deepEqual(parseFocus('?focus=theme:brand:dark'), { object_type: 'theme', object_id: 'brand:dark' });
});

test('selectionKey is stable, and empty for nothing selected', () => {
  assert.equal(selectionKey({ object_type: 'page', object_id: 'home' }), 'page:home');
  assert.equal(selectionKey(undefined), '');
  assert.equal(selectionKey(null), '');
});

test('withFocus sets, replaces and clears the selection while every other parameter survives', () => {
  const base = '/admin/requests?status=open&page=2';
  const set = withFocus(base, { object_type: 'content_item', object_id: 'req_a_b_20260101_01' });
  assert.equal(parseFocus(new URL(set, 'https://x.invalid').search)?.object_id, 'req_a_b_20260101_01');
  const params = new URL(set, 'https://x.invalid').searchParams;
  assert.equal(params.get('status'), 'open');
  assert.equal(params.get('page'), '2');

  const replaced = withFocus(set, { object_type: 'page', object_id: 'home' });
  assert.deepEqual(parseFocus(new URL(replaced, 'https://x.invalid').search), { object_type: 'page', object_id: 'home' });

  const cleared = withFocus(replaced, undefined);
  assert.equal(parseFocus(new URL(cleared, 'https://x.invalid').search), undefined);
  assert.equal(new URL(cleared, 'https://x.invalid').searchParams.get('status'), 'open');
});

test('withFocus returns the shape it was given — relative stays relative, absolute stays absolute — and keeps the hash', () => {
  assert.equal(withFocus('/admin/objects#row-3', { object_type: 'page', object_id: 'home' }), '/admin/objects?focus=page%3Ahome#row-3');
  assert.equal(
    withFocus('https://example.invalid/admin/objects', { object_type: 'page', object_id: 'home' }),
    'https://example.invalid/admin/objects?focus=page%3Ahome'
  );
});

test('a round trip through withFocus survives ids with URL-significant characters', () => {
  const selection = { object_type: 'media', object_id: 'img/42?v=1&x=2' };
  const address = withFocus('/admin/media', selection);
  assert.deepEqual(parseFocus(new URL(address, 'https://x.invalid').search), selection);
});
