import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildVariantFamilies,
  EVIDENCE_GAPS,
  isMetricScore,
  judgementRows,
  memberSeverity,
  variantEvidence,
  type VariantMember,
} from './variant-experiments.js';

const member = (overrides: Partial<VariantMember> & { object_id: string }): VariantMember => ({
  display_name: overrides.object_id,
  status: 'active',
  review_state: 'none',
  published_time: null,
  unpublished_changes: true,
  updated_at: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

const published = (id: string, at = '2026-08-01T00:00:00.000Z', extra: Partial<VariantMember> = {}) =>
  member({
    object_id: id,
    published_time: at,
    unpublished_changes: false,
    updated_at: at,
    ...extra,
  });

describe('memberSeverity', () => {
  it('reads archived as terminal info, not an error', () => {
    const read = memberSeverity(member({ object_id: 'a', status: 'archived', published_time: '2026-01-01' }));
    assert.equal(read.severity, 'info');
    assert.equal(read.label, 'Archived');
    assert.equal(read.live, false);
  });

  it('is the only level that asks for a human when a review is open', () => {
    assert.equal(memberSeverity(member({ object_id: 'a', review_state: 'open' })).severity, 'needs_you');
    assert.equal(memberSeverity(member({ object_id: 'a', review_state: 'changes_requested' })).severity, 'needs_you');
  });

  it('keeps a published article live while a revision of it is in review', () => {
    const read = memberSeverity(published('a', '2026-08-01T00:00:00.000Z', { review_state: 'open' }));
    assert.equal(read.severity, 'needs_you');
    assert.equal(read.label, 'In review');
    // The export is still serving readers — the review is about the draft.
    assert.equal(read.live, true);
  });

  it('distinguishes clean-published from published-with-edits-since', () => {
    assert.deepEqual(memberSeverity(published('a')), { severity: 'success', label: 'Published', live: true });
    const edited = memberSeverity(member({ object_id: 'a', published_time: '2026-01-01', unpublished_changes: true }));
    assert.equal(edited.severity, 'info');
    assert.equal(edited.label, 'Published, edited since');
    // Still live: the published export is what a release ships, edits or not.
    assert.equal(edited.live, true);
  });

  it('archived beats published — an archived record is never live', () => {
    assert.equal(memberSeverity(published('a', '2026-01-01', { status: 'archived' })).live, false);
  });
});

describe('buildVariantFamilies', () => {
  it('creates a family from the clone, never from the parent', () => {
    const families = buildVariantFamilies([member({ object_id: 'art_a' }), member({ object_id: 'art_b' })]);
    assert.deepEqual(families, []);
  });

  it('groups clones under the parent named by lineage.parent_content_id', () => {
    const families = buildVariantFamilies([
      published('art_parent'),
      member({ object_id: 'art_v2', parent_content_id: 'art_parent' }),
      member({ object_id: 'art_v1', parent_content_id: 'art_parent' }),
      member({ object_id: 'art_unrelated' }),
    ]);
    assert.equal(families.length, 1);
    assert.equal(families[0]?.parentId, 'art_parent');
    assert.equal(families[0]?.parentMissing, false);
    // Sorted by object id, so the same input in any order renders the same.
    assert.deepEqual(
      families[0]?.variants.map((view) => view.member.object_id),
      ['art_v1', 'art_v2']
    );
    assert.deepEqual(
      families[0]?.members.map((view) => view.member.object_id),
      ['art_parent', 'art_v1', 'art_v2']
    );
  });

  it('keeps an orphaned family when the parent was retired and purged', () => {
    const families = buildVariantFamilies([member({ object_id: 'art_v1', parent_content_id: 'art_gone' })]);
    assert.equal(families[0]?.parentMissing, true);
    assert.equal(families[0]?.parent, undefined);
    assert.equal(families[0]?.members.length, 1);
  });

  it('ignores a record that names itself as its own parent', () => {
    assert.deepEqual(buildVariantFamilies([member({ object_id: 'art_a', parent_content_id: 'art_a' })]), []);
  });

  it('places a clone-of-a-clone in both families', () => {
    const families = buildVariantFamilies([
      member({ object_id: 'art_p' }),
      member({ object_id: 'art_c', parent_content_id: 'art_p' }),
      member({ object_id: 'art_g', parent_content_id: 'art_c' }),
    ]);
    assert.deepEqual(families.map((family) => family.parentId).sort(), ['art_c', 'art_p']);
  });

  it('sorts families most-recently-touched first', () => {
    const families = buildVariantFamilies([
      member({ object_id: 'art_old' }),
      member({ object_id: 'art_old_v', parent_content_id: 'art_old', updated_at: '2026-01-01T00:00:00.000Z' }),
      member({ object_id: 'art_new' }),
      member({ object_id: 'art_new_v', parent_content_id: 'art_new', updated_at: '2026-08-20T00:00:00.000Z' }),
    ]);
    assert.deepEqual(
      families.map((family) => family.parentId),
      ['art_new', 'art_old']
    );
  });
});

describe('family stage', () => {
  const stage = (members: VariantMember[]) => buildVariantFamilies(members)[0]?.stage;

  it('is drafting while the clone is unpublished', () => {
    assert.equal(stage([published('art_p'), member({ object_id: 'art_v', parent_content_id: 'art_p' })]), 'drafting');
  });

  it('is both_published — the state a winner selection exists to end', () => {
    const family = buildVariantFamilies([
      published('art_p'),
      published('art_v', '2026-08-02T00:00:00.000Z', { parent_content_id: 'art_p' }),
    ])[0];
    assert.equal(family?.stage, 'both_published');
    // needs_you, never an error: two live permalinks is a decision, not a fault.
    assert.equal(family?.stageSeverity, 'needs_you');
  });

  it('is settled once the alternatives are archived', () => {
    assert.equal(
      stage([
        published('art_p', '2026-08-01T00:00:00.000Z', { status: 'archived' }),
        published('art_v', '2026-08-02T00:00:00.000Z', { parent_content_id: 'art_p' }),
      ]),
      'settled'
    );
  });

  it('is dormant when every member is archived', () => {
    assert.equal(
      stage([
        published('art_p', '2026-08-01T00:00:00.000Z', { status: 'archived' }),
        member({ object_id: 'art_v', parent_content_id: 'art_p', status: 'archived' }),
      ]),
      'dormant'
    );
  });
});

describe('judgementRows', () => {
  const familyWith = (parentScores: VariantMember['scores'], variantScores: VariantMember['scores']) =>
    buildVariantFamilies([
      member({ object_id: 'art_p', scores: parentScores }),
      member({ object_id: 'art_v', parent_content_id: 'art_p', scores: variantScores }),
    ])[0]!;

  it('aligns the same framework/dimension across the family', () => {
    const rows = judgementRows(
      familyWith(
        [{ scored_by: 'editor-agent', at: '2026-08-01', framework: 'clarity.v1', dimension: 'lede', score: 3 }],
        [{ scored_by: 'editor-agent', at: '2026-08-02', framework: 'clarity.v1', dimension: 'lede', score: 4 }]
      )
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(
      rows[0]?.cells.map((cell) => [cell.objectId, cell.score]),
      [
        ['art_p', 3],
        ['art_v', 4],
      ]
    );
  });

  it('leaves a cell absent rather than zero when a member is unjudged', () => {
    const rows = judgementRows(
      familyWith(
        [{ scored_by: 'editor-agent', at: '2026-08-01', framework: 'clarity.v1', dimension: 'lede', score: 3 }],
        undefined
      )
    );
    assert.equal(rows[0]?.cells.length, 1);
    assert.equal(rows[0]?.cells[0]?.objectId, 'art_p');
  });

  it('keeps the latest entry per member — scores append, they never replace', () => {
    const rows = judgementRows(
      familyWith(
        [
          { scored_by: 'editor-agent', at: '2026-08-01', framework: 'clarity.v1', dimension: 'lede', score: 3 },
          { scored_by: 'editor-agent', at: '2026-08-05', framework: 'clarity.v1', dimension: 'lede', score: 5 },
        ],
        undefined
      )
    );
    assert.equal(rows[0]?.cells[0]?.score, 5);
  });

  it('flags a metric-namespaced entry as not an agent judgment', () => {
    assert.equal(
      isMetricScore({ scored_by: 'metric:engagement.v1', at: '', framework: '', dimension: '', score: 0 }),
      true
    );
    assert.equal(isMetricScore({ scored_by: 'editor-agent', at: '', framework: '', dimension: '', score: 0 }), false);
    const rows = judgementRows(
      familyWith(
        [
          {
            scored_by: 'metric:engagement.v1',
            at: '2026-08-01',
            framework: 'engagement.v1',
            dimension: 'dwell',
            score: 9,
          },
        ],
        undefined
      )
    );
    assert.equal(rows[0]?.agentJudgmentOnly, false);
  });
});

describe('variantEvidence — the honest results surface', () => {
  const bare = buildVariantFamilies([
    member({ object_id: 'art_p' }),
    member({ object_id: 'art_v', parent_content_id: 'art_p' }),
  ])[0]!;

  it('reports no evidence, and still names all three gaps', () => {
    const evidence = variantEvidence(bare);
    assert.equal(evidence.kind, 'none');
    assert.deepEqual(evidence.rows, []);
    assert.deepEqual(
      evidence.gaps.map((gap) => gap.id),
      ['traffic_split', 'per_variant_outcomes', 'metric_scores']
    );
  });

  it('never claims a test when agent judgments exist', () => {
    const family = buildVariantFamilies([
      member({
        object_id: 'art_p',
        scores: [{ scored_by: 'editor-agent', at: '2026-08-01', framework: 'clarity.v1', dimension: 'lede', score: 3 }],
      }),
      member({ object_id: 'art_v', parent_content_id: 'art_p' }),
    ])[0]!;
    const evidence = variantEvidence(family);
    assert.equal(evidence.kind, 'agent_judgment');
    assert.match(evidence.headline, /not a randomized test/);
    // The gaps do not stop being true because a score exists.
    assert.equal(evidence.gaps.length, 3);
  });

  it('says plainly that no significance is calculated, and why', () => {
    const note = variantEvidence(bare).significanceNote;
    assert.match(note, /No significance is calculated/);
    assert.match(note, /sample sizes/);
  });

  it('every gap cites a real path so the claim is checkable', () => {
    for (const gap of EVIDENCE_GAPS) {
      assert.ok(gap.source.includes('/'), `${gap.id} must cite a path`);
      assert.ok(gap.detail.length > 40, `${gap.id} must say what is missing`);
    }
  });
});
