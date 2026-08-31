/**
 * admin-plugin-manifest — the W1 acceptance surface for the publishing-plugin
 * bundle.
 *
 *   GET                      → the stored doc: active, draft, and why an
 *                              installed export is stale (W4.2).
 *   POST {action:"render"}   → render a fresh draft from live state.
 *   POST {action:"promote"}  → make the current draft the active bundle.
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
import { readVoiceRecord } from '../lib/plugin/read-voice.js';

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
