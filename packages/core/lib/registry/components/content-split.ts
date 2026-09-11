/**
 * `content_split` registry module (W5, plan §4) — text + media split: kicker/
 * heading/paragraph body/actions beside one or two images. The reusable
 * generic the bespoke shop-preview hero became; `reverse` flips the columns.
 * Action hrefs resolve centrally (ContentSplitResolved).
 */
import { sectionVariantDataSchema, type ContentSplitResolved, type SectionComponentDefinition } from './types.js';

export const contentSplitDefinition: SectionComponentDefinition<'content_split', ContentSplitResolved> = {
  type: 'content_split',
  schema: sectionVariantDataSchema('content_split'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Content split',
    icon: 'tabler:layout-columns',
    useWhen:
      'Two-column copy-beside-media row with optional CTAs — alternating feature explainers, product stories; reverse flips the columns.',
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      body: { label: 'Body', help: 'Paragraph-only rich text (<p> blocks).', widget: 'richtext' },
      actions: { label: 'Actions', help: 'CTA buttons beside the copy.', widget: 'cards' },
      images: {
        label: 'Images',
        help: 'One or two images ({src, alt}) on site-asset hosts; the second staggers on wide screens.',
        widget: 'cards',
      },
      reverse: { label: 'Reverse columns', help: 'Media left, copy right.', widget: 'text' },
    },
    defaultData: {
      heading: 'A split section',
      body: '<p>Copy beside media.</p>',
      actions: [],
      images: [],
    },
  },
};
