/**
 * T2.4 — the pure decision behind the document verifier's content check.
 *
 * On 2026-09-03 a 5-page drlurie PDF — `[object Object]` twice, four pages with no body
 * text, every image a broken-image box — passed `verify-article-images.ts`'s document check
 * because that check only asked "is the expected document linked on the page, HTTP 200, and
 * content-type application/pdf?". None of those three questions look at what is ON the
 * pages. This module is the missing question, answered as a pure function so it can be
 * tested with plain input/output and no server: given an inspection of a PDF's actual pages
 * (page count, per-page text length, the render engine's own quality-gate findings) and a
 * requirement, is this document OK to have passed as "the expected document", and if not,
 * why not.
 *
 * The inspection input is intentionally the same shape `inspect_pdf_artifact` (pdf-tool, W1)
 * returns — this module does not parse PDF bytes itself and does not re-implement the
 * quality gate; it only decides what an already-computed inspection means for one expected
 * document. See `packages/core/server/lib/pdf-content-inspection.ts` for the (impure) code
 * that calls pdf-tool's bridge and hands its response to `evaluateDocumentContent` below.
 *
 * NO TENANT DATA (BRIEF §1): a `DocumentContentFinding.detail` is whatever pdf-tool's own
 * quality gate put there — already scrubbed of blobKeys/paths by that module's own contract
 * (asset ids and slot names only). This module never adds a blobKey, sha256, or storage path
 * to any reason string it produces.
 */
import { z } from 'zod';

export type DocumentContentFindingCode = 'BLANK_PAGE' | 'UNRESOLVED_IMAGE' | 'UNRENDERED_TOKEN';

export type DocumentContentFinding = {
  code: DocumentContentFindingCode;
  page?: number;
  detail: string;
};

export type DocumentContentInspection = {
  pageCount: number;
  sizeBytes: number;
  qualityGate: {
    passed: boolean;
    findings: DocumentContentFinding[];
  };
};

/** The zod mirror of the subset of pdf-tool's InspectPdfArtifactResult this module needs.
 * Parsing (not just casting) an external service's response before it drives a pass/fail
 * decision — an unexpected shape must become "could not be inspected", never a crash and
 * never a silently-wrong verdict. */
export const documentContentInspectionSchema = z.object({
  pageCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  qualityGate: z.object({
    passed: z.boolean(),
    findings: z.array(
      z.object({
        code: z.enum(['BLANK_PAGE', 'UNRESOLVED_IMAGE', 'UNRENDERED_TOKEN']),
        page: z.number().int().positive().optional(),
        detail: z.string(),
      })
    ),
  }),
});

export const parseDocumentContentInspection = (
  raw: unknown
): { ok: true; value: DocumentContentInspection } | { ok: false; reason: string } => {
  const parsed = documentContentInspectionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'pdf-tool returned an inspection response in an unexpected shape.' };
  }
  return { ok: true, value: parsed.data };
};

export type DocumentContentRequirement = {
  /**
   * Default 1 — i.e. no floor beyond "it has a page".
   *
   * W2 REVIEW: this defaulted to 2, which made every caller that simply passed
   * `expectedDocuments` fail a legitimately one-page PDF with a reason it never
   * asked for — the "precheck that fails correct inputs" shape. A page-count
   * FLOOR is a property of the job that produced the document
   * (`requirements.pageCount`, which pdf-tool enforces at render with
   * PDF_REQ_PAGE_COUNT_MIN), not a default a verifier should invent about a
   * document somebody linked. A caller who does want a floor passes one and
   * gets it honoured, exactly as before.
   *
   * The findings that actually catch the 2026-09-03 defect — blank pages,
   * unresolved images, leaked template tokens — are unchanged and still fail.
   */
  minPageCount?: number;
  maxBytes?: number;
};

export type DocumentContentVerdict =
  | { ok: true; pageCount: number; sizeBytes: number }
  | { ok: false; reason: string; findings: DocumentContentFinding[] };

const DEFAULT_MIN_PAGE_COUNT = 1;

const describeFindingGroup = (
  code: DocumentContentFindingCode,
  label: string,
  findings: DocumentContentFinding[]
): string | undefined => {
  const matches = findings.filter((finding) => finding.code === code);
  if (matches.length === 0) return undefined;
  const pages = matches
    .map((finding) => finding.page)
    .filter((page): page is number => typeof page === 'number');
  const pageList = pages.length > 0 ? ` (page${pages.length > 1 ? 's' : ''} ${pages.join(', ')})` : '';
  return `${matches.length} ${label}${matches.length > 1 ? 's' : ''}${pageList}.`;
};

/**
 * The pure decision: given one already-computed inspection and a requirement, is this
 * document OK. Never throws, never calls out — every input is data already in hand.
 */
export const evaluateDocumentContent = (
  inspection: DocumentContentInspection,
  requirement: DocumentContentRequirement = {}
): DocumentContentVerdict => {
  const minPageCount = requirement.minPageCount ?? DEFAULT_MIN_PAGE_COUNT;
  const reasons: string[] = [];

  if (inspection.pageCount < minPageCount) {
    reasons.push(`Only ${inspection.pageCount} page(s); at least ${minPageCount} required.`);
  }

  if (requirement.maxBytes !== undefined && inspection.sizeBytes > requirement.maxBytes) {
    reasons.push(`PDF is ${inspection.sizeBytes} bytes, exceeding the ${requirement.maxBytes}-byte limit.`);
  }

  const findings = inspection.qualityGate.findings;
  const blank = describeFindingGroup('BLANK_PAGE', 'page has no readable body text', findings);
  const unresolved = describeFindingGroup('UNRESOLVED_IMAGE', 'image failed to resolve', findings);
  const unrendered = describeFindingGroup('UNRENDERED_TOKEN', 'unrendered template token or leaked value', findings);
  if (blank) reasons.push(blank);
  if (unresolved) reasons.push(unresolved);
  if (unrendered) reasons.push(unrendered);

  if (reasons.length === 0) {
    return { ok: true, pageCount: inspection.pageCount, sizeBytes: inspection.sizeBytes };
  }
  return { ok: false, reason: reasons.join(' '), findings };
};
