/**
 * Genesis Lab 2 site-identity config (T11.7 scaffold) — every tenant-specific
 * identifier this client's deployment needs, in ONE place. Mirrors
 * src/config/site-identity.ts's shape (packages/core/lib/site-identity.ts's
 * SiteIdentityConfig) but lives under this client's own sites/<client>/ tree
 * — self-contained, no dependency on another client's committed config.
 *
 * The committed site export (data/site/site.json, materialized from the
 * site singleton record) stays authoritative: a lockstep test should fail if
 * the two drift, the same discipline Dr-Lurie's site-identity.test.ts uses.
 */
import type { SiteIdentityConfig } from '../../../packages/core/lib/site-identity.js';

export const siteIdentityConfig = {
  siteId: 'site_genesis_lab_2',
  siteSlug: 'genesis-lab-2',
  brandName: 'Genesis Lab 2',
  mcpServerName: 'Genesis_Lab_2_MCP_Server',
  mcpDiagnosticName: 'Genesis_Lab_2_MCP',
  // Placeholder — point at this client's real asset CDN before going live.
  assetHost: 'https://example-assets.netlify.app',
  assetFolder: 'genesis-lab-2',
  pdfToolProjectId: 'genesis-lab-2',
} satisfies SiteIdentityConfig;
