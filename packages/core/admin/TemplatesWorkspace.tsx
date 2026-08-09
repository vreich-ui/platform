import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdminShell } from './AdminShell';
import { AgentRail } from './AgentRail';
import { ArtifactPreviewPlaceholder, ArtifactStagePreview } from './ArtifactStagePreview';
import { useChat } from './chat';
import { Badge, Button, Card, EmptyState, Skeleton } from './primitives';
import { IconAlertTriangle, IconLibrary, IconSparkles } from './icons';
import type { SiteIdentity } from '@core/lib/site-identity';
import { createFreeChat } from '@core/lib/admin/chat-client';
import { fetchStudioData, type StudioRecord } from '@core/lib/admin/studio-client';
import { fetchEditorialAssets } from '@core/lib/admin/editorial-assets-client';
import type { EditorialArtifact, EditorialAssetsPayload, PdfTemplateSummary } from '@core/lib/admin/editorial-assets';
import { contextActionsFor } from '@core/lib/admin/object-context-actions';
import { objectStageModeClass } from '@core/lib/admin/object-stage';
import { agentStarterHref, type AgentStarterKey } from '@core/lib/admin/agent-starters';

async function getToken(): Promise<string> {
  const auth = await import('@core/lib/admin/goTrueClient');
  return (await auth.getAccessToken()) ?? '';
}

type FamilyId = 'articles' | 'pages' | 'sections' | 'images' | 'pdfs' | 'newsletters';

const FAMILIES: Array<{ id: FamilyId; label: string; description: string }> = [
  { id: 'articles', label: 'Articles', description: 'Standards for article structure and voice.' },
  { id: 'pages', label: 'Pages', description: 'Reusable page structures.' },
  { id: 'sections', label: 'Sections', description: 'Reusable page-section recipes.' },
  { id: 'images', label: 'Images', description: 'Visual direction and image standards.' },
  { id: 'pdfs', label: 'PDFs', description: 'Templates manufactured through PDF tools.' },
  { id: 'newsletters', label: 'Newsletters', description: 'Reusable email structures.' },
];

const CREATION_STARTER: Partial<Record<FamilyId, AgentStarterKey>> = {
  articles: 'article',
  pages: 'page',
  sections: 'section-template',
  images: 'media',
  pdfs: 'media',
};

const displayName = (record: StudioRecord): string =>
  typeof record.body?.name === 'string' ? record.body.name : 'Untitled template';

function GovernedTemplateList({ records, kind }: { records: StudioRecord[]; kind: 'template' | 'section_template' }) {
  if (!records.length) {
    return <EmptyState title="No templates yet" message="Ask the Publishing Agent to establish the first one." />;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {records.map((record) => (
        <a
          key={record.object_id}
          href={`/admin/content/${encodeURIComponent(record.object_id)}?type=${kind}`}
          className="adm-focusable rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface)] p-4 hover:border-[var(--adm-accent)]"
        >
          <p className="font-medium text-[var(--adm-text-heading)]">{displayName(record)}</p>
          {typeof record.body?.description === 'string' ? (
            <p className="mt-1 line-clamp-2 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
              {record.body.description}
            </p>
          ) : null}
          {typeof record.body?.whenToUse === 'string' ? (
            <p className="mt-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              <span className="font-medium">Useful when:</span> {record.body.whenToUse}
            </p>
          ) : null}
        </a>
      ))}
    </div>
  );
}

function Gap({ family }: { family: 'Article' | 'Image' | 'Newsletter' }) {
  const next =
    family === 'Image'
      ? 'A future image-standard object should govern purpose, composition, allowed visual language, and representative examples without owning generated image bytes.'
      : family === 'Newsletter'
        ? 'A future newsletter-template object should govern subject/body structure, rendering constraints, and purpose without widening the page-template schema.'
        : 'Article frameworks currently live in Brand Voice. A separate article-template model should be introduced only when reusable article structures need their own lifecycle.';
  return (
    <Card>
      <EmptyState
        icon={<IconSparkles size={24} />}
        title={`No governed ${family.toLowerCase()} template model yet`}
        message={next}
      />
    </Card>
  );
}

function PdfTemplateRoom({
  template,
  artifacts,
  onRefresh,
}: {
  template: PdfTemplateSummary;
  artifacts: EditorialArtifact[];
  onRefresh: () => Promise<void>;
}) {
  const [chatId, setChatId] = useState<string>();
  const chat = useChat(getToken, chatId);
  const sample = artifacts.find((artifact) => artifact.kind === 'pdf' && artifact.template_id === template.id);
  const actions = contextActionsFor({ focusKind: 'pdf-template', focusLabel: template.label }).map((action) => ({
    id: action.id,
    label: action.label,
    text: action.buildContext({ focusKind: 'pdf-template', focusLabel: template.label }),
  }));

  useEffect(() => {
    const key = `pdf-template-chat:${template.id}`;
    const existing = sessionStorage.getItem(key);
    if (existing) {
      setChatId(existing);
      return;
    }
    createFreeChat(getToken, `PDF template: ${template.label}`)
      .then(({ chat: created }) => {
        sessionStorage.setItem(key, created.chat_id);
        setChatId(created.chat_id);
      })
      .catch(() => setChatId(undefined));
  }, [template.id]);

  useEffect(() => {
    if (chat.writeStamp > 0) void onRefresh();
  }, [chat.writeStamp, onRefresh]);

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,68%)_minmax(19rem,32%)]">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] lg:h-[calc(100dvh-10rem)]">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--adm-border)] bg-[var(--adm-surface)] px-4 py-3">
          <div>
            <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
              PDF Object Stage
            </p>
            <h3 className="mt-1 font-semibold text-[var(--adm-text-heading)]">{template.label}</h3>
            <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              {template.renderer} · version {template.version}
            </p>
          </div>
          <Badge tone={template.status === 'active' ? 'success' : template.status === 'draft' ? 'warning' : 'neutral'}>
            {template.status}
          </Badge>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className={objectStageModeClass('document')}>
            {sample ? (
              <ArtifactStagePreview artifact={sample} />
            ) : (
              <ArtifactPreviewPlaceholder title="No sample PDF yet" />
            )}
          </div>
        </div>
        <footer className="border-t border-[var(--adm-border)] bg-[var(--adm-surface)] px-4 py-3 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {sample
            ? 'The latest generated sample remains visible while the Publishing Agent produces another version.'
            : 'Ask the Publishing Agent to render a sample. It will reuse the existing job when polling.'}
        </footer>
      </section>
      <AgentRail
        chat={chat}
        focus={template.label}
        agentFocus={`PDF template ${template.id}. Use the existing PDF-tool bridge, keep grants and raw job data server-side, and poll an existing artifact job instead of recreating it.`}
        contextActions={actions}
        suggestions={['Explain what this template is designed to create.', 'Render a sample for review.']}
      />
    </div>
  );
}

export default function TemplatesWorkspace({ identity }: { identity: SiteIdentity }) {
  const [family, setFamily] = useState<FamilyId>('pages');
  const [templates, setTemplates] = useState<StudioRecord[]>([]);
  const [sections, setSections] = useState<StudioRecord[]>([]);
  const [assets, setAssets] = useState<EditorialAssetsPayload>();
  const [selectedPdf, setSelectedPdf] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refreshAssets = useCallback(async () => {
    const next = await fetchEditorialAssets(getToken);
    setAssets(next);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [studio, editorial] = await Promise.all([fetchStudioData(getToken), fetchEditorialAssets(getToken)]);
      setTemplates(studio.templates);
      setSections(studio.sections);
      setAssets(editorial);
      setSelectedPdf(editorial.pdf_templates[0]?.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Templates could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo<Record<FamilyId, number>>(
    () => ({
      articles: 0,
      pages: templates.length,
      sections: sections.length,
      images: 0,
      pdfs: assets?.pdf_templates.length ?? 0,
      newsletters: 0,
    }),
    [assets, sections.length, templates.length]
  );
  const selected = assets?.pdf_templates.find((template) => template.id === selectedPdf);
  const creationStarter = CREATION_STARTER[family];

  return (
    <AdminShell currentPath="/admin/templates" title="Templates" identity={identity} wide>
      <div className="flex flex-col gap-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[length:var(--adm-text-2xl)] font-semibold text-[var(--adm-text-heading)]">Templates</h1>
            <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
              Reusable standards, organized by what they create.
            </p>
          </div>
          <a
            href={creationStarter ? agentStarterHref(creationStarter) : '/admin/agents'}
            className="adm-focusable inline-flex h-10 items-center rounded-[var(--adm-radius-md)] border border-transparent bg-[var(--adm-accent)] px-4 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-on-accent)] hover:bg-[var(--adm-accent-hover)]"
          >
            {creationStarter ? `Create ${FAMILIES.find((item) => item.id === family)?.label.toLowerCase()} with agent` : 'Ask CMS Agent'}
          </a>
        </header>
        {loading ? (
          <div className="flex flex-col gap-3" role="status" aria-live="polite">
            <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">Loading reusable templates and PDF samples…</p>
            <Skeleton variant="rect" height={360} />
          </div>
        ) : error ? (
          <EmptyState
            icon={<IconAlertTriangle size={26} />}
            title="Templates unavailable"
            message={`${error} No template has been changed.`}
            action={<Button variant="secondary" onClick={() => void load()}>Try again</Button>}
          />
        ) : (
          <>
            <nav className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="Template families">
              {FAMILIES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFamily(item.id)}
                  className={`adm-focusable rounded-[var(--adm-radius-lg)] border p-3 text-left ${family === item.id ? 'border-[var(--adm-accent)] bg-[var(--adm-accent-soft)]' : 'border-[var(--adm-border)] bg-[var(--adm-surface)] hover:border-[var(--adm-border-strong)]'}`}
                >
                  <span className="block font-medium text-[var(--adm-text-heading)]">{item.label}</span>
                  <span className="mt-1 block text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                    {counts[item.id]} available
                  </span>
                </button>
              ))}
            </nav>
            {family === 'pages' ? <GovernedTemplateList records={templates} kind="template" /> : null}
            {family === 'sections' ? <GovernedTemplateList records={sections} kind="section_template" /> : null}
            {family === 'articles' ? <Gap family="Article" /> : null}
            {family === 'images' ? <Gap family="Image" /> : null}
            {family === 'newsletters' ? <Gap family="Newsletter" /> : null}
            {family === 'pdfs' ? (
              !assets?.pdf_templates_available ? (
                <EmptyState
                  icon={<IconLibrary size={24} />}
                  title="PDF templates unavailable"
                  message="This publication’s server-side PDF bridge is not currently available. No credentials are exposed to the browser."
                />
              ) : !assets.pdf_templates.length ? (
                <EmptyState
                  title="No PDF templates yet"
                  message="Ask the Publishing Agent to establish the first one."
                />
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="flex gap-2 overflow-x-auto pb-1" aria-label="PDF templates">
                    {assets.pdf_templates.map((template) => (
                      <Button
                        key={template.id}
                        size="sm"
                        variant={template.id === selectedPdf ? 'primary' : 'secondary'}
                        onClick={() => setSelectedPdf(template.id)}
                      >
                        {template.label}
                      </Button>
                    ))}
                  </div>
                  {selected ? (
                    <PdfTemplateRoom template={selected} artifacts={assets.artifacts} onRefresh={refreshAssets} />
                  ) : null}
                </div>
              )
            ) : null}
          </>
        )}
        <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          Themes remain available to Owners under Settings while visual identity is reviewed as a publication object.
          The legacy Studio route remains available during migration.
        </p>
      </div>
    </AdminShell>
  );
}
