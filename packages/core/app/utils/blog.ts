import type { PaginateFunction } from 'astro';
import { getCollection, getEntry, render } from 'astro:content';
import type { CollectionEntry } from 'astro:content';
import type { Post } from '~/types';
import { APP_BLOG } from 'astrowind:config';
import { cleanSlug, trimSlash, BLOG_BASE, POST_PERMALINK_PATTERN, CATEGORY_BASE, TAG_BASE } from './permalinks';
import { contentItemBodySchema } from '../../schema/bodies/content-item-v1';
import { renderArticleNodes } from '../../lib/article-object/render-nodes';
import { seededShuffle } from './seeded-shuffle';

/**
 * Display labels for category/tag slugs, from the taxonomy registry export
 * (sites/drlurie/data/site/taxonomy.json — W11 T11.6 relocated the export
 * root; the derived export of the converted tax_drlurie object; W3 step 2,
 * "slugs + label lookup"). Post frontmatter
 * carries canonical SLUGS; the registry owns how a term is DISPLAYED — rename
 * a term's label in the registry and every card, tag chip, listing title, and
 * topics page updates on the next build. A slug not in the registry falls back
 * to the raw frontmatter string, so unmapped terms render exactly as before.
 */
type TaxonomyLabelMaps = { category: Map<string, string>; tag: Map<string, string> };
let taxonomyLabelsPromise: Promise<TaxonomyLabelMaps> | undefined;

const getTaxonomyLabels = (): Promise<TaxonomyLabelMaps> => {
  taxonomyLabelsPromise ??= (async () => {
    const maps: TaxonomyLabelMaps = { category: new Map(), tag: new Map() };
    const entry = await Promise.resolve(getEntry('taxonomyObject', 'taxonomy')).catch(() => undefined);
    const kinds = (entry?.data as { kinds?: Record<string, { terms?: Array<{ slug?: string; label?: string }> }> })
      ?.kinds;
    for (const kind of ['category', 'tag'] as const) {
      for (const term of kinds?.[kind]?.terms ?? []) {
        if (term?.slug && term?.label) maps[kind].set(term.slug, term.label);
      }
    }
    return maps;
  })();
  return taxonomyLabelsPromise;
};

const generatePermalink = async ({
  id,
  slug,
  publishDate,
  category,
}: {
  id: string;
  slug: string;
  publishDate: Date;
  category: string | undefined;
}) => {
  const year = String(publishDate.getFullYear()).padStart(4, '0');
  const month = String(publishDate.getMonth() + 1).padStart(2, '0');
  const day = String(publishDate.getDate()).padStart(2, '0');
  const hour = String(publishDate.getHours()).padStart(2, '0');
  const minute = String(publishDate.getMinutes()).padStart(2, '0');
  const second = String(publishDate.getSeconds()).padStart(2, '0');

  const permalink = POST_PERMALINK_PATTERN.replace('%slug%', slug)
    .replace('%id%', id)
    .replace('%category%', category || '')
    .replace('%year%', year)
    .replace('%month%', month)
    .replace('%day%', day)
    .replace('%hour%', hour)
    .replace('%minute%', minute)
    .replace('%second%', second);

  return permalink
    .split('/')
    .map((el) => trimSlash(el))
    .filter((el) => !!el)
    .join('/');
};

const getNormalizedPost = async (post: CollectionEntry<'post'>): Promise<Post> => {
  const { id, data } = post;
  const { Content, remarkPluginFrontmatter } = await render(post);

  const {
    publishDate: rawPublishDate = new Date(),
    updateDate: rawUpdateDate,
    title,
    excerpt,
    image,
    video,
    ctaLink,
    ctaText,
    tags: rawTags = [],
    category: rawCategory,
    author,
    draft = false,
    published_time: rawPublishedTime,
    metadata = {},
  } = data;

  const slug = cleanSlug(id); // cleanSlug(rawSlug.split('/').pop());
  const publishDate = new Date(rawPublishDate);
  const updateDate = rawUpdateDate ? new Date(rawUpdateDate) : undefined;

  const labels = await getTaxonomyLabels();

  const category = rawCategory
    ? {
        slug: cleanSlug(rawCategory),
        title: labels.category.get(cleanSlug(rawCategory)) ?? rawCategory,
      }
    : undefined;

  const tags = rawTags.map((tag: string) => ({
    slug: cleanSlug(tag),
    title: labels.tag.get(cleanSlug(tag)) ?? tag,
  }));

  return {
    id: id,
    slug: slug,
    permalink: await generatePermalink({ id, slug, publishDate, category: category?.slug }),

    publishDate: publishDate,
    updateDate: updateDate,

    title: title,
    excerpt: excerpt,
    image: image,
    video: video,
    ctaLink: ctaLink,
    ctaText: ctaText,

    category: category,
    tags: tags,
    author: author,

    draft: draft,
    published_time: rawPublishedTime,

    metadata,

    Content: Content,
    // or 'content' in case you consume from API

    readingTime: remarkPluginFrontmatter?.readingTime,
  };
};

/**
 * Object-backed articles (W7.3): published content_item objects materialize
 * to sites/drlurie/data/site/articles/*.json (W11 T11.6 relocated the export
 * root) and join the SAME post list as the
 * committed .md posts — one list, so listings, categories, tags, related
 * scoring, RSS, and search cover both families with no per-surface wiring.
 * The export's __generated.at is the effective published_time (T1.3), so the
 * standing published-time gate below applies unchanged. The body renders
 * through the one node renderer (render-nodes.ts) into `post.content` — the
 * article route's set:html branch — with per-node canvas identity attached.
 */
const loadArticleObjectPosts = async (takenSlugs: Set<string>): Promise<Post[]> => {
  const entries = await getCollection('articleObject');
  if (entries.length === 0) return [];
  const labels = await getTaxonomyLabels();
  const posts: Post[] = [];

  for (const entry of entries) {
    const { __generated, ...body } = entry.data as { __generated: { at: string; record_version?: number } } &
      Record<string, unknown>;
    const parsed = contentItemBodySchema.safeParse(body);
    if (!parsed.success) {
      // Loud skip, never a build failure: a bad export is healed store-side.
      console.warn(`[articleObject] ${entry.id}: export does not parse as content_item.v1 — skipped.`);
      continue;
    }
    const article = parsed.data;
    if (takenSlugs.has(article.slug)) {
      // Validation blocks this at write; a legacy .md post added later can
      // still collide. The committed post wins — objects never shadow it.
      console.warn(`[articleObject] ${entry.id}: slug "${article.slug}" is taken by a committed post — skipped.`);
      continue;
    }

    const publishDate = new Date(__generated.at);
    const rendered = renderArticleNodes(entry.id, article, __generated.record_version);
    const category = article.taxonomy?.category
      ? {
          slug: cleanSlug(article.taxonomy.category),
          title: labels.category.get(cleanSlug(article.taxonomy.category)) ?? article.taxonomy.category,
        }
      : undefined;
    const tags = (article.taxonomy?.tags ?? []).map((tag) => ({
      slug: cleanSlug(tag),
      title: labels.tag.get(cleanSlug(tag)) ?? tag,
    }));

    posts.push({
      id: entry.id,
      slug: article.slug,
      permalink: await generatePermalink({ id: entry.id, slug: article.slug, publishDate, category: category?.slug }),
      publishDate,
      title: article.title,
      excerpt: article.description ?? article.deck,
      image: article.image?.src,
      category,
      tags,
      author: article.author,
      draft: false,
      published_time: publishDate,
      metadata: {
        ...(article.seo?.meta_title ? { title: article.seo.meta_title } : {}),
        ...(article.seo?.meta_description ? { description: article.seo.meta_description } : {}),
        ...(article.seo?.canonical_url ? { canonical: article.seo.canonical_url } : {}),
      },
      content: rendered.html,
      readingTime: rendered.readingTime,
    });
  }
  return posts;
};

const load = async function (): Promise<Array<Post>> {
  // The legacy .md `post` collection was retired 2026-07-13 (all articles are
  // content_item OBJECTS now). The collection is intentionally empty — Astro
  // logs a benign "collection 'post' … is empty" line at build (same class as
  // the pre-seed articleObject warning); the build is unaffected. The `.catch`
  // keeps the read robust and lets committed .md posts merge back seamlessly
  // if they ever return.
  const posts = await getCollection('post').catch(() => []);
  const normalizedPosts = await Promise.all(posts.map(async (post) => await getNormalizedPost(post)));
  const articleObjectPosts = await loadArticleObjectPosts(new Set(normalizedPosts.map((post) => post.slug)));

  const results = [...normalizedPosts, ...articleObjectPosts]
    .sort((a, b) => b.publishDate.valueOf() - a.publishDate.valueOf())
    .filter((post) => {
      const publishedTime = post.published_time instanceof Date ? post.published_time.getTime() : Number.NaN;
      return Number.isFinite(publishedTime) && publishedTime <= Date.now();
    });

  return results;
};

let _posts: Array<Post>;

/** */
export const isBlogEnabled = APP_BLOG.isEnabled;
export const isRelatedPostsEnabled = APP_BLOG.isRelatedPostsEnabled;
export const isBlogListRouteEnabled = APP_BLOG.list.isEnabled;
export const isBlogPostRouteEnabled = APP_BLOG.post.isEnabled;
export const isBlogCategoryRouteEnabled = APP_BLOG.category.isEnabled;
export const isBlogTagRouteEnabled = APP_BLOG.tag.isEnabled;

export const blogListRobots = APP_BLOG.list.robots;
export const blogPostRobots = APP_BLOG.post.robots;
export const blogCategoryRobots = APP_BLOG.category.robots;
export const blogTagRobots = APP_BLOG.tag.robots;

export const blogPostsPerPage = APP_BLOG?.postsPerPage;

/** */
export const fetchPosts = async (): Promise<Array<Post>> => {
  if (!_posts) {
    _posts = await load();
  }

  return _posts;
};

/** */
export const findPostsBySlugs = async (slugs: Array<string>): Promise<Array<Post>> => {
  if (!Array.isArray(slugs)) return [];

  const posts = await fetchPosts();

  return slugs.reduce(function (r: Array<Post>, slug: string) {
    posts.some(function (post: Post) {
      return slug === post.slug && r.push(post);
    });
    return r;
  }, []);
};

/** */
export const findPostsByIds = async (ids: Array<string>): Promise<Array<Post>> => {
  if (!Array.isArray(ids)) return [];

  const posts = await fetchPosts();

  return ids.reduce(function (r: Array<Post>, id: string) {
    posts.some(function (post: Post) {
      return id === post.id && r.push(post);
    });
    return r;
  }, []);
};

/** */
export const findLatestPosts = async ({ count }: { count?: number }): Promise<Array<Post>> => {
  const _count = count || 4;
  const posts = await fetchPosts();

  return posts ? posts.slice(0, _count) : [];
};

/** */
export const getStaticPathsBlogList = async ({ paginate }: { paginate: PaginateFunction }) => {
  if (!isBlogEnabled || !isBlogListRouteEnabled) return [];
  return paginate(await fetchPosts(), {
    params: { blog: BLOG_BASE || undefined },
    pageSize: blogPostsPerPage,
  });
};

/** */
export const getStaticPathsBlogPost = async () => {
  if (!isBlogEnabled || !isBlogPostRouteEnabled) return [];
  return (await fetchPosts()).flatMap((post) => ({
    params: {
      blog: post.permalink,
    },
    props: { post },
  }));
};

/** */
export const getStaticPathsBlogCategory = async ({ paginate }: { paginate: PaginateFunction }) => {
  if (!isBlogEnabled || !isBlogCategoryRouteEnabled) return [];

  const posts = await fetchPosts();
  const categories = {};
  posts.map((post) => {
    if (post.category?.slug) {
      categories[post.category?.slug] = post.category;
    }
  });

  return Array.from(Object.keys(categories)).flatMap((categorySlug) =>
    paginate(
      posts.filter((post) => post.category?.slug && categorySlug === post.category?.slug),
      {
        params: { category: categorySlug, blog: CATEGORY_BASE || undefined },
        pageSize: blogPostsPerPage,
        props: { category: categories[categorySlug] },
      }
    )
  );
};

/** */
export const getStaticPathsBlogTag = async ({ paginate }: { paginate: PaginateFunction }) => {
  if (!isBlogEnabled || !isBlogTagRouteEnabled) return [];

  const posts = await fetchPosts();
  const tags = {};
  posts.map((post) => {
    if (Array.isArray(post.tags)) {
      post.tags.map((tag) => {
        tags[tag?.slug] = tag;
      });
    }
  });

  return Array.from(Object.keys(tags)).flatMap((tagSlug) =>
    paginate(
      posts.filter((post) => Array.isArray(post.tags) && post.tags.find((elem) => elem.slug === tagSlug)),
      {
        params: { tag: tagSlug, blog: TAG_BASE || undefined },
        pageSize: blogPostsPerPage,
        props: { tag: tags[tagSlug] },
      }
    )
  );
};

/**
 * The related-posts scoring, pure: same category +5, each shared tag +1,
 * best-first, current post excluded. Single source of truth for BOTH the
 * legacy RelatedPosts furniture (getRelatedPosts below) and the object-backed
 * `related` content_grid source (section-resolve-deps.ts, `tag_similarity`).
 */
export function rankRelatedPosts(allPosts: Post[], originalPost: Post, maxResults: number): Post[] {
  const originalTagsSet = new Set(originalPost.tags ? originalPost.tags.map((tag) => tag.slug) : []);

  const postsWithScores = allPosts.reduce((acc: { post: Post; score: number }[], iteratedPost: Post) => {
    if (iteratedPost.slug === originalPost.slug) return acc;

    let score = 0;
    if (iteratedPost.category && originalPost.category && iteratedPost.category.slug === originalPost.category.slug) {
      score += 5;
    }

    if (iteratedPost.tags) {
      iteratedPost.tags.forEach((tag) => {
        if (originalTagsSet.has(tag.slug)) {
          score += 1;
        }
      });
    }

    acc.push({ post: iteratedPost, score });
    return acc;
  }, []);

  postsWithScores.sort((a, b) => b.score - a.score);

  return postsWithScores.slice(0, maxResults).map((entry) => entry.post);
}

/** */
export async function getRelatedPosts(originalPost: Post, maxResults: number = 4): Promise<Post[]> {
  const allPosts = await fetchPosts();
  return rankRelatedPosts(allPosts, originalPost, maxResults);
}

/**
 * A DETERMINISTIC "random" pick (the `random` related algorithm): a stable
 * shuffle seeded by `seed` (seededShuffle), so the built output never churns
 * between deploys yet each article shows a different-looking set.
 * `excludeSlug` drops the anchor post.
 */
export function pickRandomPosts(
  allPosts: Post[],
  excludeSlug: string | undefined,
  seed: string,
  maxResults: number
): Post[] {
  const pool = allPosts.filter((post) => post.slug !== excludeSlug);
  return seededShuffle(pool, seed).slice(0, maxResults);
}
