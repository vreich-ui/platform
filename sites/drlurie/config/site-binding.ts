/**
 * The Dr-Lurie SiteBinding (W11 T11.3, dataRoot added T11.6) — this site's
 * instantiation of the core server layer's per-site seam.
 *
 * Carries the site id, the env-var NAMES (never values) the server machinery
 * reads, and this site's committed-export root (`dataRoot`) — where the
 * publish-time materializers write. Dr-Lurie uses the Netlify-platform-
 * standard names — the per-site VALUES come from this Netlify site's own
 * environment (the tenant boundary, OQ-W11-4). A future client gets its own
 * copy of this module with its own site id + dataRoot (T11.7 provisioning
 * emits it).
 *
 * `sites/drlurie/site.config.ts` re-exports this binding (single source —
 * do not construct a second SiteBinding there).
 *
 * Export-name unification (T16.3, 2026-08-10): every CLI-born site
 * (create-site.mjs's template) exports its binding as plain `siteBinding` —
 * Dr-Lurie predates that convention and exports `drlurieSiteBinding`, which
 * every root `netlify/functions/*` shim still imports by that name. Both
 * names are exported here, pointing at the SAME object: `drlurieSiteBinding`
 * stays for those existing importers (never removed — see the T16.3 grep of
 * the whole repo), and `siteBinding` is the fleet-uniform alias so tooling
 * that expects the CLI-born shape (e.g. a future generic per-site import)
 * works here too.
 */
import { PLATFORM_ENV_NAMES, type SiteBinding } from '../../../packages/core/server/lib/site-binding.js';
import { siteIdentityConfig } from './site-identity.js';

export const drlurieSiteBinding: SiteBinding = {
  siteId: siteIdentityConfig.siteId,
  env: PLATFORM_ENV_NAMES,
  dataRoot: 'sites/drlurie/data/site',
  // Perf profiling (2026-08-06): admin-object/admin-audit cold starts add
  // ~1.3s TTFB to /admin/content. Warm them on the same schedule as /mcp.
  warmAdminKeepalive: true,
};

/** Fleet-uniform alias (T16.3) — same object as `drlurieSiteBinding` above. */
export const siteBinding: SiteBinding = drlurieSiteBinding;
