/**
 * W1 T1.2 — the layer scale is the ONLY stacking order.
 *
 * The defect this pins is not a bug that happened; it is the one that was
 * about to. A sticky header said `z-40` in one file and a search overlay said
 * `z-50` in another, with nothing relating them. The moment a reader-side
 * region gains a sticky or floating kind, the author's only way to place it is
 * to grep for numbers and pick a bigger one — which is how every z-index war
 * in every codebase starts.
 *
 * So: no raw z-index anywhere a reader-side component can reach. The values
 * come from `--dl-layer-*` (theme-tokens.ts), emitted by CustomStyles.astro
 * for every tenant, and NOT agent-writable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const abs = (relPath) => path.join(ROOT, relPath);

const TOKEN_FILE = 'packages/core/lib/registry/theme-tokens.ts';

const walk = (dir, exts) => {
  const out = [];
  const visit = (current) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        visit(full);
        continue;
      }
      if (exts.some((ext) => entry.endsWith(ext))) out.push(full);
    }
  };
  visit(dir);
  return out;
};

/**
 * A Tailwind stacking utility with a literal value: `z-40`, `z-[9999]`,
 * `-z-[1]`, or a raw `z-index:` declaration. `z-[var(--dl-layer-…)]` is the
 * sanctioned form and never matches, because the bracket contents are not a
 * number.
 */
const RAW_Z = /(^|[\s"'`:[])-?z-(?:\d+|\[-?\d+\w*\])|z-index\s*:/;

const offenders = (files) => {
  const found = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (rel === TOKEN_FILE) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (RAW_Z.test(line)) found.push(`${rel}:${index + 1}`);
      });
  }
  return found;
};

test('packages/core/components/sections/** carries no stacking order at all', () => {
  // Currently zero, and that is the interesting part: a SECTION never decides
  // its own layer — the page's regions do. Pinning zero keeps it that way.
  const files = walk(abs('packages/core/components/sections'), ['.astro', '.ts', '.tsx']);
  assert.ok(files.length > 20, 'expected the section components to be present');
  assert.deepEqual(offenders(files), []);
});

/**
 * Every READER-SIDE root. `packages/core/lib/tracking` is here because the
 * consent banner is markup a reader sees, built outside `app/` — the first
 * pass of this lint missed it and a raw `z-50` survived into the built page,
 * which is how the sticky_bottom region turned out to be occupied already.
 *
 * Deliberately NOT here: `packages/core/admin/**` and `packages/core/lib/
 * edit-mode/**`. Both are AUTHORING chrome with their own scales (`--adm-*`,
 * and edit-mode's 99988+ band) that sit above the reader's page entirely;
 * folding them into this scale would be a change to a different subsystem
 * with none of this one's benefit.
 */
const READER_SIDE_ROOTS = ['packages/core/app', 'packages/core/components', 'packages/core/lib/tracking'];

test('every reader-side surface uses the layer tokens, never a raw z-index', () => {
  const files = READER_SIDE_ROOTS.flatMap((root) => walk(abs(root), ['.astro', '.ts', '.tsx', '.css']));
  assert.ok(files.length > 30, 'expected the reader-side sources to be present');
  assert.deepEqual(
    offenders(files),
    [],
    'use z-[var(--dl-layer-…)] — the scale is in theme-tokens.ts (behind/base/raised/sticky/overlay/modal/toast)'
  );
});

test('the scale is declared once and emitted for every tenant', () => {
  const tokens = readFileSync(abs(TOKEN_FILE), 'utf8');
  const names = [...tokens.matchAll(/'(--dl-layer-[a-z]+)':/g)].map((match) => match[1]);
  assert.deepEqual(names, [
    '--dl-layer-behind',
    '--dl-layer-base',
    '--dl-layer-raised',
    '--dl-layer-sticky',
    '--dl-layer-overlay',
    '--dl-layer-modal',
    '--dl-layer-toast',
  ]);

  const custom = readFileSync(abs('packages/core/app/components/CustomStyles.astro'), 'utf8');
  assert.match(custom, /layerTokenCss/, 'CustomStyles.astro must emit the scale');
  // Unconditional: unlike the axis vars, there is no "only when set" branch.
  assert.match(custom, /const layerCss = layerTokenCss\(\);/);
});

test('the layer scale is NOT a brand token — nothing an agent writes can reorder the page', () => {
  const tokens = readFileSync(abs(TOKEN_FILE), 'utf8');
  // The axis tables are the agent-writable surface; a layer var appearing in
  // one would make stacking order a design choice a tenant could invert.
  const axesBlock = tokens.slice(tokens.indexOf('export const THEME_AXES'));
  assert.ok(!axesBlock.includes('--dl-layer-'), 'a layer var leaked into THEME_AXES');

  const themeSchema = readFileSync(abs('packages/core/schema/bodies/theme-v1.ts'), 'utf8');
  assert.ok(!themeSchema.includes('layer'), 'the theme schema must not carry a layer key');
});

test('no native CSS cascade layers were introduced (W1 brief: the token scale is the mechanism)', () => {
  // tailwind.css legitimately uses Tailwind's @layer AT-RULE (base /
  // components / utilities). Anything else named @layer would be the native
  // cascade-layer feature, which this wave deliberately does not adopt.
  const files = walk(abs('packages/core'), ['.css']);
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/@layer\s+([a-zA-Z-]+)/g)) {
      assert.ok(
        ['base', 'components', 'utilities'].includes(match[1]),
        `${path.relative(ROOT, file)}: unexpected @layer ${match[1]}`
      );
    }
  }
});
