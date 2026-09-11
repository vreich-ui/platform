/**
 * Every per-type registry definition, in one pure map (W1 T1.1).
 *
 * WHY IT EXISTS. Three consumers need the definitions WITHOUT the `.astro`
 * bindings — `object-contract.ts` (editor hints, footprints), the region
 * registry, and the composition rules — and `index.ts` cannot serve them
 * because importing it pulls in every Astro component (see types.ts on the
 * split). Before this module, `object-contract.ts` kept its own hand-written
 * map of `.editor` values; adding footprints would have meant a second
 * hand-written map of the same 25 names. One map, three readers.
 *
 * The `Record` is TOTAL over `REGISTERED_SECTION_TYPES`, so a type added to
 * that list without a definition here — or a definition here that is not a
 * registered type — is a compile error, exactly like `index.ts`'s binding map.
 */
import { bioDefinition } from './bio.js';
import { brandRowDefinition } from './brand-row.js';
import { checklistDefinition } from './checklist.js';
import { comparisonTableDefinition } from './comparison-table.js';
import { compositionDefinition } from './composition.js';
import { contactFormDefinition } from './contact-form.js';
import { contentEmbedDefinition } from './content-embed.js';
import { contentGridDefinition } from './content-grid.js';
import { contentSplitDefinition } from './content-split.js';
import { ctaBannerDefinition } from './cta-banner.js';
import { faqDefinition } from './faq.js';
import { formConfirmationDefinition } from './form-confirmation.js';
import { heroDefinition } from './hero.js';
import { ledeDefinition } from './lede.js';
import { linkListDefinition } from './link-list.js';
import { mediaDefinition } from './media.js';
import { newsletterSignupDefinition } from './newsletter-signup.js';
import { pricingTableDefinition } from './pricing-table.js';
import { productPreviewDefinition } from './product-preview.js';
import { proseDefinition } from './prose.js';
import { searchDefinition } from './search.js';
import { statsDefinition } from './stats.js';
import { stepsDefinition } from './steps.js';
import { testimonialDefinition } from './testimonial.js';
import { timelineDefinition } from './timeline.js';
import type { RegisteredSectionType } from './registered-types.js';
import type { SectionComponentDefinition, SectionFootprint, SectionType } from './types.js';

export const SECTION_DEFINITIONS: Record<
  RegisteredSectionType,
  SectionComponentDefinition<SectionType, unknown>
> = {
  hero: heroDefinition,
  lede: ledeDefinition,
  prose: proseDefinition,
  checklist: checklistDefinition,
  content_grid: contentGridDefinition,
  bio: bioDefinition,
  newsletter_signup: newsletterSignupDefinition,
  testimonial: testimonialDefinition,
  cta_banner: ctaBannerDefinition,
  faq: faqDefinition,
  link_list: linkListDefinition,
  product_preview: productPreviewDefinition,
  contact_form: contactFormDefinition,
  search: searchDefinition,
  content_embed: contentEmbedDefinition,
  form_confirmation: formConfirmationDefinition,
  steps: stepsDefinition,
  content_split: contentSplitDefinition,
  pricing_table: pricingTableDefinition,
  media: mediaDefinition,
  brand_row: brandRowDefinition,
  stats: statsDefinition,
  timeline: timelineDefinition,
  comparison_table: comparisonTableDefinition,
  composition: compositionDefinition,
} as Record<RegisteredSectionType, SectionComponentDefinition<SectionType, unknown>>;

/** The declared footprint for a registered kind; `undefined` for `card` / `shared_ref`. */
export const sectionFootprint = (type: string): SectionFootprint | undefined =>
  (SECTION_DEFINITIONS as Record<string, SectionComponentDefinition<SectionType, unknown> | undefined>)[type]
    ?.footprint;
