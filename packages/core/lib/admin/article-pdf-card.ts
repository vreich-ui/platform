/**
 * Article inspector → PDF card (T2.6, W2 brief §"Two deliverables"/1).
 *
 * Every decision the card makes lives HERE, not in the `.tsx`: which of the
 * five states (`none` / `rendering` / `attached-unverified` / `verified` /
 * `failed`) the article is in, which actions that state permits, and how a
 * quality-gate report renders to readable strings. `ArticlePdfCard.tsx` is a
 * thin renderer over `buildArticlePdfCardView` — this repo has no DOM/
 * component test stack (`tsconfig.test.json` excludes
 * `packages/core/admin/**\/*.tsx`), so a decision made in JSX is a decision
 * nothing tests, and a previous wave shipped a crash-level bug for exactly
 * that reason.
 *
 * PROVABLE, NEVER CLAIMED (governing principle, Wave 2 onward: "the UI must
 * never claim a state it can't prove"). Every state below is read off data
 * actually in hand:
 *   - `none` / attached: whether the article body carries a `document`-typed
 *     media node (or a `/pdf/…` `ctaLink`) pointing at a PDF artifact — the
 *     one mechanism `object-validate.ts` already sanctions for attaching a
 *     PDF to an article (`PDF_PUBLIC_PATH_RE`, mirrored locally below).
 *   - `rendering` / `failed`: the most recent `render_article_pdf` /
 *     `create_agent_artifact_job` job status this object's own chat has
 *     actually seen (a `tool_result` event — `extractLatestArticlePdfJob`).
 *   - `verified`: the most recent `verify_pdf_content` result the chat has
 *     actually seen (`extractLatestArticlePdfVerification`) — never inferred
 *     from an HTTP 200, never assumed from an old attach.
 *
 * ASSUMED SHAPES — FLAG FOR VERIFICATION (brief, §"THE TEST CONSTRAINT" +
 * "Do not touch mcp-tool-handlers.ts"). `render_article_pdf` and
 * `verify_pdf_content` are T2.3's tools, built in parallel in a file this
 * task must not touch. This module wires against the NAMES and SHAPES the
 * brief documents (job.qualityGate: {passed, findings[]}, job.warnings,
 * W1's job-status contract) and nothing more. Two joins need verifying once
 * T2.3 lands:
 *   1. That these tools actually run through the admin object chat (so their
 *      `tool_result` reaches `ChatEventView[]`) and are marked to disclose
 *      their result (`discloseResult`-equivalent) — today NEITHER tool
 *      exists, so this is untested against a real payload.
 *   2. The exact field names on the job/verification bodies. Every read
 *      below is defensive (missing/mistyped fields degrade to "unknown"
 *      rather than a wrong claim) for exactly this reason.
 *
 * NO TENANT DATA IN EDITOR-VISIBLE TEXT (brief §1). A finding or warning
 * string coming back from the render engine could in principle embed a
 * blobKey or a sha256 — `redact()` strips both defensively before any string
 * in this module reaches a human. The article's own `/pdf/{id}/{sha256}.pdf`
 * path is carried as an `href` (a link TARGET, never printed as text) so
 * "Open PDF" stays one click away without ever rendering the path as prose.
 */
import type { ChatEventView } from './chat-client.js';

// ─── redaction (brief §1: no blobKeys/SHAs/tenant paths in editor text) ─────

const SHA256_RE = /\b[0-9a-f]{64}\b/gi;
const BLOBKEY_RE = /\b(?:image|pdf|document)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/gi;

/** Strips anything blobKey- or sha256-shaped from a string bound for the UI. */
export const redactArticlePdfText = (text: string): string =>
  text.replace(BLOBKEY_RE, '[reference removed]').replace(SHA256_RE, '[reference removed]');

// ─── attachment: is a PDF actually on the article? ──────────────────────────

/** Mirrors `object-validate.ts`'s `PDF_PUBLIC_PATH_RE` (kept local: this
 *  module must not import server/lib into admin/lib). */
const PDF_PUBLIC_PATH_RE = /^\/pdf\/[^/]+\/[0-9a-f]{64}\.pdf$/i;

export interface ArticlePdfNodeLike {
  id: string;
  public?: {
    media?: { type?: string; src?: string } | null;
    ctaLink?: string;
  } | null;
}

export interface ArticlePdfAttachment {
  /** The node the PDF is attached through — what `buildDetachPdfOp` targets. */
  nodeId: string;
  /** The article's own `/pdf/{id}/{sha256}.pdf` path. A LINK TARGET ONLY —
   *  never render this as visible text (brief §1). */
  href: string;
  /** Which field on the node carries it, so detach clears the right one. */
  via: 'media' | 'ctaLink';
}

/** Finds the (at most one, by convention) PDF attached to this article's
 *  body. A `document` media node wins over a `ctaLink` when both exist. */
export function findAttachedPdf(nodes: readonly ArticlePdfNodeLike[] | undefined): ArticlePdfAttachment | undefined {
  for (const node of nodes ?? []) {
    const media = node.public?.media;
    if (media && media.type === 'document' && typeof media.src === 'string' && PDF_PUBLIC_PATH_RE.test(media.src)) {
      return { nodeId: node.id, href: media.src, via: 'media' };
    }
  }
  for (const node of nodes ?? []) {
    const link = node.public?.ctaLink;
    if (typeof link === 'string' && PDF_PUBLIC_PATH_RE.test(link)) {
      return { nodeId: node.id, href: link, via: 'ctaLink' };
    }
  }
  return undefined;
}

// ─── the job record (W1 shape: qualityGate + warnings) ──────────────────────

export type ArticlePdfJobStatus = 'pending' | 'running' | 'complete' | 'failed';

const IN_FLIGHT_STATUSES = new Set<string>(['pending', 'queued', 'running', 'blocked']);
const FAILED_STATUSES = new Set<string>(['failed', 'error']);

export interface PdfQualityFinding {
  /** BLANK_PAGE | UNRESOLVED_IMAGE | UNRENDERED_TOKEN | … (W1, warn-only). */
  code: string;
  page?: number;
  assetId?: string;
  token?: string;
  message?: string;
}

/** W1: `job.qualityGate: { passed, findings[] }`. The gate WARNS, never
 *  blocks (D-A) — `passed: false` is informational, not a job failure. */
export interface PdfQualityGate {
  passed: boolean;
  findings: PdfQualityFinding[];
}

export interface ArticlePdfJobRecord {
  jobId: string;
  status: ArticlePdfJobStatus;
  templateId?: string;
  createdAt?: string;
  qualityGate?: PdfQualityGate;
  /** W1: engine diagnostics, `job.warnings`. */
  warnings?: string[];
  error?: { code?: string; message: string };
}

export interface ArticlePdfVerification {
  verified: boolean;
  checkedAt?: string;
  /** Why verification failed, or what it actually checked. Never a raw HTTP body. */
  reason?: string;
}

// ─── the state machine (acceptance: five states, provably derived) ─────────

export type ArticlePdfState = 'none' | 'rendering' | 'attached-unverified' | 'verified' | 'failed';

export interface ArticlePdfStateResult {
  state: ArticlePdfState;
  /** Populated only for `failed` — the one state the brief requires a reason for. */
  reason?: string;
}

export interface ArticlePdfStateInput {
  attachment?: ArticlePdfAttachment;
  job?: ArticlePdfJobRecord;
  verification?: ArticlePdfVerification;
}

/**
 * Precedence, most authoritative first:
 *
 *  1. A job actively in flight always reads `rendering` — including a
 *     re-render over an already-attached, already-verified PDF; nothing else
 *     is true of the PDF until that job settles.
 *  2. A job that failed, or a verification that came back negative, is
 *     `failed` — proof the current state is NOT usable, whether or not an
 *     (older, possibly stale) PDF is still attached.
 *  3. Attached + a positive verification is `verified`.
 *  4. Attached + no positive verification yet (verification never run, OR a
 *     job completed WITH quality-gate findings — D-A: the gate warns, it
 *     never blocks) is `attached-unverified` — a REAL, common state, not an
 *     error state. Quality-gate findings ride alongside this state; they do
 *     not demote it to `failed`.
 *  5. Nothing attached and no job in flight is `none`.
 */
export function deriveArticlePdfState(input: ArticlePdfStateInput): ArticlePdfStateResult {
  const { attachment, job, verification } = input;

  if (job && IN_FLIGHT_STATUSES.has(job.status)) {
    return { state: 'rendering' };
  }
  if (job && FAILED_STATUSES.has(job.status)) {
    return { state: 'failed', reason: job.error?.message ?? 'The last render attempt failed.' };
  }
  if (verification && verification.verified === false) {
    return { state: 'failed', reason: verification.reason ?? 'Verification found the attached PDF unusable.' };
  }
  if (attachment) {
    if (verification?.verified === true) return { state: 'verified' };
    return { state: 'attached-unverified' };
  }
  return { state: 'none' };
}

// ─── actions the state permits ───────────────────────────────────────────────

export type ArticlePdfActionId = 'make_pdf' | 're_render' | 'verify' | 'detach';

export interface ArticlePdfAction {
  id: ArticlePdfActionId;
  label: string;
}

const ACTION_LABEL: Record<ArticlePdfActionId, string> = {
  make_pdf: 'Make PDF',
  re_render: 'Re-render',
  verify: 'Verify',
  detach: 'Detach',
};

/** Which of Make PDF / Re-render / Verify / Detach a state permits. A
 *  control this returns nothing for must not render at all — never disabled
 *  with an invented reason, never present but broken (brief §"UI must never
 *  claim a state it can't prove"). */
export function articlePdfActionsForState(state: ArticlePdfState): ArticlePdfAction[] {
  const ids: readonly ArticlePdfActionId[] = (() => {
    switch (state) {
      case 'none':
        return ['make_pdf'];
      case 'rendering':
        // A job is already in flight; nothing else is actionable until it settles.
        return [];
      case 'attached-unverified':
        return ['verify', 're_render', 'detach'];
      case 'verified':
        // Already proven good; re-render replaces it, detach removes it.
        // Re-running Verify on an unchanged, already-verified PDF adds
        // nothing the badge doesn't already say.
        return ['re_render', 'detach'];
      case 'failed':
        // Nothing to verify until a new render replaces the broken one;
        // detach still removes whatever (possibly stale) file is attached.
        return ['re_render', 'detach'];
      default:
        return [];
    }
  })();
  return ids.map((id) => ({ id, label: ACTION_LABEL[id] }));
}

// ─── quality-gate report → human strings (acceptance: no blobKeys/SHAs) ─────

const FINDING_COPY: Record<string, (finding: PdfQualityFinding) => string> = {
  BLANK_PAGE: (f) => `Page ${f.page ?? '?'} rendered with no body text.`,
  UNRESOLVED_IMAGE: (f) =>
    `An image did not resolve${f.page ? ` on page ${f.page}` : ''}${f.assetId ? ` (asset ${f.assetId})` : ''}.`,
  UNRENDERED_TOKEN: (f) =>
    `A template token was left unrendered${f.page ? ` on page ${f.page}` : ''}${f.token ? ` ("${f.token}")` : ''}.`,
};

/** One quality-gate finding, as a sentence a human can act on — never the
 *  finding's raw JSON, never a code alone if there is anything more to say. */
export function describeQualityFinding(finding: PdfQualityFinding): string {
  const known = FINDING_COPY[finding.code];
  if (known) return redactArticlePdfText(known(finding));
  const fallback = finding.message?.trim() || finding.code.replace(/_/g, ' ').toLowerCase();
  const withPage = finding.page ? `${fallback} (page ${finding.page})` : fallback;
  return redactArticlePdfText(withPage);
}

/**
 * The full quality-gate report for a job: every finding, then every engine
 * warning, each redacted independently. D-A / this brief: a job can complete
 * WITH findings — this list is shown as information, never framed as a
 * failure, and an empty return means "nothing to show", not "no PDF".
 */
export function describeQualityGate(job: Pick<ArticlePdfJobRecord, 'qualityGate' | 'warnings'> | undefined): string[] {
  if (!job) return [];
  const findings = (job.qualityGate?.findings ?? []).map(describeQualityFinding);
  const warnings = (job.warnings ?? []).map((warning) => redactArticlePdfText(warning));
  return [...findings, ...warnings];
}

/** Whether there is anything worth a "quality gate" section at all. */
export function hasQualityGateReport(job: Pick<ArticlePdfJobRecord, 'qualityGate' | 'warnings'> | undefined): boolean {
  return describeQualityGate(job).length > 0;
}

// ─── detach: an ordinary content patch, not a pdf-tool call ────────────────

/** A type alias, not an interface, on purpose: `EditSession.patch` takes
 *  `Record<string, unknown>[]`, and an interface has no implicit index
 *  signature, so an interface here does not assign to it. (That mismatch
 *  shipped as a real TS2322 in `ArticlePdfCard.tsx` — invisible to `npm test`,
 *  which excludes `packages/core/admin/**\/*.tsx`, and caught only by
 *  `npm run check:astro`.) */
export type ArticlePdfPatchOp = {
  op: 'update_node';
  node_id: string;
  fields: Record<string, unknown>;
};

/**
 * Detaching a PDF is a content edit, not a pdf-tool action — it clears
 * whichever field `findAttachedPdf` found it on and leaves the rest of the
 * node (and the pdf-tool artifact itself) untouched. `null` is the patch
 * engine's field-unset marker (`object-patch-apply.ts`'s `mergeFields`),
 * same convention `buildPinKindDefaultOp` (visual-identity-pdf.ts) relies on.
 */
export function buildDetachPdfOp(attachment: Pick<ArticlePdfAttachment, 'nodeId' | 'via'>): ArticlePdfPatchOp {
  if (!attachment.nodeId.trim()) throw new Error('A node id is required to detach a PDF.');
  const fields = attachment.via === 'media' ? { public: { media: null } } : { public: { ctaLink: null } };
  return { op: 'update_node', node_id: attachment.nodeId, fields };
}

// ─── chat-driven actions: prompts for Make PDF / Re-render / Verify ────────

/**
 * Make PDF / Re-render / Verify have no browser-reachable admin endpoint —
 * same seam `visual-identity-pdf.ts`'s "Render sample" uses — so each becomes
 * a prompt that SEEDS the object's own chat composer (`ObjectWorkspace`'s
 * `composerSeed`), naming T2.3's tool explicitly rather than leaving the
 * agent to guess which one applies.
 */
export function buildArticlePdfPrompt(
  action: Extract<ArticlePdfActionId, 'make_pdf' | 're_render' | 'verify'>,
  context: { contentItemId: string; templateId?: string }
): string {
  const template = context.templateId ? ` using template ${context.templateId}` : '';
  switch (action) {
    case 'make_pdf':
      return (
        `Render a PDF for this article (content item ${context.contentItemId}) with render_article_pdf${template}, ` +
        `then attach it to the article. Quality-gate findings only warn, they never block — report them plainly ` +
        `rather than treating the render as failed.`
      );
    case 're_render':
      return (
        `Re-render the PDF for this article (content item ${context.contentItemId}) with render_article_pdf${template}, ` +
        `replacing the currently attached one. Report any quality-gate findings plainly; they warn, they don't block.`
      );
    case 'verify':
      return (
        `Verify the PDF currently attached to this article (content item ${context.contentItemId}) with ` +
        `verify_pdf_content and tell me the result plainly.`
      );
    default:
      return action satisfies never;
  }
}

// ─── reading the job/verification off this object's own chat transcript ────

/**
 * ASSUMED JOIN (flagged above): a job/verification is "in hand" only once
 * this object's chat has actually seen its `tool_result`. `events` is the
 * SAME `ChatEventView[]` `ObjectWorkspace` already polls for this object —
 * scoped to one object already, so no extra filtering by content-item id is
 * needed here.
 */
const JOB_TOOL_NAMES = new Set(['render_article_pdf', 'create_agent_artifact_job', 'get_agent_artifact_job_status']);
const VERIFY_TOOL_NAMES = new Set(['verify_pdf_content']);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** A `tool_result` event's `detail.output` as parsed JSON, defensively. It
 *  may already be an object (some callers pass structured `output`), or a
 *  JSON string (the common shape elsewhere in this chat transport). */
function parseToolOutput(detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const output = detail?.output;
  if (typeof output === 'string') {
    try {
      const parsed: unknown = JSON.parse(output);
      return asRecord(parsed);
    } catch {
      return undefined;
    }
  }
  return asRecord(output);
}

function normalizeQualityGate(value: unknown): PdfQualityGate | undefined {
  const gate = asRecord(value);
  if (!gate) return undefined;
  const rawFindings = Array.isArray(gate.findings) ? gate.findings : [];
  const findings: PdfQualityFinding[] = rawFindings.flatMap((entry) => {
    const record = asRecord(entry);
    const code = asString(record?.code);
    if (!record || !code) return [];
    return [
      {
        code,
        ...(asNumber(record.page) !== undefined ? { page: asNumber(record.page) } : {}),
        ...(asString(record.assetId) ? { assetId: asString(record.assetId) } : {}),
        ...(asString(record.token) ? { token: asString(record.token) } : {}),
        ...(asString(record.message) ? { message: asString(record.message) } : {}),
      },
    ];
  });
  return { passed: gate.passed !== false, findings };
}

/**
 * W2 REVIEW — this used to default to 'complete'.
 *
 * "The UI must never claim a state it can't prove" (governing principle). A
 * status word this card does not recognize — a body with no `status` at all, a
 * word pdf-tool grows later, a truncated payload — is "I don't know", and "I
 * don't know" is not "finished". Defaulting it to 'complete' made the card
 * declare an unproven render done, offer Verify/Detach over a PDF that may not
 * exist, and quietly depend on `render_article_pdf`'s timeout receipt saying
 * `status: 'pending'` to stay honest. `pending` is the safe unknown: it reads
 * as "rendering", offers no action, and resolves itself on the next poll.
 * `normalizeArticlePdfJobStatus` (lib/pdf/article-pdf-render.ts) already
 * biases the same way for the same reason; these two now agree.
 */
function normalizeJobStatus(value: unknown): ArticlePdfJobStatus {
  const status = asString(value)?.toLowerCase();
  if (!status) return 'pending';
  if (FAILED_STATUSES.has(status)) return 'failed';
  if (IN_FLIGHT_STATUSES.has(status)) return 'pending';
  if (status === 'complete' || status === 'completed' || status === 'succeeded') return 'complete';
  return 'pending';
}

function normalizeJobRecord(body: Record<string, unknown>): ArticlePdfJobRecord | undefined {
  const jobId = asString(body.jobId) ?? asString(body.job_id);
  if (!jobId) return undefined;
  const errorRecord = asRecord(body.error);
  const warnings = Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string') : undefined;
  return {
    jobId,
    status: normalizeJobStatus(body.status),
    ...(asString(body.templateId) ? { templateId: asString(body.templateId) } : {}),
    ...(asString(body.createdAt) ? { createdAt: asString(body.createdAt) } : {}),
    ...(normalizeQualityGate(body.qualityGate) ? { qualityGate: normalizeQualityGate(body.qualityGate) } : {}),
    ...(warnings && warnings.length ? { warnings } : {}),
    ...(errorRecord && asString(errorRecord.message)
      ? { error: { message: asString(errorRecord.message)!, ...(asString(errorRecord.code) ? { code: asString(errorRecord.code) } : {}) } }
      : {}),
  };
}

/** The most recent job status this chat has actually seen, for the tools
 *  that can report one. An errored tool CALL (not a business-logic failure
 *  the tool reported cleanly) still proves an attempt failed. */
export function extractLatestArticlePdfJob(events: readonly ChatEventView[]): ArticlePdfJobRecord | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== 'tool_result') continue;
    const tool = asString(event.detail?.tool);
    if (!tool || !JOB_TOOL_NAMES.has(tool)) continue;
    if (event.detail?.is_error) {
      return { jobId: `${tool}-${event.seq}`, status: 'failed', error: { message: 'The render request failed.' } };
    }
    const body = parseToolOutput(event.detail);
    if (!body) continue;
    const record = normalizeJobRecord(body);
    if (record) return record;
  }
  return undefined;
}

/** The most recent `verify_pdf_content` result this chat has actually seen. */
export function extractLatestArticlePdfVerification(events: readonly ChatEventView[]): ArticlePdfVerification | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== 'tool_result') continue;
    const tool = asString(event.detail?.tool);
    if (!tool || !VERIFY_TOOL_NAMES.has(tool)) continue;
    if (event.detail?.is_error) {
      return { verified: false, reason: 'Verification could not run.' };
    }
    const body = parseToolOutput(event.detail);
    if (!body) continue;
    return {
      verified: body.verified === true,
      ...(asString(body.checkedAt) ? { checkedAt: asString(body.checkedAt) } : {}),
      ...(asString(body.reason) ? { reason: asString(body.reason) } : {}),
    };
  }
  return undefined;
}

// ─── the assembled view: everything `ArticlePdfCard.tsx` needs, decided ────

export interface ArticlePdfCardView {
  state: ArticlePdfState;
  reason?: string;
  actions: ArticlePdfAction[];
  /** A link target only — never rendered as text (brief §1). */
  openHref?: string;
  qualityGateLines: string[];
  qualityGatePassed?: boolean;
}

export function buildArticlePdfCardView(input: ArticlePdfStateInput): ArticlePdfCardView {
  const { state, reason } = deriveArticlePdfState(input);
  return {
    state,
    ...(reason ? { reason } : {}),
    actions: articlePdfActionsForState(state),
    ...(input.attachment?.href ? { openHref: input.attachment.href } : {}),
    qualityGateLines: describeQualityGate(input.job),
    ...(input.job?.qualityGate ? { qualityGatePassed: input.job.qualityGate.passed } : {}),
  };
}
