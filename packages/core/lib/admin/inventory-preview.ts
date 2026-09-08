/**
 * Pure decisions behind `admin/InventoryPage.tsx` (T4).
 *
 * The page component owns rendering and nothing else: every question it has
 * to ANSWER — which preview renderer a hit gets, what endpoint that renderer
 * fetches, whether a trimmed preview payload can be summarized at all, and
 * whether the signed-in role set may use this surface — is decided here,
 * where `node:test` can see it (`packages/core/admin/**\/*.tsx` is excluded
 * from `tsconfig.test.json`, so nothing in a `.tsx` file is testable).
 *
 * Governing rule (BRIEF.md, Wave 2): the UI never claims a state it cannot
 * prove, and previews are fetched on demand rather than assumed. That is why
 * `parseInventoryPreviewJson` returns `null` instead of a best-effort object
 * for a payload it cannot parse (a TRUNCATED JSON preview is exactly this
 * case) — a caller then renders the raw text it actually has instead of a
 * summary of fields it does not.
 *
 * No React, no DOM, no I/O — the endpoint builders return URL strings; the
 * fetching (auth header, retry, shared queue, object-URL cache) is
 * `artifact-preview-loader.ts`'s job, unchanged.
 */
import { getAdminBlobImageEndpoint } from './artifact-preview.js';
import { OBJECT_TYPE_LABELS } from './display-name.js';
import type { InventoryHit } from './inventory-server-logic.js';
import type { Role } from '../../server/lib/roles.js';

// ─── access ─────────────────────────────────────────────────────────────────

/**
 * The five-tier role vocabulary (`server/lib/roles.ts`), as a runtime list so
 * a `string[]` from `fetchMe` can be narrowed to `Role[]`. Declared `readonly
 * Role[]` rather than re-declaring the union: the compiler rejects this list
 * the moment it drifts from `Role`.
 */
export const KNOWN_ROLES: readonly Role[] = ['owner', 'admin', 'publisher', 'editor', 'viewer'];

/** Narrows `fetchMe`'s `roles: string[]` to the known role tier, dropping anything unrecognized. */
export const toInventoryRoles = (values: readonly string[]): Role[] =>
  KNOWN_ROLES.filter((role) => values.includes(role));

/**
 * The client-side mirror of the server gate: `admin-inventory.ts` 403s
 * anything that is not owner|admin (`resolveAdminAccessFromEvent`), so the
 * page shows an EmptyState for exactly the same role sets rather than
 * rendering a surface whose every request would fail. This is defense in
 * depth — never the only gate.
 */
export const canUseInventory = (roles: readonly Role[]): boolean =>
  roles.includes('owner') || roles.includes('admin');

// ─── preview endpoints ──────────────────────────────────────────────────────

/** Mirrors `admin-get-blob-pdf`'s own blobKey guard, the way `artifact-preview.ts` mirrors the image one. */
export const ADMIN_PREVIEWABLE_PDF_REF_RE = /^pdf\/[a-z0-9._-]+\/[a-f0-9]{64}(?:\.pdf)?$/i;

/** The identity-gated PDF byte endpoint for a blob key, or undefined when the key is not a PDF artifact ref. */
export const getAdminBlobPdfEndpoint = (blobKey: string): string | undefined => {
  const trimmed = blobKey.trim();
  if (!ADMIN_PREVIEWABLE_PDF_REF_RE.test(trimmed)) return undefined;

  return `/.netlify/functions/admin-get-blob-pdf?blobKey=${encodeURIComponent(trimmed)}`;
};

/**
 * How one hit is previewed.
 *
 * `'json'` is the floor, not a failure: objects and store blobs are ALWAYS
 * previewed as their trimmed JSON/text payload (the `preview` action), and an
 * artifact whose reference carries no previewable blob key falls back to its
 * own metadata rather than to a broken `<img>`.
 */
export type InventoryPreviewPlan =
  | { mode: 'image'; endpoint: string; cacheKey: string }
  | { mode: 'pdf'; endpoint: string; cacheKey: string }
  | { mode: 'json' };

/**
 * Which renderer a hit gets. Only artifacts can have bytes to show, and only
 * when their `previewRef` (the artifact-index `blobKey`) matches the shape
 * the corresponding endpoint will actually accept — the same patterns
 * `admin-get-blob-image` / `admin-get-blob-pdf` enforce server-side, checked
 * here so the page never issues a request it knows will 400.
 */
const trimmedRef = (value: string | null): string => (typeof value === 'string' ? value.trim() : '');

export const inventoryPreviewPlan = (hit: InventoryHit): InventoryPreviewPlan => {
  if (hit.collection === 'artifacts') {
    const ref = trimmedRef(hit.previewRef);
    if (!ref) return { mode: 'json' };

    const image = getAdminBlobImageEndpoint(ref);
    if (image) return { mode: 'image', endpoint: image, cacheKey: `inventory:image:${ref}` };

    const pdf = getAdminBlobPdfEndpoint(ref);
    if (pdf) return { mode: 'pdf', endpoint: pdf, cacheKey: `inventory:pdf:${ref}` };

    return { mode: 'json' };
  }

  /**
   * A non-artifact row can still have imagery it can PROVE is its own: the
   * search response joins each object to the artifact index by requestId and
   * puts the hero image's blob key on `thumbnailRef` (see
   * `inventory-server-logic.ts`). `previewRef` is deliberately NOT consulted
   * here — an object's `previewRef` is its own id, which is what made every
   * Objects row fall through to a text chip.
   *
   * `null` (nothing proven) falls through to `'json'`, and the surface draws
   * `inventoryTypeVisual(hit)` — never a placeholder image, never a spinner
   * waiting on bytes nobody found. The cache key is the blob key, so an
   * object and the artifact row for the same image share one fetch.
   */
  const thumbnail = trimmedRef(hit.thumbnailRef);
  if (thumbnail) {
    const image = getAdminBlobImageEndpoint(thumbnail);
    if (image) return { mode: 'image', endpoint: image, cacheKey: `inventory:image:${thumbnail}` };
  }

  return { mode: 'json' };
};

// ─── type visuals ───────────────────────────────────────────────────────────

/**
 * The icon a row falls back to when it has no bytes of its own — named, not
 * drawn, because this module is pure and the icons live in the admin kit's
 * `.tsx`. Every id here is an icon that ALREADY EXISTS in `admin/icons.tsx`;
 * this mapping invents no artwork and pulls in no image dependency.
 */
export type InventoryTypeIconId =
  | 'note'
  | 'layout-list'
  | 'layout-grid'
  | 'file-plus'
  | 'menu'
  | 'tag'
  | 'home'
  | 'palette'
  | 'archive'
  | 'chart-bar'
  | 'mic'
  | 'sparkles'
  | 'bookmark'
  | 'settings'
  | 'info';

export interface InventoryTypeVisual {
  iconId: InventoryTypeIconId;
  /** What the icon stands for, in words — the cell's accessible label and its caption. */
  label: string;
}

/**
 * One icon per governed object type — all thirteen of them
 * (`schema/object-record-v1.ts`'s `objectTypes`). Keyed loosely on `string`
 * rather than `ObjectType` because `hit.kind` arrives from the server as a
 * plain string and an unrecognized value must degrade, not throw.
 */
export const OBJECT_TYPE_ICONS: Record<string, InventoryTypeIconId> = {
  page: 'layout-list',
  section: 'bookmark',
  navigation: 'menu',
  taxonomy: 'tag',
  site: 'home',
  template: 'layout-grid',
  section_template: 'file-plus',
  theme: 'palette',
  product: 'archive',
  content_item: 'note',
  tracking_config: 'chart-bar',
  editorial_voice: 'mic',
  visual_standard: 'sparkles',
};

/** `content_item` → `Article`, `some_new_type` → `Some new type`. */
const humanizeType = (value: string): string => {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : 'Item';
};

/**
 * The per-type visual for an object row. An object type this deploy does not
 * know still gets a visual and a readable name — a generic mark that says
 * "no specific icon for this", which is honest, rather than borrowing another
 * type's icon and implying a kinship that is not there.
 */
export const objectTypeVisual = (objectType: string): InventoryTypeVisual => {
  const key = objectType.trim();
  const iconId = OBJECT_TYPE_ICONS[key];
  const label = (OBJECT_TYPE_LABELS as Record<string, string | undefined>)[key] ?? humanizeType(key);

  return { iconId: iconId ?? 'info', label };
};

/**
 * The visual for ANY row without provable bytes, so the preview column is
 * never empty: objects by type, store blobs by their store name, artifacts by
 * their artifact kind.
 */
export const inventoryTypeVisual = (hit: InventoryHit): InventoryTypeVisual => {
  switch (hit.collection) {
    case 'objects':
      return objectTypeVisual(hit.kind);
    case 'stores':
      // Deliberately not the store name: the Kind column already carries it,
      // and repeating it in the preview cell says nothing new.
      return { iconId: 'settings', label: 'Store blob' };
    case 'artifacts':
      return { iconId: 'note', label: humanizeType(hit.kind) };
  }
};

/** A file name for the download action — the blob key's last segment, or the hit id's. */
export const inventoryDownloadFilename = (hit: InventoryHit): string => {
  const source = (typeof hit.previewRef === 'string' && hit.previewRef.trim()) || hit.id;
  return source.split('/').filter(Boolean).at(-1) ?? 'artifact';
};

// ─── preview payloads ───────────────────────────────────────────────────────

/**
 * The store name `previewSummary` (inventory-logic) should key on. A store
 * hit carries its store name on `kind` (the canonical `collection` is the
 * closed enum `'stores'`); anything else has no store, and falls through to
 * `previewSummary`'s generic top-level-key extractor.
 */
export const previewStoreName = (hit: InventoryHit): string =>
  hit.collection === 'stores' ? hit.kind : hit.collection;

/**
 * The `preview` action returns PRETTY-PRINTED TEXT plus the format it is in
 * (`inventory-server-logic.ts`'s `trimStoreBlobPreview` / `trimJsonPreview`),
 * not a parsed object — so a summary needs the text parsed back.
 *
 * Returns `null` — never a partial object — when there is nothing provably
 * parseable: a `text` payload (the blob was not JSON), a payload that was
 * TRUNCATED at 32 KB and is therefore no longer valid JSON, or a JSON value
 * that is not an object (an array or a bare scalar has no fields to
 * summarize). The caller renders the raw text it actually received instead.
 */
export const parseInventoryPreviewJson = (
  format: string | undefined,
  text: string | undefined
): Record<string, unknown> | null => {
  if (format !== 'json' || typeof text !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
};
