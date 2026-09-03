/**
 * The admin chat lambdas are a SECOND entry point into mcp.ts, whose sibling
 * handlers are module state injected once per site. Before this wiring, the
 * first operational tool a chat run executed (create_agent_artifact_job's
 * brand-imagery site lookup) threw "MCP server not configured".
 */
import '../../../../../sites/drlurie/config/policy-bindings.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isMcpConfigured } from '../../functions/mcp.js';
import { ensureMcpSiblings } from './mcp-siblings.js';
import { drlurieSiteBinding } from '../../../../../sites/drlurie/config/site-binding.js';

describe('chat lambdas inject mcp.ts siblings', () => {
  it('configures the trio from the caller-supplied binding, then short-circuits', () => {
    ensureMcpSiblings(drlurieSiteBinding);
    assert.equal(isMcpConfigured(), true);
    // Idempotent: a warm instance re-entering the handler must not rebuild or
    // clobber (a real MCP shim may have injected a richer set).
    ensureMcpSiblings(drlurieSiteBinding);
    assert.equal(isMcpConfigured(), true);
  });

  it('objectStoreHandler is reachable — the exact call create_agent_artifact_job made when it failed', async () => {
    ensureMcpSiblings(drlurieSiteBinding);
    const { objectStoreHandler } = await import('../../functions/mcp.js');
    // Not asserting the RESULT (no blob store in a unit test) — only that the
    // sibling lookup itself no longer throws "MCP server not configured".
    await assert.doesNotReject(
      Promise.resolve()
        .then(() => objectStoreHandler({ httpMethod: 'POST', headers: {}, body: '{}' }))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.doesNotMatch(message, /MCP server not configured/);
        })
    );
  });
});
