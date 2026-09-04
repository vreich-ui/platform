/**
 * plugin-install (W7.1) — what an INVITED MEMBER needs, on a page that is not
 * the admin.
 *
 *   GET  /api/plugin-install                → public install facts + cards
 *   GET  /api/plugin-install?download=…     → the export bytes, member-gated
 *
 * WHY IT IS NOT `admin-plugin-manifest`. That endpoint is Owner/Admin only, and
 * correctly so — it RENDERS and PROMOTES, which reads governed objects and
 * changes what every installed copy runs. But the person doing an install is
 * usually an editor, and until now every download button on the plugins page
 * 403'd for exactly the audience the plugin exists for. So this is a second,
 * narrower door: it serves the ALREADY-PROMOTED bundle, never renders, never
 * promotes, and gates downloads on membership rather than on admin.
 *
 * WHY IT IS NOT UNDER `/api/plugin/*`. That prefix belongs to the Actions
 * façade, whose path list IS the charter: `/api/plugin/install` would arrive at
 * plugin-actions and be refused 403 as a tool that is not in charter. The
 * hyphen keeps the two surfaces apart.
 *
 * THE PUBLIC/PRIVATE LINE, deliberately drawn:
 *
 *   PUBLIC — the facts on the page. Origin, MCP URL, Actions schema URL, the
 *   health probe, the manifest version, the tool digest. Every one of these is
 *   already served unauthenticated somewhere else (`/api/plugin/openapi.json`,
 *   `/mcp?health=auth`), and an installer who cannot read the page before
 *   signing in cannot tell a mis-sent link from a broken tenant. The page has
 *   to work at the moment the invitation lands.
 *
 *   MEMBER-GATED — the bundles. The skill zip carries the tenant's rendered
 *   editorial voice: how this publication argues, what it refuses to claim,
 *   which framings it uses. That is the client's strategy, not a connection
 *   detail, and it does not go on an open URL. `editor` is the floor, matching
 *   the role that can actually use what it downloads.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import { installCards, type InstallFacts } from '../../lib/plugin-install.js';
import { getPluginManifestBlobStore, getPluginManifestDoc } from '../lib/plugin/manifest-store.js';
import { buildSkillZip, buildCoworkPlugin } from '../lib/plugin/export-claude.js';
import { buildGptConfigZip, GptInstructionsTooLongError } from '../lib/plugin/export-openai.js';
import { buildGemInstructions } from '../lib/plugin/export-gemini.js';
import type { Role } from '../lib/roles.js';

type LambdaEvent = {
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  queryStringParameters?: Record<string, string | undefined>;
};

/** Roles allowed to download a bundle — the same floor `whoami.can_write` reports. */
const INSTALL_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'publisher', 'editor']);

const DOWNLOAD_KINDS = ['skill', 'plugin', 'gpt', 'gemini'] as const;

const json = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});

const originFromEvent = (event: LambdaEvent): string | null => {
  const headers = event.headers ?? {};
  const host = headers['x-forwarded-host'] ?? headers['X-Forwarded-Host'] ?? headers.host ?? headers.Host;
  if (!host) return null;
  const proto = headers['x-forwarded-proto'] ?? headers['X-Forwarded-Proto'] ?? 'https';
  return `${proto}://${host}`;
};

export const INSTALL_ENDPOINT = '/api/plugin-install';

/** The facts the page renders from, built from the ACTIVE bundle and the site identity. */
export const buildInstallFacts = (input: {
  origin: string;
  brandName: string;
  tenant: string;
  manifestVersion: string;
  toolsDigest: string;
  pluginInstall?: { customGptUrl?: string; agentStudioUrl?: string };
}): InstallFacts => ({
  tenant: input.tenant,
  brand_name: input.brandName,
  origin: input.origin,
  mcp_url: `${input.origin}/mcp`,
  openapi_url: `${input.origin}/api/plugin/openapi.json`,
  mcp_auth_health_url: `${input.origin}/mcp?health=auth`,
  manifest_version: input.manifestVersion,
  tools_digest: input.toolsDigest,
  ...(input.pluginInstall?.customGptUrl ? { custom_gpt_url: input.pluginInstall.customGptUrl } : {}),
  ...(input.pluginInstall?.agentStudioUrl ? { agent_studio_url: input.pluginInstall.agentStudioUrl } : {}),
  downloads: {
    skill: `${INSTALL_ENDPOINT}?download=skill`,
    plugin: `${INSTALL_ENDPOINT}?download=plugin`,
    gpt: `${INSTALL_ENDPOINT}?download=gpt`,
    gemini: `${INSTALL_ENDPOINT}?download=gemini`,
  },
});

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if ((event.httpMethod ?? 'GET') !== 'GET') return json(405, { error: 'Method not allowed' });

  const origin = originFromEvent(event);
  if (!origin) return json(400, { error: 'The request carried no Host header, so the tenant origin is unknown.' });

  const doc = await getPluginManifestDoc(await getPluginManifestBlobStore(event, binding));
  const active = doc.active;

  const download = event.queryStringParameters?.download;
  if (download) {
    if (!(DOWNLOAD_KINDS as readonly string[]).includes(download)) {
      return json(400, { error: `download must be one of: ${DOWNLOAD_KINDS.join(', ')}.` });
    }
    /**
     * The gate. Note the ORDER: authentication first, then role, then whether
     * there is anything to download. An unauthenticated caller must not be
     * able to use this endpoint to learn whether a tenant has promoted a
     * bundle — that is what the public branch below is for, and it says so
     * plainly rather than leaking it through a download's status code.
     */
    const access = await resolveAdminAccessFromEvent(event, context);
    if (!access.authenticated) {
      return json(401, {
        error: 'Sign in as the member this tenant invited to download the bundle.',
        error_code: 'install_requires_member',
      });
    }
    if (!access.roles.some((role) => INSTALL_ROLES.has(role))) {
      return json(403, {
        error: `${access.email ?? 'This account'} has no editing role on this tenant, so there is nothing here to install. Ask the owner for editor or publisher.`,
        error_code: 'install_requires_editor',
      });
    }
    if (!active) {
      return json(409, {
        error: 'This tenant has not promoted a plugin bundle yet, so there is nothing to download.',
        error_code: 'no_active_manifest',
      });
    }

    if (download === 'gemini') {
      const gem = buildGemInstructions(active);
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${gem.filename}"`,
          'Cache-Control': 'no-store',
          'X-Plugin-Manifest-Version': active.manifest_version,
        },
        body: gem.content,
      };
    }

    let artifact;
    try {
      artifact =
        download === 'skill'
          ? buildSkillZip(active)
          : download === 'plugin'
            ? buildCoworkPlugin(active)
            : buildGptConfigZip(active);
    } catch (error) {
      if (error instanceof GptInstructionsTooLongError) {
        return json(500, { error: error.message, error_code: 'gpt_instructions_too_long' });
      }
      throw error;
    }
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${artifact.filename}"`,
        'Cache-Control': 'no-store',
        'X-Plugin-Manifest-Version': active.manifest_version,
      },
      body: artifact.bytes.toString('base64'),
      isBase64Encoded: true,
    };
  }

  const identity = getSiteIdentity();
  if (!active) {
    return json(200, {
      ready: false,
      tenant: identity.siteSlug,
      brand_name: identity.brandName,
      facts: null,
      cards: [],
    });
  }

  const facts = buildInstallFacts({
    // The origin the request arrived on wins over the stored one, exactly as
    // the Actions schema does: a token minted through a host this deploy does
    // not accept is refused forever and looks like a bad credential.
    origin,
    brandName: identity.brandName,
    tenant: identity.siteSlug,
    manifestVersion: active.manifest_version,
    toolsDigest: active.sources.tool_surface_digest,
    ...(identity.pluginInstall ? { pluginInstall: identity.pluginInstall } : {}),
  });

  return json(200, {
    ready: true,
    tenant: identity.siteSlug,
    brand_name: identity.brandName,
    facts,
    cards: installCards(facts),
    aggression_ceiling: active.sources.aggression_ceiling,
    approval_posture: active.sources.approval_posture,
  });
};

/**
 * Nothing here may reach a caller as a bare Netlify 502 — this is a PUBLIC
 * endpoint, and plugin-actions already shipped that defect once: an unhandled
 * throw answered with Netlify's own envelope, naming internal module paths to
 * an unauthenticated caller (see plugin-actions.ts's `guarded`).
 */
export const createHandler = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  try {
    return await buildHandlerImpl(binding)(event, context);
  } catch (error) {
    console.error('plugin-install failed.', error);
    return json(500, { error: 'The install page could not be built for this tenant.' });
  }
};
