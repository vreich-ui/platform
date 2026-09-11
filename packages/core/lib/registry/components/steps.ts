/**
 * `steps` registry module (W5, plan §4) — an ordered process strip ("how it
 * works"): numbered (or iconed) titled steps. Ordering is the semantic that
 * distinguishes it from a content_grid card grid. No references: resolved is
 * empty.
 */
import { sectionVariantDataSchema, type EmptyResolved, type SectionComponentDefinition } from './types.js';

export const stepsDefinition: SectionComponentDefinition<'steps', EmptyResolved> = {
  type: 'steps',
  schema: sectionVariantDataSchema('steps'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Steps',
    icon: 'tabler:list-numbers',
    useWhen:
      "A numbered sequence — how-it-works, protocols, onboarding paths. Use when order matters; checklist when it doesn't.",
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      items: {
        label: 'Steps',
        help: 'Ordered steps. Each has a title, optional description, optional Tabler icon (numbered when absent).',
        widget: 'cards',
      },
    },
    defaultData: {
      heading: 'How it works',
      items: [{ title: 'First step' }],
    },
  },
};
