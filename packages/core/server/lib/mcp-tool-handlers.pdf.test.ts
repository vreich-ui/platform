/**
 * W2 T2.3 — the pdf bridge's two integration joins, proven end to end from the
 * MCP tool input to the bytes that actually leave this process.
 *
 * JOIN B (`create_pdf_template` dropped the contract) is the one that needs a
 * real wire observation rather than a pure unit test: the defect was not a bad
 * decision, it was three fields that existed on the MCP input, existed on
 * pdf-tool's own tool schema, and simply never got written into the request.
 * Only looking at the request body proves that is fixed — so this test stubs
 * `globalThis.fetch` and reads the JSON-RPC arguments the bridge actually
 * posted.
 *
 * No live pdf-tool, no network: the stub answers in-process.
 */
import '../../../../sites/drlurie/config/policy-bindings.js';
// mcp.ts first — see mcp-tool-handlers.test.ts's header for why the import
// order of this documented circular pair matters.
import '../functions/mcp.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { callCreatePdfTemplate } from './mcp-tool-handlers.js';
import { createPlatformPdfTemplate } from './pdf-tool-client.js';

const SITE_ID = 'site_drlurie';

type CapturedCall = { tool: string; args: Record<string, unknown> };

/** Installs a fetch stub that records every pdf-tool JSON-RPC call and
 *  answers with a minimal success envelope. Returns the captured calls and a
 *  restore function. */
const stubPdfTool = (result: Record<string, unknown>) => {
  const calls: CapturedCall[] = [];
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    PDF_TOOL_BASE_URL: process.env.PDF_TOOL_BASE_URL,
    PDF_TOOL_AGENT_RUN_TOKEN: process.env.PDF_TOOL_AGENT_RUN_TOKEN,
    PDF_TOOL_STORAGE_TOKEN: process.env.PDF_TOOL_STORAGE_TOKEN,
    PDF_TOOL_STORAGE_SITE_ID: process.env.PDF_TOOL_STORAGE_SITE_ID,
  };
  process.env.PDF_TOOL_BASE_URL = 'https://pdf-x.invalid';
  process.env.PDF_TOOL_AGENT_RUN_TOKEN = 'test-run-token';
  process.env.PDF_TOOL_STORAGE_TOKEN = 'test-storage-token';
  process.env.PDF_TOOL_STORAGE_SITE_ID = 'netlify-site-under-test';

  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const parsed = JSON.parse(init?.body ?? '{}') as {
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    calls.push({ tool: parsed.params?.name ?? '', args: parsed.params?.arguments ?? {} });
    return {
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: '1',
        result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result },
      }),
    } as unknown as Response;
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
};

const RENDER_DATA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: { title: { type: 'string', minLength: 1, maxLength: 200 } },
};
const SAMPLE_DATA = { title: 'What moisturizers actually do' };
const SAMPLE_ASSETS = { images: [{ assetId: 'cover', blobKey: 'image/req_seed/' + 'a'.repeat(64) + '.webp' }] };

test('JOIN B: create_pdf_template forwards render_data_schema / sample_data / sample_assets to pdf-tool', async () => {
  const stub = stubPdfTool({ templateId: 'article_brochure_v1', version: 1, status: 'draft' });
  try {
    const result = await callCreatePdfTemplate({} as never, {
      site_id: SITE_ID,
      template_json: { html: '<h1>{{ title }}</h1>' },
      renderer: 'chromium',
      template_id: 'article_brochure_v1',
      label: 'Article brochure',
      tags: ['article'],
      render_data_schema: RENDER_DATA_SCHEMA,
      sample_data: SAMPLE_DATA,
      sample_assets: SAMPLE_ASSETS,
    });

    assert.equal((result as { isError?: boolean }).isError, undefined, 'the create must succeed');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]!.tool, 'create_pdf_template');

    const args = stub.calls[0]!.args;
    // THE DEFECT: these three used to be absent from the wire entirely, so a
    // template seeded through this bridge reached pdf-tool with no contract
    // and W1's RENDER_DATA_INVALID gate never armed for it.
    assert.deepEqual(args.renderDataSchema, RENDER_DATA_SCHEMA);
    assert.deepEqual(args.sampleData, SAMPLE_DATA);
    assert.deepEqual(args.sampleAssets, SAMPLE_ASSETS);
    // The fields that already worked still do.
    assert.deepEqual(args.templateJson, { html: '<h1>{{ title }}</h1>' });
    assert.equal(args.renderer, 'chromium');
    assert.equal(args.templateId, 'article_brochure_v1');
    assert.equal(args.label, 'Article brochure');
    assert.deepEqual(args.tags, ['article']);

    // Never claimed, always stated: the response says the contract travelled.
    const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    assert.equal(structured?.renderDataSchemaForwarded, true);
  } finally {
    stub.restore();
  }
});

test('JOIN B: a create with no contract still works, and says the contract did NOT travel', async () => {
  const stub = stubPdfTool({ templateId: 'tpl_plain', version: 1, status: 'draft' });
  try {
    const result = await callCreatePdfTemplate({} as never, {
      site_id: SITE_ID,
      template_json: { html: '<h1>hi</h1>' },
    });
    const args = stub.calls[0]!.args;
    assert.equal('renderDataSchema' in args, false, 'an omitted schema must not become null/undefined on the wire');
    assert.equal('sampleData' in args, false);
    assert.equal('sampleAssets' in args, false);
    const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    assert.equal(structured?.renderDataSchemaForwarded, false);
  } finally {
    stub.restore();
  }
});

test('JOIN B: a malformed render_data_schema / sample_assets is refused here, by name', async () => {
  const stub = stubPdfTool({ templateId: 'x', version: 1 });
  try {
    const schemaResult = await callCreatePdfTemplate({} as never, {
      site_id: SITE_ID,
      template_json: { html: 'x' },
      render_data_schema: ['not', 'a', 'schema'],
    });
    assert.equal((schemaResult as { isError?: boolean }).isError, true);
    assert.equal(
      (schemaResult as { structuredContent?: Record<string, unknown> }).structuredContent?.error_code,
      'template_render_data_schema_invalid'
    );

    const assetsResult = await callCreatePdfTemplate({} as never, {
      site_id: SITE_ID,
      template_json: { html: 'x' },
      sample_assets: 'nope',
    });
    assert.equal((assetsResult as { isError?: boolean }).isError, true);
    assert.equal(
      (assetsResult as { structuredContent?: Record<string, unknown> }).structuredContent?.error_code,
      'template_sample_assets_invalid'
    );

    assert.equal(stub.calls.length, 0, 'nothing malformed is ever posted to pdf-tool');
  } finally {
    stub.restore();
  }
});

test('JOIN B: the client itself puts the three fields in the payload (the layer under the handler)', async () => {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    const parsed = JSON.parse(init?.body ?? '{}') as {
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    calls.push({ tool: parsed.params?.name ?? '', args: parsed.params?.arguments ?? {} });
    return {
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: '1', result: { structuredContent: { templateId: 't' } } }),
    } as unknown as Response;
  }) as typeof fetch;

  await createPlatformPdfTemplate(
    {
      grantVersion: 1,
      grantType: 'netlify-pat',
      projectId: 'dr-lurie',
      siteId: 'netlify-site',
      token: 'tok',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as never,
    {
      templateJson: { html: 'x' },
      renderDataSchema: RENDER_DATA_SCHEMA,
      sampleData: SAMPLE_DATA,
      sampleAssets: SAMPLE_ASSETS,
    },
    { env: { PDF_TOOL_BASE_URL: 'https://pdf-x.invalid', PDF_TOOL_AGENT_RUN_TOKEN: 'tok' }, fetchImpl }
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args.renderDataSchema, RENDER_DATA_SCHEMA);
  assert.deepEqual(calls[0]!.args.sampleData, SAMPLE_DATA);
  assert.deepEqual(calls[0]!.args.sampleAssets, SAMPLE_ASSETS);
});
