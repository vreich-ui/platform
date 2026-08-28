/**
 * Seed data for the tracking-config singleton (W13 T13.10 — 12-plan §3).
 *
 * ONE seed only (the site_/tax_ singleton convention): `trk_drlurie`, the
 * per-project tracker registry. Values are the RATIFIED posture:
 * - consent per OQ-W13-1 (2026-07-19): `geo-adaptive`, restricted_regions =
 *   EEA-30 (EU-27 + IS/LI/NO) + UK + CH, GPC honored, banner copy seeded
 *   (plain validated strings — the banner itself is the T13.6 code
 *   component).
 * - ALL pixel providers ship `enabled: false` — enabling one is a Wolf-era
 *   config edit through the normal verbs, and the CSP hosts-drift test
 *   forces the netlify.toml edit to ride that same change (T13.8).
 * - `own` enabled, cookieless-essential: ingest `/api/t`, sink env NAMES
 *   per OQ-W13-6 (never values/URLs), mirror `fallback`.
 * - `defaults` = the §6 v1 collection matrix verbatim.
 *
 * Consumed by scripts/home-conversion-roundtrip.mjs via
 *   --seeds scripts/lib/tracking-config-seed-data.mjs
 * which drills the singleton's one op (set_tracking_config_fields) ending
 * byte-identical to the seed. Creation note: tracking_config is
 * human/seed-minted only (OQ-W13-2) — the conversion-factory driver is the
 * named seed identity in src/config/creation-policy.ts.
 */

export const SEED_SITE = 'site_drlurie';

// EEA-30 (EU-27 + IS/LI/NO) + UK + CH — the OQ-W13-1 ratified list.
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
  providers: {
    own: {
      enabled: true,
      consent_class: 'essential',
      ingest_path: '/api/t',
      endpoint_env: 'TRACKING_SINK_URL',
      auth_env: 'TRACKING_SINK_TOKEN',
      blob_mirror: 'fallback',
    },
    // Every ad provider ships DISABLED (ids arrive with enablement; the
    // schema requires an id only when enabled). gtm is permanently out
    // (OQ-W13-3) — the key exists for shape stability only.
    ga4: { enabled: false, consent_class: 'analytics' },
    gtm: { enabled: false, consent_class: 'advertising' },
    google_ads: { enabled: false, consent_class: 'advertising' },
    meta_pixel: { enabled: false, consent_class: 'advertising' },
    taboola: { enabled: false, consent_class: 'advertising' },
    outbrain: { enabled: false, consent_class: 'advertising' },
    mgid: { enabled: false, consent_class: 'advertising' },
    plausible: { enabled: false, consent_class: 'analytics' },
  },
  consent: {
    posture: 'geo-adaptive',
    restricted_regions: RESTRICTED_REGIONS,
    honor_gpc: true,
    banner: {
      headline: 'Privacy choices',
      body:
        'We measure how this site is used with a cookieless, first-party counter that stores nothing on your device. ' +
        'With your permission we would also use advertising measurement and a persistent analytics identifier. ' +
        'You can change your choice any time via the privacy choices link in the footer.',
      accept_label: 'Accept all',
      reject_label: 'Decline',
      manage_label: 'Manage choices',
    },
  },
  // The §6 v1 object-type × activity matrix, verbatim.
  defaults: {
    page: ['pageview', 'scroll_depth', 'engagement'],
    section: ['section_impression', 'section_dwell', 'cta_click', 'form_start', 'form_submit'],
    content_item: ['read_progress', 'node_impression', 'node_dwell', 'completion'],
    product: ['buy_click'],
    navigation: ['nav_click'],
    taxonomy: ['term_view', 'tag_click'],
    outbound_links: true,
    utm_capture: true,
  },
};

export const CONVERSION_SEEDS = [{ objectType: 'tracking_config', objectId: 'trk_drlurie', body: trackingConfigBody }];
