/**
 * `contact_form` registry module — a Netlify Forms contact form
 * (ContactForm.astro). No references to resolve (EmptyResolved). The field set
 * (name/email/message) is a fixed affordance; the schema carries only the
 * posting identity, heading, and disclaimer.
 */
import { sectionVariantDataSchema, type EmptyResolved, type SectionComponentDefinition } from './types.js';

export const contactFormDefinition: SectionComponentDefinition<'contact_form', EmptyResolved> = {
  type: 'contact_form',
  schema: sectionVariantDataSchema('contact_form'),
  footprint: { region: 'flow', singleton: true },
  editor: {
    label: 'Contact form',
    icon: 'tabler:mail',
    useWhen:
      "The Netlify-backed contact form with heading and disclaimer — the contact page's working section or an embedded inquiry block.",
    fieldHints: {
      heading: { label: 'Heading', widget: 'text' },
      subtitle: { label: 'Subtitle', help: 'Optional intro line under the heading.', widget: 'text' },
      description: { label: 'Description', help: 'Optional fine print above the form fields.', widget: 'text' },
      formName: {
        label: 'Form name',
        help: 'The Netlify form identity submissions are grouped under.',
        widget: 'text',
      },
      disclaimer: { label: 'Disclaimer', help: 'Optional fine print shown under the form.', widget: 'text' },
    },
    defaultData: {
      formName: 'contact',
      heading: 'Get in touch',
    },
  },
};
