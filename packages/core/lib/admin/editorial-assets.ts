import type { ArtifactKind, ArtifactReference } from '../../server/lib/artifacts.js';

export type MediaFamily = 'logos' | 'product' | 'editorial' | 'illustrations' | 'documents';

export interface EditorialArtifact {
  id: string;
  kind: 'image' | 'pdf';
  family: MediaFamily;
  label: string;
  filename: string;
  preview_url: string;
  created_at: string;
  size_bytes: number;
  tags: string[];
  request_id?: string;
  template_id?: string;
  page_count?: number;
}

export interface PdfTemplateSummary {
  id: string;
  label: string;
  status: 'active' | 'draft' | 'disabled' | 'unknown';
  renderer: string;
  version: number;
  active_version?: number;
  created_at?: string;
  /** FIX-U1 / BRIEF §3.6: 'article' | 'guide' | 'checklist' … an open key set. */
  kind?: string;
  /** FIX-U1 / BRIEF §3.6: set by publish; an image blob key. */
  thumbnail_key?: string;
  /**
   * D4 fix (task A5): WHY thumbnail_key is absent, whenever pdf-tool knows —
   * mirrors pdf-tool's own `PdfTemplateRecord.thumbnailError`
   * (pdf-template-store.ts). Optional/absent-safe: an older pdf-tool deploy
   * that predates this field, or a template whose thumbnail simply hasn't
   * rendered yet (no error, just not attempted), sends nothing here.
   */
  thumbnail_error?: string;
  /** FIX-U1 / BRIEF §3.6: the JSON Schema the materializer fills deterministically (R7). */
  render_data_schema?: unknown;
  /**
   * D4 fix (task A5): a cheap presence flag alongside `render_data_schema`
   * itself, for a UI that only needs to know WHETHER a schema exists (e.g.
   * a badge) without paying for the full schema object on every list row.
   * Always present and computed defensively (never trusts an upstream
   * `hasRenderDataSchema` field, which pdf-tool does not send) — false on
   * an older pdf-tool deploy that predates `renderDataSchema` entirely, not
   * merely absent, so a UI reading this field never needs its own
   * `?? false` fallback.
   */
  has_render_data_schema: boolean;
  /** FIX-U1 / BRIEF §3.6: must validate against render_data_schema at create and publish. */
  sample_data?: unknown;
}

export interface EditorialAssetsPayload {
  pdf_templates: PdfTemplateSummary[];
  artifacts: EditorialArtifact[];
  pdf_templates_available: boolean;
}

const words = (values: Array<string | undefined>): string[] =>
  values
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.toLowerCase().split(/[^a-z0-9]+/))
    .filter(Boolean);

const hasAny = (haystack: readonly string[], needles: readonly string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));

export function classifyMediaFamily(input: {
  kind: 'image' | 'pdf';
  label?: string;
  filename?: string;
  tags?: string[];
}): MediaFamily {
  if (input.kind === 'pdf') return 'documents';
  const terms = words([input.label, input.filename, ...(input.tags ?? [])]);
  if (hasAny(terms, ['logo', 'logotype', 'wordmark', 'brandmark'])) return 'logos';
  if (hasAny(terms, ['product', 'sku', 'packshot', 'serum', 'cream', 'bottle'])) return 'product';
  if (hasAny(terms, ['illustration', 'diagram', 'chart', 'cartoon', 'infographic', 'icon'])) return 'illustrations';
  return 'editorial';
}

const safeStatus = (value: unknown): PdfTemplateSummary['status'] =>
  value === 'active' || value === 'draft' || value === 'disabled' ? value : 'unknown';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const humanize = (value: string, fallback: string): string => {
  const trimmed = value.trim();
  if (!trimmed || UUID_PATTERN.test(trimmed)) return fallback;
  const result = trimmed
    .replace(/^tpl[_-]?/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
  return result || fallback;
};

export function projectPdfTemplate(value: unknown): PdfTemplateSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const id = typeof row.templateId === 'string' ? row.templateId.trim() : '';
  if (!id) return undefined;
  const version = Number(row.latestVersion ?? row.version ?? 1);
  const activeVersion = Number(row.latestActiveVersion ?? row.activeVersion);
  return {
    id,
    label:
      typeof row.label === 'string' && row.label.trim() && !UUID_PATTERN.test(row.label.trim())
        ? row.label.trim()
        : humanize(id, 'PDF template'),
    status: safeStatus(row.status),
    renderer: typeof row.renderer === 'string' && row.renderer.trim() ? row.renderer.trim() : 'PDF',
    version: Number.isInteger(version) && version > 0 ? version : 1,
    ...(Number.isInteger(activeVersion) && activeVersion > 0 ? { active_version: activeVersion } : {}),
    ...(typeof row.createdAt === 'string' ? { created_at: row.createdAt } : {}),
    // FIX-U1 / BRIEF §3.6 (+ T2.6 / W1's thumbnailError): five additive fields, named explicitly — STILL a
    // whitelist (tests/netlify/admin-editorial-assets.test.ts asserts an
    // upstream `storage` secret never leaks), not a passthrough. Each is
    // forwarded only when the upstream row actually carries it, so a
    // pre-§3.6 template (or a store that predates this) still projects the
    // original six fields unchanged.
    ...(typeof row.kind === 'string' && row.kind.trim() ? { kind: row.kind.trim() } : {}),
    ...(typeof row.thumbnailKey === 'string' && row.thumbnailKey.trim() ? { thumbnail_key: row.thumbnailKey.trim() } : {}),
    // D4 fix (task A5): forwarded alongside thumbnail_key, same defensive
    // shape — an older pdf-tool deploy (or a template with no thumbnail
    // attempt yet, which is not an error) simply never sends this key.
    ...(typeof row.thumbnailError === 'string' && row.thumbnailError.trim() ? { thumbnail_error: row.thumbnailError.trim() } : {}),
    ...(row.renderDataSchema && typeof row.renderDataSchema === 'object' && !Array.isArray(row.renderDataSchema)
      ? { render_data_schema: row.renderDataSchema }
      : {}),
    // D4 fix (task A5): always present (unlike the optional fields above) —
    // computed from the SAME presence check as render_data_schema itself,
    // never a passthrough of an upstream field pdf-tool does not send, so
    // it is exactly as absent-safe on an old pdf-tool deploy as the schema
    // object it mirrors (both simply read `undefined` off `row`).
    has_render_data_schema: Boolean(
      row.renderDataSchema && typeof row.renderDataSchema === 'object' && !Array.isArray(row.renderDataSchema)
    ),
    ...(row.sampleData !== undefined ? { sample_data: row.sampleData } : {}),
  };
}

const requestIdFromBlobKey = (blobKey: string): string | undefined => {
  const [, requestId] = blobKey.split('/');
  return requestId || undefined;
};

const previewUrl = (kind: 'image' | 'pdf', blobKey: string): string =>
  `/.netlify/functions/admin-get-blob-${kind === 'image' ? 'image' : 'pdf'}?blobKey=${encodeURIComponent(blobKey)}`;

export function projectEditorialArtifact(reference: ArtifactReference): EditorialArtifact | undefined {
  const rawKind = reference.artifactKind ?? reference.blobKey.split('/')[0];
  if (rawKind !== 'image' && rawKind !== 'pdf') return undefined;
  const kind = rawKind as Extract<ArtifactKind, 'image' | 'pdf'>;
  const metadata = reference.metadata ?? {};
  const originalFilename = reference.originalFilename?.trim();
  const filename = originalFilename || (kind === 'pdf' ? 'PDF document' : 'Image asset');
  const rawLabel = reference.label?.trim();
  const label =
    rawLabel && !UUID_PATTERN.test(rawLabel)
      ? rawLabel
      : originalFilename || (kind === 'pdf' ? 'Untitled PDF document' : 'Untitled image');
  const tags = (reference.tags ?? []).filter((tag) => typeof tag === 'string').slice(0, 12);
  const templateId = typeof metadata.templateId === 'string' ? metadata.templateId : undefined;
  const pageCount = Number(metadata.pageCount);
  return {
    id: reference.sha256,
    kind,
    family: classifyMediaFamily({ kind, label, filename, tags }),
    label,
    filename,
    preview_url: previewUrl(kind, reference.blobKey),
    created_at: reference.createdAtISO,
    size_bytes: reference.sizeBytes,
    tags,
    ...(requestIdFromBlobKey(reference.blobKey) ? { request_id: requestIdFromBlobKey(reference.blobKey) } : {}),
    ...(templateId ? { template_id: templateId } : {}),
    ...(Number.isInteger(pageCount) && pageCount > 0 ? { page_count: pageCount } : {}),
  };
}

export const artifactsByFamily = (
  artifacts: readonly EditorialArtifact[]
): Record<MediaFamily, EditorialArtifact[]> => ({
  logos: artifacts.filter((artifact) => artifact.family === 'logos'),
  product: artifacts.filter((artifact) => artifact.family === 'product'),
  editorial: artifacts.filter((artifact) => artifact.family === 'editorial'),
  illustrations: artifacts.filter((artifact) => artifact.family === 'illustrations'),
  documents: artifacts.filter((artifact) => artifact.family === 'documents'),
});
