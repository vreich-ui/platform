/**
 * W2 T2.3 — `render_article_pdf`, the composite, as a pure orchestrator.
 *
 * THE POINT OF THE WAVE. Before this, producing a PDF for an article meant an
 * agent hand-assembling one: build render data (or guess it), create a job,
 * poll it, read the outcome, decide what the quality gate meant, and patch the
 * result onto the article. Every one of those steps is a place the 2026-09-03
 * garbage PDF went wrong. This module is that whole sequence, decided once:
 *
 *   build render data → create the job → poll to completion → read the quality
 *   gate → attach the PDF to the article as a `document` node → return a
 *   RECEIPT.
 *
 * THE RECEIPT IS THE DELIVERABLE, not the side effect. It says what was
 * rendered, what the quality gate found, what the mapper could not fill
 * (`unfilled[]`), and where the PDF now lives. An agent that reads only the
 * receipt knows everything a human would need to know.
 *
 * RULING D-A BINDS HERE: content quality WARNS, it never blocks. A job that
 * completes WITH quality-gate findings is a completed job — it attaches, and
 * the receipt carries the findings. Only a job pdf-tool itself failed is a
 * failure, and then it surfaces as ITSELF (`RENDER_DATA_INVALID`,
 * `ASSET_MISSING`, `DATA_BINDING_ERROR`, …), never flattened into a generic
 * error, and nothing is attached.
 *
 * WHY THIS FILE IS PURE. Every effect — creating the job, polling it, reading
 * the article, writing the patch, sleeping, the clock — is INJECTED
 * (`RenderArticlePdfEffects`). The repo's test posture is logic-first with no
 * live pdf-tool (BRIEF §4), and the interesting behaviour here is entirely
 * decisions: does this outcome attach, what does the receipt say, does the
 * poll terminate. Those are tested against fakes; `mcp-tool-handlers.ts` binds
 * the real effects and adds nothing but I/O.
 *
 * NO TENANT DATA (BRIEF §1). Nothing this module emits carries a storage
 * grant, a blobKey, a blob sha, or a tenant store path. `redactPdfReceiptText`
 * strips anything blobKey- or sha-shaped out of every free-text string that
 * arrives from the render engine before it reaches the receipt. The ONE path
 * that appears is the article's own public artifact path
 * (`/pdf/{requestId}/{sha256}.pdf`) — carried as `attachment.href`, a link
 * TARGET: it is the value that gets written into the article body, it is what
 * the admin PDF card opens, and the existing bridge already returns it as
 * `public_path` on every completed job. A receipt that would not say where the
 * PDF lives could not do its job — which is why it is carried BOTH as
 * `attachment.href` (where it landed on the article) and, since the W2 review,
 * as `public_path` on every completed receipt including `attach: false`, under
 * the same field name the rest of the bridge uses.
 */
import { MediaTypeError, normalizeArticleNodeMediaFields } from '../article-content/media-type.js';

// ─── redaction ──────────────────────────────────────────────────────────────

const SHA256_RE = /\b[0-9a-f]{64}\b/gi;
const BLOBKEY_RE = /\b(?:image|pdf|document)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/gi;

/** Strips anything blobKey- or sha256-shaped from a string bound for a
 *  receipt. Mirrors `admin/article-pdf-card.ts`'s `redactArticlePdfText` —
 *  deliberately duplicated rather than shared, because `packages/core/admin`
 *  must not depend on the pdf pipeline and vice versa. */
export const redactPdfReceiptText = (text: string): string =>
  text.replace(BLOBKEY_RE, '[reference removed]').replace(SHA256_RE, '[reference removed]');

// ─── the job, as this module reads it ───────────────────────────────────────

export type PdfQualityFinding = {
  /** BLANK_PAGE | UNRESOLVED_IMAGE | UNRENDERED_TOKEN | … (W1, warn-only). */
  code: string;
  page?: number;
  assetId?: string;
  token?: string;
  message?: string;
};

/** W1: `job.qualityGate: { passed, findings[] }`. The gate WARNS, never
 *  blocks (D-A) — `passed: false` is information, not a job failure. */
export type PdfQualityGate = { passed: boolean; findings: PdfQualityFinding[] };

export type ArticlePdfJobStatus = 'pending' | 'complete' | 'failed';

export type ArticlePdfJobView = {
  jobId: string;
  status: ArticlePdfJobStatus;
  /** pdf-tool's own status word, kept so a receipt never rounds it off. */
  rawStatus?: string;
  templateId?: string;
  createdAt?: string;
  /** `/pdf/{requestId}/{sha256}.pdf` — a link target (see the header). */
  publicPath?: string;
  pageCount?: number;
  /** The completed artifact's byte size, off the terminal response's
   *  `artifactReference.sizeBytes`. A number, never a key or a sha — it is what
   *  the attached download block shows, and what makes a re-render stop
   *  advertising the PREVIOUS PDF's size. */
  sizeBytes?: number;
  qualityGate?: PdfQualityGate;
  warnings?: string[];
  error?: { code?: string; message: string };
  /** D-2's mapper output, forwarded by the bridge as `renderData.unfilled`. */
  unfilled?: string[];
  /** Which contract the render data was mapped against. */
  schemaSource?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const strList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((entry): entry is string => typeof entry === 'string');
  return list.length > 0 ? list : undefined;
};

/**
 * pdf-tool's terminal statuses are exactly `complete` and `failed`; everything
 * else (`pending`, `queued`, `running`, `blocked`, and anything it grows
 * later) is still in flight. Deliberately biased toward "in flight" for an
 * UNKNOWN word: claiming completion this module cannot prove is the one
 * mistake the governing principle forbids outright.
 */
const IN_FLIGHT = new Set(['pending', 'queued', 'running', 'blocked', 'awaiting_approval']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);

export const normalizeArticlePdfJobStatus = (value: unknown): ArticlePdfJobStatus => {
  const status = str(value)?.toLowerCase();
  if (!status) return 'pending';
  if (status === 'complete' || status === 'completed' || status === 'succeeded') return 'complete';
  if (FAILED.has(status)) return 'failed';
  if (IN_FLIGHT.has(status)) return 'pending';
  return 'pending';
};

const readQualityGate = (value: unknown): PdfQualityGate | undefined => {
  if (!isRecord(value)) return undefined;
  const rawFindings = Array.isArray(value.findings) ? value.findings : [];
  const findings: PdfQualityFinding[] = [];
  for (const entry of rawFindings) {
    if (!isRecord(entry)) continue;
    const code = str(entry.code);
    if (!code) continue;
    // `detail` is pdf-tool's own field name for the finding sentence
    // (document-content-check.ts); `message` is the admin card's. Accept both,
    // emit the card's.
    const message = str(entry.message) ?? str(entry.detail);
    findings.push({
      code,
      ...(num(entry.page) !== undefined ? { page: num(entry.page) } : {}),
      ...(str(entry.assetId) ? { assetId: str(entry.assetId) } : {}),
      ...(str(entry.token) ? { token: str(entry.token) } : {}),
      ...(message ? { message: redactPdfReceiptText(message) } : {}),
    });
  }
  return { passed: value.passed !== false, findings };
};

/**
 * Reads one bridge job/status response body (the `structuredContent` of
 * `create_agent_artifact_job` / `get_agent_artifact_job_status`) into the view
 * this module reasons over. Every field is read defensively: a shape this
 * module does not recognize degrades to "still pending, nothing claimed",
 * never to a wrong claim.
 */
export const readArticlePdfJobView = (body: unknown): ArticlePdfJobView | undefined => {
  if (!isRecord(body)) return undefined;
  const jobId = str(body.jobId) ?? str(body.job_id);
  if (!jobId) return undefined;

  const rawStatus = str(body.status);
  const errorMessage = str(body.error) ?? str(isRecord(body.errorDetail) ? body.errorDetail.reason : undefined);
  const errorCode = str(body.errorCode) ?? str(body.error_code);
  const renderData = isRecord(body.renderData) ? body.renderData : undefined;
  // The bridge's terminal payload carries the verified ArtifactReference; its
  // `sizeBytes` is the only honest source for the attached node's download size.
  const artifactSizeBytes =
    num(isRecord(body.artifactReference) ? body.artifactReference.sizeBytes : undefined) ?? num(body.sizeBytes);

  return {
    jobId,
    status: normalizeArticlePdfJobStatus(rawStatus),
    ...(rawStatus ? { rawStatus } : {}),
    ...(str(body.templateId) ? { templateId: str(body.templateId) } : {}),
    ...(str(body.createdAt) ? { createdAt: str(body.createdAt) } : {}),
    ...(str(body.public_path) ?? str(body.publicPath)
      ? { publicPath: str(body.public_path) ?? str(body.publicPath) }
      : {}),
    ...(num(body.pageCount) !== undefined ? { pageCount: num(body.pageCount) } : {}),
    ...(artifactSizeBytes !== undefined ? { sizeBytes: artifactSizeBytes } : {}),
    ...(readQualityGate(body.qualityGate) ? { qualityGate: readQualityGate(body.qualityGate) } : {}),
    ...(strList(body.warnings) ? { warnings: strList(body.warnings)!.map(redactPdfReceiptText) } : {}),
    ...(errorMessage || errorCode
      ? {
          error: {
            ...(errorCode ? { code: errorCode } : {}),
            message: redactPdfReceiptText(errorMessage ?? `pdf-tool failed this job (${errorCode}).`),
          },
        }
      : {}),
    ...(strList(renderData?.unfilled) ? { unfilled: strList(renderData?.unfilled) } : {}),
    ...(str(renderData?.schemaSource) ? { schemaSource: str(renderData?.schemaSource) } : {}),
  };
};

// ─── where the PDF attaches ─────────────────────────────────────────────────

export type ArticleNodeLike = {
  id?: unknown;
  kind?: unknown;
  visibility?: unknown;
  public?: unknown;
};

/** Mirrors `object-validate.ts`'s `PDF_PUBLIC_PATH_RE` and the admin card's
 *  local copy: the ONE path shape a PDF may be attached to an article as. */
export const PDF_PUBLIC_PATH_RE = /^\/pdf\/[^/]+\/[0-9a-f]{64}\.pdf$/i;

export type ArticlePdfAttachTarget =
  | { ok: true; nodeId: string; mode: 'replace' | 'append' }
  | { ok: false; reason: 'no_attachable_node'; detail: string };

/**
 * Which node the PDF lands on. `update_node` merges into an EXISTING node —
 * this module never invents one, because minting an article node (its id, its
 * kind, its position) is an editorial decision, not a rendering one.
 *
 *  1. A node already carrying a `document` media block: the re-render case.
 *     Replacing it is what "re-render" means, and it is the node the admin
 *     PDF card's `findAttachedPdf` will find afterwards.
 *  2. Otherwise the LAST public `content` node with no media of its own — a
 *     download block belongs at the end of an article, and a node that already
 *     carries an image must not have that image silently replaced by a PDF.
 *  3. Otherwise nothing, said plainly. The PDF still exists and the receipt
 *     still names it; it is simply not on the article.
 */
export const selectArticlePdfAttachTarget = (nodes: unknown): ArticlePdfAttachTarget => {
  const list = Array.isArray(nodes) ? nodes.filter(isRecord) : [];

  for (const node of list) {
    const id = str(node.id);
    if (!id) continue;
    const pub = isRecord(node.public) ? node.public : undefined;
    const media = isRecord(pub?.media) ? pub!.media : undefined;
    if (!media) continue;
    const type = str(media.type);
    const src = str(media.src);
    if (type === 'document' || (src !== undefined && PDF_PUBLIC_PATH_RE.test(src))) {
      return { ok: true, nodeId: id, mode: 'replace' };
    }
  }

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const node = list[index]!;
    const id = str(node.id);
    if (!id) continue;
    if ((str(node.visibility) ?? 'public') !== 'public') continue;
    if ((str(node.kind) ?? 'content') !== 'content') continue;
    const pub = isRecord(node.public) ? node.public : undefined;
    if (pub && isRecord(pub.media)) continue;
    return { ok: true, nodeId: id, mode: 'append' };
  }

  return {
    ok: false,
    reason: 'no_attachable_node',
    detail:
      'This article has no public content node the PDF could attach to (every node already carries its own media). ' +
      'The PDF was rendered and is named in this receipt; attach it by hand, or add a node for it.',
  };
};

export type ArticlePdfAttachOp = {
  op: 'update_node';
  node_id: string;
  fields: Record<string, unknown>;
};

export type ArticlePdfAttachOpResult =
  | { ok: true; op: ArticlePdfAttachOp }
  | { ok: false; reason: 'media_type_refused' | 'invalid_pdf_path'; detail: string };

/**
 * Builds the `update_node` op that attaches the PDF, THROUGH
 * `normalizeArticleNodeMediaFields` (media-type.ts) — the same module the
 * patch engine runs this op through on the way in.
 *
 * The op deliberately does NOT state `type`. That is the whole discipline:
 * a PDF patched onto a node used to land as `{type:'image', src:'/pdf/…'}`
 * because the type was defaulted rather than derived, and the live page
 * rendered a broken `<img>`. Leaving it absent makes media-type.ts INFER
 * `document` from the `.pdf` src, and REFUSE anything it cannot infer — here,
 * before the write, with the refusal named in the receipt, instead of at the
 * patch endpoint as an opaque 422.
 */
export const buildArticlePdfAttachOp = (
  existingNode: Record<string, unknown>,
  publicPath: string,
  meta: { title?: string; caption?: string; sizeBytes?: number } = {}
): ArticlePdfAttachOpResult => {
  if (!PDF_PUBLIC_PATH_RE.test(publicPath)) {
    return {
      ok: false,
      reason: 'invalid_pdf_path',
      detail: 'The completed job did not return a /pdf/{requestId}/{sha256}.pdf artifact path to attach.',
    };
  }
  const nodeId = str(existingNode.id) ?? '';
  const existingPublic = isRecord(existingNode.public) ? existingNode.public : undefined;
  const existingMedia = isRecord(existingPublic?.media) ? existingPublic!.media : undefined;

  // W2 REVIEW — THE RE-RENDER TRAP. `update_node` DEEP-MERGES, so a field this
  // op does not name keeps the value the PREVIOUS render left behind. On the
  // real drlurie article the PDF lives on an `action` node whose
  // `public.ctaLink` is the download button's actual href and whose
  // `public.media.sizeBytes` is the size that button prints. A re-render that
  // only rewrote `media.src` left BOTH pointing at the old artifact: the
  // receipt said the new PDF was attached, and the live page still handed the
  // reader the old one, at a size belonging to neither.
  //
  //  - `ctaLink`: rewritten only when it currently holds a /pdf/… path (i.e. it
  //    is this attachment's own link). A ctaLink pointing anywhere else is a
  //    human's editorial choice and is left alone.
  //  - `sizeBytes`: set from the completed artifact when known, and UNSET
  //    (null — the patch engine's unset marker) when it is not, because a stale
  //    byte count is a claim about bytes nobody measured.
  const existingCtaLink = str(existingPublic?.ctaLink);
  const ctaLinkIsThisPdf = existingCtaLink !== undefined && PDF_PUBLIC_PATH_RE.test(existingCtaLink);
  const hadSizeBytes = typeof existingMedia?.sizeBytes === 'number';

  const fields: Record<string, unknown> = {
    public: {
      ...(ctaLinkIsThisPdf && existingCtaLink !== publicPath ? { ctaLink: publicPath } : {}),
      media: {
        src: publicPath,
        contentType: 'application/pdf',
        ...(meta.title ? { alt: meta.title } : {}),
        ...(meta.caption ? { caption: meta.caption } : {}),
        ...(meta.sizeBytes !== undefined && Number.isInteger(meta.sizeBytes) && meta.sizeBytes > 0
          ? { sizeBytes: meta.sizeBytes }
          : hadSizeBytes
            ? { sizeBytes: null }
            : {}),
      },
    },
  };
  try {
    normalizeArticleNodeMediaFields(existingNode, fields, 'render_article_pdf fields');
  } catch (error) {
    if (error instanceof MediaTypeError) {
      return { ok: false, reason: 'media_type_refused', detail: error.message };
    }
    throw error;
  }
  return { ok: true, op: { op: 'update_node', node_id: nodeId, fields } };
};

// ─── the receipt ────────────────────────────────────────────────────────────

export type RenderArticlePdfReceipt = {
  siteId: string;
  contentItemId: string;
  /** Always present, on every outcome — a job is never orphaned by a receipt. */
  jobId: string;
  /** 'pending' means STILL RENDERING, not "probably fine". */
  status: ArticlePdfJobStatus;
  templateId?: string;
  createdAt?: string;
  /** True only for a job pdf-tool reported `complete`. */
  rendered: boolean;
  /**
   * Where the finished PDF lives — `/pdf/{requestId}/{sha256}.pdf`, the SAME
   * `public_path` every other bridge tool returns for a completed artifact, in
   * the same snake_case field, so a caller reads it the same way here as
   * everywhere else.
   *
   * W2 REVIEW: the receipt used to name the PDF only through
   * `attachment.href`, i.e. only when it had been attached — so `attach: false`
   * (render without touching the article, which the tool explicitly offers)
   * produced a receipt that could not say what it had rendered, against this
   * module's own stated contract that the receipt is the deliverable. Present
   * whenever the job completed with an artifact, whether or not it was
   * attached; absent while pending or failed, because then there is nothing to
   * name.
   */
  public_path?: string;
  /** True only when the article was actually patched. */
  attached: boolean;
  attachment?: { nodeId: string; field: 'media'; mode: 'replace' | 'append'; href: string };
  /** Why the PDF is not on the article, when it isn't. */
  attachSkipped?: { reason: string; detail: string };
  pageCount?: number;
  /** D-A: findings are reported, never a failure. */
  qualityGate?: PdfQualityGate;
  qualityGatePassed?: boolean;
  warnings?: string[];
  /** The typed pdf-tool failure, as itself. */
  error?: { code?: string; message: string };
  /** What the mapper could not fill — stable codes, safe to show a human. */
  unfilled: string[];
  schemaSource?: string;
  /** Present while the job is still in flight, so nothing is orphaned. */
  polling?: { tool: string; input: Record<string, unknown> };
  /** One sentence a human can read without decoding the rest. */
  summary: string;
};

export type AttachOutcome =
  | { attached: true; nodeId: string; mode: 'replace' | 'append'; href: string }
  | { attached: false; reason: string; detail: string }
  | { attached: false; reason: 'not_requested' };

/**
 * D-A, stated once: does this job's outcome attach?
 *
 * ONLY a completed job with a real artifact path attaches. Quality-gate
 * findings never enter this decision — `passed: false` is a warning about a
 * PDF that exists, and an unattached warning helps nobody. A failed job
 * attaches nothing (there is no artifact), and a still-running one attaches
 * nothing yet (there is nothing to attach).
 */
export const shouldAttachArticlePdf = (job: ArticlePdfJobView, attachRequested: boolean): boolean =>
  attachRequested && job.status === 'complete' && typeof job.publicPath === 'string';

const summarize = (receipt: Omit<RenderArticlePdfReceipt, 'summary'>): string => {
  const findings = receipt.qualityGate?.findings.length ?? 0;
  const unfilled = receipt.unfilled.length;
  const gapNote = unfilled > 0 ? ` The mapper could not fill ${unfilled} slot${unfilled === 1 ? '' : 's'} — see unfilled[].` : '';

  if (receipt.status === 'failed') {
    const code = receipt.error?.code ? ` (${receipt.error.code})` : '';
    return `The render failed${code} and nothing was attached to the article. ${receipt.error?.message ?? ''}`.trim();
  }
  if (receipt.status === 'pending') {
    return (
      `Still rendering. Job ${receipt.jobId} was created and is not finished yet — nothing has been attached. ` +
      `Poll get_agent_artifact_job_status with this job id; the PDF is not lost.${gapNote}`
    );
  }
  const gate =
    findings > 0
      ? ` The content quality gate reported ${findings} finding${findings === 1 ? '' : 's'} — these WARN, they do not block, and the PDF was attached anyway.`
      : '';
  if (receipt.attached) {
    return `Rendered${receipt.pageCount ? ` (${receipt.pageCount} pages)` : ''} and attached to node ${receipt.attachment?.nodeId}.${gate}${gapNote}`;
  }
  const why = receipt.attachSkipped?.reason === 'not_requested' ? ' (attach was not requested)' : '';
  const where = receipt.public_path ? ' The PDF exists and is named in this receipt as public_path.' : '';
  return `Rendered${receipt.pageCount ? ` (${receipt.pageCount} pages)` : ''} but NOT attached to the article${why}. ${receipt.attachSkipped?.detail ?? ''}${where}${gate}${gapNote}`.trim();
};

/**
 * The receipt, decided. Pure: everything it says is read off the job view and
 * the attach outcome already in hand.
 */
export const buildRenderArticlePdfReceipt = (input: {
  siteId: string;
  contentItemId: string;
  job: ArticlePdfJobView;
  attach: AttachOutcome;
  polling?: { tool: string; input: Record<string, unknown> };
}): RenderArticlePdfReceipt => {
  const { job } = input;
  const attached = input.attach.attached;
  const base: Omit<RenderArticlePdfReceipt, 'summary'> = {
    siteId: input.siteId,
    contentItemId: input.contentItemId,
    jobId: job.jobId,
    status: job.status,
    ...(job.templateId ? { templateId: job.templateId } : {}),
    ...(job.createdAt ? { createdAt: job.createdAt } : {}),
    rendered: job.status === 'complete',
    ...(job.status === 'complete' && job.publicPath ? { public_path: job.publicPath } : {}),
    attached,
    ...(input.attach.attached
      ? {
          attachment: {
            nodeId: input.attach.nodeId,
            field: 'media' as const,
            mode: input.attach.mode,
            href: input.attach.href,
          },
        }
      : { attachSkipped: { reason: input.attach.reason, detail: 'detail' in input.attach ? input.attach.detail : '' } }),
    ...(job.pageCount !== undefined ? { pageCount: job.pageCount } : {}),
    ...(job.qualityGate ? { qualityGate: job.qualityGate, qualityGatePassed: job.qualityGate.passed } : {}),
    ...(job.warnings ? { warnings: job.warnings } : {}),
    ...(job.error ? { error: job.error } : {}),
    unfilled: job.unfilled ?? [],
    ...(job.schemaSource ? { schemaSource: job.schemaSource } : {}),
    ...(job.status === 'pending' && input.polling ? { polling: input.polling } : {}),
  };
  return { ...base, summary: summarize(base) };
};

// ─── the polling budget ─────────────────────────────────────────────────────

/** One second between polls: pdf-tool's own recommended interval for artifact
 *  jobs is 2s and the bridge already halves that on its inline fast path; a
 *  composite that is deliberately waiting can afford the tighter loop. */
export const RENDER_ARTICLE_PDF_POLL_INTERVAL_MS = 1_000;
/** The wait a caller gets when nothing constrains it. A chromium article
 *  render is typically a few seconds; 20s covers the ordinary case without
 *  pretending an invocation can wait forever. */
export const RENDER_ARTICLE_PDF_DEFAULT_BUDGET_MS = 20_000;
/** Held back from the poll budget for the attach write (checkout → patch →
 *  checkin) and response serialization, so a render that finishes on the last
 *  poll can still be ATTACHED rather than reported as an orphan. */
export const RENDER_ARTICLE_PDF_ATTACH_RESERVE_MS = 3_000;

/**
 * The poll budget, capped by the invocation's own remaining time.
 *
 * TERMINATION IS THE CONTRACT. This loop always ends: either the job reaches a
 * terminal status, or the budget runs out and the receipt says `pending` with
 * the job id and polling instructions. It never hangs, and it never claims a
 * result it does not have — pdf-tool additionally auto-fails any job still
 * running after ~12 minutes, so a job left to a later poll always reaches a
 * terminal state eventually.
 *
 * Returns 0 when there is no room to poll at all (a nearly-expired
 * invocation): the job is still created, and the receipt is the pending one.
 */
export const resolveRenderArticlePdfPollBudgetMs = (
  invocationDeadlineMs: number | undefined,
  nowMs: number = Date.now(),
  env: Record<string, string | undefined> = {}
): number => {
  const override = Number(env.PDF_RENDER_ARTICLE_WAIT_MS);
  const requested =
    env.PDF_RENDER_ARTICLE_WAIT_MS !== undefined && Number.isFinite(override) && override >= 0
      ? override
      : RENDER_ARTICLE_PDF_DEFAULT_BUDGET_MS;
  if (invocationDeadlineMs === undefined) return requested;
  const remaining = invocationDeadlineMs - nowMs - RENDER_ARTICLE_PDF_ATTACH_RESERVE_MS;
  return Math.max(0, Math.min(requested, remaining));
};

// ─── the orchestrator ───────────────────────────────────────────────────────

export type RenderArticlePdfEffectResult<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message: string } };

export type RenderArticlePdfEffects = {
  /** Creates the job (the bridge's own D-1..D-4 defaults + D-2 mapper run). */
  createJob: () => Promise<RenderArticlePdfEffectResult<ArticlePdfJobView>>;
  /** One status poll. A transient failure is reported, not thrown. */
  pollJob: (jobId: string) => Promise<RenderArticlePdfEffectResult<ArticlePdfJobView>>;
  /** The article's current nodes, read once, only when an attach is possible. */
  readArticleNodes: () => Promise<RenderArticlePdfEffectResult<ArticleNodeLike[]>>;
  /** Applies the update_node op. */
  applyAttach: (op: ArticlePdfAttachOp) => Promise<RenderArticlePdfEffectResult<true>>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log?: (entry: Record<string, unknown>) => void;
};

export type RenderArticlePdfParams = {
  siteId: string;
  contentItemId: string;
  attach: boolean;
  pollBudgetMs: number;
  pollIntervalMs?: number;
  /** Copy for the attached node's alt text — the article's own title. */
  articleTitle?: string;
  polling?: { tool: string; input: Record<string, unknown> };
};

export type RenderArticlePdfOutcome =
  | { ok: true; receipt: RenderArticlePdfReceipt }
  /** The job could never be created — there is no job id, so there is no
   *  receipt to give: the caller surfaces this as a tool error instead. */
  | { ok: false; error: { code?: string; message: string } };

export const renderArticlePdf = async (
  params: RenderArticlePdfParams,
  effects: RenderArticlePdfEffects
): Promise<RenderArticlePdfOutcome> => {
  const created = await effects.createJob();
  if (!created.ok) return { ok: false, error: created.error };

  let job = created.value;
  const interval = params.pollIntervalMs ?? RENDER_ARTICLE_PDF_POLL_INTERVAL_MS;
  const deadline = effects.now() + params.pollBudgetMs;

  // Poll to a terminal status, or to the budget. Both terminate.
  while (job.status === 'pending' && effects.now() < deadline) {
    const remaining = deadline - effects.now();
    await effects.sleep(Math.min(interval, remaining));
    const polled = await effects.pollJob(job.jobId);
    if (!polled.ok) {
      // A transient status hiccup must not lose the job. Keep the last view we
      // had (which carries the job id) and keep polling until the budget ends.
      effects.log?.({ event: 'render_article_pdf_poll_failed', jobId: job.jobId, detail: polled.error.message });
      continue;
    }
    // The poll response is the newer truth, but it does NOT carry the create
    // call's renderData/unfilled — keep those.
    job = {
      ...polled.value,
      ...(polled.value.unfilled === undefined && job.unfilled ? { unfilled: job.unfilled } : {}),
      ...(polled.value.schemaSource === undefined && job.schemaSource ? { schemaSource: job.schemaSource } : {}),
      ...(polled.value.templateId === undefined && job.templateId ? { templateId: job.templateId } : {}),
    };
  }

  const attachOutcome = await resolveAttach(params, job, effects);
  effects.log?.({
    event: 'render_article_pdf_settled',
    jobId: job.jobId,
    status: job.status,
    attached: attachOutcome.attached,
    findings: job.qualityGate?.findings.length ?? 0,
    unfilled: job.unfilled?.length ?? 0,
  });
  return {
    ok: true,
    receipt: buildRenderArticlePdfReceipt({
      siteId: params.siteId,
      contentItemId: params.contentItemId,
      job,
      attach: attachOutcome,
      ...(params.polling ? { polling: params.polling } : {}),
    }),
  };
};

const resolveAttach = async (
  params: RenderArticlePdfParams,
  job: ArticlePdfJobView,
  effects: RenderArticlePdfEffects
): Promise<AttachOutcome> => {
  if (!params.attach) return { attached: false, reason: 'not_requested' };
  if (job.status === 'failed') {
    return {
      attached: false,
      reason: 'render_failed',
      detail: 'The render failed, so there is no PDF to attach.',
    };
  }
  if (job.status === 'pending') {
    return {
      attached: false,
      reason: 'still_rendering',
      detail: 'The job had not finished inside this call, so nothing was attached yet.',
    };
  }
  if (!shouldAttachArticlePdf(job, true)) {
    return {
      attached: false,
      reason: 'no_artifact_path',
      detail: 'The completed job returned no public PDF path to attach.',
    };
  }

  const nodes = await effects.readArticleNodes();
  if (!nodes.ok) {
    return { attached: false, reason: 'article_unreadable', detail: nodes.error.message };
  }
  const target = selectArticlePdfAttachTarget(nodes.value);
  if (!target.ok) return { attached: false, reason: target.reason, detail: target.detail };

  const node = nodes.value.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.id === target.nodeId);
  if (!node) {
    return { attached: false, reason: 'node_missing', detail: `Node ${target.nodeId} vanished between read and write.` };
  }
  const op = buildArticlePdfAttachOp(node, job.publicPath!, {
    ...(params.articleTitle ? { title: params.articleTitle } : {}),
    ...(job.sizeBytes !== undefined ? { sizeBytes: job.sizeBytes } : {}),
  });
  if (!op.ok) return { attached: false, reason: op.reason, detail: op.detail };

  const applied = await effects.applyAttach(op.op);
  if (!applied.ok) {
    return { attached: false, reason: 'attach_refused', detail: redactPdfReceiptText(applied.error.message) };
  }
  return { attached: true, nodeId: target.nodeId, mode: target.mode, href: job.publicPath! };
};
