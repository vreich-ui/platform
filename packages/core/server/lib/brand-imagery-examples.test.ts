/**
 * X1 acceptance (BRIEF.md §3.1/R9): hash-gated example generation, the
 * sampleSubjects×usageContexts zip, partial-failure tolerance, and the
 * dependency-injected orchestrator — logic-first `node:test` over the pure
 * module, same posture as visual-identity-imagery.test.ts.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { isFilename, isRequestId } from '../../lib/agents-naming.js';
import {
  buildExampleJobFilename,
  buildExampleJobInput,
  buildExampleJobRequestId,
  computeBrandImageryContractHash,
  EXAMPLE_USAGE_CONTEXTS,
  generateVisualStandardExamplesWithDeps,
  mergeExampleResults,
  planExampleGeneration,
  type VisualStandardExampleRecord,
} from './brand-imagery-examples.js';

const IMAGERY = {
  version: 1,
  medium: 'photograph',
  styleSentence: 'Quiet clinical daylight on matte surfaces.',
  palette: ['#2E5C42', '#F4F1EA'],
  negative: ['stock smiles'],
  seedBase: 42,
};

const OTHER_IMAGERY = { ...IMAGERY, styleSentence: 'Bright saturated studio light.' };

// ─── computeBrandImageryContractHash ────────────────────────────────────────

describe('computeBrandImageryContractHash', () => {
  test('is deterministic for the same value', () => {
    assert.equal(computeBrandImageryContractHash(IMAGERY), computeBrandImageryContractHash({ ...IMAGERY }));
  });

  test('is insensitive to key order', () => {
    const reordered = { seedBase: 42, styleSentence: IMAGERY.styleSentence, version: 1, medium: 'photograph', palette: [...IMAGERY.palette], negative: [...IMAGERY.negative] };
    assert.equal(computeBrandImageryContractHash(IMAGERY), computeBrandImageryContractHash(reordered));
  });

  test('differs for different brandImagery', () => {
    assert.notEqual(computeBrandImageryContractHash(IMAGERY), computeBrandImageryContractHash(OTHER_IMAGERY));
  });

  test('is a lowercase hex sha256 (64 chars)', () => {
    assert.match(computeBrandImageryContractHash(IMAGERY), /^[a-f0-9]{64}$/);
  });

  test('handles undefined/null brandImagery without throwing', () => {
    assert.match(computeBrandImageryContractHash(undefined), /^[a-f0-9]{64}$/);
    assert.equal(computeBrandImageryContractHash(undefined), computeBrandImageryContractHash(null));
  });
});

// ─── planExampleGeneration ───────────────────────────────────────────────────

describe('planExampleGeneration', () => {
  test('no existing examples ⇒ generates up to 3 jobs, zipped by index', () => {
    const plan = planExampleGeneration({
      sampleSubjects: ['a mug of coffee', 'a bicycle', 'a garden trowel'],
      brandImagery: IMAGERY,
    });
    assert.equal(plan.shouldGenerate, true);
    if (!plan.shouldGenerate) return;
    assert.deepEqual(
      plan.jobs.map((job) => job.usageContext),
      ['article_header', 'article_body', 'category_page']
    );
    assert.deepEqual(
      plan.jobs.map((job) => job.sampleSubject),
      ['a mug of coffee', 'a bicycle', 'a garden trowel']
    );
    assert.equal(plan.contractHash, computeBrandImageryContractHash(IMAGERY));
  });

  test('same hash on every existing example ⇒ skip (the cost control)', () => {
    const contractHash = computeBrandImageryContractHash(IMAGERY);
    const examples: VisualStandardExampleRecord[] = [
      { usageContext: 'article_header', blobKey: 'image/req/aa.png', contractHash },
      { usageContext: 'article_body', blobKey: 'image/req/bb.png', contractHash },
    ];
    const plan = planExampleGeneration({ sampleSubjects: ['a mug'], brandImagery: IMAGERY, examples });
    assert.deepEqual(plan, { shouldGenerate: false, contractHash, reason: 'hash_unchanged' });
  });

  test('a new hash (brandImagery changed) ⇒ regenerates even with prior examples present', () => {
    const staleHash = computeBrandImageryContractHash(IMAGERY);
    const examples: VisualStandardExampleRecord[] = [
      { usageContext: 'article_header', blobKey: 'image/req/aa.png', contractHash: staleHash },
    ];
    const plan = planExampleGeneration({ sampleSubjects: ['a mug', 'a bike', 'a trowel'], brandImagery: OTHER_IMAGERY, examples });
    assert.equal(plan.shouldGenerate, true);
    if (!plan.shouldGenerate) return;
    assert.equal(plan.jobs.length, 3);
    assert.notEqual(plan.contractHash, staleHash);
  });

  test('a partial-failure leftover (mixed hashes) is treated as needing regeneration, not up to date', () => {
    const currentHash = computeBrandImageryContractHash(IMAGERY);
    const examples: VisualStandardExampleRecord[] = [
      { usageContext: 'article_header', blobKey: 'image/req/aa.png', contractHash: currentHash },
      { usageContext: 'article_body', blobKey: 'image/req/bb.png', contractHash: 'stale-hash-from-before' },
    ];
    const plan = planExampleGeneration({ sampleSubjects: ['a mug', 'a bike'], brandImagery: IMAGERY, examples });
    assert.equal(plan.shouldGenerate, true);
  });

  test('an empty examples array is never "up to date" — forces regeneration (the Regenerate-button mechanism)', () => {
    const plan = planExampleGeneration({ sampleSubjects: ['a mug'], brandImagery: IMAGERY, examples: [] });
    assert.equal(plan.shouldGenerate, true);
  });

  test('fewer than 3 sampleSubjects ⇒ only that many jobs planned', () => {
    const plan = planExampleGeneration({ sampleSubjects: ['a single mug'], brandImagery: IMAGERY });
    assert.equal(plan.shouldGenerate, true);
    if (!plan.shouldGenerate) return;
    assert.equal(plan.jobs.length, 1);
    assert.equal(plan.jobs[0]!.usageContext, 'article_header');
    assert.equal(plan.jobs[0]!.sampleSubject, 'a single mug');
  });

  test('two sampleSubjects ⇒ exactly two jobs, article_header then article_body', () => {
    const plan = planExampleGeneration({ sampleSubjects: ['first', 'second'], brandImagery: IMAGERY });
    assert.equal(plan.shouldGenerate, true);
    if (!plan.shouldGenerate) return;
    assert.deepEqual(plan.jobs.map((j) => j.usageContext), ['article_header', 'article_body']);
  });

  test('no sampleSubjects at all ⇒ skip with a named reason, regardless of hash', () => {
    const plan = planExampleGeneration({ sampleSubjects: [], brandImagery: IMAGERY });
    assert.deepEqual(plan, { shouldGenerate: false, contractHash: computeBrandImageryContractHash(IMAGERY), reason: 'no_sample_subjects' });
  });

  test('blank/non-string sampleSubjects entries are filtered out before counting', () => {
    const plan = planExampleGeneration({ sampleSubjects: ['  ', 42, 'real subject', null], brandImagery: IMAGERY });
    assert.equal(plan.shouldGenerate, true);
    if (!plan.shouldGenerate) return;
    assert.equal(plan.jobs.length, 1);
    assert.equal(plan.jobs[0]!.sampleSubject, 'real subject');
  });

  test('never plans more than 3 jobs even with more than 3 usage contexts worth of subjects', () => {
    const plan = planExampleGeneration({ sampleSubjects: ['1', '2', '3', '4', '5'], brandImagery: IMAGERY });
    assert.equal(plan.shouldGenerate, true);
    if (!plan.shouldGenerate) return;
    assert.equal(plan.jobs.length, EXAMPLE_USAGE_CONTEXTS.length);
    assert.equal(plan.jobs.length, 3);
  });
});

// ─── mergeExampleResults ─────────────────────────────────────────────────────

describe('mergeExampleResults', () => {
  const hash = 'abc123';

  test('all successes ⇒ every entry carries the round hash', () => {
    const merged = mergeExampleResults(hash, [
      { usageContext: 'article_header', ok: true, blobKey: 'image/req/a.png' },
      { usageContext: 'article_body', ok: true, blobKey: 'image/req/b.png' },
      { usageContext: 'category_page', ok: true, blobKey: 'image/req/c.png' },
    ]);
    assert.equal(merged.length, 3);
    assert.ok(merged.every((example) => example.contractHash === hash));
  });

  test('a partial failure keeps only whichever succeeded — never an error', () => {
    const merged = mergeExampleResults(hash, [
      { usageContext: 'article_header', ok: true, blobKey: 'image/req/a.png' },
      { usageContext: 'article_body', ok: false },
      { usageContext: 'category_page', ok: true, blobKey: 'image/req/c.png' },
    ]);
    assert.deepEqual(
      merged.map((e) => e.usageContext),
      ['article_header', 'category_page']
    );
  });

  test('every job failing ⇒ an empty array, not a thrown error', () => {
    const merged = mergeExampleResults(hash, [
      { usageContext: 'article_header', ok: false },
      { usageContext: 'article_body', ok: false },
    ]);
    assert.deepEqual(merged, []);
  });

  test('an ok:true attempt with no blobKey does not produce an example', () => {
    const merged = mergeExampleResults(hash, [{ usageContext: 'article_header', ok: true }]);
    assert.deepEqual(merged, []);
  });
});

// ─── job id / filename shape (must satisfy the repo's own naming grammar) ───

describe('buildExampleJobRequestId / buildExampleJobFilename', () => {
  test('the request id matches agents-naming.ts isRequestId', () => {
    const requestId = buildExampleJobRequestId('vis_acme_summer', 'article_header', Date.UTC(2026, 8, 1, 12, 0, 0));
    assert.equal(isRequestId(requestId), true, requestId);
    assert.match(requestId, /^req_visimg_vis_acme_summer_article_header_20260901_\d{2}$/);
  });

  test('the filename matches agents-naming.ts isFilename', () => {
    const filename = buildExampleJobFilename('vis_acme_summer', 'category_page');
    assert.equal(isFilename(filename), true, filename);
    assert.equal(filename, 'vis-acme-summer-example-category-page.png');
  });

  test('two different usage contexts on the same standard/timestamp never collide', () => {
    const now = 1_700_000_000_000;
    const a = buildExampleJobRequestId('vis_acme', 'article_header', now);
    const b = buildExampleJobRequestId('vis_acme', 'article_body', now);
    assert.notEqual(a, b);
  });
});

describe('buildExampleJobInput', () => {
  test('carries style.visualStandardId, a subject-only prompt, and the usageContext with no explicit size', () => {
    const input = buildExampleJobInput('site_demo', 'vis_demo_summer', { usageContext: 'article_header', sampleSubject: 'a mug of coffee' }, 1_700_000_000_000);
    assert.equal(input.site_id, 'site_demo');
    assert.equal(input.artifact_kind, 'image');
    assert.equal(input.prompt, 'a mug of coffee');
    assert.deepEqual(input.style, { visualStandardId: 'vis_demo_summer' });
    assert.deepEqual(input.requirements, { image: { usageContext: 'article_header' } });
    assert.equal(input.wait, true);
    assert.equal(typeof input.request_id, 'string');
    assert.equal(typeof input.filename, 'string');
  });
});

// ─── generateVisualStandardExamplesWithDeps (the DI orchestrator) ──────────

describe('generateVisualStandardExamplesWithDeps', () => {
  test('hash unchanged ⇒ no jobs created, nothing persisted', async () => {
    const contractHash = computeBrandImageryContractHash(IMAGERY);
    let createCalls = 0;
    let persistCalls = 0;
    const outcome = await generateVisualStandardExamplesWithDeps(
      {
        siteId: 'site_demo',
        now: () => 1_700_000_000_000,
        createExampleJob: async () => {
          createCalls += 1;
          return { ok: true, blobKey: 'image/req/x.png' };
        },
        persistExamples: async () => {
          persistCalls += 1;
        },
      },
      'vis_demo',
      { sampleSubjects: ['a mug'], brandImagery: IMAGERY, examples: [{ usageContext: 'article_header', blobKey: 'image/req/a.png', contractHash }] }
    );
    assert.deepEqual(outcome, { generated: false, reason: 'hash_unchanged' });
    assert.equal(createCalls, 0);
    assert.equal(persistCalls, 0);
  });

  test('a new hash ⇒ exactly 3 jobs created (3 sampleSubjects) with the right usage contexts, and the successes are persisted', async () => {
    const created: Record<string, unknown>[] = [];
    let persisted: unknown;
    const outcome = await generateVisualStandardExamplesWithDeps(
      {
        siteId: 'site_demo',
        now: () => 1_700_000_000_000,
        createExampleJob: async (input) => {
          created.push(input);
          return { ok: true, blobKey: `image/req/${input.request_id}.png` };
        },
        persistExamples: async (_id, examples) => {
          persisted = examples;
        },
      },
      'vis_demo',
      { sampleSubjects: ['a mug', 'a bike', 'a trowel'], brandImagery: IMAGERY }
    );
    assert.equal(created.length, 3);
    assert.deepEqual(
      created.map((c) => (c.requirements as { image: { usageContext: string } }).image.usageContext),
      ['article_header', 'article_body', 'category_page']
    );
    assert.ok(created.every((c) => (c.style as { visualStandardId: string }).visualStandardId === 'vis_demo'));
    assert.equal(outcome.generated, true);
    if (!outcome.generated) return;
    assert.equal(outcome.examples.length, 3);
    assert.deepEqual(persisted, outcome.examples);
  });

  test('a fewer-than-3-sampleSubjects standard creates only as many jobs as it has', async () => {
    let createCalls = 0;
    const outcome = await generateVisualStandardExamplesWithDeps(
      {
        siteId: 'site_demo',
        now: () => 1_700_000_000_000,
        createExampleJob: async () => {
          createCalls += 1;
          return { ok: true, blobKey: 'image/req/x.png' };
        },
        persistExamples: async () => undefined,
      },
      'vis_demo',
      { sampleSubjects: ['only one subject'], brandImagery: IMAGERY }
    );
    assert.equal(createCalls, 1);
    assert.equal(outcome.generated, true);
    if (!outcome.generated) return;
    assert.equal(outcome.examples.length, 1);
    assert.equal(outcome.examples[0]!.usageContext, 'article_header');
  });

  test('a partial failure keeps whatever succeeded and is never surfaced as an error', async () => {
    let call = 0;
    let persisted: VisualStandardExampleRecord[] | undefined;
    const outcome = await generateVisualStandardExamplesWithDeps(
      {
        siteId: 'site_demo',
        now: () => 1_700_000_000_000,
        createExampleJob: async () => {
          call += 1;
          if (call === 2) return { ok: false };
          return { ok: true, blobKey: `image/req/job-${call}.png` };
        },
        persistExamples: async (_id, examples) => {
          persisted = examples;
        },
      },
      'vis_demo',
      { sampleSubjects: ['a', 'b', 'c'], brandImagery: IMAGERY }
    );
    assert.equal(outcome.generated, true);
    if (!outcome.generated) return;
    assert.equal(outcome.examples.length, 2);
    assert.deepEqual(persisted, outcome.examples);
  });

  test('a rejected createExampleJob call is treated as a failure, not thrown onward', async () => {
    const outcome = await generateVisualStandardExamplesWithDeps(
      {
        siteId: 'site_demo',
        now: () => 1_700_000_000_000,
        createExampleJob: async () => {
          throw new Error('pdf-tool unreachable');
        },
        persistExamples: async () => {
          throw new Error('should not be called — nothing succeeded');
        },
      },
      'vis_demo',
      { sampleSubjects: ['a'], brandImagery: IMAGERY }
    );
    assert.equal(outcome.generated, true);
    if (!outcome.generated) return;
    assert.deepEqual(outcome.examples, []);
  });

  test('when nothing succeeds, persistExamples is never called (an outage does not wipe prior examples)', async () => {
    let persistCalls = 0;
    await generateVisualStandardExamplesWithDeps(
      {
        siteId: 'site_demo',
        now: () => 1_700_000_000_000,
        createExampleJob: async () => ({ ok: false }),
        persistExamples: async () => {
          persistCalls += 1;
        },
      },
      'vis_demo',
      { sampleSubjects: ['a'], brandImagery: IMAGERY }
    );
    assert.equal(persistCalls, 0);
  });

  test('a rejected persistExamples is swallowed — generation is still reported as having happened', async () => {
    const outcome = await generateVisualStandardExamplesWithDeps(
      {
        siteId: 'site_demo',
        now: () => 1_700_000_000_000,
        createExampleJob: async () => ({ ok: true, blobKey: 'image/req/a.png' }),
        persistExamples: async () => {
          throw new Error('store unavailable');
        },
      },
      'vis_demo',
      { sampleSubjects: ['a'], brandImagery: IMAGERY }
    );
    assert.equal(outcome.generated, true);
  });

  test('no sampleSubjects ⇒ generated:false with the named reason, no jobs', async () => {
    let createCalls = 0;
    const outcome = await generateVisualStandardExamplesWithDeps(
      {
        siteId: 'site_demo',
        now: () => 1_700_000_000_000,
        createExampleJob: async () => {
          createCalls += 1;
          return { ok: true, blobKey: 'image/req/x.png' };
        },
        persistExamples: async () => undefined,
      },
      'vis_demo',
      { sampleSubjects: [], brandImagery: IMAGERY }
    );
    assert.deepEqual(outcome, { generated: false, reason: 'no_sample_subjects' });
    assert.equal(createCalls, 0);
  });
});
