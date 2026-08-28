/**
 * Tracking-config SKELETON for 'site_zilberman' (T16.1 create-site scaffold,
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
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/zilberman --seeds sites/zilberman/seeds/tracking-config-seed-data.mjs
 */

export const SEED_SITE = 'site_zilberman';

export const RESTRICTED_REGIONS = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'IS',
  'LI',
  'NO',
  'GB',
  'CH',
  'IL',
];

export const trackingConfigBody = {
  // No analytics/ad provider is enabled by default — onboarding: fill with the client
  // (docs/cms-architecture/12-object-tracking-and-analytics.md §4 has the
  // per-provider id shape when one is turned on).
  providers: {},
  consent: {
    // onboarding: fill with the client — pick the posture that matches this client's
    // real audience geography: 'geo-adaptive' | 'consent-first' | 'us-first'.
    posture: 'consent-first',
    restricted_regions: RESTRICTED_REGIONS,
    honor_gpc: true,
    analytics_id_mode: 'unrestricted-auto',
    banner: {
      headline: 'Privacy choices',
      body: 'onboarding: fill with the client — describe what this site measures and what a visitor is consenting to.',
      accept_label: 'Accept all',
      reject_label: 'Decline',
      manage_label: 'Manage choices',
    },
  },
  defaults: {
    page: ['pageview'],
    section: [],
    content_item: [],
    product: [],
    navigation: [],
    taxonomy: [],
    outbound_links: false,
    utm_capture: false,
  },
};

export const CONVERSION_SEEDS = [
  { objectType: 'tracking_config', objectId: 'trk_zilberman', body: trackingConfigBody },
];
