/**
 * W2 T2.3 — `render_article_pdf` end to end, through the real MCP dispatch,
 * the real bridge, the real mapper and the real object store, with only
 * pdf-tool itself stubbed.
 *
 * The decisions are unit-tested against fakes in
 * `packages/core/lib/pdf/article-pdf-render.test.ts` (BRIEF §4: logic-first).
 * What THIS file proves is the part fakes cannot: that the composite's effects
 * are actually bound to the real machinery — that the job it creates carries
 * MAPPED render data (D-2 + JOIN A) and the site's brand (D-3), that the PDF
 * it attaches lands on the article as a `document` node through the patch
 * engine's own media-type discipline, and that a re-read of the article
 * afterwards actually finds it.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler, type LambdaEvent } from '../../netlify/functions/mcp.js';
import { createLocalBlobStore, setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import { stubPdfToolMcp, type PdfToolMcpRoute } from './pdf-tool-mcp-fetch-stub.js';

const SITE_ID = 'site_drlurie';
const REQUEST_ID = 'req_agent_render_article_pdf_20260904_01';
const STORAGE_SECRET = 'storage-secret-never-expose';
const RUN_SECRET = 'run-secret-never-expose';
const PROOF_SECRET = 'proof-never-expose';
const PDF_SHA = 'c'.repeat(64);
const HERO_SHA = 'a'.repeat(64);
const PDF_PATH = `/pdf/${REQUEST_ID}/${PDF_SHA}.pdf`;

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-render-article-pdf');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

for (const key of [
  'NETLIFY',
  'NETLIFY_SITE_ID',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'SITE_ID',
  'MCP_HTTP_AUTH_TOKEN',
]) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';
process.env.PDF_TOOL_STORAGE_TOKEN = STORAGE_SECRET;
process.env.PDF_TOOL_STORAGE_SITE_ID = 'site-api-id';
process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool.test';
process.env.PDF_TOOL_AGENT_RUN_TOKEN = RUN_SECRET;
// Keep the composite's own poll loop short and deterministic in tests.
process.env.PDF_RENDER_ARTICLE_WAIT_MS = '3000';

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

const rpc = async (name: string, args: Record<string, unknown>, extra: Partial<LambdaEvent> = {}) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    ...extra,
  });
  assert.equal(response.statusCode, 200);
  return (JSON.parse(response.body) as { result: ToolResult }).result;
};

const ARTICLE_BODY = {
  slug: 'what-moisturizers-actually-do',
  title: 'What moisturizers actually do',
  deck: 'Most moisturizers perform three basic jobs.',
  author: 'Dr. Lurie',
  image: { src: `/img/${REQUEST_ID}/${HERO_SHA}.webp`, alt: 'Moisturizer textures.' },
  nodes: [
    {
      id: 'n_lede',
      kind: 'content',
      visibility: 'public',
      public: { body: 'The moisturizer shelf can make a basic step feel like a specialist subject.' },
    },
    {
      id: 'n_close',
      kind: 'content',
      visibility: 'public',
      public: { title: 'What to do next', body: 'Pick one formula and use it for a month.' },
    },
  ],
};

const seedSite = async () => {
  const store = createLocalBlobStore('site-objects');
  await store.setJSON(objectRecordKey('site', SITE_ID), {
    object_id: SITE_ID,
    object_type: 'site',
    schema_version: 'site.v1',
    site: SITE_ID,
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    status: 'active',
    body: {
      name: 'Dr. Lurié',
      brandTokens: {
        colors: { primary: '#2E5C42' },
        fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' },
      },
      pdf: { defaultTemplateId: 'article_brochure_v1' },
    },
    publication: { published_time: null },
    history: [],
    version: 1,
    content_revision: 1,
  });
};

const resetAndSeed = async () => {
  await rm(join(LOCAL_BLOBS_ROOT, 'site-objects'), { recursive: true, force: true });
  const created = await rpc('object_create', {
    object_type: 'content_item',
    site: SITE_ID,
    requested_id: REQUEST_ID,
    body: ARTICLE_BODY,
  });
  assert.ok(!created.isError, JSON.stringify(created.structuredContent));
  await seedSite();
};

const TEMPLATE_ROUTE: PdfToolMcpRoute = (body) => ({
  body: {
    projectId: body.projectId,
    templateId: body.templateId,
    renderer: 'chromium',
    status: 'active',
    version: 1,
    renderDataSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['brand', 'title', 'sections'],
      properties: {
        brand: { $ref: '#/$defs/brand' },
        title: { type: 'string', maxLength: 200 },
        deck: { type: 'string', maxLength: 400 },
        author: { type: 'string', maxLength: 120 },
        date: { type: 'string', maxLength: 40 },
        coverImage: { $ref: '#/$defs/assetId' },
        sections: {
          type: 'array',
          minItems: 1,
          maxItems: 24,
          items: {
            type: 'object',
            properties: { heading: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } },
          },
        },
      },
      $defs: {
        assetId: { type: 'string', pattern: '^[a-zA-Z0-9._-]{1,128}$' },
        brand: { type: 'object', properties: { colors: {}, fonts: {} } },
      },
    },
  },
});

const PDF_REFERENCE = {
  blobKey: `pdf/${REQUEST_ID}/${PDF_SHA}.pdf`,
  sha256: PDF_SHA,
  sizeBytes: 220_114,
  contentType: 'application/pdf',
  artifactKind: 'pdf',
  originalFilename: 'what-moisturizers-actually-do.pdf',
};

const withMockedFetch = async <T>(routes: Record<string, PdfToolMcpRoute>, run: () => Promise<T>): Promise<T> => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp(routes);
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    void calls;
  }
};

const readArticleNodes = async (): Promise<Record<string, unknown>[]> => {
  const store = createLocalBlobStore('site-objects');
  const raw = (await store.get(objectRecordKey('content_item', REQUEST_ID))) ?? '{}';
  const record = JSON.parse(raw) as { body?: { nodes?: Record<string, unknown>[] } };
  return record.body?.nodes ?? [];
};

// ── the whole sequence, in one call ─────────────────────────────────────────

test('render_article_pdf: maps, renders, polls, and attaches the PDF as a document node', async () => {
  await resetAndSeed();
  let statusCalls = 0;
  let jobBody: Record<string, unknown> | undefined;

  const receipt = await withMockedFetch(
    {
      get_pdf_template: TEMPLATE_ROUTE,
      create_agent_artifact_job: (body) => {
        jobBody = body;
        return {
          status: 202,
          body: { jobId: 'job_render_1', status: 'pending', projectId: body.projectId, requestId: body.requestId },
        };
      },
      get_agent_artifact_job_status: (body) => {
        statusCalls += 1;
        if (statusCalls === 1) {
          return { body: { jobId: 'job_render_1', status: 'pending', projectId: body.projectId, requestId: REQUEST_ID } };
        }
        return {
          body: {
            jobId: 'job_render_1',
            status: 'complete',
            projectId: body.projectId,
            requestId: REQUEST_ID,
            artifactKind: 'pdf',
            renderer: 'chromium',
            pageCount: 5,
            qualityGate: { passed: true, findings: [] },
            artifactReference: PDF_REFERENCE,
            materializationProof: PROOF_SECRET,
          },
        };
      },
    },
    async () => {
      const result = await rpc('render_article_pdf', { site_id: SITE_ID, content_item_id: REQUEST_ID });
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
      return result.structuredContent!;
    }
  );

  // 1. The job carried MAPPED render data (JOIN A) shaped to the TEMPLATE's
  //    schema, plus the site's brand (D-3) and the hero as a job asset.
  assert.ok(jobBody, 'a job must have been created');
  const data = jobBody!.data as Record<string, unknown>;
  assert.equal(data.title, 'What moisturizers actually do');
  assert.equal(data.deck, 'Most moisturizers perform three basic jobs.');
  assert.ok(Array.isArray(data.sections) && (data.sections as unknown[]).length >= 1);
  assert.deepEqual(data.brand, {
    colors: { primary: '#2E5C42' },
    fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' },
  });
  const assets = jobBody!.assets as { images: { assetId: string; blobKey: string }[] };
  assert.equal(assets.images[0]!.blobKey, `image/${REQUEST_ID}/${HERO_SHA}.webp`);
  assert.equal(data.coverImage, assets.images[0]!.assetId);
  // D-1 resolved the template from site.pdf; D-4 the filename from the slug.
  assert.equal(jobBody!.templateId, 'article_brochure_v1');
  assert.equal(jobBody!.filename, 'what-moisturizers-actually-do.pdf');

  // 2. The receipt.
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.rendered, true);
  assert.equal(receipt.attached, true);
  assert.equal(receipt.jobId, 'job_render_1');
  assert.equal(receipt.pageCount, 5);
  assert.deepEqual(receipt.attachment, {
    nodeId: 'n_close',
    field: 'media',
    mode: 'append',
    href: PDF_PATH,
  });
  assert.ok(Array.isArray(receipt.unfilled), 'the mapper report must reach the receipt');
  assert.ok((receipt.unfilled as string[]).includes('missing:sources'));

  // 3. The article really changed, and the media type was INFERRED, not
  //    authored: nothing in this file ever wrote `type: 'document'`.
  const nodes = await readArticleNodes();
  const attached = nodes.find((node) => node.id === 'n_close');
  const media = (attached!.public as { media: Record<string, unknown> }).media;
  assert.equal(media.type, 'document');
  assert.equal(media.src, PDF_PATH);

  // 4. The article is not left locked by the attach.
  const reopened = await rpc('object_checkout', {
    object_type: 'content_item',
    object_id: REQUEST_ID,
    agent_name: 'test',
  });
  assert.ok(!reopened.isError, JSON.stringify(reopened.structuredContent));
});

test('render_article_pdf: attach=false renders and leaves the article untouched', async () => {
  await resetAndSeed();

  const receipt = await withMockedFetch(
    {
      get_pdf_template: TEMPLATE_ROUTE,
      create_agent_artifact_job: (body) => ({
        status: 202,
        body: { jobId: 'job_dry', status: 'pending', projectId: body.projectId, requestId: body.requestId },
      }),
      get_agent_artifact_job_status: (body) => ({
        body: {
          jobId: 'job_dry',
          status: 'complete',
          projectId: body.projectId,
          requestId: REQUEST_ID,
          artifactReference: PDF_REFERENCE,
          materializationProof: PROOF_SECRET,
        },
      }),
    },
    async () => {
      const result = await rpc('render_article_pdf', {
        site_id: SITE_ID,
        content_item_id: REQUEST_ID,
        attach: false,
      });
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
      return result.structuredContent!;
    }
  );

  assert.equal(receipt.rendered, true);
  assert.equal(receipt.attached, false);
  assert.deepEqual(receipt.attachSkipped, { reason: 'not_requested', detail: '' });

  const nodes = await readArticleNodes();
  for (const node of nodes) {
    assert.equal((node.public as Record<string, unknown>).media, undefined, 'no node may have gained media');
  }
});

test('render_article_pdf: a typed pdf-tool failure surfaces as itself and attaches nothing', async () => {
  await resetAndSeed();

  const receipt = await withMockedFetch(
    {
      get_pdf_template: TEMPLATE_ROUTE,
      create_agent_artifact_job: (body) => ({
        status: 202,
        body: { jobId: 'job_bad', status: 'pending', projectId: body.projectId, requestId: body.requestId },
      }),
      get_agent_artifact_job_status: (body) => ({
        body: {
          jobId: 'job_bad',
          status: 'failed',
          projectId: body.projectId,
          requestId: REQUEST_ID,
          errorCode: 'RENDER_DATA_INVALID',
          error: 'data.sections must NOT have fewer than 1 items',
        },
      }),
    },
    async () => {
      const result = await rpc('render_article_pdf', { site_id: SITE_ID, content_item_id: REQUEST_ID });
      assert.ok(!result.isError, 'a typed render failure is a RECEIPT, not a tool error');
      return result.structuredContent!;
    }
  );

  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.attached, false);
  assert.deepEqual(receipt.error, {
    code: 'RENDER_DATA_INVALID',
    message: 'data.sections must NOT have fewer than 1 items',
  });
  assert.equal(receipt.jobId, 'job_bad');

  const nodes = await readArticleNodes();
  for (const node of nodes) {
    assert.equal((node.public as Record<string, unknown>).media, undefined);
  }
});

test('render_article_pdf: a job that never finishes returns a pending receipt with the job id', async () => {
  await resetAndSeed();

  const receipt = await withMockedFetch(
    {
      get_pdf_template: TEMPLATE_ROUTE,
      create_agent_artifact_job: (body) => ({
        status: 202,
        body: { jobId: 'job_slow', status: 'pending', projectId: body.projectId, requestId: body.requestId },
      }),
      get_agent_artifact_job_status: (body) => ({
        body: { jobId: 'job_slow', status: 'running', projectId: body.projectId, requestId: REQUEST_ID },
      }),
    },
    async () => {
      const result = await rpc('render_article_pdf', { site_id: SITE_ID, content_item_id: REQUEST_ID });
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
      return result.structuredContent!;
    }
  );

  assert.equal(receipt.status, 'pending', 'never a false claim of success');
  assert.equal(receipt.rendered, false);
  assert.equal(receipt.attached, false);
  assert.equal(receipt.jobId, 'job_slow', 'the job id comes back so nothing is orphaned');
  assert.deepEqual(receipt.polling, {
    tool: 'get_agent_artifact_job_status',
    input: { site_id: SITE_ID, request_id: REQUEST_ID },
  });
});

test('render_article_pdf: no storage grant, blobKey or sha ever reaches the receipt', async () => {
  await resetAndSeed();

  const receipt = await withMockedFetch(
    {
      get_pdf_template: TEMPLATE_ROUTE,
      create_agent_artifact_job: (body) => ({
        status: 202,
        body: { jobId: 'job_leak', status: 'pending', projectId: body.projectId, requestId: body.requestId },
      }),
      get_agent_artifact_job_status: (body) => ({
        body: {
          jobId: 'job_leak',
          status: 'complete',
          projectId: body.projectId,
          requestId: REQUEST_ID,
          artifactReference: PDF_REFERENCE,
          materializationProof: PROOF_SECRET,
        },
      }),
    },
    async () => {
      const result = await rpc('render_article_pdf', { site_id: SITE_ID, content_item_id: REQUEST_ID });
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
      return result.structuredContent!;
    }
  );

  const asText = JSON.stringify(receipt);
  assert.equal(asText.includes(STORAGE_SECRET), false);
  assert.equal(asText.includes(RUN_SECRET), false);
  assert.equal(asText.includes(PROOF_SECRET), false);
  // The ONLY place a sha appears is the article's own public artifact path,
  // carried in the two fields that exist to carry it: `attachment.href` (the
  // link target the editor clicks, and the value written into the article body)
  // and `public_path` (the same value under the name every other bridge tool
  // already returns it as). Never as prose, and never as the storage blobKey it
  // is derived from. Everything else must be sha-free and blobKey-free.
  assert.equal(receipt.attachment !== undefined, true);
  assert.equal(receipt.public_path, PDF_PATH);
  assert.equal((receipt.attachment as { href: string }).href, receipt.public_path, 'one value, two fields');
  const withoutPaths = JSON.stringify({ ...receipt, attachment: undefined, public_path: undefined });
  assert.equal(/[0-9a-f]{64}/.test(withoutPaths), false, 'no sha outside the artifact path fields');
  assert.equal(withoutPaths.includes(PDF_REFERENCE.blobKey), false, 'no blobKey may appear');
  assert.equal(String(receipt.summary).includes('/pdf/'), false, 'and never as prose in the summary');
  assert.equal(asText.includes('artifactReference'), false, 'the raw artifact reference never rides a receipt');
});

test('validate_pdf_render_data and get_pdf_render_brand answer without rendering anything', async () => {
  await resetAndSeed();

  await withMockedFetch({ get_pdf_template: TEMPLATE_ROUTE }, async () => {
    const bad = await rpc('validate_pdf_render_data', {
      site_id: SITE_ID,
      template_id: 'article_brochure_v1',
      data: { title: 'x', coverImage: 'cover' },
    });
    assert.ok(!bad.isError, JSON.stringify(bad.structuredContent));
    assert.equal(bad.structuredContent!.valid, false);
    assert.equal(bad.structuredContent!.schemaSource, 'template');
    // Required slots missing, and the named asset is not supplied.
    const errors = bad.structuredContent!.errors as { keyword: string; message: string }[];
    assert.ok(errors.some((entry) => entry.keyword === 'required' && entry.message.includes('sections')));
    assert.deepEqual(bad.structuredContent!.missingAssetIds, ['cover']);

    const good = await rpc('validate_pdf_render_data', {
      site_id: SITE_ID,
      template_id: 'article_brochure_v1',
      data: {
        brand: { colors: { primary: '#2E5C42' }, fonts: { sans: 'Inter' } },
        title: 'x',
        sections: [{ heading: 'h', paragraphs: ['p'] }],
        coverImage: 'cover',
      },
      assets: { images: [{ assetId: 'cover', blobKey: `image/${REQUEST_ID}/${HERO_SHA}.webp` }] },
    });
    assert.equal(good.structuredContent!.valid, true);
    assert.equal(good.structuredContent!.authoritative, true);

    const brand = await rpc('get_pdf_render_brand', { site_id: SITE_ID, template_id: 'article_brochure_v1' });
    assert.ok(!brand.isError, JSON.stringify(brand.structuredContent));
    assert.equal(brand.structuredContent!.hasBrandTokens, true);
    assert.equal(brand.structuredContent!.brandSlot, 'object');
    assert.deepEqual(brand.structuredContent!.injected, {
      brand: { colors: { primary: '#2E5C42' }, fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' } },
    });
  });

  // Without a template, both candidate payloads are shown and the slot rule
  // is stated rather than guessed at.
  const brandOnly = await rpc('get_pdf_render_brand', { site_id: SITE_ID });
  assert.equal(brandOnly.structuredContent!.brandName, 'Dr. Lurié');
  assert.equal(brandOnly.structuredContent!.brandSlot, undefined);
  assert.match(String(brandOnly.structuredContent!.note), /the TEMPLATE decides its TYPE/);
});

// ── W2 review: ruling D-D, end to end ───────────────────────────────────────
//
// T2.5 built the `pdf_quality` criterion and left its resolver unwired, because
// nothing persisted a verdict a SYNCHRONOUS `object_validate` could read back.
// D-D was therefore a ruling with no implementation: the warning could never
// appear, in production or anywhere else.
//
// This is the loop, closed, through the real dispatch: a render whose quality
// gate has findings still ATTACHES (D-A), files its verdict under the PDF's own
// artifact key, and the very next `validate_content_item` on that article reads
// it back as a WARNING that is not a blocker (D-D). Then a clean re-render under
// a new sha leaves no verdict, and the criterion goes silent rather than
// inheriting the previous PDF's.

const jobRoutes = (opts: { sha: string; qualityGate: Record<string, unknown> }): Record<string, PdfToolMcpRoute> => ({
  get_pdf_template: TEMPLATE_ROUTE,
  create_agent_artifact_job: (body) => ({
    status: 202,
    body: { jobId: 'job_dd', status: 'pending', projectId: body.projectId, requestId: body.requestId },
  }),
  get_agent_artifact_job_status: (body) => ({
    body: {
      jobId: 'job_dd',
      status: 'complete',
      projectId: body.projectId,
      requestId: REQUEST_ID,
      artifactKind: 'pdf',
      pageCount: 5,
      qualityGate: opts.qualityGate,
      artifactReference: { ...PDF_REFERENCE, blobKey: `pdf/${REQUEST_ID}/${opts.sha}.pdf`, sha256: opts.sha },
      materializationProof: PROOF_SECRET,
    },
  }),
});

const criterion = (result: ToolResult, id: string) => {
  const groups = (result.structuredContent?.validation as { criteria?: { id: string; status: string; message?: string }[] }[]) ?? [];
  for (const group of groups) {
    for (const entry of group.criteria ?? []) if (entry.id === id) return entry;
  }
  return undefined;
};

test('D-D: a render with quality-gate findings attaches, and the NEXT validate warns about it', async () => {
  await resetAndSeed();
  await rm(join(LOCAL_BLOBS_ROOT, 'artifact-index'), { recursive: true, force: true });

  const receipt = await withMockedFetch(
    jobRoutes({
      sha: PDF_SHA,
      qualityGate: {
        passed: false,
        findings: [
          { code: 'BLANK_PAGE', page: 3, detail: 'Page 3 has 0 characters of extracted text.' },
          { code: 'UNRESOLVED_IMAGE', page: 2, detail: 'asset figure-n_close did not resolve' },
        ],
      },
    }),
    async () => {
      const result = await rpc('render_article_pdf', { site_id: SITE_ID, content_item_id: REQUEST_ID });
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
      return result.structuredContent!;
    }
  );

  // D-A holds: findings warn, the PDF still attached.
  assert.equal(receipt.attached, true);
  assert.equal(receipt.qualityGatePassed, false);

  // D-D: the verdict is now readable by a plain, synchronous validation.
  const validated = await rpc('validate_content_item', { object_id: REQUEST_ID });
  assert.ok(!validated.isError, JSON.stringify(validated.structuredContent));
  const quality = criterion(validated, 'pdf_quality');
  assert.ok(quality, `pdf_quality must be reported: ${JSON.stringify(validated.structuredContent)}`);
  assert.equal(quality!.status, 'warning');
  assert.match(String(quality!.message), /no readable body text/);
  assert.match(String(quality!.message), /never blocks/);

  // …and it is a WARNING, not a blocker: the article stays publishable.
  const summary = validated.structuredContent!.summary as
    | { blockers?: { id: string }[]; warnings?: { id: string }[]; eligible?: boolean }
    | undefined;
  assert.equal(summary?.eligible, true, 'a PDF-quality warning must never make an article ineligible');
  assert.equal((summary?.blockers ?? []).some((entry) => entry.id === 'pdf_quality'), false);
  assert.equal((summary?.warnings ?? []).some((entry) => entry.id === 'pdf_quality'), true);
  assert.equal(JSON.stringify(validated.structuredContent).includes(PDF_SHA), false, 'no sha in the readable report');
});

test('D-D: a clean re-render leaves no verdict, and the criterion goes silent rather than inheriting the old one', async () => {
  await resetAndSeed();
  await rm(join(LOCAL_BLOBS_ROOT, 'artifact-index'), { recursive: true, force: true });

  await withMockedFetch(
    jobRoutes({ sha: PDF_SHA, qualityGate: { passed: false, findings: [{ code: 'BLANK_PAGE', page: 3, detail: 'blank' }] } }),
    async () => rpc('render_article_pdf', { site_id: SITE_ID, content_item_id: REQUEST_ID })
  );
  assert.equal(criterion(await rpc('validate_content_item', { object_id: REQUEST_ID }), 'pdf_quality')?.status, 'warning');

  const cleanSha = 'b'.repeat(64);
  await withMockedFetch(jobRoutes({ sha: cleanSha, qualityGate: { passed: true, findings: [] } }), async () => {
    const result = await rpc('render_article_pdf', { site_id: SITE_ID, content_item_id: REQUEST_ID });
    assert.ok(!result.isError, JSON.stringify(result.structuredContent));
    assert.equal((result.structuredContent!.attachment as { href: string }).href, `/pdf/${REQUEST_ID}/${cleanSha}.pdf`);
  });

  // A clean gate is not proof of a clean document, so nothing is claimed for the
  // new PDF — and the OLD PDF's warning does not follow it either.
  assert.equal(criterion(await rpc('validate_content_item', { object_id: REQUEST_ID }), 'pdf_quality'), undefined);
});
