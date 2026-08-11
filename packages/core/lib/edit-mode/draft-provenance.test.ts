import { describe, it } from 'node:test';
import assert from 'node:assert';

import { changedUnitsSince, provenanceUnitFor, regionIsDraft, type HistoryEntry } from './draft-provenance.js';

const entry = (action: string, op?: Record<string, unknown>): HistoryEntry => ({
  action,
  ...(op ? { details: { op } } : {}),
});

describe('changedUnitsSince', () => {
  it('a node edit after a publish is the one unit changed', () => {
    const changed = changedUnitsSince([
      entry('create'),
      entry('publish'),
      entry('update_node', { node_id: 'node_hook' }),
    ]);
    assert.strictEqual(changed.resolved, true);
    assert.strictEqual(changed.wholeObject, false);
    assert.deepStrictEqual([...changed.nodeIds], ['node_hook']);
    assert.strictEqual(changed.sectionIds.size, 0);
  });

  it('two node edits are both in the changed set', () => {
    const changed = changedUnitsSince([
      entry('publish'),
      entry('update_node', { node_id: 'node_hook' }),
      entry('update_node', { node_id: 'node_resolution' }),
    ]);
    assert.deepStrictEqual([...changed.nodeIds].sort(), ['node_hook', 'node_resolution']);
    assert.strictEqual(changed.wholeObject, false);
  });

  it('a node edit BEFORE the last publish does not count', () => {
    const changed = changedUnitsSince([
      entry('update_node', { node_id: 'node_hook' }), // stale — predates the publish below
      entry('publish'),
      entry('update_node', { node_id: 'node_proof' }),
    ]);
    assert.deepStrictEqual([...changed.nodeIds], ['node_proof']);
    assert.strictEqual(changed.nodeIds.has('node_hook'), false);
  });

  it('a section edit lands in sectionIds, not nodeIds', () => {
    const changed = changedUnitsSince([entry('publish'), entry('update_section_data', { section_id: 'sec_hero' })]);
    assert.deepStrictEqual([...changed.sectionIds], ['sec_hero']);
    assert.strictEqual(changed.nodeIds.size, 0);
    assert.strictEqual(changed.wholeObject, false);
  });

  it('a create with no publish dirties the whole object', () => {
    const changed = changedUnitsSince([entry('create')]);
    assert.strictEqual(changed.resolved, true);
    assert.strictEqual(changed.wholeObject, true);
  });

  it('set_page_meta dirties the whole object (no sub-object unit to narrow to)', () => {
    const changed = changedUnitsSince([entry('publish'), entry('set_page_meta')]);
    assert.strictEqual(changed.wholeObject, true);
    assert.strictEqual(changed.nodeIds.size, 0);
    assert.strictEqual(changed.sectionIds.size, 0);
  });

  it('an op shape the mapping does not recognise falls back to whole-object, never ignored', () => {
    const changed = changedUnitsSince([entry('publish'), entry('some_future_op', { thing: 'x' })]);
    assert.strictEqual(changed.resolved, true);
    assert.strictEqual(changed.wholeObject, true);
  });

  it('an empty history is unresolved — the caller must fall back', () => {
    const changed = changedUnitsSince([]);
    assert.strictEqual(changed.resolved, false);
    assert.strictEqual(changed.wholeObject, false);
    assert.strictEqual(changed.nodeIds.size, 0);
    assert.strictEqual(changed.sectionIds.size, 0);
  });

  it('a history of only checkout/checkin is resolved, with nothing changed', () => {
    const changed = changedUnitsSince([entry('checkout'), entry('checkin')]);
    assert.strictEqual(changed.resolved, true);
    assert.strictEqual(changed.wholeObject, false);
    assert.strictEqual(changed.nodeIds.size, 0);
    assert.strictEqual(changed.sectionIds.size, 0);
  });
});

describe('provenanceUnitFor', () => {
  it('an article node reads its own node id', () => {
    assert.deepStrictEqual(provenanceUnitFor({ objectType: 'content_item', nodeId: 'node_hook' }, undefined), {
      kind: 'node',
      id: 'node_hook',
    });
  });

  it('a page-owned section reads its own section id', () => {
    assert.deepStrictEqual(provenanceUnitFor({ objectType: 'page', sectionId: 'sec_page_1' }, undefined), {
      kind: 'section',
      id: 'sec_page_1',
    });
  });

  it("a shared section reads the shared record's OWN inner section id, not the page reference", () => {
    const record = { body: { section: { id: 'sec_inner_9' } } };
    assert.deepStrictEqual(provenanceUnitFor({ objectType: 'section' }, record), {
      kind: 'section',
      id: 'sec_inner_9',
    });
  });

  it('a shared section with no readable inner id is undefined — the caller must fall back', () => {
    assert.strictEqual(provenanceUnitFor({ objectType: 'section' }, undefined), undefined);
    assert.strictEqual(provenanceUnitFor({ objectType: 'section' }, { body: {} }), undefined);
  });
});

describe('regionIsDraft — the per-region marking decision', () => {
  it('one changed node in a multi-article marks that node and no other', () => {
    const changed = changedUnitsSince([entry('publish'), entry('update_node', { node_id: 'node_hook' })]);
    assert.strictEqual(regionIsDraft(true, changed, { kind: 'node', id: 'node_hook' }), true);
    assert.strictEqual(regionIsDraft(true, changed, { kind: 'node', id: 'node_proof' }), false);
    assert.strictEqual(regionIsDraft(true, changed, { kind: 'node', id: 'node_resolution' }), false);
  });

  it('a section-level change marks the section', () => {
    const changed = changedUnitsSince([entry('publish'), entry('update_section_data', { section_id: 'sec_hero' })]);
    assert.strictEqual(regionIsDraft(true, changed, { kind: 'section', id: 'sec_hero' }), true);
    assert.strictEqual(regionIsDraft(true, changed, { kind: 'section', id: 'sec_footer' }), false);
  });

  it('an unresolvable case falls back to object-wide (marks every unit)', () => {
    const unresolved = changedUnitsSince([]); // resolved: false
    assert.strictEqual(regionIsDraft(true, unresolved, { kind: 'node', id: 'node_hook' }), true);
    assert.strictEqual(regionIsDraft(true, unresolved, { kind: 'node', id: 'node_proof' }), true);

    // A whole-object change (e.g. set_page_meta) also falls back for every unit.
    const wholeObject = changedUnitsSince([entry('publish'), entry('set_page_meta')]);
    assert.strictEqual(regionIsDraft(true, wholeObject, { kind: 'section', id: 'sec_anything' }), true);

    // A region whose own unit couldn't be determined (e.g. a shared section
    // with no readable inner id) also falls back, even with a resolved,
    // non-whole-object change elsewhere in the same object's history.
    const nodeChange = changedUnitsSince([entry('publish'), entry('update_node', { node_id: 'node_hook' })]);
    assert.strictEqual(regionIsDraft(true, nodeChange, undefined), true);
  });

  it('no pending changes marks nothing, regardless of history', () => {
    const changed = changedUnitsSince([entry('publish'), entry('update_node', { node_id: 'node_hook' })]);
    assert.strictEqual(regionIsDraft(false, changed, { kind: 'node', id: 'node_hook' }), false);
    assert.strictEqual(regionIsDraft(false, undefined, undefined), false);
  });
});
