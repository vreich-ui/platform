/**
 * `product_preview` registry module (S2) — a product card grid over PRODUCT
 * objects (ProductPreview.astro). `manual`/`query` sources resolve to cards
 * (title/excerpt/image/price badge/href) centrally in the renderer via the
 * M-8 semantics; a `cards` source renders curated cells with only their
 * optional actions resolved. This module declares no resolveRefs — the
 * resolved shape is the contract the renderer fills.
 */
import { sectionVariantDataSchema, type ProductPreviewResolved, type SectionComponentDefinition } from './types.js';

export const productPreviewDefinition: SectionComponentDefinition<'product_preview', ProductPreviewResolved> = {
  type: 'product_preview',
  schema: sectionVariantDataSchema('product_preview'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Product preview',
    icon: 'tabler:shopping-bag',
    useWhen:
      'Product cards resolved live from shop objects (hand-picked, query, or curated cells) with price badges — the buy-adjacent grid on content pages.',
    fieldHints: {
      heading: { label: 'Heading', widget: 'text' },
      source: {
        label: 'Products source',
        help:
          "Where the cards come from: 'query' (every available product), 'manual' (curated prod_… ids with an " +
          "optional query-fallback backfill), or 'cards' (hand-written cells). Retired/coming_soon products " +
          'never render.',
        widget: 'cards',
      },
      limit: { label: 'Max cards', widget: 'text' },
    },
    defaultData: {
      heading: 'Products',
      source: { kind: 'query', query: {} },
      limit: 6,
    },
  },
};
