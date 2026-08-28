import '../../../../sites/drlurie/config/policy-bindings.js';
// mcp.ts and mcp-tool-handlers.ts are a real (documented, normally-safe)
// circular import: it only stays safe with mcp.ts as the entry, since its
// own top-level `_mcpInternal` object reads an mcp-tool-handlers.ts export
// eagerly, whereas mcp-tool-handlers.ts only ever reads mcp.ts's exports
// lazily inside function bodies. Import mcp.ts FIRST, ahead of
// mcp-tool-handlers.js below, so this test file never becomes the one place
// that flips which module starts the cycle.
import { toolError } from '../functions/mcp.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  ARTIFACT_BRIDGE_SCOPE_CACHE_TTL_MS,
  resolveArtifactBridgeScopeForJobWithStore,
  callResumeAgentArtifactJob,
} from './mcp-tool-handlers.js';
import type { IdempotencyBlobStore, ToolCallResponse } from './idempotency-store.js';

// ─── injected-store pattern (idempotency-store.test.ts's makeStore) ─────────
const makeStore = (): IdempotencyBlobStore & { blobs: Map<string, string> } => {
  const blobs = new Map<string, string>();
  return {
    blobs,
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      blobs.set(key, JSON.stringify(value));
      return { modified: true };
    },
  };
};

const okScope = (siteId: string, requestId: string) => ({ ok: true as const, scope: { siteId, requestId } });
const errScope = () => ({ ok: false as const, result: toolError('nope') });

describe('resolveArtifactBridgeScopeForJobWithStore (perf/drop-verify-hop-cache-scope, Change 2)', () => {
  it('a cache MISS calls the live resolver and caches a successful result', async () => {
    const store = makeStore();
    let liveCalls = 0;
    const resolveLive = async () => {
      liveCalls += 1;
      return okScope('site_drlurie', 'req_1');
    };

    const result = await resolveArtifactBridgeScopeForJobWithStore(
      store,
      resolveLive,
      'site_drlurie',
      'req_1',
      'job-1'
    );

    assert.strictEqual(liveCalls, 1);
    assert.deepStrictEqual(result, okScope('site_drlurie', 'req_1'));
    assert.strictEqual(store.blobs.size, 1, 'a successful live resolve must be cached');
  });

  it('a second poll for the SAME jobId does not re-invoke the live resolver (no re-check against object-store)', async () => {
    const store = makeStore();
    let liveCalls = 0;
    const resolveLive = async () => {
      liveCalls += 1;
      return okScope('site_drlurie', 'req_1');
    };

    const first = await resolveArtifactBridgeScopeForJobWithStore(store, resolveLive, 'site_drlurie', 'req_1', 'job-1');
    const second = await resolveArtifactBridgeScopeForJobWithStore(
      store,
      resolveLive,
      'site_drlurie',
      'req_1',
      'job-1'
    );

    assert.strictEqual(liveCalls, 1, 'the second poll must be served from the cache, not a fresh object-store check');
    assert.deepStrictEqual(second, first);
  });

  it('a poll for a DIFFERENT jobId resolves scope freshly (no cross-job cache bleed)', async () => {
    const store = makeStore();
    let liveCalls = 0;
    const resolveLive = async () => {
      liveCalls += 1;
      return okScope('site_drlurie', 'req_1');
    };

    await resolveArtifactBridgeScopeForJobWithStore(store, resolveLive, 'site_drlurie', 'req_1', 'job-1');
    await resolveArtifactBridgeScopeForJobWithStore(store, resolveLive, 'site_drlurie', 'req_1', 'job-2');

    assert.strictEqual(liveCalls, 2, "a different jobId must never reuse another job's cached scope");
  });

  it('a cached entry that does not match the CALLER-supplied siteId/requestId is never trusted — falls through live', async () => {
    const store = makeStore();
    let liveCalls = 0;
    const resolveLive = async () => {
      liveCalls += 1;
      return okScope('site_drlurie', 'req_1');
    };

    await resolveArtifactBridgeScopeForJobWithStore(store, resolveLive, 'site_drlurie', 'req_1', 'job-1');
    // Same jobId, but a caller now presenting a DIFFERENT requestId — must not
    // silently inherit the previously cached scope.
    const mismatched = await resolveArtifactBridgeScopeForJobWithStore(
      store,
      resolveLive,
      'site_drlurie',
      'req_2',
      'job-1'
    );

    assert.strictEqual(liveCalls, 2, 'a scope mismatch against the cache must re-run the live resolver');
    assert.deepStrictEqual(mismatched, okScope('site_drlurie', 'req_1'));
  });

  it('a FAILED live resolve is never cached — the next poll retries live rather than replaying a stale error', async () => {
    const store = makeStore();
    let liveCalls = 0;
    const resolveLive = async () => {
      liveCalls += 1;
      return liveCalls === 1 ? errScope() : okScope('site_drlurie', 'req_1');
    };

    const first = await resolveArtifactBridgeScopeForJobWithStore(store, resolveLive, 'site_drlurie', 'req_1', 'job-1');
    const second = await resolveArtifactBridgeScopeForJobWithStore(
      store,
      resolveLive,
      'site_drlurie',
      'req_1',
      'job-1'
    );

    assert.strictEqual(first.ok, false);
    assert.strictEqual(liveCalls, 2, 'a failed resolve must not poison the cache');
    assert.strictEqual(second.ok, true);
  });

  it("the cache TTL mirrors pdf-tool's 12-minute JOB_RUNNING_TIMEOUT_MS", () => {
    assert.strictEqual(ARTIFACT_BRIDGE_SCOPE_CACHE_TTL_MS, 12 * 60_000);
  });

  it('an expired cache entry is treated as a miss and re-resolved live', async () => {
    const store = makeStore();
    let liveCalls = 0;
    const resolveLive = async () => {
      liveCalls += 1;
      return okScope('site_drlurie', 'req_1');
    };

    // Seed an already-expired entry directly (expiresAtMs in the past).
    store.blobs.set(
      'cache:artifact-bridge-scope:job-1',
      JSON.stringify({ value: { siteId: 'site_drlurie', requestId: 'req_1' }, expiresAtMs: Date.now() - 1 })
    );

    const result = await resolveArtifactBridgeScopeForJobWithStore(
      store,
      resolveLive,
      'site_drlurie',
      'req_1',
      'job-1'
    );

    assert.strictEqual(liveCalls, 1, 'an expired entry must not short-circuit the live resolve');
    assert.deepStrictEqual(result, okScope('site_drlurie', 'req_1'));
  });
});

// W16-ish: resume_agent_artifact_job's tenant-facing bridge, mirroring
// get_agent_artifact_job_status's shape. These cover only the cheap,
// synchronous fail-fast checks (site_id/request_id/job_id/resume_token/
// approval_token) that run BEFORE resolveArtifactBridgeScopeForJob or any
// pdf-tool network call — everything past that needs a live object store and
// pdf-tool bridge, out of scope for a unit test here.
const call = async (input: Record<string, unknown>): Promise<ToolCallResponse> =>
  (await callResumeAgentArtifactJob({}, input)) as ToolCallResponse;

const errorText = (result: ToolCallResponse): string => (result.content as Array<{ text: string }>)[0].text;

describe('callResumeAgentArtifactJob — fail-fast input validation', () => {
  const validInput = {
    site_id: 'site_drlurie',
    request_id: 'req_1',
    job_id: 'job-1',
    resume_token: 'resume-token-abc',
    approval_token: 'approval-token-xyz',
  };

  it('requires site_id and request_id', async () => {
    const result = await call({ job_id: 'job-1' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent?.error_code, 'artifact_scope_required');
  });

  it('rejects a site_id that does not match this deployment', async () => {
    const result = await call({ ...validInput, site_id: 'site_someone_else' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent?.error_code, 'artifact_site_mismatch');
  });

  it('requires job_id', async () => {
    const { job_id: _jobId, ...rest } = validInput;
    const result = await call(rest);
    assert.strictEqual(result.isError, true);
    assert.match(errorText(result), /job_id is required/);
  });

  it('requires resume_token', async () => {
    const { resume_token: _resumeToken, ...rest } = validInput;
    const result = await call(rest);
    assert.strictEqual(result.isError, true);
    assert.match(errorText(result), /resume_token is required/);
  });

  it('requires approval_token', async () => {
    const { approval_token: _approvalToken, ...rest } = validInput;
    const result = await call(rest);
    assert.strictEqual(result.isError, true);
    assert.match(errorText(result), /approval_token is required/);
  });
});
