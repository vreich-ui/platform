/**
 * Analytics export (T21.28; runner R11.2) — pure logic. Every table this
 * module builds is derived from the SAME `AnalyticsPanelReady` shape the
 * dashboard already renders from (`analytics-logic.ts`'s
 * `resolveNetlifyAnalyticsPanel` / `own-analytics-logic.ts`'s
 * `resolveOwnAnalyticsPanel`) — never a parallel query or recomputation.
 * "Matches exactly what is on screen" (same filters, range, exclusions) is
 * therefore true by construction: a card's CSV is the same rows array the
 * card rendered from, just serialized differently.
 *
 * No I/O, no `Date.now()` — the caller (the component, for the two
 * client-only formats; `admin-analytics.ts` for nothing here, since the raw
 * event export is a separate proxy in `server/lib/own-tracker-stats.ts`)
 * always passes `generatedAt` explicitly.
 */
import type {
  AnalyticsChartView,
  AnalyticsFooterItem,
  AnalyticsPanelReady,
  KpiDatum,
  RankingView,
} from './analytics-logic.js';

// ─── the generic table shape every export format serializes ───────────────

export interface ExportTable {
  title: string;
  columns: string[];
  rows: (string | number)[][];
}

// ─── CSV ────────────────────────────────────────────────────────────────────

/** RFC 4180: quote a cell that contains a comma, quote, or newline; double up embedded quotes. */
const csvCell = (value: string | number): string => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** `\r\n` line endings — the RFC 4180 default, and what every spreadsheet app expects without a BOM/encoding guess. */
export function tableToCsv(table: ExportTable): string {
  const lines = [table.columns.map(csvCell).join(','), ...table.rows.map((row) => row.map(csvCell).join(','))];
  return lines.map((line) => `${line}\r\n`).join('');
}

// ─── panel → tables (one card == one table, so "Export CSV" on a card is `tableToCsv(theOneTable)`) ──

const SHARE_COLUMN = 'Share of top row';

/**
 * One ranking view (a card, or one internally-tabbed view of a card) → one
 * exportable table. `isOnlyView` mirrors `RankingView.label`'s own contract
 * ("ignored when the card has only one view", `analytics-logic.ts`) — a
 * single-view card's export title is just the card title, matching what
 * actually renders (no tab chrome to read a label off of).
 */
export function rankingViewTable(groupTitle: string, view: RankingView, isOnlyView = false): ExportTable {
  return {
    title: !isOnlyView && view.label ? `${groupTitle} — ${view.label}` : groupTitle,
    columns: ['Label', 'Visits', SHARE_COLUMN],
    rows: view.rows.map((row) => [row.label, row.visits, `${Math.round(row.share * 1000) / 10}%`]),
  };
}

export function kpiTable(kpis: readonly KpiDatum[]): ExportTable {
  return {
    title: 'KPIs',
    columns: ['Metric', 'Value', 'Change vs previous period'],
    rows: kpis.map((kpi) => [kpi.label, kpi.value, kpi.delta?.label ?? '']),
  };
}

/** The chart's own trend points — same rows the uPlot series draws from, both the primary and (when compare is on) the previous-period ghost series get their own row keyed by date. */
export function chartTable(chart: AnalyticsChartView): ExportTable {
  const rows: (string | number)[][] = chart.points.map((point) => [point.t, point.visits, point.uniques]);
  return {
    title: 'Trend',
    columns: ['Date', chart.seriesALabel, chart.seriesBLabel],
    rows,
  };
}

export function footerTable(items: readonly AnalyticsFooterItem[]): ExportTable {
  return {
    title: 'Health',
    columns: ['Metric', 'Value'],
    rows: items.map((item) => [item.label, item.value]),
  };
}

/** Every table on the page, in the order the page renders them — what "Export report" (JSON/HTML) walks. */
export function panelTables(panel: AnalyticsPanelReady): ExportTable[] {
  const tables: ExportTable[] = [kpiTable(panel.kpis), chartTable(panel.chart)];
  for (const group of panel.rankings) {
    const isOnlyView = group.views.length === 1;
    for (const view of group.views) tables.push(rankingViewTable(group.title, view, isOnlyView));
  }
  if (panel.footer.length > 0) tables.push(footerTable(panel.footer));
  return tables;
}

// ─── whole-page report: JSON + printable HTML ──────────────────────────────

export interface ExportMeta {
  tab: 'own' | 'netlify';
  /** Human-readable range text, e.g. "30 days" or "2026-08-01 – 2026-08-15". */
  range: string;
  compare: boolean;
  /** Rendered filter chips, e.g. { Country: "IL" } — empty object when none are active. */
  filters: Readonly<Record<string, string>>;
  /** The active saved view's name, when the report was exported from one. */
  viewName?: string;
  generatedAt: string;
}

export interface AnalyticsReportJson {
  generated_at: string;
  tab: 'own' | 'netlify';
  range: string;
  compare: boolean;
  filters: Readonly<Record<string, string>>;
  view_name?: string;
  panels: ExportTable[];
}

export function buildReportJson(meta: ExportMeta, tables: readonly ExportTable[]): AnalyticsReportJson {
  return {
    generated_at: meta.generatedAt,
    tab: meta.tab,
    range: meta.range,
    compare: meta.compare,
    filters: meta.filters,
    view_name: meta.viewName,
    panels: tables.map((table) => ({ title: table.title, columns: table.columns, rows: table.rows })),
  };
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A self-contained, printable HTML document (inline CSS, no external assets) — "print to PDF" from the browser is the delivery mechanism, not a server-rendered PDF. */
export function buildReportHtml(meta: ExportMeta, tables: readonly ExportTable[]): string {
  const filterEntries = Object.entries(meta.filters).filter(([, value]) => value);
  const filterText =
    filterEntries.length > 0 ? filterEntries.map(([key, value]) => `${key}: ${value}`).join(', ') : 'None';

  const sections = tables
    .map(
      (table) => `
    <section>
      <h2>${escapeHtml(table.title)}</h2>
      <table>
        <thead><tr>${table.columns.map((col) => `<th>${escapeHtml(col)}</th>`).join('')}</tr></thead>
        <tbody>${
          table.rows.length > 0
            ? table.rows
                .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join('')}</tr>`)
                .join('')
            : `<tr><td colspan="${table.columns.length}" class="empty">No rows</td></tr>`
        }</tbody>
      </table>
    </section>`
    )
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Analytics report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 2rem; color: #111827; }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1rem; margin: 1.75rem 0 0.5rem; }
  .meta { color: #4b5563; font-size: 0.85rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d1d5db; padding: 4px 8px; text-align: left; font-size: 0.85rem; }
  thead { background: #f3f4f6; }
  td.empty { color: #6b7280; font-style: italic; }
  @media print { section { page-break-inside: avoid; } }
</style>
</head>
<body>
  <h1>Analytics report — ${escapeHtml(meta.tab === 'own' ? 'Own tracker' : 'Netlify')}${
    meta.viewName ? ` · ${escapeHtml(meta.viewName)}` : ''
  }</h1>
  <p class="meta">Range: ${escapeHtml(meta.range)}${meta.compare ? ' (vs previous period)' : ''} · Filters: ${escapeHtml(
    filterText
  )} · Generated ${escapeHtml(meta.generatedAt)}</p>
  ${sections}
</body>
</html>
`;
}

// ─── filenames ──────────────────────────────────────────────────────────────

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'export';

export function csvFilename(panelTitle: string, range: string): string {
  return `analytics-${slugify(panelTitle)}-${slugify(range)}.csv`;
}

export function reportFilename(range: string, extension: 'json' | 'html'): string {
  return `analytics-report-${slugify(range)}.${extension}`;
}

/** R11.2 — raw NDJSON event export filename; used by both the server proxy (Content-Disposition) and the client (a11y label / download hint). */
export function rawExportFilename(kind: 'events' | 'commerce' | 'dims', from: string, to: string): string {
  return `tracking-${kind}-${slugify(from)}-${slugify(to)}.ndjson`;
}
