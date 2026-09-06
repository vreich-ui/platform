import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReportHtml,
  buildReportJson,
  chartTable,
  csvFilename,
  footerTable,
  kpiTable,
  panelTables,
  rankingViewTable,
  rawExportFilename,
  reportFilename,
  tableToCsv,
  type ExportMeta,
} from './analytics-export-logic.js';
import type { AnalyticsPanelReady, RankingView } from './analytics-logic.js';

// ─── CSV ────────────────────────────────────────────────────────────────────

test('tableToCsv escapes commas, quotes, and embedded newlines per RFC 4180', () => {
  const csv = tableToCsv({
    title: 'Pages',
    columns: ['Label', 'Visits'],
    rows: [
      ['/plain', 12],
      ['/has,comma', 3],
      ['/has "quote"', 1],
      ['/has\nnewline', 0],
    ],
  });
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines[0], 'Label,Visits');
  assert.equal(lines[1], '/plain,12');
  assert.equal(lines[2], '"/has,comma",3');
  assert.equal(lines[3], '"/has ""quote""",1');
  assert.equal(lines[4], '"/has\nnewline",0');
});

test('tableToCsv on zero rows still emits the header line', () => {
  const csv = tableToCsv({ title: 'Empty', columns: ['A', 'B'], rows: [] });
  assert.equal(csv, 'A,B\r\n');
});

// ─── panel fixture: a small, hand-built AnalyticsPanelReady standing in for what the dashboard actually renders ──

function fixturePanel(): AnalyticsPanelReady {
  const pagesView: RankingView = {
    id: 'top',
    label: 'Top',
    rows: [
      { label: '/skincare-basics', visits: 120, share: 1 },
      { label: '/retinol-guide', visits: 60, share: 0.5 },
    ],
    emptyMessage: 'No pages yet.',
  };
  return {
    kind: 'ready',
    kpis: [
      { id: 'visits', label: 'Pageviews', value: '1,200', delta: { pct: 12.3, direction: 'up', label: '▲ 12.3%' } },
      { id: 'uniques', label: 'Unique visitors', value: '900' },
    ],
    chart: {
      points: [
        { t: '2026-08-01', visits: 100, uniques: 80 },
        { t: '2026-08-02', visits: 140, uniques: 95 },
      ],
      seriesALabel: 'Visits',
      seriesBLabel: 'Uniques',
      emptyMessage: 'No data in this window.',
    },
    rankings: [{ id: 'pages', title: 'Pages', views: [pagesView] }],
    footer: [{ id: 'health', label: 'Capture rate', value: '94%' }],
  };
}

test('rankingViewTable matches the on-screen rows for a fixture card exactly, and a single-view card gets the plain card title', () => {
  const panel = fixturePanel();
  const table = rankingViewTable(panel.rankings[0]!.title, panel.rankings[0]!.views[0]!, true);
  assert.equal(table.title, 'Pages');
  assert.deepEqual(table.columns, ['Label', 'Visits', 'Share of top row']);
  assert.deepEqual(table.rows, [
    ['/skincare-basics', 120, '100%'],
    ['/retinol-guide', 60, '50%'],
  ]);
});

test('rankingViewTable qualifies the title with the internal-tab label on a multi-view card, matching the on-screen tab chrome', () => {
  const view: RankingView = { id: 'entry', label: 'Entry', rows: [], emptyMessage: 'x' };
  const table = rankingViewTable('Pages', view, false);
  assert.equal(table.title, 'Pages — Entry');
});

test('kpiTable carries the delta label verbatim, and an empty string when there is none', () => {
  const table = kpiTable(fixturePanel().kpis);
  assert.deepEqual(table.rows, [
    ['Pageviews', '1,200', '▲ 12.3%'],
    ['Unique visitors', '900', ''],
  ]);
});

test('chartTable is one row per trend point, columns named from the series labels', () => {
  const table = chartTable(fixturePanel().chart);
  assert.deepEqual(table.columns, ['Date', 'Visits', 'Uniques']);
  assert.deepEqual(table.rows, [
    ['2026-08-01', 100, 80],
    ['2026-08-02', 140, 95],
  ]);
});

test('footerTable carries label/value pairs', () => {
  const table = footerTable(fixturePanel().footer);
  assert.deepEqual(table.rows, [['Capture rate', '94%']]);
});

test('panelTables walks KPIs, chart, every ranking view, then the footer, in render order', () => {
  const tables = panelTables(fixturePanel());
  assert.deepEqual(
    tables.map((t) => t.title),
    ['KPIs', 'Trend', 'Pages', 'Health']
  );
});

test('panelTables omits the footer table when there is no footer', () => {
  const panel = { ...fixturePanel(), footer: [] };
  const tables = panelTables(panel);
  assert.deepEqual(
    tables.map((t) => t.title),
    ['KPIs', 'Trend', 'Pages']
  );
});

// ─── report JSON / HTML ─────────────────────────────────────────────────────

const meta: ExportMeta = {
  tab: 'own',
  range: '30 days',
  compare: true,
  filters: { Country: 'IL' },
  viewName: 'Weekly review',
  generatedAt: '2026-09-05T00:00:00.000Z',
};

test('buildReportJson carries every panel table plus the view meta', () => {
  const tables = panelTables(fixturePanel());
  const report = buildReportJson(meta, tables);
  assert.equal(report.generated_at, meta.generatedAt);
  assert.equal(report.tab, 'own');
  assert.equal(report.view_name, 'Weekly review');
  assert.equal(report.panels.length, tables.length);
  assert.deepEqual(report.panels[0], tables[0]);
});

test('buildReportHtml names every panel and escapes untrusted row text', () => {
  const tables = [{ title: 'Pages', columns: ['Label'], rows: [['<script>alert(1)</script>']] }];
  const html = buildReportHtml(meta, tables);
  assert.match(html, /<h2>Pages<\/h2>/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Weekly review/);
  assert.match(html, /Country: IL/);
});

test('buildReportHtml renders a named empty state for a table with zero rows, not a blank body', () => {
  const html = buildReportHtml(meta, [{ title: 'Sources', columns: ['Label'], rows: [] }]);
  assert.match(html, /No rows/);
});

// ─── filenames ──────────────────────────────────────────────────────────────

test('csvFilename and reportFilename slugify the title/range into a safe filename', () => {
  assert.equal(csvFilename('Pages — Entry', '30 days'), 'analytics-pages-entry-30-days.csv');
  assert.equal(reportFilename('7 days', 'json'), 'analytics-report-7-days.json');
  assert.equal(reportFilename('7 days', 'html'), 'analytics-report-7-days.html');
});

test('rawExportFilename encodes kind and the from/to window', () => {
  assert.equal(rawExportFilename('events', '2026-08-01', '2026-08-31'), 'tracking-events-2026-08-01-2026-08-31.ndjson');
});
