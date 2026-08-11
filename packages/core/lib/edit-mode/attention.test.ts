import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  blockAttentionCounts,
  gutterMarkerState,
  markerAriaLabel,
  openThreadCount,
  pageAttentionTotal,
} from './attention.js';
import type { MarginaliaThreadStatus } from '../../schema/marginalia-v1.js';

const row = (key: string, status: MarginaliaThreadStatus) => ({ key, thread: { status } });

describe('openThreadCount', () => {
  it('counts open threads and nothing else', () => {
    assert.strictEqual(
      openThreadCount([{ status: 'open' }, { status: 'resolved' }, { status: 'dismissed' }, { status: 'open' }]),
      2
    );
  });
  it('is zero for an empty list', () => {
    assert.strictEqual(openThreadCount([]), 0);
  });
});

describe('blockAttentionCounts', () => {
  it('tallies open and resolved per anchor', () => {
    const counts = blockAttentionCounts([
      row('a', 'open'),
      row('a', 'open'),
      row('a', 'resolved'),
      row('b', 'dismissed'),
    ]);
    assert.deepStrictEqual(counts.get('a'), { open: 2, resolved: 1 });
    assert.deepStrictEqual(counts.get('b'), { open: 0, resolved: 1 });
  });

  it('folds dismissed in with resolved — the marker has no third state', () => {
    const counts = blockAttentionCounts([row('a', 'dismissed'), row('a', 'resolved')]);
    assert.deepStrictEqual(counts.get('a'), { open: 0, resolved: 2 });
  });

  it('has no entry for a block with no threads', () => {
    assert.strictEqual(blockAttentionCounts([row('a', 'open')]).get('b'), undefined);
  });
});

describe('pageAttentionTotal', () => {
  it('is the PDF definition: two blocks with one open thread each reads 2', () => {
    assert.strictEqual(pageAttentionTotal([row('a', 'open'), row('b', 'open'), row('c', 'resolved')]), 2);
  });

  it('includes whole-object and orphaned threads — they still want you', () => {
    assert.strictEqual(pageAttentionTotal([row('whole', 'open'), row('gone', 'open')]), 2);
  });

  it('drops to zero once everything is resolved', () => {
    assert.strictEqual(pageAttentionTotal([row('a', 'resolved'), row('b', 'dismissed')]), 0);
  });
});

describe('gutterMarkerState', () => {
  it('shows the numeral whenever anything is open, hovered or not', () => {
    assert.strictEqual(gutterMarkerState({ open: 1, resolved: 0, hovered: false }), 'count');
    assert.strictEqual(gutterMarkerState({ open: 3, resolved: 2, hovered: true }), 'count');
  });

  it('shows a resolved-only block nothing until it is hovered', () => {
    assert.strictEqual(gutterMarkerState({ open: 0, resolved: 2, hovered: false }), 'none');
    assert.strictEqual(gutterMarkerState({ open: 0, resolved: 2, hovered: true }), 'muted');
  });

  it('offers the accent dot on a hovered block with no threads at all', () => {
    assert.strictEqual(gutterMarkerState({ open: 0, resolved: 0, hovered: true }), 'accent');
    assert.strictEqual(gutterMarkerState({ open: 0, resolved: 0, hovered: false }), 'none');
  });
});

describe('markerAriaLabel', () => {
  it('speaks the count, so colour is never the only carrier', () => {
    assert.strictEqual(markerAriaLabel('count', 1, 'Article content'), '1 open comment on Article content');
    assert.strictEqual(markerAriaLabel('count', 2, 'hero'), '2 open comments on hero');
  });
  it('names the quiet states too', () => {
    assert.strictEqual(markerAriaLabel('muted', 0, 'hero'), 'No open comments on hero');
    assert.strictEqual(markerAriaLabel('accent', 0, 'hero'), 'Comment on hero');
  });
});
