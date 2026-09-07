/**
 * Record → `SearchDoc` projection: the one place a stored object becomes a
 * searchable document.
 *
 * It is a PURE function of the record, which is the property
 * `search-index-store.ts` depends on to cache a doc against the blob's etag
 * and skip re-reading an unchanged record. If anything time-, policy- or
 * request-dependent ever creeps in here, that cache becomes wrong — so it
 * doesn't.
 *
 * Reads are defensive on purpose. This walks bodies of a dozen object types
 * against schemas that keep growing, and a search index is the wrong place to
 * be strict: a body shape this doesn't recognize must degrade to a thinner
 * document, never to a throw that takes the whole lookup down. Every accessor
 * below returns `null`/`[]` rather than asserting.
 */
import { normalizeRoutePath } from './content-search.js';
import type { SearchDoc } from './content-search.js';
import type { ObjectRecord } from '../../schema/object-record-v1.js';

/** Object types the search sweeps when the caller names none. */
export const DEFAULT_SEARCH_TYPES = ['content_item', 'page'] as const;

/** Enough headings to identify an article, not enough to bloat the index blob. */
const MAX_HEADINGS = 40;
const MAX_FIELD_LEN = 300;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const str = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_FIELD_LEN ? trimmed.slice(0, MAX_FIELD_LEN) : trimmed;
};

const strArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = str(entry);
    if (text) out.push(text);
  }
  return out;
};

const at = (source: unknown, ...path: string[]): unknown => {
  let cursor = source;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
};

/** Concatenated text of a rich_text.v1 subtree's leaf nodes. */
const richTextText = (node: unknown): string => {
  if (!isRecord(node)) return '';
  if (node.nodeType === 'text') return typeof node.value === 'string' ? node.value : '';
  const content = node.content;
  if (!Array.isArray(content)) return '';
  return content.map(richTextText).join('');
};

/**
 * The article's visible section headings: each node's own `public.title` /
 * `public.eyebrow` (the node IS the section in this model) plus any
 * `heading-*` block inside a rich_text body. Body prose is deliberately not
 * collected — see content-search.ts's header.
 */
const collectHeadings = (nodes: unknown): string[] => {
  if (!Array.isArray(nodes)) return [];
  const out: string[] = [];
  const push = (value: unknown) => {
    if (out.length >= MAX_HEADINGS) return;
    const text = str(value);
    if (text) out.push(text);
  };
  const walk = (node: unknown) => {
    if (out.length >= MAX_HEADINGS || !isRecord(node)) return;
    if (typeof node.nodeType === 'string' && node.nodeType.startsWith('heading')) push(richTextText(node));
    if (Array.isArray(node.content)) for (const child of node.content) walk(child);
  };
  for (const node of nodes) {
    if (out.length >= MAX_HEADINGS) break;
    if (!isRecord(node)) continue;
    push(at(node, 'public', 'eyebrow'));
    push(at(node, 'public', 'title'));
    const body = at(node, 'public', 'body');
    if (isRecord(body)) walk(body);
  }
  return out;
};

/** A content_item's public path is `/${slug}`; a page owns `body.route` outright. */
const routeFor = (objectType: string, body: unknown, slug: string | null): string | null => {
  const declared = str(at(body, 'route')) ?? str(at(body, 'path'));
  if (declared) return normalizeRoutePath(declared);
  if (objectType === 'content_item' && slug) return `/${slug}`;
  return null;
};

const slugFor = (body: unknown, route: string | null): string | null => {
  const declared = str(at(body, 'slug'));
  if (declared) return declared.toLowerCase();
  if (!route || route === '/') return null;
  const segments = route.split('/').filter(Boolean);
  return segments.length ? (segments[segments.length - 1] as string) : null;
};

/**
 * Alias sources, in the order an editor would expect them to resolve. Only
 * `body.aliases` is a first-class field today; the canonical URL is folded in
 * because a caller pasting the canonical of a re-slugged article is exactly
 * the "I only have the URL" case this tool exists for.
 */
const aliasesFor = (body: unknown): string[] => {
  const out = strArray(at(body, 'aliases'));
  const canonical = str(at(body, 'seo', 'canonical_url'));
  if (canonical) {
    const path = normalizeRoutePath(canonical);
    if (path && path !== '/') out.push(path.replace(/^\//, ''));
  }
  return Array.from(new Set(out));
};

export const projectSearchDoc = (record: ObjectRecord): SearchDoc => {
  const body = (record as unknown as { body?: unknown }).body;
  const objectType = String(record.object_type);
  const publishedTime = (at(record, 'publication', 'published_time') as string | null | undefined) ?? null;

  const route = routeFor(objectType, body, str(at(body, 'slug'))?.toLowerCase() ?? null);
  const slug = slugFor(body, route);

  return {
    object_id: record.object_id,
    object_type: objectType,
    status: record.status,
    published: Boolean(publishedTime),
    published_time: typeof publishedTime === 'string' ? publishedTime : null,
    updated_at: str((record as unknown as { updated_at?: unknown }).updated_at),
    slug,
    title: str(at(body, 'title')) ?? str(at(body, 'name')),
    description: str(at(body, 'description')) ?? str(at(body, 'deck')),
    route,
    // content_item nests SEO under snake_case, page under camelCase — read both
    // rather than making the caller care which type they landed on.
    seo_title: str(at(body, 'seo', 'meta_title')) ?? str(at(body, 'seo', 'title')),
    seo_description: str(at(body, 'seo', 'meta_description')) ?? str(at(body, 'seo', 'description')),
    category: str(at(body, 'taxonomy', 'category')),
    tags: strArray(at(body, 'taxonomy', 'tags')),
    headings: collectHeadings(at(body, 'nodes')),
    aliases: aliasesFor(body),
    request_id: /^req_/i.test(record.object_id) ? record.object_id : null,
  };
};
