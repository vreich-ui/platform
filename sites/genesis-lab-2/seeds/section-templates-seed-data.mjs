/**
 * Baseline starter section-template RECIPES for 'site_genesis_lab_2' (T11.7
 * create-site scaffold) — the nine core-provided CANONICAL starter shapes
 * every client gets (T14.1, packages/core/cli/canonical-seed-data.mjs):
 * a landing hero, a curated audience/feature grid, an automatic
 * related-articles strip, a newsletter CTA, a closing CTA banner, a media
 * gallery, a stats band, a comparison matrix, and an expectations timeline.
 * All blueprint copy is neutral starter text — a recipe supplies structure,
 * an agent replaces the copy before publishing. Recipe ids are stable across
 * the fleet (they carry no client-specific data, so there is no reason for
 * a client's copy to diverge from the canonical starter set) — bodies are
 * IMPORTED from the canonical pack, never restated, so this scaffold cannot
 * drift from the rest of the fleet the way the pre-T14.1 copies did.
 *
 * A site adds its OWN recipes by importing what it needs from the canonical
 * pack and appending site-specific entries to CONVERSION_SEEDS below.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/genesis-lab-2 --seeds sites/genesis-lab-2/seeds/section-templates-seed-data.mjs
 */
import { CANONICAL_SECTION_TEMPLATES } from '../../../packages/core/cli/canonical-seed-data.mjs';

export const SEED_SITE = 'site_genesis_lab_2';

export const CONVERSION_SEEDS = CANONICAL_SECTION_TEMPLATES.map(({ objectId, body }) => ({
  objectType: 'section_template',
  objectId,
  body,
}));
