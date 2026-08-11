import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  collapseThreadStack,
  isBlockAnchor,
  marginaliaAnchorKey,
  packRailEntries,
  partitionRailThreads,
  railDisplacementFor,
  railLeftFor,
  railMayDisplaceContent,
  railWidthFor,
  selectRailLayoutMode,
  type RailMetrics,
} from './rail-layout.js';

/** The spec's tokens: 344px rail (260px floor), 24px gap, 8px pad, 900px sheet floor. */
const metrics = (overrides: Partial<RailMetrics>): RailMetrics => ({
  viewportWidth: 1440,
  columnRight: 1080,
  surface: 'article',
  railWidth: 344,
  railMinWidth: 260,
  railGap: 24,
  railPad: 8,
  sheetFloor: 900,
  ...overrides,
});

describe('selectRailLayoutMode', () => {
  it('insets when the natural margin already fits rail + gap + pad', () => {
    // 1440 - 1080 = 360 margin; the full rail needs 344 + 24 + 8 = 376 → the
    // page has to move over to make room, and can afford to (1440 - 376 ≥ 900).
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1440, columnRight: 1080 })), 'slide');
    // A wider viewport with the same column: 1600 - 1080 = 520 ≥ 376.
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1600, columnRight: 1080 })), 'inset');
  });

  it('insets exactly at the boundary (margin === rail + gap + pad)', () => {
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1456, columnRight: 1080 })), 'inset');
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1455, columnRight: 1080 })), 'slide');
  });

  it('slides on both surfaces — Wolf kept the movement (2026-08-11)', () => {
    for (const surface of ['article', 'other'] as const) {
      assert.strictEqual(railMayDisplaceContent(surface), true, surface);
      assert.strictEqual(selectRailLayoutMode(metrics({ surface })), 'slide', surface);
    }
  });

  it('narrows the rail instead of the page when the page cannot spare the width', () => {
    // 1200 - 376 = 824 < the 900px sheet floor: displacing would leave a page
    // narrower than the surface supports, so the rail gives way instead.
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1200, columnRight: 880 })), 'compact');
    // margin 292 === 260 + 24 + 8 — the compact floor, exactly.
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1200, columnRight: 908 })), 'compact');
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1200, columnRight: 909 })), 'markers');
  });

  it('shows markers on a wide-enough-for-a-rail viewport with no margin to give', () => {
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 900, columnRight: 820 })), 'markers');
  });

  it('drops to the sheet below the sheet floor, however narrow the column', () => {
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 899, columnRight: 300 })), 'sheet');
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 375, columnRight: 360 })), 'sheet');
  });

  it('narrows at the threshold but widens only 24px past it', () => {
    const atBoundary = metrics({ viewportWidth: 1455, columnRight: 1080 }); // margin 375
    assert.strictEqual(selectRailLayoutMode(atBoundary, 'inset'), 'slide');
    // Coming back up: 376 is enough cold, but not while the slide is applied.
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1456, columnRight: 1080 }), 'slide'), 'slide');
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1479, columnRight: 1080 }), 'slide'), 'slide');
    assert.strictEqual(selectRailLayoutMode(metrics({ viewportWidth: 1480, columnRight: 1080 }), 'slide'), 'inset');
  });
});

describe('railDisplacementFor', () => {
  it('moves the page by exactly one rail + gap + pad, and only when sliding', () => {
    assert.strictEqual(railDisplacementFor('slide', metrics({})), 376);
    for (const mode of ['inset', 'compact', 'markers', 'sheet'] as const) {
      assert.strictEqual(railDisplacementFor(mode, metrics({})), 0, mode);
    }
  });

  it('depends on the tokens alone — not on the column the page happens to have', () => {
    assert.strictEqual(
      railDisplacementFor('slide', metrics({ columnRight: 300 })),
      railDisplacementFor('slide', metrics({ columnRight: 1400 }))
    );
  });
});

describe('railWidthFor', () => {
  it('gives the full rail when inset or slid, and the real margin when compact', () => {
    assert.strictEqual(railWidthFor('inset', metrics({})), 344);
    assert.strictEqual(railWidthFor('slide', metrics({})), 344);
    // margin 360 - gap 24 - pad 8 = 328.
    assert.strictEqual(railWidthFor('compact', metrics({})), 328);
  });

  it('never narrows past the floor and never exceeds the full rail', () => {
    assert.strictEqual(railWidthFor('compact', metrics({ viewportWidth: 1440, columnRight: 1180 })), 260);
    assert.strictEqual(railWidthFor('compact', metrics({ viewportWidth: 2000, columnRight: 1080 })), 344);
  });

  it('has no width where there is no rail column', () => {
    assert.strictEqual(railWidthFor('markers', metrics({})), undefined);
    assert.strictEqual(railWidthFor('sheet', metrics({})), undefined);
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

  it('sits a compact rail at right: railPad, its narrowed width against the column', () => {
    const compact = metrics({ viewportWidth: 1440, columnRight: 1080 });
    assert.strictEqual(railLeftFor('compact', compact), 1104);
    assert.strictEqual((railLeftFor('compact', compact) ?? 0) + (railWidthFor('compact', compact) ?? 0), 1432);
  });

  it('pins a slid rail to the strip the page vacated, not to the moved column', () => {
    // 1440 - 8 - 344: the same box whatever the column underneath does, so a
    // page that re-centres by half the shift cannot drag the rail with it.
    assert.strictEqual(railLeftFor('slide', metrics({ viewportWidth: 1440, columnRight: 1080 })), 1088);
    assert.strictEqual(railLeftFor('slide', metrics({ viewportWidth: 1440, columnRight: 400 })), 1088);
  });

  it('has no position in markers or sheet mode', () => {
    assert.strictEqual(railLeftFor('markers', metrics({ viewportWidth: 1000, columnRight: 990 })), undefined);
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
