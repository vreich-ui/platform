/**
 * ContentLibrary (T9.8) — the human-named browse surface. One inventory fetch,
 * client-side type filter + search + sort. Every object shows its display name
 * (T9.2), a type badge, a status pill, a readiness dot, and an
 * unpublished-changes pill — never a naked id (ids live in tooltips only).
 *
 * Rows link to the object workspace at /admin/content/<id> (T9.9). Landed
 * adjacent to T9.9 per the brief.
 */
import { useEffect, useMemo, useState } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { cn } from './utils';
import { Badge, StatusPill, Skeleton, EmptyState, Card } from './primitives';
import { Input } from './forms';
import { DataTable, type Column } from './data';
import { relativeTimeFromNow } from './logic';
import { IconLibrary, IconAlertTriangle, IconSparkles } from './icons';
import {
  filterRows,
  rowStatus,
  readinessDot,
  typeCounts,
  type LibraryRow,
  type ReadinessDot,
} from '@core/lib/admin/library-logic';
import { objectTypeLabel, idTooltip } from '@core/lib/admin/display-name';
import { EDITORIAL_STATE_PRESENTATION, type EditorialObjectState } from '@core/lib/admin/editorial-state';
import { fetchReleaseOverview } from '@core/lib/admin/release-client';
import type { ObjectType } from '@core/schema/object-record-v1';
// A pure, side-effect-free sync accessor (no network, no bundling cost worth
// deferring) — safe to import statically so the very first render can read
// whatever was cached, instead of racing a dynamic import against paint.
import { freshCachedInventoryRows } from '@core/lib/admin/library-client';
import { agentStarterHref } from '@core/lib/admin/agent-starters';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

const DOT_CLASS: Record<ReadinessDot, string> = {
  ready: 'bg-[var(--adm-success)]',
  attention: 'bg-[var(--adm-warning)]',
  idle: 'bg-[var(--adm-border-strong)]',
};
const DOT_LABEL: Record<ReadinessDot, string> = {
  ready: 'Ready — live and current',
  attention: 'Needs attention — in review or unpublished changes',
  idle: 'Draft — not published',
};

function LibraryTable({
  rows,
  now,
  states,
}: {
  rows: LibraryRow[];
  now: number;
  states: Record<string, EditorialObjectState>;
}) {
  const columns: Column<LibraryRow>[] = [
    {
      key: 'display_name',
      header: 'Name',
      sortable: true,
      accessor: (r) => r.display_name,
      render: (r) => {
        const dot = readinessDot(r);
        return (
          <a
            href={`/admin/content/${encodeURIComponent(r.object_id)}?type=${r.object_type}`}
            className="adm-focusable group flex items-center gap-2.5 rounded"
          >
            <span
              className={cn('h-2 w-2 shrink-0 rounded-full', DOT_CLASS[dot])}
              title={DOT_LABEL[dot]}
              aria-label={DOT_LABEL[dot]}
            />
            <span className="min-w-0">
              <span
                className="block truncate font-medium text-[var(--adm-text)] group-hover:text-[var(--adm-accent)]"
                title={idTooltip(r.object_id)}
              >
                {r.display_name}
              </span>
            </span>
          </a>
        );
      },
    },
    {
      key: 'object_type',
      header: 'Type',
      sortable: true,
      accessor: (r) => objectTypeLabel(r.object_type),
      render: (r) => <Badge>{objectTypeLabel(r.object_type)}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const status = states[r.object_id] ? EDITORIAL_STATE_PRESENTATION[states[r.object_id]] : rowStatus(r);
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusPill status={status.label} tone={status.tone} label={status.label} />
            {r.unpublished_changes && r.published_time ? (
              <StatusPill status="draft changes" tone="warning" label="Draft changes" />
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'updated_at',
      header: 'Updated',
      sortable: true,
      align: 'right',
      accessor: (r) => r.updated_at,
      render: (r) => (
        <span className="text-[var(--adm-text-muted)]" title={r.updated_at}>
          {relativeTimeFromNow(r.updated_at, now) || '—'}
        </span>
      ),
    },
  ];
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.object_id} />;
}

function ContentLibraryBody() {
  // SSR and the browser must begin from the same tree. Browser storage is
  // consulted only after hydration, then used as stale-while-revalidate data.
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<ObjectType | 'all'>('all');
  const [query, setQuery] = useState('');
  const [now, setNow] = useState<number>(0);
  const [states, setStates] = useState<Record<string, EditorialObjectState>>({});

  useEffect(() => {
    setNow(Date.now());
    const cachedRows = freshCachedInventoryRows();
    if (cachedRows) {
      setRows(cachedRows);
      setLoading(false);
      setRefreshing(true);
    }
    let alive = true;
    (async () => {
      try {
        const { fetchInventoryRows } = await import('@core/lib/admin/library-client');
        // Never force here — a fresh in-memory/TTL cache (e.g. populated by
        // this very call a moment ago on a fast re-mount, or by the palette)
        // is reused instead of firing a second network sweep.
        const fetched = await fetchInventoryRows(getToken);
        if (alive) {
          setRows(fetched);
          setLoading(false);
          setRefreshing(false);
        }
      } catch (err) {
        if (alive) {
          // If we already have cached rows on screen, a failed background
          // refresh shouldn't blow away a working view — just stop spinning.
          if (cachedRows !== null) {
            setRefreshing(false);
          } else {
            setError(err instanceof Error ? err.message : 'Could not load the content library.');
            setLoading(false);
          }
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetchReleaseOverview(getToken)
      .then((overview) => {
        if (alive) {
          setStates(Object.fromEntries(overview.objects.map((object) => [object.object_id, object.state])));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const counts = useMemo(() => typeCounts(rows), [rows]);
  const filtered = useMemo(() => filterRows(rows, { type, query }), [rows, type, query]);

  const typeChips: Array<{ value: ObjectType | 'all'; label: string; count: number }> = [
    { value: 'all', label: 'All', count: rows.length },
    ...(Object.keys(counts) as ObjectType[])
      .sort()
      .map((t) => ({ value: t, label: objectTypeLabel(t), count: counts[t] })),
  ];

  // Only the true first-load (nothing cached to show yet) gets the big
  // blocking skeleton — a cached render shows rows immediately and the
  // small inline "refreshing…" indicator below instead (stale-while-revalidate).
  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton variant="rect" height={40} width="40%" />
        <Skeleton variant="rect" height={200} />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <EmptyState icon={<IconAlertTriangle size={26} />} title="Couldn't load the library" message={error} />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {refreshing ? (
        <p
          className="flex items-center gap-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]"
          role="status"
          aria-live="polite"
        >
          <span className="inline-block animate-pulse">●</span> Refreshing…
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {typeChips.map((chip) => {
          const active = type === chip.value;
          return (
            <button
              key={chip.value}
              type="button"
              onClick={() => setType(chip.value)}
              aria-pressed={active}
              className={cn(
                'adm-focusable inline-flex items-center gap-1.5 rounded-[var(--adm-radius-pill)] border px-3 py-1 text-[length:var(--adm-text-sm)] font-medium transition-colors',
                active
                  ? 'border-transparent bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]'
                  : 'border-[var(--adm-border-strong)] text-[var(--adm-text-muted)] hover:bg-[var(--adm-surface-sunken)]'
              )}
            >
              {chip.label}
              <span className="text-[length:var(--adm-text-xs)] opacity-70">{chip.count}</span>
            </button>
          );
        })}
      </div>

      <div className="max-w-sm">
        <Input
          placeholder="Search by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search content"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<IconLibrary size={26} />}
          title={rows.length === 0 ? 'No objects yet' : 'No matches'}
          message={rows.length === 0 ? 'Objects you create will appear here.' : 'Try a different type or search term.'}
        />
      ) : (
        <>
          <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {filtered.length} {filtered.length === 1 ? 'object' : 'objects'}
          </p>
          <LibraryTable rows={filtered} now={now} states={states} />
        </>
      )}
    </div>
  );
}

export interface ContentLibraryProps {
  identity: SiteIdentity;
}

export default function ContentLibrary({ identity }: ContentLibraryProps) {
  return (
    <AdminShell currentPath="/admin/content" title="Content library" identity={identity}>
      <div className="flex flex-col gap-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[length:var(--adm-text-2xl)] font-semibold text-[var(--adm-text-heading)]">Content</h1>
            <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
              Find governed objects or start a new draft with the CMS Agent.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={agentStarterHref('article')}
              className="adm-focusable inline-flex h-10 items-center gap-2 rounded-[var(--adm-radius-md)] border border-transparent bg-[var(--adm-accent)] px-4 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-on-accent)] hover:bg-[var(--adm-accent-hover)]"
            >
              <IconSparkles size={16} /> New article
            </a>
            <a
              href={agentStarterHref('page')}
              className="adm-focusable inline-flex h-10 items-center rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] bg-[var(--adm-surface-raised)] px-4 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]"
            >
              New page
            </a>
          </div>
        </header>
        <ContentLibraryBody />
      </div>
    </AdminShell>
  );
}
