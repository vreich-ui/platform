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
