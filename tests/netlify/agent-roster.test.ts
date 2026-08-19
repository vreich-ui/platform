/**
 * T9.26 — roster & assignment + canvas Ask-AI re-point (§4a).
 *
 * Handler level (real local file-backed stores; unique ids per run):
 * assignment CRUD is Owner-only (store-tier admin 403s but can read);
 * resolution lands in a NEW chat's policy-only run record while the public
 * reasoning identity remains Client Manager. Lib level: askAiForObject
 * speaks the ASSIGNED profile's provider — both transports mocked and
 * conformance-checked (Anthropic forced-tool vs OpenAI function-calling).
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ADMIN_EMAILS = 'wolf@example.com';
process.env.CMS_AGENT_MCP_ENDPOINT = 'https://cms-agent.test/mcp';
process.env.CMS_AGENT_MCP_TOKEN = 'test-token';

import { handler as chatHandler } from '../../netlify/functions/admin-agent-chat.js';
import { askAiForObject, type AskAiObjectStore } from '../../packages/core/server/lib/ask-ai-object.js';
import { getAgentChatBlobStore, loadChatDoc } from '../../packages/core/server/lib/agent/chat-store.js';
import { getUsersBlobStore, putUserRecord } from '../../packages/core/server/lib/users-store.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import type { ObjectRecord } from '../../packages/core/schema/object-record-v1.js';

const RUN = Date.now().toString(36);
const OWNER_CTX = { clientContext: { user: { sub: 'id-wolf', email: 'wolf@example.com' } } };
const ADMIN_EMAIL = `roster-admin-${RUN}@example.com`;
const ADMIN_CTX = { clientContext: { user: { sub: 'id-roster', email: ADMIN_EMAIL } } };

const call = async (body: Record<string, unknown>, context?: unknown) =>
  chatHandler({ httpMethod: 'POST', body: JSON.stringify(body), headers: {} }, context as never);

const parse = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

test('roster RBAC + §4a policy resolution: a new run freezes the profile while Client Manager remains the reasoning identity', async () => {
  // Seed a store-tier ADMIN (not in ADMIN_EMAILS): passes the admin wall, is not an owner.
  const usersStore = await getUsersBlobStore({});
  await putUserRecord(usersStore, {
    schema_version: 1,
    email: ADMIN_EMAIL,
    display_name: 'Roster Admin',
    role: 'admin',
    status: 'active',
    invited_by: 'wolf@example.com',
    created_at: '2026-07-19T00:00:00.000Z',
    updated_at: '2026-07-19T00:00:00.000Z',
    audit: [],
  });

  // Owner creates a profile and assigns it as the content_item type default.
  const profileId = `prof_test_${RUN}`;
  const upsert = await call(
    {
      action: 'upsert_profile',
      profile: { profile_id: profileId, name: `Test GPT ${RUN}`, provider: 'openai', model: 'gpt-5' },
    },
    OWNER_CTX
  );
  assert.equal(upsert.statusCode, 200, upsert.body);
  const assign = await call(
    { action: 'assign_profile', target: { kind: 'type', object_type: 'content_item' }, profile_id: profileId },
    OWNER_CTX
  );
  assert.equal(assign.statusCode, 200, assign.body);

  // Store-tier admin: reads pass, writes 403.
  const read = await call({ action: 'list_profiles' }, ADMIN_CTX);
  assert.equal(read.statusCode, 200);
  const denied = await call(
    { action: 'upsert_profile', profile: { name: 'Nope', provider: 'openai', model: 'x' } },
    ADMIN_CTX
  );
  assert.equal(denied.statusCode, 403);
  const deniedAssign = await call(
    { action: 'assign_profile', target: { kind: 'site_default' }, profile_id: profileId },
    ADMIN_CTX
  );
  assert.equal(deniedAssign.statusCode, 403);

  // A NEW object chat on a content_item resolves the TYPE assignment into the
  // compatibility policy record. It cannot replace Client Manager as the
  // public reasoning identity.
  const objectId = `req_roster_demo_20260719_${RUN.slice(-2)}`;
  const created = await call(
    { action: 'create_chat', kind: 'object', object_type: 'content_item', object_id: objectId },
    OWNER_CTX
  );
  assert.equal(created.statusCode, 200, created.body);
  const chatId = (parse(created).chat as { chat_id: string }).chat_id;
  const sent = await call({ action: 'send', chat_id: chatId, text: 'Hello agent.' }, OWNER_CTX);
  assert.equal(sent.statusCode, 200, sent.body);
  const doc = await loadChatDoc(await getAgentChatBlobStore({}), chatId);
  assert.equal(doc?.run?.profile.profile_id, profileId);
  assert.equal(doc?.run?.profile.provider, 'openai');
  const view = parse(await call({ action: 'get_chat', chat_id: chatId }, OWNER_CTX));
  assert.equal((view.agent as { name: string }).name, 'Client Manager');
  assert.equal((view.agent as { agent_ref: string }).agent_ref, 'agt_client_manager');
  assert.equal((view.agent as { engine: string }).engine, 'cms_agent');

  // Unknown profile id on assign → 404.
  const missing = await call(
    { action: 'assign_profile', target: { kind: 'site_default' }, profile_id: 'prof_ghost' },
    OWNER_CTX
  );
  assert.equal(missing.statusCode, 404);
});

// ─── ask-ai re-point: both providers, conformance-mocked ─────────────────────

const pageRecord = (): ObjectRecord => ({
  object_id: 'page_askai',
  object_type: 'page',
  schema_version: 'page.v1',
  site: 'site_drlurie',
  created_at: '2026-07-19T00:00:00.000Z',
  updated_at: '2026-07-19T00:00:00.000Z',
  status: 'active',
  body: {
    route: '/askai',
    pageType: 'home',
    title: 'Ask AI Page',
    seo: { description: 'Fixture.' },
    sections: [{ id: 's_hero', type: 'hero', data: { heading: 'Hi', actions: [] } }],
  },
  publication: { published_time: null },
  history: [],
  version: 1,
  content_revision: 1,
});

const memObjectStore = (): AskAiObjectStore => {
  const map = new Map<string, string>([[objectRecordKey('page', 'page_askai'), JSON.stringify(pageRecord())]]);
  return { get: async (key) => map.get(key) ?? null };
};

const request = {
  object_type: 'page',
  object_id: 'page_askai',
  instruction: 'Tighten the hero heading.',
};

test('ask-ai anthropic transport: /v1/messages, x-api-key, forced tool_choice, parsed input object', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(
      JSON.stringify({
        content: [{ type: 'tool_use', name: 'propose_object_changes', input: { title: 'Calmer skin, explained' } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  const result = await askAiForObject(memObjectStore(), request, {
    apiKey: 'ant-key',
    model: 'claude-opus-4-8',
    provider: 'anthropic',
    fetchImpl,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages');
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'ant-key');
  assert.ok(headers['anthropic-version']);
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.equal(body.model, 'claude-opus-4-8');
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'propose_object_changes' });
  assert.ok((result.body.suggestion as Record<string, unknown>).title);
});

test('ask-ai openai transport (default): chat/completions with forced function call', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'propose_object_changes',
                    arguments: JSON.stringify({ title: 'Calmer skin, explained' }),
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  const result = await askAiForObject(memObjectStore(), request, {
    apiKey: 'oa-key',
    model: 'gpt-5',
    fetchImpl, // provider omitted → openai (back-compat default)
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(calls[0]!.url, 'https://api.openai.com/v1/chat/completions');
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer oa-key');
  const body = JSON.parse(String(calls[0]!.init.body)) as { tool_choice?: { function?: { name?: string } } };
  assert.equal(body.tool_choice?.function?.name, 'propose_object_changes');
  assert.ok((result.body.suggestion as Record<string, unknown>).title);
});
