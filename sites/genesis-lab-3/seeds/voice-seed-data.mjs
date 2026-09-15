/**
 * Editorial-voice SKELETON for 'site_genesis_lab_3' (T16.1 create-site scaffold,
 * onboarding stage) — structurally valid (satisfies
 * packages/core/schema/bodies/editorial-voice-v1.ts) so the standard
 * round-trip/reconcile tooling works unmodified for any new client, but every
 * free-text field left un-supplied is a placeholder: genesis never invents a
 * client's editorial identity (Wolf's 2026-08-05 ruling; see
 * sites/drlurie/seeds/voice-seed-data.mjs for what a FILLED-IN voice looks
 * like). Replace every 'onboarding: fill with the client' marker with the real
 * answer before this seed is ever driven into the store.
 *
 * Wolf 2026-09-09: the body now carries `provenance`, the UNSET MARKER. A
 * scaffolded skeleton is `genesis_default` — legal, readable, and warned on
 * by every consumer until somebody decides it. A voice supplied at mint
 * (`create-site --editorial-voice '<json>'`) is `agent` and warns on nothing.
 * The fallback path this replaces left a tenant with no voice object at all,
 * which every consumer had to special-case.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/genesis-lab-3 --seeds sites/genesis-lab-3/seeds/voice-seed-data.mjs
 */

export const SEED_SITE = 'site_genesis_lab_3';

export const voiceBody = {
  "name": "genesis-lab-3 — provisional voice (genesis)",
  "audience": "owners of aging dogs noticing changes in mobility, comfort or everyday movement",
  "tone": [
    "clear",
    "specific",
    "unhurried",
    "non-promotional"
  ],
  "cadence": "Short paragraphs. One idea per paragraph. Concrete nouns before abstractions.",
  "lexicon": {
    "prefer": [
      "plain words",
      "the reader's own terms",
      "specific quantities"
    ],
    "avoid": [
      "hype",
      "superlatives",
      "unearned certainty",
      "filler transitions"
    ]
  },
  "claim_policy": "State only what the source material supports. Attribute anything contested. Do not assert outcomes, results or guarantees that the tenant has not published.",
  "cta_policy": "At most one call to action, at the end, and only when the page genuinely has a next step. Never mid-article.",
  "reader_safety_notes": "This voice was generated at genesis from the niche and audience supplied then; nobody has reviewed it. Treat it as a floor, not a house style, and do not let it license claims about senior and aging pets — mobility, comfort, everyday care that the tenant's own material does not make.",
  "frameworks": [
    {
      "framework_id": "plain_explainer",
      "label": "Plain explainer",
      "description": "Answer the reader's question directly, then give the reasoning behind the answer.",
      "when_to_use": "Any article, until an editor decides this tenant needs something else."
    }
  ],
  "default_framework": "plain_explainer",
  "provenance": {
    "set_by": "agent",
    "set_at": "1970-01-01T00:00:00.000Z"
  }
};

export const CONVERSION_SEEDS = [{ objectType: 'editorial_voice', objectId: 'voice_genesis_lab_3', body: voiceBody }];
