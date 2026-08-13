#!/usr/bin/env node
/**
 * T12.10 draft preview — render the EMITTED drafts and screenshot them, with
 * no publish, no release, and no deploy anywhere in the path.
 *
 * ## Why this exists
 *
 * The first acceptance run (T12.6) scored 0 visual comparisons out of 34: the
 * scorer had source screenshots and nothing to compare them to, because a
 * captured draft is an unpublished object graph and unpublished objects do not
 * render. Structural coverage cannot answer "does this look like the target",
 * and Wolf cannot review a clone he cannot see.
 *
 * ## How a draft renders without being published
 *
 * A published page reaches the reader through three stages: `object_publish`
 * writes a derived export, `release_to_production` commits it into
 * `sites/<client>/data/site/pages/`, and a deploy builds the site. Only the
 * LAST stage is what actually turns an export into HTML — the first two are
 * governance, and they are exactly what a preview must not touch.
 *
 * So the preview keeps the third stage and replaces the first two with a
 * throwaway copy of the tenant:
 *
 *   1. copy `sites/<client>` into a scratch directory under `.tmp/` (never the
 *      working tree, never git, never a commit);
 *   2. write each emitted draft page body into the COPY's committed-export
 *      directory, at a preview-only route (`/__draft-preview/<page object id>`)
 *      so it can never collide with a real route the tenant already serves —
 *      the object-page catch-all then serves it like any other page object;
 *   3. apply the captured theme draft to the COPY's site object `brandTokens`
 *      — the same tokens `site_apply_theme` would write, applied to a scratch
 *      file instead of a live store, so the preview shows the captured palette;
 *   4. run the ordinary Astro build against the copy and serve `dist/` on
 *      localhost.
 *
 * Nothing here is a second renderer: the drafts render through the real
 * `PageObjectRenderer` → section-component registry path, which is the point.
 * The forbidden verbs (`object_publish`, `release_to_production`,
 * `trigger_netlify_build`, `deploy`) are never called and are recorded as
 * refused in the manifest.
 *
 * ## What it produces
 *
 * `capture-preview.v1` — the manifest `score.mjs --preview` has always
 * expected: per page, per emitted block, per viewport, the path to a
 * screenshot of the emitted block. Screenshots are taken through the shared
 * capture browser plane (`browser.mjs`) at the SAME viewports as the source
 * capture (390×844, 1440×1000); a preview shot at any other size would make
 * the per-block diff meaningless.
 *
 * The source↔preview join is the section annotation the renderer already
 * stamps on every dispatched section (`data-cms-object-id` /
 * `data-cms-section-id`, section-annotations.ts): the mapper records which
 * source blocks became which candidate section, so the emitted section's
 * rendered box is the emitted counterpart of that source block.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  CAPTURE_VIEWPORTS,
  VIEWPORT_SETTLE_DELAY_MS,
  gotoSettled,
  launchCaptureBrowser,
  screenshotElement,
  screenshotFullPage,
  settleLazyContent,
} from './browser.mjs';
import { writeJson } from './snapshot-v1.mjs';

const execFileAsync = promisify(execFile);

export const PREVIEW_SCHEMA_VERSION = 'capture-preview.v1';
/**
 * Preview routes live under one reserved prefix. Draft routes are REWRITTEN
 * onto it rather than served at their emitted route: a captured home page
 * claims `/`, which the tenant already owns, and a preview must never depend
 * on winning that fight (the T12.6 emission quarantined exactly that page).
 */
export const DRAFT_PREVIEW_ROUTE_PREFIX = '/__draft-preview';
/** PageTypes the object-page catch-all deliberately does not serve (W6 loaders). */
const LOADER_OWNED_PAGE_TYPES = new Set(['listing', 'content_detail']);
const FORBIDDEN_VERBS = ['object_publish', 'release_to_production', 'trigger_netlify_build', 'deploy'];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export class PreviewError extends Error {}

const clone = (value) => JSON.parse(JSON.stringify(value));

/** `emit.mjs --dry-run` wraps the plan; a live emission report IS the plan. */
export function emissionPlanOf(document) {
  const plan = document?.plan ?? document;
  if (plan?.schemaVersion !== 'capture-emission-plan.v1')
    throw new PreviewError('Draft preview requires a capture-emission-plan.v1 document (emit.mjs output).');
  return plan;
}

/**
 * Join the emitted page drafts to the mapping that produced them.
 *
 * The emitter creates one page object per mapped page, in mapping order
 * (emit.mjs `buildEmissionPlan`), so the two lists zip — and the zip is
 * verified against `pageRefs` and the emitted route rather than assumed.
 * Every reason a page or block cannot be previewed is recorded as a DEFECT
 * here; nothing is silently dropped, because a silently dropped block is
 * exactly how the 0/34 run looked clean.
 */
export function buildDraftPreviewPlan({ plan, mapping, routePrefix = DRAFT_PREVIEW_ROUTE_PREFIX }) {
  if (mapping?.schemaVersion !== 'capture-map.v1')
    throw new PreviewError('Draft preview requires a capture-map.v1 mapping.');
  const pageCreates = (plan.creates ?? []).filter((operation) => operation.objectType === 'page');
  const mappedPages = mapping.pages ?? [];
  if (pageCreates.length !== mappedPages.length)
    throw new PreviewError(
      `Emission plan has ${pageCreates.length} page drafts for ${mappedPages.length} mapped pages; refusing to guess the pairing.`
    );
  const defects = [];
  const pages = [];
  for (const [index, mapped] of mappedPages.entries()) {
    const create = pageCreates[index];
    if ((plan.pageRefs ?? [])[index] !== mapped.pageRef)
      throw new PreviewError(`Emission plan pageRefs[${index}] does not match the mapping page order.`);
    if (create.body?.route !== mapped.pageBody?.route)
      throw new PreviewError(
        `Emitted page ${create.requestedId} does not carry mapped page ${mapped.pageRef}'s route.`
      );
    const pageObjectId = create.requestedId;
    const previewRoute = `${routePrefix}/${pageObjectId}`;
    if (LOADER_OWNED_PAGE_TYPES.has(create.body.pageType)) {
      defects.push({
        code: 'page_type_not_previewable',
        severity: 'defect',
        pageRef: mapped.pageRef,
        pageObjectId,
        detail: `pageType ${create.body.pageType} binds to a dedicated listing loader, not the object-page catch-all`,
      });
      continue;
    }
    const emittedSectionIds = new Set((create.body.sections ?? []).map((section) => section.id));
    const blocks = [];
    for (const candidate of mapped.candidates ?? []) {
      const sectionId = candidate.section?.id;
      for (const blockRef of candidate.sourceBlockIds ?? []) {
        if (!sectionId || !emittedSectionIds.has(sectionId)) {
          defects.push({
            code: 'mapped_section_absent_from_emitted_page',
            severity: 'defect',
            pageRef: mapped.pageRef,
            blockRef,
            candidateId: candidate.candidateId,
            detail: `candidate section ${sectionId ?? '(none)'} is not in the emitted page body`,
          });
          continue;
        }
        blocks.push({ blockRef, candidateId: candidate.candidateId, sectionId });
      }
    }
    if (blocks.length === 0) {
      defects.push({
        code: 'page_has_no_previewable_block',
        severity: 'defect',
        pageRef: mapped.pageRef,
        pageObjectId,
        detail: 'the emitted page carries no section mapped from a source block',
      });
    }
    pages.push({
      pageRef: mapped.pageRef,
      sourceUrl: mapped.sourceUrl,
      pageObjectId,
      emittedRoute: create.body.route,
      previewRoute,
      body: clone(create.body),
      blocks,
    });
  }
  return { pages, defects };
}

/** The scratch tenant's export: the emitted body at its preview-only route. */
export function draftPageExport(page) {
  return {
    __generated: {
      at: new Date(0).toISOString(),
      from: `t12.10-draft-preview/${page.pageRef}`,
      record_version: 0,
    },
    ...page.body,
    route: page.previewRoute,
  };
}

/**
 * Theme draft → the site object's `brandTokens`.
 *
 * `theme.v1` tokens and `site.brandTokens` are the same shape by construction
 * (theme-tokens.ts is the one key registry both read), so this is a copy, not
 * a translation. It is the preview-only stand-in for `site_apply_theme`: the
 * privileged palette writer is never called, and the write lands in a scratch
 * file that no store, commit, or deploy can see.
 */
export function previewBrandTokens(theme) {
  const tokens = theme?.tokens;
  if (!tokens?.colors || !tokens?.fonts) throw new PreviewError('Theme draft has no tokens.colors/tokens.fonts.');
  return {
    colors: { ...tokens.colors },
    fonts: { ...tokens.fonts },
    ...(tokens.layout ? { layout: { ...tokens.layout } } : {}),
    ...(tokens.shape ? { shape: { ...tokens.shape } } : {}),
    ...(tokens.type ? { type: { ...tokens.type } } : {}),
  };
}

const TEXT_REWRITE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yaml', '.yml']);

async function* walkFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * Copy `sites/<client>` to a scratch directory and repoint it at itself.
 *
 * A site tree names its own repo-relative path in a handful of places
 * (`astro.config.ts`'s `siteDir`, `app/content/config.ts`'s collection bases,
 * `config/site-binding.ts`'s dataRoot). The copy rewrites that literal, which
 * is why the scratch directory is kept at the SAME depth from the repo root as
 * `sites/<client>` — the relative `../../` imports in those files must still
 * resolve.
 */
export async function materializePreviewSite({ siteDir, previewSiteDir, pages, theme }) {
  const source = path.resolve(REPO_ROOT, siteDir);
  const destination = path.resolve(REPO_ROOT, previewSiteDir);
  const relativeSource = path.relative(REPO_ROOT, source);
  const relativeDestination = path.relative(REPO_ROOT, destination);
  if (relativeSource.split(path.sep).length !== relativeDestination.split(path.sep).length)
    throw new PreviewError('The preview site directory must sit at the same depth as the site it copies.');
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry);
      return name !== 'node_modules' && name !== 'dist' && name !== '.netlify';
    },
  });

  for await (const file of walkFiles(destination)) {
    if (!TEXT_REWRITE_EXTENSIONS.has(path.extname(file))) continue;
    const contents = await readFile(file, 'utf8');
    if (!contents.includes(relativeSource)) continue;
    await writeFile(file, contents.split(relativeSource).join(relativeDestination));
  }

  const pagesDir = path.join(destination, 'data', 'site', 'pages');
  await mkdir(pagesDir, { recursive: true });
  for (const page of pages) {
    await writeJson(path.join(pagesDir, `${page.pageObjectId}.json`), draftPageExport(page));
  }

  const siteObjectPath = path.join(destination, 'data', 'site', 'site.json');
  let themeApplied = false;
  if (theme) {
    const siteObject = JSON.parse(await readFile(siteObjectPath, 'utf8'));
    siteObject.brandTokens = previewBrandTokens(theme);
    await writeJson(siteObjectPath, siteObject);
    themeApplied = true;
  }
  return { previewSiteDir: relativeDestination, themeApplied };
}

export async function buildPreviewSite(previewSiteDir) {
  // `--config` is resolved by Astro as `path.join(root, configFile)`, so it
  // must be repo-root-relative; an absolute path silently doubles the root.
  const configPath = path.join(path.relative(REPO_ROOT, path.resolve(REPO_ROOT, previewSiteDir)), 'astro.config.ts');
  await execFileAsync('npx', ['astro', 'build', '--config', configPath], {
    cwd: REPO_ROOT,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', FORCE_COLOR: '0' },
    maxBuffer: 32 * 1024 * 1024,
  });
  return path.join(path.resolve(REPO_ROOT, previewSiteDir), 'dist');
}

const CONTENT_TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  })
);

/**
 * Minimal static file server for the preview `dist/`; loopback only.
 *
 * `port` is optional and defaults to an ephemeral one. The fixture harness
 * pins it, because a captured page's `pageId` is derived from its URL — an
 * ephemeral port would make every regeneration renumber every id and path in
 * the committed fixture.
 */
export async function serveStaticDirectory(root, { port = 0 } = {}) {
  const resolvedRoot = path.resolve(root);
  const server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      let filePath = path.resolve(resolvedRoot, `.${requestPath}`);
      if (path.relative(resolvedRoot, filePath).startsWith('..')) {
        response.writeHead(403).end('forbidden');
        return;
      }
      const info = await stat(filePath).catch(() => null);
      if (info?.isDirectory()) filePath = path.join(filePath, 'index.html');
      else if (!info && !path.extname(filePath)) filePath = `${filePath}/index.html`;
      const body = await readFile(filePath);
      response.writeHead(200, {
        'content-type': CONTENT_TYPES.get(path.extname(filePath)) ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const { port: boundPort } = server.address();
  return {
    origin: `http://127.0.0.1:${boundPort}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The rendered counterpart of a source block: the section the mapper emitted for it. */
export const previewBlockSelector = (pageObjectId, sectionId) =>
  `[data-cms-object-id="${pageObjectId}"][data-cms-section-id="${sectionId}"] > *`;

/**
 * Screenshot every previewed page at both capture viewports, plus each emitted
 * block. Written under `preview/` inside the run root so the source evidence
 * and the preview evidence share one `--screenshot-root`.
 */
export async function screenshotDraftPreview({
  browser,
  origin,
  pages,
  outputRoot,
  viewports = CAPTURE_VIEWPORTS,
  prefix = 'preview',
}) {
  const defects = [];
  const results = [];
  for (const page of pages) {
    const context = await browser.newContext({
      viewport: { width: viewports[0].width, height: viewports[0].height },
      deviceScaleFactor: viewports[0].deviceScaleFactor,
    });
    const browserPage = await context.newPage();
    const pageScreenshots = [];
    const blocks = [];
    try {
      await gotoSettled(browserPage, `${origin}${page.previewRoute}/`);
      for (const viewport of viewports) {
        await browserPage.setViewportSize({ width: viewport.width, height: viewport.height });
        await browserPage.waitForTimeout(VIEWPORT_SETTLE_DELAY_MS);
        await settleLazyContent(browserPage);
        pageScreenshots.push({
          viewportId: viewport.id,
          kind: 'full-page',
          ...(await screenshotFullPage(
            browserPage,
            outputRoot,
            `${prefix}/pages/${page.pageRef}/${viewport.id}/full-page.png`
          )),
        });
        for (const block of page.blocks) {
          const screenshotPath = `${prefix}/pages/${page.pageRef}/${viewport.id}/blocks/${block.blockRef}.png`;
          try {
            const locator = browserPage.locator(previewBlockSelector(page.pageObjectId, block.sectionId)).first();
            const written = await screenshotElement(locator, outputRoot, screenshotPath);
            blocks.push({
              blockRef: block.blockRef,
              candidateId: block.candidateId,
              sectionId: block.sectionId,
              viewportId: viewport.id,
              screenshotPath: written.path,
              sha256: written.sha256,
              byteLength: written.byteLength,
            });
          } catch (error) {
            defects.push({
              code: 'preview_block_screenshot_failed',
              severity: 'defect',
              pageRef: page.pageRef,
              blockRef: block.blockRef,
              viewportId: viewport.id,
              detail: String(error.message ?? error).slice(0, 300),
            });
          }
        }
      }
    } catch (error) {
      defects.push({
        code: 'preview_page_render_failed',
        severity: 'defect',
        pageRef: page.pageRef,
        detail: String(error.message ?? error).slice(0, 300),
      });
    } finally {
      await context.close();
    }
    results.push({
      pageRef: page.pageRef,
      sourceUrl: page.sourceUrl,
      pageObjectId: page.pageObjectId,
      emittedRoute: page.emittedRoute,
      previewRoute: page.previewRoute,
      screenshots: pageScreenshots,
      blocks,
    });
  }
  return { pages: results, defects };
}

export function buildPreviewManifest({
  target,
  plan,
  mapping,
  previewSiteDir,
  siteDir,
  themeApplied,
  pages,
  defects,
  viewports = CAPTURE_VIEWPORTS,
}) {
  return {
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    task: 'T12.10',
    target,
    generatedAt: new Date().toISOString(),
    source: {
      targetUrl: plan.source?.targetUrl ?? mapping.source?.targetUrl ?? null,
      mappingGeneratedAt: mapping.generatedAt ?? null,
    },
    preview: {
      mechanism: 'local_astro_build_of_scratch_tenant_copy',
      siteDir,
      previewSiteDir,
      routePrefix: DRAFT_PREVIEW_ROUTE_PREFIX,
      themeApplied,
      published: false,
      released: false,
      deployed: false,
      refusedVerbs: [...FORBIDDEN_VERBS].sort(),
    },
    viewports: viewports.map((viewport) => ({ ...viewport })),
    pages,
    defects,
    defectCount: defects.length,
  };
}

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    'Usage: node packages/core/cli/capture/preview.mjs --target <project> --plan <emission-plan.json> --mapping <capture-map.v1.json> --site <sites/client> --run-root <capture run dir> --out <capture-preview.v1.json> [--theme <theme.v1.json>] [--preview-site-dir <.tmp/dir>] [--browser-executable <path>] [--keep]'
  );
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') usage();
    if (!key.startsWith('--')) usage(`Unexpected argument: ${key}`);
    if (key === '--keep') {
      args.keep = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for ${key}`);
    args[key.slice(2)] = value;
    index += 1;
  }
  for (const required of ['target', 'plan', 'mapping', 'site', 'run-root', 'out'])
    if (!args[required]) usage(`Missing --${required}`);
  return args;
}

const readJson = async (file) => JSON.parse(await readFile(path.resolve(file), 'utf8'));

/** The whole preview run: materialize → build → serve → screenshot → manifest. */
export async function runDraftPreview({
  target,
  planDocument,
  mapping,
  theme,
  siteDir,
  runRoot,
  previewSiteDir,
  browserExecutable,
  keep = false,
}) {
  const plan = emissionPlanOf(planDocument);
  const { pages: previewPages, defects: planDefects } = buildDraftPreviewPlan({ plan, mapping });
  const materialized = await materializePreviewSite({ siteDir, previewSiteDir, pages: previewPages, theme });
  let server;
  let browser;
  try {
    const distDir = await buildPreviewSite(previewSiteDir);
    server = await serveStaticDirectory(distDir);
    ({ browser } = await launchCaptureBrowser(browserExecutable));
    const shot = await screenshotDraftPreview({
      browser,
      origin: server.origin,
      pages: previewPages,
      outputRoot: runRoot,
    });
    return buildPreviewManifest({
      target,
      plan,
      mapping,
      siteDir,
      previewSiteDir: materialized.previewSiteDir,
      themeApplied: materialized.themeApplied,
      pages: shot.pages,
      defects: [...planDefects, ...shot.defects],
    });
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    if (!keep) await rm(path.resolve(REPO_ROOT, previewSiteDir), { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [planDocument, mapping, theme] = await Promise.all([
    readJson(args.plan),
    readJson(args.mapping),
    args.theme ? readJson(args.theme) : null,
  ]);
  const manifest = await runDraftPreview({
    target: args.target,
    planDocument,
    mapping,
    theme,
    siteDir: args.site,
    runRoot: path.resolve(args['run-root']),
    previewSiteDir: args['preview-site-dir'] ?? `.tmp/capture-preview-${args.target.replace(/[^a-z0-9-]/gi, '')}`,
    browserExecutable: args['browser-executable'],
    keep: args.keep,
  });
  await writeJson(path.resolve(args.out), manifest);
  console.log(
    JSON.stringify(
      {
        ok: manifest.defectCount === 0,
        out: path.resolve(args.out),
        pages: manifest.pages.length,
        previewBlockScreenshots: manifest.pages.reduce((total, page) => total + page.blocks.length, 0),
        defects: manifest.defects,
      },
      null,
      2
    )
  );
  if (manifest.defectCount > 0) process.exitCode = 3;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
