/**
 * `content_search` — the pure half (no I/O, no store, no deps).
 *
 * ## Why this exists
 *
 * Before this module an agent that wanted to edit an existing article had two
 * options, and both were bad. It could `object_list('content_item')` and then
 * `object_get` its way down the list looking for the right slug — N+1 blob
 * reads to answer "which object is /nac-for-skin-health" — or it could be
 * handed the `req_*` object id out of band by a human. The second is why the
 * ChatGPT plugin sessions kept stalling on "what is the request id?": the id
 * is an internal minting detail, and the agent has no way to derive it from
 * the one thing it always has, which is the URL or the headline.
 *
 * So this is a resolver first and a search engine second. `slug`, `url` and
 * `route` are IDENTITY lookups and score exactly 1.0 on an exact hit — the
 * caller gets `canonical_result` and goes straight to `object_get` /
 * `object_checkout` / `object_patch` / `object_publish`. `title` and `query`
 * are the ranked fallback for when the caller only knows what the thing was
 * called.
 *
 * ## Why the matching is hand-rolled
 *
 * The repo's standing rule is no new dependencies for a change this size, and
 * a stemmer/BM25 package would be a poor trade anyway: the corpus is a few
 * hundred short documents of curated editorial metadata, not prose at scale.
 * Everything here is O(docs x query tokens) over an already-projected index,
 * with a bounded Levenshtein for typo tolerance.
 *
 * ## What is deliberately NOT searched
 *
 * Article body prose. The searchable surface is the metadata an editor names
 * a piece by — slug, title, SEO title, meta description, route, taxonomy,
 * tags, headings, aliases. Indexing body text would multiply the index blob
 * by ~50x to make "find the article that mentions X somewhere" work, which is
 * a different tool with a different cost profile. If that is wanted later it
 * belongs behind its own flag, not smuggled into the resolver's steady state.
 */

// ─── document shape ───────────────────────────────────────────────────────────

/**
 * The projected, cached form of one object. Every field is a pure function of
 * the record, which is what lets `search-index-store.ts` cache it against the
 * blob etag and never re-read an unchanged record.
 */
export type SearchDoc = {
  object_id: string;
  object_type: string;
  status: 'active' | 'archived';
  published: boolean;
  published_time: string | null;
  updated_at: string | null;
  /** The article slug (content_item) or the last route segment (page). */
  slug: string | null;
  title: string | null;
  description: string | null;
  /** Public path, always normalized: leading slash, no trailing slash, lowercased. */
  route: string | null;
  seo_title: string | null;
  seo_description: string | null;
  category: string | null;
  tags: string[];
  headings: string[];
  aliases: string[];
  /**
   * The article-pipeline request id. content_item ids ARE request ids by
   * construction (`req_*`), so this is the same string — surfaced under the
   * name callers already use rather than making them know that.
   */
  request_id: string | null;
};

export type SearchCriteria = {
  query?: string;
  slug?: string;
  url?: string;
  route?: string;
  title?: string;
  request_id?: string;
  /** Default true. false = exact/prefix matching only, no edit-distance. */
  fuzzy?: boolean;
};

export type SearchResult = SearchDoc & {
  score: number;
  /** Which supplied criteria contributed a non-zero score, best first. */
  matched_on: string[];
};

/** Results below this are noise, not near-misses, and are dropped. */
export const MIN_SCORE = 0.25;
/** `canonical_result` is only set above this — the spec's ">0.95 confidence". */
export const CANONICAL_SCORE = 0.95;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

// ─── normalization ────────────────────────────────────────────────────────────

/** Lowercased, de-accented, punctuation-to-space, whitespace-collapsed. */
export const normalizeText = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Words too common to distinguish two articles from each other. Dropped only
 * when something else survives — a query of literally "the" still searches for
 * "the" rather than for nothing.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'how', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'why', 'with', 'your',
]);

export const tokenize = (value: string): string[] => {
  const all = normalizeText(value).split(' ').filter(Boolean);
  const kept = all.filter((token) => !STOPWORDS.has(token));
  return kept.length > 0 ? kept : all;
};

/** `NAC for Skin Health` / `nac_for_skin_health` → `nac-for-skin-health`. */
export const slugify = (value: string): string => normalizeText(value).replace(/ /g, '-');

/**
 * Accepts a full URL, an origin-relative path, or a bare slug and returns the
 * canonical public path. Deliberately string-only: a caller pasting a
 * half-typed URL should get a best-effort path, never a thrown TypeError from
 * `new URL()`.
 *
 *   https://drluriescience.netlify.app/nac-for-skin-health?utm=x → /nac-for-skin-health
 *   /nac-for-skin-health/                                       → /nac-for-skin-health
 *   nac-for-skin-health                                         → /nac-for-skin-health
 */
export const normalizeRoutePath = (value: string): string | null => {
  let raw = value.trim();
  if (!raw) return null;
  const schemeAt = raw.indexOf('://');
  if (schemeAt !== -1) {
    const afterScheme = raw.slice(schemeAt + 3);
    const firstSlash = afterScheme.indexOf('/');
    raw = firstSlash === -1 ? '/' : afterScheme.slice(firstSlash);
  }
  raw = (raw.split('#')[0] ?? '').split('?')[0] ?? '';
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* a malformed %-escape is data, not a reason to fail the lookup */
  }
  raw = raw.trim().toLowerCase();
  if (!raw || raw === '/') return raw === '/' ? '/' : null;
  const trimmed = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed ? `/${trimmed}` : '/';
};

// ─── bounded edit distance ────────────────────────────────────────────────────

/** Longer than this and character-level typo tolerance stops being meaningful. */
const MAX_FUZZY_LEN = 64;

/** Classic two-row Levenshtein, length-capped so a pathological input can't dominate a sweep. */
export const editDistance = (a: string, b: string): number => {
  const s = a.length > MAX_FUZZY_LEN ? a.slice(0, MAX_FUZZY_LEN) : a;
  const t = b.length > MAX_FUZZY_LEN ? b.slice(0, MAX_FUZZY_LEN) : b;
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  let prev = new Array<number>(t.length + 1);
  let curr = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;

  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost
      );
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[t.length] as number;
};

/** 1 = identical, 0 = nothing in common. */
export const similarity = (a: string, b: string): number => {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const longest = Math.max(Math.min(a.length, MAX_FUZZY_LEN), Math.min(b.length, MAX_FUZZY_LEN));
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
};

/** Below this, an "approximate" match is a coincidence rather than a typo. */
const FUZZY_FLOOR = 0.76;

// ─── field weighting ──────────────────────────────────────────────────────────

/**
 * How much each field is worth as evidence that the caller meant THIS object.
 * Identity-bearing fields (slug, aliases, route, title) sit at or near 1.0;
 * descriptive prose is weaker because two unrelated skincare articles share
 * most of their meta description vocabulary.
 */
const FIELD_WEIGHTS: Record<string, number> = {
  slug: 1,
  aliases: 1,
  title: 1,
  route: 0.9,
  seo_title: 0.85,
  tags: 0.75,
  category: 0.7,
  headings: 0.62,
  description: 0.58,
  seo_description: 0.5,
};

type FieldTokens = { field: string; tokens: string[]; weight: number };

const fieldTokensFor = (doc: SearchDoc): FieldTokens[] => {
  const out: FieldTokens[] = [];
  const push = (field: string, values: Array<string | null | undefined>) => {
    const tokens = values.filter((value): value is string => Boolean(value)).flatMap((value) => tokenize(value));
    if (tokens.length) out.push({ field, tokens, weight: FIELD_WEIGHTS[field] ?? 0.5 });
  };
  push('slug', [doc.slug]);
  push('aliases', doc.aliases);
  push('title', [doc.title]);
  push('route', [doc.route]);
  push('seo_title', [doc.seo_title]);
  push('tags', doc.tags);
  push('category', [doc.category]);
  push('headings', doc.headings);
  push('description', [doc.description]);
  push('seo_description', [doc.seo_description]);
  return out;
};

/** How well one query token matches one field's token bag, 0..1. */
const tokenMatch = (token: string, tokens: string[], fuzzy: boolean): number => {
  let best = 0;
  for (const candidate of tokens) {
    if (candidate === token) return 1;
    if (token.length >= 4 && candidate.startsWith(token)) best = Math.max(best, 0.9);
    else if (candidate.length >= 4 && token.startsWith(candidate)) best = Math.max(best, 0.85);
  }
  if (best > 0 || !fuzzy) return best;
  // Typo tolerance is the last resort, and only for tokens long enough for an
  // edit distance to mean something ("nac" vs "nap" is not a typo, it's a
  // different word).
  if (token.length < 5) return 0;
  for (const candidate of tokens) {
    if (Math.abs(candidate.length - token.length) > 3) continue;
    const score = similarity(candidate, token);
    if (score >= FUZZY_FLOOR) best = Math.max(best, score * 0.9);
  }
  return best;
};

// ─── per-criterion scoring ────────────────────────────────────────────────────

const scoreQuery = (doc: SearchDoc, query: string, fuzzy: boolean): number => {
  const tokens = tokenize(query);
  if (!tokens.length) return 0;
  const fields = fieldTokensFor(doc);
  if (!fields.length) return 0;

  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const field of fields) best = Math.max(best, tokenMatch(token, field.tokens, fuzzy) * field.weight);
    total += best;
  }
  let score = total / tokens.length;

  // A whole-phrase hit on an identity field beats any token average — "NAC for
  // Skin Health" against that exact title should not be diluted by "for"
  // matching four other articles.
  const phrase = normalizeText(query);
  if (phrase) {
    if (doc.title && normalizeText(doc.title) === phrase) score = Math.max(score, 0.99);
    else if (doc.slug && doc.slug === slugify(query)) score = Math.max(score, 1);
    else if (doc.title && normalizeText(doc.title).includes(phrase)) score = Math.max(score, 0.9);
    else if (doc.slug && doc.slug.includes(slugify(query))) score = Math.max(score, 0.88);
  }
  return Math.min(score, 1);
};

const scoreTitle = (doc: SearchDoc, title: string, fuzzy: boolean): number => {
  const wanted = normalizeText(title);
  if (!wanted) return 0;
  if (doc.title && normalizeText(doc.title) === wanted) return 1;
  if (doc.seo_title && normalizeText(doc.seo_title) === wanted) return 0.97;
  for (const alias of doc.aliases) if (normalizeText(alias) === wanted) return 0.97;

  let best = 0;
  if (fuzzy) {
    for (const candidate of [doc.title, doc.seo_title, ...doc.aliases]) {
      if (!candidate) continue;
      const score = similarity(normalizeText(candidate), wanted);
      if (score >= FUZZY_FLOOR) best = Math.max(best, score * 0.95);
    }
  }
  // Fall back to token evidence so a partial headline ("skin health") still ranks.
  return Math.max(best, scoreQuery(doc, title, fuzzy) * 0.95);
};

const scoreSlug = (doc: SearchDoc, slug: string, fuzzy: boolean): number => {
  const wanted = slugify(slug);
  if (!wanted) return 0;
  if (doc.slug && doc.slug === wanted) return 1;
  if (doc.route && doc.route === `/${wanted}`) return 1;
  for (const alias of doc.aliases) if (slugify(alias) === wanted) return 0.98;
  if (!fuzzy) return 0;

  let best = 0;
  for (const candidate of [doc.slug, doc.route?.replace(/^\//, '')]) {
    if (!candidate) continue;
    const score = similarity(candidate, wanted);
    if (score >= FUZZY_FLOOR) best = Math.max(best, score * 0.94);
  }
  return best;
};

const scoreRoute = (doc: SearchDoc, route: string, fuzzy: boolean): number => {
  const wanted = normalizeRoutePath(route);
  if (!wanted) return 0;
  if (doc.route && doc.route === wanted) return 1;
  // A content_item's public path is `/${slug}`; a page owns `body.route`.
  // Either may be the thing the caller pasted.
  if (doc.slug && `/${doc.slug}` === wanted) return 1;
  return scoreSlug(doc, wanted.replace(/^\//, ''), fuzzy) * 0.98;
};

const scoreRequestId = (doc: SearchDoc, requestId: string): number => {
  const wanted = requestId.trim().toLowerCase();
  if (!wanted) return 0;
  if (doc.object_id.toLowerCase() === wanted) return 1;
  if (doc.request_id && doc.request_id.toLowerCase() === wanted) return 1;
  if (doc.object_id.toLowerCase().includes(wanted) && wanted.length >= 8) return 0.9;
  return 0;
};

/**
 * One document against the whole criteria bag. Each supplied criterion is
 * INDEPENDENTLY SUFFICIENT (the spec's "any one of slug, url, route, title or
 * query"), so the document's score is the best any criterion gives it, never
 * an average that would punish a perfect slug hit for having no title match.
 */
export const scoreDoc = (doc: SearchDoc, criteria: SearchCriteria): { score: number; matched_on: string[] } => {
  const fuzzy = criteria.fuzzy !== false;
  const scored: Array<{ name: string; score: number }> = [];

  if (criteria.slug) scored.push({ name: 'slug', score: scoreSlug(doc, criteria.slug, fuzzy) });
  if (criteria.url) scored.push({ name: 'url', score: scoreRoute(doc, criteria.url, fuzzy) });
  if (criteria.route) scored.push({ name: 'route', score: scoreRoute(doc, criteria.route, fuzzy) });
  if (criteria.title) scored.push({ name: 'title', score: scoreTitle(doc, criteria.title, fuzzy) });
  if (criteria.query) scored.push({ name: 'query', score: scoreQuery(doc, criteria.query, fuzzy) });
  if (criteria.request_id) scored.push({ name: 'request_id', score: scoreRequestId(doc, criteria.request_id) });

  const hits = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  const score = hits.length ? (hits[0] as { score: number }).score : 0;
  return { score: Math.round(score * 10000) / 10000, matched_on: hits.map((entry) => entry.name) };
};

// ─── ranking ──────────────────────────────────────────────────────────────────

/** Newest-published first, then id — so equal scores never shuffle between calls. */
const tieBreak = (a: SearchResult, b: SearchResult): number => {
  const at = a.published_time ?? '';
  const bt = b.published_time ?? '';
  if (at !== bt) return bt.localeCompare(at);
  return a.object_id.localeCompare(b.object_id);
};

export type RankedSearch = {
  results: SearchResult[];
  canonical_result?: SearchResult;
};

/**
 * Score, filter, sort, truncate — and decide whether the top hit is
 * unambiguous enough to hand back as `canonical_result`.
 *
 * "Exactly one strong match" is enforced literally: a second result at or
 * above the same threshold means the answer is NOT canonical, however good the
 * leader looks. Two articles both scoring 1.0 on a slug lookup is a data
 * problem, and silently picking one would launder it into a wrong edit.
 */
export const rankSearchDocs = (
  docs: readonly SearchDoc[],
  criteria: SearchCriteria,
  limit = DEFAULT_LIMIT
): RankedSearch => {
  const scored: SearchResult[] = [];
  for (const doc of docs) {
    const { score, matched_on } = scoreDoc(doc, criteria);
    if (score < MIN_SCORE) continue;
    scored.push({ ...doc, score, matched_on });
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : tieBreak(a, b)));

  const strong = scored.filter((result) => result.score > CANONICAL_SCORE);
  const capped = Math.min(Math.max(limit, 1), MAX_LIMIT);
  const results = scored.slice(0, capped);
  return strong.length === 1 ? { results, canonical_result: strong[0] as SearchResult } : { results };
};
