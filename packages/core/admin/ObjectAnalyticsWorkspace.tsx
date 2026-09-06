/**
 * ObjectAnalyticsWorkspace (T21.30; runner R11.4) — the
 * `/admin/analytics/object/<objectId>` drill-down: engagement funnel,
 * per-node read-depth bars (the `node_strategy` join — a private,
 * admin-only vocabulary), traffic sources, the variant family, and who/what
 * produced the live revision, all over the SAME range picker as
 * `/admin/analytics` (D1: no parallel chart/ranking-card implementation —
 * this page renders through `KpiStrip`/`RangePicker`/`BarList`, the exact
 * components the main dashboard uses).
 *
 * Two independent reads, on purpose:
 *  - identity + producer (`fetchAnalyticsObjectIdentity`) is store-backed
 *    (the D6 export directory + the object's own publish receipt) and does
 *    not depend on the range picker or the tracking sink — it answers even
 *    before the sink has deployed anything;
 *  - the funnel/nodes/sources/variants come from the SAME
 *    `?source=own&object=<id>` request the main page's Pages/Engagement
 *    cards already use (D7's object filter), windowed by the range picker.
 *    `stats.object` is optional end to end (the sink may not have deployed
 *    it yet) — `resolveObjectDrilldownPanel`'s `sinkObjectAbsent` is what
 *    lets this page tell "not deployed yet" apart from "deployed, and this
 *    object has zero of something", so the two render distinctly named
 *    states rather than one generic empty panel.
 */
import { useEffect, useMemo, useState } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Breadcrumbs, Card, EmptyState, Skeleton } from './primitives';
import { BarList } from './AnalyticsCharts';
import { RangePicker, KpiStrip } from './AnalyticsWorkspace';
import { IconExternalLink, IconPencil } from './icons';
import {
  ANALYTICS_RANGE_OPTIONS,
  DEFAULT_ANALYTICS_RANGE,
  type AnalyticsRangeKey,
  type CustomRangeInput,
} from '@core/lib/admin/analytics-logic';
import {
  fetchAnalyticsObjectIdentity,
  fetchOwnAnalyticsOverview,
  type AnalyticsObjectIdentityResult,
} from '@core/lib/admin/own-analytics-client';
import { resolveObjectDrilldownPanel } from '@core/lib/admin/analytics-object-drilldown-logic';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

/** `''` during Astro's build-time SSR pass (no `window` yet — same guard `ObjectWorkspace.tsx`'s `parseLocation` uses); the real id resolves once React hydrates in the browser. */
function objectIdFromLocation(): string {
  if (typeof window === 'undefined') return '';
  return decodeURIComponent(window.location.pathname.split('/').filter(Boolean).at(-1) ?? '');
}

const DEFAULT_CUSTOM: CustomRangeInput = { from: '', to: '' };

function rangeLabelFor(key: AnalyticsRangeKey): string {
  return ANALYTICS_RANGE_OPTIONS.find((option) => option.key === key)?.label ?? key;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function WorkspaceBody({ identity: _identity }: { identity: SiteIdentity }) {
  const [objectId] = useState<string>(() => objectIdFromLocation());
  const [rangeKey, setRangeKey] = useState<AnalyticsRangeKey>(DEFAULT_ANALYTICS_RANGE);
  const [custom, setCustom] = useState<CustomRangeInput>(DEFAULT_CUSTOM);

  const [identityResult, setIdentityResult] = useState<AnalyticsObjectIdentityResult | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [configMessage, setConfigMessage] = useState<string | undefined>(undefined);
  const [objectDetail, setObjectDetail] = useState<
    import('@core/lib/admin/own-analytics-logic').OwnTrackerObjectDetail | null | undefined
  >(undefined);
  const [sourceRows, setSourceRows] = useState<
    import('@core/lib/admin/own-analytics-logic').OwnTrackerTopSource[] | undefined
  >(undefined);

  // Identity/producer — one shot, independent of the range picker.
  useEffect(() => {
    if (!objectId) return;
    let cancelled = false;
    fetchAnalyticsObjectIdentity(getToken, objectId)
      .then((result) => {
        if (!cancelled) setIdentityResult(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setIdentityError(err instanceof Error ? err.message : 'Could not load this object.');
      });
    return () => {
      cancelled = true;
    };
  }, [objectId]);

  // Sink data — the funnel/nodes/sources/variants block, re-fetched per range.
  useEffect(() => {
    if (!objectId) return;
    if (rangeKey === 'custom' && (!custom.from || !custom.to)) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchOwnAnalyticsOverview(getToken, {
      range: rangeKey,
      custom: rangeKey === 'custom' ? custom : undefined,
      filters: { object_id: objectId },
    })
      .then((overview) => {
        if (cancelled) return;
        setConfigured(overview.configured);
        setConfigMessage(overview.message);
        setObjectDetail(overview.stats?.object);
        setSourceRows(overview.stats?.top_sources);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Analytics could not be loaded.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [objectId, rangeKey, custom.from, custom.to]);

  const panel = useMemo(
    () =>
      resolveObjectDrilldownPanel({
        loading,
        error,
        identity: identityResult?.identity,
        producer: identityResult?.producer ?? undefined,
        objectDetail,
        sourceRows,
      }),
    [loading, error, identityResult, objectDetail, sourceRows]
  );

  const title = panel.identity?.title || objectId;
  const rangeLabel = rangeLabelFor(rangeKey);

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Breadcrumbs items={[{ label: 'Analytics', href: '/admin/analytics' }, { label: title }]} />
          <div className="flex flex-wrap items-center gap-2">
            <h1
              className="truncate text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]"
              title={title}
            >
              {title}
            </h1>
            {panel.identity ? (
              <Badge tone={panel.identity.found ? 'neutral' : 'warning'}>{panel.identity.objectType}</Badge>
            ) : null}
            {panel.identity && !panel.identity.found ? <Badge tone="warning">unresolved</Badge> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {panel.identity?.route ? (
              <a
                href={panel.identity.route}
                target="_blank"
                rel="noopener noreferrer"
                className="adm-focusable inline-flex items-center gap-1 hover:text-[var(--adm-text)]"
              >
                <IconExternalLink size={12} /> View live page
              </a>
            ) : null}
            <a
              href={`/admin/content/${encodeURIComponent(objectId)}`}
              className="adm-focusable inline-flex items-center gap-1 hover:text-[var(--adm-text)]"
            >
              <IconPencil size={12} /> Open in object workspace
            </a>
          </div>
        </div>
        <RangePicker rangeKey={rangeKey} custom={custom} onSelect={setRangeKey} onCustomChange={setCustom} />
      </div>

      <Card kicker="Producer" bodyClassName="flex flex-wrap gap-6">
        <div>
          <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">Surface</p>
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
            {identityError ? '—' : identityResult ? (panel.producer?.surface ?? 'Not recorded') : 'Loading…'}
          </p>
        </div>
        <div>
          <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">Prompt version</p>
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
            {identityError ? '—' : identityResult ? (panel.producer?.promptVersion ?? 'Not recorded') : 'Loading…'}
          </p>
        </div>
      </Card>

      {panel.status === 'loading' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Skeleton height={80} />
          <Skeleton height={80} />
          <Skeleton height={80} />
        </div>
      ) : panel.status === 'error' ? (
        <EmptyState severity="error" title="Analytics could not be loaded" message={panel.error} />
      ) : !configured ? (
        <EmptyState
          title="The own-tracker sink is not configured"
          message={configMessage ?? 'This site has no TRACKING_SINK_URL/TRACKING_PROJECT_ID set.'}
        />
      ) : panel.sinkObjectAbsent ? (
        <EmptyState
          title="Object-level detail is not available yet"
          message="This sink has not deployed the per-object stats block (funnel, node read-depth, variants) yet. Pageview-level totals for this object still show on the main Analytics page's Pages card."
        />
      ) : (
        <>
          <KpiStrip items={panel.kpis} rangeLabel={rangeLabel} />

          <Card kicker="Engagement funnel" title="Pageview → read → complete → CTA → buy">
            <BarList
              rows={panel.funnelBars}
              caption="Engagement funnel"
              emptyMessage="No funnel activity in this window."
            />
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card kicker="Node read-depth" title="By document position">
              <BarList
                rows={panel.nodeRows}
                caption="Node read-depth"
                emptyMessage="No node-level read data for this window."
              />
            </Card>
            <Card kicker="Sources" title="Traffic into this object">
              <BarList rows={panel.sourceRows} caption="Sources" emptyMessage="No source data for this window." />
            </Card>
          </div>

          <Card kicker="Variants" title="The variant family, by version">
            {panel.variants.length === 0 ? (
              <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">No variants recorded.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[length:var(--adm-text-sm)]">
                  <thead>
                    <tr className="text-[length:var(--adm-text-xs)] uppercase tracking-wide text-[var(--adm-text-muted)]">
                      <th className="py-1 pr-3">Version</th>
                      <th className="py-1 pr-3">Route</th>
                      <th className="py-1 pr-3">Published</th>
                      <th className="py-1 pr-3">Pageviews</th>
                      <th className="py-1 pr-3">Sessions</th>
                      <th className="py-1 pr-3">Completion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {panel.variants.map((variant) => (
                      <tr
                        key={`${variant.objectId}-${variant.version}`}
                        className="border-t border-[var(--adm-border)]"
                      >
                        <td className="py-1.5 pr-3 tabular-nums">v{variant.version}</td>
                        <td className="py-1.5 pr-3">
                          {variant.route ? (
                            <a
                              href={variant.route}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="adm-focusable hover:underline"
                            >
                              {variant.route}
                            </a>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-1.5 pr-3">{formatDate(variant.publishedAt)}</td>
                        <td className="py-1.5 pr-3 tabular-nums">{variant.pageviews ?? '—'}</td>
                        <td className="py-1.5 pr-3 tabular-nums">{variant.sessions ?? '—'}</td>
                        <td className="py-1.5 pr-3 tabular-nums">
                          {variant.completionRate !== undefined ? `${Math.round(variant.completionRate * 100)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

export interface ObjectAnalyticsWorkspaceProps {
  identity: SiteIdentity;
}

export default function ObjectAnalyticsWorkspace({ identity }: ObjectAnalyticsWorkspaceProps) {
  return (
    <AdminShell currentPath="/admin/analytics" title="Object analytics" identity={identity} wide>
      <WorkspaceBody identity={identity} />
    </AdminShell>
  );
}
