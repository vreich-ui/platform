/**
 * `brand_row` registry module (W10 T10.5 — ratified mint, batch 1). The
 * logo strip (survey A2 + C4): press logos, certification badges, partner
 * marks — 2–8 small images with an optional label and optional per-logo
 * targets (resolved through the standard action policy, never raw hrefs in
 * the component).
 */
import { sectionVariantDataSchema, type SectionComponentDefinition } from './types.js';

/** Per-logo resolved hrefs, index-aligned with `data.logos` (undefined = unlinked). */
export type BrandRowResolved = { logoHrefs: (string | undefined)[] };

export const brandRowDefinition: SectionComponentDefinition<'brand_row', BrandRowResolved> = {
  type: 'brand_row',
  schema: sectionVariantDataSchema('brand_row'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Brand row',
    icon: 'tabler:building-store',
    useWhen:
      'A horizontal strip of small logos — "as seen in", certifications, partners. Not a content grid (no copy per item) and not media (logos are identity marks, not figures).',
    fieldHints: {
      heading: { label: 'Label', help: 'Optional small lead-in, e.g. "As seen in".', widget: 'text' },
      logos: {
        label: 'Logos',
        help: 'Two to eight logo images (src + alt); each may carry an optional link target.',
        widget: 'cards',
      },
      anchor: { label: 'Anchor', help: 'Public URL fragment for this section.', widget: 'text' },
    },
    defaultData: {
      logos: [
        { src: '/images/default.png', alt: 'Logo one' },
        { src: '/images/default.png', alt: 'Logo two' },
      ],
    },
  },
};
