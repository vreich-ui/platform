/**
 * Baseline site-singleton seed for 'site_genesis_lab_2' (T11.7 create-site
 * scaffold). This is a STARTER body — placeholder branding an operator
 * replaces before going live, not finished client content. Follows the
 * sites/drlurie/seeds/site-seed-data.mjs shape exactly (same driver
 * contract) so the standard round-trip/reconcile tooling works unmodified
 * for any new client.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/genesis-lab-2 --seeds sites/genesis-lab-2/seeds/site-seed-data.mjs
 */

export const SEED_SITE = 'site_genesis_lab_2';

export const siteBody = {
  name: 'Genesis Lab 2',
  logo: {
    text: 'GENESIS LAB 2',
  },
  urls: {
    base: '/',
    canonicalHost: 'https://kugel-genesis-lab-2.netlify.app',
  },
  metadataDefaults: {
    description: 'Genesis Lab 2 — a starter site, ready for real content.',
    ogImage: '/Social/og-default.jpg',
    titleTemplate: '%s - Genesis Lab 2',
  },
  brandTokens: {
    colors: {
      primary: 'rgb(51 102 204)',
      secondary: 'rgb(38 77 153)',
      accent: 'rgb(0 150 136)',
      gold: 'rgb(191 155 48)',
      'text-heading': 'rgb(20 24 28)',
      'text-default': 'rgb(38 43 48)',
      'text-muted': 'rgb(60 67 75 / 76%)',
      'bg-page': 'rgb(255 255 255)',
      'bg-surface': 'rgb(245 246 248)',
      'bg-page-dark': 'rgb(10 12 20)',
    },
    fonts: {
      sans: 'system-ui, sans-serif',
      serif: 'Georgia, serif',
      heading: 'Georgia, serif',
    },
  },
  // P6: the applied copy of the house visual_standard below (BRIEF §R1 —
  // "site keeps brandImagery as the applied copy", mirroring
  // theme -> site.brandTokens). Derived from brandTokens above via
  // deriveBrandImageryFromTokens at scaffold time, byte-identical to
  // visualStandardBody.brandImagery, so site.brandImagery is never empty for
  // a new site even before any agent or human ever touches visual identity.
  brandImagery: {
    "version": 1,
    "medium": "digital_illustration",
    "styleSentence": "Cool editorial digital illustration on a clean off-white ground, built around confident blue and muted teal accents; matte textured shapes with softly rounded forms, balanced negative space, soft diffuse light and no harsh shadows; clear, modern editorial feel with a deliberately limited palette.",
    "palette": [
      "#3366CC",
      "#009688",
      "#BF9B30",
      "#264D99",
      "#14181C",
      "#262B30",
      "#3C434B",
      "#FFFFFF"
    ],
    "negative": [
      "text, lettering, watermarks, or UI chrome",
      "distorted hands and faces",
      "photorealistic stock-photo gloss",
      "corporate handshakes or boardroom cliches",
      "neon or oversaturated colors",
      "cluttered composition or busy backgrounds",
      "lens flare, bokeh, heavy vignetting",
      "3D renders and glossy plastic surfaces",
      "hard black outlines and drop shadows",
      "cyberpunk, sci-fi, or circuit-board motifs",
      "gradient mesh backgrounds",
      "muddy low-contrast rendering"
    ],
    "composition": {
      "subjectScale": "single clear subject occupying 50-60% of the frame",
      "cropRule": "generous margins; never crop the subject at the frame edge",
      "depthOfField": "flat even focus throughout; no simulated shallow depth"
    },
    "aspectRatios": {
      "article_header": "3:2",
      "article_body": "1:1",
      "category_page": "7:4",
      "social_og": "3:2"
    },
    "seedBase": 2528125599
  },
  chrome: {
    showRssFeed: false,
    showThemeToggle: true,
  },
  defaultNavigation: {
    header: 'nav_header',
    footer: 'nav_footer',
  },
  blog: {
    listPath: 'learn/library',
    postsPerPage: 6,
    categoryBase: 'category',
    tagBase: 'tag',
  },
};

// P6: the house visual_standard (BRIEF §3.1/R1/R2) — the governed SOURCE
// object `site.brandImagery` above is the applied copy of. `visual_standard`
// is a brand-new object type landing concurrently (P1/P3); this is a plain
// object literal, not validated against that schema here (it does not exist
// in this worktree) — packages/core/cli/visual-standard-genesis.mjs is the
// one place that shape is assembled, so the merge only ever needs to touch
// that file, never this one, once the type lands.
export const visualStandardBody = {
  "version": 1,
  "kind": "house",
  "label": "Genesis Lab 2 — house visual standard",
  "description": "The default image style for Genesis Lab 2, derived automatically from its brand palette (brandTokens) rather than hand-authored. Replace with a client-specific mood board and writer proposal once real brand direction exists.",
  "brandImagery": {
    "version": 1,
    "medium": "digital_illustration",
    "styleSentence": "Cool editorial digital illustration on a clean off-white ground, built around confident blue and muted teal accents; matte textured shapes with softly rounded forms, balanced negative space, soft diffuse light and no harsh shadows; clear, modern editorial feel with a deliberately limited palette.",
    "palette": [
      "#3366CC",
      "#009688",
      "#BF9B30",
      "#264D99",
      "#14181C",
      "#262B30",
      "#3C434B",
      "#FFFFFF"
    ],
    "negative": [
      "text, lettering, watermarks, or UI chrome",
      "distorted hands and faces",
      "photorealistic stock-photo gloss",
      "corporate handshakes or boardroom cliches",
      "neon or oversaturated colors",
      "cluttered composition or busy backgrounds",
      "lens flare, bokeh, heavy vignetting",
      "3D renders and glossy plastic surfaces",
      "hard black outlines and drop shadows",
      "cyberpunk, sci-fi, or circuit-board motifs",
      "gradient mesh backgrounds",
      "muddy low-contrast rendering"
    ],
    "composition": {
      "subjectScale": "single clear subject occupying 50-60% of the frame",
      "cropRule": "generous margins; never crop the subject at the frame edge",
      "depthOfField": "flat even focus throughout; no simulated shallow depth"
    },
    "aspectRatios": {
      "article_header": "3:2",
      "article_body": "1:1",
      "category_page": "7:4",
      "social_og": "3:2"
    },
    "seedBase": 2528125599
  },
  "references": [],
  "sampleSubjects": [
    "a person in a independent film preservation setting, an everyday moment",
    "a close-up of hands at work in independent film preservation",
    "a quiet still-life of objects related to independent film preservation"
  ],
  "derivedFrom": {
    "method": "tokens"
  },
  "status": "active"
};

export const CONVERSION_SEEDS = [
  { objectType: 'site', objectId: 'site_genesis_lab_2', body: siteBody },
  { objectType: 'visual_standard', objectId: 'vis_genesis_lab_2', body: visualStandardBody },
];
