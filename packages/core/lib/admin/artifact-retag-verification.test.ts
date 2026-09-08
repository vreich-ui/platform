import { describe, it } from 'node:test';
import assert from 'node:assert';

import { verifyArtifactRetag } from './artifact-retag-verification.js';

describe('verifyArtifactRetag', () => {
  it('confirms a write the index reports back exactly', () => {
    const result = verifyArtifactRetag(['t9-acceptance'], { status: 'ok', tags: ['t9-acceptance'] });

    assert.strictEqual(result.verified, true);
    assert.deepStrictEqual(result.persistedTags, ['t9-acceptance']);
    assert.deepStrictEqual(result.missing, []);
    assert.deepStrictEqual(result.unexpected, []);
    assert.strictEqual(result.reason, undefined);
  });

  it('confirms a removal down to no tags at all', () => {
    const result = verifyArtifactRetag([], { status: 'ok', tags: undefined });

    assert.strictEqual(result.verified, true);
    assert.deepStrictEqual(result.persistedTags, []);
  });

  it('ignores tag casing and surrounding whitespace, the same rule the tag arithmetic uses', () => {
    const result = verifyArtifactRetag(['T9-Acceptance'], { status: 'ok', tags: [' t9-acceptance '] });

    assert.strictEqual(result.verified, true);
  });

  /**
   * The reported defect, at the layer that decides. The write resolved, the
   * handler answered 200 with the tags it had COMPUTED, and the index still
   * held the old body — so the page said "updated" about a tag that was not
   * findable a second later.
   */
  it('refuses to confirm when the index still reports the pre-write tags', () => {
    const result = verifyArtifactRetag(['t9-acceptance'], { status: 'ok', tags: [] });

    assert.strictEqual(result.verified, false);
    assert.deepStrictEqual(result.persistedTags, []);
    assert.deepStrictEqual(result.missing, ['t9-acceptance']);
    assert.match(result.reason ?? '', /NOT confirmed/);
    assert.match(result.reason ?? '', /expected t9-acceptance/);
  });

  it('reports a removal that did not take as unexpected, not as success', () => {
    const result = verifyArtifactRetag(['keep'], { status: 'ok', tags: ['keep', 'should-be-gone'] });

    assert.strictEqual(result.verified, false);
    assert.deepStrictEqual(result.unexpected, ['should-be-gone']);
    assert.deepStrictEqual(result.missing, []);
  });

  it('never reports the intended tags as persisted when the entry cannot be read back', () => {
    const result = verifyArtifactRetag(['t9-acceptance'], { status: 'absent' });

    assert.strictEqual(result.verified, false);
    // The whole point: an unreadable entry proves nothing, so it claims nothing.
    assert.deepStrictEqual(result.persistedTags, []);
    assert.deepStrictEqual(result.missing, ['t9-acceptance']);
    assert.match(result.reason ?? '', /could not be read back/);
  });

  it('carries the parse issue through when the entry is stored but unusable', () => {
    const result = verifyArtifactRetag(['t9-acceptance'], {
      status: 'rejected',
      issue: 'unexpected top-level keys: requestId',
    });

    assert.strictEqual(result.verified, false);
    assert.deepStrictEqual(result.persistedTags, []);
    assert.match(result.reason ?? '', /unexpected top-level keys: requestId/);
  });

  it('reports the store\'s own casing, not the request\'s', () => {
    const result = verifyArtifactRetag(['Featured'], { status: 'ok', tags: ['featured'] });

    assert.strictEqual(result.verified, true);
    assert.deepStrictEqual(result.persistedTags, ['featured']);
  });
});
