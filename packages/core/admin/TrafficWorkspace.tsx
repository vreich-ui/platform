/**
 * TrafficWorkspace (T4.1) — the `/admin/traffic` page: visits, sources, top
 * content, trends, from Netlify Analytics (gate G1). Same house pattern as
 * `GovernancePage.tsx`: a page component wraps `AdminShell`, a body
 * component does the fetch/skeleton/empty-state/render cycle.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Button, Card, EmptyState, Skeleton, StatCard } from './primitives';
import { Input } from './forms';
import { TrendChart, BarList } from './TrafficCharts';
import { IconChartBar } from './icons';
import { useCurrentUser } from '@core/lib/admin/use-current-user';
import { fetchTrafficOverview, type TrafficOverview } from '@core/lib/admin/traffic-client';
import { fetchOwnTrafficOverview, type OwnTrafficOverview } from '@core/lib/admin/own-traffic-client';
import {
  ownTrackerChartSeries,
  ownTrackerStatRow,
  captureRate,
  type OwnTrackerDays,
  type SurfaceSplitRow,
} from '@core/lib/admin/own-traffic-logic';
import {
  TRAFFIC_RANGE_OPTIONS,
  DEFAULT_TRAFFIC_RANGE,
  resolveDateWindow,
  formatTrafficCount,
  trafficRangeStorageKey,
  parseStoredTrafficRange,
  serializeStoredTrafficRange,
  type TrafficRangeKey,
  type CustomRangeInput,
  type TrafficRankingRowWithShare,
} from '@core/lib/admin/traffic-logic';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

// ─── range persistence (localStorage, per site + per viewer) ───────────────

function readStoredRange(storageKey: string): { key: TrafficRangeKey; custom?: CustomRangeInput } | null {
  try {
    return parseStoredTrafficRange(localStorage.getItem(storageKey));
  } catch {
    return null;
  }
}

function writeStoredRange(storageKey: string, value: { key: TrafficRangeKey; custom?: CustomRangeInput }): void {
  try {
    localStorage.setItem(storageKey, serializeStoredTrafficRange(value));
  } catch {
    // private browsing / disabled storage — the picker still works this page-load
  }
}

// ─── range picker ────────────────────────────────────────────────────────────

function RangePicker({
  rangeKey,
  custom,
  onSelect,
  onCustomChange,
}: {
  rangeKey: TrafficRangeKey;
  custom: CustomRangeInput;
  onSelect: (key: TrafficRangeKey) => void;
  onCustomChange: (custom: CustomRangeInput) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex items-center gap-1 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] p-0.5">
        {TRAFFIC_RANGE_OPTIONS.map((option) => (
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

/**
 * W7.4 — the surface split as bar-list rows.
 *
 * `share` is relative to the LARGEST surface, matching every other bar list on
 * this page (`withShare` in traffic-logic). A bar list whose fills meant
 * something different from the one beside it would be read wrong at a glance.
 */
const surfaceBarRows = (rows: readonly SurfaceSplitRow[]): TrafficRankingRowWithShare[] => {
  const max = rows.reduce((most, row) => Math.max(most, row.pageviews), 0);
  return rows.map((row) => ({
    label: `${row.surface} (${row.objects} object${row.objects === 1 ? '' : 's'})`,
    visits: row.pageviews,
    share: max > 0 ? row.pageviews / max : 0,
  }));
};

// ─── own-tracker section (T21.2b — a second, first-party data source) ──────

function SubsectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2 px-1 text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
      {children}
    </p>
  );
}

function OwnTrackerSection({
  days,
  netlifyPageviews,
  netlifyRangeDays,
}: {
  days: OwnTrackerDays;
  /** Netlify's window total, when that feed is loaded/enabled — `null` while unknown or unavailable. */
  netlifyPageviews: number | null;
  /** The day-count Netlify's CURRENT range actually covers (7/30), or `null` for 90d/custom — no matching own-tracker window to compare. */
  netlifyRangeDays: number | null;
}) {
  const [overview, setOverview] = useState<OwnTrafficOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchOwnTrafficOverview(getToken, { days })
      .then((result) => {
        if (alive) setOverview(result);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load own-tracker data.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [days]);

  let body: ReactNode;

  if (loading) {
    body = (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Skeleton variant="rect" height={84} />
        <Skeleton variant="rect" height={84} />
        <Skeleton variant="rect" height={84} />
      </div>
    );
  } else if (error) {
    body = <EmptyState severity="error" title="Couldn't load own-tracker data" message={error} />;
  } else if (!overview) {
    body = null;
  } else if (!overview.configured || !overview.stats) {
    body = (
      <EmptyState
        icon={<IconChartBar size={26} />}
        title="Own tracker isn't connected"
        message={
          overview.message ??
          'The own-tracker sink is not configured for this site. Set TRACKING_SINK_URL and TRACKING_PROJECT_ID to see first-party traffic here.'
        }
      />
    );
  } else {
    const stats = overview.stats;
    const series = ownTrackerChartSeries(stats);
    const stat = ownTrackerStatRow(stats);
    const rate =
      netlifyPageviews === null ? null : captureRate(series.totals.visits, netlifyPageviews, days, netlifyRangeDays);

    body = (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Sessions" value={formatTrafficCount(stat.sessions)} />
          <StatCard label="Visitors" value={formatTrafficCount(stat.visitors)} />
          <StatCard
            label="Consented"
            value={stat.consentedPct === null ? '—' : `${stat.consentedPct}%`}
            hint="Share of sessions with tracking consent"
          />
          <StatCard label="Purchases" value={formatTrafficCount(stat.purchases)} />
          <StatCard
            label="Last event"
            value={stat.lastEventAt ? new Date(stat.lastEventAt).toLocaleString() : 'None yet'}
          />
          {rate !== null ? (
            <StatCard
              label="Capture rate"
              value={`${rate}%`}
              hint="Own-tracker pageviews ÷ Netlify pageviews (server-side, not blockable) over the same range — a lower bound on client-side visibility, not a completeness score."
            />
          ) : null}
        </div>

        <div>
          <SubsectionLabel>Pageviews and sessions</SubsectionLabel>
          {series.trend.length > 0 ? (
            <TrendChart points={series.trend} seriesALabel="Pageviews" seriesBLabel="Sessions" />
          ) : (
            <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
              No events recorded in this range.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <SubsectionLabel>Top objects</SubsectionLabel>
            <BarList
              rows={series.topPaths}
              caption="Most-visited objects"
              emptyMessage="No object views recorded in this range."
            />
          </div>
          <div>
            <SubsectionLabel>Top sources</SubsectionLabel>
            <BarList
              rows={series.topSources}
              caption="Traffic sources"
              emptyMessage="No referrer/UTM data recorded in this range."
            />
          </div>
        </div>

        {/*
          W7.4 — the whole reason the publishing surface is stamped on a receipt:
          "do plugin-written articles perform differently from workflow-written
          ones?" Rendered only when there is more than one surface in the window,
          because a single-surface bar chart is a bar chart of one fact.
        */}
        {(overview.surfaces?.length ?? 0) > 1 ? (
          <div>
            <SubsectionLabel>Pageviews by publishing surface</SubsectionLabel>
            <BarList
              rows={surfaceBarRows(overview.surfaces ?? [])}
              caption="Which chat app — or the autonomous workflow — published the objects being read"
              emptyMessage="No published-surface data for this range."
            />
            <p className="mt-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              <code>workflow</code> is the autonomous path. <code>unknown</code> means the object could not be read, or
              was published before the surface was recorded — deliberately not folded into <code>workflow</code>, which
              would overstate its share.
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Card kicker="First-party" title="Own tracker (first-party)">
      <p className="mb-4 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        Events from this site&rsquo;s own tracking sink — client-side, so ad blockers and tracking protection can
        suppress it. Netlify Analytics below runs server-side and cannot be blocked.
      </p>
      {body}
    </Card>
  );
}

// ─── body ─────────────────────────────────────────────────────────────────────

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function defaultCustomRange(now: Date): CustomRangeInput {
  return { from: isoDate(now.getTime() - 30 * 86_400_000), to: isoDate(now.getTime()) };
}

function TrafficBody({ identity }: { identity: SiteIdentity }) {
  const currentUser = useCurrentUser();
  const storageKey = trafficRangeStorageKey(identity.siteSlug, currentUser.user?.email ?? '');

  const [rangeKey, setRangeKey] = useState<TrafficRangeKey>(DEFAULT_TRAFFIC_RANGE);
  const [custom, setCustom] = useState<CustomRangeInput>(() => defaultCustomRange(new Date()));
  const [hydrated, setHydrated] = useState(false);
  const [overview, setOverview] = useState<TrafficOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Hydrate the stored range after mount only (reading localStorage during
  // the initial render would make this component's first paint differ from
  // the server-rendered shell).
  useEffect(() => {
    const stored = readStoredRange(storageKey);
    if (stored) {
      setRangeKey(stored.key);
      if (stored.custom) setCustom(stored.custom);
    }
    setHydrated(true);
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    writeStoredRange(storageKey, rangeKey === 'custom' ? { key: rangeKey, custom } : { key: rangeKey });
  }, [hydrated, storageKey, rangeKey, custom]);

  const windowResult = useMemo(
    () => resolveDateWindow(rangeKey, new Date(), rangeKey === 'custom' ? custom : undefined),
    [rangeKey, custom]
  );
  // A stable primitive the fetch effect can depend on — re-fires exactly
  // when the resolved window actually changes (a custom-range edit that
  // fails validation, e.g. clearing one field mid-edit, does not re-fetch).
  const windowKey = windowResult.ok ? `${windowResult.window.from}:${windowResult.window.to}` : null;

  useEffect(() => {
    if (!hydrated || !windowResult.ok) return;
    let alive = true;
    setLoading(true);
    setError(null);
    fetchTrafficOverview(getToken, { range: rangeKey, custom: rangeKey === 'custom' ? custom : undefined })
      .then((result) => {
        if (alive) setOverview(result);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load traffic data.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [hydrated, rangeKey, windowKey]);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-[length:var(--adm-text-xl)] font-semibold text-[var(--adm-text-heading)]">Traffic</h2>
        <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          Visits, sources, and top content from Netlify Analytics.
        </p>
      </div>
      <RangePicker rangeKey={rangeKey} custom={custom} onSelect={setRangeKey} onCustomChange={setCustom} />
    </div>
  );

  // Own-tracker only ever asks the sink for a 7- or 30-day window; it rides
  // the same range picker rather than adding a second control, clamping the
  // longer/unbounded Netlify ranges down to the closest supported one.
  // `netlifyRangeDays` (below) is what actually gates the capture-rate stat —
  // this is just which window OwnTrackerSection itself fetches and shows.
  const ownDays: OwnTrackerDays = rangeKey === '7d' ? 7 : 30;
  // Only 7d/30d have an exact own-tracker counterpart; 90d/custom means the
  // two feeds are not looking at the same range, so captureRate() gets told
  // there is nothing to compare against.
  const netlifyRangeDays = rangeKey === '7d' ? 7 : rangeKey === '30d' ? 30 : null;
  const netlifyPageviews =
    overview && overview.configured && overview.enabled && overview.series ? overview.series.totals.visits : null;

  let netlifyContent: ReactNode;

  if (rangeKey === 'custom' && !windowResult.ok) {
    netlifyContent = (
      <Card>
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-danger)]">{windowResult.error}</p>
      </Card>
    );
  } else if (!hydrated || loading) {
    netlifyContent = (
      <>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Skeleton variant="rect" height={84} />
          <Skeleton variant="rect" height={84} />
          <Skeleton variant="rect" height={84} />
        </div>
        <Skeleton variant="rect" height={240} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton variant="rect" height={200} />
          <Skeleton variant="rect" height={200} />
        </div>
      </>
    );
  } else if (error) {
    netlifyContent = (
      <Card>
        <EmptyState severity="error" title="Couldn't load traffic data" message={error} />
      </Card>
    );
  } else if (!overview) {
    netlifyContent = null;
  } else if (!overview.configured) {
    netlifyContent = (
      <Card>
        <EmptyState
          icon={<IconChartBar size={26} />}
          title="Netlify Analytics isn't connected"
          message={
            overview.message ??
            'Netlify Analytics credentials are not configured for this site. Set the Netlify site id and access token this deployment already uses for deploy lookups.'
          }
        />
      </Card>
    );
  } else if (!overview.enabled) {
    netlifyContent = (
      <Card>
        <EmptyState
          icon={<IconChartBar size={26} />}
          title="Analytics is not enabled for this site"
          message={
            overview.message ??
            'Turn on the Netlify Analytics add-on for this site in Netlify to see traffic data here.'
          }
        />
      </Card>
    );
  } else if (!overview.series) {
    netlifyContent = null;
  } else {
    const series = overview.series;
    netlifyContent = (
      <>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard label="Visits" value={formatTrafficCount(series.totals.visits)} />
          <StatCard label="Unique visitors" value={formatTrafficCount(series.totals.uniques)} />
          <StatCard
            label="Average per period"
            value={formatTrafficCount(series.totals.avgPerBucket)}
            hint={overview.window?.resolution === 'hour' ? 'per hour' : 'per day'}
          />
        </div>

        <Card kicker="Trend" title="Visits over time">
          {series.trend.length > 0 ? (
            <TrendChart points={series.trend} />
          ) : (
            <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
              No visits recorded in this range.
            </p>
          )}
        </Card>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card kicker="Top content" title="Most-visited pages" actions={<Badge>{series.topPaths.length}</Badge>}>
            <BarList
              rows={series.topPaths}
              caption="Most-visited pages"
              emptyMessage="No page views recorded in this range."
            />
          </Card>
          <Card kicker="Sources" title="Where visits came from" actions={<Badge>{series.topSources.length}</Badge>}>
            <BarList
              rows={series.topSources}
              caption="Traffic sources"
              emptyMessage="No referrer data recorded in this range."
            />
          </Card>
        </div>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      <OwnTrackerSection days={ownDays} netlifyPageviews={netlifyPageviews} netlifyRangeDays={netlifyRangeDays} />
      {netlifyContent}
    </div>
  );
}

export interface TrafficWorkspaceProps {
  identity: SiteIdentity;
}

export default function TrafficWorkspace({ identity }: TrafficWorkspaceProps) {
  return (
    <AdminShell currentPath="/admin/traffic" title="Traffic" identity={identity}>
      <TrafficBody identity={identity} />
    </AdminShell>
  );
}
