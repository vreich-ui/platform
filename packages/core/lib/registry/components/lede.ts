/**
 * `lede` registry module (T4.2, D§3.5) — the interior-page opener (kicker + h1 +
 * intro + actions). Same field shape as `hero`; distinct component (Lede.astro).
 * resolveRefs (action targets → hrefs) is wired by the T3.6 renderer;
 * HeroResolved in types.ts is the shared contract for the actionHrefs shape.
 */
import { sectionVariantDataSchema, type HeroResolved, type SectionComponentDefinition } from './types.js';

export const ledeDefinition: SectionComponentDefinition<'lede', HeroResolved> = {
  type: 'lede',
  schema: sectionVariantDataSchema('lede'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Lede',
    icon: 'tabler:text-caption',
    useWhen:
      'Quiet interior-page opener: kicker + heading + intro paragraphs. The default first section for standard/system pages; escalate to hero only when the page must sell.',
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      body: { label: 'Intro', help: 'One or more intro paragraphs.', widget: 'richtext' },
      actions: { label: 'Buttons', widget: 'link_actions' },
      anchor: { label: 'Anchor', help: 'Public URL fragment for this section.', widget: 'text' },
    },
    defaultData: {
      heading: 'New page heading',
      actions: [],
    },
  },
};
