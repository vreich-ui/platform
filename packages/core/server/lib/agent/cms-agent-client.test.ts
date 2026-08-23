import assert from 'node:assert';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  CMS_AGENT_BOUNDS,
  CmsAgentClient,
  checkConverseBounds,
  cmsAgentMissingEnvVars,
  isCmsAgentConfigured,
  resolveCmsAgentConfig,
  sanitizeCmsAgentPayload,
  type CmsAgentConverseRequest,
} from './cms-agent-client.js';

const TOKEN = 'scoped-bearer-value-do-not-log';

// ─── a real Streamable-HTTP MCP server, minimal but faithful ─────────────────

type ServerBehavior = {
  initializeStatus?: number;
  callStatus?: number;
  /** Return an SSE-framed body instead of application/json. */
  sse?: boolean;
  /** JSON-RPC error object returned from tools/call. */
  toolError?: unknown;
  /** `data` payload inside the {ok:true,data} envelope. */
  toolData?: unknown;
  /** Answer tools/call without the envelope at all. */
  rawResult?: unknown;
  /** Delay every response by this long (to exercise the abort path). */
  delayMs?: number;
  /** Omit the Mcp-Session-Id header on initialize. */
  withholdSessionId?: boolean;
};

const state = {
  behavior: {} as ServerBehavior,
  requests: [] as Array<{ method: string; rpcMethod?: string; headers: Record<string, string>; body: string }>,
  sessionCounter: 0,
  toolCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const send = (
  res: ServerResponse,
  status: number,
  payload: unknown,
  sse: boolean,
  extra: Record<string, string> = {}
) => {
  if (sse) {
    res.writeHead(status, { 'content-type': 'text/event-stream', ...extra });
    res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(payload));
};

let server: Server;
let endpoint: string;

const handler = async (req: IncomingMessage, res: ServerResponse) => {
  const body = await readBody(req);
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : (value ?? '')])
  );
  let rpc: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } = {};
  try {
    rpc = body ? JSON.parse(body) : {};
  } catch {
    rpc = {};
  }
  state.requests.push({ method: req.method ?? '', rpcMethod: rpc.method, headers, body });

  if (state.behavior.delayMs) await new Promise((resolve) => setTimeout(resolve, state.behavior.delayMs));

  if (req.method === 'DELETE') {
    res.writeHead(204).end();
    return;
  }

  if (rpc.method === 'initialize') {
    const status = state.behavior.initializeStatus ?? 200;
    if (status !== 200) {
      send(res, status, { error: { code: 'unauthorized', message: `bearer ${TOKEN} rejected` } }, false);
      return;
    }
    state.sessionCounter += 1;
    const extra: Record<string, string> = state.behavior.withholdSessionId
      ? {}
      : { 'mcp-session-id': `mcps_${state.sessionCounter}` };
    send(
      res,
      200,
      {
        jsonrpc: '2.0',
        id: rpc.id,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'cms-agent', version: '1' } },
      },
      Boolean(state.behavior.sse),
      extra
    );
    return;
  }

  if (rpc.method === 'notifications/initialized') {
    res.writeHead(202).end();
    return;
  }

  if (rpc.method === 'tools/call') {
    state.toolCalls.push({ name: rpc.params?.name ?? '', args: rpc.params?.arguments ?? {} });
    const status = state.behavior.callStatus ?? 200;
    if (status !== 200) {
      send(res, status, { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } }, false);
      return;
    }
    if (state.behavior.toolError) {
      send(res, 200, { jsonrpc: '2.0', id: rpc.id, error: state.behavior.toolError }, Boolean(state.behavior.sse));
      return;
    }
    const result =
      'rawResult' in state.behavior
        ? state.behavior.rawResult
        : { structuredContent: { ok: true, data: state.behavior.toolData ?? {} } };
    send(res, 200, { jsonrpc: '2.0', id: rpc.id, result }, Boolean(state.behavior.sse));
    return;
  }

  send(res, 400, { error: { message: 'unexpected' } }, false);
};

before(async () => {
  server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  endpoint = `http://127.0.0.1:${port}/mcp`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state.behavior = {};
  state.requests = [];
  state.toolCalls = [];
  process.env.CMS_AGENT_MCP_ENDPOINT = endpoint;
  process.env.CMS_AGENT_MCP_TOKEN = TOKEN;
});

const clearEnv = () => {
  delete process.env.CMS_AGENT_MCP_ENDPOINT;
  delete process.env.CMS_AGENT_MCP_TOKEN;
};

const validRequest = (overrides: Partial<CmsAgentConverseRequest> = {}): CmsAgentConverseRequest => ({
  agent_ref: 'agt_client_manager@2',
  project_id: 'platform',
  conversation_id: 'obj:page_home',
  turn_id: 't_run_1_0',
  actor: { kind: 'human', id: 'usr_123' },
  context: { site_id: 'site_platform' },
  messages: [{ role: 'user', text: 'hello' }],
  tools: [{ name: 'patch', description: 'Propose a governed patch.', input_schema: { type: 'object' } }],
  constraints: { max_tokens: 16_000, timeout_ms: 90_000 },
  ...overrides,
});

// ─── configuration ───────────────────────────────────────────────────────────

describe('configuration', () => {
  it('reports the missing NAMES and never throws when unconfigured', () => {
    clearEnv();
    assert.deepEqual(cmsAgentMissingEnvVars(), ['CMS_AGENT_MCP_ENDPOINT', 'CMS_AGENT_MCP_TOKEN']);
    assert.equal(isCmsAgentConfigured(), false);
    const config = resolveCmsAgentConfig();
    assert.equal(config.ok, false);
    assert.equal(config.ok === false && config.code, 'cms_agent_not_configured');
  });

  it('an unconfigured converse fails typed at the use site, with no network call', async () => {
    clearEnv();
    const client = new CmsAgentClient();
    const result = await client.converse(validRequest());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, 'cms_agent_not_configured');
    assert.equal(state.requests.length, 0);
  });

  it('reads values live, never cached at module scope', () => {
    process.env.CMS_AGENT_MCP_TOKEN = 'first';
    assert.equal(resolveCmsAgentConfig().ok && resolveCmsAgentConfig().ok, true);
    const first = resolveCmsAgentConfig();
    process.env.CMS_AGENT_MCP_TOKEN = 'second';
    const second = resolveCmsAgentConfig();
    assert.equal(first.ok && first.data.token, 'first');
    assert.equal(second.ok && second.data.token, 'second');
  });

  it('configuration contains only the endpoint and scoped token', () => {
    process.env.CMS_AGENT_CHAT_MODE = 'off';
    const config = resolveCmsAgentConfig();
    assert.equal(config.ok, true);
    if (config.ok) assert.deepEqual(Object.keys(config.data).sort(), ['endpoint', 'token']);
    delete process.env.CMS_AGENT_CHAT_MODE;
  });
});

// ─── handshake, session, DELETE ──────────────────────────────────────────────

describe('Streamable-HTTP transport', () => {
  it('handshakes once, propagates Mcp-Session-Id and the protocol header, then DELETEs', async () => {
    state.behavior.toolData = {
      agent_ref: 'agt_client_manager@2',
      name: 'Client Manager',
      rev: 2,
      model: 'gpt-4.1',
      status: 'active',
    };
    const client = new CmsAgentClient();

    const first = await client.resolveAgent({ role: 'client_manager', project_id: 'platform' });
    assert.equal(first.ok, true);

    const initialize = state.requests.find((entry) => entry.rpcMethod === 'initialize');
    assert.ok(initialize, 'expected an initialize handshake');
    assert.equal(initialize?.headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(!initialize?.headers['mcp-session-id'], 'initialize must not carry a session id');

    const call = state.requests.find((entry) => entry.rpcMethod === 'tools/call');
    assert.equal(call?.headers['mcp-session-id'], 'mcps_1');
    assert.equal(call?.headers['mcp-protocol-version'], '2025-06-18');

    // A second call reuses the session — exactly one handshake.
    state.behavior.toolData = {
      assistant_text: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
      agent_rev: 2,
      model: 'gpt-4.1',
    };
    await client.converse(validRequest());
    assert.equal(state.requests.filter((entry) => entry.rpcMethod === 'initialize').length, 1);

    await client.close();
    const deleted = state.requests.find((entry) => entry.method === 'DELETE');
    assert.equal(deleted?.headers['mcp-session-id'], 'mcps_1');
    assert.equal(client.currentSessionId(), undefined);
  });

  it('opens exactly one session when several turns start at once', async () => {
    state.behavior.delayMs = 40;
    state.behavior.toolData = {
      assistant_text: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
      agent_rev: 2,
      model: 'gpt-4.1',
    };
    const client = new CmsAgentClient();
    await Promise.all([
      client.converse(validRequest({ turn_id: 't_a' })),
      client.converse(validRequest({ turn_id: 't_b' })),
      client.converse(validRequest({ turn_id: 't_c' })),
    ]);
    assert.equal(
      state.requests.filter((entry) => entry.rpcMethod === 'initialize').length,
      1,
      'concurrent first calls must share one handshake, not orphan sessions'
    );
  });

  it('redacts a bearer echoed back inside a successful assistant reply', async () => {
    state.behavior.toolData = {
      assistant_text: `I found ${TOKEN} in the config.`,
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
      agent_rev: 2,
      model: 'gpt-4.1',
    };
    const result = await new CmsAgentClient().converse(validRequest());
    assert.equal(result.ok, true);
    assert.ok(!JSON.stringify(result).includes(TOKEN), 'the bearer must not survive a success path either');
    // …but the success payload keeps its own shape: no key-dropping on content.
    assert.deepEqual(result.ok === true && result.data.usage, { input_tokens: 1, output_tokens: 1, cost_usd: 0 });
  });

  it('does not strip credential-shaped KEYS from editor content on the success path', async () => {
    state.behavior.toolData = {
      tool_calls: [{ id: 'call_1', name: 'patch', args: { ops: [{ path: '/secret_sauce', value: 'the recipe' }] } }],
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
      agent_rev: 2,
      model: 'gpt-4.1',
    };
    const result = await new CmsAgentClient().converse(validRequest());
    assert.equal(result.ok, true);
    // A patch whose content mentions "secret" is editor copy, not a credential;
    // redacting it here would silently corrupt what the agent proposed.
    assert.equal(JSON.stringify(result.ok === true && result.data.tool_calls).includes('the recipe'), true);
  });

  it('parses an SSE-framed response as well as application/json', async () => {
    state.behavior.sse = true;
    state.behavior.toolData = {
      assistant_text: 'streamed',
      usage: { input_tokens: 2, output_tokens: 3, cost_usd: 0.1 },
      agent_rev: 2,
      model: 'gpt-4.1',
    };
    const result = await new CmsAgentClient().converse(validRequest());
    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.assistant_text, 'streamed');
  });

  it('unwraps the {ok:true,data} envelope and rejects a response without one', async () => {
    state.behavior.rawResult = { structuredContent: { assistant_text: 'no envelope' } };
    const result = await new CmsAgentClient().converse(validRequest());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, 'cms_agent_protocol_error');
  });

  it('aborts on timeout and marks the turn_id reusable', async () => {
    state.behavior.delayMs = 300;
    const client = new CmsAgentClient({ timeoutMs: 60 });
    const result = await client.converse(validRequest());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, 'cms_agent_timeout');
    assert.equal(result.ok === false && result.retryableWithSameTurnId, true);
  });

  it('an unreachable endpoint is transport-class, not a claimed turn', async () => {
    process.env.CMS_AGENT_MCP_ENDPOINT = 'http://127.0.0.1:1/mcp';
    const result = await new CmsAgentClient().converse(validRequest());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, 'cms_agent_unreachable');
    assert.equal(result.ok === false && result.retryableWithSameTurnId, true);
  });

  it('drops an expired session on 404 so the next call re-handshakes', async () => {
    state.behavior.toolData = { agent_ref: 'agt_client_manager@2' };
    const client = new CmsAgentClient();
    await client.resolveAgent({ role: 'client_manager', project_id: 'platform' });
    assert.ok(client.currentSessionId());

    state.behavior.callStatus = 404;
    const expired = await client.converse(validRequest());
    assert.equal(expired.ok, false);
    assert.equal(expired.ok === false && expired.code, 'cms_agent_protocol_error');
    assert.equal(expired.ok === false && expired.retryableWithSameTurnId, true);
    assert.equal(client.currentSessionId(), undefined);
  });
});

// ─── errors ──────────────────────────────────────────────────────────────────

describe('error mapping', () => {
  it('maps the opaque 401 to one auth code without claiming to know the cause', async () => {
    state.behavior.callStatus = 401;
    const result = await new CmsAgentClient().converse(validRequest());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, 'cms_agent_auth_failed');
    // Auth is checked at the door, before any tool dispatch, so no idempotency
    // claim was written and the turn_id survives the operator fixing the token.
    assert.equal(result.ok === false && result.retryableWithSameTurnId, true);
    // Wrong-project and bad-token are byte-identical upstream; the copy must not pick one.
    assert.match(result.ok === false ? result.message : '', /same response for both/i);
  });

  it('reads the frozen machine code at error.data.error.code', async () => {
    for (const code of ['unknown_project', 'transcript_too_large', 'model_timeout', 'invalid_turn_request']) {
      state.behavior.toolError = { code: -32000, message: `${code}: rejected`, data: { error: { code } } };
      const result = await new CmsAgentClient().converse(validRequest());
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.code, code);
      // Anything the server answered has already claimed the turn_id.
      assert.equal(result.ok === false && result.retryableWithSameTurnId, false);
    }
  });

  it('an unknown machine code degrades to cms_agent_error rather than being trusted', async () => {
    state.behavior.toolError = { code: -32000, message: 'weird', data: { error: { code: 'not_in_the_frozen_list' } } };
    const result = await new CmsAgentClient().converse(validRequest());
    assert.equal(result.ok === false && result.code, 'cms_agent_error');
  });

  it('a 5xx is transport-class: it never reached tool code, so the turn_id survives', async () => {
    state.behavior.callStatus = 503;
    const result = await new CmsAgentClient().converse(validRequest());
    assert.equal(result.ok === false && result.code, 'cms_agent_error');
    assert.equal(result.ok === false && result.retryableWithSameTurnId, true);
  });

  it('never leaks the bearer through an upstream error message', async () => {
    state.behavior.initializeStatus = 401;
    const result = await new CmsAgentClient().converse(validRequest());
    assert.equal(result.ok, false);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(TOKEN), 'the bearer must never appear in a returned error');
  });
});

// ─── agent_ref cache ─────────────────────────────────────────────────────────

describe('agent_ref resolution', () => {
  it('caches per (role, project) and re-resolves after invalidation', async () => {
    state.behavior.toolData = { agent_ref: 'agt_client_manager@2' };
    const client = new CmsAgentClient();
    await client.resolveAgent({ role: 'client_manager', project_id: 'platform' });
    await client.resolveAgent({ role: 'client_manager', project_id: 'platform' });
    assert.equal(state.toolCalls.filter((call) => call.name === 'agent_resolve').length, 1);

    await client.resolveAgent({ role: 'client_manager', project_id: 'dr-lurie' });
    assert.equal(state.toolCalls.filter((call) => call.name === 'agent_resolve').length, 2);

    client.invalidateAgentRef('client_manager', 'platform');
    await client.resolveAgent({ role: 'client_manager', project_id: 'platform' });
    assert.equal(state.toolCalls.filter((call) => call.name === 'agent_resolve').length, 3);
  });

  it('expires the cache on TTL', async () => {
    state.behavior.toolData = { agent_ref: 'agt_client_manager@2' };
    let clock = 1_000;
    const client = new CmsAgentClient({ now: () => clock });
    await client.resolveAgent({ role: 'client_manager', project_id: 'platform' });
    clock += 10 * 60_000;
    await client.resolveAgent({ role: 'client_manager', project_id: 'platform' });
    assert.equal(state.toolCalls.filter((call) => call.name === 'agent_resolve').length, 2);
  });

  it('drops the cached ref when the agent no longer resolves', async () => {
    state.behavior.toolError = {
      code: -32000,
      message: 'agent_unresolved',
      data: { error: { code: 'agent_unresolved' } },
    };
    const client = new CmsAgentClient();
    const result = await client.resolveAgent({ role: 'client_manager', project_id: 'platform' });
    assert.equal(result.ok === false && result.code, 'agent_unresolved');
  });
});

// ─── bounds pre-flight ───────────────────────────────────────────────────────

describe('bounds pre-flight', () => {
  it('a local bounds violation never reaches the wire, so the turn_id is not burned', async () => {
    const client = new CmsAgentClient();
    const oversized = validRequest({
      messages: Array.from({ length: CMS_AGENT_BOUNDS.maxMessages + 1 }, () => ({ role: 'user' as const, text: 'x' })),
    });
    const result = await client.converse(oversized);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, 'transcript_too_large');
    assert.equal(result.ok === false && result.retryableWithSameTurnId, true);
    assert.equal(state.requests.length, 0, 'a locally-detected violation must not hit the network');
  });

  it('rejects the request shapes the strict contract rejects', () => {
    assert.equal(checkConverseBounds(validRequest()), undefined);

    assert.equal(
      checkConverseBounds(validRequest({ context: { site_id: 's', object_type: 'page' } }))?.code,
      'invalid_turn_request'
    );
    assert.equal(checkConverseBounds(validRequest({ actor: { kind: 'human', id: '' } }))?.code, 'invalid_turn_request');
    assert.equal(
      checkConverseBounds(validRequest({ actor: { kind: 'human', id: 'wolf@example.com' } }))?.code,
      'invalid_turn_request'
    );
    // …but a non-email id containing '@' is VALID upstream, so the pre-flight
    // must not invent a stricter rule and refuse work the service accepts.
    assert.equal(checkConverseBounds(validRequest({ actor: { kind: 'human', id: 'usr@tenant' } })), undefined);
    // CA6 is live at agent rev 2: diagnostics_requested is an accepted field.
    assert.equal(
      checkConverseBounds(validRequest({ context: { site_id: 's', diagnostics_requested: true } })),
      undefined
    );
    assert.equal(
      checkConverseBounds(validRequest({ tools: [{ name: 'patch', description: '  ', input_schema: {} }] }))?.code,
      'invalid_turn_request'
    );
    assert.equal(checkConverseBounds(validRequest({ messages: [] }))?.code, 'invalid_turn_request');
    assert.equal(
      checkConverseBounds(validRequest({ constraints: { max_tokens: 40_000, timeout_ms: 90_000 } }))?.code,
      'invalid_turn_request'
    );
    assert.equal(
      checkConverseBounds(validRequest({ constraints: { max_tokens: 16_000, timeout_ms: 200_000 } }))?.code,
      'invalid_turn_request'
    );
  });

  it('enforces the frozen per-field lengths, not just the aggregate sizes', () => {
    const cases: Array<[string, CmsAgentConverseRequest]> = [
      ['project_id', validRequest({ project_id: 'p'.repeat(64) })],
      ['conversation_id', validRequest({ conversation_id: 'c'.repeat(257) })],
      ['turn_id', validRequest({ turn_id: 't'.repeat(257) })],
      ['agent_ref', validRequest({ agent_ref: 'a'.repeat(257) })],
      ['actor.id', validRequest({ actor: { kind: 'human', id: 'u'.repeat(257) } })],
      ['site_id', validRequest({ context: { site_id: 's'.repeat(129) } })],
      ['object_type', validRequest({ context: { site_id: 's', object_type: 't'.repeat(129), object_id: 'o' } })],
      ['object_id', validRequest({ context: { site_id: 's', object_type: 't', object_id: 'o'.repeat(257) } })],
      ['focus', validRequest({ context: { site_id: 's', focus: 'f'.repeat(501) } })],
      ['approval_note', validRequest({ context: { site_id: 's', approval_note: 'n'.repeat(1001) } })],
      ['description', validRequest({ tools: [{ name: 'patch', description: 'd'.repeat(16_001), input_schema: {} }] })],
    ];
    for (const [label, request] of cases) {
      assert.equal(checkConverseBounds(request)?.code, 'invalid_turn_request', `${label} must be bounded`);
    }
    // Right at the limits, all still valid.
    assert.equal(checkConverseBounds(validRequest({ context: { site_id: 's', focus: 'f'.repeat(500) } })), undefined);
  });

  it('accepts Platform’s real tool count', () => {
    const tools = Array.from({ length: 19 }, (_, index) => ({
      name: `tool_${index}`,
      description: 'A real description.',
      input_schema: { type: 'object' as const },
    }));
    assert.equal(checkConverseBounds(validRequest({ tools })), undefined);
  });
});

// ─── sanitizer ───────────────────────────────────────────────────────────────

describe('sanitizer', () => {
  it('redacts token-shaped keys and the bearer value wherever it appears', () => {
    const payload = {
      authorization: `Bearer ${TOKEN}`,
      nested: { api_key: 'k', apiKey: 'k', accessToken: 'k', client_secret: 'k', note: `leaked ${TOKEN} here` },
      safe: { site_id: 'site_platform', tokens_used: 12 },
      list: [{ token: 'x' }, `prefix ${TOKEN}`],
    };
    const safe = sanitizeCmsAgentPayload(payload, [TOKEN]) as Record<string, unknown>;
    const serialized = JSON.stringify(safe);

    assert.ok(!serialized.includes(TOKEN), 'the bearer value must not survive');
    assert.equal(safe.authorization, '[REDACTED]');
    const nested = safe.nested as Record<string, unknown>;
    for (const key of ['api_key', 'apiKey', 'accessToken', 'client_secret']) {
      assert.equal(nested[key], '[REDACTED]', `${key} must be redacted`);
    }
    assert.equal(nested.note, 'leaked [REDACTED] here');
    assert.deepEqual(safe.safe, { site_id: 'site_platform', tokens_used: 12 });
  });

  it('never redacts the usage counts — they are the whole point of the response', () => {
    // A substring rule would eat `input_tokens`/`output_tokens` and quietly
    // destroy the per-tenant cost rollup. `token` is a credential; `tokens` is
    // a count noun.
    const usage = { input_tokens: 120, output_tokens: 30, cost_usd: 0.00048 };
    assert.deepEqual(sanitizeCmsAgentPayload({ usage, tokens_used: 150 }, [TOKEN]), { usage, tokens_used: 150 });
  });

  it('leaves a bare `key` alone — blob keys are not credentials', () => {
    assert.deepEqual(sanitizeCmsAgentPayload({ key: 'agent-chats/obj_1' }, [TOKEN]), { key: 'agent-chats/obj_1' });
  });

  it('leaves innocent values alone and survives primitives', () => {
    assert.equal(sanitizeCmsAgentPayload('plain', [TOKEN]), 'plain');
    assert.equal(sanitizeCmsAgentPayload(42, [TOKEN]), 42);
    assert.equal(sanitizeCmsAgentPayload(null, [TOKEN]), null);
    assert.deepEqual(sanitizeCmsAgentPayload({ focus: 'Homepage → Hero' }, [TOKEN]), { focus: 'Homepage → Hero' });
  });
});
