/**
 * The side-by-side review artifact (T12.10) — the human-readable face of the
 * fidelity report.
 *
 * A number cannot be reviewed. This renders one self-contained HTML page that
 * puts the SOURCE block next to the EMITTED block, per page and per viewport,
 * with that pair's score printed underneath, so the T12.6 gate is a
 * walk-through instead of a percentage. Images are referenced by relative path
 * into the run root — the artifact travels with the evidence it describes and
 * never inlines megabytes of base64.
 *
 * It is evidence, not authority: the rubric verdict is reproduced verbatim from
 * the fidelity report and nothing here can change it. Unavailable comparisons
 * are rendered as loud DEFECT rows, for the same reason score.mjs enumerates
 * them — a hole in the evidence must be visible from across the room.
 */
import path from 'node:path';

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const percent = (value) => (typeof value === 'number' ? `${(value * 100).toFixed(2)}%` : '—');

const STYLE = `
:root { color-scheme: light; }
body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; margin: 0; padding: 32px; background: #f6f7f9; color: #1b1f24; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 40px 0 4px; }
h3 { font-size: 15px; margin: 24px 0 8px; font-weight: 600; color: #444c56; }
.meta { color: #57606a; font-size: 13px; margin: 0 0 4px; }
.summary { background: #fff; border: 1px solid #d8dee4; border-radius: 8px; padding: 16px 20px; margin: 20px 0 8px; }
.summary dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
.summary dt { color: #57606a; }
.summary dd { margin: 0; font-variant-numeric: tabular-nums; }
.pair { background: #fff; border: 1px solid #d8dee4; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
.pair header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; }
.pair code { font-size: 12px; color: #57606a; }
.frames { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 10px; }
.frame { min-width: 0; }
.frame span { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #57606a; margin-bottom: 6px; }
.frame img { max-width: 100%; height: auto; border: 1px solid #d8dee4; border-radius: 4px; background: #fff; display: block; }
.score { font-variant-numeric: tabular-nums; font-weight: 600; }
.defect { border-color: #cf222e; background: #fff5f5; }
.defect .tag { color: #cf222e; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; font-size: 12px; }
.verdict { font-weight: 700; }
.note { color: #57606a; font-size: 13px; max-width: 70ch; }
`;

const sourceScreenshotIndex = (snapshot) => {
  const index = new Map();
  for (const page of snapshot?.pages ?? []) {
    for (const block of page.blocks ?? []) {
      for (const shot of block.screenshots ?? []) {
        if (shot.kind !== 'block' || !shot.captured) continue;
        index.set(`${page.pageId}\0${block.id}\0${shot.viewportId}`, shot.path);
      }
    }
  }
  return index;
};

const previewFullPageIndex = (manifest) => {
  const index = new Map();
  for (const page of manifest?.pages ?? []) {
    for (const shot of page.screenshots ?? []) {
      if (shot.kind === 'full-page') index.set(`${page.pageRef}\0${shot.viewportId}`, shot.path);
    }
  }
  return index;
};

const sourceFullPageIndex = (snapshot) => {
  const index = new Map();
  for (const page of snapshot?.pages ?? []) {
    for (const shot of page.screenshots ?? []) {
      if (shot.kind === 'full-page' && shot.captured) index.set(`${page.pageId}\0${shot.viewportId}`, shot.path);
    }
  }
  return index;
};

/**
 * @param report        capture-fidelity-report.v1 (carries the comparisons + scores)
 * @param snapshot      snapshot.v1 (source screenshot paths + page URLs)
 * @param previewManifest capture-preview.v1 (preview screenshot paths)
 * @param screenshotRoot  run root every path above is relative to
 * @param outPath         where the HTML will be written (for relative image srcs)
 */
export function renderSideBySideHtml({ report, snapshot, previewManifest, screenshotRoot, outPath }) {
  const outDirectory = path.dirname(path.resolve(outPath));
  const href = (relativePath) =>
    escapeHtml(path.relative(outDirectory, path.resolve(screenshotRoot, relativePath)).split(path.sep).join('/'));
  const sourceShots = sourceScreenshotIndex(snapshot);
  const sourceFull = sourceFullPageIndex(snapshot);
  const previewFull = previewFullPageIndex(previewManifest);
  const previewPages = new Map((previewManifest?.pages ?? []).map((page) => [page.pageRef, page]));
  const byPage = new Map();
  for (const comparison of report?.visual?.comparisons ?? []) {
    byPage.set(comparison.pageRef, [...(byPage.get(comparison.pageRef) ?? []), comparison]);
  }

  const frame = (label, relativePath) =>
    relativePath
      ? `<div class="frame"><span>${escapeHtml(label)}</span><img loading="lazy" src="${href(relativePath)}" alt="${escapeHtml(label)}" /></div>`
      : `<div class="frame"><span>${escapeHtml(label)}</span><p class="note">not available</p></div>`;

  const sections = (report?.pages ?? []).map((page) => {
    const preview = previewPages.get(page.pageRef);
    const comparisons = byPage.get(page.pageRef) ?? [];
    const fullPagePairs = (previewManifest?.viewports ?? [])
      .map((viewport) => {
        const sourcePath = sourceFull.get(`${page.pageRef}\0${viewport.id}`);
        const previewPath = previewFull.get(`${page.pageRef}\0${viewport.id}`);
        if (!sourcePath && !previewPath) return '';
        return `<div class="pair"><header><strong>Whole page — ${escapeHtml(viewport.id)}</strong><code>${viewport.width}×${viewport.height}</code></header><div class="frames">${frame('source', sourcePath)}${frame('emitted draft', previewPath)}</div></div>`;
      })
      .join('');
    const blockPairs = comparisons
      .map((comparison) => {
        const sourcePath =
          comparison.sourceScreenshot ??
          sourceShots.get(`${page.pageRef}\0${comparison.blockRef}\0${comparison.viewportId}`);
        if (comparison.status !== 'scored') {
          return `<div class="pair defect"><header><strong>${escapeHtml(comparison.blockRef)} — ${escapeHtml(comparison.viewportId)}</strong><span class="tag">defect · ${escapeHtml(comparison.reason ?? 'unavailable')}</span></header><div class="frames">${frame('source', sourcePath)}${frame('emitted draft', comparison.previewScreenshot)}</div></div>`;
        }
        return `<div class="pair"><header><strong>${escapeHtml(comparison.blockRef)} — ${escapeHtml(comparison.viewportId)}</strong><span class="score">score ${percent(comparison.score)}</span></header><code>${escapeHtml(comparison.candidateId ?? '')}</code><div class="frames">${frame('source', sourcePath)}${frame('emitted draft', comparison.previewScreenshot)}</div></div>`;
      })
      .join('');
    return `<section><h2>${escapeHtml(page.pageRef)}</h2><p class="meta">source ${escapeHtml(page.sourceUrl ?? '—')} → preview route ${escapeHtml(preview?.previewRoute ?? '—')} (emitted route ${escapeHtml(preview?.emittedRoute ?? '—')})</p><p class="meta">mapped-block coverage ${percent(page.structural?.mappedBlockCoverage)} · ${page.structural?.mappedBlocks ?? 0}/${page.structural?.sourceBlocks ?? 0} blocks</p><h3>Whole page</h3>${fullPagePairs || '<p class="note">no full-page evidence</p>'}<h3>Block by block</h3>${blockPairs || '<p class="note">no block comparisons</p>'}</section>`;
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Capture fidelity — source vs emitted draft (${escapeHtml(report?.target ?? '')})</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Source vs emitted draft</h1>
<p class="meta">target project <strong>${escapeHtml(report?.target ?? '—')}</strong> · source ${escapeHtml(report?.source?.targetUrl ?? '—')}</p>
<div class="summary">
<dl>
<dt>Rubric verdict</dt><dd class="verdict">${escapeHtml(report?.rubric?.verdict ?? '—')}</dd>
<dt>Mapped coverage</dt><dd>${percent(report?.rubric?.coverage?.score)} against a ${percent(report?.rubric?.coverage?.minimum)} minimum</dd>
<dt>Visual comparisons</dt><dd>${report?.visual?.scoredCount ?? 0} scored / ${report?.visual?.unavailableCount ?? 0} unavailable</dd>
<dt>Aggregate visual score</dt><dd>${percent(report?.visual?.aggregateScore)}</dd>
<dt>Evidence defects</dt><dd>${report?.visual?.defectCount ?? 0}</dd>
<dt>Preview mechanism</dt><dd>${escapeHtml(previewManifest?.preview?.mechanism ?? '—')} · published ${String(previewManifest?.preview?.published ?? false)} · released ${String(previewManifest?.preview?.released ?? false)} · deployed ${String(previewManifest?.preview?.deployed ?? false)}</dd>
</dl>
</div>
<p class="note">Visual evidence explains where a draft differs; it never authorizes a publish, a release, or a CSS change to chase pixels. Both sides are screenshotted at the same capture viewports and normalized onto one comparison raster before scoring.</p>
${sections.join('\n')}
</body>
</html>
`;
}
