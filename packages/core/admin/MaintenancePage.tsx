/**
 * Maintenance (T9.24 reskin of /admin/blobs) — Owner-only blob browser,
 * store diagnostics, and wipe tools, on the AdminShell chrome. The server
 * 403s a non-owner on every admin-blob-manager / admin-blob-store-diagnostics
 * call (T9.4); this UI additionally hides for non-owners, the same posture
 * as AdminUsers.tsx.
 *
 * Human framing: the blob list shows a readable label (artifact metadata
 * when the store is "artifacts", the bare key otherwise) with the raw key
 * underneath, rather than a flat key dump. Raw JSON/text content lives
 * behind the viewer drawer's "Raw" tab — "Details" is the human-readable
 * default. Wipe actions are both typed-confirm (ConfirmDialog
 * requireTyped), matching the destructive-action convention the kit
 * documents (§3).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Button, Card, EmptyState, IconButton, Skeleton } from './primitives';
import { Input, Select, Textarea } from './forms';
import { ConfirmDialog, Drawer, useToast } from './overlays';
import { DataTable, type Column } from './data';
import { DropdownMenu, Tabs } from './menus';
import { IconDots, IconPlus, IconTrash, IconUser, IconWrench } from './icons';
import { fetchMe } from '@core/lib/admin/users-client';
import {
  deleteBlob,
  duplicateBlob,
  fetchDiagnostics,
  getArtifactMetadata,
  getBlob,
  listBlobs,
  listStores,
  normalizeSiteIdDiagnostic,
  renameBlob,
  setBlob,
  wipeAll,
  wipeStore,
  type BlobArtifactMetadata,
} from '@core/lib/admin/maintenance-client';
import { MAINTENANCE_PAGE_SIZES, paginateMaintenanceRows } from '@core/lib/admin/maintenance-pagination';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const ARTIFACT_METADATA_CONCURRENCY = 6;

interface BlobRow {
  key: string;
  metadata?: BlobArtifactMetadata;
}

type DrawerState = { mode: 'create' } | { mode: 'edit'; key: string } | null;

function DiagnosticsCard() {
  const [diagnostics, setDiagnostics] = useState<Awaited<ReturnType<typeof fetchDiagnostics>>['diagnostics'] | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { diagnostics } = await fetchDiagnostics(getToken);
        if (alive) setDiagnostics(diagnostics);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Diagnostics could not be loaded.');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-danger)]">{error}</p>;
  if (!diagnostics) return <Skeleton variant="rect" height={64} />;

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {Object.entries(diagnostics).map(([name, diag]) => {
        // `siteId` is a structured diagnostic ({envVar, present, redacted}),
        // not a string — normalize before rendering any of its fields so an
        // older server build (or a stale cached response) that still sends a
        // plain string renders too, instead of crashing (see
        // normalizeSiteIdDiagnostic's doc comment for the incident this
        // guards against).
        const siteId = normalizeSiteIdDiagnostic(diag.siteId);
        return (
          <div
            key={name}
            className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] p-3"
          >
            <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
              {diag.storeName}
            </p>
            <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">{diag.source}</p>
            <p className="mt-0.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              site id ({siteId.envVar ?? 'unset'}): {siteId.present ? siteId.redacted || '(redacted)' : 'not set'}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function MaintenanceBody() {
  const { toast } = useToast();
  const [owner, setOwner] = useState<boolean | null>(null);
  const [ownerCheckError, setOwnerCheckError] = useState<string | null>(null);

  const [stores, setStores] = useState<string[]>([]);
  const [store, setStore] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<BlobRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof MAINTENANCE_PAGE_SIZES)[number]>(50);
  const [listStatus, setListStatus] = useState('');
  const [loadingList, setLoadingList] = useState(false);

  const [drawerState, setDrawerState] = useState<DrawerState>(null);
  const [drawerTab, setDrawerTab] = useState('details');
  const [editorKey, setEditorKey] = useState('');
  const [editorContentType, setEditorContentType] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [editorMeta, setEditorMeta] = useState<BlobDetailMeta | null>(null);
  const [editorArtifact, setEditorArtifact] = useState<BlobArtifactMetadata | null>(null);
  const [editorStatus, setEditorStatus] = useState('');
  const [saving, setSaving] = useState(false);

  const [wipeStoreConfirm, setWipeStoreConfirm] = useState(false);
  const [wipeAllConfirm, setWipeAllConfirm] = useState(false);
  const [wiping, setWiping] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me = await fetchMe(getToken);
        if (alive) setOwner(me.roles.includes('owner'));
      } catch (err) {
        if (alive) setOwnerCheckError(err instanceof Error ? err.message : 'Could not verify access.');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const refreshBlobs = useCallback(
    async (activeStore: string) => {
      setPage(1);
      if (!activeStore) {
        setRows([]);
        setTotalCount(0);
        setTruncated(false);
        setListStatus('No blob stores exist for this site yet.');
        return;
      }
      setLoadingList(true);
      try {
        const result = await listBlobs(getToken, activeStore, search.trim());
        const keys = result.keys;
        setRows(keys.map((key) => ({ key })));
        setTotalCount(result.count);
        setTruncated(result.truncated);
        const truncatedNote = result.truncated ? ' This browser is limited to the first 10,000 matching objects.' : '';
        setListStatus(`${result.count} object${result.count === 1 ? '' : 's'} in "${activeStore}".${truncatedNote}`);
      } catch (err) {
        setListStatus(err instanceof Error ? err.message : 'Objects could not be loaded.');
        setRows([]);
        setTotalCount(0);
        setTruncated(false);
      } finally {
        setLoadingList(false);
      }
    },
    [search]
  );

  useEffect(() => {
    if (!owner) return;
    (async () => {
      try {
        const { stores } = await listStores(getToken);
        setStores(stores);
        const first = stores[0] ?? '';
        setStore(first);
      } catch (err) {
        setListStatus(err instanceof Error ? err.message : 'Blob stores could not be loaded.');
      }
    })();
  }, [owner]);

  useEffect(() => {
    if (!owner || !store) return;
    const timer = window.setTimeout(() => void refreshBlobs(store), 250);
    return () => window.clearTimeout(timer);
  }, [owner, refreshBlobs, store]);

  const pagination = useMemo(() => paginateMaintenanceRows(rows, page, pageSize), [page, pageSize, rows]);

  useEffect(() => {
    if (page !== pagination.page) setPage(pagination.page);
  }, [page, pagination.page]);

  useEffect(() => {
    if (store !== 'artifacts') return;

    const missingKeys = pagination.rows.filter((row) => !row.metadata).map((row) => row.key);
    if (!missingKeys.length) return;

    let active = true;
    const hydrateVisibleMetadata = async () => {
      for (let index = 0; index < missingKeys.length; index += ARTIFACT_METADATA_CONCURRENCY) {
        const batch = missingKeys.slice(index, index + ARTIFACT_METADATA_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (key) => {
            try {
              const { artifact } = await getArtifactMetadata(getToken, key);
              return { key, artifact };
            } catch {
              // Metadata is a nice-to-have; the bare key still renders.
              return null;
            }
          })
        );
        if (!active) return;
        const metadataByKey = new Map(
          results
            .filter((result): result is { key: string; artifact: BlobArtifactMetadata } => result !== null)
            .map((result) => [result.key, result.artifact])
        );
        if (metadataByKey.size) {
          setRows((previous) =>
            previous.map((row) => (metadataByKey.has(row.key) ? { ...row, metadata: metadataByKey.get(row.key) } : row))
          );
        }
      }
    };

    void hydrateVisibleMetadata();
    return () => {
      active = false;
    };
  }, [pagination.rows, store]);

  const openCreate = () => {
    setDrawerState({ mode: 'create' });
    setDrawerTab('details');
    setEditorKey('');
    setEditorContentType('');
    setEditorContent('');
    setEditorMeta(null);
    setEditorArtifact(null);
    setEditorStatus('');
  };

  const openEdit = async (key: string) => {
    setDrawerState({ mode: 'edit', key });
    setDrawerTab('details');
    setEditorKey(key);
    setEditorStatus('Loading…');
    setEditorMeta(null);
    setEditorArtifact(null);

    if (store === 'artifacts') {
      try {
        const { artifact } = await getArtifactMetadata(getToken, key);
        setEditorArtifact(artifact);
      } catch {
        // Metadata is a nice-to-have.
      }
    }

    try {
      const blob = await getBlob(getToken, store, key);
      setEditorContentType(blob.contentType ?? '');
      setEditorContent(blob.encoding === 'text' ? blob.content : '');
      setEditorMeta({ size: blob.size, encoding: blob.encoding, truncated: blob.truncated });
      setEditorStatus('');
    } catch (err) {
      setEditorStatus(err instanceof Error ? err.message : 'Blob could not be loaded.');
    }
  };

  const closeDrawer = () => setDrawerState(null);

  const saveBlob = async () => {
    const key = editorKey.trim();
    if (!key) {
      setEditorStatus('A key is required.');
      return;
    }
    setSaving(true);
    setEditorStatus('Saving…');
    try {
      await setBlob(getToken, { store, key, content: editorContent, contentType: editorContentType.trim() });
      toast({ title: 'Saved', tone: 'success' });
      closeDrawer();
      await refreshBlobs(store);
    } catch (err) {
      setEditorStatus(err instanceof Error ? err.message : 'Blob could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const onDuplicate = async (key: string) => {
    const targetKey = window.prompt(`Duplicate "${key}" to a new key:`, `${key}-copy`);
    if (!targetKey || targetKey.trim() === key) return;
    try {
      await duplicateBlob(getToken, store, key, targetKey.trim());
      toast({ title: 'Duplicated', tone: 'success' });
      await refreshBlobs(store);
    } catch (err) {
      toast({
        title: 'Could not duplicate',
        description: err instanceof Error ? err.message : undefined,
        tone: 'danger',
      });
    }
  };

  const onRename = async (key: string) => {
    const targetKey = window.prompt(`Rename "${key}" to:`, key);
    if (!targetKey || targetKey.trim() === key) return;
    try {
      await renameBlob(getToken, store, key, targetKey.trim());
      toast({ title: 'Renamed', tone: 'success' });
      await refreshBlobs(store);
    } catch (err) {
      toast({ title: 'Could not rename', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    }
  };

  const onDelete = async (key: string) => {
    if (!window.confirm(`Delete "${key}" from "${store}"? This cannot be undone.`)) return;
    try {
      await deleteBlob(getToken, store, key);
      toast({ title: 'Deleted', tone: 'success' });
      await refreshBlobs(store);
    } catch (err) {
      toast({ title: 'Could not delete', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    }
  };

  const doWipeStore = async () => {
    setWiping(true);
    try {
      const result = await wipeStore(getToken, store);
      toast({
        title: `Wiped ${result.deleted} object${result.deleted === 1 ? '' : 's'} from "${store}"`,
        tone: 'success',
      });
      setWipeStoreConfirm(false);
      await refreshBlobs(store);
    } catch (err) {
      toast({ title: 'Wipe failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setWiping(false);
    }
  };

  const doWipeAll = async () => {
    setWiping(true);
    try {
      const result = await wipeAll(getToken);
      toast({
        title: `Wiped ${result.totalDeleted} object${result.totalDeleted === 1 ? '' : 's'} across ${result.stores.length} store(s)`,
        tone: 'success',
      });
      setWipeAllConfirm(false);
      await refreshBlobs(store);
    } catch (err) {
      toast({ title: 'Wipe-all failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setWiping(false);
    }
  };

  const columns: Column<BlobRow>[] = useMemo(
    () => [
      {
        key: 'label',
        header: 'Object',
        sortable: true,
        accessor: (row) => row.metadata?.label ?? row.metadata?.originalFilename ?? row.key,
        render: (row) => {
          const label = row.metadata?.label ?? row.metadata?.originalFilename;
          return (
            <div className="min-w-0">
              {label ? (
                <>
                  <div className="truncate font-medium text-[var(--adm-text)]">{label}</div>
                  <div className="truncate font-mono text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                    {row.key}
                  </div>
                </>
              ) : (
                <div className="truncate font-mono text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
                  {row.key}
                </div>
              )}
              {row.metadata?.tags?.length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {row.metadata.tags.map((tag) => (
                    <Badge key={tag} tone="neutral">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        key: 'size',
        header: 'Size',
        align: 'right',
        accessor: (row) => row.metadata?.sizeBytes ?? 0,
        render: (row) => (
          <span className="text-[var(--adm-text-muted)]">
            {row.metadata?.sizeBytes ? formatBytes(row.metadata.sizeBytes) : '—'}
          </span>
        ),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        render: (row) => (
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => void openEdit(row.key)}>
              View
            </Button>
            <DropdownMenu
              align="end"
              trigger={({ ref, onToggle }) => (
                <IconButton
                  ref={ref}
                  label={`Actions for ${row.metadata?.label ?? row.metadata?.originalFilename ?? row.key}`}
                  icon={<IconDots size={18} />}
                  size="sm"
                  variant="secondary"
                  onClick={onToggle}
                />
              )}
              items={[
                { id: 'duplicate', label: 'Duplicate', onSelect: () => void onDuplicate(row.key) },
                { id: 'rename', label: 'Rename', onSelect: () => void onRename(row.key) },
                {
                  id: 'delete',
                  label: 'Delete',
                  icon: <IconTrash size={14} />,
                  tone: 'danger',
                  separatorBefore: true,
                  onSelect: () => void onDelete(row.key),
                },
              ]}
            />
          </div>
        ),
      },
    ],
    [onDelete, onDuplicate, onRename, openEdit]
  );

  if (owner === null && !ownerCheckError) return <Skeleton variant="rect" height={280} />;
  if (ownerCheckError) {
    return (
      <Card>
        <EmptyState severity="error" title="Couldn't verify access" message={ownerCheckError} />
      </Card>
    );
  }
  if (!owner) {
    return (
      <Card>
        <EmptyState
          icon={<IconUser size={26} />}
          title="Owner access required"
          message="Only Owners can use maintenance tools. Ask an Owner to change your role."
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Card kicker="Diagnostics" title="Blob store sources">
        <DiagnosticsCard />
      </Card>

      <Card kicker="Blob browser" title="Objects">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Select
            label="Store"
            value={store}
            onChange={(event) => {
              const next = event.target.value;
              setStore(next);
              setPage(1);
            }}
            options={stores.map((name) => ({ value: name, label: name }))}
          />
          <div className="min-w-[16rem] flex-1">
            <Input
              label="Search keys"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Filter by key substring…"
            />
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => void refreshBlobs(store)} loading={loadingList}>
              Refresh
            </Button>
            <Button leftIcon={<IconPlus size={16} />} onClick={openCreate}>
              New blob
            </Button>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{listStatus}</p>
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]" aria-live="polite">
            {pagination.endIndex === 0
              ? 'No objects to show'
              : `Showing ${pagination.startIndex + 1}–${pagination.endIndex} of ${rows.length}${truncated ? ` loaded (${totalCount} total)` : ''}`}
          </p>
        </div>

        <DataTable
          columns={columns}
          rows={[...pagination.rows]}
          getRowKey={(row) => row.key}
          emptyState={<EmptyState title="No objects" message="No blobs match the current store and search." />}
        />

        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <Select
            className="w-36"
            label="Rows per page"
            value={String(pageSize)}
            onChange={(event) => {
              setPageSize(Number(event.target.value) as (typeof MAINTENANCE_PAGE_SIZES)[number]);
              setPage(1);
            }}
            options={MAINTENANCE_PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
          />
          <div className="flex items-center gap-2" aria-label="Blob list pagination">
            <span className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
              Page {pagination.page} of {Math.max(1, pagination.pageCount)}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPage((current) => current - 1)}
              disabled={pagination.page <= 1}
              aria-label="Previous blob page"
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPage((current) => current + 1)}
              disabled={pagination.page >= pagination.pageCount}
              aria-label="Next blob page"
            >
              Next
            </Button>
          </div>
        </div>
      </Card>

      <Card
        kicker="Destructive actions"
        title="Danger zone"
        className="border-[var(--adm-danger)]/35 bg-[var(--adm-danger)]/5"
      >
        <p className="mb-3 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          Wiping deletes objects permanently and cannot be undone. "Wipe ALL stores" removes every object in every store
          for this site.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger"
            leftIcon={<IconTrash size={16} />}
            disabled={!store}
            onClick={() => setWipeStoreConfirm(true)}
          >
            Wipe this store
          </Button>
          <Button variant="danger" leftIcon={<IconWrench size={16} />} onClick={() => setWipeAllConfirm(true)}>
            Wipe ALL stores
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={wipeStoreConfirm}
        onClose={() => setWipeStoreConfirm(false)}
        onConfirm={() => void doWipeStore()}
        title={`Wipe "${store}"?`}
        message={`Delete every object in "${store}". This cannot be undone.`}
        confirmLabel={wiping ? 'Wiping…' : 'Wipe store'}
        tone="danger"
        requireTyped={store}
      />
      <ConfirmDialog
        open={wipeAllConfirm}
        onClose={() => setWipeAllConfirm(false)}
        onConfirm={() => void doWipeAll()}
        title="Wipe ALL stores?"
        message="Delete every object in every blob store for this site. This cannot be undone."
        confirmLabel={wiping ? 'Wiping…' : 'Wipe everything'}
        tone="danger"
        requireTyped="WIPE ALL"
      />

      <Drawer
        open={drawerState !== null}
        onClose={closeDrawer}
        title={drawerState?.mode === 'create' ? 'New blob' : 'Blob'}
        width={560}
        footer={
          <>
            <Button variant="primary" onClick={() => void saveBlob()} loading={saving}>
              Save
            </Button>
            <Button variant="secondary" onClick={closeDrawer}>
              Cancel
            </Button>
          </>
        }
      >
        <Input
          label="Key"
          value={editorKey}
          onChange={(event) => setEditorKey(event.target.value)}
          disabled={drawerState?.mode === 'edit'}
        />
        {drawerState?.mode === 'edit' ? (
          <Tabs
            className="mt-3"
            value={drawerTab}
            onChange={setDrawerTab}
            tabs={[
              {
                id: 'details',
                label: 'Details',
                content: (
                  <div className="flex flex-col gap-2 pt-3 text-[length:var(--adm-text-sm)]">
                    {editorArtifact ? (
                      <>
                        <p>
                          <span className="text-[var(--adm-text-muted)]">Label:</span>{' '}
                          {editorArtifact.label ?? editorArtifact.originalFilename ?? '—'}
                        </p>
                        {editorArtifact.tags?.length ? (
                          <div className="flex flex-wrap gap-1">
                            {editorArtifact.tags.map((tag) => (
                              <Badge key={tag} tone="neutral">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                        {editorArtifact.createdAtISO ? (
                          <p>
                            <span className="text-[var(--adm-text-muted)]">Created:</span>{' '}
                            {new Date(editorArtifact.createdAtISO).toLocaleString()}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                    <p>
                      <span className="text-[var(--adm-text-muted)]">Size:</span>{' '}
                      {editorMeta ? formatBytes(editorMeta.size) : '—'}
                    </p>
                    <p>
                      <span className="text-[var(--adm-text-muted)]">Encoding:</span> {editorMeta?.encoding ?? '—'}
                    </p>
                    {editorMeta?.truncated ? (
                      <p className="text-[var(--adm-warning)]">
                        Content is too large to preview inline — edit via the Raw tab is unavailable for this object.
                      </p>
                    ) : null}
                  </div>
                ),
              },
              {
                id: 'raw',
                label: 'Raw',
                content: (
                  <div className="flex flex-col gap-3 pt-3">
                    <Input
                      label="Content type (optional metadata)"
                      value={editorContentType}
                      onChange={(event) => setEditorContentType(event.target.value)}
                      placeholder="e.g. application/json"
                    />
                    <Textarea
                      label="Content"
                      rows={14}
                      spellCheck={false}
                      value={editorContent}
                      onChange={(event) => setEditorContent(event.target.value)}
                      disabled={editorMeta?.truncated}
                    />
                  </div>
                ),
              },
            ]}
          />
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            <Input
              label="Content type (optional metadata)"
              value={editorContentType}
              onChange={(event) => setEditorContentType(event.target.value)}
              placeholder="e.g. text/plain"
            />
            <Textarea
              label="Content"
              rows={14}
              spellCheck={false}
              value={editorContent}
              onChange={(event) => setEditorContent(event.target.value)}
            />
          </div>
        )}
        {editorStatus ? (
          <p className="mt-3 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{editorStatus}</p>
        ) : null}
      </Drawer>
    </div>
  );
}

interface BlobDetailMeta {
  size: number;
  encoding: 'text' | 'base64';
  truncated: boolean;
}

export interface MaintenancePageProps {
  identity: SiteIdentity;
}

export default function MaintenancePage({ identity }: MaintenancePageProps) {
  return (
    <AdminShell currentPath="/admin/maintenance" title="Maintenance" identity={identity}>
      <MaintenanceBody />
    </AdminShell>
  );
}
