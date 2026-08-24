/**
 * Baseline starter section-template RECIPES for 'site_zilberman' (T11.7
 * create-site scaffold).
 *
 * T14.1: these bodies used to be restated here — byte-identical to
 * sites/platform and sites/fernwell's copies only by luck, nothing enforced
 * it. They now come from the CANONICAL pack
 * (packages/core/cli/canonical-seed-data.mjs), imported rather than
 * restated, so the fleet cannot drift apart again. This also brings in the
 * four recipes that used to live only on sites/drlurie
 * (stpl_media_gallery, stpl_stats_band, stpl_comparison_matrix,
 * stpl_expectations_timeline) — brand-neutral shapes this site was simply
 * never given.
 *
 * A site adds its OWN recipes by importing what it needs from the canonical
 * pack and appending site-specific entries to CONVERSION_SEEDS below —
 * zilberman has none yet.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/zilberman --seeds sites/zilberman/seeds/section-templates-seed-data.mjs
 */
import { CANONICAL_SECTION_TEMPLATES } from '../../../packages/core/cli/canonical-seed-data.mjs';

export const SEED_SITE = 'site_zilberman';

export const CONVERSION_SEEDS = CANONICAL_SECTION_TEMPLATES.map(({ objectId, body }) => ({
  objectType: 'section_template',
  objectId,
  body,
}));
