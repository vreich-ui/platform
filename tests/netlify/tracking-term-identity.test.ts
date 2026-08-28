import assert from 'node:assert/strict';
import test from 'node:test';

import { termIdForSlug } from '../../packages/core/lib/tracking/term-identity.js';

test('term route identity comes from the stored taxonomy id, not the slug mint convention', () => {
  const taxonomy = {
    kinds: {
      category: {
        terms: [{ slug: 'renamed-skin', term_id: 't_stable_original' }],
      },
      tag: {
        terms: [{ slug: 'skin-barrier', term_id: 't_skinbarrier' }],
      },
    },
  };

  assert.equal(termIdForSlug(taxonomy, 'category', 'renamed-skin'), 't_stable_original');
  assert.equal(termIdForSlug(taxonomy, 'tag', 'skin-barrier'), 't_skinbarrier');
  assert.equal(termIdForSlug(taxonomy, 'tag', 'missing'), undefined);
});
