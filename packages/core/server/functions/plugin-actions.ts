/**
 * plugin-actions — the ChatGPT Actions façade (W3.1).
 *
 *   GET  /api/plugin/openapi.json   the generated Actions schema
 *   POST /api/plugin/<tool>         forward to the same-named MCP tool
 *
 * THE WHOLE DESIGN IS "NO NEW BUSINESS LOGIC, NO NEW AUTH SURFACE". A tool call
 * is wrapped in a JSON-RPC `tools/call` envelope and handed to the exported
 * `/mcp` handler with the caller's Authorization header untouched. Every gate —
 * OAuth resolution, the publish gate, creation policy, locks, idempotency —
 * runs in exactly the code path `/mcp` uses, because it IS that path. The
 * façade cannot drift from `/mcp` because it has nothing of its own to drift.
 *
 * The one thing it adds is a REFUSAL. `/mcp` has no per-client tool allowlist
 * (recon-mcp.md §4.2), so the plugin's `tools.json` is advisory there. Here the
 * generated path list is the charter: a tool outside the active manifest is
 * refused 403 before it reaches the handler. On this surface the allowlist is
 * real.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { handler as mcpHandler } from './mcp.js';
import { visibleToolDefinitions } from './mcp.js';
import { getPluginManifestBlobStore, getPluginManifestDoc } from '../lib/plugin/manifest-store.js';
import { buildOpenApiDocument, PLUGIN_ACTION_PATH_PREFIX } from '../lib/plugin/build-openapi.js';

type LambdaEvent = {
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  path?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined>;
};

const json = (statusCode: number, body: unknown, extraHeaders: Record<string, string> = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  body: JSON.stringify(body),
});

const refusal = (statusCode: number, error: string, extra: Record<string, unknown> = {}) =>
  json(statusCode, { ok: false, error, ...extra });

/** The trailing path segment: `/api/plugin/object_create` → `object_create`. */
export const toolNameFromPath = (path: string | undefined): string | null => {
  if (!path) return null;
  const index = path.indexOf(PLUGIN_ACTION_PATH_PREFIX);
  if (index === -1) return null;
  const rest = path.slice(index + PLUGIN_ACTION_PATH_PREFIX.length).replace(/^\/+/, '');
  const segment = rest.split(/[/?#]/)[0];
  return segment.length ? segment : null;
};

const originFromEvent = (event: LambdaEvent): string | null => {
  const headers = event.headers ?? {};
  const host = headers['x-forwarded-host'] ?? headers['X-Forwarded-Host'] ?? headers.host ?? headers.Host;
  if (!host) return null;
  const proto = headers['x-forwarded-proto'] ?? headers['X-Forwarded-Proto'] ?? 'https';
  return `${proto}://${host}`;
};

const parseJsonBody = (event: LambdaEvent): { ok: true; value: Record<string, unknown> } | { ok: false } => {
  if (!event.body) return { ok: true, value: {} };
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const parsed = raw.trim().length ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
};

/**
 * MCP JSON-RPC errors carry a numeric code. Map the two that mean something to
 * an HTTP client and let everything else be a 400 — the tool's own error body
 * (`error_code`, `details`) is what the model actually needs, and it rides
 * through untouched.
 */
const httpStatusForRpcError = (code: number): number => {
  if (code === -32601) return 404; // method/tool not found
  if (code === -32001) return 401; // unauthorized (mcp.ts's auth refusal)
  return 400;
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: unknown) => {
  const method = event.httpMethod ?? 'GET';
  const toolName = toolNameFromPath(event.path);

  // ── the schema ────────────────────────────────────────────────────────────
  if (toolName === 'openapi.json') {
    if (method !== 'GET') return refusal(405, 'Method not allowed');
    const origin = originFromEvent(event);
    if (!origin) return refusal(400, 'The request carried no Host header, so the tenant origin is unknown.');

    let active;
    try {
      const store = await getPluginManifestBlobStore(event, binding);
      active = (await getPluginManifestDoc(store)).active;
    } catch {
      return refusal(500, 'The plugin manifest store is unavailable.');
    }
    if (!active) {
      return refusal(409, 'No active plugin manifest. Render a draft and promote it in the tenant admin first.');
    }

    const document = buildOpenApiDocument({
      // The origin the request actually arrived on wins over the stored one, so
      // a schema fetched through a preview or custom domain names that host —
      // an OAuth token minted against a host the deploy does not accept is
      // refused forever and looks exactly like a bad credential (W0.1 §5).
      connection: { ...active.connection, origin },
      tools: active.tools,
      definitions: visibleToolDefinitions(),
      manifestVersion: active.manifest_version,
    });
    return json(200, document, {
      'Cache-Control': 'no-store',
      'X-Plugin-Manifest-Version': active.manifest_version,
    });
  }

  // ── a tool call ───────────────────────────────────────────────────────────
  if (!toolName) return refusal(404, 'Unknown plugin action path.');
  if (method !== 'POST') return refusal(405, 'Method not allowed. Tool calls are POST.');

  let active;
  try {
    const store = await getPluginManifestBlobStore(event, binding);
    active = (await getPluginManifestDoc(store)).active;
  } catch {
    return refusal(500, 'The plugin manifest store is unavailable.');
  }
  if (!active) {
    return refusal(409, 'No active plugin manifest, so no tool is in charter yet.');
  }
  if (!active.tools.some((tool) => tool.name === toolName)) {
    // The charter refusal. Deliberately BEFORE auth resolution: whether a tool
    // is in charter is a public fact about this plugin, and answering it early
    // keeps the message useful instead of masking it behind a 401.
    return refusal(403, `"${toolName}" is not in this plugin's charter.`, {
      error_code: 'tool_not_in_plugin_charter',
      manifest_version: active.manifest_version,
    });
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) return refusal(400, 'Invalid JSON body.');

  // Hand it to /mcp's own handler, Authorization header untouched.
  const rpcResponse = await mcpHandler(
    {
      ...event,
      httpMethod: 'POST',
      path: '/mcp',
      isBase64Encoded: false,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: parsed.value },
      }),
    } as never,
    context as never
  );

  // A non-200 from the MCP handler is a transport/auth refusal — pass it back
  // as-is rather than reinterpreting it.
  if (rpcResponse.statusCode !== 200) {
    return { ...rpcResponse, headers: { ...rpcResponse.headers, 'Cache-Control': 'no-store' } };
  }

  let envelope: {
    result?: { content?: unknown; structuredContent?: unknown; isError?: boolean };
    error?: { code: number; message: string; data?: unknown };
  };
  try {
    envelope = JSON.parse(rpcResponse.body) as typeof envelope;
  } catch {
    return refusal(502, 'The tool returned a response this façade could not read.');
  }

  if (envelope.error) {
    return json(httpStatusForRpcError(envelope.error.code), {
      ok: false,
      error: envelope.error.message,
      ...(envelope.error.data && typeof envelope.error.data === 'object' ? (envelope.error.data as object) : {}),
    });
  }

  const result = envelope.result ?? {};
  const payload =
    result.structuredContent !== undefined
      ? result.structuredContent
      : // A tool that returned only text still has to produce JSON here.
        { content: result.content };

  // A tool-level failure is a 422, not a 200 with an error inside it: ChatGPT
  // surfaces a non-2xx to the model far more reliably than a buried flag.
  return json(result.isError ? 422 : 200, payload as Record<string, unknown>);
};

export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
