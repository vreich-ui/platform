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
  assert.equal(isNavVisible({}, true, false), true);
  assert.equal(isNavVisible({ ownerOnly: false }, true, false), true);
  assert.equal(isNavVisible({ ownerOnly: true }, true, false), true);
  assert.equal(isNavVisible({ adminOnly: true }, true, false), true);
});

test('isNavVisible: a non-owner sees only what is not ownerOnly', () => {
  assert.equal(isNavVisible({}, false, false), true);
  assert.equal(isNavVisible({ ownerOnly: false }, false, false), true);
  assert.equal(isNavVisible({ ownerOnly: true }, false, false), false);
});

// ─── isNavVisible / visibleNavGroups: adminOnly tier (T6) ──────────────────

test('isNavVisible: adminOnly is visible to admin, hidden from a non-admin non-owner', () => {
  assert.equal(isNavVisible({ adminOnly: true }, false, true), true);
  assert.equal(isNavVisible({ adminOnly: true }, false, false), false);
});

test('isNavVisible: ownerOnly still wins over adminOnly (an admin who is not owner cannot see an ownerOnly node)', () => {
  assert.equal(isNavVisible({ ownerOnly: true, adminOnly: true }, false, true), false);
});

type Item = { href: string; ownerOnly?: boolean; adminOnly?: boolean };
type Group = { label?: string; ownerOnly?: boolean; items: Item[] };

const FIXTURE: Group[] = [
  { items: [{ href: '/admin' }, { href: '/admin/traffic' }] },
  {
    label: 'Settings',
    items: [
      { href: '/admin/settings/visual-identity', ownerOnly: true },
      { href: '/admin/settings/admins' },
      { href: '/admin/profile', ownerOnly: true },
      { href: '/admin/inventory', adminOnly: true },
    ],
  },
  { label: 'Owner only group', ownerOnly: true, items: [{ href: '/admin/maintenance' }] },
];

test('visibleNavGroups: an owner sees every group and every item, unchanged', () => {
  const result = visibleNavGroups(FIXTURE, true, false);
  assert.deepEqual(result, FIXTURE);
});

test('visibleNavGroups: a non-owner sees a mixed group with only its non-ownerOnly items — this is the T4.3 fix, Admins reachable, Visual identity/Profile still hidden', () => {
  const result = visibleNavGroups(FIXTURE, false, false);
  const settings = result.find((g) => g.label === 'Settings');
  assert.ok(settings);
  assert.deepEqual(
    settings!.items.map((i) => i.href),
    ['/admin/settings/admins']
  );
});

test('visibleNavGroups: a group that is entirely ownerOnly disappears for a non-owner', () => {
  const result = visibleNavGroups(FIXTURE, false, false);
  assert.equal(
    result.some((g) => g.label === 'Owner only group'),
    false
  );
});

test('visibleNavGroups: an ungated group is untouched for a non-owner', () => {
  const result = visibleNavGroups(FIXTURE, false, false);
  const top = result.find((g) => g.label === undefined);
  assert.deepEqual(
    top!.items.map((i) => i.href),
    ['/admin', '/admin/traffic']
  );
});

// ─── visibleNavGroups: the Inventory nav item's owner+admin tier (T6) ──────

test('visibleNavGroups: an owner sees the adminOnly Inventory item', () => {
  const result = visibleNavGroups(FIXTURE, true, false);
  const settings = result.find((g) => g.label === 'Settings');
  assert.ok(settings!.items.some((i) => i.href === '/admin/inventory'));
});

test('visibleNavGroups: an admin (non-owner) sees the adminOnly Inventory item', () => {
  const result = visibleNavGroups(FIXTURE, false, true);
  const settings = result.find((g) => g.label === 'Settings');
  assert.ok(settings!.items.some((i) => i.href === '/admin/inventory'));
});

test('visibleNavGroups: an editor (neither owner nor admin) does not see the adminOnly Inventory item', () => {
  const result = visibleNavGroups(FIXTURE, false, false);
  const settings = result.find((g) => g.label === 'Settings');
  assert.equal(
    settings!.items.some((i) => i.href === '/admin/inventory'),
    false
  );
});
