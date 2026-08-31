import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { visibleToolDefinitions } from '../../netlify/functions/mcp.js';

/**
 * W1.0 — before this, `object_patch` and `object_publish` carried NO attribution
 * argument, so every article a chat-app plugin wrote landed its patch and its
 * publish as `unattributed-agent` (object-store.ts agentPrincipal fallback) and
 * the ledger could not answer "who published this".
 */
const inputSchemaFor = (name: string) => {
  const tool = visibleToolDefinitions().find((t) => t.name === name);
  assert.ok(tool, `${name} is not on the tool surface`);
  return tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
};

for (const name of ['object_patch', 'object_publish']) {
  test(`${name} accepts agent_name so its history entry is attributable`, () => {
    const schema = inputSchemaFor(name);
    assert.ok(schema.properties, `${name} declares no properties`);
    assert.ok('agent_name' in (schema.properties ?? {}), `${name} still carries no agent_name`);
  });

  test(`${name} does not make agent_name required — attribution is not authentication`, () => {
    const schema = inputSchemaFor(name);
    assert.ok(!(schema.required ?? []).includes('agent_name'), `${name} must not require agent_name`);
  });
}

test('object_publish still carries producer, the publish-history attribution seam', () => {
  const schema = inputSchemaFor('object_publish');
  const producer = (schema.properties ?? {}).producer as { required?: string[] } | undefined;
  assert.ok(producer, 'object_publish lost its producer field');
  assert.deepEqual(producer.required, ['run_id', 'node_id', 'prompt_version', 'model']);
});
