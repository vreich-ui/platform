/**
 * A6 — the example-generation JOB RECORD, and the one trigger both surfaces use.
 *
 * WHY THIS EXISTS. X1 wired example generation INLINE into `callObjectAction`
 * (mcp-tool-handlers.ts): the MCP verb dispatch waited ~10s for flux, dropped
 * whatever had not finished ("partial failure is never an error"), and told
 * nobody. A human clicking "Regenerate examples" therefore saw silence, and a
 * human's own browser writes (`admin-object.ts`) never triggered the generator
 * at all — the surface the affordance actually lives on was the one surface
 * with no trigger. Both defects have the same fix: the trigger writes a JOB
 * RECORD and hands the work to a background function
 * (`visual-standard-examples-background`), which has the budget flux needs and
 * writes its result back onto the record. The record is the thing a UI can
 * poll (A7), and the thing that makes a failure sayable.
 *
 * WHERE IT LIVES. The artifact-index blob store — the store that already holds
 * every by-request/by-kind pointer for exactly these generated images, and the
 * one store BOTH trigger surfaces already open (`getArtifactIndexBlobStore`).
 * One record per standard, at `visual-standard-examples/<id>.json`: a standard
 * has at most one generation in flight, and the newest round is the only one
 * anybody wants to look at.
 *
 * PER-CONTEXT STATUS. `examples_status` is the whole job; `contexts[]` carries
 * one row per usage context, whose status is `pending`, `ready`, or
 * `failed:<reason>`. A single context failing is NEVER a failed job — it is a
 * `partial`, with that one context saying why. That is the entire difference
 * between this and X1's silent `mergeExampleResults` drop.
 *
 * AUTHORIZATION. A background function is a PUBLIC HTTP endpoint and this one
 * spends real money on image jobs, so the trigger mints a one-shot token into
 * the record and the worker consumes it on start — the same mechanic the
 * editorial-request sweep uses (requests/store.ts `mintSweepToken`).
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

export const VISUAL_STANDARD_EXAMPLES_JOB_SCHEMA_VERSION = 'visual-standard-examples-job.v1';

/** The background worker's public path — the one string both trigger sites POST to. */
export const VISUAL_STANDARD_EXAMPLES_BACKGROUND_PATH = '/.netlify/functions/visual-standard-examples-background';

/** The job as a whole. `partial` is a real, reportable outcome, not a failure. */
export const examplesJobStatusSchema = z.enum(['pending', 'partial', 'ready', 'failed']);
export type ExamplesJobStatus = z.infer<typeof examplesJobStatusSchema>;

/** Which surface asked. Kept on the record because "the browser never triggered
 *  this" was the defect — an operator must be able to SEE that it does now. */
export const examplesJobTriggerSchema = z.enum(['mcp', 'browser']);
export type ExamplesJobTrigger = z.infer<typeof examplesJobTriggerSchema>;

/** `failed:<reason>` is part of the contract A7 renders — a bare `failed` is not. */
const CONTEXT_STATUS_RE = /^(pending|ready|failed:[a-z0-9_]{1,60})$/;
export const examplesJobContextSchema = z
  .object({
    usageContext: z.string().min(1).max(80),
    status: z.string().regex(CONTEXT_STATUS_RE),
    blobKey: z.string().min(1).max(500).optional(),
  })
  .strict();
export type ExamplesJobContext = z.infer<typeof examplesJobContextSchema>;

export const visualStandardExamplesJobSchema = z
  .object({
    schema_version: z.literal(VISUAL_STANDARD_EXAMPLES_JOB_SCHEMA_VERSION),
    visual_standard_id: z.string().min(1),
    site_id: z.string().min(1).optional(),
    examples_status: examplesJobStatusSchema,
    contexts: z.array(examplesJobContextSchema).max(24),
    trigger: examplesJobTriggerSchema,
    /** Why the job as a whole ended where it did, when the contexts do not say
     *  it on their own (`hash_unchanged`, `no_sample_subjects`, `not_dispatched`). */
    reason: z.string().max(120).optional(),
    /** Present only while unclaimed: consumed by the worker on start. */
    trigger_token: z.string().min(1).optional(),
    /** False when the worker could not be reached at all — the job is pending
     *  and nothing is coming, which a UI must be able to say out loud. */
    dispatched: z.boolean().optional(),
    started_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();
export type VisualStandardExamplesJob = z.infer<typeof visualStandardExamplesJobSchema>;

/** The blob-store surface this module needs — the artifact-index store satisfies it. */
export type ExamplesJobStore = {
  get: (key: string) => Promise<string | null>;
  setJSON: (key: string, value: unknown, options?: { metadata?: Record<string, string> }) => Promise<unknown>;
};

export const visualStandardExamplesJobKey = (visualStandardId: string): string =>
  `visual-standard-examples/${encodeURIComponent(visualStandardId)}.json`;

/** A `failed:<reason>` context status, with the reason machine-shaped so the
 *  string stays parseable no matter what an upstream error message looked like. */
export const contextFailure = (reason: string): string => {
  const slug =
    reason
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'unknown';
  return `failed:${slug}`;
};

export const isContextFailure = (status: string): boolean => status.startsWith('failed:');

/**
 * The job status implied by its contexts: every one ready is `ready`, none
 * ready is `failed`, anything in between is `partial` — "a single context
 * failing must be visible without failing the whole job."
 */
export const deriveExamplesStatus = (contexts: readonly ExamplesJobContext[]): ExamplesJobStatus => {
  if (contexts.length === 0) return 'failed';
  if (contexts.some((context) => context.status === 'pending')) return 'pending';
  const ready = contexts.filter((context) => context.status === 'ready').length;
  if (ready === contexts.length) return 'ready';
  if (ready === 0) return 'failed';
  return 'partial';
};

export const readExamplesJob = async (
  store: ExamplesJobStore,
  visualStandardId: string
): Promise<VisualStandardExamplesJob | undefined> => {
  const raw = await store.get(visualStandardExamplesJobKey(visualStandardId)).catch(() => null);
  if (!raw) return undefined;
  try {
    const parsed = visualStandardExamplesJobSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export const writeExamplesJob = async (store: ExamplesJobStore, job: VisualStandardExamplesJob): Promise<void> => {
  await store.setJSON(visualStandardExamplesJobKey(job.visual_standard_id), job, {
    metadata: { visualStandardId: job.visual_standard_id, examplesStatus: job.examples_status },
  });
};

/** Opens a round: status `pending`, a fresh one-shot token, contexts not yet known
 *  (the worker plans them — only it has read the standard's sampleSubjects). */
export const startExamplesJob = async (
  store: ExamplesJobStore,
  input: { visualStandardId: string; siteId?: string; trigger: ExamplesJobTrigger; nowMs: number; token?: string }
): Promise<VisualStandardExamplesJob> => {
  const iso = new Date(input.nowMs).toISOString();
  const job: VisualStandardExamplesJob = {
    schema_version: VISUAL_STANDARD_EXAMPLES_JOB_SCHEMA_VERSION,
    visual_standard_id: input.visualStandardId,
    ...(input.siteId ? { site_id: input.siteId } : {}),
    examples_status: 'pending',
    contexts: [],
    trigger: input.trigger,
    trigger_token: input.token ?? randomUUID(),
    started_at: iso,
    updated_at: iso,
  };
  await writeExamplesJob(store, job);
  return job;
};

/** One-shot: the token is cleared as it is spent, so a replayed POST to the
 *  public background endpoint cannot buy a second round of image jobs. */
export const consumeExamplesJobToken = async (
  store: ExamplesJobStore,
  visualStandardId: string,
  token: string
): Promise<VisualStandardExamplesJob | undefined> => {
  const job = await readExamplesJob(store, visualStandardId);
  if (!job || !job.trigger_token || job.trigger_token !== token) return undefined;
  const claimed: VisualStandardExamplesJob = { ...job };
  delete claimed.trigger_token;
  await writeExamplesJob(store, claimed);
  return claimed;
};

/** Closes a round. The worker owns the status it reports (a skip is `ready`
 *  with a reason, not a lie about generated images). */
export const finishExamplesJob = async (
  store: ExamplesJobStore,
  visualStandardId: string,
  outcome: { status: ExamplesJobStatus; contexts: ExamplesJobContext[]; reason?: string; nowMs: number }
): Promise<VisualStandardExamplesJob | undefined> => {
  const job = await readExamplesJob(store, visualStandardId);
  if (!job) return undefined;
  const next: VisualStandardExamplesJob = {
    ...job,
    examples_status: outcome.status,
    contexts: outcome.contexts,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    updated_at: new Date(outcome.nowMs).toISOString(),
  };
  // The finished round owns the reason, so a trigger-time one (`not_dispatched`)
  // must not survive onto a job that plainly did run.
  if (!outcome.reason) delete next.reason;
  delete next.trigger_token;
  await writeExamplesJob(store, next);
  return next;
};

/** The poll-facing projection (A7 reads this; the token never leaves the server). */
export type ExamplesJobStatusView = {
  examples_status: ExamplesJobStatus;
  contexts: ExamplesJobContext[];
  trigger: ExamplesJobTrigger;
  reason?: string;
  dispatched?: boolean;
  started_at: string;
  updated_at: string;
};

export const examplesJobStatusView = (job: VisualStandardExamplesJob): ExamplesJobStatusView => ({
  examples_status: job.examples_status,
  contexts: job.contexts,
  trigger: job.trigger,
  ...(job.reason ? { reason: job.reason } : {}),
  ...(job.dispatched === undefined ? {} : { dispatched: job.dispatched }),
  started_at: job.started_at,
  updated_at: job.updated_at,
});

// ─── which writes are a trigger ──────────────────────────────────────────────

/** The same three object actions X1 hooked — create, patch, and a REAL
 *  `apply_brand_imagery` — resolved from the RESULT the verb core actually
 *  produced, never re-derived from the caller's own input. Shared verbatim by
 *  both surfaces so they can never drift again. */
export const VISUAL_STANDARD_EXAMPLE_TRIGGER_ACTIONS = ['create', 'patch', 'apply_brand_imagery'] as const;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const asId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

export const resolveExamplesTriggerTarget = (
  payload: Record<string, unknown>,
  result: Record<string, unknown>
): string | undefined => {
  const action = asId(payload.action);
  if (!action || !(VISUAL_STANDARD_EXAMPLE_TRIGGER_ACTIONS as readonly string[]).includes(action)) return undefined;

  if (action === 'create') {
    if (asId(payload.object_type) !== 'visual_standard') return undefined;
    return asId(asRecord(result.record)?.object_id);
  }
  if (action === 'patch') {
    if (asId(payload.object_type) !== 'visual_standard') return undefined;
    return asId(payload.object_id);
  }
  // apply_brand_imagery: a dry run writes nothing, and a theme_id apply has no
  // standard to attach examples to.
  if (result.dry_run === true) return undefined;
  const source = asRecord(result.applied_brand_imagery_source);
  if (asId(source?.kind) !== 'visual_standard') return undefined;
  return asId(source?.id);
};

// ─── the trigger ─────────────────────────────────────────────────────────────

/** Fire-and-forget POST to the background worker. Injectable so a test never
 *  needs a listening socket, and so a missing `URL` (local/dev) is a recorded
 *  `dispatched: false` rather than a crash. */
export type ExamplesJobDispatch = (input: { visualStandardId: string; token: string }) => Promise<boolean>;

export const fetchExamplesJobDispatch: ExamplesJobDispatch = async ({ visualStandardId, token }) => {
  const base = process.env.URL;
  if (!base) return false;
  try {
    await fetch(`${base}${VISUAL_STANDARD_EXAMPLES_BACKGROUND_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visual_standard_id: visualStandardId, trigger_token: token }),
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * The ONE call both surfaces make after a successful visual_standard write.
 * Never throws: a successful object write must not become a failed one because
 * the examples side effect could not be started.
 */
export const triggerVisualStandardExamplesJob = async (
  store: ExamplesJobStore,
  input: {
    visualStandardId: string;
    trigger: ExamplesJobTrigger;
    siteId?: string;
    nowMs?: number;
    dispatch?: ExamplesJobDispatch;
    log?: (entry: { event: string; [key: string]: unknown }) => void;
  }
): Promise<VisualStandardExamplesJob | undefined> => {
  const nowMs = input.nowMs ?? Date.now();
  try {
    const job = await startExamplesJob(store, {
      visualStandardId: input.visualStandardId,
      ...(input.siteId ? { siteId: input.siteId } : {}),
      trigger: input.trigger,
      nowMs,
    });
    const dispatch = input.dispatch ?? fetchExamplesJobDispatch;
    const dispatched = await dispatch({ visualStandardId: input.visualStandardId, token: job.trigger_token! });
    const recorded: VisualStandardExamplesJob = {
      ...job,
      dispatched,
      ...(dispatched ? {} : { reason: 'not_dispatched' }),
    };
    await writeExamplesJob(store, recorded);
    input.log?.({
      event: 'visual_standard_examples_job_triggered',
      visualStandardId: input.visualStandardId,
      trigger: input.trigger,
      dispatched,
    });
    return recorded;
  } catch (error) {
    input.log?.({
      event: 'visual_standard_examples_job_trigger_failed',
      visualStandardId: input.visualStandardId,
      trigger: input.trigger,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
};
