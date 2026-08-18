/**
 * W6 §2 (CMS-Agent WORK-ORDER-2026-08-12, Wolf's standing ruling): the client
 * contract must DECLARE the aggression ceiling. CMS-Agent's contractReduction
 * reads `pick(record, ["aggression_ceiling", "aggressionCeiling"])` off the
 * `object_contract` response record; before this it warned
 * `aggression_ceiling_missing` on every run because no platform contract
 * carried it. These tests exercise the real MCP handler on the drlurie site
 * config (registered via policy-bindings) end-to-end, and the pure builder.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // register the drlurie site providers
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { AGGRESSION_CEILING_DIALS, type AggressionCeiling } from '../../packages/core/lib/site-identity.js';
import {
  buildObjectContract,
  OBJECT_CONTRACT_TYPES,
  type ObjectContract,
} from '../../packages/core/lib/registry/object-contract.js';

for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID', 'MCP_HTTP_AUTH_TOKEN']) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';

const DRLURIE_CEILING: AggressionCeiling = {
  claim_strength: 0.45,
  urgency: 0.1,
  emotional_agitation: 0.15,
  cta_density: 0.2,
};

type ToolCallResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.statusCode, 200);
  return (JSON.parse(response.body) as { result: ToolCallResult }).result;
};

const assertValidCeiling = (ceiling: unknown, label: string): AggressionCeiling => {
  assert.ok(ceiling && typeof ceiling === 'object', `${label}: aggression_ceiling must be an object`);
  const record = ceiling as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), [...AGGRESSION_CEILING_DIALS].sort(), `${label}: exactly the four dials`);
  for (const dial of AGGRESSION_CEILING_DIALS) {
    const value = record[dial];
    assert.equal(typeof value, 'number', `${label}.${dial} is a number`);
    assert.ok(Number.isFinite(value as number) && (value as number) >= 0 && (value as number) <= 1, `${label}.${dial} in [0,1]`);
  }
  return record as AggressionCeiling;
};

test('object_contract(content_item) via the MCP handler carries aggression_ceiling with the four dials (drlurie site config)', async () => {
  const res = await callTool('object_contract', { object_type: 'content_item' });
  assert.ok(!res.isError, JSON.stringify(res.structuredContent));
  const contract = res.structuredContent?.contract as ObjectContract;
  assert.equal(contract.object_type, 'content_item');

  // JSON path 1: contract.aggression_ceiling (sibling of publish_policy)
  const top = assertValidCeiling(contract.aggression_ceiling, 'contract.aggression_ceiling');
  assert.deepEqual(top, DRLURIE_CEILING);

  // JSON path 2: contract.publish_policy.aggression_ceiling (mirror)
  const mirrored = assertValidCeiling(
    contract.publish_policy.aggression_ceiling,
    'contract.publish_policy.aggression_ceiling'
  );
  assert.deepEqual(mirrored, top);
});

test('the pure builder emits the ceiling for content_item and for no other object type', () => {
  for (const type of OBJECT_CONTRACT_TYPES) {
    const contract = buildObjectContract(type);
    if (type === 'content_item') {
      assert.deepEqual(contract.aggression_ceiling, DRLURIE_CEILING);
      assert.deepEqual(contract.publish_policy.aggression_ceiling, DRLURIE_CEILING);
    } else {
      assert.equal(contract.aggression_ceiling, undefined, `${type} must not carry aggression_ceiling`);
      assert.equal(contract.publish_policy.aggression_ceiling, undefined, `${type}.publish_policy must not carry it`);
    }
  }
});

test('an explicit ceiling override is validated: out-of-range / non-finite dials are refused', () => {
  const ok = { claim_strength: 0.9, urgency: 0.5, emotional_agitation: 0, cta_density: 1 };
  assert.deepEqual(buildObjectContract('content_item', { aggressionCeiling: ok }).aggression_ceiling, ok);
  assert.throws(
    () => buildObjectContract('content_item', { aggressionCeiling: { ...ok, urgency: 1.01 } }),
    /Invalid aggressionCeiling[\s\S]*urgency/
  );
  assert.throws(
    () => buildObjectContract('content_item', { aggressionCeiling: { ...ok, cta_density: Number.POSITIVE_INFINITY } }),
    /Invalid aggressionCeiling[\s\S]*cta_density/
  );
});
