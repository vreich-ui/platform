/**
 * Editorial strategy body schema — 'editorial_strategy.v1' (Wolf, 2026-09-09).
 *
 * The THIRD genesis-seeded tenant singleton, beside `editorial_voice`
 * (`voice_<slug>`) and `visual_standard` (`vis_<slug>`). Where a voice says
 * HOW a publication sounds, a strategy says WHAT it is publishing for and
 * WHERE the effort goes: the offer the funnel sells, the segments it is
 * written for, the weight each topic carries, the mix of angles, and how hard
 * each funnel stage may push.
 *
 * ONE PER SITE, id `strat_<slug>` — the site_/tax_/trk_/voice_/vis_ singleton
 * convention. Reachable through the ordinary object surface
 * (`object_contract('editorial_strategy')` then `object_get('strat_drlurie')`)
 * for the same reason the voice is: no engine should need a private
 * side-channel to learn a client's strategy, and a governed object is
 * versioned, approvable, diffable and lock-governed where a prompt fragment is
 * none of those things.
 *
 * DATA, NOT INSTRUCTIONS. Every field states what the strategy IS, in the
 * third person, as a fact about the publication. A field carrying
 * prompt-formatted text ("You are a growth marketer…", chat-turn markers,
 * {{templates}}) is refused at write by the `strategy_not_a_prompt`
 * constraint — the SAME marker catalog (`lib/registry/voice-prose.ts`) and the
 * same write-time block as `voice_not_a_prompt`, for the same reason: a prompt
 * smuggled into a governed object is an unreviewable instruction to whichever
 * model reads it next, and the approval that covered "the strategy" would
 * silently have covered an injection.
 *
 * WHY THE WEIGHTS ARE NOT NORMALIZED. `topic_weights[].weight` and
 * `angle_mix[].share` are each bounded 0–1 per entry, and the SET is NOT
 * required to sum to 1. A strategy is edited by partial merge
 * (`set_strategy_fields`), and a sum invariant would make the natural edit —
 * "raise this one angle" — refuse until the editor rebalanced everything else
 * by hand, which is how a governance rule teaches people to route around it.
 * The consumer normalizes at read; `strategy_shares_sum` warns (never blocks)
 * when a set drifts far from 1, so drift is visible without being fatal.
 *
 * `funnel_aggression` is the Magnetic-Marketing scale: how directly each stage
 * may sell, top-of-funnel LOWEST. It is a per-stage ceiling, not a target.
 *
 * `private.notes` is operator prose — the strategist's own reasoning, which is
 * never reader-facing and therefore carries no reader-safety obligation. It is
 * stripped from every materialized export by `materializers/shared.ts`'s
 * `stripPrivate`, so it lives in the store and never in the site tree. It is
 * NOT exempt from `strategy_not_a_prompt`: a private field is still read by
 * models, so an injection there is exactly as unreviewable as one in `goal`.
 *
 * Does NOT carry the per-object `tracking` attribute (the
 * tracking_config/editorial_voice/visual_standard precedent): a strategy is
 * never a tracked reader-facing surface, it is publishing law.
 */
import { z } from 'zod';

import { baselineProvenanceSchema } from './baseline-provenance-v1.js';

export const EDITORIAL_STRATEGY_SCHEMA_VERSION = 'editorial_strategy.v1';

/** A share/weight: bounded per entry, never normalized across the set. See the header note. */
const unitShareSchema = z.number().min(0).max(1);

/**
 * One weighted topic. `term_id` names a taxonomy term when the strategy is
 * anchored to the tenant's registry; `label` carries a plain-language topic
 * that has no term yet. At least one of the two is required — an entry naming
 * neither is a weight attached to nothing, which is the one shape a reviewer
 * cannot check. Both together are legitimate: the term is the identity, the
 * label is what a human reads in a diff.
 */
export const strategyTopicWeightSchema = z
  .object({
    term_id: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    weight: unitShareSchema,
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (!entry.term_id && !entry.label) {
      ctx.addIssue({
        code: 'custom',
        path: ['term_id'],
        message: 'A topic weight must name a taxonomy term_id, a plain label, or both — a weight on nothing is unreviewable.',
      });
    }
  });
export type StrategyTopicWeight = z.infer<typeof strategyTopicWeightSchema>;

/**
 * One editorial angle and the share of output it should carry. `angle` is the
 * strategy's own vocabulary ("myth-correction", "protocol walkthrough") rather
 * than a closed enum: the angles a publication runs are a business decision,
 * and pinning them fleet-wide would make every tenant argue with the engine.
 * This is the grain `strategy-review` proposes on today (C-16's topic /
 * funnel-stage grain is not yet available on the sink).
 */
export const strategyAngleShareSchema = z
  .object({
    angle: z.string().min(1),
    share: unitShareSchema,
  })
  .strict();
export type StrategyAngleShare = z.infer<typeof strategyAngleShareSchema>;

/**
 * The per-stage selling ceiling, 0 (never sells) to 1 (sells hard). Top of
 * funnel is expected to be the LOWEST of the three; a strategy that inverts
 * that is legal but warned (`strategy_funnel_shape`), because inverting it is
 * occasionally deliberate and usually a typo.
 */
export const funnelAggressionSchema = z
  .object({
    tofu: unitShareSchema,
    mofu: unitShareSchema,
    bofu: unitShareSchema,
  })
  .strict();
export type FunnelAggression = z.infer<typeof funnelAggressionSchema>;

export const strategyPrivateSchema = z
  .object({
    /** Operator prose. Stripped from every export by stripPrivate; still prompt-guarded. */
    notes: z.string().optional(),
  })
  .strict();

/**
 * The SHAPE alone, without whole-body invariants — split out for the same
 * reason `editorialVoiceShapeSchema` is: zod refuses `.partial()` on a schema
 * carrying refinements, and the Ask-AI derivation partials every body schema
 * to build its suggestion tool. Every write path validates the full
 * `editorialStrategyBodySchema` below.
 */
export const editorialStrategyShapeSchema = z
  .object({
    name: z.string().min(1),
    /** What publishing is FOR on this site, stated as a fact about the business. */
    goal: z.string().min(1),
    /** The DTC offer (or offer architecture) the funnel sells. */
    offer: z.string().min(1),
    /** Who the funnel is written for — one entry per named segment. */
    audience_segments: z.array(z.string().min(1)).default([]),
    topic_weights: z.array(strategyTopicWeightSchema).default([]),
    angle_mix: z.array(strategyAngleShareSchema).default([]),
    funnel_aggression: funnelAggressionSchema,
    /** Publishing rhythm as a fact ("two long-form articles a week, one teardown a month"). */
    cadence: z.string().min(1),
    private: strategyPrivateSchema.optional(),
    /** The unset marker. See baseline-provenance-v1.ts. Required — this type has no legacy bodies. */
    provenance: baselineProvenanceSchema,
  })
  .strict();

/**
 * The enforced body. The only whole-body invariant is duplicate detection:
 * two entries for the same topic or the same angle make "the weight of X"
 * ambiguous at exactly the moment a reviewer or a normalizer needs one answer.
 * Sum-to-1 is deliberately NOT enforced here — see the header note.
 */
export const editorialStrategyBodySchema = editorialStrategyShapeSchema.superRefine((body, ctx) => {
  const topicKeys = body.topic_weights.map((entry) => entry.term_id ?? `label:${entry.label}`);
  const duplicateTopics = topicKeys.filter((key, index) => topicKeys.indexOf(key) !== index);
  if (duplicateTopics.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['topic_weights'],
      message: `Duplicate topic(s): ${[...new Set(duplicateTopics)].join(', ')}.`,
    });
  }

  const angles = body.angle_mix.map((entry) => entry.angle);
  const duplicateAngles = angles.filter((angle, index) => angles.indexOf(angle) !== index);
  if (duplicateAngles.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['angle_mix'],
      message: `Duplicate angle(s): ${[...new Set(duplicateAngles)].join(', ')}.`,
    });
  }
});

export type EditorialStrategyBody = z.infer<typeof editorialStrategyBodySchema>;
