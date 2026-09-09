/**
 * Editorial-strategy SKELETON for 'site_drlurie' (Wolf, 2026-09-09) — the
 * voice seed's twin, and it follows the same rule: structurally valid
 * (satisfies packages/core/schema/bodies/editorial-strategy-v1.ts) so the
 * standard round-trip/reconcile tooling works unmodified, but every free-text
 * field left un-supplied is a placeholder. Genesis does NOT invent a client's
 * offer, segments or funnel posture.
 *
 * What genesis DOES do, and why it is not a contradiction of the 2026-08-05
 * types-not-instances ruling: it writes the object anyway, marked
 * `provenance.set_by: "genesis_default"`. That marker is the whole point. A
 * tenant with NO strategy object forces every consumer to special-case absence
 * and gives the fleet no address to read; a tenant with a MARKED default gives
 * every consumer one address, one honest "needs to be set" warning, and
 * nothing blocked. When the caller supplies values at mint
 * (`create-site --editorial-strategy '<json>'`), the same block reads
 * `set_by: "agent"` instead and no warning fires.
 *
 * `funnel_aggression` is the Magnetic-Marketing scale (0 = never sells,
 * 1 = sells hard) as a per-stage CEILING, top of funnel lowest. The seeded
 * values are a conservative floor, not a recommendation.
 *
 * Replace every 'onboarding: fill with the client' marker with the real answer — the
 * write path stamps set_by/set_at for you on the first real edit.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/drlurie --seeds sites/drlurie/seeds/strategy-seed-data.mjs
 */

export const SEED_SITE = 'site_drlurie';

export const strategyBody = {
  "name": "Dr. Lurié Skincare — strategy (onboarding: fill with the client)",
  "goal": "onboarding: fill with the client — what is publishing FOR on this site?",
  "offer": "onboarding: fill with the client — the offer (or offer architecture) the funnel sells.",
  "audience_segments": [],
  "topic_weights": [],
  "angle_mix": [],
  "funnel_aggression": {
    "tofu": 0,
    "mofu": 0.2,
    "bofu": 0.4
  },
  "cadence": "onboarding: fill with the client — how often, and at what volume?",
  "provenance": {
    "set_by": "genesis_default",
    "set_at": "1970-01-01T00:00:00.000Z"
  }
};

export const CONVERSION_SEEDS = [
  { objectType: 'editorial_strategy', objectId: 'strat_drlurie', body: strategyBody },
];
