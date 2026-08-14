/**
 * Baseline site-singleton seed for 'site_zilberman' (T11.7 create-site
 * scaffold). This is a STARTER body — placeholder branding an operator
 * replaces before going live, not finished client content. Follows the
 * sites/drlurie/seeds/site-seed-data.mjs shape exactly (same driver
 * contract) so the standard round-trip/reconcile tooling works unmodified
 * for any new client.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/zilberman --seeds sites/zilberman/seeds/site-seed-data.mjs
 */

export const SEED_SITE = 'site_zilberman';

export const siteBody = {
  name: 'Zilberman',
  logo: {
    text: 'ZILBERMAN',
  },
  urls: {
    base: '/',
    canonicalHost: 'https://zilbermanfilmfoundation.netlify.app',
  },
  metadataDefaults: {
    description: 'Zilberman — a starter site, ready for real content.',
    ogImage: '/Social/og-default.jpg',
    titleTemplate: '%s - Zilberman',
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

export const CONVERSION_SEEDS = [{ objectType: 'site', objectId: 'site_zilberman', body: siteBody }];
