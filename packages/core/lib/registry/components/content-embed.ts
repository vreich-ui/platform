/**
 * `content_embed` registry module — the bridge to the article grammar
 * (ContentEmbed.astro, D§2.5). Its `contentItem` id resolves to a link card by
 * the renderer (ContentEmbedResolved), computed in PageObjectRenderer from the
 * published posts, so this module declares no resolveRefs — the resolved shape
 * is the contract the renderer fills.
 */
import { sectionVariantDataSchema, type ContentEmbedResolved, type SectionComponentDefinition } from './types.js';

export const contentEmbedDefinition: SectionComponentDefinition<'content_embed', ContentEmbedResolved> = {
  type: 'content_embed',
  schema: sectionVariantDataSchema('content_embed'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Content embed',
    icon: 'tabler:article',
    useWhen: "An inline link-card to ONE published article — 'read this next' placed inside page flow.",
    fieldHints: {
      contentItem: { label: 'Content item', help: 'The id of a published article to link to.', widget: 'text' },
    },
    defaultData: {
      contentItem: 'example-article',
    },
  },
};
