/**
 * T2.7 — proves the genesis HOOK: `scripts/site-genesis-drive.mjs`'s
 * `runDrive` calls `runArticleTemplateSeed` after the object seed pack and
 * before `release_to_production`, so a freshly-scaffolded tenant comes out
 * the other end with BOTH the article template and `site.pdf` populated —
 * with no separate manual step (the standing "genesis is never a manual
 * step" rule).
 *
 * Drives `runDrive` itself (not just `runArticleTemplateSeed` in isolation
 * — that is covered by `seed-article-pdf-template.test.mjs`) against a real
 * scratch site fixture (`loadSeeds` does a real dynamic `import()`) and a
 * single stateful mocked `tool()` covering both the object-store verbs and
 * the pdf-tool bridge verbs, mirroring `site-genesis-verify.test.mjs`'s
 * fixture pattern.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runDrive } from '../../scripts/site-genesis-drive.mjs';

const NAV_HEADER_BODY = { role: 'header', groups: [{ id: 'g_primary', items: [] }] };
const NAV_FOOTER_BODY = { role: 'footer', groups: [], footNote: '© Fixture.' };
const SITE_BODY = {
  name: 'Fixture Co',
  logo: { text: 'FIXTURE' },
  brandTokens: {
    colors: { primary: '#336699', accent: '#009688' },
    fonts: { sans: 'system-ui', serif: 'Georgia', heading: 'Georgia' },
  },
  defaultNavigation: { header: 'nav_header', footer: 'nav_footer' },
};

const makeSiteFixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-pdf-seed-'));
  fs.mkdirSync(path.join(dir, 'seeds'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'site', 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'seeds', 'navigation-seed-data.mjs'),
    `export const SEED_SITE = 'site_fixture';\n` +
      `export const CONVERSION_SEEDS = [\n` +
      `  { objectType: 'navigation', objectId: 'nav_header', body: ${JSON.stringify(NAV_HEADER_BODY)} },\n` +
      `  { objectType: 'navigation', objectId: 'nav_footer', body: ${JSON.stringify(NAV_FOOTER_BODY)} },\n` +
      `];\n`
  );
  fs.writeFileSync(
    path.join(dir, 'seeds', 'site-seed-data.mjs'),
    `export const SEED_SITE = 'site_fixture';\n` +
      `export const CONVERSION_SEEDS = [\n` +
      `  { objectType: 'site', objectId: 'site_fixture', body: ${JSON.stringify(SITE_BODY)} },\n` +
      `];\n`
  );
  return dir;
};

/** A stateful mock covering both the object-store verbs and the pdf-tool bridge verbs `runDrive` + the pdf-template-seed hook use. */
const makeGenesisTool = () => {
  const objects = new Map(); // `${type}:${id}` -> { body, version, publication }
  const templates = new Map(); // templateId -> raw pdf-tool template row
  let validationPolls = 0;
  const log = [];
  const key = (type, id) => `${type}:${id}`;

  const tool = async (name, args = {}) => {
    log.push({ name, args });
    switch (name) {
      case 'object_get': {
        const record = objects.get(key(args.object_type, args.object_id));
        return { isError: false, data: { record } };
      }
      case 'object_create': {
        objects.set(key(args.object_type, args.requested_id), { body: args.body, version: 1, publication: undefined });
        return { isError: false, data: {} };
      }
      case 'object_checkout':
        return { isError: false, data: { lockToken: 'lock-1' } };
      case 'object_publish': {
        const record = objects.get(key(args.object_type, args.object_id));
        if (record) record.publication = { published_time: '2026-09-04T00:00:00Z' };
        return { isError: false, data: {} };
      }
      case 'object_checkin':
        return { isError: false, data: {} };
      case 'object_patch': {
        const record = objects.get(key(args.object_type, args.object_id));
        if (!record) return { isError: true, data: { error: 'not found' } };
        for (const op of args.ops) {
          if (op.op === 'set_site_fields') {
            record.body = { ...record.body, ...op.fields, pdf: { ...(record.body.pdf ?? {}), ...(op.fields.pdf ?? {}) } };
          }
        }
        record.version += 1;
        return { isError: false, data: {} };
      }
      case 'list_pdf_templates':
        return { isError: false, data: { templates: [...templates.values()] } };
      case 'create_pdf_template': {
        const row = {
          templateId: args.template_id,
          renderer: args.renderer,
          label: args.label,
          version: 1,
          renderDataSchema: args.render_data_schema,
          sampleData: args.sample_data,
        };
        templates.set(args.template_id, row);
        return { isError: false, data: { templateId: row.templateId, version: 1 } };
      }
      case 'get_pdf_template': {
        const row = templates.get(args.template_id);
        return { isError: false, data: row ?? {} };
      }
      // W2 review: validation is ASYNCHRONOUS in pdf-tool — this call starts a
      // background render and returns a `running` report; chromium's publish
      // gate refuses until `get_pdf_template_validation` reports `passed`.
      // Modelled as it really behaves, so the genesis hook is proven to survive
      // it rather than proven against a status this tool never returns.
      case 'validate_pdf_template':
        return { isError: false, data: { templateId: args.template_id, validationId: 'val_genesis', status: 'running' } };
      case 'get_pdf_template_validation': {
        validationPolls += 1;
        return {
          isError: false,
          data: {
            templateId: args.template_id,
            validationId: 'val_genesis',
            status: validationPolls === 1 ? 'running' : 'passed',
          },
        };
      }
      case 'publish_pdf_template': {
        const row = templates.get(args.template_id);
        if (row) row.activeVersion = 1;
        return { isError: false, data: { templateId: args.template_id, activeVersion: 1 } };
      }
      case 'release_to_production':
        return { isError: false, data: { released: true } };
      default:
        return { isError: true, data: { error: `unmocked tool '${name}'` } };
    }
  };
  return { tool, log, objects, templates };
};

test('ACCEPTANCE: a fresh tenant genesis run (runDrive) produces both the article template and site.pdf defaults', async () => {
  const siteRoot = makeSiteFixture();
  try {
    const { tool, log, objects, templates } = makeGenesisTool();
    const exitCode = await runDrive({
      siteDir: 'sites/fixture',
      siteRoot,
      endpoint: 'https://fixture.example/mcp',
      tool,
      dryRun: false,
      noRelease: false,
    });

    assert.equal(exitCode, 0);

    // The template exists, and carries the fixture's own brand.
    const created = templates.get('fixture_article_v1');
    assert.ok(created, 'the article template was created under the derived template id');
    assert.equal(created.activeVersion, 1, 'the template was published');
    assert.equal(created.sampleData.brand.colors.primary, '#336699');

    // site.pdf now points at it.
    const site = objects.get('site:site_fixture');
    assert.equal(site.body.pdf.defaultTemplateId, 'fixture_article_v1');
    assert.equal(site.body.pdf.byKind.article, 'fixture_article_v1');

    // release_to_production still ran exactly once, after everything else.
    const names = log.map((entry) => entry.name);
    assert.equal(names.filter((name) => name === 'release_to_production').length, 1);
    assert.ok(names.indexOf('create_pdf_template') < names.lastIndexOf('release_to_production'));
  } finally {
    fs.rmSync(siteRoot, { recursive: true, force: true });
  }
});

test('re-running runDrive against the now-seeded fixture makes no further pdf-tool write calls', async () => {
  const siteRoot = makeSiteFixture();
  try {
    const { tool, log } = makeGenesisTool();
    await runDrive({ siteDir: 'sites/fixture', siteRoot, endpoint: 'https://fixture.example/mcp', tool, dryRun: false, noRelease: false });
    log.length = 0; // only inspect the SECOND run

    const exitCode = await runDrive({ siteDir: 'sites/fixture', siteRoot, endpoint: 'https://fixture.example/mcp', tool, dryRun: false, noRelease: false });
    assert.equal(exitCode, 0);

    const names = log.map((entry) => entry.name);
    assert.deepEqual(names.filter((name) => name === 'create_pdf_template'), []);
    assert.deepEqual(names.filter((name) => name === 'object_patch'), []);
  } finally {
    fs.rmSync(siteRoot, { recursive: true, force: true });
  }
});
