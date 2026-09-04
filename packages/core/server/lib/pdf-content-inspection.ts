/**
 * T2.4 — the impure half of the document content check: resolves a public artifact path to
 * pdf-tool's blobKey, calls the pdf-tool bridge's `inspect_pdf_artifact` (W1), and hands the
 * response to the pure decision in `packages/core/lib/pdf/document-content-check.ts`.
 *
 * JUDGEMENT CALL (BRIEF T2.4): `inspect_pdf_artifact` takes an artifactReference; the
 * document verifier holds a public URL it just fetched. The `/pdf/<requestId>/<sha256>.pdf`
 * public path IS the artifact's blobKey in servable form (see
 * `packages/core/server/lib/artifact-trust.ts`'s `publicPathForArtifactRef` /
 * `rawArtifactRefForPublicPath` — the same inverse this module reuses, not reinvented), and
 * the sha256 rides in the filename itself. So for that one shape the round trip is honest:
 * `rawArtifactRefForPublicPath` recovers the exact blobKey pdf-tool minted, the requestId is
 * the blobKey's own owning-request segment, and `inspect_pdf_artifact`'s own
 * `verifyArtifactMaterialization` re-proves it belongs to this project/request before any
 * byte is read. A URL that does NOT have that shape (an external PDF, a legacy committed
 * asset) is NOT silently treated as unreachable-content — this module reports `unverified`
 * with a reason instead of inventing a second inspection path in this repo (a verifier that
 * claims a check it did not run is worse than one that admits it could not).
 *
 * NO TENANT DATA (BRIEF §1): callers of `inspectDocumentContent` get back a `DocumentContentCheck`
 * that never carries a blobKey, sha256, storage grant, or tenant path — only the pure verdict
 * (pageCount/sizeBytes/reason/findings), which is already scrubbed at the source (pdf-tool's
 * own `agent-artifact-pdf-inspect.ts` contract, and `document-content-check.ts` above it).
 */
import {
  MAJOR_KEY_ARTIFACT_REF_RE,
  PUBLIC_ARTIFACT_PATH_RE,
  rawArtifactRefForPublicPath,
} from './artifact-trust.js';
import { buildPdfToolStorageGrant } from './pdf-tool-storage-grant.js';
import { inspectPlatformArtifact, type PdfToolClientOptions } from './pdf-tool-client.js';
import {
  evaluateDocumentContent,
  parseDocumentContentInspection,
  type DocumentContentFinding,
  type DocumentContentRequirement,
} from '../../lib/pdf/document-content-check.js';

export type DocumentContentCheck =
  | { status: 'ok'; pageCount: number; sizeBytes: number }
  | { status: 'failed'; reason: string; findings: DocumentContentFinding[]; pageCount?: number; sizeBytes?: number }
  | { status: 'unverified'; reason: string };

/**
 * The inverse of the artifact bridge's public path, restricted to PDFs: recovers
 * `{ blobKey, sha256 }` from a `/pdf/<requestId>/<sha256>.pdf` path or absolute URL.
 * `undefined` for anything else — an image path, a legacy committed asset, an external URL —
 * so the caller can report `unverified` honestly instead of guessing.
 */
export const resolvePdfArtifactRefFromPublicPath = (
  rawPath: string
): { blobKey: string; sha256: string; requestId: string } | undefined => {
  let pathname: string;
  try {
    pathname = /^https?:\/\//i.test(rawPath) ? new URL(rawPath).pathname : rawPath;
  } catch {
    return undefined;
  }

  if (!PUBLIC_ARTIFACT_PATH_RE.test(pathname) || !pathname.startsWith('/pdf/')) return undefined;

  const blobKey = rawArtifactRefForPublicPath(pathname);
  if (!MAJOR_KEY_ARTIFACT_REF_RE.test(blobKey)) return undefined;

  const segments = blobKey.split('/');
  const requestId = segments[1];
  const filename = segments[segments.length - 1] ?? '';
  const sha256 = filename.replace(/\.[a-z0-9]+$/i, '');
  if (!requestId || !sha256) return undefined;

  return { blobKey, sha256, requestId };
};

/**
 * Runs the actual content check for one already-resolved PDF artifact. Never throws: every
 * failure mode (bridge not configured, pdf-tool unreachable, the artifact not verifiable,
 * an unparseable inspection response) resolves to `{ status: 'unverified', reason }` rather
 * than a claim this module cannot back up.
 */
export const inspectDocumentContent = async (
  input: { blobKey: string; sha256?: string; requestId: string; requirement?: DocumentContentRequirement },
  options: PdfToolClientOptions = {}
): Promise<DocumentContentCheck> => {
  const built = buildPdfToolStorageGrant();
  if (!built.ok) {
    return { status: 'unverified', reason: `Content could not be inspected: ${built.error}` };
  }

  const artifactReference: Record<string, unknown> = { blobKey: input.blobKey };
  if (input.sha256) artifactReference.sha256 = input.sha256;

  const inspected = await inspectPlatformArtifact(built.grant, input.requestId, artifactReference, options);
  if (!inspected.ok) {
    // pdf-tool's own mcp.ts turns a business-level `ok: false` (ARTIFACT_NOT_VERIFIED,
    // ARTIFACT_NOT_PDF, PDF_INVALID_BYTES, ARTIFACT_BYTES_UNREADABLE, ...) into an MCP-level
    // error itself (see its `errorContent` wrapping) — postPdfTool already surfaces that here
    // as `ok: false`, so there is no separate "successful call, failed body.ok" case to check.
    return { status: 'unverified', reason: `Content could not be inspected: ${inspected.error}` };
  }

  const parsed = parseDocumentContentInspection(inspected.body);
  if (!parsed.ok) {
    return { status: 'unverified', reason: `Content could not be inspected: ${parsed.reason}` };
  }

  const verdict = evaluateDocumentContent(parsed.value, input.requirement);
  if (verdict.ok) {
    return { status: 'ok', pageCount: verdict.pageCount, sizeBytes: verdict.sizeBytes };
  }
  return {
    status: 'failed',
    reason: verdict.reason,
    findings: verdict.findings,
    pageCount: parsed.value.pageCount,
    sizeBytes: parsed.value.sizeBytes,
  };
};

/**
 * Convenience wrapper for a caller that only has the public path (the document verifier's
 * position): resolves it to a blobKey first and reports `unverified` immediately when the
 * path is not a recognized platform PDF artifact reference, instead of calling the bridge at
 * all.
 */
export const inspectDocumentContentFromPublicPath = async (
  publicPath: string,
  requirement: DocumentContentRequirement | undefined,
  options: PdfToolClientOptions = {}
): Promise<DocumentContentCheck> => {
  const resolved = resolvePdfArtifactRefFromPublicPath(publicPath);
  if (!resolved) {
    return {
      status: 'unverified',
      reason:
        'Content could not be inspected: this is not a recognized platform PDF artifact path ' +
        '(expected /pdf/<requestId>/<sha256>.pdf).',
    };
  }
  return inspectDocumentContent({ ...resolved, requirement }, options);
};

/**
 * W2 review (ruling D-D, closed) — the render-time half of the same verdict.
 *
 * `render_article_pdf` holds W1's warn-only quality gate at attach time and
 * nothing else in this repo does; without it, D-D's `pdf_quality` warning could
 * only ever appear after a human separately ran `verify_pdf_content`. This
 * turns a gate report into the SAME `DocumentContentCheck` shape that check
 * produces, so both writers file one verdict in one vocabulary.
 *
 * IT ONLY EVER PRODUCES A FAILURE, deliberately, for two reasons:
 *
 *  1. D-D is "a publish/release with a FAILING attached PDF warns". A clean
 *     gate is not evidence of a clean document — the gate is one pass over the
 *     render, not the full inspection `inspect_pdf_artifact` does — so
 *     recording "ok" from it would make `object_validate` show a green
 *     `pdf_quality` criterion for a check nobody ran. Recording nothing leaves
 *     the article honestly "not verified" until `verify_pdf_content` says
 *     otherwise.
 *  2. The bridge's job-status payload carries no page count (pdf-tool's status
 *     response has `qualityGate` and `artifactReference`, not `pageCount`), and
 *     the `ok` verdict is defined as a page count plus a byte size. Inventing
 *     either to fill the shape is exactly the class of claim this wave exists
 *     to stop.
 *
 * The page-count floor is passed explicitly as 1 — which is now also
 * `evaluateDocumentContent`'s own default, but stated here because it is
 * load-bearing rather than incidental: a page-count requirement belongs to the
 * job's own `requirements` and pdf-tool already failed the render if it was
 * violated, so re-applying a floor to a job it declared complete would
 * manufacture a finding out of policy rather than out of the document.
 */
export const failedContentCheckFromQualityGate = (
  gate: { passed?: boolean; findings?: readonly { code?: unknown; page?: unknown; detail?: unknown }[] } | undefined,
  observed: { pageCount?: number; sizeBytes?: number } = {}
): DocumentContentCheck | undefined => {
  if (!gate || !Array.isArray(gate.findings)) return undefined;

  const findings: DocumentContentFinding[] = [];
  for (const entry of gate.findings) {
    if (!entry || typeof entry !== 'object') continue;
    const code = (entry as { code?: unknown }).code;
    if (code !== 'BLANK_PAGE' && code !== 'UNRESOLVED_IMAGE' && code !== 'UNRENDERED_TOKEN') continue;
    const page = (entry as { page?: unknown }).page;
    const detail = (entry as { detail?: unknown }).detail;
    findings.push({
      code,
      ...(typeof page === 'number' && Number.isInteger(page) && page > 0 ? { page } : {}),
      detail: typeof detail === 'string' ? detail : '',
    });
  }
  if (findings.length === 0) return undefined;

  const verdict = evaluateDocumentContent(
    {
      pageCount: observed.pageCount ?? 1,
      sizeBytes: observed.sizeBytes ?? 0,
      qualityGate: { passed: false, findings },
    },
    { minPageCount: 1 }
  );
  if (verdict.ok) return undefined;
  return {
    status: 'failed',
    reason: verdict.reason,
    findings: verdict.findings,
    ...(observed.pageCount !== undefined ? { pageCount: observed.pageCount } : {}),
    ...(observed.sizeBytes !== undefined ? { sizeBytes: observed.sizeBytes } : {}),
  };
};
