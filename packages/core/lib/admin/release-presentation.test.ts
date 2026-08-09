import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  groupReleaseReviewItems,
  isClearlyPublicOrReachable,
  isLikelyTestOrPlaceholder,
  releaseQueueSignature,
  releaseReviewSummary,
  shortDiagnosticCommit,
} from './release-presentation.js';

describe('release review presentation', () => {
  const items = [
    { object_id: 'page_home', object_type: 'page', display_name: 'Homepage' },
    { object_id: 'tpl_field_test', object_type: 'template', display_name: 'Field Test Template' },
    { object_id: 'section_newsletter', object_type: 'section', display_name: 'Newsletter signup' },
  ];

  it('flags likely test records conservatively without treating normal editorial words as test content', () => {
    assert.equal(isLikelyTestOrPlaceholder(items[1]!), true);
    assert.equal(
      isLikelyTestOrPlaceholder({ object_id: 'page_testimonial', object_type: 'page', display_name: 'Testimonials' }),
      false
    );
  });

  it('only treats route-bearing content types as clearly reader-facing', () => {
    assert.equal(isClearlyPublicOrReachable(items[0]!), true);
    assert.equal(isClearlyPublicOrReachable(items[2]!), false);
  });

  it('keeps flagged groups ahead of apparently ready records and summarizes the review', () => {
    const groups = groupReleaseReviewItems(items);

    assert.deepEqual(
      groups.map((group) => group.category),
      ['likely_test', 'reachability_unclear', 'ready']
    );
    assert.equal(groups[0]?.items[0]?.object_id, 'tpl_field_test');
    assert.match(releaseReviewSummary(groups), /2 changes need review/i);
  });

  it('shortens commit diagnostics and hides absent values', () => {
    assert.equal(shortDiagnosticCommit('1234567890abcdef'), '12345678');
    assert.equal(shortDiagnosticCommit(null), undefined);
  });

  it('changes the reviewed batch signature when the published queue changes', () => {
    assert.notEqual(releaseQueueSignature(items), releaseQueueSignature(items.slice(0, 2)));
    assert.equal(releaseQueueSignature(items), releaseQueueSignature([...items].reverse()));
  });
});
