import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildObjectContract } from '../../packages/core/lib/registry/object-contract.js';
import { TOOL_DEFINITIONS_PART2 } from '../../packages/core/server/lib/mcp-tool-definitions-2.js';

test('authorized external chat clients are told to use the direct content_item publishing path', () => {
  const createTool = TOOL_DEFINITIONS_PART2.find((tool) => tool.name === 'object_create');
  assert.ok(createTool, 'object_create must stay exposed');
  assert.match(createTool.description, /two supported creation paths/i);
  assert.match(createTool.description, /authorized external publishing-plugin\/MCP clients/i);
  assert.match(createTool.description, /object_validate\(candidate body\).*object_create.*object_publish.*release_to_production/i);

  const sequence = buildObjectContract('content_item').workflow.sequence;
  assert.match(sequence[0], /CMS-Agent\/admin-chat plane/i);
  assert.match(sequence[0], /External MCP\/chat plane/i);
  assert.match(sequence[0], /Direct object_create\(content_item\) is refused only in the internal admin-chat registry/i);
  assert.ok(
    sequence.some(
      (step) => step.startsWith('object_create (') && step.includes('external MCP/chat plane')
    ),
    'content_item workflow must name direct object_create for the external chat plane'
  );
  assert.doesNotMatch(sequence[0], /DO NOT HAND-BUILD/);
});
