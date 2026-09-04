/**
 * W2 T2.3 — `render_article_pdf`'s decisions, tested against fakes.
 *
 * Every effect is injected, so none of this needs a live pdf-tool, a network,
 * or a clock (BRIEF §4: logic-first, `node:test`, no DOM stack). What is under
 * test is exactly what the brief asks for: given a job status + a quality gate
 * + mapper output, what does the receipt say and does it attach.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildArticlePdfAttachOp,
  buildRenderArticlePdfReceipt,
  readArticlePdfJobView,
  redactPdfReceiptText,
  renderArticlePdf,
  resolveRenderArticlePdfPollBudgetMs,
  selectArticlePdfAttachTarget,
  shouldAttachArticlePdf,
  type ArticleNodeLike,
  type ArticlePdfAttachOp,
  type ArticlePdfJobView,
  type RenderArticlePdfEffects,
} from './article-pdf-render.js';

const REQUEST_ID = 'req_plugin_moisturizer_functions_20260903_01';
const PDF_SHA = 'c'.repeat(64);
const PDF_PATH = `/pdf/${REQUEST_ID}/${PDF_SHA}.pdf`;

const ARTICLE_NODES: ArticleNodeLike[] = [
  { id: 'n_lede', kind: 'content', visibility: 'public', public: { body: 'The moisturizer shelf…' } },
  {
    id: 'n_figure',
    kind: 'content',
    visibility: 'public',
    public: { title: 'Barrier', body: 'copy', media: { type: 'image', src: `/img/${REQUEST_ID}/${'a'.repeat(64)}.webp` } },
  },
  { id: 'n_close', kind: 'content', visibility: 'public', public: { title: 'What to do next', body: 'copy' } },
  { id: 'n_cta', kind: 'action', visibility: 'public', public: { ctaText: 'Book' } },
];

// ─── the fake world ─────────────────────────────────────────────────────────

type FakeWorld = {
  effects: RenderArticlePdfEffects;
  polls: number;
  slept: number[];
  attachOps: ArticlePdfAttachOp[];
  logs: Record<string, unknown>[];
};

const makeWorld = (options: {
  create: ArticlePdfJobView | { error: { code?: string; message: string } };
  /** One entry per poll, in order; the last one repeats. */
  polls?: ArticlePdfJobView[];
  nodes?: ArticleNodeLike[];
  attachFails?: string;
  readNodesFails?: string;
}): FakeWorld => {
  let clock = 0;
  const slept: number[] = [];
  const attachOps: ArticlePdfAttachOp[] = [];
  const logs: Record<string, unknown>[] = [];
  let polls = 0;
  const world = {
    get polls() {
      return polls;
    },
    slept,
    attachOps,
    logs,
  } as FakeWorld;

  world.effects = {
    createJob: async () =>
      'jobId' in options.create
        ? { ok: true as const, value: options.create }
        : { ok: false as const, error: options.create.error },
    pollJob: async () => {
      const list = options.polls ?? [];
      const view = list[Math.min(polls, list.length - 1)];
      polls += 1;
      return view ? { ok: true, value: view } : { ok: false, error: { message: 'no status' } };
    },
    readArticleNodes: async () =>
      options.readNodesFails
        ? { ok: false, error: { message: options.readNodesFails } }
        : { ok: true, value: options.nodes ?? ARTICLE_NODES },
    applyAttach: async (op) => {
      attachOps.push(op);
      return options.attachFails ? { ok: false, error: { message: options.attachFails } } : { ok: true, value: true };
    },
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    log: (entry) => logs.push(entry),
  };
  return world;
};

const completedJob = (over: Partial<ArticlePdfJobView> = {}): ArticlePdfJobView => ({
  jobId: 'job_1',
  status: 'complete',
  templateId: 'article_brochure_v1',
  publicPath: PDF_PATH,
  pageCount: 5,
  unfilled: ['missing:kicker'],
  ...over,
});

const params = (over: Partial<Parameters<typeof renderArticlePdf>[0]> = {}) => ({
  siteId: 'site_drlurie',
  contentItemId: REQUEST_ID,
  attach: true,
  pollBudgetMs: 5_000,
  pollIntervalMs: 1_000,
  polling: { tool: 'get_agent_artifact_job_status', input: { site_id: 'site_drlurie', request_id: REQUEST_ID } },
  ...over,
});

// ─── acceptance ─────────────────────────────────────────────────────────────

test('a clean render attaches, and the receipt names the PDF', async () => {
  const world = makeWorld({
    create: { jobId: 'job_1', status: 'pending', templateId: 'article_brochure_v1', unfilled: ['missing:kicker'] },
    polls: [completedJob()],
  });

  const outcome = await renderArticlePdf(params(), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const receipt = outcome.receipt;

  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.rendered, true);
  assert.equal(receipt.attached, true);
  assert.equal(receipt.jobId, 'job_1');
  assert.equal(receipt.pageCount, 5);
  // Where the PDF now lives, and on which node.
  assert.equal(receipt.attachment?.href, PDF_PATH);
  assert.equal(receipt.attachment?.nodeId, 'n_close');
  assert.equal(receipt.attachment?.field, 'media');
  assert.equal(receipt.attachment?.mode, 'append');
  // What the mapper could not fill survives all the way into the receipt.
  assert.deepEqual(receipt.unfilled, ['missing:kicker']);
  assert.match(receipt.summary, /attached to node n_close/);

  // The op went through media-type inference: no `type` was authored, and
  // 'document' was DERIVED from the .pdf src.
  assert.equal(world.attachOps.length, 1);
  const media = (world.attachOps[0]!.fields.public as { media: Record<string, unknown> }).media;
  assert.equal(media.type, 'document');
  assert.equal(media.src, PDF_PATH);
  assert.equal(world.attachOps[0]!.node_id, 'n_close');
});

test('D-A: a render whose quality gate has findings STILL attaches, and the receipt carries the findings', async () => {
  const gate = {
    passed: false,
    findings: [
      { code: 'BLANK_PAGE', page: 4, message: 'page 4 has no body text' },
      { code: 'UNRESOLVED_IMAGE', page: 2, assetId: 'figure-n_b4r8q1' },
    ],
  };
  const world = makeWorld({
    create: { jobId: 'job_gate', status: 'pending' },
    polls: [completedJob({ jobId: 'job_gate', qualityGate: gate, warnings: ['font fallback applied'] })],
  });

  const outcome = await renderArticlePdf(params(), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const receipt = outcome.receipt;

  // The ruling: WARNS, never blocks.
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.attached, true, 'quality-gate findings must never stop the attach');
  assert.equal(receipt.qualityGatePassed, false);
  assert.equal(receipt.qualityGate?.findings.length, 2);
  assert.equal(receipt.qualityGate?.findings[0]?.code, 'BLANK_PAGE');
  assert.deepEqual(receipt.warnings, ['font fallback applied']);
  assert.equal(receipt.error, undefined, 'a gate finding is not an error');
  assert.match(receipt.summary, /2 findings/);
  assert.match(receipt.summary, /WARN, they do not block/);
});

test('a typed pdf-tool failure surfaces with its own code and attaches nothing', async () => {
  for (const code of ['RENDER_DATA_INVALID', 'ASSET_MISSING', 'DATA_BINDING_ERROR']) {
    const world = makeWorld({
      create: { jobId: 'job_fail', status: 'pending' },
      polls: [
        {
          jobId: 'job_fail',
          status: 'failed',
          error: { code, message: `pdf-tool refused this render (${code}).` },
        },
      ],
    });

    const outcome = await renderArticlePdf(params(), world.effects);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const receipt = outcome.receipt;

    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.rendered, false);
    assert.equal(receipt.attached, false);
    assert.equal(receipt.error?.code, code, 'the typed code surfaces as ITSELF, never flattened');
    assert.equal(receipt.jobId, 'job_fail', 'the job id comes back even on failure');
    assert.equal(receipt.attachSkipped?.reason, 'render_failed');
    assert.equal(world.attachOps.length, 0, 'nothing may be written to the article');
    assert.match(receipt.summary, new RegExp(code));
  }
});

test('a poll timeout returns a receipt with the job id and no false claim of success', async () => {
  const world = makeWorld({
    create: { jobId: 'job_slow', status: 'pending', templateId: 'article_brochure_v1' },
    // Never finishes.
    polls: [{ jobId: 'job_slow', status: 'pending' }],
  });

  const outcome = await renderArticlePdf(params({ pollBudgetMs: 3_000, pollIntervalMs: 1_000 }), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const receipt = outcome.receipt;

  assert.equal(receipt.status, 'pending', 'still rendering is said, not guessed at');
  assert.equal(receipt.rendered, false);
  assert.equal(receipt.attached, false);
  assert.equal(receipt.jobId, 'job_slow', 'the job is never orphaned');
  assert.equal(receipt.attachSkipped?.reason, 'still_rendering');
  assert.equal(receipt.polling?.tool, 'get_agent_artifact_job_status');
  assert.match(receipt.summary, /Still rendering/);
  assert.match(receipt.summary, /nothing has been attached/);
  assert.match(receipt.summary, /the PDF is not lost/);
  // TERMINATION: the loop ended on the budget, it did not spin forever.
  assert.equal(world.polls, 3);
  assert.deepEqual(world.slept, [1000, 1000, 1000]);
  assert.equal(world.attachOps.length, 0);
});

test('attach=false renders and does not touch the article', async () => {
  const world = makeWorld({
    create: { jobId: 'job_dry', status: 'pending' },
    polls: [completedJob({ jobId: 'job_dry' })],
  });

  const outcome = await renderArticlePdf(params({ attach: false }), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const receipt = outcome.receipt;

  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.rendered, true);
  assert.equal(receipt.attached, false);
  assert.equal(receipt.attachSkipped?.reason, 'not_requested');
  assert.equal(world.attachOps.length, 0, 'no patch may be issued');
  assert.match(receipt.summary, /NOT attached/);
  // W2 REVIEW: a receipt that cannot say what it rendered is not a deliverable.
  // `attachment.href` is absent here by definition, so the PDF is named under
  // the same `public_path` field every other bridge tool returns it as.
  assert.equal(receipt.public_path, PDF_PATH);
  assert.match(receipt.summary, /public_path/);
});

test('every completed receipt names the PDF; a pending or failed one names nothing it cannot prove', async () => {
  const attached = await renderArticlePdf(params(), makeWorld({
    create: { jobId: 'job_a', status: 'pending' },
    polls: [completedJob({ jobId: 'job_a' })],
  }).effects);
  assert.equal(attached.ok, true);
  if (!attached.ok) return;
  // Attached: BOTH, and they agree — attachment.href is where it landed on the
  // article, public_path is where the artifact is.
  assert.equal(attached.receipt.public_path, PDF_PATH);
  assert.equal(attached.receipt.attachment?.href, PDF_PATH);

  // Still rendering: nothing to name.
  const pending = await renderArticlePdf(
    { ...params(), pollBudgetMs: 0 },
    makeWorld({ create: { jobId: 'job_p', status: 'pending' } }).effects
  );
  assert.equal(pending.ok, true);
  if (!pending.ok) return;
  assert.equal(pending.receipt.status, 'pending');
  assert.equal(pending.receipt.public_path, undefined);

  // Failed: there is no artifact, so there is no path.
  const failed = await renderArticlePdf(params(), makeWorld({
    create: { jobId: 'job_f', status: 'pending' },
    polls: [{ jobId: 'job_f', status: 'failed', error: { code: 'RENDER_DATA_INVALID', message: 'data did not validate' } }],
  }).effects);
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  assert.equal(failed.receipt.public_path, undefined);
});

// ─── the surrounding decisions ──────────────────────────────────────────────

test('a job that could never be created is a tool error, not a receipt for a job that does not exist', async () => {
  const world = makeWorld({ create: { error: { code: 'artifact_request_not_found', message: 'no such article' } } });
  const outcome = await renderArticlePdf(params(), world.effects);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, 'artifact_request_not_found');
});

test('an existing document node is REPLACED rather than a second PDF appended', async () => {
  const nodes: ArticleNodeLike[] = [
    ...ARTICLE_NODES,
    {
      id: 'n_download',
      kind: 'content',
      visibility: 'public',
      public: { media: { type: 'document', src: `/pdf/${REQUEST_ID}/${'d'.repeat(64)}.pdf` } },
    },
  ];
  const world = makeWorld({
    create: { jobId: 'job_re', status: 'pending' },
    polls: [completedJob({ jobId: 'job_re' })],
    nodes,
  });
  const outcome = await renderArticlePdf(params(), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.receipt.attachment?.nodeId, 'n_download');
  assert.equal(outcome.receipt.attachment?.mode, 'replace');
});

test('an article with nowhere to attach still renders, and says why nothing was attached', async () => {
  const world = makeWorld({
    create: { jobId: 'job_nowhere', status: 'pending' },
    polls: [completedJob({ jobId: 'job_nowhere' })],
    nodes: [{ id: 'n_img', kind: 'content', visibility: 'public', public: { media: { type: 'image', src: '/img/x/y.webp' } } }],
  });
  const outcome = await renderArticlePdf(params(), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.receipt.rendered, true);
  assert.equal(outcome.receipt.attached, false);
  assert.equal(outcome.receipt.attachSkipped?.reason, 'no_attachable_node');
  assert.equal(outcome.receipt.attachment, undefined);
  // The PDF is not lost: the receipt still names the job.
  assert.equal(outcome.receipt.jobId, 'job_nowhere');
});

test('a refused attach is reported, and never reported as attached', async () => {
  const world = makeWorld({
    create: { jobId: 'job_locked', status: 'pending' },
    polls: [completedJob({ jobId: 'job_locked' })],
    attachFails: 'The article is checked out by someone else.',
  });
  const outcome = await renderArticlePdf(params(), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.receipt.attached, false);
  assert.equal(outcome.receipt.attachSkipped?.reason, 'attach_refused');
  assert.match(outcome.receipt.attachSkipped!.detail, /checked out/);
});

test('a transient poll failure does not lose the job, and the loop still terminates', async () => {
  let clock = 0;
  const slept: number[] = [];
  let polls = 0;
  const effects: RenderArticlePdfEffects = {
    createJob: async () => ({ ok: true, value: { jobId: 'job_flaky', status: 'pending' } }),
    pollJob: async () => {
      polls += 1;
      return polls < 3
        ? { ok: false, error: { message: 'pdf-tool hiccup' } }
        : { ok: true, value: completedJob({ jobId: 'job_flaky' }) };
    },
    readArticleNodes: async () => ({ ok: true, value: ARTICLE_NODES }),
    applyAttach: async () => ({ ok: true, value: true }),
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  const outcome = await renderArticlePdf(params({ pollBudgetMs: 10_000, pollIntervalMs: 1_000 }), effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.receipt.status, 'complete');
  assert.equal(outcome.receipt.jobId, 'job_flaky');
  assert.equal(polls, 3);
});

test('the poll response never erases the create call\'s mapper report', async () => {
  const world = makeWorld({
    create: { jobId: 'job_keep', status: 'pending', unfilled: ['missing:deck', 'dropped_figure:n_x'], schemaSource: 'template' },
    // A status poll body carries no renderData at all.
    polls: [{ jobId: 'job_keep', status: 'complete', publicPath: PDF_PATH, pageCount: 3 }],
  });
  const outcome = await renderArticlePdf(params(), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.receipt.unfilled, ['missing:deck', 'dropped_figure:n_x']);
  assert.equal(outcome.receipt.schemaSource, 'template');
});

test('a completed job with no artifact path attaches nothing and does not pretend otherwise', () => {
  assert.equal(shouldAttachArticlePdf(completedJob({ publicPath: undefined }), true), false);
  assert.equal(shouldAttachArticlePdf(completedJob(), false), false);
  assert.equal(shouldAttachArticlePdf(completedJob(), true), true);
  assert.equal(shouldAttachArticlePdf({ jobId: 'j', status: 'pending' }, true), false);
});

// ─── attach-target selection and the media-type discipline ──────────────────

test('the attach target is the last public content node without media of its own', () => {
  const target = selectArticlePdfAttachTarget(ARTICLE_NODES);
  assert.deepEqual(target, { ok: true, nodeId: 'n_close', mode: 'append' });
});

test('a non-public or non-content node is never chosen', () => {
  const target = selectArticlePdfAttachTarget([
    { id: 'n_ok', kind: 'content', visibility: 'public', public: { body: 'x' } },
    { id: 'n_internal', kind: 'content', visibility: 'internal', public: { body: 'x' } },
    { id: 'n_cta', kind: 'action', visibility: 'public', public: {} },
  ]);
  assert.deepEqual(target, { ok: true, nodeId: 'n_ok', mode: 'append' });
});

test('buildArticlePdfAttachOp infers document and refuses what it cannot infer', () => {
  const node = { id: 'n_close', public: { title: 'What to do next' } } as Record<string, unknown>;

  const ok = buildArticlePdfAttachOp(node, PDF_PATH, { title: 'What moisturizers actually do' });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  const media = (ok.op.fields.public as { media: Record<string, unknown> }).media;
  assert.equal(media.type, 'document', 'never defaulted to image — inferred from the .pdf src');
  assert.equal(media.contentType, 'application/pdf');
  assert.equal(media.alt, 'What moisturizers actually do');

  // Not a public PDF artifact path: refused before any write.
  const bad = buildArticlePdfAttachOp(node, '/files/report.pdf');
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.reason, 'invalid_pdf_path');
});

test('a PDF landing on a node whose media was an image re-derives the type instead of keeping a stale image', () => {
  const node = {
    id: 'n_x',
    public: { media: { type: 'image', src: `/img/${REQUEST_ID}/${'a'.repeat(64)}.webp` } },
  } as Record<string, unknown>;
  const built = buildArticlePdfAttachOp(node, PDF_PATH);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const media = (built.op.fields.public as { media: Record<string, unknown> }).media;
  assert.equal(media.type, 'document');
});

/**
 * W2 REVIEW — the re-render trap, on the SHAPE THE REAL ARTICLE HAS.
 *
 * `sites/drlurie/data/site/articles/req_plugin_moisturizer_functions_20260903_01.json`
 * carries its PDF on node `n_k1q6d8`: an `action` node whose `public.ctaLink`
 * IS the download button's href and whose `public.media.sizeBytes` is the size
 * that button prints. `update_node` deep-merges, so an op that only rewrote
 * `media.src` left the button pointing at the PREVIOUS artifact at the
 * PREVIOUS size — a receipt claiming the new PDF was attached over a page that
 * still served the old one.
 */
test('a re-render rewrites the download link and the size, not just the media src', () => {
  const oldPdf = `/pdf/${REQUEST_ID}/${'e'.repeat(64)}.pdf`;
  const node = {
    id: 'n_k1q6d8',
    kind: 'action',
    visibility: 'public',
    public: {
      title: 'Keep the guide handy',
      body: 'A concise five-page version of this article is available to save or print.',
      ctaText: 'Download the PDF guide',
      ctaLink: oldPdf,
      media: { type: 'document', src: oldPdf, contentType: 'application/pdf', sizeBytes: 28934 },
    },
  } as Record<string, unknown>;

  const built = buildArticlePdfAttachOp(node, PDF_PATH, { title: 'What moisturizers actually do', sizeBytes: 41210 });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const pub = built.op.fields.public as Record<string, unknown>;
  const media = pub.media as Record<string, unknown>;
  assert.equal(media.src, PDF_PATH);
  assert.equal(pub.ctaLink, PDF_PATH, 'the download button must not keep pointing at the previous PDF');
  assert.equal(media.sizeBytes, 41210, 'the printed download size must be the NEW artifact\'s');
});

test('a re-render with no known artifact size unsets the stale one rather than keeping it', () => {
  const oldPdf = `/pdf/${REQUEST_ID}/${'e'.repeat(64)}.pdf`;
  const node = {
    id: 'n_k1q6d8',
    public: { ctaLink: oldPdf, media: { type: 'document', src: oldPdf, sizeBytes: 28934 } },
  } as Record<string, unknown>;
  const built = buildArticlePdfAttachOp(node, PDF_PATH);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const media = (built.op.fields.public as { media: Record<string, unknown> }).media;
  assert.equal(media.sizeBytes, null, 'null is the patch engine\'s unset marker — never a stale byte count');
});

test('a ctaLink that is not this attachment\'s PDF is a human editorial choice and is left alone', () => {
  const node = {
    id: 'n_cta',
    public: { ctaText: 'Book a consultation', ctaLink: '/contact', media: { type: 'document', src: PDF_PATH } },
  } as Record<string, unknown>;
  const built = buildArticlePdfAttachOp(node, PDF_PATH);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal((built.op.fields.public as Record<string, unknown>).ctaLink, undefined);
});

test('a first attach onto a plain content node introduces no ctaLink and no invented size', () => {
  const node = { id: 'n_close', public: { title: 'What to do next' } } as Record<string, unknown>;
  const built = buildArticlePdfAttachOp(node, PDF_PATH);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const pub = built.op.fields.public as Record<string, unknown>;
  assert.equal(pub.ctaLink, undefined);
  assert.equal((pub.media as Record<string, unknown>).sizeBytes, undefined);
});

test('readArticlePdfJobView takes the download size from the verified artifactReference', () => {
  const view = readArticlePdfJobView({
    jobId: 'job_s',
    status: 'complete',
    public_path: PDF_PATH,
    artifactReference: { blobKey: `pdf/${REQUEST_ID}/${'c'.repeat(64)}.pdf`, sizeBytes: 41210, sha256: 'c'.repeat(64) },
  });
  assert.equal(view?.sizeBytes, 41210);
  // Nothing else about the reference reaches the view.
  assert.equal(JSON.stringify(view).includes('blobKey'), false);
});

// ─── reading pdf-tool's job body ────────────────────────────────────────────

test('readArticlePdfJobView reads the bridge body defensively and never claims completion it cannot prove', () => {
  assert.equal(readArticlePdfJobView(undefined), undefined);
  assert.equal(readArticlePdfJobView({ status: 'complete' }), undefined, 'no jobId ⇒ no view');

  const unknownStatus = readArticlePdfJobView({ jobId: 'j', status: 'something_new' });
  assert.equal(unknownStatus?.status, 'pending', 'an unknown status is in flight, never complete');
  assert.equal(unknownStatus?.rawStatus, 'something_new');

  const failed = readArticlePdfJobView({
    jobId: 'j',
    status: 'failed',
    errorCode: 'ASSET_MISSING',
    errorDetail: { reason: 'asset cover not resolvable' },
  });
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.error?.code, 'ASSET_MISSING');
  assert.match(failed!.error!.message, /asset cover/);

  const complete = readArticlePdfJobView({
    jobId: 'j',
    status: 'complete',
    public_path: PDF_PATH,
    pageCount: 4,
    qualityGate: { passed: false, findings: [{ code: 'BLANK_PAGE', page: 3, detail: 'no text' }] },
    renderData: { mapped: true, schemaSource: 'template', unfilled: ['missing:deck'] },
  });
  assert.equal(complete?.status, 'complete');
  assert.equal(complete?.publicPath, PDF_PATH);
  assert.equal(complete?.qualityGate?.findings[0]?.message, 'no text');
  assert.deepEqual(complete?.unfilled, ['missing:deck']);
});

// ─── the leak rule ──────────────────────────────────────────────────────────

test('nothing blobKey- or sha-shaped survives into receipt text', () => {
  const sha = 'f'.repeat(64);
  assert.equal(redactPdfReceiptText(`failed on pdf/${REQUEST_ID}/${sha}.pdf`), 'failed on [reference removed]');
  assert.equal(redactPdfReceiptText(`sha ${sha} mismatch`), 'sha [reference removed] mismatch');

  const view = readArticlePdfJobView({
    jobId: 'j',
    status: 'failed',
    errorCode: 'ASSET_MISSING',
    error: `could not resolve image/${REQUEST_ID}/${sha}.webp`,
    warnings: [`blob ${sha} was re-fetched`],
  });
  assert.equal(view?.error?.message.includes(sha), false);
  assert.equal(view?.warnings?.[0]?.includes(sha), false);

  const receipt = buildRenderArticlePdfReceipt({
    siteId: 'site_drlurie',
    contentItemId: REQUEST_ID,
    job: view!,
    attach: { attached: false, reason: 'render_failed', detail: 'no PDF' },
  });
  const asText = JSON.stringify(receipt);
  assert.equal(/[0-9a-f]{64}/.test(asText), false, 'no sha may appear anywhere in a receipt');
  assert.equal(asText.includes('storage'), false);
});

test('the ONE path a receipt carries is the article\'s own public artifact path, in the bridge\'s own two fields', () => {
  const receipt = buildRenderArticlePdfReceipt({
    siteId: 'site_drlurie',
    contentItemId: REQUEST_ID,
    job: completedJob(),
    attach: { attached: true, nodeId: 'n_close', mode: 'append', href: PDF_PATH },
  });
  // Two fields, ONE value, and it is the article's own public artifact path:
  // `attachment.href` says where it landed on the article, `public_path` says
  // where the artifact is (the same name every other bridge tool uses, added by
  // the W2 review so an `attach:false` receipt still names what it rendered).
  assert.equal(receipt.attachment?.href, PDF_PATH);
  assert.equal(receipt.public_path, PDF_PATH);
  // …and nothing else path-shaped anywhere: no blobKey, no store name, and the
  // human-readable `summary` never prints a path as prose.
  assert.equal(
    JSON.stringify({ ...receipt, attachment: undefined, public_path: undefined }).includes('/pdf/'),
    false
  );
  assert.equal(receipt.summary.includes('/pdf/'), false);
});

// ─── the polling budget ─────────────────────────────────────────────────────

test('the poll budget is capped by the invocation deadline and reserves room for the attach', () => {
  // No deadline: the plain default.
  assert.equal(resolveRenderArticlePdfPollBudgetMs(undefined, 0, {}), 20_000);
  // A deadline shorter than the default wins, minus the attach reserve.
  assert.equal(resolveRenderArticlePdfPollBudgetMs(10_000, 0, {}), 7_000);
  // A nearly-expired invocation polls not at all rather than overrunning.
  assert.equal(resolveRenderArticlePdfPollBudgetMs(1_000, 0, {}), 0);
  assert.equal(resolveRenderArticlePdfPollBudgetMs(0, 5_000, {}), 0);
  // Env override, still capped.
  assert.equal(resolveRenderArticlePdfPollBudgetMs(undefined, 0, { PDF_RENDER_ARTICLE_WAIT_MS: '4000' }), 4_000);
  assert.equal(resolveRenderArticlePdfPollBudgetMs(10_000, 0, { PDF_RENDER_ARTICLE_WAIT_MS: '60000' }), 7_000);
  // Garbage falls back to the default rather than to zero or NaN.
  assert.equal(resolveRenderArticlePdfPollBudgetMs(undefined, 0, { PDF_RENDER_ARTICLE_WAIT_MS: 'soon' }), 20_000);
});

test('a zero poll budget still creates the job and returns a pending receipt', async () => {
  const world = makeWorld({ create: { jobId: 'job_zero', status: 'pending' }, polls: [] });
  const outcome = await renderArticlePdf(params({ pollBudgetMs: 0 }), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.receipt.status, 'pending');
  assert.equal(outcome.receipt.jobId, 'job_zero');
  assert.equal(world.polls, 0);
});

test('a job already terminal at creation is not polled at all', async () => {
  const world = makeWorld({ create: completedJob({ jobId: 'job_fast' }), polls: [] });
  const outcome = await renderArticlePdf(params(), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(world.polls, 0);
  assert.equal(outcome.receipt.attached, true);
});
