/**
 * U1 acceptance: the default badge and the set-default op payload, plus the
 * rest of the PDF tab's decisions. Logic-first `node:test` over the pure
 * module — the panel component is excluded from `tsconfig.test.json`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { EditorialArtifact } from './editorial-assets.js';
import {
  SAMPLE_RENDER_MAX_POLLS,
  buildPdfTemplatesViewModel,
  buildPinKindDefaultOp,
  buildSetSiteDefaultOp,
  latestSampleArtifact,
  pdfDefaultBadges,
  pdfKindLabel,
  pdfKindOptions,
  pdfValidationView,
  sampleRenderWaitState,
  type PdfTemplateInput,
} from './visual-identity-pdf.js';

const template = (over: Partial<PdfTemplateInput> & { id: string }): PdfTemplateInput => ({
  label: over.label ?? over.id,
  status: 'active',
  renderer: 'chromium',
  version: 2,
  active_version: 1,
  ...over,
});

const THUMB = `image/req_thumb/${'b'.repeat(64)}.png`;

// ─── the default badge (acceptance) ─────────────────────────────────────────

test('the site default wears the site badge and nothing else does', () => {
  const sitePdf = { defaultTemplateId: 'tpl_article' };
  assert.deepEqual(pdfDefaultBadges('tpl_article', sitePdf), [
    { label: 'Site default', tone: 'success', scope: 'site' },
  ]);
  assert.deepEqual(pdfDefaultBadges('tpl_guide', sitePdf), []);
});

test('a kind pin gets its own badge, named for the kind', () => {
  assert.deepEqual(
    pdfDefaultBadges('tpl_guide', { defaultTemplateId: 'tpl_article', byKind: { guide: 'tpl_guide' } }),
    [{ label: 'Default for guide', tone: 'info', scope: 'kind', kind: 'guide' }]
  );
});

test('one template can be both the site default and a kind pin — both facts show', () => {
  // site.pdf carries two independent pointers (§3.2); collapsing them to one
  // badge would hide a pin the reader has to know about before repointing it.
  assert.deepEqual(
    pdfDefaultBadges('tpl_article', {
      defaultTemplateId: 'tpl_article',
      byKind: { article: 'tpl_article', checklist: 'tpl_article' },
    }),
    [
      { label: 'Site default', tone: 'success', scope: 'site' },
      { label: 'Default for article', tone: 'info', scope: 'kind', kind: 'article' },
      { label: 'Default for checklist', tone: 'info', scope: 'kind', kind: 'checklist' },
    ]
  );
});

test('no site.pdf block at all means no badges anywhere', () => {
  assert.deepEqual(pdfDefaultBadges('tpl_article', undefined), []);
  assert.deepEqual(pdfDefaultBadges('tpl_article', {}), []);
});

test('the view model reads site.pdf off the site body and flags a dangling default', () => {
  const model = buildPdfTemplatesViewModel({
    templates: [template({ id: 'tpl_article', label: 'Article brochure', kind: 'article' })],
    siteBody: { name: 'Demo', pdf: { defaultTemplateId: 'tpl_gone', byKind: { article: 'tpl_article' } } },
    canEdit: true,
  });
  assert.equal(model.defaultTemplateId, 'tpl_gone');
  assert.equal(
    model.danglingDefault,
    'tpl_gone',
    'a default pointing at a template pdf-tool no longer lists is a fault to surface'
  );
  assert.deepEqual(model.byKind, [{ kind: 'article', templateId: 'tpl_article', resolved: true }]);
  assert.equal(model.rows[0]?.isSiteDefault, false);
  assert.equal(model.rows[0]?.isKindDefault, true);
});

// The clear affordance: a dangling default can be cleared exactly as it can
// be re-pointed — the op layer (`buildSetSiteDefaultOp(null)`) already
// supports it, only the panel used to omit any way to reach it.
test('the clear-default affordance is available for a dangling default, Owner-gated the same way canSetDefault is', () => {
  const owner = buildPdfTemplatesViewModel({
    templates: [template({ id: 'tpl_article' })],
    siteBody: { pdf: { defaultTemplateId: 'tpl_gone' } },
    canEdit: true,
  });
  assert.equal(owner.canClearDefault, true);
  assert.equal(owner.clearDefaultBlockedReason, undefined);

  const notOwner = buildPdfTemplatesViewModel({
    templates: [template({ id: 'tpl_article' })],
    siteBody: { pdf: { defaultTemplateId: 'tpl_gone' } },
    canEdit: false,
  });
  assert.equal(notOwner.canClearDefault, false);
  assert.match(String(notOwner.clearDefaultBlockedReason), /Owner/);
});

// Point 5: clearing must also be reachable when the default is set AND
// valid — not only when it is dangling.
test('the clear-default affordance is also available for a valid, non-dangling default', () => {
  const model = buildPdfTemplatesViewModel({
    templates: [template({ id: 'tpl_article' })],
    siteBody: { pdf: { defaultTemplateId: 'tpl_article' } },
    canEdit: true,
  });
  assert.equal(model.danglingDefault, undefined, 'this default is valid — not dangling');
  assert.equal(model.canClearDefault, true);
});

test('there is nothing to clear when no site default is set at all', () => {
  const model = buildPdfTemplatesViewModel({
    templates: [template({ id: 'tpl_article' })],
    canEdit: true,
  });
  assert.equal(model.canClearDefault, false);
  assert.match(String(model.clearDefaultBlockedReason), /no site default/);
});

// ─── the set-default op payload (acceptance) ────────────────────────────────

test('set-as-site-default writes only defaultTemplateId, so kind pins survive the merge', () => {
  // set_site_fields DEEP-MERGES (object-patch-ops.ts); writing the whole pdf
  // block would silently drop a byKind pin the human never touched.
  assert.deepEqual(buildSetSiteDefaultOp('tpl_article'), {
    op: 'set_site_fields',
    fields: { pdf: { defaultTemplateId: 'tpl_article' } },
  });
});

test('the set-default op refuses an empty id rather than writing a broken pointer', () => {
  assert.throws(() => buildSetSiteDefaultOp('   '), /template id is required/);
  assert.throws(() => buildSetSiteDefaultOp(''), /template id is required/);
});

test('null clears the site default — the same unset marker buildPinKindDefaultOp already uses', () => {
  assert.deepEqual(buildSetSiteDefaultOp(null), {
    op: 'set_site_fields',
    fields: { pdf: { defaultTemplateId: null } },
  });
});

test('pinning a kind touches one key inside byKind, and null clears it', () => {
  assert.deepEqual(buildPinKindDefaultOp('guide', 'tpl_guide'), {
    op: 'set_site_fields',
    fields: { pdf: { byKind: { guide: 'tpl_guide' } } },
  });
  assert.deepEqual(buildPinKindDefaultOp('guide', null), {
    op: 'set_site_fields',
    fields: { pdf: { byKind: { guide: null } } },
  });
  assert.throws(() => buildPinKindDefaultOp('', 'tpl_guide'), /content kind is required/);
});

// ─── validation status ──────────────────────────────────────────────────────

test('validation status reports what the list row actually proves', () => {
  assert.equal(pdfValidationView({ status: 'active', active_version: 3 }).state, 'published');
  assert.match(pdfValidationView({ status: 'active', active_version: 3 }).label, /v3/);
  assert.equal(pdfValidationView({ status: 'active' }).state, 'draft');
  assert.equal(pdfValidationView({ status: 'draft' }).state, 'draft');
  assert.equal(pdfValidationView({ status: 'disabled', active_version: 2 }).state, 'disabled');
  assert.equal(pdfValidationView({ status: 'unknown' }).state, 'unknown');
});

test('only a published template can become a default, and only an editor can set one', () => {
  const model = buildPdfTemplatesViewModel({
    templates: [
      template({ id: 'tpl_published', kind: 'article' }),
      template({ id: 'tpl_draft', status: 'draft', active_version: undefined }),
      template({ id: 'tpl_off', status: 'disabled' }),
    ],
    canEdit: true,
  });
  assert.equal(model.rows[0]?.canSetDefault, true);
  assert.equal(model.rows[1]?.canSetDefault, false);
  assert.match(String(model.rows[1]?.setDefaultBlockedReason), /published/);
  assert.equal(model.rows[2]?.canSetDefault, false);

  const readOnly = buildPdfTemplatesViewModel({ templates: [template({ id: 'tpl_published' })], canEdit: false });
  assert.equal(readOnly.rows[0]?.canSetDefault, false);
  assert.match(String(readOnly.rows[0]?.setDefaultBlockedReason), /Owner/);
});

// ─── §3.6's additive fields, present and absent ─────────────────────────────

test('kind, thumbnail and sample data light up the row when pdf-tool sends them', () => {
  const model = buildPdfTemplatesViewModel({
    templates: [
      template({
        id: 'tpl_article',
        label: 'Article brochure',
        kind: 'article',
        thumbnail_key: THUMB,
        render_data_schema: { type: 'object' },
        sample_data: { title: 'Sample' },
      }),
    ],
    canEdit: true,
  });
  const row = model.rows[0]!;
  assert.equal(row.kindLabel, 'Article');
  assert.match(String(row.thumbnailUrl), /admin-get-blob-image/);
  assert.equal(row.hasRenderDataSchema, true);
  assert.equal(row.canRenderSample, true);
  assert.equal(row.renderSampleBlockedReason, undefined);
});

// D2 fix: `thumbnail_key` genuinely absent from the row (no property at all —
// e.g. a pre-thumbnailing pdf-tool deploy, or some other shape gap upstream
// of this function) is a WEAKER, shape-level fact than pdf-tool explicitly
// reporting `thumbnailKey: null`, and must not be worded as if pdf-tool told
// us anything about this template's thumbnail state.
test('a row missing the §3.6 fields degrades honestly instead of faking them', () => {
  const row = buildPdfTemplatesViewModel({ templates: [template({ id: 'tpl_article' })], canEdit: true }).rows[0]!;
  assert.equal(row.kind, undefined);
  assert.equal(row.kindLabel, 'Unclassified');
  assert.equal(row.thumbnailUrl, undefined);
  assert.match(String(row.thumbnailMissingReason), /did not report a thumbnail_key/);
  assert.doesNotMatch(String(row.thumbnailMissingReason), /has not published a thumbnail/);
  assert.equal(row.hasRenderDataSchema, false);
  assert.equal(row.canRenderSample, false);
  assert.match(String(row.renderSampleBlockedReason), /no sample data/);
});

// D2 fix: `thumbnail_key: null` is pdf-tool's OWN report ("no thumbnail"),
// distinct from the field being absent above — this is the one case that may
// honestly say "pdf-tool has not published a thumbnail yet".
test('D2: an explicit thumbnail_key: null is pdf-tool\'s own report, worded as such', () => {
  const row = buildPdfTemplatesViewModel({
    templates: [template({ id: 'tpl_article', thumbnail_key: null })],
  }).rows[0]!;
  assert.equal(row.thumbnailUrl, undefined);
  assert.equal(row.thumbnailMissingReason, 'pdf-tool has not published a thumbnail for this template yet.');
});

test('T2.6: a real thumbnailError from pdf-tool beats this module\'s own generic guess', () => {
  const row = buildPdfTemplatesViewModel({
    templates: [template({ id: 'tpl_article', thumbnail_error: 'Chromium render timed out before the thumbnail step.' })],
  }).rows[0]!;
  assert.equal(row.thumbnailUrl, undefined);
  assert.equal(row.thumbnailMissingReason, 'Chromium render timed out before the thumbnail step.');
});

// D2 fix: thumbnail_error still wins even when a (rejected) key is ALSO
// present — pdf-tool's own reason is more useful than restating the key's
// shape problem.
test('D2: thumbnail_error beats an also-present, also-unservable thumbnail_key', () => {
  const row = buildPdfTemplatesViewModel({
    templates: [
      template({
        id: 'tpl_article',
        thumbnail_key: 'pdf/not-an-image-key',
        thumbnail_error: 'The render completed, but the render service returned no thumbnail image.',
      }),
    ],
  }).rows[0]!;
  assert.equal(row.thumbnailMissingReason, 'The render completed, but the render service returned no thumbnail image.');
});

test('D1: a pdf-tool template thumbnail key now resolves to a real endpoint instead of the unservable-key excuse', () => {
  const { rows } = buildPdfTemplatesViewModel({
    templates: [template({ id: 'tpl_article', thumbnail_key: 'thumbnails/tpl_article/v3.png' })],
  });
  assert.match(String(rows[0]?.thumbnailUrl), /admin-get-blob-image/);
  assert.match(String(rows[0]?.thumbnailUrl), /thumbnails%2Ftpl_article%2Fv3\.png/);
  assert.equal(rows[0]?.thumbnailMissingReason, undefined);
});

// D2 fix: a present-but-unservable key means the KEY'S SHAPE is wrong (not
// that pdf-tool published nothing) — the message must surface the offending
// key rather than a generic "not servable" excuse. Now that the gate accepts
// pdf-tool's full safeSegment id charset, a dotted id is NOT one of these any
// more (see the test below it); what remains is a `.`/`..` segment, a
// non-numeric version, a wrong extension, or extra path segments.
test('an unservable thumbnail key names the key and explains the shape it needed', () => {
  for (const key of [
    'thumbnails/../v3.png',
    'thumbnails/./v3.png',
    'thumbnails/a..b/v3.png',
    'thumbnails/tpl_article/vlatest.png',
    'thumbnails/tpl_article/v3.svg',
    'thumbnails/tpl_article/nested/v3.png',
  ]) {
    const row = buildPdfTemplatesViewModel({
      templates: [template({ id: 'tpl_article', thumbnail_key: key })],
    }).rows[0]!;
    assert.equal(row.thumbnailUrl, undefined, `must not build a preview URL for ${key}`);
    const reason = String(row.thumbnailMissingReason);
    assert.match(reason, /admin image reader/);
    // The offending key is quoted verbatim, whatever it is.
    assert.ok(reason.includes(`"${key}"`), `must quote ${key}`);
    // …and the message names what is actually refused now.
    assert.match(reason, /"\.\." or containing "\.\."/);
    assert.match(reason, /not digits/);
    assert.match(reason, /other than \.png/);
    assert.match(reason, /extra path segment/);
    // It must no longer claim a dotted template id is unservable.
    assert.doesNotMatch(reason, /containing a dot/);
  }
});

// The widening this message now describes: pdf-tool's safeSegment keeps dots,
// so `drlurie.article.v1` is a real template id and its thumbnail previews.
test('a dotted pdf-tool template id previews instead of earning the unservable-key message', () => {
  const row = buildPdfTemplatesViewModel({
    templates: [template({ id: 'drlurie.article.v1', thumbnail_key: 'thumbnails/drlurie.article.v1/v3.png' })],
  }).rows[0]!;
  assert.match(String(row.thumbnailUrl), /admin-get-blob-image/);
  assert.match(String(row.thumbnailUrl), /thumbnails%2Fdrlurie\.article\.v1%2Fv3\.png/);
  assert.equal(row.thumbnailMissingReason, undefined);
});

test('a published template with sample data still cannot render while it is a draft', () => {
  const row = buildPdfTemplatesViewModel({
    templates: [template({ id: 'tpl_draft', status: 'draft', active_version: undefined, sample_data: { a: 1 } })],
  }).rows[0]!;
  assert.equal(row.canRenderSample, false);
  assert.match(String(row.renderSampleBlockedReason), /Publish the template/);
});

// ─── empty states ───────────────────────────────────────────────────────────

test('an empty list distinguishes "none yet" from "the bridge is not configured"', () => {
  assert.match(String(buildPdfTemplatesViewModel({ templates: [] }).emptyState?.title), /No PDF templates yet/);
  const unavailable = buildPdfTemplatesViewModel({ templates: [], available: false });
  assert.match(String(unavailable.emptyState?.title), /unavailable/);
  assert.equal(unavailable.available, false);
});

test('T2.6: byKind selector options cover every known kind plus any open kind actually in use', () => {
  const options = pdfKindOptions([{ kind: 'article' }, { kind: 'case_study' }, { kind: undefined }]);
  assert.deepEqual(
    options.map((o) => o.kind),
    ['article', 'brochure', 'case_study', 'checklist', 'guide', 'report'].sort()
  );
  assert.equal(options.find((o) => o.kind === 'case_study')?.label, 'Case study');
});

test('kind labels humanize an open key set', () => {
  assert.equal(pdfKindLabel('article'), 'Article');
  assert.equal(pdfKindLabel('case_study'), 'Case study');
  assert.equal(pdfKindLabel(undefined), 'Unclassified');
});

test('the newest rendered PDF for a template is what the stage previews', () => {
  const artifact = (id: string, templateId: string | undefined, createdAt: string): EditorialArtifact => ({
    id,
    kind: 'pdf',
    family: 'documents',
    label: id,
    filename: `${id}.pdf`,
    preview_url: `/.netlify/functions/admin-get-blob-pdf?blobKey=pdf/${id}`,
    created_at: createdAt,
    size_bytes: 10,
    tags: [],
    ...(templateId ? { template_id: templateId } : {}),
  });
  const artifacts = [
    artifact('old', 'tpl_article', '2026-08-01T00:00:00.000Z'),
    artifact('new', 'tpl_article', '2026-08-09T00:00:00.000Z'),
    artifact('other', 'tpl_guide', '2026-08-20T00:00:00.000Z'),
    artifact('untemplated', undefined, '2026-08-30T00:00:00.000Z'),
  ];
  assert.equal(latestSampleArtifact('tpl_article', artifacts)?.id, 'new');
  assert.equal(latestSampleArtifact('tpl_missing', artifacts), undefined);
});

/**
 * W5 F7: `create_agent_artifact_job`'s inline wait has a budget, and the
 * endpoint answers 202 with a job id when it runs out. The panel used to
 * announce "a sample of X was rendered" for exactly that case — no artifact,
 * nothing to poll, and clicking again paid for a second render.
 */
test('a render that outlived the inline wait is waited on, then given up on out loud', () => {
  assert.equal(sampleRenderWaitState(true, 0), 'landed');
  assert.equal(sampleRenderWaitState(true, SAMPLE_RENDER_MAX_POLLS + 10), 'landed');
  assert.equal(sampleRenderWaitState(false, 0), 'waiting');
  assert.equal(sampleRenderWaitState(false, SAMPLE_RENDER_MAX_POLLS - 1), 'waiting');
  assert.equal(sampleRenderWaitState(false, SAMPLE_RENDER_MAX_POLLS), 'gave_up');
  assert.equal(sampleRenderWaitState(false, 2, 3), 'waiting');
  assert.equal(sampleRenderWaitState(false, 3, 3), 'gave_up');
});
