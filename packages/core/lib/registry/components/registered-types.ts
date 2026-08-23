/**
 * The section types that have a bound Astro component (T3.2/T3.13/T4.2) — the
 * ones actually renderable on a page today. Kept in a standalone, client-safe
 * module (no `.astro` imports) so it can be consumed by the Netlify function
 * bundle: the object-contract serializer (to mark `component_bound`) and the
 * validation-context `componentTypeExists` resolver both read it, and neither
 * can import `index.ts` (which pulls the `.astro` components).
 *
 * `index.ts` types its `componentRegistry` as a TOTAL `Record` over this list,
 * so adding a binding without listing it here (or vice-versa) is a compile
 * error — the two cannot drift.
 */
import type { SectionType } from '../../../schema/bodies/section-v1.js';

export const REGISTERED_SECTION_TYPES = [
  'hero',
  'lede',
  'prose',
  'checklist',
  'content_grid',
  'bio',
  'newsletter_signup',
  'testimonial',
  'cta_banner',
  'faq',
  'link_list',
  'product_preview',
  'contact_form',
  'search',
  'content_embed',
  'form_confirmation',
  'steps',
  'content_split',
  'pricing_table',
  'media',
  'brand_row',
  'stats',
  'timeline',
  'comparison_table',
  'composition',
] as const satisfies readonly SectionType[];

export type RegisteredSectionType = (typeof REGISTERED_SECTION_TYPES)[number];

export const isRegisteredSectionType = (type: string): type is RegisteredSectionType =>
  (REGISTERED_SECTION_TYPES as readonly string[]).includes(type);

/**
 * The section types legal as a STANDALONE instance — directly in a page's
 * `sections[]` (alongside `shared_ref` pointers, which the caller allows
 * separately), as a shared 'section' object's wrapped instance, or as a
 * section-template blueprint (W8). Exactly the component-bound list: `card`
 * is a block-tree LEAF (rendered only inside a content_grid `cards` source —
 * it parses under the section union but has no standalone component, so the
 * build dies with "No component registered", the Session-K gap), and
 * `shared_ref` is a pointer, never a concrete instance. One predicate for
 * every enforcement site, so the page rule, the wrapper rule, and the
 * blueprint rule cannot drift.
 */
export const isStandalonePlaceableSectionType = (type: string): type is RegisteredSectionType =>
  isRegisteredSectionType(type);
