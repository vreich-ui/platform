/**
 * `media` registry module (W10 T10.5 — ratified mint, batch 1). Standalone
 * image / gallery / video section (survey B2 + C3: figure with caption,
 * before/after or portfolio gallery, video feature). Video folded in per the
 * T10.4 ruling: `kind: 'video'` carries provider + regex-pinned ID only —
 * the embed URL is a code-owned template in Media.astro, so data can never
 * smuggle a src (the write+render safety posture).
 */
import { sectionVariantDataSchema, type EmptyResolved, type SectionComponentDefinition } from './types.js';

export const mediaDefinition: SectionComponentDefinition<'media', EmptyResolved> = {
  type: 'media',
  schema: sectionVariantDataSchema('media'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Media',
    icon: 'tabler:photo',
    useWhen:
      'A standalone image, gallery, or video block — figures with captions, before/after strips, a video feature. Not for images inside article prose (those live in rich text) and not a content grid (no linked cards here).',
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      layout: {
        label: 'Layout',
        help: "'single' (one large figure), 'grid' (2-column gallery), or 'strip' (horizontal row).",
        widget: 'select',
      },
      items: {
        label: 'Media items',
        help: 'Images (src + alt + optional caption) or videos (provider + video ID — never a URL).',
        widget: 'cards',
      },
      anchor: { label: 'Anchor', help: 'Public URL fragment for this section (e.g. "gallery").', widget: 'text' },
    },
    defaultData: {
      layout: 'single',
      items: [{ kind: 'image', src: '/images/default.png', alt: 'Placeholder image' }],
    },
  },
};
