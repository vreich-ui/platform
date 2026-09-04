/**
 * T2.7 — tests for `scripts/seed-article-pdf-template.mjs`'s
 * `runArticleTemplateSeed`, against a MOCKED MCP `tool(name, args)` function
 * (the `site-genesis-verify.test.mjs` pattern) — no live pdf-tool call.
 *
 * Covers the three acceptance-mandated proofs:
 *   - a fresh site produces BOTH the template (create -> validate -> publish)
 *     and the site.pdf defaults;
 *   - re-running against an already-seeded site is a no-op;
 *   - the disclosed create_pdf_template bridge gap is caught, not papered over.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadArticleBrochureV1Source, runArticleTemplateSeed } from '../../scripts/seed-article-pdf-template.mjs';

const DRLURIE_SITE_BODY = {
  name: 'Dr. Lurié Skincare',
  brandTokens: {
    colors: { primary: 'rgb(46 111 149)', accent: 'rgb(94 140 138)' },
    fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' },
  },
};

const SOURCE = loadArticleBrochureV1Source();

/**
 * A scriptable mock of the `tool(name, args)` seam. `responses` maps a tool
 * name to either a fixed `{isError, data}` or a function of `(args, log)`
 * returning one; every call (name + args) is recorded in `log` so a test can
 * assert exactly which calls did, or did not, happen.
 */
const makeTool = (responses) => {
  const log = [];
  const tool = async (name, args) => {
    log.push({ name, args });
    const responder = responses[name];
    if (!responder) return { isError: true, data: { error: `unmocked tool '${name}'` } };
    return typeof responder === 'function' ? responder(args, log) : responder;
  };
  return { tool, log };
};

const okSiteGet = (body, version = 1) => ({ isError: false, data: { record: { body, version } } });

/** A `get_pdf_template_validation` responder that walks a scripted status list,
 *  repeating the last entry forever — the shape a real poll sees. */
const validationReports = (statuses) => {
  let call = 0;
  return () => {
    const status = statuses[Math.min(call, statuses.length - 1)];
    call += 1;
    return { isError: false, data: { templateId: 'drlurie_article_v1', validationId: 'val_1', status } };
  };
};

/** Every seed run in this file uses the real (bounded) poll loop with the wait
 *  removed, so the poll's ORDER is tested without its wall clock. */
const seed = (args) => runArticleTemplateSeed({ ...args, sleep: async () => {} });

const baseResponses = (siteBody) => ({
  object_get: okSiteGet(siteBody),
  list_pdf_templates: { isError: false, data: { templates: [] } },
  create_pdf_template: { isError: false, data: { templateId: 'drlurie_article_v1', version: 1 } },
  get_pdf_template: {
    isError: false,
    data: { templateId: 'drlurie_article_v1', renderDataSchema: SOURCE.renderDataSchema },
  },
  // pdf-tool's validate_pdf_template is ASYNCHRONOUS: it writes a `running`
  // report and dispatches a background render. Modelled as it really behaves —
  // the previous fixture returned `status: 'passed'` from this call, which is a
  // status this tool never returns, and that fiction is what hid the missing
  // poll (see the "publish gate" test below).
  validate_pdf_template: {
    isError: false,
    data: { templateId: 'drlurie_article_v1', validationId: 'val_1', status: 'running' },
  },
  get_pdf_template_validation: validationReports(['running', 'passed']),
  publish_pdf_template: { isError: false, data: { templateId: 'drlurie_article_v1', activeVersion: 1 } },
  object_checkout: { isError: false, data: { lockToken: 'lock-1' } },
  object_patch: { isError: false, data: {} },
  object_publish: { isError: false, data: {} },
  object_checkin: { isError: false, data: {} },
});

test('ACCEPTANCE: a fresh site produces BOTH the template (create->validate->publish) and the site.pdf defaults', async () => {
  const { tool, log } = makeTool(baseResponses(DRLURIE_SITE_BODY));
  const result = await seed({ tool, siteId: 'site_drlurie' });

  assert.equal(result.ok, true);
  assert.equal(result.templateId, 'drlurie_article_v1');

  const names = log.map((entry) => entry.name);
  assert.ok(names.includes('create_pdf_template'), 'template was created');
  assert.ok(names.includes('validate_pdf_template'), 'template was validated');
  assert.ok(names.includes('publish_pdf_template'), 'template was published');
  assert.ok(names.includes('object_patch'), 'site.pdf was patched');
  assert.ok(names.includes('object_publish'), 'the site object was published after the patch');
  assert.ok(names.includes('object_checkin'), 'the site lock was released');

  const patchCall = log.find((entry) => entry.name === 'object_patch');
  assert.deepEqual(patchCall.args.ops, [
    {
      op: 'set_site_fields',
      fields: { pdf: { defaultTemplateId: 'drlurie_article_v1', byKind: { article: 'drlurie_article_v1', lead_magnet: 'drlurie_article_v1' } } },
    },
  ]);

  const createCall = log.find((entry) => entry.name === 'create_pdf_template');
  assert.equal(createCall.args.template_id, 'drlurie_article_v1');
  assert.equal(createCall.args.sample_data.brand.colors.primary, 'rgb(46 111 149)');
});

test('ACCEPTANCE: re-running the seed on an already-seeded site is a no-op', async () => {
  const alreadySeededBody = { ...DRLURIE_SITE_BODY, pdf: { defaultTemplateId: 'drlurie_article_v1', byKind: { article: 'drlurie_article_v1' } } };
  const responses = {
    ...baseResponses(alreadySeededBody),
    object_get: okSiteGet(alreadySeededBody),
    list_pdf_templates: { isError: false, data: { templates: [{ templateId: 'drlurie_article_v1' }] } },
  };
  const { tool, log } = makeTool(responses);
  const result = await seed({ tool, siteId: 'site_drlurie' });

  assert.equal(result.ok, true);
  const names = log.map((entry) => entry.name);
  assert.deepEqual(
    names.filter((name) => ['create_pdf_template', 'validate_pdf_template', 'publish_pdf_template', 'object_patch', 'object_checkout'].includes(name)),
    [],
    'no write call was made on the idempotent re-run'
  );
  assert.deepEqual(
    result.steps.map((step) => step.stage),
    ['template_plan', 'site_pdf_plan']
  );
  assert.equal(result.steps[0].action, 'already_seeded');
  assert.equal(result.steps[1].action, 'already_present');
});

test('a fresh tenant genesis path (no existing templates, no site.pdf) reaches BOTH the create call and the site.pdf patch, in the right order', async () => {
  const { tool, log } = makeTool(baseResponses(DRLURIE_SITE_BODY));
  await seed({ tool, siteId: 'site_drlurie' });
  const order = log.map((entry) => entry.name);
  const createIdx = order.indexOf('create_pdf_template');
  const validateIdx = order.indexOf('validate_pdf_template');
  const publishIdx = order.indexOf('publish_pdf_template');
  const patchIdx = order.indexOf('object_patch');
  assert.ok(createIdx < validateIdx, 'validate never runs before create');
  assert.ok(validateIdx < publishIdx, 'the hard publish gate: validate before publish');
  assert.ok(publishIdx < patchIdx, 'site.pdf is only set once the template is actually ready');
});

test('refuses to seed a template with a fabricated brand when the site has no usable brandTokens', async () => {
  const { tool, log } = makeTool(baseResponses({ name: 'No brand yet' }));
  const result = await seed({ tool, siteId: 'site_acme' });
  assert.equal(result.ok, false);
  assert.match(result.error, /no usable brandTokens/);
  assert.equal(log.some((entry) => entry.name === 'create_pdf_template'), false);
});

test('fails clearly (does not silently succeed) when the site singleton does not exist yet', async () => {
  const { tool } = makeTool({ object_get: { isError: false, data: {} } });
  const result = await seed({ tool, siteId: 'site_missing' });
  assert.equal(result.ok, false);
  assert.match(result.error, /does not exist yet/);
});

test('DISCLOSED GAP: refuses to validate/publish when create_pdf_template does not persist renderDataSchema', async () => {
  const responses = {
    ...baseResponses(DRLURIE_SITE_BODY),
    // The known bridge gap: callCreatePdfTemplate does not yet forward
    // render_data_schema, so a real pdf-tool response would echo the
    // template WITHOUT one.
    get_pdf_template: { isError: false, data: { templateId: 'drlurie_article_v1' } },
  };
  const { tool, log } = makeTool(responses);
  const result = await seed({ tool, siteId: 'site_drlurie' });

  assert.equal(result.ok, false);
  assert.match(result.error, /did not persist renderDataSchema/);
  const names = log.map((entry) => entry.name);
  assert.ok(names.includes('create_pdf_template'));
  assert.equal(names.includes('validate_pdf_template'), false, 'never validates a template that lacks its schema');
  assert.equal(names.includes('publish_pdf_template'), false, 'never publishes a template that lacks its schema');
});

test('a drlurie-style call with salesBrochureTemplateId pins byKind.sales_brochure too', async () => {
  const { tool, log } = makeTool(baseResponses(DRLURIE_SITE_BODY));
  await seed({
    tool,
    siteId: 'site_drlurie',
    salesBrochureTemplateId: '674a43bd-40c0-40ed-847a-67a9e0b4ec2c',
  });
  const patchCall = log.find((entry) => entry.name === 'object_patch');
  assert.equal(patchCall.args.ops[0].fields.pdf.byKind.sales_brochure, '674a43bd-40c0-40ed-847a-67a9e0b4ec2c');
});

// ── W2 review: the publish gate ─────────────────────────────────────────────
//
// chromium's publish gate is HARD — `publishPdfTemplate` throws
// TEMPLATE_VALIDATION_REQUIRED when the version's validation report is missing
// or still `running`, and `validate_pdf_template` only STARTS an asynchronous
// render (a cold chromium render exceeds the sync budget, which is why it is
// asynchronous at all). This seed went create -> validate -> publish with no
// poll in between, so publish would have been refused for every freshly-seeded
// tenant, the seed would have returned before ever writing `site.pdf`, and the
// genesis hook — warn-only by design — would have printed one line and moved
// on: ruling D-B silently unachieved for every new site. Nothing caught it
// because the fixture had `validate_pdf_template` return `status: 'passed'`, a
// status that call never returns.

test('W2 review: the seed polls the validation report to terminal BEFORE publishing', async () => {
  const { tool, log } = makeTool({
    ...baseResponses(DRLURIE_SITE_BODY),
    get_pdf_template_validation: validationReports(['running', 'running', 'passed']),
  });
  const result = await seed({ tool, siteId: 'site_drlurie' });
  assert.equal(result.ok, true);

  const names = log.map((entry) => entry.name);
  const validateAt = names.indexOf('validate_pdf_template');
  const firstPollAt = names.indexOf('get_pdf_template_validation');
  const publishAt = names.indexOf('publish_pdf_template');
  assert.ok(validateAt >= 0 && firstPollAt > validateAt, 'the report is polled after validation is started');
  assert.ok(publishAt > firstPollAt, 'publish happens only after the report is read');
  assert.equal(
    names.filter((name) => name === 'get_pdf_template_validation').length,
    3,
    'it polls until terminal, not once'
  );
  // The poll carries the validationId the start call handed back, so it reads
  // THIS render's report rather than whatever report happens to be latest.
  assert.equal(log.find((entry) => entry.name === 'get_pdf_template_validation').args.validation_id, 'val_1');
});

test('W2 review: a validation that FAILS is never published, and the seed says so', async () => {
  const { tool, log } = makeTool({
    ...baseResponses(DRLURIE_SITE_BODY),
    get_pdf_template_validation: validationReports(['running', 'failed']),
  });
  const result = await seed({ tool, siteId: 'site_drlurie' });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not pass \(failed\)/);
  const names = log.map((entry) => entry.name);
  assert.equal(names.includes('publish_pdf_template'), false, 'never publishes a template whose validation failed');
  assert.equal(names.includes('object_patch'), false, 'and never points site.pdf at it');
});

test('W2 review: a validation still running when the budget ends is reported as running, never as passed', async () => {
  const { tool, log } = makeTool({
    ...baseResponses(DRLURIE_SITE_BODY),
    get_pdf_template_validation: validationReports(['running']),
  });
  const result = await seed({ tool, siteId: 'site_drlurie' });
  assert.equal(result.ok, false);
  assert.match(result.error, /still running/);
  assert.match(result.error, /re-run this seed/, 'the operator is told the seed is idempotent, not that the work is lost');
  assert.equal(log.map((entry) => entry.name).includes('publish_pdf_template'), false);
});

test('W2 review: an unreadable validation poll is retried, not read as a pass', async () => {
  let call = 0;
  const { tool } = makeTool({
    ...baseResponses(DRLURIE_SITE_BODY),
    get_pdf_template_validation: () => {
      call += 1;
      if (call < 3) return { isError: true, data: { error: 'bridge unavailable' } };
      return { isError: false, data: { validationId: 'val_1', status: 'passed' } };
    },
  });
  const result = await seed({ tool, siteId: 'site_drlurie' });
  assert.equal(result.ok, true);
  assert.equal(call, 3);
});
