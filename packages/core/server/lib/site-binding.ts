/**
 * SiteBinding (W11 T11.3) — the per-site parameterization seam for the core
 * server layer.
 *
 * A binding carries the site's identity and the env-var NAMES (never values)
 * that the server machinery reads its credentials from. Values are read from
 * `process.env` at CALL TIME through `readBoundEnv` — never cached at module
 * scope — so two bindings in one process never share resolved secrets, and a
 * missing variable fails closed at the use site instead of poisoning a cache.
 *
 * `PLATFORM_ENV_NAMES` is the Netlify-standard name set. It is deliberately
 * NOT site-specific: the tenant boundary is the Netlify site (OQ-W11-4), so
 * every client deployment reads the same names and the platform supplies
 * per-site values. A binding exists so a site COULD rebind names (staging,
 * tests, unusual topologies) and so core never hardcodes the lookup.
 *
 * The Dr-Lurie instance lives site-side in `src/config/site-binding.ts`.
 *
 * `dataRoot` (W11 T11.6) is the site's committed-export tree — where the
 * publish-time materializers write (`materialize.ts` /
 * `materializers/shared.ts`'s `exportPath`). Unlike the env-var NAME lists
 * above, this is a literal path, not a secret or a platform convention: core
 * never defaults it (a materializer call with no exportRoot fails loudly),
 * so a fleet of sites can never collide on one another's export tree.
 */

/** Env-var name lists, first non-empty value wins (mirrors the pre-W11 `A || B` chains). */
export type SiteBindingEnvNames = {
  /** Netlify site id for the Blobs API config. */
  readonly blobSiteId: readonly string[];
  /** Netlify Blobs / API token. */
  readonly blobToken: readonly string[];
  /** Optional Blobs API URL override. */
  readonly blobApiUrl: readonly string[];
  /** The server-held publish secret (never client-supplied). */
  readonly publishSecret: readonly string[];
  /** MCP HTTP auth token (gate open when the variable is unset). */
  readonly mcpAuthToken: readonly string[];
  /** GitHub token for content commits. */
  readonly gitContentToken: readonly string[];
  /** GitHub repository slug for content commits. */
  readonly gitRepository: readonly string[];
  /** Git branch for content commits (last entry may be a plain default). */
  readonly gitBranch: readonly string[];
  /** Netlify build hook URL (the only allowed production-build trigger). */
  readonly buildHookUrl: readonly string[];
  /** Token for deploy lookups against the Netlify API. */
  readonly deployLookupToken: readonly string[];
  /** CMS-Agent Streamable-HTTP MCP endpoint (the Cloud Run `/mcp` URL). */
  readonly cmsAgentEndpoint: readonly string[];
  /** This site's scoped CMS-Agent bearer — one project, one tool allow-list. */
  readonly cmsAgentToken: readonly string[];
  /** `off | fallback | required`; unset or unrecognized resolves to `off`. */
  readonly cmsAgentChatMode: readonly string[];
};

export type SiteBinding = {
  /** The site singleton object id (identity, not a secret), e.g. 'site_drlurie'. */
  readonly siteId: string;
  readonly env: SiteBindingEnvNames;
  /** This site's committed-export root, e.g. 'sites/drlurie/data/site' (W11 T11.6). */
  readonly dataRoot: string;
  /**
   * Opt this site's scheduled mcp-keepalive run into also warming its
   * admin-object / admin-audit functions (the /admin/content read path),
   * not just /mcp. Defaults to unset/false — a site opts in explicitly in
   * its own `sites/<site>/config/site-binding.ts` rather than core deciding
   * per site identity, so this stays a plain per-site data field instead of
   * a site-name literal in fleet law.
   */
  readonly warmAdminKeepalive?: boolean;
};

/**
 * The Netlify-platform-standard names — exactly the chains the server layer
 * read before W11 (order preserved; behavior byte-identical).
 */
export const PLATFORM_ENV_NAMES: SiteBindingEnvNames = {
  blobSiteId: ['NETLIFY_SITE_ID', 'SITE_ID'],
  blobToken: ['NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN'],
  blobApiUrl: ['NETLIFY_BLOBS_API_URL'],
  publishSecret: ['PUBLISH_SECRET', 'NETLIFY_PUBLISH_SECRET'],
  mcpAuthToken: ['MCP_HTTP_AUTH_TOKEN'],
  gitContentToken: ['GITHUB_CONTENT_TOKEN'],
  gitRepository: ['GITHUB_REPOSITORY'],
  gitBranch: ['GITHUB_BRANCH', 'BRANCH'],
  buildHookUrl: ['NETLIFY_BUILD_HOOK_URL'],
  deployLookupToken: ['NETLIFY_AUTH_TOKEN', 'NETLIFY_BLOBS_TOKEN'],
  cmsAgentEndpoint: ['CMS_AGENT_MCP_ENDPOINT'],
  cmsAgentToken: ['CMS_AGENT_MCP_TOKEN'],
  cmsAgentChatMode: ['CMS_AGENT_CHAT_MODE'],
};

/**
 * Read one bound variable: the first name whose `process.env` value is a
 * non-empty string. Always a live read — never cached — so per-invocation
 * resolution and cross-binding isolation hold by construction.
 */
export const readBoundEnv = (names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
};

/** Convenience: read a binding key by name. */
export const readBindingVar = (binding: SiteBinding, key: keyof SiteBindingEnvNames): string | undefined =>
  readBoundEnv(binding.env[key]);
