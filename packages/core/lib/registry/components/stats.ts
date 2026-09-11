/**
 * `stats` registry module (W10 T10.5 — ratified mint, batch 1). The number
 * band (survey A4 + C6): 2–6 large value + label (+ sublabel) items. Values
 * are short bounded strings ("10k+", "4.9★", "97%") — semantics live in the
 * copy, never in free markup.
 */
import { sectionVariantDataSchema, type EmptyResolved, type SectionComponentDefinition } from './types.js';

export const statsDefinition: SectionComponentDefinition<'stats', EmptyResolved> = {
  type: 'stats',
  schema: sectionVariantDataSchema('stats'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Stats',
    icon: 'tabler:chart-bar',
    useWhen:
      'A band of headline numbers — metrics, ratings, counts ("10k readers · 97% satisfaction"). Not a checklist (no prose per item) and not a content grid (no links or images).',
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      items: {
        label: 'Stats',
        help: 'Two to six items: a short value (e.g. "10k+"), a label, and an optional sublabel.',
        widget: 'cards',
      },
      anchor: { label: 'Anchor', help: 'Public URL fragment for this section.', widget: 'text' },
    },
    defaultData: {
      items: [
        { value: '10k+', label: 'Readers' },
        { value: '97%', label: 'Satisfaction' },
      ],
    },
  },
};
