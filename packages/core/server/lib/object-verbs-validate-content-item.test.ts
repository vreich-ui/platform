/**
 * T2.5 — proves the `validate_content_item` MCP tool's exact dispatch shape
 * (`handleObjectVerb({ action: 'validate', object_type: 'content_item', object_id })`,
 * the same request `callObjectAction` builds in mcp.ts's `validate_content_item` case)
 * returns a `pdf_quality` warning wired end-to-end through the REAL
 * `buildStoreValidationContext` (object-validation-context.ts) — not a hand-rolled
 * context — and that the same context object is exactly what `object_publish` reads
 * (`{...deps.validationContext, publishIntent: true}`, object-publish.ts): the two
 * paths differ only in `publishIntent`, and `pdf_quality` never varies with it, so
 * `validate_content_item` returns the same pdf_quality signal a publish would.
 *
 * Follows the injected-store pattern object-verbs-shared-ref-stamp.test.ts already
 * established (a real handleObjectVerb call against an in-memory store, with
 * buildStoreValidationContext wired for real, not a hand-rolled stub).
 */
import '../../../../sites/drlurie/config/policy-bindings.js'; // registers site providers — handleObjectVerb needs them resolvable
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { handleObjectVerb, type ObjectVerbStore } from './object-verbs.js';
import { buildStoreValidationContext } from './object-validation-context.js';
import { validateObject, summarizeValidation, type ReadinessCriterion } from './object-validate.js';
import { objectRecordKey } from './object-store-keys.js';
import type { ObjectRecord, Principal } from '../../schema/object-record-v1.js';

const makeStore = (seeds: ObjectRecord[]) => {
  const blobs = new Map<string, string>();
  for (const seed of seeds) blobs.set(objectRecordKey(seed.object_type, seed.object_id), JSON.stringify(seed));
  return {
    blobs,
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      blobs.set(key, JSON.stringify(value));
    },
    async list({ prefix }: { prefix: string }) {
      return { blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
};

const HUMAN: Principal = { kind: 'human', id: 'u1', email: 'editor@example.com' };
const SHA = 'b'.repeat(64);
const PDF_PATH = `/pdf/req_1/${SHA}.pdf`;

const articleBody = () => ({
  slug: 'moisturizers-explainer',
  title: 'What moisturizers actually do',
  nodes: [
    { id: 'n_1', kind: 'content', public: { title: 'Intro', body: 'Some text.' } },
    { id: 'n_2', kind: 'content', public: { media: { type: 'document', src: PDF_PATH } } },
  ],
});

const makeArticleRecord = (): ObjectRecord => ({
  object_id: 'req_agent_moisturizers_20260901_01',
  object_type: 'content_item',
  schema_version: 'content_item.v1',
  site: 'site_drlurie',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  status: 'active',
  body: articleBody(),
  publication: { published_time: null },
  history: [],
  version: 1,
  content_revision: 1,
});

const findCriterion = (groups: { id: string; criteria: ReadinessCriterion[] }[], id: string) =>
  groups.flatMap((g) => g.criteria).find((c) => c.id === id);

describe('validate_content_item dispatch shape (handleObjectVerb "validate", object_type content_item)', () => {
  it('a clean attached PDF (status: ok) validates with no pdf_quality warning, and the object is publishable', async () => {
    const article = makeArticleRecord();
    const store = makeStore([article]);
    const context = await buildStoreValidationContext(store as unknown as ObjectVerbStore, {
      selfObjectId: article.object_id,
      selfObjectType: 'content_item',
      documentContentChecks: { [PDF_PATH]: { status: 'ok', pageCount: 5, sizeBytes: 900_000 } },
    });

    const result = await handleObjectVerb(
      store as unknown as ObjectVerbStore,
      { action: 'validate', object_type: 'content_item', object_id: article.object_id },
      HUMAN,
      { validationContext: context }
    );

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    const groups = (result.body as { validation: { id: string; criteria: ReadinessCriterion[] }[] }).validation;
    const pdfQuality = findCriterion(groups, 'pdf_quality');
    assert.ok(pdfQuality, 'expected a pdf_quality criterion to be present');
    assert.strictEqual(pdfQuality!.status, 'complete');
    const summary = (result.body as { summary: { eligible: boolean } }).summary;
    assert.strictEqual(summary.eligible, true);
  });

  it('a PDF that failed content inspection: pdf_quality warns, names the defect, carries no blobKey/SHA, and the article stays eligible', async () => {
    const article = makeArticleRecord();
    const store = makeStore([article]);
    const context = await buildStoreValidationContext(store as unknown as ObjectVerbStore, {
      selfObjectId: article.object_id,
      selfObjectType: 'content_item',
      documentContentChecks: {
        [PDF_PATH]: {
          status: 'failed',
          reason: '4 pages have no readable body text (pages 2, 3, 4, 5). 2 images failed to resolve.',
          findings: [],
        },
      },
    });

    const result = await handleObjectVerb(
      store as unknown as ObjectVerbStore,
      { action: 'validate', object_type: 'content_item', object_id: article.object_id },
      HUMAN,
      { validationContext: context }
    );

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    const groups = (result.body as { validation: { id: string; criteria: ReadinessCriterion[] }[] }).validation;
    const pdfQuality = findCriterion(groups, 'pdf_quality');
    assert.ok(pdfQuality);
    assert.strictEqual(pdfQuality!.status, 'warning');
    assert.ok(pdfQuality!.message.includes('no readable body text'), pdfQuality!.message);
    assert.ok(!pdfQuality!.message.includes(SHA), pdfQuality!.message);
    assert.ok(!pdfQuality!.message.includes('req_1'), pdfQuality!.message);

    const summary = (result.body as { summary: { eligible: boolean; blockers: ReadinessCriterion[] } }).summary;
    assert.strictEqual(summary.eligible, true, 'a failing pdf_quality check must never block eligibility (D-D)');
    assert.ok(!summary.blockers.some((b) => b.id === 'pdf_quality'));
  });

  it('validate_content_item returns what the publish path would: the same context, only publishIntent differs, and pdf_quality is identical either way', async () => {
    const article = makeArticleRecord();
    const store = makeStore([article]);
    const context = await buildStoreValidationContext(store as unknown as ObjectVerbStore, {
      selfObjectId: article.object_id,
      selfObjectType: 'content_item',
      documentContentChecks: {
        [PDF_PATH]: { status: 'failed', reason: 'Only 1 page(s); at least 2 required.', findings: [] },
      },
    });

    // What validate_content_item computes (handleObjectVerb 'validate', object_id mode).
    const validateResult = await handleObjectVerb(
      store as unknown as ObjectVerbStore,
      { action: 'validate', object_type: 'content_item', object_id: article.object_id },
      HUMAN,
      { validationContext: context }
    );
    const validateGroups = (validateResult.body as { validation: { id: string; criteria: ReadinessCriterion[] }[] })
      .validation;

    // What object-publish.ts computes: validateObject with the IDENTICAL context object,
    // publishIntent forced true (object-publish.ts:229-236's own shape).
    const publishGroups = validateObject(
      { objectType: 'content_item', objectId: article.object_id, body: article.body, published: false },
      { ...context, publishIntent: true }
    );

    assert.deepStrictEqual(
      findCriterion(validateGroups, 'pdf_quality'),
      findCriterion(publishGroups, 'pdf_quality'),
      'validate_content_item must surface the identical pdf_quality signal object_publish would compute'
    );
    assert.strictEqual(summarizeValidation(publishGroups).eligible, true, 'publish path stays eligible too (D-D)');
  });
});
