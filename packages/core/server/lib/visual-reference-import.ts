/**
 * A1 — importing mood-board reference images deterministically.
 *
 * WHY THIS EXISTS. The admin's "Visual identity → Imagery → Import
 * references" button used to build a CHAT INSTRUCTION: the agent had to
 * invent an `import_images_from_url` request id and mint `ref_` ids for the
 * mood board itself, and it got them wrong often enough that the patch simply
 * failed. Everything in this module is the deterministic half of that fix —
 * the id, the pdf-tool call, and the byte mirror — with no model in the loop.
 *
 * THE MIRROR (the chosen ruling, not a proxy). pdf-tool imports through the
 * artifact bridge and leaves the bytes under ITS OWN key shape. Platform's
 * `admin-get-blob-image` only serves keys matching
 * `image/<requestId>/<sha256>[.ext]` out of the `artifacts` store
 * (admin-get-blob-image.ts's `allowedImageBlobKeyPattern`), so an imported
 * reference card rendered "Preview unavailable" forever. This module re-saves
 * the SAME bytes through `saveArtifactBytes` under a request id Platform
 * minted, which produces a canonical key and writes the artifact indexes
 * (`writeArtifactReferenceIndexes`, inside saveArtifactBytes — one write
 * path, never a second hand-rolled one). Images are already bounded to
 * ≤2048px on import (#77), so nothing is resized here.
 *
 * THE ID. `req_visref_<site>_<yyyymmdd>_<nn>` — the repo's
 * `req_<flow>_<topic>_<yyyymmdd>_<nn>` shape (agents-naming.ts REQUEST_ID_RE)
 * with flow `visref` and the site short id as the topic. `nn` is the first
 * free sequence for that site+day, probed against the artifact index the
 * mirror itself writes, exactly as `mintWorkspaceRequestId` probes the object
 * store for `req_agent_*`.
 */
import { listArtifactReferencesForRequest, type ArtifactIndexStore } from './artifact-index.js';
import { saveArtifactBytes } from './artifact-upload.js';
import { getArtifactBlobStore, getArtifactIndexBlobStore } from './blob-store.js';
import { sha256Hex } from './crypto.js';
// LOAD ORDER, not decoration: mcp.ts and mcp-tool-handlers.ts are a module
// CYCLE, and mcp.ts reads the handlers' exports at MODULE scope
// (`_mcpInternal`). Whichever module enters the cycle first must therefore be
// mcp.ts — entering through mcp-tool-handlers throws "Cannot access
// 'resolveArtifactJobInlineWaitBudgetMs' before initialization" at import
// time. `agent/context.ts` pins the same order for the same reason (its
// comment above the mcp.js import); this file is the second reader of those
// call* handlers from outside the MCP entry point.
import '../functions/mcp.js';
import type { LambdaEvent } from '../functions/mcp.js';
import { callGetImageSearchBank, callGetImageSearchJobStatus, callImportImagesFromUrl } from './mcp-tool-handlers.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const positiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

// ─── the deterministic request id ───────────────────────────────────────────

export const VISUAL_REFERENCE_REQUEST_FLOW = 'visref';

/** UTC `yyyymmdd`, the same derivation the content_item minters use. */
export const visualReferenceDay = (now: Date = new Date()): string =>
  `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;

export const visualReferenceRequestId = (siteShortId: string, day: string, sequence: number): string =>
  `req_${VISUAL_REFERENCE_REQUEST_FLOW}_${siteShortId}_${day}_${String(sequence).padStart(2, '0')}`;

/**
 * The first sequence of the day nothing has been mirrored under yet. Pure but
 * for the `isTaken` probe, so a test can assert the sequence rule without a
 * blob store.
 */
export const mintVisualReferenceRequestId = async (input: {
  siteShortId: string;
  isTaken: (requestId: string) => Promise<boolean>;
  now?: Date;
}): Promise<string> => {
  const day = visualReferenceDay(input.now ?? new Date());
  for (let sequence = 1; sequence <= 99; sequence += 1) {
    const candidate = visualReferenceRequestId(input.siteShortId, day, sequence);
    if (!(await input.isTaken(candidate))) return candidate;
  }
  throw new Error(`Every reference-import id for ${input.siteShortId} on ${day} is already used (01..99).`);
};

/** The store-backed probe: an id is taken once anything is indexed under it. */
export const mintVisualReferenceRequestIdForEvent = async (
  event: unknown,
  siteShortId: string,
  now: Date = new Date()
): Promise<string> => {
  const indexStore = (await getArtifactIndexBlobStore(event)) as unknown as ArtifactIndexStore;
  return mintVisualReferenceRequestId({
    siteShortId,
    now,
    isTaken: async (requestId) => (await listArtifactReferencesForRequest(indexStore, requestId)).length > 0,
  });
};

// ─── reading what pdf-tool imported ─────────────────────────────────────────

export type ImportedCandidate = {
  blobKey: string;
  sha256?: string;
  sizeBytes?: number;
  contentType?: string;
  filename?: string;
  candidateId?: string;
  sourceUrl?: string;
};

const CANDIDATE_LIST_KEYS = ['candidates', 'imported', 'images', 'results', 'artifacts', 'items'];
const REFERENCE_KEYS = ['artifactReference', 'artifact', 'reference'];
const SOURCE_URL_KEYS = ['sourceUrl', 'url', 'requestedUrl', 'originUrl'];

const readCandidate = (raw: unknown): ImportedCandidate | undefined => {
  if (!isRecord(raw)) return undefined;
  const reference = REFERENCE_KEYS.map((key) => raw[key]).find(isRecord) ?? raw;
  const blobKey = text(reference.blobKey);
  if (!blobKey) return undefined;
  const source = SOURCE_URL_KEYS.map((key) => text(raw[key]) ?? text(reference[key])).find(Boolean);
  return {
    blobKey,
    ...(text(reference.sha256) ? { sha256: text(reference.sha256)?.toLowerCase() } : {}),
    ...(positiveInt(reference.sizeBytes) !== undefined ? { sizeBytes: positiveInt(reference.sizeBytes) } : {}),
    ...(text(reference.contentType) ? { contentType: text(reference.contentType) } : {}),
    ...((text(reference.originalFilename) ?? text(reference.filename))
      ? { filename: text(reference.originalFilename) ?? text(reference.filename) }
      : {}),
    ...(text(raw.candidateId) ? { candidateId: text(raw.candidateId) } : {}),
    ...(source ? { sourceUrl: source } : {}),
  };
};

/**
 * pdf-tool answers the import batch with job metadata and the imported
 * candidates come back out of the image-search bank — but a fast import can
 * also carry them inline on the job response. Rather than pin one shape, this
 * collects every candidate-looking entry from any of the payloads it is
 * handed, deduped by blobKey and in first-seen order.
 */
export const collectImportedCandidates = (payloads: readonly unknown[]): ImportedCandidate[] => {
  const found = new Map<string, ImportedCandidate>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 3 || !isRecord(value)) return;
    const single = readCandidate(value);
    if (single && !found.has(single.blobKey)) found.set(single.blobKey, single);
    for (const key of CANDIDATE_LIST_KEYS) {
      const list = value[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const candidate = readCandidate(entry);
        if (candidate && !found.has(candidate.blobKey)) found.set(candidate.blobKey, candidate);
      }
    }
    for (const nested of Object.values(value)) {
      if (isRecord(nested)) visit(nested, depth + 1);
    }
  };
  for (const payload of payloads) visit(payload, 0);
  return [...found.values()];
};

const TERMINAL_OK = new Set(['complete', 'completed', 'done', 'succeeded', 'success', 'ready']);
const TERMINAL_FAILED = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled']);

export const importJobState = (status: unknown): 'ok' | 'failed' | 'pending' => {
  const value = text(status)?.toLowerCase();
  if (!value) return 'pending';
  if (TERMINAL_OK.has(value)) return 'ok';
  if (TERMINAL_FAILED.has(value)) return 'failed';
  return 'pending';
};

// ─── the byte mirror ────────────────────────────────────────────────────────

type BinaryReadableStore = {
  get: (key: string, options: { type: 'arrayBuffer' }) => Promise<ArrayBuffer | Buffer | string | null>;
};

export const readBlobBytes = async (store: unknown, key: string): Promise<Buffer | undefined> => {
  try {
    const value = await (store as BinaryReadableStore).get(key, { type: 'arrayBuffer' });
    if (value === null || value === undefined) return undefined;
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === 'string') return Buffer.from(value, 'utf8');
    return Buffer.from(value);
  } catch {
    return undefined;
  }
};

const IMAGE_SIGNATURES: Array<{ contentType: string; extension: string; matches: (bytes: Buffer) => boolean }> = [
  {
    contentType: 'image/png',
    extension: 'png',
    matches: (bytes) => bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
  },
  {
    contentType: 'image/jpeg',
    extension: 'jpg',
    matches: (bytes) => bytes.subarray(0, 3).toString('hex') === 'ffd8ff',
  },
  {
    contentType: 'image/webp',
    extension: 'webp',
    matches: (bytes) =>
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  { contentType: 'image/gif', extension: 'gif', matches: (bytes) => bytes.subarray(0, 3).toString('ascii') === 'GIF' },
];

/**
 * The stored content type has to match what the bytes actually decode to —
 * `saveArtifactBytes` re-validates them with sharp and refuses a mismatch —
 * so the bytes themselves are the authority here, and pdf-tool's declared
 * type is only the fallback for a format this sniffer does not know.
 */
export const sniffImageBytes = (bytes: Buffer): { contentType: string; extension: string } | undefined =>
  IMAGE_SIGNATURES.find((signature) => signature.matches(bytes));

export type MirroredReference = {
  blobKey: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  sourceBlobKey: string;
  sourceUrl?: string;
  /** True when these exact bytes were already on the board under `blobKey`. */
  alreadyStored?: boolean;
};

export type MirrorOutcome = { ok: true; reference: MirroredReference } | { ok: false; error: string };

/**
 * Copy one imported image into Platform's own `artifacts` store under
 * `requestId`. Never trusts the caller's sha/size: both are recomputed from
 * the bytes, and a reference that declares a digest gets it checked.
 */
export const mirrorImportedImage = async (
  event: unknown,
  input: {
    requestId: string;
    candidate: ImportedCandidate;
    note?: string;
    /**
     * sha256 → blobKey for images the board ALREADY carries. Re-importing the
     * same address must resolve to the SAME blobKey (and therefore the same
     * reference), not a second copy under this import's request id — the
     * canonical key embeds the request id, so identity has to come from the
     * bytes.
     */
    existingBySha?: ReadonlyMap<string, string>;
  }
): Promise<MirrorOutcome> => {
  const { candidate } = input;
  const artifactStore = await getArtifactBlobStore(event);
  const bytes = await readBlobBytes(artifactStore, candidate.blobKey);
  if (!bytes || bytes.byteLength === 0) {
    return {
      ok: false,
      error: `The import wrote no readable bytes for ${candidate.sourceUrl ?? candidate.blobKey}, so it cannot be added to the mood board.`,
    };
  }

  const sha256 = sha256Hex(bytes);
  if (candidate.sha256 && candidate.sha256 !== sha256) {
    return {
      ok: false,
      error: `The imported bytes for ${candidate.sourceUrl ?? candidate.blobKey} do not match their checksum.`,
    };
  }

  const alreadyStored = input.existingBySha?.get(sha256);
  if (alreadyStored) {
    return {
      ok: true,
      reference: {
        blobKey: alreadyStored,
        sha256,
        sizeBytes: bytes.byteLength,
        contentType: candidate.contentType ?? sniffImageBytes(bytes)?.contentType ?? 'image/png',
        sourceBlobKey: candidate.blobKey,
        alreadyStored: true,
        ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
      },
    };
  }

  const sniffed = sniffImageBytes(bytes);
  const contentType = sniffed?.contentType ?? candidate.contentType ?? 'image/png';
  const extension = sniffed?.extension ?? contentType.split('/').pop() ?? 'png';
  const saved = await saveArtifactBytes({
    requestId: input.requestId,
    artifactKind: 'image',
    contentType,
    filename: `visual-reference-${sha256.slice(0, 8)}.${extension}`,
    label: input.note ?? 'Mood board reference',
    tags: ['visual-standard-reference'],
    expectedSizeBytes: bytes.byteLength,
    expectedSha256: sha256,
    bytes,
    metadata: {
      importedFrom: candidate.blobKey,
      ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
      ...(candidate.candidateId ? { candidateId: candidate.candidateId } : {}),
    },
    event,
  });
  if (!saved.ok) return { ok: false, error: saved.error };

  return {
    ok: true,
    reference: {
      blobKey: saved.artifact.blobKey,
      sha256: saved.artifact.sha256,
      sizeBytes: saved.artifact.sizeBytes,
      contentType: saved.artifact.contentType,
      sourceBlobKey: candidate.blobKey,
      ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
    },
  };
};

// ─── the whole import ───────────────────────────────────────────────────────

export type ImportImagesResult =
  | { ok: true; jobId?: string; mirrored: MirroredReference[]; failures: Array<{ source: string; error: string }> }
  | { ok: false; statusCode: number; error: string };

export type ImportImagesOptions = {
  /** Bounded so an import can never outlive the function invocation. */
  pollAttempts?: number;
  pollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const toolFailure = (result: unknown, fallback: string): { ok: false; statusCode: number; error: string } => {
  const structured = isRecord(result) ? (result as { structuredContent?: unknown }).structuredContent : undefined;
  const body = isRecord(structured) ? structured : {};
  return {
    ok: false,
    statusCode: positiveInt(body.statusCode) ?? 502,
    error: text(body.error) ?? fallback,
  };
};

const structuredOf = (result: unknown): Record<string, unknown> => {
  const structured = isRecord(result) ? (result as { structuredContent?: unknown }).structuredContent : undefined;
  return isRecord(structured) ? structured : {};
};

/**
 * Run the batch import through the SAME server handler the
 * `import_images_from_url` MCP tool dispatches to (never a second copy of its
 * logic, and never a round trip through MCP), wait for the job it starts, and
 * mirror every image it produced.
 */
export const importVisualReferenceImages = async (
  event: LambdaEvent,
  input: {
    siteId: string;
    requestId: string;
    urls: readonly string[];
    note?: string;
    existingBySha?: ReadonlyMap<string, string>;
  },
  options: ImportImagesOptions = {}
): Promise<ImportImagesResult> => {
  const pollAttempts = options.pollAttempts ?? 8;
  const pollDelayMs = options.pollDelayMs ?? 750;
  const sleep = options.sleep ?? defaultSleep;

  const started = await callImportImagesFromUrl(event, {
    site_id: input.siteId,
    request_id: input.requestId,
    urls: [...input.urls],
    ...(input.note ? { label: input.note } : {}),
  });
  if ('isError' in started) return toolFailure(started, 'The image import could not be started.');

  const startedBody = structuredOf(started);
  const jobId = text(startedBody.jobId);
  const payloads: unknown[] = [startedBody];

  if (jobId && importJobState(startedBody.status) !== 'ok') {
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      const status = await callGetImageSearchJobStatus(event, { site_id: input.siteId, job_id: jobId });
      if ('isError' in status) return toolFailure(status, 'The image import job could not be read.');
      const statusBody = structuredOf(status);
      payloads.push(statusBody);
      const state = importJobState(statusBody.status);
      if (state === 'failed') {
        return {
          ok: false,
          statusCode: 502,
          error: text(statusBody.error) ?? 'The image import job failed before any image was stored.',
        };
      }
      if (state === 'ok') break;
      if (attempt < pollAttempts - 1) await sleep(pollDelayMs);
    }
  }

  if (collectImportedCandidates(payloads).length === 0) {
    const bank = await callGetImageSearchBank(event, { site_id: input.siteId, request_id: input.requestId });
    if ('isError' in bank) return toolFailure(bank, 'The imported images could not be read back.');
    payloads.push(structuredOf(bank));
  }

  const requested = new Set(input.urls);
  const candidates = collectImportedCandidates(payloads).filter(
    (candidate) => !candidate.sourceUrl || requested.has(candidate.sourceUrl)
  );
  if (candidates.length === 0) {
    return { ok: false, statusCode: 502, error: 'The import finished without storing any image.' };
  }

  const mirrored: MirroredReference[] = [];
  const failures: Array<{ source: string; error: string }> = [];
  for (const candidate of candidates) {
    const outcome = await mirrorImportedImage(event, {
      requestId: input.requestId,
      candidate,
      ...(input.note ? { note: input.note } : {}),
      ...(input.existingBySha ? { existingBySha: input.existingBySha } : {}),
    });
    if (outcome.ok) mirrored.push(outcome.reference);
    else failures.push({ source: candidate.sourceUrl ?? candidate.blobKey, error: outcome.error });
  }

  return { ok: true, ...(jobId ? { jobId } : {}), mirrored, failures };
};
