/**
 * `form_confirmation` registry module — the reusable post-submit confirmation
 * section (FormConfirmation.astro; today's /thank-you is one instance). Its
 * `actions` resolve to hrefs the same way hero/lede actions do (HeroResolved),
 * computed centrally by the renderer (src/lib/renderer/resolve.ts), so this
 * module declares no resolveRefs. Renamed from `thank_you` (2026-07-11).
 */
import { sectionVariantDataSchema, type HeroResolved, type SectionComponentDefinition } from './types.js';

export const formConfirmationDefinition: SectionComponentDefinition<'form_confirmation', HeroResolved> = {
  type: 'form_confirmation',
  schema: sectionVariantDataSchema('form_confirmation'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Form confirmation',
    icon: 'tabler:circle-check',
    useWhen: 'Post-submit thank-you block with per-form message overrides — confirmation/thank-you pages only.',
    fieldHints: {
      eyebrow: { label: 'Eyebrow', help: 'Small uppercase lead-in above the title.', widget: 'text' },
      heading: { label: 'Title', help: 'Fallback title shown when no per-form override matches.', widget: 'text' },
      message: { label: 'Message', help: 'Fallback message shown when no per-form override matches.', widget: 'text' },
      formMessages: {
        label: 'Per-form messages',
        help: 'Title/message overrides keyed by the ?form= query value.',
        widget: 'cards',
      },
      actions: { label: 'Actions', help: 'Call-to-action buttons.', widget: 'link_actions' },
    },
    defaultData: {
      heading: 'Thank you.',
      message: 'Your submission has been received.',
      formMessages: [],
      actions: [],
    },
  },
};
