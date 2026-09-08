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
 * "Render sample" and "Render sample (first page only)" are, since A5, two
 * DIRECT endpoints instead of chat instructions
 * (`admin-visual-identity-render-sample`, `admin-visual-identity-preview-sample`
 * — packages/core/server/functions/) — no `onIntent` reaches this panel at
 * all any more. The full sample comes back as an ordinary indexed artifact
 * and is previewed with the shared `ArtifactStagePreview`; the first-page-only
 * chip renders inline (no job, nothing to poll) and is previewed directly
 * from its own response, honestly labeled as first-page-only.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ArtifactStagePreview } from './ArtifactStagePreview';
import { Badge, Button, Card, EmptyState } from './primitives';
import { Select } from './forms';
import { IconAlertTriangle } from './icons';
import type { SiteIdentity } from '@core/lib/site-identity';
import type { EditorialArtifact } from '@core/lib/admin/editorial-assets';
import type { StudioRecord } from '@core/lib/admin/studio-client';
import { EditSession, type GetToken } from '@core/lib/edit-mode/verbs-client';
import { renderPdfTemplateSample } from '@core/lib/admin/visual-identity-render-sample-client';
import { previewPdfTemplateSample } from '@core/lib/admin/visual-identity-preview-sample-client';
import {
  SAMPLE_RENDER_POLL_INTERVAL_MS,
  buildPdfTemplatesViewModel,
  buildPinKindDefaultOp,
  buildSetSiteDefaultOp,
  latestSampleArtifact,
  pdfKindOptions,
  sampleRenderWaitState,
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
  onChanged,
}: PdfTemplatesPanelProps) {
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  /** Which action is in flight for `busyId`'s row — lets the row's OTHER
   *  buttons (also disabled while busyId is set, per the existing
   *  single-flight-per-checkout rule) stay silent instead of all claiming
   *  to be the one running. Presentation only; does not change what is
   *  disabled or when. */
  const [busyAction, setBusyAction] = useState<'default' | 'kind' | 'sample' | 'preview' | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  /** D3: the SAME outcome as `error`/`notice` above, but keyed by template id
   *  so the row a click actually acted on shows its own result inline —
   *  the top banner is 25 cards away from a click deep in the grid. */
  const [rowMessage, setRowMessage] = useState<Record<string, { tone: 'success' | 'error'; text: string } | undefined>>(
    {}
  );
  const [previewId, setPreviewId] = useState<string | undefined>(undefined);
  /** A5: the first-page-only chip's own last result, shown instead of an
   *  indexed artifact when the row has no rendered sample (or this is
   *  newer) — `preview_pdf_template` produces no job, so nothing indexes it. */
  const [directPreview, setDirectPreview] = useState<{ templateId: string; url?: string } | undefined>(undefined);
  /** T2.6: the kind each row's byKind selector currently has picked, keyed by template id. */
  const [kindChoice, setKindChoice] = useState<Record<string, string>>({});
  /** W5 F7: a render whose job outlived the endpoint's inline wait (202). The
   *  effect below re-reads the artifact index until the sample lands. */
  const [pendingRender, setPendingRender] = useState<{ templateId: string; label: string } | undefined>(undefined);
  const pendingRenderAttemptsRef = useRef(0);

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

  /** D3: sets the top banner AND the acting row's own inline message from
   *  one call, so the two never drift out of sync. */
  const setFeedback = useCallback((templateId: string, tone: 'success' | 'error', text: string) => {
    if (tone === 'error') {
      setError(text);
      setNotice(undefined);
    } else {
      setNotice(text);
      setError(undefined);
    }
    setRowMessage((prior) => ({ ...prior, [templateId]: { tone, text } }));
  }, []);

  const pinKind = useCallback(
    async (templateId: string, kind: string) => {
      setBusyId(templateId);
      setBusyAction('kind');
      setError(undefined);
      setNotice(undefined);
      setRowMessage((prior) => ({ ...prior, [templateId]: undefined }));
      const session = new EditSession('site', identity.siteId, getToken);
      try {
        const checkout = await session.ensureCheckout();
        if (!checkout.ok) {
          setFeedback(templateId, 'error', `The publication is checked out by ${checkout.heldBy ?? 'someone else'}.`);
          return;
        }
        const result = await session.patch([buildPinKindDefaultOp(kind, templateId)]);
        if (!result.ok) {
          setFeedback(templateId, 'error', result.error);
          return;
        }
        setFeedback(templateId, 'success', `${templateId} is now the default PDF template for ${kind}.`);
        await onChanged();
      } catch (reason) {
        setFeedback(templateId, 'error', reason instanceof Error ? reason.message : 'The kind default could not be set.');
      } finally {
        await session.checkin().catch(() => undefined);
        setBusyId(undefined);
      }
    },
    [getToken, identity.siteId, onChanged, setFeedback]
  );

  const setSiteDefault = useCallback(
    async (templateId: string) => {
      setBusyId(templateId);
      setBusyAction('default');
      setError(undefined);
      setNotice(undefined);
      setRowMessage((prior) => ({ ...prior, [templateId]: undefined }));
      const session = new EditSession('site', identity.siteId, getToken);
      try {
        const checkout = await session.ensureCheckout();
        if (!checkout.ok) {
          setFeedback(templateId, 'error', `The publication is checked out by ${checkout.heldBy ?? 'someone else'}.`);
          return;
        }
        const result = await session.patch([buildSetSiteDefaultOp(templateId)]);
        if (!result.ok) {
          setFeedback(templateId, 'error', result.error);
          return;
        }
        setFeedback(templateId, 'success', `${templateId} is now the publication's default PDF template.`);
        await onChanged();
      } catch (reason) {
        setFeedback(templateId, 'error', reason instanceof Error ? reason.message : 'The default could not be set.');
      } finally {
        await session.checkin().catch(() => undefined);
        setBusyId(undefined);
      }
    },
    [getToken, identity.siteId, onChanged, setFeedback]
  );

  /**
   * A5: the full multi-page sample, via `create_agent_artifact_job`'s own
   * inline wait — a single call usually comes back with the finished
   * artifact already. `onChanged()` reloads the artifact index so
   * `latestSampleArtifact` below picks the one this call just produced.
   */
  const renderSample = useCallback(
    async (row: PdfTemplateRow) => {
      setBusyId(row.id);
      setBusyAction('sample');
      setError(undefined);
      setNotice(undefined);
      setRowMessage((prior) => ({ ...prior, [row.id]: undefined }));
      setDirectPreview(undefined);
      setPreviewId(row.id);
      try {
        const result = await renderPdfTemplateSample(getToken, { templateId: row.id });
        // W5 F7: only say "rendered" when something actually rendered. A 202
        // means the job is still running — wait for it rather than announcing
        // a sample that is not there and cannot be polled.
        if (result.pending) {
          pendingRenderAttemptsRef.current = 0;
          setPendingRender({ templateId: row.id, label: row.label });
          setFeedback(row.id, 'success', `Still rendering ${row.label} — this panel updates when the sample lands.`);
        } else {
          setPendingRender(undefined);
          setFeedback(row.id, 'success', `A sample of ${row.label} was rendered.`);
        }
        await onChanged();
      } catch (reason) {
        setFeedback(row.id, 'error', reason instanceof Error ? reason.message : 'The sample could not be rendered.');
      } finally {
        setBusyId(undefined);
      }
    },
    [getToken, onChanged, setFeedback]
  );

  /**
   * A5: the direct first-page-only chip — no job, nothing to poll, and
   * nothing this produces is indexed as an artifact, so its result is shown
   * from the response itself (`directPreview`) rather than from `artifacts`.
   */
  const previewSample = useCallback(
    async (row: PdfTemplateRow) => {
      setBusyId(row.id);
      setBusyAction('preview');
      setError(undefined);
      setNotice(undefined);
      setRowMessage((prior) => ({ ...prior, [row.id]: undefined }));
      setPreviewId(row.id);
      try {
        const result = await previewPdfTemplateSample(getToken, { templateId: row.id });
        setDirectPreview({ templateId: row.id, ...(result.previewUrl ? { url: result.previewUrl } : {}) });
        setFeedback(row.id, 'success', `First page of ${row.label} rendered — not the complete document.`);
      } catch (reason) {
        setFeedback(row.id, 'error', reason instanceof Error ? reason.message : 'The preview could not be rendered.');
      } finally {
        setBusyId(undefined);
      }
    },
    [getToken, setFeedback]
  );

  /**
   * W5 F7: the wait for a 202'd render. The sample arrives as an ordinary
   * indexed PDF artifact, so "has it landed?" is a question `artifacts`
   * already answers — re-run the panel's own `onChanged()` refresh on a
   * bounded cadence until `latestSampleArtifact` sees it, then say so. A
   * ceiling is the whole point: a job that never finishes must stop the poll
   * and TELL the operator, which is what the old flat "was rendered" notice
   * never did.
   */
  useEffect(() => {
    if (!pendingRender) return;
    const state = sampleRenderWaitState(
      Boolean(latestSampleArtifact(pendingRender.templateId, artifacts)),
      pendingRenderAttemptsRef.current
    );
    if (state === 'landed') {
      setPendingRender(undefined);
      setFeedback(pendingRender.templateId, 'success', `A sample of ${pendingRender.label} was rendered.`);
      return;
    }
    if (state === 'gave_up') {
      setPendingRender(undefined);
      setFeedback(
        pendingRender.templateId,
        'error',
        `${pendingRender.label} is taking longer than expected to render. The job is still running — reload this tab in a few minutes rather than rendering again.`
      );
      return;
    }
    const timer = setTimeout(() => {
      pendingRenderAttemptsRef.current += 1;
      void onChanged();
    }, SAMPLE_RENDER_POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [pendingRender, artifacts, onChanged, setFeedback]);

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
                    loading={busyId === row.id && busyAction === 'default'}
                    onClick={() => void setSiteDefault(row.id)}
                  >
                    {busyId === row.id && busyAction === 'default'
                      ? 'Setting…'
                      : row.isSiteDefault
                        ? 'Already the site default'
                        : 'Set as site default'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!row.canRenderSample || busyId !== undefined || pendingRender !== undefined}
                    loading={(busyId === row.id && busyAction === 'sample') || pendingRender?.templateId === row.id}
                    onClick={() => void renderSample(row)}
                  >
                    {(busyId === row.id && busyAction === 'sample') || pendingRender?.templateId === row.id
                      ? 'Rendering…'
                      : 'Render sample'}
                  </Button>
                  {/* T2.6/A5: the DIRECT chip — W1's preview_pdf_template,
                      first page only. A shorter path than the full sample
                      above (no job to poll), labeled so it is never mistaken
                      for the complete rendered document. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!row.canRenderSample || busyId !== undefined}
                    loading={busyId === row.id && busyAction === 'preview'}
                    onClick={() => void previewSample(row)}
                  >
                    {busyId === row.id && busyAction === 'preview' ? 'Rendering…' : 'Render sample (first page only)'}
                  </Button>
                  {latestSampleArtifact(row.id, artifacts) ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDirectPreview(undefined);
                        setPreviewId(row.id);
                      }}
                    >
                      Show latest sample
                    </Button>
                  ) : null}
                </div>
                {/* D3: the row that was acted on gets its own result, right
                    next to the buttons that produced it — the top banner
                    (kept above, ~line 301) is too far from a click deep in a
                    ~25-card grid to read as feedback at all. */}
                {rowMessage[row.id] ? (
                  <p
                    role="status"
                    aria-live="polite"
                    className={
                      rowMessage[row.id]!.tone === 'error'
                        ? 'text-[length:var(--adm-text-sm)] text-[var(--adm-danger-text)]'
                        : 'text-[length:var(--adm-text-sm)] text-[var(--adm-success-text)]'
                    }
                  >
                    {rowMessage[row.id]!.text}
                  </p>
                ) : null}
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
                    loading={busyId === row.id && busyAction === 'kind'}
                    onClick={() => {
                      const kind = kindChoice[row.id] ?? row.kind ?? kindOptions[0]?.kind;
                      if (kind) void pinKind(row.id, kind);
                    }}
                  >
                    {busyId === row.id && busyAction === 'kind' ? 'Setting…' : 'Set as default for kind'}
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
          ) : directPreview?.templateId === previewRow.id ? (
            directPreview.url ? (
              <div className="flex flex-col gap-2">
                {/* KNOWN LIMITATION (W5 F10, deliberately not fixed here):
                    `preview_pdf_template`'s response shape is still unverified
                    against a live pdf-tool, so what `preview_url` points at is
                    unknown. If it resolves to a PDF Major Key the browser gets
                    `/pdf/...`, and `get-public-pdf` serves every artifact with
                    `Content-Disposition: attachment` — which no browser renders
                    inside an iframe. Fixing that blind would mean guessing at
                    both the shape AND a disposition change on a shared public
                    endpoint; it waits for a real response to look at. */}
                <p className={MUTED}>First page only — not the complete rendered document.</p>
                <iframe
                  src={directPreview.url}
                  title={`${previewRow.label} first-page preview`}
                  className="h-96 w-full rounded-[var(--adm-radius-sm)] border border-[var(--adm-border)]"
                />
              </div>
            ) : (
              <EmptyState
                title="Preview rendered"
                message="pdf-tool did not return a servable preview address for this template."
              />
            )
          ) : (
            <EmptyState
              title="No sample rendered yet"
              message="Render one above, or wait for the agent's run to finish and reload this tab."
            />
          )}
        </Card>
      ) : null}
    </div>
  );
}

export default PdfTemplatesPanel;
