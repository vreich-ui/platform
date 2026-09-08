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
 *
 * D2 fix — `thumbnail_key`'s "optional" is `string | null`, not just
 * `string | undefined`: `null` is pdf-tool affirmatively reporting no
 * thumbnail, which is a different fact from the field being absent from
 * the row entirely (a shape/projection gap). See `pdfThumbnailMissingReason`
 * for the message each of those, plus a present-but-unservable key and a
 * real `thumbnail_error`, actually earns.
 */
import { getAdminBlobImageEndpoint } from './artifact-preview.js';
import type { EditorialArtifact } from './editorial-assets.js';

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
  /**
   * §3.6: set by publish; an image blob key.
   *
   * D2 fix: `null` is a distinct value from the field being absent — see
   * `PdfTemplateSummary.thumbnail_key` (editorial-assets.ts) for why that
   * distinction is real: `null` means pdf-tool's list row affirmatively
   * reported no thumbnail; the field being OMITTED means the row never
   * carried `thumbnailKey` at all (a pre-thumbnailing pdf-tool deploy, or —
   * defensively — some other shape gap upstream of this function). Both
   * still mean "there is no key to preview", but only the first is a claim
   * this function can attribute to pdf-tool.
   */
  thumbnail_key?: string | null;
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
  /**
   * The clear-default affordance's own can/blocked pair, in the same style
   * as a row's `canSetDefault`/`setDefaultBlockedReason` — but this one is
   * panel-level, not per-row: clearing `pdf.defaultTemplateId` is not an
   * action any one template row owns (a dangling default names a row that
   * is not even IN `rows`), so it lives on the view model itself. Owner-gated
   * the same way `canSetDefault` is; also false with a reason when there is
   * nothing to clear.
   */
  canClearDefault: boolean;
  clearDefaultBlockedReason?: string;
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

/**
 * D2 fix — why a row has no thumbnail preview, told as three genuinely
 * different facts instead of collapsed into one placeholder:
 *
 *  1. `thumbnail_error` — pdf-tool's own reported reason (T2.6/W1). Always
 *     wins: it is the one message here pdf-tool actually wrote.
 *  2. `thumbnail_key` is a non-empty string but `thumbnailUrl` is still
 *     undefined — a key EXISTS but the admin-image-reader gate would not
 *     serve it (`getAdminBlobImageEndpoint` returned undefined). The gate
 *     now accepts pdf-tool's full `safeSegment` id charset (letters, digits,
 *     `.`, `_`, `-`), so a dotted id like `drlurie.article.v1` is servable
 *     and is no longer the case that lands here; what lands here is a key
 *     that is genuinely malformed for this reader — a `.`/`..` id segment,
 *     a non-numeric version, an extension other than `.png`, or extra path
 *     segments. The offending key is surfaced so an operator can tell why at
 *     a glance instead of being told to go look.
 *  3. `thumbnail_key === null` — pdf-tool's list row AFFIRMATIVELY reports
 *     no thumbnail (see `PdfTemplateInput.thumbnail_key`'s doc comment).
 *     This is the one case honestly worded as "pdf-tool has not published
 *     a thumbnail yet" — it is the one case pdf-tool actually told us that.
 *  4. `thumbnail_key === undefined` — the row never carried a
 *     `thumbnailKey` property at all. That is a shape/projection fact
 *     about the LISTING, not a report from pdf-tool about this template,
 *     so it must not be worded as one; saying "pdf-tool has not published
 *     one yet" here would assert knowledge nobody actually has.
 */
export function pdfThumbnailMissingReason(
  template: Pick<PdfTemplateInput, 'thumbnail_key' | 'thumbnail_error'>
): string {
  if (template.thumbnail_error) return template.thumbnail_error;

  const key = str(template.thumbnail_key);
  if (key) {
    return (
      `The stored thumbnail key ("${key}") is not a shape the admin image reader can serve — ` +
      'it accepts only thumbnails/<template id>/v<version>.png, where the id starts with a letter ' +
      'or digit and then uses letters, digits, ".", "_" and "-" (pdf-tool\'s own id charset). ' +
      'Refused: an id segment of "." or ".." or containing "..", a version that is not digits ' +
      '(v3, not vlatest), any extension other than .png, and any extra path segment. ' +
      'Check the raw key in pdf-tool.'
    );
  }
  if (template.thumbnail_key === null) {
    return 'pdf-tool has not published a thumbnail for this template yet.';
  }
  return 'The template listing did not report a thumbnail_key for this template at all, so it is not known whether pdf-tool has produced one.';
}

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
      ...(thumbnailUrl ? { thumbnailUrl } : { thumbnailMissingReason: pdfThumbnailMissingReason(template) }),
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

  const hasDefault = Boolean(sitePdf?.defaultTemplateId);
  const canClearDefault = input.canEdit === true && hasDefault;

  return {
    rows,
    ...(sitePdf?.defaultTemplateId ? { defaultTemplateId: sitePdf.defaultTemplateId } : {}),
    byKind: Object.entries(sitePdf?.byKind ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, templateId]) => ({ kind, templateId, resolved: knownIds.has(templateId) })),
    available,
    canEdit: input.canEdit === true,
    ...(dangling ? { danglingDefault: dangling } : {}),
    canClearDefault,
    ...(canClearDefault
      ? {}
      : {
          clearDefaultBlockedReason: !hasDefault
            ? 'There is no site default to clear.'
            : 'Clearing the site default needs the Owner role.',
        }),
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
 *
 * `null` CLEARS the site default — the same unset marker
 * `buildPinKindDefaultOp` already uses for a kind pin (the patch engine's
 * null-inside-`fields`-unsets-a-key grammar, `object-patch-ops.ts`). An empty
 * *string* is still refused: that is a caller bug (e.g. a blank form field
 * slipping through), not a deliberate clear, so it keeps throwing rather than
 * silently writing a broken pointer or being misread as "unset".
 */
export function buildSetSiteDefaultOp(templateId: string | null): PatchOp {
  if (templateId === null) {
    return { op: 'set_site_fields', fields: { pdf: { defaultTemplateId: null } } };
  }
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

// ─── Render sample ─────────────────────────────────────────────────────────────────────
//
// A5 replaced the two chat-intent builders that used to live here
// (`buildRenderSampleIntent`, `create_agent_artifact_job`; `buildPreviewSampleIntent`,
// T2.6's direct `preview_pdf_template` chip) with two real endpoints —
// `admin-visual-identity-render-sample` and `admin-visual-identity-preview-sample`
// (packages/core/server/functions/) — so the panel now calls their browser
// clients (`visual-identity-render-sample-client.ts`,
// `visual-identity-preview-sample-client.ts`) directly. Nothing about EITHER
// button's payload needs a pure decision function of its own: both send just
// `{ templateId: row.id }`, which the panel builds inline.

/**
 * W5 F7 — waiting for a sample that is still rendering.
 *
 * `create_agent_artifact_job`'s inline wait has a budget bounded by the
 * function's own invocation deadline; when it runs out the endpoint answers
 * 202 with the job id and no artifact. The panel then WAITS instead of
 * claiming a rendered sample: it re-reads the artifact index (the same
 * `onChanged()` refresh every other action here runs) until the sample shows
 * up, or until this ceiling says to stop and tell the operator plainly.
 *
 * The decision is a pure function for the same reason A7's poll predicates
 * are: `PdfTemplatesPanel.tsx` is a `.tsx` file and `tsconfig.test.json`
 * excludes those, so this is the only place the rule can be tested at all.
 */
export const SAMPLE_RENDER_POLL_INTERVAL_MS = 5000;
export const SAMPLE_RENDER_MAX_POLLS = 24;

export type SampleRenderWait = 'landed' | 'waiting' | 'gave_up';

export function sampleRenderWaitState(
  hasArtifact: boolean,
  attempts: number,
  maxAttempts: number = SAMPLE_RENDER_MAX_POLLS
): SampleRenderWait {
  if (hasArtifact) return 'landed';
  return attempts < maxAttempts ? 'waiting' : 'gave_up';
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
