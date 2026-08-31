import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildGptConfigZip,
  renderGptInstructions,
  GPT_INSTRUCTIONS_LIMIT,
  GptInstructionsTooLongError,
} from '../../packages/core/server/lib/plugin/export-openai.js';
import { buildManifestBundle } from '../../packages/core/server/lib/plugin/build-manifest.js';
import { visibleToolDefinitions } from '../../netlify/functions/mcp.js';

const bundle = buildManifestBundle({
  origin: 'https://drluriescience.netlify.app',
  definitions: visibleToolDefinitions(),
  voice: {
    object_id: 'voice_drlurie',
    record_version: 14,
    body: {
      name: 'Dr. Lurie — evidence-led skin health',
      tone: ['warm', 'calm'],
      lexicon: { prefer: ['barrier'], avoid: ['miracle'] },
      frameworks: [{ framework_id: 'fw_concern', label: 'Concern', when_to_use: 'Reader arrives worried.' }],
    },
  },
  platform: 'openai',
  now: () => new Date('2026-08-31T12:00:00.000Z'),
  approval: { master: 'all-autonomous' },
});

const readZip = (bytes: Buffer) => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-cfg-'));
  const archive = join(dir, 'a.zip');
  writeFileSync(archive, bytes);
  return {
    names: execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    read: (p: string) => execFileSync('unzip', ['-p', archive, p], { encoding: 'utf8' }),
  };
};

test("the instructions fit ChatGPT's 8,000-character cap", () => {
  const instructions = renderGptInstructions(bundle);
  assert.ok(
    instructions.length <= GPT_INSTRUCTIONS_LIMIT,
    `instructions are ${instructions.length} chars, over the ${GPT_INSTRUCTIONS_LIMIT} limit`
  );
  // The canonical skill is ~17k, so the split is doing real work rather than
  // the limit being incidentally satisfied.
  assert.ok(bundle.skill_md.length > GPT_INSTRUCTIONS_LIMIT * 1.5);
});

test('an over-long instruction render throws rather than shipping a truncated one', () => {
  const bloated = { ...bundle, manifest_version: 'x'.repeat(GPT_INSTRUCTIONS_LIMIT) };
  assert.throws(() => buildGptConfigZip(bloated), GptInstructionsTooLongError);
});

test('what stays in instructions is what breaks the run if it is wrong', () => {
  const i = renderGptInstructions(bundle);
  // The ordering bug the live acceptance run found.
  assert.match(i, /Media now, not earlier/);
  assert.match(i, /refused before step 3/);
  // The rule that blocks a publish.
  assert.match(i, /Write `sources`\. Never write `claims`\./);
  // The ceiling is a number, not a pointer to a knowledge file.
  assert.match(i, /claim_strength 0\.\d\d/);
  assert.match(i, /Nothing on the server enforces this for you/);
  // The retry contract, in the words the live 502 proved.
  assert.match(i, /replayed_from_idempotency_key/);
  assert.match(i, /never as \*failed\*/);
  // Attribution.
  assert.match(i, /plugin:openai/);
  assert.ok(i.includes(bundle.manifest_version));
});

test('the bundle carries instructions, the setup card and three knowledge files', () => {
  const { filename, bytes } = buildGptConfigZip(bundle);
  assert.equal(filename, `${bundle.connection.tenant}-gpt-config.zip`);
  const { names, read } = readZip(bytes);
  assert.deepEqual([...names].sort(), [
    'actions-setup.md',
    'instructions.md',
    'knowledge/method.md',
    'knowledge/publishing.md',
    'knowledge/voice.md',
  ]);
  // The knowledge files must actually carry the detail the instructions dropped.
  assert.ok(read('knowledge/voice.md').includes('Dr. Lurie — evidence-led skin health'));
  assert.ok(read('knowledge/voice.md').includes('miracle'));
  assert.ok(read('knowledge/method.md').includes('ceiling, not a target'));
  assert.ok(read('knowledge/publishing.md').includes('object_publish'));
});

test('the setup card names the import URL, the real OAuth endpoints and the empty scope', () => {
  const card = readZip(buildGptConfigZip(bundle).bytes).read('actions-setup.md');
  assert.ok(card.includes('https://drluriescience.netlify.app/api/plugin/openapi.json'));
  assert.ok(card.includes('/oauth/authorize'));
  assert.ok(card.includes('/oauth/token'));
  assert.ok(card.includes('/oauth/register'));
  assert.match(card, /Do not invent a scope/);
  assert.ok(card.includes('mcp?health=auth'));
  assert.match(card, /tool_not_in_plugin_charter/);
});

test('the GPT bundle carries no credential', () => {
  const text = buildGptConfigZip(bundle).bytes.toString('utf8');
  assert.ok(!/client_secret|PUBLISH_SECRET|MCP_HTTP_AUTH_TOKEN|Bearer\s+[A-Za-z0-9._-]{12,}/i.test(text));
});
