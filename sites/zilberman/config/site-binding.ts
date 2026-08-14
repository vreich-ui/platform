/**
 * zilberman SiteBinding (T11.7 scaffold) — this client's instantiation
 * of the core server layer's per-site seam (packages/core/server/lib/
 * site-binding.ts). Carries the site id, the env-var NAMES the server
 * machinery reads (the shared `PLATFORM_ENV_NAMES` — every client reads the
 * same names, the platform supplies per-site values, OQ-W11-4), and this
 * site's committed-export root.
 */
import { PLATFORM_ENV_NAMES, type SiteBinding } from '../../../packages/core/server/lib/site-binding.js';
import { siteIdentityConfig } from './site-identity.js';

export const siteBinding: SiteBinding = {
  siteId: siteIdentityConfig.siteId,
  env: PLATFORM_ENV_NAMES,
  dataRoot: 'sites/zilberman/data/site',
  // Admin cold-start fix (T16.3 fleet parity): admin-object/admin-audit
  // cold starts add ~1.3s TTFB to /admin/content. Warm them on the same
  // schedule as /mcp.
  warmAdminKeepalive: true,
};
