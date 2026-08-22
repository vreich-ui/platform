/**
 * `/admin/requests` (W19 T19.4) — the one place an editor sees every job.
 *
 * A row is a REQUEST, not a chat: the editorial job survives the conversation
 * that started it, and a job that stalled at node 19 shows here whether or not
 * anyone still has its chat open. Order is attention-first (plan §4.1) and is
 * decided server-side; this component never re-sorts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Button, Card, EmptyState, Skeleton, StatusPill } from './primitives';
import { Input, Select } from './forms';
import { useToast } from './overlays';
import { IconAlertTriangle, IconExternalLink, IconSparkles } from './icons';
import {
  archiveRequest,
  cancelRequest,
  listRequests,
  requestPollIntervalFor,
  requestStatusLabel,
  unarchiveRequest,
  type RequestKind,
  type RequestRowView,
  type RequestStatus,
} from '@core/lib/admin/requests-client';
import { progressPhrase, relativeAge, requestStatusTone } from '@core/lib/admin/request-logic';
import { useCurrentUser } from '@core/lib/admin/use-current-user';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

const KIND_LABELS: Record<RequestKind, string> = {
  article: 'Article',
  page: 'Page',
  section: 'Section',
  theme: 'Theme',
  media: 'Media',
  capture: 'Capture',
  other: 'Other',
};

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Everything active' },
  { value: 'needs_you', label: 'Needs you' },
  { value: 'stalled,failed', label: 'Stalled or failed' },
  { value: 'running,queued', label: 'Working' },
  { value: 'done', label: 'Done' },
];

/** A live row gets a spinner, not a dot — an editor must be able to tell "moving" from "parked" at a glance. */
function LiveDot({ status }: { status: RequestStatus }) {
  if (status !== 'running' && status !== 'queued') return null;
  return (
    <svg
      className="animate-spin text-[var(--adm-info-text)]"
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <span
      className="mt-1.5 block h-1 w-full max-w-[16rem] overflow-hidden rounded-[var(--adm-radius-pill)] bg-[var(--adm-surface-sunken)]"
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
    >
      <span
        className="block h-full rounded-[var(--adm-radius-pill)] bg-[var(--adm-accent)]"
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

function RequestRow({
  row,
  nowMs,
  canArchive,
  busy,
  onArchive,
  onCancel,
  selected,
}: {
  row: RequestRowView;
  nowMs: number;
  canArchive: boolean;
  busy: boolean;
  onArchive: (row: RequestRowView) => void;
  onCancel: (row: RequestRowView) => void;
  selected: boolean;
}) {
  const phrase = progressPhrase(row.progress, row.current_node);
  const unhappy = row.status === 'needs_you' || row.status === 'stalled' || row.status === 'failed';
  return (
    <li
      className={`border-b border-[var(--adm-border)] last:border-0 ${selected ? 'bg-[var(--adm-surface-sunken)]' : ''}`}
    >
      <div className="flex flex-wrap items-start gap-3 px-2 py-3">
        <a
          href={`/admin/requests/${encodeURIComponent(row.request_id)}`}
          className="adm-focusable min-w-0 flex-1 rounded-[var(--adm-radius-md)]"
        >
          <span className="flex flex-wrap items-center gap-2">
            <LiveDot status={row.status} />
            <span className="truncate text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">
              {row.title}
            </span>
            <StatusPill
              status={row.status}
              tone={requestStatusTone(row.status)}
              label={requestStatusLabel(row.status)}
            />
            <Badge tone="neutral">{KIND_LABELS[row.kind] ?? row.kind}</Badge>
          </span>
          <span className="mt-0.5 block text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {phrase ? <span>{phrase} · </span> : null}
            {row.created_by} · {relativeAge(row.updated_at, nowMs)}
          </span>
          {unhappy && row.status_reason ? (
            <span className="mt-1 flex items-start gap-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-warning-text)]">
              <IconAlertTriangle size={13} /> {row.status_reason}
            </span>
          ) : null}
          {row.progress && row.progress.total > 0 && (row.status === 'running' || row.status === 'queued') ? (
            <ProgressBar done={row.progress.done} total={row.progress.total} />
          ) : null}
        </a>
        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
          {row.chat_id ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => window.location.assign(`/admin/agents?chat=${encodeURIComponent(row.chat_id!)}`)}
            >
              Open chat
            </Button>
          ) : null}
          {row.object_id ? (
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<IconExternalLink size={14} />}
              onClick={() =>
                window.location.assign(`/admin/content/${encodeURIComponent(row.object_id!)}?type=content_item`)
              }
            >
              Article
            </Button>
          ) : null}
          {row.status !== 'done' && row.status !== 'cancelled' && !row.archived ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onCancel(row)}>
              Cancel
            </Button>
          ) : null}
          {canArchive ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onArchive(row)}>
              {row.archived ? 'Restore' : 'Archive'}
            </Button>
          ) : null}
        </span>
      </div>
    </li>
  );
}

const readParams = () =>
  typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);

export function RequestsBody({ selectedId }: { selectedId?: string }) {
  const { toast } = useToast();
  const user = useCurrentUser();
  const [rows, setRows] = useState<RequestRowView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [statusFilter, setStatusFilter] = useState(() => readParams().get('status') ?? '');
  const [kindFilter, setKindFilter] = useState(() => readParams().get('kind') ?? '');
  const [mine, setMine] = useState(() => readParams().get('mine') === '1');
  const [archived, setArchived] = useState(() => readParams().get('archived') === '1');
  const [query, setQuery] = useState(() => readParams().get('q') ?? '');
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  /**
   * A GENERATION counter, not a shared `live` flag. A filter change (every
   * keystroke in Search) tears down one effect and starts another; with one
   * shared flag the new effect immediately re-armed it, so a fetch still in
   * flight from the OLD closure passed the check, overwrote the list with
   * stale-filtered rows and scheduled its own timer — a zombie poll chain per
   * filter change, each clobbering the visible list forever.
   */
  const generationRef = useRef(0);

  const canArchive = user.roles.includes('owner') || user.roles.includes('publisher');

  // Filter state lives in the query string, so a filtered view is linkable.
  useEffect(() => {
    if (typeof window === 'undefined' || selectedId) return;
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (kindFilter) params.set('kind', kindFilter);
    if (mine) params.set('mine', '1');
    if (archived) params.set('archived', '1');
    if (query) params.set('q', query);
    const search = params.toString();
    window.history.replaceState({}, '', search ? `/admin/requests?${search}` : '/admin/requests');
  }, [statusFilter, kindFilter, mine, archived, query, selectedId]);

  const load = useCallback(
    async (generation: number) => {
      // Only the current generation may write state or schedule the next poll.
      const current = () => generationRef.current === generation;
      try {
        const result = await listRequests(getToken, {
          ...(statusFilter ? { status: statusFilter.split(',') as RequestStatus[] } : {}),
          ...(kindFilter ? { kind: [kindFilter] as RequestKind[] } : {}),
          ...(mine ? { mine: true } : {}),
          ...(archived ? { archived: true } : {}),
          ...(query.trim() ? { q: query.trim() } : {}),
        });
        if (!current()) return;
        setRows(result.requests);
        setTotal(result.total);
        setNowMs(Date.now());
        setError(undefined);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => void load(generation), requestPollIntervalFor(result.requests));
      } catch (loadError) {
        if (!current()) return;
        setRows((rowsNow) => rowsNow ?? []);
        setError(loadError instanceof Error ? loadError.message : 'Could not load requests.');
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => void load(generation), 20_000);
      }
    },
    [statusFilter, kindFilter, mine, archived, query]
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    void load(generation);
    return () => {
      // Bumping the generation retires this chain even if its fetch is still
      // in flight; the timer clear handles the idle case.
      generationRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [load]);

  // Polling pauses while the tab is hidden — nobody is reading it, and the
  // sweeper keeps the record true regardless.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // A hidden tab keeps its generation but schedules nothing; becoming
      // visible again resumes the SAME chain rather than starting a parallel
      // one. A fetch already in flight when the tab hides still resolves and
      // reschedules — one extra poll, not a second chain.
      if (document.visibilityState === 'visible') void load(generationRef.current);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [load]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: label, tone: 'success' });
      await load(generationRef.current);
    } catch (actionError) {
      toast({
        title: `${label} failed`,
        description: actionError instanceof Error ? actionError.message : undefined,
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  };

  const visible = useMemo(
    () => (selectedId ? (rows ?? []).filter((row) => row.request_id === selectedId) : (rows ?? [])),
    [rows, selectedId]
  );

  return (
    <div className="flex flex-col gap-4">
      <Card
        kicker="Requests"
        title={selectedId ? 'This request' : 'Everything in flight'}
        actions={
          selectedId ? (
            <Button size="sm" variant="secondary" onClick={() => window.location.assign('/admin/requests')}>
              All requests
            </Button>
          ) : (
            <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              {rows === null ? '' : `${total} ${total === 1 ? 'request' : 'requests'}`}
            </span>
          )
        }
      >
        {selectedId ? null : (
          <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Select
              label="Status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              options={STATUS_FILTERS}
            />
            <Select
              label="Kind"
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value)}
              options={[
                { value: '', label: 'Every kind' },
                ...Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
              ]}
            />
            <Input
              label="Search"
              value={query}
              placeholder="Title or request id"
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="flex items-end gap-3 pb-1">
              <label className="flex items-center gap-1.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} /> Mine
              </label>
              <label className="flex items-center gap-1.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                <input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />{' '}
                Archived
              </label>
            </div>
          </div>
        )}

        {error ? <p className="mb-2 text-[length:var(--adm-text-xs)] text-[var(--adm-danger)]">{error}</p> : null}

        {rows === null ? (
          <Skeleton variant="rect" height={160} />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<IconSparkles size={24} />}
            title={archived ? 'Nothing archived' : 'Nothing in flight'}
            message={
              archived
                ? 'Archived requests appear here once someone files them away.'
                : 'Ask the agent for an article and it will appear here while it is being written.'
            }
          />
        ) : (
          <ul className="flex flex-col">
            {visible.map((row) => (
              <RequestRow
                key={row.request_id}
                row={row}
                nowMs={nowMs}
                canArchive={canArchive}
                busy={busy}
                selected={row.request_id === selectedId}
                onArchive={(target) =>
                  void act(target.archived ? 'Restored' : 'Archived', () =>
                    target.archived
                      ? unarchiveRequest(getToken, target.request_id)
                      : archiveRequest(getToken, target.request_id)
                  )
                }
                onCancel={(target) => void act('Cancelled', () => cancelRequest(getToken, target.request_id))}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export interface RequestsWorkspaceProps {
  identity: SiteIdentity;
}

/**
 * `/admin/requests/<id>` is served by the `__request` placeholder page through
 * the netlify.toml rewrite (the T9.9 object-workspace pattern), so the id is
 * read from the URL here rather than passed as a prop.
 */
const requestIdFromPath = (): string | undefined => {
  if (typeof window === 'undefined') return undefined;
  const match = /^\/admin\/requests\/([^/?#]+)/.exec(window.location.pathname);
  const id = match?.[1];
  return id && id !== '__request' ? decodeURIComponent(id) : undefined;
};

export default function RequestsWorkspace({ identity }: RequestsWorkspaceProps) {
  const [selectedId] = useState(requestIdFromPath);
  return (
    <AdminShell currentPath="/admin/requests" title="Requests" identity={identity}>
      <RequestsBody {...(selectedId ? { selectedId } : {})} />
    </AdminShell>
  );
}
