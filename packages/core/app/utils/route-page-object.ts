/**
 * Route page-object loader (W6/T6.1) — how the LISTING surfaces (blog
 * library/category/tag, topics hub) and the article route read their editable
 * copy + SEO from a published Page object while their query machinery stays
 * the audited build-time derivation (A§2.5–2.7).
 *
 * The contract per surface:
 *
 *   - The page object's FIRST visible `lede` section is the surface's header
 *     block (`listing` PageType requires one): kicker + heading + body
 *     paragraphs, rendered by the surface's own header furniture (the list
 *     markup, pagination, topic cards, and back-links stay code furniture —
 *     exactly like the contact form's field set).
 *   - Every REMAINING visible section renders through the component registry
 *     via <ObjectSections /> after the derived furniture — an agent can put a
 *     cta_banner or newsletter_signup below the list/article with one patch op.
 *   - `title` and `seo` feed the route's metadata; the loader keeps the
 *     pagination suffixes and robots gating as furniture.
 *   - Per-term surfaces pass `term`: every `%term%` token in the body/title/seo
 *     is replaced with the concrete term's display label (listing-term.ts).
 *
 * Absent export → undefined, and the caller falls back to its pre-conversion
 * literals (the W4 site-object pattern) — builds keep working before the
 * seeds materialize. A PRESENT but invalid export still throws loudly
 * (parsePageExport): a corrupt committed export must fail the build, never
 * silently regress to stale copy.
 */
import { getEntry } from 'astro:content';

import { applyListingTerm } from '../../lib/renderer/listing-term';
import { termIdForSlug, type TaxonomyTermKind } from '../../lib/tracking/term-identity';
import { parsePageExport } from '../../lib/renderer/resolve';
import { sectionAnnotationAttrs, type SectionAnnotationAttrs } from '../../lib/renderer/section-annotations';
import { splitRichTextParagraphs } from '../../lib/richtext/paragraphs';
import type { PageBody } from '../../schema/bodies/page-v1';

export type RoutePageHeader = {
  kicker?: string;
  heading: string;
  /** Inner-HTML of each body paragraph (allowlist inline tags only). */
  paragraphs: string[];
  /**
   * The header lede's stable section id — the edit-mode canvas annotation
   * target, so a listing surface's primary object-backed copy gets a hover
   * chip like any dispatched section. Absent on the pre-conversion literal
   * fallback (no object backs it).
   */
  sectionId?: string;
};

export type RoutePageObject = {
  /** page.title, term-interpolated — the metadata title base (suffixes are furniture). */
  title: string;
  /** page.seo, term-interpolated — description/ogImage/robots defaults for the route. */
  seo: PageBody['seo'];
  /** The first visible lede, as header copy; undefined when the page has none. */
  header?: RoutePageHeader;
  /** Every other visible section, in order — render via <ObjectSections />. */
  extraSections: PageBody['sections'];
};

export const loadRoutePageObject = async (objectId: string, term?: string): Promise<RoutePageObject | undefined> => {
  const entry = await getEntry('pageObject', objectId);
  if (!entry) return undefined;

  const parsed = parsePageExport(entry.data);
  const page = term === undefined ? parsed : applyListingTerm(parsed, term);

  const visible = page.sections.filter((section) => section.visibility !== 'hidden');
  const headerIndex = visible.findIndex((section) => section.type === 'lede');
  const headerSection = headerIndex >= 0 ? visible[headerIndex] : undefined;
  const header: RoutePageHeader | undefined =
    headerSection && headerSection.type === 'lede'
      ? {
          sectionId: headerSection.id,
          ...(headerSection.data.kicker !== undefined ? { kicker: headerSection.data.kicker } : {}),
          heading: headerSection.data.heading,
          paragraphs: splitRichTextParagraphs(headerSection.data.body ?? ''),
        }
      : undefined;

  return {
    title: page.title,
    seo: page.seo,
    header,
    extraSections: visible.filter((_, index) => index !== headerIndex),
  };
};

/**
 * The edit-mode canvas annotation for a listing route's header lede, so its
 * object-backed heading/body carries a hover chip like any dispatched section.
 * `undefined` when the header is the pre-conversion literal fallback (no
 * object) — spreading it onto the wrapper then adds no attributes, and the
 * canvas ignores an unannotated region.
 */
export const routeHeaderAnnotation = (
  objectId: string,
  header: RoutePageHeader | undefined
): SectionAnnotationAttrs | undefined =>
  header?.sectionId ? sectionAnnotationAttrs(objectId, { id: header.sectionId, type: 'lede' }) : undefined;

export const resolveRouteTermId = async (kind: TaxonomyTermKind, slug: string): Promise<string | undefined> => {
  const entry = await Promise.resolve(getEntry('taxonomyObject', 'taxonomy')).catch(() => undefined);
  return termIdForSlug(entry?.data, kind, slug);
};
