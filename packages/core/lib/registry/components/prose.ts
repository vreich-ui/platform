/**
 * `prose` registry module — a reader-width body-copy section (Prose.astro). No
 * references to resolve (EmptyResolved). The single field is the richtext body;
 * the editor renders it with the richtext widget. Growth cost stays "one union
 * member + one module + one component + one binding" (T3.2 pattern).
 */
import { sectionVariantDataSchema, type EmptyResolved, type SectionComponentDefinition } from './types.js';

export const proseDefinition: SectionComponentDefinition<'prose', EmptyResolved> = {
  type: 'prose',
  schema: sectionVariantDataSchema('prose'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Prose',
    icon: 'tabler:align-left',
    useWhen:
      'Long-form body copy — headings, paragraphs, lists. The workhorse for any explanatory, editorial, or legal text; reach for it before anything more structured.',
    fieldHints: {
      body: { label: 'Body', help: 'Reader-width body copy. Paragraphs only.', widget: 'richtext' },
    },
    defaultData: {
      body: '<p></p>',
    },
  },
};
