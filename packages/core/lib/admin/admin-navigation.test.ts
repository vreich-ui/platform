import assert from 'node:assert/strict';
import test from 'node:test';

import { settingsNavigationLabel, isNavVisible, visibleNavGroups } from './admin-navigation.js';

test('settings navigation labels are bound to the current publication', () => {
  assert.equal(settingsNavigationLabel('Dr. Lurié Skincare'), 'Settings · Dr. Lurié Skincare');
  assert.equal(settingsNavigationLabel('Kugel Platform'), 'Settings · Kugel Platform');
});

test('settings navigation has a safe generic fallback', () => {
  assert.equal(settingsNavigationLabel('  '), 'Settings');
  assert.equal(settingsNavigationLabel(undefined), 'Settings');
});

// ─── isNavVisible / visibleNavGroups (T4.3 nav fix) ────────────────────────

test('isNavVisible: an owner sees everything', () => {
  assert.equal(isNavVisible({}, true), true);
  assert.equal(isNavVisible({ ownerOnly: false }, true), true);
  assert.equal(isNavVisible({ ownerOnly: true }, true), true);
});

test('isNavVisible: a non-owner sees only what is not ownerOnly', () => {
  assert.equal(isNavVisible({}, false), true);
  assert.equal(isNavVisible({ ownerOnly: false }, false), true);
  assert.equal(isNavVisible({ ownerOnly: true }, false), false);
});

type Item = { href: string; ownerOnly?: boolean };
type Group = { label?: string; ownerOnly?: boolean; items: Item[] };

const FIXTURE: Group[] = [
  { items: [{ href: '/admin' }, { href: '/admin/traffic' }] },
  {
    label: 'Settings',
    items: [
      { href: '/admin/settings/visual-identity', ownerOnly: true },
      { href: '/admin/settings/admins' },
      { href: '/admin/profile', ownerOnly: true },
    ],
  },
  { label: 'Owner only group', ownerOnly: true, items: [{ href: '/admin/maintenance' }] },
];

test('visibleNavGroups: an owner sees every group and every item, unchanged', () => {
  const result = visibleNavGroups(FIXTURE, true);
  assert.deepEqual(result, FIXTURE);
});

test('visibleNavGroups: a non-owner sees a mixed group with only its non-ownerOnly items — this is the T4.3 fix, Admins reachable, Visual identity/Profile still hidden', () => {
  const result = visibleNavGroups(FIXTURE, false);
  const settings = result.find((g) => g.label === 'Settings');
  assert.ok(settings);
  assert.deepEqual(
    settings!.items.map((i) => i.href),
    ['/admin/settings/admins']
  );
});

test('visibleNavGroups: a group that is entirely ownerOnly disappears for a non-owner', () => {
  const result = visibleNavGroups(FIXTURE, false);
  assert.equal(
    result.some((g) => g.label === 'Owner only group'),
    false
  );
});

test('visibleNavGroups: an ungated group is untouched for a non-owner', () => {
  const result = visibleNavGroups(FIXTURE, false);
  const top = result.find((g) => g.label === undefined);
  assert.deepEqual(
    top!.items.map((i) => i.href),
    ['/admin', '/admin/traffic']
  );
});
