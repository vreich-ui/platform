import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  collapseThreadStack,
  isBlockAnchor,
  marginaliaAnchorKey,
  packRailEntries,
  partitionRailThreads,
  railLeftFor,
  railSlidePadding,
  selectRailLayoutMode,
  type RailMetrics,
} from './rail-layout.js';

/** The spec's tokens: 344px rail, 24px gap, 8px pad, 900px slide floor. */
const metrics = (overrides: Partial<RailMetrics>): RailMetrics => ({
  viewportWidth: 1440,
  columnRight: 1080,
  railWidth: 344,
  railGap: 24,
  railPad: 8,
  slideFloor: 900,
  ...overrides,
});

describe('selectRailLayoutMode', () => {
  it('insets when the natural margin already fits rail + gap + pad', () => {
    // 1440 - 1080 = 360 margin; needs 344 + 24 + 8 = 376 → not quite.
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1440, columnRight: 1080 })), 'slide');
    // A wider viewport with the same column: 1600 - 1080 = 520 ≥ 376.
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1600, columnRight: 1080 })), 'inset');
  });

  it('insets exactly at the boundary (margin === rail + gap + pad)', () => {
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1456, columnRight: 1080 })), 'inset');
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1455, columnRight: 1080 })), 'slide');
  });

  it('slides on a viewport at or above the slide floor that cannot inset', () => {
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 900, columnRight: 820 })), 'slide');
  });

  it('drops to the sheet below the slide floor, however narrow the column', () => {
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 899, columnRight: 300 })), 'sheet');
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 375, columnRight: 360 })), 'sheet');
  });
});

describe('railSlidePadding', () => {
  it('is rail + gap + pad while sliding and zero otherwise', () => {
    assert.strictEqual(railSlidePadding('slide', metrics({})), 376);
    assert.strictEqual(railSlidePadding('inset', metrics({})), 0);
    assert.strictEqual(railSlidePadding('sheet', metrics({})), 0);
  });
});

describe('railLeftFor', () => {
  it('derives the inset position from the content column, not the viewport', () => {
    assert.strictEqual(railLeftFor('inset', metrics({ viewportWidth: 1600, columnRight: 1080 })), 1104);
  });

  it('never lets an inset rail overhang the viewport pad', () => {
    // columnRight + gap would be 1500; the pinned-right limit is 1600-8-344.
    assert.strictEqual(railLeftFor('inset', metrics({ viewportWidth: 1600, columnRight: 1476 })), 1248);
  });

  it('pins to the viewport right edge while sliding', () => {
    assert.strictEqual(railLeftFor('slide', metrics({ viewportWidth: 1440 })), 1088);
  });

  it('has no position in sheet mode', () => {
    assert.strictEqual(railLeftFor('sheet', metrics({ viewportWidth: 600 })), undefined);
  });
});

describe('packRailEntries', () => {
  it('leaves non-colliding bubbles at their desired tops', () => {
    assert.deepStrictEqual(
      packRailEntries(
        [
          { desiredTop: 100, height: 80 },
          { desiredTop: 400, height: 80 },
        ],
        8
      ),
      [100, 400]
    );
  });

  it('pushes a colliding bubble to previousBottom + gap', () => {
    assert.deepStrictEqual(
      packRailEntries(
        [
          { desiredTop: 100, height: 120 },
          { desiredTop: 150, height: 60 },
          { desiredTop: 160, height: 40 },
        ],
        8
      ),
      [100, 228, 296]
    );
  });

  it('keeps the first entry at its desired top even when negative (scrolled past)', () => {
    assert.deepStrictEqual(packRailEntries([{ desiredTop: -200, height: 100 }], 8), [-200]);
  });

  it('returns nothing for no entries', () => {
    assert.deepStrictEqual(packRailEntries([], 8), []);
  });
});

describe('marginaliaAnchorKey / isBlockAnchor', () => {
  it('distinguishes a section anchor from a node anchor with the same id text', () => {
    assert.notStrictEqual(
      marginaliaAnchorKey({ objectType: 'page', objectId: 'p1', sectionId: 'x' }),
      marginaliaAnchorKey({ objectType: 'page', objectId: 'p1', nodeId: 'x' })
    );
  });

  it('cannot be forged by an id containing the separator characters', () => {
    assert.notStrictEqual(
      marginaliaAnchorKey({ objectType: 'page', objectId: 'p1\u0000s1' }),
      marginaliaAnchorKey({ objectType: 'page', objectId: 'p1', sectionId: 's1' })
    );
  });

  it('is stable for the same anchor', () => {
    assert.strictEqual(
      marginaliaAnchorKey({ objectType: 'content_item', objectId: 'req_a', nodeId: 'n1' }),
      marginaliaAnchorKey({ objectType: 'content_item', objectId: 'req_a', nodeId: 'n1' })
    );
  });

  it('reads a whole-object anchor as not block-anchored', () => {
    assert.strictEqual(isBlockAnchor({ objectType: 'page', objectId: 'p1' }), false);
    assert.strictEqual(isBlockAnchor({ objectType: 'page', objectId: 'p1', sectionId: 's1' }), true);
    assert.strictEqual(isBlockAnchor({ objectType: 'content_item', objectId: 'a', nodeId: 'n' }), true);
  });
});

describe('partitionRailThreads', () => {
  const entry = (key: string, blockAnchored: boolean, thread: string) => ({ key, blockAnchored, thread });

  it('groups block threads by anchor, in input order', () => {
    const result = partitionRailThreads(
      [entry('k1', true, 't1'), entry('k2', true, 't2'), entry('k1', true, 't3')],
      new Set(['k1', 'k2'])
    );
    assert.deepStrictEqual(
      [...result.blocks.entries()],
      [
        ['k1', ['t1', 't3']],
        ['k2', ['t2']],
      ]
    );
    assert.deepStrictEqual(result.wholeObject, []);
    assert.deepStrictEqual(result.orphans, []);
  });

  it('sends a whole-object thread to the rail-top group when no region owns its key', () => {
    const result = partitionRailThreads([entry('whole', false, 't1')], new Set(['k1']));
    assert.deepStrictEqual(result.wholeObject, ['t1']);
    assert.deepStrictEqual(result.orphans, []);
  });

  it('attaches a whole-object thread to its region when one IS present (navigation)', () => {
    const result = partitionRailThreads([entry('nav', false, 't1')], new Set(['nav']));
    assert.deepStrictEqual([...result.blocks.entries()], [['nav', ['t1']]]);
    assert.deepStrictEqual(result.wholeObject, []);
  });

  it('orphans a block thread whose block is gone — never drops it', () => {
    const result = partitionRailThreads([entry('gone', true, 't1')], new Set(['here']));
    assert.deepStrictEqual(result.orphans, ['t1']);
    assert.strictEqual(result.blocks.size, 0);
    assert.deepStrictEqual(result.wholeObject, []);
  });

  it('keeps every thread in exactly one bucket', () => {
    const result = partitionRailThreads(
      [entry('here', true, 'a'), entry('gone', true, 'b'), entry('whole', false, 'c')],
      new Set(['here'])
    );
    const total = [...result.blocks.values()].flat().length + result.wholeObject.length + result.orphans.length;
    assert.strictEqual(total, 3);
  });
});

describe('collapseThreadStack', () => {
  it('shows every thread up to the limit', () => {
    assert.deepStrictEqual(collapseThreadStack(['a', 'b', 'c'], 3), { visible: ['a', 'b', 'c'], hidden: 0 });
  });

  it('collapses to the newest plus a +N count beyond the limit', () => {
    assert.deepStrictEqual(collapseThreadStack(['a', 'b', 'c', 'd'], 3), { visible: ['d'], hidden: 3 });
  });

  it('handles an empty stack', () => {
    assert.deepStrictEqual(collapseThreadStack([], 3), { visible: [], hidden: 0 });
  });
});
