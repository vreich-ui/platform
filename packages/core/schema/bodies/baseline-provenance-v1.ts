/**
 * Baseline-artifact provenance (Wolf, 2026-09-09) — the shared `provenance`
 * block carried by the genesis-seeded tenant singletons.
 *
 * THE PROBLEM IT SOLVES. A tenant is minted with a voice and a strategy
 * whether or not anybody authored them: an unset baseline is seeded with a
 * thin, honest default so that no consumer has to special-case absence and
 * nothing blocks at birth (decision 2 of the 2026-09-09 ruling). But a seeded
 * default and a decided one are, at the point of use, the same shape of
 * object — and an engine that cannot tell them apart treats boilerplate as
 * the publication's declared identity. That is exactly the failure
 * `genesisEditorialVoiceFallback` was written to avoid on the CMS-Agent side,
 * and it comes straight back the moment the fallback becomes a real object.
 *
 * So the marker rides ON the body. `set_by: 'genesis_default'` is THE UNSET
 * MARKER: the object exists, it is readable, it is legal to use, and every
 * consumer that reads it is expected to surface "this still needs to be set"
 * (CMS-Agent's `strategy_object_unconfigured` / `voice_object_unconfigured`
 * warnings) rather than refuse to run.
 *
 * `agent` and `human` both mean DECIDED — the distinction is who decided, not
 * how much the value is worth. An agent-supplied baseline at mint time (the
 * genesis inputs of W2) is a real answer to a real question and is used
 * without a warning; the governed history already records exactly which
 * principal wrote it, so this field is a fast, body-level fact rather than a
 * second, weaker identity claim.
 *
 * Optional on `editorial_voice`, where it is additive to bodies that existed
 * before this block did. Absence there means exactly "written before the
 * marker existed" — which is an authored voice, not a default — so the
 * default for an existing body is `human` and NOT `genesis_default`.
 * Required on `editorial_strategy`, which has no bodies predating it.
 */
import { z } from 'zod';

/** Who put the current values there. `genesis_default` is the unset marker. */
export const baselineProvenanceSetBySchema = z.enum(['genesis_default', 'agent', 'human']);
export type BaselineProvenanceSetBy = z.infer<typeof baselineProvenanceSetBySchema>;

export const baselineProvenanceSchema = z
  .object({
    set_by: baselineProvenanceSetBySchema,
    /** ISO-8601 instant the current values were set. */
    set_at: z.string().min(1),
  })
  .strict();
export type BaselineProvenance = z.infer<typeof baselineProvenanceSchema>;

/**
 * The one predicate every consumer asks: is this baseline still the seeded
 * default? Written once, here, so the CMS-Agent-side warning and the
 * platform-side readiness criterion can never drift on what "unset" means.
 * A body with NO provenance is treated as authored — see the note above.
 */
export const isSeededDefault = (provenance: unknown): boolean =>
  typeof provenance === 'object' &&
  provenance !== null &&
  (provenance as { set_by?: unknown }).set_by === 'genesis_default';
