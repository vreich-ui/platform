/**
 * Analytics dashboard charts (T4.1; renamed from TrafficCharts, T21.9b) — inline SVG, no charting dependency.
 *
 * The plan named shadcn charts / Recharts; neither is installed (T0.1: no
 * shadcn, no Radix, no Recharts in this repo) and adding a charting
 * dependency to a fleet-shared package is a real decision this task does not
 * make silently. Four chart shapes (a trend line/area, three horizontal bar
 * lists) are simple enough to hand-roll: responsive (`viewBox` +
 * `max-width:100%`, no fixed pixel sizing), theme-aware (`--adm-*` tokens
 * only, matching `admin-tokens.css`'s light/dark pair — no hardcoded
 * colours), and accessible (an SVG `<title>` plus a `sr-only` data table so a
 * screen-reader user gets the real numbers, not just a shape).
 */
import { cn } from './utils';
import { buildLinePoints, pointsToPolyline, pointsToAreaPath, formatAnalyticsCount } from '@core/lib/admin/analytics-logic';
import type { AnalyticsRankingRowWithShare, AnalyticsTrendPoint } from '@core/lib/admin/analytics-logic';

// ─── shared: sr-only data table fallback ───────────────────────────────────

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

// ─── TrendChart: line + filled area, two series (visits / unique visitors) ──

const TREND_WIDTH = 640;
const TREND_HEIGHT = 200;
const TREND_PADDING = 12;

export interface TrendChartProps {
  points: AnalyticsTrendPoint[];
  className?: string;
  /** T21.2b: the own-tracker feed plots pageviews/sessions through this same
   *  chart — mislabeling those as "Visits"/"Unique visitors" would misdescribe
   *  the numbers, so the legend/aria-label text is parameterized rather than
   *  duplicating the chart. Defaults preserve the Netlify card unchanged. */
  seriesALabel?: string;
  seriesBLabel?: string;
}

export function TrendChart({
  points,
  className,
  seriesALabel = 'Visits',
  seriesBLabel = 'Unique visitors',
}: TrendChartProps) {
  if (points.length === 0) return null;

  const visitsPoints = buildLinePoints(
    points.map((p) => p.visits),
    TREND_WIDTH,
    TREND_HEIGHT,
    TREND_PADDING
  );
  const uniquesPoints = buildLinePoints(
    points.map((p) => p.uniques),
    TREND_WIDTH,
    TREND_HEIGHT,
    TREND_PADDING
  );
  const baselineY = TREND_HEIGHT - TREND_PADDING;
  const label = `${seriesALabel} and ${seriesBLabel.toLowerCase()} over ${points.length} ${points.length === 1 ? 'period' : 'periods'}, from ${points[0].t.slice(0, 10)} to ${points[points.length - 1].t.slice(0, 10)}.`;

  return (
    <div className={className}>
      <svg
        viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
        className="block h-auto w-full"
        style={{ maxWidth: '100%' }}
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        <path d={pointsToAreaPath(visitsPoints, baselineY)} fill="var(--adm-accent-soft)" stroke="none" />
        <polyline
          points={pointsToPolyline(visitsPoints)}
          fill="none"
          stroke="var(--adm-accent)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline
          points={pointsToPolyline(uniquesPoints)}
          fill="none"
          stroke="var(--adm-info)"
          strokeWidth={2}
          strokeDasharray="4 3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="mt-2 flex items-center gap-4 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full bg-[var(--adm-accent)]" aria-hidden="true" />
          {seriesALabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-0.5 w-3 rounded-full border-t-2 border-dashed border-[var(--adm-info)]"
            aria-hidden="true"
          />
          {seriesBLabel}
        </span>
      </div>
      <ScreenReaderTable
        caption={`${seriesALabel} and ${seriesBLabel.toLowerCase()} by period`}
        rows={points.map((p) => [
          p.t,
          `${p.visits} ${seriesALabel.toLowerCase()}, ${p.uniques} ${seriesBLabel.toLowerCase()}`,
        ])}
      />
    </div>
  );
}

// ─── BarList: horizontal bar list (top content / top sources) ──────────────

export interface BarListProps {
  rows: AnalyticsRankingRowWithShare[];
  caption: string;
  emptyMessage: string;
  className?: string;
}

export function BarList({ rows, caption, emptyMessage, className }: BarListProps) {
  if (rows.length === 0) {
    return (
      <p className={cn('text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]', className)}>{emptyMessage}</p>
    );
  }

  const label = `${caption}: ${rows.map((r) => `${r.label}, ${r.visits} visits`).join('; ')}.`;

  return (
    // T6.1: `role="img"` used to sit on this outer wrapper, with the
    // `ScreenReaderTable` fallback nested INSIDE it — but most AT flattens
    // an `role="img"` element's subtree to just its `aria-label`, which
    // would swallow that fallback table rather than exposing it. The role
    // now lives on the `<ul>` alone (the presentational part), so the table
    // stays a sibling screen readers can actually reach, matching
    // `TrendChart`'s svg/table split above.
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
            <span className="h-2 flex-1 overflow-hidden rounded-[var(--adm-radius-pill)] bg-[var(--adm-surface-sunken)]">
              <span
                className="block h-full rounded-[var(--adm-radius-pill)] bg-[var(--adm-accent)]"
                style={{ width: `${Math.max(row.share * 100, row.visits > 0 ? 2 : 0)}%` }}
              />
            </span>
            <span className="w-12 shrink-0 text-right text-[length:var(--adm-text-xs)] tabular-nums text-[var(--adm-text-muted)]">
              {formatAnalyticsCount(row.visits)}
            </span>
          </li>
        ))}
      </ul>
      <ScreenReaderTable caption={caption} rows={rows.map((r) => [r.label, `${r.visits} visits`])} />
    </div>
  );
}
