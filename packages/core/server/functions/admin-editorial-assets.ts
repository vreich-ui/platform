import { createHash } from 'node:crypto';

import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { getArtifactIndexBlobStore } from '../lib/blob-store.js';
import {
  listArtifactIndexKeys,
  parseArtifactPointer,
  repairArtifactPointer,
  resolveArtifactPointer,
  type ArtifactIndexStore,
  type ArtifactPointer,
} from '../lib/artifact-index.js';
import { isArtifactReference, type ArtifactReference } from '../lib/artifacts.js';
import { mapWithConcurrency, STORE_READ_CONCURRENCY } from '../lib/blob-list.js';
import { buildPdfToolStorageGrant } from '../lib/pdf-tool-storage-grant.js';
import { listPlatformPdfTemplates } from '../lib/pdf-tool-client.js';
import { sweepEditorialArtifacts } from '../lib/artifact-listing-projection.js';
import {
  projectEditorialArtifact,
  projectPdfTemplate,
  type EditorialArtifact,
} from '../../lib/admin/editorial-assets.js';
import { logDiagnostics, timeAuth, timeSection, timeSerialize, withServerTiming } from '../lib/server-timing.js';

type LambdaEvent = {
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
};

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: timeSerialize(() => JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body })),
});

/**
 * T2.3 — the whole function is one GET, one read, no mutation branch, so the
 * ETag applies to the entire success body (the templates+media listing an
 * editor's asset picker re-fetches on every navigation into it).
 */
const CACHE_CONTROL = 'private, no-cache';
/**
 * Hashes the ALREADY-SERIALIZED wire body, so a read response is
 * `JSON.stringify`d exactly ONCE per request. The digest is identical to
 * hashing the object (same input string), but the previous shape paid a
 * second full stringify of the whole body on every read — on a latency
 * branch, on this surface's hottest read paths.
 */
const etagForSerialized = (serialized: string): string => `"${createHash('sha1').update(serialized).digest('hex')}"`;

const parseJson = async (store: ArtifactIndexStore, key: string): Promise<unknown> => {
  const raw = await store.get(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

const RESULT_LIMIT = 100;

type PointerCandidate = {
  key: string;
  pointer: ArtifactPointer;
  createdAtISO: string;
  /** Already in hand when the record had to be read to place the pointer at all. */
  reference?: ArtifactReference;
};

/**
 * The `by-kind/` sweep — bounded fan-out, and now bounded READS.
 *
 * The shape of the problem: `by-kind/<kind>/<sha>.json` names a reference, and
 * the listing wants the newest 100 live ones. Netlify's blob `list()` answers
 * `{ key, etag }` with no metadata channel (lib/blob-list.ts), so the only way
 * to learn a record's `createdAtISO` used to be to READ the record — every
 * record, for every artifact in the store, to return 100 rows. That is the
 * 3.6s `sec.artifacts_image` this function was measured at.
 *
 * `ArtifactPointer` now mirrors `createdAtISO`/`deletedAtISO` (W3 T1), so the
 * sort and the slice happen on the pointers and only the rows that are
 * actually returned cost a full-record read. The reads that remain:
 *
 *   1. one pointer read per `by-kind/` key — unchanged, and unavoidable;
 *   2. one full-record read per UNREPAIRED pointer. A pointer with no
 *      `createdAtISO` cannot be placed in the sort at all, so it is read
 *      exactly as it always was — and REPAIRED in place, so it is the last
 *      time that pointer costs anything;
 *   3. one full-record read per row returned, for pointers that carried their
 *      own `createdAtISO`.
 *
 * On a fully repaired store that is 100 record reads however large the store
 * is. On a store where nothing has been repaired it is exactly what it was
 * (plus the repair writes). On any mix it is correct, because the undated
 * pointers are read FIRST and their real `createdAtISO` is merged into the
 * same sort as the dated ones — the answer is never "the newest 100 of the
 * repaired ones".
 *
 * Liveness is still decided by the RECORD, never by the pointer: the pointer's
 * `deletedAtISO` only skips a read that would have been thrown away, and every
 * row that survives to the result has had its record read and re-checked. That
 * is what makes a stale-live pointer (a torn write, a delete racing this
 * sweep) cost a read instead of returning a deleted artifact.
 *
 * Exported for tests/netlify/admin-editorial-assets.test.ts, which PINS the
 * read count for a fixture — the cost this function is judged on is "how many
 * blob reads per listed artifact", and that is not observable from the
 * handler's wire response. (Same reason `requestSchema` is exported from
 * admin-governance.ts.)
 */
export async function listKind(store: ArtifactIndexStore, kind: 'image' | 'pdf'): Promise<ArtifactReference[]> {
  const pointerKeys = await listArtifactIndexKeys(store, `by-kind/${kind}/`);
  const pointers = await mapWithConcurrency(pointerKeys, STORE_READ_CONCURRENCY, async (key) => {
    const stored = await parseJson(store, key);
    return { key, stored, pointer: parseArtifactPointer(stored) };
  });

  const dated: PointerCandidate[] = [];
  const undated: { key: string; stored: unknown; pointer: ArtifactPointer }[] = [];

  for (const entry of pointers) {
    if (!entry.pointer) continue;
    // Only a delete path writes this; the read-repair below deliberately never
    // does. So a pointer that says "deleted" was told so by the writer that
    // deleted it, and skipping its record is skipping a row we would drop.
    if (entry.pointer.deletedAtISO) continue;
    if (entry.pointer.createdAtISO) {
      dated.push({ key: entry.key, pointer: entry.pointer, createdAtISO: entry.pointer.createdAtISO });
    } else {
      undated.push({ key: entry.key, stored: entry.stored, pointer: entry.pointer });
    }
  }

  // Unplaceable without their record — read them all, then repair so this is
  // the last sweep that has to.
  const resolvedUndated = await mapWithConcurrency(undated, STORE_READ_CONCURRENCY, async (entry) => {
    const reference = await resolveArtifactPointer(store, entry.pointer);
    if (reference) await repairArtifactPointer(store, entry.key, entry.stored, reference);
    return { entry, reference };
  });

  const candidates: PointerCandidate[] = [...dated];
  for (const { entry, reference } of resolvedUndated) {
    if (!reference || !isArtifactReference(reference) || reference.deletedAtISO) continue;
    candidates.push({ key: entry.key, pointer: entry.pointer, createdAtISO: reference.createdAtISO, reference });
  }

  candidates.sort((a, b) => b.createdAtISO.localeCompare(a.createdAtISO));

  /**
   * Refill rather than one `slice(0, RESULT_LIMIT)`: a dated candidate can still
   * turn out to be soft-deleted or unreadable once its record is open (a pointer
   * is a cache, and this sweep is not the only writer). Taking the next-newest in
   * its place is exactly what reading everything and slicing afterwards used to
   * do, so the returned ROWS are identical either way.
   */
  const unique = new Map<string, ArtifactReference>();
  let cursor = 0;

  while (unique.size < RESULT_LIMIT && cursor < candidates.length) {
    const batch = candidates.slice(cursor, cursor + (RESULT_LIMIT - unique.size));
    cursor += batch.length;

    const references = await mapWithConcurrency(
      batch,
      STORE_READ_CONCURRENCY,
      async (candidate) => candidate.reference ?? (await resolveArtifactPointer(store, candidate.pointer))
    );

    for (const reference of references) {
      if (!reference || !isArtifactReference(reference) || reference.deletedAtISO) continue;
      if (!unique.has(reference.sha256)) unique.set(reference.sha256, reference);
    }
  }

  return [...unique.values()].sort((a, b) => b.createdAtISO.localeCompare(a.createdAtISO));
}

/**
 * BOTH kinds, from ONE sweep of the artifact RECORDS.
 *
 * `listKind` (above) asks the `by-kind/` pointers, and that cost this surface
 * `sec.artifacts_image = 2406ms` on drluriescience: two listings, a read of
 * every pointer, and a full-record read for every row returned. The
 * projection (`lib/artifact-listing-projection.ts`) lists the records once and
 * serves every row whose etag has not moved since it was last projected —
 * `1 list + 1 get` in steady state, and the pointers are not consulted at all,
 * so a shared or torn `by-kind/` pointer cannot affect this listing.
 *
 * The one case that still goes the old way is a projection that has not
 * converged: a cold or wholly-invalidated store larger than the sweep's read
 * budget answers `complete: false`, and this response falls back to `listKind`
 * rather than showing a short list. That costs the old price for the few loads
 * it takes the projection to fill in — never a wrong answer.
 */
const listArtifacts = async (store: ArtifactIndexStore): Promise<EditorialArtifact[]> => {
  const sweep = await sweepEditorialArtifacts(store);
  logDiagnostics('artifacts_projection', sweep.stats);
  if (sweep.complete) return [...sweep.byKind.image, ...sweep.byKind.pdf];

  const [images, pdfs] = await Promise.all([listKind(store, 'image'), listKind(store, 'pdf')]);
  return [...images, ...pdfs].map(projectEditorialArtifact).filter((artifact) => artifact !== undefined);
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });

  const access = await timeAuth(() => resolveAdminAccessFromEvent(event, context, binding));
  if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
  if (!access.isAdmin) return jsonResponse(403, { error: 'Admin access is required.' });

  const respond = (body: Record<string, unknown>) => {
    const serialized = timeSerialize(() => JSON.stringify({ ok: true, status: 200, ...body }));
    const etag = etagForSerialized(serialized);
    const ifNoneMatch = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      return { statusCode: 304, headers: { 'Cache-Control': CACHE_CONTROL, ETag: etag }, body: '' };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': CACHE_CONTROL, ETag: etag },
      body: serialized,
    };
  };

  try {
    const indexStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ArtifactIndexStore;

    /**
     * The two halves of this response are INDEPENDENT: the media listing is a
     * blob sweep of this tenant's artifact index, the template listing is one
     * cross-site HTTP POST to pdf-tool's `/mcp`. Running them back to back
     * paid for both in series on every load of the asset picker, and the
     * remote leg has no timeout of its own (lib/pdf-tool-client.ts) — a slow
     * pdf-tool cold start was added straight onto the sweep.
     *
     * `timeSection` splits the resulting `work` by QUESTION ASKED, so the
     * next Server-Timing read says which half is slow instead of leaving it
     * to another investigation.
     */
    const grant = buildPdfToolStorageGrant();
    const [projected, listed] = await Promise.all([
      timeSection('artifacts_projection', () => listArtifacts(indexStore)),
      // Same short-circuit as before: no grant, no call to pdf-tool at all.
      grant.ok ? timeSection('pdf_templates', () => listPlatformPdfTemplates(grant.grant, { limit: 100 })) : undefined,
    ]);

    const artifacts = [...projected].sort((a, b) => b.created_at.localeCompare(a.created_at));

    if (!grant.ok || !listed || !listed.ok) {
      return respond({ pdf_templates: [], artifacts, pdf_templates_available: false });
    }
    const rawTemplates = Array.isArray(listed.body.templates) ? listed.body.templates : [];
    const pdfTemplates = rawTemplates.map(projectPdfTemplate).filter((template) => template !== undefined);
    return respond({ pdf_templates: pdfTemplates, artifacts, pdf_templates_available: true });
  } catch (error) {
    console.error('Failed to load editorial assets.', error);
    return jsonResponse(500, { error: 'Templates and media could not be loaded.' });
  }
};

export const createHandler = (binding: SiteBinding) =>
  withServerTiming('admin-editorial-assets', buildHandlerImpl(binding));
