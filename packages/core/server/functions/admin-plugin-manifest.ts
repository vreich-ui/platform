/**
 * admin-plugin-manifest — the surface for the publishing-plugin bundle.
 *
 *   GET                      → the stored doc: active, draft, and why an
 *                              installed export is stale (W4.2).
 *   GET ?export=skill        → the Claude skill zip for the ACTIVE bundle (W2.1).
 *   GET ?export=plugin       → the Cowork `.plugin` bundle (W2.2).
 *   POST {action:"render"}   → render a fresh draft from live state.
 *   POST {action:"promote"}  → make the current draft the active bundle.
 *
 * Exports serve the ACTIVE bundle only. A draft is a proposal — shipping one to
 * a human's Claude org would put an unreviewed skill in front of the team, and
 * "promote, then download" is one extra click that makes the review real.
 *
 * Owner/admin only. The bundle carries no secrets — the OAuth URLs and the MCP
 * endpoint are public facts, and the token never transits here — but rendering
 * reads the site's governed objects, so it stays behind admin auth.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { getGovernanceBlobStore, resolveActivePolicies } from '../lib/governance-store.js';
import { getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { visibleToolDefinitions } from './mcp.js';
import {
  getPluginManifestBlobStore,
  getPluginManifestDoc,
  putPluginManifestDoc,
  promoteDraft,
  recordRenderedDraft,
} from '../lib/plugin/manifest-store.js';
import { buildManifestBundle, manifestStaleReasons } from '../lib/plugin/build-manifest.js';
import { toolSurfaceDigest, buildPluginTools } from '../lib/plugin/build-tools.js';
import { pluginPlatforms, type PluginPlatform } from '../lib/plugin/manifest-types.js';
import { buildSkillZip, buildCoworkPlugin } from '../lib/plugin/export-claude.js';
import { buildGptConfigZip, GptInstructionsTooLongError } from '../lib/plugin/export-openai.js';
import { buildGemInstructions } from '../lib/plugin/export-gemini.js';
import { readVoiceRecord } from '../lib/plugin/read-voice.js';
import { ensureMcpSiblings } from '../lib/agent/mcp-siblings.js';

type LambdaEvent = {
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined>;
};

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});

/**
 * The tenant's public origin. The deploy does not know its own hostname from
 * config — it learns it per request — so it is derived from the forwarded host,
 * exactly as the OAuth audience check does.
 */
const originFromEvent = (event: LambdaEvent): string | null => {
  const headers = event.headers ?? {};
  const host = headers['x-forwarded-host'] ?? headers['X-Forwarded-Host'] ?? headers.host ?? headers.Host;
  if (!host) return null;
  const proto = headers['x-forwarded-proto'] ?? headers['X-Forwarded-Proto'] ?? 'https';
  return `${proto}://${host}`;
};

const parsePlatform = (value: unknown): PluginPlatform =>
  pluginPlatforms.includes(value as PluginPlatform) ? (value as PluginPlatform) : 'claude';

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  const method = event.httpMethod ?? 'GET';
  if (method !== 'GET' && method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const access = await resolveAdminAccessFromEvent(event, context);
  if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
  if (!access.isAdmin || !access.email) return jsonResponse(403, { error: 'Admin access is required.' });

  /**
   * This function reads the live tool surface through `visibleToolDefinitions()`,
   * and that filter calls `requireSiblings()` — which throws by design in a
   * process that never injected the /mcp siblings. This is a different lambda
   * from /mcp, so nothing had ever injected them here: an authenticated GET
   * threw "MCP server not configured" one line below the auth gate and Netlify
   * answered a bare 502. Every test this endpoint had stopped at 401/403/405,
   * so no test ever reached the throwing line.
   *
   * Derived from this function's OWN binding and guarded by `isMcpConfigured()`
   * — it can never inject another tenant's handlers, and never downgrades a
   * real /mcp shim that already injected a richer set.
   */
  ensureMcpSiblings(binding);

  const origin = originFromEvent(event);
  if (!origin)
    return jsonResponse(400, { error: 'The request carried no Host header, so the tenant origin is unknown.' });

  let store;
  try {
    store = await getPluginManifestBlobStore(event, binding);
  } catch (error) {
    console.error('Plugin manifest store unavailable.', error);
    return jsonResponse(500, { error: 'The plugin manifest store is unavailable.' });
  }

  const doc = await getPluginManifestDoc(store);

  const approval = await resolveApproval(event);
  const liveTools = buildPluginTools(visibleToolDefinitions());
  const liveDigest = toolSurfaceDigest(liveTools);

  if (method === 'GET') {
    const exportKind = event.queryStringParameters?.export;
    if (exportKind) {
      if (!['skill', 'plugin', 'gpt', 'gemini'].includes(exportKind)) {
        return jsonResponse(400, { error: 'export must be "skill", "plugin", "gpt" or "gemini".' });
      }
      if (!doc.active) {
        return jsonResponse(409, {
          error: 'There is no active bundle to export. Render a draft and promote it first.',
        });
      }

      // Gemini is markdown, not a zip: a Gem has one instructions field and
      // nothing to connect (plan D6), so there is no bundle to build.
      if (exportKind === 'gemini') {
        const gem = buildGemInstructions(doc.active);
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `attachment; filename="${gem.filename}"`,
            'Cache-Control': 'no-store',
            'X-Plugin-Manifest-Version': doc.active.manifest_version,
          },
          body: gem.content,
        };
      }
      let artifact;
      try {
        artifact =
          exportKind === 'skill'
            ? buildSkillZip(doc.active)
            : exportKind === 'plugin'
              ? buildCoworkPlugin(doc.active)
              : buildGptConfigZip(doc.active);
      } catch (error) {
        // The GPT instructions cap is ChatGPT's, not ours: a bundle that would
        // not fit is a render defect to fix, never something to truncate
        // silently into a half-instruction.
        if (error instanceof GptInstructionsTooLongError) {
          return jsonResponse(500, { error: error.message, error_code: 'gpt_instructions_too_long' });
        }
        throw error;
      }
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${artifact.filename}"`,
          'Cache-Control': 'no-store',
          // The version the human is installing, readable without unzipping —
          // this is what an operator compares against the live manifest when
          // an install looks stale.
          'X-Plugin-Manifest-Version': doc.active.manifest_version,
        },
        body: artifact.bytes.toString('base64'),
        isBase64Encoded: true,
      };
    }

    const voice = await readVoiceRecord(event, binding, getSiteObjectsBlobStore).catch(() => null);
    const live = {
      voiceRecordVersion: voice?.record_version ?? null,
      toolSurfaceDigest: liveDigest,
      approvalPosture: approval.master,
    };
    return jsonResponse(200, {
      active: doc.active ?? null,
      draft: doc.draft ?? null,
      stale: doc.active ? manifestStaleReasons(doc.active, live) : [],
      updated_by: doc.updated_by,
      updated_at: doc.updated_at,
      history: doc.history.slice(0, 10),
      exports: doc.active
        ? {
            skill_zip: '/.netlify/functions/admin-plugin-manifest?export=skill',
            cowork_plugin: '/.netlify/functions/admin-plugin-manifest?export=plugin',
            gpt_config: '/.netlify/functions/admin-plugin-manifest?export=gpt',
            gem_instructions: '/.netlify/functions/admin-plugin-manifest?export=gemini',
            actions_openapi: '/api/plugin/openapi.json',
          }
        : null,
    });
  }

  let payload: Record<string, unknown> = {};
  try {
    const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body.' });
  }

  const action = typeof payload.action === 'string' ? payload.action : '';

  if (action === 'promote') {
    const promoted = promoteDraft(doc, access.email, new Date().toISOString());
    if (!promoted.ok) return jsonResponse(409, { error: promoted.error });
    await putPluginManifestDoc(store, promoted.doc);
    return jsonResponse(200, { active: promoted.doc.active, promoted: true });
  }

  if (action !== 'render') {
    return jsonResponse(400, { error: 'action must be "render" or "promote".' });
  }

  const voice = await readVoiceRecord(event, binding, getSiteObjectsBlobStore).catch(() => null);
  const bundle = buildManifestBundle({
    origin,
    definitions: visibleToolDefinitions(),
    voice,
    platform: parsePlatform(payload.platform),
    approval,
  });
  const next = recordRenderedDraft(doc, bundle, access.email);
  await putPluginManifestDoc(store, next);
  return jsonResponse(200, { draft: bundle, warnings: bundle.warnings });
};

const resolveApproval = async (event: LambdaEvent): Promise<{ master: string; overrides?: Record<string, string> }> => {
  try {
    const governance = await getGovernanceBlobStore(event);
    const active = await resolveActivePolicies(governance);
    const approval = active.approval as unknown as { master: string; overrides?: Record<string, string> };
    return { master: approval.master, overrides: approval.overrides };
  } catch {
    // The committed posture file is the documented fallback; buildManifestBundle
    // reads it when no posture is passed, and records a warning if even that fails.
    return { master: 'all-autonomous' };
  }
};

export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
