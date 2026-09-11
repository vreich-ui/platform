/**
 * `newsletter_signup` registry module (T3.2, D§3.5) — the audited Netlify
 * newsletter form (A§2.4), promoted to a shared section at T3.4. The
 * component owns the form furniture (email label, placeholder, submit
 * wording, aria-label) as fixed affordances of "a newsletter signup"; copy
 * slots (kicker/heading/body/consentText) and the posting identity
 * (formName) are data. The global submit-mirroring to save-opt-in stays
 * layout chrome, not CMS data (C§1.5).
 */
import { sectionVariantDataSchema, type EmptyResolved, type SectionComponentDefinition } from './types.js';

export const newsletterSignupDefinition: SectionComponentDefinition<'newsletter_signup', EmptyResolved> = {
  type: 'newsletter_signup',
  schema: sectionVariantDataSchema('newsletter_signup'),
  footprint: { region: 'flow', singleton: true },
  editor: {
    label: 'Newsletter signup',
    icon: 'tabler:mail',
    useWhen:
      'The email-capture block wired to a Netlify form — the standing mid- or end-of-page conversion ask on content pages.',
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      body: { label: 'Body', widget: 'richtext' },
      formName: {
        label: 'Form name',
        help: 'Netlify form identity; also the ?form= value on the thank-you redirect.',
        widget: 'text',
      },
      consentText: { label: 'Note', help: 'Small print under the form.', widget: 'text' },
      anchor: { label: 'Anchor', help: 'Public URL fragment for this section (e.g. "newsletter").', widget: 'text' },
    },
    defaultData: {
      heading: 'Join the newsletter',
      formName: 'newsletter',
    },
  },
};
