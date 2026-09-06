/**
 * Analytics dashboard charts (T4.1; renamed from TrafficCharts, T21.9b).
 *
 * R6.3 (T21.25) replaces the hand-rolled inline-SVG trend chart with uPlot
 * 1.6.32 (analytics-dashboard-spec.md §7) — the library the plan named for
 * one real reason: cursor sync across chart instances is built in, and it is
 * what makes a two-metric dashboard actually traceable (hover one chart, see
 * the same instant on the other). uPlot is loaded with a runtime
 * `import()` from inside `useEffect`, never a static import — the base
 * admin bundle carries zero uPlot bytes until `/admin/analytics` actually
 * mounts a chart. Drag-to-zoom is NOT a uPlot feature (the spec's own
 * correction to the runner plan, §7) — `zoomPlugin` below is the local
 * plugin against `setSelect` the spec calls for. A plain click (bucket
 * select) is handled separately, off `cursor.idx` — `setSelect` only ever
 * fires for a selection with real width/height, never a zero-movement click.
 *
 * Rankings stay HTML bars below (`BarList`) — no library, unchanged shape.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from './utils';
import { IconChartBar, IconExternalLink, IconPencil } from './icons';
import { formatAnalyticsCount } from '@core/lib/admin/analytics-logic';
import type { AnalyticsRankingRowWithShare, AnalyticsTrendPoint } from '@core/lib/admin/analytics-logic';
import type { AnnotationMarker } from '@core/lib/admin/analytics-annotations-logic';
// Type-only — erased entirely at compile time (verbatimModuleSyntax), so this
// contributes zero runtime bytes; the actual class is loaded at runtime via
// `loadUplotModule()`'s dynamic `import()` below, never a static import.
import type UplotCtor from 'uplot';

// ─── shared: sr-only data table fallback (used by the still-inert BarList) ──

function ScreenReaderTable({ caption, rows }: { caption: string; rows: Array<[string, string]> }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── uPlot: loaded once, on demand ──────────────────────────────────────────

type UplotInstance = InstanceType<typeof UplotCtor>;

let uplotModulePromise: Promise<typeof UplotCtor> | null = null;
/**
 * Memoized so N chart mounts on the same page load one copy of uPlot's
 * JS+CSS, not N. uPlot's own d.ts declares a CJS `export =`, which — unlike
 * its real ESM build's `export { uPlot as default }` — TypeScript resolves a
 * dynamic `import()` of ambiguously; the module's default export IS the
 * class at runtime (the actual `.esm.js` file, which is what a bundler
 * resolves this dynamic import to), so this one cast documents where the
 * static types and the real shape diverge rather than fighting it.
 */
function loadUplotModule(): Promise<typeof UplotCtor> {
  uplotModulePromise ??= Promise.all([import('uplot'), import('uplot/dist/uPlot.min.css')]).then(
    ([mod]) => (mod as unknown as { default: typeof UplotCtor }).default
  );
  return uplotModulePromise;
}

function readCssToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// ─── R11.3 (T21.29): annotation ticks — release/publish/note markers drawn onto the chart ──

/** Distinct, saturated colors chosen for contrast against both themes and the series lines — deliberately NOT drawn from the design-token palette (those are for chart series/chrome, and a marker needs to read as a different KIND of thing on the canvas, not a fourth series color). */
const MARKER_COLOR: Record<AnnotationMarker['kind'], string> = {
  release: '#16a34a',
  publish: '#2563eb',
  note: '#9333ea',
};

/** How close (in device px) the pointer must be to a marker's x-position for `MiniChart`'s hover tooltip to pick it up. */
const MARKER_HOVER_PX = 6;

interface PositionedMarker {
  marker: AnnotationMarker;
  ts: number;
}

/** `Date.parse` returning `NaN` (a malformed `at`) degrades to `0` — the marker just won't land inside the visible range rather than corrupting every other marker's draw call. */
function positionMarkers(markers: readonly AnnotationMarker[] | undefined): PositionedMarker[] {
  return (markers ?? []).map((marker) => ({ marker, ts: Math.floor(Date.parse(marker.at) / 1000) || 0 }));
}

/**
 * The local drag-to-zoom plugin (§7's correction — uPlot ships no zoom of its
 * own). Any deliberate drag (uPlot only fires `setSelect` at all when the
 * resulting selection has non-zero width or height — a true zero-movement
 * click never reaches this hook) zooms the shared x-scale on BOTH synced
 * charts via `zoomBothTo`, keeping "one shared time axis per tab" true after
 * a zoom too. `onZoomed` marks that a real drag just happened, so the
 * separate native `click` listener (below, in `MiniChart` — a plain click
 * needs `u.cursor.idx`, not `setSelect`, since it never fires one) can ignore
 * the `click` event a browser dispatches right after this same mouseup.
 */
function zoomPlugin(zoomBothTo: (min: number, max: number) => void, onZoomed: () => void) {
  return {
    hooks: {
      setSelect: [
        (u: UplotInstance) => {
          const { left, width } = u.select;
          const min = u.posToVal(left, 'x');
          const max = u.posToVal(left + width, 'x');
          zoomBothTo(min, max);
          onZoomed();
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
        },
      ],
    },
  };
}

interface MiniChartProps {
  points: AnalyticsTrendPoint[];
  previousPoints: (number | null)[];
  metric: 'visits' | 'uniques';
  label: string;
  color: string;
  syncKey: string;
  onBucketSelect: ((isoDate: string) => void) | undefined;
  /** Registered by the parent (a `Set`, held one level up) so a zoom fired from EITHER chart's plugin fans out to every registered chart — the actual "shared time axis" enforcement, independent of (and in addition to) uPlot's own cursor sync. */
  registerZoomTarget: (setScale: (min: number, max: number) => void) => () => void;
  /** Applies `[min,max]` to every registered chart — passed straight into this chart's own `zoomPlugin` as the drag-to-zoom action. */
  zoomBothTo: (min: number, max: number) => void;
  /** Resets every registered chart to the full x-range — wired to a double-click on this chart's own element. */
  resetBothZoom: () => void;
  /** R11.3 — release/publish/note markers, drawn as vertical ticks (a uPlot `draw` hook) with a hover tooltip naming what shipped. */
  markers: readonly AnnotationMarker[] | undefined;
  /** R11.3 — Shift+click a point to add an operator note for that day, instead of the plain click's "narrow to this day" (`onBucketSelect`). */
  onDayClick: ((isoDate: string) => void) | undefined;
}

/**
 * One synced mini time-series chart — current period solid, previous period
 * dashed (D3's ghost series). Two of these stacked (visits/pageviews +
 * uniques/sessions) make up a tab's "Over time" card; `syncKey` is the same
 * string on both, which is the entire cursor-sync wiring (uPlot's `cursor.
 * sync.key` — "hovering any chart moves the cursor on all of them", §7).
 * uPlot's own live legend is left on, so the Playwright acceptance case
 * ("hover chart A → chart B legend updates") is native behavior, not custom
 * code — the two legends together are the "every visible metric" tooltip.
 */
function MiniChart({
  points,
  previousPoints,
  metric,
  label,
  color,
  syncKey,
  onBucketSelect,
  registerZoomTarget,
  zoomBothTo,
  resetBothZoom,
  markers,
  onDayClick,
}: MiniChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const [themeTick, setThemeTick] = useState(0);
  const [hover, setHover] = useState<{ x: number; marker: AnnotationMarker } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const bump = () => setThemeTick((t) => t + 1);
    media.addEventListener('change', bump);
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      media.removeEventListener('change', bump);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || points.length === 0) return undefined;
    let instance: UplotInstance | null = null;
    let unregister: (() => void) | undefined;
    let disposed = false;

    const xs = points.map((p) => Math.floor(Date.parse(p.t) / 1000) || 0);
    const current = points.map((p) => p[metric]);
    const ghost = points.map((_, i) => previousPoints[i] ?? null);
    const positionedMarkers = positionMarkers(markers);

    const border = readCssToken('--adm-border', 'rgba(15,18,20,0.12)');
    const textMuted = readCssToken('--adm-text-muted', '#5b6470');

    void loadUplotModule().then((Uplot) => {
      if (disposed || !containerRef.current) return;
      const width = containerRef.current.clientWidth || 600;

      const options = {
        width,
        height: 140,
        padding: [8, 8, 0, 0] as [number, number, number, number],
        cursor: {
          sync: { key: syncKey, scales: ['x', null] as [string | null, string | null] },
          drag: { x: true, y: false, setScale: false },
        },
        legend: { show: true, live: true },
        scales: { x: { time: true } },
        axes: [
          { stroke: textMuted, grid: { stroke: border, width: 1 }, ticks: { stroke: border } },
          {
            stroke: textMuted,
            grid: { stroke: border, width: 1 },
            ticks: { stroke: border },
            size: 46,
            values: (_u: UplotInstance, vals: number[]) => vals.map((v) => formatAnalyticsCount(v)),
          },
        ],
        series: [
          {},
          {
            label,
            stroke: color,
            width: 2,
            points: { show: false },
            value: (_u: UplotInstance, v: number | null) => (v == null ? '—' : formatAnalyticsCount(v)),
          },
          {
            label: `${label} (previous period)`,
            stroke: color,
            width: 1.5,
            dash: [4, 3],
            points: { show: false },
            value: (_u: UplotInstance, v: number | null) => (v == null ? '—' : formatAnalyticsCount(v)),
          },
        ],
        plugins: [
          zoomPlugin(zoomBothTo, () => {
            justZoomed = true;
          }),
        ],
        // R11.3 — draws one vertical tick per marker inside the visible
        // range, ON TOP of the series (a `draw` hook runs after uPlot's own
        // paint). Distinct color per kind (`MARKER_COLOR`); a note's tick is
        // dashed so it reads as "operator-added" rather than "shipped".
        hooks: {
          draw: [
            (u: UplotInstance) => {
              if (positionedMarkers.length === 0) return;
              const { ctx } = u;
              const top = u.bbox.top;
              const bottom = u.bbox.top + u.bbox.height;
              ctx.save();
              for (const { marker, ts } of positionedMarkers) {
                const x = u.valToPos(ts, 'x', true);
                if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
                ctx.strokeStyle = MARKER_COLOR[marker.kind];
                ctx.lineWidth = 1.5;
                ctx.setLineDash(marker.kind === 'note' ? [3, 2] : []);
                ctx.beginPath();
                ctx.moveTo(x, top);
                ctx.lineTo(x, bottom);
                ctx.stroke();
              }
              ctx.restore();
            },
          ],
        },
      };

      instance = new Uplot(options, [xs, current, ghost], containerRef.current);
      unregister = registerZoomTarget((min, max) => instance?.setScale('x', { min, max }));

      // A plain click never reaches `setSelect` (uPlot only fires it for a
      // selection with real width/height) — read the hovered bucket directly
      // off the cursor instead. `justZoomed` swallows the native `click` a
      // browser also dispatches right after a real drag-to-zoom's mouseup, so
      // finishing a zoom never ALSO sets a single-day range filter. R11.3:
      // Shift+click reroutes the same gesture to "add a note for this day"
      // instead of narrowing the range — the two never fire together.
      let justZoomed = false;
      const onClick = (event: MouseEvent) => {
        if (justZoomed) {
          justZoomed = false;
          return;
        }
        const idx = instance?.cursor.idx;
        if (idx == null) return;
        const point = pointsRef.current[idx];
        if (!point) return;
        if (event.shiftKey && onDayClick) {
          onDayClick(point.t);
          return;
        }
        onBucketSelect?.(point.t);
      };
      containerRef.current.addEventListener('click', onClick);

      // R11.3 — hover tooltip: nearest marker within `MARKER_HOVER_PX` of the
      // pointer's x-position, independent of uPlot's own data-point cursor
      // (a marker's timestamp rarely lands exactly on a bucket).
      const onMouseMove = (event: MouseEvent) => {
        if (!instance || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        let nearest: { x: number; marker: AnnotationMarker; dist: number } | null = null;
        for (const { marker, ts } of positionedMarkers) {
          const x = instance.valToPos(ts, 'x', true);
          const dist = Math.abs(x - offsetX);
          if (dist <= MARKER_HOVER_PX && (!nearest || dist < nearest.dist)) nearest = { x, marker, dist };
        }
        setHover(nearest ? { x: nearest.x, marker: nearest.marker } : null);
      };
      const onMouseLeave = () => setHover(null);
      if (positionedMarkers.length > 0) {
        containerRef.current.addEventListener('mousemove', onMouseMove);
        containerRef.current.addEventListener('mouseleave', onMouseLeave);
      }

      const onDblClick = () => resetBothZoom();
      containerRef.current.addEventListener('dblclick', onDblClick);
      const resizeObserver = new ResizeObserver((entries) => {
        const nextWidth = entries[0]?.contentRect.width;
        if (nextWidth && instance) instance.setSize({ width: nextWidth, height: 140 });
      });
      resizeObserver.observe(containerRef.current);

      // Stash cleanup on the element so the outer effect teardown (below,
      // which runs before this promise necessarily resolves) can still find it.
      (containerRef.current as HTMLDivElement & { __analyticsCleanup?: () => void }).__analyticsCleanup = () => {
        containerRef.current?.removeEventListener('click', onClick);
        containerRef.current?.removeEventListener('mousemove', onMouseMove);
        containerRef.current?.removeEventListener('mouseleave', onMouseLeave);
        containerRef.current?.removeEventListener('dblclick', onDblClick);
        resizeObserver.disconnect();
        instance?.destroy();
      };
    });

    return () => {
      disposed = true;
      unregister?.();
      (el as HTMLDivElement & { __analyticsCleanup?: () => void }).__analyticsCleanup?.();
    };
  }, [
    points,
    previousPoints,
    metric,
    label,
    color,
    syncKey,
    onBucketSelect,
    registerZoomTarget,
    zoomBothTo,
    resetBothZoom,
    themeTick,
    markers,
    onDayClick,
  ]);

  // The tooltip is a SIBLING of uPlot's mount node, not a child of it —
  // uPlot manipulates that node's DOM imperatively (it inserts its own
  // canvas/legend elements directly, outside React's reconciliation), so a
  // React-rendered child living inside the SAME node risks React and uPlot
  // fighting over the same DOM subtree. Both live in this outer, merely
  // relatively-positioned wrapper instead.
  return (
    <div className="relative w-full">
      <div
        ref={containerRef}
        data-analytics-chart={metric}
        className="w-full [&_.u-legend]:text-[length:var(--adm-text-xs)]"
      />
      {hover ? (
        <div
          role="status"
          className="pointer-events-none absolute top-1 z-10 max-w-[220px] -translate-x-1/2 rounded-[var(--adm-radius-sm)] border border-[var(--adm-border-strong)] bg-[var(--adm-surface-raised)] px-2 py-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text)] shadow-[var(--adm-shadow-sm)]"
          style={{ left: hover.x }}
        >
          <span className="font-medium capitalize">{hover.marker.kind}</span>
          {': '}
          {hover.marker.label}
          {hover.marker.detail ? (
            <span className="block text-[var(--adm-text-muted)]">{hover.marker.detail}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ─── UplotTrendChart: two synced mini charts + keyboard-reachable tables ────

export interface UplotTrendChartProps {
  points: AnalyticsTrendPoint[];
  className?: string;
  /** T21.2b: the own-tracker feed plots pageviews/sessions through this same
   *  chart — mislabeling those as "Visits"/"Unique visitors" would misdescribe
   *  the numbers, so the legend/aria-label text is parameterized rather than
   *  duplicating the chart. Defaults preserve the Netlify card unchanged. */
  seriesALabel?: string;
  seriesBLabel?: string;
  /** R6.2/D3 — the previous period's points, rendered as a dashed ghost series, aligned by bucket INDEX (not real timestamp — the two windows cover different calendar days, so a real-timestamp overlay would put the ghost off-chart; the axis reads the CURRENT period's dates throughout). */
  previousPoints?: AnalyticsTrendPoint[];
  /** R6.3 — clicking a bucket (a plain click, not a drag) sets the range filter to that single day. */
  onBucketSelect?: (isoDate: string) => void;
  /** R11.3 — release/publish/note markers drawn as ticks on both mini charts, with a hover tooltip naming what shipped. */
  markers?: AnnotationMarker[];
  /** R11.3 — Shift+click a point to add an operator note for that day (a plain click keeps `onBucketSelect`'s existing behavior). */
  onDayClick?: (isoDate: string) => void;
}

export function UplotTrendChart({
  points,
  className,
  seriesALabel = 'Visits',
  seriesBLabel = 'Unique visitors',
  previousPoints,
  onBucketSelect,
  markers,
  onDayClick,
}: UplotTrendChartProps) {
  const syncKey = useId();
  const zoomTargetsRef = useRef(new Set<(min: number, max: number) => void>());

  // Hooks run unconditionally (rules-of-hooks) even though the empty-points
  // early return below means none of this is ever handed to a `MiniChart`;
  // memoized on `points`/`previousPoints` so an unrelated parent re-render
  // (e.g. a filter chip elsewhere on the page) doesn't force every chart to
  // tear down and remount its uPlot instance — only an actual data change does.
  const ghostVisits = useMemo(
    () => points.map((_, i) => previousPoints?.[i]?.visits ?? null),
    [points, previousPoints]
  );
  const ghostUniques = useMemo(
    () => points.map((_, i) => previousPoints?.[i]?.uniques ?? null),
    [points, previousPoints]
  );
  const [fullMin, fullMax] = useMemo(() => {
    const xs = points.map((p) => Math.floor(Date.parse(p.t) / 1000) || 0);
    return [xs[0] ?? 0, xs[xs.length - 1] ?? 0];
  }, [points]);

  const registerZoomTarget = useCallback((setScale: (min: number, max: number) => void) => {
    zoomTargetsRef.current.add(setScale);
    return () => {
      zoomTargetsRef.current.delete(setScale);
    };
  }, []);

  // A zoom triggered on EITHER mini chart's plugin applies the SAME
  // [min,max] to every registered chart — "one shared time axis per tab"
  // surviving a zoom, not just the initial render.
  const zoomBothTo = useCallback((min: number, max: number) => {
    zoomTargetsRef.current.forEach((setScale) => setScale(min, max));
  }, []);
  const resetBothZoom = useCallback(() => zoomBothTo(fullMin, fullMax), [zoomBothTo, fullMin, fullMax]);

  if (points.length === 0) return null;

  const label = `${seriesALabel} and ${seriesBLabel.toLowerCase()} over ${points.length} ${points.length === 1 ? 'period' : 'periods'}, from ${points[0].t.slice(0, 10)} to ${points[points.length - 1].t.slice(0, 10)}. Drag either chart to zoom, double-click to reset, click a point to filter to that day${onDayClick ? ', shift-click a point to add a note for that day' : ''}.`;

  return (
    <div className={className} role="group" aria-label={label}>
      <div className="flex flex-col gap-3">
        <MiniChart
          points={points}
          previousPoints={ghostVisits}
          metric="visits"
          label={seriesALabel}
          color="var(--adm-accent)"
          syncKey={syncKey}
          onBucketSelect={onBucketSelect}
          registerZoomTarget={registerZoomTarget}
          zoomBothTo={zoomBothTo}
          resetBothZoom={resetBothZoom}
          markers={markers}
          onDayClick={onDayClick}
        />
        <ChartDataTable points={points} previousPoints={ghostVisits} metric="visits" label={seriesALabel} />
        <MiniChart
          points={points}
          previousPoints={ghostUniques}
          metric="uniques"
          label={seriesBLabel}
          color="var(--adm-info)"
          syncKey={syncKey}
          onBucketSelect={onBucketSelect}
          registerZoomTarget={registerZoomTarget}
          zoomBothTo={zoomBothTo}
          resetBothZoom={resetBothZoom}
          markers={markers}
          onDayClick={onDayClick}
        />
        <ChartDataTable points={points} previousPoints={ghostUniques} metric="uniques" label={seriesBLabel} />
      </div>
    </div>
  );
}

/**
 * §8's load-bearing mitigation for "uPlot ships no accessibility
 * affordances — canvas is opaque to a screen reader": a REAL, visible
 * (once opened) table, not `sr-only` — collapsed by default, reachable and
 * togglable by keyboard (`<summary>` is natively focusable), and announced
 * by assistive tech as a disclosure widget. One of these sits under each of
 * the two mini charts, per spec §8's "under every chart".
 */
function ChartDataTable({
  points,
  previousPoints,
  metric,
  label,
}: {
  points: AnalyticsTrendPoint[];
  previousPoints: (number | null)[];
  metric: 'visits' | 'uniques';
  label: string;
}) {
  return (
    <details className="group">
      <summary className="adm-focusable inline-block cursor-pointer select-none rounded-[var(--adm-radius-sm)] px-1 py-0.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]">
        {label} — data table
      </summary>
      <div className="mt-1 max-h-40 overflow-y-auto rounded-[var(--adm-radius-sm)] border border-[var(--adm-border)]">
        <table className="w-full text-[length:var(--adm-text-xs)]">
          <caption className="sr-only">{`${label} by period, current and previous`}</caption>
          <thead>
            <tr className="border-b border-[var(--adm-border)] text-left text-[var(--adm-text-muted)]">
              <th scope="col" className="px-2 py-1 font-medium">
                Period
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                {label}
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                Previous
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={p.t} className="border-b border-[var(--adm-border)] last:border-0">
                <td className="px-2 py-1 text-[var(--adm-text-muted)]">{p.t}</td>
                <td className="px-2 py-1 tabular-nums text-[var(--adm-text)]">{p[metric]}</td>
                <td className="px-2 py-1 tabular-nums text-[var(--adm-text-muted)]">
                  {previousPoints[i] == null ? '—' : previousPoints[i]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ─── BarList: horizontal bar list (top content / top sources) ──────────────

export interface BarListProps {
  rows: AnalyticsRankingRowWithShare[];
  caption: string;
  emptyMessage: string;
  className?: string;
  /**
   * R6.2/D7 — set when this view's rows are click-to-filter (own tab
   * dimensions the sink can filter on). Absent ⇒ rows render as plain
   * text/links, matching the pre-R6.2 behavior exactly (Netlify's views, and
   * own-tab dimensions the sink cannot filter on, e.g. devices/scroll
   * depth). `row.value ?? row.label` is what gets passed back.
   */
  onRowClick?: (row: AnalyticsRankingRowWithShare) => void;
  /** The active filter value for this view, if any (D7) — highlights the matching row so a reader can see what's currently narrowing the page. */
  activeValue?: string;
}

const rowValue = (row: AnalyticsRankingRowWithShare): string => row.value ?? row.label;

/** A bar row's fixed-width bar-and-count — shared between the interactive (button) and inert (plain) row shapes so both look identical. */
function BarFill({ row }: { row: AnalyticsRankingRowWithShare }) {
  return (
    <>
      <span className="h-2 flex-1 overflow-hidden rounded-[var(--adm-radius-pill)] bg-[var(--adm-surface-sunken)]">
        <span
          className="block h-full rounded-[var(--adm-radius-pill)] bg-[var(--adm-accent)]"
          style={{ width: `${Math.max(row.share * 100, row.visits > 0 ? 2 : 0)}%` }}
        />
      </span>
      <span className="w-12 shrink-0 text-right text-[length:var(--adm-text-xs)] tabular-nums text-[var(--adm-text-muted)]">
        {formatAnalyticsCount(row.visits)}
      </span>
    </>
  );
}

export function BarList({ rows, caption, emptyMessage, className, onRowClick, activeValue }: BarListProps) {
  if (rows.length === 0) {
    return (
      <p className={cn('text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]', className)}>{emptyMessage}</p>
    );
  }

  // Interactive rows (click-to-filter, or a resolved live-page/admin link)
  // get real semantics — a labeled button/anchor per row — so `role="img"`
  // (which flattens the whole subtree to one `aria-label`, per T6.1's
  // finding) would hide them from assistive tech. Only the fully inert case
  // (no filter, no links, no sublabel) keeps the original image-plus-sr-table
  // shape unchanged.
  const anyInteractive = rows.some(
    (row) => onRowClick || row.href || row.adminHref || row.analyticsHref || row.sublabel || row.unresolved
  );

  if (!anyInteractive) {
    const label = `${caption}: ${rows.map((r) => `${r.label}, ${r.visits} visits`).join('; ')}.`;
    return (
      <div className={className}>
        <ul className="flex flex-col gap-2" role="img" aria-label={label}>
          {rows.map((row) => (
            <li key={row.label} className="flex items-center gap-3">
              <span
                className="w-28 shrink-0 truncate text-[length:var(--adm-text-sm)] text-[var(--adm-text)]"
                title={row.label}
              >
                {row.label}
              </span>
              <BarFill row={row} />
            </li>
          ))}
        </ul>
        <ScreenReaderTable caption={caption} rows={rows.map((r) => [r.label, `${r.visits} visits`])} />
      </div>
    );
  }

  return (
    <ul className={cn('flex flex-col gap-1.5', className)} aria-label={caption}>
      {rows.map((row) => {
        const value = rowValue(row);
        const active = activeValue !== undefined && activeValue === value;
        const accessibleLabel = `${row.label}${row.unresolved ? ' (unresolved)' : ''}, ${row.visits} visits${row.sublabel ? `, ${row.sublabel}` : ''}`;
        return (
          <li key={`${row.label}-${value}`} className="flex items-center gap-2">
            {onRowClick ? (
              <button
                type="button"
                aria-pressed={active}
                aria-label={accessibleLabel}
                title={row.unresolved ? `${row.label} — could not be resolved to a title` : row.label}
                className={cn(
                  'adm-focusable flex min-w-0 flex-1 items-center gap-3 rounded-[var(--adm-radius-sm)] px-1 py-0.5 text-left',
                  active ? 'bg-[var(--adm-accent-soft)]' : 'hover:bg-[var(--adm-surface-sunken)]'
                )}
                onClick={(e) => {
                  if ((e.metaKey || e.ctrlKey) && row.href) {
                    window.open(row.href, '_blank', 'noopener,noreferrer');
                    return;
                  }
                  onRowClick(row);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block w-28 truncate text-[length:var(--adm-text-sm)] text-[var(--adm-text)] sm:w-auto">
                    {row.label}
                    {row.unresolved ? (
                      <span className="ml-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                        unresolved
                      </span>
                    ) : null}
                  </span>
                  {row.sublabel ? (
                    <span className="block truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                      {row.sublabel}
                    </span>
                  ) : null}
                </span>
                <BarFill row={row} />
              </button>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-3 px-1 py-0.5">
                <span className="min-w-0 flex-1">
                  <span
                    className="block w-28 truncate text-[length:var(--adm-text-sm)] text-[var(--adm-text)] sm:w-auto"
                    title={row.label}
                  >
                    {row.label}
                  </span>
                  {row.sublabel ? (
                    <span className="block truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                      {row.sublabel}
                    </span>
                  ) : null}
                </span>
                <BarFill row={row} />
              </span>
            )}
            {row.href ? (
              <a
                href={row.href}
                target="_blank"
                rel="noopener noreferrer"
                title="Open the live page"
                aria-label={`Open ${row.label} on the live site`}
                className="adm-focusable shrink-0 rounded-[var(--adm-radius-sm)] p-1 text-[var(--adm-text-muted)] hover:bg-[var(--adm-surface-sunken)] hover:text-[var(--adm-text)]"
              >
                <IconExternalLink size={14} />
              </a>
            ) : null}
            {row.adminHref ? (
              <a
                href={row.adminHref}
                title="Open the admin object"
                aria-label={`Open ${row.label} in the admin object workspace`}
                className="adm-focusable shrink-0 rounded-[var(--adm-radius-sm)] p-1 text-[var(--adm-text-muted)] hover:bg-[var(--adm-surface-sunken)] hover:text-[var(--adm-text)]"
              >
                <IconPencil size={14} />
              </a>
            ) : null}
            {row.analyticsHref ? (
              <a
                href={row.analyticsHref}
                title="Open the analytics drill-down"
                aria-label={`Open ${row.label} in the analytics drill-down`}
                className="adm-focusable shrink-0 rounded-[var(--adm-radius-sm)] p-1 text-[var(--adm-text-muted)] hover:bg-[var(--adm-surface-sunken)] hover:text-[var(--adm-text)]"
              >
                <IconChartBar size={14} />
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
