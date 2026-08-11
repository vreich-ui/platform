/**
 * THE INVARIANT: every visible surface — page content, edit-mode overlays and
 * fixed chrome — is positioned against the same displacement value at all
 * times. The displacement changes only on activation and resize, never on
 * hover, focus, pin or save.
 *
 * This file replaces `no-page-movement.test.ts`, which pinned the stronger
 * invariant "nothing moves". Wolf revised the requirement on 2026-08-11:
 *
 *   "i think that text move the way it is done in canvas is not bad. my only
 *    concern is left side placed objects. so they can't all move the same way
 *    but they can move."   → "Keep it, fix the registration."
 *
 * What must not come back is the ORIGINAL defect: the displacement was decided
 * from the rail plan, the rail plan only fills when something is revealed, so
 * the page moved 188px under the pointer on hover and back on hover-out. That
 * is a property of WHEN the value is decided, not of the movement, and it is
 * what the guards below pin.
 *
 * Spec: docs/design/marginalia-interaction-model.md §§1.2, 1.3.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { STYLES } from './ui-chrome.js';
import {
  RAIL_MODE_HYSTERESIS,
  railDisplacementFor,
  railLeftFor,
  railMayDisplaceContent,
  railWidthFor,
  selectRailLayoutMode,
  type RailLayoutMode,
  type RailMetrics,
  type RailSurfaceKind,
} from './rail-layout.js';

// ── 1. the displacement is a function of the page, never of the pointer ─────

const TOKENS = { railWidth: 344, railMinWidth: 260, railGap: 24, railPad: 8, sheetFloor: 900 } as const;
/** What a slide costs the page: rail + gap + pad. */
const SHIFT = TOKENS.railWidth + TOKENS.railGap + TOKENS.railPad;

const at = (viewportWidth: number, columnRight: number, surface: RailSurfaceKind = 'article'): RailMetrics => ({
  viewportWidth,
  columnRight,
  surface,
  ...TOKENS,
});

const RANK: Record<RailLayoutMode, number> = { sheet: 0, markers: 1, compact: 2, slide: 3, inset: 4 };
const MODES: RailLayoutMode[] = ['sheet', 'markers', 'compact', 'slide', 'inset'];
const SURFACES: RailSurfaceKind[] = ['article', 'other'];

/** Viewports from a phone to a 4K half-screen, columns from tiny to full-bleed. */
const SAMPLES: RailMetrics[] = [];
for (let viewport = 320; viewport <= 2560; viewport += 7) {
  for (const fraction of [0, 0.25, 0.5, 0.62, 0.75, 0.84, 0.9, 0.96, 1]) {
    for (const surface of SURFACES) {
      SAMPLES.push(at(viewport, Math.round(viewport * fraction), surface));
    }
  }
}

/** The whole decision, end to end: metrics → mode → px of page displacement. */
const displacementAt = (metrics: RailMetrics, previous?: RailLayoutMode): number =>
  railDisplacementFor(selectRailLayoutMode(metrics, previous), metrics);

describe('the page displacement is decided by geometry alone', () => {
  it('is one value or none — never a size derived from the plan, the column or the pointer', () => {
    for (const metrics of SAMPLES) {
      const mode = selectRailLayoutMode(metrics);
      const shift = railDisplacementFor(mode, metrics);
      const where = `${mode} at ${metrics.viewportWidth}/${metrics.columnRight}/${metrics.surface}`;
      assert.ok(shift === 0 || shift === SHIFT, `${where}: displaced by ${shift}, not 0 or ${SHIFT}`);
      assert.equal(shift > 0, mode === 'slide', `${where}: only slide may displace`);
    }
  });

  it('displaces only where the gate allows it, and the gate reads the surface alone', () => {
    for (const surface of SURFACES) {
      assert.equal(railMayDisplaceContent(surface), true, `${surface} may displace (Wolf, 2026-08-11)`);
      assert.equal(railMayDisplaceContent(surface), railMayDisplaceContent(surface), 'the gate must be pure');
    }
    // …and turning the gate off for a surface removes every slide on it: the
    // seam is real, not decorative. Proven by the ladder's own arithmetic —
    // below the sheet floor no viewport can afford a slide at all.
    for (const metrics of SAMPLES.filter((sample) => sample.viewportWidth < TOKENS.sheetFloor + SHIFT)) {
      assert.notEqual(selectRailLayoutMode(metrics), 'slide', `${metrics.viewportWidth} cannot afford a slide`);
    }
  });

  it('never leaves the page narrower than the sheet floor', () => {
    for (const metrics of SAMPLES) {
      const shift = displacementAt(metrics);
      if (shift === 0) continue;
      assert.ok(
        metrics.viewportWidth - shift >= TOKENS.sheetFloor,
        `${metrics.viewportWidth}: a ${shift}px displacement leaves ${metrics.viewportWidth - shift}px of page`
      );
    }
  });

  it('is idempotent: re-deciding on an applied mode moves the page no further', () => {
    for (const metrics of SAMPLES) {
      for (const previous of MODES) {
        const once = selectRailLayoutMode(metrics, previous);
        assert.equal(selectRailLayoutMode(metrics, once), once, `unstable at ${metrics.viewportWidth}/${previous}`);
        assert.equal(displacementAt(metrics, once), railDisplacementFor(once, metrics), 'displacement must settle');
      }
    }
  });

  it('never widens on a 1px step, so a resize cannot make the page flap', () => {
    for (const metrics of SAMPLES) {
      const cold = selectRailLayoutMode(metrics);
      for (const delta of [-1, 1]) {
        const stepped = at(metrics.viewportWidth + delta, metrics.columnRight, metrics.surface);
        const next = selectRailLayoutMode(stepped, cold);
        const where = `${metrics.viewportWidth}${delta > 0 ? '+' : '-'}1/${metrics.columnRight}`;
        assert.ok(RANK[next] <= RANK[cold], `${where}: widened from ${cold} to ${next} on one pixel`);
        assert.ok(
          next === cold || next === selectRailLayoutMode(stepped),
          `${where}: ${next} is neither the applied mode nor the cold one`
        );
      }
    }
  });

  it('leaves a 24px band between entering a narrower mode and returning', () => {
    // A fixed 1080px column, sweeping the viewport 1px at a time in each
    // direction: the width at which a mode is entered going down and the one
    // at which it is left going up differ by exactly the hysteresis.
    const columnRight = 1080;
    const sweep = (from: number, to: number, start: RailLayoutMode): Map<RailLayoutMode, number> => {
      const step = from < to ? 1 : -1;
      const firstSeenAt = new Map<RailLayoutMode, number>();
      let mode = start;
      for (let viewport = from; step > 0 ? viewport <= to : viewport >= to; viewport += step) {
        const next = selectRailLayoutMode(at(viewport, columnRight), mode);
        if (next !== mode || viewport === from) firstSeenAt.set(next, viewport);
        mode = next;
      }
      return firstSeenAt;
    };
    const shrinking = sweep(1600, 1300, 'inset');
    const growing = sweep(1300, 1600, 'slide');
    // Cold thresholds: inset needs 1080 + 344 + 24 + 8 = 1456.
    assert.equal(shrinking.get('slide'), 1455, 'the page must move the moment the natural margin stops fitting');
    assert.equal(growing.get('inset'), 1456 + RAIL_MODE_HYSTERESIS, 'it must wait for the band to move back');
    assert.equal(
      (growing.get('inset') as number) - (shrinking.get('slide') as number),
      RAIL_MODE_HYSTERESIS + 1,
      'the band between narrowing and widening is the hysteresis'
    );
  });

  it('would oscillate if decided from the DISPLACED column — the reason ui.ts measures naturally', () => {
    // A centred column re-centres in what the displacement leaves, i.e. its
    // right edge moves left by half the shift and the margin grows by half.
    // Feed THAT back into the ladder and the mode flips to inset, which
    // removes the displacement, which flips it back. `measureNaturalColumnRight`
    // exists to break this loop; this case proves the loop is real, so nobody
    // deletes the lift-and-restore as dead weight.
    const natural = at(1600, 1280);
    assert.equal(selectRailLayoutMode(natural), 'slide', 'margin 320 < 376 → slide');
    const displaced = at(natural.viewportWidth, natural.columnRight - SHIFT / 2);
    assert.equal(selectRailLayoutMode(displaced), 'inset', 'the slid page reads as inset');
    assert.equal(railDisplacementFor(selectRailLayoutMode(displaced), displaced), 0, 'and would undo itself');
  });
});

describe('the rail lands in the strip the page gave up', () => {
  it('places every rail box inside the viewport and clear of the column', () => {
    for (const metrics of SAMPLES) {
      const mode = selectRailLayoutMode(metrics);
      const width = railWidthFor(mode, metrics);
      const left = railLeftFor(mode, metrics);
      const where = `${mode} at ${metrics.viewportWidth}/${metrics.columnRight}`;
      if (mode === 'markers' || mode === 'sheet') {
        assert.equal(width, undefined, `${where}: markers/sheet have no rail width`);
        assert.equal(left, undefined, `${where}: markers/sheet have no rail position`);
        continue;
      }
      assert.ok(width !== undefined && left !== undefined, `${where}: a rail mode must produce a box`);
      assert.ok(width >= TOKENS.railMinWidth, `${where}: rail ${width} narrower than the 260px floor`);
      assert.ok(width <= TOKENS.railWidth, `${where}: rail ${width} wider than the full rail`);
      if (mode !== 'compact') assert.equal(width, TOKENS.railWidth, `${where}: ${mode} draws the full rail`);
      assert.ok(left >= TOKENS.railPad, `${where}: rail left ${left} inside the pad`);
      assert.ok(
        left + width <= metrics.viewportWidth - TOKENS.railPad,
        `${where}: rail right ${left + width} overhangs ${metrics.viewportWidth}`
      );
      if (mode === 'slide') {
        // The registration statement for the rail itself: the page's new
        // right edge, plus exactly one gap, IS the rail's left edge.
        assert.equal(
          left,
          metrics.viewportWidth - SHIFT + TOKENS.railGap,
          `${where}: the rail is not one gap right of the displaced page edge`
        );
      } else {
        assert.ok(left >= metrics.columnRight, `${where}: rail left ${left} overlaps the column`);
      }
    }
  });
});

// ── 2. the source-level guard: one writer, one value ────────────────────────

/** The compiled test runs from a temp dir; ascend to the repo root. */
const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'sites', 'drlurie', 'config', 'site-identity.ts'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate the repo root');
};

const EDIT_MODE_DIR = join('packages', 'core', 'lib', 'edit-mode');
const readEditModeSource = (name: string): string => readFileSync(join(repoRoot(), EDIT_MODE_DIR, name), 'utf8');

/** Anything here on `<body>`/`<html>` moves, resizes or re-origins the page. */
const BANNED_PROPERTY = /^(padding|margin|border|width|max-width|transform|zoom)(-|$)/;
/** …except the one displacement, which is the whole point and is one value. */
const DISPLACEMENT_PROPERTY = 'padding-right';
const DISPLACEMENT_VALUE = /var\(\s*--dlem-shift/;

type CssRule = { selector: string; declarations: string };

/** Flatten the style sheet, descending through at-rules (@media, @keyframes). */
const cssRules = (css: string): CssRule[] => {
  const rules: CssRule[] = [];
  const walk = (source: string): void => {
    let prelude = '';
    let index = 0;
    while (index < source.length) {
      const character = source[index];
      if (character !== '{') {
        prelude += character;
        index += 1;
        continue;
      }
      let depth = 1;
      let end = index + 1;
      while (end < source.length && depth > 0) {
        if (source[end] === '{') depth += 1;
        else if (source[end] === '}') depth -= 1;
        end += 1;
      }
      const body = source.slice(index + 1, end - 1);
      const head = prelude.trim();
      if (head.startsWith('@')) walk(body);
      else rules.push({ selector: head, declarations: body });
      prelude = '';
      index = end;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  return rules;
};

/** The element a selector actually styles: its last compound. */
const subjectOf = (selector: string): string =>
  selector
    .trim()
    .split(/[\s>+~]+/)
    .pop() ?? '';

const isPageBox = (selector: string): boolean => /^(html|body|:root)\b/.test(subjectOf(selector));

const declarationsOf = (rule: CssRule): Array<[string, string]> =>
  rule.declarations
    .split(';')
    .map((declaration): [string, string] => {
      const [property, ...rest] = declaration.split(':');
      return [property.trim().toLowerCase(), rest.join(':').trim()];
    })
    .filter(([property]) => property.length > 0);

describe('the page box is written in exactly one way', () => {
  it('changes nothing on html/body/:root except the one displacement variable', () => {
    for (const rule of cssRules(STYLES)) {
      for (const selector of rule.selector.split(',')) {
        if (!isPageBox(selector)) continue;
        for (const [property, value] of declarationsOf(rule)) {
          if (property === DISPLACEMENT_PROPERTY) {
            assert.match(
              value,
              DISPLACEMENT_VALUE,
              `${selector.trim()} sets ${property}: ${value} — the page may move only by --dlem-shift`
            );
            continue;
          }
          assert.ok(
            !BANNED_PROPERTY.test(property),
            `${selector.trim()} declares "${property}" — the only page-box write allowed is the displacement`
          );
          // A transition may animate the displacement and nothing else.
          if (property === 'transition' || property === 'transition-property') {
            for (const token of value.split(/[\s,]+/)) {
              const animated = token.trim().toLowerCase();
              if (animated === DISPLACEMENT_PROPERTY) continue;
              assert.ok(
                !BANNED_PROPERTY.test(animated),
                `${selector.trim()} transitions "${animated}" — only the displacement may animate`
              );
            }
          }
        }
      }
    }
  });

  it('gives the displacement variable a 0px default, so a visitor never moves', () => {
    const root = cssRules(STYLES).filter((rule) => rule.selector.trim() === ':root');
    const declared = root.flatMap(declarationsOf).filter(([property]) => property === '--dlem-shift');
    assert.equal(declared.length, 1, ':root must declare --dlem-shift exactly once');
    assert.equal(declared[0][1], '0px', 'the displacement defaults to zero');
  });

  it('writes the displacement from exactly one place in the whole package', () => {
    const sources = readdirSync(join(repoRoot(), EDIT_MODE_DIR)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts')
    );
    assert.ok(sources.includes('ui.ts'), 'the edit-mode directory should hold ui.ts');
    let writers = 0;
    for (const name of sources) {
      if (name === 'ui-chrome.ts') continue; // the style sheet, guarded above
      const text = readEditModeSource(name);
      const writes = [...text.matchAll(/setProperty\(\s*'--dlem-shift'/g)];
      writers += writes.length;
      for (const target of ['document.body.style.padding', 'document.documentElement.style.padding', 'body.style.']) {
        assert.ok(
          !text.includes(target),
          `${name} writes ${target} — the page box moves by --dlem-shift or not at all`
        );
      }
    }
    assert.equal(writers, 1, 'exactly one function may write --dlem-shift');
  });

  it('touches document.body.classList only with the allow-listed classes', () => {
    // `dl-em-on` gates the displacement rule; `dl-em-measuring` suppresses its
    // transition for the one reflow the natural measurement needs. Any third
    // class is a second, unaudited way to move the page.
    const allowed = new Set(['dl-em-on', 'dl-em-measuring']);
    const text = readEditModeSource('ui.ts');
    const uses = [...text.matchAll(/document\.body\.classList\.(\w+)\(\s*'([^']*)'/g)];
    assert.ok(uses.length > 0, 'ui.ts is expected to toggle the edit-mode class on body');
    for (const [, method, className] of uses) {
      assert.ok(
        allowed.has(className),
        `ui.ts calls classList.${method}('${className}') on body — only ${[...allowed].join(', ')} are allowed`
      );
    }
    assert.ok(
      !/document\.body\.classList\.\w+\(\s*[^'\s)]/.test(text),
      'ui.ts must only pass literal class names to document.body.classList'
    );
  });

  it('never rebuilds an editable region to edit it — the block must survive its own edit', () => {
    // Double-click used to replace the region's children with the editing
    // host, which deleted the article node's <h2>/eyebrow/<ul>/<figure>/CTA —
    // or, on a section, the `<section class="dl-section">` itself with its
    // padding, its 72rem centring and the 720px reading column. Everything
    // below it reflowed. The surface now replaces only the element(s) that
    // render the edited field.
    assert.ok(
      !/\bregion\.replaceChildren\s*\(/.test(readEditModeSource('ui.ts')),
      "ui.ts replaces an edit region's children — entering an edit must not rebuild the block"
    );
  });
});
