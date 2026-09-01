import '../../../../../sites/drlurie/config/policy-bindings.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAgentSystemPrompt,
  publishedObjectRef,
  resultObjectRef,
  runAgentLoop,
  startRun,
  type ProtocolDeps,
} from './loop.js';
import { loadChatDoc, saveChatDoc, type AgentChatStore, type ChatDoc, type ChatRun, type RunProfile } from './chat-store.js';
import { providerEngine } from './engine.js';
import type { ProviderAdapter } from './provider.js';
import type { ToolContext } from './tools.js';

const profile: RunProfile = {
  profile_id: 'prof_test',
  name: 'Test agent',
  provider: 'anthropic',
  model: 'test-model',
  system_prompt: 'Base prompt.',
};

const baseRun = (overrides: Partial<ChatRun> = {}): ChatRun => ({
  run_id: 'run_1',
  started_at: '2026-08-12T00:00:00.000Z',
  principal: { kind: 'human', id: 'u1', email: 'editor@example.com' },
  profile,
  autonomy: {},
  learning_mode: false,
  diagnostics_requested: false,
  engine: 'provider',
  transcript: [],
  call_queue: [],
  provider_turns: 0,
  tool_calls_used: 0,
  output_tokens_used: 0,
  ...overrides,
});

const memoryStore = (): AgentChatStore => {
  const blobs = new Map<string, string>();
  return {
    async get(key) {
      return blobs.get(key) ?? null;
    },
    async setJSON(key, value) {
      blobs.set(key, JSON.stringify(value));
    },
    async list({ prefix }) {
      return { blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
};

const baseDoc = (overrides: Partial<ChatDoc> = {}): ChatDoc => ({
  schema_version: 'agent-chat.v1',
  chat_id: 'free:1',
  kind: 'free',
  title: 'Chat',
  created_by: 'u1',
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:00:00.000Z',
  status: 'idle',
  seq: 0,
  events: [],
  runs: [],
  ...overrides,
});

describe('buildAgentSystemPrompt — chat-interactive-controls protocol instruction', () => {
  it('teaches the agent to prefer a controls block for enumerable decisions', () => {
    const prompt = buildAgentSystemPrompt(baseDoc(), baseRun());
    assert.match(prompt, /```controls```/);
    assert.match(prompt, /radio.*checkbox.*toggle/s);
    assert.match(prompt, /at most one controls block per message/i);
  });

  it('teaches the agent to treat a Selections receipt as settled, not re-ask', () => {
    const prompt = buildAgentSystemPrompt(baseDoc(), baseRun());
    assert.match(prompt, /Selections \[controls:<id>\]/);
    assert.match(prompt, /without re-asking/i);
  });

  it('still carries the base profile prompt and object-binding instruction', () => {
    const prompt = buildAgentSystemPrompt(
      baseDoc({ kind: 'object', object_type: 'page', object_id: 'page_home' }),
      baseRun()
    );
    assert.match(prompt, /Base prompt\./);
    assert.match(prompt, /bound to the page object "page_home"/);
  });
});

// ─── E2b: the publish result reaches the receipt ────────────────────────────

/**
 * A successful publish's 200 body, as `server/lib/object-publish.ts` returns
 * it — the receipt included, because what must NOT leave this body is half
 * the point of the test below.
 */
const PUBLISH_OK = {
  published: true,
  object_type: 'content_item',
  object_id: 'req_agent_retinol_basics_20260825_01',
  published_time: '2026-08-31T00:00:00.000Z',
  receipt: {
    kind: 'object_export_commit',
    branch: 'main',
    commit_sha: 'abc1234def5678',
    tree_sha: 'fed9876cba5432',
    no_op: false,
    attempts: 1,
    files: ['sites/drlurie/data/site/content_item/req_agent_retinol_basics_20260825_01.json'],
    content_revision: 7,
    exported_at: '2026-08-31T00:00:00.000Z',
  },
  version: 12,
  content_revision: 7,
  article_path: '/retinol-for-beginners',
};

describe('publishedObjectRef — the stamp a proven publish leaves on its tool_result', () => {
  it('a successful publish yields the published object id and type', () => {
    assert.deepEqual(publishedObjectRef('publish', JSON.stringify(PUBLISH_OK)), {
      published_object_id: 'req_agent_retinol_basics_20260825_01',
      published_object_type: 'content_item',
    });
  });

  it('reads the generated registry’s object_publish identically — same verb, same body', () => {
    assert.deepEqual(publishedObjectRef('object_publish', JSON.stringify(PUBLISH_OK)), {
      published_object_id: 'req_agent_retinol_basics_20260825_01',
      published_object_type: 'content_item',
    });
  });

  it('stamps NOTHING but the two ids — the export receipt (branch, shas, repo paths) is never carried', () => {
    const stamp = publishedObjectRef('publish', JSON.stringify(PUBLISH_OK))!;
    assert.deepEqual(Object.keys(stamp).sort(), ['published_object_id', 'published_object_type']);
    assert.doesNotMatch(JSON.stringify(stamp), /sites\/|commit_sha|abc1234|main/);
  });

  it('claims nothing without the body’s own proof: no `published: true`, no object_id, or unparseable', () => {
    // A partial publish — the export committed but the record was not stamped
    // — is an error status, and even read directly it never says published.
    const partial = { code: 'stamp_failed_export_committed', export_committed: true, receipt: PUBLISH_OK.receipt };
    assert.equal(publishedObjectRef('publish', JSON.stringify(partial)), undefined);
    assert.equal(publishedObjectRef('publish', JSON.stringify({ ...PUBLISH_OK, published: false })), undefined);
    assert.equal(publishedObjectRef('publish', JSON.stringify({ published: true })), undefined);
    assert.equal(publishedObjectRef('publish', 'not json'), undefined);
  });

  it('is scoped to the publish verbs — no other tool can mint a "Published" claim', () => {
    for (const tool of ['patch', 'create_object', 'submit_review', 'publish_workspace_run', 'discard']) {
      assert.equal(publishedObjectRef(tool, JSON.stringify(PUBLISH_OK)), undefined, tool);
    }
  });
});

/**
 * The wiring, end to end through the real loop (the `registry-wiring.test.ts`
 * /`approval-routing.test.ts` pattern): an auto-executed publish must leave
 * the stamp on its persisted `tool_result` event — that event IS the chat's
 * only source for the receipt's "Published" clause — and must still leave the
 * result body OFF it, since `publish` sets no `discloseResult` and its body
 * carries the export receipt.
 */
describe('E2b — a successful publish’s tool_result event carries the ids and nothing else', () => {
  const runPublish = async (verbResponse: { status: number; body: Record<string, unknown> }) => {
    const chatStore = memoryStore();
    await saveChatDoc(chatStore, {
      ...baseDoc({ chat_id: 'free:e2b' }),
    });
    const ctx = {
      roles: ['owner'],
      principal: { id: 'editor_1', email: 'editor@example.com' },
      agentAuthoredOps: () => new Set<string>(),
      contract: () => ({}),
      validateNewObject: async () => ({}),
      listArtifacts: async () => ({}),
      verb: async () => verbResponse,
    } as unknown as ToolContext;
    const protocol: ProtocolDeps = { chatStore, toolContext: ctx, nowIso: () => '2026-08-31T00:00:00.000Z' };
    const started = await startRun(
      protocol,
      (await loadChatDoc(chatStore, 'free:e2b'))!,
      'Publish the retinol article.',
      { id: 'editor_1', email: 'editor@example.com' },
      profile,
      { publish: 'auto' },
      false,
      undefined,
      false,
      'legacy'
    );
    const adapter: ProviderAdapter = async () => ({
      outputTokens: 5,
      toolCalls: [
        {
          id: 'c1',
          name: 'publish',
          args: {
            object_type: 'content_item',
            object_id: 'req_agent_retinol_basics_20260825_01',
            lock_token: 'lock_1',
          },
        },
      ],
    });
    await runAgentLoop(
      { chatStore, toolContext: ctx, engine: providerEngine(adapter), nowIso: protocol.nowIso },
      'free:e2b',
      started.resume!.triggerToken
    );
    const doc = await loadChatDoc(chatStore, 'free:e2b');
    return doc!.events.find((e) => e.type === 'tool_result' && e.detail?.tool === 'publish');
  };

  it('the stamp is on the event, the receipt body is not, and it is not mistaken for a creation', async () => {
    const event = await runPublish({ status: 200, body: PUBLISH_OK });
    assert.ok(event, 'the publish must leave a tool_result event');
    assert.equal(event!.detail?.is_error, false);
    assert.equal(event!.detail?.published_object_id, 'req_agent_retinol_basics_20260825_01');
    assert.equal(event!.detail?.published_object_type, 'content_item');
    // Not a creation: `createdObjectsFromEvents` keys on `object_id`.
    assert.equal(event!.detail?.object_id, undefined);
    // `publish` sets no discloseResult — the commit sha, branch and export
    // path in its body must not ride the persisted, editor-visible event.
    assert.equal(event!.detail?.output, undefined);
    assert.doesNotMatch(JSON.stringify(event!.detail), /commit_sha|sites\/drlurie/);
  });

  it('a REFUSED publish stamps nothing — the receipt can claim nothing from it', async () => {
    const event = await runPublish({
      status: 422,
      body: { code: 'validation_failed', error: 'Validation failed', blockers: ['missing_hero_image'] },
    });
    assert.ok(event);
    assert.equal(event!.detail?.is_error, true);
    assert.equal(event!.detail?.published_object_id, undefined);
  });
});

// ─── E2c: the creation stamp was legacy-name-only, so it never fired ────────

describe('resultObjectRef — both registries name the same four creation tools', () => {
  const body = JSON.stringify({ record: { object_id: 'obj_1' } });

  it('stamps under the GENERATED names, which is what a default run actually calls', () => {
    assert.deepEqual(resultObjectRef('object_create', { object_type: 'page' }, body), {
      object_id: 'obj_1',
      object_type: 'page',
    });
    assert.deepEqual(resultObjectRef('object_create_variant', {}, body), {
      object_id: 'obj_1',
      object_type: 'content_item',
    });
    assert.deepEqual(resultObjectRef('object_instantiate_template', {}, body), {
      object_id: 'obj_1',
      object_type: 'page',
    });
    assert.deepEqual(
      resultObjectRef('object_instantiate_section_template', { target: { kind: 'standalone' } }, body),
      { object_id: 'obj_1', object_type: 'section' }
    );
  });

  it('the legacy names keep stamping exactly as before — persisted history stays readable', () => {
    assert.deepEqual(resultObjectRef('create_object', { object_type: 'page' }, body), {
      object_id: 'obj_1',
      object_type: 'page',
    });
  });

  it('FIX 3: a section instantiated INTO a page stamps nothing — nothing was created', () => {
    // `target.kind: 'page'` patches an existing page; the `object_id` in that
    // result is the PAGE's. Stamping it made the receipt say "Created draft"
    // about an edit and link a page id as a content_item, which dead-ends on
    // "not found". No proven type, no claim — under either registry's name.
    for (const name of ['instantiate_section_template', 'object_instantiate_section_template']) {
      assert.equal(resultObjectRef(name, { target: { kind: 'page' } }, body), undefined, name);
      assert.equal(resultObjectRef(name, {}, body), undefined, `${name} with no target`);
    }
  });

  it('and `create_object` without a declared type stamps nothing either', () => {
    assert.equal(resultObjectRef('object_create', {}, body), undefined);
  });

  it('still only stamps a result that PROVES the object exists, and only for creation tools', () => {
    assert.equal(resultObjectRef('object_create', { object_type: 'page' }, JSON.stringify({ ok: true })), undefined);
    assert.equal(resultObjectRef('object_create', { object_type: 'page' }, 'not json'), undefined);
    assert.equal(resultObjectRef('object_patch', {}, body), undefined);
    assert.equal(resultObjectRef('object_publish', {}, body), undefined);
  });
});

/**
 * The case that has been silently broken: a run on the DEFAULT (generated)
 * registry creates an object, and the `tool_result` event the chat receipt
 * reads must carry the stamp — plus the finished run's own chips, which were
 * legacy-keyed too and so read "no changes" for a run that created something.
 */
describe('E2c — a generated-registry creation stamps its object through the real loop', () => {
  it('object_create_variant leaves object_id/object_type on the event and a "created 1 object" chip', async () => {
    const chatStore = memoryStore();
    await saveChatDoc(chatStore, baseDoc({ chat_id: 'free:e2c' }));
    const ctx = {
      roles: ['owner'],
      principal: { id: 'editor_1', email: 'editor@example.com' },
      agentAuthoredOps: () => new Set<string>(),
      contract: () => ({}),
      validateNewObject: async () => ({}),
      listArtifacts: async () => ({}),
      verb: async () => ({ status: 200, body: { record: { object_id: 'req_variant_20260831_01' } } }),
    } as unknown as ToolContext;
    const protocol: ProtocolDeps = { chatStore, toolContext: ctx, nowIso: () => '2026-08-31T00:00:00.000Z' };
    const started = await startRun(
      protocol,
      (await loadChatDoc(chatStore, 'free:e2c'))!,
      'Make me an A/B variant of the retinol article.',
      { id: 'editor_1', email: 'editor@example.com' },
      profile,
      { object_create_variant: 'auto' },
      false,
      undefined,
      false,
      'generated'
    );
    let turn = 0;
    const adapter: ProviderAdapter = async () =>
      turn++ === 0
        ? {
            outputTokens: 5,
            toolCalls: [
              { id: 'c1', name: 'object_create_variant', args: { source_object_id: 'req_retinol_20260825_01' } },
            ],
          }
        : { outputTokens: 5, toolCalls: [], text: 'Done — the variant is drafted.' };
    await runAgentLoop(
      { chatStore, toolContext: ctx, engine: providerEngine(adapter), nowIso: protocol.nowIso },
      'free:e2c',
      started.resume!.triggerToken
    );

    const doc = await loadChatDoc(chatStore, 'free:e2c');
    const event = doc!.events.find((e) => e.type === 'tool_result' && e.detail?.tool === 'object_create_variant');
    assert.ok(event, 'the creation must leave a tool_result event');
    assert.equal(event!.detail?.is_error, false);
    // This stamp is the ONLY thing `createdObjectsFromEvents` reads; without
    // it the receipt's "Created draft → open" clause cannot render at all.
    assert.equal(event!.detail?.object_id, 'req_variant_20260831_01');
    assert.equal(event!.detail?.object_type, 'content_item');
    // …and not confused with a publish.
    assert.equal(event!.detail?.published_object_id, undefined);
    assert.deepEqual(doc!.runs.at(-1)?.chips, ['created 1 object']);
  });
});
