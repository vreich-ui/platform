/**
 * The last-known PDF content-quality result, persisted where a SYNCHRONOUS
 * validation pass can read it back (W2 review — ruling D-D, closed).
 *
 * WHAT WAS OPEN. T2.5 added `ObjectValidationContext.resolvePdfContentCheck`
 * and the `pdf_quality` criterion that reads it, and then deliberately left the
 * resolver unwired: nothing in this repo persisted a `DocumentContentCheck`
 * anywhere a synchronous `buildStoreValidationContext` could find it, so the
 * criterion emitted nothing, always, and D-D was a ruling with no
 * implementation. (T2.5 was right not to fetch one live: `object_validate` runs
 * on every draft save, every candidate_patch dry-run and every publish attempt,
 * and an HTTP round trip to pdf-tool's `inspect_pdf_artifact` on each of those
 * is not a validation, it is an outage waiting for a slow day.)
 *
 * THIS IS THE MISSING HALF: a tiny append-only snapshot store, written by the
 * two places that already HOLD a verdict — `render_article_pdf` (the quality
 * gate is in its hand at attach time) and `verify_pdf_content` (its whole
 * output is one) — and preloaded by `buildStoreValidationContext` in the SAME
 * sweep it already does for artifact-ref existence. "Preload once, resolve
 * sync", exactly like `resolveArtifactRef`.
 *
 * WHERE IT LIVES. The artifact-index blob store, under its own
 * `pdf-content-checks/` prefix — beside `request-artifacts/`, keyed the same
 * way (`<requestId>/<sha256>`), so a check is addressed by the artifact it is
 * about and a re-render (a new sha) never inherits the previous render's
 * verdict. Nothing here mutates a record pdf-tool owns.
 *
 * WARN-ONLY, BOTH DIRECTIONS (D-A/D-D). Writing a snapshot is best-effort: a
 * store that will not write must never fail a render or a verification, and an
 * absent snapshot means "not verified", which the criterion reports as nothing
 * at all rather than as a pass or a failure.
 *
 * NO TENANT DATA (BRIEF §1). The stored value is the `DocumentContentCheck`
 * itself — page count, byte size, findings, a reason sentence already scrubbed
 * at source (`document-content-check.ts`). The blobKey and sha live in the
 * STORAGE KEY, which is machine plumbing and never rendered; nothing this
 * module hands back to a caller carries either.
 */
import type { ArtifactIndexStore } from './artifact-index.js';
import type { DocumentContentCheck } from './pdf-content-inspection.js';
import { resolvePdfArtifactRefFromPublicPath } from './pdf-content-inspection.js';

/** One stored snapshot. `checkedAt` is what lets an operator tell a stale
 *  verdict from a fresh one; the check itself is stored verbatim. */
export type StoredPdfContentCheck = {
  publicPath: string;
  checkedAt: string;
  check: DocumentContentCheck;
};

export const pdfContentCheckKey = (requestId: string, sha256: string): string =>
  `pdf-content-checks/${encodeURIComponent(requestId)}/${sha256}.json`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses a stored snapshot back, refusing anything that is not one of the
 *  three shapes `DocumentContentCheck` actually has — a corrupted or
 *  future-shaped entry reads as ABSENT, never as a pass. */
export const parseStoredPdfContentCheck = (raw: unknown): StoredPdfContentCheck | undefined => {
  if (!isRecord(raw)) return undefined;
  const publicPath = typeof raw.publicPath === 'string' ? raw.publicPath : undefined;
  const checkedAt = typeof raw.checkedAt === 'string' ? raw.checkedAt : undefined;
  const check = raw.check;
  if (!publicPath || !checkedAt || !isRecord(check)) return undefined;
  if (check.status === 'ok') {
    if (typeof check.pageCount !== 'number' || typeof check.sizeBytes !== 'number') return undefined;
    return { publicPath, checkedAt, check: { status: 'ok', pageCount: check.pageCount, sizeBytes: check.sizeBytes } };
  }
  if (check.status === 'failed') {
    if (typeof check.reason !== 'string' || !Array.isArray(check.findings)) return undefined;
    return { publicPath, checkedAt, check: check as unknown as DocumentContentCheck };
  }
  if (check.status === 'unverified') {
    if (typeof check.reason !== 'string') return undefined;
    return { publicPath, checkedAt, check: { status: 'unverified', reason: check.reason } };
  }
  return undefined;
};

/**
 * Records the last-known content check for one PDF public path. Best-effort:
 * an unwritable store, an unrecognized path, or a check this pipeline could not
 * make (`unverified`) all resolve to "nothing recorded" rather than an error —
 * a render must never fail because a warning could not be filed.
 *
 * `unverified` is deliberately NOT persisted: "we could not look" is not a
 * finding, and storing it would make a later reader think a check had run.
 */
export const recordPdfContentCheck = async (
  store: ArtifactIndexStore | undefined,
  publicPath: string,
  check: DocumentContentCheck,
  now: () => string = () => new Date().toISOString()
): Promise<boolean> => {
  if (!store || check.status === 'unverified') return false;
  const resolved = resolvePdfArtifactRefFromPublicPath(publicPath);
  if (!resolved) return false;
  const value: StoredPdfContentCheck = { publicPath, checkedAt: now(), check };
  try {
    await store.setJSON(pdfContentCheckKey(resolved.requestId, resolved.sha256), value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Reads the snapshots for a set of PDF public paths, into the exact map
 * `buildStoreValidationContext` hands `ObjectValidationContext` as
 * `documentContentChecks`. A path with no snapshot is simply absent from the
 * map, which the `pdf_quality` criterion reads as "not verified".
 */
export const loadPdfContentChecks = async (
  store: ArtifactIndexStore | undefined,
  publicPaths: readonly string[]
): Promise<Record<string, DocumentContentCheck>> => {
  const out: Record<string, DocumentContentCheck> = {};
  if (!store || publicPaths.length === 0) return out;

  await Promise.all(
    [...new Set(publicPaths)].map(async (publicPath) => {
      const resolved = resolvePdfArtifactRefFromPublicPath(publicPath);
      if (!resolved) return;
      let raw: string | null;
      try {
        raw = await store.get(pdfContentCheckKey(resolved.requestId, resolved.sha256));
      } catch {
        return;
      }
      if (!raw) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return;
      }
      const stored = parseStoredPdfContentCheck(parsed);
      if (stored) out[publicPath] = stored.check;
    })
  );

  return out;
};
