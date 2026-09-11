/**
 * `testimonial` registry module (T3.13 extensibility drill, D§3.5).
 *
 * This type has no counterpart in the audited static site — it exists to prove
 * the registry's extensibility promise end-to-end: adding a section type an
 * agent can place on any page costs exactly one union member (section-v1.ts),
 * one registry module (this file), one Astro component (Testimonial.astro), and
 * one binding (index.ts) — nothing else. No references to resolve in v1.
 */
import { sectionVariantDataSchema, type EmptyResolved, type SectionComponentDefinition } from './types.js';

export const testimonialDefinition: SectionComponentDefinition<'testimonial', EmptyResolved> = {
  type: 'testimonial',
  schema: sectionVariantDataSchema('testimonial'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Testimonial',
    icon: 'tabler:quote',
    useWhen: 'Quotes with attribution — social proof placed between content sections; not a card grid.',
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      quotes: { label: 'Quotes', help: 'Reader or expert quotes, each with optional attribution.', widget: 'cards' },
      anchor: { label: 'Anchor', help: 'Public URL fragment for this section (e.g. "reviews").', widget: 'text' },
    },
    defaultData: {
      quotes: [],
    },
  },
};
