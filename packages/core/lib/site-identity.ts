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

/** One aggression dial: a finite number in [0, 1]. */
const dial = z.number().finite().min(0).max(1);

/**
 * Aggression ceiling (CMS-Agent WORK-ORDER-2026-08-12 W6 §2, Wolf's standing
 * ruling): the per-site componentwise UPPER BOUND on how hard published copy
 * may push, on four dials each in [0, 1]. Surfaced verbatim by
 * `object_contract(content_item)` as `aggression_ceiling`; CMS-Agent resolves
 * each dial as `min(placement_target, ceiling)`. It is a ceiling, not a target
 * — copy may always be calmer.
 */
export const aggressionCeilingSchema = z.strictObject({
  /** How strong/absolute claims may read (0 = hedged, 1 = categorical). */
  claim_strength: dial,
  /** Time pressure / scarcity framing. */
  urgency: dial,
  /** Emotional stirring — fear, shame, FOMO. */
  emotional_agitation: dial,
  /** How many/how prominent the calls to action are. */
  cta_density: dial,
});

export type AggressionCeiling = z.infer<typeof aggressionCeilingSchema>;

export const AGGRESSION_CEILING_DIALS = ['claim_strength', 'urgency', 'emotional_agitation', 'cta_density'] as const;

/**
 * Loader-side assert for a ceiling value (used by the resolver and by any
 * override layer): every dial present, finite, and within [0, 1]. Throws a
 * clear error naming the offending dial(s).
 */
export const assertAggressionCeiling = (value: unknown, source = 'site-identity config'): AggressionCeiling => {
  const parsed = aggressionCeilingSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(
      `Invalid aggressionCeiling in ${source}: each of ${AGGRESSION_CEILING_DIALS.join('/')} must be a finite number in [0, 1] (${detail}).`
    );
  }
  return parsed.data;
};

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
  /**
   * W6 §2: the site's aggression ceiling. Optional in the TYPE (older
   * scaffolds parse), but every committed site config MUST carry one — the
   * client contract must never omit it (an absent ceiling is a CMS-Agent
   * blocker by design). Validated 0..1 per dial at resolve time.
   */
  aggressionCeiling: aggressionCeilingSchema.optional(),
  /**
   * W7.3: how much slack the server-side ceiling check allows before it warns
   * and before it blocks, as a multiple of the ceiling. Optional: omitted means
   * the fleet default (warn at 1.00, block at 1.15). A site whose voice is
   * deliberately louder than its dials suggest raises `block`; a site that
   * wants the ceiling to be exactly a ceiling sets both to 1.
   */
  aggressionTolerance: z
    .strictObject({
      warn: z.number().finite().min(0.5).max(3),
      block: z.number().finite().min(0.5).max(5),
    })
    .refine((value) => value.block >= value.warn, {
      message: 'aggressionTolerance.block must be >= warn — a ceiling that blocks before it warns is a typo.',
    })
    .optional(),
  /**
   * W7.1: links an OWNER published outside this system, which the public
   * install page shows when they exist. Optional everywhere and absent by
   * default: a tenant with no shared GPT still gets a complete install card
   * (build it once from the Actions schema URL), so this can never become a
   * scaffold obligation for a new site.
   */
  pluginInstall: z
    .strictObject({
      /** A shared Custom GPT link (chatgpt.com/g/…), when the owner published one. */
      customGptUrl: nonEmpty.regex(/^https:\/\//).optional(),
      /** An Agent Studio agent the owner shares with invitees. */
      agentStudioUrl: nonEmpty.regex(/^https:\/\//).optional(),
    })
    .optional(),
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
  /** The committed ceiling (undefined only for a config that omits it). */
  aggressionCeiling?: AggressionCeiling;
  /** W7.1: owner-published install links, when this site declares any. */
  pluginInstall?: { customGptUrl?: string; agentStudioUrl?: string };
  /** W7.3: per-site slack around the ceiling; undefined means the fleet default. */
  aggressionTolerance?: { warn: number; block: number };
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
  // Ceiling first, for the clearer per-dial error (the whole-schema parse
  // below would also refuse it, with the generic zod message).
  if (config && typeof config === 'object' && 'aggressionCeiling' in config) {
    assertAggressionCeiling((config as { aggressionCeiling: unknown }).aggressionCeiling);
  }
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
    ...(parsed.data.aggressionCeiling ? { aggressionCeiling: parsed.data.aggressionCeiling } : {}),
    ...(parsed.data.pluginInstall ? { pluginInstall: parsed.data.pluginInstall } : {}),
    ...(parsed.data.aggressionTolerance ? { aggressionTolerance: parsed.data.aggressionTolerance } : {}),
  };
};

/** The identity of THIS deployment (committed config + process env). */
export const getSiteIdentity = (): SiteIdentity => resolveSiteIdentity();
