/**
 * The COMMITTED site-identity config — every tenant-specific identifier the
 * codebase used to hardcode, in ONE place (the 2026-07-22 pre-W11 dehardcode;
 * front-loads T11.5). A second client site edits THIS file (or sets the env
 * overrides listed in src/lib/site-identity.ts) — no other code changes.
 *
 *   siteId            → object id of the site singleton in the object store.
 *                       The committed site export (sites/drlurie/data/site/
 *                       site.json — W11 T11.6 relocated this from
 *                       src/data/site/site.json — materialized from this
 *                       record) stays authoritative:
 *                       a lockstep test fails if the two drift.
 *   siteSlug          → hyphenated machine slug: GitHub User-Agent prefixes
 *                       (`<slug>-object-publisher`, …) and the default
 *                       pdf-tool storage-grant projectId.
 *   brandName         → the site export's `name`; drift-guarded the same way.
 *                       Feeds agent-facing copy (the server-side publisher's
 *                       display name and instructions).
 *   mcpServerName     → MCP `serverInfo.name`. External connectors key on it:
 *                       changing it here severs existing connector sessions.
 *   mcpDiagnosticName → the `server` field in MCP diagnostics/ping payloads.
 *   assetHost         → the shared agency asset CDN (favicon + editor hints).
 *   assetFolder       → this site's folder on assetHost.
 *
 * Site URLs/routing stay in src/config.yaml (Wolf B2 — config.yaml is
 * authoritative there); this file deliberately does not duplicate them.
 */
import type { SiteIdentityConfig } from '../../../packages/core/lib/site-identity.js';

export const siteIdentityConfig = {
  siteId: 'site_drlurie',
  siteSlug: 'dr-lurie',
  brandName: 'Dr. Lurié Skincare',
  mcpServerName: 'Dr_Lurie_MCP_Server',
  mcpDiagnosticName: 'Dr_Lurie_Science_MCP',
  assetHost: 'https://kugelmedia.netlify.app',
  assetFolder: 'drlurieblog',
  // Canonical adapter id registered in pdf-tool. This is the site → artifact
  // project mapping; agents never derive it from site_drlurie.
  pdfToolProjectId: 'dr-lurie',
  cmsAgentProjectId: 'dr-lurie',
  // W11 T11.5: pinned so the de-hardcoded core resolves byte-identically.
  adminLabel: 'Dr. Lurié admin',
  committerName: 'Dr. Lurié Publisher',
  committerEmail: 'publisher@drlurie.local',
  // W6 §2 (CMS-Agent WORK-ORDER-2026-08-12): componentwise aggression ceiling
  // (each dial 0..1) surfaced by object_contract(content_item).aggression_ceiling.
  // CMS-Agent resolves min(placement_target, ceiling); never omit it.
  aggressionCeiling: { claim_strength: 0.45, urgency: 0.10, emotional_agitation: 0.15, cta_density: 0.20 },
} satisfies SiteIdentityConfig;
