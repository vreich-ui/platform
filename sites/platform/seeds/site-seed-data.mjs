/**
 * Baseline site-singleton seed for 'site_platform' (T11.7 create-site
 * scaffold). This is a STARTER body — placeholder branding an operator
 * replaces before going live, not finished client content. Follows the
 * sites/drlurie/seeds/site-seed-data.mjs shape exactly (same driver
 * contract) so the standard round-trip/reconcile tooling works unmodified
 * for any new client.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/platform --seeds sites/platform/seeds/site-seed-data.mjs
 */

export const SEED_SITE = 'site_platform';

export const siteBody = {
  name: 'Platform',
  logo: {
    text: 'PLATFORM',
  },
  urls: {
    base: '/',
    canonicalHost: 'https://platform.netlify.app',
  },
  metadataDefaults: {
    description: 'Platform — a starter site, ready for real content.',
    ogImage: '/Social/og-default.jpg',
    titleTemplate: '%s - Platform',
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
  // W16 C1 (§4 vocabulary): the visual-identity contract for AI image
  // generation/search — the STYLE half agents never supply themselves.
  // Minimal starter stanza; no composition/lora tuning yet.
  brandImagery: {
    version: 1,
    medium: 'flat_vector',
    styleSentence: 'Neutral professional flat-vector SaaS illustration with clean geometric line art.',
    palette: ['#2563EB', '#0F172A'],
    negative: ['no photorealism', 'no gradients or drop shadows'],
    aspectRatios: {
      article_header: '3:2',
      article_body: '4:3',
      pdf_cover: '1:1',
    },
    seedBase: 100002,
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

export const CONVERSION_SEEDS = [{ objectType: 'site', objectId: 'site_platform', body: siteBody }];
