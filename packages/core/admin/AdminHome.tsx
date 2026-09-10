import { useEffect, useState } from 'react';
import { navigate } from 'astro:transitions/client';

import { AdminShell } from './AdminShell';
import { Badge, Button, Card, EmptyState, Skeleton } from './primitives';
import { IconExternalLink, IconFilePlus, IconLibrary, IconPalette, IconSparkles } from './icons';
import type { SiteIdentity } from '@core/lib/site-identity';
import { createFreeChat, sendChatMessage } from '@core/lib/admin/chat-client';
import { rowStatus, type LibraryRow } from '@core/lib/admin/library-logic';
import {
  fetchEditorialView,
  peekCachedEditorialView,
  EDITORIAL_VIEW_PERSISTED_MAX_AGE_MS,
  type EditorialSlotView,
  type EditorialView,
} from '@core/lib/admin/editorial-view-client';
import { EDITORIAL_STATE_PRESENTATION } from '@core/lib/admin/editorial-state';
import { chatWorkLabel } from '@core/lib/admin/work-summary';
import { agentStarterHref } from '@core/lib/admin/agent-starters';
import { governedMediaCountLabel } from '@core/lib/admin/media-counts';
// T1.1: a page-load read backs this page's own fetch, and (T1.2 R6) a
// cached snapshot seeds first paint below the same way Studio.tsx's
// `peekCachedStudioData()` does.
import { isAbortError } from '@core/lib/admin/page-generation';

async function token(): Promise<string> {
  const auth = await import('@core/lib/admin/goTrueClient');
  return (await auth.getAccessToken()) ?? '';
}

const href = (row: Pick<LibraryRow, 'object_id' | 'object_type'>) =>
  `/admin/content/${encodeURIComponent(row.object_id)}?type=${row.object_type}`;

function FoundationSlot({
  label,
  description,
  slot,
  prompt,
}: {
  label: string;
  description: string;
  slot: EditorialSlotView;
  prompt: string;
}) {
  const rows = slot.rows;
  const lifecycle = slot.state ?? undefined;
  const work = slot.work ?? undefined;
  const primary = rows[0];
  const status = primary
    ? lifecycle
      ? EDITORIAL_STATE_PRESENTATION[lifecycle]
      : rowStatus(primary as LibraryRow)
    : undefined;
  const create = async () => {
    const { chat } = await createFreeChat(token, `Create ${label}`);
    await sendChatMessage(token, chat.chat_id, prompt);
    void navigate(`/admin/agents?chat=${encodeURIComponent(chat.chat_id)}`);
  };
  return (
    <div className="flex min-h-40 flex-col rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-[var(--adm-text-heading)]">{label}</h3>
          <p className="mt-1 text-[length:var(--adm-text-xs)] leading-5 text-[var(--adm-text-muted)]">{description}</p>
        </div>
        {status ? <Badge tone={status.tone}>{status.label}</Badge> : <Badge tone="neutral">Missing</Badge>}
      </div>
      {work ? (
        <p className="mt-3 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-info-text)]">
          {chatWorkLabel(work)} · {work.title}
        </p>
      ) : null}
      <div className="mt-auto pt-4">
        {primary ? (
          <a
            href={href(primary)}
            className="adm-focusable inline-flex items-center gap-1 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-accent)] hover:underline"
          >
            Open workspace <IconExternalLink size={14} />
          </a>
        ) : (
          <Button variant="secondary" size="sm" leftIcon={<IconSparkles size={15} />} onClick={() => void create()}>
            Create with agent
          </Button>
        )}
        {slot.count > 1 ? (
          <p className="mt-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {slot.count} connected objects
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * T5.1 (T0.2 §6.3): `count` arrives as an integer. This used to receive the
 * WHOLE inventory and a type list, and filter it in the browser — which is why
 * the page downloaded N rows to render five numbers.
 */
function FamilySummary({
  label,
  count,
  href: destination,
  icon,
  countLabel,
}: {
  label: string;
  count: number;
  href: string;
  icon: React.ReactNode;
  countLabel?: (count: number) => string;
}) {
  return (
    <a
      href={destination}
      className="adm-focusable flex items-center gap-3 rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface)] p-4 hover:border-[var(--adm-accent)]"
    >
      <span className="grid h-9 w-9 place-items-center rounded-[var(--adm-radius-md)] bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-[var(--adm-text-heading)]">{label}</span>
        <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {countLabel ? countLabel(count) : `${count} object${count === 1 ? '' : 's'}`}
        </span>
      </span>
      <IconExternalLink size={15} />
    </a>
  );
}

export interface AdminHomeProps {
  identity: SiteIdentity;
}

// T1.2 R6: synchronous, no-network read of the last known publication map —
// the same stale-while-revalidate pattern Studio.tsx uses with
// `peekCachedStudioData()`/`STUDIO_PERSISTED_MAX_AGE_MS`. A repeat visit (or
// a reload within the window) paints immediately from the persisted
// snapshot instead of the blocking skeleton, while the effect below still
// fires a normal `fetchEditorialView()` to refresh it in the background.
function initialCachedEditorialView(): EditorialView | null {
  if (typeof window === 'undefined') return null;
  const cached = peekCachedEditorialView();
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > EDITORIAL_VIEW_PERSISTED_MAX_AGE_MS) return null;
  return cached.view;
}

export default function AdminHome({ identity }: AdminHomeProps) {
  const [initialView] = useState(initialCachedEditorialView);
  const [view, setView] = useState<EditorialView | null>(initialView);
  const [loading, setLoading] = useState(initialView === null);
  // A background refetch always runs, even when cached data painted
  // immediately — this only controls the small inline "refreshing…"
  // indicator instead of the blocking skeleton.
  const [refreshing, setRefreshing] = useState(initialView !== null);
  const [error, setError] = useState<string>();

  /**
   * T5.1 Phase 2 (T0.2 §6.3): ONE request.
   *
   * This mount used to `Promise.all` three — the whole object inventory, the
   * whole release overview (a SECOND full store sweep, computed server-side),
   * and the whole chat list — and block paint on all three, so the slowest of
   * them gated the page. Everything below renders three object rows and eight
   * integers, and that is now exactly what comes back.
   *
   * T1.2 R6: when `initialView` seeded first paint from the persisted cache,
   * this effect's job is only to revalidate in the background — a failure
   * here leaves the cached view on screen instead of blanking the page.
   */
  useEffect(() => {
    let live = true;
    fetchEditorialView(token)
      .then((next) => {
        if (live) {
          setView(next);
          setRefreshing(false);
        }
      })
      .catch((err) => {
        if (!live) return;
        // T1.1: the page navigating away is why this fetch died, not a real
        // failure — leave the view exactly as it was.
        if (isAbortError(err)) return;
        if (initialView !== null) {
          // A cached view is already on screen — don't blow it away over a
          // failed background refresh, just stop the "refreshing…" indicator.
          setRefreshing(false);
        } else {
          setError(err instanceof Error ? err.message : 'Could not load the publication map.');
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <AdminShell currentPath="/admin" title="Editorial" identity={identity}>
      <div className="flex flex-col gap-7">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
              Publication map
            </p>
            <h2 className="mt-1 text-[length:var(--adm-text-2xl)] font-semibold text-[var(--adm-text-heading)]">
              {identity.brandName}
            </h2>
            <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
              The governed foundation, structure, and editorial collections behind this publication.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={agentStarterHref('article')}
              className="adm-focusable inline-flex h-10 items-center rounded-[var(--adm-radius-md)] border border-transparent bg-[var(--adm-accent)] px-4 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-on-accent)] hover:bg-[var(--adm-accent-hover)]"
            >
              New article
            </a>
            <a
              href={agentStarterHref('page')}
              className="adm-focusable inline-flex h-10 items-center rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] bg-[var(--adm-surface-raised)] px-4 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]"
            >
              New page
            </a>
          </div>
        </header>
        {refreshing ? (
          <p
            className="flex items-center gap-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]"
            role="status"
            aria-live="polite"
          >
            <span className="inline-block animate-pulse">●</span> Refreshing…
          </p>
        ) : null}
        {loading ? (
          <Skeleton variant="rect" height={420} />
        ) : error ? (
          <Card>
            <EmptyState severity="error" title="Couldn’t load the publication map" message={error} />
          </Card>
        ) : !view ? (
          <Card>
            <EmptyState
              severity="error"
              title="Couldn’t load the publication map"
              message="The publication map came back empty. Refresh to try again."
            />
          </Card>
        ) : (
          <>
            <section>
              <h2 className="mb-3 text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">
                Foundation
              </h2>
              <div className="grid gap-4 md:grid-cols-3">
                <FoundationSlot
                  label="Publication identity"
                  description="Name, public identity, defaults, and publication-level metadata."
                  slot={view.foundation.site}
                  prompt={`Create the publication identity object for ${identity.brandName}. Inspect existing objects first and propose the smallest governed change.`}
                />
                <FoundationSlot
                  label="Brand Voice"
                  description="Audience, tone, cadence, vocabulary, claims, safety, and article frameworks."
                  slot={view.foundation.editorial_voice}
                  prompt={`Create the Brand Voice for ${identity.brandName}. Ask for any missing editorial decisions before proposing a governed object.`}
                />
                <FoundationSlot
                  label="Visual Identity"
                  description={`Aggregate view of ${view.foundation.visual_identity.theme_count} theme object${view.foundation.visual_identity.theme_count === 1 ? '' : 's'}, brand tokens, and logo configuration.`}
                  slot={view.foundation.visual_identity}
                  prompt={`Create the visual identity foundation for ${identity.brandName}, reusing any existing theme and site brand tokens.`}
                />
              </div>
            </section>
            <section>
              <h2 className="mb-3 text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">
                Structure
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <FamilySummary
                  label="Pages"
                  count={view.families.pages}
                  href="/admin/objects?type=page,section"
                  icon={<IconFilePlus size={18} />}
                />
                <FamilySummary
                  label="Navigation"
                  count={view.families.navigation}
                  href="/admin/objects?type=navigation"
                  icon={<IconLibrary size={18} />}
                />
              </div>
            </section>
            <section>
              <h2 className="mb-3 text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">
                Editorial collections
              </h2>
              <div className="grid gap-4 sm:grid-cols-3">
                <FamilySummary
                  label="Templates"
                  count={view.families.templates}
                  href="/admin/objects?type=template,section_template"
                  icon={<IconPalette size={18} />}
                />
                <FamilySummary
                  label="Media"
                  count={view.families.media}
                  // No governed object type is "media" (see media-counts.ts's
                  // own comment) — the objects plane's grid view is the
                  // closest honest destination, not a fabricated type facet.
                  href="/admin/objects?view=grid"
                  icon={<IconLibrary size={18} />}
                  countLabel={governedMediaCountLabel}
                />
                <FamilySummary
                  label="Content"
                  count={view.families.content}
                  href="/admin/objects?type=content_item,product"
                  icon={<IconLibrary size={18} />}
                />
              </div>
            </section>
          </>
        )}
      </div>
    </AdminShell>
  );
}
