import assert from 'node:assert/strict';
import test from 'node:test';

import { governedMediaCountLabel } from './media-counts.js';

test('publication map media count does not pretend that artifacts are objects', () => {
  assert.equal(governedMediaCountLabel(0), '0 governed media objects · assets in Media');
  assert.equal(governedMediaCountLabel(1), '1 governed media object · assets in Media');
});
