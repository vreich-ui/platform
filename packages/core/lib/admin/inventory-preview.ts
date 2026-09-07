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
export const inventoryPreviewPlan = (hit: InventoryHit): InventoryPreviewPlan => {
  if (hit.collection !== 'artifacts') return { mode: 'json' };

  const ref = typeof hit.previewRef === 'string' ? hit.previewRef.trim() : '';
  if (!ref) return { mode: 'json' };

  const image = getAdminBlobImageEndpoint(ref);
  if (image) return { mode: 'image', endpoint: image, cacheKey: `inventory:image:${ref}` };

  const pdf = getAdminBlobPdfEndpoint(ref);
  if (pdf) return { mode: 'pdf', endpoint: pdf, cacheKey: `inventory:pdf:${ref}` };

  return { mode: 'json' };
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
