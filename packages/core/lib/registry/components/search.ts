/**
 * `search` registry module — a site-search box over a JSON index route
 * (Search.astro). No references to resolve (EmptyResolved). The index route is
 * data; the box + client filtering are the fixed affordance.
 */
import { sectionVariantDataSchema, type EmptyResolved, type SectionComponentDefinition } from './types.js';

export const searchDefinition: SectionComponentDefinition<'search', EmptyResolved> = {
  type: 'search',
  schema: sectionVariantDataSchema('search'),
  footprint: { region: 'flow', singleton: true },
  editor: {
    label: 'Search',
    icon: 'tabler:search',
    useWhen: "The site search widget — the /search page's working section; rarely useful elsewhere.",
    fieldHints: {
      placeholder: { label: 'Placeholder', help: 'Input placeholder text.', widget: 'text' },
      indexRoute: { label: 'Index route', help: 'The JSON search index to query (e.g. /search.json).', widget: 'text' },
    },
    defaultData: {
      indexRoute: '/search.json',
    },
  },
};
