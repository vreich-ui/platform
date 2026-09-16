import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  groupReleaseReviewItems,
  releaseAsOfIsStale,
  releaseAsOfLabel,
  RELEASE_AS_OF_STALE_MS,
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

/**
 * M1 — the honesty label. The admin no longer computes deploy state on the page
 * path, so every surface that renders it has to say how old it is.
 */
describe('release snapshot age', () => {
  const AT = '2026-09-16T14:32:09.000Z';

  it('renders hours and minutes in the reader\'s zone, without seconds', () => {
    assert.equal(releaseAsOfLabel(AT, { locale: 'en-GB', timeZone: 'UTC' }), 'as of 14:32');
    assert.equal(releaseAsOfLabel(AT, { locale: 'en-GB', timeZone: 'Europe/Berlin' }), 'as of 16:32');
  });

  it('renders nothing rather than "Invalid Date" when the stamp is absent or unparseable', () => {
    // A function deploy older than M1 answers without `as_of`; the surfaces
    // must degrade to no label, never to a broken one.
    assert.equal(releaseAsOfLabel(undefined), undefined);
    assert.equal(releaseAsOfLabel(null), undefined);
    assert.equal(releaseAsOfLabel(''), undefined);
    assert.equal(releaseAsOfLabel('not a date'), undefined);
  });

  it('calls a snapshot stale only past the same bound the server rebuilds at', () => {
    const now = Date.parse(AT);
    assert.equal(releaseAsOfIsStale(AT, now + RELEASE_AS_OF_STALE_MS - 1), false);
    assert.equal(releaseAsOfIsStale(AT, now + RELEASE_AS_OF_STALE_MS + 1), true);
    // No stamp is not a stale stamp — it is an older server, and claiming
    // staleness there would put a warning on every surface during a rollout.
    assert.equal(releaseAsOfIsStale(undefined, now), false);
  });
});
