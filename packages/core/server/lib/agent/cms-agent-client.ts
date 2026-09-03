/**
 * PF1 — the CMS-Agent Streamable-HTTP MCP client.
 *
 * This is the thing `pdf-tool-client.ts` deliberately is NOT: a real MCP
 * client. pdf-tool's bridge is a single unauthenticated-shape POST to one
 * `/mcp` function with no `initialize` handshake and no session — fine for a
 * stateless tool bridge, wrong here. CMS-Agent's endpoint is Streamable HTTP
 * (POST + DELETE only; GET is 405), issues `Mcp-Session-Id` on initialize,
 * expires sessions on 30-min idle / 12-h max, and speaks protocol versions
 * `2025-06-18` / `2025-03-26`. So we handshake, carry the session id, send the
 * protocol-version header, and DELETE on close. Config and the payload
 * sanitizer follow pdf-tool-client's shape; the transport does not.
 *
 * Scope note (PF1): this module owns transport, config, bounds pre-flight,
 * error typing and the `agent_ref` cache. It does NOT build an
 * `agent_converse` request from a chat run — that is PF2's `cmsAgentEngine`.
 * Nothing here is wired into `loop.ts` yet; PF1 adds a client and no call site.
 *
 * Contract: `CLIENT-MANAGER-CONTRACT.md` at the ROOT of the CMS-Agent repo
 * (wire version `client_manager.turn.v1`), mirrored in
 * `docs/admin-redesign/cms-agent-chat-plan.md` §5/§5A.
 */
import { PLATFORM_ENV_NAMES, readBoundEnv, type SiteBindingEnvNames } from '../site-binding.js';
import type { ChatMsg, ChatToolCall } from './chat-store.js';
import type { WireTool } from './provider.js';

// ─── protocol + bounds constants (frozen contract) ───────────────────────────

/** Preferred first; CMS-Agent also accepts `2025-03-26`. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_FALLBACK_PROTOCOL_VERSION = '2025-03-26';

/** Contract bounds. Exceeding these is `invalid_turn_request`/`transcript_too_large` upstream. */
export const CMS_AGENT_BOUNDS = {
  maxMessages: 200,
  maxMessagesChars: 256_000,
  /**
   * W19 T19.8 (coordinated with CMS-Agent's `MAX_CONVERSATION_TOOLS`): raised
   * from 64. Platform's registry had grown to exactly 63 tools + the
   * learning-mode `present_candidates`, i.e. the old ceiling with ZERO
   * headroom — adding a single tool would have silently truncated the wire.
   *
   * 64 was never a provider limit; it was this contract's own number. The
   * bound that actually protects cost is `maxToolsChars`, which is unchanged.
   * `cmsAgentEngine` falls back to 64 once, automatically, if the other side
   * is still on the old bound — so the two repos can land in either order.
   */
  maxTools: 96,
  /** The previous ceiling, kept as the automatic fallback (see engine.ts). */
  legacyMaxTools: 64,
  maxToolsChars: 256_000,
  maxContextChars: 64_000,
  maxTokensCeiling: 32_000,
  timeoutMsCeiling: 120_000,
} as const;

export const CMS_AGENT_DEFAULT_CONSTRAINTS = { max_tokens: 16_000, timeout_ms: 90_000 } as const;

/** Default wall clock for one HTTP call. Matches the agent-side clamp. */
export const CMS_AGENT_DEFAULT_TIMEOUT_MS = 90_000;

/** `agent_resolve` results are cached per (project, role) for this long. */
export const AGENT_REF_TTL_MS = 5 * 60_000;

// ─── errors ──────────────────────────────────────────────────────────────────

/** The eight frozen CMS-Agent tool-error codes, read at `error.data.error.code`. */
export const CMS_AGENT_WIRE_ERROR_CODES = [
  'unknown_project',
  'project_disabled',
  'agent_unresolved',
  'transcript_too_large',
  'model_timeout',
  'model_error',
  'budget_exceeded',
  'invalid_turn_request',
  /**
   * Provider-error-details (CMS-Agent PR #233): a provider's own 429 is now
   * split by WHY — out of credit vs. merely rate-limited — instead of
   * collapsing into `budget_exceeded` (reserved for CMS-Agent's OWN usd
   * guard) or the opaque `model_error`/`cms_agent_error` bucket. Without these
   * two in the frozen list, `callTool` would not recognize either code and
   * would degrade them to `cms_agent_error` exactly like the bug this closes.
   */
  'provider_quota',
  'provider_rate_limit',
] as const;
export type CmsAgentWireErrorCode = (typeof CMS_AGENT_WIRE_ERROR_CODES)[number];

/** Platform-side classes for everything that is not a frozen tool error. */
export type CmsAgentTransportErrorCode =
  | 'cms_agent_not_configured'
  | 'cms_agent_auth_failed'
  | 'cms_agent_unreachable'
  | 'cms_agent_timeout'
  | 'cms_agent_protocol_error'
  | 'cms_agent_error';

export type CmsAgentErrorCode = CmsAgentWireErrorCode | CmsAgentTransportErrorCode;

const WIRE_ERROR_CODES = new Set<string>(CMS_AGENT_WIRE_ERROR_CODES);

export type CmsAgentError = {
  code: CmsAgentErrorCode;
  /** Human-safe; never contains the bearer or a token-shaped value. */
  message: string;
  /**
   * As-built delta 1 (plan §5A) — the single most important integration
   * consequence, and the reason this is decided here rather than re-derived by
   * every caller. Read it as one precise sentence:
   *
   *   TRUE  — re-send the BYTE-IDENTICAL request under the SAME turn_id.
   *   FALSE — mint a FRESH turn_id before retrying.
   *
   * The trap is not "did the request reach the claim". The claim for
   * `(conversation_id, turn_id)` is written BEFORE project/agent validation and
   * is pinned to a hash of the normalized request, and the contract says
   * reusing the key with DIFFERENT input returns `invalid_turn_request`
   * forever. So the real question is whether the retry will carry the same
   * bytes:
   *
   *  - Transport-class failures (timeout, unreachable, 5xx, an unparseable
   *    body) retry verbatim, so reuse is not merely safe but strictly better:
   *    if the turn did complete server-side, idempotent replay returns the
   *    stored result and Platform is not billed for a second model call. This
   *    is the ONLY way to avoid double-spending a completed-but-unheard turn.
   *  - Anything the server rejected on the merits — every frozen wire code —
   *    is followed by a retry with CHANGED input (a trimmed transcript after
   *    `transcript_too_large`, a corrected field after `invalid_turn_request`),
   *    which is exactly the case that conflicts forever. Mint a fresh id.
   *  - Failures raised locally, before anything was sent, leave the id
   *    unclaimed entirely, so it is free to use for whatever is sent next.
   */
  retryableWithSameTurnId: boolean;
  /** Present when the failure carried an HTTP status (Platform's OWN call TO CMS-Agent). */
  statusCode?: number;
  /**
   * Provider-error-details (Task B) — CMS-Agent's own structured error detail,
   * present only on a `provider_quota`/`provider_rate_limit`/`budget_exceeded`
   * wire error. `providerStatus` is the UPSTREAM model provider's HTTP status
   * (e.g. 429) — never to be confused with `statusCode` above, which is
   * Platform's own call status (always 200 for a JSON-RPC-level tool error).
   */
  operatorAction?: string;
  providerStatus?: number;
  providerMessage?: string;
  /**
   * True only when CMS-Agent actually answered with a parseable JSON-RPC
   * error body (`parsed.error` in `callTool`) — i.e. `code`/`message` here
   * are real detail, not a guess. False/absent for every transport-class
   * failure (connect error, timeout, an HTML 5xx, an unparseable body): the
   * caller must show the generic "service unavailable" copy for those,
   * never a raw `code: message` built from garbage.
   */
  fromJsonBody?: boolean;
};

export type CmsAgentResult<T> = { ok: true; data: T } | ({ ok: false } & CmsAgentError);

const fail = (
  code: CmsAgentErrorCode,
  message: string,
  options: {
    retryableWithSameTurnId?: boolean;
    statusCode?: number;
    operatorAction?: string;
    providerStatus?: number;
    providerMessage?: string;
    fromJsonBody?: boolean;
  } = {}
): { ok: false } & CmsAgentError => ({
  ok: false,
  code,
  message,
  // Default false — the safe direction. A wrong `false` costs one wasted id; a
  // wrong `true` conflicts that id forever.
  retryableWithSameTurnId: options.retryableWithSameTurnId ?? false,
  ...(options.statusCode === undefined ? {} : { statusCode: options.statusCode }),
  ...(options.operatorAction === undefined ? {} : { operatorAction: options.operatorAction }),
  ...(options.providerStatus === undefined ? {} : { providerStatus: options.providerStatus }),
  ...(options.providerMessage === undefined ? {} : { providerMessage: options.providerMessage }),
  ...(options.fromJsonBody === undefined ? {} : { fromJsonBody: options.fromJsonBody }),
});

// ─── config (NAMES, never values; resolved at call time) ─────────────────────

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * The single predicate for "is the CMS-Agent bridge configured", mirroring
 * pdf-tool-client's T16.5 arrangement: the real call path and any future
 * capability-status family read this one function, so the env names live in
 * exactly one place.
 */
export const cmsAgentMissingEnvVars = (names: SiteBindingEnvNames = PLATFORM_ENV_NAMES): string[] => {
  const missing: string[] = [];
  if (!nonEmpty(readBoundEnv(names.cmsAgentEndpoint)))
    missing.push(names.cmsAgentEndpoint[0] ?? 'CMS_AGENT_MCP_ENDPOINT');
  if (!nonEmpty(readBoundEnv(names.cmsAgentToken))) missing.push(names.cmsAgentToken[0] ?? 'CMS_AGENT_MCP_TOKEN');
  return missing;
};

export const isCmsAgentConfigured = (names: SiteBindingEnvNames = PLATFORM_ENV_NAMES): boolean =>
  cmsAgentMissingEnvVars(names).length === 0;

export type CmsAgentConfig = { endpoint: string; token: string };

/**
 * Never throws and never caches: a missing variable is a typed
 * `cms_agent_not_configured` at the use site, exactly as
 * `resolvePdfToolClientConfig` does. Importing this module has no side effects.
 */
export const resolveCmsAgentConfig = (
  names: SiteBindingEnvNames = PLATFORM_ENV_NAMES
): CmsAgentResult<CmsAgentConfig> => {
  const missing = cmsAgentMissingEnvVars(names);
  if (missing.length > 0) {
    return fail(
      'cms_agent_not_configured',
      `Platform's CMS-Agent bridge is not configured (missing ${missing.join(' and ')}).`
    );
  }
  return {
    ok: true,
    data: {
      endpoint: nonEmpty(readBoundEnv(names.cmsAgentEndpoint))!.replace(/\/+$/, ''),
      token: nonEmpty(readBoundEnv(names.cmsAgentToken))!,
    },
  };
};

// ─── sanitizer ───────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

/**
 * Key names whose VALUE is never safe to log or return, whatever it holds.
 *
 * Segment-matched over snake_case, kebab-case AND camelCase, because a naive
 * substring rule gets this wrong in both directions: it misses `accessToken`
 * (no separator before the word) and it eats `input_tokens` / `output_tokens` —
 * which are the usage counts in every `agent_converse` response, not secrets.
 * Hence the deliberate singular/plural split: `token` is a credential,
 * `tokens` is a count noun. The bearer's literal value is redacted separately,
 * so a key this misses still cannot leak the credential itself.
 */
const CREDENTIAL_SEGMENTS = new Set([
  'token',
  'secret',
  'secrets',
  'authorization',
  'bearer',
  'password',
  'passwords',
  'credential',
  'credentials',
]);

const keySegments = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()
    .split('_')
    .filter(Boolean);

const isTokenShapedKey = (key: string): boolean => {
  const segments = keySegments(key);
  if (segments.some((segment) => CREDENTIAL_SEGMENTS.has(segment))) return true;
  // api_key / apiKey / apikey — only as an adjacent pair, so a bare `key`
  // (blob keys are everywhere in this codebase) is left alone.
  return segments.some(
    (segment, index) => segment === 'apikey' || (segment === 'api' && segments[index + 1] === 'key')
  );
};

/**
 * Strip credentials from anything that can reach a log line, a chat event, or
 * an MCP response. Two independent rules, because either alone leaks:
 * token-shaped KEYS are dropped wholesale, and the bearer's literal VALUE is
 * redacted wherever it appears as a substring (it shows up inside echoed
 * `authorization` headers and inside some upstream error messages).
 */
export const sanitizeCmsAgentPayload = (value: unknown, secrets: readonly string[] = []): unknown => {
  const needles = secrets.filter((secret) => typeof secret === 'string' && secret.length > 0);
  if (typeof value === 'string') {
    return needles.reduce((safe, secret) => safe.split(secret).join('[REDACTED]'), value);
  }
  if (Array.isArray(value)) return value.map((child) => sanitizeCmsAgentPayload(child, needles));
  if (!isRecord(value)) return value;
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isTokenShapedKey(key)) {
      safe[key] = '[REDACTED]';
      continue;
    }
    safe[key] = sanitizeCmsAgentPayload(child, needles);
  }
  return safe;
};

/**
 * Value-only redaction, for payloads that are editor CONTENT rather than
 * diagnostics. Same secret needles as the full sanitizer, none of its
 * key-dropping — see the call site in `callTool` for why that distinction has
 * to exist.
 */
export const redactSecretValues = (value: unknown, secrets: readonly string[] = []): unknown => {
  const needles = secrets.filter((secret) => typeof secret === 'string' && secret.length > 0);
  if (needles.length === 0) return value;
  if (typeof value === 'string') {
    return needles.reduce((safe, secret) => safe.split(secret).join('[REDACTED]'), value);
  }
  if (Array.isArray(value)) return value.map((child) => redactSecretValues(child, needles));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactSecretValues(child, needles)]));
};

const safeMessage = (value: unknown, secrets: readonly string[], fallbackText: string): string => {
  const sanitized = sanitizeCmsAgentPayload(value, secrets);
  return typeof sanitized === 'string' && sanitized.length > 0 ? sanitized : fallbackText;
};

// ─── the frozen request/response shapes ──────────────────────────────────────

export type CmsAgentActor = { kind: 'human'; id: string };

/**
 * No `email` field exists on the wire — the omission is the contract.
 *
 * Shapes and bounds here are taken from CMS-Agent's
 * `src/agent/conversations/conversationContract.ts` (the code that actually
 * parses the request), NOT from CLIENT-MANAGER-CONTRACT.md, which was last
 * touched at CA3 and is stale: it predates CA6 (`871d977`) and so documents
 * neither `diagnostics_requested` nor the rev-2 prompt that reads it.
 */
export type CmsAgentContext = {
  site_id: string;
  object_type?: string;
  object_id?: string;
  focus?: string;
  learning_mode?: boolean;
  /**
   * CA6, additive and live at agent rev 2: the caller asserts an Owner asked
   * for technical detail on this run, relaxing the prompt's editor-facing
   * -language default for that run only. A tone assertion, never an
   * authorization signal — PF2 must gate it on the run's Owner role before
   * setting it, exactly as Platform's own systemPrompt() branch does today.
   */
  diagnostics_requested?: boolean;
  approval_note?: string;
};

export type CmsAgentConstraints = { max_tokens: number; timeout_ms: number };

/** All nine top-level fields are required; the whole request is `.strict()`. */
export type CmsAgentConverseRequest = {
  agent_ref: string;
  project_id: string;
  conversation_id: string;
  turn_id: string;
  actor: CmsAgentActor;
  context: CmsAgentContext;
  messages: ChatMsg[];
  tools: WireTool[];
  constraints: CmsAgentConstraints;
};

export type CmsAgentConverseResponse = {
  assistant_text?: string;
  tool_calls?: ChatToolCall[];
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
  /** A NUMBER on the wire, a string in CMS-Agent's stored record (as-built delta 3). */
  agent_rev: number;
  model: string;
};

export type CmsAgentResolveRequest = { role: 'client_manager'; project_id: string };
export type CmsAgentResolveResponse = {
  agent_ref: string;
  name: string;
  rev: number;
  model: string;
  status: string;
};

// ─── bounds pre-flight ───────────────────────────────────────────────────────

const serializedLength = (value: unknown): number => JSON.stringify(value ?? null).length;

/**
 * Check the contract's bounds BEFORE the request leaves Platform.
 *
 * This is not belt-and-braces: because the idempotency claim is written before
 * validation upstream (as-built delta 1), a bounds violation that reaches
 * CMS-Agent burns the turn_id permanently. Catching it here means the claim is
 * never written and the caller's turn_id stays usable — a locally-detected
 * violation is strictly cheaper than the identical one detected remotely.
 */
export const checkConverseBounds = (request: CmsAgentConverseRequest): CmsAgentError | undefined => {
  const tooLarge = (message: string): CmsAgentError => ({
    code: 'transcript_too_large',
    message,
    retryableWithSameTurnId: true,
  });
  const invalid = (message: string): CmsAgentError => ({
    code: 'invalid_turn_request',
    message,
    retryableWithSameTurnId: true,
  });

  // Per-field lengths, straight from the frozen contract. Cheap here, and each
  // one caught locally is a turn_id not burned by a remote rejection.
  const lengths: Array<[string, string | undefined, number, number]> = [
    ['agent_ref', request.agent_ref, 1, 256],
    ['project_id', request.project_id, 1, 63],
    ['conversation_id', request.conversation_id, 1, 256],
    ['turn_id', request.turn_id, 1, 256],
    ['actor.id', request.actor.id, 1, 256],
    ['context.site_id', request.context.site_id, 1, 128],
    ['context.object_type', request.context.object_type, 1, 128],
    ['context.object_id', request.context.object_id, 1, 256],
    ['context.focus', request.context.focus, 1, 500],
    ['context.approval_note', request.context.approval_note, 1, 1000],
  ];
  for (const [name, value, min, max] of lengths) {
    if (value === undefined) continue;
    if (value.length < min || value.length > max) {
      return invalid(`${name} must be ${min}..${max} characters (got ${value.length}).`);
    }
  }
  const overLongDescription = request.tools.find((tool) => tool.description.length > 16_000);
  if (overLongDescription) {
    return invalid(`tool "${overLongDescription.name}" has a description over 16000 characters.`);
  }

  if (request.messages.length < 1) return invalid('messages must carry at least one entry.');
  if (request.messages.length > CMS_AGENT_BOUNDS.maxMessages) {
    return tooLarge(
      `transcript is ${request.messages.length} messages; the bound is ${CMS_AGENT_BOUNDS.maxMessages}. Trim oldest-first.`
    );
  }
  const messagesChars = serializedLength(request.messages);
  if (messagesChars > CMS_AGENT_BOUNDS.maxMessagesChars) {
    return tooLarge(
      `transcript serializes to ${messagesChars} characters; the bound is ${CMS_AGENT_BOUNDS.maxMessagesChars}. Trim oldest-first.`
    );
  }
  if (request.tools.length > CMS_AGENT_BOUNDS.maxTools) {
    return invalid(`tools list is ${request.tools.length} entries; the bound is ${CMS_AGENT_BOUNDS.maxTools}.`);
  }
  const toolsChars = serializedLength(request.tools);
  if (toolsChars > CMS_AGENT_BOUNDS.maxToolsChars) {
    return invalid(
      `tools list serializes to ${toolsChars} characters; the bound is ${CMS_AGENT_BOUNDS.maxToolsChars}.`
    );
  }
  if (request.tools.some((tool) => tool.description.trim().length === 0)) {
    return invalid('every tool description must be non-empty (contract: min(1)).');
  }
  const contextChars = serializedLength(request.context);
  if (contextChars > CMS_AGENT_BOUNDS.maxContextChars) {
    return invalid(
      `context serializes to ${contextChars} characters; the bound is ${CMS_AGENT_BOUNDS.maxContextChars}.`
    );
  }
  // Paired or absent — never one without the other.
  if ((request.context.object_type === undefined) !== (request.context.object_id === undefined)) {
    return invalid('context.object_type and context.object_id must be sent together or not at all.');
  }
  if (request.actor.id.trim().length === 0) {
    return invalid('actor.id must be a non-empty stable id.');
  }
  // Mirror CMS-Agent's own regex EXACTLY. A stricter local rule (e.g. "contains
  // an @") would reject stable ids the service accepts, which is a client
  // refusing valid work — the one failure mode a pre-flight must never have.
  if (/\S+@\S+\.\S+/.test(request.actor.id)) {
    return invalid('actor.id must be a stable id, never an email address.');
  }
  if (request.constraints.max_tokens < 1 || request.constraints.max_tokens > CMS_AGENT_BOUNDS.maxTokensCeiling) {
    return invalid(`constraints.max_tokens must be 1..${CMS_AGENT_BOUNDS.maxTokensCeiling}.`);
  }
  if (request.constraints.timeout_ms < 1000 || request.constraints.timeout_ms > CMS_AGENT_BOUNDS.timeoutMsCeiling) {
    return invalid(`constraints.timeout_ms must be 1000..${CMS_AGENT_BOUNDS.timeoutMsCeiling}.`);
  }
  return undefined;
};

// ─── Streamable-HTTP transport ───────────────────────────────────────────────

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

/**
 * A Streamable-HTTP POST may answer with `application/json` OR with an SSE
 * stream carrying the same JSON-RPC message in `data:` frames. Both are legal;
 * a client that only handles the former breaks the moment the server decides to
 * stream, so parse both.
 */
const parseStreamableBody = (contentType: string, body: string): JsonRpcResponse | undefined => {
  const text = body.trim();
  if (text.length === 0) return undefined;
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    try {
      return JSON.parse(text) as JsonRpcResponse;
    } catch {
      return undefined;
    }
  }
  let last: JsonRpcResponse | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse;
      if (parsed.result !== undefined || parsed.error !== undefined) last = parsed;
    } catch {
      // A non-JSON frame (a comment or keep-alive) is not an error.
    }
  }
  return last;
};

export type CmsAgentClientOptions = {
  /** Env NAMES, not values. Defaults to the Netlify-standard set. */
  names?: SiteBindingEnvNames;
  fetchImpl?: typeof fetch;
  /** Per-call wall clock; the contract ceiling is 120s. */
  timeoutMs?: number;
  now?: () => number;
};

let requestCounter = 0;
const nextRequestId = (): string => `pf-${(requestCounter += 1)}`;

type AgentRefCacheEntry = { ref: string; expiresAt: number };

/**
 * One client per site binding. Holds at most one MCP session and a short-TTL
 * `agent_ref` cache; both are process-local and safe to discard at any time.
 */
export class CmsAgentClient {
  private readonly names: SiteBindingEnvNames;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private sessionId: string | undefined;
  /** In-flight handshake, so N concurrent first calls open ONE session. */
  private handshake: Promise<CmsAgentResult<true>> | undefined;
  private negotiatedProtocol = MCP_PROTOCOL_VERSION;
  private readonly agentRefCache = new Map<string, AgentRefCacheEntry>();

  constructor(options: CmsAgentClientOptions = {}) {
    this.names = options.names ?? PLATFORM_ENV_NAMES;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? CMS_AGENT_DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Exposed so the health probe and the turn client share one config source. */
  config(): CmsAgentResult<CmsAgentConfig> {
    return resolveCmsAgentConfig(this.names);
  }

  private headers(config: CmsAgentConfig, includeProtocol: boolean): Record<string, string> {
    return {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
      // Streamable HTTP: the server may answer either way, so accept both.
      accept: 'application/json, text/event-stream',
      ...(includeProtocol ? { 'mcp-protocol-version': this.negotiatedProtocol } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    };
  }

  private async post(
    config: CmsAgentConfig,
    body: Record<string, unknown>,
    options: { includeProtocol: boolean; timeoutMs?: number }
  ): Promise<CmsAgentResult<{ response: Response; text: string }>> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(config.endpoint, {
        method: 'POST',
        headers: this.headers(config, options.includeProtocol),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text().catch(() => '');
      return { ok: true, data: { response, text } };
    } catch (error) {
      const aborted = controller.signal.aborted || (error as { name?: string } | undefined)?.name === 'AbortError';
      return aborted
        ? fail('cms_agent_timeout', `CMS-Agent did not respond within ${timeoutMs}ms.`, {
            retryableWithSameTurnId: true,
          })
        : fail('cms_agent_unreachable', 'CMS-Agent is unreachable from Platform.', { retryableWithSameTurnId: true });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Wrong project and bad token are a byte-identical opaque 401 upstream
   * (as-built delta 5). Both map here to one `cms_agent_auth_failed` — the
   * client must not imply it can tell them apart.
   */
  private httpFailure(status: number, text: string, secrets: readonly string[]): { ok: false } & CmsAgentError {
    if (status === 401 || status === 403) {
      return fail(
        'cms_agent_auth_failed',
        'CMS-Agent rejected the credential. The site token may be wrong, or scoped to a different project — the service returns the same response for both.',
        // Authentication happens at the door, before any tool dispatch, so no
        // claim exists. The id is untouched and free to reuse once the operator
        // fixes the token.
        { statusCode: status, retryableWithSameTurnId: true }
      );
    }
    return fail('cms_agent_error', safeMessage(text, secrets, `CMS-Agent request failed (HTTP ${status}).`), {
      statusCode: status,
      // A 5xx/429 is infrastructure, not a verdict on the request: the retry is
      // byte-identical, so reuse either replays a completed turn for free or
      // claims an id that was never taken. A 4xx other than auth is a verdict.
      retryableWithSameTurnId: status >= 500 || status === 429,
    });
  }

  /**
   * `initialize` → capture the session id → `notifications/initialized`.
   *
   * Deduplicated: PF2 holds one client per site and the background hop can
   * start several turns at once, so without this the first N calls would each
   * open a session and silently orphan all but the last.
   */
  private async ensureSession(config: CmsAgentConfig): Promise<CmsAgentResult<true>> {
    if (this.sessionId) return { ok: true, data: true };
    if (!this.handshake) {
      this.handshake = this.openSession(config).finally(() => {
        this.handshake = undefined;
      });
    }
    return this.handshake;
  }

  private async openSession(config: CmsAgentConfig): Promise<CmsAgentResult<true>> {
    if (this.sessionId) return { ok: true, data: true };
    const secrets = [config.token];

    const posted = await this.post(
      config,
      {
        jsonrpc: '2.0',
        id: nextRequestId(),
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'platform-cms-agent-client', version: '1' },
        },
      },
      { includeProtocol: false }
    );
    if (!posted.ok) return posted;

    const { response, text } = posted.data;
    if (!response.ok) return this.httpFailure(response.status, text, secrets);

    const parsed = parseStreamableBody(response.headers.get('content-type') ?? '', text);
    if (!parsed || parsed.error || !isRecord(parsed.result)) {
      return fail('cms_agent_protocol_error', 'CMS-Agent returned no usable initialize result.', {
        retryableWithSameTurnId: true,
        statusCode: response.status,
      });
    }

    const negotiated = (parsed.result as { protocolVersion?: unknown }).protocolVersion;
    if (typeof negotiated === 'string' && negotiated.length > 0) this.negotiatedProtocol = negotiated;
    else this.negotiatedProtocol = MCP_FALLBACK_PROTOCOL_VERSION;

    const issued = response.headers.get('mcp-session-id');
    if (issued && issued.length > 0) this.sessionId = issued;

    // Best-effort: the spec requires the notification, but a server that has
    // already issued a session id will not fail a later tools/call without it.
    await this.post(
      config,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { includeProtocol: true, timeoutMs: Math.min(this.timeoutMs, 15_000) }
    );

    return { ok: true, data: true };
  }

  /** Low-level `tools/call`. Unwraps CMS-Agent's `{ok:true,data}` envelope. */
  async callTool<T>(name: string, args: Record<string, unknown>): Promise<CmsAgentResult<T>> {
    const config = this.config();
    if (!config.ok) return config;
    const secrets = [config.data.token];

    const session = await this.ensureSession(config.data);
    if (!session.ok) return session;

    const posted = await this.post(
      config.data,
      { jsonrpc: '2.0', id: nextRequestId(), method: 'tools/call', params: { name, arguments: args } },
      { includeProtocol: true }
    );
    if (!posted.ok) return posted;

    const { response, text } = posted.data;
    if (response.status === 404 && this.sessionId) {
      // The session expired (30-min idle / 12-h max). Drop it; the caller
      // retries with a fresh handshake. Not a turn-claiming failure.
      this.sessionId = undefined;
      return fail('cms_agent_protocol_error', 'The CMS-Agent MCP session expired; retry to open a new one.', {
        retryableWithSameTurnId: true,
        statusCode: 404,
      });
    }
    if (!response.ok) return this.httpFailure(response.status, text, secrets);

    const parsed = parseStreamableBody(response.headers.get('content-type') ?? '', text);
    if (!parsed) {
      return fail('cms_agent_protocol_error', 'CMS-Agent returned an unparseable response body.', {
        retryableWithSameTurnId: true,
        statusCode: response.status,
      });
    }

    if (parsed.error) {
      // Machine codes live at error.data.error.code (as-built delta 6).
      const data = isRecord(parsed.error.data) ? parsed.error.data : undefined;
      const inner = data && isRecord(data.error)
        ? (data.error as { code?: unknown; operatorAction?: unknown; providerStatus?: unknown; providerMessage?: unknown })
        : undefined;
      const wire = typeof inner?.code === 'string' && WIRE_ERROR_CODES.has(inner.code) ? inner.code : undefined;
      const message = safeMessage(parsed.error.message, secrets, 'CMS-Agent returned an error.');
      // Provider-error-details (Task B): CMS-Agent's own structured detail —
      // sanitized the same way `message` is, since a provider's own text
      // could in principle echo something sensitive. `fromJsonBody: true`
      // marks EVERY error reached here (wire-recognized or not) as a real
      // parsed JSON-RPC error body, never a network/timeout/HTML-5xx guess —
      // that is the one signal `humanCopyForCmsAgentError` uses to decide
      // whether raw code/message detail is safe to show instead of the
      // generic "service unavailable" copy.
      const operatorAction =
        typeof inner?.operatorAction === 'string' ? safeMessage(inner.operatorAction, secrets, '') || undefined : undefined;
      const providerStatus = typeof inner?.providerStatus === 'number' ? inner.providerStatus : undefined;
      const providerMessage =
        typeof inner?.providerMessage === 'string' ? safeMessage(inner.providerMessage, secrets, '') || undefined : undefined;
      const detailOptions = { statusCode: response.status, operatorAction, providerStatus, providerMessage, fromJsonBody: true };
      return wire
        ? fail(wire as CmsAgentWireErrorCode, message, detailOptions)
        : fail('cms_agent_error', message, detailOptions);
    }

    const result = isRecord(parsed.result) ? parsed.result : undefined;
    const envelope = result && isRecord(result.structuredContent) ? result.structuredContent : result;
    if (!isRecord(envelope) || envelope.ok !== true || envelope.data === undefined) {
      return fail('cms_agent_protocol_error', 'CMS-Agent returned no {ok:true,data} envelope.', {
        statusCode: response.status,
      });
    }
    // Done-criteria E4 covers EVERY returned payload, success included — the
    // bearer can be echoed back inside a model-authored string. But only the
    // VALUE redaction runs here, never the key-dropping rule: a success payload
    // is editor content (assistant_text, tool_call args), and a `patch` whose
    // args legitimately mention a field called `secret` must survive intact.
    // Redacting a literal that equals the bearer can never destroy real content.
    return { ok: true, data: redactSecretValues(envelope.data, secrets) as T };
  }

  /**
   * Never hardcode an agent id — resolve it. Cached per (role, project) for a
   * short TTL and dropped on `agent_unresolved` so a rev bump self-heals.
   */
  async resolveAgent(request: CmsAgentResolveRequest): Promise<CmsAgentResult<string>> {
    const key = `${request.role}:${request.project_id}`;
    const cached = this.agentRefCache.get(key);
    if (cached && cached.expiresAt > this.now()) return { ok: true, data: cached.ref };

    const resolved = await this.callTool<CmsAgentResolveResponse>('agent_resolve', { ...request });
    if (!resolved.ok) {
      if (resolved.code === 'agent_unresolved') this.agentRefCache.delete(key);
      return resolved;
    }
    const ref = resolved.data?.agent_ref;
    if (typeof ref !== 'string' || ref.length === 0) {
      return fail('cms_agent_protocol_error', 'agent_resolve returned no agent_ref.');
    }
    this.agentRefCache.set(key, { ref, expiresAt: this.now() + AGENT_REF_TTL_MS });
    return { ok: true, data: ref };
  }

  /** Forget a cached ref — call after `agent_unresolved` from `agent_converse`. */
  invalidateAgentRef(role: string, projectId: string): void {
    this.agentRefCache.delete(`${role}:${projectId}`);
  }

  /** One model turn. Bounds are checked locally first so a violation cannot burn the turn_id. */
  async converse(request: CmsAgentConverseRequest): Promise<CmsAgentResult<CmsAgentConverseResponse>> {
    const bounds = checkConverseBounds(request);
    if (bounds) return { ok: false, ...bounds };
    return this.callTool<CmsAgentConverseResponse>('agent_converse', { ...request });
  }

  /**
   * P5 (brand-imagery wave, BRIEF §3.5): run one CMS-Agent workspace node
   * (e.g. `brand_imagery_writer`) outside a full workflow run — the same
   * `tools/call` shape `node_prepare_execution`/`node_validate_input` already
   * use (`{nodeId, input}`, no `projectId` — the authenticated session is
   * already project-scoped). A thin wrapper over `callTool`, exactly like
   * `converse` above, kept here so every CmsAgentClient caller (the
   * brand-imagery proxy included) shares one call site instead of
   * hand-building the `node_execute` args inline.
   */
  async nodeExecute<T = unknown>(nodeId: string, input: Record<string, unknown>): Promise<CmsAgentResult<T>> {
    return this.callTool<T>('node_execute', { nodeId, input });
  }

  /**
   * DELETE the session. Idempotent, best-effort, and never throws: a failed
   * close costs an idle server-side session that expires on its own.
   */
  async close(): Promise<void> {
    const config = this.config();
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    if (!config.ok || !sessionId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 15_000));
    try {
      await this.fetchImpl(config.data.endpoint, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${config.data.token}`,
          'mcp-protocol-version': this.negotiatedProtocol,
          'mcp-session-id': sessionId,
        },
        signal: controller.signal,
      });
    } catch {
      // Best-effort by design.
    } finally {
      clearTimeout(timer);
    }
  }

  /** Test/diagnostic accessor; never logged. */
  currentSessionId(): string | undefined {
    return this.sessionId;
  }
}
