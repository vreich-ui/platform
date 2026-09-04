import '../../../../sites/drlurie/config/policy-bindings.js'; // tools.ts resolves site identity at import

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TOOL_GLOSSARY, describeTool, humanizeToolName } from './tool-glossary.js';
import { CHAT_TOOLS } from '../../server/lib/agent/tools.js';
import { MEMBERSHIP_TOOL_NAMES } from '../../server/lib/mcp-tool-definitions-membership.js';

/** Exactly the names the guardrails catalog serves (admin-governance.ts's
 *  `chatToolsCatalog`): CHAT_TOOLS plus the membership family. */
const CATALOG_NAMES = [...CHAT_TOOLS.map((tool) => tool.name), ...MEMBERSHIP_TOOL_NAMES];

describe('tool glossary', () => {
  it('has plain-language copy for EVERY tool the guardrails table renders', () => {
    const missing = CATALOG_NAMES.filter((name) => !TOOL_GLOSSARY[name]);
    assert.deepEqual(
      missing,
      [],
      `Guardrails would render these tools with no written explanation: ${missing.join(', ')}`
    );
  });

  it('never falls back to the anonymous "Tool action" row', () => {
    for (const name of CATALOG_NAMES) {
      const { label } = describeTool(name);
      assert.notEqual(label, 'Tool action', `${name} still renders as the anonymous row`);
      assert.doesNotMatch(label, /_/, `${name}'s label leaks the raw tool name`);
    }
  });

  it('gives every tool a hover sentence and a fuller modal explanation', () => {
    for (const name of CATALOG_NAMES) {
      const entry = TOOL_GLOSSARY[name]!;
      // The hover is a tooltip, not a place to read: one sentence, no jargon.
      assert.ok(entry.short.length > 20, `${name}'s hover text is too thin`);
      assert.ok(entry.short.length <= 160, `${name}'s hover text is too long for a tooltip`);
      assert.doesNotMatch(entry.short, /_/, `${name}'s hover text leaks a raw tool name`);
      // The modal is where consequences live, so it must say more than the hover.
      assert.ok(entry.detail.length > entry.short.length, `${name}'s modal adds nothing over the hover`);
      assert.notEqual(entry.detail, entry.short);
    }
  });

  it('resolves canonical registry names to the same copy as the chat name', () => {
    assert.equal(describeTool('object_patch').label, describeTool('patch').label);
    assert.equal(describeTool('site_apply_theme').label, describeTool('apply_theme').label);
    assert.equal(describeTool('list_artifacts_for_request').label, describeTool('search_artifacts').label);
  });

  it('degrades an unwritten tool to a readable name, never to "Tool action"', () => {
    assert.equal(humanizeToolName('check_workspace_run_readiness'), 'Check workspace run readiness');
    const unknown = describeTool('some_future_tool');
    assert.equal(unknown.label, 'Some future tool');
    assert.notEqual(unknown.label, 'Tool action');
  });
});
