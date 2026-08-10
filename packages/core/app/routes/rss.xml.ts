/**
 * `/rss.xml` — a SHELL route (W16 T16.4).
 *
 * Core's `Header.astro` emits `getAsset('/rss.xml')` whenever `showRssFeed` is
 * on, so the route is core's own dependency and must exist on every tenant. It
 * used to live only in `sites/drlurie/app/pages/`, which made the RSS icon a
 * dead link on platform and fernwell.
 *
 * Everything tenant-specific comes from that site's `config.yaml` through the
 * `astrowind:config` virtual module (`SITE.name`, `METADATA.description`,
 * `SITE.trailingSlash`) and from Astro's `site` (`import.meta.env.SITE`), so
 * one implementation serves the fleet. A tenant with zero articles gets a
 * valid, empty feed — `fetchPosts()` returns `[]` and `getRssString` emits a
 * well-formed `<channel>` with no `<item>`s.
 *
 * A site that ships its own `app/pages/rss.xml.*` keeps ownership: the
 * injection in `shell-routes.ts` skips this route when the site file exists
 * (see `siteOwnsRoute` there — Astro would otherwise register BOTH and warn
 * about a static-route collision).
 */
import { getRssString } from '@astrojs/rss';

import { SITE, METADATA, APP_BLOG } from 'astrowind:config';
import { fetchPosts } from '~/utils/blog';
import { getPermalink } from '~/utils/permalinks';

export const prerender = true;

export const GET = async () => {
  if (!APP_BLOG.isEnabled) {
    return new Response(null, {
      status: 404,
      statusText: 'Not found',
    });
  }

  const posts = await fetchPosts();

  const rss = await getRssString({
    title: `${SITE.name}’s Blog`,
    description: METADATA?.description || '',
    site: import.meta.env.SITE,

    items: posts.map((post) => ({
      link: getPermalink(post.permalink, 'post'),
      title: post.title,
      description: post.excerpt,
      pubDate: post.publishDate,
    })),

    trailingSlash: SITE.trailingSlash,
  });

  return new Response(rss, {
    headers: {
      'Content-Type': 'application/xml',
    },
  });
};
