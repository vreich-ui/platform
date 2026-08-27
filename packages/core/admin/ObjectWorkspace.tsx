/**
 * ObjectWorkspace (T2.2, D1(a)+D2) — the object DETAIL view: one object, its
 * tabs, and a contextual AI panel bound to that object.
 *
 * Shape:
 *
 *  - **Right chat dock.** The existing `AgentRail` (extended in place with a
 *    collapse toggle — this surface does not mount a second chat), docked
 *    sticky beside the scrolling content. Fixed width with a collapse
 *    toggle rather than drag-resizable: this kit has no `Resizable`
 *    primitive (`primitives.tsx`/`overlays.tsx`/`menus.tsx` have none) and
 *    building one is not this task. Its supplementary sections use
 *    `<DetailSection>`, which is collapsed on EVERY load by construction —
 *    no persisted expansion state — the `/admin/publish` dock convention.
 *
 *  - **Tabs: Content / Versions / Usage / Activity.** Versions and Activity
 *    are derived from `ObjectRecord.history` + `publication.publish_receipt`
 *    — the audit trail the record already carries (T0.1 §3/§7: `object_get`
 *    is the only per-object read this admin has, and it returns history in
 *    full). Usage has no client-reachable source and says so rather than
 *    rendering an invented panel. All four live in
 *    `lib/admin/object-detail-tabs.ts`.
 *
 *  - **Both edit paths, one set of verbs.** Text-like types get a direct
 *    form (`ObjectDetailForm`) AND chat editing of the same fields; both go
 *    through `checkout → patch → checkin` on `EditSession`, and the form
 *    reconciles against every chat write via `reconcileFormDraft`. Media-ish
 *    types get chips + chat and no form (`objectEditMode`).
 *
 *  - **Rights-gated action surface (T0.3 A4).** Every control comes from
 *    `resolveObjectControls`, which returns an entry for each control id in
 *    every state; a control the viewer may not use renders DISABLED with the
 *    reason as its tooltip, never hidden. `retire`'s reason says no admin
 *    endpoint exists, because none does (T0.1 §7).
 *
 *  - **A1/A2 closed here, through the ONE façade.** `ActionRow` (T1.2)
 *    renders Approve AND Reject on the review state, both dispatched through
 *    `decide()` (T3.2's `lib/admin/decisions.ts`) — not through
 *    `EditSession`. Same `review_decide` verb either way; only `decide()`
 *    also drives the optimistic overlay and invalidates the shared request
 *    index, which is what makes a decision taken here show up on the header
 *    pill and the runs inbox without a reload. Re-open review stays off the
 *    façade: it is `submit_review`, a lifecycle action that opens a review
 *    rather than a decision on one. The old plain-text "resolve them, then
 *    re-open review" line now comes with the Re-open review control it names.
 *
 * Perf (T0.2 R1 + the double release-state sweep F2 calls out for this
 * route): `load()` fires all three reads at once and paints on the record
 * alone, and the embedded `ObjectBrowser` — the second
 * `fetchReleaseOverview` caller on this page — is gone; the objects plane
 * (`/admin/objects`, T2.1) is the library now.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from 'astro:transitions/client';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Breadcrumbs, Button, Card, EmptyState, StatusPill, Skeleton } from './primitives';
import { DropdownMenu, Tabs } from './menus';
import { Input, Select } from './forms';
import { ConfirmDialog, Drawer, useToast } from './overlays';
import { HistoryTimeline, ReadinessList } from './data';
import { ActionRow, ApprovalCard } from './approval';
import { SeverityIcon } from './severity';
import { ObjectLens, objectLensMode } from './ObjectLensRegistry';
import { ObjectDetailForm, commitFieldOps } from './ObjectDetailForm';
import { AgentRail } from './AgentRail';
import { CandidateStage } from './CandidateStage';
import { cn } from './utils';
import { useChat } from './chat';
import { createObjectChat } from '@core/lib/admin/chat-client';
import { candidateAtShortcut, currentCandidateText } from '@core/lib/admin/candidate-choice';
import { MarginaliaThreadList } from './MarginaliaThreadList';
import {
  IconDots,
  IconExternalLink,
  IconLock,
  IconPencil,
  IconPlus,
  IconRocket,
  IconSparkles,
  IconWrench,
} from './icons';
import { objectDisplayName, objectTypeLabel, idTooltip } from '@core/lib/admin/display-name';
import { resolveWorkspaceObjectType } from '@core/lib/admin/object-type-resolve';
import type { ObjectType, ObjectRecord } from '@core/schema/object-record-v1';
import type { ReadinessGroup, CriterionStatus } from '@core/lib/admin/readiness-criteria';
import { useCurrentUser } from '@core/lib/admin/use-current-user';
import { objectStageModeClass } from '@core/lib/admin/object-stage';
import { releaseAwareLifecyclePresentation, resolveReleaseAwareLifecycle } from '@core/lib/admin/editorial-state';
import {
  fetchReleaseOverview,
  invalidateReleaseOverview,
  type ReleaseObjectView,
} from '@core/lib/admin/release-client';
import { fetchObjectLockStatusIfChanged, type ObjectLockView } from '@core/lib/admin/content-view-client';
import { pageSectionLabel } from '@core/lib/admin/preview-logic';
import type { Role as ReviewerRole } from '@core/lib/admin/object-review-ui';
import type { LibraryRow } from '@core/lib/admin/library-logic';
import { QuickActionChips } from './QuickActions';
import {
  OBJECT_CONTROL_IDS,
  objectReviewDecisionTarget,
  resolveObjectControls,
  reviewDecisionAvailability,
  type ObjectControlId,
  type ObjectControlMap,
} from '@core/lib/admin/object-detail-actions';
import { assertDecided, decide, decisionAvailability, type DecisionAction } from '@core/lib/admin/decisions';
import {
  buildFormPatchOps,
  excerptFieldId,
  objectEditMode,
  objectFormFields,
  readFormValues,
  titleFieldId,
} from '@core/lib/admin/object-detail-form';
import {
  deriveActivityEntries,
  deriveUsage,
  deriveVersionEntries,
  parseDetailTab,
  type ObjectDetailTab,
} from '@core/lib/admin/object-detail-tabs';
import { WORKSPACE_EXPANDED_MIN_WIDTH } from '@core/lib/admin/responsive-workspace';
import {
  NEW_NAV_ITEM_COMPOSER_SEED,
  NEW_SECTION_COMPOSER_SEED,
  contextActionsFor,
  isNewPageSectionProposal,
  repeatableItemCount,
  type ObjectActionContext,
  type ObjectFocusKind,
} from '@core/lib/admin/object-context-actions';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

// A successful write here (patch / publish / discard / create_variant) can
// change what the library list should show (display name, updated_at,
// status, unpublished-changes pill) — invalidate so the next library visit
// or palette open refetches instead of showing a stale row.
//
// T5.1 R2: the release overview is now cached too (`release-client.ts`,
// 15s TTL), and the very same writes move review/approval/publish state. It
// is dropped here in lockstep with the inventory so an editor's own action
// can never be hidden behind either cache.
function invalidateLibraryCache(): Promise<void> {
  // The release half is SYNCHRONOUS on purpose. Every caller below fires
  // `load()` on the very next line without awaiting this, and `load()` reads
  // the release cache — so an awaited dynamic import here would race, and the
  // reload could be served the pre-write overview. `release-client` is already
  // a static import in this file, so the drop lands first. The inventory
  // half keeps its lazy import: nothing on this page reads that cache
  // synchronously after a write.
  invalidateReleaseOverview();
  return Promise.all([
    import('@core/lib/admin/library-client').then(({ invalidateInventoryCache }) => invalidateInventoryCache()),
    // `/admin`'s publication map is a projection of these same records
    // (T5.1's `admin-editorial-view`). Nothing on THIS page reads it, so the
    // lazy import is safe here — but a swap back to `/admin` inside its TTL
    // would otherwise paint the pre-write foundation state.
    import('@core/lib/admin/editorial-view-client').then(({ invalidateEditorialView }) => invalidateEditorialView()),
  ]).then(() => undefined);
}

type Rec = ObjectRecord<Record<string, unknown>>;

type WorkspaceFocus = {
  kind: ObjectFocusKind;
  label: string;
  sectionId?: string;
};

const asBag = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

function pageSectionFocuses(record: Rec): Array<{ id: string; label: string; section: Record<string, unknown> }> {
  if (record.object_type !== 'page') return [];
  const sections = Array.isArray(record.body?.sections) ? record.body.sections : [];
  return sections.flatMap((raw, index) => {
    const section = asBag(raw);
    return typeof section.id === 'string' ? [{ id: section.id, label: pageSectionLabel(section, index), section }] : [];
  });
}

function parseLocation(): { id: string; type: ObjectType | undefined; tab: ObjectDetailTab } {
  const segment = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).at(-1) ?? '');
  const params = new URLSearchParams(window.location.search);
  const type = params.get('type') as ObjectType | null;
  return { id: segment, type: type ?? undefined, tab: parseDetailTab(params.get('tab')) };
}

/** Best-effort live URL for the Edit-on-site link. */
function liveUrl(record: Rec): string | undefined {
  const body = record.body ?? {};
  const route = typeof body.route === 'string' ? body.route : undefined;
  const slug = typeof body.slug === 'string' ? body.slug : undefined;
  if (route) return route;
  if (record.object_type === 'content_item' && slug) return `/${slug}`;
  return undefined;
}

// ─── collapsed-by-default section (the /admin/publish dock convention) ──────
//
// Deliberately NOT persisted: D-brief says "sections collapsed by default on
// EVERY load", so this holds no localStorage key and no lifted state — a
// remount is a collapsed section, always.

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-3 py-2">
      <summary className="adm-focusable cursor-pointer select-none text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
        {title}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

// ─── rights-gated control (T0.3 A4: disabled with a reason, never absent) ────

function GatedButton({
  control,
  onClick,
  children,
  variant = 'secondary',
  leftIcon,
  loading,
}: {
  control: { enabled: boolean; reason?: string };
  onClick: () => void;
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
  leftIcon?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant={variant}
      leftIcon={leftIcon}
      disabled={!control.enabled}
      title={control.reason}
      loading={loading}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

// ─── generated inspector VIEW

function FieldValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-[var(--adm-text-muted)]">—</span>;
  if (typeof value === 'boolean') return <Badge tone={value ? 'success' : 'neutral'}>{String(value)}</Badge>;
  if (typeof value === 'string' || typeof value === 'number') {
    return <span className="text-[var(--adm-text)]">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    return (
      <span className="text-[var(--adm-text-muted)]">
        {value.length} item{value.length === 1 ? '' : 's'} (structured)
      </span>
    );
  }
  return <span className="text-[var(--adm-text-muted)]">structured — edit on site</span>;
}

function GeneratedInspector({ record, onEditOnSite }: { record: Rec; onEditOnSite?: string }) {
  const entries = Object.entries(record.body ?? {}).filter(([key]) => key !== '__generated');
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)]">
        {entries.length === 0 ? (
          <p className="px-4 py-3 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">No body fields.</p>
        ) : (
          entries.map(([key, value]) => (
            <div
              key={key}
              className="flex items-start justify-between gap-4 border-b border-[var(--adm-border)] px-4 py-2.5 last:border-0"
            >
              <span className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-muted)]">{key}</span>
              <span className="min-w-0 text-right text-[length:var(--adm-text-sm)]">
                <FieldValue value={value} />
              </span>
            </div>
          ))
        )}
      </div>
      <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
        Structured and visual fields are edited on the canvas.
        {onEditOnSite ? (
          <>
            {' '}
            <a className="underline hover:text-[var(--adm-text)]" href={`${onEditOnSite}?edit=1`}>
              Edit on site
            </a>
            .
          </>
        ) : null}
      </p>
    </div>
  );
}

// ─── readiness from validate

function readinessFromValidate(body: Record<string, unknown>): ReadinessGroup[] {
  const blockers = Array.isArray(body.blockers) ? (body.blockers as unknown[]) : [];
  const warnings = Array.isArray(body.warnings) ? (body.warnings as unknown[]) : [];
  const criteria = [
    ...blockers.map((b, i) => ({
      id: `b${i}`,
      label: 'Blocker',
      status: 'missing' as CriterionStatus,
      message: String(b),
    })),
    ...warnings.map((w, i) => ({
      id: `w${i}`,
      label: 'Warning',
      status: 'warning' as CriterionStatus,
      message: String(w),
    })),
  ];
  if (criteria.length === 0) {
    criteria.push({
      id: 'ok',
      label: 'Valid',
      status: 'complete' as CriterionStatus,
      message: 'No blockers or warnings.',
    });
  }
  return [{ id: 'validation', label: 'Validation', criteria }];
}

// ─── hover-revealed inline edit (title / excerpt) ───────────────────────────
//
// Same verbs as the form below it: `commitFieldOps` → checkout → patch →
// checkin. The pencil is hover/focus-only chrome; the write is identical.

function InlineFieldEdit({
  record,
  fieldId,
  label,
  disabledReason,
  onSaved,
  children,
}: {
  record: Rec;
  fieldId: string;
  label: string;
  disabledReason?: string;
  onSaved: () => Promise<void> | void;
  children: React.ReactNode;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const begin = () => {
    setValue(readFormValues(record)[fieldId] ?? '');
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      const base = readFormValues(record);
      const ops = buildFormPatchOps(record.object_type, base, { ...base, [fieldId]: value });
      const outcome = await commitFieldOps(record, ops, getToken);
      if (!outcome.ok) {
        toast({ title: `${label} not saved`, description: outcome.error, tone: 'danger' });
        return;
      }
      setEditing(false);
      await onSaved();
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Input
          label={label}
          value={value}
          autoFocus
          disabled={busy}
          className="min-w-[16rem]"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
            if (event.key === 'Escape') setEditing(false);
          }}
        />
        <Button size="sm" loading={busy} onClick={() => void save()}>
          Save
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <span className="group/inline inline-flex min-w-0 items-center gap-1.5">
      {children}
      <button
        type="button"
        onClick={begin}
        disabled={Boolean(disabledReason)}
        title={disabledReason ?? `Edit ${label.toLowerCase()}`}
        aria-label={`Edit ${label.toLowerCase()}`}
        className="adm-focusable shrink-0 rounded p-1 text-[var(--adm-text-muted)] opacity-0 transition-opacity hover:text-[var(--adm-text)] focus-visible:opacity-100 group-hover/inline:opacity-100 disabled:cursor-not-allowed"
      >
        <IconPencil size={14} />
      </button>
    </span>
  );
}

// ─── dedicated-agent selector (T9.26 §4a; Owner assigns, Admin reads)

function DedicatedAgentPicker({ objectId, owner }: { objectId: string; owner: boolean }) {
  const [profiles, setProfiles] = useState<{ profile_id: string; name: string; status: string }[]>([]);
  const [assigned, setAssigned] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { listProfiles } = await import('@core/lib/admin/chat-client');
        const res = await listProfiles(getToken);
        setProfiles(res.profiles);
        setAssigned(res.assignments.objects[objectId] ?? '');
      } catch {
        /* roster unavailable — the resolved chip in the chat header still shows the agent */
      }
    })();
  }, [objectId]);

  if (profiles.length === 0) return null;
  const options = [
    { value: '', label: '— inherit (type default → site default) —' },
    ...profiles
      .filter((profile) => profile.status === 'active')
      .map((profile) => ({ value: profile.profile_id, label: profile.name })),
  ];
  if (!owner) {
    const name = profiles.find((profile) => profile.profile_id === assigned)?.name;
    return (
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        Dedicated agent: <span className="text-[var(--adm-text)]">{name ?? 'inherited'}</span>
      </p>
    );
  }
  return (
    <Select
      label="Dedicated agent"
      hint="New conversations on this object use this agent (live runs keep the agent they started with)."
      value={assigned}
      disabled={busy}
      onChange={async (event) => {
        const next = event.target.value;
        setBusy(true);
        try {
          const { assignProfile } = await import('@core/lib/admin/chat-client');
          await assignProfile(getToken, { kind: 'object', object_id: objectId }, next || null);
          setAssigned(next);
        } finally {
          setBusy(false);
        }
      }}
      options={options}
    />
  );
}

// ─── article taxonomy (T9.20 workspace parity with the canvas panel)
//
// Trimmed to the two REGISTRY-backed fields. Title/slug/description/author/
// SEO moved to the generic `ObjectDetailForm` in this rebuild — they are
// ordinary `set_article_meta` fields with no registry behind them, and
// having them in two places was the duplication this view was carrying.
// Category/tags stay here because they need the taxonomy registry read and
// the edit-time contract validation, and they go through the same
// `set_article_meta` op either way.

function ArticleTaxonomyCard({
  record,
  onSaved,
  identity,
  disabledReason,
}: {
  record: Rec;
  onSaved: () => Promise<void> | void;
  identity: SiteIdentity;
  disabledReason?: string;
}) {
  const { toast } = useToast();
  const body = record.body ?? {};
  const taxonomy = (body.taxonomy ?? {}) as { category?: string; tags?: string[] };
  const [category, setCategory] = useState(taxonomy.category ?? '');
  const [tags, setTags] = useState((taxonomy.tags ?? []).join(', '));
  const [registry, setRegistry] = useState<{ categories: string[]; tags: string[] }>({ categories: [], tags: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
        const res = await callObjectVerb(getToken, {
          action: 'get',
          object_type: 'taxonomy',
          object_id: identity.taxonomyId,
        });
        const kinds = ((res.body as { record?: { body?: { kinds?: Record<string, { terms?: { slug?: string }[] }> } } })
          .record?.body?.kinds ?? {}) as Record<string, { terms?: { slug?: string }[] }>;
        setRegistry({
          categories: (kinds.category?.terms ?? []).map((term) => term.slug ?? '').filter(Boolean),
          tags: (kinds.tag?.terms ?? []).map((term) => term.slug ?? '').filter(Boolean),
        });
      } catch {
        /* registry unavailable — free text still validates at publish */
      }
    })();
  }, []);

  const enteredTags = tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const novelTags = enteredTags.filter((tag) => registry.tags.length > 0 && !registry.tags.includes(tag));
  const changed = category !== (taxonomy.category ?? '') || enteredTags.join('\n') !== (taxonomy.tags ?? []).join('\n');

  const save = async () => {
    setBusy(true);
    try {
      const fields = { taxonomy: { ...(category ? { category } : { category: null }), tags: enteredTags } };
      const { callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
      // Edit-time contract validation — the same shared validation messages
      // the canvas panel shows, before the lock is taken.
      const candidate = await callObjectVerb(getToken, {
        action: 'validate',
        object_type: record.object_type,
        object_id: record.object_id,
        candidate_patch: [{ op: 'set_article_meta', fields }],
      });
      if (candidate.status === 200 && (candidate.body as { eligible?: boolean }).eligible === false) {
        const groups = ((candidate.body as { validation?: { items?: { severity?: string; message?: string }[] }[] })
          .validation ?? []) as { items?: { severity?: string; message?: string }[] }[];
        const blockers = groups
          .flatMap((group) => group.items ?? [])
          .filter((item) => item.severity === 'block')
          .map((item) => item.message ?? '');
        toast({
          title: 'Fix before saving',
          description: blockers.join(' · ') || 'Validation failed.',
          tone: 'danger',
        });
        return;
      }
      const outcome = await commitFieldOps(record, [{ op: 'set_article_meta', fields }], getToken);
      if (outcome.ok) {
        void invalidateLibraryCache();
        toast({ title: 'Taxonomy saved as a draft', tone: 'success' });
        await onSaved();
      } else {
        toast({ title: 'Not saved', description: outcome.error, tone: 'danger' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] p-3">
      <p className="text-[length:var(--adm-text-sm)] font-semibold text-[var(--adm-text-heading)]">Taxonomy</p>
      <Select
        label="Category"
        value={category}
        disabled={Boolean(disabledReason) || busy}
        onChange={(event) => setCategory(event.target.value)}
        options={[
          { value: '', label: '—' },
          ...[...new Set([...registry.categories, ...(category ? [category] : [])])].map((slugValue) => ({
            value: slugValue,
            label: registry.categories.includes(slugValue) ? slugValue : `${slugValue} (not in registry)`,
          })),
        ]}
        hint="From the taxonomy registry."
      />
      <Input
        label="Tags"
        value={tags}
        disabled={Boolean(disabledReason) || busy}
        onChange={(event) => setTags(event.target.value)}
        hint={
          novelTags.length > 0
            ? `Not in the registry (needed before publish): ${novelTags.join(', ')}`
            : 'Comma-separated; registry terms resolve at publish.'
        }
      />
      <Button
        size="sm"
        className="self-start"
        onClick={() => void save()}
        loading={busy}
        disabled={Boolean(disabledReason) || !changed}
        title={disabledReason}
      >
        Save draft
      </Button>
    </div>
  );
}

// ─── workspace body

function WorkspaceBody({ identity }: { identity: SiteIdentity }) {
  const { toast } = useToast();
  const [record, setRecord] = useState<Rec | null>(null);
  /**
   * T5.1 (T0.2 F9): the lock heartbeat's own state, separate from `record`.
   * The 4 s poll used to overwrite the WHOLE record just to refresh this;
   * now it refreshes only this, through `admin-content-view`'s lock-only
   * projection. `record.lock` (set once, at load) is still the fallback for
   * the render between mount and the poll's first tick.
   */
  const [lockView, setLockView] = useState<ObjectLockView | undefined>(undefined);
  const [releaseObject, setReleaseObject] = useState<ReleaseObjectView>();
  const [releaseKnown, setReleaseKnown] = useState(false);
  const [readiness, setReadiness] = useState<ReadinessGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [expandedWorkspace, setExpandedWorkspace] = useState(false);
  const [now, setNow] = useState(0);
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  const [focus, setFocus] = useState<WorkspaceFocus>({ kind: 'object', label: '' });
  const [composerSeed, setComposerSeed] = useState<{ key: string; text: string } | undefined>(undefined);
  const seedSequence = useRef(0);
  const [loc] = useState(() =>
    typeof window === 'undefined' ? { id: '', type: undefined, tab: 'content' as ObjectDetailTab } : parseLocation()
  );
  const [tab, setTab] = useState<ObjectDetailTab>(loc.tab);
  // The resolved object type: `?type=` when the library link supplied it,
  // otherwise derived from the id (prefix map + inventory fallback, W15 S1).
  const typeRef = useRef<ObjectType | undefined>(loc.type);
  const chat = useChat(getToken, chatId);
  const currentUser = useCurrentUser();
  const owner = currentUser.roles.includes('owner') || currentUser.user?.role === 'owner';

  // The dock owns approval effects, so the inline dock and the drawer dock
  // are mutually exclusive at runtime — never both mounted.
  useEffect(() => {
    const media = window.matchMedia(`(min-width: ${WORKSPACE_EXPANDED_MIN_WIDTH}px)`);
    const sync = () => {
      setExpandedWorkspace(media.matches);
      if (media.matches) setAgentOpen(false);
    };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  /**
   * T0.2 R1 (F1): the three reads have no data dependency on each other —
   * `type` and `loc.id` are both known before this function is entered — so
   * they all go out at once and the paint gate (`setLoading(false)`) waits
   * on the RECORD alone. Release state and readiness fill in behind it.
   * Three sequential round trips became one.
   */
  const load = async (): Promise<Rec | undefined> => {
    const type = typeRef.current;
    if (!loc.id || !type) {
      setError('This object could not be identified. Open it from the objects library.');
      setLoading(false);
      return undefined;
    }
    const { getObjectRecord, callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
    const recordPromise = getObjectRecord(getToken, type, loc.id);
    const overviewPromise = fetchReleaseOverview(getToken).then(
      (overview) => ({ ok: true as const, overview }),
      () => ({ ok: false as const, overview: undefined })
    );
    const readinessPromise = callObjectVerb(getToken, {
      action: 'validate',
      object_type: type,
      object_id: loc.id,
    }).catch(() => undefined);

    const { record: loaded } = await recordPromise;
    if (!loaded) {
      setError(`${objectTypeLabel(type)} "${loc.id}" was not found.`);
      setLoading(false);
      void overviewPromise;
      void readinessPromise;
      return undefined;
    }
    setRecord(loaded as Rec);
    setLoading(false);

    const release = await overviewPromise;
    setReleaseKnown(release.ok);
    setReleaseObject(release.overview?.objects.find((object) => object.object_id === loc.id));

    const validation = await readinessPromise;
    setReadiness(validation ? readinessFromValidate(validation.body ?? {}) : null);
    return loaded as Rec;
  };

  useEffect(() => {
    setNow(Date.now());
    (async () => {
      // Bare deep links (W15 S1): /admin/content/<id> without `?type=` — the
      // id prefix names the type for eleven governed types; content_item ids
      // (req_*) and anything unprefixed resolve via one inventory lookup.
      if (loc.id && !typeRef.current) {
        typeRef.current = await resolveWorkspaceObjectType(getToken, loc.id);
        if (!typeRef.current) {
          setError(`"${loc.id}" was not found in the objects library.`);
          setLoading(false);
          return;
        }
      }
      // R1 again: the per-object conversation does not depend on the record —
      // only on the id and type — so it opens alongside the load rather than
      // behind it. The display title is patched in by the chat header.
      await Promise.all([
        load(),
        loc.id && typeRef.current
          ? createObjectChat(getToken, typeRef.current, loc.id)
              .then(({ chat: created }) => setChatId(created.chat_id))
              .catch(() => setChatId(undefined))
          : Promise.resolve(),
      ]);
    })().catch((e) => {
      setError(e instanceof Error ? e.message : 'Could not load this object.');
      setLoading(false);
    });
  }, []);

  // Keep `?tab=` deep-linkable without a navigation (same document, same state).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (tab === 'content') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    window.history.replaceState(window.history.state, '', url.toString());
  }, [tab]);

  // Every accepted write refreshes the record — the preview re-renders,
  // readiness re-computes, and the direct edit form reconciles its draft
  // against the new body (ObjectDetailForm's `record.version` effect). Chat
  // and the form edit the same fields, so this is the chat → form half of
  // the round trip.
  useEffect(() => {
    if (chat.writeStamp > 0) {
      void invalidateLibraryCache();
      void load();
    }
  }, [chat.writeStamp]);

  // Locks are short-lived coordination state. T5.1 (T0.2 F9): this used to
  // re-fetch the WHOLE record every 4s just to read one boolean and an
  // expiry timestamp — 15 full-record reads/min while a lock was visible, the
  // body tree dominating the wire on any large article. `admin-content-view`
  // projects exactly `{locked, lock, version}`, and an unmoved lock between
  // two heartbeats (the common case) comes back a bodyless 304 (R8's shape).
  useEffect(() => {
    // A fresh `record` (a full reload after a write, or a checkin elsewhere)
    // is always more authoritative than a stale poll snapshot from the
    // PREVIOUS lock state — reset before the guard below, or a checkin would
    // leave `lockView` reporting a lock that is already gone (the guard stops
    // the poll that would otherwise have cleared it).
    setLockView(undefined);
    if (!record?.lock?.token || !typeRef.current) return;
    let active = true;
    let etag: string | undefined;
    const refreshLock = async () => {
      try {
        const result = await fetchObjectLockStatusIfChanged(getToken, typeRef.current!, loc.id, etag);
        if (!active) return;
        etag = result.etag;
        if (!result.unchanged) setLockView(result.view);
      } catch {
        // Keep the last known state; the next interval retries quietly.
      }
    };
    const timer = window.setInterval(() => void refreshLock(), 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loc.id, record?.lock?.token]);

  useEffect(() => {
    if (!chat.candidateSet) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.matches('input, textarea, select') ||
        target?.isContentEditable ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const shortcut = candidateAtShortcut(chat.candidateSet!.candidates, event.key);
      if (shortcut) {
        event.preventDefault();
        chat.preview(shortcut.candidate_id);
      } else if (event.key === 'Enter' && chat.previewCandidate) {
        event.preventDefault();
        void chat.chooseCandidate(chat.previewCandidate.candidate_id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chat.candidateSet, chat.previewCandidate]);

  const runAction = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const doPublish = () =>
    runAction(async () => {
      if (!record) return;
      const { EditSession } = await import('@core/lib/edit-mode/verbs-client');
      const session = new EditSession(record.object_type, record.object_id, getToken);
      const co = await session.ensureCheckout();
      if (!co.ok) {
        toast({ title: 'Locked', description: co.heldBy ? `Held by ${co.heldBy}.` : undefined, tone: 'warning' });
        return;
      }
      const res = await session.publish();
      await session.checkin();
      if (res.status === 200) {
        void invalidateLibraryCache();
        toast({ title: 'Published', tone: 'success' });
        await load();
      } else {
        // B7 (T0.3): "blocked" is D4's true-dead-end word — a non-200 here is
        // usually a recoverable failure (retrying the same click after
        // fixing the cause works), so it reads as "failed", not "blocked".
        toast({
          title: 'Publish failed',
          description: String((res.body as { error?: string }).error ?? ''),
          tone: 'danger',
        });
      }
    });

  /**
   * A1's missing control: the workspace used to render "resolve them, then
   * re-open review before approving" as plain text naming an action with no
   * button anywhere. This is that button. Re-opening IS `submit_review`,
   * which writes under a held lock — hence checkout → submit → checkin.
   */
  const doSubmitReview = () =>
    runAction(async () => {
      if (!record) return;
      const { EditSession } = await import('@core/lib/edit-mode/verbs-client');
      const session = new EditSession(record.object_type, record.object_id, getToken);
      const co = await session.ensureCheckout();
      if (!co.ok) {
        toast({ title: 'Locked', description: co.heldBy ? `Held by ${co.heldBy}.` : undefined, tone: 'warning' });
        return;
      }
      const res = await session.submitReview();
      await session.checkin();
      if (res.status === 200) {
        void invalidateLibraryCache();
        toast({ title: 'Review re-opened', tone: 'success' });
        await load();
      } else {
        toast({
          title: 'Could not re-open review',
          description: String((res.body as { error?: string }).error ?? ''),
          tone: 'danger',
        });
      }
    });

  const doDiscard = () =>
    runAction(async () => {
      if (!record) return;
      const { callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
      const res = await callObjectVerb(getToken, {
        action: 'discard',
        object_type: record.object_type,
        object_id: record.object_id,
      });
      if (res.status === 200) {
        void invalidateLibraryCache();
        toast({ title: 'Changes discarded', tone: 'success' });
        await load();
      } else {
        toast({
          title: 'Discard failed',
          description: String((res.body as { error?: string }).error ?? ''),
          tone: 'danger',
        });
      }
      setConfirmDiscard(false);
    });

  const doTakeOver = () =>
    runAction(async () => {
      if (!record) return;
      const { callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
      const res = await callObjectVerb(getToken, {
        action: 'checkin',
        object_type: record.object_type,
        object_id: record.object_id,
        force: true,
      });
      if (res.status === 200) {
        toast({ title: 'Lock released', tone: 'success' });
        await load();
      } else {
        toast({
          title: 'Take-over failed',
          description: String((res.body as { error?: string }).error ?? ''),
          tone: 'danger',
        });
      }
    });

  const doNewVariant = () =>
    runAction(async () => {
      if (!record) return;
      const { callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
      const res = await callObjectVerb(getToken, { action: 'create_variant', source_object_id: record.object_id });
      const newId =
        (res.body as { object?: { object_id?: string }; object_id?: string }).object?.object_id ??
        (res.body as { object_id?: string }).object_id;
      if (res.status === 200 && newId) {
        void invalidateLibraryCache();
        toast({ title: 'Variant created', tone: 'success' });
        // T0.2 R4/F14: a client-side swap keeps the module caches warm.
        void navigate(`/admin/content/${encodeURIComponent(newId)}?type=content_item`);
      } else {
        toast({
          title: 'Could not create a variant',
          description: String((res.body as { error?: string }).error ?? ''),
          tone: 'danger',
        });
      }
    });

  // Suggested prompts (plan §4): seeded from missing readiness criteria, with
  // generic starters as the floor.
  const readinessOpenItems = useMemo(
    () =>
      (readiness ?? [])
        .flatMap((group) => group.criteria)
        .filter((criterion) => criterion.status === 'missing' || criterion.status === 'warning').length,
    [readiness]
  );
  const suggestions = useMemo(() => {
    const fromReadiness = (readiness ?? [])
      .flatMap((group) => group.criteria)
      .filter((criterion) => criterion.status === 'missing')
      .slice(0, 2)
      .map((criterion) => `${criterion.label} needs attention — can you take care of it?`);
    return [...fromReadiness, 'Summarize this object and anything that looks off.', 'What would you improve here?'];
  }, [readiness]);

  // D8: skeleton out on ONE round trip (the record), not three.
  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton variant="text" width="40%" height={28} />
        <Skeleton variant="text" width="22%" height={16} />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Skeleton variant="rect" height={420} />
          <Skeleton variant="rect" height={420} />
        </div>
      </div>
    );
  }
  if (error || !record) {
    return (
      <Card>
        <EmptyState
          severity="error"
          title="Couldn't open this object"
          message={error ?? undefined}
          action={
            <Button variant="secondary" onClick={() => void navigate('/admin/objects')}>
              Back to objects
            </Button>
          }
        />
      </Card>
    );
  }

  // Fixed defect (kept): only a server-confirmed release row is trustworthy
  // here; anything else is UNKNOWN, and unknown fails closed.
  const lifecycle = resolveReleaseAwareLifecycle(releaseObject);
  const status = releaseAwareLifecyclePresentation(lifecycle);
  const url = liveUrl(record);
  // T5.1 (F9): once the lock-only poll has ticked at least once, its view is
  // the live truth; `record.lock` (set at load, never touched by the poll
  // any more) is only the fallback for the render before the first tick.
  // Deliberately mirrors the OLD truthiness check (a lock object present),
  // not `lockView.locked`'s expiry-awareness — same behavior, faster wire.
  const lockHeld = lockView ? Boolean(lockView.lock) : Boolean(record.lock && record.lock.token);
  const lockOwnerLabel = lockView ? lockView.lock?.owner_label : record.lock?.owner_label;
  // `lockOwnerFromPrincipal` (server/lib/object-lock.ts) writes a HUMAN
  // holder's email as `owner_label` and an agent's name for both fields, so
  // the caller's email is the one comparable identity the browser has. An
  // unknown viewer email fails toward "held by someone else", which is the
  // safe direction for a lock.
  const lockHeldByOther =
    lockHeld && (currentUser.user?.email === undefined || lockOwnerLabel !== currentUser.user.email);
  const isContentItem = record.object_type === 'content_item';
  const stageMode = objectLensMode(record.object_type);
  const editMode = objectEditMode(record.object_type);
  const reviewerRoles = currentUser.roles.filter(
    (role): role is ReviewerRole => role === 'admin' || role === 'publisher' || role === 'editor'
  );

  const controlsInput = {
    objectType: record.object_type,
    roles: reviewerRoles,
    isOwner: owner,
    releaseKnown: releaseObject !== undefined && releaseKnown,
    lockHeld,
    lockHeldByOther,
    review: record.review,
    contentRevision: record.content_revision,
    ...(releaseObject !== undefined ? { requiresApprovalOverride: releaseObject.requires_approval } : {}),
    status: record.status,
  };
  const controls: ObjectControlMap = resolveObjectControls(controlsInput);
  const availability = reviewDecisionAvailability(controlsInput);

  const displayName = objectDisplayName(record);
  const titleField = titleFieldId(record.object_type);
  const excerptField = excerptFieldId(record.object_type);
  const pageSections = pageSectionFocuses(record);
  const existingSectionIds = new Set(pageSections.map((section) => section.id));
  const selectedPageSection = focus.sectionId
    ? pageSections.find((section) => section.id === focus.sectionId)
    : undefined;
  const focusedSection = record.object_type === 'section' ? asBag(record.body?.section) : selectedPageSection?.section;
  const sectionItemCount = focusedSection ? repeatableItemCount(focusedSection) : undefined;
  const quickContext: ObjectActionContext | undefined = focusedSection
    ? {
        focusKind: 'section',
        focusLabel: focus.kind === 'section' && focus.label ? focus.label : displayName,
        ...(record.object_type === 'page' ? { parentLabel: displayName } : {}),
        itemCount: sectionItemCount,
        repeatable: sectionItemCount !== undefined,
      }
    : undefined;
  const chatContextActions = quickContext
    ? contextActionsFor(quickContext).map((action) => ({
        id: action.id,
        label: action.label,
        text: action.buildContext(quickContext),
      }))
    : undefined;

  /**
   * T2.1's quick-action chip registry, consumed for real (T3.3 filled it in).
   * The registry's own contract is "no rights → no chip" — rights-gating
   * happens INSIDE `resolve`, so this surface never filters. The row is
   * assembled here because the registry's subject is a `LibraryRow`, the
   * same shape the objects plane resolves against, so one object gets one
   * chip set wherever it is rendered.
   */
  const quickActionRow: LibraryRow = {
    object_id: record.object_id,
    object_type: record.object_type,
    display_name: displayName,
    updated_at: record.updated_at,
    status: record.status,
    review_state: record.review?.state ?? 'none',
    ...(releaseObject ? { approval_state: releaseObject.approval_state } : {}),
    ...(releaseObject ? { requires_approval: releaseObject.requires_approval } : {}),
    published_time: record.publication?.published_time ?? null,
    content_revision: record.content_revision,
    unpublished_changes: lifecycle === 'draft' || lifecycle === 'approved',
  };

  const focusLabel = focus.kind === 'object' || !focus.label ? displayName : `${displayName} → ${focus.label}`;
  const sequentialProposal =
    focus.kind === 'new-section' && isNewPageSectionProposal(chat.pending, record.object_id, existingSectionIds);
  const workState =
    chat.status === 'awaiting_approval'
      ? 'Waiting for you'
      : chat.status === 'awaiting_candidate'
        ? 'Ready to review'
        : chat.status === 'queued' || chat.status === 'running'
          ? 'Working'
          : chat.status === 'error'
            ? 'Failed'
            : undefined;
  const agentOccupied = chat.busy || workState !== undefined;

  const versions = deriveVersionEntries(record);
  const activity = deriveActivityEntries(record);
  const usage = deriveUsage();

  const agentRail = (
    <AgentRail
      chat={chat}
      focus={focusLabel}
      preferenceScope={`${currentUser.user?.email ?? 'anonymous'}:${record.object_id}`}
      suggestions={focus.kind === 'object' ? suggestions : undefined}
      contextActions={chatContextActions}
      draftSeed={composerSeed}
      approvalInStage={sequentialProposal}
      collapsed={expandedWorkspace && dockCollapsed}
      {...(expandedWorkspace ? { onToggleCollapsed: () => setDockCollapsed((value) => !value) } : {})}
      belowHeader={
        <div className="flex flex-col gap-2">
          <DetailSection title="Agent assignment">
            <DedicatedAgentPicker objectId={record.object_id} owner={owner} />
          </DetailSection>
          <DetailSection title="Object fields (read-only view)">
            <GeneratedInspector record={record} onEditOnSite={url} />
          </DetailSection>
        </div>
      }
      aboveComposer={
        readiness && readinessOpenItems > 0 ? (
          <details className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] px-3 py-2">
            <summary className="cursor-pointer select-none text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-warning)]">
              {readinessOpenItems} readiness item{readinessOpenItems === 1 ? '' : 's'} before publish
            </summary>
            <div className="mt-2">
              <ReadinessList groups={readiness} />
            </div>
          </details>
        ) : null
      }
    />
  );

  const beginAdd = (kind: 'new-section' | 'navigation-item') => {
    const isSection = kind === 'new-section';
    setFocus({ kind, label: isSection ? 'New section' : 'New navigation item' });
    setComposerSeed({
      key: `${kind}-${++seedSequence.current}`,
      text: isSection ? NEW_SECTION_COMPOSER_SEED : NEW_NAV_ITEM_COMPOSER_SEED,
    });
  };

  // `chat.approve` carries its own consumed-call guard (chat.tsx) — a second
  // click while the same call_id is in flight is a no-op there.
  const saveSequentialProposal = async (addNext: boolean) => {
    const pending = chat.pending;
    if (!pending) return;
    const outcome = await chat.approve(pending.call_id);
    if (!outcome.approved) return;
    toast({ title: 'Section saved', tone: 'success' });
    if (addNext) beginAdd('new-section');
    else {
      setFocus({ kind: 'object', label: '' });
      setComposerSeed(undefined);
    }
  };

  // ─── the review decision surface (D3: buttons render WITH the state) ──────
  //
  // One `<ApprovalCard>`, always carrying its `<ActionRow>`. When the viewer
  // cannot decide, the row renders DISABLED with the reason as its tooltip
  // (T0.3 A4) — the "Waiting on a review decision" / "Changes were requested"
  // copy that used to be a bare sentence is now that reason string, attached
  // to the buttons it describes.
  // W19 severity law (CLAUDE.md, `activity-severity.ts`): a HELD GATE is
  // attention/amber, never red. A review sitting in `changes_requested` is a
  // gate waiting on a human, not a failure — `needs_you`, not `error`.
  const reviewSeverity =
    record.review?.state === 'approved' && availability.canPublish
      ? 'success'
      : record.review === undefined
        ? 'info'
        : 'needs_you';
  const reopening = record.review?.state === 'changes_requested';
  const reviewCause =
    record.review === undefined
      ? 'No review has been opened on this object yet.'
      : record.review.state === 'open'
        ? 'A review is open on the current revision.'
        : record.review.state === 'changes_requested'
          ? 'Changes were requested on this review — resolve them, then re-open review before approving.'
          : availability.canPublish
            ? 'Approved for the current revision.'
            : 'Approved, but the body changed since — the approval no longer covers this revision.';

  /**
   * T3.2's hand-off, taken: this surface's Approve/Reject go through the ONE
   * decision façade (`decisions.ts`), not through `EditSession`.
   *
   * Both reach the same `review_decide` verb, but only `decide()` drives the
   * optimistic overlay and invalidates T2.3's shared request index — which is
   * the whole of T3.2's acceptance criterion: a decision taken HERE has to
   * update the header pill and the runs inbox without a reload. A second
   * decision path would be right on the wire and still break that, so the
   * detail view has exactly one.
   *
   * The target carries this view's own display-availability, so the façade's
   * pre-flight refusal and the disabled buttons below can never disagree —
   * and `describeDecision` gets the display name, the pinned revision and the
   * lock context it needs to write a receipt that says what actually changed.
   *
   * Deliberately NOT on the façade: Re-open review (`submit_review`, below).
   * It is a lifecycle action that OPENS a review, not a decision on one —
   * `DecisionTarget` has no variant for it, it writes under a held lock, and
   * routing it through `decide()` would mean inventing a fourth mechanism.
   */
  /**
   * The editorial request this review belongs to, when there is one.
   *
   * Source: W19 T19.5's chat→request binding, resolved SERVER-side
   * (`requestRowForChat`) and handed to this page on the object chat's first
   * poll. This surface mounts exactly one chat and it is scoped to this
   * object, so the request that chat is attached to is the request this
   * object's work belongs to — the guard below only refuses a binding that
   * names a different object, which a `chat_obj_*` id makes near-impossible
   * and which would otherwise alias the wrong row.
   *
   * Deliberately NOT `record.object_id`: a `content_item` id keeps the
   * `req_*` shape, so it LOOKS like a request id, but content items minted
   * outside the editorial pipeline wear the same shape without a request
   * behind them. Where the binding is absent (a chat not yet attached to any
   * request, a page/section/theme object that no request produced) this stays
   * undefined and the decision behaves exactly as it did before — one key, no
   * alias.
   */
  const boundRequestId =
    chat.request && (chat.request.object_id === undefined || chat.request.object_id === record.object_id)
      ? chat.request.request_id
      : undefined;

  const reviewTarget = objectReviewDecisionTarget({
    objectType: record.object_type,
    objectId: record.object_id,
    displayName,
    contentRevision: record.content_revision,
    availability,
    lock: {
      held: lockHeld,
      ...(lockOwnerLabel ? { ownerLabel: lockOwnerLabel } : {}),
    },
    // T3.2 key-space fix: gives the overlay entry the request keying every
    // inbox-shaped reader actually looks up, so approving here moves the row
    // now rather than when the sweeper next runs.
    ...(boundRequestId !== undefined ? { requestId: boundRequestId } : {}),
  });

  const decideReview = async (decision: DecisionAction, reason?: string) => {
    // `assertDecided` turns the normalised failure into the rejected promise
    // `<ActionRow>` expects — it catches and toasts it with the server's own
    // sentence rather than leaving a button spinning.
    const result = assertDecided(await decide(getToken, reviewTarget, decision, reason ? { reason } : {}));
    void invalidateLibraryCache();
    toast({ title: displayName, description: result.receipt, tone: 'success' });
    await load();
  };

  const reviewPanel = (
    <ApprovalCard
      severity={reviewSeverity}
      title={`Review — ${objectTypeLabel(record.object_type)}`}
      cause={reviewCause}
      actions={{
        onApprove: () => decideReview('approve'),
        onReject: (reason) => decideReview('reject', reason),
        // A10 / ux-inventory Table C: Reject is called "Reject" on every
        // surface — the `<ActionRow>` default — so this one no longer says
        // "Request changes" while the identical mechanism in the Release
        // workspace says "Reject". The verb it sends is still
        // `request_changes`; the receipt is where the object-store wording
        // belongs, not the button.
        //
        // A4, per button: Approve and Reject do not always share an
        // availability, so each carries its own reason rather than one of
        // them borrowing the other's.
        ...(controls.approve.enabled ? {} : { approveDisabledReason: controls.approve.reason }),
        ...(controls.request_changes.enabled ? {} : { rejectDisabledReason: controls.request_changes.reason }),
        // Reason capture is asked of the façade rather than hardcoded: the
        // object store DOES carry the reviewer's words on a rejection
        // (`review_decide`'s `note`), so the textarea swap is right here —
        // but the same `<ActionRow>` rendering a mechanism that drops them
        // gets `'none'` and decides on the first click instead. Independent
        // of the per-button disabled reasons above: a button can be
        // unavailable AND its mechanism reason-less.
        rejectReason: decisionAvailability(reviewTarget).reasonReaches.reject ? 'optional' : 'none',
        secondary: reopening ? (
          // A1's missing control, rendered next to the copy that names it.
          <GatedButton control={controls.reopen_review} onClick={doSubmitReview} loading={busy}>
            Re-open review
          </GatedButton>
        ) : (
          <GatedButton control={controls.submit_review} onClick={doSubmitReview} loading={busy}>
            Submit for review
          </GatedButton>
        ),
      }}
    />
  );

  const contentTab = (
    <div className="flex flex-col gap-4">
      <section
        className="flex min-h-0 flex-col overflow-hidden rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)]"
        aria-label={`${objectTypeLabel(record.object_type)} preview`}
        data-stage-mode={stageMode}
      >
        <div className="border-b border-[var(--adm-border)] bg-[var(--adm-surface)] px-4 py-2">
          <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
            Object Stage
          </p>
          <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {chat.previewCandidate
              ? `Comparing version ${chat.previewCandidate.label}`
              : objectTypeLabel(record.object_type)}
          </p>
          {record.object_type === 'page' ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Page section focus">
              <button
                type="button"
                onClick={() => {
                  setFocus({ kind: 'object', label: '' });
                  setComposerSeed(undefined);
                }}
                className={`adm-focusable rounded-full border px-2.5 py-1 text-[length:var(--adm-text-xs)] ${focus.kind === 'object' ? 'border-[var(--adm-accent)] bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]' : 'border-[var(--adm-border)] text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]'}`}
              >
                Page
              </button>
              {pageSections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => {
                    setFocus({ kind: 'section', label: section.label, sectionId: section.id });
                    setComposerSeed(undefined);
                  }}
                  className={`adm-focusable rounded-full border px-2.5 py-1 text-[length:var(--adm-text-xs)] ${focus.sectionId === section.id ? 'border-[var(--adm-accent)] bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]' : 'border-[var(--adm-border)] text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]'}`}
                >
                  {section.label}
                </button>
              ))}
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<IconPlus size={14} />}
                onClick={() => beginAdd('new-section')}
                disabled={agentOccupied}
              >
                Add section
              </Button>
            </div>
          ) : record.object_type === 'navigation' ? (
            <div className="mt-2">
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<IconPlus size={14} />}
                onClick={() => beginAdd('navigation-item')}
                disabled={agentOccupied}
              >
                Add item
              </Button>
            </div>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {chat.candidateSet && chat.previewCandidate ? (
            <CandidateStage
              set={chat.candidateSet}
              selected={chat.previewCandidate}
              currentText={currentCandidateText(record, focus.sectionId)}
              busy={chat.busy}
              onPreview={chat.preview}
              onChoose={(candidateId) => void chat.chooseCandidate(candidateId)}
            />
          ) : (
            <div className={objectStageModeClass(stageMode)}>
              <ObjectLens record={record} focusId={focus.sectionId} />
            </div>
          )}
        </div>
        {sequentialProposal ? (
          <div className="sticky bottom-0 shrink-0 border-t border-[var(--adm-border)] bg-[var(--adm-surface)] px-4 py-3">
            {chat.pendingConsumed ? (
              <p className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-muted)]">
                Approved — waiting for the agent…
              </p>
            ) : (
              /* The chat tool-call decision (T0.1 §6.2), rendered through the
                 same T1.2 <ActionRow> the review decision above uses, so both
                 decisions on this page read as one vocabulary. */
              <ActionRow
                approveLabel="Save"
                /* A10 / ux-inventory Table C: this was the last surface still
                   calling Reject something else ("Ask for changes"). Approve
                   keeps its domain verb — the proposal is literally saved, and
                   it pairs with "Save & Add Next" — but the non-approve action
                   is "Reject" here as everywhere else. */
                rejectLabel="Reject"
                onApprove={() => saveSequentialProposal(false)}
                onReject={async (reason) => {
                  if (chat.pending) {
                    await chat.deny(chat.pending.call_id, reason ?? 'Please revise this proposal before saving.');
                  }
                }}
                {...(chat.busy ? { disabledReason: 'The agent is still working on this proposal.' } : {})}
                secondary={
                  <Button size="sm" onClick={() => void saveSequentialProposal(true)} loading={chat.busy}>
                    Save &amp; Add Next
                  </Button>
                }
              />
            )}
          </div>
        ) : null}
      </section>

      {/* D2 — text-like objects: a direct form AND chat, over the same verbs. */}
      {editMode === 'form' && objectFormFields(record.object_type).length > 0 ? (
        <Card kicker="Direct edit" title="Fields">
          <ObjectDetailForm
            record={record}
            getToken={getToken}
            {...(controls.edit_fields.enabled ? {} : { disabledReason: controls.edit_fields.reason })}
            onSaved={async () => {
              void invalidateLibraryCache();
              await load();
            }}
          />
        </Card>
      ) : (
        <Card kicker="Direct edit" title="Not available for this type">
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{controls.edit_fields.reason}</p>
        </Card>
      )}

      {isContentItem ? (
        <ArticleTaxonomyCard
          record={record}
          identity={identity}
          {...(controls.edit_fields.enabled ? {} : { disabledReason: controls.edit_fields.reason })}
          onSaved={async () => {
            await load();
          }}
        />
      ) : null}
    </div>
  );

  const versionsTab =
    versions.length === 0 ? (
      <EmptyState
        title="No versions yet"
        message="Edits, publishes and review decisions on this object will appear here."
      />
    ) : (
      <ol className="flex flex-col gap-2">
        {versions.map((version) => (
          <li
            key={`${version.historyIndex}-${version.at}`}
            className="flex flex-col gap-1 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <SeverityIcon
                level={version.kind === 'publish' ? 'success' : version.kind === 'discard' ? 'error' : 'info'}
                size={14}
                title=""
              />
              <span className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">{version.summary}</span>
              {version.isCurrentPublish ? <Badge tone="success">Current publish</Badge> : null}
            </div>
            <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              {version.actor} · {new Date(version.at).toLocaleString()}
              {version.changedFields.length > 0 ? ` · ${version.changedFields.join(', ')}` : ''}
            </p>
          </li>
        ))}
      </ol>
    );

  const usageTab = (
    <EmptyState
      icon={<IconWrench size={26} />}
      title="Nothing tracks where this object is used"
      message={usage.message}
      action={
        <div className="text-left text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          <p className="mb-1 font-medium text-[var(--adm-text)]">What would fill this tab:</p>
          <ul className="list-disc pl-5">
            {usage.wouldBePopulatedBy.map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        </div>
      }
    />
  );

  const activityTab = (
    <div className="flex flex-col gap-3">
      <HistoryTimeline entries={activity} now={now || undefined} />
      <DetailSection title="Comments">
        <MarginaliaThreadList objectType={record.object_type} objectId={record.object_id} />
      </DetailSection>
      {owner ? (
        <DetailSection title="Raw record">
          <pre className="max-h-[28rem] overflow-auto rounded-[var(--adm-radius-md)] bg-[var(--adm-surface-sunken)] p-3 text-[length:var(--adm-text-xs)] text-[var(--adm-text)]">
            {JSON.stringify(record, null, 2)}
          </pre>
        </DetailSection>
      ) : null}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Breadcrumbs
            items={[
              { label: 'Editorial', href: '/admin' },
              { label: 'Objects', href: '/admin/objects' },
              { label: objectTypeLabel(record.object_type) },
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <InlineFieldEdit
              record={record}
              fieldId={titleField ?? 'title'}
              label="Title"
              {...(controls.edit_fields.enabled && titleField
                ? {}
                : {
                    disabledReason: controls.edit_fields.reason ?? 'This type has no title field the form can write.',
                  })}
              onSaved={async () => {
                void invalidateLibraryCache();
                await load();
              }}
            >
              <h1
                className="truncate text-[length:var(--adm-text-2xl)] font-semibold text-[var(--adm-text-heading)]"
                title={idTooltip(record.object_id)}
              >
                {displayName}
              </h1>
            </InlineFieldEdit>
          </div>
          {excerptField ? (
            <div className="mt-1 max-w-[46rem]">
              <InlineFieldEdit
                record={record}
                fieldId={excerptField}
                label="Excerpt"
                {...(controls.edit_fields.enabled ? {} : { disabledReason: controls.edit_fields.reason })}
                onSaved={async () => {
                  void invalidateLibraryCache();
                  await load();
                }}
              >
                <span className="truncate text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                  {String((record.body as { description?: unknown }).description ?? '') || 'Add an excerpt'}
                </span>
              </InlineFieldEdit>
            </div>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusPill status={status.label} tone={status.tone} label={status.label} />
            {workState ? (
              <Badge tone={workState === 'Failed' ? 'danger' : workState === 'Working' ? 'info' : 'warning'}>
                {workState === 'Working' ? <span className="mr-1 inline-block animate-pulse">●</span> : null}
                {workState}
              </Badge>
            ) : null}
            {lockHeld ? (
              <span
                role="status"
                aria-label={`Checked out by ${lockOwnerLabel ?? 'another editor'}`}
                title={`Checked out by ${lockOwnerLabel ?? 'another editor'}. This status refreshes automatically.`}
                className="inline-grid h-6 w-6 place-items-center rounded-full border border-[var(--adm-border-strong)] bg-[var(--adm-surface-sunken)] text-[var(--adm-warning-text)]"
              >
                <IconLock size={13} />
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!expandedWorkspace ? (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<IconSparkles size={16} />}
              onClick={() => setAgentOpen(true)}
            >
              Publishing Agent
            </Button>
          ) : null}
          <DropdownMenu
            align="end"
            trigger={({ ref, onToggle, open }) => (
              <button
                ref={ref}
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                aria-label="More object actions"
                className="adm-focusable grid h-8 w-8 place-items-center rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]"
              >
                <IconDots size={17} />
              </button>
            )}
            items={OBJECT_CONTROL_IDS.filter(
              (id): id is Extract<ObjectControlId, 'new_variant' | 'release_lock' | 'retire' | 'discard'> =>
                id === 'new_variant' || id === 'release_lock' || id === 'retire' || id === 'discard'
            ).map((id) => {
              const control = controls[id];
              const label =
                id === 'new_variant'
                  ? 'New variant'
                  : id === 'release_lock'
                    ? 'Release lock'
                    : id === 'retire'
                      ? 'Retire object'
                      : 'Discard changes';
              return {
                id,
                label,
                disabled: !control.enabled,
                ...(control.reason ? { title: control.reason } : {}),
                ...(id === 'discard' ? { tone: 'danger' as const, separatorBefore: true } : {}),
                ...(id === 'new_variant' ? { icon: <IconPlus size={16} /> } : {}),
                ...(id === 'release_lock' ? { icon: <IconLock size={16} /> } : {}),
                onSelect: () => {
                  if (!control.enabled) return;
                  if (id === 'new_variant') void doNewVariant();
                  else if (id === 'release_lock') void doTakeOver();
                  else if (id === 'discard') setConfirmDiscard(true);
                },
              };
            })}
          />
        </div>
      </div>

      {/* Action surface — quick-action chips + the primary publish control. */}
      <div className="flex flex-wrap items-center gap-2 rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-3 py-2">
        <QuickActionChips
          row={quickActionRow}
          roles={currentUser.roles}
          variant="button"
          /* Publish, Submit for review and New variant already exist on this
             surface as gated controls that render disabled WITH A REASON
             (`object-detail-actions.ts`), which is the better affordance
             where the object is the subject of the page. The chips add what
             that set has no entry for. */
          exclude={['publish', 'submit_review', 'new_variant']}
          /* This surface already has the object's chat in the rail, so a
             hand-off seeds that composer (T2.2 left `composerSeed` wired to
             `ChatComposer`'s `draftSeed` for exactly this) instead of
             navigating the editor away from the record. */
          onSeedComposer={(prompt) => setComposerSeed({ key: `quick-${Date.now()}`, text: prompt })}
          onChanged={() => void load()}
        />
        {url ? (
          <a
            href={`${url}?edit=1`}
            className="adm-focusable inline-flex items-center gap-1.5 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] px-3 py-1.5 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]"
          >
            <IconExternalLink size={16} /> Edit on site
          </a>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {lifecycle === 'published' ? (
            // T0.3 Table C: matches EDITORIAL_STATE_PRESENTATION.published's
            // tone (info, not warning) — this literal used to bypass that
            // shared table and drift to amber on its own.
            <a
              href="/admin/release"
              className="adm-focusable rounded text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-info-text)] hover:underline"
            >
              Published · waiting for release
            </a>
          ) : lifecycle === 'live' ? (
            <Badge tone="success">Live</Badge>
          ) : null}
          {lifecycle === 'unknown' ? (
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              Retry release state
            </Button>
          ) : null}
          <GatedButton
            control={controls.publish}
            variant="primary"
            leftIcon={<IconRocket size={16} />}
            onClick={doPublish}
            loading={busy}
          >
            Publish
          </GatedButton>
        </div>
      </div>

      {reviewPanel}

      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <Tabs
            value={tab}
            onChange={(next) => setTab(parseDetailTab(next))}
            tabs={[
              { id: 'content', label: 'Content', content: contentTab },
              { id: 'versions', label: 'Versions', content: versionsTab },
              { id: 'usage', label: 'Usage', content: usageTab },
              { id: 'activity', label: 'Activity', content: activityTab },
            ]}
          />
        </div>
        {/* The dock: sticky while the content scrolls. */}
        {expandedWorkspace ? (
          <div
            className={cn('sticky top-4 self-start', dockCollapsed ? 'w-12' : 'w-[24rem]')}
            aria-label="Contextual agent dock"
          >
            {agentRail}
          </div>
        ) : null}
      </div>

      {!expandedWorkspace ? (
        <Drawer open={agentOpen} onClose={() => setAgentOpen(false)} title="Publishing Agent" width={480}>
          {agentOpen ? agentRail : null}
        </Drawer>
      ) : null}

      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={doDiscard}
        title="Discard changes?"
        message="This reverts the working copy to the last published state. This cannot be undone."
        confirmLabel="Discard"
        tone="danger"
      />
    </div>
  );
}

export interface ObjectWorkspaceProps {
  identity: SiteIdentity;
}

export default function ObjectWorkspace({ identity }: ObjectWorkspaceProps) {
  return (
    <AdminShell currentPath="/admin/objects" title="Object detail" identity={identity} wide>
      <WorkspaceBody identity={identity} />
    </AdminShell>
  );
}
