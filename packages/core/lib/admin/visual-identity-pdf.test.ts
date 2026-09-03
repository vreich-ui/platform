/**
 * U1 acceptance: the default badge and the set-default op payload, plus the
 * rest of the PDF tab's decisions. Logic-first `node:test` over the pure
 * module — the panel component is excluded from `tsconfig.test.json`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { EditorialArtifact } from './editorial-assets.js';
import {
  buildPdfTemplatesViewModel,
  buildPinKindDefaultOp,
  buildRenderSampleIntent,
  buildSetSiteDefaultOp,
  latestSampleArtifact,
  pdfDefaultBadges,
  pdfKindLabel,
  pdfValidationView,
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

test('a row missing the §3.6 fields degrades honestly instead of faking them', () => {
  const row = buildPdfTemplatesViewModel({ templates: [template({ id: 'tpl_article' })], canEdit: true }).rows[0]!;
  assert.equal(row.kind, undefined);
  assert.equal(row.kindLabel, 'Unclassified');
  assert.equal(row.thumbnailUrl, undefined);
  assert.match(String(row.thumbnailMissingReason), /has not published a thumbnail/);
  assert.equal(row.hasRenderDataSchema, false);
  assert.equal(row.canRenderSample, false);
  assert.match(String(row.renderSampleBlockedReason), /no sample data/);
});

test('an unservable thumbnail key says so rather than rendering a permanently broken image', () => {
  const row = buildPdfTemplatesViewModel({
    templates: [template({ id: 'tpl_article', thumbnail_key: 'pdf/not-an-image-key' })],
  }).rows[0]!;
  assert.equal(row.thumbnailUrl, undefined);
  assert.match(String(row.thumbnailMissingReason), /admin image reader/);
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

test('kind labels humanize an open key set', () => {
  assert.equal(pdfKindLabel('article'), 'Article');
  assert.equal(pdfKindLabel('case_study'), 'Case study');
  assert.equal(pdfKindLabel(undefined), 'Unclassified');
});

// ─── render sample ──────────────────────────────────────────────────────────

test('the render-sample intent names the tool and lets the agent read sampleData itself', () => {
  const intent = buildRenderSampleIntent({ id: 'tpl_article', label: 'Article brochure' });
  assert.equal(intent.tool, 'create_agent_artifact_job');
  assert.equal(intent.starter, 'visual-identity');
  assert.match(intent.prompt, /tpl_article/);
  assert.match(intent.prompt, /get_pdf_template/);
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
