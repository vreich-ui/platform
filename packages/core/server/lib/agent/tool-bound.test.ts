/**
 * W19 T19.8 — the wire tool bound, and the fallback that makes the two repos'
 * merge order irrelevant.
 *
 * Every one of these is a regression from the adversarial review: the original
 * fallback keyed on a free-text regex over an upstream message this repo does
 * not control, so a wording change would have turned every admin chat turn
 * into a hard failure.
 */
import '../../../../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CMS_AGENT_BOUNDS } from './cms-agent-client.js';
import { cmsAgentEngine, trimToolsToCmsAgentBound, type CmsAgentTurnClient } from './engine.js';
import type { ChatDoc, ChatRun } from './chat-store.js';
import type { WireTool } from './provider.js';

const tool = (name: string): WireTool => ({ name, description: `d ${name}`, input_schema: { type: 'object' } });

const wire = (count: number, prefix = 'tool'): WireTool[] =>
  Array.from({ length: count }, (_, index) => tool(`${prefix}_${index}`));

const REQUEST_TOOLS = ['list_requests', 'get_request', 'retry_request', 'archive_request'].map(tool);
const MEMBERSHIP_TOOLS = ['member_list', 'member_invite', 'member_remove'].map(tool);

describe('the family-ordered trim', () => {
  it('does nothing when the wire already fits', () => {
    const result = trimToolsToCmsAgentBound(wire(10), 64);
    assert.equal(result.tools.length, 10);
    assert.deepEqual(result.dropped, []);
    assert.equal(result.sliced, false);
  });

  it('drops membership first, and reports it by name', () => {
    const tools = [...wire(63), ...MEMBERSHIP_TOOLS];
    const result = trimToolsToCmsAgentBound(tools, 64);
    assert.deepEqual(result.dropped, ['membership']);
    assert.equal(result.sliced, false);
    assert.equal(result.tools.length, 63);
  });

  it('drops the request family WHOLE rather than leaving half of it on the wire', () => {
    const tools = [...wire(63), ...MEMBERSHIP_TOOLS, ...REQUEST_TOOLS];
    const result = trimToolsToCmsAgentBound(tools, 64);
    assert.deepEqual(result.dropped, ['membership', 'editorial_requests']);
    // Half a family — a `list_requests` the agent can call and a `get_request`
    // it cannot — is worse than none of it.
    for (const name of ['list_requests', 'get_request', 'retry_request', 'archive_request']) {
      assert.ok(!result.tools.some((entry) => entry.name === name), `${name} must go with its family`);
    }
  });

  it('falls back to a positional slice only when families are not enough, and says so', () => {
    const result = trimToolsToCmsAgentBound(wire(200), 64);
    assert.equal(result.tools.length, 64);
    assert.equal(result.sliced, true);
  });
});

// ─── the engine fallback ─────────────────────────────────────────────────────

const doc = (): ChatDoc =>
  ({ chat_id: 'chat_1', kind: 'free', object_type: undefined, object_id: undefined }) as unknown as ChatDoc;

const run = (): ChatRun =>
  ({
    run_id: 'run_1',
    provider_turns: 0,
    principal: { kind: 'human', id: 'u1', email: 'e@example.com' },
    learning_mode: false,
    transcript: [],
  }) as unknown as ChatRun;

const stubClient = (
  responses: Array<{ ok: boolean; code?: string; message?: string }>,
  seen: Array<{ turnId: string; toolCount: number }>
): CmsAgentTurnClient =>
  ({
    resolveAgent: async () => ({ ok: true, data: 'agt_client_manager@1' }),
    invalidateAgentRef: () => {},
    converse: async (request: { turn_id: string; tools: WireTool[] }) => {
      seen.push({ turnId: request.turn_id, toolCount: request.tools.length });
      const next = responses.shift() ?? { ok: true };
      return next.ok
        ? { ok: true, data: { assistant_text: 'ok', tool_calls: [], usage: { output_tokens: 1 } } }
        : { ok: false, code: next.code, message: next.message, retryableWithSameTurnId: false };
    },
  }) as unknown as CmsAgentTurnClient;

describe('the legacy-bound fallback', () => {
  const tools = [...wire(80), ...REQUEST_TOOLS];

  it('retries at 64 on ANY invalid_turn_request — never on a wording match', async () => {
    const seen: Array<{ turnId: string; toolCount: number }> = [];
    // A zod default message, not the phrase the first implementation matched.
    const client = stubClient(
      [{ ok: false, code: 'invalid_turn_request', message: 'tools: Array must contain at most 64 element(s)' }],
      seen
    );
    const engine = cmsAgentEngine({ client, projectId: 'p', siteId: 'site_x' });
    const result = await engine({ doc: doc(), run: run(), system: '', tools });
    assert.equal(result.text, 'ok');
    assert.equal(seen.length, 2, 'one rejected send, then one retry');
    assert.ok(seen[0]!.toolCount > CMS_AGENT_BOUNDS.legacyMaxTools);
    assert.ok(seen[1]!.toolCount <= CMS_AGENT_BOUNDS.legacyMaxTools, 'the retry fits the OLD bound');
    assert.notEqual(seen[1]!.turnId, seen[0]!.turnId, 'changed bytes need a fresh turn id');
  });

  it('retries even when the rejection carries no message at all', async () => {
    const seen: Array<{ turnId: string; toolCount: number }> = [];
    const client = stubClient([{ ok: false, code: 'invalid_turn_request', message: '' }], seen);
    const engine = cmsAgentEngine({ client, projectId: 'p', siteId: 'site_x' });
    await engine({ doc: doc(), run: run(), system: '', tools });
    assert.equal(seen.length, 2);
  });

  it('gives up after ONE retry — a rejection for another reason must not spin', async () => {
    const seen: Array<{ turnId: string; toolCount: number }> = [];
    const client = stubClient(
      [
        { ok: false, code: 'invalid_turn_request', message: 'context too large' },
        { ok: false, code: 'invalid_turn_request', message: 'context too large' },
      ],
      seen
    );
    const engine = cmsAgentEngine({ client, projectId: 'p', siteId: 'site_x' });
    await assert.rejects(() => engine({ doc: doc(), run: run(), system: '', tools }));
    assert.equal(seen.length, 2, 'exactly two sends, then the error surfaces');
  });

  it('does not retry when the wire already fits the old bound — there is nothing to trim', async () => {
    const seen: Array<{ turnId: string; toolCount: number }> = [];
    const client = stubClient([{ ok: false, code: 'invalid_turn_request', message: 'something else' }], seen);
    const engine = cmsAgentEngine({ client, projectId: 'p', siteId: 'site_x' });
    await assert.rejects(() => engine({ doc: doc(), run: run(), system: '', tools: wire(20) }));
    assert.equal(seen.length, 1);
  });
});
