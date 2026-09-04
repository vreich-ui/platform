/**
 * Visual identity → PDF templates tab: every decision, as pure functions (U1,
 * brand-imagery wave; BRIEF.md §3.2/§3.6, R7).
 *
 * Same reason as `visual-identity-imagery.ts` for existing at all: the
 * component is excluded from `tsconfig.test.json`, so a decision made in JSX
 * is a decision nothing tests. `PdfTemplatesPanel.tsx` renders; this decides.
 *
 * TWO SOURCES, ONE VIEW. The template list comes from pdf-tool through the
 * EXISTING `admin-editorial-assets` endpoint (which already calls
 * `list_pdf_templates` and projects each row); the *default* pointer comes
 * from `site.pdf` (§3.2), an ordinary, additive site block. Neither is
 * re-derived here — this joins them and decides what badge each row wears.
 *
 * WHY `site.pdf` IS AN ORDINARY WRITE. Unlike `brandTokens`/`brandImagery`,
 * a template pointer is a reference, not a governed value, so §3.2 makes it
 * patchable through plain `set_site_fields` — no privileged funnel, no apply
 * verb. `buildSetSiteDefaultOp` is therefore an ordinary patch op the page
 * submits under its own site checkout.
 *
 * DEGRADING HONESTLY. §3.6 adds `kind`, `renderDataSchema`, `sampleData` and
 * `thumbnailKey` to a pdf-tool template record (T2.6 adds a fifth,
 * `thumbnailError` — W1's own reason when publish could not produce one).
 * Those are produced in the pdf-tool repo and have to survive the platform's
 * own browser projection (`editorial-assets.ts`'s `projectPdfTemplate`, which
 * today whitelists these plus the original six and drops everything else).
 * This module accepts them as OPTIONAL and says plainly, per row, what is
 * missing and which affordance that disables — rather than rendering a
 * thumbnail well that is permanently blank or a "Render sample" button that
 * cannot know the sample data.
 */
import { getAdminBlobImageEndpoint } from './artifact-preview.js';
import type { EditorialArtifact } from './editorial-assets.js';
import type { VisualIdentityChatIntent } from './visual-identity-imagery.js';

type Bag = Record<string, unknown>;

const asBag = (value: unknown): Bag =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Bag) : {};
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

export type PdfTemplateStatus = 'active' | 'draft' | 'disabled' | 'unknown';

/**
 * The row as it reaches the browser: `editorial-assets.ts`'s
 * `PdfTemplateSummary` plus §3.6's four additive fields, all optional so the
 * shape is satisfied both before and after the pdf-tool side lands.
 */
export interface PdfTemplateInput {
  id: string;
  label: string;
  status: PdfTemplateStatus;
  renderer: string;
  version: number;
  active_version?: number;
  created_at?: string;
  /** §3.6: 'article' | 'guide' | 'checklist' … an open key set. */
  kind?: string;
  /** §3.6: set by publish; an image blob key. */
  thumbnail_key?: string;
  /** W1 (pdf-tool) / T2.6: why publish could not produce a thumbnail, when it couldn't. */
  thumbnail_error?: string;
  /** §3.6: the JSON Schema the materializer fills deterministically (R7). */
  render_data_schema?: unknown;
  /** §3.6: must validate against renderDataSchema at create and publish. */
  sample_data?: unknown;
}

export interface SitePdfBlock {
  defaultTemplateId?: string;
  byKind?: Record<string, string>;
}

export type PdfDefaultScope = 'site' | 'kind';

export interface PdfDefaultBadge {
  label: string;
  tone: 'success' | 'info';
  scope: PdfDefaultScope;
  /** The `byKind` key this badge is for; absent for the site-wide default. */
  kind?: string;
}

export type PdfValidationState = 'published' | 'draft' | 'disabled' | 'unknown';

export interface PdfValidationView {
  state: PdfValidationState;
  label: string;
  tone: 'success' | 'warning' | 'neutral' | 'danger';
  detail: string;
}

export interface PdfTemplateRow {
  id: string;
  label: string;
  kind?: string;
  kindLabel: string;
  status: PdfTemplateStatus;
  version: number;
  activeVersion?: number;
  /** Badges this row wears: the site-wide default first, then any kind pins. */
  badges: PdfDefaultBadge[];
  isSiteDefault: boolean;
  isKindDefault: boolean;
  thumbnailUrl?: string;
  thumbnailMissingReason?: string;
  validation: PdfValidationView;
  /** A disabled template cannot render and must not become a default. */
  canSetDefault: boolean;
  setDefaultBlockedReason?: string;
  canRenderSample: boolean;
  renderSampleBlockedReason?: string;
  hasRenderDataSchema: boolean;
}

export interface PdfTemplatesViewModel {
  rows: PdfTemplateRow[];
  defaultTemplateId?: string;
  byKind: Array<{ kind: string; templateId: string; resolved: boolean }>;
  /** False when the pdf-tool bridge is unconfigured — the endpoint says so explicitly. */
  available: boolean;
  /** Writing `site.pdf` is a site patch; the page gates it on the admin tier it already resolved. */
  canEdit: boolean;
  /** True when `site.pdf.defaultTemplateId` points at a template that is not in the list. */
  danglingDefault?: string;
  emptyState?: { title: string; message: string };
}

const KIND_LABELS: Record<string, string> = {
  article: 'Article',
  guide: 'Guide',
  checklist: 'Checklist',
  brochure: 'Brochure',
  report: 'Report',
};

export const pdfKindLabel = (kind: unknown): string => {
  const key = str(kind);
  if (!key) return 'Unclassified';
  return KIND_LABELS[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
};

/**
 * The kind choices the byKind selector offers (T2.6): every KNOWN kind
 * (`KIND_LABELS`) plus any kind actually present on a listed template — so a
 * tenant's own open-ended kind still shows up even when it is not one of the
 * built-in labels, sorted for a stable, human-scanned list.
 */
export function pdfKindOptions(rows: readonly Pick<PdfTemplateRow, 'kind'>[]): Array<{ kind: string; label: string }> {
  const kinds = new Set<string>(Object.keys(KIND_LABELS));
  for (const row of rows) {
    if (row.kind) kinds.add(row.kind);
  }
  return [...kinds].sort((a, b) => a.localeCompare(b)).map((kind) => ({ kind, label: pdfKindLabel(kind) }));
}

/**
 * Validation status without inventing a read path.
 * `get_pdf_template_validation` is a pdf-tool MCP verb with no browser
 * endpoint, so this reports what the LIST row actually proves: a template with
 * an active version has passed publish-time validation (which is where §3.6
 * makes `sampleData` validate against `renderDataSchema`); a draft has not been
 * published; a disabled one is blocked from rendering entirely.
 */
export function pdfValidationView(row: Pick<PdfTemplateInput, 'status' | 'active_version'>): PdfValidationView {
  if (row.status === 'disabled') {
    return {
      state: 'disabled',
      label: 'Disabled',
      tone: 'danger',
      detail: 'Hidden from rendering until it is reactivated. It cannot be a default.',
    };
  }
  if (row.status === 'active' && typeof row.active_version === 'number' && row.active_version > 0) {
    return {
      state: 'published',
      label: `Published v${row.active_version}`,
      tone: 'success',
      detail: 'A published version exists, so its sample data validated against its render schema at publish time.',
    };
  }
  if (row.status === 'draft' || row.status === 'active') {
    return {
      state: 'draft',
      label: 'Not published',
      tone: 'warning',
      detail: 'No active version yet. Publish it before pointing the site at it.',
    };
  }
  return {
    state: 'unknown',
    label: 'Unknown',
    tone: 'neutral',
    detail: 'pdf-tool did not report a status for this template.',
  };
}

/**
 * The default badge (acceptance). A row can be BOTH the site-wide default and
 * pinned for one or more kinds — `site.pdf` is `{ defaultTemplateId, byKind? }`
 * (§3.2), and the two are independent pointers, so this returns a LIST rather
 * than picking a winner and hiding the other fact from the reader.
 */
export function pdfDefaultBadges(templateId: string, sitePdf: SitePdfBlock | undefined): PdfDefaultBadge[] {
  const badges: PdfDefaultBadge[] = [];
  if (sitePdf?.defaultTemplateId && sitePdf.defaultTemplateId === templateId) {
    badges.push({ label: 'Site default', tone: 'success', scope: 'site' });
  }
  for (const [kind, id] of Object.entries(sitePdf?.byKind ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (id === templateId) {
      badges.push({ label: `Default for ${pdfKindLabel(kind).toLowerCase()}`, tone: 'info', scope: 'kind', kind });
    }
  }
  return badges;
}

const readSitePdf = (siteBody: unknown): SitePdfBlock | undefined => {
  const pdf = asBag(asBag(siteBody).pdf);
  if (!Object.keys(pdf).length) return undefined;
  const byKind = Object.fromEntries(
    Object.entries(asBag(pdf.byKind))
      .map(([kind, value]) => [kind, str(value)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
  );
  return {
    ...(str(pdf.defaultTemplateId) ? { defaultTemplateId: str(pdf.defaultTemplateId) } : {}),
    ...(Object.keys(byKind).length ? { byKind } : {}),
  };
};

export function buildPdfTemplatesViewModel(input: {
  templates: readonly PdfTemplateInput[];
  /** The site record's body (or just its `pdf` block). */
  siteBody?: unknown;
  sitePdf?: SitePdfBlock;
  available?: boolean;
  canEdit?: boolean;
}): PdfTemplatesViewModel {
  const sitePdf = input.sitePdf ?? readSitePdf(input.siteBody);
  const available = input.available !== false;
  const knownIds = new Set(input.templates.map((template) => template.id));

  const rows: PdfTemplateRow[] = input.templates.map((template) => {
    const badges = pdfDefaultBadges(template.id, sitePdf);
    const validation = pdfValidationView(template);
    const thumbnailUrl = template.thumbnail_key ? getAdminBlobImageEndpoint(template.thumbnail_key) : undefined;
    const canSetDefault = input.canEdit === true && validation.state === 'published';
    const hasSample = template.sample_data !== undefined && template.sample_data !== null;
    const canRenderSample = validation.state === 'published' && hasSample;
    return {
      id: template.id,
      label: template.label,
      ...(str(template.kind) ? { kind: str(template.kind) } : {}),
      kindLabel: pdfKindLabel(template.kind),
      status: template.status,
      version: template.version,
      ...(typeof template.active_version === 'number' ? { activeVersion: template.active_version } : {}),
      badges,
      isSiteDefault: badges.some((badge) => badge.scope === 'site'),
      isKindDefault: badges.some((badge) => badge.scope === 'kind'),
      ...(thumbnailUrl
        ? { thumbnailUrl }
        : {
            // T2.6 / W1's `thumbnailError`: a real, pdf-tool-reported reason
            // beats this module's own guess — a template can carry NEITHER a
            // key nor an error (thumbnailing simply hasn't run yet), which
            // still degrades to the honest generic reasons below.
            thumbnailMissingReason:
              template.thumbnail_error ??
              (template.thumbnail_key
                ? 'The stored thumbnail key is not one the admin image reader can serve.'
                : 'pdf-tool has not published a thumbnail for this template yet.'),
          }),
      validation,
      canSetDefault,
      ...(canSetDefault
        ? {}
        : {
            setDefaultBlockedReason:
              input.canEdit === true
                ? 'Only a published template can be the site default.'
                : 'Changing the site default needs the Owner role.',
          }),
      canRenderSample,
      ...(canRenderSample
        ? {}
        : {
            renderSampleBlockedReason: hasSample
              ? 'Publish the template before rendering a sample.'
              : 'This template carries no sample data to render.',
          }),
      hasRenderDataSchema: template.render_data_schema !== undefined && template.render_data_schema !== null,
    };
  });

  const dangling =
    sitePdf?.defaultTemplateId && !knownIds.has(sitePdf.defaultTemplateId) ? sitePdf.defaultTemplateId : undefined;

  return {
    rows,
    ...(sitePdf?.defaultTemplateId ? { defaultTemplateId: sitePdf.defaultTemplateId } : {}),
    byKind: Object.entries(sitePdf?.byKind ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, templateId]) => ({ kind, templateId, resolved: knownIds.has(templateId) })),
    available,
    canEdit: input.canEdit === true,
    ...(dangling ? { danglingDefault: dangling } : {}),
    ...(rows.length
      ? {}
      : {
          emptyState: available
            ? {
                title: 'No PDF templates yet',
                message:
                  'This publication has no PDF templates. Ask the agent to create one from the generic article template.',
              }
            : {
                title: 'PDF templates are unavailable',
                message: 'The pdf-tool bridge is not configured for this publication, so no templates can be listed.',
              },
        }),
  };
}

// ─── Write path ─────────────────────────────────────────────────────────────

export type PatchOp = {
  op: string;
  fields: Record<string, unknown>;
};

/**
 * "Set as site default" (acceptance). §3.2 makes `site.pdf` ORDINARY — plain
 * `set_site_fields`, which deep-merges — so this writes ONLY
 * `pdf.defaultTemplateId` and leaves any `byKind` pins exactly where they
 * were. Writing the whole block instead would silently drop a kind pin the
 * human never touched.
 */
export function buildSetSiteDefaultOp(templateId: string): PatchOp {
  const id = str(templateId);
  if (!id) throw new Error('A template id is required to set the site default.');
  return { op: 'set_site_fields', fields: { pdf: { defaultTemplateId: id } } };
}

/**
 * The per-kind sibling. Same merge reasoning: one key inside `byKind`, so the
 * other kinds and the site-wide default survive untouched. `null` clears a pin
 * (the patch engine's unset marker).
 */
export function buildPinKindDefaultOp(kind: string, templateId: string | null): PatchOp {
  const key = str(kind);
  if (!key) throw new Error('A content kind is required to pin a template.');
  const id = templateId === null ? null : str(templateId);
  if (id === undefined) throw new Error('A template id is required to pin a template.');
  return { op: 'set_site_fields', fields: { pdf: { byKind: { [key]: id } } } };
}

// ─── Render sample ──────────────────────────────────────────────────────────

/**
 * "Render sample" needs `create_agent_artifact_job`, an MCP tool with no
 * browser-reachable admin endpoint — the same seam the imagery tab's
 * import/propose buttons use, and the same one `TemplatesWorkspace` has always
 * used for exactly this action ("Ask the Publishing Agent to render a
 * sample"). The intent names the template and tells the agent to use the
 * template's OWN `sampleData`, so the browser never has to carry it.
 */
export function buildRenderSampleIntent(row: Pick<PdfTemplateRow, 'id' | 'label'>): VisualIdentityChatIntent {
  return {
    starter: 'visual-identity',
    tool: 'create_agent_artifact_job',
    label: 'Render sample',
    prompt: `Render a sample PDF from template ${row.id} ("${row.label}"): read its sampleData with get_pdf_template, then create_agent_artifact_job with artifact_kind 'pdf', that template, and that sample data as the render data. Poll the existing job rather than creating a second one, and tell me the artifact id when it lands.`,
  };
}

/**
 * The DIRECT chip (T2.6). W1 landed `preview_pdf_template` — first page
 * only, no job to poll — a much shorter path than the full
 * `create_agent_artifact_job` above (which produces a complete, multi-page
 * artifact and needs a poll loop). Labeled honestly: this is a first-page
 * preview, not the rendered sample `buildRenderSampleIntent` produces, and
 * the button copy must say so rather than implying a finished document.
 *
 * ASSUMED SHAPE — flagged for verification once `preview_pdf_template`
 * actually reaches this admin surface (it is a pdf-tool MCP tool with no
 * browser-reachable endpoint today, same seam as `buildRenderSampleIntent`):
 * this only asserts the tool's NAME and that it takes the template id plus
 * its own sampleData, which is everything the brief documents about it.
 */
export function buildPreviewSampleIntent(row: Pick<PdfTemplateRow, 'id' | 'label'>): VisualIdentityChatIntent {
  return {
    starter: 'visual-identity',
    tool: 'preview_pdf_template',
    label: 'Render sample (first page only)',
    prompt: `Render a first-page-only preview of template ${row.id} ("${row.label}") with preview_pdf_template, reading its sampleData with get_pdf_template first. Tell me the artifact id when it lands — say plainly that this is a first-page preview, not the complete document.`,
  };
}

/**
 * A rendered sample comes back as an ordinary indexed PDF artifact, so the
 * panel previews it with the SAME `ArtifactStagePreview` the rest of the admin
 * uses. This picks the newest PDF artifact this template produced — the
 * projection already carries `template_id` on every rendered PDF.
 */
export function latestSampleArtifact(
  templateId: string,
  artifacts: readonly EditorialArtifact[]
): EditorialArtifact | undefined {
  return artifacts
    .filter((artifact) => artifact.kind === 'pdf' && artifact.template_id === templateId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}
