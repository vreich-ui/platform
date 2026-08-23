import { useEffect, useMemo, useState } from 'react';

import { AdminShell } from './AdminShell';
import { Badge, Button, Card, EmptyState, Skeleton } from './primitives';
import { IconExternalLink, IconFilePlus, IconLibrary, IconPalette, IconSparkles } from './icons';
import type { SiteIdentity } from '@core/lib/site-identity';
import { createFreeChat, listChats, sendChatMessage, type ChatSummaryView } from '@core/lib/admin/chat-client';
import { fetchInventoryRows } from '@core/lib/admin/library-client';
import { rowStatus, type LibraryRow } from '@core/lib/admin/library-logic';
import { fetchReleaseOverview } from '@core/lib/admin/release-client';
import { EDITORIAL_STATE_PRESENTATION, type EditorialObjectState } from '@core/lib/admin/editorial-state';
import { chatWorkLabel } from '@core/lib/admin/work-summary';
import { agentStarterHref } from '@core/lib/admin/agent-starters';
import { governedMediaCountLabel } from '@core/lib/admin/media-counts';
import type { ObjectType } from '@core/schema/object-record-v1';

async function token(): Promise<string> {
  const auth = await import('@core/lib/admin/goTrueClient');
  return (await auth.getAccessToken()) ?? '';
}

const href = (row: LibraryRow) => `/admin/content/${encodeURIComponent(row.object_id)}?type=${row.object_type}`;

function FoundationSlot({
  label,
  description,
  rows,
  prompt,
  lifecycle,
  work,
}: {
  label: string;
  description: string;
  rows: LibraryRow[];
  prompt: string;
  lifecycle?: EditorialObjectState;
  work?: ChatSummaryView;
}) {
  const primary = rows[0];
  const status = primary ? (lifecycle ? EDITORIAL_STATE_PRESENTATION[lifecycle] : rowStatus(primary)) : undefined;
  const create = async () => {
    const { chat } = await createFreeChat(token, `Create ${label}`);
    await sendChatMessage(token, chat.chat_id, prompt);
    window.location.assign(`/admin/agents?chat=${encodeURIComponent(chat.chat_id)}`);
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
        {rows.length > 1 ? (
          <p className="mt-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {rows.length} connected objects
          </p>
        ) : null}
      </div>
    </div>
  );
}

function FamilySummary({
  label,
  types,
  rows,
  href: destination,
  icon,
  countLabel,
}: {
  label: string;
  types: ObjectType[];
  rows: LibraryRow[];
  href: string;
  icon: React.ReactNode;
  countLabel?: (count: number) => string;
}) {
  const count = rows.filter((row) => types.includes(row.object_type)).length;
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

export default function AdminHome({ identity }: AdminHomeProps) {
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [states, setStates] = useState<Record<string, EditorialObjectState>>({});
  const [workByObject, setWorkByObject] = useState<Record<string, ChatSummaryView>>({});
  useEffect(() => {
    let live = true;
    Promise.all([
      fetchInventoryRows(token),
      fetchReleaseOverview(token).catch(() => undefined),
      listChats(token).catch((): { chats: ChatSummaryView[] } => ({ chats: [] })),
    ])
      .then(([next, overview, chatResult]) => {
        if (!live) return;
        setRows(next);
        setStates(Object.fromEntries((overview?.objects ?? []).map((object) => [object.object_id, object.state])));
        setWorkByObject(
          Object.fromEntries(
            chatResult.chats
              .filter((chat) =>
                ['queued', 'running', 'awaiting_approval', 'awaiting_candidate', 'error'].includes(chat.status)
              )
              .filter((chat): chat is ChatSummaryView & { object_id: string } => Boolean(chat.object_id))
              .map((chat) => [chat.object_id, chat])
          )
        );
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : 'Could not load the publication map.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);
  const byType = useMemo(() => (type: ObjectType) => rows.filter((row) => row.object_type === type), [rows]);
  const visualRows = [...byType('theme'), ...byType('site')];

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
        {loading ? (
          <Skeleton variant="rect" height={420} />
        ) : error ? (
          <Card>
            <EmptyState title="Couldn’t load the publication map" message={error} />
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
                  rows={byType('site')}
                  lifecycle={byType('site')[0] ? states[byType('site')[0].object_id] : undefined}
                  work={byType('site')[0] ? workByObject[byType('site')[0].object_id] : undefined}
                  prompt={`Create the publication identity object for ${identity.brandName}. Inspect existing objects first and propose the smallest governed change.`}
                />
                <FoundationSlot
                  label="Brand Voice"
                  description="Audience, tone, cadence, vocabulary, claims, safety, and article frameworks."
                  rows={byType('editorial_voice')}
                  lifecycle={byType('editorial_voice')[0] ? states[byType('editorial_voice')[0].object_id] : undefined}
                  work={byType('editorial_voice')[0] ? workByObject[byType('editorial_voice')[0].object_id] : undefined}
                  prompt={`Create the Brand Voice for ${identity.brandName}. Ask for any missing editorial decisions before proposing a governed object.`}
                />
                <FoundationSlot
                  label="Visual Identity"
                  description={`Aggregate view of ${byType('theme').length} theme object${byType('theme').length === 1 ? '' : 's'}, brand tokens, and logo configuration.`}
                  rows={visualRows}
                  lifecycle={visualRows[0] ? states[visualRows[0].object_id] : undefined}
                  work={visualRows[0] ? workByObject[visualRows[0].object_id] : undefined}
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
                  types={['page', 'section']}
                  rows={rows}
                  href="/admin/content"
                  icon={<IconFilePlus size={18} />}
                />
                <FamilySummary
                  label="Navigation"
                  types={['navigation']}
                  rows={rows}
                  href="/admin/content"
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
                  types={['template', 'section_template']}
                  rows={rows}
                  href="/admin/templates"
                  icon={<IconPalette size={18} />}
                />
                <FamilySummary
                  label="Media"
                  types={[]}
                  rows={rows}
                  href="/admin/media"
                  icon={<IconLibrary size={18} />}
                  countLabel={governedMediaCountLabel}
                />
                <FamilySummary
                  label="Content"
                  types={['content_item', 'product']}
                  rows={rows}
                  href="/admin/content"
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
