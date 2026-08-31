/**
 * Kit gallery island (T9.2) — renders every admin-ui component in its states,
 * with a light/dark toggle. This is the visual-regression surface and the
 * brief-writers' reference. It also demonstrates the identity module by
 * running objectDisplayName over sample records of all ten object types.
 */
import type { SiteIdentity } from '../lib/site-identity.js';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { AdminShell } from './AdminShell';
import { Markdown } from './Markdown';
import { MicButton } from './MicButton';
import {
  Button,
  IconButton,
  Badge,
  StatusPill,
  Card,
  StatCard,
  Avatar,
  Skeleton,
  EmptyState,
  Breadcrumbs,
  Input,
  Textarea,
  Select,
  Switch,
  TaxonomyPicker,
  Tabs,
  DropdownMenu,
  CommandPalette,
  Dialog,
  ConfirmDialog,
  Drawer,
  Popover,
  useToast,
  DataTable,
  DiffView,
  ReadinessList,
  LockBanner,
  ApprovalCard,
  RunProgress,
  HistoryTimeline,
  Tree,
  IconPlus,
  IconTrash,
  IconPencil,
  IconDots,
  IconExternalLink,
  IconChevronDown,
  SeverityIcon,
  StatusBadge,
  SeverityCountPill,
  type Column,
} from './index';
import { SEVERITY, severityCopy, type AdminSeverity } from '@core/lib/admin/severity';
import type { ReadinessGroup } from '@core/lib/admin/readiness-criteria';
import type { HistoryEntry, ObjectType } from '@core/schema/object-record-v1';
import { objectDisplayName, objectTypeLabel, idTooltip } from '@core/lib/admin/display-name';

const FIXED_NOW = Date.parse('2026-07-17T12:00:00.000Z');

/** D4 demo fixture (T1.1) — one copy-tone example per level, using the templates
 * `severityCopy` implements. Order matches `SEVERITY`'s worst-first ranking. */
const SEVERITY_DEMO: ReadonlyArray<{ level: AdminSeverity; copy: string }> = [
  {
    level: 'blocked',
    copy: severityCopy('blocked', {
      cause: 'the object has no signed-in approver and none is configured',
      escape: 'ask an admin to grant approval rights for this object',
    }),
  },
  {
    level: 'error',
    copy: severityCopy('error', { subject: 'Publishing', escape: 'retry the step' }),
  },
  {
    level: 'needs_you',
    copy: severityCopy('needs_you', { action: 'approve the pending release before it ships' }),
  },
  {
    level: 'info',
    copy: severityCopy('info', { subject: 'The draft', action: 'was saved automatically' }),
  },
  {
    level: 'success',
    copy: severityCopy('success', { subject: 'The article', action: 'was published' }),
  },
];

/** T1.2 `ActionRow` demo fixture — a plain endpoint-agnostic async callback,
 * exactly the shape T3.2 will point at whichever of the three decision
 * mechanisms (`review_decide` / `approve_tool`/`deny_tool` / `decideRunPublish`)
 * applies. Resolves after a short delay and surfaces the result via the same
 * shared toast the rest of the kit gallery uses. */
async function demoDecision(toast: ReturnType<typeof useToast>['toast'], verb: string, reason?: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 700));
  toast({ title: verb, description: reason, tone: verb === 'Rejected' ? 'warning' : 'success' });
}

/** Deliberately rejects, to demonstrate `ActionRow` returning to rest and
 * surfacing the failure as a toast rather than leaving the button spinning. */
async function demoDecisionFailure(verb: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 700));
  throw new Error(`${verb} failed — the publish service is still down (demo).`);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">{title}</h2>
      <div className="flex flex-col gap-3 rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface)] p-4">
        {children}
      </div>
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

// ─── sample data ──────────────────────────────────────────────────────────────

const READINESS: ReadinessGroup[] = [
  {
    id: 'content',
    label: 'Content',
    criteria: [
      { id: 'title', label: 'Title', status: 'complete', message: 'Present and within length.' },
      { id: 'excerpt', label: 'Excerpt', status: 'warning', message: 'Shorter than recommended.' },
      { id: 'body', label: 'Body sections', status: 'complete', message: 'Intro, body, and conclusion detected.' },
    ],
  },
  {
    id: 'seo',
    label: 'SEO',
    criteria: [
      { id: 'meta', label: 'Meta description', status: 'missing', message: 'Add a meta description to publish.' },
      { id: 'slug', label: 'Slug', status: 'complete', message: 'Valid, unique slug.' },
      { id: 'image', label: 'Social image', status: 'optional', message: 'Optional but recommended.' },
    ],
  },
];

const HISTORY: HistoryEntry[] = [
  {
    at: '2026-07-17T11:58:00.000Z',
    action: 'publish',
    actor: { kind: 'agent', agent_name: 'final_article', auth: 'publish_key' },
  },
  {
    at: '2026-07-17T09:30:00.000Z',
    action: 'review_decide',
    actor: { kind: 'human', id: 'u1', email: 'wolf@kugelbrands.com' },
    details: { decision: 'approve' },
  },
  {
    at: '2026-07-15T14:00:00.000Z',
    action: 'checkout',
    actor: { kind: 'human', id: 'u2', email: 'alex.rivera@example.com' },
  },
  {
    at: '2026-07-14T10:00:00.000Z',
    action: 'create',
    actor: { kind: 'human', id: 'u2', email: 'alex.rivera@example.com' },
  },
];

interface DemoRow {
  name: string;
  type: string;
  status: string;
  updated: string;
}

const TABLE_ROWS: DemoRow[] = [
  { name: 'The three-step routine', type: 'Article', status: 'published', updated: '2026-07-16' },
  { name: 'Barrier Repair Guide', type: 'Product', status: 'draft', updated: '2026-07-15' },
  { name: 'Interior page', type: 'Page template', status: 'active', updated: '2026-07-10' },
  { name: 'Why This Blog Exists', type: 'Section', status: 'archived', updated: '2026-07-02' },
];

const TABLE_COLUMNS: Column<DemoRow>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'type', header: 'Type', sortable: true },
  { key: 'status', header: 'Status', sortable: true, render: (r) => <StatusPill status={r.status} /> },
  { key: 'updated', header: 'Updated', sortable: true, align: 'right' },
];

// Sample records covering all ten object types — proves objectDisplayName.
// D2: takes the server-resolved identity as a parameter (rather than calling
// getSiteIdentity() at module load) so the taxonomy/site/theme sample ids
// reflect this deployment's real identity, env overrides included, instead
// of whatever happened to be baked into the client bundle at build time.
const buildDisplaySamples = (
  identity: SiteIdentity
): Array<{ object_type: ObjectType; object_id: string; body: unknown }> => [
  { object_type: 'page', object_id: 'page_404', body: { title: 'Page Not Found', route: '/404' } },
  {
    object_type: 'section',
    object_id: 'sec_about_blog',
    body: { section: { id: 's_blog', data: { body: '<h2>Why This Blog Exists</h2>' } } },
  },
  { object_type: 'navigation', object_id: 'nav_footer', body: { role: 'footer', brand: {} } },
  { object_type: 'taxonomy', object_id: identity.taxonomyId, body: { kinds: { category: {}, tag: {} } } },
  { object_type: 'site', object_id: identity.siteId, body: { name: identity.brandName } },
  { object_type: 'template', object_id: 'tpl_interior', body: { name: 'Interior page' } },
  { object_type: 'section_template', object_id: 'stpl_audience_grid', body: { name: 'Audience grid' } },
  { object_type: 'theme', object_id: `thm_${identity.siteShortId}_default`, body: { name: 'Default theme' } },
  {
    object_type: 'product',
    object_id: 'prod_barrier',
    body: { slug: 'barrier-repair-guide', presentation: { title: 'The Barrier Repair Guide' } },
  },
  {
    object_type: 'content_item',
    object_id: 'req_agent_minimal_routine_20260713_01',
    body: { title: 'The three-step routine that is genuinely enough' },
  },
];

const TAXONOMY_KINDS = [
  {
    kind: 'category',
    terms: [
      { term_id: 't_skinhealth', label: 'Skin Health' },
      { term_id: 't_industry', label: 'Industry' },
    ],
  },
  {
    kind: 'tag',
    terms: [
      { term_id: 't_barrier', label: 'Barrier' },
      { term_id: 't_routine', label: 'Routine' },
    ],
  },
];

// ─── interactive gallery body (inside AdminShell's ToastProvider) ────────────

function GalleryBody({ identity }: { identity: SiteIdentity }) {
  const { toast } = useToast();
  const displaySamples = buildDisplaySamples(identity);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [switchOn, setSwitchOn] = useState(true);
  const [terms, setTerms] = useState<string[]>(['t_barrier']);
  const [micListening, setMicListening] = useState(false);

  return (
    <div className="flex flex-col gap-8">
      <Section title="Buttons">
        <Row>
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
        </Row>
        <Row>
          <Button size="sm" leftIcon={<IconPlus size={16} />}>
            New
          </Button>
          <Button variant="secondary" size="sm" rightIcon={<IconChevronDown size={16} />}>
            Options
          </Button>
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
        </Row>
        <Row>
          <IconButton label="Edit" icon={<IconPencil size={18} />} />
          <IconButton label="More" icon={<IconDots size={18} />} variant="secondary" />
          <IconButton label="Delete" icon={<IconTrash size={18} />} variant="danger" />
        </Row>
      </Section>

      <Section title="Badges & status">
        <Row>
          <Badge>Neutral</Badge>
          <Badge tone="accent">Accent</Badge>
          <Badge tone="success">Success</Badge>
          <Badge tone="warning">Warning</Badge>
          <Badge tone="danger">Danger</Badge>
          <Badge tone="info">Info</Badge>
        </Row>
        <Row>
          <StatusPill status="published" />
          <StatusPill status="draft" />
          <StatusPill status="changes_requested" />
          <StatusPill status="archived" />
          <StatusPill status="failed" />
        </Row>
      </Section>

      <Section title="Severity (D4) — one source of truth">
        <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          All five levels, in worst-first order. Colors and glyphs come only from <code>SEVERITY</code> — Error and
          Blocked deliberately share red, distinguished by icon alone (circle-! vs. octagon), never by a second red.
        </p>
        <Row>
          {SEVERITY_DEMO.map(({ level }) => (
            <SeverityIcon key={level} level={level} title={SEVERITY[level].label} />
          ))}
        </Row>
        <Row>
          {SEVERITY_DEMO.map(({ level }) => (
            <StatusBadge key={level} level={level} />
          ))}
        </Row>
        <Row>
          {SEVERITY_DEMO.map(({ level }, index) => (
            <SeverityCountPill key={level} level={level} count={index + 1} />
          ))}
        </Row>
        <div className="flex flex-col gap-1.5">
          {SEVERITY_DEMO.map(({ level, copy }) => (
            <p key={level} className="flex items-start gap-2 text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
              <SeverityIcon level={level} size={16} className="mt-0.5 shrink-0" title="" />
              <span>
                <span className="font-medium text-[var(--adm-text-heading)]">{SEVERITY[level].label}:</span> {copy}
              </span>
            </p>
          ))}
        </div>
      </Section>

      <Section title="Approval card & action row (D9/D3, T1.2)">
        <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          One bordered block, at most two background colours (the card surface plus the icon chip's soft tint), no
          nested cards, no accordion — the Approve/Reject/Modify row is always visible. Click Reject or Modify below to
          see the row swap in-place to the reason textarea; the Error card&apos;s Retry deliberately fails, to show a
          rejected decision promise returning the row to rest and surfacing the error as a toast instead of leaving a
          button stuck spinning.
        </p>
        <div className="flex max-w-lg flex-col gap-3">
          <ApprovalCard
            severity="needs_you"
            title="Publish &ldquo;The Barrier Repair Guide&rdquo;"
            cause={severityCopy('needs_you', { action: 'approve the pending release before it ships' })}
            meta={{ requester: 'wolf@kugelbrands.com', age: 'held for 12m', cost: '$0.42' }}
            actions={{
              onApprove: () => demoDecision(toast, 'Approved'),
              onReject: (reason) => demoDecision(toast, 'Rejected', reason),
              onModify: (reason) => demoDecision(toast, 'Sent back for changes', reason),
            }}
          />
          <ApprovalCard
            severity="error"
            title="Publishing the release failed"
            cause={severityCopy('error', { subject: 'Publishing', escape: 'retry the step' })}
            actions={{
              approveLabel: 'Retry',
              onApprove: () => demoDecisionFailure('Retry'),
            }}
          />
          <ApprovalCard
            severity="blocked"
            title="No signed-in approver"
            cause={severityCopy('blocked', {
              cause: 'the article has no signed-in approver',
              escape: 'ask an admin to grant approval rights',
            })}
            actions={{
              onApprove: () => demoDecision(toast, 'Approved'),
              onReject: (reason) => demoDecision(toast, 'Rejected', reason),
            }}
            disabledReason="You do not have review or publish authority for this object. Ask an admin to grant approval rights."
          />
        </div>
      </Section>

      <Section title="Run progress (D5 ambient tier, T1.2 — consumed by T3.1)">
        <div className="flex max-w-lg flex-col gap-4">
          <RunProgress
            step={3}
            totalSteps={7}
            label="Drafting the outline"
            elapsedMs={82_000}
            costUsd={0.18}
            severity="needs_you"
          />
          <RunProgress
            step={7}
            totalSteps={7}
            label="Published"
            elapsedMs={244_000}
            costUsd={0.42}
            severity="success"
          />
        </div>
      </Section>

      <Section title="Cards & stats">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard label="Published" value="42" hint="+3 this week" tone="success" />
          <StatCard label="In review" value="7" hint="2 awaiting you" tone="warning" />
          <StatCard label="Drafts" value="15" />
        </div>
        <Card kicker="Object" title="The three-step routine" actions={<Button size="sm">Open</Button>}>
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            A card wraps any object summary. Header, body, and footer are all optional.
          </p>
        </Card>
      </Section>

      <Section title="Forms">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Title" placeholder="Article title" hint="Shown in listings and the browser tab." />
          <Input label="Slug" defaultValue="not a slug!" error="Use lowercase words separated by hyphens." />
          <Select
            label="Status"
            options={[
              { value: 'draft', label: 'Draft' },
              { value: 'published', label: 'Published' },
            ]}
          />
          <div className="flex items-end">
            <Switch
              checked={switchOn}
              onCheckedChange={setSwitchOn}
              label="Autonomous publish"
              hint="Agents may publish without approval."
            />
          </div>
        </div>
        <Textarea label="Excerpt" placeholder="One or two sentences…" rows={3} />
        <TaxonomyPicker label="Taxonomy" kinds={TAXONOMY_KINDS} value={terms} onChange={setTerms} />
      </Section>

      <Section title="Voice dictation (T3.4)">
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          Sits beside every chat composer's Send button. Renders nothing at all in a browser without the Web Speech API
          — this is a fixed idle/recording toggle for the gallery, not the live hook.
        </p>
        <Row>
          <MicButton listening={micListening} onToggle={() => setMicListening((on) => !on)} />
          <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {micListening ? 'Recording — click to stop' : 'Idle — click to dictate'}
          </span>
        </Row>
      </Section>

      <Section title="Avatars, skeletons, empty state">
        <Row>
          <Avatar name="Wolf Reich" />
          <Avatar name="Alex Rivera" size={40} />
          <Avatar name="Final Article" size={24} />
        </Row>
        <div className="flex w-64 flex-col gap-2">
          <Skeleton width="60%" />
          <Skeleton />
          <Skeleton variant="rect" height={64} />
        </div>
        <EmptyState
          icon={<IconPlus size={28} />}
          title="No drafts yet"
          message="Start a conversation with a CMS agent to create your first draft."
          action={<Button size="sm">New draft</Button>}
        />
      </Section>

      <Section title="Navigation">
        <Breadcrumbs
          items={[
            { label: 'Workspace', href: '#' },
            { label: 'Articles', href: '#' },
            { label: 'The three-step routine' },
          ]}
        />
        <Tabs
          tabs={[
            {
              id: 'inspector',
              label: 'Inspector',
              content: (
                <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                  Generated inspector fields go here.
                </p>
              ),
            },
            { id: 'history', label: 'History', content: <HistoryTimeline entries={HISTORY} now={FIXED_NOW} /> },
            { id: 'preview', label: 'Preview', disabled: true, content: null },
          ]}
        />
        <Row>
          <DropdownMenu
            trigger={({ ref, onToggle, open }) => (
              <Button
                ref={ref}
                variant="secondary"
                size="sm"
                rightIcon={<IconChevronDown size={16} />}
                aria-expanded={open}
                onClick={onToggle}
              >
                Actions
              </Button>
            )}
            items={[
              {
                id: 'edit',
                label: 'Edit',
                icon: <IconPencil size={16} />,
                onSelect: () => toast({ title: 'Edit selected' }),
              },
              {
                id: 'open',
                label: 'Open live',
                icon: <IconExternalLink size={16} />,
                onSelect: () => toast({ title: 'Opening…' }),
              },
              {
                id: 'delete',
                label: 'Delete',
                icon: <IconTrash size={16} />,
                tone: 'danger',
                onSelect: () => toast({ title: 'Deleted', tone: 'danger' }),
              },
            ]}
          />
          <Button variant="secondary" size="sm" onClick={() => setPaletteOpen(true)}>
            Command palette (⌘K)
          </Button>
        </Row>
      </Section>

      <Section title="Tree">
        <div className="max-w-sm">
          <Tree
            ariaLabel="Component kit publication tree"
            storageKey="kit-gallery"
            activeId="page-about"
            nodes={[
              {
                id: 'foundation',
                label: 'Foundation',
                badge: <Badge tone="neutral">2</Badge>,
                children: [
                  { id: 'voice', label: 'Brand Voice', href: '#brand-voice' },
                  { id: 'identity', label: 'Publication identity', href: '#identity' },
                ],
              },
              {
                id: 'structure',
                label: 'Structure',
                children: [
                  { id: 'page-about', label: 'About' },
                  { id: 'empty-page', label: 'Empty children', children: [] },
                  {
                    id: 'long-label',
                    label: 'A deliberately long object label that demonstrates truncation without layout shift',
                  },
                ],
              },
            ]}
          />
        </div>
      </Section>

      <Section title="Overlays & toasts">
        <Row>
          <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            Delete (typed confirm)
          </Button>
          <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
            Open drawer
          </Button>
        </Row>
        <Row>
          {/* T0: one Popover component, two modes. Hover mode on an enabled
              trigger is the ordinary case; hover mode on a `disabled`
              trigger is the Convention D3 case ActionRow's DecisionButton
              uses — tab to it or tap it, the reason still opens. */}
          <Popover
            mode="hover"
            content="Tab to me, or hover — opens after 200ms."
            trigger={(a11y) => (
              <Button variant="secondary" size="sm" {...a11y}>
                Hover tooltip
              </Button>
            )}
          />
          <Popover
            mode="hover"
            content="Approving requires publisher rights on this object."
            disabled
            trigger={(a11y) => (
              <Button variant="secondary" size="sm" disabled {...a11y}>
                Disabled trigger, tab-reachable tooltip
              </Button>
            )}
          />
          <Popover
            mode="click"
            trigger={(a11y) => (
              <Button variant="secondary" size="sm" {...a11y}>
                Click popover
              </Button>
            )}
            content={
              <div className="flex w-56 flex-col gap-2">
                <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
                  Arbitrary content, not just text. Esc or an outside click closes it.
                </p>
                <Button size="sm" onClick={() => toast({ title: 'Popover action ran' })}>
                  Do a thing
                </Button>
              </div>
            }
          />
        </Row>
        <Row>
          <Button variant="secondary" size="sm" onClick={() => toast({ title: 'Saved', tone: 'success' })}>
            Success toast
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => toast({ title: 'Heads up', description: 'Lock expires in 5 minutes.', tone: 'warning' })}
          >
            Warning toast
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              toast({ title: 'Publish failed', description: 'The deploy did not complete.', tone: 'danger' })
            }
          >
            Danger toast
          </Button>
        </Row>
      </Section>

      <Section title="Locks & readiness">
        <LockBanner
          holder="Alex Rivera"
          since="2026-07-17T11:30:00.000Z"
          now={FIXED_NOW}
          onRefresh={() => toast({ title: 'Lock refreshed' })}
          onForceRelease={() => toast({ title: 'Lock force-released', tone: 'warning' })}
        />
        <LockBanner
          holder="You"
          since="2026-07-17T11:55:00.000Z"
          now={FIXED_NOW}
          isOwnLock
          onRefresh={() => toast({ title: 'Lock refreshed' })}
        />
        <ReadinessList groups={READINESS} />
      </Section>

      <Section title="Data table">
        <DataTable
          columns={TABLE_COLUMNS}
          rows={TABLE_ROWS}
          getRowKey={(r) => r.name}
          initialSort={{ key: 'name', dir: 'asc' }}
        />
        <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          Click a sortable header to cycle asc → desc → unsorted.
        </p>
        <DataTable
          columns={TABLE_COLUMNS}
          rows={[]}
          getRowKey={(r) => r.name}
          emptyState={<EmptyState title="No objects" message="This filter returned nothing." />}
        />
      </Section>

      <Section title="Field diff">
        <DiffView
          entries={[
            {
              field: 'title',
              before: 'Three steps that work',
              after: 'The three-step routine that is genuinely enough',
            },
            { field: 'status', before: 'draft', after: 'published' },
          ]}
        />
      </Section>

      <Section title="History timeline">
        <HistoryTimeline entries={HISTORY} now={FIXED_NOW} />
      </Section>

      <Section title="Assistant markdown">
        <div className="max-w-2xl rounded-[var(--adm-radius-lg)] bg-[var(--adm-surface-sunken)] p-4 text-[length:var(--adm-text-sm)]">
          <Markdown>{`## A concise answer

Use a short list when several steps matter:

1. Review the draft.
2. Check the evidence.
3. **Approve** only when it is ready.

> Keep the reader's needs visible.

| State | Meaning |
| --- | --- |
| Draft | Still being revised |
| Published | Exported, not necessarily live |

Inline \`code\` stays quiet, while fenced code scrolls instead of wrapping:

\`\`\`text
a-very-long-value-that-demonstrates-horizontal-scrolling-without-breaking-the-chat-layout
\`\`\`

[Open the documentation](https://example.com/a/very/long/documentation/link)`}</Markdown>
        </div>
        <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          Use the gallery theme switch above to verify this sample in light and dark.
        </p>
      </Section>

      <Section title="Identity module — objectDisplayName across all ten types">
        <div className="overflow-x-auto">
          <table className="w-full text-[length:var(--adm-text-sm)]">
            <thead>
              <tr className="text-left text-[var(--adm-text-muted)]">
                <th className="py-1 pr-4 font-semibold">Type</th>
                <th className="py-1 pr-4 font-semibold">Display name (shown)</th>
                <th className="py-1 font-semibold">Raw id (tooltip only)</th>
              </tr>
            </thead>
            <tbody>
              {displaySamples.map((sample) => (
                <tr key={sample.object_id} className="border-t border-[var(--adm-border)]">
                  <td className="py-1.5 pr-4">
                    <Badge>{objectTypeLabel(sample.object_type)}</Badge>
                  </td>
                  <td className="py-1.5 pr-4 font-medium text-[var(--adm-text)]">{objectDisplayName(sample)}</td>
                  <td className="py-1.5 text-[var(--adm-text-muted)]" title={idTooltip(sample.object_id)}>
                    <code className="text-[length:var(--adm-text-xs)]">{sample.object_id}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Edit summary"
        description="A native <dialog> with focus trap, Escape, and backdrop dismiss."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setDialogOpen(false);
                toast({ title: 'Saved', tone: 'success' });
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Input label="Title" defaultValue="The three-step routine" />
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          toast({ title: 'Object deleted', tone: 'danger' });
        }}
        title="Delete this object?"
        message="This permanently removes the object. Type the confirmation phrase to proceed."
        confirmLabel="Delete object"
        tone="danger"
        requireTyped="DELETE"
      />

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Object inspector">
        <div className="flex flex-col gap-3">
          <Input label="Title" defaultValue="The three-step routine" />
          <Select
            label="Status"
            options={[
              { value: 'draft', label: 'Draft' },
              { value: 'published', label: 'Published' },
            ]}
          />
          <ReadinessList groups={READINESS} />
        </div>
      </Drawer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={[
          {
            id: 'new-article',
            label: 'Create article',
            group: 'Create',
            onSelect: () => toast({ title: 'New article' }),
          },
          { id: 'new-page', label: 'Create page', group: 'Create', onSelect: () => toast({ title: 'New page' }) },
          {
            id: 'publish',
            label: 'Publish current',
            group: 'Actions',
            onSelect: () => toast({ title: 'Publishing…' }),
          },
          {
            id: 'guardrails',
            label: 'Open guardrails',
            group: 'Settings',
            keywords: ['policy', 'approval'],
            onSelect: () => toast({ title: 'Guardrails' }),
          },
        ]}
      />
    </div>
  );
}

// ─── root with dark toggle, inside the shared admin chrome ────────────────────

export interface KitGalleryProps {
  identity: SiteIdentity;
}

export default function KitGallery({ identity }: KitGalleryProps) {
  const [dark, setDark] = useState(false);

  return (
    <AdminShell currentPath="/admin/kit" title="Admin UI Kit" identity={identity}>
      <div className={dark ? 'dark' : undefined}>
        <div className="rounded-[var(--adm-radius-lg)] bg-[var(--adm-surface-page)] p-4 sm:p-6">
          <div className="mb-6 flex items-center justify-between">
            <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
              Admin UI kit — every component, every state.
            </p>
            <Switch checked={dark} onCheckedChange={setDark} label={dark ? 'Dark' : 'Light'} />
          </div>
          {/* AdminShell already wraps children in its own ToastProvider (T9.3),
              same as every sibling page (Studio.tsx, MaintenancePage.tsx) — no
              local <ToastProvider> here, GalleryBody's useToast() resolves to
              the shell's. */}
          <GalleryBody identity={identity} />
        </div>
      </div>
    </AdminShell>
  );
}
