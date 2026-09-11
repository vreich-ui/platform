/**
 * `content_grid` registry module (T3.2/T3.9, D§3.5) — the one reusable grid.
 * `manual`/`query` sources render from renderer-resolved content summaries
 * (src/lib/renderer/resolve.ts, M-8 fallback semantics from T3.3); a `cards`
 * source renders curated cells composed directly on the grid (the flat-data
 * form of the block-tree `card` children; replaced the retired `static`
 * escape hatch, 2026-07-10).
 */
import { sectionVariantDataSchema, type ContentGridResolved, type SectionComponentDefinition } from './types.js';

export const contentGridDefinition: SectionComponentDefinition<'content_grid', ContentGridResolved> = {
  type: 'content_grid',
  schema: sectionVariantDataSchema('content_grid'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Content grid',
    icon: 'tabler:layout-grid',
    useWhen:
      'Any repeating card/tile row: curated copy cells (cards), hand-picked articles (manual), an automatic content query, or tag-similar related reading.',
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      body: { label: 'Intro', help: 'Optional paragraph under the heading.', widget: 'richtext' },
      source: {
        label: 'Cards',
        help: 'Where the cards come from: curated cells (kind "cards"), curated article picks (kind "manual", query fallback), or a content query (kind "query").',
        widget: 'cards',
      },
      limit: { label: 'Max cards', widget: 'number' },
      anchor: { label: 'Anchor', help: 'Public URL fragment for this section (e.g. "start-here").', widget: 'text' },
    },
    defaultData: {
      source: { kind: 'manual', items: [] },
      limit: 4,
    },
  },
  // Block-tree bounds: a grid is a CONTAINER of `card` leaf blocks an agent
  // composes (docs/cms-architecture/block-tree.md). `card` is the only legal
  // child; at most 8 cells. The flat `cards` source carries the same bound
  // (CONTENT_GRID_MAX_CARDS in section-v1.ts) until path-addressed block ops
  // exist — keep the two maxima aligned.
  allowedChildren: ['card'],
  childCount: { max: 8 },
};
