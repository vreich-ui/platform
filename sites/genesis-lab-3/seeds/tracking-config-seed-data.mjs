/**
 * Tracking-config SKELETON for 'site_genesis_lab_3' (T16.1 create-site scaffold,
 * onboarding stage) — structurally valid (satisfies
 * packages/core/schema/bodies/tracking-config-v1.ts) so the standard
 * round-trip/reconcile tooling works unmodified for any new client, but no
 * provider is enabled and every free-text field is a placeholder: genesis
 * never invents a client's analytics posture or copy (Wolf's 2026-08-05
 * ruling; see sites/drlurie/seeds/tracking-config-seed-data.mjs for what a
 * FILLED-IN config looks like). Replace every 'onboarding: fill with the client'
 * marker — and pick a real consent posture — before this seed is ever driven
 * into the store.
 *
 * What to decide, field by field:
 *   providers        — empty means nothing is measured at all. The per-provider
 *                      id shape is in
 *                      docs/cms-architecture/12-object-tracking-and-analytics.md §4.
 *   consent.posture  — 'geo-adaptive' | 'consent-first' | 'us-first'. Seeded
 *                      'consent-first', the most restrictive of the three;
 *                      pick the one that matches this client's real audience
 *                      geography rather than leaving the safe default because
 *                      it was already there.
 *   consent.banner   — the words a visitor reads. Placeholder copy is not
 *                      consent copy.
 *
 * Wolf 2026-09-09: `create-site --tracking-config '<json>'` deep-merges a
 * partial body onto this skeleton at mint, so an agent that already knows the
 * client's analytics posture can supply it instead of scaffolding placeholders
 * for a human to find later. Unlike the strategy/voice/visual baselines this
 * object carries no provenance marker, so a supplied config is simply the
 * config.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/genesis-lab-3 --seeds sites/genesis-lab-3/seeds/tracking-config-seed-data.mjs
 */

export const SEED_SITE = 'site_genesis_lab_3';

export const trackingConfigBody = {
  "providers": {},
  "consent": {
    "posture": "consent-first",
    "restricted_regions": [],
    "honor_gpc": true,
    "banner": {
      "headline": "Privacy choices",
      "body": "onboarding: fill with the client — describe what this site measures and what a visitor is consenting to.",
      "accept_label": "Accept all",
      "reject_label": "Decline",
      "manage_label": "Manage choices"
    }
  },
  "defaults": {
    "page": [
      "pageview"
    ],
    "section": [],
    "content_item": [],
    "product": [],
    "navigation": [],
    "taxonomy": [],
    "outbound_links": false,
    "utm_capture": false
  }
};

export const CONVERSION_SEEDS = [
  { objectType: 'tracking_config', objectId: 'trk_genesis_lab_3', body: trackingConfigBody },
];
