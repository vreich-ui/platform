/**
 * `composition` registry module (T12.31) — the one composable section: an
 * ordered sequence of copy, imagery and calls-to-action.
 *
 * It exists for the residue a site capture cannot fit into a named type — a
 * source block carrying copy AND images, or images AND links, which any single
 * named shape would have to drop half of. Prefer a named type whenever one
 * fits; this is the fallback, not the default.
 */
import { sectionVariantDataSchema, type CompositionResolved, type SectionComponentDefinition } from './types.js';

export const compositionDefinition: SectionComponentDefinition<'composition', CompositionResolved> = {
  type: 'composition',
  schema: sectionVariantDataSchema('composition'),
  editor: {
    label: 'Composition',
    icon: 'tabler:layout-list',
    useWhen:
      'A block of mixed content that no named section fits — copy, images and links interleaved in a specific order. Reach for a named type first; this one has no layout opinion of its own.',
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      images: {
        label: 'Images',
        help: 'The section’s images ({src, alt}) on site-asset hosts. Blocks reference these by position.',
        widget: 'cards',
      },
      blocks: {
        label: 'Blocks',
        help: 'The ordered sequence: text (rich text), actions (CTA buttons), or image (by position in Images).',
        widget: 'cards',
      },
      anchor: { label: 'Anchor', help: 'Optional id for in-page links.', widget: 'text' },
    },
    defaultData: {
      images: [],
      blocks: [{ kind: 'text', body: '<p>Mixed content in source order.</p>' }],
    },
  },
};
