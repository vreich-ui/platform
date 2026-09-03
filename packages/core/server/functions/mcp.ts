/**
 * The MCP server — fleet law (W14 T14.3).
 *
 * This file used to live in `netlify/functions/` and be Dr-Lurie's alone. Two
 * things bound it to that one client, and only the first was obvious:
 *
 *  1. it opened by importing `sites/drlurie/config/policy-bindings`, and
 *  2. it is a COMPOSITE — it dispatches to sibling function handlers,
 *     imported statically from the same directory.
 *
 * So the decoupling is dependency injection, not a file move. `configureMcp`
 * is the seam: each site's shim registers its own policy bindings, builds the
 * governed handlers from the core factories with ITS SiteBinding, and passes
 * them in.
 *
 * RETIRED (2026-07-29): the legacy `save_json_blob_*` article pipeline and its
 * per-stage workflow tools are gone — module, publish path, tools and all
 * (ruling OQ-W11-6; its last consumer, CMS-Agent's dr-lurie hook, moved to the
 * object dialect first). Articles are `content_item` OBJECTS on every site in
 * the fleet. The committed legacy posts under `src/data/post/` and their
 * rendering are untouched: this retired the WRITE pipeline, not the published
 * content.
 *
 * `verify-article-images` survives that retirement and is still injected
 * rather than imported: it is a per-site function, and it serves the OBJECT
 * path (post-release image verification) as much as it ever served the legacy
 * one. It stays OPTIONAL — a site that injects no handler does not advertise
 * the tool rather than advertising one that cannot run.
 *
 * FAILS CLOSED: calling into this module before `configureMcp` throws. A
 * silent fallback to another tenant's handlers is the one outcome worse than
 * a crash.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * A Netlify function handler, as invoked in-process by the tool bodies.
 * `LambdaEvent`/`LambdaContext` are declared further down this module.
 */
type SiblingResponse = { statusCode: number; body?: string; headers?: Record<string, string> };
type SiblingHandler = (event: LambdaEvent, context?: LambdaContext) => Promise<SiblingResponse>;

/**
 * The governed trio every site has, plus the optional image-verification
 * handler a site supplies when it deploys `verify-article-images`.
 */
export interface McpSiblingHandlers {
  saveArtifactHandler: SiblingHandler;
  objectStoreHandler: SiblingHandler;
  deployStatusHandler: SiblingHandler;
  verifyArticleImagesHandler?: SiblingHandler;
}

let siblings: McpSiblingHandlers | undefined;

/** Called once per site, by that site's shim, before any request is served. */
export const configureMcp = (handlers: McpSiblingHandlers): void => {
  siblings = handlers;
};

/**
 * Whether this PROCESS already has siblings injected.
 *
 * The admin chat lambdas are a second, separate entry point into this module:
 * since the chat's generated tool registry executes operational tools
 * (`create_agent_artifact_job`, `deploy_status`, the pdf-tool/image families)
 * through the very same handler bodies `tools/call` uses, and those bodies
 * reach the object store through `objectStoreHandler`, a chat lambda that
 * never called `configureMcp` fails closed with "MCP server not configured" —
 * correct behavior, wrong place to hit it. Those functions configure the trio
 * themselves from their own SiteBinding, but must NOT clobber a shim that has
 * already injected a richer set (e.g. one carrying
 * `verifyArticleImagesHandler`), hence this guard rather than an
 * unconditional call.
 */
export const isMcpConfigured = (): boolean => siblings !== undefined;

const requireSiblings = (): McpSiblingHandlers => {
  if (!siblings) {
    throw new Error(
      "MCP server not configured — this site's shim must call configureMcp() " +
        '(and import its own config/policy-bindings) before serving a request.'
    );
  }
  return siblings;
};

/**
 * Tools that cannot work without a handler only some sites inject. A site that
 * injects none must not ADVERTISE them — listing a tool an agent cannot call
 * is worse than omitting it: the agent plans around it and fails mid-run.
 *
 * Caught by T14.4's live round-trip: injecting the handlers alone left every
 * one of these in `tools/list` on a site that had none of them.
 */
const OPTIONAL_HANDLER_TOOLS = new Set(['verify_article_images']);

/**
 * Operational tools that remain callable for admin and test workflows, but
 * are intentionally absent from agent discovery. They are
 * not part of normal information exchange or governed object editing, and a
 * large destructive/upload surface makes agent planning needlessly noisy.
 */
export { INTERNAL_ONLY_TOOLS };

/** True when this site supplied the article-image verification handler. */
const hasVerifyArticleImages = (): boolean => Boolean(requireSiblings().verifyArticleImagesHandler);

/** An optional handler: present only on a site that deploys the function. */
const requireOptional = (name: 'verifyArticleImagesHandler') => {
  const handlerFn = requireSiblings()[name];
  if (!handlerFn) {
    throw new Error(`This site does not deploy '${name}', so the tool is unavailable.`);
  }
  return handlerFn;
};

const saveArtifactHandler: SiblingHandler = (event, context) => requireSiblings().saveArtifactHandler(event, context);
export const objectStoreHandler: SiblingHandler = (event, context) =>
  requireSiblings().objectStoreHandler(event, context);
export const deployStatusHandler: SiblingHandler = (event, context) =>
  requireSiblings().deployStatusHandler(event, context);
export const verifyArticleImagesHandler: SiblingHandler = (event, context) =>
  requireOptional('verifyArticleImagesHandler')(event, context);
import { getArtifactIndexBlobStore, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { getGovernanceBlobStore } from '../lib/governance-store.js';
import { toWireTool } from '../lib/mcp-tool-annotations.js';
import { getCapabilityStatus } from '../lib/capability-status.js';
import { getMembershipStatus } from '../lib/membership/status.js';
import { getAgentKeysDoc, resolveVerifiedAgentName, type AgentKeysBlobStore } from '../lib/agent-keys.js';
import {
  buildWwwAuthenticate,
  describeOAuthPrincipal,
  resolveRequestOrigin,
  type OAuthPrincipalFailure,
  type ResolvedOAuthPrincipal,
} from '../lib/oauth-server.js';
import type { OAuthBlobStore } from '../lib/oauth-store.js';
import {
  artifactKindValues,
  artifactReferenceLimits,
  isSafeArtifactFilename,
  isSafeArtifactText,
  type ArtifactKind,
} from '../lib/artifacts.js';
import { saveArtifactFromUrl } from '../lib/artifact-url-ingest.js';
import { withIdempotentToolCall } from '../lib/idempotency-store.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import { buildObjectContract, OBJECT_CONTRACT_TYPES } from '../../lib/registry/object-contract.js';
import { getBrandImageryOverridePolicy } from '../lib/brand-imagery-resolve.js';
import type { ObjectType } from '../../schema/object-record-v1.js';
import { TOOL_DEFINITIONS_PART1, INTERNAL_ONLY_TOOLS } from '../lib/mcp-tool-definitions.js';
import { TOOL_DEFINITIONS_PART2 } from '../lib/mcp-tool-definitions-2.js';
import {
  MEMBERSHIP_TOOL_VERBS,
  TOOL_DEFINITIONS_MEMBERSHIP,
  isMembershipTool,
} from '../lib/mcp-tool-definitions-membership.js';
import { handleMembershipVerb } from '../lib/membership/verbs.js';
import { callerPrincipalFromMcpEvent } from '../lib/membership/caller-principal.js';
import { getUsersBlobStore } from '../lib/users-store.js';
import {
  getArtifactMetadata,
  listArtifactsByKind,
  listArtifactsByRequest,
  listArtifactsForRequest,
  migrateArtifactIndexes,
  reconcileArtifactIndexes,
  restoreArtifact,
  searchArtifacts,
  softDeleteArtifact,
  wipeBlobStores,
} from '../lib/mcp-artifact-admin.js';
import {
  callArtifactUpload,
  callBrandImageryPropose,
  callCreateAgentArtifactJob,
  callCreateArtifactUploadIntent,
  callCreatePdfTemplate,
  callDeletePdfTemplate,
  callDeployStatus,
  callCreateCaptureJob,
  callGetAgentArtifactBySlot,
  callGetAgentArtifactJobStatus,
  callGetCaptureJobStatus,
  callGetCaptureSnapshot,
  callGetImageModelPolicy,
  callGetImageSearchBank,
  callGetImageSearchJobStatus,
  callGetImageSearchPolicy,
  callGetPdfTemplate,
  callImportImageFromUrl,
  callImportImagesFromUrl,
  callListPdfTemplates,
  callObjectAction,
  callObjectPublish,
  callGetPdfTemplateValidation,
  callPdfToolHealth,
  callPublishPdfTemplate,
  callResumeAgentArtifactJob,
  callSearchImages,
  callSetImageModelPolicy,
  callSetImageSearchPolicy,
  callUpdateImageSearchCandidate,
  callValidatePdfTemplate,
  callReleaseToProduction,
  callTriggerNetlifyBuild,
  callVerifyArticleImages,
  callCommerceOrders,
  callOrderReissue,
  callProductSetPrice,
  callRegistryGet,
  resolveArtifactJobInlineWaitBudgetMs,
  resolveReleaseWaitBudgetSeconds,
} from '../lib/mcp-tool-handlers.js';

type StructuredLogPayload = {
  event: string;
  rpcMethod?: string | null;
  slug?: string | null;
  [key: string]: unknown;
};

type StructuredLogger = (payload: StructuredLogPayload) => void;

export type LambdaEvent = {
  blobs?: string;
  body?: string | null;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  /** Epoch ms by which this invocation is killed by the platform; derived from the Lambda context when available. */
  invocationDeadlineMs?: number;
  isBase64Encoded?: boolean;
  log?: StructuredLogger;
  queryStringParameters?: Record<string, string | undefined>;
  rpcMethod?: string | null;
  requestId?: string;
  slug?: string | null;
  /** W11 T11.10: set once per request when the Authorization bearer token resolves to a VERIFIED per-agent credential. */
  verifiedAgentName?: string;
  /** W18 T18.6a: the OAuth principal (a Netlify Identity HUMAN + client) this request authenticated with, if any. */
  oauthPrincipal?: ResolvedOAuthPrincipal;
  /**
   * The chat surface this call arrived through, when the ENTRY POINT knows it
   * for certain and a redirect-host derivation would get it wrong. Today that
   * is exactly one caller: the Actions façade (`/api/plugin/*`), which is
   * `plugin:openai-gpt` by construction — a Custom GPT registers OAuth
   * callbacks on chatgpt.com, so deriving from the redirect host would label
   * its calls `plugin:openai-agent`.
   *
   * Deliberately an in-process event FIELD and not a header: Netlify builds
   * this event from the HTTP request, so a client can set headers but cannot
   * invent a property. Nothing reachable from outside can claim a surface.
   */
  pluginSurface?: string;
  /**
   * QA-W16-3: set once per request, right after `getAuthResult` succeeds —
   * i.e. this request already cleared the platform's own MCP gate (the
   * shared MCP_HTTP_AUTH_TOKEN, a verified per-agent token, or an OAuth
   * principal). A tool handler reached via callTool can always rely on this
   * being true; it exists so a handler that ALSO needs to distinguish an
   * MCP-authenticated caller from an unauthenticated one (e.g. the
   * admin-artifact-browsing tools, which used to re-check an unrelated
   * Netlify-Identity session and failed 100% of the time for every agent)
   * doesn't have to re-derive that from scratch or reach for the wrong check.
   */
  mcpGateAuthenticated?: boolean;
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type ToolPreviewBinding =
  | { kind: 'verb_dry_run' } // execute the same verb with dry_run: true
  | { kind: 'validate_new_object' } // synthetic create preview (chat's validateNewObject)
  | { kind: 'input_echo' }; // echo the exact args onto the approval card

export type ToolGovernance = {
  /** Chat risk class; drives default autonomy (read → auto, everything else → ask). `membership` (W18 T18.6b) is ask-floored by construction. */
  toolClass: 'read' | 'draft' | 'creation' | 'publication' | 'privileged' | 'membership';
  /** Hard floor: no governance or profile override may promote this tool to 'auto'. */
  autonomyFloor?: 'ask';
  /** Approval-card preview strategy for non-read tools. Absent = card shows args + describe only. */
  preview?: ToolPreviewBinding;
  /** Chat-side default autonomy is 'off' (tool exists but disabled until enabled by governance/profile). */
  chatDefaultOff?: true;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  governance: ToolGovernance;
};

// Derived from the site-identity seam; for Dr-Lurie the resolved values are
// byte-identical to the historical literals ('Dr_Lurie_MCP_Server' /
// 'Dr_Lurie_Science_MCP') — external connectors key on serverInfo.name, so
// the identity config must never change them casually.
const SERVER_NAME = getSiteIdentity().mcpServerName;
const SERVER_DIAGNOSTIC_NAME = getSiteIdentity().mcpDiagnosticName;
const PROTOCOL_VERSION = '2025-06-18';

// Cold-start observability: a fresh runtime instance means the caller just
// paid module-evaluation latency. Surfaced in the per-request structured log
// and in the ping tool so slow first calls are attributable from client side.
const INSTANCE_BOOTED_AT_MS = Date.now();
let instanceInvocationCount = 0;

const jsonHeaders = {
  'Access-Control-Allow-Headers':
    'authorization, content-type, mcp-protocol-version, mcp-session-id, x-mcp-auth-token, x-publish-key',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'mcp-session-id',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

const textContent = (text: string) => [{ type: 'text', text }];

export const toNonEmptyString = (value: unknown) => {
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const getRecordValue = (value: unknown) =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

const safeSecretsMatch = (provided: string, expected: string) => {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
};

const getBearerToken = (authorization: string | undefined) => {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || undefined;
};

/**
 * The URL-borne shared token (W14 F9). Reason it exists: claude.ai's custom-
 * connector form takes a URL and OAuth credentials — there is NO field for a
 * static bearer or a custom header — so once F1 closed the fail-open gate,
 * every header-less client (Wolf's connector included) was locked out with no
 * way back in short of implementing an OAuth server. `?key=<token>` is the
 * standard workaround for exactly this shape of client and is what the other
 * Netlify-hosted MCP endpoints in this account already use.
 *
 * It is deliberately the WEAKEST of the three paths and is documented as such:
 * a URL query string is recorded by proxies, CDN access logs, and browser
 * history in a way an `Authorization` header is not. Any client that can send
 * headers should send headers. The value is compared with the same constant-
 * time `safeSecretsMatch` as the header paths, and is never logged — the
 * rejection diagnostic records only WHETHER a key was present.
 */
const getUrlKeyToken = (event: LambdaEvent) => {
  const params = event.queryStringParameters ?? {};

  return toNonEmptyString(params.key) ?? toNonEmptyString(params.mcp_key);
};

export const hasValidNetlifyPublishSecret = (event: LambdaEvent) => {
  const expected = toNonEmptyString(process.env.PUBLISH_SECRET ?? process.env.NETLIFY_PUBLISH_SECRET);
  if (!expected) return false;

  const provided =
    toNonEmptyString(getHeader(event.headers, 'x-publish-key')) ??
    getBearerToken(getHeader(event.headers, 'authorization'));

  return Boolean(provided && safeSecretsMatch(provided, expected));
};

export const parseJsonResponseBody = (bodyText: string | undefined) => {
  if (!bodyText) return {};

  try {
    return JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return { error: bodyText };
  }
};

/**
 * Every tool result crosses the wire TWICE — once as `content[0].text` and once
 * as `structuredContent` — because the MCP spec wants both and clients differ
 * in which they read. That duplication is the spec's; the INDENTATION was ours.
 * Pretty-printing the text half cost ~40% on top of an already-doubled payload
 * (measured on a real 10-node article: 11,693 B record → 31,889 B wire, of
 * which 18,844 B was the indented text). No client renders that whitespace —
 * they parse it. Compact serialization, same bytes of meaning (W6 D3).
 */
export const toolResult = (payload: Record<string, unknown>) => ({
  content: textContent(JSON.stringify(payload)),
  structuredContent: payload,
});

export const toolError = (message: string, payload: Record<string, unknown> = {}) => ({
  isError: true,
  content: textContent(message),
  structuredContent: { error: message, ...payload },
});

// T9.13/PF5: 'ping' extracted to an exported function (mechanical, same
// pattern as the mcp-tool-handlers.ts call* extractions) so the chat tool
// registry's `operational` bridge (agent/context.ts) has something to
// dispatch to. Kept here rather than mcp-tool-handlers.ts because it reads
// this module's own private cold-start instance state
// (INSTANCE_BOOTED_AT_MS/instanceInvocationCount) — moving those would not be
// a mechanical, behavior-preserving extraction.
export const callPing = () =>
  // instance_age_ms near zero means this call paid a cold start; the fields
  // are additive diagnostics on top of the original {ok, server}.
  toolResult({
    ok: true,
    server: SERVER_DIAGNOSTIC_NAME,
    instance_age_ms: Date.now() - INSTANCE_BOOTED_AT_MS,
    instance_invocations: instanceInvocationCount,
  });

const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...TOOL_DEFINITIONS_PART1,
  ...TOOL_DEFINITIONS_PART2,
  // W18 T18.6b: listed only to OAuth HUMAN principals (visibleToolDefinitions).
  ...TOOL_DEFINITIONS_MEMBERSHIP,
];
export const response = (statusCode: number, body: unknown, headers: Record<string, string> = jsonHeaders) => ({
  statusCode,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const emptyResponse = (statusCode: number) => ({
  statusCode,
  headers: { ...jsonHeaders, 'Content-Type': 'text/plain' },
  body: '',
});

const rpcResponse = (id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id: id ?? null,
  result,
});

const rpcError = (id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

const parseBody = (event: LambdaEvent) => {
  if (!event.body) throw new Error('Missing request body.');

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  return JSON.parse(rawBody) as JsonRpcRequest | JsonRpcRequest[];
};

type AuthResult =
  | { ok: true; verifiedAgentName?: string; oauthPrincipal?: ResolvedOAuthPrincipal }
  | {
      ok: false;
      reason: 'missing_token' | 'missing_authorization' | 'invalid_authorization';
      /** Set when a bearer WAS presented and the OAuth path was the one that refused it. */
      oauthFailure?: OAuthPrincipalFailure;
    };

/** The audience this deployment issues and accepts tokens for (W14 F10). */
const mcpRequestOrigin = (event: LambdaEvent): string =>
  resolveRequestOrigin({
    ...(event.headers ? { headers: event.headers } : {}),
    ...(process.env.URL ? { fallbackUrl: process.env.URL } : {}),
  });

/**
 * EVERY URI that names this deployment's MCP endpoint, not just the one the
 * current request happened to arrive on.
 *
 * One Netlify site answers on several hosts at once — `<site>.netlify.app`,
 * each custom domain and its `www.`/apex twin, and a deploy alias — and the
 * OAuth flow and the MCP traffic do not have to arrive on the same one: the
 * human approves consent in a browser (whatever host the connector sent them
 * to, and Netlify's own domain canonicalization may move them), while the
 * connector then calls `/mcp` on the URL it was configured with. Binding the
 * token to only the consent-time host turned that ordinary difference into a
 * PERMANENT 401 on a grant that was genuinely approved, with no diagnostic and
 * no way out — reconnecting just reproduced it.
 *
 * `process.env.URL` (this site's primary URL) and `process.env.DEPLOY_URL`
 * (this specific deploy) are set by the Netlify runtime itself, so no new
 * configuration is involved and no other tenant's name can appear here.
 */
const mcpResourceAudiences = (event: LambdaEvent): string[] => {
  const origins = [mcpRequestOrigin(event), process.env.URL, process.env.DEPLOY_URL]
    .map((origin) => toNonEmptyString(origin)?.replace(/\/+$/, ''))
    .filter((origin): origin is string => Boolean(origin));

  return [...new Set(origins.map((origin) => `${origin}/mcp`))];
};

/**
 * perf/drop-verify-hop-cache-scope, Change 3: an uncached governance-blob read
 * on EVERY single request, even though the same bearer token is presented
 * over and over by the same long-lived MCP client. A tiny module-scope memo —
 * 60s TTL, keyed by a SHA-256 hash of the token (never the raw token itself,
 * so a leaked heap snapshot/log of this map never carries a usable
 * credential) — removes that read for the common repeat-caller case.
 *
 * Only a POSITIVE resolution is ever memoized. An unknown, malformed,
 * expired, or REVOKED token is never written to the map — every such request
 * re-checks the store live, every time, so a revocation (or an attacker
 * guessing tokens) is never masked by a stale cache entry. The memo therefore
 * only ever makes an ALREADY-valid caller's repeat calls cheaper; it never
 * makes an invalid caller's calls succeed, or fail slower.
 *
 * DELIBERATELY NOT applied to resolveOAuthPrincipalForRequest below: this
 * repo already has a hard, tested guarantee that an OAuth token revocation
 * "must take effect on the next request, with no cache to wait out" (see
 * mcp-oauth.test.ts's "a revoked access token stops working immediately").
 * A 60s positive memo on that path would let a revoked-but-still-cached OAuth
 * token keep authorizing requests for up to a minute after /oauth/revoke
 * returns 200 — a real regression the spec's own "never cache a NEGATIVE
 * result" instruction does not by itself prevent, since the revoked check
 * only ever runs again on a cache MISS. Only the per-agent bearer-token path
 * (getAgentKeysDoc via resolveVerifiedAgentNameForRequest) is memoized: it
 * carries no equivalent immediate-revocation contract today.
 */
const AUTH_MEMO_TTL_MS = 60_000;

type AuthMemoEntry<T> = { value: T; expiresAtMs: number };

const verifiedAgentNameMemo = new Map<string, AuthMemoEntry<string>>();

/** Test-only: clears the auth memo so one test's cached token can't leak into the next. */
export const resetAuthMemoForTesting = (): void => {
  verifiedAgentNameMemo.clear();
};

const hashAuthToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

const readAuthMemo = <T>(memo: Map<string, AuthMemoEntry<T>>, key: string, nowMs: number): T | undefined => {
  const entry = memo.get(key);
  if (!entry) return undefined;
  if (entry.expiresAtMs <= nowMs) {
    memo.delete(key);
    return undefined;
  }
  return entry.value;
};

const writeAuthMemo = <T>(memo: Map<string, AuthMemoEntry<T>>, key: string, value: T, nowMs: number): void => {
  memo.set(key, { value, expiresAtMs: nowMs + AUTH_MEMO_TTL_MS });
};

/**
 * W14 F10: the OAuth resource-server check. A bearer token that resolves to a
 * live, unexpired, correctly-audienced access token in THIS site's store
 * satisfies the gate on its own — that is the whole point of the authorization
 * server: a client a human approved no longer needs the shared secret.
 *
 * Failure is silent by design (null, never a throw): a store outage must read
 * as "this token does not authorize you", which falls through to the shared-
 * secret gate below and, absent that, to a 401. The alternative — 500ing —
 * would turn a blob hiccup into an outage for shared-key callers who never
 * needed OAuth at all.
 *
 * NOT memoized — see the Change-3 comment above the auth memo for why this
 * one path keeps its per-request store read.
 */
const resolveOAuthPrincipalForRequest = async (
  event: LambdaEvent,
  token: string
): Promise<{ principal?: ResolvedOAuthPrincipal; failure?: OAuthPrincipalFailure }> => {
  /**
   * Still silent to the CALLER (no principal, so the gate falls through to the
   * shared-secret path and, absent that, to a 401) — but never again silent to
   * the operator. A governance-store outage used to be indistinguishable in
   * the logs from a bad token, which is how an infrastructure failure got
   * debugged as a credentials problem.
   */
  const logStoreError = (detail: string) =>
    event.log?.({ event: 'mcp_oauth_store_error', rpcMethod: null, slug: null, error: detail });

  try {
    const store = (await getGovernanceBlobStore(event)) as unknown as OAuthBlobStore;
    const resolved = await describeOAuthPrincipal(store, {
      token,
      site: getSiteIdentity().siteId,
      resourceUris: mcpResourceAudiences(event),
      nowMs: Date.now(),
    });
    if (resolved.ok) return { principal: resolved.principal };
    // The store was ACQUIRED but could not be READ. That reaches here as a
    // resolution rather than a throw (the MCP endpoint must answer 401, not
    // 500, when its own store is sick) — so the log line has to be emitted
    // here too, or a read outage would pass through unremarked while only an
    // ACQUISITION outage got recorded.
    if (resolved.reason === 'store_error') logStoreError(resolved.detail ?? 'The OAuth store could not be read.');
    return { failure: resolved.reason };
  } catch (error) {
    // The store could not even be acquired (blob context missing, fail-closed).
    logStoreError(error instanceof Error ? error.message : String(error));
    return { failure: 'store_error' };
  }
};

/**
 * W11 T11.10: resolves a verified per-agent identity from the Authorization
 * bearer token, independent of the shared-secret gate below — a store read
 * that throws (governance store unreachable/corrupt) degrades to "not
 * verified" rather than crashing the request, the same resilience posture
 * `resolveRolesForPrincipalAsync` already uses for the users-store read.
 */
const resolveVerifiedAgentNameForRequest = async (event: LambdaEvent, token: string): Promise<string | undefined> => {
  const nowMs = Date.now();
  const tokenKey = hashAuthToken(token);
  const cached = readAuthMemo(verifiedAgentNameMemo, tokenKey, nowMs);
  if (cached !== undefined) return cached;

  try {
    const store = await getGovernanceBlobStore(event);
    const doc = await getAgentKeysDoc(store as unknown as AgentKeysBlobStore);
    const resolved = resolveVerifiedAgentName(token, getSiteIdentity().siteId, doc) ?? undefined;
    if (resolved) writeAuthMemo(verifiedAgentNameMemo, tokenKey, resolved, nowMs);
    return resolved;
  } catch {
    return undefined;
  }
};

/**
 * The shared `MCP_HTTP_AUTH_TOKEN` gate (unchanged decision tree below) PLUS
 * the new verified-per-agent-token path (W11 T11.10): a bearer token that
 * resolves to an ACTIVE per-agent key satisfies the gate on its own — the
 * `Authorization: Bearer <agent token>` path the OQ-W11-5 ruling asks for —
 * and its resolved `agent_name` is carried on `verifiedAgentName` so
 * `callTool` can override the self-declared `agent_name` for every tool
 * call in this request. An unresolved/absent/revoked agent token changes
 * nothing: the shared-secret gate still runs exactly as it did before this
 * task (the deprecated fallback the brief keeps, not a forced cutover).
 *
 * W14 F10 adds a THIRD independent path, checked before the shared secret: an
 * OAuth access token this site's own authorization server issued to a client a
 * human approved. It stands alone — it works with the shared token set, unset,
 * or rotated — because that is what makes OAuth an answer to F9 rather than
 * another way to spell the same shared secret.
 */
const getAuthResult = async (event: LambdaEvent): Promise<AuthResult> => {
  const authorization = toNonEmptyString(getHeader(event.headers, 'authorization'));
  const bearerToken = getBearerToken(authorization);
  const verifiedAgentName = bearerToken ? await resolveVerifiedAgentNameForRequest(event, bearerToken) : undefined;
  if (verifiedAgentName) return { ok: true, verifiedAgentName };

  const token = toNonEmptyString(process.env.MCP_HTTP_AUTH_TOKEN);

  // Try OAuth only when the bearer is not simply the shared secret — the
  // common case must not pay a second blob read.
  let oauthFailure: OAuthPrincipalFailure | undefined;
  if (bearerToken && !(token && safeSecretsMatch(bearerToken, token))) {
    const resolved = await resolveOAuthPrincipalForRequest(event, bearerToken);
    if (resolved.principal) return { ok: true, oauthPrincipal: resolved.principal };
    oauthFailure = resolved.failure;
  }

  const refuse = (reason: Exclude<AuthResult, { ok: true }>['reason']): AuthResult => ({
    ok: false,
    reason,
    ...(oauthFailure ? { oauthFailure } : {}),
  });

  if (!token) {
    // W14 F1: an UNSET shared token opens the gate ONLY in a non-lambda dev/test
    // runtime. In a production function runtime it must FAIL CLOSED — a verified
    // per-agent token or an OAuth token (both returned above) is then the only
    // way through — so a site that ships with no MCP_HTTP_AUTH_TOKEN (as
    // drluriescience did) is never wide open. Same lambda-detection posture as
    // the blob-store fail-closed guard. An explicitly-empty token ('') already
    // fails closed below, unchanged.
    const inLambdaRuntime = Boolean(process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME);
    if (process.env.MCP_HTTP_AUTH_TOKEN === undefined && !inLambdaRuntime) {
      return { ok: true };
    }
    return refuse('missing_token');
  }

  const dedicatedToken = toNonEmptyString(getHeader(event.headers, 'x-mcp-auth-token'));
  // Header paths first, URL key last: same secret, three carriers, ordered by
  // how safe the carrier is (see getUrlKeyToken).
  const providedTokens = [dedicatedToken, bearerToken, getUrlKeyToken(event)].filter((provided): provided is string =>
    Boolean(provided)
  );

  if (providedTokens.length === 0) return refuse('missing_authorization');

  return providedTokens.some((provided) => safeSecretsMatch(provided, token))
    ? { ok: true }
    : refuse('invalid_authorization');
};

const getAuthDiagnosticReason = (reason: Exclude<AuthResult, { ok: true }>['reason']) => `mcp_auth_${reason}`;

export const getHeader = (headers: LambdaEvent['headers'], name: string) => {
  const normalizedName = name.toLowerCase();
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === normalizedName);

  return entry?.[1];
};

const getRequestId = (event: LambdaEvent) =>
  toNonEmptyString(getHeader(event.headers, 'x-nf-request-id')) ?? randomUUID();

const getSlugFromValue = (value: unknown): string | null => {
  const record = getRecordValue(value);
  if (!record) return null;

  return (
    toNonEmptyString(record.slug) ??
    toNonEmptyString(record.articleSlug) ??
    toNonEmptyString(record.article_slug) ??
    getSlugFromValue(record.publication) ??
    getSlugFromValue(record.content)
  );
};

const getRpcSlug = (request: JsonRpcRequest) =>
  getSlugFromValue(request.params?.arguments) ?? getSlugFromValue(request.params);

const createStructuredLogger = (requestId: string): StructuredLogger => {
  return ({ event: logEvent, rpcMethod = null, slug = null, ...details }) => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        requestId,
        rpcMethod,
        slug,
        event: logEvent,
        ...details,
      })
    );
  };
};

const withStructuredLogger = (event: LambdaEvent): LambdaEvent => {
  const requestId = event.requestId ?? getRequestId(event);

  return {
    ...event,
    requestId,
    log: event.log ?? createStructuredLogger(requestId),
  };
};

const createPublishKeyHeaders = (event: LambdaEvent, publishSecret: string) => ({
  ...(event.headers ?? {}),
  ...(getHeader(event.headers, 'x-nf-site-id') ? { 'x-nf-site-id': getHeader(event.headers, 'x-nf-site-id') } : {}),
  ...(getHeader(event.headers, 'x-nf-deploy-id')
    ? { 'x-nf-deploy-id': getHeader(event.headers, 'x-nf-deploy-id') }
    : {}),
  'x-publish-key': publishSecret,
  'content-type': 'application/json',
});

export const invokeSaveArtifact = async (event: LambdaEvent, payload: Record<string, unknown>) => {
  const publishSecret = process.env.PUBLISH_SECRET || process.env.NETLIFY_PUBLISH_SECRET;

  if (!publishSecret) {
    return toolError('Server-side artifact storage is not configured.');
  }

  const saveResponse = await saveArtifactHandler({
    httpMethod: 'POST',
    headers: createPublishKeyHeaders(event, publishSecret),
    body: JSON.stringify(payload),
    log: event.log,
    requestId: event.requestId,
    rpcMethod: event.rpcMethod,
    slug: event.slug,
  });

  const bodyText = saveResponse.body ?? '';
  let parsedBody: Record<string, unknown> = {};

  if (bodyText) {
    try {
      parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      return toolError(`HTTP ${saveResponse.statusCode}: ${bodyText}`);
    }
  }

  if (saveResponse.statusCode < 200 || saveResponse.statusCode >= 300) {
    return toolError(
      typeof parsedBody.error === 'string' ? parsedBody.error : `HTTP ${saveResponse.statusCode}: ${bodyText}`
    );
  }

  return parsedBody;
};

// W11 T11.10: tool names whose `agent_name` argument is the free-form CMS
// object-store attribution string (creation-policy allowlists, object
// history, lock ownership) — the ONLY place a verified per-agent token
// should override it.
const CMS_AGENT_NAME_ATTRIBUTION_TOOLS = new Set([
  'object_create',
  'object_create_variant',
  'object_instantiate_template',
  'object_instantiate_section_template',
  'site_apply_theme',
  'site_apply_brand_imagery',
  'product_set_price',
  'order_reissue',
  // Object-lock owner attribution bug (2026-08-28): these three forward
  // agent_name into the same object-store.ts `agentPrincipal()` derivation
  // as the tools above, so a verified per-agent token must override a
  // self-declared name here too, not just on the write verbs.
  'object_checkout',
  'object_refresh_lock',
  'object_checkin',
  // W1.0 (publishing plugin, 2026-08-31): the two verbs that carried NO
  // attribution at all. Every article a chat-app plugin writes landed its
  // patch and its publish as 'unattributed-agent', so the ledger could not
  // answer "who published this" for the one actor class that is not the
  // autonomous engine. Same object-store.ts agentPrincipal() derivation as
  // the tools above, so a verified per-agent token must override here too.
  'object_patch',
  'object_publish',
]);

const callTool = async (event: LambdaEvent, name: unknown, args: unknown) => {
  const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  // A verified per-agent token (see getAuthResult) overrides whatever
  // self-declared agent_name the CMS-attribution tool arguments carried —
  // the one place that attribution becomes trustworthy for those tools.
  if (event.verifiedAgentName && typeof name === 'string' && CMS_AGENT_NAME_ATTRIBUTION_TOOLS.has(name)) {
    input.agent_name = event.verifiedAgentName;
  }

  switch (name) {
    case 'ping':
      return callPing();
    case 'capability_status':
      // T16.5: pure, synchronous, in-process — no store round trip, nothing
      // secret-shaped in the response (booleans + env-var NAMES only).
      return toolResult(getCapabilityStatus());
    case 'membership_status':
      // W18 T18.7: the fleet probe's `membership` family — store reachability +
      // policy provenance, non-secret by construction (names/numbers only).
      return toolResult(await getMembershipStatus(event));
    case 'deploy_status':
      return callDeployStatus(event, input);
    case 'verify_article_images':
      return callVerifyArticleImages(event, input);
    case 'trigger_netlify_build':
      return callTriggerNetlifyBuild(event, input);
    case 'release_to_production':
      // QA-W16-1: a 502/timeout on this call does NOT mean the release did
      // not happen — it very often already has. idempotency_key makes a
      // same-key retry replay the first result instead of firing a second
      // forceBuild.
      return withIdempotentToolCall(event, name, input.idempotency_key, () => callReleaseToProduction(event, input));
    case 'create_agent_artifact_job':
      return withIdempotentToolCall(event, name, input.idempotency_key, () => callCreateAgentArtifactJob(event, input));
    case 'get_agent_artifact_job_status':
      return callGetAgentArtifactJobStatus(event, input);
    case 'resume_agent_artifact_job':
      return callResumeAgentArtifactJob(event, input);
    case 'get_agent_artifact_by_slot':
      return callGetAgentArtifactBySlot(event, input);
    case 'create_pdf_template':
      return withIdempotentToolCall(event, name, input.idempotency_key, () => callCreatePdfTemplate(event, input));
    case 'list_pdf_templates':
      return callListPdfTemplates(event, input);
    case 'get_pdf_template':
      return callGetPdfTemplate(event, input);
    case 'validate_pdf_template':
      return callValidatePdfTemplate(event, input);
    case 'get_pdf_template_validation':
      return callGetPdfTemplateValidation(event, input);
    case 'publish_pdf_template':
      return callPublishPdfTemplate(event, input);
    case 'delete_pdf_template':
      return callDeletePdfTemplate(event, input);
    case 'health':
      return callPdfToolHealth(event, input);
    // T12.13 capture bridge — see the block comment above callCreateCaptureJob in
    // mcp-tool-handlers.ts. create is idempotency-keyed by pdf-tool itself on a
    // server-derived request scope, so it needs no withIdempotentToolCall wrapper:
    // a retried create re-attaches to the running crawl by construction.
    case 'create_capture_job':
      return callCreateCaptureJob(event, input);
    case 'get_capture_job_status':
      return callGetCaptureJobStatus(event, input);
    case 'get_capture_snapshot':
      return callGetCaptureSnapshot(event, input);
    case 'search_images':
      return callSearchImages(event, input);
    case 'get_image_search_job_status':
      return callGetImageSearchJobStatus(event, input);
    case 'get_image_search_bank':
      return callGetImageSearchBank(event, input);
    case 'update_image_search_candidate':
      return callUpdateImageSearchCandidate(event, input);
    case 'import_image_from_url':
      return callImportImageFromUrl(event, input);
    case 'import_images_from_url':
      return callImportImagesFromUrl(event, input);
    case 'get_image_search_policy':
      return callGetImageSearchPolicy(event, input);
    case 'set_image_search_policy':
      return callSetImageSearchPolicy(event, input);
    case 'get_image_model_policy':
      return callGetImageModelPolicy(event, input);
    case 'set_image_model_policy':
      return callSetImageModelPolicy(event, input);
    case 'create_artifact_upload_intent':
      return callCreateArtifactUploadIntent(event, input);
    case 'create_artifact_from_url': {
      const requestId = toNonEmptyString(input.requestId);
      if (!requestId) return toolError('requestId is required.');

      const artifactKind = toNonEmptyString(input.artifactKind);
      if (!artifactKind || !artifactKindValues.includes(artifactKind as ArtifactKind)) {
        return toolError(`artifactKind must be one of: ${artifactKindValues.join(', ')}.`);
      }

      const contentType = toNonEmptyString(input.contentType);
      if (!contentType) return toolError('contentType is required.');

      const sourceUrl = toNonEmptyString(input.sourceUrl);
      if (!sourceUrl) return toolError('sourceUrl is required.');

      const expectedSizeBytes = Number(input.expectedSizeBytes);
      if (!Number.isInteger(expectedSizeBytes) || expectedSizeBytes < 0) {
        return toolError('expectedSizeBytes must be a non-negative integer.');
      }

      const expectedSha256 = toNonEmptyString(input.expectedSha256)?.toLowerCase();
      if (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
        return toolError('expectedSha256 must be a 64-character hex digest.');
      }

      const filename = toNonEmptyString(input.filename);
      if (filename && !isSafeArtifactFilename(filename)) {
        return toolError('filename contains unsafe characters or is too long.');
      }

      const label = toNonEmptyString(input.label);
      if (label && !isSafeArtifactText(label, artifactReferenceLimits.label)) {
        return toolError('label contains unsafe characters or is too long.');
      }

      const tags = Array.isArray(input.tags) ? (input.tags as string[]) : undefined;
      if (tags) {
        if (tags.length > artifactReferenceLimits.tags) {
          return toolError(`Too many tags. Max: ${artifactReferenceLimits.tags}`);
        }
        for (const tag of tags) {
          if (!isSafeArtifactText(tag, artifactReferenceLimits.tag)) {
            return toolError(`Tag "${tag}" contains unsafe characters or is too long.`);
          }
        }
      }

      const metadata = getRecordValue(input.metadata);

      const result = await saveArtifactFromUrl({
        requestId,
        artifactKind: artifactKind as ArtifactKind,
        contentType,
        sourceUrl,
        expectedSizeBytes,
        expectedSha256,
        filename,
        label,
        tags,
        metadata,
        event,
      });

      if (!result.ok) {
        return toolError(result.error, {
          statusCode: result.statusCode,
          sourceUrl: result.sourceUrl,
          maxBytes: result.maxBytes,
        });
      }

      return toolResult(result);
    }
    case 'save_artifact':
      return callArtifactUpload(event, {
        requestId: input.requestId,
        artifactKind: input.artifactKind,
        contentType: input.contentType,
        filename: input.filename,
        encoding: input.encoding,
        expectedSizeBytes: input.expectedSizeBytes,
        expectedSha256: input.expectedSha256,
        localSizeBytes: input.localSizeBytes,
        localSha256: input.localSha256,
        payload: input.payload,
        label: input.label,
        tags: input.tags,
        metadata: input.metadata,
      });
    case 'list_artifacts_for_request':
      return listArtifactsForRequest(event, input.requestId);
    case 'get_artifact_metadata':
      return getArtifactMetadata(event, input.requestId, input.sha256);
    case 'list_artifacts_by_kind':
      return listArtifactsByKind(event, input);
    case 'list_artifacts_by_request':
      return listArtifactsByRequest(event, input);
    case 'search_artifacts':
      return searchArtifacts(event, input);
    case 'soft_delete_artifact':
      return softDeleteArtifact(event, input);
    case 'restore_artifact':
      return restoreArtifact(event, input);
    case 'migrate_artifact_indexes':
      return migrateArtifactIndexes(event, input);
    case 'wipe_blob_stores':
      return wipeBlobStores(event, input);
    case 'reconcile_artifact_indexes':
      return reconcileArtifactIndexes(event, input);

    // ── Object verbs (T0.9) → object-store.ts (publish key injected). ──
    case 'object_get':
      return callObjectAction(event, {
        action: 'get',
        object_type: input.object_type,
        object_id: input.object_id,
        ...(input.projection ? { projection: input.projection } : {}),
      });
    case 'object_list':
      return callObjectAction(event, { action: 'list', object_type: input.object_type, status: input.status });
    case 'object_create':
      // QA-W16-1: object_create mints a fresh object_id by default, so a
      // naive retry after a timeout/502 creates a second object even though
      // the first write landed. idempotency_key makes a same-key retry
      // replay the original created object instead.
      return withIdempotentToolCall(event, name, input.idempotency_key, () =>
        callObjectAction(event, {
          action: 'create',
          object_type: input.object_type,
          site: input.site,
          body: input.body,
          requested_id: input.requested_id,
          agent_name: input.agent_name,
        })
      );
    case 'object_create_variant':
      return callObjectAction(event, {
        action: 'create_variant',
        object_type: 'content_item',
        source_object_id: input.source_object_id,
        slug: input.slug,
        requested_id: input.requested_id,
        dry_run: input.dry_run,
        agent_name: input.agent_name,
      });
    case 'object_instantiate_template':
      return callObjectAction(event, {
        action: 'instantiate',
        template_id: input.template_id,
        site: input.site,
        route: input.route,
        title: input.title,
        page_type: input.page_type,
        seo: input.seo,
        requested_id: input.requested_id,
        dry_run: input.dry_run,
        agent_name: input.agent_name,
      });
    case 'object_instantiate_section_template':
      return callObjectAction(event, {
        action: 'instantiate_section',
        section_template_id: input.section_template_id,
        target: input.target,
        dry_run: input.dry_run,
        agent_name: input.agent_name,
      });
    case 'site_apply_theme':
      return callObjectAction(event, {
        action: 'apply_theme',
        theme_id: input.theme_id,
        site_id: input.site_id,
        lock_token: input.lock_token,
        expected_record_version: input.expected_record_version,
        dry_run: input.dry_run,
        agent_name: input.agent_name,
      });
    case 'site_apply_brand_imagery':
      return callObjectAction(event, {
        action: 'apply_brand_imagery',
        visual_standard_id: input.visual_standard_id,
        theme_id: input.theme_id,
        site_id: input.site_id,
        lock_token: input.lock_token,
        expected_record_version: input.expected_record_version,
        dry_run: input.dry_run,
        agent_name: input.agent_name,
      });
    case 'brand_imagery_propose':
      return callBrandImageryPropose(event, input);
    case 'object_checkout':
      // Object-lock owner attribution bug (2026-08-28): agent_name was never
      // forwarded here, so every agent checkout recorded the object-store.ts
      // `agentPrincipal()` fallback ('unattributed-agent') as the lock owner
      // regardless of what the caller declared.
      return callObjectAction(event, {
        action: 'checkout',
        object_type: input.object_type,
        object_id: input.object_id,
        lease_seconds: input.lease_seconds,
        agent_name: input.agent_name,
      });
    case 'object_refresh_lock':
      return callObjectAction(event, {
        action: 'refresh_lock',
        object_type: input.object_type,
        object_id: input.object_id,
        lock_token: input.lock_token,
        lease_seconds: input.lease_seconds,
        agent_name: input.agent_name,
      });
    case 'object_checkin':
      return callObjectAction(event, {
        action: 'checkin',
        object_type: input.object_type,
        object_id: input.object_id,
        lock_token: input.lock_token,
        agent_name: input.agent_name,
      });
    case 'object_patch':
      return callObjectAction(event, {
        action: 'patch',
        object_type: input.object_type,
        object_id: input.object_id,
        lock_token: input.lock_token,
        expected_record_version: input.expected_record_version,
        ops: input.ops,
        agent_name: input.agent_name,
      });
    case 'object_validate':
      return callObjectAction(event, {
        action: 'validate',
        object_type: input.object_type,
        object_id: input.object_id,
        candidate_patch: input.candidate_patch,
        body: input.body,
        requested_id: input.requested_id,
        site: input.site,
      });
    case 'object_inventory':
      return callObjectAction(event, {
        action: 'inventory',
        object_type: input.object_type,
        object_id: input.object_id,
        status: input.status,
        requires_approval: input.requires_approval,
        review_state: input.review_state,
        pending_changes: input.pending_changes,
      });

    // ── Review + publish verbs (P1) → object-store.ts (publish key injected).
    //    Faithful passthrough: object-verbs.ts owns locks, the publish gate,
    //    and the human-only review rule. ──
    case 'object_submit_review':
      return callObjectAction(event, {
        action: 'submit_review',
        object_type: input.object_type,
        object_id: input.object_id,
        lock_token: input.lock_token,
        note: input.note,
        requested_publish_action: input.requested_publish_action,
      });
    case 'object_review_decide':
      return callObjectAction(event, {
        action: 'review_decide',
        object_type: input.object_type,
        object_id: input.object_id,
        decision: input.decision,
        note: input.note,
        publish_action: input.publish_action,
        approval_pin: input.approval_pin,
      });
    // ── Marginalia (W15 S4, MVP) → object-store.ts (publish key injected). ──
    case 'marginalia_create':
      return callObjectAction(event, {
        action: 'marginalia_create',
        object_type: input.object_type,
        object_id: input.object_id,
        section_id: input.section_id,
        node_id: input.node_id,
        field: input.field,
        selected_text: input.selected_text,
        body: input.body,
      });
    case 'marginalia_reply':
      return callObjectAction(event, {
        action: 'marginalia_reply',
        object_type: input.object_type,
        object_id: input.object_id,
        thread_id: input.thread_id,
        body: input.body,
        parent_comment_id: input.parent_comment_id,
      });
    case 'marginalia_list':
      return callObjectAction(event, {
        action: 'marginalia_list',
        object_type: input.object_type,
        object_id: input.object_id,
      });
    case 'marginalia_resolve':
      return callObjectAction(event, {
        action: 'marginalia_resolve',
        object_type: input.object_type,
        object_id: input.object_id,
        thread_id: input.thread_id,
        status: input.status,
      });

    case 'object_discard':
      return callObjectAction(event, {
        action: 'discard',
        object_type: input.object_type,
        object_id: input.object_id,
        lock_token: input.lock_token,
        entries: input.entries,
      });
    case 'object_retire':
      return callObjectAction(event, {
        action: 'retire',
        object_type: input.object_type,
        object_id: input.object_id,
        lock_token: input.lock_token,
        ...(input.redirect_to !== undefined ? { redirect_to: input.redirect_to } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
    case 'object_publish':
      // QA-W16-1: publish is largely self-idempotent already (D§5.6: a retry
      // with the same published_time re-materializes byte-identical output
      // and the committer no-ops) EXCEPT the final stamp, which still bumps
      // `version` and appends a fresh `history` entry on every call. A
      // same-key retry after a timeout/502 replays the original receipt
      // instead of stacking a redundant stamp/history entry.
      return withIdempotentToolCall(event, name, input.idempotency_key, () =>
        callObjectPublish(event, {
          action: 'publish_by_time',
          object_type: input.object_type,
          object_id: input.object_id,
          lock_token: input.lock_token,
          published_time: input.published_time,
          artifact_set: input.artifact_set,
          release_build: input.release_build,
          producer: input.producer,
          agent_name: input.agent_name,
        })
      );
    case 'product_set_price':
      return callProductSetPrice(event, input);
    case 'commerce_orders':
      return callCommerceOrders(event, input);
    case 'order_reissue':
      return callOrderReissue(event, input);
    case 'object_contract': {
      const objectType = toNonEmptyString(input.object_type);
      if (!objectType || !OBJECT_CONTRACT_TYPES.includes(objectType as ObjectType)) {
        return toolError(`object_type must be one of ${OBJECT_CONTRACT_TYPES.join('|')}.`, {
          error_code: 'invalid_object_type',
        });
      }
      // Derived from the enforcing schemas/registries/policy so it cannot
      // drift. REVIEW (brand-imagery wave): `site` additionally reports the
      // LIVE `brandImageryOverrides` guardrail on its
      // `brand_imagery_override_policy` constraint — BRIEF §3.7 makes this
      // the read path (`contractPrefetch` already calls object_contract), and
      // buildObjectContract is synchronous, so the runtime-override value has
      // to be resolved HERE and passed in. Without it the contract reported
      // the hardcoded default 'allow' on every site, including a locked one.
      // One governance blob read, `site` only; any failure degrades to
      // 'allow' inside getBrandImageryOverridePolicy.
      const contractOptions =
        objectType === 'site'
          ? { brandImageryOverridePolicy: await getBrandImageryOverridePolicy(getSiteIdentity().siteId, event) }
          : {};
      return toolResult({ contract: buildObjectContract(objectType as ObjectType, contractOptions) });
    }
    case 'registry_get':
      return callRegistryGet(event, input);

    default:
      break;
  }

  // W18 T18.6b: the membership family — one core, gated on a HUMAN principal.
  // `callerPrincipalFromMcpEvent` mints a human ONLY from an OAuth-bound
  // subject; everything else is an agent and the core answers 403
  // membership_requires_human before any read.
  if (isMembershipTool(name)) {
    const run = () => callMembershipTool(event, name, input);
    return typeof input.idempotency_key === 'string'
      ? withIdempotentToolCall(event, name, input.idempotency_key, run)
      : run();
  }

  return toolError(`Unknown tool: ${String(name)}`);
};

const callMembershipTool = async (event: LambdaEvent, name: string, input: Record<string, unknown>) => {
  const principal = callerPrincipalFromMcpEvent(
    { oauthPrincipal: event.oauthPrincipal, verifiedAgentName: event.verifiedAgentName, requestId: event.requestId },
    input.agent_name
  );
  const { idempotency_key: _idem, agent_name: _agent, ...args } = input;
  const result = await handleMembershipVerb({
    verb: MEMBERSHIP_TOOL_VERBS[name],
    args,
    principal,
    deps: {
      store: await getUsersBlobStore(event),
      // no GoTrue admin token on an MCP request (it exists only on Identity-JWT
      // requests) — invitation e-mails still go out via the store record + the
      // next admin-UI action; identity deletes queue (T18.4).
      oauthStore: async () => (await getGovernanceBlobStore(event)) as unknown as OAuthBlobStore,
      objectStore: async () => (await getSiteObjectsBlobStore(event)) as never,
    },
  });
  if (result.status >= 200 && result.status < 300) return toolResult(result.body);
  return toolError(String(result.body.error ?? 'Membership request failed.'), {
    ...(result.body.error_code ? { error_code: result.body.error_code } : {}),
    status: result.status,
    ...Object.fromEntries(Object.entries(result.body).filter(([k]) => k !== 'error' && k !== 'error_code')),
  });
};

const handleRpcRequest = async (event: LambdaEvent, request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> => {
  const rpcMethod = typeof request.method === 'string' ? request.method : null;
  const slug = getRpcSlug(request);

  event.log?.({ event: 'rpc_request_received', rpcMethod, slug });

  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return rpcError(request.id, -32600, 'Invalid Request');
  }

  const isNotification = !Object.hasOwn(request, 'id');

  if (request.method === 'notifications/initialized') {
    event.log?.({ event: 'rpc_notification_ignored', rpcMethod, slug });
    return undefined;
  }

  if (isNotification) {
    event.log?.({ event: 'rpc_notification_ignored', rpcMethod, slug });
    return undefined;
  }

  switch (request.method) {
    case 'initialize':
      return rpcResponse(request.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: '0.1.0' },
      });
    case 'tools/list':
      // Serialize to the MCP wire shape: adds `annotations` (so a client stops
      // confirming reads — the live ChatGPT Agent showed "Read actions: none")
      // and drops the internal `governance` field, which is this repo's chat
      // autonomy classification and has no business in a protocol response.
      return rpcResponse(request.id, { tools: visibleToolDefinitions(event).map(toWireTool) });
    case 'tools/call':
      event.log?.({ event: 'rpc_tool_call_started', rpcMethod, slug, toolName: request.params?.name });
      return rpcResponse(
        request.id,
        await callTool({ ...event, rpcMethod, slug }, request.params?.name, request.params?.arguments)
      );
    default:
      event.log?.({ event: 'rpc_method_not_found', rpcMethod, slug });
      return rpcError(request.id, -32601, `Method not found: ${request.method}`);
  }
};

/**
 * The tool surface THIS site exposes. Identical to TOOL_DEFINITIONS for a site
 * that injects every optional handler; a site missing one omits the tools that
 * depend on it entirely.
 */
export const visibleToolDefinitions = (event?: Pick<LambdaEvent, 'oauthPrincipal'>): ToolDefinition[] =>
  TOOL_DEFINITIONS.filter(
    (tool) =>
      !INTERNAL_ONLY_TOOLS.has(tool.name) &&
      (hasVerifyArticleImages() || !OPTIONAL_HANDLER_TOOLS.has(tool.name)) &&
      // W18 T18.6b: membership tools exist only for an OAuth-bound HUMAN —
      // shared-token / per-agent sessions never even see them (the core
      // refuses them anyway: defence in depth).
      (!isMembershipTool(tool.name) || Boolean(event?.oauthPrincipal))
  );

export const _mcpInternal = {
  getArtifactIndexBlobStore,
  objectStoreHandler,
  resetAuthMemoForTesting,
  readAuthMemo,
  writeAuthMemo,
  hashAuthToken,
  verifiedAgentNameMemo,
  AUTH_MEMO_TTL_MS,
  resolveArtifactJobInlineWaitBudgetMs,
  resolveReleaseWaitBudgetSeconds,
};

export const handler = async (rawEvent: LambdaEvent, context?: LambdaContext) => {
  instanceInvocationCount += 1;

  const remainingTimeMs =
    typeof context?.getRemainingTimeInMillis === 'function' ? context.getRemainingTimeInMillis() : undefined;
  const event = withStructuredLogger({
    ...rawEvent,
    ...(remainingTimeMs !== undefined ? { invocationDeadlineMs: Date.now() + remainingTimeMs } : {}),
  });
  event.log?.({
    event: 'mcp_request_received',
    rpcMethod: null,
    slug: null,
    httpMethod: event.httpMethod,
    instanceAgeMs: Date.now() - INSTANCE_BOOTED_AT_MS,
    instanceInvocations: instanceInvocationCount,
    coldStart: instanceInvocationCount === 1,
    ...(remainingTimeMs !== undefined ? { invocationBudgetMs: remainingTimeMs } : {}),
  });
  if (event.httpMethod === 'OPTIONS') {
    return emptyResponse(204);
  }

  // Unauthenticated liveness probe for uptime monitors and keep-warm pings:
  // GET /mcp?health=1 answers 200 with non-sensitive instance diagnostics.
  // Plain GET stays 405 below, as the Streamable HTTP spec requires for a
  // server that does not offer an SSE stream.
  const healthProbe = toNonEmptyString(event.queryStringParameters?.health);
  if (event.httpMethod === 'GET' && healthProbe) {
    /**
     * `?health=auth` additionally answers the two questions an operator has
     * when a connector reports an authorization failure and the logs are on
     * the far side of a Netlify dashboard:
     *
     *   - WHICH audiences will this deploy accept a token for? A token minted
     *     through a host that is not in this list is refused forever, and that
     *     is invisible from the client side (see mcpResourceAudiences).
     *   - Can this deploy READ its own token store at all? A governance-store
     *     outage refuses every OAuth token while looking exactly like a bad
     *     credential.
     *
     * Both answers are public facts — hostnames this site already serves, and
     * a boolean. No token, no key, and not even whether a shared secret is
     * configured, goes into this response.
     */
    const authDiagnostics =
      healthProbe === 'auth'
        ? {
            oauth: {
              realm: getSiteIdentity().siteSlug,
              accepted_audiences: mcpResourceAudiences(event),
              token_store_reachable: await getGovernanceBlobStore(event)
                .then((store) => store.get('oauth/__health_probe__').then(() => true))
                .catch(() => false),
            },
          }
        : {};

    return response(200, {
      ok: true,
      server: SERVER_DIAGNOSTIC_NAME,
      instance_age_ms: Date.now() - INSTANCE_BOOTED_AT_MS,
      instance_invocations: instanceInvocationCount,
      ...authDiagnostics,
    });
  }

  // MCP Streamable HTTP session termination. This handler holds no durable,
  // per-session state to tear down (no in-memory or blob-backed session
  // store keyed by Mcp-Session-Id exists anywhere in this module), so DELETE
  // is a safe no-op: acknowledge with 204 rather than falling through to the
  // POST-only branch below, which would 405 a method the CORS preflight
  // above (jsonHeaders' Access-Control-Allow-Methods) already told the
  // client was allowed.
  if (event.httpMethod === 'DELETE') {
    return emptyResponse(204);
  }

  if (event.httpMethod !== 'POST') {
    return response(405, rpcError(null, -32000, 'Method not allowed.'), { ...jsonHeaders, Allow: 'POST' });
  }

  const authResult = await getAuthResult(event);
  if (!authResult.ok) {
    const diagnosticReason = getAuthDiagnosticReason(authResult.reason);
    event.log?.({
      event: 'mcp_auth_rejected',
      rpcMethod: null,
      slug: null,
      hasMcpHttpAuthToken: Boolean(toNonEmptyString(process.env.MCP_HTTP_AUTH_TOKEN)),
      hasMcpAuthTokenHeader: Boolean(toNonEmptyString(getHeader(event.headers, 'x-mcp-auth-token'))),
      hasAuthorizationHeader: Boolean(toNonEmptyString(getHeader(event.headers, 'authorization'))),
      // Presence only — the key itself never reaches a log line.
      hasUrlKey: Boolean(getUrlKeyToken(event)),
      reason: diagnosticReason,
      // WHY the OAuth path refused, when a bearer was presented at all. This
      // is the line that separates "the client sent a bad token" from "this
      // deployment rejected a good one" — see mcpResourceAudiences.
      ...(authResult.oauthFailure ? { oauthFailure: authResult.oauthFailure } : {}),
      ...(authResult.oauthFailure === 'audience_mismatch' ? { audiences: mcpResourceAudiences(event) } : {}),
    });

    // W14 F10 / RFC 9728 §5.1: this challenge is how an OAuth-capable client
    // DISCOVERS the authorization server. Without it a connector has no way to
    // start a flow — it just reports "unauthorized" forever, which is exactly
    // the dead end F1's hardening left Wolf's connector in.
    // `audience_mismatch` and `store_error` are OUR faults, not the caller's,
    // and they are the two an operator cannot otherwise tell from a bad token
    // — so they travel in the body where `curl -i` shows them. `no_record` and
    // `expired` stay in the log only: naming them would make this endpoint a
    // (weak, but free) oracle about which tokens exist.
    const disclosableFailure =
      authResult.oauthFailure === 'audience_mismatch' || authResult.oauthFailure === 'store_error'
        ? authResult.oauthFailure
        : undefined;

    return response(
      401,
      rpcError(null, -32001, 'Unauthorized', {
        reason: diagnosticReason,
        ...(disclosableFailure ? { oauth_failure: disclosableFailure } : {}),
      }),
      {
        ...jsonHeaders,
        'Access-Control-Expose-Headers': 'mcp-session-id, WWW-Authenticate',
        'WWW-Authenticate': buildWwwAuthenticate({
          origin: mcpRequestOrigin(event),
          realm: getSiteIdentity().siteSlug,
          // A bearer that WAS presented and refused is `invalid_token`,
          // whichever of the three paths refused it. Saying so is what tells
          // an OAuth client to discard the token and re-run the flow rather
          // than retry the dead one forever; omitting it on an expired or
          // unknown OAuth token (as this did) left the connector with no
          // signal that reconnecting was the answer.
          ...(authResult.reason === 'invalid_authorization' || authResult.oauthFailure
            ? { error: 'invalid_token' }
            : {}),
        }),
      }
    );
  }
  // QA-W16-3: this request cleared the MCP gate above — every tool handler
  // reached via callTool for this request can treat the caller as
  // MCP-authenticated without re-deriving it.
  event.mcpGateAuthenticated = true;
  // W11 T11.10: a verified per-agent bearer token overrides self-declared
  // `agent_name` for every tool call in this request — see callTool's use
  // of `event.verifiedAgentName` below.
  if (authResult.verifiedAgentName) event.verifiedAgentName = authResult.verifiedAgentName;
  // W18 T18.6a: the OAuth-bound HUMAN, when present, is the only thing that
  // lets a membership tool run over /mcp — `callerPrincipalFromMcpEvent`
  // (membership/caller-principal.ts) reads it; everything else is an agent.
  event.oauthPrincipal = authResult.oauthPrincipal;
  if (authResult.oauthPrincipal) {
    // Attribution, not authority: the log now names the CLIENT and the HUMAN
    // who approved it. The token grants exactly the same surface as the shared
    // key — narrowing per client is post-V1 scope work, and pretending
    // otherwise here would be worse than saying so.
    event.log?.({
      event: 'mcp_oauth_authorized',
      rpcMethod: null,
      slug: null,
      clientId: authResult.oauthPrincipal.client_id,
      clientName: authResult.oauthPrincipal.client_name,
      subject: authResult.oauthPrincipal.subject_email,
    });
  }

  let body: JsonRpcRequest | JsonRpcRequest[];

  try {
    body = parseBody(event);
  } catch (error) {
    return response(400, rpcError(null, -32700, 'Parse error', error instanceof Error ? error.message : String(error)));
  }

  try {
    const requests = Array.isArray(body) ? body : [body];
    const results = (await Promise.all(requests.map((request) => handleRpcRequest(event, request)))).filter(
      (result): result is JsonRpcResponse => Boolean(result)
    );

    if (results.length === 0) {
      return emptyResponse(202);
    }

    return response(200, Array.isArray(body) ? results : results[0]);
  } catch (error) {
    event.log?.({
      event: 'mcp_request_failed',
      rpcMethod: null,
      slug: null,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error('Failed to handle MCP JSON-RPC request.', error);

    return response(500, rpcError(null, -32000, 'Internal server error'));
  }
};
