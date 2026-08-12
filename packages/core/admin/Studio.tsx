/**
 * Templates & Themes studio (T9.18, plan §2) — the visual browse/preview/apply
 * layer over the W8 recipe family. Three galleries (tpl_/stpl_/thm_) showing
 * the REQUIRED description/whenToUse/scope metadata; every creation/apply flow
 * is dry-run-first on the governed verbs. Owner-tier per the §8 matrix: the UI
 * hides apply/instantiate for admins AND the server 403s (verb-level owner
 * gate on real apply_theme; UI-level gating elsewhere — creation stays on the
 * governed verbs either way). REUSE-FIRST made visual.
 */
import { useEffect, useState } from 'react';

import { AdminShell } from './AdminShell';
import { Badge, Button, Card, EmptyState, Skeleton } from './primitives';
import { Input } from './forms';
import { Dialog, ConfirmDialog, useToast } from './overlays';
import { IconAlertTriangle, IconPalette, IconSparkles } from './icons';
import type { ObjectRecord } from '@core/schema/object-record-v1';
// D2: identity is resolved server-side by the /admin/studio.astro route
// (where process.env is real) and threaded down as a prop, all the way to
// ThemeGallery below — this component no longer calls getSiteIdentity()
// itself, which used to see only the COMMITTED config on the client (no
// process.env in the browser) and silently ignore any SITE_* env override.
import type { SiteIdentity } from '@core/lib/site-identity';
// A pure, side-effect-free sync accessor (no network, no bundling cost worth
// deferring) — safe to import statically so the very first render can read
// whatever was cached, instead of racing a dynamic import against paint.
import { peekCachedStudioData, STUDIO_PERSISTED_MAX_AGE_MS } from '@core/lib/admin/studio-client';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

// instantiate/instantiate_section/apply_theme all mint or change objects the
// content library lists (and, for the recipe types themselves, the Studio
// galleries below) — invalidate both caches so neither the library, the
// Cmd-K palette, nor Studio's own galleries show a stale view after one of
// these succeeds.
async function invalidateLibraryCache(): Promise<void> {
  const [{ invalidateInventoryCache }, { invalidateStudioCache }] = await Promise.all([
    import('@core/lib/admin/library-client'),
    import('@core/lib/admin/studio-client'),
  ]);
  invalidateInventoryCache();
  invalidateStudioCache();
}

type Rec = ObjectRecord<Record<string, unknown>>;

interface RecipeMeta {
  description?: string;
  whenToUse?: string;
  scope?: string;
}

const metaOf = (record: Rec): RecipeMeta => {
  const body = record.body ?? {};
  return {
    description: typeof body.description === 'string' ? body.description : undefined,
    whenToUse: typeof body.whenToUse === 'string' ? body.whenToUse : undefined,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
  };
};

const nameOf = (record: Rec): string =>
  typeof record.body?.name === 'string' ? (record.body.name as string) : record.object_id;

const missingTrio = (record: Rec): boolean => {
  const meta = metaOf(record);
  return !meta.description || !meta.whenToUse || !meta.scope;
};

async function verb(request: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const { callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
  return callObjectVerb(getToken, request) as Promise<{ status: number; body: Record<string, unknown> }>;
}

function MetaLines({ record }: { record: Rec }) {
  const meta = metaOf(record);
  return (
    <dl className="flex flex-col gap-1 text-[length:var(--adm-text-xs)]">
      {meta.description ? <dd className="text-[var(--adm-text)]">{meta.description}</dd> : null}
      {meta.whenToUse ? (
        <dd className="text-[var(--adm-text-muted)]">
          <span className="font-medium">When to use:</span> {meta.whenToUse}
        </dd>
      ) : null}
      {meta.scope ? (
        <dd className="text-[var(--adm-text-muted)]">
          <span className="font-medium">Scope:</span> {meta.scope}
        </dd>
      ) : null}
    </dl>
  );
}

// ─── page-template gallery ───────────────────────────────────────────────────

function TemplateGallery({ templates, onCreated }: { templates: Rec[]; onCreated: (id: string) => void }) {
  const { toast } = useToast();
  const [target, setTarget] = useState<Rec | null>(null);
  const [route, setRoute] = useState('');
  const [title, setTitle] = useState('');
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const dryRun = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await verb({
        action: 'instantiate',
        template_id: target.object_id,
        site: target.site,
        route,
        title,
        dry_run: true,
      });
      // Fixed defect: a 422 (or any non-200) here used to still call
      // `setPreview`, and the footer switches to the enabled "Create page"
      // button on any truthy `preview` — so a rejected dry run enabled the
      // real create anyway. Compare `mintStandalone` below, which already
      // gates on `dry.status`.
      if (res.status !== 200) {
        toast({ title: 'Preview failed', description: String(res.body.error ?? ''), tone: 'danger' });
        return;
      }
      setPreview(res.body);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!target) return;
    setBusy(true);
    let minted = false;
    try {
      const res = await verb({
        action: 'instantiate',
        template_id: target.object_id,
        site: target.site,
        route,
        title,
      });
      if (res.status === 200) {
        minted = true;
        void invalidateLibraryCache();
        const id = (res.body.record as { object_id?: string } | undefined)?.object_id;
        toast({ title: 'Page created', tone: 'success' });
        if (id) onCreated(`/admin/content/${encodeURIComponent(id)}?type=page`);
      } else {
        toast({ title: 'Could not create the page', description: String(res.body.error ?? ''), tone: 'danger' });
      }
    } finally {
      // Fixed defect: clearing `busy` unconditionally here re-enabled
      // "Create page" while `onCreated`'s `location.assign` navigation was
      // still pending, so a double-click minted a duplicate page. Stay
      // busy/disabled through a successful mint — this view is about to be
      // replaced anyway — and only clear it to let the human retry a failure.
      if (!minted) setBusy(false);
    }
  };

  const previewSummary = preview
    ? ((preview.summary as { eligible?: boolean } | undefined)?.eligible ?? preview.dry_run)
      ? 'Preview validates — the page can be created.'
      : `Preview has problems: ${String(preview.error ?? 'see validation')}`
    : null;

  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        {templates.map((template) => (
          <Card key={template.object_id} title={nameOf(template)} kicker="Page template">
            <div className="flex flex-col gap-3">
              {missingTrio(template) ? (
                <Badge tone="warning" className="self-start">
                  needs backfill (422 on patch)
                </Badge>
              ) : (
                <MetaLines record={template} />
              )}
              <Button
                size="sm"
                className="self-start"
                onClick={() => {
                  setTarget(template);
                  setRoute('');
                  setTitle('');
                  setPreview(null);
                }}
              >
                Use this template
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <Dialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={`New page from ${target ? nameOf(target) : ''}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTarget(null)} disabled={busy}>
              Cancel
            </Button>
            {preview ? (
              <Button onClick={confirm} loading={busy}>
                Create page
              </Button>
            ) : (
              <Button onClick={dryRun} loading={busy} disabled={!route || !title}>
                Preview (dry run)
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input label="Route" placeholder="/new-page" value={route} onChange={(e) => setRoute(e.target.value)} />
          <Input label="Title" placeholder="Page title" value={title} onChange={(e) => setTitle(e.target.value)} />
          {previewSummary ? (
            <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">{previewSummary}</p>
          ) : null}
          {preview ? (
            <details>
              <summary className="cursor-pointer text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                Dry-run details
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-[var(--adm-surface-sunken)] p-2 text-[length:var(--adm-text-xs)]">
                {JSON.stringify(preview, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}

// ─── section-template gallery ────────────────────────────────────────────────

function SectionTemplateGallery({ sections, onCreated }: { sections: Rec[]; onCreated: (path: string) => void }) {
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const mintStandalone = async (record: Rec) => {
    setBusyId(record.object_id);
    try {
      const dry = await verb({
        action: 'instantiate_section',
        section_template_id: record.object_id,
        target: { kind: 'standalone' },
        dry_run: true,
      });
      if (dry.status !== 200) {
        toast({ title: 'Preview failed', description: String(dry.body.error ?? ''), tone: 'danger' });
        return;
      }
      const res = await verb({
        action: 'instantiate_section',
        section_template_id: record.object_id,
        target: { kind: 'standalone' },
      });
      if (res.status === 200) {
        void invalidateLibraryCache();
        const id = (res.body.record as { object_id?: string } | undefined)?.object_id;
        toast({ title: 'Shared section minted', tone: 'success' });
        if (id) onCreated(`/admin/content/${encodeURIComponent(id)}?type=section`);
      } else {
        toast({ title: 'Could not mint the section', description: String(res.body.error ?? ''), tone: 'danger' });
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {sections.map((section) => (
        <Card key={section.object_id} title={nameOf(section)} kicker="Section template">
          <div className="flex flex-col gap-3">
            {missingTrio(section) ? (
              <Badge tone="warning" className="self-start">
                needs backfill (422 on patch)
              </Badge>
            ) : (
              <MetaLines record={section} />
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                loading={busyId === section.object_id}
                onClick={() => void mintStandalone(section)}
              >
                Mint shared section
              </Button>
              <a
                href={`/admin/content/${encodeURIComponent(section.object_id)}?type=section_template`}
                className="adm-focusable inline-flex items-center rounded-[var(--adm-radius-md)] px-3 py-1.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]"
              >
                Stamp into a page via its agent →
              </a>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─── theme gallery ───────────────────────────────────────────────────────────

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={`${label}: ${color}`}>
      <span
        className="h-5 w-5 rounded-full border border-[var(--adm-border)]"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{label}</span>
    </span>
  );
}

function ThemeGallery({ themes, owner, identity }: { themes: Rec[]; owner: boolean; identity: SiteIdentity }) {
  const { toast } = useToast();
  const [target, setTarget] = useState<Rec | null>(null);
  const [diff, setDiff] = useState<Record<string, unknown> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const SITE_ID = identity.siteId;

  const dryRun = async (record: Rec) => {
    setTarget(record);
    setDiff(null);
    setBusy(true);
    try {
      const res = await verb({ action: 'apply_theme', theme_id: record.object_id, site_id: SITE_ID, dry_run: true });
      setDiff(res.body);
    } finally {
      setBusy(false);
    }
  };

  const realApply = async () => {
    if (!target) return;
    setBusy(true);
    setConfirming(false);
    try {
      const co = await verb({ action: 'checkout', object_type: 'site', object_id: SITE_ID });
      if (co.status !== 200) {
        const holder = (co.body.lock as { owner_label?: string } | undefined)?.owner_label;
        toast({ title: 'Site is locked', description: holder ? `Held by ${holder}.` : undefined, tone: 'warning' });
        return;
      }
      const lockToken = co.body.lockToken as string;
      const res = await verb({
        action: 'apply_theme',
        theme_id: target.object_id,
        site_id: SITE_ID,
        lock_token: lockToken,
        expected_record_version: co.body.record_version as number,
      });
      await verb({ action: 'checkin', object_type: 'site', object_id: SITE_ID, lock_token: lockToken });
      if (res.status === 200) {
        void invalidateLibraryCache();
        toast({
          title: 'Theme applied',
          description: 'The site palette changed in the working copy. Publish + release when ready.',
          tone: 'success',
        });
        window.location.assign(`/admin/content/${encodeURIComponent(SITE_ID)}?type=site`);
      } else {
        toast({ title: 'Apply refused', description: String(res.body.error ?? ''), tone: 'danger' });
      }
    } finally {
      setBusy(false);
      setTarget(null);
      setDiff(null);
    }
  };

  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        {themes.map((theme) => {
          const colors = ((theme.body?.tokens as { colors?: Record<string, string> } | undefined)?.colors ??
            {}) as Record<string, string>;
          const fonts = ((theme.body?.tokens as { fonts?: Record<string, string> } | undefined)?.fonts ?? {}) as Record<
            string,
            string
          >;
          return (
            <Card key={theme.object_id} title={nameOf(theme)} kicker="Theme">
              <div className="flex flex-col gap-3">
                {missingTrio(theme) ? (
                  <Badge tone="warning" className="self-start">
                    needs backfill (422 on patch)
                  </Badge>
                ) : (
                  <MetaLines record={theme} />
                )}
                <div className="flex flex-wrap gap-3">
                  {Object.entries(colors)
                    .slice(0, 6)
                    .map(([key, value]) => (
                      <Swatch key={key} color={value} label={key} />
                    ))}
                </div>
                {fonts.heading || fonts.body ? (
                  <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                    <span style={{ fontFamily: fonts.heading }} className="text-[var(--adm-text)]">
                      Heading — {fonts.heading ?? '—'}
                    </span>
                    <br />
                    <span style={{ fontFamily: fonts.body }}>Body — {fonts.body ?? '—'}</span>
                  </p>
                ) : null}
                {owner ? (
                  <Button
                    size="sm"
                    className="self-start"
                    onClick={() => void dryRun(theme)}
                    loading={busy && target?.object_id === theme.object_id}
                  >
                    Apply theme…
                  </Button>
                ) : (
                  <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                    Applying themes is Owner-only.
                  </p>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <Dialog
        open={target !== null && diff !== null}
        onClose={() => {
          setTarget(null);
          setDiff(null);
        }}
        title={`Apply ${target ? nameOf(target) : ''} to the site`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setTarget(null);
                setDiff(null);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={() => setConfirming(true)} disabled={busy || diff?.eligible === false}>
              Apply for real…
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
            Exact-replace: after the apply, the site's brandTokens EQUAL this theme's tokens (stale keys are unset). The
            palette changes only through this verb. Publish and release stay separate deliberate steps.
          </p>
          <details open>
            <summary className="cursor-pointer text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              Computed token op (dry run)
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-[var(--adm-surface-sunken)] p-2 text-[length:var(--adm-text-xs)]">
              {JSON.stringify(diff?.op ?? diff, null, 2)}
            </pre>
          </details>
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void realApply()}
        title="Apply this theme to the live site config?"
        message={`Type APPLY to confirm. This rewrites site.brandTokens to ${target ? nameOf(target) : ''}'s tokens under your checkout.`}
        confirmLabel="Apply theme"
        tone="danger"
        requireTyped="APPLY"
      />
    </>
  );
}

// ─── the studio page ─────────────────────────────────────────────────────────

// Synchronous, no-network read of the last known Studio data — used as the
// initial render state so a repeat visit (e.g. switching Studio tabs away
// and back) paints immediately instead of the full blocking skeleton, the
// same stale-while-revalidate pattern ContentLibrary already uses for the
// content library.
function initialCachedStudioData(): { templates: Rec[]; sections: Rec[]; themes: Rec[] } | null {
  if (typeof window === 'undefined') return null;
  const cached = peekCachedStudioData();
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > STUDIO_PERSISTED_MAX_AGE_MS) return null;
  return cached.data;
}

function StudioBody({ identity }: { identity: SiteIdentity }) {
  const [initialData] = useState(initialCachedStudioData);
  const [templates, setTemplates] = useState<Rec[] | null>(initialData?.templates ?? null);
  const [sections, setSections] = useState<Rec[] | null>(initialData?.sections ?? null);
  const [themes, setThemes] = useState<Rec[] | null>(initialData?.themes ?? null);
  // A background refetch always runs, even when cached data painted
  // immediately — this just controls the small inline "refreshing…"
  // indicator instead of the big per-gallery skeletons.
  const [refreshing, setRefreshing] = useState(initialData !== null);
  const [owner, setOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      // D1(b): fetchMe() used to be awaited BEFORE the recipe-loading call
      // started, adding a full extra round-trip to the waterfall. It doesn't
      // need to — fetchMe hits a different endpoint (admin-users, not
      // admin-object) and its only effect here is gating the theme "Apply
      // theme…" button behind Owner (setOwner below); nothing in the recipe
      // loads reads it. It's genuinely independent, so it now runs
      // concurrently with fetchStudioData() instead of ahead of it. Its own
      // try/catch is kept nested (rather than folded into the outer one) so
      // a fetchMe failure still degrades to "not owner" instead of blanking
      // the whole page — the same behaviour as before.
      const fetchOwner = (async () => {
        try {
          const { fetchMe } = await import('@core/lib/admin/users-client');
          const me = await fetchMe(getToken);
          if (alive) setOwner(me.roles.includes('owner'));
        } catch {
          /* ignore */
        }
      })();
      try {
        const { fetchStudioData } = await import('@core/lib/admin/studio-client');
        // Never force here — a fresh in-memory/TTL cache (e.g. populated by
        // this very call a moment ago on a fast tab-switch remount) is
        // reused instead of firing a second full network sweep.
        const data = await fetchStudioData(getToken);
        if (alive) {
          setTemplates(data.templates);
          setSections(data.sections);
          setThemes(data.themes);
          setRefreshing(false);
        }
      } catch (loadError) {
        if (alive) {
          // If we already have cached data on screen, a failed background
          // refresh shouldn't blow away a working view — just stop spinning.
          if (initialData !== null) {
            setRefreshing(false);
          } else {
            setError(loadError instanceof Error ? loadError.message : 'Could not load the recipe family.');
          }
        }
      }
      await fetchOwner;
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return <EmptyState icon={<IconAlertTriangle size={26} />} title="Studio unavailable" message={error} />;
  }

  const navigate = (path: string) => window.location.assign(path);

  return (
    <div className="flex flex-col gap-6">
      {refreshing ? (
        <p
          className="flex items-center gap-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]"
          role="status"
          aria-live="polite"
        >
          <span className="inline-block animate-pulse">●</span> Refreshing…
        </p>
      ) : null}
      <section>
        <h2 className="mb-3 text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">
          Page templates
        </h2>
        {templates === null ? (
          <Skeleton variant="rect" height={140} />
        ) : templates.length === 0 ? (
          <EmptyState
            icon={<IconSparkles size={22} />}
            title="No page templates yet"
            message="There's no in-app form for minting one — page templates are created conversationally through the CMS Agents, or by an agent calling object_create with object_type: 'template' (include description, whenToUse, and scope so it can publish)."
          />
        ) : (
          <TemplateGallery templates={templates} onCreated={navigate} />
        )}
      </section>
      <section>
        <h2 className="mb-3 text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">
          Section templates
        </h2>
        {sections === null ? (
          <Skeleton variant="rect" height={140} />
        ) : sections.length === 0 ? (
          <EmptyState
            icon={<IconSparkles size={22} />}
            title="No section templates yet"
            message="There's no in-app form for minting one — section templates are created conversationally through the CMS Agents, or by an agent calling object_create with object_type: 'section_template' (include description, whenToUse, and scope so it can publish)."
          />
        ) : (
          <SectionTemplateGallery sections={sections} onCreated={navigate} />
        )}
      </section>
      <section>
        <h2 className="mb-3 text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">
          <span className="mr-2 inline-flex align-middle text-[var(--adm-accent)]">
            <IconPalette size={20} />
          </span>
          Themes
        </h2>
        {themes === null ? (
          <Skeleton variant="rect" height={140} />
        ) : themes.length === 0 ? (
          <EmptyState
            icon={<IconPalette size={22} />}
            title="No themes yet"
            message="There's no in-app form for minting one — themes are created conversationally through the CMS Agents, or by an agent calling object_create with object_type: 'theme' (include description, whenToUse, and scope so it can publish)."
          />
        ) : (
          <ThemeGallery themes={themes} owner={owner} identity={identity} />
        )}
      </section>
      <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
        New recipes are created conversationally — use the CMS Agents starters — or by an agent through the governed
        verbs. Creation stays contract-bound either way.
      </p>
    </div>
  );
}

export interface StudioProps {
  identity: SiteIdentity;
  currentPath?: string;
  title?: string;
}

export default function Studio({ identity, currentPath = '/admin/studio', title = 'Templates & Themes' }: StudioProps) {
  return (
    <AdminShell currentPath={currentPath} title={title} identity={identity}>
      <StudioBody identity={identity} />
    </AdminShell>
  );
}
