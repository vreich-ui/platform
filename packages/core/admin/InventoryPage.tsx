/**
 * Admin Inventory (T4) — one owner/admin surface that finds every object
 * across all three collections (governed objects, artifacts, system store
 * blobs), previews it, and acts on it singly or in bulk.
 *
 * WHAT THIS FILE IS ALLOWED TO DECIDE: nothing. Every rule lives in a tested
 * pure module and is imported here —
 *   - `lib/admin/inventory-logic.ts`      facet counts, `allowedActions`,
 *                                         `bulkActionsFor` (the intersection
 *                                         the bulk toolbar shows), preview
 *                                         summaries per store kind;
 *   - `lib/admin/inventory-preview.ts`    which renderer a hit gets, the byte
 *                                         endpoints, whether a trimmed
 *                                         payload can be summarized, and the
 *                                         client mirror of the server's role
 *                                         gate;
 *   - `lib/admin/bulk-selection.ts`       checkbox state;
 *   - `lib/admin/bulk-object-ops.ts` /
 *     `lib/admin/bulk-artifact-ops.ts`    the bounded fan-out and its
 *                                         per-item `{ok, failed}` result.
 * `packages/core/admin/**` is excluded from `tsconfig.test.json`, so anything
 * decided in this file is decided where no test can see it. That is the whole
 * reason the split exists.
 *
 * HOOK ORDER. Every hook in `InventoryBody` sits in one contiguous block
 * ABOVE the first `return`. The access check, the loading state and the
 * error state are early returns, and an early return above a hook is what
 * throws "Rendered more hooks than during the previous render" and unmounts
 * the page. `eslint`'s `react-hooks/rules-of-hooks` is an error in this repo
 * for exactly this file's failure mode; do not move a hook below the block.
 *
 * THE GOVERNING RULE (BRIEF.md, Wave 2): the UI never claims a state it
 * cannot prove.
 *   - Every mutation is followed by a fresh `search` before the table
 *     changes: nothing renders as deleted or retagged until the server has
 *     said so. There is no optimistic row update anywhere in this file.
 *   - Previews are fetched on demand (opening the drawer, or a row thumbnail
 *     that actually issues its own authenticated request) — never inferred
 *     from a row's metadata.
 *   - A refused or failed item is reported with the server's own reason, per
 *     item, in the result dialog.
 *   - The System-health card says "Owner access required" to an admin rather
 *     than showing an empty grid: `admin-blob-store-diagnostics` is
 *     owner-only, so an admin has no diagnostics to show, and the card says
 *     that instead of implying there are none.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { AdminShell } from './AdminShell';
import { AgentRail } from './AgentRail';
import { useChat } from './chat';
import { InventoryQuickActionChips } from './QuickActions';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Button, Card, EmptyState, IconButton, Skeleton, StatusPill } from './primitives';
import { Input, Textarea } from './forms';
import { ConfirmDialog, Dialog, Drawer, useToast } from './overlays';
import { DataTable, type Column } from './data';
import { DropdownMenu, type MenuItem } from './menus';
import {
  IconArchive,
  IconBookmark,
  IconChartBar,
  IconCheck,
  IconDots,
  IconDownload,
  IconExternalLink,
  IconFilePlus,
  IconHome,
  IconInfo,
  IconLayoutGrid,
  IconLayoutList,
  IconMenu,
  IconMic,
  IconNote,
  IconPalette,
  IconRobot,
  IconSettings,
  IconSparkles,
  IconTag,
  IconTrash,
  IconUser,
  type IconProps,
} from './icons';
import { ARTIFACT_PREVIEW_THUMBNAIL_WIDTH } from './ArtifactStagePreview';
import { fetchMe } from '@core/lib/admin/users-client';
import { createFreeChat } from '@core/lib/admin/chat-client';
import {
  browserDockedChatStorage,
  clearDockedChatId,
  dockedChatStorageKey,
  readDockedChatId,
  writeDockedChatId,
} from '@core/lib/admin/docked-chat-session';
import {
  buildInventoryChatPrompt,
  INVENTORY_CHAT_SELECTION_CAP,
  type InventoryChatSelectionItem,
} from '@core/lib/admin/inventory-chat';
import {
  deleteArtifact,
  previewInventoryHit,
  retagArtifact,
  searchInventory,
  type PreviewResult,
  type SearchResult,
} from '@core/lib/admin/inventory-client';
import {
  parseObjectHitId,
  parseStoreHitId,
  type InventoryCollection,
  type InventoryHit,
} from '@core/lib/admin/inventory-server-logic';
import {
  allowedActions,
  bulkActionsFor,
  facetCounts,
  previewSummary,
  type ActionId,
  type PreviewField,
  type Role,
} from '@core/lib/admin/inventory-logic';
import {
  canUseInventory,
  inventoryDownloadFilename,
  inventoryPreviewPlan,
  inventoryTypeVisual,
  parseInventoryPreviewJson,
  previewStoreName,
  toInventoryRoles,
  type InventoryPreviewPlan,
  type InventoryTypeIconId,
} from '@core/lib/admin/inventory-preview';
import {
  describeInventorySelection,
  INVENTORY_COLLECTION_LABELS as COLLECTION_LABELS,
} from '@core/lib/admin/inventory-selection';
import {
  clearSelection,
  emptySelection,
  isAllSelected,
  isSelected,
  isSomeSelected,
  pruneSelection,
  selectAll,
  selectionCount,
  toggleSelectAll,
  toggleSelection,
  type SelectionState,
} from '@core/lib/admin/bulk-selection';
import { bulkDeleteArtifacts, bulkRetagArtifacts } from '@core/lib/admin/bulk-artifact-ops';
import { bulkArchiveObjects, bulkValidateObjects, type VerbCaller } from '@core/lib/admin/bulk-object-ops';
import { ArtifactPreviewFetchError, createArtifactPreviewLoader } from '@core/lib/admin/artifact-preview-loader';
import { describeArtifactPreviewError } from '@core/lib/admin/artifact-preview-error';
import { objectWorkspaceHref } from '@core/lib/admin/request-logic';
import { deleteBlob, fetchDiagnostics, normalizeSiteIdDiagnostic, wipeAll, wipeStore } from '@core/lib/admin/maintenance-client';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

const makeCallVerb = async (): Promise<VerbCaller> => {
  const { callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
  return (body) => callObjectVerb(getToken, body);
};

/**
 * One loader for the whole page: shared object-URL cache and a shared
 * concurrency bound, so a table of image rows never fires more than
 * `DEFAULT_CONCURRENCY_LIMIT` authenticated byte fetches at once. See
 * `artifact-preview-loader.ts` for the retry/timeout/queue policy and its
 * `node:test` coverage.
 */
const previewLoader = createArtifactPreviewLoader();

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 50;

/**
 * One free chat, reused for every "Send to chat" on this page for the length
 * of the tab's session, so a reload does not orphan the conversation the
 * editor was just seeding.
 *
 * The id is cached through `docked-chat-session.ts` rather than by touching
 * `sessionStorage` directly, because that module exists to fix a REPORTED
 * DEFECT this page would otherwise have reproduced exactly: a cached id that
 * is never cleared makes the first conversation the only one the surface can
 * ever reach — when it dies server-side (a provider error, a chat deleted, a
 * different person signing in on the same tab, since `sessionStorage` outlives
 * a logout and `get_chat` has no per-user gate) every reload re-attaches to
 * the dead thread with no way out. The scope segment keys the cache per SITE
 * (`<scope>:<siteId>`), and "New chat" below clears it.
 */
const INVENTORY_CHAT_SCOPE = 'inventory-chat';

const formatBytes = (bytes: number | null): string => {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

/** A timestamp the row can prove. `null` from the server means "this listing carried none" — say so. */
const formatUpdated = (value: string | null): string => {
  if (!value) return 'unknown';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() ? error.message : fallback;

// ─── bulk result model ──────────────────────────────────────────────────────

interface BulkOk {
  id: string;
  detail?: string;
}
interface BulkFailure {
  id: string;
  reason: string;
}
interface BulkReport {
  title: string;
  ok: BulkOk[];
  failed: BulkFailure[];
}

interface PendingConfirm {
  action: Extract<ActionId, 'archive' | 'delete' | 'delete-blob'>;
  hits: InventoryHit[];
}

interface PendingTag {
  action: Extract<ActionId, 'add-tag' | 'remove-tag'>;
  hits: InventoryHit[];
}

/** "Send to chat" (single row or bulk) — the free-text intent is collected
 *  in the dialog this pends, then `inventory-chat.ts` builds the prompt. */
interface PendingChatHandoff {
  hits: InventoryHit[];
}

/**
 * The two STORE-WIDE owner verbs (`inventory-logic.ts`'s `STORE_WIDE_ACTIONS`).
 * They are pended separately from `PendingConfirm` because their subject is a
 * store, not a set of rows, and because their typed phrase is dynamic: wiping
 * one store demands that store's own name typed back, exactly as the retired
 * Maintenance danger zone did. `admin-blob-manager` gates BOTH to `isOwner`
 * server-side; this state only ever exists for an owner.
 */
type PendingWipe = { kind: 'store'; store: string } | { kind: 'all' };

/** Typed-confirm phrase per destructive action (BRIEF: every destructive single OR bulk action). */
const CONFIRM_PHRASE: Record<PendingConfirm['action'], string> = {
  archive: 'ARCHIVE',
  delete: 'DELETE',
  'delete-blob': 'DELETE BLOB',
};

const CONFIRM_TITLE: Record<PendingConfirm['action'], string> = {
  archive: 'Archive',
  delete: 'Delete artifact',
  'delete-blob': 'Delete store blob',
};

/**
 * What each destructive verb ACTUALLY does to the bytes — said before the
 * human types the phrase, not after (BRIEF: the UI never claims a state it
 * cannot prove, and "Delete" claims more than the server does).
 *
 * `delete` is a SOFT delete and always has been: `admin-inventory`'s
 * `delete-artifact` stamps `deletedAtISO`/`deletedBy` on the artifact-index
 * reference and leaves the bytes in the `artifacts` store, which is the
 * platform's only artifact-delete primitive (see `artifact-trust.ts`, which
 * reads `deletedAtISO` as soft-deleted). The row stays in Inventory
 * afterwards with a `deleted` status, which is how it gets found again.
 * `delete-blob` and `archive`, by contrast, really are what they say.
 */
const CONFIRM_EFFECT: Record<PendingConfirm['action'], string> = {
  archive: 'Archiving retires the object; it stays readable and can be found under the archived status.',
  delete:
    'This is a SOFT delete: the artifact is marked deleted in the index and its bytes are kept, so the row stays listed with a "deleted" status and the file can be recovered. It is not erased from storage.',
  'delete-blob': 'The blob is removed from its store. This is a raw store delete and cannot be undone.',
};

// ─── selection checkbox (native input, indeterminate set imperatively) ──────

function RowCheckbox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className="adm-focusable h-4 w-4 cursor-pointer accent-[var(--adm-accent)]"
    />
  );
}

// ─── byte previews (image / pdf), fetched on demand ─────────────────────────

function BytesPreview({
  endpoint,
  cacheKey,
  mode,
  label,
}: {
  endpoint: string;
  cacheKey: string;
  mode: 'image' | 'pdf';
  label: string;
}) {
  const [source, setSource] = useState<string>();
  /** `undefined` = not failed; `null` = failed with no status (timeout / dropped connection). */
  const [errorStatus, setErrorStatus] = useState<number | null>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setSource(undefined);
    setErrorStatus(undefined);
    (async () => {
      try {
        const token = await getToken();
        const objectUrl = await previewLoader.load(cacheKey, endpoint, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (alive) setSource(objectUrl);
      } catch (error) {
        if (!alive) return;
        setErrorStatus(error instanceof ArtifactPreviewFetchError && error.status !== undefined ? error.status : null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [cacheKey, endpoint, attempt]);

  if (errorStatus !== undefined) {
    const view = describeArtifactPreviewError(errorStatus ?? undefined);
    return (
      <EmptyState
        severity="error"
        title={view.title}
        message={view.message}
        {...(view.canRetry
          ? {
              action: (
                <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
                  Try preview again
                </Button>
              ),
            }
          : {})}
      />
    );
  }

  if (!source) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-live="polite">
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          Fetching {mode === 'pdf' ? 'document' : 'image'} bytes…
        </p>
        <Skeleton variant="rect" height={mode === 'pdf' ? 480 : 320} />
      </div>
    );
  }

  if (mode === 'pdf') {
    return (
      <iframe
        src={source}
        title={label}
        className="h-[min(60dvh,44rem)] w-full rounded-[var(--adm-radius-md)] border-0 bg-white"
      />
    );
  }

  return (
    <div className="grid min-h-[16rem] place-items-center">
      <img src={source} alt={label} className="max-h-[60dvh] max-w-full object-contain" />
    </div>
  );
}

/**
 * The icon behind each `InventoryTypeIconId`. The ids are chosen in
 * `inventory-preview.ts` (pure, tested); this table is the only place they
 * become artwork, and every entry is an icon the admin kit already ships —
 * no new icon set, no image dependency.
 */
const TYPE_ICONS: Record<InventoryTypeIconId, (props: IconProps) => ReactNode> = {
  note: IconNote,
  'layout-list': IconLayoutList,
  'layout-grid': IconLayoutGrid,
  'file-plus': IconFilePlus,
  menu: IconMenu,
  tag: IconTag,
  home: IconHome,
  palette: IconPalette,
  archive: IconArchive,
  'chart-bar': IconChartBar,
  mic: IconMic,
  sparkles: IconSparkles,
  bookmark: IconBookmark,
  settings: IconSettings,
  info: IconInfo,
};

/**
 * A row with no bytes of its own: the icon for what it IS, plus that in
 * words. Never blank, and never a stand-in picture — the frame is obviously
 * an icon tile, so it cannot be misread as a thumbnail of the item.
 */
function InventoryTypeThumb({ iconId, label }: { iconId: InventoryTypeIconId; label: string }) {
  const Icon = TYPE_ICONS[iconId];
  return (
    <div className="flex items-center gap-2">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--adm-radius-sm)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] text-[var(--adm-text-muted)]">
        <Icon size={18} title={label} />
      </div>
      <span className="whitespace-nowrap text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{label}</span>
    </div>
  );
}

/**
 * The row's preview cell. A row with provable image bytes issues its own
 * authenticated, width-bounded request through the shared queue + cache —
 * artifacts from their own `previewRef`, objects from the `thumbnailRef` the
 * server joined for them (see `inventory-server-logic.ts`'s requestId join),
 * both through the SAME loader and the same `admin-get-blob-image` endpoint.
 *
 * Everything else — a PDF, whose first page nothing in the browser can
 * rasterize; an object with no image under its request; a store blob — gets
 * the type visual. A thumbnail that fails to fetch degrades to that same
 * visual, never to an error state and never to a spinner that never
 * resolves.
 */
function InventoryThumb({ hit, plan }: { hit: InventoryHit; plan: InventoryPreviewPlan }) {
  const thumbEndpoint = plan.mode === 'image' ? `${plan.endpoint}&w=${ARTIFACT_PREVIEW_THUMBNAIL_WIDTH}` : '';
  const cacheKey = plan.mode === 'image' ? `${plan.cacheKey}#w=${ARTIFACT_PREVIEW_THUMBNAIL_WIDTH}` : '';
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!thumbEndpoint) return;
    let alive = true;
    setSource(undefined);
    setFailed(false);
    (async () => {
      try {
        const token = await getToken();
        const objectUrl = await previewLoader.load(cacheKey, thumbEndpoint, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (alive) setSource(objectUrl);
      } catch {
        // A thumbnail that cannot be fetched degrades to the type chip — it
        // never becomes an error state for the row, and never a placeholder
        // image pretending to be the artifact.
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [cacheKey, thumbEndpoint]);

  if (plan.mode === 'image' && !failed) {
    return source ? (
      <img
        src={source}
        alt=""
        className="h-10 w-10 rounded-[var(--adm-radius-sm)] border border-[var(--adm-border)] object-cover"
      />
    ) : (
      <Skeleton variant="rect" width={40} height={40} />
    );
  }

  // A PDF artifact says PDF; everything else says what it is.
  const visual = plan.mode === 'pdf' ? { iconId: 'note' as InventoryTypeIconId, label: 'PDF' } : inventoryTypeVisual(hit);
  return <InventoryTypeThumb iconId={visual.iconId} label={visual.label} />;
}

// ─── system health (collapsed, on demand, owner-only endpoint) ──────────────

type DiagnosticsMap = Awaited<ReturnType<typeof fetchDiagnostics>>['diagnostics'];

function DiagnosticsGrid({ diagnostics }: { diagnostics: DiagnosticsMap }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {Object.entries(diagnostics).map(([name, diag]) => {
        // `siteId` is a structured diagnostic, not a string — normalize before
        // reading any field, the same guard MaintenancePage carries.
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

// ─── facet rail ─────────────────────────────────────────────────────────────

interface FacetSelection {
  collection: string | null;
  kind: string | null;
  status: string | null;
}

const EMPTY_FACETS: FacetSelection = { collection: null, kind: null, status: null };

function FacetGroup({
  title,
  counts,
  active,
  onToggle,
  labelFor,
}: {
  title: string;
  counts: Record<string, number>;
  active: string | null;
  onToggle: (value: string) => void;
  labelFor?: (value: string) => string;
}) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([value, count]) => {
          const selected = active === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={selected}
              onClick={() => onToggle(value)}
              className={`adm-focusable inline-flex items-center gap-1.5 rounded-[var(--adm-radius-pill)] border px-2.5 py-1 text-[length:var(--adm-text-xs)] ${
                selected
                  ? 'border-[var(--adm-accent)] bg-[var(--adm-accent)]/10 text-[var(--adm-text)]'
                  : 'border-[var(--adm-border)] text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]'
              }`}
            >
              <span>{labelFor ? labelFor(value) : value}</span>
              <span className="text-[var(--adm-text-muted)]">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── the page body ──────────────────────────────────────────────────────────

function InventoryBody({ siteId }: { siteId: string }) {
  // ── HOOKS — every one of them, before any early return. ──────────────────
  const { toast } = useToast();

  const [roleNames, setRoleNames] = useState<string[] | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);

  const [queryText, setQueryText] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [hits, setHits] = useState<InventoryHit[]>([]);
  const [meta, setMeta] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [facet, setFacet] = useState<FacetSelection>(EMPTY_FACETS);
  const [selection, setSelection] = useState<SelectionState>(emptySelection());

  const [inspected, setInspected] = useState<InventoryHit | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [confirming, setConfirming] = useState<PendingConfirm | null>(null);
  const [tagPrompt, setTagPrompt] = useState<PendingTag | null>(null);
  const [tagValue, setTagValue] = useState('');
  const [report, setReport] = useState<BulkReport | null>(null);
  const [busy, setBusy] = useState(false);

  // "Send to chat" (T5) — a free chat this page seeds, never sends into on
  // its own. `chatId` stays `undefined` until the first hand-off, so the
  // rail below renders nothing for a page load that never uses it.
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  const [chatOpen, setChatOpen] = useState(false);
  const [composerSeed, setComposerSeed] = useState<{ key: string; text: string } | undefined>(undefined);
  const [chatHandoff, setChatHandoff] = useState<PendingChatHandoff | null>(null);
  const [chatIntent, setChatIntent] = useState('');
  const chat = useChat(getToken, chatId);

  const [wiping, setWiping] = useState<PendingWipe | null>(null);
  const [healthOpen, setHealthOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsMap | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);

  const roles = useMemo<Role[]>(() => toInventoryRoles(roleNames ?? []), [roleNames]);
  const hasAccess = canUseInventory(roles);
  const isOwnerRole = roles.includes('owner');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me = await fetchMe(getToken);
        if (alive) setRoleNames(me.roles ?? []);
      } catch (error) {
        if (alive) setAccessError(errorText(error, 'Could not verify access.'));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setActiveQuery(queryText.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [queryText]);

  /**
   * Reads a page from the server. `cursor` appends the next keyset page;
   * without one this REPLACES the table, which is also what every mutation
   * calls to prove the new state before the UI shows it.
   */
  const runSearch = useCallback(
    async (cursor?: string) => {
      setSearching(true);
      setSearchError(null);
      try {
        const result = await searchInventory(getToken, {
          query: activeQuery,
          limit: PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        // A follow-up page only sweeps the collections its cursor still names
        // (the server skips the exhausted ones rather than re-serving them),
        // so its `counts`/`truncated` cover only those. Carry the earlier
        // entries forward for the collections this page did not report — they
        // were proved by the response that issued this cursor, and a
        // collection missing from a later page is exhausted, not unknown.
        // Without this the "Server matched …" line silently drops a
        // collection on "Load more".
        setMeta((previous) =>
          cursor && previous
            ? {
                ...result,
                counts: { ...previous.counts, ...result.counts },
                truncated: { ...previous.truncated, ...result.truncated },
              }
            : result
        );
        setHits((previous) => {
          if (!cursor) return result.hits;
          const seen = new Set(previous.map((hit) => hit.id));
          return [...previous, ...result.hits.filter((hit) => !seen.has(hit.id))];
        });
      } catch (error) {
        setSearchError(errorText(error, 'Inventory could not be searched.'));
        if (!cursor) {
          setHits([]);
          setMeta(null);
        }
      } finally {
        setSearching(false);
      }
    },
    [activeQuery]
  );

  useEffect(() => {
    if (!hasAccess) return;
    void runSearch();
  }, [hasAccess, runSearch]);

  const facets = useMemo(() => facetCounts(hits), [hits]);

  const visibleHits = useMemo(
    () =>
      hits.filter(
        (hit) =>
          (facet.collection === null || hit.collection === facet.collection) &&
          (facet.kind === null || hit.kind === facet.kind) &&
          (facet.status === null || hit.status === facet.status)
      ),
    [hits, facet]
  );

  const visibleIds = useMemo(() => visibleHits.map((hit) => hit.id), [visibleHits]);

  useEffect(() => {
    setSelection((current) => pruneSelection(current, visibleIds));
  }, [visibleIds]);

  const selectedHits = useMemo(
    () => visibleHits.filter((hit) => selection.selected.has(hit.id)),
    [visibleHits, selection]
  );

  const bulkActions = useMemo(() => bulkActionsFor(selectedHits, roles), [selectedHits, roles]);
  /**
   * Why the toolbar looks the way it does. `bulkActionsFor` intersects
   * `allowedActions` across the selection — correct, and unchanged — but a
   * selection spanning two collections collapses to `send-to-chat` alone,
   * which is what "Add tag disappeared when I picked more rows" actually
   * was. `describeInventorySelection` turns that into a sentence plus the
   * one-click narrowings below; the intersection itself is not relaxed.
   */
  const selectionSpan = useMemo(() => describeInventorySelection(selectedHits), [selectedHits]);

  useEffect(() => {
    if (!inspected) return;
    let alive = true;
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    (async () => {
      try {
        const result = await previewInventoryHit(getToken, inspected.collection, inspected.id);
        if (alive) setPreview(result);
      } catch (error) {
        if (alive) setPreviewError(errorText(error, 'This preview could not be loaded.'));
      } finally {
        if (alive) setPreviewLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [inspected]);

  useEffect(() => {
    if (!healthOpen || !isOwnerRole || diagnostics || diagnosticsError) return;
    let alive = true;
    setDiagnosticsLoading(true);
    (async () => {
      try {
        const result = await fetchDiagnostics(getToken);
        if (alive) setDiagnostics(result.diagnostics);
      } catch (error) {
        if (alive) setDiagnosticsError(errorText(error, 'Diagnostics could not be loaded.'));
      } finally {
        if (alive) setDiagnosticsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [healthOpen, isOwnerRole, diagnostics, diagnosticsError]);
  // ── END OF HOOKS. Early returns start here. ──────────────────────────────

  if (roleNames === null && !accessError) return <Skeleton variant="rect" height={280} />;

  if (accessError) {
    return (
      <Card>
        <EmptyState severity="error" title="Couldn't verify access" message={accessError} />
      </Card>
    );
  }

  if (!hasAccess) {
    return (
      <Card>
        <EmptyState
          icon={<IconUser size={26} />}
          title="Owner or Admin access required"
          message="Inventory spans every object, artifact and system store for this site, so it is limited to Owners and Admins. Ask an Owner to change your role."
        />
      </Card>
    );
  }

  // ── handlers (hoisted declarations — no hooks below this line) ───────────

  // Plain consts, deliberately not hooks: they are read only inside the
  // handlers below (never during render), so putting them here keeps the hook
  // block above exactly as long as it was.
  const chatStorage = browserDockedChatStorage();
  const chatStorageKey = dockedChatStorageKey(INVENTORY_CHAT_SCOPE, siteId);

  function toggleFacet(group: keyof FacetSelection, value: string) {
    setFacet((current) => ({ ...current, [group]: current[group] === value ? null : value }));
  }

  function objectTargets(targets: readonly InventoryHit[]) {
    const rows: Array<{ object_id: string; object_type: string }> = [];
    const rejected: BulkFailure[] = [];
    for (const hit of targets) {
      const parsed = parseObjectHitId(hit.id);
      if (parsed) rows.push({ object_id: parsed.objectId, object_type: parsed.objectType });
      else
        rejected.push({
          id: hit.id,
          reason: 'Row id is not an object reference (expected "<object_type>/<object_id>").',
        });
    }
    return { rows, rejected };
  }

  async function runArchive(targets: readonly InventoryHit[]): Promise<BulkReport> {
    const { rows, rejected } = objectTargets(targets);
    const summary = await bulkArchiveObjects(rows, await makeCallVerb());
    return {
      title: `Archive — ${summary.succeeded.length} of ${targets.length} succeeded`,
      ok: summary.succeeded.map((id) => ({ id })),
      failed: [
        ...rejected,
        ...summary.failed.map((failure) => ({ id: failure.object_id, reason: failure.error ?? 'Archive failed.' })),
      ],
    };
  }

  async function runValidate(targets: readonly InventoryHit[]): Promise<BulkReport> {
    const { rows, rejected } = objectTargets(targets);
    const summary = await bulkValidateObjects(rows, await makeCallVerb());
    return {
      title: `Validate — ${summary.readyCount} ready, ${summary.warningCount} with warnings, ${summary.blockedCount} blocked`,
      ok: summary.results
        .filter((result) => result.ok)
        .map((result) => ({
          id: result.object_id,
          detail: [
            result.level ?? 'checked',
            result.blockerCount ? `${result.blockerCount} blocker(s)` : null,
            result.warningCount ? `${result.warningCount} warning(s)` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        })),
      failed: [
        ...rejected,
        ...summary.results
          .filter((result) => !result.ok)
          .map((result) => ({ id: result.object_id, reason: result.error ?? 'Validation failed.' })),
      ],
    };
  }

  async function runDeleteArtifacts(targets: readonly InventoryHit[]): Promise<BulkReport> {
    const ids = targets.map((hit) => hit.id);
    const summary = await bulkDeleteArtifacts(ids, (id) => deleteArtifact(getToken, id));
    return {
      // "marked deleted", not "deleted": the server soft-deletes (see
      // CONFIRM_EFFECT) and the bytes are still there. Reporting a hard
      // delete would be the page claiming a state it cannot prove.
      title: `Delete artifacts — ${summary.ok.length} of ${ids.length} marked deleted (bytes retained)`,
      ok: summary.ok.map((id) => ({ id })),
      failed: summary.failed.map((failure) => ({ id: failure.id, reason: failure.reason ?? 'Delete failed.' })),
    };
  }

  async function runDeleteBlobs(targets: readonly InventoryHit[]): Promise<BulkReport> {
    const ids = targets.map((hit) => hit.id);
    // `bulkDeleteArtifacts` is id-generic: ids in, an injected per-id delete,
    // a bounded pool, and a per-item `{ok, failed}` out. Reusing it here is
    // what keeps raw-blob deletes on the same reporting contract as every
    // other bulk verb instead of growing a second, untested fan-out.
    const summary = await bulkDeleteArtifacts(ids, async (id) => {
      const parsed = parseStoreHitId(id);
      if (!parsed) throw new Error('Row id is not a blob reference (expected "<store>/<key>").');
      return deleteBlob(getToken, parsed.store, parsed.key);
    });
    return {
      title: `Delete store blobs — ${summary.ok.length} of ${ids.length} deleted`,
      ok: summary.ok.map((id) => ({ id })),
      failed: summary.failed.map((failure) => ({ id: failure.id, reason: failure.reason ?? 'Delete failed.' })),
    };
  }

  async function runRetag(targets: readonly InventoryHit[], action: PendingTag['action'], tag: string) {
    const ids = targets.map((hit) => hit.id);
    const add = action === 'add-tag' ? [tag] : [];
    const remove = action === 'remove-tag' ? [tag] : [];
    const summary = await bulkRetagArtifacts(ids, add, remove, (id, addTags, removeTags) =>
      retagArtifact(getToken, id, addTags, removeTags)
    );
    return {
      title: `${action === 'add-tag' ? 'Add tag' : 'Remove tag'} "${tag}" — ${summary.ok.length} of ${ids.length} updated`,
      ok: summary.ok.map((id) => ({ id })),
      failed: summary.failed.map((failure) => ({ id: failure.id, reason: failure.reason ?? 'Retag failed.' })),
    };
  }

  /**
   * Runs one verb over a set of rows, then RE-READS from the server before
   * showing the result. The table never renders a post-mutation state the
   * server has not confirmed.
   */
  async function runAction(action: ActionId, targets: readonly InventoryHit[], tag?: string) {
    if (targets.length === 0) return;
    setBusy(true);
    try {
      let result: BulkReport;
      switch (action) {
        case 'archive':
          result = await runArchive(targets);
          break;
        case 'validate':
          result = await runValidate(targets);
          break;
        case 'delete':
          result = await runDeleteArtifacts(targets);
          break;
        case 'delete-blob':
          result = await runDeleteBlobs(targets);
          break;
        case 'add-tag':
        case 'remove-tag':
          result = await runRetag(targets, action, tag ?? '');
          break;
        default:
          return;
      }
      await runSearch();
      setInspected(null);
      setSelection(clearSelection());
      setReport(result);
    } catch (error) {
      toast({ title: 'The run could not be completed', description: errorText(error, ''), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * The two store-wide owner verbs, restored to Inventory with T6's retirement
   * of Maintenance. They are NOT bulk verbs and never produce a per-item
   * report: each is one call against `admin-blob-manager` (owner-gated
   * server-side) that answers with the number of blobs it actually removed,
   * and that server-reported number is what the toast says — the page never
   * asserts a wipe it has not been told happened. The table is re-read before
   * the toast, same rule as `runAction`.
   */
  async function runWipe(pending: PendingWipe) {
    setBusy(true);
    try {
      if (pending.kind === 'store') {
        const result = await wipeStore(getToken, pending.store);
        toast({
          title: `Wiped ${result.deleted} blob${result.deleted === 1 ? '' : 's'} from "${pending.store}"`,
          tone: 'success',
        });
      } else {
        const result = await wipeAll(getToken);
        toast({
          title: `Wiped ${result.totalDeleted} blob${result.totalDeleted === 1 ? '' : 's'} across ${
            result.stores.length
          } store${result.stores.length === 1 ? '' : 's'}`,
          tone: 'success',
        });
      }
      await runSearch();
      setInspected(null);
      setSelection(clearSelection());
    } catch (error) {
      toast({ title: 'Wipe failed', description: errorText(error, ''), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function downloadHit(hit: InventoryHit, plan: InventoryPreviewPlan) {
    if (plan.mode === 'json') return;
    try {
      const token = await getToken();
      const objectUrl = await previewLoader.load(plan.cacheKey, plan.endpoint, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = inventoryDownloadFilename(hit);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      toast({ title: 'Download failed', description: errorText(error, ''), tone: 'danger' });
    }
  }

  function openWorkspace(hit: InventoryHit) {
    const parsed = parseObjectHitId(hit.id);
    if (!parsed) return;
    window.location.assign(objectWorkspaceHref(parsed.objectId, parsed.objectType));
  }

  // ── "Send to chat" (T5) ──────────────────────────────────────────────────

  const hitToSelectionItem = (hit: InventoryHit): InventoryChatSelectionItem => ({
    collection: hit.collection,
    id: hit.id,
    label: hit.label,
  });

  /**
   * The free chat this page seeds — minted once and cached per site for the
   * tab's session (see `INVENTORY_CHAT_SCOPE`). Storage access goes through
   * `docked-chat-session.ts`'s guarded helpers, which never throw, so a
   * private-browsing tab simply mints a chat per page load instead of
   * failing the hand-off.
   */
  async function ensureInventoryChatId(): Promise<string | undefined> {
    if (chatId) return chatId;

    const cached = readDockedChatId(chatStorage, chatStorageKey);
    if (cached) {
      setChatId(cached);
      return cached;
    }
    try {
      const { chat: created } = await createFreeChat(getToken, 'Inventory');
      writeDockedChatId(chatStorage, chatStorageKey, created.chat_id);
      setChatId(created.chat_id);
      return created.chat_id;
    } catch (error) {
      toast({ title: "Couldn't open chat", description: errorText(error, ''), tone: 'danger' });
      return undefined;
    }
  }

  /**
   * The way OUT of a conversation this page can no longer use — the half the
   * shipped `sessionStorage` cache was missing. Drops the cached id and the
   * held one; the next hand-off mints a fresh chat through the path above.
   * Always offered, never hidden: the state where it is most needed (the id
   * still resolves but the conversation is dead) is indistinguishable from
   * the healthy one, so a control that appeared only "on failure" would never
   * appear at all.
   */
  function startNewInventoryChat() {
    clearDockedChatId(chatStorage, chatStorageKey);
    setChatId(undefined);
    setComposerSeed(undefined);
    setChatOpen(false);
  }

  /**
   * Seeds the composer and nothing else (THE GOVERNING RULE — this page
   * proves nothing it does not do: it does not send the message, it opens
   * the rail so the human sees it prefilled and decides). Routed through the
   * EXISTING `draftSeed` prop `AgentRail`'s `ChatComposer` already reads —
   * see that component and `ObjectWorkspace.tsx`'s identical `composerSeed`
   * wiring. No new chat behaviour lives here.
   */
  async function seedInventoryComposer(prompt: string) {
    const id = await ensureInventoryChatId();
    if (!id) return;
    setComposerSeed({ key: `inventory-${Date.now()}`, text: prompt });
    setChatOpen(true);
  }

  function openSendToChat(hits: readonly InventoryHit[]) {
    setChatIntent('');
    setChatHandoff({ hits: [...hits] });
  }

  async function confirmSendToChat(hits: readonly InventoryHit[], intent: string) {
    const items = hits.map(hitToSelectionItem);
    const { prompt, truncated } = buildInventoryChatPrompt(intent, items);
    if (truncated) {
      toast({
        title: 'Selection capped',
        description: `Only the first ${INVENTORY_CHAT_SELECTION_CAP} of ${hits.length} items were listed for the agent.`,
        tone: 'warning',
      });
    }
    await seedInventoryComposer(prompt);
  }

  /**
   * The row menu, built from `allowedActions` — never from a hard-coded list.
   *
   * Two ids in the matrix are deliberately not menu items here:
   *   - `read` IS this row's "Inspect" button and its drawer;
   *   - `wipe-all` has no row to belong to — it empties every store on the
   *     site — so it lives in the System-health card's danger zone below,
   *     owner-only, behind a typed "WIPE ALL". (`wipe-store` DOES belong to
   *     a row: it names the store that row is in, and its typed phrase is
   *     that store's own name.)
   * Both were unreachable from anywhere between T6 deleting MaintenancePage
   * and this fix, while `allowedActions` and the owner-gated
   * `admin-blob-manager` still allowed them.
   */
  function rowMenuItems(hit: InventoryHit): MenuItem[] {
    const plan = inventoryPreviewPlan(hit);
    const items: MenuItem[] = [];
    for (const action of allowedActions(hit, roles)) {
      switch (action) {
        case 'open-in-workspace': {
          const parsed = parseObjectHitId(hit.id);
          items.push({
            id: action,
            label: 'Open in workspace',
            icon: <IconExternalLink size={14} />,
            disabled: !parsed,
            ...(parsed ? {} : { title: 'This row does not carry an object id.' }),
            onSelect: () => openWorkspace(hit),
          });
          break;
        }
        case 'validate':
          items.push({
            id: action,
            label: 'Validate',
            icon: <IconCheck size={14} />,
            disabled: busy,
            onSelect: () => void runAction('validate', [hit]),
          });
          break;
        case 'archive':
          items.push({
            id: action,
            label: 'Archive',
            icon: <IconArchive size={14} />,
            disabled: busy,
            onSelect: () => setConfirming({ action: 'archive', hits: [hit] }),
          });
          break;
        case 'add-tag':
          items.push({
            id: action,
            label: 'Add tag…',
            icon: <IconTag size={14} />,
            disabled: busy,
            onSelect: () => {
              setTagValue('');
              setTagPrompt({ action: 'add-tag', hits: [hit] });
            },
          });
          break;
        case 'remove-tag':
          items.push({
            id: action,
            label: 'Remove tag…',
            disabled: busy,
            onSelect: () => {
              setTagValue('');
              setTagPrompt({ action: 'remove-tag', hits: [hit] });
            },
          });
          break;
        case 'download':
          items.push({
            id: action,
            label: 'Download',
            icon: <IconDownload size={14} />,
            disabled: plan.mode === 'json',
            ...(plan.mode === 'json'
              ? { title: 'This artifact has no image or PDF bytes to download.' }
              : {}),
            onSelect: () => void downloadHit(hit, plan),
          });
          break;
        case 'delete':
          items.push({
            id: action,
            label: 'Delete (soft)',
            icon: <IconTrash size={14} />,
            tone: 'danger',
            separatorBefore: true,
            disabled: busy,
            onSelect: () => setConfirming({ action: 'delete', hits: [hit] }),
          });
          break;
        case 'delete-blob':
          items.push({
            id: action,
            label: 'Delete blob',
            icon: <IconTrash size={14} />,
            tone: 'danger',
            separatorBefore: true,
            disabled: busy,
            onSelect: () => setConfirming({ action: 'delete-blob', hits: [hit] }),
          });
          break;
        case 'wipe-store':
          items.push({
            id: action,
            label: `Wipe store "${hit.kind}"…`,
            icon: <IconTrash size={14} />,
            tone: 'danger',
            disabled: busy,
            onSelect: () => setWiping({ kind: 'store', store: hit.kind }),
          });
          break;
        case 'send-to-chat':
          items.push({
            id: action,
            label: 'Send to chat…',
            icon: <IconRobot size={14} />,
            onSelect: () => openSendToChat([hit]),
          });
          break;
        default:
          break;
      }
    }
    return items;
  }

  /** The bulk toolbar: only the verbs valid for EVERY selected row, and only the ones this page can execute. */
  function bulkButtons() {
    const buttons: ReactNode[] = [];
    for (const action of bulkActions) {
      switch (action) {
        case 'validate':
          buttons.push(
            <Button key={action} size="sm" variant="secondary" disabled={busy} onClick={() => void runAction('validate', selectedHits)}>
              Validate
            </Button>
          );
          break;
        case 'archive':
          buttons.push(
            <Button
              key={action}
              size="sm"
              variant="secondary"
              leftIcon={<IconArchive size={14} />}
              disabled={busy}
              onClick={() => setConfirming({ action: 'archive', hits: selectedHits })}
            >
              Archive
            </Button>
          );
          break;
        case 'add-tag':
          buttons.push(
            <Button
              key={action}
              size="sm"
              variant="secondary"
              leftIcon={<IconTag size={14} />}
              disabled={busy}
              onClick={() => {
                setTagValue('');
                setTagPrompt({ action: 'add-tag', hits: selectedHits });
              }}
            >
              Add tag
            </Button>
          );
          break;
        case 'remove-tag':
          buttons.push(
            <Button
              key={action}
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setTagValue('');
                setTagPrompt({ action: 'remove-tag', hits: selectedHits });
              }}
            >
              Remove tag
            </Button>
          );
          break;
        case 'delete':
          buttons.push(
            <Button
              key={action}
              size="sm"
              variant="danger"
              leftIcon={<IconTrash size={14} />}
              disabled={busy}
              onClick={() => setConfirming({ action: 'delete', hits: selectedHits })}
            >
              Delete (soft)
            </Button>
          );
          break;
        case 'delete-blob':
          buttons.push(
            <Button
              key={action}
              size="sm"
              variant="danger"
              leftIcon={<IconTrash size={14} />}
              disabled={busy}
              onClick={() => setConfirming({ action: 'delete-blob', hits: selectedHits })}
            >
              Delete blobs
            </Button>
          );
          break;
        case 'send-to-chat':
          buttons.push(
            <Button
              key={action}
              size="sm"
              variant="secondary"
              leftIcon={<IconRobot size={14} />}
              disabled={busy}
              onClick={() => openSendToChat(selectedHits)}
            >
              Send to chat…
            </Button>
          );
          break;
        default:
          break;
      }
    }
    return buttons;
  }

  // ── drawer content ───────────────────────────────────────────────────────

  function previewFields(hit: InventoryHit): PreviewField[] {
    if (!preview) return [];
    if (preview.format === 'artifact-metadata') return previewSummary(previewStoreName(hit), preview.artifact);
    const parsed = parseInventoryPreviewJson(preview.format, preview.text);
    return parsed ? previewSummary(previewStoreName(hit), parsed) : [];
  }

  function rawPreviewText(): string | null {
    if (!preview) return null;
    return preview.format === 'artifact-metadata' ? JSON.stringify(preview.artifact, null, 2) : preview.text;
  }

  const columns: Column<InventoryHit>[] = [
    {
      key: 'select',
      header: (
        <RowCheckbox
          checked={isAllSelected(selection, visibleIds)}
          indeterminate={isSomeSelected(selection, visibleIds)}
          onChange={() => setSelection((current) => toggleSelectAll(current, visibleIds))}
          label="Select every row on this page"
        />
      ),
      render: (hit) => (
        <RowCheckbox
          checked={isSelected(selection, hit.id)}
          onChange={() => setSelection((current) => toggleSelection(current, hit.id))}
          label={`Select ${hit.label}`}
        />
      ),
    },
    {
      key: 'preview',
      header: 'Preview',
      render: (hit) => <InventoryThumb hit={hit} plan={inventoryPreviewPlan(hit)} />,
    },
    {
      key: 'label',
      header: 'Item',
      sortable: true,
      accessor: (hit) => hit.label,
      render: (hit) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-[var(--adm-text)]">{hit.label}</div>
          <div className="truncate font-mono text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {hit.id}
          </div>
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      sortable: true,
      accessor: (hit) => hit.kind,
      render: (hit) => (
        <div className="flex flex-col gap-1">
          <Badge tone="neutral">{hit.kind}</Badge>
          <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {COLLECTION_LABELS[hit.collection]}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      accessor: (hit) => hit.status,
      render: (hit) => <StatusPill status={hit.status} />,
    },
    {
      key: 'updated',
      header: 'Updated',
      sortable: true,
      accessor: (hit) => hit.updatedAt ?? '',
      render: (hit) => (
        <span className="whitespace-nowrap text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {formatUpdated(hit.updatedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (hit) => {
        const items = rowMenuItems(hit);
        return (
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setInspected(hit)}>
              Inspect
            </Button>
            {items.length > 0 ? (
              <DropdownMenu
                align="end"
                trigger={({ ref, onToggle }) => (
                  <IconButton
                    ref={ref}
                    label={`Actions for ${hit.label}`}
                    icon={<IconDots size={18} />}
                    size="sm"
                    variant="secondary"
                    onClick={onToggle}
                  />
                )}
                items={items}
              />
            ) : null}
          </div>
        );
      },
    },
  ];

  const selected = selectionCount(selection);
  /** The selection's single shared collection, for the bulk toolbar's starter
   *  chips — `null` for an empty or mixed-collection selection, since a
   *  starter's canned intent ("Validate these…") is specific to one. The
   *  plain "Send to chat…" button above still covers a mixed selection. */
  const firstSelectedHit = selectedHits[0] as InventoryHit | undefined;
  const bulkStarterCollection: InventoryCollection | null =
    firstSelectedHit && selectedHits.every((hit) => hit.collection === firstSelectedHit.collection)
      ? firstSelectedHit.collection
      : null;
  const truncatedCollections = Object.entries(meta?.truncated ?? {})
    .filter(([, value]) => value)
    .map(([name]) => name);
  /** The server's own per-collection match totals (before the page limit) — not a count of what happens to be loaded. */
  const matchCounts = Object.entries(meta?.counts ?? {})
    .map(([name, count]) => `${COLLECTION_LABELS[name as InventoryCollection] ?? name} ${count}`)
    .join(' · ');
  const inspectedPlan = inspected ? inventoryPreviewPlan(inspected) : null;
  const rawText = rawPreviewText();

  return (
    <div
      className={
        chatId
          ? 'grid min-h-0 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]'
          : 'flex flex-col gap-5'
      }
    >
    <div className="flex flex-col gap-5">
      <Card
        kicker="Inventory"
        title="Everything in this site"
        actions={
          <Button variant="secondary" onClick={() => void runSearch()} loading={searching}>
            Refresh
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Search"
            value={queryText}
            onChange={(event) => setQueryText(event.target.value)}
            placeholder="Objects, artifacts (label / filename / tag), store keys…"
          />

          <div className="flex flex-col gap-3 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] p-3">
            <FacetGroup
              title="Collection"
              counts={facets.collection}
              active={facet.collection}
              onToggle={(value) => toggleFacet('collection', value)}
              labelFor={(value) => COLLECTION_LABELS[value as InventoryCollection] ?? value}
            />
            <FacetGroup title="Kind" counts={facets.kind} active={facet.kind} onToggle={(value) => toggleFacet('kind', value)} />
            <FacetGroup
              title="Status"
              counts={facets.status}
              active={facet.status}
              onToggle={(value) => toggleFacet('status', value)}
            />
            {facet.collection || facet.kind || facet.status ? (
              <div>
                <Button size="sm" variant="ghost" onClick={() => setFacet(EMPTY_FACETS)}>
                  Clear facets
                </Button>
              </div>
            ) : null}
          </div>

          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]" aria-live="polite">
            {searching
              ? 'Searching…'
              : `${visibleHits.length} row${visibleHits.length === 1 ? '' : 's'} shown of ${hits.length} loaded.`}
            {matchCounts ? ` Server matched ${matchCounts}.` : ''}
            {truncatedCollections.length
              ? ` Results in ${truncatedCollections.join(', ')} hit this site's scan cap — this is not the whole collection.`
              : ''}
          </p>

          {searchError ? (
            <EmptyState severity="error" title="Search failed" message={searchError} />
          ) : (
            <>
              {selected > 0 ? (
                <div className="flex flex-col gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">
                      {selected} selected
                    </span>
                    {bulkButtons()}
                    {bulkStarterCollection && bulkActions.includes('send-to-chat') ? (
                      <InventoryQuickActionChips
                        collection={bulkStarterCollection}
                        items={selectedHits.map(hitToSelectionItem)}
                        onSeedComposer={(prompt) => void seedInventoryComposer(prompt)}
                      />
                    ) : null}
                    {bulkActions.length === 0 ? (
                      <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                        No action applies to every selected item.
                      </span>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => setSelection(clearSelection())}>
                      Clear
                    </Button>
                  </div>

                  {/* The intersection, said out loud. A selection spanning two
                      collections keeps only the actions all of them share —
                      which is why Add tag / Remove tag vanish the moment an
                      object or a store row joins a set of artifacts. The
                      buttons below narrow the selection to one collection
                      (ids straight off the selection, so nothing the human
                      did not tick is ever selected for them); the verbs come
                      back because `bulkActionsFor` then intersects over one
                      collection, not because the rule was relaxed. */}
                  {selectionSpan.spansMultiple ? (
                    <div
                      className="flex flex-col gap-2 rounded-[var(--adm-radius-sm)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] px-3 py-2"
                      role="status"
                      aria-live="polite"
                    >
                      <p className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">
                        {selectionSpan.headline}
                      </p>
                      <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                        {selectionSpan.detail}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {selectionSpan.narrowingOptions.map((option) => (
                          <Button
                            key={option.collection}
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => setSelection(selectAll(option.ids))}
                          >
                            {option.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <DataTable
                columns={columns}
                rows={visibleHits}
                getRowKey={(hit) => hit.id}
                emptyState={
                  <EmptyState
                    title={searching ? 'Searching…' : 'Nothing matches'}
                    message="Try a different search, or clear the facet filters."
                  />
                }
              />

              {meta?.cursor ? (
                <div>
                  <Button
                    variant="secondary"
                    loading={searching}
                    onClick={() => void runSearch(meta.cursor ?? undefined)}
                  >
                    Load more
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </Card>

      <Card
        kicker="Diagnostics"
        title="System health"
        actions={
          <Button size="sm" variant="secondary" onClick={() => setHealthOpen((open) => !open)}>
            {healthOpen ? 'Hide' : 'Show'}
          </Button>
        }
      >
        {healthOpen ? (
          !isOwnerRole ? (
            <EmptyState
              title="Owner access required"
              message="Blob-store diagnostics are Owner-only on the server, so there is nothing here to show an Admin."
            />
          ) : diagnosticsError ? (
            <EmptyState severity="error" title="Diagnostics unavailable" message={diagnosticsError} />
          ) : diagnosticsLoading || !diagnostics ? (
            <Skeleton variant="rect" height={64} />
          ) : (
            <DiagnosticsGrid diagnostics={diagnostics} />
          )
        ) : (
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            Blob-store sources for this site. Fetched only when opened.
          </p>
        )}

        {/* The danger zone the retired Maintenance page carried. Owner-only on
            the client because `admin-blob-manager` is owner-only on the server
            — an admin is shown nothing here rather than a button that 403s. */}
        {healthOpen && isOwnerRole ? (
          <div className="mt-4 rounded-[var(--adm-radius-md)] border border-[var(--adm-danger)] p-3">
            <p className="text-[length:var(--adm-text-sm)] font-semibold text-[var(--adm-text)]">Danger zone</p>
            <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
              Wipe every blob in every store for this site. Owner-only, and it cannot be undone. To empty a single
              store, use "Wipe store" on any row from that store.
            </p>
            <div className="mt-2">
              <Button size="sm" variant="danger" disabled={busy} onClick={() => setWiping({ kind: 'all' })}>
                Wipe all stores…
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Drawer
        open={inspected !== null}
        onClose={() => setInspected(null)}
        title={inspected?.label ?? 'Item'}
        width={620}
        footer={
          inspected ? (
            <>
              {rowMenuItems(inspected).map((item) => (
                <Button
                  key={item.id}
                  size="sm"
                  variant={item.tone === 'danger' ? 'danger' : 'secondary'}
                  disabled={item.disabled}
                  onClick={() => item.onSelect?.()}
                >
                  {item.label}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setInspected(null)}>
                Close
              </Button>
            </>
          ) : null
        }
      >
        {inspected ? (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-2 text-[length:var(--adm-text-sm)]">
              <div>
                <dt className="text-[var(--adm-text-muted)]">Collection</dt>
                <dd>{COLLECTION_LABELS[inspected.collection]}</dd>
              </div>
              <div>
                <dt className="text-[var(--adm-text-muted)]">Kind</dt>
                <dd>{inspected.kind}</dd>
              </div>
              <div>
                <dt className="text-[var(--adm-text-muted)]">Status</dt>
                <dd>
                  <StatusPill status={inspected.status} />
                </dd>
              </div>
              <div>
                <dt className="text-[var(--adm-text-muted)]">Updated</dt>
                <dd>{formatUpdated(inspected.updatedAt)}</dd>
              </div>
              <div>
                <dt className="text-[var(--adm-text-muted)]">Size</dt>
                <dd>{formatBytes(inspected.sizeBytes)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-[var(--adm-text-muted)]">Id</dt>
                <dd className="break-all font-mono text-[length:var(--adm-text-xs)]">{inspected.id}</dd>
              </div>
              {inspected.refs.length ? (
                <div className="col-span-2">
                  <dt className="text-[var(--adm-text-muted)]">References</dt>
                  <dd className="flex flex-wrap gap-1">
                    {inspected.refs.map((ref) => (
                      <Badge key={ref} tone="neutral">
                        {ref}
                      </Badge>
                    ))}
                  </dd>
                </div>
              ) : null}
            </dl>

            {allowedActions(inspected, roles).includes('send-to-chat') ? (
              <InventoryQuickActionChips
                collection={inspected.collection}
                items={[hitToSelectionItem(inspected)]}
                onSeedComposer={(prompt) => void seedInventoryComposer(prompt)}
              />
            ) : null}

            {previewError ? (
              <EmptyState severity="error" title="Preview unavailable" message={previewError} />
            ) : previewLoading ? (
              <Skeleton variant="rect" height={200} />
            ) : (
              <>
                {inspectedPlan && inspectedPlan.mode !== 'json' ? (
                  <BytesPreview
                    endpoint={inspectedPlan.endpoint}
                    cacheKey={inspectedPlan.cacheKey}
                    mode={inspectedPlan.mode}
                    label={inspected.label}
                  />
                ) : null}

                {previewFields(inspected).length ? (
                  <dl className="grid grid-cols-2 gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] p-3 text-[length:var(--adm-text-sm)]">
                    {previewFields(inspected).map((field) => (
                      <div key={field.label}>
                        <dt className="text-[var(--adm-text-muted)]">{field.label}</dt>
                        <dd className="break-words">{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                {rawText !== null ? (
                  <details className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)]">
                    <summary className="cursor-pointer px-3 py-2 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                      Raw {preview?.format === 'text' ? 'text' : 'JSON'}
                      {preview && preview.format !== 'artifact-metadata' && preview.truncated
                        ? ` (trimmed — ${formatBytes(preview.sizeBytes)} stored)`
                        : ''}
                    </summary>
                    <pre className="max-h-80 overflow-auto px-3 pb-3 font-mono text-[length:var(--adm-text-xs)] text-[var(--adm-text)]">
                      {rawText}
                    </pre>
                  </details>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          const pending = confirming;
          setConfirming(null);
          if (pending) void runAction(pending.action, pending.hits);
        }}
        title={
          confirming
            ? `${CONFIRM_TITLE[confirming.action]} ${confirming.hits.length} item${confirming.hits.length === 1 ? '' : 's'}?`
            : ''
        }
        message={
          confirming
            ? `${confirming.hits
                .slice(0, 5)
                .map((hit) => hit.label)
                .join(', ')}${confirming.hits.length > 5 ? `, and ${confirming.hits.length - 5} more` : ''}. ${
                CONFIRM_EFFECT[confirming.action]
              } Each item is reported individually — a refusal names its reason.`
            : ''
        }
        confirmLabel={busy ? 'Working…' : CONFIRM_TITLE[confirming?.action ?? 'delete']}
        tone="danger"
        requireTyped={CONFIRM_PHRASE[confirming?.action ?? 'delete']}
      />

      {/* Typed confirm for the store-wide verbs. The phrase for one store is
          that store's OWN NAME (so it cannot be typed by muscle memory from
          another store's dialog); the fleet-wide wipe demands "WIPE ALL".
          Both are exactly the phrases the retired Maintenance danger zone
          used. */}
      <ConfirmDialog
        open={wiping !== null}
        onClose={() => setWiping(null)}
        onConfirm={() => {
          const pending = wiping;
          setWiping(null);
          if (pending) void runWipe(pending);
        }}
        title={wiping?.kind === 'store' ? `Wipe "${wiping.store}"?` : 'Wipe ALL stores?'}
        message={
          wiping?.kind === 'store'
            ? `Delete every blob in "${wiping.store}". This is a raw store wipe and cannot be undone.`
            : 'Delete every blob in every blob store for this site. This cannot be undone.'
        }
        confirmLabel={busy ? 'Wiping…' : wiping?.kind === 'store' ? 'Wipe store' : 'Wipe everything'}
        tone="danger"
        requireTyped={wiping?.kind === 'store' ? wiping.store : 'WIPE ALL'}
      />

      <Dialog
        open={tagPrompt !== null}
        onClose={() => setTagPrompt(null)}
        title={tagPrompt?.action === 'remove-tag' ? 'Remove a tag' : 'Add a tag'}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setTagPrompt(null)}>
              Cancel
            </Button>
            <Button
              disabled={!tagValue.trim() || busy}
              onClick={() => {
                const pending = tagPrompt;
                const tag = tagValue.trim();
                setTagPrompt(null);
                if (pending && tag) void runAction(pending.action, pending.hits, tag);
              }}
            >
              Apply
            </Button>
          </>
        }
      >
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          {tagPrompt?.action === 'remove-tag' ? 'Removed from' : 'Added to'} {tagPrompt?.hits.length ?? 0} artifact
          {(tagPrompt?.hits.length ?? 0) === 1 ? '' : 's'}. The server normalizes and validates the tag; a rejected tag
          is reported per item.
        </p>
        <div className="mt-3">
          <Input label="Tag" value={tagValue} onChange={(event) => setTagValue(event.target.value)} autoComplete="off" />
        </div>
      </Dialog>

      <Dialog
        open={report !== null}
        onClose={() => setReport(null)}
        title={report?.title ?? 'Result'}
        size="md"
        footer={
          <Button variant="secondary" onClick={() => setReport(null)}>
            Close
          </Button>
        }
      >
        <div className="flex flex-col gap-4 text-[length:var(--adm-text-sm)]">
          <section>
            <h3 className="mb-1 font-semibold text-[var(--adm-text)]">Succeeded ({report?.ok.length ?? 0})</h3>
            {report?.ok.length ? (
              <ul className="flex flex-col gap-1">
                {report.ok.map((entry) => (
                  <li key={entry.id} className="font-mono text-[length:var(--adm-text-xs)]">
                    {entry.id}
                    {entry.detail ? <span className="ml-2 font-sans text-[var(--adm-text-muted)]">{entry.detail}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[var(--adm-text-muted)]">None.</p>
            )}
          </section>
          <section>
            <h3 className="mb-1 font-semibold text-[var(--adm-text)]">Failed ({report?.failed.length ?? 0})</h3>
            {report?.failed.length ? (
              <ul className="flex flex-col gap-1">
                {report.failed.map((entry) => (
                  <li key={entry.id}>
                    <span className="font-mono text-[length:var(--adm-text-xs)]">{entry.id}</span>
                    <span className="ml-2 text-[var(--adm-danger)]">{entry.reason}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[var(--adm-text-muted)]">None.</p>
            )}
          </section>
        </div>
      </Dialog>

      <Dialog
        open={chatHandoff !== null}
        onClose={() => setChatHandoff(null)}
        title="Send to chat"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setChatHandoff(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const pending = chatHandoff;
                const intent = chatIntent;
                setChatHandoff(null);
                if (pending) void confirmSendToChat(pending.hits, intent);
              }}
            >
              Send
            </Button>
          </>
        }
      >
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          {chatHandoff?.hits.length ?? 0} item{(chatHandoff?.hits.length ?? 0) === 1 ? '' : 's'} will be listed for the
          agent{(chatHandoff?.hits.length ?? 0) > INVENTORY_CHAT_SELECTION_CAP
            ? ` (capped at ${INVENTORY_CHAT_SELECTION_CAP})`
            : ''}
          . This only prefills the chat composer — nothing sends until you do.
        </p>
        <div className="mt-3">
          <Textarea
            label="What do you want done?"
            value={chatIntent}
            onChange={(event) => setChatIntent(event.target.value)}
            rows={3}
            placeholder="e.g. Validate these and summarize issues"
          />
        </div>
      </Dialog>
    </div>
    {chatId ? (
      <div className="flex min-h-0 flex-col gap-2">
        <AgentRail
          chat={chat}
          focus="Inventory"
          draftSeed={composerSeed}
          collapsed={!chatOpen}
          onToggleCollapsed={() => setChatOpen((open) => !open)}
        />
        {/* The way out of a conversation that has stopped working — see
            `startNewInventoryChat`. Always offered, because a dead chat looks
            exactly like a live one from here. */}
        <div>
          <Button size="sm" variant="ghost" onClick={startNewInventoryChat}>
            New chat
          </Button>
        </div>
      </div>
    ) : null}
    </div>
  );
}

export interface InventoryPageProps {
  identity: SiteIdentity;
}

export default function InventoryPage({ identity }: InventoryPageProps) {
  return (
    <AdminShell currentPath="/admin/inventory" title="Inventory" identity={identity} wide>
      <InventoryBody siteId={identity.siteId} />
    </AdminShell>
  );
}
