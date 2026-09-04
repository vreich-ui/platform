/**
 * Zilberman site config (T11.7 scaffold) — the per-client bundle of
 * everything that binds a deployment of the core CMS to THIS site: identity,
 * canonical host, image domains, the redirect table, and the site binding.
 * Routing authority stays a committed FILE (Wolf B2) — this module IS that
 * file for this client. Mirrors sites/drlurie/site.config.ts's shape (the
 * W11 T11.6 pattern) but is fully self-contained under this client's own
 * tree — see ./config/site-identity.ts + ./config/site-binding.ts, not
 * another client's src/config/*.
 *
 * Wire this up the way sites/drlurie's shell does: astro.config.ts reads
 * canonicalHost/imageDomains from here for THIS deployment; config.yaml's
 * site URL must agree; netlify.toml's [[redirects]] must equal `redirects`
 * below. (Today only one Netlify build — Dr-Lurie's — reads any site.config
 * at build time; wiring an actual second deployment to read from ITS OWN
 * sites/<client>/site.config.ts, rather than sites/drlurie's, is T11.11's
 * job, not this scaffold's.)
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
  canonicalHost: z.string().regex(/^https:\/\/[^\s/]+$/),
  imageDomains: z.array(z.string().min(1)),
  redirects: z.array(redirectSchema),
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;

export const siteConfig: SiteConfig = siteConfigSchema.parse({
  siteId: siteIdentityConfig.siteId,
  canonicalHost: 'https://zilbermanfilmfoundation.netlify.app',
  imageDomains: [],
  redirects: [
    { from: '/pdf/*', to: '/.netlify/functions/get-public-pdf?blobKey=pdf/:splat', status: 200 },
    { from: '/img/*', to: '/.netlify/functions/get-public-image?blobKey=image/:splat', status: 200 },
    { from: '/mcp', to: '/.netlify/functions/mcp', status: 200 },
    // W3.1: the ChatGPT Actions facade over this tenant's MCP tools. One splat —
    // the tool name is the last path segment and the function routes on it, so
    // adding a tool to the plugin charter never needs a routing change. The
    // facade forwards to the same handler and the same OAuth as /mcp.
    { from: '/api/plugin/*', to: '/.netlify/functions/plugin-actions', status: 200 },
    // W7.1 — the public install page's data endpoint. NOT under /api/plugin/*:
    // that prefix is the Actions facade, whose path list IS the charter, so
    // /api/plugin/install would arrive there and be refused as a tool out of
    // charter. Facts are public; the bundle downloads behind ?download= are
    // gated on tenant membership (editor and above).
    { from: '/api/plugin-install', to: '/.netlify/functions/plugin-install', status: 200 },
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
  ],
});

export { siteIdentityConfig };
export { siteBinding } from './config/site-binding.js';
