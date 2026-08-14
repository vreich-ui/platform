/**
 * Baseline default THEME for 'thm_zilberman_default' (T11.7 create-site scaffold).
 * Tokens are imported from the site seed so the default theme is
 * byte-identical to the starter palette — applying it to the untouched site
 * is a provable no-op (the same W8.4 zero-risk pattern Dr-Lurie's
 * thm_drlurie_default uses).
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/zilberman --seeds sites/zilberman/seeds/themes-seed-data.mjs
 */
import { siteBody } from './site-seed-data.mjs';

export const SEED_SITE = 'site_zilberman';

export const themeDefaultBody = {
  name: 'Default',
  description: 'The starter palette, verbatim from the site seed — applying it to the untouched site is a no-op.',
  whenToUse: 'Apply to restore the starter palette after theme experiments, or copy as the starting point for a real brand palette.',
  scope: 'evergreen',
  tokens: structuredClone(siteBody.brandTokens),
};

export const CONVERSION_SEEDS = [{ objectType: 'theme', objectId: 'thm_zilberman_default', body: themeDefaultBody }];
