import assert from 'node:assert/strict';
import test from 'node:test';

import { settingsNavigationLabel } from './admin-navigation.js';

test('settings navigation labels are bound to the current publication', () => {
  assert.equal(settingsNavigationLabel('Dr. Lurié Skincare'), 'Settings · Dr. Lurié Skincare');
  assert.equal(settingsNavigationLabel('Kugel Platform'), 'Settings · Kugel Platform');
});

test('settings navigation has a safe generic fallback', () => {
  assert.equal(settingsNavigationLabel('  '), 'Settings');
  assert.equal(settingsNavigationLabel(undefined), 'Settings');
});
