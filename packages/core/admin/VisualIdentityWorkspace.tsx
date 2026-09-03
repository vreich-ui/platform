/**
 * Visual Identity is an aggregate lens, not a second theme/template catalog.
 * It reads the existing site singleton (active tokens), theme objects
 * (named alternatives), and safe artifact projections (available logos).
 *
 * U1 (brand-imagery wave) turns it into the wave's ONE surface — identity ·
 * imagery · PDF templates — as three tabs on THIS route. BRIEF §4 puts new
 * admin routes out of scope, so the tab is a `?tab=` round-trip
 * (`parseVisualIdentityTab`), not a route.
 *
 * ONE LOADER, THREE TABS. Every record all three tabs read is fetched here,
 * once, and passed down: the site singleton, the theme objects, the
 * `visual_standard` collection, the guardrail value, and the editorial-asset
 * payload (which already carries both `list_pdf_templates` and the rendered
 * artifacts). The tab components stay stateless about loading, which keeps
 * their hook lists short and unconditional.
 *
 * THE U3 SEAM. R8 docks the visual-identity chat on this page and renames the
 * `retheme` starter; that rail is task U3's. This file exposes exactly one
 * hole for it — the optional `rail` prop — and every tool-backed button routes
 * through `runIntent`. With a rail present the intent opens the docked chat;
 * without one it opens a small dialog showing the exact instruction and a link
 * to the agents page, so the affordance is honest rather than dead. Nothing
 * here imports or edits `chat.tsx`, `AgentRail.tsx`, `chat-*.ts` or
 * `agent-starters.ts`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdminShell } from './AdminShell';
import { AgentRail } from './AgentRail';
import { ArtifactStagePreview } from './ArtifactStagePreview';
import { useChat } from './chat';
import { ImageryBoard } from './ImageryBoard';
import { PdfTemplatesPanel } from './PdfTemplatesPanel';
import { Badge, Button, Card, EmptyState, Skeleton } from './primitives';
import { Tabs } from './menus';
import { Dialog } from './overlays';
import { IconExternalLink, IconPalette, IconSparkles } from './icons';
import type { SiteIdentity } from '@core/lib/site-identity';
import type { EditorialAssetsPayload } from '@core/lib/admin/editorial-assets';
import type { StudioRecord } from '@core/lib/admin/studio-client';
import { fetchStudioData } from '@core/lib/admin/studio-client';
import { fetchEditorialAssets } from '@core/lib/admin/editorial-assets-client';
import { fetchGovernance } from '@core/lib/admin/governance-client';
import { agentStarterByKey } from '@core/lib/admin/agent-starters';
import { createFreeChat, sendChatMessage } from '@core/lib/admin/chat-client';
import { callObjectVerb } from '@core/lib/edit-mode/verbs-client';
import { buildVisualIdentityViewModel, type VisualIdentityViewModel } from '@core/lib/admin/visual-identity';
import {
  VISUAL_IDENTITY_STARTER_HREF,
  VISUAL_IDENTITY_TAB_LABELS,
  VISUAL_IDENTITY_TABS,
  parseVisualIdentityTab,
  type BrandImageryOverridePolicy,
  type VisualIdentityChatIntent,
  type VisualIdentityTab,
} from '@core/lib/admin/visual-identity-imagery';

async function getToken(): Promise<string> {
  const auth = await import('@core/lib/admin/goTrueClient');
  return (await auth.getAccessToken()) ?? '';
}

async function fetchSite(siteId: string): Promise<StudioRecord> {
  const result = await callObjectVerb(getToken, { action: 'get', object_type: 'site', object_id: siteId });
  if (result.status !== 200 || !result.body.record) {
    throw new Error(String(result.body.error ?? 'The publication identity could not be loaded.'));
  }
  return result.body.record as StudioRecord;
}

/**
 * The `visual_standard` collection (house + templates) through the SAME
 * `admin-object` verbs every other admin read uses — list, then one parallel
 * `get` per id, exactly `studio-client`'s shape. A tenant that predates the
 * type (or an unavailable store) yields an empty list rather than failing the
 * whole page: the identity tab must still paint.
 */
async function fetchVisualStandards(): Promise<StudioRecord[]> {
  const listed = await callObjectVerb(getToken, { action: 'list', object_type: 'visual_standard' });
  if (listed.status !== 200 || !Array.isArray(listed.body.objects)) return [];
  const ids = (listed.body.objects as Array<{ object_id?: string }>)
    .map((row) => row.object_id)
    .filter((id): id is string => Boolean(id));
  const records = await Promise.all(
    ids.map((id) => callObjectVerb(getToken, { action: 'get', object_type: 'visual_standard', object_id: id }))
  );
  return records
    .filter((result) => result.status === 200 && result.body.record)
    .map((result) => result.body.record as StudioRecord);
}

/** The guardrail is Owner-read too; an unreadable one is reported as the default. */
async function fetchOverridePolicy(): Promise<BrandImageryOverridePolicy> {
  try {
    const governance = await fetchGovernance(getToken);
    return governance.active?.brandImageryOverrides === 'lock' ? 'lock' : 'allow';
  } catch {
    return 'allow';
  }
}

function Swatches({ colors }: { colors: VisualIdentityViewModel['colors'] }) {
  if (!colors.length)
    return (
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        No active color tokens are available yet.
      </p>
    );
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {colors.map((color) => (
        <div
          key={color.name}
          className="min-w-0 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] p-2"
        >
          <span
            className="mb-2 block h-12 rounded-[var(--adm-radius-sm)] border border-black/10"
            style={{ backgroundColor: color.value }}
            aria-hidden="true"
          />
          <span className="block truncate text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text)]">
            {color.name}
          </span>
          <span className="block truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {color.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function Typography({ rows }: { rows: VisualIdentityViewModel['typography'] }) {
  if (!rows.length)
    return (
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        No publication typography tokens are available yet.
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <div
          key={row.name}
          className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-3 py-2"
        >
          <p className="text-[length:var(--adm-text-xs)] font-medium uppercase tracking-wide text-[var(--adm-text-muted)]">
            {row.name}
          </p>
          <p
            className="mt-1 text-[length:var(--adm-text-lg)] text-[var(--adm-text-heading)]"
            style={{ fontFamily: row.value }}
          >
            Evidence-led publishing for real readers.
          </p>
          <p className="truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{row.value}</p>
        </div>
      ))}
    </div>
  );
}

function IdentityBoard({
  model,
  identity,
  onRetheme,
}: {
  model: VisualIdentityViewModel;
  identity: SiteIdentity;
  onRetheme: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
            Publication identity
          </p>
          <h2 className="mt-1 text-[length:var(--adm-text-xl)] font-semibold text-[var(--adm-text-heading)]">
            The brand board
          </h2>
          <p className="mt-1 max-w-2xl text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            The active visual system drawn from this publication’s site and theme objects.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* R8's retheme CTA. It opens the docked chat when U3 supplies a rail,
              and otherwise hands over the same instruction to paste. */}
          <Button onClick={onRetheme}>
            <IconSparkles size={15} /> Retheme
          </Button>
          <a
            href={`/admin/content/${encodeURIComponent(identity.siteId)}?type=site`}
            className="adm-focusable inline-flex h-10 items-center gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] bg-[var(--adm-surface-raised)] px-4 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]"
          >
            Open publication settings <IconExternalLink size={15} />
          </a>
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(18rem,0.82fr)_minmax(0,1.18fr)]">
        <Card kicker="Mark" title={model.logoText}>
          <div className="flex flex-col gap-3">
            <div className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] p-5">
              <p className="text-[length:var(--adm-text-xl)] font-semibold tracking-[0.16em] text-[var(--adm-text-heading)]">
                {model.logoText}
              </p>
            </div>
            <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
              {model.logoImageConfigured
                ? 'An image logo is configured for the publication.'
                : 'This publication currently uses a text mark.'}
            </p>
            {model.availableLogo ? (
              <details>
                <summary className="cursor-pointer text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-accent)]">
                  Available logo preview: {model.availableLogo.label}
                </summary>
                <div className="mt-3 max-h-72 overflow-auto rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] p-3">
                  <ArtifactStagePreview artifact={model.availableLogo} />
                </div>
              </details>
            ) : null}
          </div>
        </Card>

        <Card kicker="Live reference" title="Representative publication preview">
          {model.previewUrl ? (
            <div className="flex flex-col gap-3">
              <iframe
                title={`Live preview of ${model.publicationName}`}
                src={model.previewUrl}
                className="h-[22rem] w-full rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-white"
              />
              <a
                href={model.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="adm-focusable inline-flex items-center gap-1 self-start text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-accent)] hover:underline"
              >
                Open publication <IconExternalLink size={14} />
              </a>
            </div>
          ) : (
            <EmptyState
              title="Preview address unavailable"
              message="Add a valid publication base address to the site object to show a representative live preview."
            />
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          kicker="Active palette"
          title={model.activeThemeLabel ? `Applied from ${model.activeThemeLabel}` : 'Publication color tokens'}
        >
          <Swatches colors={model.colors} />
        </Card>
        <Card kicker="Typography" title="Publication type system">
          <Typography rows={model.typography} />
        </Card>
      </div>

      <Card kicker="Themes" title="Available named visual systems">
        {model.themes.length ? (
          <div className="flex flex-wrap gap-2">
            {model.themes.map((theme) => (
              <a
                key={theme.objectId}
                href={`/admin/content/${encodeURIComponent(theme.objectId)}?type=theme`}
                className="adm-focusable inline-flex items-center gap-2 rounded-[var(--adm-radius-pill)] border border-[var(--adm-border-strong)] px-3 py-1.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]"
              >
                <IconPalette size={15} /> {theme.label}
                {theme.active ? <Badge tone="success">active match</Badge> : null}
              </a>
            ))}
          </div>
        ) : (
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            No named theme objects are available. The active tokens above still come directly from the publication
            object.
          </p>
        )}
      </Card>
    </div>
  );
}

/**
 * The one hole U3 fills. A rail-bearing host passes `open`; without it the
 * page still offers every tool-backed action, as an instruction the human can
 * take to the agent themselves.
 */
export interface VisualIdentityRailSeam {
  open: (intent: VisualIdentityChatIntent) => void;
}

const RETHEME_INTENT: VisualIdentityChatIntent = {
  starter: 'visual-identity',
  tool: 'site_apply_theme',
  label: 'Retheme',
  prompt:
    'I want to look at the visual identity of this publication — theme, imagery and PDF templates. Start with the theme: list the theme objects, then propose site_apply_theme with a dry run so I can see the exact brandTokens diff before deciding. Do not apply anything without my approval.',
};

function IntentDialog({ intent, onClose }: { intent: VisualIdentityChatIntent | undefined; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open={Boolean(intent)}
      onClose={() => {
        setCopied(false);
        onClose();
      }}
      size="lg"
      title={intent?.label ?? 'Ask the agent'}
      description={`This runs through the agent, so the approval card stays in charge. Tool: ${intent?.tool ?? ''}`}
      footer={
        <span className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              const text = intent?.prompt;
              if (!text) return;
              void navigator.clipboard?.writeText(text).then(
                () => setCopied(true),
                () => setCopied(false)
              );
            }}
          >
            {copied ? 'Copied' : 'Copy instruction'}
          </Button>
          <a
            href={VISUAL_IDENTITY_STARTER_HREF}
            className="adm-focusable inline-flex h-10 items-center gap-2 rounded-[var(--adm-radius-md)] bg-[var(--adm-accent)] px-4 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-accent-contrast,#fff)]"
          >
            Open the agent <IconExternalLink size={15} />
          </a>
        </span>
      }
    >
      <pre className="max-h-[45dvh] overflow-auto whitespace-pre-wrap rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] p-3 text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
        {intent?.prompt}
      </pre>
    </Dialog>
  );
}

function VisualIdentityBody({
  identity,
  rail,
  onOwnerChange,
}: {
  identity: SiteIdentity;
  rail?: VisualIdentityRailSeam;
  /**
   * U3: reports the SAME owner check this body already gates its own tabs
   * on, so the docked rail (mounted by the OUTER component, which has no
   * owner check of its own) can stay off a non-owner's screen too — a
   * governed "Do not apply anything without my approval" chat has no
   * business being live next to an "Owner-only" empty state.
   */
  onOwnerChange?: (owner: boolean) => void;
}) {
  const [owner, setOwner] = useState<boolean | null>(null);
  const [model, setModel] = useState<VisualIdentityViewModel | null>(null);
  const [site, setSite] = useState<StudioRecord | undefined>(undefined);
  const [standards, setStandards] = useState<StudioRecord[]>([]);
  const [assets, setAssets] = useState<EditorialAssetsPayload | undefined>(undefined);
  const [overridePolicy, setOverridePolicy] = useState<BrandImageryOverridePolicy>('allow');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<VisualIdentityTab>('identity');
  const [pendingIntent, setPendingIntent] = useState<VisualIdentityChatIntent | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { fetchMe } = await import('@core/lib/admin/users-client');
      const me = await fetchMe(getToken);
      const isOwner = me.roles.includes('owner');
      setOwner(isOwner);
      onOwnerChange?.(isOwner);
      if (!isOwner) return;
      const [siteRecord, studio, editorial, visualStandards, policy] = await Promise.all([
        fetchSite(identity.siteId),
        fetchStudioData(getToken),
        fetchEditorialAssets(getToken),
        fetchVisualStandards(),
        fetchOverridePolicy(),
      ]);
      setSite(siteRecord);
      setStandards(visualStandards);
      setAssets(editorial);
      setOverridePolicy(policy);
      setModel(
        buildVisualIdentityViewModel({
          site: siteRecord,
          themes: studio.themes,
          artifacts: editorial.artifacts,
          fallbackName: identity.brandName,
        })
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Visual identity could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [identity.brandName, identity.siteId, onOwnerChange]);

  useEffect(() => {
    void load();
  }, [load]);

  // `?tab=` round-trip. Read once on mount (the URL is the entry point, not a
  // second source of truth for the session) and written back on every change,
  // so a deep link and a shared link both land on the right tab.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setTab(parseVisualIdentityTab(new URLSearchParams(window.location.search).get('tab')));
  }, []);

  const selectTab = useCallback((next: string) => {
    const resolved = parseVisualIdentityTab(next);
    setTab(resolved);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('tab', resolved);
    window.history.replaceState({}, '', url);
  }, []);

  /**
   * The seam. With a rail (U3) the intent opens the docked chat; without one it
   * surfaces the exact instruction. Either way the tool call itself is the
   * agent's, under the normal approval card — this page never invents a
   * client-side write path for a tool that has no admin endpoint.
   */
  const runIntent = useCallback(
    (intent: VisualIdentityChatIntent) => {
      if (rail) {
        rail.open(intent);
        return;
      }
      setPendingIntent(intent);
    },
    [rail]
  );

  const tabs = useMemo(
    () => [
      {
        id: 'identity' as const,
        label: VISUAL_IDENTITY_TAB_LABELS.identity,
        content:
          model && site ? (
            <IdentityBoard model={model} identity={identity} onRetheme={() => runIntent(RETHEME_INTENT)} />
          ) : null,
      },
      {
        id: 'imagery' as const,
        label: VISUAL_IDENTITY_TAB_LABELS.imagery,
        content: (
          <ImageryBoard
            identity={identity}
            site={site}
            standards={standards}
            overridePolicy={overridePolicy}
            isOwner={owner === true}
            getToken={getToken}
            onIntent={runIntent}
            onChanged={load}
          />
        ),
      },
      {
        id: 'pdf' as const,
        label: VISUAL_IDENTITY_TAB_LABELS.pdf,
        content: (
          <PdfTemplatesPanel
            identity={identity}
            site={site}
            templates={assets?.pdf_templates ?? []}
            artifacts={assets?.artifacts ?? []}
            available={assets?.pdf_templates_available === true}
            isOwner={owner === true}
            getToken={getToken}
            onIntent={runIntent}
            onChanged={load}
          />
        ),
      },
    ],
    [assets, identity, load, model, overridePolicy, owner, runIntent, site, standards]
  );

  if (loading || owner === null) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-live="polite">
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          Loading the publication’s visual system…
        </p>
        <Skeleton variant="rect" height={420} />
      </div>
    );
  }
  if (!owner) {
    return (
      <EmptyState
        title="Visual identity is Owner-only"
        message="Ask a publication Owner to review or change this visual system."
      />
    );
  }
  if (error || !model) {
    return (
      <EmptyState
        severity="error"
        title="Visual identity unavailable"
        message={error ?? 'The visual identity records could not be loaded.'}
        action={
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-[length:var(--adm-text-2xl)] font-semibold text-[var(--adm-text-heading)]">
          Visual identity
        </h1>
        <p className="mt-1 max-w-3xl text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          One place for how this publication looks: its brand board, the image style every generated picture obeys, and
          the PDF templates its documents render from.
        </p>
      </header>
      <Tabs tabs={tabs} value={tab} onChange={selectTab} />
      <IntentDialog intent={pendingIntent} onClose={() => setPendingIntent(undefined)} />
    </div>
  );
}

/**
 * U3 (R8, BRIEF §4): docks `AgentRail` on THIS route, seeded with the
 * `visual-identity` starter, and wires its `chat.send` into the `rail` seam
 * U1 left. A `rail` passed in from outside (tests, a future host) is used
 * as-is instead — this self-hosted dock only fills the gap when nobody
 * supplied one, exactly the gap the seam's own fallback dialog used to fill
 * alone. `sessionStorage` keeps ONE conversation per browser tab across a
 * tab-switch remount (`PdfTemplateRoom`'s existing pattern, TemplatesWorkspace.tsx) —
 * the starter's opening turn goes out once, not on every remount.
 */
function useDockedVisualIdentityChat(siteId: string, enabled: boolean) {
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const key = `visual-identity-chat:${siteId}`;
    const existing = sessionStorage.getItem(key);
    if (existing) {
      setChatId(existing);
      return;
    }
    const starter = agentStarterByKey('visual-identity');
    createFreeChat(getToken, starter?.label ?? 'Visual identity')
      .then(async ({ chat: created }) => {
        sessionStorage.setItem(key, created.chat_id);
        setChatId(created.chat_id);
        if (starter) await sendChatMessage(getToken, created.chat_id, starter.prompt);
      })
      .catch(() => setChatId(undefined));
  }, [enabled, siteId]);
  return chatId;
}

export default function VisualIdentityWorkspace({
  identity,
  rail: externalRail,
}: {
  identity: SiteIdentity;
  rail?: VisualIdentityRailSeam;
}) {
  const dockNeeded = !externalRail;
  // Gates the docked rail on the SAME owner check `VisualIdentityBody`
  // already gates its own tabs on (see that prop's own comment) — `null`
  // until the first `fetchMe` resolves, so the dock stays unmounted rather
  // than flashing on for a viewer who turns out not to be an Owner.
  const [ownerKnown, setOwnerKnown] = useState<boolean | null>(null);
  const onOwnerChange = useCallback((next: boolean) => setOwnerKnown(next), []);
  const dockActive = dockNeeded && ownerKnown === true;
  const chatId = useDockedVisualIdentityChat(identity.siteId, dockActive);
  const chat = useChat(getToken, chatId);
  const [composerSeed, setComposerSeed] = useState<{ key: string; text: string } | undefined>(undefined);

  const dockedRail: VisualIdentityRailSeam = useMemo(
    () => ({
      open: (intent) => setComposerSeed({ key: `${intent.tool}:${Date.now()}`, text: intent.prompt }),
    }),
    []
  );
  const rail = externalRail ?? dockedRail;

  return (
    <AdminShell currentPath="/admin/settings/visual-identity" title="Visual identity" identity={identity} wide>
      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          <VisualIdentityBody identity={identity} rail={rail} {...(dockNeeded ? { onOwnerChange } : {})} />
        </div>
        {dockActive ? (
          <div className="sticky top-4 self-start" aria-label="Visual identity agent dock">
            {/* REVIEW: this dock only mounts once `fetchMe` has confirmed an
                Owner (see `dockActive`), so the rail's Owner-only provider
                error detail belongs on. `isOwner` defaults to false, which
                silently hid it from the only role that can reach this page. */}
            <AgentRail
              chat={chat}
              focus="the publication’s visual identity"
              isOwner
              suggestions={[
                'Summarize the current theme, image style and PDF templates.',
                'What would you change about the image style?',
              ]}
              draftSeed={composerSeed}
            />
          </div>
        ) : null}
      </div>
    </AdminShell>
  );
}

/** Re-exported so the route (and U3's rail host) can name the tabs without reaching into the lib. */
export { VISUAL_IDENTITY_TABS };
