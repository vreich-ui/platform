/**
 * Visual identity → PDF templates tab (U1, brand-imagery wave).
 *
 * A thin renderer, for the same reason as `ImageryBoard.tsx`: the `.tsx` files
 * are excluded from `tsconfig.test.json`, so every decision — the default
 * badge, the validation reading, what disables "Set as site default", the
 * `set_site_fields` payload, which artifact is the newest sample — lives in
 * `@core/lib/admin/visual-identity-pdf` where a `node:test` can hold it
 * honest.
 *
 * DATA IN, NO NEW ENDPOINT. The list comes from the EXISTING
 * `admin-editorial-assets` endpoint (which already calls `list_pdf_templates`
 * and also carries the rendered-PDF artifacts this panel previews); the
 * default pointer comes from the site record the workspace already loaded.
 * `site.pdf` is an ORDINARY, additive block (§3.2), so "Set as site default"
 * is a plain `set_site_fields` patch under a normal site checkout — no
 * privileged funnel, no apply verb.
 *
 * "Render sample" needs `create_agent_artifact_job`, an MCP tool with no
 * browser-reachable admin endpoint, so it goes through `onIntent` to the
 * docked rail — exactly what `TemplatesWorkspace` has always done for this
 * action. The rendered PDF then comes back as an ordinary indexed artifact and
 * is previewed with the shared `ArtifactStagePreview`.
 *
 * T2.6 adds three things, all decided in `visual-identity-pdf.ts`:
 *  - a DIRECT "Render sample (first page only)" chip over W1's
 *    `preview_pdf_template` — shorter than the job above (no poll loop),
 *    labeled so it is never mistaken for the complete document;
 *  - the byKind selector next to "Set as site default" — the same
 *    `set_site_fields` merge, scoped to one kind (`buildPinKindDefaultOp`);
 *  - thumbnails that can now say WHY one is missing (W1's `thumbnailError`),
 *    not just that it is.
 */
import { useCallback, useMemo, useState } from 'react';

import { ArtifactStagePreview } from './ArtifactStagePreview';
import { Badge, Button, Card, EmptyState } from './primitives';
import { Select } from './forms';
import { IconAlertTriangle } from './icons';
import type { SiteIdentity } from '@core/lib/site-identity';
import type { EditorialArtifact } from '@core/lib/admin/editorial-assets';
import type { StudioRecord } from '@core/lib/admin/studio-client';
import { EditSession, type GetToken } from '@core/lib/edit-mode/verbs-client';
import type { VisualIdentityChatIntent } from '@core/lib/admin/visual-identity-imagery';
import {
  buildPdfTemplatesViewModel,
  buildPinKindDefaultOp,
  buildPreviewSampleIntent,
  buildRenderSampleIntent,
  buildSetSiteDefaultOp,
  latestSampleArtifact,
  pdfKindOptions,
  type PdfTemplateInput,
  type PdfTemplateRow,
} from '@core/lib/admin/visual-identity-pdf';

const MUTED = 'text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]';

function TemplateThumbnail({ row }: { row: PdfTemplateRow }) {
  if (!row.thumbnailUrl) {
    return (
      <div className="grid h-28 place-items-center rounded-[var(--adm-radius-sm)] border border-dashed border-[var(--adm-border-strong)] px-3 text-center">
        <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {row.thumbnailMissingReason}
        </span>
      </div>
    );
  }
  return (
    <div className="max-h-40 overflow-hidden rounded-[var(--adm-radius-sm)] border border-[var(--adm-border)]">
      <ArtifactStagePreview
        artifact={{
          id: `${row.id}-thumb`,
          kind: 'image',
          family: 'documents',
          label: `${row.label} thumbnail`,
          filename: `${row.id}.png`,
          preview_url: row.thumbnailUrl,
          created_at: '',
          size_bytes: 0,
          tags: [],
        }}
      />
    </div>
  );
}

export interface PdfTemplatesPanelProps {
  identity: SiteIdentity;
  site: StudioRecord | undefined;
  templates: readonly PdfTemplateInput[];
  /** Rendered PDFs already in the artifact index — the source for "Render sample" previews. */
  artifacts: readonly EditorialArtifact[];
  /** False when the pdf-tool bridge is unconfigured for this publication. */
  available: boolean;
  isOwner: boolean;
  getToken: GetToken;
  onIntent: (intent: VisualIdentityChatIntent) => void;
  onChanged: () => void | Promise<void>;
}

export function PdfTemplatesPanel({
  identity,
  site,
  templates,
  artifacts,
  available,
  isOwner,
  getToken,
  onIntent,
  onChanged,
}: PdfTemplatesPanelProps) {
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [previewId, setPreviewId] = useState<string | undefined>(undefined);
  /** T2.6: the kind each row's byKind selector currently has picked, keyed by template id. */
  const [kindChoice, setKindChoice] = useState<Record<string, string>>({});

  const model = useMemo(
    () =>
      buildPdfTemplatesViewModel({
        templates,
        siteBody: site?.body,
        available,
        canEdit: isOwner,
      }),
    [templates, site?.body, available, isOwner]
  );

  const kindOptions = useMemo(() => pdfKindOptions(model.rows), [model.rows]);

  const pinKind = useCallback(
    async (templateId: string, kind: string) => {
      setBusyId(templateId);
      setError(undefined);
      setNotice(undefined);
      const session = new EditSession('site', identity.siteId, getToken);
      try {
        const checkout = await session.ensureCheckout();
        if (!checkout.ok) {
          setError(`The publication is checked out by ${checkout.heldBy ?? 'someone else'}.`);
          return;
        }
        const result = await session.patch([buildPinKindDefaultOp(kind, templateId)]);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setNotice(`${templateId} is now the default PDF template for ${kind}.`);
        await onChanged();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'The kind default could not be set.');
      } finally {
        await session.checkin().catch(() => undefined);
        setBusyId(undefined);
      }
    },
    [getToken, identity.siteId, onChanged]
  );

  const setSiteDefault = useCallback(
    async (templateId: string) => {
      setBusyId(templateId);
      setError(undefined);
      setNotice(undefined);
      const session = new EditSession('site', identity.siteId, getToken);
      try {
        const checkout = await session.ensureCheckout();
        if (!checkout.ok) {
          setError(`The publication is checked out by ${checkout.heldBy ?? 'someone else'}.`);
          return;
        }
        const result = await session.patch([buildSetSiteDefaultOp(templateId)]);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setNotice(`${templateId} is now the publication's default PDF template.`);
        await onChanged();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'The default could not be set.');
      } finally {
        await session.checkin().catch(() => undefined);
        setBusyId(undefined);
      }
    },
    [getToken, identity.siteId, onChanged]
  );

  const previewRow = model.rows.find((row) => row.id === previewId);
  const previewArtifact = previewRow ? latestSampleArtifact(previewRow.id, artifacts) : undefined;

  return (
    <div className="flex flex-col gap-5">
      {error ? <EmptyState severity="error" title="That did not go through" message={error} /> : null}
      {notice ? (
        <p className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-success-soft)] px-3 py-2 text-[length:var(--adm-text-sm)] text-[var(--adm-success-text)]">
          {notice}
        </p>
      ) : null}

      {model.danglingDefault ? (
        <div className="flex items-start gap-3 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] bg-[var(--adm-warning-soft)] px-3 py-2">
          <IconAlertTriangle size={16} />
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-warning-text)]">
            This publication&rsquo;s default PDF template is <code>{model.danglingDefault}</code>, which pdf-tool no
            longer lists. Pick a published template below.
          </p>
        </div>
      ) : null}

      {model.emptyState ? (
        <EmptyState title={model.emptyState.title} message={model.emptyState.message} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {model.rows.map((row) => (
            <Card
              key={row.id}
              kicker={row.kindLabel}
              title={row.label}
              actions={
                <span className="flex flex-wrap items-center gap-1">
                  {row.badges.map((badge) => (
                    <Badge key={`${badge.scope}-${badge.kind ?? 'site'}`} tone={badge.tone}>
                      {badge.label}
                    </Badge>
                  ))}
                  <Badge tone={row.validation.tone}>{row.validation.label}</Badge>
                </span>
              }
              footer={<span className={MUTED}>{row.validation.detail}</span>}
            >
              <div className="flex flex-col gap-3">
                <TemplateThumbnail row={row} />
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[length:var(--adm-text-xs)]">
                  <dt className="text-[var(--adm-text-muted)]">Template id</dt>
                  <dd className="truncate font-mono text-[var(--adm-text)]">{row.id}</dd>
                  <dt className="text-[var(--adm-text-muted)]">Latest version</dt>
                  <dd className="text-[var(--adm-text)]">{row.version}</dd>
                  <dt className="text-[var(--adm-text-muted)]">Render data schema</dt>
                  <dd className="text-[var(--adm-text)]">{row.hasRenderDataSchema ? 'declared' : 'not reported'}</dd>
                </dl>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={!row.canSetDefault || row.isSiteDefault || busyId !== undefined}
                    onClick={() => void setSiteDefault(row.id)}
                  >
                    {row.isSiteDefault ? 'Already the site default' : 'Set as site default'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!row.canRenderSample}
                    onClick={() => {
                      onIntent(buildRenderSampleIntent(row));
                      setPreviewId(row.id);
                    }}
                  >
                    Render sample
                  </Button>
                  {/* T2.6: the DIRECT chip — W1's preview_pdf_template, first
                      page only. A shorter path than the full sample above
                      (no job to poll), labeled so it is never mistaken for
                      the complete rendered document. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!row.canRenderSample}
                    onClick={() => {
                      onIntent(buildPreviewSampleIntent(row));
                      setPreviewId(row.id);
                    }}
                  >
                    Render sample (first page only)
                  </Button>
                  {latestSampleArtifact(row.id, artifacts) ? (
                    <Button variant="ghost" size="sm" onClick={() => setPreviewId(row.id)}>
                      Show latest sample
                    </Button>
                  ) : null}
                </div>
                {/* T2.6: the byKind selector, alongside "Set as site default" —
                    the same `set_site_fields` merge, scoped to one kind
                    (`buildPinKindDefaultOp`) instead of the whole publication. */}
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label={`Content kind to pin ${row.label} as the default for`}
                    className="w-40"
                    options={kindOptions.map((option) => ({ value: option.kind, label: option.label }))}
                    value={kindChoice[row.id] ?? row.kind ?? kindOptions[0]?.kind ?? ''}
                    onChange={(event) => setKindChoice((prior) => ({ ...prior, [row.id]: event.target.value }))}
                    disabled={!row.canSetDefault || busyId !== undefined}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!row.canSetDefault || busyId !== undefined}
                    onClick={() => {
                      const kind = kindChoice[row.id] ?? row.kind ?? kindOptions[0]?.kind;
                      if (kind) void pinKind(row.id, kind);
                    }}
                  >
                    Set as default for kind
                  </Button>
                </div>
                {!row.canSetDefault && row.setDefaultBlockedReason ? (
                  <p className={MUTED}>{row.setDefaultBlockedReason}</p>
                ) : null}
                {!row.canRenderSample && row.renderSampleBlockedReason ? (
                  <p className={MUTED}>{row.renderSampleBlockedReason}</p>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}

      {model.byKind.length ? (
        <Card kicker="Per-kind pins" title="Templates pinned to a content kind">
          <ul className="flex flex-col gap-1">
            {model.byKind.map((pin) => (
              <li key={pin.kind} className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
                <span className="text-[var(--adm-text-muted)]">{pin.kind}: </span>
                <code>{pin.templateId}</code>
                {pin.resolved ? null : (
                  <Badge tone="danger" className="ml-2">
                    not listed
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {previewRow ? (
        <Card kicker="Sample" title={`Latest rendered sample — ${previewRow.label}`}>
          {previewArtifact ? (
            <ArtifactStagePreview artifact={previewArtifact} />
          ) : (
            <EmptyState
              title="No sample rendered yet"
              message="The agent is producing it. Reload this tab once the run finishes and the PDF will appear here."
            />
          )}
        </Card>
      ) : null}
    </div>
  );
}

export default PdfTemplatesPanel;
