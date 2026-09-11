import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  navActionCapacity,
  REGION_IDS,
  REGION_REGISTRY,
  REGION_ROWS,
  regionForSectionType,
  sectionTypesInRegion,
} from '../../packages/core/lib/registry/region-registry.js';
import { navActionCapacity as shimCapacity } from '../../packages/core/lib/registry/structural-capacity.js';
import { SECTION_DEFINITIONS, sectionFootprint } from '../../packages/core/lib/registry/components/definitions.js';
import { REGISTERED_SECTION_TYPES } from '../../packages/core/lib/registry/components/registered-types.js';
import { buildObjectContract, listSectionTypeContracts } from '../../packages/core/lib/registry/object-contract.js';

/**
 * W1 T1.1 acceptance — the region registry.
 *
 * The table is the interesting part, not the code: it is the first place that
 * says a reader-side page has regions at all. Two things are pinned — that
 * every placeable kind declares WHERE it goes (so a future sticky kind cannot
 * be added without answering that question), and that the table an agent reads
 * through `object_contract` / `registry_get` is the same table the validator
 * enforces.
 */

test('every registered section type declares a footprint', () => {
  for (const type of REGISTERED_SECTION_TYPES) {
    const footprint = SECTION_DEFINITIONS[type].footprint;
    assert.ok(footprint, `${type} has no footprint`);
    assert.ok(REGION_IDS.includes(footprint.region), `${type}: unknown region ${footprint.region}`);
  }
  // The `Record` is total over the registered list, so this is a compile-time
  // guarantee as well — the runtime assertion catches a cast that defeated it.
  assert.equal(Object.keys(SECTION_DEFINITIONS).length, REGISTERED_SECTION_TYPES.length);
});

test('every bound kind is in flow today — and the flow allow-list is DERIVED from that', () => {
  assert.deepEqual(sectionTypesInRegion('flow'), [...REGISTERED_SECTION_TYPES]);
  const flow = REGION_REGISTRY.flow.allowed;
  assert.equal(flow.kind, 'all_placeable');
  assert.deepEqual(flow.kind === 'all_placeable' ? [...flow.types] : [], [...REGISTERED_SECTION_TYPES]);
  // A leaf/pointer type has no footprint and therefore no region.
  assert.equal(regionForSectionType('card'), undefined);
  assert.equal(regionForSectionType('shared_ref'), undefined);
  assert.equal(regionForSectionType('hero'), 'flow');
});

test('the region table — pinned row by row', () => {
  assert.deepEqual(
    REGION_ROWS.map((row) => ({
      id: row.id,
      max: row.occupancy.max ?? null,
      ordered: row.occupancy.ordered ?? false,
      allowed: row.allowed.kind,
      level: row.level,
      rendered: row.rendered,
    })),
    [
      { id: 'header', max: 1, ordered: false, allowed: 'navigation', level: 'warning', rendered: true },
      { id: 'announcement', max: 1, ordered: false, allowed: 'section_types', level: 'warning', rendered: false },
      { id: 'flow', max: null, ordered: true, allowed: 'all_placeable', level: 'none', rendered: true },
      { id: 'sticky_bottom', max: 1, ordered: false, allowed: 'code_owned', level: 'missing', rendered: true },
      { id: 'floating', max: 1, ordered: false, allowed: 'reserved', level: 'missing', rendered: false },
      { id: 'overlay', max: null, ordered: false, allowed: 'code_owned', level: 'none', rendered: true },
      { id: 'footer', max: 1, ordered: false, allowed: 'navigation', level: 'missing', rendered: true },
    ]
  );
});

test('sticky_bottom is already OCCUPIED — the consent banner, found by the z-index lint', () => {
  const row = REGION_REGISTRY.sticky_bottom;
  // The brief expected an empty reserved row. `lib/tracking/consent/
  // banner-html.ts` renders a fixed bottom bar on every tenant, so the region
  // has exactly one code-owned occupant and no room for a second. This is the
  // fact a future sticky_cta has to design around.
  assert.equal(row.allowed.kind, 'code_owned');
  assert.equal(row.rendered, true);
  assert.equal(row.occupancy.max, 1);
});

test('the announcement region is declared UNRENDERED — the honest row (KNOWN_ISSUES #68)', () => {
  const row = REGION_REGISTRY.announcement;
  assert.equal(row.rendered, false);
  assert.match(row.description, /#68/);
  // It still declares what it would hold, so the row survives the fix.
  assert.deepEqual(row.allowed.kind === 'section_types' ? [...row.allowed.types] : [], ['cta_banner']);
});

test('the header capacity rule survived the move, and the shim reaches the same object', () => {
  assert.deepEqual(navActionCapacity.header, { max: 3, level: 'warning' });
  assert.equal(shimCapacity, navActionCapacity, 'the shim must re-export, not copy');
});

test('object_contract and registry_get publish the footprints and the region table', () => {
  const contracts = listSectionTypeContracts();
  for (const contract of contracts) {
    const expected = sectionFootprint(contract.type);
    assert.deepEqual(contract.footprint, expected, contract.type);
    // A component-bound type always has one; card / shared_ref never do.
    assert.equal(Boolean(contract.footprint), contract.component_bound, contract.type);
  }

  const page = buildObjectContract('page');
  assert.deepEqual(page.regions, REGION_ROWS, 'the contract must publish the registry, not a copy of it');
  assert.ok(page.section_types?.some((entry) => entry.footprint?.region === 'flow'));

  // A type that carries no sections carries no region table either.
  assert.equal(buildObjectContract('navigation').regions, undefined);
});

test('a singleton kind says so in its own footprint, not in a list somewhere else', () => {
  for (const type of ['newsletter_signup', 'contact_form', 'search'] as const) {
    assert.equal(SECTION_DEFINITIONS[type].footprint.singleton, true, type);
  }
  assert.equal(SECTION_DEFINITIONS.prose.footprint.singleton, undefined);
});
