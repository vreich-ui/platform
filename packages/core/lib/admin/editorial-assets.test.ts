import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  artifactsByFamily,
  classifyMediaFamily,
  projectEditorialArtifact,
  projectPdfTemplate,
} from './editorial-assets.js';

describe('editorial asset projection', () => {
  it('projects only safe PDF-template summary fields', () => {
    const projected = projectPdfTemplate({
      templateId: 'tpl_evidence_guide',
      latestVersion: 3,
      latestActiveVersion: 2,
      status: 'active',
      renderer: 'pdfme',
      createdAt: '2026-08-07T10:00:00.000Z',
      storage: { token: 'never-expose', stores: { templates: 'pdf-templates' } },
      templateJson: { private: true },
    });
    assert.deepStrictEqual(projected, {
      id: 'tpl_evidence_guide',
      label: 'Evidence Guide',
      status: 'active',
      renderer: 'pdfme',
      version: 3,
      active_version: 2,
      created_at: '2026-08-07T10:00:00.000Z',
      has_render_data_schema: false,
    });
    assert.doesNotMatch(JSON.stringify(projected), /never-expose|pdf-templates|templateJson/);
  });

  // FIX-U1: kind/renderDataSchema/sampleData/thumbnailKey (BRIEF §3.6) used
  // to be dropped by the whitelist, leaving U1's thumbnail/kind/render-sample
  // affordances permanently dark. They must now forward — while `storage`
  // (and anything else not named) still does not, so this stays a whitelist,
  // never a passthrough.
  //
  // D4 fix (task A5): thumbnailError and has_render_data_schema join the
  // forwarded set — pdf-tool's `list_pdf_templates` already returns both
  // (thumbnailError alongside thumbnailKey, per pdf-tool's
  // `pdf-template-store.ts`), but the bridge dropped them, so the admin PDF
  // tab could never show WHY a thumbnail was missing, nor cheaply badge
  // "has a render-data schema" without shipping the whole schema object.
  it('forwards kind/renderDataSchema/sampleData/thumbnailKey/thumbnailError when the upstream row carries them, and still drops storage', () => {
    const schema = { type: 'object', properties: { headline: { type: 'string' } }, required: ['headline'] };
    const projected = projectPdfTemplate({
      templateId: 'tpl_article_brochure',
      latestVersion: 1,
      status: 'active',
      renderer: 'chromium',
      kind: 'article',
      thumbnailKey: 'image/tpl_article_brochure/thumb.png',
      thumbnailError: 'render worker timed out after 30s',
      renderDataSchema: schema,
      sampleData: { headline: 'A sample headline' },
      storage: { token: 'never-expose' },
    });
    assert.deepStrictEqual(projected, {
      id: 'tpl_article_brochure',
      label: 'Article Brochure',
      status: 'active',
      renderer: 'chromium',
      version: 1,
      kind: 'article',
      thumbnail_key: 'image/tpl_article_brochure/thumb.png',
      thumbnail_error: 'render worker timed out after 30s',
      render_data_schema: schema,
      has_render_data_schema: true,
      sample_data: { headline: 'A sample headline' },
    });
    assert.doesNotMatch(JSON.stringify(projected), /never-expose/);
  });

  // D4 fix (task A5): a template whose only thumbnail state is "not attempted
  // yet" — thumbnailKey null, no thumbnailError — is not an error case; it
  // must forward has_render_data_schema: false and nothing else new, same as
  // the fully-legacy row below.
  it('reports has_render_data_schema: false and no thumbnail_error when pdf-tool sends thumbnailKey: null with no error', () => {
    const projected = projectPdfTemplate({
      templateId: 'tpl_pending_thumbnail',
      latestVersion: 1,
      status: 'draft',
      renderer: 'chromium',
      thumbnailKey: null,
    });
    assert.deepStrictEqual(projected, {
      id: 'tpl_pending_thumbnail',
      label: 'Pending Thumbnail',
      status: 'draft',
      renderer: 'chromium',
      version: 1,
      has_render_data_schema: false,
    });
  });

  // D4 fix (task A5): the defensiveness the field additions are FOR — an
  // older pdf-tool deploy that predates label/kind/thumbnailKey/
  // thumbnailError/renderDataSchema entirely must not crash and must not
  // fabricate any of them; has_render_data_schema is the one field that is
  // always present regardless, and must compute to false here.
  it('omits every optional §3.6/D4 field when the upstream row predates them all, and still returns has_render_data_schema: false', () => {
    const projected = projectPdfTemplate({
      templateId: 'tpl_legacy',
      latestVersion: 1,
      status: 'active',
      renderer: 'pdfme',
    });
    assert.deepStrictEqual(projected, {
      id: 'tpl_legacy',
      label: 'Legacy',
      status: 'active',
      renderer: 'pdfme',
      version: 1,
      has_render_data_schema: false,
    });
  });

  it('never exposes a UUID as a PDF template label', () => {
    const projected = projectPdfTemplate({
      templateId: 'e43c0e58-f68b-4ff5-8e8b-9d3c6c5a1b90',
      latestVersion: 2,
    });
    assert.equal(projected?.label, 'PDF template');
  });

  it('projects an artifact to an authenticated preview without leaking raw metadata', () => {
    const sha = 'a'.repeat(64);
    const projected = projectEditorialArtifact({
      blobKey: `pdf/req_evidence/${sha}.pdf`,
      sha256: sha,
      contentType: 'application/pdf',
      sizeBytes: 1200,
      createdAtISO: '2026-08-07T10:00:00.000Z',
      artifactKind: 'pdf',
      originalFilename: 'evidence-guide.pdf',
      label: 'Evidence guide',
      tags: ['guide'],
      metadata: {
        templateId: 'tpl_evidence_guide',
        pageCount: 4,
        renderDataRef: { storeName: 'pdf-render-data', blobKey: 'secret-internal-ref' },
      },
    });
    assert.equal(projected?.family, 'documents');
    assert.equal(projected?.template_id, 'tpl_evidence_guide');
    assert.equal(projected?.page_count, 4);
    assert.match(projected?.preview_url ?? '', /admin-get-blob-pdf/);
    assert.doesNotMatch(JSON.stringify(projected), /pdf-render-data|secret-internal-ref/);
  });

  it('uses human media fallbacks instead of checksum-derived filenames', () => {
    const sha = 'c'.repeat(64);
    const artifact = projectEditorialArtifact({
      blobKey: `pdf/request-1/${sha}.pdf`,
      sha256: sha,
      contentType: 'application/pdf',
      sizeBytes: 10,
      createdAtISO: '2026-08-09T00:00:00.000Z',
      artifactKind: 'pdf',
    });
    assert.equal(artifact?.label, 'Untitled PDF document');
    assert.equal(artifact?.filename, 'PDF document');
  });
});

describe('media grouping', () => {
  it('groups recognized visual roles and uses editorial as the calm fallback', () => {
    assert.equal(classifyMediaFamily({ kind: 'image', filename: 'brand-wordmark.svg' }), 'logos');
    assert.equal(classifyMediaFamily({ kind: 'image', tags: ['sku', 'product'] }), 'product');
    assert.equal(classifyMediaFamily({ kind: 'image', label: 'Routine diagram' }), 'illustrations');
    assert.equal(classifyMediaFamily({ kind: 'image', label: 'Morning portrait' }), 'editorial');
    assert.equal(classifyMediaFamily({ kind: 'pdf', label: 'Guide' }), 'documents');
  });

  it('returns every stable family with honest counts, including empty groups', () => {
    const sha = 'b'.repeat(64);
    const artifact = projectEditorialArtifact({
      blobKey: `image/req_product/${sha}.webp`,
      sha256: sha,
      contentType: 'image/webp',
      sizeBytes: 500,
      createdAtISO: '2026-08-07T10:00:00.000Z',
      artifactKind: 'image',
      label: 'Serum product portrait',
      tags: ['product'],
    });
    assert.ok(artifact);
    const grouped = artifactsByFamily([artifact]);
    assert.equal(grouped.product.length, 1);
    assert.equal(grouped.logos.length, 0);
    assert.equal(grouped.documents.length, 0);
  });
});
