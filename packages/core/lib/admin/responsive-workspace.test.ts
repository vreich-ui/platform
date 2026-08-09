import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  ADMIN_COMPACT_NAV_CLASS,
  ADMIN_EXPANDED_NAV_BREAKPOINT,
  ADMIN_EXPANDED_NAV_CLASS,
  WORKSPACE_COMPACT_PANEL_CLASS,
  WORKSPACE_EXPANDED_BREAKPOINT,
  WORKSPACE_EXPANDED_GRID_CLASS,
  WORKSPACE_EXPANDED_MIN_WIDTH,
  WORKSPACE_EXPANDED_PANEL_CLASS,
} from './responsive-workspace.js';

describe('responsive admin workspace contract', () => {
  it('keeps the global navigation compact until the desktop breakpoint', () => {
    assert.strictEqual(ADMIN_EXPANDED_NAV_BREAKPOINT, 'xl');
    assert.strictEqual(ADMIN_EXPANDED_NAV_CLASS, 'xl:flex');
    assert.strictEqual(ADMIN_COMPACT_NAV_CLASS, 'xl:hidden');
  });

  it('shows supporting panels only at desktop widths', () => {
    assert.strictEqual(WORKSPACE_EXPANDED_BREAKPOINT, 'xl');
    assert.strictEqual(WORKSPACE_EXPANDED_MIN_WIDTH, 1280);
    assert.match(WORKSPACE_EXPANDED_GRID_CLASS, /^xl:grid-cols-/);
    assert.strictEqual(WORKSPACE_COMPACT_PANEL_CLASS, 'xl:hidden');
    assert.strictEqual(WORKSPACE_EXPANDED_PANEL_CLASS, 'hidden xl:block');
  });
});
