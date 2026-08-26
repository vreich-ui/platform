/**
 * Dr-Lurie site config (W11 T11.5) — the per-client bundle of everything that
 * binds a deployment of the core CMS to THIS site: identity, canonical host,
 * image domains, the redirect table, and the site binding. Routing authority
 * stays a committed FILE (Wolf B2) — this module IS that file's new per-site
 * home; it is data + bindings, never objectified.
 *
 * Single-truth wiring (v1, drift-guarded rather than generated):
 *   - `astro.config.ts` reads `canonicalHost` + `imageDomains` from here.
 *   - `src/config.yaml` (the astrowind config) must agree on the site URL —
 *     pinned by tests/netlify/site-config-drift.test.ts.
 *   - root `netlify.toml`'s [[redirects]] table must equal `redirects` below —
 *     same drift test (generation deemed too invasive for v1; the test makes
 *     divergence impossible to land, which is the invariant that matters).
 *   - identity + policy posture stay in `src/config/*` (registered through
 *     `src/config/policy-bindings.ts`); this module re-exports the identity
 *     config and the SiteBinding (built + owned by `src/config/site-binding.ts`
 *     — not reconstructed here, T11.6 fix) so a future `sites/<client>`
 *     consumer has ONE import surface. T11.6 relocated seeds/exports beside
 *     this file (`seeds/`, `data/site/`) and threaded `dataRoot` onto the
 *     binding so the publish path writes into this tree; T11.7 provisions new
 *     clients by emitting a sibling of this module.
 */
import { z } from 'zod';

import { siteIdentityConfig } from './config/site-identity.js';

const redirectSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
  status: z.number().int(),
});

export const siteConfigSchema = z.strictObject({
  siteId: z.string().regex(/^site_[a-z0-9]+$/),
  /** Canonical public origin — astro.config `site` + config.yaml `site.site`. */
  canonicalHost: z.string().regex(/^https:\/\/[^\s/]+$/),
  /** Remote image optimization allowlist — astro.config `image.domains`. */
  imageDomains: z.array(z.string().min(1)),
  /** The netlify.toml [[redirects]] table, in order (drift-guarded). */
  redirects: z.array(redirectSchema),
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;

export const siteConfig: SiteConfig = siteConfigSchema.parse({
  siteId: siteIdentityConfig.siteId,
  canonicalHost: 'https://drluriescience.netlify.app',
  imageDomains: ['cdn.pixabay.com'],
  redirects: [
    { from: '/pdf/*', to: '/.netlify/functions/get-public-pdf?blobKey=pdf/:splat', status: 200 },
    { from: '/img/*', to: '/.netlify/functions/get-public-image?blobKey=image/:splat', status: 200 },
    { from: '/mcp', to: '/.netlify/functions/mcp', status: 200 },
    {
      from: '/.well-known/oauth-protected-resource',
      to: '/.netlify/functions/mcp-oauth?oauth_endpoint=protected-resource-metadata',
      status: 200,
    },
    {
      from: '/.well-known/oauth-protected-resource/*',
      to: '/.netlify/functions/mcp-oauth?oauth_endpoint=protected-resource-metadata',
      status: 200,
    },
    {
      from: '/.well-known/oauth-authorization-server',
      to: '/.netlify/functions/mcp-oauth?oauth_endpoint=authorization-server-metadata',
      status: 200,
    },
    {
      from: '/.well-known/oauth-authorization-server/*',
      to: '/.netlify/functions/mcp-oauth?oauth_endpoint=authorization-server-metadata',
      status: 200,
    },
    { from: '/oauth/register', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=register', status: 200 },
    { from: '/oauth/authorize', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=authorize', status: 200 },
    { from: '/oauth/consent', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=consent', status: 200 },
    { from: '/oauth/token', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=token', status: 200 },
    { from: '/oauth/revoke', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=revoke', status: 200 },
    { from: '/api/t', to: '/.netlify/functions/track-ingest', status: 200 },
    // W15 S1: one path segment, so /admin/content itself keeps serving the
    // static content library (the splat form swallowed the library index).
    { from: '/admin/content/:objectId', to: '/admin/content/__workspace', status: 200 },
    { from: '/admin/requests/:requestId', to: '/admin/requests/__request', status: 200 },
    // T2.1 D1(a): Templates/Media/Content collapse into /admin/objects.
    { from: '/admin/content', to: '/admin/objects', status: 301 },
    { from: '/admin/templates', to: '/admin/objects?type=template,section_template', status: 301 },
    { from: '/admin/studio', to: '/admin/objects?type=template,section_template', status: 301 },
    { from: '/admin/media', to: '/admin/objects?view=grid', status: 301 },
    { from: '/blog', to: '/learn/library', status: 301 },
    { from: '/topics', to: '/learn/topics', status: 301 },
    { from: '/topics/*', to: '/learn/topics/:splat', status: 301 },
    { from: '/shop', to: '/solutions/shop-preview', status: 301 },
    { from: '/early-access', to: '/solutions/early-access', status: 301 },
  ],
});

/** One import surface for site-side wiring (identity + server binding). */
export { siteIdentityConfig };
export { drlurieSiteBinding as siteBinding } from './config/site-binding.js';
