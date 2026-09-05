/**
 * AnalyticsWorkspace (T4.1; renamed from TrafficWorkspace, T21.9b) — the
 * `/admin/analytics` page. R6.1 (T21.11) rebuilt this as two TABS over one
 * shared layout — analytics-dashboard-spec.md D1: "Own tracker" and
 * "Netlify" render through the SAME KPI strip / chart card / ranking-card
 * components, so moving between them is a change of data, not of
 * vocabulary. Tab + range + compare state is persisted in the URL
 * (`?source=own|netlify&range=...&compare=...`, `analytics-logic.ts`'s
 * `parseAnalyticsSearchParams`/`serializeAnalyticsSearchParams`) so a
 * bookmark reproduces the exact view.
 *
 * Scope discipline (R6.1 is layout ONLY): no new data point that isn't
 * already in `AnalyticsOverview`/`OwnAnalyticsOverview` is invented here —
 * the Netlify tab's KPI strip is still Visits/Uniques/Avg-per-bucket (the
 * D2 vision's Top-page-share/404s/Bandwidth need R6.2's new endpoints), the
 * compare toggle is wired but inert everywhere (`isCompareAvailable` is
 * `false` until a feed actually carries a previous-period figure), and the
 * charts are still the hand-rolled SVG from `AnalyticsCharts.tsx` (R6.3
 * swaps the library). What's new is the SHAPE: two tabs instead of two
 * stacked sections, a compact KPI strip instead of five oversized tiles,
 * and health/meta (last event, capture rate) moved into a footer strip —
 * never sized like a metric.
 *
 * Same house pattern as `GovernancePage.tsx`: a page component wraps
 * `AdminShell`, a body component does the fetch/state/render cycle. The
 * actual "what should this tab show right now" decision is a PURE function
 * per feed (`resolveNetlifyAnalyticsPanel` in `analytics-logic.ts`,
 * `resolveOwnAnalyticsPanel` in `own-analytics-logic.ts`) — this file is a
 * thin, untested switch over their shared `AnalyticsPanelState`, matching
 * this codebase's rule that pure logic is the tested tier and JSX is not.
 */
import { useEffect, useMemo, useState } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Button, type ButtonProps, Card, EmptyState, Skeleton } from './primitives';
import { Input } from './forms';
import { Tabs, type TabItem } from './menus';
import { Popover } from './overlays';
import { TrendChart, BarList } from './AnalyticsCharts';
import { IconChartBar } from './icons';
import { useCurrentUser } from '@core/lib/admin/use-current-user';
import { fetchAnalyticsOverview, type AnalyticsOverview } from '@core/lib/admin/analytics-client';
import { fetchOwnAnalyticsOverview, type OwnAnalyticsOverview } from '@core/lib/admin/own-analytics-client';
import { resolveOwnAnalyticsPanel, type OwnTrackerDays } from '@core/lib/admin/own-analytics-logic';
import {
  ANALYTICS_RANGE_OPTIONS,
  DEFAULT_ANALYTICS_SOURCE,
  resolveDateWindow,
  resolveNetlifyAnalyticsPanel,
  parseAnalyticsSearchParams,
  serializeAnalyticsSearchParams,
  isRangeAvailableForSource,
  clampRangeForSource,
  isCompareAvailable,
  analyticsRangeStorageKey,
  parseStoredAnalyticsRange,
  serializeStoredAnalyticsRange,
  type AnalyticsRangeKey,
  type AnalyticsSource,
  type AnalyticsSearchState,
  type CustomRangeInput,
  type AnalyticsPanelState,
  type AnalyticsChartView,
  type KpiDatum,
  type RankingGroup,
  type AnalyticsFooterItem,
  type DateWindowResult,
} from '@core/lib/admin/analytics-logic';

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

// ─── range picker + compare toggle (shared header controls) ────────────────

/**
 * A disabled `Button` with a reason, per Convention D3 — the same pattern
 * as `approval.tsx`'s `DecisionButton`: a native `title=` on a disabled
 * `<button>` only ever reaches a mouse, so the reason instead rides T0's
 * `Popover` (hover mode), which moves the listeners onto a focusable
 * wrapper span reachable by keyboard focus and touch, not just hover.
 */
function ReasonedButton({ reason, disabled, ...buttonProps }: { reason?: string } & ButtonProps) {
  if (!reason) return <Button disabled={disabled} {...buttonProps} />;
  return (
    <Popover
      mode="hover"
      content={reason}
      disabled
      trigger={(a11y) => <Button {...buttonProps} disabled {...a11y} />}
    />
  );
}

function RangePicker({
  rangeKey,
  source,
  custom,
  onSelect,
  onCustomChange,
}: {
  rangeKey: AnalyticsRangeKey;
  source: AnalyticsSource;
  custom: CustomRangeInput;
  onSelect: (key: AnalyticsRangeKey) => void;
  onCustomChange: (custom: CustomRangeInput) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex items-center gap-1 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] p-0.5">
        {ANALYTICS_RANGE_OPTIONS.map((option) => {
          const available = isRangeAvailableForSource(option.key, source);
          return (
            <ReasonedButton
              key={option.key}
              type="button"
              size="sm"
              variant={rangeKey === option.key ? 'secondary' : 'ghost'}
              aria-pressed={rangeKey === option.key}
              disabled={!available}
              reason={
                available ? undefined : 'Not available yet for the own tracker — R6.2 adds a wider window to that feed.'
              }
              onClick={() => onSelect(option.key)}
            >
              {option.label}
            </ReasonedButton>
          );
        })}
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
 * D3's compare toggle — wired into the header for every source, disabled
 * everywhere in R6.1 (`isCompareAvailable`): neither feed's payload carries
 * a previous-period figure yet (R6.2). A disabled control with an honest
 * title, never a silently-ignored click or a fabricated delta.
 */
function CompareToggle({ source }: { source: AnalyticsSource }) {
  const available = isCompareAvailable(source);
  return (
    <ReasonedButton
      type="button"
      size="sm"
      variant="ghost"
      disabled={!available}
      aria-pressed={false}
      reason={
        available ? undefined : 'Comparison data lands in R6.2 — neither feed carries a previous-period figure yet.'
      }
    >
      Compare: previous period
    </ReasonedButton>
  );
}

// ─── shared presentational layer: KPI strip / chart card / ranking cards ───
//
// D1/R6.1: both tabs render through these three, differing only in the data
// (`AnalyticsPanelState`) each feed's resolver produces.

function KpiStrip({ items }: { items: KpiDatum[] }) {
  if (items.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((item) => (
        <div
          key={item.id}
          className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] px-3 py-2.5"
        >
          <p className="truncate text-[length:var(--adm-text-xs)] font-medium uppercase tracking-wide text-[var(--adm-text-muted)]">
            {item.label}
          </p>
          <p className="mt-0.5 text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">
            {item.value}
          </p>
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
  );
}

function ChartCard({ chart }: { chart: AnalyticsChartView }) {
  return (
    <Card kicker="Trend" title="Over time">
      {chart.points.length > 0 ? (
        <TrendChart points={chart.points} seriesALabel={chart.seriesALabel} seriesBLabel={chart.seriesBLabel} />
      ) : (
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{chart.emptyMessage}</p>
      )}
    </Card>
  );
}

/** Density: ≤320px tall (TOP_LIST_LIMIT=8 rows + header fits comfortably under that; overflow scrolls rather than growing the card). */
function RankingCard({ group }: { group: RankingGroup }) {
  return (
    <Card
      kicker={group.title}
      title={group.caption}
      actions={<Badge>{group.rows.length}</Badge>}
      className="flex max-h-[320px] flex-col"
      bodyClassName="min-h-0 flex-1 overflow-y-auto"
    >
      <BarList rows={group.rows} caption={group.caption} emptyMessage={group.emptyMessage} />
      {group.footnote ? (
        <p className="mt-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{group.footnote}</p>
      ) : null}
    </Card>
  );
}

/** Two columns at ≥1024px (`lg`), three at ≥1280px (`xl`) — "a two- or three-column grid that works on a laptop screen". */
function RankingGrid({ groups }: { groups: RankingGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
      {groups.map((group) => (
        <RankingCard key={group.id} group={group} />
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
}: {
  state: AnalyticsPanelState;
  notConfiguredTitle: string;
  notEnabledTitle: string;
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
          <KpiStrip items={state.kpis} />
          <ChartCard chart={state.chart} />
          <RankingGrid groups={state.rankings} />
          <FooterStrip items={state.footer} />
        </div>
      );
  }
}

// ─── own tracker tab (T21.2b — the first-party feed) ────────────────────────

function OwnAnalyticsTab({
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
  const [overview, setOverview] = useState<OwnAnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchOwnAnalyticsOverview(getToken, { days })
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
  }, [days]);

  const panel = resolveOwnAnalyticsPanel({ loading, error, overview, netlifyPageviews, netlifyRangeDays, days });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        Events from this site&rsquo;s own tracking sink — client-side, so ad blockers and tracking protection can
        suppress it.
      </p>
      <AnalyticsPanel
        state={panel}
        notConfiguredTitle="Own tracker isn't connected"
        notEnabledTitle="Own tracker isn't enabled"
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
}: {
  overview: AnalyticsOverview | null;
  loading: boolean;
  error: string | null;
  windowResult: DateWindowResult;
}) {
  const panel = resolveNetlifyAnalyticsPanel({ loading, error, windowResult, overview });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        Netlify Analytics — server-side, so it runs regardless of ad blockers or tracking protection.
      </p>
      <AnalyticsPanel
        state={panel}
        notConfiguredTitle="Netlify Analytics isn't connected"
        notEnabledTitle="Analytics is not enabled for this site"
      />
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

  const [source, setSource] = useState<AnalyticsSource>(DEFAULT_ANALYTICS_SOURCE);
  const [rangeKey, setRangeKeyState] = useState<AnalyticsRangeKey>('30d');
  const [custom, setCustom] = useState<CustomRangeInput>(() => defaultCustomRange(new Date()));
  const [hydrated, setHydrated] = useState(false);

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

    if (!params.has('source') && !params.has('range')) {
      try {
        const stored = parseStoredAnalyticsRange(localStorage.getItem(storageKey));
        if (stored) {
          initial = {
            source: DEFAULT_ANALYTICS_SOURCE,
            range: clampRangeForSource(stored.key, DEFAULT_ANALYTICS_SOURCE),
            custom: stored.custom,
            compare: false,
          };
        }
      } catch {
        // private browsing / disabled storage — the URL defaults stand
      }
    }

    setSource(initial.source);
    setRangeKeyState(initial.range);
    if (initial.custom) setCustom(initial.custom);
    setHydrated(true);
    // Deliberately run once on mount — this reads the URL as it was when the
    // page loaded; subsequent state changes go through the sync effect below.
  }, []);

  // Keep the URL — and the range-only localStorage fallback for a bare
  // future visit — in sync with every tab/range/custom change.
  useEffect(() => {
    if (!hydrated) return;
    const state: AnalyticsSearchState = {
      source,
      range: rangeKey,
      custom: rangeKey === 'custom' ? custom : undefined,
      compare: false,
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
  }, [hydrated, source, rangeKey, custom, storageKey]);

  // Switching INTO the own tab while parked on a range it can't serve
  // (90d/custom) clamps to 30d, matching the range picker's own disablement
  // rule — never a silent per-render fallback the picker itself disagrees with.
  const handleSourceChange = (next: AnalyticsSource) => {
    setSource(next);
    setRangeKeyState((current) => clampRangeForSource(current, next));
  };

  const windowResult = useMemo(
    () => resolveDateWindow(rangeKey, new Date(), rangeKey === 'custom' ? custom : undefined),
    [rangeKey, custom]
  );
  // A stable primitive the fetch effect can depend on — re-fires exactly
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

  // Own-tracker only ever asks the sink for a 7- or 30-day window; it rides
  // the same range picker rather than adding a second control. `rangeKey` is
  // already clamped to 7d/30d whenever `source === 'own'` (the picker
  // disables the rest, and `handleSourceChange` clamps on switch-in), so
  // this derivation never silently disagrees with what the picker shows.
  const ownDays: OwnTrackerDays = rangeKey === '7d' ? 7 : 30;
  // Only 7d/30d have an exact own-tracker counterpart; 90d/custom means the
  // two feeds are not looking at the same range, so captureRate() gets told
  // there is nothing to compare against.
  const netlifyRangeDays = rangeKey === '7d' ? 7 : rangeKey === '30d' ? 30 : null;
  const netlifyPageviews =
    netlifyOverview && netlifyOverview.configured && netlifyOverview.enabled && netlifyOverview.series
      ? netlifyOverview.series.totals.visits
      : null;

  const tabs: TabItem[] = [
    {
      id: 'own',
      label: 'Own tracker',
      content: (
        <OwnAnalyticsTab days={ownDays} netlifyPageviews={netlifyPageviews} netlifyRangeDays={netlifyRangeDays} />
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
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[length:var(--adm-text-xl)] font-semibold text-[var(--adm-text-heading)]">Analytics</h2>
          <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            Engagement, conversions, and producers across both tracking feeds.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <RangePicker
            rangeKey={rangeKey}
            source={source}
            custom={custom}
            onSelect={setRangeKeyState}
            onCustomChange={setCustom}
          />
          <CompareToggle source={source} />
        </div>
      </div>
      <Tabs tabs={tabs} value={source} onChange={(id) => handleSourceChange(id === 'netlify' ? 'netlify' : 'own')} />
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
