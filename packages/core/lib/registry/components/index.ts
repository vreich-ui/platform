/**
 * Component registry v1 (T3.2, D§3.5) — the dispatch table the T3.6 renderer
 * (and the admin preview, D§4.4) will use. This file is the ONLY place a
 * section type meets its Astro component; everything else about a type lives
 * in its per-type module (see types.ts for why the binding is centralized:
 * per-type modules stay pure TS so the node test harness can execute them).
 *
 * `shared_ref` is deliberately absent: the renderer dereferences it to the
 * target section's variant BEFORE dispatch (D§3.5), so no component ever
 * sees a reference. Types in the section union without a registry entry
 * (prose, faq, …) fail lookup loudly — they gain entries when a migration
 * needs them, one module + one binding each.
 */
import type { AstroComponentFactory } from 'astro/runtime/server/index.js';

import Bio from '../../../components/sections/Bio.astro';
import Checklist from '../../../components/sections/Checklist.astro';
import ContactForm from '../../../components/sections/ContactForm.astro';
import ContentEmbed from '../../../components/sections/ContentEmbed.astro';
import ContentGrid from '../../../components/sections/ContentGrid.astro';
import Composition from '../../../components/sections/Composition.astro';
import ContentSplit from '../../../components/sections/ContentSplit.astro';
import CtaBanner from '../../../components/sections/CtaBanner.astro';
import Faq from '../../../components/sections/Faq.astro';
import Hero from '../../../components/sections/Hero.astro';
import Lede from '../../../components/sections/Lede.astro';
import LinkList from '../../../components/sections/LinkList.astro';
import NewsletterSignup from '../../../components/sections/NewsletterSignup.astro';
import ProductPreview from '../../../components/sections/ProductPreview.astro';
import PricingTable from '../../../components/sections/PricingTable.astro';
import Prose from '../../../components/sections/Prose.astro';
import FormConfirmation from '../../../components/sections/FormConfirmation.astro';
import Search from '../../../components/sections/Search.astro';
import Steps from '../../../components/sections/Steps.astro';
import BrandRow from '../../../components/sections/BrandRow.astro';
import ComparisonTable from '../../../components/sections/ComparisonTable.astro';
import Media from '../../../components/sections/Media.astro';
import Stats from '../../../components/sections/Stats.astro';
import Timeline from '../../../components/sections/Timeline.astro';
import Testimonial from '../../../components/sections/Testimonial.astro';

import { bioDefinition } from './bio.js';
import { checklistDefinition } from './checklist.js';
import { contactFormDefinition } from './contact-form.js';
import { contentEmbedDefinition } from './content-embed.js';
import { contentGridDefinition } from './content-grid.js';
import { compositionDefinition } from './composition.js';
import { contentSplitDefinition } from './content-split.js';
import { ctaBannerDefinition } from './cta-banner.js';
import { faqDefinition } from './faq.js';
import { heroDefinition } from './hero.js';
import { ledeDefinition } from './lede.js';
import { linkListDefinition } from './link-list.js';
import { newsletterSignupDefinition } from './newsletter-signup.js';
import { productPreviewDefinition } from './product-preview.js';
import { pricingTableDefinition } from './pricing-table.js';
import { proseDefinition } from './prose.js';
import { formConfirmationDefinition } from './form-confirmation.js';
import { searchDefinition } from './search.js';
import { stepsDefinition } from './steps.js';
import { brandRowDefinition } from './brand-row.js';
import { comparisonTableDefinition } from './comparison-table.js';
import { mediaDefinition } from './media.js';
import { statsDefinition } from './stats.js';
import { timelineDefinition } from './timeline.js';
import { testimonialDefinition } from './testimonial.js';
import type { RegisteredSectionType } from './registered-types.js';
import type {
  SectionComponentDefinition,
  SectionType,
} from './types.js';

export type RegisteredComponent = {
  definition: SectionComponentDefinition<SectionType, unknown>;
  component: AstroComponentFactory;
};

const bind = <TType extends SectionType, TResolved>(
  definition: SectionComponentDefinition<TType, TResolved>,
  component: unknown
): RegisteredComponent => ({
  definition: definition as SectionComponentDefinition<SectionType, unknown>,
  component: component as AstroComponentFactory,
});

// Typed as a TOTAL record over REGISTERED_SECTION_TYPES: a binding missing from
// (or absent in) the list is a compile error, so the two cannot drift.
export const componentRegistry: Record<RegisteredSectionType, RegisteredComponent> = {
  hero: bind(heroDefinition, Hero),
  lede: bind(ledeDefinition, Lede),
  prose: bind(proseDefinition, Prose),
  checklist: bind(checklistDefinition, Checklist),
  content_grid: bind(contentGridDefinition, ContentGrid),
  bio: bind(bioDefinition, Bio),
  newsletter_signup: bind(newsletterSignupDefinition, NewsletterSignup),
  testimonial: bind(testimonialDefinition, Testimonial),
  cta_banner: bind(ctaBannerDefinition, CtaBanner),
  faq: bind(faqDefinition, Faq),
  link_list: bind(linkListDefinition, LinkList),
  product_preview: bind(productPreviewDefinition, ProductPreview),
  contact_form: bind(contactFormDefinition, ContactForm),
  search: bind(searchDefinition, Search),
  content_embed: bind(contentEmbedDefinition, ContentEmbed),
  form_confirmation: bind(formConfirmationDefinition, FormConfirmation),
  steps: bind(stepsDefinition, Steps),
  media: bind(mediaDefinition, Media),
  brand_row: bind(brandRowDefinition, BrandRow),
  stats: bind(statsDefinition, Stats),
  timeline: bind(timelineDefinition, Timeline),
  comparison_table: bind(comparisonTableDefinition, ComparisonTable),
  content_split: bind(contentSplitDefinition, ContentSplit),
  composition: bind(compositionDefinition, Composition),
  pricing_table: bind(pricingTableDefinition, PricingTable),
};

export const getRegisteredComponent = (type: SectionType): RegisteredComponent => {
  const entry = (componentRegistry as Partial<Record<SectionType, RegisteredComponent>>)[type];
  if (!entry) {
    throw new Error(
      `No component registered for section type '${type}' — add its registry module and binding (one of each, T3.2 pattern) before rendering it.`
    );
  }
  return entry;
};
