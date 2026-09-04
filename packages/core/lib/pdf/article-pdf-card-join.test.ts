/**
 * W2 T2.3 — JOIN C: T2.6's admin PDF card, driven by T2.3's actual tool output.
 *
 * T2.6 built `packages/core/lib/admin/article-pdf-card.ts` against tools that
 * did not exist yet, and said so in its own header ("ASSUMED SHAPES — FLAG FOR
 * VERIFICATION"): it reads `render_article_pdf` and `verify_pdf_content`
 * results off the object's chat transcript by NAME, and reads particular
 * fields off their bodies. Nothing checked that those fields exist. This file
 * is that check — the card's real decision modules, fed real receipts built by
 * `article-pdf-render.ts`, with no hand-written fixture in between.
 *
 * FINDINGS (see the T2.3 report): the card's assumptions hold, and the one
 * field it declared but never read (`artifactId`) has since been REMOVED by
 * the W2 review — no receipt carries it (the only id pdf-tool has for a
 * completed PDF is its `{requestId, sha256}` artifact reference, and a sha in
 * agent- or editor-readable text is exactly what BRIEF §1 forbids), and no
 * reader ever consumed it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatEventView } from '../admin/chat-client.js';
import {
  buildArticlePdfCardView,
  extractLatestArticlePdfJob,
  extractLatestArticlePdfVerification,
  findAttachedPdf,
} from '../admin/article-pdf-card.js';
import {
  buildArticlePdfAttachOp,
  buildRenderArticlePdfReceipt,
  type ArticlePdfJobView,
} from './article-pdf-render.js';

const REQUEST_ID = 'req_plugin_moisturizer_functions_20260903_01';
const PDF_PATH = `/pdf/${REQUEST_ID}/${'c'.repeat(64)}.pdf`;

/** A `tool_result` event exactly as the object chat records one. */
const toolResultEvent = (seq: number, tool: string, output: unknown): ChatEventView => ({
  seq,
  at: '2026-09-04T10:00:00.000Z',
  type: 'tool_result',
  detail: { tool, output: JSON.stringify(output) },
});

const receiptFor = (job: ArticlePdfJobView, attached: boolean) =>
  buildRenderArticlePdfReceipt({
    siteId: 'site_drlurie',
    contentItemId: REQUEST_ID,
    job,
    attach: attached
      ? { attached: true, nodeId: 'n_close', mode: 'append', href: PDF_PATH }
      : { attached: false, reason: 'render_failed', detail: 'no PDF to attach' },
  });

test('JOIN C: a clean receipt reads through the card as an attached, unverified PDF', () => {
  const receipt = receiptFor(
    { jobId: 'job_1', status: 'complete', templateId: 'article_brochure_v1', publicPath: PDF_PATH, pageCount: 5 },
    true
  );
  const events = [toolResultEvent(1, 'render_article_pdf', receipt)];

  const job = extractLatestArticlePdfJob(events);
  assert.ok(job, 'the card must be able to read this receipt at all');
  assert.equal(job!.jobId, 'job_1');
  assert.equal(job!.status, 'complete');
  assert.equal(job!.templateId, 'article_brochure_v1');

  // The article, patched by the same op the composite issues.
  const node = { id: 'n_close', public: { title: 'What to do next' } } as Record<string, unknown>;
  const op = buildArticlePdfAttachOp(node, PDF_PATH);
  assert.equal(op.ok, true);
  if (!op.ok) return;
  const media = (op.op.fields.public as { media: Record<string, unknown> }).media;
  const attachment = findAttachedPdf([{ id: 'n_close', public: { media: media as { type?: string; src?: string } } }]);
  assert.deepEqual(attachment, { nodeId: 'n_close', href: PDF_PATH, via: 'media' });

  const view = buildArticlePdfCardView({ attachment, job: job! });
  assert.equal(view.state, 'attached-unverified');
  assert.equal(view.openHref, PDF_PATH);
  assert.deepEqual(
    view.actions.map((action) => action.id),
    ['verify', 're_render', 'detach']
  );
});

test('JOIN C: D-A — a receipt with quality-gate findings still reads as ATTACHED, and the card shows the findings', () => {
  const receipt = receiptFor(
    {
      jobId: 'job_gate',
      status: 'complete',
      publicPath: PDF_PATH,
      qualityGate: {
        passed: false,
        findings: [
          { code: 'BLANK_PAGE', page: 4 },
          { code: 'UNRESOLVED_IMAGE', page: 2, assetId: 'figure-n_b4r8q1' },
        ],
      },
      warnings: ['font fallback applied'],
    },
    true
  );
  const job = extractLatestArticlePdfJob([toolResultEvent(1, 'render_article_pdf', receipt)]);
  assert.ok(job);
  assert.equal(job!.status, 'complete', 'findings must not demote the job to failed');
  assert.equal(job!.qualityGate?.passed, false);

  const view = buildArticlePdfCardView({
    attachment: { nodeId: 'n_close', href: PDF_PATH, via: 'media' },
    job: job!,
  });
  assert.equal(view.state, 'attached-unverified', 'never `failed` — the gate warns (D-A)');
  assert.equal(view.qualityGatePassed, false);
  assert.deepEqual(view.qualityGateLines, [
    'Page 4 rendered with no body text.',
    'An image did not resolve on page 2 (asset figure-n_b4r8q1).',
    'font fallback applied',
  ]);
});

test('JOIN C: a typed failure receipt reads as `failed`, with pdf-tool\'s own message', () => {
  const receipt = receiptFor(
    {
      jobId: 'job_fail',
      status: 'failed',
      error: { code: 'RENDER_DATA_INVALID', message: 'data.sections must NOT have fewer than 1 items' },
    },
    false
  );
  const job = extractLatestArticlePdfJob([toolResultEvent(1, 'render_article_pdf', receipt)]);
  assert.ok(job);
  assert.equal(job!.status, 'failed');
  assert.equal(job!.error?.code, 'RENDER_DATA_INVALID');

  const view = buildArticlePdfCardView({ job: job! });
  assert.equal(view.state, 'failed');
  assert.match(view.reason!, /fewer than 1 items/);
  assert.deepEqual(
    view.actions.map((action) => action.id),
    ['re_render', 'detach']
  );
});

test('JOIN C: a TIMEOUT receipt reads as `rendering`, never as a silent success', () => {
  // This is the join that most easily goes wrong: `normalizeJobStatus` in the
  // card falls back to 'complete' for an unrecognized status word, so a
  // timeout receipt MUST use a status the card knows is in flight.
  const receipt = receiptFor({ jobId: 'job_slow', status: 'pending' }, false);
  assert.equal(receipt.status, 'pending');

  const job = extractLatestArticlePdfJob([toolResultEvent(1, 'render_article_pdf', receipt)]);
  assert.ok(job);
  assert.equal(job!.status, 'pending');

  const view = buildArticlePdfCardView({ job: job! });
  assert.equal(view.state, 'rendering');
  assert.deepEqual(view.actions, [], 'nothing is actionable while a job is in flight');
});

test('JOIN C: verify_pdf_content\'s existing body (T2.4) reads through the card unchanged', () => {
  // T2.4's documentContentCheckToolBody: { siteId, status, verified, ... }.
  const passing = extractLatestArticlePdfVerification([
    toolResultEvent(1, 'verify_pdf_content', {
      siteId: 'site_drlurie',
      status: 'ok',
      verified: true,
      pageCount: 5,
      sizeBytes: 220_114,
    }),
  ]);
  assert.deepEqual(passing, { verified: true });

  const failing = extractLatestArticlePdfVerification([
    toolResultEvent(1, 'verify_pdf_content', {
      siteId: 'site_drlurie',
      status: 'failed',
      verified: false,
      reason: '1 page has no readable body text (page 4).',
      findings: [{ code: 'BLANK_PAGE', page: 4, detail: 'no text' }],
    }),
  ]);
  assert.equal(failing?.verified, false);
  assert.match(failing!.reason!, /no readable body text/);

  const view = buildArticlePdfCardView({
    attachment: { nodeId: 'n_close', href: PDF_PATH, via: 'media' },
    verification: passing!,
  });
  assert.equal(view.state, 'verified');
});

test('JOIN C: no field the card renders as TEXT ever carries a sha or a blobKey', () => {
  const sha = 'e'.repeat(64);
  const receipt = receiptFor(
    {
      jobId: 'job_leak',
      status: 'complete',
      publicPath: PDF_PATH,
      qualityGate: { passed: false, findings: [{ code: 'UNRENDERED_TOKEN', token: 'brand', message: `at pdf/${REQUEST_ID}/${sha}.pdf` }] },
      warnings: [`sha ${sha} reused`],
    },
    true
  );
  const job = extractLatestArticlePdfJob([toolResultEvent(1, 'render_article_pdf', receipt)]);
  const view = buildArticlePdfCardView({
    attachment: { nodeId: 'n_close', href: PDF_PATH, via: 'media' },
    job: job!,
  });
  for (const line of view.qualityGateLines) {
    assert.equal(/[0-9a-f]{64}/.test(line), false, `quality-gate line leaked a sha: ${line}`);
  }
  // openHref is a link TARGET, and is the one place the artifact path appears.
  assert.equal(view.openHref, PDF_PATH);
});
