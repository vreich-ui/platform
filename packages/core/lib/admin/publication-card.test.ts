/**
 * 2026-08-31 — the run card's publish/release tail. Copy and link only; the
 * state itself is the server's (`publication-evidence.ts`).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { liveArticleUrl, policyRecordLine, publicationCopy } from './publication-card.js';

describe('liveArticleUrl', () => {
  it('joins the article path to the site origin', () => {
    assert.equal(
      liveArticleUrl('/retinol-vs-bakuchiol-sensitive-skin', 'https://drluriescience.netlify.app'),
      'https://drluriescience.netlify.app/retinol-vs-bakuchiol-sensitive-skin'
    );
    assert.equal(
      liveArticleUrl('retinol', 'https://drluriescience.netlify.app/'),
      'https://drluriescience.netlify.app/retinol'
    );
  });
  it('is the bare path with no origin, and nothing with no path', () => {
    assert.equal(liveArticleUrl('/x', undefined), '/x');
    assert.equal(liveArticleUrl(undefined, 'https://a.b'), undefined);
  });
});

describe('publicationCopy', () => {
  it('live: success, "Live", the deploy id and commit as facts, no recheck', () => {
    const copy = publicationCopy({
      state: 'live',
      article_path: '/retinol-vs-bakuchiol-sensitive-skin',
      deploy_id: '6a92f3c558169f0008f28e47',
      commit: '61f1b1827f38766b85beaa0bdd58ccdc82539f9c',
    });
    assert.equal(copy.severity, 'success');
    assert.equal(copy.title, 'Live');
    assert.equal(copy.detail, undefined);
    assert.deepEqual(copy.facts, ['deploy 6a92f3c558169f0008f28e47', 'commit 61f1b18']);
    assert.equal(copy.offerRecheck, false);
  });

  it('live without a path says so rather than rendering a dead link', () => {
    const copy = publicationCopy({ state: 'live' });
    assert.match(copy.detail ?? '', /live path was not in the publish receipt/);
  });

  it('pending: amber, "awaiting release confirmation", the release blocker verbatim, and a recheck', () => {
    const copy = publicationCopy({
      state: 'published_pending_release',
      article_path: '/retinol-vs-bakuchiol-sensitive-skin',
      commit: '61f1b1827f38766b85beaa0bdd58ccdc82539f9c',
      release_reason: 'release_not_confirmed',
      release_blockers: ['release_not_confirmed: MCP request failed with HTTP 504.'],
    });
    assert.equal(copy.severity, 'needs_you');
    assert.equal(copy.title, 'Published — awaiting release confirmation');
    assert.equal(copy.detail, 'release_not_confirmed: MCP request failed with HTTP 504.');
    assert.equal(copy.offerRecheck, true);
  });

  it('pending with only a reason code words it; with nothing, says what is known', () => {
    assert.match(
      publicationCopy({ state: 'published_pending_release', release_reason: 'deploy_not_confirmed_after_max_attempts' })
        .detail ?? '',
      /deploy not confirmed after max attempts/
    );
    assert.match(publicationCopy({ state: 'published_pending_release' }).detail ?? '', /not confirmed go-live yet/);
  });
});

describe('policyRecordLine', () => {
  it('reads "Proceeded autonomously — <step>", falling back to the node id', () => {
    assert.equal(
      policyRecordLine({ node_id: 'publish_executor' }, 'publishing'),
      'Proceeded autonomously — publishing'
    );
    assert.equal(
      policyRecordLine({ node_id: 'release_executor' }, undefined),
      'Proceeded autonomously — release_executor'
    );
  });
});
