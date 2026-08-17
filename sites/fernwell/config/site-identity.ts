/**
 * Fernwell site-identity config (T11.7 scaffold) — every tenant-specific
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
  siteId: 'site_fernwell',
  siteSlug: 'fernwell',
  brandName: 'Fernwell',
  mcpServerName: 'Fernwell_MCP_Server',
  mcpDiagnosticName: 'Fernwell_MCP',
  // Placeholder — point at this client's real asset CDN before going live.
  assetHost: 'https://example-assets.netlify.app',
  assetFolder: 'fernwell',
  pdfToolProjectId: 'fernwell',
  cmsAgentProjectId: 'fernwell',
  // W6 §2 (CMS-Agent WORK-ORDER-2026-08-12): componentwise aggression ceiling
  // (each dial 0..1) surfaced by object_contract(content_item).aggression_ceiling.
  // CMS-Agent resolves min(placement_target, ceiling); never omit it.
  aggressionCeiling: { claim_strength: 0.45, urgency: 0.10, emotional_agitation: 0.15, cta_density: 0.20 },
} satisfies SiteIdentityConfig;
