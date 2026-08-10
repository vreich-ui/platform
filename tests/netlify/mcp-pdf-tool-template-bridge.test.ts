import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { stubPdfToolMcp } from './pdf-tool-mcp-fetch-stub.js';

const REQUEST_ID = 'req_agent_pdf_template_bridge_pdf_report_20260804_01';
const STORAGE_SECRET = 'storage-secret-never-expose';
const RUN_SECRET = 'run-secret-never-expose';
const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-pdf-tool-template-bridge');
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

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

const rpc = async (name: string, args: Record<string, unknown>, logs: Array<Record<string, unknown>> = []) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    log: (payload) => logs.push(payload),
  });
  assert.equal(response.statusCode, 200);
  return { response, result: (JSON.parse(response.body) as { result: ToolResult }).result };
};

const resetAndSeedRequest = async () => {
  await rm(join(LOCAL_BLOBS_ROOT, 'site-objects'), { recursive: true, force: true });
  const created = await rpc('object_create', {
    object_type: 'content_item',
    site: 'site_drlurie',
    requested_id: REQUEST_ID,
    body: {
      slug: 'pdf-template-bridge-pdf-report',
      title: 'A PDF Report Built From a Template',
      nodes: [
        {
          id: 'n_start',
          kind: 'content',
          public: { title: 'Report', body: 'A report generated from a pdf-tool template.' },
          visibility: 'public',
        },
      ],
    },
  });
  assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));
};

test('tools/list exposes the pdf template bridge tools', async () => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const tools = (JSON.parse(response.body) as { result: { tools: Array<{ name: string }> } }).result.tools;
  const names = new Set(tools.map((tool) => tool.name));
  assert.ok(names.has('create_pdf_template'));
  assert.ok(names.has('list_pdf_templates'));
  assert.ok(names.has('get_pdf_template'));
  assert.ok(names.has('publish_pdf_template'));
  assert.ok(names.has('delete_pdf_template'));
  assert.ok(names.has('health'));
});

test('health returns pdf-tool capability manifest through the bridge and never exposes the grant', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    health: () => ({
      body: {
        ok: true,
        renderers: { pdfme: 'available', 'react-pdf': 'available', typst: 'degraded', chromium: 'available' },
        featureFlags: { imageSearch: true },
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const logs: Array<Record<string, unknown>> = [];
    const health = await rpc('health', { site_id: 'site_drlurie' }, logs);
    assert.ok(!health.result.isError, JSON.stringify(health.result.structuredContent));
    assert.equal(health.result.structuredContent?.ok, true);
    assert.equal(health.result.structuredContent?.siteId, 'site_drlurie');
    assert.deepEqual(health.result.structuredContent?.renderers, {
      pdfme: 'available',
      'react-pdf': 'available',
      typst: 'degraded',
      chromium: 'available',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization, `Bearer ${RUN_SECRET}`);
    // B2 fix: upstream health args schema is a strict empty object, and health
    // is grant-optional -- the bridged call must forward NO business args at
    // all (a stray projectId fails upstream validation; storage would be
    // stripped but is not sent either).
    assert.deepEqual(calls[0].body, {});

    const visible = JSON.stringify({ logs, health: health.response.body });
    assert.ok(!visible.includes(STORAGE_SECRET));
    assert.ok(!visible.includes(RUN_SECRET));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Platform creates then publishes a pdfme template end-to-end and never exposes the grant', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_pdf_template: (body) => ({
      status: 201,
      body: {
        projectId: body.projectId,
        templateId: 'tpl_report_card',
        version: 1,
        status: 'draft',
        renderer: body.renderer ?? 'pdfme',
      },
    }),
    publish_pdf_template: (body) => ({
      body: {
        projectId: body.projectId,
        templateId: body.templateId,
        version: body.version ?? 1,
        status: 'published',
        renderer: 'pdfme',
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const logs: Array<Record<string, unknown>> = [];
    const created = await rpc(
      'create_pdf_template',
      {
        site_id: 'site_drlurie',
        template_json: { schemas: [[{ name: 'title', type: 'text', position: { x: 0, y: 0 } }]] },
        label: 'Report card',
      },
      logs
    );
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));
    assert.equal(created.result.structuredContent?.templateId, 'tpl_report_card');
    assert.equal(created.result.structuredContent?.renderer, 'pdfme');
    assert.equal(created.result.structuredContent?.siteId, 'site_drlurie');

    const published = await rpc(
      'publish_pdf_template',
      { site_id: 'site_drlurie', template_id: 'tpl_report_card' },
      logs
    );
    assert.ok(!published.result.isError, JSON.stringify(published.result.structuredContent));
    assert.equal(published.result.structuredContent?.status, 'published');
    assert.equal(published.result.structuredContent?.siteId, 'site_drlurie');

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.authorization, `Bearer ${RUN_SECRET}`);
      assert.equal(call.body.projectId, 'dr-lurie');
      assert.equal((call.body.storage as { projectId: string }).projectId, 'dr-lurie');
      assert.equal((call.body.storage as { token: string }).token, STORAGE_SECRET);
    }

    const visible = JSON.stringify({ logs, created: created.response.body, published: published.response.body });
    assert.ok(!visible.includes(STORAGE_SECRET));
    assert.ok(!visible.includes(RUN_SECRET));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('publish_pdf_template surfaces the upstream 409 TEMPLATE_VALIDATION_REQUIRED unchanged', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      {
        error: 'Template tpl_react_report has no passed validation report for renderer react-pdf.',
        errorCode: 'TEMPLATE_VALIDATION_REQUIRED',
      },
      { status: 409 }
    )) as typeof fetch;
  try {
    const published = await rpc('publish_pdf_template', {
      site_id: 'site_drlurie',
      template_id: 'tpl_react_report',
    });
    assert.equal(published.result.isError, true);
    assert.equal(published.result.structuredContent?.statusCode, 409);
    assert.equal(published.result.structuredContent?.errorCode, 'TEMPLATE_VALIDATION_REQUIRED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Platform deactivates a pdf template and never exposes the grant', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    delete_pdf_template: (body) => ({
      body: {
        projectId: body.projectId,
        templateId: body.templateId,
        version: body.version ?? 1,
        status: 'disabled',
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const logs: Array<Record<string, unknown>> = [];
    const deleted = await rpc(
      'delete_pdf_template',
      { site_id: 'site_drlurie', template_id: 'tpl_report_card', reason: 'superseded by v2 layout' },
      logs
    );
    assert.ok(!deleted.result.isError, JSON.stringify(deleted.result.structuredContent));
    assert.equal(deleted.result.structuredContent?.status, 'disabled');
    assert.equal(deleted.result.structuredContent?.templateId, 'tpl_report_card');
    assert.equal(deleted.result.structuredContent?.siteId, 'site_drlurie');

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.authorization, `Bearer ${RUN_SECRET}`);
    assert.equal(call.body.projectId, 'dr-lurie');
    assert.equal(call.body.templateId, 'tpl_report_card');
    assert.equal(call.body.reason, 'superseded by v2 layout');
    assert.equal((call.body.storage as { projectId: string }).projectId, 'dr-lurie');
    assert.equal((call.body.storage as { token: string }).token, STORAGE_SECRET);

    const visible = JSON.stringify({ logs, deleted: deleted.response.body });
    assert.ok(!visible.includes(STORAGE_SECRET));
    assert.ok(!visible.includes(RUN_SECRET));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('delete_pdf_template surfaces an upstream 409 TEMPLATE_ARCHIVED-style error unchanged', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      {
        error: 'Template tpl_report_card version 3 conflicts with the currently disabled version.',
        errorCode: 'TEMPLATE_ARCHIVED',
      },
      { status: 409 }
    )) as typeof fetch;
  try {
    const deleted = await rpc('delete_pdf_template', {
      site_id: 'site_drlurie',
      template_id: 'tpl_report_card',
      version: 3,
    });
    assert.equal(deleted.result.isError, true);
    assert.equal(deleted.result.structuredContent?.statusCode, 409);
    assert.equal(deleted.result.structuredContent?.errorCode, 'TEMPLATE_ARCHIVED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('foreign site_id fails template bridge tools with template_site_mismatch and makes zero outbound fetches', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ error: 'must not be reached' }, { status: 500 });
  }) as typeof fetch;
  try {
    const create = await rpc('create_pdf_template', {
      site_id: 'site_other',
      template_json: { schemas: [[]] },
    });
    assert.equal(create.result.isError, true);
    assert.equal(create.result.structuredContent?.error_code, 'template_site_mismatch');

    const list = await rpc('list_pdf_templates', { site_id: 'site_other' });
    assert.equal(list.result.isError, true);
    assert.equal(list.result.structuredContent?.error_code, 'template_site_mismatch');

    const get = await rpc('get_pdf_template', { site_id: 'site_other', template_id: 'tpl_x' });
    assert.equal(get.result.isError, true);
    assert.equal(get.result.structuredContent?.error_code, 'template_site_mismatch');

    const publish = await rpc('publish_pdf_template', { site_id: 'site_other', template_id: 'tpl_x' });
    assert.equal(publish.result.isError, true);
    assert.equal(publish.result.structuredContent?.error_code, 'template_site_mismatch');

    const del = await rpc('delete_pdf_template', { site_id: 'site_other', template_id: 'tpl_x' });
    assert.equal(del.result.isError, true);
    assert.equal(del.result.structuredContent?.error_code, 'template_site_mismatch');

    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validate_pdf_template forwards required worst-case sample data and rejects a call missing it', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    validate_pdf_template: (body) => ({
      body: {
        projectId: body.projectId,
        templateId: body.templateId,
        version: body.version ?? 1,
        validationId: 'val_1',
        status: 'pending',
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const data = { title: 'Worst Case Title That Is Extremely Long', lines: ['a', 'b', 'c'] };
    const validated = await rpc('validate_pdf_template', {
      site_id: 'site_drlurie',
      template_id: 'tpl_react_report',
      data,
    });
    assert.ok(!validated.result.isError, JSON.stringify(validated.result.structuredContent));
    assert.equal(validated.result.structuredContent?.validationId, 'val_1');

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.data, data);

    const missingData = await rpc('validate_pdf_template', {
      site_id: 'site_drlurie',
      template_id: 'tpl_react_report',
    });
    assert.equal(missingData.result.isError, true);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('create_agent_artifact_job forwards template_id, data, and assets to pdf-tool', async () => {
  await resetAndSeedRequest();
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: (body) => ({
      status: 202,
      body: {
        jobId: 'job-template-render',
        status: 'pending',
        projectId: body.projectId,
        requestId: body.requestId,
        artifactKind: body.artifactKind,
        polling: { tool: 'get_agent_artifact_job_status', input: { projectId: body.projectId } },
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const data = { title: 'Q3 Report', total: '$4,200' };
    const assets = { images: [{ name: 'logo', src: 'image/req/logo.webp' }] };
    const created = await rpc('create_agent_artifact_job', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      artifact_kind: 'pdf',
      filename: 'q3-report.pdf',
      template_id: 'tpl_report_card',
      data,
      assets,
      // This stub only mocks create-agent-artifact-job; opt out of the
      // create call's own inline status wait (covered by
      // mcp-create-agent-artifact-job-inline-wait.test.ts) so the test
      // doesn't spend its whole ~10s default budget retrying an unmocked
      // get-agent-artifact-job-status route.
      wait: false,
    });
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

    const jobCall = calls.find((call) => call.tool === 'create_agent_artifact_job');
    assert.ok(jobCall);
    assert.equal(jobCall?.body.templateId, 'tpl_report_card');
    assert.deepEqual(jobCall?.body.data, data);
    assert.deepEqual(jobCall?.body.assets, assets);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
