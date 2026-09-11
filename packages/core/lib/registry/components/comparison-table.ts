/**
 * `comparison_table` registry module (W10 T10.6 — ratified mint, batch 2).
 * A bounded feature matrix (survey A12): 2–4 columns × ≤12 rows; cells are
 * booleans (rendered as check/dash) or short strings. Not pricing_table
 * (product-object-bound money truth) and not prose tables (not
 * agent-configurable data).
 */
import { sectionVariantDataSchema, type EmptyResolved, type SectionComponentDefinition } from './types.js';

export const comparisonTableDefinition: SectionComponentDefinition<'comparison_table', EmptyResolved> = {
  type: 'comparison_table',
  schema: sectionVariantDataSchema('comparison_table'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Comparison table',
    icon: 'tabler:table',
    useWhen:
      'A feature matrix comparing 2–4 things (us-vs-them, plan A vs plan B) with yes/no or short-text cells. Use pricing_table when the columns are purchasable products.',
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      columns: { label: 'Columns', help: 'Two to four column headers; one may be highlighted.', widget: 'cards' },
      rows: {
        label: 'Rows',
        help: 'Feature rows: a label plus one cell per column (true/false or short text; missing cells render as —).',
        widget: 'cards',
      },
      anchor: { label: 'Anchor', help: 'Public URL fragment for this section.', widget: 'text' },
    },
    defaultData: {
      columns: [{ label: 'Option A' }, { label: 'Option B', highlighted: true }],
      rows: [{ label: 'A feature', cells: [true, true] }],
    },
  },
};
