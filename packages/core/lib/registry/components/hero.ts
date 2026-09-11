/**
 * `hero` registry module (T3.2, D§3.5). Schema is the live section-v1
 * variant; the Astro component binds in ./index.ts (see types.ts on the
 * split). resolveRefs (action targets → hrefs) is wired by the T3.6
 * renderer; HeroResolved in types.ts is its contract.
 */
import { sectionVariantDataSchema, type HeroResolved, type SectionComponentDefinition } from './types.js';

export const heroDefinition: SectionComponentDefinition<'hero', HeroResolved> = {
  type: 'hero',
  schema: sectionVariantDataSchema('hero'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Hero',
    icon: 'tabler:sparkles',
    useWhen:
      'Big campaign-weight page opener: kicker, large heading, intro, CTA buttons. Use once, first, on landing/offer pages — interior pages usually want the quieter lede.',
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      body: { label: 'Body', help: 'One or more paragraphs; the first renders larger.', widget: 'richtext' },
      actions: { label: 'Buttons', widget: 'link_actions' },
    },
    defaultData: {
      heading: 'New page heading',
      actions: [],
    },
  },
};
