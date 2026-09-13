import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  buildVariantFamilies,
  EVIDENCE_GAPS,
  isMetricScore,
  judgementRows,
  memberSeverity,
  variantEvidence,
  type VariantMember,
  type VariantScore,
} from './variant-experiments.js';
import { fetchVariantMembers } from './variants-client.js';

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

// ═══ W4.1 — the call count behind this page ═══════════════════════════════════

/**
 * `/admin/variants` was measured live at FORTY `admin-object` invocations for
 * one page load: one `inventory`, then one `get` per article, because
 * `lineage.parent_content_id` lived in the body and the inventory projection
 * did not carry it. Each call was warm and individually fast — the cost was
 * the count against the ~250-400 ms fixed per-invocation platform overhead.
 *
 * These tests pin the COUNT, and pin that collapsing it changed no output:
 * the legacy N+1 derivation is reproduced below, run against the same fixture,
 * and its members and its families must match the one-call path exactly. The
 * acceptance bar for the whole page was <= 3 calls; this path is 1.
 */

const ARTICLE_COUNT = 12;

/** One fixture article: the record body the store holds, and the lifecycle fields a row mirrors. */
const article = (index: number) => {
  const id = `req_probe_${String(index).padStart(2, '0')}`;
  // A family of three: #0 is a parent, #1 and #2 are its clones. The rest are
  // standalone parents, which is what a real corpus mostly is.
  const parent = index === 1 || index === 2 ? 'req_probe_00' : undefined;
  return {
    id,
    row: {
      object_id: id,
      object_type: 'content_item',
      display_name: `Article ${index}`,
      status: 'active' as const,
      review_state: 'none' as const,
      published_time: index % 2 === 0 ? '2026-08-01T00:00:00.000Z' : null,
      unpublished_changes: index % 2 !== 0,
      updated_at: '2026-08-02T00:00:00.000Z',
    },
    body: {
      title: `Article ${index}`,
      slug: `article-${index}`,
      ...(parent ? { lineage: { parent_content_id: parent } } : {}),
      scores: [
        { scored_by: 'agent:judge', at: '2026-08-03T00:00:00.000Z', framework: 'f1', dimension: 'clarity', score: 2 },
        { scored_by: 'agent:judge', at: '2026-08-08T00:00:00.000Z', framework: 'f1', dimension: 'clarity', score: 4 },
      ] as Record<string, unknown>[],
    } as Record<string, unknown>,
  };
};

const ARTICLES = Array.from({ length: ARTICLE_COUNT }, (_, index) => article(index));

/**
 * The server, as far as this page can tell: `inventory` answers rows carrying
 * the W4.1 `content` summary (the same reduction `object-inventory.ts` does —
 * latest score per framework/dimension), `get` answers a record envelope.
 * Every request is tallied by action.
 */
const mockObjectEndpoint = () => {
  const actions: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as { action?: string; object_id?: string };
    actions.push(String(request.action));
    if (request.action === 'inventory') {
      const objects = ARTICLES.map((entry) => {
        const lineage = entry.body.lineage as { parent_content_id?: string } | undefined;
        const scores = entry.body.scores as Record<string, unknown>[];
        return {
          ...entry.row,
          content: {
            slug: entry.body.slug as string,
            parent_content_id: lineage?.parent_content_id ?? null,
            // The digest: newest entry per (framework, dimension).
            scores: [scores[scores.length - 1]],
          },
        };
      });
      return new Response(JSON.stringify({ objects }), { status: 200 });
    }
    const found = ARTICLES.find((entry) => entry.id === request.object_id);
    return new Response(JSON.stringify({ record: { object_id: request.object_id, body: found?.body } }), {
      status: 200,
    });
  }) as typeof fetch;
  return {
    actions,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

/**
 * The derivation as it was BEFORE W4.1, verbatim in shape: list, then one
 * `get` per row, reading the same three facts out of each body. Kept here and
 * only here, as the reference the one-call path is proved equal to.
 */
const legacyFetchVariantMembers = async (): Promise<VariantMember[]> => {
  const listed = await fetch('/.netlify/functions/admin-object', {
    method: 'POST',
    body: JSON.stringify({ action: 'inventory', object_type: 'content_item' }),
  });
  const rows = ((await listed.json()) as { objects: Record<string, unknown>[] }).objects;
  const members: VariantMember[] = [];
  for (const row of rows) {
    const got = await fetch('/.netlify/functions/admin-object', {
      method: 'POST',
      body: JSON.stringify({ action: 'get', object_type: 'content_item', object_id: row.object_id }),
    });
    const body = ((await got.json()) as { record: { body: Record<string, unknown> } }).record.body;
    const lineage = body.lineage as { parent_content_id?: string } | undefined;
    const scores = body.scores as VariantScore[];
    const { content: _content, object_type: _type, ...rest } = row as Record<string, unknown>;
    members.push({
      ...(rest as unknown as VariantMember),
      ...(lineage?.parent_content_id ? { parent_content_id: lineage.parent_content_id } : {}),
      slug: body.slug as string,
      // The old path carried the whole array; the surface reduces it to the
      // newest per line itself, which is what the digest now ships.
      scores: [scores[scores.length - 1] as VariantScore],
    });
  }
  return members;
};

describe('fetchVariantMembers (W4.1)', () => {
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
  });

  it('issues exactly ONE admin-object call for the whole page, whatever the corpus size', async () => {
    const endpoint = mockObjectEndpoint();
    restoreFetch = endpoint.restore;

    const members = await fetchVariantMembers(async () => 'test-token');

    assert.equal(endpoint.actions.length, 1, `one call, not ${ARTICLE_COUNT + 1} — this is the whole task`);
    assert.deepEqual(endpoint.actions, ['inventory']);
    assert.ok(endpoint.actions.length <= 3, 'the plan’s acceptance bar for the page');
    assert.equal(members.length, ARTICLE_COUNT);
  });

  it('derives the SAME members and the same families the N+1 path did', async () => {
    const endpoint = mockObjectEndpoint();
    restoreFetch = endpoint.restore;

    const oneCall = await fetchVariantMembers(async () => 'test-token');
    const callsForOne = endpoint.actions.length;

    endpoint.actions.length = 0;
    const legacy = await legacyFetchVariantMembers();
    const callsForLegacy = endpoint.actions.length;

    assert.equal(callsForOne, 1);
    assert.equal(callsForLegacy, ARTICLE_COUNT + 1, 'the measured before-count: one inventory plus one get per row');

    assert.deepEqual(oneCall, legacy, 'the projection carries exactly what the record reads carried');
    assert.deepEqual(buildVariantFamilies(oneCall), buildVariantFamilies(legacy));

    // And the grouping is a real one, not an empty coincidence.
    const families = buildVariantFamilies(oneCall);
    const withVariants = families.find((family) => family.variants.length > 0);
    assert.equal(withVariants?.parentId, 'req_probe_00');
    assert.equal(withVariants?.variants.length, 2);
    assert.deepEqual(
      judgementRows(withVariants as (typeof families)[number]).map((row) => row.dimension),
      ['clarity']
    );
  });

  it('reads the parentage off the row, so a row without a summary is simply a parent', async () => {
    const originalFetch = globalThis.fetch;
    restoreFetch = () => {
      globalThis.fetch = originalFetch;
    };
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          objects: [
            {
              object_id: 'req_bare',
              object_type: 'content_item',
              display_name: 'Bare',
              status: 'active',
              review_state: 'none',
              published_time: null,
              unpublished_changes: true,
              updated_at: '2026-08-02T00:00:00.000Z',
              content: { slug: null, parent_content_id: null },
            },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;

    const members = await fetchVariantMembers(async () => 'test-token');
    assert.deepEqual(members, [
      {
        object_id: 'req_bare',
        display_name: 'Bare',
        status: 'active',
        review_state: 'none',
        published_time: null,
        unpublished_changes: true,
        updated_at: '2026-08-02T00:00:00.000Z',
      },
    ]);
  });
});
