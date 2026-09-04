import '../../sites/drlurie/config/policy-bindings.js'; // the drlurie ceiling is the one under test
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateAggression, scoreAggression } from '../../packages/core/server/lib/aggression-score.js';
import {
  AGGRESSION_GATE_ID,
  checkAggressionCeiling,
  summarizeValidation,
  validateObject,
} from '../../packages/core/server/lib/object-validate.js';
import { publishObject } from '../../packages/core/server/lib/object-publish.js';
import { setSiteIdentityConfigProvider, type AggressionCeiling } from '../../packages/core/lib/site-identity.js';
import { siteIdentityConfig } from '../../sites/drlurie/config/site-identity.js';
import type { ObjectRecord, Principal } from '../../packages/core/schema/object-record-v1.js';

/**
 * W7.3 acceptance — the ceiling is enforced by the SERVER, for every actor.
 *
 * Until this wave the ceiling lived in one place a plugin never passes through:
 * CMS-Agent's composer. Over `/mcp` it was a paragraph in a rendered skill, and
 * this project already learned once (caller-surface.ts, sixteen unattributed
 * tool calls) that a rule which survives only in prose does not survive.
 *
 * Four things have to hold, and each is a way the check could be worse than
 * nothing:
 *
 *  1. THE LIVE CORPUS PASSES. A gate that fails the publication's own published
 *     articles is not a gate, it is an outage — and the first calibration did
 *     exactly that (the moisturizer article scored 220% of a ceiling it plainly
 *     respects). Every real editorial article is held to a pass here.
 *  2. THE BANDS ARE WHERE THEY ARE CLAIMED. 60% passes clean, 105% warns, 130%
 *     blocks. The fixtures are GENERATED to an exact word count so the
 *     percentage is arithmetic rather than a guess about prose.
 *  3. A BLOCK STOPS A REAL PUBLISH, with a gate id. Not "the criterion is
 *     missing" — the actual publish call, refused, naming GATE-CEIL-1.
 *  4. THE REFUSAL SAYS WHAT TO CHANGE. A score with no phrases is an accusation.
 */
/**
 * Walk up to the repo root rather than counting `..` segments: this file runs
 * from `.tmp/ci-test/tests/netlify/` after the test compile, not from its
 * source directory, so a fixed relative path resolves inside the build output.
 * Same trick, same reason, as site-config-drift.test.ts.
 */
const findRepoRoot = (startDir: string): string => {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'astro.config.ts'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('repo root not found');
    dir = parent;
  }
};
const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const ARTICLES_DIR = join(REPO_ROOT, 'sites/drlurie/data/site/articles');

const DRLURIE_CEILING: AggressionCeiling = {
  claim_strength: 0.45,
  urgency: 0.1,
  emotional_agitation: 0.15,
  cta_density: 0.2,
};

/**
 * The two articles that genuinely exceed the ceiling, named rather than
 * excused. Both are DEMO fixtures from the object-model walkthrough, and both
 * stack two calls to action into seven blocks — 29% against a declared 20%
 * ceiling. The scorer is right about them; they are listed here so a future
 * calibration change cannot quietly start passing them, and so nobody reads
 * "the corpus passes" as "nothing in the corpus is over".
 */
const KNOWN_OVER = new Set([
  'req_agent_object_model_demo_20260713_01.json',
  'req_agent_object_model_demo_variant_20260831_01.json',
]);

// ─── 1. the live corpus ──────────────────────────────────────────────────────

test('every published drlurie article scores within its own ceiling', () => {
  const files = readdirSync(ARTICLES_DIR).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 20, `expected the real corpus, found ${files.length} files`);

  const over: string[] = [];
  for (const file of files) {
    if (KNOWN_OVER.has(file)) continue;
    const body = JSON.parse(readFileSync(join(ARTICLES_DIR, file), 'utf8')) as unknown;
    const evaluation = evaluateAggression(body, DRLURIE_CEILING);
    if (evaluation.worst && evaluation.worst.ratio > 1) {
      over.push(`${file}: ${evaluation.worst.dial} at ${Math.round(evaluation.worst.ratio * 100)}%`);
    }
  }
  assert.deepEqual(over, [], `these published articles would now warn or block:\n${over.join('\n')}`);
});

test('the live plugin-published article — the one W7 exists for — passes comfortably', () => {
  const body = JSON.parse(
    readFileSync(join(ARTICLES_DIR, 'req_plugin_moisturizer_functions_20260903_01.json'), 'utf8')
  ) as unknown;
  const evaluation = evaluateAggression(body, DRLURIE_CEILING);
  assert.ok(
    evaluation.worst && evaluation.worst.ratio < 0.75,
    `expected comfortable headroom, got ${evaluation.worst?.dial} at ${Math.round((evaluation.worst?.ratio ?? 0) * 100)}%`
  );
});

test('the demo articles that ARE over are caught, and for the reason claimed', () => {
  const body = JSON.parse(readFileSync(join(ARTICLES_DIR, 'req_agent_object_model_demo_20260713_01.json'), 'utf8'));
  const evaluation = evaluateAggression(body, DRLURIE_CEILING);
  assert.equal(evaluation.worst?.dial, 'cta_density');
  assert.equal(evaluation.basis.cta_nodes, 2);
  assert.equal(evaluation.basis.public_nodes, 7);
});

// ─── 2. the bands, on generated fixtures ─────────────────────────────────────

/**
 * A fixture article of an EXACT word count, carrying an exact number of
 * flagged phrases. Generating it beats hand-writing prose: the percentage is
 * then arithmetic (`hits ÷ words × 1000 ÷ saturation ÷ ceiling`) and a test
 * that claims "105%" can prove it rather than assert a vibe.
 *
 * The filler is deliberately calm and deliberately hedge-free — a hedge would
 * damp the claim dial and move the band under the test's feet.
 */
const FILLER_WORD = 'skin';
const article = (input: { words: number; claims?: number; ctaNodes?: number; contentNodes?: number }) => {
  const claims = Array.from({ length: input.claims ?? 0 }, () => 'clinically proven').join(' ');
  const claimWords = (input.claims ?? 0) * 2;
  const filler = Array.from({ length: Math.max(0, input.words - claimWords) }, () => FILLER_WORD).join(' ');
  const contentNodes = input.contentNodes ?? 8;
  const nodes: unknown[] = [
    { id: 'n_body', kind: 'content', public: { body: `${claims} ${filler}`.trim() } },
    ...Array.from({ length: contentNodes - 1 }, (_, index) => ({
      id: `n_c${index}`,
      kind: 'content',
      public: { body: FILLER_WORD },
    })),
    ...Array.from({ length: input.ctaNodes ?? 0 }, (_, index) => ({
      id: `n_a${index}`,
      kind: 'action',
      public: { ctaText: 'Read the next note', ctaLink: '/guides' },
    })),
  ];
  // The filler words in the extra nodes count too; the caller sizes `words`
  // for the body node and the test asserts the measured total.
  return { slug: 'fixture', title: 'A fixture', nodes };
};

const claimRatio = (words: number, claims: number) => {
  const body = article({ words, claims });
  return evaluateAggression(body, DRLURIE_CEILING).ratio.claim_strength;
};

test('a fixture at ~60% of the ceiling passes with nothing to say', () => {
  // 2 "clinically proven" in ~750 words → 2.66 per 1000 → score 0.266 → 59% of 0.45.
  const body = article({ words: 750, claims: 2 });
  const evaluation = evaluateAggression(body, DRLURIE_CEILING);
  assert.ok(
    evaluation.ratio.claim_strength > 0.5 && evaluation.ratio.claim_strength < 0.7,
    `expected ~60%, got ${Math.round(evaluation.ratio.claim_strength * 100)}%`
  );

  const criteria = checkAggressionCeiling(body, { aggressionCeiling: DRLURIE_CEILING });
  assert.equal(criteria.filter((c) => c.status === 'warning' || c.status === 'missing').length, 0);
  // …but the readout is still there. A dial you can only see by tripping it is a trap.
  assert.ok(criteria.some((c) => c.id === 'aggression_score' && c.status === 'info'));
});

test('a fixture just over the ceiling WARNS, and names the phrases', () => {
  // 4 claims in ~850 words → 4.7 per 1000 → score 0.47 → 105% of 0.45.
  const body = article({ words: 850, claims: 4 });
  const ratio = claimRatio(850, 4);
  assert.ok(ratio > 1.0 && ratio < 1.15, `expected ~105%, got ${Math.round(ratio * 100)}%`);

  const criteria = checkAggressionCeiling(body, { aggressionCeiling: DRLURIE_CEILING });
  const flagged = criteria.find((c) => c.id === 'aggression_over_ceiling');
  assert.ok(flagged, 'nothing was flagged');
  assert.equal(flagged.status, 'warning', 'just over the ceiling must warn, not block');
  assert.match(flagged.message, /clinically proven/, 'the warning must quote what drove it');
  assert.ok(!flagged.message.includes(AGGRESSION_GATE_ID), 'a warning is not a gate');
});

test('a fixture well over the ceiling BLOCKS, with the gate id', () => {
  // 5 claims in ~850 words → 5.9 per 1000 → score 0.59 → 131% of 0.45.
  const body = article({ words: 850, claims: 5 });
  const ratio = claimRatio(850, 5);
  assert.ok(ratio > 1.15 && ratio < 1.45, `expected ~130%, got ${Math.round(ratio * 100)}%`);

  const criteria = checkAggressionCeiling(body, { aggressionCeiling: DRLURIE_CEILING });
  const flagged = criteria.find((c) => c.id === 'aggression_over_ceiling');
  assert.equal(flagged?.status, 'missing', 'past the block tolerance it must be a blocker');
  assert.match(flagged!.message, new RegExp(AGGRESSION_GATE_ID));
  assert.match(flagged!.message, /claim_strength/);
});

test('per-site tolerance moves the bands, and only the bands', () => {
  const body = article({ words: 850, claims: 5 }); // ~130%
  const strict = checkAggressionCeiling(body, {
    aggressionCeiling: DRLURIE_CEILING,
    aggressionTolerance: { warn: 1, block: 1 },
  });
  const lenient = checkAggressionCeiling(body, {
    aggressionCeiling: DRLURIE_CEILING,
    aggressionTolerance: { warn: 1.5, block: 2 },
  });
  assert.equal(strict.find((c) => c.id === 'aggression_over_ceiling')?.status, 'missing');
  assert.equal(
    lenient.find((c) => c.id === 'aggression_over_ceiling'),
    undefined
  );
  // The SCORE is identical either way — tolerance is a policy about the same
  // measurement, never a different measurement.
  assert.equal(
    strict.find((c) => c.id === 'aggression_score')?.message,
    lenient.find((c) => c.id === 'aggression_score')?.message
  );
});

test('a site that declares no ceiling is told so, never silently treated as unlimited', () => {
  /**
   * The dangerous default would be "no ceiling declared → nothing enforced,
   * quietly", which makes the least-configured site the most permissive one.
   * Swapping the identity provider is the only honest way to reach that branch
   * from a file that has the drlurie bindings imported at the top; it is
   * restored immediately so nothing after this line sees a half-configured site.
   */
  const previous = siteIdentityConfig;
  try {
    setSiteIdentityConfigProvider(() => ({ ...previous, aggressionCeiling: undefined }));
    const criteria = checkAggressionCeiling(article({ words: 200, claims: 20 }), {});
    const declared = criteria.find((c) => c.id === 'aggression_ceiling_declared');
    assert.equal(declared?.status, 'warning', 'an undeclared ceiling must be visible, not silent');
    assert.match(declared!.message, /aggressionCeiling/);
    assert.equal(
      criteria.find((c) => c.id === 'aggression_over_ceiling'),
      undefined
    );
  } finally {
    setSiteIdentityConfigProvider(() => previous);
  }
});

// ─── 3. the dials measure what they say ──────────────────────────────────────

test('ordinary English is not aggression — the lexicons are phrases, not words', () => {
  const calm = article({ words: 0, contentNodes: 1 });
  (calm.nodes[0] as { public: { body: string } }).public.body = [
    'Now that you know how the barrier works, the next step is simple.',
    'Retinoids never suit everyone, and results today are not results in six weeks.',
    'The evidence is proven in trials, and you should always patch test first.',
  ].join(' ');
  const evaluation = evaluateAggression(calm, DRLURIE_CEILING);
  assert.equal(evaluation.score.urgency, 0, 'bare "now"/"today" must not read as urgency');
  assert.equal(evaluation.score.emotional_agitation, 0, '"never"/"always" must not read as agitation');
});

test('scarcity framing does read as urgency', () => {
  const pushy = article({ words: 0, contentNodes: 1 });
  (pushy.nodes[0] as { public: { body: string } }).public.body =
    'Limited time only. Act now before it is too late — while supplies last, and only 3 left.';
  const evaluation = evaluateAggression(pushy, DRLURIE_CEILING);
  assert.ok(evaluation.score.urgency > 0.5, `expected a loud urgency score, got ${evaluation.score.urgency}`);
  assert.ok(evaluation.hits.some((hit) => hit.dial === 'urgency' && hit.term.includes('limited time')));
});

test('the strategy annotations are NOT scored — naming a beat is not performing it', () => {
  const annotated = {
    slug: 'x',
    title: 'A calm article',
    nodes: [
      {
        id: 'n_1',
        kind: 'content',
        public: { body: 'A calm paragraph about barrier repair.' },
        private: { strategy: 'agitation', intent: 'convert', agentNotes: 'hurry, limited time, buy now' },
      },
    ],
  };
  const evaluation = evaluateAggression(annotated, DRLURIE_CEILING);
  assert.equal(evaluation.score.urgency, 0, 'private strategy notes must never score');
  assert.equal(evaluation.score.emotional_agitation, 0);
});

test('a CTA node counts once, however many ways it announces itself', () => {
  const body = {
    slug: 'x',
    title: 'y',
    nodes: [
      { id: 'n_1', kind: 'content', public: { body: 'A paragraph.' } },
      // action + ctaLink + an imperative phrase: three signals, one CTA.
      { id: 'n_2', kind: 'action', public: { ctaText: 'Download the PDF guide', ctaLink: '/guide' } },
    ],
  };
  assert.equal(scoreAggression(body).basis.cta_nodes, 1);
  // 1 CTA over the minimum denominator of 5 — not over the 2 blocks this stub
  // happens to have. A share is meaningless on a fragment (MIN_CTA_DENOMINATOR).
  assert.equal(scoreAggression(body).score.cta_density, 0.2);
});

// ─── 4. a real publish is refused ────────────────────────────────────────────

const ACTOR: Principal = { kind: 'human', id: 'u1', email: 'wolf@example.com' };
const NOW = Date.parse('2026-09-04T12:00:00.000Z');

const loudArticleRecord = (): ObjectRecord => ({
  object_id: 'req_fixture_over_ceiling_20260904_01',
  object_type: 'content_item',
  schema_version: 'content_item.v1',
  site: 'site_drlurie',
  created_at: '2026-09-04T00:00:00.000Z',
  updated_at: '2026-09-04T00:00:00.000Z',
  status: 'active',
  body: {
    slug: 'over-the-ceiling-fixture',
    title: 'A fixture that pushes far too hard',
    deck: 'A deck long enough to be a real deck, and calm in itself.',
    description: 'A fixture article used to prove the ceiling stops a publish.',
    author: 'Dr. Lurie',
    taxonomy: { category: 'skin-health', tags: ['skincare-basics'] },
    seo: { meta_description: 'A fixture article used to prove the ceiling stops a publish.' },
    nodes: [
      {
        id: 'n_01',
        kind: 'content',
        public: {
          body: `<p>${'clinically proven '.repeat(5)}${'skin '.repeat(840)}</p>`,
        },
        private: { strategy: 'explanation', intent: 'educate' },
      },
    ],
  },
  publication: { published_time: null },
  lock: {
    token: 'tok1',
    owner_id: 'u1',
    owner_label: 'wolf@example.com',
    acquired_at: new Date(NOW - 60_000).toISOString(),
    expires_at: new Date(NOW + 600_000).toISOString(),
  },
  history: [{ at: '2026-09-04T00:00:00.000Z', action: 'object_create', actor: ACTOR }],
  version: 3,
  content_revision: 2,
});

test('publishing an article over the ceiling is refused at the gate, naming GATE-CEIL-1', async (t) => {
  const record = loudArticleRecord();
  const store = {
    get: async () => JSON.stringify(record),
    setJSON: async () => {
      assert.fail('a refused publish must never write the record');
    },
    set: async () => {
      assert.fail('a refused publish must never write the record');
    },
  };

  const result = await publishObject(
    store as never,
    {
      object_type: 'content_item',
      object_id: record.object_id,
      lock_token: 'tok1',
      actor: ACTOR,
    } as never,
    {
      nowMs: NOW,
      exportRoot: 'sites/drlurie/data/site',
      validationContext: { aggressionCeiling: DRLURIE_CEILING },
    }
  );

  await t.test('the publish is refused, not merely warned about', () => {
    assert.equal(result.status, 422);
    assert.equal(result.body.error, 'Validation failed');
  });

  await t.test('and the blocker names the gate, so the refusal is traceable', () => {
    const blockers = result.body.blockers as Array<{ id: string; message: string }>;
    const gate = blockers.find((blocker) => blocker.id === 'aggression_over_ceiling');
    assert.ok(gate, `expected the ceiling blocker, got ${blockers.map((b) => b.id).join(', ')}`);
    assert.match(gate.message, new RegExp(AGGRESSION_GATE_ID));
  });
});

test('the same article one notch calmer publishes — the gate is a ceiling, not a wall', () => {
  const record = loudArticleRecord();
  const body = record.body as { nodes: Array<{ public: { body: string } }> };
  body.nodes[0].public.body = `<p>${'clinically proven '.repeat(2)}${'skin '.repeat(840)}</p>`;

  const groups = validateObject(
    { objectType: 'content_item', objectId: record.object_id, body: record.body, published: false },
    { publishIntent: true, aggressionCeiling: DRLURIE_CEILING }
  );
  const ceilingBlockers = summarizeValidation(groups).blockers.filter((c) => c.id === 'aggression_over_ceiling');
  assert.deepEqual(ceilingBlockers, []);
});
