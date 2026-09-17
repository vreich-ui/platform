/**
 * `before_after` — fixed two-image visual comparison. The shape is deliberately
 * narrow: exactly one before image, one after image, one shared caption, and at
 * most one standard link action. Use `media` for galleries or unrelated images.
 */
import {
  sectionVariantDataSchema,
  type BeforeAfterResolved,
  type SectionComponentDefinition,
} from './types.js';

export const beforeAfterDefinition: SectionComponentDefinition<'before_after', BeforeAfterResolved> = {
  type: 'before_after',
  schema: sectionVariantDataSchema('before_after'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Before / after',
    icon: 'tabler:arrows-diff',
    useWhen:
      'A fixed two-image comparison with explicit before/after labels, one shared caption, and an optional CTA. Use media for galleries or unrelated images.',
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      before: { label: 'Before image', help: 'Image src + alt text + visible label.', widget: 'cards' },
      after: { label: 'After image', help: 'Image src + alt text + visible label.', widget: 'cards' },
      caption: { label: 'Caption', help: 'Shared plain-text caption beneath both images.', widget: 'text' },
      action: { label: 'CTA', help: 'Optional single call-to-action using the standard link target.', widget: 'cards' },
      anchor: { label: 'Anchor', help: 'Optional id for in-page links.', widget: 'text' },
    },
    defaultData: {
      before: { src: '/images/default.png', alt: 'Before', label: 'Before' },
      after: { src: '/images/default.png', alt: 'After', label: 'After' },
    },
  },
};
