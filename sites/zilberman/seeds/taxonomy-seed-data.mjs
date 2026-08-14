/**
 * Baseline taxonomy-registry SKELETON for 'tax_zilberman' (T11.7
 * create-site scaffold) — zero terms. A brand-new client has no editorial
 * vocabulary yet; agents grow it with the taxonomy patch ops (add_term, …)
 * as real content gets written. Mirrors sites/drlurie/seeds/
 * taxonomy-seed-data.mjs's shape (empty kinds.category/tag term arrays parse
 * cleanly — taxonomy.v1 imposes no minimum).
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/zilberman --seeds sites/zilberman/seeds/taxonomy-seed-data.mjs
 */

export const SEED_SITE = 'site_zilberman';

export const taxonomyBody = {
  kinds: {
    category: { terms: [] },
    tag: { terms: [] },
  },
};

export const CONVERSION_SEEDS = [{ objectType: 'taxonomy', objectId: 'tax_zilberman', body: taxonomyBody }];
