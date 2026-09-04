/**
 * T2.6 acceptance: the article inspector's PDF card, decided entirely here —
 * `ArticlePdfCard.tsx` renders this module's output and adds no logic of its
 * own (this repo has no DOM/component test stack; `tsconfig.test.json`
 * excludes `packages/core/admin/**\/*.tsx`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatEventView } from './chat-client.js';
import {
  articlePdfActionsForState,
  buildArticlePdfCardView,
  buildArticlePdfPrompt,
  buildDetachPdfOp,
  deriveArticlePdfState,
  describeQualityFinding,
  describeQualityGate,
  extractLatestArticlePdfJob,
  extractLatestArticlePdfVerification,
  findAttachedPdf,
  hasQualityGateReport,
  redactArticlePdfText,
  type ArticlePdfJobRecord,
  type ArticlePdfNodeLike,
} from './article-pdf-card.js';

const SHA = 'a'.repeat(64);
const ATTACHMENT = { nodeId: 'n_pdf1', href: `/pdf/req_123/${SHA}.pdf`, via: 'media' as const };

const job = (over: Partial<ArticlePdfJobRecord> = {}): ArticlePdfJobRecord => ({
  jobId: 'job_1',
  status: 'complete',
  ...over,
});

// ─── the five states, from realistic inputs (acceptance) ───────────────────

test('nothing attached and no job in flight is "none"', () => {
  assert.deepEqual(deriveArticlePdfState({}), { state: 'none' });
});

test('a job in flight is "rendering" regardless of what is already attached', () => {
  assert.equal(deriveArticlePdfState({ job: job({ status: 'pending' }) }).state, 'rendering');
  assert.equal(deriveArticlePdfState({ job: job({ status: 'running' }) }).state, 'rendering');
  assert.equal(
    deriveArticlePdfState({ attachment: ATTACHMENT, verification: { verified: true }, job: job({ status: 'running' }) })
      .state,
    'rendering',
    'a re-render over an already-verified PDF is still "rendering" until it settles'
  );
});

test('a job that failed is "failed", carrying its own reason', () => {
  const result = deriveArticlePdfState({ job: job({ status: 'failed', error: { message: 'Template asset missing.' } }) });
  assert.deepEqual(result, { state: 'failed', reason: 'Template asset missing.' });
});

test('a failed job with no reported message still gets a reason, never a bare "failed"', () => {
  const result = deriveArticlePdfState({ job: job({ status: 'failed' }) });
  assert.equal(result.state, 'failed');
  assert.match(String(result.reason), /render attempt failed/);
});

test('attached + verified is "verified"', () => {
  assert.deepEqual(deriveArticlePdfState({ attachment: ATTACHMENT, verification: { verified: true } }), {
    state: 'verified',
  });
});

test('attached + never verified is "attached-unverified" — a real state, not an error', () => {
  assert.deepEqual(deriveArticlePdfState({ attachment: ATTACHMENT }), { state: 'attached-unverified' });
});

test('a job that COMPLETED WITH quality-gate findings still resolves attached-unverified, never failed', () => {
  // D-A / W1: the gate warns, it never blocks. A job can complete carrying
  // findings — this is the brief's explicit "attached with warnings is a
  // real and common state, not an error state."
  const withFindings = job({
    status: 'complete',
    qualityGate: { passed: false, findings: [{ code: 'BLANK_PAGE', page: 3 }] },
  });
  const result = deriveArticlePdfState({ attachment: ATTACHMENT, job: withFindings });
  assert.equal(result.state, 'attached-unverified');
  assert.equal(result.reason, undefined, 'quality-gate findings are not a failure reason');
});

test('a negative verification is "failed", even though a PDF is still attached', () => {
  const result = deriveArticlePdfState({ attachment: ATTACHMENT, verification: { verified: false, reason: 'Blank pages.' } });
  assert.deepEqual(result, { state: 'failed', reason: 'Blank pages.' });
});

test('a negative verification with no reason still gets one', () => {
  const result = deriveArticlePdfState({ attachment: ATTACHMENT, verification: { verified: false } });
  assert.match(String(result.reason), /unusable/);
});

test('an unrecognized in-flight-ish status still reads as settled, not stuck rendering forever', () => {
  // Defensive: an unknown status string must not silently disable every action.
  assert.equal(deriveArticlePdfState({ attachment: ATTACHMENT, job: job({ status: 'complete' }) }).state, 'attached-unverified');
});

// ─── the action set per state (acceptance) ──────────────────────────────────

test('"none" offers only Make PDF', () => {
  assert.deepEqual(
    articlePdfActionsForState('none').map((a) => a.id),
    ['make_pdf']
  );
});

test('"rendering" offers nothing — nothing else is actionable mid-job', () => {
  assert.deepEqual(articlePdfActionsForState('rendering'), []);
});

test('"attached-unverified" offers Verify, Re-render and Detach', () => {
  assert.deepEqual(
    articlePdfActionsForState('attached-unverified').map((a) => a.id),
    ['verify', 're_render', 'detach']
  );
});

test('"verified" offers Re-render and Detach, not Verify again', () => {
  assert.deepEqual(
    articlePdfActionsForState('verified').map((a) => a.id),
    ['re_render', 'detach']
  );
});

test('"failed" offers Re-render and Detach, not Verify', () => {
  assert.deepEqual(
    articlePdfActionsForState('failed').map((a) => a.id),
    ['re_render', 'detach']
  );
});

test('every action carries a human label', () => {
  for (const action of articlePdfActionsForState('attached-unverified')) {
    assert.equal(typeof action.label, 'string');
    assert.ok(action.label.length > 0);
  }
});

// ─── quality-gate findings → readable strings, no blobKeys/SHAs (acceptance) ─

test('a BLANK_PAGE finding reads as a sentence naming the page', () => {
  assert.equal(describeQualityFinding({ code: 'BLANK_PAGE', page: 4 }), 'Page 4 rendered with no body text.');
});

test('an UNRESOLVED_IMAGE finding names the asset id (asset ids are allowed, brief §1) but never a blobKey', () => {
  const text = describeQualityFinding({ code: 'UNRESOLVED_IMAGE', page: 2, assetId: 'hero_shot' });
  assert.match(text, /hero_shot/);
  assert.doesNotMatch(text, /\//);
});

test('an UNRENDERED_TOKEN finding names the token', () => {
  assert.match(describeQualityFinding({ code: 'UNRENDERED_TOKEN', token: '{{deck}}' }), /\{\{deck\}\}/);
});

test('an unknown finding code still renders something readable rather than a bare enum', () => {
  const text = describeQualityFinding({ code: 'SOME_NEW_CODE', page: 1 });
  assert.match(text, /some new code/);
  assert.match(text, /page 1/);
});

test('a finding message carrying a blobKey or a sha256 is redacted before it reaches a human', () => {
  const leaky = `Image at pdf/req_9/${'b'.repeat(64)}.webp failed to fetch`;
  const text = describeQualityFinding({ code: 'WEIRD', message: leaky });
  assert.doesNotMatch(text, /pdf\/req_9/);
  assert.doesNotMatch(text, new RegExp('b'.repeat(64)));
  assert.match(text, /reference removed/);
});

test('describeQualityGate lists every finding, then every engine warning, and nothing when there is no job', () => {
  assert.deepEqual(describeQualityGate(undefined), []);
  const lines = describeQualityGate({
    qualityGate: { passed: false, findings: [{ code: 'BLANK_PAGE', page: 1 }] },
    warnings: ['Font fallback applied on page 2.'],
  });
  assert.deepEqual(lines, ['Page 1 rendered with no body text.', 'Font fallback applied on page 2.']);
});

test('hasQualityGateReport is false for a clean job and true the moment there is anything to show', () => {
  assert.equal(hasQualityGateReport(job({ qualityGate: { passed: true, findings: [] } })), false);
  assert.equal(hasQualityGateReport(job({ warnings: ['note'] })), true);
});

test('redactArticlePdfText strips blobKey shapes and sha256 hashes independent of finding code', () => {
  const text = redactArticlePdfText(`See image/req_1/${'c'.repeat(64)}.png and ${SHA}`);
  assert.doesNotMatch(text, /image\/req_1/);
  assert.doesNotMatch(text, new RegExp(SHA));
});

// ─── attachment detection off the article body ─────────────────────────────

test('finds a document media node whose src is a public /pdf/ path', () => {
  const nodes: ArticlePdfNodeLike[] = [
    { id: 'n_a', public: { body: 'text' } as never },
    { id: 'n_b', public: { media: { type: 'document', src: `/pdf/req_1/${SHA}.pdf` } } },
  ];
  assert.deepEqual(findAttachedPdf(nodes), { nodeId: 'n_b', href: `/pdf/req_1/${SHA}.pdf`, via: 'media' });
});

test('an image media node never counts as an attached PDF', () => {
  const nodes: ArticlePdfNodeLike[] = [{ id: 'n_a', public: { media: { type: 'image', src: '/img/req_1/x.webp' } } }];
  assert.equal(findAttachedPdf(nodes), undefined);
});

test('a ctaLink pointing at /pdf/ counts when there is no document media node', () => {
  const nodes: ArticlePdfNodeLike[] = [{ id: 'n_a', public: { ctaLink: `/pdf/req_1/${SHA}.pdf` } }];
  assert.deepEqual(findAttachedPdf(nodes), { nodeId: 'n_a', href: `/pdf/req_1/${SHA}.pdf`, via: 'ctaLink' });
});

test('no nodes, or nodes with neither shape, is "not attached"', () => {
  assert.equal(findAttachedPdf(undefined), undefined);
  assert.equal(findAttachedPdf([{ id: 'n_a', public: {} }]), undefined);
});

// ─── detach: an ordinary content patch ──────────────────────────────────────

test('detaching a media attachment clears public.media and nothing else', () => {
  assert.deepEqual(buildDetachPdfOp({ nodeId: 'n_b', via: 'media' }), {
    op: 'update_node',
    node_id: 'n_b',
    fields: { public: { media: null } },
  });
});

test('detaching a ctaLink attachment clears public.ctaLink, not media', () => {
  assert.deepEqual(buildDetachPdfOp({ nodeId: 'n_a', via: 'ctaLink' }), {
    op: 'update_node',
    node_id: 'n_a',
    fields: { public: { ctaLink: null } },
  });
});

test('detach refuses a blank node id rather than writing a broken patch', () => {
  assert.throws(() => buildDetachPdfOp({ nodeId: '  ', via: 'media' }), /node id is required/);
});

// ─── chat prompts name the tool, never invent state ─────────────────────────

test('every chat-driven action prompt names its content item and its tool, and disclaims the gate as non-blocking', () => {
  const makePdf = buildArticlePdfPrompt('make_pdf', { contentItemId: 'ci_1' });
  assert.match(makePdf, /render_article_pdf/);
  assert.match(makePdf, /ci_1/);
  assert.match(makePdf, /never block/);

  const reRender = buildArticlePdfPrompt('re_render', { contentItemId: 'ci_1', templateId: 'tpl_x' });
  assert.match(reRender, /render_article_pdf/);
  assert.match(reRender, /tpl_x/);

  const verify = buildArticlePdfPrompt('verify', { contentItemId: 'ci_1' });
  assert.match(verify, /verify_pdf_content/);
});

// ─── reading job/verification off the chat transcript ──────────────────────

const toolResult = (seq: number, tool: string, output: unknown, isError = false): ChatEventView => ({
  seq,
  at: '2026-09-04T00:00:00.000Z',
  type: 'tool_result',
  detail: { tool, output: JSON.stringify(output), is_error: isError },
});

test('extractLatestArticlePdfJob reads the newest matching tool_result, ignoring unrelated tools', () => {
  const events: ChatEventView[] = [
    toolResult(1, 'patch', { ok: true }),
    toolResult(2, 'render_article_pdf', { jobId: 'job_1', status: 'running' }),
    toolResult(3, 'render_article_pdf', {
      jobId: 'job_1',
      status: 'complete',
      qualityGate: { passed: false, findings: [{ code: 'BLANK_PAGE', page: 2 }] },
      warnings: ['Fell back to Noto Sans.'],
    }),
  ];
  const record = extractLatestArticlePdfJob(events);
  assert.equal(record?.status, 'complete');
  assert.equal(record?.qualityGate?.passed, false);
  assert.deepEqual(record?.warnings, ['Fell back to Noto Sans.']);
});

test('extractLatestArticlePdfJob treats an errored tool CALL as a failed job', () => {
  const events: ChatEventView[] = [toolResult(1, 'render_article_pdf', { error: 'boom' }, true)];
  const record = extractLatestArticlePdfJob(events);
  assert.equal(record?.status, 'failed');
  assert.match(String(record?.error?.message), /render request failed/);
});

test('extractLatestArticlePdfJob returns undefined when this chat has never seen a matching tool', () => {
  assert.equal(extractLatestArticlePdfJob([toolResult(1, 'patch', { ok: true })]), undefined);
  assert.equal(extractLatestArticlePdfJob([]), undefined);
});

test('extractLatestArticlePdfJob is defensive against a malformed body rather than throwing', () => {
  const events: ChatEventView[] = [{ seq: 1, at: '', type: 'tool_result', detail: { tool: 'render_article_pdf', output: 'not json' } }];
  assert.equal(extractLatestArticlePdfJob(events), undefined);
});

/**
 * W2 REVIEW. `normalizeJobStatus` used to fall through to 'complete' for any
 * status word it did not recognize — including a body carrying no `status` at
 * all. That is the "UI must never claim a state it can't prove" violation in
 * its purest form: an unknown state rendered as a finished one, offering
 * Verify/Detach over a PDF the card has no evidence exists. Unknown is now
 * 'pending' ("rendering", no actions, resolves on the next poll).
 */
test('an unknown or absent job status reads as still rendering, never as complete', () => {
  for (const body of [
    { jobId: 'job_x' },
    { jobId: 'job_x', status: 'dispatched' },
    { jobId: 'job_x', status: '' },
    { jobId: 'job_x', status: 42 },
  ]) {
    const record = extractLatestArticlePdfJob([toolResult(1, 'render_article_pdf', body)]);
    assert.equal(record?.status, 'pending', `status ${JSON.stringify(body.status)} must not read as complete`);
    assert.equal(deriveArticlePdfState({ job: record }).state, 'rendering');
    assert.deepEqual(articlePdfActionsForState('rendering'), []);
  }
  // The words it DOES know still read as themselves.
  for (const [status, expected] of [
    ['complete', 'complete'],
    ['completed', 'complete'],
    ['succeeded', 'complete'],
    ['failed', 'failed'],
    ['queued', 'pending'],
  ] as const) {
    const record = extractLatestArticlePdfJob([toolResult(1, 'render_article_pdf', { jobId: 'job_y', status })]);
    assert.equal(record?.status, expected);
  }
});

test('extractLatestArticlePdfVerification reads the newest verify_pdf_content result', () => {
  const events: ChatEventView[] = [
    toolResult(1, 'verify_pdf_content', { verified: false, reason: 'old check' }),
    toolResult(2, 'verify_pdf_content', { verified: true, checkedAt: '2026-09-04T00:00:00.000Z' }),
  ];
  assert.deepEqual(extractLatestArticlePdfVerification(events), {
    verified: true,
    checkedAt: '2026-09-04T00:00:00.000Z',
  });
});

test('extractLatestArticlePdfVerification treats an errored verify call as unverified with a reason', () => {
  const events: ChatEventView[] = [toolResult(1, 'verify_pdf_content', {}, true)];
  assert.deepEqual(extractLatestArticlePdfVerification(events), { verified: false, reason: 'Verification could not run.' });
});

// ─── the assembled view ─────────────────────────────────────────────────────

test('buildArticlePdfCardView never exposes the href as text, only as a link target field', () => {
  const view = buildArticlePdfCardView({ attachment: ATTACHMENT, verification: { verified: true } });
  assert.equal(view.state, 'verified');
  assert.equal(view.openHref, ATTACHMENT.href);
  assert.deepEqual(view.actions.map((a) => a.id), ['re_render', 'detach']);
});

test('buildArticlePdfCardView surfaces quality-gate lines and the passed flag together', () => {
  const view = buildArticlePdfCardView({
    attachment: ATTACHMENT,
    job: job({ qualityGate: { passed: false, findings: [{ code: 'BLANK_PAGE', page: 1 }] } }),
  });
  assert.equal(view.state, 'attached-unverified');
  assert.equal(view.qualityGatePassed, false);
  assert.deepEqual(view.qualityGateLines, ['Page 1 rendered with no body text.']);
});

test('buildArticlePdfCardView on "none" carries no href and no quality lines', () => {
  const view = buildArticlePdfCardView({});
  assert.equal(view.state, 'none');
  assert.equal(view.openHref, undefined);
  assert.deepEqual(view.qualityGateLines, []);
  assert.deepEqual(view.actions.map((a) => a.id), ['make_pdf']);
});
