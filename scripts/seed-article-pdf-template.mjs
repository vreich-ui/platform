#!/usr/bin/env node
/**
 * T2.7 — seeds `article_brochure_v1` (vendored at
 * `scripts/lib/pdf-templates/article_brochure_v1.json`) into a tenant as
 * `<slug>_article_v1`, through the platform's existing pdf-tool bridge
 * (`create_pdf_template` -> `validate_pdf_template` -> `publish_pdf_template`
 * — chromium templates have a hard publish gate that requires a passing
 * validation, so the order matters), then points `site.pdf` at it
 * (ruling D-B). All DECISIONS are pure functions in `scripts/lib/` — this
 * file is the thin, testable-by-mocked-`tool()` I/O shell around them,
 * same shape as `scripts/site-genesis-drive.mjs`.
 *
 * `runArticleTemplateSeed` is also imported directly by
 * `site-genesis-drive.mjs` as a genesis STEP (see that file) — every
 * freshly-scaffolded tenant gets this automatically, no separate script run
 * required. drlurie already exists, so its one-time retrofit is
 * `scripts/seed-drlurie-pdf-defaults.mjs`, a thin wrapper around this same
 * function with drlurie's own sales-brochure template id supplied (that
 * UUID is drlurie-specific data and does not belong in this fleet-generic
 * module — see `scripts/lib/site-pdf-defaults.mjs`'s doc comment).
 *
 * ── The contract, proven rather than assumed ─────────────────────────────
 * When T2.7 was written, `callCreatePdfTemplate` did not forward
 * `render_data_schema` / `sample_data` / `sample_assets` at all, so a
 * platform-seeded template reached pdf-tool with no contract and W1's
 * RENDER_DATA_INVALID gate never armed for it. T2.3 (JOIN B) widened that
 * handler; this script still sends the three fields and still PROVES the
 * schema landed by reading the template back with `get_pdf_template` before
 * validating or publishing, so a future regression in that forwarding is
 * caught here instead of by the first garbage render — the same "never claim
 * a state you can't prove" rule the brief applies to the UI, applied to a
 * script.
 *
 * ── The publish order is not optional ────────────────────────────────────
 * chromium's publish gate is HARD: `publish_pdf_template` refuses a version
 * with no PASSED validation report, and `validate_pdf_template` only STARTS
 * an asynchronous render. create -> validate -> poll
 * `get_pdf_template_validation` to a terminal report -> publish. Skipping the
 * poll fails the publish essentially every time; see the W2 review note at
 * the call site.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  articleTemplateIdForSite,
  buildBrandedArticleTemplateSeed,
  planArticleTemplateSeed,
  validateSeedSampleData,
} from './lib/article-template-seed.mjs';
import { buildSitePdfDefaults, planSitePdfSeed } from './lib/site-pdf-defaults.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SOURCE_PATH = path.join(repoRoot, 'scripts', 'lib', 'pdf-templates', 'article_brochure_v1.json');

/** The vendored `article_brochure_v1` source (BRIEF's Reference file), read fresh each call so a test can point `sourcePath` elsewhere. */
export const loadArticleBrochureV1Source = (sourcePath = SOURCE_PATH) => JSON.parse(readFileSync(sourcePath, 'utf8'));

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const AGENT = 'seed-article-pdf-template';

/** Bounded, so a stuck validation ends the seed with a readable message instead
 *  of hanging genesis. ~30s total, comfortably over a cold chromium render. */
export const TEMPLATE_VALIDATION_POLL_ATTEMPTS = 20;
export const TEMPLATE_VALIDATION_POLL_INTERVAL_MS = 1_500;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `get_pdf_template_validation` to a TERMINAL report (`passed` / `failed`),
 * or gives up after a bounded number of attempts and says so. Never claims a
 * status it did not read: a poll that errors is recorded and retried, and a
 * still-`running` report at the end comes back as `running`, not as a pass.
 */
const pollTemplateValidation = async ({ tool, templateId, validationId, steps, sleep = wait }) => {
  let last = { status: 'running', body: undefined };
  for (let attempt = 1; attempt <= TEMPLATE_VALIDATION_POLL_ATTEMPTS; attempt += 1) {
    const polled = await tool('get_pdf_template_validation', {
      template_id: templateId,
      ...(validationId ? { validation_id: validationId } : {}),
    });
    const status = !polled.isError && typeof polled.data?.status === 'string' ? polled.data.status : undefined;
    last = { status: status ?? 'running', body: polled.data };
    if (status === 'passed' || status === 'failed') {
      steps.push({ stage: 'template_validation_poll', attempts: attempt, status });
      return last;
    }
    if (attempt < TEMPLATE_VALIDATION_POLL_ATTEMPTS) await sleep(TEMPLATE_VALIDATION_POLL_INTERVAL_MS);
  }
  steps.push({ stage: 'template_validation_poll', attempts: TEMPLATE_VALIDATION_POLL_ATTEMPTS, status: last.status });
  return last;
};

/**
 * The whole seed operation for one site, against an MCP `tool(name, args)`
 * function (the same `{isError, data}` shape `site-genesis-drive.mjs`'s
 * `createTool` returns — this file never opens its own connection). Returns
 * `{ ok, templateId, steps, error? }`; `steps` is a full trace, useful for
 * `--verify`-style reporting and for tests to assert exactly which tool
 * calls did (or, on the idempotent no-op path, did NOT) happen.
 */
export const runArticleTemplateSeed = async ({
  tool,
  siteId,
  agentName = AGENT,
  salesBrochureTemplateId,
  source = loadArticleBrochureV1Source(),
  // Injected so a test can run the (real, bounded) validation poll without
  // spending 30 seconds of wall clock on it. Production always waits.
  sleep = wait,
}) => {
  const steps = [];
  const templateId = articleTemplateIdForSite(siteId);

  const siteGet = await tool('object_get', { object_type: 'site', object_id: siteId });
  const record = siteGet.isError ? undefined : siteGet.data?.record;
  const siteBody = isRecord(record?.body) ? record.body : undefined;
  if (!siteBody) {
    return {
      ok: false,
      templateId,
      steps,
      error: `site '${siteId}' does not exist yet -- seed the site singleton first.`,
    };
  }

  const listed = await tool('list_pdf_templates', { limit: 200 });
  const existingTemplates = !listed.isError && Array.isArray(listed.data?.templates) ? listed.data.templates : [];
  const existingIds = existingTemplates
    .map((row) => (isRecord(row) ? row.templateId : undefined))
    .filter((id) => typeof id === 'string');

  const templatePlan = planArticleTemplateSeed(templateId, existingIds);
  steps.push({ stage: 'template_plan', ...templatePlan });

  let templateReady = templatePlan.action === 'already_seeded';

  if (templatePlan.action === 'create') {
    const seed = buildBrandedArticleTemplateSeed({ templateId, source, siteBody });
    if (!seed) {
      steps.push({
        stage: 'template_create',
        action: 'refused',
        reason: 'site has no usable brandTokens -- refusing to seed a template with a fabricated brand.',
      });
      return { ok: false, templateId, steps, error: 'site has no usable brandTokens.' };
    }

    const localValidation = validateSeedSampleData(seed);
    steps.push({ stage: 'local_schema_check', valid: localValidation.valid, errors: localValidation.errors });
    if (!localValidation.valid) {
      return {
        ok: false,
        templateId,
        steps,
        error: `branded sampleData does not validate against its own renderDataSchema: ${localValidation.errors.join('; ')}`,
      };
    }

    const created = await tool('create_pdf_template', {
      template_id: seed.templateId,
      template_json: seed.templateJson,
      renderer: seed.renderer,
      label: seed.label,
      tags: seed.tags,
      // The render-data CONTRACT (forwarded by callCreatePdfTemplate since
      // T2.3/JOIN B, and proven landed by the readback below).
      render_data_schema: seed.renderDataSchema,
      sample_data: seed.sampleData,
      sample_assets: seed.sampleAssets,
    });
    steps.push({ stage: 'template_create', isError: created.isError, data: created.data });
    if (created.isError) {
      return { ok: false, templateId, steps, error: `create_pdf_template failed: ${brief(created.data)}` };
    }

    const fetched = await tool('get_pdf_template', { template_id: templateId });
    const storedSchema = !fetched.isError && isRecord(fetched.data?.renderDataSchema) ? fetched.data.renderDataSchema : undefined;
    steps.push({ stage: 'template_readback', hasRenderDataSchema: Boolean(storedSchema) });
    if (!storedSchema) {
      return {
        ok: false,
        templateId,
        steps,
        error:
          `create_pdf_template did not persist renderDataSchema for '${templateId}'. callCreatePdfTemplate is ` +
          `supposed to forward render_data_schema/sample_data/sample_assets (T2.3/JOIN B) -- check that it still ` +
          `does before re-running this seed, or the template publishes with no contract and W1's ` +
          `RENDER_DATA_INVALID gate never arms for it.`,
      };
    }

    const validated = await tool('validate_pdf_template', { template_id: templateId, data: seed.sampleData });
    steps.push({ stage: 'template_validate', isError: validated.isError, data: validated.data });
    if (validated.isError) {
      return { ok: false, templateId, steps, error: `validate_pdf_template failed: ${brief(validated.data)}` };
    }

    // W2 REVIEW — THE PUBLISH GATE IS NOT SATISFIED BY STARTING A VALIDATION.
    //
    // `validate_pdf_template` is ASYNCHRONOUS: it writes a `running` report and
    // dispatches a background render, because a cold chromium render exceeds the
    // sync budget (pdf-tool's own note on `recordPublishValidation`). Chromium's
    // publish gate is HARD — `publishPdfTemplate` throws
    // TEMPLATE_VALIDATION_REQUIRED for `!report || report.status === 'running'`.
    // Publishing immediately after starting validation therefore FAILED for every
    // freshly-seeded tenant, the seed returned before ever writing `site.pdf`, and
    // genesis printed one warn line and moved on: ruling D-B silently unachieved
    // for every new site. Every published tool description already spells the
    // required order out ("poll get_pdf_template_validation until the report is
    // terminal"); this is that poll.
    const report = await pollTemplateValidation({
      tool,
      templateId,
      validationId: validated.data?.validationId,
      steps,
      sleep,
    });
    if (report.status !== 'passed') {
      return {
        ok: false,
        templateId,
        steps,
        error:
          report.status === 'running'
            ? `validation for '${templateId}' was still running after ${TEMPLATE_VALIDATION_POLL_ATTEMPTS} polls; it is not lost — re-run this seed once get_pdf_template_validation reports a terminal status.`
            : `validation for '${templateId}' did not pass (${report.status}): ${brief(report.body)}`,
      };
    }

    const published = await tool('publish_pdf_template', { template_id: templateId });
    steps.push({ stage: 'template_publish', isError: published.isError, data: published.data });
    if (published.isError) {
      return { ok: false, templateId, steps, error: `publish_pdf_template failed: ${brief(published.data)}` };
    }
    templateReady = true;
  }

  const existingSitePdf = isRecord(siteBody.pdf) ? siteBody.pdf : undefined;
  const sitePdfPlan = planSitePdfSeed(existingSitePdf);
  steps.push({ stage: 'site_pdf_plan', ...sitePdfPlan });

  if (sitePdfPlan.action === 'set' && templateReady) {
    const defaults = buildSitePdfDefaults({ articleTemplateId: templateId, salesBrochureTemplateId });

    const checkout = await tool('object_checkout', { object_type: 'site', object_id: siteId, agent_name: agentName });
    const lockToken = checkout.data?.lockToken;
    if (checkout.isError || !lockToken) {
      return { ok: false, templateId, steps, error: `could not check out site '${siteId}' to set site.pdf.` };
    }

    const patched = await tool('object_patch', {
      object_type: 'site',
      object_id: siteId,
      lock_token: lockToken,
      agent_name: agentName,
      expected_record_version: record.version,
      ops: [{ op: 'set_site_fields', fields: { pdf: defaults } }],
    });
    steps.push({ stage: 'site_pdf_patch', isError: patched.isError, data: patched.data });

    if (!patched.isError) {
      const sitePublished = await tool('object_publish', {
        object_type: 'site',
        object_id: siteId,
        lock_token: lockToken,
        agent_name: agentName,
      });
      steps.push({ stage: 'site_publish', isError: sitePublished.isError, data: sitePublished.data });
    }

    await tool('object_checkin', { object_type: 'site', object_id: siteId, lock_token: lockToken, agent_name: agentName });

    if (patched.isError) {
      return { ok: false, templateId, steps, error: `object_patch (set_site_fields pdf) failed: ${brief(patched.data)}` };
    }
  }

  return { ok: true, templateId, steps };
};

const brief = (data) => JSON.stringify(data ?? {}).slice(0, 300);

// ─── MCP transport + CLI (same shape as site-genesis-drive.mjs) ────────────

export const createTool = (endpoint, key) => {
  let rpcId = 0;
  return async (name, toolArgs) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: toolArgs ?? {} },
      }),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { isError: true, data: { error: `non-JSON response (${response.status})`, detail: text.slice(0, 200) } };
    }
    const result = body.result ?? {};
    return {
      isError: Boolean(result.isError) || Boolean(body.error),
      data: result.structuredContent ?? body.error ?? {},
    };
  };
};

export const parseArgs = (argv) => {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    siteId: flag('--site-id'),
    endpoint: flag('--endpoint'),
    salesBrochureTemplateId: flag('--sales-brochure-template-id'),
  };
};

const USAGE =
  'usage: MCP_HTTP_AUTH_TOKEN=… node scripts/seed-article-pdf-template.mjs --site-id site_<client> --endpoint https://<host>/mcp [--sales-brochure-template-id <id>]';

export const main = async (argv) => {
  const opts = parseArgs(argv);
  if (!opts.siteId || !opts.endpoint) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const key = process.env.MCP_HTTP_AUTH_TOKEN;
  if (!key) {
    console.error('[pdf-template-seed] MCP_HTTP_AUTH_TOKEN is required.');
    process.exitCode = 2;
    return;
  }
  const tool = createTool(opts.endpoint, key);
  const result = await runArticleTemplateSeed({
    tool,
    siteId: opts.siteId,
    salesBrochureTemplateId: opts.salesBrochureTemplateId,
  });
  for (const step of result.steps) console.log(JSON.stringify(step));
  console.log(result.ok ? `[pdf-template-seed] OK (${result.templateId})` : `[pdf-template-seed] FAILED: ${result.error}`);
  process.exitCode = result.ok ? 0 : 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('[pdf-template-seed] crashed:', error.message);
    process.exit(1);
  });
}
