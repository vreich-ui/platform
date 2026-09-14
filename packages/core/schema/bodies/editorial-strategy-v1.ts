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

/**
 * COMMISSIONING — the autonomous-publishing block (Wolf, 2026-09-14, Track C).
 *
 * OPTIONAL, AND ABSENCE IS NOT AN ERROR. Every tenant that exists today has a
 * strategy with no `commissioning` block, and every one of them must keep
 * validating, publishing and reviewing exactly as before. Absence warns
 * (`strategy_commissioning_present`) and blocks nothing: the warning says
 * "this publication cannot commission its own work yet", which is a true and
 * useful fact about a site, not a defect in it.
 *
 * WHY IT LIVES ON THE STRATEGY. A commissioning policy is the same KIND of
 * statement the rest of this object makes — what this publication publishes
 * for, and how hard. Putting the budget, the cadence and the seed topics in a
 * governed, versioned, diffable, approvable object means an operator can read
 * "why did this site publish that" out of one place, and can turn autonomy off
 * by editing an object rather than by finding a job.
 *
 * DATA, NOT INSTRUCTIONS, still applies: `seeds[].topic`, `archetypes[].job`
 * and every other string here is scanned by `strategy_not_a_prompt` like any
 * other field on the body.
 *
 * THE PLANNER NEVER TRUSTS THESE NUMBERS AS PERMISSION. `runsPerDay`,
 * `dailyBudgetUsd` and `maxConcurrentRuns` are CEILINGS the planner clamps
 * itself to, not an allowance it is owed — the engine re-derives today's spend
 * and today's open runs from the run store before every commission, so a
 * strategy edited to `runsPerDay: 50` still cannot outrun the engine's own
 * per-run budget guard.
 */
export const READER_STATES = ['recognition', 'understanding', 'investigation', 'selection'] as const;
export type ReaderState = (typeof READER_STATES)[number];

/**
 * The traffic sources and awareness stages `placement_resolver` recognizes.
 * Duplicated here as a literal union on purpose: the engine's copy
 * (`aggressionVector.ts`) is the runtime authority, and a strategy that names
 * a value the engine does not know must be refused at WRITE — in the object
 * store, where a human is looking — rather than at 06:00 on a Tuesday inside
 * an unattended job.
 */
export const COMMISSIONING_TRAFFIC_SOURCES = [
  'organic_search',
  'organic_social',
  'paid_search',
  'paid_social',
  'email',
  'direct',
  'referral',
] as const;
export const COMMISSIONING_AWARENESS_STAGES = [
  'unaware',
  'problem_aware',
  'solution_aware',
  'product_aware',
  'most_aware',
] as const;

/**
 * One reader archetype: WHO a commissioned piece is for and what job it does
 * for them. `defaultTrafficSource`/`defaultAwarenessStage` are the placement
 * signals a seed inherits when it does not name its own — the two inputs
 * `placement_resolver` turns into the aggression vector, so an archetype is
 * effectively "this kind of reader, arriving this way, this warm".
 */
export const commissioningArchetypeSchema = z
  .object({
    id: z.string().min(1),
    /** The job this archetype hires the publication to do, as a fact ("decide whether to switch actives"). */
    job: z.string().min(1),
    defaultTrafficSource: z.enum(COMMISSIONING_TRAFFIC_SOURCES),
    defaultAwarenessStage: z.enum(COMMISSIONING_AWARENESS_STAGES),
  })
  .strict();
export type CommissioningArchetype = z.infer<typeof commissioningArchetypeSchema>;

/**
 * One seed: a topic the strategist has already decided is worth publishing,
 * with the reader state it serves. Seeds are the planner's FLOOR, not its
 * ceiling — the model turn may propose beyond them, but a tenant with seeds
 * always has something legitimate to commission even when the model turn
 * returns nothing usable.
 */
export const commissioningSeedSchema = z
  .object({
    topic: z.string().min(1),
    readerState: z.enum(READER_STATES),
    archetypeId: z.string().min(1),
    trafficSource: z.enum(COMMISSIONING_TRAFFIC_SOURCES).optional(),
    awarenessStage: z.enum(COMMISSIONING_AWARENESS_STAGES).optional(),
    /** Higher runs first. Unbounded on purpose: a strategist ranks, the planner sorts. */
    priority: z.number().default(0),
  })
  .strict();
export type CommissioningSeed = z.infer<typeof commissioningSeedSchema>;

/** How commissioned output should spread across the four reader states. Weights, not shares — normalized at read, like topic_weights. */
export const readerStateMixSchema = z
  .object({
    recognition: unitShareSchema,
    understanding: unitShareSchema,
    investigation: unitShareSchema,
    selection: unitShareSchema,
  })
  .strict();
export type ReaderStateMix = z.infer<typeof readerStateMixSchema>;

export const commissioningSchema = z
  .object({
    /** The master switch. FALSE BY DEFAULT — a tenant never starts commissioning because a block appeared. */
    enabled: z.boolean().default(false),
    runsPerDay: z.number().int().min(0).max(50).default(1),
    dailyBudgetUsd: z.number().min(0).default(10),
    maxConcurrentRuns: z.number().int().min(1).max(10).default(1),
    /** Consecutive failed commissioned runs before the planner halts itself and raises planner_halted. */
    stopAfterConsecutiveFailures: z.number().int().min(1).max(20).default(2),
    readerStateMix: readerStateMixSchema.default({
      recognition: 0.25,
      understanding: 0.25,
      investigation: 0.25,
      selection: 0.25,
    }),
    archetypes: z.array(commissioningArchetypeSchema).default([]),
    seeds: z.array(commissioningSeedSchema).default([]),
    /** Topics, slugs or phrases this publication will not commission. Matched case-insensitively against the candidate topic and slug. */
    exclusions: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type Commissioning = z.infer<typeof commissioningSchema>;

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
    /**
     * Autonomous commissioning policy. OPTIONAL — absent means this
     * publication only publishes what a human or an agent asks it to, which is
     * every tenant's state until somebody decides otherwise. See the block header.
     */
    commissioning: commissioningSchema.optional(),
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

  const commissioning = body.commissioning;
  if (commissioning) {
    // Duplicate archetype ids make "the archetype for this seed" ambiguous at
    // exactly the moment the planner has to pick one — the same reason a
    // duplicate topic weight blocks.
    const archetypeIds = commissioning.archetypes.map((entry) => entry.id);
    const duplicateArchetypes = archetypeIds.filter((id, index) => archetypeIds.indexOf(id) !== index);
    if (duplicateArchetypes.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['commissioning', 'archetypes'],
        message: `Duplicate archetype id(s): ${[...new Set(duplicateArchetypes)].join(', ')}.`,
      });
    }

    // A seed pointing at an archetype that does not exist is a brief with no
    // reader. Refused at write, where a human is looking, rather than silently
    // dropped at 06:00 inside an unattended job.
    const known = new Set(archetypeIds);
    commissioning.seeds.forEach((seed, index) => {
      if (!known.has(seed.archetypeId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['commissioning', 'seeds', index, 'archetypeId'],
          message: `Seed names archetype "${seed.archetypeId}", which this strategy does not define.`,
        });
      }
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
