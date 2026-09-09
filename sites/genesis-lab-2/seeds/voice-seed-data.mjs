/**
 * Editorial-voice SKELETON for 'site_genesis_lab_2' (T16.1 create-site scaffold,
 * onboarding stage) — structurally valid (satisfies
 * packages/core/schema/bodies/editorial-voice-v1.ts) so the standard
 * round-trip/reconcile tooling works unmodified for any new client, but every
 * free-text field is a placeholder: genesis never invents a client's
 * editorial identity (Wolf's 2026-08-05 ruling; see
 * sites/drlurie/seeds/voice-seed-data.mjs for what a FILLED-IN voice looks
 * like). Replace every 'onboarding: fill with the client' marker with the real
 * answer before this seed is ever driven into the store.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/genesis-lab-2 --seeds sites/genesis-lab-2/seeds/voice-seed-data.mjs
 */

export const SEED_SITE = 'site_genesis_lab_2';

export const voiceBody = {
  name: 'Genesis Lab 2 — voice (onboarding: fill with the client)',
  audience: 'onboarding: fill with the client — who is this publication written for?',
  tone: ['onboarding: fill with the client'],
  cadence: 'onboarding: fill with the client — sentence/paragraph rhythm, person, tense.',
  lexicon: {
    prefer: [],
    avoid: [],
  },
  claim_policy: 'onboarding: fill with the client — what may this publication assert, and what evidence does a claim need?',
  cta_policy: 'onboarding: fill with the client — what may this publication ask a reader to do, and how directly?',
  reader_safety_notes: 'onboarding: fill with the client — reader-harm boundaries specific to this audience, if any.',
  frameworks: [
    {
      framework_id: 'fw_placeholder',
      label: 'onboarding: fill with the client',
      description: 'onboarding: fill with the client',
      when_to_use: 'onboarding: fill with the client',
      beats: [],
    },
  ],
  default_framework: 'fw_placeholder',
};

export const CONVERSION_SEEDS = [{ objectType: 'editorial_voice', objectId: 'voice_genesis_lab_2', body: voiceBody }];
