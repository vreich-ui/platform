/**
 * `timeline` registry module (W10 T10.6 — ratified mint, batch 2). Ordered
 * milestones on a time axis (survey B7: "what to expect over 12 weeks").
 * Distinct from `steps` (procedure, no time semantics) and `checklist`
 * (completion, no ordering narrative).
 */
import { sectionVariantDataSchema, type EmptyResolved, type SectionComponentDefinition } from './types.js';

export const timelineDefinition: SectionComponentDefinition<'timeline', EmptyResolved> = {
  type: 'timeline',
  schema: sectionVariantDataSchema('timeline'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Timeline',
    icon: 'tabler:timeline',
    useWhen:
      'An ordered sequence over TIME — "what to expect over 12 weeks", a treatment or delivery arc. Use steps for a procedure the reader performs, checklist for do-this items.',
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      milestones: {
        label: 'Milestones',
        help: 'Two to eight entries: label, optional period ("Week 1–2"), and a short description.',
        widget: 'cards',
      },
      anchor: { label: 'Anchor', help: 'Public URL fragment for this section.', widget: 'text' },
    },
    defaultData: {
      milestones: [
        { label: 'Getting started', period: 'Week 1', description: 'What happens first.' },
        { label: 'Seeing change', period: 'Week 4', description: 'What to expect by now.' },
      ],
    },
  },
};
