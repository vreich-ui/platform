export type TaxonomyTermKind = 'category' | 'tag';

type TaxonomyExport = {
  kinds?: Partial<Record<TaxonomyTermKind, { terms?: Array<{ slug?: unknown; term_id?: unknown }> }>>;
};

/** Resolve the stable stored term id for a route slug; never reconstruct ids from slugs. */
export const termIdForSlug = (value: unknown, kind: TaxonomyTermKind, slug: string): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const terms = (value as TaxonomyExport).kinds?.[kind]?.terms;
  if (!Array.isArray(terms)) return undefined;
  const match = terms.find((term) => term?.slug === slug);
  return typeof match?.term_id === 'string' ? match.term_id : undefined;
};
