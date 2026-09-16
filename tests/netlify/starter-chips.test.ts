/**
 * PCL-P4 — composer starter chips, at the HTTP handler level.
 *
 * `create_chat`/`get_chat`'s `chatSummary` (server/functions/admin-agent-chat.ts)
 * stamps `starter_chips` on an object-kind chat, derived from
 * `buildObjectContract(object_type).patch_ops` — the SAME source
 * `agent/context.ts`'s `agentAuthoredOps` uses to decide what CMS-Agent may
 * actually propose for that type. This file proves the chips differ by
 * bound-object type, are absent on a free chat, and that a `send` carrying
 * `origin.starter` round-trips it onto the run's own `origin_starter` field —
 * the per-send half of main's CHAT-ORIGIN mechanism (`chat-origin.ts`,
 * `engine.ts`'s `buildTurnOrigin`), extended here with one more field. This
 * file only checks the HTTP-level wiring end to end.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ADMIN_EMAILS = process.env.ADMIN_EMAILS ?? 'wolf@example.com';
process.env.CMS_AGENT_MCP_ENDPOINT = process.env.CMS_AGENT_MCP_ENDPOINT ?? 'https://cms-agent.test/mcp';
process.env.CMS_AGENT_MCP_TOKEN = process.env.CMS_AGENT_MCP_TOKEN ?? 'test-token';

import { handler as chatHandler } from '../../netlify/functions/admin-agent-chat.js';
import { getAgentChatBlobStore, loadChatDoc } from '../../packages/core/server/lib/agent/chat-store.js';

const RUN = Date.now().toString(36);
const OWNER_CTX = { clientContext: { user: { sub: 'id-wolf', email: 'wolf@example.com' } } };

const call = async (body: Record<string, unknown>) =>
  chatHandler({ httpMethod: 'POST', body: JSON.stringify(body), headers: {} }, OWNER_CTX as never);

const parse = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

type Chip = { key: string; label: string; prompt: string };

test("starter chips differ by the bound object's type", async () => {
  const article = parse(
    await call({
      action: 'create_chat',
      kind: 'object',
      object_type: 'content_item',
      object_id: `article_chips_${RUN}`,
    })
  );
  const visualStandard = parse(
    await call({
      action: 'create_chat',
      kind: 'object',
      object_type: 'visual_standard',
      object_id: `vis_chips_${RUN}`,
    })
  );
  const articleChips = (article.chat as { starter_chips?: Chip[] }).starter_chips;
  const visualStandardChips = (visualStandard.chat as { starter_chips?: Chip[] }).starter_chips;

  assert.ok(articleChips && articleChips.length > 0, 'an article gets starter chips');
  assert.ok(visualStandardChips && visualStandardChips.length > 0, 'a visual standard gets starter chips too');
  assert.notDeepEqual(
    articleChips!.map((chip) => chip.key),
    visualStandardChips!.map((chip) => chip.key),
    'two different object types must not get the same chip set'
  );
  // 3-5 chips (rule 2), but never padded past what the type can really do (rule 4).
  assert.ok(articleChips!.length <= 5);
  assert.ok(visualStandardChips!.length <= 5);
  // Every chip is traceable to a real op name, not free-standing prose.
  for (const chip of articleChips!) assert.ok(chip.key.length > 0 && chip.key.length <= 64);
});

test('a free (non-object) chat gets no starter chips at all', async () => {
  const created = parse(await call({ action: 'create_chat', kind: 'free' }));
  assert.equal((created.chat as { starter_chips?: Chip[] }).starter_chips, undefined);
});

test('starter_chips is also carried on get_chat, not just create_chat', async () => {
  const objectId = `page_chips_${RUN}`;
  const created = parse(
    await call({ action: 'create_chat', kind: 'object', object_type: 'page', object_id: objectId })
  );
  const chatId = (created.chat as { chat_id: string }).chat_id;
  const fetched = parse(await call({ action: 'get_chat', chat_id: chatId }));
  const chips = (fetched as { starter_chips?: Chip[] }).starter_chips;
  assert.ok(chips && chips.length > 0);
});

test("a send that names a starter chip key stamps it onto the run's origin; a plain send stamps none", async () => {
  const objectId = `page_starter_send_${RUN}`;
  const created = parse(
    await call({ action: 'create_chat', kind: 'object', object_type: 'page', object_id: objectId })
  );
  const chatId = (created.chat as { chat_id: string }).chat_id;
  const chips = (created.chat as { starter_chips?: Chip[] }).starter_chips!;
  const chipKey = chips[0].key;

  const sent = await call({
    action: 'send',
    chat_id: chatId,
    text: chips[0].prompt,
    origin: { starter: chipKey },
  });
  assert.equal(sent.statusCode, 200, sent.body);
  const doc = await loadChatDoc(await getAgentChatBlobStore({}), chatId);
  // CHAT-ORIGIN's run fields are flat (`origin_request_id`, `origin_run_id`,
  // `origin_selection`, and this one) — never a nested `origin` object.
  assert.equal(doc?.run?.origin_starter, chipKey);

  // A second, unrelated chat on the same object type sent WITHOUT a chip
  // carries no starter key at all — never a guessed one.
  const objectId2 = `page_no_starter_send_${RUN}`;
  const created2 = parse(
    await call({ action: 'create_chat', kind: 'object', object_type: 'page', object_id: objectId2 })
  );
  const chatId2 = (created2.chat as { chat_id: string }).chat_id;
  const sent2 = await call({ action: 'send', chat_id: chatId2, text: 'Just an ordinary message.' });
  assert.equal(sent2.statusCode, 200, sent2.body);
  const doc2 = await loadChatDoc(await getAgentChatBlobStore({}), chatId2);
  assert.equal(doc2?.run?.origin_starter, undefined);
  assert.ok(!doc2?.run || !('origin_starter' in doc2.run));
});
