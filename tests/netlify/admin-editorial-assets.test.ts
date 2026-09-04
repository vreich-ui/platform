import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/admin-editorial-assets.js';
import { getArtifactIndexBlobStore } from '../../packages/core/server/lib/blob-store.js';
import { writeArtifactReferenceIndexes } from '../../packages/core/server/lib/artifact-index.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { stubPdfToolMcp } from './pdf-tool-mcp-fetch-stub.js';

const ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'admin-editorial-assets');
setLocalBlobsRootForTesting(ROOT);

test('admin editorial assets returns sanitized PDF templates and indexed media', async () => {
  await rm(ROOT, { recursive: true, force: true });
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.ADMIN_EMAILS = 'owner@example.com';
  process.env.PDF_TOOL_STORAGE_TOKEN = 'storage-secret-never-return';
  process.env.PDF_TOOL_STORAGE_SITE_ID = 'private-storage-site';
  process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool.test';
  process.env.PDF_TOOL_AGENT_RUN_TOKEN = 'bridge-secret-never-return';

  const sha = 'c'.repeat(64);
  const index = await getArtifactIndexBlobStore({});
  await writeArtifactReferenceIndexes(index, 'req_editorial_asset_20260807_01', {
    blobKey: `pdf/req_editorial_asset_20260807_01/${sha}.pdf`,
    sha256: sha,
    sizeBytes: 1800,
    contentType: 'application/pdf',
    createdAtISO: '2026-08-07T10:00:00.000Z',
    artifactKind: 'pdf',
    originalFilename: 'evidence-guide.pdf',
    label: 'Evidence guide',
    metadata: {
      templateId: 'tpl_evidence_guide',
      pageCount: 2,
      renderDataRef: { storeName: 'pdf-render-data', blobKey: 'private-render-input' },
    },
  });

  // D4 fix (task A5): tpl_evidence_guide carries the FULL new field set —
  // kind/thumbnailKey/thumbnailError/renderDataSchema — proving the bridge
  // forwards all of them end to end; tpl_legacy_no_thumbnail (right below)
  // carries NONE of them, proving an older-shaped pdf-tool row still comes
  // through with has_render_data_schema: false and no crash.
  const renderDataSchema = { type: 'object', properties: { headline: { type: 'string' } }, required: ['headline'] };
  const originalFetch = globalThis.fetch;
  const { fetchImpl } = stubPdfToolMcp({
    list_pdf_templates: () => ({
      body: {
        templates: [
          {
            templateId: 'tpl_evidence_guide',
            latestVersion: 2,
            latestActiveVersion: 1,
            status: 'active',
            renderer: 'pdfme',
            kind: 'guide',
            thumbnailKey: 'image/tpl_evidence_guide/thumb.png',
            thumbnailError: 'thumbnail render timed out',
            renderDataSchema,
            storage: { token: 'upstream-secret' },
          },
          {
            templateId: 'tpl_legacy_no_thumbnail',
            latestVersion: 1,
            status: 'draft',
            renderer: 'pdfme',
          },
        ],
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const response = await handler(
      { httpMethod: 'GET', headers: {} },
      { clientContext: { user: { sub: 'owner-1', email: 'owner@example.com' } } }
    );
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as {
      pdf_templates: Array<Record<string, unknown>>;
      artifacts: Array<Record<string, unknown>>;
      pdf_templates_available: boolean;
    };
    assert.equal(body.pdf_templates_available, true);
    const evidenceGuide = body.pdf_templates.find((template) => template.id === 'tpl_evidence_guide');
    assert.equal(evidenceGuide?.kind, 'guide');
    assert.equal(evidenceGuide?.thumbnail_key, 'image/tpl_evidence_guide/thumb.png');
    assert.equal(evidenceGuide?.thumbnail_error, 'thumbnail render timed out');
    assert.deepEqual(evidenceGuide?.render_data_schema, renderDataSchema);
    assert.equal(evidenceGuide?.has_render_data_schema, true);

    // The fixture without any D4/§3.6 fields must still project cleanly:
    // has_render_data_schema defaults to false, and none of the optional
    // fields are fabricated.
    const legacy = body.pdf_templates.find((template) => template.id === 'tpl_legacy_no_thumbnail');
    assert.equal(legacy?.has_render_data_schema, false);
    assert.equal(legacy?.kind, undefined);
    assert.equal(legacy?.thumbnail_key, undefined);
    assert.equal(legacy?.thumbnail_error, undefined);
    assert.equal(legacy?.render_data_schema, undefined);

    assert.equal(body.artifacts[0]?.label, 'Evidence guide');
    assert.match(String(body.artifacts[0]?.preview_url), /admin-get-blob-pdf/);
    const visible = JSON.stringify(body);
    assert.doesNotMatch(visible, /storage-secret-never-return|bridge-secret-never-return|upstream-secret/);
    assert.doesNotMatch(visible, /pdf-render-data|private-render-input|private-storage-site/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('admin editorial assets rejects unauthenticated requests', async () => {
  const response = await handler({ httpMethod: 'GET', headers: {} });
  assert.equal(response.statusCode, 401);
});
