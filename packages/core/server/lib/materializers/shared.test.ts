import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderExport } from './shared.js';

// W6 Q — the annotation layer never reaches git. The export is committed to the
// repository, and `private` (strategy / intent / agentNotes) is the persuasion
// architecture of an article. The strip is a SECURITY seam, not a formatting
// choice, and it is the reason `node_strategy` labels are pushed to the tracking
// sink from the store at publish (`tracking-dims-publish.ts`, KI-08) rather than
// read back out of these files. Anyone tempted to exempt `private` here to "fix"
// the dimensions is about to reintroduce the thing this asserts against.

const META = { at: '2026-09-08T00:00:00.000Z', record_version: 3, exportRoot: 'sites/drlurie/data/site' };

const keysAtEveryDepth = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const entry of value) keysAtEveryDepth(entry, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      found.push(key);
      keysAtEveryDepth(nested, found);
    }
  }
  return found;
};

describe('renderExport', () => {
  it('drops `private` at every depth, including the strategy labels', () => {
    const body = {
      slug: 'how-retinoids-work',
      private: { agentNotes: 'top-level annotation' },
      nodes: [
        { id: 'n1', kind: 'hook', private: { strategy: 'curiosity_gap', intent: 'stop_the_scroll' } },
        { id: 'n2', kind: 'body', blocks: [{ private: { strategy: 'nested_deeper' } }] },
      ],
    };
    const exported = renderExport('content_item', 'art_1', body, META);
    const keys = keysAtEveryDepth(JSON.parse(exported));
    assert.ok(!keys.includes('private'), 'no `private` key survives');
    assert.ok(!keys.includes('strategy'), 'no `strategy` key survives');
    assert.ok(!keys.includes('intent'), 'no `intent` key survives');
    assert.ok(!exported.includes('curiosity_gap'));
    assert.ok(!exported.includes('nested_deeper'));
  });

  it('keeps everything that is not private', () => {
    const exported = JSON.parse(
      renderExport('content_item', 'art_1', { slug: 's', nodes: [{ id: 'n1', kind: 'hook', private: { strategy: 'x' } }] }, META)
    ) as { slug: string; nodes: Array<Record<string, unknown>>; __generated: Record<string, unknown> };
    assert.equal(exported.slug, 's');
    assert.deepEqual(exported.nodes, [{ id: 'n1', kind: 'hook' }]);
    assert.equal(exported.__generated.record_version, 3);
  });
});
