/**
 * X1 (brand-imagery wave, BRIEF.md §3.1/R9, last/cosmetic): example images per
 * visual standard.
 *
 * On apply (an agent's `site_apply_brand_imagery`) or propose-accept (the
 * CMS-Agent `visual_standard_materializer`'s `object_create`/`object_patch`
 * of a `visual_standard` — both reach Platform through the SAME MCP surface,
 * `mcp-tool-handlers.ts`'s `callObjectAction`), and from the admin's
 * "Regenerate examples" affordance, up to 3 image jobs are created —
 * `sampleSubjects[0..2]` zipped with `EXAMPLE_USAGE_CONTEXTS` by index — each
 * carrying `style: { visualStandardId }` so `callCreateAgentArtifactJob`
 * (P4) resolves and assembles the brand-aware prompt exactly as it would for
 * any other agent-triggered image job. Results land in the standard's
 * `examples[]` (visual-standard-v1.ts), each tagged with a `contractHash` —
 * a sha256 of the standard's OWN `brandImagery` value, nothing else.
 *
 * COST CONTROL (the whole point of this module): `planExampleGeneration`
 * skips entirely whenever every existing example already carries the
 * standard's CURRENT contract hash. A patch that touches `label`,
 * `description`, `references`, or anything other than `brandImagery` never
 * changes the hash, so it never re-triggers generation — "examples must
 * never regenerate on an unrelated patch" (BRIEF). The only way to force a
 * regeneration without an actual `brandImagery` change is to clear
 * `examples` first (what the "Regenerate examples" affordance asks the
 * agent to do, via the ordinary `set_visual_standard_fields` op) — an empty
 * `examples[]` is never "up to date", so the next trigger regenerates.
 *
 * PARTIAL FAILURE IS NEVER AN ERROR: `mergeExampleResults` keeps whichever
 * jobs actually produced a blob key and silently drops the rest — a caller
 * of `generateVisualStandardExamplesWithDeps` never sees a thrown error or a
 * degraded response for this path; at worst nothing changes.
 *
 * PURE, DEPENDENCY-INJECTED. Every decision (the hash, whether to generate,
 * which jobs, the request id/filename each job gets, and how results merge
 * into the stored `examples[]`) lives here as functions that take plain data
 * in and hand plain data back — including the top-level orchestrator,
 * `generateVisualStandardExamplesWithDeps`, whose only "impure" surface is
 * the `deps` object a caller injects. Nothing in this file imports the blob
 * store, the object-store HTTP bridge, or pdf-tool-client — mcp-tool-
 * handlers.ts wires those in as `deps` and stays a thin integration layer,
 * exactly the split the repo's admin-test rule already draws for `.tsx`.
 */
import { createHash } from 'node:crypto';

/** Order-insensitive canonical JSON, so key order in a stored body never
 * changes the hash (mirrors visual-identity-imagery.ts's `stableJson` —
 * duplicated rather than imported, since that file lives under
 * `packages/core/lib/admin` and this one is a `server/lib` leaf module that
 * must not reach into the admin tree). */
const stableJson = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const bag = value as Record<string, unknown>;
    return `{${Object.keys(bag)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(bag[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/** The three usage contexts examples are generated for, in the fixed order
 * `sampleSubjects[]` is zipped against (BRIEF: "sampleSubjects[0..2] × the
 * usage contexts article_header, article_body, category_page"). */
export const EXAMPLE_USAGE_CONTEXTS = ['article_header', 'article_body', 'category_page'] as const;
export type ExampleUsageContext = (typeof EXAMPLE_USAGE_CONTEXTS)[number];

/** Mirrors visual-standard-v1.ts's `visualStandardExampleSchema`. */
export type VisualStandardExampleRecord = { usageContext: string; blobKey: string; contractHash: string };

export type ExampleGenerationJob = { usageContext: ExampleUsageContext; sampleSubject: string };

export type ExampleGenerationPlan =
  | { shouldGenerate: false; contractHash: string; reason: 'hash_unchanged' | 'no_sample_subjects' }
  | { shouldGenerate: true; contractHash: string; jobs: ExampleGenerationJob[] };

/** A sha256 of the standard's `brandImagery` value alone — never the whole
 * body, so a patch to any other field (label, whenToUse, references, status,
 * ...) can never change it. */
export const computeBrandImageryContractHash = (brandImagery: unknown): string =>
  createHash('sha256').update(stableJson(brandImagery ?? null)).digest('hex');

/**
 * The cost-control decision (BRIEF: "Skip entirely when the hash is
 * unchanged"). "Up to date" means every stored example already carries the
 * CURRENT hash — a standard with 2/3 examples from a prior partial failure,
 * at the SAME hash, is treated as up to date (no silent backfill on an
 * unrelated trigger; see the module doc comment for how to force one). Any
 * mismatch, or no examples at all, means (re)generate — zipping
 * `sampleSubjects[0..min(3,len)]` against `EXAMPLE_USAGE_CONTEXTS` by index,
 * so a standard with fewer than 3 sample subjects plans only that many jobs.
 */
export const planExampleGeneration = (input: {
  sampleSubjects: readonly unknown[] | undefined;
  brandImagery: unknown;
  examples?: readonly VisualStandardExampleRecord[] | undefined;
}): ExampleGenerationPlan => {
  const contractHash = computeBrandImageryContractHash(input.brandImagery);
  const subjects = (input.sampleSubjects ?? []).filter(
    (subject): subject is string => typeof subject === 'string' && subject.trim().length > 0
  );
  if (subjects.length === 0) return { shouldGenerate: false, contractHash, reason: 'no_sample_subjects' };

  const existing = input.examples ?? [];
  const upToDate = existing.length > 0 && existing.every((example) => example.contractHash === contractHash);
  if (upToDate) return { shouldGenerate: false, contractHash, reason: 'hash_unchanged' };

  const jobCount = Math.min(EXAMPLE_USAGE_CONTEXTS.length, subjects.length);
  const jobs: ExampleGenerationJob[] = EXAMPLE_USAGE_CONTEXTS.slice(0, jobCount).map((usageContext, index) => ({
    usageContext,
    sampleSubject: subjects[index]!,
  }));
  return { shouldGenerate: true, contractHash, jobs };
};

export type ExampleGenerationAttempt = { usageContext: ExampleUsageContext; ok: boolean; blobKey?: string };

/**
 * "A partial failure keeps whatever examples succeeded; it is never an
 * error" — the result is exactly the successful attempts, tagged with the
 * round's contract hash, in usage-context order. A failed attempt simply
 * contributes nothing (its usageContext gets no entry this round, rather
 * than carrying forward a stale one from a different hash).
 */
export const mergeExampleResults = (
  contractHash: string,
  attempts: readonly ExampleGenerationAttempt[]
): VisualStandardExampleRecord[] =>
  attempts
    .filter(
      (attempt): attempt is ExampleGenerationAttempt & { blobKey: string } =>
        attempt.ok && typeof attempt.blobKey === 'string' && attempt.blobKey.length > 0
    )
    .map((attempt) => ({ usageContext: attempt.usageContext, blobKey: attempt.blobKey, contractHash }));

const toMachineSegment = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'x';
};

/** `req_<flow>_<topic>_<yyyymmdd>_<nn>` (agents-naming.ts's `isRequestId`) —
 * `visimg` names the flow, the standard id + usage context are the topic, so
 * two different standards (or two different contexts on the same standard)
 * regenerating on the same day never collide. */
export const buildExampleJobRequestId = (
  visualStandardId: string,
  usageContext: string,
  nowMs: number
): string => {
  const yyyymmdd = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');
  const nn = String(Math.abs(Math.floor(nowMs)) % 100).padStart(2, '0');
  return `req_visimg_${toMachineSegment(visualStandardId)}_${toMachineSegment(usageContext)}_${yyyymmdd}_${nn}`;
};

/** Lowercase kebab-case with an extension (agents-naming.ts's `isFilename`). */
export const buildExampleJobFilename = (visualStandardId: string, usageContext: string): string =>
  `${toMachineSegment(visualStandardId).replace(/_/g, '-')}-example-${toMachineSegment(usageContext).replace(/_/g, '-')}.png`;

/**
 * The exact input shape `callCreateAgentArtifactJob` (mcp-tool-handlers.ts,
 * P4) expects: `style: { visualStandardId }` so the standard being
 * previewed is the one whose brand gets resolved (never the site's applied
 * copy — a template's examples must render in the TEMPLATE's style even
 * when it is not the site's current look), and `requirements.image.
 * usageContext` with no explicit `size` so P4's aspectRatios → size mapping
 * applies. `prompt` is `sampleSubject` alone — subject-only, per R4; the
 * style words come from `style.visualStandardId`, never from here.
 */
export const buildExampleJobInput = (
  siteId: string,
  visualStandardId: string,
  job: ExampleGenerationJob,
  nowMs: number
): Record<string, unknown> => ({
  site_id: siteId,
  request_id: buildExampleJobRequestId(visualStandardId, job.usageContext, nowMs),
  artifact_kind: 'image',
  filename: buildExampleJobFilename(visualStandardId, job.usageContext),
  prompt: job.sampleSubject,
  style: { visualStandardId },
  requirements: { image: { usageContext: job.usageContext } },
  wait: true,
});

/** Injected dependencies for `generateVisualStandardExamplesWithDeps` — the
 * only impure surface in this module. Every call is best-effort from the
 * orchestrator's point of view: a rejected `createExampleJob` is treated
 * exactly like `{ ok: false }` (partial failure, never thrown onward), and a
 * rejected `persistExamples` is swallowed after being logged, never thrown.
 */
export type VisualStandardExampleDeps = {
  siteId: string;
  now: () => number;
  createExampleJob: (input: Record<string, unknown>) => Promise<{ ok: boolean; blobKey?: string }>;
  persistExamples: (visualStandardId: string, examples: VisualStandardExampleRecord[]) => Promise<void>;
  /** Shaped to drop straight into mcp.ts's `LambdaEvent['log']` (a structured
   * logger requiring `event: string`) with no cast at the call site. */
  log?: (entry: { event: string; [key: string]: unknown }) => void;
};

export type ExampleGenerationOutcome =
  | { generated: false; reason: 'hash_unchanged' | 'no_sample_subjects' }
  | { generated: true; contractHash: string; examples: VisualStandardExampleRecord[] };

/**
 * The full apply/propose-accept/regenerate flow for ONE standard: plan, run
 * the up-to-3 jobs in parallel (bounded by `EXAMPLE_USAGE_CONTEXTS`, so cost
 * never exceeds the ~$0.03-per-job / ≤$0.10-per-standard cap), merge, and
 * persist only when at least one job actually produced an example — a round
 * where every job fails leaves whatever was already stored untouched rather
 * than clobbering it with an empty array, so a transient outage doesn't wipe
 * a standard's last-known-good examples.
 */
export const generateVisualStandardExamplesWithDeps = async (
  deps: VisualStandardExampleDeps,
  visualStandardId: string,
  body: { sampleSubjects: readonly unknown[] | undefined; brandImagery: unknown; examples?: readonly VisualStandardExampleRecord[] }
): Promise<ExampleGenerationOutcome> => {
  const plan = planExampleGeneration(body);
  if (!plan.shouldGenerate) {
    deps.log?.({ event: 'visual_standard_examples_skipped', visualStandardId, reason: plan.reason });
    return { generated: false, reason: plan.reason };
  }

  const nowMs = deps.now();
  const attempts = await Promise.all(
    plan.jobs.map(async (job): Promise<ExampleGenerationAttempt> => {
      const input = buildExampleJobInput(deps.siteId, visualStandardId, job, nowMs);
      try {
        const result = await deps.createExampleJob(input);
        return { usageContext: job.usageContext, ok: result.ok, ...(result.blobKey ? { blobKey: result.blobKey } : {}) };
      } catch (error) {
        deps.log?.({
          event: 'visual_standard_example_job_failed',
          visualStandardId,
          usageContext: job.usageContext,
          error: error instanceof Error ? error.message : String(error),
        });
        return { usageContext: job.usageContext, ok: false };
      }
    })
  );

  const examples = mergeExampleResults(plan.contractHash, attempts);
  deps.log?.({
    event: 'visual_standard_examples_generated',
    visualStandardId,
    attempted: plan.jobs.length,
    succeeded: examples.length,
  });

  if (examples.length > 0) {
    try {
      await deps.persistExamples(visualStandardId, examples);
    } catch (error) {
      deps.log?.({
        event: 'visual_standard_examples_persist_failed',
        visualStandardId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { generated: true, contractHash: plan.contractHash, examples };
};
