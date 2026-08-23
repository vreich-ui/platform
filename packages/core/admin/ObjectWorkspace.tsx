/**
 * ObjectWorkspace (T9.9) — the object-first editorial surface that replaces
 * the machine-centered /admin/objects page. The selected object stays visible
 * in a unified stage while its agent remains scoped alongside it; operational
 * details, readiness, history, and raw data live in the Details drawer.
 *
 * Field-level WRITE editing across the ten discriminated-union schemas is
 * wired through the tested op-builder (inspector-ops.ts, with the trap #2
 * null-out) but its per-type field→op mapping is verified on the deployed site
 * (the brief's scripted per-type drive) — until then the inspector generates a
 * read view and points visual edits at the canvas.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Breadcrumbs, Button, Card, EmptyState, StatusPill, Skeleton } from './primitives';
import { DropdownMenu, Tabs } from './menus';
import { Input, Select, Textarea } from './forms';
import { ConfirmDialog, Drawer, useToast } from './overlays';
import { HistoryTimeline, ReadinessList } from './data';
import { ObjectLens, objectLensMode } from './ObjectLensRegistry';
import { ObjectBrowser } from './ObjectBrowser';
import { AgentRail } from './AgentRail';
import { CandidateStage } from './CandidateStage';
import { cn } from './utils';
import { useChat } from './chat';
import { createObjectChat } from '@core/lib/admin/chat-client';
import { candidateAtShortcut, currentCandidateText } from '@core/lib/admin/candidate-choice';
import { MarginaliaThreadList } from './MarginaliaThreadList';
import {
  IconAlertTriangle,
  IconDots,
  IconExternalLink,
  IconLibrary,
  IconLock,
  IconPlus,
  IconRocket,
  IconSparkles,
  IconWrench,
} from './icons';
import { objectDisplayName, objectTypeLabel, idTooltip } from '@core/lib/admin/display-name';
import { resolveWorkspaceObjectType } from '@core/lib/admin/object-type-resolve';
import type { ObjectType, ObjectRecord, HistoryEntry } from '@core/schema/object-record-v1';
import type { ReadinessGroup, CriterionStatus } from '@core/lib/admin/readiness-criteria';
import { useCurrentUser } from '@core/lib/admin/use-current-user';
import { objectStageModeClass } from '@core/lib/admin/object-stage';
import { releaseAwareLifecyclePresentation, resolveReleaseAwareLifecycle } from '@core/lib/admin/editorial-state';
import { fetchReleaseOverview, type ReleaseObjectView } from '@core/lib/admin/release-client';
import { pageSectionLabel } from '@core/lib/admin/preview-logic';
import { reviewerAvailableActions, type Role as ReviewerRole } from '@core/lib/admin/object-review-ui';
import {
  WORKSPACE_COMPACT_PANEL_CLASS,
  WORKSPACE_EXPANDED_GRID_CLASS,
  WORKSPACE_EXPANDED_MIN_WIDTH,
  WORKSPACE_EXPANDED_PANEL_CLASS,
} from '@core/lib/admin/responsive-workspace';
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
async function invalidateLibraryCache(): Promise<void> {
  const { invalidateInventoryCache } = await import('@core/lib/admin/library-client');
  invalidateInventoryCache();
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

function parseLocation(): { id: string; type: ObjectType | undefined } {
  const segment = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).at(-1) ?? '');
  const type = new URLSearchParams(window.location.search).get('type') as ObjectType | null;
  return { id: segment, type: type ?? undefined };
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

// ─── article settings (T9.20 workspace parity with the canvas panel)
// Same fields, same registry-backed pickers, same edit-time contract
// validation — all through set_article_meta under EditSession.

function ArticleSettingsCard({
  record,
  onSaved,
  identity,
}: {
  record: Rec;
  onSaved: () => void;
  identity: SiteIdentity;
}) {
  const { toast } = useToast();
  const body = record.body ?? {};
  const taxonomy = (body.taxonomy ?? {}) as { category?: string; tags?: string[] };
  const seo = (body.seo ?? {}) as { description?: string };
  const [slug, setSlug] = useState(String(body.slug ?? ''));
  const [author, setAuthor] = useState(String(body.author ?? ''));
  const [description, setDescription] = useState(String(body.description ?? ''));
  const [category, setCategory] = useState(taxonomy.category ?? '');
  const [tags, setTags] = useState((taxonomy.tags ?? []).join(', '));
  const [seoDescription, setSeoDescription] = useState(seo.description ?? '');
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

  const slugValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim());
  const enteredTags = tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const novelTags = enteredTags.filter((tag) => registry.tags.length > 0 && !registry.tags.includes(tag));

  const save = async () => {
    setBusy(true);
    try {
      const fields: Record<string, unknown> = {};
      if (slug.trim() && slug.trim() !== body.slug) fields.slug = slug.trim();
      if (author.trim() !== String(body.author ?? '')) {
        fields.author = author.trim() === '' ? null : author.trim();
      }
      if (description.trim() !== String(body.description ?? '')) {
        fields.description = description.trim() === '' ? null : description.trim();
      }
      if (category !== (taxonomy.category ?? '') || enteredTags.join('\n') !== (taxonomy.tags ?? []).join('\n')) {
        fields.taxonomy = { ...(category ? { category } : { category: null }), tags: enteredTags };
      }
      if (seoDescription.trim() !== (seo.description ?? '')) {
        fields.seo = { description: seoDescription.trim() === '' ? null : seoDescription.trim() };
      }
      if (Object.keys(fields).length === 0) {
        toast({ title: 'Nothing changed', tone: 'info' });
        return;
      }
      const { callObjectVerb, EditSession } = await import('@core/lib/edit-mode/verbs-client');
      // Edit-time contract validation (slug uniqueness vs committed posts) —
      // the same shared validation messages the canvas panel shows.
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
      const session = new EditSession(record.object_type, record.object_id, getToken);
      const checkout = await session.ensureCheckout();
      if (!checkout.ok) {
        toast({
          title: 'Locked',
          description: checkout.heldBy ? `Held by ${checkout.heldBy}.` : undefined,
          tone: 'warning',
        });
        return;
      }
      const outcome = await session.patch([{ op: 'set_article_meta', fields }]);
      await session.checkin();
      if (outcome.ok) {
        void invalidateLibraryCache();
        toast({ title: 'Article settings saved as a draft', tone: 'success' });
        onSaved();
      } else {
        toast({ title: 'Not saved', description: outcome.error, tone: 'danger' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] p-3">
      <p className="text-[length:var(--adm-text-sm)] font-semibold text-[var(--adm-text-heading)]">Article settings</p>
      <Input
        label="Slug"
        value={slug}
        onChange={(event) => setSlug(event.target.value)}
        error={slug && !slugValid ? 'Lowercase letters, digits, single hyphens.' : undefined}
        hint="Unique across articles; validated on save."
      />
      <Input
        label="Author"
        value={author}
        maxLength={120}
        onChange={(event) => setAuthor(event.target.value)}
        hint="Shown as the byline; leave blank to omit."
      />
      <Textarea
        label="Description (deck)"
        rows={2}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <Select
        label="Category"
        value={category}
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
        onChange={(event) => setTags(event.target.value)}
        hint={
          novelTags.length > 0
            ? `Not in the registry (needed before publish): ${novelTags.join(', ')}`
            : 'Comma-separated; registry terms resolve at publish.'
        }
      />
      <Textarea
        label="SEO description"
        rows={2}
        value={seoDescription}
        onChange={(event) => setSeoDescription(event.target.value)}
        hint={`${seoDescription.length}/160 characters.`}
      />
      <Button size="sm" className="self-start" onClick={() => void save()} loading={busy}>
        Save draft
      </Button>
    </div>
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

// ─── workspace body

function WorkspaceBody({ identity }: { identity: SiteIdentity }) {
  const { toast } = useToast();
  const [record, setRecord] = useState<Rec | null>(null);
  const [releaseObject, setReleaseObject] = useState<ReleaseObjectView>();
  const [readiness, setReadiness] = useState<ReadinessGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [publicationOpen, setPublicationOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [expandedWorkspace, setExpandedWorkspace] = useState(false);
  const [now, setNow] = useState(0);
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  const [focus, setFocus] = useState<WorkspaceFocus>({ kind: 'object', label: '' });
  const [composerSeed, setComposerSeed] = useState<{ key: string; text: string } | undefined>(undefined);
  const seedSequence = useRef(0);
  // Bumped after publish/approve and on every chat write-stamp — the sole
  // refresh signal ObjectBrowser needs to re-fetch instead of showing a
  // contradictory state next to this workspace after an action here.
  const [browserRefresh, setBrowserRefresh] = useState(0);
  const [loc] = useState(() => (typeof window === 'undefined' ? { id: '', type: undefined } : parseLocation()));
  // The resolved object type: `?type=` when the library link supplied it,
  // otherwise derived from the id (prefix map + inventory fallback, W15 S1).
  const typeRef = useRef<ObjectType | undefined>(loc.type);
  const chat = useChat(getToken, chatId);
  const currentUser = useCurrentUser();
  const owner = currentUser.roles.includes('owner') || currentUser.user?.role === 'owner';

  // Supporting panels must not mount twice: AgentRail owns approval effects,
  // so the desktop rail and drawer rail are mutually exclusive at runtime.
  useEffect(() => {
    const media = window.matchMedia(`(min-width: ${WORKSPACE_EXPANDED_MIN_WIDTH}px)`);
    const sync = () => {
      setExpandedWorkspace(media.matches);
      if (media.matches) {
        setPublicationOpen(false);
        setAgentOpen(false);
      }
    };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  const load = async (): Promise<Rec | undefined> => {
    const type = typeRef.current;
    if (!loc.id || !type) {
      setError('This object could not be identified. Open it from the content library.');
      setLoading(false);
      return undefined;
    }
    const { getObjectRecord, callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
    const { record } = await getObjectRecord(getToken, type, loc.id);
    if (!record) {
      setError(`${objectTypeLabel(type)} "${loc.id}" was not found.`);
      setLoading(false);
      return undefined;
    }
    setRecord(record as Rec);
    try {
      const overview = await fetchReleaseOverview(getToken);
      setReleaseObject(overview.objects.find((object) => object.object_id === loc.id));
    } catch {
      setReleaseObject(undefined);
    }
    setLoading(false);
    // readiness (best-effort)
    try {
      const res = await callObjectVerb(getToken, { action: 'validate', object_type: type, object_id: loc.id });
      setReadiness(readinessFromValidate(res.body ?? {}));
    } catch {
      setReadiness(null);
    }
    return record as Rec;
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
          setError(`"${loc.id}" was not found in the content library.`);
          setLoading(false);
          return;
        }
      }
      const loadedRecord = await load();
      // Chat-first (T9.14): the per-object conversation opens with the page.
      if (loc.id && typeRef.current) {
        createObjectChat(getToken, typeRef.current, loc.id, loadedRecord ? objectDisplayName(loadedRecord) : undefined)
          .then(({ chat: created }) => setChatId(created.chat_id))
          .catch(() => setChatId(undefined));
      }
    })().catch((e) => {
      setError(e instanceof Error ? e.message : 'Could not load this object.');
      setLoading(false);
    });
  }, []);

  // Every accepted write refreshes the record — the preview re-renders and
  // readiness re-computes on each approved patch. Chat is the primary
  // editing surface here and its write tools overlap the mutating-verb list
  // (patch/create_variant/instantiate*/publish/discard/apply_theme) — the
  // library list needs the same invalidation these buttons get.
  useEffect(() => {
    if (chat.writeStamp > 0) {
      void invalidateLibraryCache();
      void load();
      setBrowserRefresh((n) => n + 1);
    }
  }, [chat.writeStamp]);

  // Locks are short-lived coordination state. Refresh only the record while a
  // lock is visible so an agent check-in clears the icon without a page reload.
  useEffect(() => {
    if (!record?.lock?.token || !typeRef.current) return;
    let active = true;
    const refreshLock = async () => {
      try {
        const { getObjectRecord } = await import('@core/lib/edit-mode/verbs-client');
        const result = await getObjectRecord(getToken, typeRef.current!, loc.id);
        if (active && result.record) setRecord(result.record as Rec);
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
        setBrowserRefresh((n) => n + 1);
      } else {
        toast({
          title: 'Publish blocked',
          description: String((res.body as { error?: string }).error ?? ''),
          tone: 'danger',
        });
      }
    });

  // Fixed defect: this used to auto-open a review (checkout → submit_review)
  // whenever one wasn't already 'open', silently re-opening and
  // self-approving an object sitting in `changes_requested`. The server verb
  // (review_decide) never required an open review in the first place — it
  // records a fresh decision from whatever state review is in — so this now
  // just decides. The Approve button itself only renders/enables per
  // `reviewerAvailableActions.canApprove` (below), which is the actual gate
  // against a silent re-decision; the server is the final authority either way.
  const doApprove = () =>
    runAction(async () => {
      if (!record) return;
      const { EditSession } = await import('@core/lib/edit-mode/verbs-client');
      const session = new EditSession(record.object_type, record.object_id, getToken);
      const approved = await session.approveReview();
      if (approved.status === 200) {
        void invalidateLibraryCache();
        toast({ title: 'Approved', tone: 'success' });
        await load();
        setBrowserRefresh((n) => n + 1);
      } else {
        toast({
          title: 'Approval blocked',
          description: String((approved.body as { error?: string }).error ?? ''),
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
        window.location.assign(`/admin/content/${encodeURIComponent(newId)}?type=content_item`);
      } else {
        toast({
          title: 'Could not create a variant',
          description: String((res.body as { error?: string }).error ?? ''),
          tone: 'danger',
        });
      }
    });

  const history = useMemo<HistoryEntry[]>(
    () => ((record?.history ?? []) as HistoryEntry[]).slice().reverse(),
    [record]
  );

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

  if (loading) return <Skeleton variant="rect" height={320} />;
  if (error || !record) {
    return (
      <Card>
        <EmptyState
          icon={<IconAlertTriangle size={26} />}
          title="Couldn't open this object"
          message={error ?? undefined}
          action={
            <Button variant="secondary" onClick={() => window.location.assign('/admin/content')}>
              Back to library
            </Button>
          }
        />
      </Card>
    );
  }

  // Fixed defect: this used to fall back to a client-computed lifecycle
  // (hardcoding production_confirmed:false and defaulting requires_approval
  // to false) whenever the release overview couldn't be loaded or didn't
  // list this object — fabricating a "Draft" pill and an unguarded Publish
  // button for objects that could actually be gated, or already live. Only a
  // server-confirmed release row is trustworthy here; anything else is
  // UNKNOWN, and unknown fails closed (below).
  const lifecycle = resolveReleaseAwareLifecycle(releaseObject);
  const status = releaseAwareLifecyclePresentation(lifecycle);
  const url = liveUrl(record);
  const lockHeld = Boolean(record.lock && record.lock.token);
  const isContentItem = record.object_type === 'content_item';
  const stageMode = objectLensMode(record.object_type);
  const reviewerRoles = currentUser.roles.filter(
    (role): role is ReviewerRole => role === 'admin' || role === 'publisher' || role === 'editor'
  );
  // Only ever computed from a server-confirmed release row — when
  // `releaseObject` is undefined (lifecycle 'unknown'), this stays undefined
  // and the action chooser below fails closed rather than rendering Publish.
  const availability =
    releaseObject !== undefined
      ? reviewerAvailableActions({
          objectType: record.object_type,
          principalKind: 'human',
          roles: reviewerRoles,
          hasActiveLock: lockHeld,
          review: record.review,
          contentRevision: record.content_revision,
          requiresApprovalOverride: releaseObject.requires_approval,
        })
      : undefined;
  const approvalDisabledReason =
    record.review?.state === 'changes_requested'
      ? 'Changes were requested on this review — resolve them, then re-open review before approving.'
      : reviewerRoles.length === 0
        ? 'You do not have review or publish authority for this object.'
        : 'Waiting on a review decision.';
  const displayName = objectDisplayName(record);
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
  const quickActions = quickContext
    ? contextActionsFor(quickContext).map((action) => ({
        id: action.id,
        label: action.label,
        text: action.buildContext(quickContext),
      }))
    : undefined;
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
  const agentRail = (
    <AgentRail
      chat={chat}
      focus={focusLabel}
      preferenceScope={`${currentUser.user?.email ?? 'anonymous'}:${record.object_id}`}
      suggestions={focus.kind === 'object' ? suggestions : undefined}
      contextActions={quickActions}
      draftSeed={composerSeed}
      approvalInStage={sequentialProposal}
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

  // `chat.approve` now carries its own consumed-call guard (chat.tsx) — a
  // second click here while the same call_id is already in flight is a
  // no-op there (approved: false), not a re-POST of a consumed call_id.
  const saveSequentialProposal = async (addNext: boolean) => {
    const pending = chat.pending;
    if (!pending) return;
    const outcome = await chat.approve(pending.call_id);
    if (!outcome.approved) return;
    // Task 5: execution is async now — success/failure arrives as a normal
    // `tool_result` event via the poll, not on this response.
    toast({ title: 'Section saved', tone: 'success' });
    if (addNext) beginAdd('new-section');
    else {
      setFocus({ kind: 'object', label: '' });
      setComposerSeed(undefined);
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <a
            href="/admin"
            className="adm-focusable mb-2 inline-flex rounded text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-accent)] hover:underline"
          >
            ← Publication
          </a>
          <Breadcrumbs
            items={[{ label: 'Editorial', href: '/admin' }, { label: objectTypeLabel(record.object_type) }]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <h1
              className="truncate text-[length:var(--adm-text-2xl)] font-semibold text-[var(--adm-text-heading)]"
              title={idTooltip(record.object_id)}
            >
              {objectDisplayName(record)}
            </h1>
          </div>
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
                aria-label={`Checked out by ${record.lock?.owner_label ?? 'another editor'}`}
                title={`Checked out by ${record.lock?.owner_label ?? 'another editor'}. This status refreshes automatically.`}
                className="inline-grid h-6 w-6 place-items-center rounded-full border border-[var(--adm-border-strong)] bg-[var(--adm-surface-sunken)] text-[var(--adm-warning-text)]"
              >
                <IconLock size={13} />
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
            items={[
              { id: 'details', label: 'Details', icon: <IconWrench size={16} />, onSelect: () => setDetailsOpen(true) },
              { id: 'activity', label: 'Activity', onSelect: () => setDetailsOpen(true) },
              ...(owner ? [{ id: 'raw', label: 'Raw', onSelect: () => setDetailsOpen(true) }] : []),
              ...(isContentItem
                ? [{ id: 'variant', label: 'New variant', icon: <IconPlus size={16} />, onSelect: doNewVariant }]
                : []),
              ...(lockHeld && owner
                ? [
                    {
                      id: 'release-lock',
                      label: 'Release lock',
                      icon: <IconLock size={16} />,
                      onSelect: doTakeOver,
                    },
                  ]
                : []),
              {
                id: 'discard',
                label: 'Discard changes',
                separatorBefore: true,
                tone: 'danger' as const,
                onSelect: () => setConfirmDiscard(true),
              },
            ]}
          />
        </div>
      </div>

      <div className={cn('mb-3 flex items-center justify-between gap-2', WORKSPACE_COMPACT_PANEL_CLASS)}>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<IconLibrary size={16} />}
          onClick={() => setPublicationOpen(true)}
        >
          Publication
        </Button>
        <Button size="sm" variant="secondary" leftIcon={<IconSparkles size={16} />} onClick={() => setAgentOpen(true)}>
          Publishing Agent
        </Button>
      </div>

      <div className={cn('grid min-h-0 gap-4', WORKSPACE_EXPANDED_GRID_CLASS)}>
        {expandedWorkspace ? (
          <div className={WORKSPACE_EXPANDED_PANEL_CLASS}>
            <ObjectBrowser activeId={record.object_id} refreshSignal={browserRefresh} />
          </div>
        ) : null}
        <section
          className="flex min-h-0 flex-col overflow-hidden rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] lg:h-[calc(100dvh-8rem)]"
          aria-label={`${objectTypeLabel(record.object_type)} workspace`}
          data-stage-mode={stageMode}
        >
          <div className="border-b border-[var(--adm-border)] bg-[var(--adm-surface)] px-4 py-2">
            <div>
              <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
                Object Stage
              </p>
              <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                {chat.previewCandidate
                  ? `Comparing version ${chat.previewCandidate.label}`
                  : objectTypeLabel(record.object_type)}
              </p>
            </div>
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
          <div className="sticky bottom-0 flex shrink-0 items-center justify-end gap-2 border-t border-[var(--adm-border)] bg-[var(--adm-surface)] px-4 py-3">
            {chat.candidateSet ? (
              <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                Preview a version, then pick it here or in the agent rail.
              </p>
            ) : sequentialProposal ? (
              chat.pendingConsumed ? (
                <p className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-muted)]">
                  Approved — waiting for the agent…
                </p>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      chat.pending && void chat.deny(chat.pending.call_id, 'Please revise this proposal before saving.')
                    }
                    disabled={chat.busy}
                  >
                    Ask for changes
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void saveSequentialProposal(false)}
                    loading={chat.busy}
                  >
                    Save
                  </Button>
                  <Button size="sm" onClick={() => void saveSequentialProposal(true)} loading={chat.busy}>
                    Save &amp; Add Next
                  </Button>
                </>
              )
            ) : (
              <>
                {url ? (
                  <a
                    href={`${url}?edit=1`}
                    className="adm-focusable inline-flex items-center gap-1.5 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] px-3 py-1.5 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]"
                  >
                    <IconExternalLink size={16} /> Edit on site
                  </a>
                ) : null}
                {lifecycle === 'published' ? (
                  <a
                    href="/admin/release"
                    className="adm-focusable rounded text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-warning-text)] hover:underline"
                  >
                    Published · waiting for release
                  </a>
                ) : lifecycle === 'live' ? (
                  <Badge tone="success">Live</Badge>
                ) : lifecycle === 'unknown' ? (
                  <span className="flex items-center gap-2">
                    <span
                      title="The release/approval state for this object couldn't be confirmed, so Publish is disabled until it can be."
                      className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-muted)]"
                    >
                      Publish status unknown
                    </span>
                    <Button size="sm" variant="secondary" onClick={() => void load()}>
                      Retry
                    </Button>
                  </span>
                ) : availability?.canPublish ? (
                  <Button size="sm" leftIcon={<IconRocket size={16} />} onClick={doPublish} loading={busy}>
                    Publish
                  </Button>
                ) : availability?.canApprove ? (
                  <Button size="sm" onClick={doApprove} loading={busy}>
                    Approve
                  </Button>
                ) : (
                  <span
                    title={approvalDisabledReason}
                    className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-muted)]"
                  >
                    {approvalDisabledReason}
                  </span>
                )}
              </>
            )}
          </div>
        </section>
        {expandedWorkspace ? <div className={WORKSPACE_EXPANDED_PANEL_CLASS}>{agentRail}</div> : null}
      </div>

      {!expandedWorkspace ? (
        <Drawer
          open={publicationOpen}
          onClose={() => setPublicationOpen(false)}
          title="Publication"
          side="left"
          width={360}
        >
          {publicationOpen ? <ObjectBrowser activeId={record.object_id} refreshSignal={browserRefresh} /> : null}
        </Drawer>
      ) : null}

      {!expandedWorkspace ? (
        <Drawer open={agentOpen} onClose={() => setAgentOpen(false)} title="Publishing Agent" width={480}>
          {agentOpen ? agentRail : null}
        </Drawer>
      ) : null}

      {/* Details drawer — the classic CMS forms, one click away, never gone. */}
      <Drawer open={detailsOpen} onClose={() => setDetailsOpen(false)} title="Details" width={560}>
        <div className="mb-4">
          <DedicatedAgentPicker objectId={record.object_id} owner={owner} />
        </div>
        {record.object_type === 'content_item' ? (
          <ArticleSettingsCard record={record} onSaved={() => void load()} identity={identity} />
        ) : null}
        <Tabs
          tabs={[
            { id: 'details', label: 'Details', content: <GeneratedInspector record={record} onEditOnSite={url} /> },
            { id: 'history', label: 'History', content: <HistoryTimeline entries={history} now={now || undefined} /> },
            {
              id: 'comments',
              label: 'Comments',
              content: <MarginaliaThreadList objectType={record.object_type} objectId={record.object_id} />,
            },
            ...(owner
              ? [
                  {
                    id: 'raw',
                    label: 'Raw',
                    content: (
                      <pre className="max-h-[28rem] overflow-auto rounded-[var(--adm-radius-md)] bg-[var(--adm-surface-sunken)] p-3 text-[length:var(--adm-text-xs)] text-[var(--adm-text)]">
                        {JSON.stringify(record, null, 2)}
                      </pre>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Drawer>

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
    <AdminShell currentPath="/admin/content" title="Object workspace" identity={identity} wide>
      <WorkspaceBody identity={identity} />
    </AdminShell>
  );
}
