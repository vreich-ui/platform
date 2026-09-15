/**
 * Genesis Lab 3 site-identity config (T11.7 scaffold) — every tenant-specific
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
  siteId: 'site_genesis_lab_3',
  siteSlug: 'genesis-lab-3',
  brandName: 'Genesis Lab 3',
  mcpServerName: 'Genesis_Lab_3_MCP_Server',
  mcpDiagnosticName: 'Genesis_Lab_3_MCP',
  // Placeholder — point at this client's real asset CDN before going live.
  assetHost: 'https://example-assets.netlify.app',
  assetFolder: 'genesis-lab-3',
  pdfToolProjectId: 'genesis-lab-3',
  // G4 (2026-09-14) — THE CEILING, SCAFFOLDED. This block used to be absent, and its absence was
  // invisible from inside this repo: `aggressionCeiling` is optional in the TYPE so an older
  // scaffold still parses, and nothing on the site fails without it. What fails is downstream and
  // far away — `object_contract(content_item)` surfaces `aggression_ceiling` from this very
  // config, so a minted tenant answered CMS-Agent with no ceiling at all, its engine stamped
  // `resolved_vector_unclamped:no_ceiling` on every brief, and the one bound that decides how hard
  // published copy may push was simply not enforced. This site's own
  // `aggression_ceiling_declared` check (object-validate.ts) was already saying so; nobody was
  // reading a brand-new tenant's validation findings.
  //
  // The values are a DELIBERATELY CALM STARTING POINT, not a house decision: a tenant nobody has
  // interviewed should not be born able to push harder than one that has been. They sit above
  // drlurie's committed ceiling (0.45 / 0.10 / 0.15 / 0.20) because drlurie is health-adjacent and
  // its bound is editorial, and well below the dials' own maxima. Raise them per tenant, in this
  // file, once somebody has decided — a ceiling is a ceiling, and copy may always be calmer.
  aggressionCeiling: { claim_strength: 0.5, urgency: 0.3, emotional_agitation: 0.4, cta_density: 0.4 },
} satisfies SiteIdentityConfig;
