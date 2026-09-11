/**
 * `faq` registry module — an optional heading over a question/answer list
 * (Faq.astro). No references to resolve (EmptyResolved). Answers are richtext.
 */
import { sectionVariantDataSchema, type EmptyResolved, type SectionComponentDefinition } from './types.js';

export const faqDefinition: SectionComponentDefinition<'faq', EmptyResolved> = {
  type: 'faq',
  schema: sectionVariantDataSchema('faq'),
  footprint: { region: 'flow' },
  editor: {
    label: 'FAQ',
    icon: 'tabler:help-circle',
    useWhen:
      'Question-and-answer list — objections, logistics, and policy detail that would bloat prose; each answer is short rich text.',
    fieldHints: {
      heading: { label: 'Heading', widget: 'text' },
      items: { label: 'Questions', help: 'Each item is a question and its richtext answer.', widget: 'cards' },
    },
    defaultData: {
      items: [],
    },
  },
};
