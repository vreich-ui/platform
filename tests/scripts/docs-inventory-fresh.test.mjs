import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { renderInventory, ROOT } from '../../scripts/docs/inventory.mjs';

const INVENTORY_PATH = path.join(ROOT, 'docs', 'generated', 'INVENTORY.md');

// The header carries the only two lines that legitimately change between
// runs made at different times/commits: the git HEAD short sha and the
// generated-at timestamp. Every other line is a deterministic function of
// the working tree, so we strip exactly these two lines before comparing.
const stripVolatileHeaderLines = (text) =>
  text
    .split('\n')
    .filter((line) => !/^- Git HEAD:/.test(line) && !/^- Generated:/.test(line))
    .join('\n');

test('docs/generated/INVENTORY.md matches a fresh render of scripts/docs/inventory.mjs', () => {
  let committed;
  try {
    committed = readFileSync(INVENTORY_PATH, 'utf8');
  } catch (err) {
    assert.fail(
      `docs/generated/INVENTORY.md is missing or unreadable (${err.message}). Run: node scripts/docs/inventory.mjs --write`
    );
  }

  const fresh = renderInventory();

  const committedStable = stripVolatileHeaderLines(committed);
  const freshStable = stripVolatileHeaderLines(fresh);

  assert.equal(
    committedStable,
    freshStable,
    'docs/generated/INVENTORY.md is stale relative to the working tree (diff ignores the header sha/date lines). Run: node scripts/docs/inventory.mjs --write'
  );
});

test('renderInventory() is deterministic across repeated calls (ignoring header sha/date lines)', () => {
  const first = stripVolatileHeaderLines(renderInventory());
  const second = stripVolatileHeaderLines(renderInventory());
  assert.equal(
    first,
    second,
    'renderInventory() produced different output on two calls with no tree changes in between'
  );
});
