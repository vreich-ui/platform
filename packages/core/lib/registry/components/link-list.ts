/**
 * `link_list` registry module — an optional heading over a list of links
 * (LinkList.astro). Each link's target resolves to an href the same way
 * hero/lede actions do (LinkListResolved.linkHrefs), computed centrally by the
 * renderer (src/lib/renderer/resolve.ts), so this module declares no
 * resolveRefs — the resolved shape is the contract the renderer fills.
 */
import { sectionVariantDataSchema, type LinkListResolved, type SectionComponentDefinition } from './types.js';

export const linkListDefinition: SectionComponentDefinition<'link_list', LinkListResolved> = {
  type: 'link_list',
  schema: sectionVariantDataSchema('link_list'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Link list',
    icon: 'tabler:list',
    useWhen:
      "A titled list of plain links — resource hubs, 'start here' indexes, in-page link groups. For card-styled tiles use content_grid instead.",
    fieldHints: {
      heading: { label: 'Heading', widget: 'text' },
      links: {
        label: 'Links',
        help: 'One or more links. Style primary/secondary renders as a button.',
        widget: 'link_actions',
      },
    },
    defaultData: {
      links: [],
    },
  },
};
