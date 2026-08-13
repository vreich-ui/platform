#!/usr/bin/env node
/**
 * Regenerate the T12.10 draft-preview fixture — the whole capture pipeline,
 * end to end, offline, against a synthetic source site.
 *
 *   node scripts/capture-preview-fixture.mjs [--site sites/fernwell] [--keep]
 *
 * Why a synthetic source: the committed Zilberman fixtures are a REDACTED,
 * byte-free subset — no screenshot binaries — so nothing in the repo could
 * produce a scored visual comparison, which is exactly the hole T12.10 closes.
 * This fixture invents its own two-page publisher
 * (`packages/core/cli/capture/fixtures/preview-fixture/source-site/`), serves it
 * on loopback, and runs capture → map → theme → emit (dry run) → PREVIEW →
 * score against it. No third party's pixels are committed, no network is
 * touched, and anyone can regenerate it.
 *
 * The five stages are the real ones (`packages/core/cli/capture/*.mjs`); this
 * script only wires them together and pins the inputs. The one thing it does
 * differently from a live run is the crawl: `capture.mjs` is the policy gate
 * (robots, HTTPS origins, page ceilings) and a loopback fixture is deliberately
 * outside what a capture policy may ever authorize, so the fixture drives the
 * shared browser plane (`browser.mjs`) directly over a fixed page list. The
 * EXTRACTION and the SCREENSHOTS are identical code either way — that is the
 * point of the shared module.
 *
 * Output: `packages/core/cli/capture/fixtures/preview-fixture/run/`, committed,
 * including the source and preview PNGs the scorer needs and the side-by-side
 * review artifact. Regenerating twice must produce identical visual scores; the
 * suite proves reproducibility over the committed artifacts.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { CAPTURE_VIEWPORTS, capturePageSnapshot, launchCaptureBrowser } from '../packages/core/cli/capture/browser.mjs';
import { buildEmissionPlan } from '../packages/core/cli/capture/emit.mjs';
import { mapSnapshot } from '../packages/core/cli/capture/map.mjs';
import { runDraftPreview, serveStaticDirectory } from '../packages/core/cli/capture/preview.mjs';
import { scoreCaptureFidelity } from '../packages/core/cli/capture/score.mjs';
import { renderSideBySideHtml } from '../packages/core/cli/capture/side-by-side.mjs';
import { SNAPSHOT_SCHEMA_VERSION, stablePageId, writeJson } from '../packages/core/cli/capture/snapshot-v1.mjs';
import { extractTheme } from '../packages/core/cli/capture/theme.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'packages/core/cli/capture/fixtures/preview-fixture');
const SOURCE_SITE_DIR = path.join(FIXTURE_DIR, 'source-site');
const RUN_DIR = path.join(FIXTURE_DIR, 'run');
/** The fixture's page list, in crawl order. */
const SOURCE_PATHS = ['/', '/about'];
export const FIXTURE_TARGET = 'fixture-preview-target';
/**
 * Pinned loopback port for the source site. A page's `pageId` hashes its URL,
 * so an ephemeral port would renumber every id, path, and screenshot filename
 * on each regeneration. If the port is busy the run fails loudly rather than
 * quietly producing a different fixture.
 */
const FIXTURE_SOURCE_PORT = 8913;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

async function main() {
  const siteDir = flag('site', 'sites/fernwell');
  const keep = args.includes('--keep');
  await rm(RUN_DIR, { recursive: true, force: true });

  const sourceServer = await serveStaticDirectory(SOURCE_SITE_DIR, { port: FIXTURE_SOURCE_PORT });
  const { browser, executablePath } = await launchCaptureBrowser(flag('browser-executable'));
  let snapshot;
  try {
    const pages = [];
    for (const sourcePath of SOURCE_PATHS) {
      const url = `${sourceServer.origin}${sourcePath}`;
      pages.push(
        await capturePageSnapshot({
          browser,
          url,
          outputRoot: RUN_DIR,
          viewports: CAPTURE_VIEWPORTS,
          pageId: stablePageId(url),
          sameOriginNavigationOnly: sourceServer.origin,
        })
      );
    }
    snapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      capture: {
        targetUrl: `${sourceServer.origin}/`,
        origin: sourceServer.origin,
        capturedAt: new Date().toISOString(),
        localOnly: true,
        redacted: false,
        // No capture policy authorized this: it is a loopback FIXTURE, not a
        // crawl. A policy may only ever name HTTPS origins (T12.7), so
        // recording a policy-shaped object here would be a lie about authority.
        fixture: 'T12.10 draft-preview fixture; synthetic source site served on loopback',
        contentTreatment: 'page content was recorded as data and never interpreted as instructions',
        crawler: { userAgent: 'W12CaptureFixture/1.0', browserExecutable: executablePath, concurrency: 1, delayMs: 0 },
        viewports: CAPTURE_VIEWPORTS.map((viewport) => ({ ...viewport })),
      },
      pages,
      diagnostics: {
        queuedUrls: SOURCE_PATHS.length,
        capturedPages: pages.length,
        skipped: [],
        quarantined: [],
        stoppedAtProjectMaxPages: false,
      },
    };
  } finally {
    await browser.close();
    await sourceServer.close();
  }
  await writeJson(path.join(RUN_DIR, 'snapshot.v1.json'), snapshot);

  const mapping = mapSnapshot(snapshot);
  await writeJson(path.join(RUN_DIR, 'mapping.v1.json'), mapping);

  const theme = extractTheme(snapshot).body;
  await writeJson(path.join(RUN_DIR, 'theme.v1.json'), theme);

  const plan = buildEmissionPlan({ target: FIXTURE_TARGET, mapping, theme });
  await writeJson(path.join(RUN_DIR, 'emission-plan.v1.json'), plan);

  const previewManifest = await runDraftPreview({
    target: FIXTURE_TARGET,
    planDocument: plan,
    mapping,
    theme,
    siteDir,
    runRoot: RUN_DIR,
    previewSiteDir: '.tmp/capture-preview-fixture',
    browserExecutable: flag('browser-executable'),
    keep,
  });
  await writeJson(path.join(RUN_DIR, 'capture-preview.v1.json'), previewManifest);

  const report = await scoreCaptureFidelity({
    snapshot,
    mapping,
    theme,
    target: FIXTURE_TARGET,
    previewManifest,
    screenshotRoot: RUN_DIR,
  });
  await writeJson(path.join(RUN_DIR, 'fidelity-report.v1.json'), report);

  const sideBySidePath = path.join(RUN_DIR, 'side-by-side.html');
  await writeFile(
    sideBySidePath,
    renderSideBySideHtml({ report, snapshot, previewManifest, screenshotRoot: RUN_DIR, outPath: sideBySidePath })
  );

  console.log(
    JSON.stringify(
      {
        ok: previewManifest.defectCount === 0 && report.visual.evidenceComplete,
        pages: report.pages.map((page) => ({
          pageRef: page.pageRef,
          mappedBlockCoverage: page.structural.mappedBlockCoverage,
        })),
        visual: {
          scoredCount: report.visual.scoredCount,
          unavailableCount: report.visual.unavailableCount,
          aggregateScore: report.visual.aggregateScore,
          defectCount: report.visual.defectCount,
        },
        previewDefects: previewManifest.defects,
        rubricVerdict: report.rubric.verdict,
        run: path.relative(REPO_ROOT, RUN_DIR),
      },
      null,
      2
    )
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}

export { main as regenerateDraftPreviewFixture, RUN_DIR, SOURCE_SITE_DIR, readFile };
