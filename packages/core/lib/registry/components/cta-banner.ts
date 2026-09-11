/**
 * `cta_banner` registry module — a closing call-to-action section
 * (CtaBanner.astro). Its `actions` resolve to hrefs the same way hero/lede
 * actions do (HeroResolved.actionHrefs), computed centrally by the renderer
 * (src/lib/renderer/resolve.ts), so this module declares no resolveRefs — the
 * resolved shape is the contract the renderer fills.
 */
import { sectionVariantDataSchema, type HeroResolved, type SectionComponentDefinition } from './types.js';

export const ctaBannerDefinition: SectionComponentDefinition<'cta_banner', HeroResolved> = {
  type: 'cta_banner',
  schema: sectionVariantDataSchema('cta_banner'),
  footprint: { region: 'flow' },
  editor: {
    label: 'CTA banner',
    icon: 'tabler:speakerphone',
    useWhen:
      'Full-width closing call-to-action: heading + buttons. The standard last section routing readers onward from interior and landing pages.',
    fieldHints: {
      heading: { label: 'Heading', widget: 'text' },
      body: { label: 'Body', help: 'Optional supporting copy above the buttons.', widget: 'richtext' },
      actions: { label: 'Actions', help: 'One or more call-to-action buttons.', widget: 'link_actions' },
    },
    defaultData: {
      actions: [],
    },
  },
};
