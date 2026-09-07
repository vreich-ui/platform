/**
 * AnalyticsWorkspace (T4.1; renamed from TrafficWorkspace, T21.9b) — the
 * `/admin/analytics` page. R6.1 (T21.11) rebuilt this as two TABS over one
 * shared layout — analytics-dashboard-spec.md D1: "Own tracker" and
 * "Netlify" render through the SAME KPI strip / chart card / ranking-card
 * components, so moving between them is a change of data, not of
 * vocabulary. Tab + range + compare + filter state is persisted in the URL
 * (`?source=own|netlify&range=...&compare=...&country=...`,
 * `analytics-logic.ts`'s `parseAnalyticsSearchParams`/
 * `serializeAnalyticsSearchParams`) so a bookmark reproduces the exact view.
 *
 * R6.2 (T21.24) turns on everything R6.1 left disabled/inert:
 *  - the own tab now rides the SAME range picker as Netlify (7d/30d/90d/
 *    custom — the sink's `from`/`to` replaced its old `days=7|30`-only
 *    query, D10), so there is no more per-source availability gating;
 *  - the compare toggle is a real control — deltas render on the KPI strip
 *    whenever the payload carries a `previous` window (own: embedded in the
 *    sink response; netlify: a second same-length-window fetch), and are
 *    hidden, never fabricated, when it doesn't (e.g. before the sink
 *    deploys);
 *  - ranking cards are D5's "card with internal tabs" shape
 *    (`RankingGroup.views`) — Pages(top/entry/exit), Sources(referrer/UTM
 *    ×3), Locations, Devices, Engagement on the own tab; Pages/Sources/
 *    Locations/Not-found on the Netlify tab;
 *  - clicking a country/source/object row on the OWN tab sets a filter
 *    (D7); active filters render as removable chips and every card/chart
 *    re-queries under them. The Netlify tab has no equivalent — its ranking
 *    API takes no filter parameters — so its rows stay plain links (each
 *    view's `footnote` says so once).
 *
 * Same house pattern as `GovernancePage.tsx`: a page component wraps
 * `AdminShell`, a body component does the fetch/state/render cycle. The
 * actual "what should this tab show right now" decision is a PURE function
 * per feed (`resolveNetlifyAnalyticsPanel` in `analytics-logic.ts`,
 * `resolveOwnAnalyticsPanel` in `own-analytics-logic.ts`) — this file is a
 * thin, untested switch over their shared `AnalyticsPanelState`, matching
 * this codebase's rule that pure logic is the tested tier and JSX is not.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Button, Card, EmptyState, Skeleton } from './primitives';
import { Input, Textarea } from './forms';
import { Tabs, DropdownMenu, type TabItem } from './menus';
import { Dialog, useToast } from './overlays';
import { UplotTrendChart, BarList } from './AnalyticsCharts';
import { IconBookmark, IconChartBar, IconChevronDown, IconDownload, IconNote, IconTrash, IconX } from './icons';
import { cn } from './utils';
import { useCurrentUser } from '@core/lib/admin/use-current-user';
import { fetchAnalyticsOverview, type AnalyticsOverview } from '@core/lib/admin/analytics-client';
import { fetchOwnAnalyticsOverview, type OwnAnalyticsOverview } from '@core/lib/admin/own-analytics-client';
import { resolveOwnAnalyticsPanel, type ObjectRowsSort } from '@core/lib/admin/own-analytics-logic';
import {
  addAnalyticsNoteRequest,
  deleteAnalyticsViewRequest,
  fetchAnalyticsViews,
  fetchAnnotationMarkers as fetchAnnotationMarkersRequest,
  saveAnalyticsViewRequest,
} from '@core/lib/admin/analytics-views-client';
import {
  buildViewInput,
  isValidNoteDate,
  isValidNoteText,
  isValidViewName,
  MAX_NOTE_LENGTH,
  MAX_VIEW_NAME_LENGTH,
  viewIdFromSearch,
  viewToSearchState,
  sortAnalyticsViews,
  type AnalyticsSavedView,
} from '@core/lib/admin/analytics-views-logic';
import type { AnnotationMarker } from '@core/lib/admin/analytics-annotations-logic';
import {
  buildReportHtml,
  buildReportJson,
  chartTable,
  csvFilename,
  kpiTable,
  panelTables,
  rankingViewTable,
  reportFilename,
  tableToCsv,
  type ExportMeta,
  type ExportTable,
} from '@core/lib/admin/analytics-export-logic';
import { fetchAnalyticsRawExport, type AnalyticsRawExportKind } from '@core/lib/admin/analytics-export-client';
import {
  ANALYTICS_RANGE_OPTIONS,
  DEFAULT_ANALYTICS_SOURCE,
  resolveDateWindow,
  resolveNetlifyAnalyticsPanel,
  isAnalyticsSource,
  parseAnalyticsSearchParams,
  serializeAnalyticsSearchParams,
  isCompareAvailable,
  defaultCompareForRange,
  analyticsFilterChips,
  EMPTY_ANALYTICS_FILTERS,
  analyticsRangeStorageKey,
  parseStoredAnalyticsRange,
  serializeStoredAnalyticsRange,
  type AnalyticsRangeKey,
  type AnalyticsSource,
  type AnalyticsSearchState,
  type CustomRangeInput,
  type AnalyticsPanelState,
  type AnalyticsPanelReady,
  type AnalyticsChartView,
  type KpiDatum,
  type AnalyticsDelta,
  type RankingGroup,
  type AnalyticsRankingRowWithShare,
  type AnalyticsFilters,
  type AnalyticsFooterItem,
  type DateWindowResult,
} from '@core/lib/admin/analytics-logic';
import { fetchAnalyticsInsightsOverview } from '@core/lib/admin/analytics-insights-client';
import {
  resolveInsightsPanel,
  formatEvidence,
  summarizeOutcomeMetrics,
  type InsightsPanelState,
  type InsightsSectionState,
  type TrackingOutcomeRow,
  type PlaybookTrackingItem,
  type OptimizerProposalRow,
  type StrategyObservationRow,
  type InsightsOverview,
} from '@core/lib/admin/analytics-insights-logic';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

// ─── URL persistence (the browser APIs; the parse/serialize logic is pure) ──

/** `''` outside a browser (SSR) — the caller always has a sane default to fall back to. */
function readLocationSearch(): string {
  try {
    return window.location.search;
  } catch {
    return '';
  }
}

/** Never throws — a non-browser context (SSR, a future test harness) just skips the URL write; component state still works for this render. */
function writeLocationSearch(qs: string): void {
  try {
    const url = new URL(window.location.href);
    url.search = qs;
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // no-op
  }
}

// ─── R11.2 (T21.28) — export: CSV/JSON/HTML downloads and the raw-export proxy ──
//
// Every table these buttons serialize comes from the SAME `AnalyticsPanelReady`
// the page already rendered from (`analytics-export-logic.ts`'s header) — a
// card's "Export CSV" is never a second query. The DOM download trigger
// itself is a browser-only side effect that has no business in a pure lib
// module, so it lives here.

/** Best-effort — a failed programmatic download should never crash the page; the operator can just try the button again. */
function downloadBlob(filename: string, blob: Blob): void {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // no-op
  }
}

function downloadText(filename: string, content: string, mimeType: string): void {
  downloadBlob(filename, new Blob([content], { type: mimeType }));
}

/** One card's "Export CSV" — `compact` drops the text label for cards whose header chrome (a Badge, tab pills) is already tight. */
function ExportCsvButton({
  table,
  rangeLabel,
  compact,
}: {
  table: ExportTable;
  rangeLabel: string;
  compact?: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-label={`Export ${table.title} as CSV`}
      title="Export CSV — matches what's on screen for this card"
      onClick={() => downloadText(csvFilename(table.title, rangeLabel), tableToCsv(table), 'text/csv;charset=utf-8')}
    >
      <IconDownload size={14} />
      {compact ? null : 'Export CSV'}
    </Button>
  );
}

// ─── range picker + compare toggle (shared header controls) ────────────────

export function RangePicker({
  rangeKey,
  custom,
  onSelect,
  onCustomChange,
}: {
  rangeKey: AnalyticsRangeKey;
  custom: CustomRangeInput;
  onSelect: (key: AnalyticsRangeKey) => void;
  onCustomChange: (custom: CustomRangeInput) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex items-center gap-1 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] p-0.5">
        {ANALYTICS_RANGE_OPTIONS.map((option) => (
          <Button
            key={option.key}
            type="button"
            size="sm"
            variant={rangeKey === option.key ? 'secondary' : 'ghost'}
            aria-pressed={rangeKey === option.key}
            onClick={() => onSelect(option.key)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {rangeKey === 'custom' ? (
        <div className="flex items-center gap-2">
          <Input
            type="date"
            aria-label="Custom range start"
            value={custom.from}
            max={custom.to || undefined}
            onChange={(e) => onCustomChange({ ...custom, from: e.target.value })}
            className="w-40"
          />
          <span className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">to</span>
          <Input
            type="date"
            aria-label="Custom range end"
            value={custom.to}
            min={custom.from || undefined}
            onChange={(e) => onCustomChange({ ...custom, to: e.target.value })}
            className="w-40"
          />
        </div>
      ) : null}
    </div>
  );
}

/** D3's compare toggle — a real pressed/unpressed control now (R6.2): every source can carry a previous-period figure (`isCompareAvailable`), and whether a delta actually renders is decided per-KPI by `computeDelta` finding (or not finding) a `previous` value in the payload. */
function CompareToggle({
  source,
  pressed,
  onToggle,
}: {
  source: AnalyticsSource;
  pressed: boolean;
  onToggle: () => void;
}) {
  if (!isCompareAvailable(source)) return null;
  return (
    <Button type="button" size="sm" variant={pressed ? 'secondary' : 'ghost'} aria-pressed={pressed} onClick={onToggle}>
      Compare: previous period
    </Button>
  );
}

/** D7 — active filters as removable pills, per the spec's page anatomy (`chips: country: IL ✕  source: newsletter ✕`). Own tab only — Netlify's ranking API takes no filter parameters. */
function FilterChips({
  filters,
  onRemove,
}: {
  filters: AnalyticsFilters;
  onRemove: (key: keyof AnalyticsFilters) => void;
}) {
  const chips = analyticsFilterChips(filters);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" role="list" aria-label="Active filters">
      {chips.map((chip) => (
        <span
          key={chip.key}
          role="listitem"
          className="inline-flex items-center gap-1.5 rounded-[var(--adm-radius-pill)] border border-[var(--adm-border-strong)] bg-[var(--adm-surface-raised)] py-1 pl-2.5 pr-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text)]"
        >
          <span className="font-medium text-[var(--adm-text-muted)]">{chip.label}:</span>
          {chip.value}
          <button
            type="button"
            aria-label={`Remove ${chip.label} filter`}
            className="adm-focusable rounded-full p-0.5 text-[var(--adm-text-muted)] hover:bg-[var(--adm-surface-sunken)] hover:text-[var(--adm-text)]"
            onClick={() => onRemove(chip.key)}
          >
            <IconX size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

// ─── R11.1 (T21.27): saved views — a "Views" menu over the header controls ──
//
// A view is an operator PREFERENCE (`analytics-views-logic.ts`'s header),
// listed via `admin-analytics?resource=views` and applied wholesale onto the
// page's own tab/range/compare/filters/pagesSort state — the same shared
// state the range picker and compare toggle already own, never a parallel
// rendering path (D1: "a change of data, not of vocabulary" extends to a
// saved view too).

function ViewsMenu({
  views,
  activeViewId,
  onApply,
  onSaveNew,
  onManage,
}: {
  views: AnalyticsSavedView[];
  activeViewId: string | null;
  onApply: (view: AnalyticsSavedView) => void;
  onSaveNew: () => void;
  onManage: () => void;
}) {
  const sorted = sortAnalyticsViews(views);
  return (
    <DropdownMenu
      trigger={({ ref, onToggle }) => (
        <Button ref={ref} type="button" size="sm" variant="ghost" onClick={onToggle}>
          <IconBookmark size={14} />
          Views
          <IconChevronDown size={14} />
        </Button>
      )}
      items={[
        ...sorted.map((view) => ({
          id: view.id,
          label: view.id === activeViewId ? <strong>{view.name}</strong> : view.name,
          onSelect: () => onApply(view),
        })),
        {
          id: 'save-new',
          label: 'Save current view…',
          icon: <IconBookmark size={14} />,
          separatorBefore: true,
          onSelect: onSaveNew,
        },
        { id: 'manage', label: 'Manage views…', onSelect: onManage },
      ]}
    />
  );
}

function SaveViewDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName('');
  }, [open]);
  const valid = isValidViewName(name);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Save current view"
      description="Saves the active tab, range, compare setting, and filters as a view you can reopen later."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!valid}
            onClick={() => {
              if (valid) onSave(name);
            }}
          >
            Save view
          </Button>
        </>
      }
    >
      <Input
        aria-label="View name"
        placeholder="e.g. Launch week"
        value={name}
        maxLength={MAX_VIEW_NAME_LENGTH}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
    </Dialog>
  );
}

function ManageViewsDialog({
  open,
  onClose,
  views,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  views: AnalyticsSavedView[];
  onDelete: (view: AnalyticsSavedView) => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Manage views"
      description="Delete a saved view. This cannot be undone."
    >
      <ul className="flex flex-col gap-1.5">
        {sortAnalyticsViews(views).map((view) => (
          <li
            key={view.id}
            className="flex items-center justify-between gap-2 rounded-[var(--adm-radius-sm)] px-2 py-1.5 hover:bg-[var(--adm-surface-sunken)]"
          >
            <span className="min-w-0 flex-1 truncate text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
              {view.name}
              {view.builtin ? (
                <span className="ml-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">default</span>
              ) : null}
            </span>
            <button
              type="button"
              aria-label={`Delete view ${view.name}`}
              className="adm-focusable shrink-0 rounded-[var(--adm-radius-sm)] p-1 text-[var(--adm-text-muted)] hover:bg-[var(--adm-surface-sunken)] hover:text-[var(--adm-danger)]"
              onClick={() => onDelete(view)}
            >
              <IconTrash size={14} />
            </button>
          </li>
        ))}
        {views.length === 0 ? (
          <li className="px-2 py-1.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            No saved views yet.
          </li>
        ) : null}
      </ul>
    </Dialog>
  );
}

/**
 * R11.3 (T21.29) — "click a day to add a note": Shift+click on either chart
 * (`UplotTrendChart`'s `onDayClick`) or the header's "Add note" button opens
 * this with a date pre-filled (the clicked day, or today for the header
 * button). Saved notes join the release/publish ticks on every chart via
 * the SAME merged marker list (`fetchAnnotationMarkers`) — a note is not a
 * second, separate annotation surface.
 */
function AddNoteDialog({
  open,
  date,
  onClose,
  onSave,
}: {
  open: boolean;
  date: string;
  onClose: () => void;
  onSave: (date: string, text: string) => void;
}) {
  const [localDate, setLocalDate] = useState(date);
  const [text, setText] = useState('');
  useEffect(() => {
    if (open) {
      setLocalDate(date);
      setText('');
    }
  }, [open, date]);
  const valid = isValidNoteDate(localDate) && isValidNoteText(text);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a note"
      description="Notes render as ticks on the chart, alongside releases and publishes — a quick way to record why a day looked the way it did."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!valid}
            onClick={() => {
              if (valid) onSave(localDate, text.trim());
            }}
          >
            Save note
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input type="date" aria-label="Note date" value={localDate} onChange={(e) => setLocalDate(e.target.value)} />
        <Textarea
          aria-label="Note text"
          placeholder="What happened this day?"
          rows={3}
          maxLength={MAX_NOTE_LENGTH}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
      </div>
    </Dialog>
  );
}

/**
 * R11.2 (T21.28) — the page-level "Export" menu: a JSON/HTML report of every
 * panel for the currently active tab (built from the SAME resolved panel the
 * page renders, lifted up via `onPanelChange`), plus "Download raw events
 * (range)" and its commerce/dims siblings — a proxy through
 * `admin-analytics.ts` so the sink's own Bearer token never reaches the
 * browser (`analytics-export-client.ts`'s header). A 404/unconfigured sink
 * degrades to a toast naming it, never a broken download.
 */
function ExportMenu({
  activePanel,
  meta,
  windowResult,
  onRawExportUnavailable,
}: {
  activePanel: AnalyticsPanelState;
  meta: Omit<ExportMeta, 'generatedAt'>;
  windowResult: DateWindowResult;
  onRawExportUnavailable: (message: string) => void;
}) {
  const ready: AnalyticsPanelReady | null = activePanel.kind === 'ready' ? activePanel : null;
  const notReadyReason = 'Available once this tab has finished loading.';

  const exportReport = (format: 'json' | 'html') => {
    if (!ready) return;
    const tables = panelTables(ready);
    const fullMeta: ExportMeta = { ...meta, generatedAt: new Date().toISOString() };
    if (format === 'json') {
      downloadText(
        reportFilename(meta.range, 'json'),
        JSON.stringify(buildReportJson(fullMeta, tables), null, 2),
        'application/json'
      );
    } else {
      downloadText(reportFilename(meta.range, 'html'), buildReportHtml(fullMeta, tables), 'text/html');
    }
  };

  const downloadRaw = async (kind: AnalyticsRawExportKind) => {
    if (!windowResult.ok) return;
    const result = await fetchAnalyticsRawExport(getToken, kind, {
      from: new Date(windowResult.window.from).toISOString(),
      to: new Date(windowResult.window.to).toISOString(),
    });
    if (result.available) downloadBlob(result.filename, result.blob);
    else onRawExportUnavailable(result.message);
  };

  return (
    <DropdownMenu
      trigger={({ ref, onToggle }) => (
        <Button ref={ref} type="button" size="sm" variant="ghost" onClick={onToggle}>
          <IconDownload size={14} />
          Export
          <IconChevronDown size={14} />
        </Button>
      )}
      items={[
        {
          id: 'report-json',
          label: 'Export report (JSON)',
          disabled: !ready,
          title: ready ? undefined : notReadyReason,
          onSelect: () => exportReport('json'),
        },
        {
          id: 'report-html',
          label: 'Export report (printable HTML)',
          disabled: !ready,
          title: ready ? undefined : notReadyReason,
          onSelect: () => exportReport('html'),
        },
        {
          id: 'raw-events',
          label: 'Download raw events (range)',
          separatorBefore: true,
          disabled: !windowResult.ok,
          onSelect: () => void downloadRaw('events'),
        },
        {
          id: 'raw-commerce',
          label: 'Download raw commerce (range)',
          disabled: !windowResult.ok,
          onSelect: () => void downloadRaw('commerce'),
        },
        {
          id: 'raw-dims',
          label: 'Download raw dimension facts (range)',
          disabled: !windowResult.ok,
          onSelect: () => void downloadRaw('dims'),
        },
      ]}
    />
  );
}

// ─── shared presentational layer: KPI strip / chart card / ranking cards ───
//
// D1/R6.1: both tabs render through these three, differing only in the data
// (`AnalyticsPanelState`) each feed's resolver produces.

/** Arrow is baked into `delta.label` already (never colour alone, spec §8) — the colour class here is a secondary reinforcement, not the signal. */
const deltaColorClass = (direction: AnalyticsDelta['direction']): string =>
  direction === 'up'
    ? 'text-[var(--adm-success-text)]'
    : direction === 'down'
      ? 'text-[var(--adm-danger-text)]'
      : 'text-[var(--adm-text-muted)]';

export function KpiStrip({ items, rangeLabel }: { items: KpiDatum[]; rangeLabel?: string }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {rangeLabel ? (
        <div className="flex justify-end">
          <ExportCsvButton table={kpiTable(items)} rangeLabel={rangeLabel} compact />
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((item) => (
          <div
            key={item.id}
            className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] px-3 py-2.5"
          >
            <p className="truncate text-[length:var(--adm-text-xs)] font-medium uppercase tracking-wide text-[var(--adm-text-muted)]">
              {item.label}
            </p>
            <div className="mt-0.5 flex items-baseline gap-1.5">
              <p className="text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">
                {item.value}
              </p>
              {item.delta ? (
                <span
                  className={cn('text-[length:var(--adm-text-xs)] font-medium', deltaColorClass(item.delta.direction))}
                >
                  {item.delta.label}
                </span>
              ) : null}
            </div>
            {item.hint ? (
              <p
                className="mt-0.5 truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]"
                title={item.hint}
              >
                {item.hint}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartCard({
  chart,
  onBucketSelect,
  onDayClick,
  markers,
  rangeLabel,
}: {
  chart: AnalyticsChartView;
  onBucketSelect?: (isoDate: string) => void;
  /** R11.3 — Shift+click a point to add an operator note for that day. */
  onDayClick?: (isoDate: string) => void;
  markers?: AnnotationMarker[];
  rangeLabel?: string;
}) {
  return (
    <Card
      kicker="Trend"
      title="Over time"
      actions={rangeLabel ? <ExportCsvButton table={chartTable(chart)} rangeLabel={rangeLabel} compact /> : undefined}
    >
      {chart.points.length > 0 ? (
        <UplotTrendChart
          points={chart.points}
          previousPoints={chart.previousPoints}
          seriesALabel={chart.seriesALabel}
          seriesBLabel={chart.seriesBLabel}
          onBucketSelect={onBucketSelect}
          onDayClick={onDayClick}
          markers={markers}
        />
      ) : (
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{chart.emptyMessage}</p>
      )}
    </Card>
  );
}

/**
 * D5 — "a card with internal tabs" is the single most consistent structural
 * convention across every product the spec surveyed. A card with exactly
 * one view renders it directly (no tab chrome) — this is how the Netlify
 * tab's simpler cards render identically to before R6.2.
 */
function RankingCard({
  group,
  filters,
  onFilterClick,
  rangeLabel,
}: {
  group: RankingGroup;
  filters: AnalyticsFilters;
  onFilterClick: (key: keyof AnalyticsFilters, value: string) => void;
  rangeLabel?: string;
}) {
  const [activeViewId, setActiveViewId] = useState(group.views[0]?.id);
  const activeView = group.views.find((v) => v.id === activeViewId) ?? group.views[0];
  if (!activeView) return null;

  const handleRowClick = activeView.filterKey
    ? (row: AnalyticsRankingRowWithShare) => onFilterClick(activeView.filterKey!, row.value ?? row.label)
    : undefined;

  return (
    <Card
      kicker={group.title}
      actions={
        <div className="flex items-center gap-1">
          {rangeLabel ? (
            <ExportCsvButton
              table={rankingViewTable(group.title, activeView, group.views.length === 1)}
              rangeLabel={rangeLabel}
              compact
            />
          ) : null}
          <Badge>{activeView.rows.length}</Badge>
        </div>
      }
      className="flex max-h-[320px] flex-col"
      bodyClassName="min-h-0 flex-1 overflow-y-auto"
    >
      {group.views.length > 1 ? (
        <div role="tablist" aria-label={`${group.title} view`} className="mb-2 flex flex-wrap gap-1">
          {group.views.map((view) => (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={view.id === activeView.id}
              className={cn(
                'adm-focusable rounded-[var(--adm-radius-sm)] px-2 py-1 text-[length:var(--adm-text-xs)] font-medium',
                view.id === activeView.id
                  ? 'bg-[var(--adm-accent-soft)] text-[var(--adm-text-heading)]'
                  : 'text-[var(--adm-text-muted)] hover:bg-[var(--adm-surface-sunken)]'
              )}
              onClick={() => setActiveViewId(view.id)}
            >
              {view.label}
            </button>
          ))}
        </div>
      ) : null}
      <BarList
        rows={activeView.rows}
        caption={`${group.title}${group.views.length > 1 ? ` — ${activeView.label}` : ''}`}
        emptyMessage={activeView.emptyMessage}
        onRowClick={handleRowClick}
        activeValue={activeView.filterKey ? filters[activeView.filterKey] : undefined}
      />
      {activeView.footnote ? (
        <p className="mt-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{activeView.footnote}</p>
      ) : null}
    </Card>
  );
}

/** Two columns at ≥1024px (`lg`), three at ≥1280px (`xl`) — "a two- or three-column grid that works on a laptop screen". */
function RankingGrid({
  groups,
  filters,
  onFilterClick,
  rangeLabel,
}: {
  groups: RankingGroup[];
  filters: AnalyticsFilters;
  onFilterClick: (key: keyof AnalyticsFilters, value: string) => void;
  rangeLabel?: string;
}) {
  if (groups.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
      {groups.map((group) => (
        <RankingCard
          key={group.id}
          group={group}
          filters={filters}
          onFilterClick={onFilterClick}
          rangeLabel={rangeLabel}
        />
      ))}
    </div>
  );
}

/** Health/meta lives here, never in the KPI strip (R6.1: "a health timestamp is not a metric"). */
function FooterStrip({ items }: { items: AnalyticsFooterItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 border-t border-[var(--adm-border)] px-1 pt-4 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
      {items.map((item) => (
        <span key={item.id} title={item.hint} className="inline-flex items-center gap-1.5">
          <span className="font-medium text-[var(--adm-text)]">{item.label}:</span>
          {item.value}
        </span>
      ))}
      <span>excl. admin &amp; test</span>
    </div>
  );
}

const PANEL_LOADING_SKELETON = (
  <div className="flex flex-col gap-4">
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} variant="rect" height={64} />
      ))}
    </div>
    <Skeleton variant="rect" height={220} />
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Skeleton variant="rect" height={200} />
      <Skeleton variant="rect" height={200} />
    </div>
  </div>
);

/**
 * The one component both tabs render through (D1). Every branch of
 * `AnalyticsPanelState` is a named empty/partial state — "own present +
 * Netlify off", "Netlify on + sink env absent", and "both absent" are three
 * instances of the SAME `not_configured`/`not_enabled` states, one per feed,
 * never a bespoke "both are down" case to maintain separately.
 */
function AnalyticsPanel({
  state,
  notConfiguredTitle,
  notEnabledTitle,
  filters,
  onFilterClick,
  onBucketSelect,
  onDayClick,
  markers,
  rangeLabel,
}: {
  state: AnalyticsPanelState;
  notConfiguredTitle: string;
  notEnabledTitle: string;
  filters: AnalyticsFilters;
  onFilterClick: (key: keyof AnalyticsFilters, value: string) => void;
  onBucketSelect?: (isoDate: string) => void;
  /** R11.3 — Shift+click a point to add an operator note for that day. */
  onDayClick?: (isoDate: string) => void;
  /** R11.3 — release/publish/note ticks for the chart. */
  markers?: AnnotationMarker[];
  /** R11.2 — when set, every card renders its own "Export CSV" button, filenamed off this (a human range string, e.g. "30 days"). */
  rangeLabel?: string;
}) {
  switch (state.kind) {
    case 'loading':
      return PANEL_LOADING_SKELETON;
    case 'range_error':
      return <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-danger)]">{state.message}</p>;
    case 'error':
      return <EmptyState severity="error" title="Couldn't load analytics data" message={state.message} />;
    case 'not_configured':
      return <EmptyState icon={<IconChartBar size={26} />} title={notConfiguredTitle} message={state.message} />;
    case 'not_enabled':
      return <EmptyState icon={<IconChartBar size={26} />} title={notEnabledTitle} message={state.message} />;
    case 'ready':
      return (
        <div className="flex flex-col gap-5">
          <KpiStrip items={state.kpis} rangeLabel={rangeLabel} />
          <ChartCard
            chart={state.chart}
            onBucketSelect={onBucketSelect}
            onDayClick={onDayClick}
            markers={markers}
            rangeLabel={rangeLabel}
          />
          <RankingGrid
            groups={state.rankings}
            filters={filters}
            onFilterClick={onFilterClick}
            rangeLabel={rangeLabel}
          />
          <FooterStrip items={state.footer} />
        </div>
      );
  }
}

// ─── own tracker tab (T21.2b — the first-party feed) ────────────────────────

function OwnAnalyticsTab({
  rangeKey,
  custom,
  windowResult,
  windowKey,
  filters,
  compare,
  pagesSort,
  netlifyPageviews,
  rangeLabel,
  onFilterClick,
  onFilterRemove,
  onBucketSelect,
  onDayClick,
  markers,
  onPanelChange,
}: {
  rangeKey: AnalyticsRangeKey;
  custom: CustomRangeInput | undefined;
  windowResult: DateWindowResult;
  windowKey: string | null;
  filters: AnalyticsFilters;
  compare: boolean;
  /** R11.1 — a saved view's alternate Pages-card sort. Absent = the page's normal default. */
  pagesSort?: ObjectRowsSort;
  /** Netlify's window total, when that feed is loaded/enabled — `null` while unknown or unavailable. */
  netlifyPageviews: number | null;
  /** R11.2 — human range text ("30 days"), threaded down for per-card CSV filenames. */
  rangeLabel: string;
  onFilterClick: (key: keyof AnalyticsFilters, value: string) => void;
  onFilterRemove: (key: keyof AnalyticsFilters) => void;
  onBucketSelect: (isoDate: string) => void;
  /** R11.3 — Shift+click a point to add an operator note for that day. */
  onDayClick?: (isoDate: string) => void;
  /** R11.3 — release/publish/note ticks for the chart. */
  markers?: AnnotationMarker[];
  /** R11.2 — lifts the resolved panel up to the page header's "Export report" action, which needs it regardless of which tab is scrolled into view. */
  onPanelChange?: (state: AnalyticsPanelState) => void;
}) {
  const [overview, setOverview] = useState<OwnAnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    if (!windowResult.ok) return;
    let alive = true;
    setLoading(true);
    setError(null);
    fetchOwnAnalyticsOverview(getToken, { range: rangeKey, custom, filters })
      .then((result) => {
        if (alive) setOverview(result);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load analytics data.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // `windowKey` is the resolved-window signal (re-fires exactly when
    // `resolveDateWindow` produces a new from/to); `filterKey` is `filters`'
    // stable dependency form. `exhaustive-deps` is not enabled in this repo
    // (see eslint.config.js) — `rangeKey`/`custom` are captured by value at
    // fetch time, which is correct since they only ever change in lockstep
    // with `windowKey`.
  }, [windowKey, filterKey]);

  const panel = useMemo(
    () =>
      resolveOwnAnalyticsPanel({
        loading,
        error,
        windowResult,
        overview,
        netlifyPageviews,
        compare,
        filters,
        pagesSort,
      }),
    [loading, error, windowResult, overview, netlifyPageviews, compare, filters, pagesSort]
  );

  useEffect(() => {
    onPanelChange?.(panel);
    // `onPanelChange` is a setter passed down from the parent (stable
    // identity in practice) — `exhaustive-deps` is not enabled in this repo.
  }, [panel]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        Events from this site&rsquo;s own tracking sink — client-side, so ad blockers and tracking protection can
        suppress it.
      </p>
      <FilterChips filters={filters} onRemove={onFilterRemove} />
      <AnalyticsPanel
        state={panel}
        notConfiguredTitle="Own tracker isn't connected"
        notEnabledTitle="Own tracker isn't enabled"
        filters={filters}
        onFilterClick={onFilterClick}
        onBucketSelect={onBucketSelect}
        onDayClick={onDayClick}
        markers={markers}
        rangeLabel={rangeLabel}
      />
    </div>
  );
}

// ─── Netlify tab ─────────────────────────────────────────────────────────────

function NetlifyAnalyticsTab({
  overview,
  loading,
  error,
  windowResult,
  compare,
  rangeLabel,
  onBucketSelect,
  onDayClick,
  markers,
  onPanelChange,
}: {
  overview: AnalyticsOverview | null;
  loading: boolean;
  error: string | null;
  windowResult: DateWindowResult;
  compare: boolean;
  rangeLabel: string;
  onBucketSelect: (isoDate: string) => void;
  /** R11.3 — Shift+click a point to add an operator note for that day. */
  onDayClick?: (isoDate: string) => void;
  /** R11.3 — release/publish/note ticks for the chart. */
  markers?: AnnotationMarker[];
  onPanelChange?: (state: AnalyticsPanelState) => void;
}) {
  const panel = useMemo(
    () => resolveNetlifyAnalyticsPanel({ loading, error, windowResult, overview, compare }),
    [loading, error, windowResult, overview, compare]
  );

  useEffect(() => {
    onPanelChange?.(panel);
  }, [panel]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        Netlify Analytics — server-side, so it runs regardless of ad blockers or tracking protection.
      </p>
      <AnalyticsPanel
        state={panel}
        notConfiguredTitle="Netlify Analytics isn't connected"
        notEnabledTitle="Analytics is not enabled for this site"
        filters={EMPTY_ANALYTICS_FILTERS}
        onFilterClick={() => {
          // D7/§9.2: the Netlify ranking API takes no filter parameters — its
          // views never carry a `filterKey`, so `BarList` never wires
          // `onRowClick` for them and this is never actually invoked.
        }}
        onBucketSelect={onBucketSelect}
        onDayClick={onDayClick}
        markers={markers}
        rangeLabel={rangeLabel}
      />
    </div>
  );
}

// ─── Insights tab (R11.5/T21.36) ────────────────────────────────────────────
//
// Read-only, and structurally unlike the other two tabs: there is no KPI
// strip/chart/window here (every row carries ITS OWN evidence window — see
// `analytics-insights-logic.ts`'s header) — four independently-degrading
// sections is the actual shape of "is the learning loop working", so this
// renders through its own `InsightsPanel`, not the `AnalyticsPanel` the
// own/Netlify tabs share. Same tab GRAMMAR (`?source=insights`, same Card/
// Badge/EmptyState/Skeleton primitives) — D1's "a change of data, not of
// vocabulary" still holds — just not the same panel shape, because the data
// itself has no shared window to hang a chart on.

function EvidenceLine({ evidence }: { evidence: { windowStart?: string | null; windowEnd?: string | null; n?: number | null } }) {
  const formatted = formatEvidence(evidence);
  return (
    <span
      className={cn(
        'text-[length:var(--adm-text-xs)]',
        formatted.sufficient ? 'text-[var(--adm-text-muted)]' : 'text-[var(--adm-warning-text)]'
      )}
    >
      {formatted.windowLabel} · {formatted.nLabel}
    </span>
  );
}

function insightsRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function OutcomeRow({ row }: { row: TrackingOutcomeRow }) {
  return (
    <li className="border-b border-[var(--adm-border)] py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <Badge>{row.producer}</Badge>
        <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {insightsRelativeTime(row.createdAt)}
        </span>
      </div>
      <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-heading)]">
        {summarizeOutcomeMetrics(row.metrics)}
      </p>
      <div className="mt-1 flex items-center justify-between gap-2">
        <EvidenceLine evidence={row.evidence} />
        {row.runId ? (
          <span className="truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]" title={row.runId}>
            {row.runId}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function PlaybookItemRow({ row }: { row: PlaybookTrackingItem }) {
  return (
    <li className="border-b border-[var(--adm-border)] py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <Badge>{row.nodeId}</Badge>
        <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {row.evidenceSources.join(', ')}
        </span>
      </div>
      <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-heading)]">{row.text}</p>
      <div className="mt-1">
        <EvidenceLine evidence={row.evidence} />
      </div>
    </li>
  );
}

function ProposalRow({ row }: { row: OptimizerProposalRow }) {
  return (
    <li className="border-b border-[var(--adm-border)] py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <Badge tone="warning">{row.status}</Badge>
        <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {insightsRelativeTime(row.createdAt)}
        </span>
      </div>
      <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-heading)]">{row.title}</p>
      <div className="mt-1 flex items-center justify-between gap-2">
        <EvidenceLine evidence={row.evidence} />
        {row.nodeId ? <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{row.nodeId}</span> : null}
      </div>
    </li>
  );
}

function StrategyObservationRowView({ row }: { row: StrategyObservationRow }) {
  return (
    <li className="border-b border-[var(--adm-border)] py-2.5 last:border-b-0">
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-heading)]">{row.label}</p>
      <div className="mt-1">
        <EvidenceLine evidence={row.evidence} />
      </div>
    </li>
  );
}

/** One card, shared shape for all four sections: a count badge when ready, a named empty/error state otherwise — never a zero, never a spinner that never resolves. */
function InsightsSectionCard<T>({
  title,
  state,
  renderRows,
}: {
  title: string;
  state: InsightsSectionState<T>;
  renderRows: (rows: T[]) => ReactNode;
}) {
  return (
    <Card
      kicker={title}
      actions={state.kind === 'ready' ? <Badge>{state.rows.length}</Badge> : undefined}
      className="flex max-h-[420px] flex-col"
      bodyClassName="min-h-0 flex-1 overflow-y-auto"
    >
      {state.kind === 'ready' ? (
        <ul>{renderRows(state.rows)}</ul>
      ) : (
        <EmptyState
          // D4: `workspace_scope` is a fact being reported, not a decision —
          // "info", never "error". It is set only when the server never even
          // called CMS-Agent for this section (a standing, by-design
          // exclusion), so it can never collide with a genuine failure on a
          // section that does call out.
          severity={state.kind === 'error' ? 'error' : state.kind === 'workspace_scope' ? 'info' : undefined}
          title={
            state.kind === 'error'
              ? 'Could not load this section'
              : state.kind === 'workspace_scope'
                ? 'Workspace-wide — not available at tenant scope'
                : 'Nothing here yet'
          }
          message={state.message}
          className="border-none px-0 py-6"
        />
      )}
    </Card>
  );
}

const INSIGHTS_LOADING_SKELETON = (
  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
    {[0, 1, 2, 3].map((i) => (
      <Skeleton key={i} variant="rect" height={220} />
    ))}
  </div>
);

function InsightsPanel({ state }: { state: InsightsPanelState }) {
  if (state.kind === 'loading') return INSIGHTS_LOADING_SKELETON;
  if (state.kind === 'error') {
    return <EmptyState severity="error" title="Could not load insights" message={state.message} />;
  }
  if (state.kind === 'not_configured') {
    return <EmptyState title="CMS-Agent isn't connected" message={state.message} />;
  }
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <InsightsSectionCard
        title="Latest tracking outcomes"
        state={state.outcomes}
        renderRows={(rows) => rows.map((row) => <OutcomeRow key={row.id} row={row} />)}
      />
      <InsightsSectionCard
        title="Playbook — cites tracking"
        state={state.playbookItems}
        renderRows={(rows) => rows.map((row) => <PlaybookItemRow key={row.id} row={row} />)}
      />
      <InsightsSectionCard
        title="Open optimizer proposals"
        state={state.proposals}
        renderRows={(rows) => rows.map((row) => <ProposalRow key={row.id} row={row} />)}
      />
      <InsightsSectionCard
        title="Strategy observations"
        state={state.strategyObservations}
        renderRows={(rows) => rows.map((row) => <StrategyObservationRowView key={row.id} row={row} />)}
      />
    </div>
  );
}

function InsightsTab() {
  const [overview, setOverview] = useState<InsightsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // No range/window dependency (unlike the other two tabs) — this fetches
  // once when the tab mounts, exactly like the object drill-down's
  // identity lookup fetches independently of the range picker.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchAnalyticsInsightsOverview(getToken)
      .then((result) => {
        if (alive) setOverview(result);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load insights.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const panel = useMemo(() => resolveInsightsPanel({ loading, error, overview }), [loading, error, overview]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        Read-only — the learning loop&rsquo;s own evidence: tracking outcomes ingested, playbook lessons drawn from
        them, open optimizer proposals, and strategy-level observations. Every row carries its own evidence window
        and sample size.
      </p>
      <InsightsPanel state={panel} />
    </div>
  );
}

// ─── body: tabs + shared header state, URL-persisted ────────────────────────

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function defaultCustomRange(now: Date): CustomRangeInput {
  return { from: isoDate(now.getTime() - 30 * 86_400_000), to: isoDate(now.getTime()) };
}

function AnalyticsBody({ identity }: { identity: SiteIdentity }) {
  const currentUser = useCurrentUser();
  const storageKey = analyticsRangeStorageKey(identity.siteSlug, currentUser.user?.email ?? '');
  const toast = useToast();

  const [source, setSource] = useState<AnalyticsSource>(DEFAULT_ANALYTICS_SOURCE);
  const [rangeKey, setRangeKeyState] = useState<AnalyticsRangeKey>('30d');
  const [custom, setCustom] = useState<CustomRangeInput>(() => defaultCustomRange(new Date()));
  const [compare, setCompare] = useState<boolean>(() => defaultCompareForRange('30d'));
  const [filters, setFilters] = useState<AnalyticsFilters>(EMPTY_ANALYTICS_FILTERS);
  const [hydrated, setHydrated] = useState(false);

  // R11.1 — saved views. `activeViewId` is cleared by every handler below
  // that changes tab/range/compare/filters BY HAND (a deliberate divergence
  // from whatever view was applied); `applyView` is the one path that sets
  // it. `pendingViewId` carries a `?view=<id>` from the URL across the async
  // views fetch — the URL is read synchronously on mount, but the view list
  // is not, so applying it has to wait for both.
  const [views, setViews] = useState<AnalyticsSavedView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [pagesSort, setPagesSort] = useState<ObjectRowsSort | undefined>(undefined);
  const [pendingViewId, setPendingViewId] = useState<string | undefined>(undefined);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [manageDialogOpen, setManageDialogOpen] = useState(false);

  // R11.2 — the resolved panel for each tab, lifted up from
  // `OwnAnalyticsTab`/`NetlifyAnalyticsTab` via `onPanelChange` so the
  // header's "Export report" action can read whichever one is active
  // without re-deriving it (the SAME object the tab rendered from).
  const [ownPanelState, setOwnPanelState] = useState<AnalyticsPanelState>({ kind: 'loading' });
  const [netlifyPanelState, setNetlifyPanelState] = useState<AnalyticsPanelState>({ kind: 'loading' });

  // R11.3 — the merged release/publish/note marker list every chart draws
  // ticks from, site-wide (not per tracking-source) — fetched once per
  // window and shared by both tabs rather than duplicated per feed.
  const [markers, setMarkers] = useState<AnnotationMarker[]>([]);
  const [noteDialogDate, setNoteDialogDate] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchAnalyticsViews(getToken)
      .then((result) => {
        if (alive) setViews(result);
      })
      .catch(() => {
        // The Views menu degrades to "no saved views" rather than blocking the page — the KPI/chart data is the load-bearing content here.
      });
    return () => {
      alive = false;
    };
  }, []);

  // Hydrate from the URL (primary, D1: "?source= persists in the URL") on
  // mount, falling back to the last-remembered RANGE in localStorage when
  // the URL carries none at all (a bare `/admin/analytics` visit) — then the
  // sync effect below normalizes the URL to the resolved state, so a
  // bookmark of THIS load reproduces it exactly rather than a silently
  // re-derived one (the exact defect D10 calls out for the old range picker).
  useEffect(() => {
    const search = readLocationSearch();
    const params = new URLSearchParams(search);
    let initial = parseAnalyticsSearchParams(search);

    // R11.1/D1 — "URL-addressable as `?view=<id>`": a bookmark carrying ONLY
    // `?view=<id>` reproduces that view once the views list has loaded (the
    // apply-pending-view effect below); it takes priority over the individual
    // params this same query string might otherwise parse to (there
    // shouldn't be any — the sync effect never writes both — but a
    // hand-edited URL is not this codebase's problem to guess about).
    const viewId = viewIdFromSearch(search);
    if (viewId) setPendingViewId(viewId);

    if (!viewId && !params.has('source') && !params.has('range')) {
      try {
        const stored = parseStoredAnalyticsRange(localStorage.getItem(storageKey));
        if (stored) {
          initial = {
            source: DEFAULT_ANALYTICS_SOURCE,
            range: stored.key,
            custom: stored.custom,
            compare: defaultCompareForRange(stored.key),
            filters: EMPTY_ANALYTICS_FILTERS,
          };
        }
      } catch {
        // private browsing / disabled storage — the URL defaults stand
      }
    }

    // A pending `?view=<id>` skips the individual-params hydrate entirely —
    // the apply-pending-view effect below sets every one of these fields
    // itself once the views list resolves, so setting them here too would
    // only mean an extra render of stale defaults in between.
    if (!viewId) {
      setSource(initial.source);
      setRangeKeyState(initial.range);
      if (initial.custom) setCustom(initial.custom);
      setCompare(initial.compare);
      setFilters(initial.filters);
    }
    setHydrated(true);
    // Deliberately run once on mount — this reads the URL as it was when the
    // page loaded; subsequent state changes go through the sync effect below.
  }, []);

  /** The one path that sets `activeViewId` (every user-driven change below clears it instead). Applies the FULL view — tab/range/compare/filters/pagesSort — in one go. */
  const applyView = (view: AnalyticsSavedView) => {
    const state = viewToSearchState(view);
    setSource(state.source);
    setRangeKeyState(state.range);
    if (state.custom) setCustom(state.custom);
    setCompare(state.compare);
    setFilters(state.filters);
    setPagesSort(view.pagesSort);
    setActiveViewId(view.id);
  };

  const handleSaveView = async (name: string) => {
    try {
      const state: AnalyticsSearchState = {
        source,
        range: rangeKey,
        custom: rangeKey === 'custom' ? custom : undefined,
        compare,
        filters,
      };
      const saved = await saveAnalyticsViewRequest(getToken, buildViewInput(name, state, pagesSort));
      setViews((prev) => [...prev, saved]);
      setActiveViewId(saved.id);
      setSaveDialogOpen(false);
      toast.toast({ title: 'View saved', description: saved.name, tone: 'success' });
    } catch (error) {
      toast.toast({
        title: 'Could not save view',
        description: error instanceof Error ? error.message : undefined,
        tone: 'danger',
      });
    }
  };

  const handleDeleteView = async (view: AnalyticsSavedView) => {
    try {
      await deleteAnalyticsViewRequest(getToken, view.id);
      setViews((prev) => prev.filter((v) => v.id !== view.id));
      if (activeViewId === view.id) {
        setActiveViewId(null);
        setPagesSort(undefined);
      }
      toast.toast({ title: 'View deleted', description: view.name });
    } catch (error) {
      toast.toast({
        title: 'Could not delete view',
        description: error instanceof Error ? error.message : undefined,
        tone: 'danger',
      });
    }
  };

  // R11.1 — apply a `?view=<id>` bookmark once BOTH the URL has been read
  // (`pendingViewId`) and the views list has loaded (`views`). Runs at most
  // once per pending id (clearing it on the way out, matched or not) — an id
  // that names a view that no longer exists (deleted since the bookmark was
  // made) degrades to "nothing applied", not a repeated failed lookup.
  useEffect(() => {
    if (!pendingViewId || views.length === 0) return;
    const view = views.find((v) => v.id === pendingViewId);
    setPendingViewId(undefined);
    if (view) applyView(view);
    // `applyView` is redefined every render but only ever closes over setters
    // (stable identities) — `exhaustive-deps` is not enabled in this repo
    // (see the window-effect above's own comment for the same pattern).
  }, [pendingViewId, views]);

  // Keep the URL — and the range-only localStorage fallback for a bare
  // future visit — in sync with every tab/range/compare/filter change. A
  // still-active saved view bookmarks as `?view=<id>` alone (R11.1); any
  // manual change clears `activeViewId` (see the handlers below) and this
  // effect falls back to the fully expanded params exactly as before R11.1.
  useEffect(() => {
    if (!hydrated) return;
    if (activeViewId) {
      writeLocationSearch(`?view=${encodeURIComponent(activeViewId)}`);
      return;
    }
    const state: AnalyticsSearchState = {
      source,
      range: rangeKey,
      custom: rangeKey === 'custom' ? custom : undefined,
      compare,
      filters,
    };
    writeLocationSearch(`?${serializeAnalyticsSearchParams(state)}`);
    try {
      localStorage.setItem(
        storageKey,
        serializeStoredAnalyticsRange(rangeKey === 'custom' ? { key: rangeKey, custom } : { key: rangeKey })
      );
    } catch {
      // private browsing / disabled storage — the picker still works this page-load
    }
  }, [hydrated, activeViewId, source, rangeKey, custom, compare, filters, storageKey]);

  // R6.2: every range is available on both feeds now (D10) — switching tabs
  // no longer needs to clamp the range. Filters are an own-tab-only concept
  // (D7/§9.2); switching to Netlify clears them so a stale own-tab selection
  // never silently rides along onto a feed that can't honor it.
  // R11.1 — every handler below is a MANUAL divergence from whatever saved
  // view was active (`applyView` above is the only path that SETS
  // `activeViewId`); clearing it here is what makes the URL sync effect fall
  // back from `?view=<id>` to the fully expanded params the instant an
  // operator tweaks anything a view captured.
  const clearActiveView = () => {
    setActiveViewId(null);
    setPagesSort(undefined);
  };

  const handleSourceChange = (next: AnalyticsSource) => {
    clearActiveView();
    setSource(next);
    // D7/§9.2: filters are an own-tab-only concept — Netlify's ranking API
    // takes none, and Insights (R11.5) has no filterable window at all.
    if (next === 'netlify' || next === 'insights') setFilters(EMPTY_ANALYTICS_FILTERS);
  };

  // D3: picking a new range re-applies its default (on for a preset, off for
  // custom) — a user's explicit compare choice is preserved only WITHIN the
  // same range, not carried across a deliberate range change.
  const handleRangeSelect = (key: AnalyticsRangeKey) => {
    clearActiveView();
    setRangeKeyState(key);
    setCompare(defaultCompareForRange(key));
  };

  // R6.3 — clicking a bucket on either chart (a near-zero-width drag,
  // `UplotTrendChart`'s `onBucketSelect`) sets the range to that single day.
  // Compare re-applies its off-for-custom default (D3), same as any other
  // deliberate range change.
  const handleBucketSelect = (isoDate: string) => {
    clearActiveView();
    const day = isoDate.slice(0, 10);
    setRangeKeyState('custom');
    setCustom({ from: day, to: day });
    setCompare(defaultCompareForRange('custom'));
  };

  const handleFilterClick = (key: keyof AnalyticsFilters, value: string) => {
    clearActiveView();
    setFilters((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  };
  const handleFilterRemove = (key: keyof AnalyticsFilters) => {
    clearActiveView();
    setFilters((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const windowResult = useMemo(
    () => resolveDateWindow(rangeKey, new Date(), rangeKey === 'custom' ? custom : undefined),
    [rangeKey, custom]
  );
  // A stable primitive the fetch effects can depend on — re-fires exactly
  // when the resolved window actually changes (a custom-range edit that
  // fails validation, e.g. clearing one field mid-edit, does not re-fetch).
  const windowKey = windowResult.ok ? `${windowResult.window.from}:${windowResult.window.to}` : null;

  // The Netlify feed is fetched regardless of which tab is active: the own
  // tab's footer needs its pageviews for the capture-rate stat (D9), so
  // there is no tab-switch saving to be had here — this matches the
  // pre-R6.1 behavior exactly. The OWN feed, by contrast, is only fetched
  // while its tab is mounted (`Tabs` unmounts the inactive panel's content),
  // which is new: parking on the Netlify tab no longer pays for a sink call
  // nobody is looking at.
  const [netlifyOverview, setNetlifyOverview] = useState<AnalyticsOverview | null>(null);
  const [netlifyLoading, setNetlifyLoading] = useState(true);
  const [netlifyError, setNetlifyError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated || !windowResult.ok) return;
    let alive = true;
    setNetlifyLoading(true);
    setNetlifyError(null);
    fetchAnalyticsOverview(getToken, { range: rangeKey, custom: rangeKey === 'custom' ? custom : undefined })
      .then((result) => {
        if (alive) setNetlifyOverview(result);
      })
      .catch((err: unknown) => {
        if (alive) setNetlifyError(err instanceof Error ? err.message : 'Could not load analytics data.');
      })
      .finally(() => {
        if (alive) setNetlifyLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [hydrated, rangeKey, windowKey]);

  // R11.3 — release/publish/note markers for the current window, shared by
  // both tabs' charts. Degrades to an empty list on failure (a toast for a
  // decorative chart annotation would be noise) — a chart with no ticks
  // reads as "nothing shipped this window", never a broken page.
  useEffect(() => {
    if (!hydrated || !windowResult.ok) return;
    let alive = true;
    fetchAnnotationMarkersRequest(getToken, {
      from: new Date(windowResult.window.from).toISOString(),
      to: new Date(windowResult.window.to).toISOString(),
    })
      .then((result) => {
        if (alive) setMarkers(result);
      })
      .catch(() => {
        if (alive) setMarkers([]);
      });
    return () => {
      alive = false;
    };
  }, [hydrated, windowKey]);

  const handleDayClick = (isoDate: string) => setNoteDialogDate(isoDate.slice(0, 10));

  const handleSaveNote = async (date: string, text: string) => {
    try {
      const note = await addAnalyticsNoteRequest(getToken, { date, text });
      setMarkers((prev) => [...prev, { id: note.id, at: note.date, kind: 'note', label: note.text }]);
      setNoteDialogDate(null);
      toast.toast({ title: 'Note added', description: date, tone: 'success' });
    } catch (error) {
      toast.toast({
        title: 'Could not add note',
        description: error instanceof Error ? error.message : undefined,
        tone: 'danger',
      });
    }
  };

  const netlifyPageviews =
    netlifyOverview && netlifyOverview.configured && netlifyOverview.enabled && netlifyOverview.series
      ? netlifyOverview.series.totals.visits
      : null;

  // R11.2 — a human range string, shared by every card's CSV filename and
  // the page-level report's meta line. Deliberately NOT the URL's
  // machine-readable range key: "30 days" reads better in a downloaded
  // filename/report header than "30d".
  const rangeLabel =
    rangeKey === 'custom'
      ? `${custom.from} to ${custom.to}`
      : (ANALYTICS_RANGE_OPTIONS.find((option) => option.key === rangeKey)?.label ?? rangeKey);

  const activeViewName = activeViewId ? views.find((v) => v.id === activeViewId)?.name : undefined;
  const exportMeta: Omit<ExportMeta, 'generatedAt'> = {
    // Export (R11.2) predates the Insights tab and only ever covers
    // own/Netlify — `ExportMenu` is hidden entirely on Insights
    // (`showWindowControls` below), so this narrowing is never actually
    // exercised for `source === 'insights'`; it only needs to satisfy
    // `ExportMeta.tab`'s narrower type.
    tab: source === 'netlify' ? 'netlify' : 'own',
    range: rangeLabel,
    compare,
    filters: Object.fromEntries(analyticsFilterChips(filters).map((chip) => [chip.label, chip.value])),
    viewName: activeViewName,
  };

  const tabs: TabItem[] = [
    {
      id: 'own',
      label: 'Own tracker',
      content: (
        <OwnAnalyticsTab
          rangeKey={rangeKey}
          custom={rangeKey === 'custom' ? custom : undefined}
          windowResult={windowResult}
          windowKey={windowKey}
          filters={filters}
          compare={compare}
          pagesSort={pagesSort}
          netlifyPageviews={netlifyPageviews}
          rangeLabel={rangeLabel}
          onFilterClick={handleFilterClick}
          onFilterRemove={handleFilterRemove}
          onBucketSelect={handleBucketSelect}
          onDayClick={handleDayClick}
          markers={markers}
          onPanelChange={setOwnPanelState}
        />
      ),
    },
    {
      id: 'netlify',
      label: (
        <span className="flex flex-col items-start leading-tight">
          <span>Netlify (server-side)</span>
          <span className="text-[length:var(--adm-text-xs)] font-normal text-[var(--adm-text-muted)]">
            Traffic — visits, sources, bandwidth
          </span>
        </span>
      ),
      content: (
        <NetlifyAnalyticsTab
          overview={netlifyOverview}
          loading={!hydrated || netlifyLoading}
          error={netlifyError}
          windowResult={windowResult}
          compare={compare}
          rangeLabel={rangeLabel}
          onBucketSelect={handleBucketSelect}
          onDayClick={handleDayClick}
          markers={markers}
          onPanelChange={setNetlifyPanelState}
        />
      ),
    },
    {
      id: 'insights',
      label: (
        <span className="flex flex-col items-start leading-tight">
          <span>Insights</span>
          <span className="text-[length:var(--adm-text-xs)] font-normal text-[var(--adm-text-muted)]">
            The learning loop, read-only
          </span>
        </span>
      ),
      content: <InsightsTab />,
    },
  ];

  // R11.5 — Insights carries no window/compare/filters of its own (every row
  // is its own evidence window) and nothing on it is editable or exportable
  // in this wave, so the range picker/compare toggle/add-note/views/export
  // controls — which all act on the shared own/Netlify window — are hidden
  // rather than shown inert on a tab they don't apply to.
  const showWindowControls = source !== 'insights';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[length:var(--adm-text-xl)] font-semibold text-[var(--adm-text-heading)]">Analytics</h2>
          <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            Engagement, conversions, and producers across both tracking feeds.
          </p>
        </div>
        {showWindowControls ? (
          <div className="flex flex-wrap items-center gap-3">
            <ViewsMenu
              views={views}
              activeViewId={activeViewId}
              onApply={applyView}
              onSaveNew={() => setSaveDialogOpen(true)}
              onManage={() => setManageDialogOpen(true)}
            />
            <ExportMenu
              activePanel={source === 'own' ? ownPanelState : netlifyPanelState}
              meta={exportMeta}
              windowResult={windowResult}
              onRawExportUnavailable={(message) =>
                toast.toast({ title: 'Raw export not available', description: message, tone: 'danger' })
              }
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setNoteDialogDate(isoDate(Date.now()))}
              title="Add a note — renders as a tick on the chart"
            >
              <IconNote size={14} />
              Add note
            </Button>
            <RangePicker rangeKey={rangeKey} custom={custom} onSelect={handleRangeSelect} onCustomChange={setCustom} />
            <CompareToggle
              source={source}
              pressed={compare}
              onToggle={() => {
                clearActiveView();
                setCompare((c) => !c);
              }}
            />
          </div>
        ) : null}
      </div>
      <Tabs
        tabs={tabs}
        value={source}
        onChange={(id) => handleSourceChange(isAnalyticsSource(id) ? id : DEFAULT_ANALYTICS_SOURCE)}
      />
      <SaveViewDialog open={saveDialogOpen} onClose={() => setSaveDialogOpen(false)} onSave={handleSaveView} />
      <ManageViewsDialog
        open={manageDialogOpen}
        onClose={() => setManageDialogOpen(false)}
        views={views}
        onDelete={handleDeleteView}
      />
      <AddNoteDialog
        open={noteDialogDate !== null}
        date={noteDialogDate ?? isoDate(Date.now())}
        onClose={() => setNoteDialogDate(null)}
        onSave={handleSaveNote}
      />
    </div>
  );
}

export interface AnalyticsWorkspaceProps {
  identity: SiteIdentity;
}

export default function AnalyticsWorkspace({ identity }: AnalyticsWorkspaceProps) {
  return (
    <AdminShell currentPath="/admin/analytics" title="Analytics" identity={identity}>
      <AnalyticsBody identity={identity} />
    </AdminShell>
  );
}
