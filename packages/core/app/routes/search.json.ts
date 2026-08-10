/**
 * `/search.json` — a SHELL route (W16 T16.4).
 *
 * The search overlay in core's `Header.astro` fetches `/search.json` on first
 * keystroke, so — like `/rss.xml` — the route is core's own dependency and
 * must exist on every tenant. It used to live only in
 * `sites/drlurie/app/pages/`, so the overlay 404'd into
 * `console.error('Failed to load search index')` on platform and fernwell.
 *
 * The index is derived entirely from `fetchPosts()`, which is per-site by
 * construction (each build resolves `@site/…` to its own tenant's exports). A
 * tenant with zero articles serves a valid, empty index: `[]`.
 *
 * A site that ships its own `app/pages/search.json.*` keeps ownership — see
 * the override note in `rss.xml.ts` and `siteOwnsRoute` in `shell-routes.ts`.
 */
import { fetchPosts } from '~/utils/blog';

export const prerender = true;

export const GET = async () => {
  const posts = await fetchPosts();

  const searchIndex = posts.map((post) => ({
    title: post.title,
    excerpt: post.excerpt,
    permalink: post.permalink,
    category: post.category?.title,
    tags: post.tags?.map((tag) => tag.title),
    publishDate: post.publishDate,
  }));

  return new Response(JSON.stringify(searchIndex), {
    headers: {
      'Content-Type': 'application/json',
    },
  });
};
