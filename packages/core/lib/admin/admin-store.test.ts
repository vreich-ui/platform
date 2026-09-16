import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  getAdminStoreEntry,
  invalidateAdminStoreEntry,
  isAdminStoreEntryStale,
  recordAdminStoreEntry,
  resetAdminStoreForTests,
  type AdminStoreEntry,
} from './admin-store.js';

describe('admin-store — the inventory/release ledger', () => {
  afterEach(() => resetAdminStoreForTests());

  it('has nothing recorded until a caller writes an entry', () => {
    assert.equal(getAdminStoreEntry('inventory'), undefined);
    assert.equal(getAdminStoreEntry('release'), undefined);
  });

  it('records a boot answer with its as_of and source', () => {
    const entry = recordAdminStoreEntry('inventory', [{ object_id: 'a' }], '2026-09-16T00:00:00.000Z', 'boot', 1_000);
    assert.deepEqual(getAdminStoreEntry('inventory'), entry);
    assert.equal(entry.source, 'boot');
    assert.equal(entry.asOf, '2026-09-16T00:00:00.000Z');
    assert.equal(entry.fetchedAtMs, 1_000);
  });

  it('records a network answer with no as_of, when the payload carries none', () => {
    const entry = recordAdminStoreEntry('release', { deploy: {} }, undefined, 'network', 2_000);
    assert.equal(entry.source, 'network');
    assert.equal(entry.asOf, undefined);
  });

  it('a later write replaces the earlier one for the same section', () => {
    recordAdminStoreEntry('inventory', ['first'], undefined, 'boot', 1_000);
    recordAdminStoreEntry('inventory', ['second'], undefined, 'network', 2_000);
    const entry = getAdminStoreEntry<string[]>('inventory');
    assert.deepEqual(entry?.data, ['second']);
    assert.equal(entry?.source, 'network');
  });

  it('one section is untouched by a write to the other', () => {
    recordAdminStoreEntry('inventory', ['rows'], undefined, 'boot', 1_000);
    assert.equal(getAdminStoreEntry('release'), undefined);
  });

  it('invalidate drops the entry outright, not just its freshness', () => {
    recordAdminStoreEntry('release', { deploy: {} }, undefined, 'boot', 1_000);
    invalidateAdminStoreEntry('release');
    assert.equal(getAdminStoreEntry('release'), undefined);
  });

  it('invalidating an already-empty section is a no-op, not a throw', () => {
    assert.doesNotThrow(() => invalidateAdminStoreEntry('inventory'));
  });

  describe('isAdminStoreEntryStale', () => {
    it('an entry with nothing recorded is always stale', () => {
      assert.equal(isAdminStoreEntryStale(undefined, 30_000, 1_000), true);
    });

    it('an entry younger than the bound is not stale', () => {
      const entry: AdminStoreEntry<unknown> = { data: null, asOf: undefined, source: 'boot', fetchedAtMs: 1_000 };
      assert.equal(isAdminStoreEntryStale(entry, 30_000, 1_000 + 29_999), false);
    });

    it('an entry exactly at the bound is stale (the bound is exclusive)', () => {
      const entry: AdminStoreEntry<unknown> = { data: null, asOf: undefined, source: 'boot', fetchedAtMs: 1_000 };
      assert.equal(isAdminStoreEntryStale(entry, 30_000, 1_000 + 30_000), false);
      assert.equal(isAdminStoreEntryStale(entry, 30_000, 1_000 + 30_001), true);
    });

    it('a boot-sourced entry and a network-sourced entry expire the same way', () => {
      const boot: AdminStoreEntry<unknown> = { data: null, asOf: undefined, source: 'boot', fetchedAtMs: 1_000 };
      const network: AdminStoreEntry<unknown> = { data: null, asOf: undefined, source: 'network', fetchedAtMs: 1_000 };
      const now = 1_000 + 60_000;
      assert.equal(isAdminStoreEntryStale(boot, 30_000, now), isAdminStoreEntryStale(network, 30_000, now));
    });
  });
});
