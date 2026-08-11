/**
 * THE INVARIANT: no edit-mode code path may change any box-model property on
 * `<body>` or `<html>`.
 *
 * Wolf, 2026-08-11 — "The article must never move. Keep everything like it is
 * published." The retracted §1.3 slide wrote `padding-right: 376px` onto
 * `document.body` when the rail came up, which re-centred the article column
 * 188px left; because the rail plan is empty until something is revealed, it
 * fired on HOVER and reversed on hover-out. The page bounced under the
 * pointer. Two guards so it cannot come back:
 *
 * 1. a pure, exhaustive sweep of the mode ladder — no mode implies page
 *    movement, no rail overhangs the viewport, and the hysteresis holds;
 * 2. a source-level guard over the CSS and over ui.ts's text, because the
 *    repo has no DOM harness and the actual write was one line of CSS plus
 *    one `document.body.style.setProperty`.
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
  railLeftFor,
  railMayDisplaceContent,
  railWidthFor,
  selectRailLayoutMode,
  type RailLayoutMode,
  type RailMetrics,
  type RailSurfaceKind,
} from './rail-layout.js';

// ── 1. the ladder ───────────────────────────────────────────────────────────

const TOKENS = { railWidth: 344, railMinWidth: 260, railGap: 24, railPad: 8, sheetFloor: 900 } as const;

const at = (viewportWidth: number, columnRight: number): RailMetrics => ({
  viewportWidth,
  columnRight,
  ...TOKENS,
});

const RANK: Record<RailLayoutMode, number> = { sheet: 0, markers: 1, compact: 2, inset: 3 };
const MODES: RailLayoutMode[] = ['sheet', 'markers', 'compact', 'inset'];
const SURFACES: RailSurfaceKind[] = ['article', 'other'];

/** Viewports from a phone to a 4K half-screen, and columns from tiny to full-bleed. */
const SAMPLES: RailMetrics[] = [];
for (let viewport = 320; viewport <= 2560; viewport += 7) {
  for (const fraction of [0, 0.25, 0.5, 0.62, 0.75, 0.84, 0.9, 0.96, 1]) {
    SAMPLES.push(at(viewport, Math.round(viewport * fraction)));
  }
}

describe('the mode ladder never moves the page', () => {
  it('offers no surface, in any mode, the right to displace page content', () => {
    for (const surface of SURFACES) {
      assert.equal(railMayDisplaceContent(surface), false, `${surface} surfaces must never displace content`);
    }
  });

  it('never places a rail that overhangs the viewport or overlaps the column', () => {
    for (const metrics of SAMPLES) {
      const mode = selectRailLayoutMode(metrics);
      const width = railWidthFor(mode, metrics);
      const left = railLeftFor(mode, metrics);
      const where = `${mode} at ${metrics.viewportWidth}/${metrics.columnRight}`;
      if (mode === 'markers' || mode === 'sheet') {
        // No rail column at all — the gutter markers (and the sheet) serve.
        assert.equal(width, undefined, `${where}: markers/sheet have no rail width`);
        assert.equal(left, undefined, `${where}: markers/sheet have no rail position`);
        continue;
      }
      assert.ok(width !== undefined && left !== undefined, `${where}: a rail mode must produce a box`);
      assert.ok(width >= TOKENS.railMinWidth, `${where}: rail ${width} narrower than the 260px floor`);
      assert.ok(width <= TOKENS.railWidth, `${where}: rail ${width} wider than the full rail`);
      if (mode === 'inset') assert.equal(width, TOKENS.railWidth, `${where}: inset draws the full rail`);
      assert.ok(left >= TOKENS.railPad, `${where}: rail left ${left} inside the pad`);
      assert.ok(
        left + width <= metrics.viewportWidth - TOKENS.railPad,
        `${where}: rail right ${left + width} overhangs ${metrics.viewportWidth}`
      );
      // The rail lives in the margin — it never reaches back over the column,
      // which is the only other way "make room" could show up as movement.
      assert.ok(left >= metrics.columnRight, `${where}: rail left ${left} overlaps the column`);
    }
  });

  it('is idempotent: re-running the decision on an applied mode changes nothing', () => {
    for (const metrics of SAMPLES) {
      for (const previous of MODES) {
        const once = selectRailLayoutMode(metrics, previous);
        assert.equal(selectRailLayoutMode(metrics, once), once, `unstable at ${metrics.viewportWidth}/${previous}`);
      }
    }
  });

  it('never widens on a 1px step, so a resize cannot make the layout flap', () => {
    for (const metrics of SAMPLES) {
      const cold = selectRailLayoutMode(metrics);
      for (const delta of [-1, 1]) {
        const stepped = at(metrics.viewportWidth + delta, metrics.columnRight);
        const next = selectRailLayoutMode(stepped, cold);
        const where = `${metrics.viewportWidth}${delta > 0 ? '+' : '-'}1/${metrics.columnRight}`;
        assert.ok(RANK[next] <= RANK[cold], `${where}: widened from ${cold} to ${next} on one pixel`);
        // Never a third mode: the step lands on the mode it had or the cold
        // mode of where it now is.
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
    const growing = sweep(1300, 1600, 'compact');
    // Cold thresholds: inset needs 1080 + 344 + 24 + 8 = 1456.
    assert.equal(shrinking.get('compact'), 1455, 'compact must bite the moment the full rail stops fitting');
    assert.equal(growing.get('inset'), 1456 + RAIL_MODE_HYSTERESIS, 'inset must wait for the band');
    assert.equal(
      (growing.get('inset') as number) - (shrinking.get('compact') as number),
      RAIL_MODE_HYSTERESIS + 1,
      'the band between narrowing and widening is the hysteresis'
    );
  });
});

// ── 2. the source-level guard ───────────────────────────────────────────────

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

/** Anything here on `<body>`/`<html>` moves, resizes or re-origins the page. */
const BANNED_PROPERTY = /^(padding|margin|border|width|max-width|transform|zoom)(-|$)/;

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

describe('no edit-mode source may write a box-model property onto the page', () => {
  it('declares nothing box-model on an html/body/:root rule in STYLES', () => {
    for (const rule of cssRules(STYLES)) {
      for (const selector of rule.selector.split(',')) {
        if (!isPageBox(selector)) continue;
        for (const declaration of rule.declarations.split(';')) {
          const [rawProperty, ...rest] = declaration.split(':');
          const property = rawProperty.trim().toLowerCase();
          if (!property) continue;
          assert.ok(
            !BANNED_PROPERTY.test(property),
            `${selector.trim()} declares "${property}" — edit mode must not change the page box`
          );
          // A transition ON one of those properties is the animated form of
          // the same defect (the retracted slide had `transition:padding-right`).
          if (property === 'transition' || property === 'transition-property') {
            for (const token of rest.join(':').split(/[\s,]+/)) {
              assert.ok(
                !BANNED_PROPERTY.test(token.trim().toLowerCase()),
                `${selector.trim()} transitions "${token}" — edit mode must not animate the page box`
              );
            }
          }
        }
      }
    }
  });

  it('never writes an inline style onto document.body or documentElement', () => {
    const root = repoRoot();
    const sources = readdirSync(join(root, EDIT_MODE_DIR)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts')
    );
    assert.ok(sources.includes('ui.ts'), 'the edit-mode directory should hold ui.ts');
    for (const name of sources) {
      const text = readFileSync(join(root, EDIT_MODE_DIR, name), 'utf8');
      for (const target of [
        'document.body.style',
        'document.documentElement.style',
        'body.style.',
        'body.setAttribute(',
      ]) {
        assert.ok(!text.includes(target), `${name} writes ${target} — the page box is not edit mode's to change`);
      }
    }
  });

  it('touches document.body.classList only with the allow-listed class', () => {
    const allowed = new Set(['dl-em-on']);
    const text = readFileSync(join(repoRoot(), EDIT_MODE_DIR, 'ui.ts'), 'utf8');
    const uses = [...text.matchAll(/document\.body\.classList\.(\w+)\(\s*'([^']*)'/g)];
    assert.ok(uses.length > 0, 'ui.ts is expected to toggle the edit-mode class on body');
    for (const [, method, className] of uses) {
      assert.ok(
        allowed.has(className),
        `ui.ts calls classList.${method}('${className}') on body — only ${[...allowed].join(', ')} is allowed, ` +
          'because a body class is how the retracted page slide was applied'
      );
    }
    // …and no computed class name can sneak past the literal check above.
    assert.ok(
      !/document\.body\.classList\.\w+\(\s*[^'\s)]/.test(text),
      'ui.ts must only pass literal class names to document.body.classList'
    );
  });
});
