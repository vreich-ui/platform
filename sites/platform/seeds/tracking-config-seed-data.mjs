/**
 * Seed data for the tracking-config singleton (T16.1 backfill closing plan
 * §1.2 finding 8, "seed↔export inversions": drlurie seeds `tracking_config`
 * with no committed export; platform commits `data/site/tracking.json` with
 * no seed — the exact opposite gap).
 *
 * This is NOT invented content (Wolf's 2026-08-05 ruling, "types yes,
 * invented instances no"): every field below is copied verbatim from the
 * COMMITTED, LIVE export at `sites/platform/data/site/tracking.json`
 * (`__generated.from: objects/tracking_config/by-id/trk_platform.json`,
 * record_version 2) — this seed describes what is already live, so that a
 * `create_variant`/reconcile drive can prove the store record matches its
 * own committed export the same way every other seed module does. T16.9
 * reconciles the inversion itself (create/publish `trk_platform` in
 * platform's own store from this exact seed, no new values); this file only
 * gives that drive something byte-true to publish FROM.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/platform --seeds sites/platform/seeds/tracking-config-seed-data.mjs
 */

export const SEED_SITE = 'site_platform';

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
  // Copied verbatim from the committed export — platform documents the CMS,
  // it does not itself run any third-party pixel provider today.
  providers: {},
  consent: {
    posture: 'consent-first',
    restricted_regions: RESTRICTED_REGIONS,
    honor_gpc: true,
    analytics_id_mode: 'unrestricted-auto',
    banner: {
      headline: 'Your privacy choices',
      body:
        'Platform documentation does not enable third-party analytics by default. If measurement is enabled later, ' +
        'choose whether non-essential tracking may run.',
      accept_label: 'Allow',
      reject_label: 'Decline',
      manage_label: 'Manage',
    },
  },
  defaults: {
    page: ['pageview', 'scroll_depth', 'completion'],
    section: ['section_impression'],
    content_item: ['pageview', 'read_progress', 'completion'],
    product: ['pageview', 'buy_click'],
    navigation: ['nav_click'],
    taxonomy: ['term_view', 'tag_click'],
    outbound_links: true,
    utm_capture: false,
  },
};

export const CONVERSION_SEEDS = [{ objectType: 'tracking_config', objectId: 'trk_platform', body: trackingConfigBody }];
