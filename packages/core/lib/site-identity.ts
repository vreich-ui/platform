/**
 * Site identity — the single resolution seam for every tenant-specific
 * identifier (2026-07-22 pre-W11 dehardcode; front-loads T11.5). Consumers
 * never embed a `site_drlurie` / `dr-lurie` / `Dr_Lurie_*` literal again:
 * they call `getSiteIdentity()` and the value comes from, in precedence
 * order, the env override → the committed config
 * (src/config/site-identity.ts) → the naming convention derived from
 * `siteId` (`tax_<shortId>`, `trk_<shortId>`, slug-as-projectId).
 *
 * Canonical sources, per core-structure.md: the site EXPORT
 * (src/data/site/site.json) is authoritative for site identity — the config
 * transcribes `siteId`/`brandName` from it and the colocated lockstep test
 * fails on drift (same stance as the site-seed drift guard). Site
 * URLs/routing stay in src/config.yaml (Wolf B2) and are deliberately not
 * resolved here. The connector-facing names (MCP server names, UA slug,
 * asset host) had no prior canonical home — the committed config now IS that
 * home within the single-repo layout; W11 extraction lifts the config file
 * out per tenant.
 *
 * Byte-compat contract: for Dr-Lurie, every resolved value equals the
 * pre-parameterization literal exactly (external MCP connectors key on
 * `serverInfo.name`; the pdf-tool grant wire format pins `projectId`).
 * The unit tests gate this.
 *
 * Env overrides (names chosen to dodge Netlify's reserved SITE_ID/SITE_NAME):
 *   SITE_OBJECT_ID, SITE_SLUG, SITE_BRAND_NAME, SITE_TAXONOMY_ID,
 *   SITE_TRACKING_PROJECT_ID, MCP_SERVER_NAME, MCP_SERVER_DIAGNOSTIC_NAME,
 *   SITE_ASSET_HOST, SITE_ASSET_FOLDER, PDF_TOOL_PROJECT_ID.
 * Empty/whitespace values are ignored, never resolved.
 */
import { z } from 'zod';

/**
 * Provider-injection seam (W11 T11.2). Core law must not import the site's
 * committed config (`src/config/site-identity.ts` stays site-side); the site
 * registers the provider once at startup (see `src/config/policy-bindings.ts`).
 * `resolveSiteIdentity` still takes `config` explicitly (tests pass it); when
 * omitted it comes from the provider — byte-identical to the previous default
 * that read the committed config directly.
 */
let siteIdentityConfigProvider: (() => unknown) | undefined;

export const setSiteIdentityConfigProvider = (provider: () => unknown): void => {
  siteIdentityConfigProvider = provider;
};

const activeSiteIdentityConfig = (): unknown => {
  if (!siteIdentityConfigProvider) {
    throw new Error(
      'Site identity config provider not configured — import the site policy bindings (src/config/policy-bindings) before resolving site identity without an explicit config.'
    );
  }
  return siteIdentityConfigProvider();
};

const nonEmpty = z.string().trim().min(1);

export const siteIdentityConfigSchema = z.strictObject({
  /** Object id of the site singleton (`site_<shortId>`), per the site export. */
  siteId: nonEmpty.regex(/^site_[a-z0-9]+$/),
  /** Hyphenated machine slug: UA prefixes, default pdf-tool projectId. */
  siteSlug: nonEmpty.regex(/^[a-z0-9][a-z0-9-]*$/),
  /** The site export's `name` (drift-guarded). */
  brandName: nonEmpty,
  /** MCP serverInfo.name — external connectors key on the exact string. */
  mcpServerName: nonEmpty,
  /** The `server` field in MCP diagnostics/ping payloads. */
  mcpDiagnosticName: nonEmpty,
  /** Shared agency asset CDN origin (no trailing slash). */
  assetHost: nonEmpty.regex(/^https:\/\/[^\s/]+$/),
  /** This site's folder on assetHost. */
  assetFolder: nonEmpty.regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Canonical project registered by pdf-tool for this site. */
  pdfToolProjectId: nonEmpty.regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  /**
   * Canonical project registered by CMS-Agent for this site — the `project_id`
   * every `agent_resolve`/`agent_converse` call is parameterized by. Committed
   * and non-secret (the site's scoped bearer is the credential, not this).
   * CMS-Agent's own bound is `^[a-z0-9][a-z0-9-]{1,62}$`.
   */
  cmsAgentProjectId: nonEmpty.regex(/^[a-z0-9][a-z0-9-]{1,62}$/).optional(),
  /** W11 T11.5: admin console label (defaults to `${brandName} admin`). */
  adminLabel: nonEmpty.optional(),
  /** W11 T11.5: git committer fallback (env GITHUB_COMMIT_AUTHOR_* wins). */
  committerName: nonEmpty.optional(),
  committerEmail: nonEmpty.optional(),
});

export type SiteIdentityConfig = z.infer<typeof siteIdentityConfigSchema>;

export type SiteIdentity = SiteIdentityConfig & {
  /** `siteId` minus the `site_` prefix — the base of the id conventions. */
  siteShortId: string;
  /** Taxonomy registry object id (convention `tax_<shortId>`). */
  taxonomyId: string;
  /** Tracking project object id (convention `trk_<shortId>`). */
  trackingProjectId: string;
  /** pdf-tool storage-grant projectId (env PDF_TOOL_PROJECT_ID, else the slug). */
  pdfToolProjectId: string;
  /** CMS-Agent project_id (env CMS_AGENT_PROJECT_ID, else the slug). */
  cmsAgentProjectId: string;
  adminLabel: string;
  committerName: string;
  committerEmail: string;
};

type EnvSource = Record<string, string | undefined>;

/** Client-safe process.env access — resolves to {} where `process` is absent. */
const processEnv = (): EnvSource => (typeof process === 'undefined' ? {} : process.env);

const envValue = (env: EnvSource, key: string): string | undefined => {
  const trimmed = env[key]?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Resolve the site identity from an env source over a config value. Throws
 * (with the zod detail) on a malformed config — a broken identity config must
 * fail loudly, never quietly resolve to another tenant's defaults.
 */
export const resolveSiteIdentity = (
  env: EnvSource = processEnv(),
  config: unknown = activeSiteIdentityConfig()
): SiteIdentity => {
  const parsed = siteIdentityConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid site-identity config (src/config/site-identity.ts): ${parsed.error.message}`);
  }

  const siteId = envValue(env, 'SITE_OBJECT_ID') ?? parsed.data.siteId;
  const siteShortId = siteId.replace(/^site_/, '');
  const siteSlug = envValue(env, 'SITE_SLUG') ?? parsed.data.siteSlug;

  return {
    siteId,
    siteShortId,
    siteSlug,
    brandName: envValue(env, 'SITE_BRAND_NAME') ?? parsed.data.brandName,
    taxonomyId: envValue(env, 'SITE_TAXONOMY_ID') ?? `tax_${siteShortId}`,
    trackingProjectId: envValue(env, 'SITE_TRACKING_PROJECT_ID') ?? `trk_${siteShortId}`,
    mcpServerName: envValue(env, 'MCP_SERVER_NAME') ?? parsed.data.mcpServerName,
    mcpDiagnosticName: envValue(env, 'MCP_SERVER_DIAGNOSTIC_NAME') ?? parsed.data.mcpDiagnosticName,
    assetHost: envValue(env, 'SITE_ASSET_HOST') ?? parsed.data.assetHost,
    assetFolder: envValue(env, 'SITE_ASSET_FOLDER') ?? parsed.data.assetFolder,
    pdfToolProjectId: envValue(env, 'PDF_TOOL_PROJECT_ID') ?? parsed.data.pdfToolProjectId ?? siteSlug,
    cmsAgentProjectId: envValue(env, 'CMS_AGENT_PROJECT_ID') ?? parsed.data.cmsAgentProjectId ?? siteSlug,
    adminLabel: parsed.data.adminLabel ?? `${parsed.data.brandName} admin`,
    committerName: parsed.data.committerName ?? `${parsed.data.brandName} Publisher`,
    committerEmail: parsed.data.committerEmail ?? `publisher@${siteSlug}.local`,
  };
};

/** The identity of THIS deployment (committed config + process env). */
export const getSiteIdentity = (): SiteIdentity => resolveSiteIdentity();
