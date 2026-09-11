/**
 * `pricing_table` registry module (W5, plan §4) — product-linked tiers: each
 * tier REFERENCES a product object and its price badge + availability resolve
 * from the SAME commerce data the shop renders at build (no copy drift;
 * repointable — the design-principles litmus). Tier copy (features,
 * description, overrides) is editorial data; money is not.
 */
import { sectionVariantDataSchema, type PricingTableResolved, type SectionComponentDefinition } from './types.js';

export const pricingTableDefinition: SectionComponentDefinition<'pricing_table', PricingTableResolved> = {
  type: 'pricing_table',
  schema: sectionVariantDataSchema('pricing_table'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Pricing table',
    icon: 'tabler:report-money',
    useWhen:
      'Tiered pricing columns whose price/availability resolve live from product objects — compare-plans sections.',
    fieldHints: {
      kicker: { label: 'Kicker', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      description: { label: 'Description', help: 'Plain-text line under the heading.', widget: 'text' },
      tiers: {
        label: 'Tiers',
        help:
          'Each tier references a product object (prod_…) — price and availability come from the product; ' +
          "title/description/features/actionLabel are this table's copy. highlighted marks the featured tier.",
        widget: 'cards',
      },
    },
    defaultData: {
      heading: 'Pricing',
      tiers: [{ product: 'prod_starter_checklist', features: [] }],
    },
  },
};
