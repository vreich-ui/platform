/**
 * TrafficWorkspace (T4.1) — the `/admin/traffic` page: visits, sources, top
 * content, trends, from Netlify Analytics (gate G1). Same house pattern as
 * `GovernancePage.tsx`: a page component wraps `AdminShell`, a body
 * component does the fetch/skeleton/empty-state/render cycle.
 */
import { useEffect, useMemo, useState } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Button, Card, EmptyState, Skeleton, StatCard } from './primitives';
import { Input } from './forms';
import { TrendChart, BarList } from './TrafficCharts';
import { IconChartBar } from './icons';
import { useCurrentUser } from '@core/lib/admin/use-current-user';
import { fetchTrafficOverview, type TrafficOverview } from '@core/lib/admin/traffic-client';
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

  if (rangeKey === 'custom' && !windowResult.ok) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Card>
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-danger)]">{windowResult.error}</p>
        </Card>
      </div>
    );
  }

  if (!hydrated || loading) {
    return (
      <div className="flex flex-col gap-6">
        {header}
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
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Card>
          <EmptyState severity="error" title="Couldn't load traffic data" message={error} />
        </Card>
      </div>
    );
  }

  if (!overview) return null;

  if (!overview.configured) {
    return (
      <div className="flex flex-col gap-6">
        {header}
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
      </div>
    );
  }

  if (!overview.enabled) {
    return (
      <div className="flex flex-col gap-6">
        {header}
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
      </div>
    );
  }

  const series = overview.series;
  if (!series) return null;

  return (
    <div className="flex flex-col gap-6">
      {header}

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
