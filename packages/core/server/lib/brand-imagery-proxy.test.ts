import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRAND_IMAGERY_MAX_REFERENCES,
  proposeBrandImagery,
  validateBrandImageryProposeInput,
  type BrandImageryCmsAgentClient,
  type BrandImageryProposeInput,
  type BrandImageryProxyDeps,
} from './brand-imagery-proxy.js';

const VALID_BRAND_IMAGERY = {
  version: 1,
  medium: 'photograph',
  styleSentence: 'Clinical-clean skincare editorial photography.',
  palette: ['#2E5C42'],
  negative: ['no stock-photo gloss'],
  aspectRatios: { article_header: '3:2' },
  seedBase: 100001,
};

const validProposalBody = (overrides: Record<string, unknown> = {}) => ({
  artifact: 'brand_imagery_proposal.v1',
  mode: 'house',
  brandImagery: VALID_BRAND_IMAGERY,
  rationale: 'Matches the site\'s existing warm neutral palette.',
  sampleSubjects: ['a jar of moisturizer on a marble countertop'],
  confidence: 'high',
  label: 'Clinical clean',
  ...overrides,
});

/** A "stubbed CmsAgentClient" — satisfies the exact structural interface the
 *  real class and ctx.cmsAgent both expose (`callTool`), recording every call. */
const stubCmsAgent = (
  respond: (name: string, args: Record<string, unknown>) => { ok: true; data: unknown } | { ok: false; code: string; message: string }
): { client: BrandImageryCmsAgentClient; calls: Array<{ name: string; args: Record<string, unknown> }> } => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      callTool: async (name, args) => {
        calls.push({ name, args });
        return respond(name, args) as never;
      },
    },
  };
};

const baseDeps = (cmsAgent: BrandImageryCmsAgentClient, overrides: Partial<BrandImageryProxyDeps> = {}): BrandImageryProxyDeps => ({
  cmsAgent,
  resolveBlobUrl: (blobKey) => `https://site.example/img/${blobKey}`,
  ...overrides,
});

/**
 * REVIEW (brand-imagery wave): the SHAPE CMS-Agent's `node.execute` actually
 * returns — `{ execution: <WorkflowExecutionRecord>, executionId }` after
 * CmsAgentClient.callTool has stripped the MCP `{ok,data}` envelope
 * (CMS-Agent src/agent/workspace/nodeRuntime.ts's `executeNode`). The
 * proposal is the node's OUTPUT on that record, never the record itself.
 * Every stub below now speaks this shape; a bare proposal is still accepted
 * by the proxy, but is no longer what the happy path proves.
 */
const nodeExecuteResult = (
  proposal: unknown,
  overrides: { status?: string; errors?: string[]; withOutput?: boolean } = {}
): Record<string, unknown> => {
  const status = overrides.status ?? 'completed';
  const withOutput = overrides.withOutput !== false;
  return {
    executionId: 'exec_1',
    execution: {
      runId: 'run_1',
      workflowId: 'independent_node',
      projectId: 'workspace',
      status,
      nodes: [
        {
          nodeId: 'brand_imagery_writer',
          status,
          produces: ['brand_imagery_proposal.v1'],
          ...(withOutput ? { output: proposal } : {}),
          ...(overrides.errors ? { errors: overrides.errors } : {}),
        },
      ],
      artifacts: withOutput
        ? [{ id: 'artifact_1', nodeId: 'brand_imagery_writer', type: 'brand_imagery_proposal.v1', value: proposal }]
        : [],
      stageOutputs: withOutput ? { brand_imagery_writer: proposal } : {},
      errors: overrides.errors ?? [],
    },
  };
};

const baseInput = (overrides: Partial<BrandImageryProposeInput> = {}): BrandImageryProposeInput => ({
  projectId: 'proj_drlurie',
  mode: 'house',
  brief: 'Clinical-clean skincare, warm neutrals.',
  ...overrides,
});

test('proposeBrandImagery: happy path builds the writer input per §3.5 and returns the validated proposal', async () => {
  const { client, calls } = stubCmsAgent((name) =>
    name === 'visual_identity_propose'
      ? { ok: true, data: nodeExecuteResult(validProposalBody()) }
      : { ok: false, code: 'unexpected', message: 'unexpected tool' }
  );

  const result = await proposeBrandImagery(
    baseInput({
      references: [{ blobKey: 'image/site/mood-1.jpg', note: 'the palette, not the subject', weight: 0.8 }],
    }),
    baseDeps(client)
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.ok && result.body.brandImagery, VALID_BRAND_IMAGERY);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, 'visual_identity_propose');
  const writerInput = calls[0]?.args as Record<string, unknown>;
  assert.equal(writerInput.project_id, 'proj_drlurie');
  assert.equal(writerInput.kind, 'brand_imagery');
  assert.equal(writerInput.mode, 'house');
  assert.equal(writerInput.brief, 'Clinical-clean skincare, warm neutrals.');
  // references[] forwarded verbatim (materializer needs the moodboard as declared).
  assert.deepEqual(writerInput.references, [
    { blobKey: 'image/site/mood-1.jpg', note: 'the palette, not the subject', weight: 0.8 },
  ]);
  // imageRefs[] is the resolved, model-visible view — a bare blobKey (no region)
  // resolves to a fetchable URL, no bytes touched.
  assert.deepEqual(writerInput.imageRefs, [
    { url: 'https://site.example/img/image/site/mood-1.jpg', mediaType: 'image/jpeg', label: 'the palette, not the subject' },
  ]);
});

test('proposeBrandImagery: >8 references is rejected with 400 before any CmsAgent call', async () => {
  const { client, calls } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));

  const references = Array.from({ length: BRAND_IMAGERY_MAX_REFERENCES + 1 }, (_, i) => ({ blobKey: `image/site/ref-${i}.jpg` }));
  const result = await proposeBrandImagery(baseInput({ references }), baseDeps(client));

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 400);
  assert.equal(!result.ok && result.errorCode, 'brand_imagery_propose_too_many_references');
  assert.equal(calls.length, 0, 'must not call CmsAgent at all once the reference cap is exceeded');
});

test('validateBrandImageryProposeInput: exactly 8 references is allowed (the boundary, not off-by-one)', () => {
  const references = Array.from({ length: BRAND_IMAGERY_MAX_REFERENCES }, (_, i) => ({ blobKey: `image/site/ref-${i}.jpg` }));
  assert.equal(validateBrandImageryProposeInput(baseInput({ references })), undefined);
});

test('proposeBrandImagery: neither references nor brief is a 400', async () => {
  const { client, calls } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  const result = await proposeBrandImagery(baseInput({ brief: undefined }), baseDeps(client));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 400);
  assert.equal(!result.ok && result.errorCode, 'brand_imagery_propose_missing_input');
  assert.equal(calls.length, 0);
});

test('proposeBrandImagery: an invalid mode is a 400', async () => {
  const { client } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  const result = await proposeBrandImagery(baseInput({ mode: 'poster' as never }), baseDeps(client));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 400);
  assert.equal(!result.ok && result.errorCode, 'brand_imagery_propose_invalid_mode');
});

test('proposeBrandImagery: a reference with neither blobKey nor url is a 400', async () => {
  const { client } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  const result = await proposeBrandImagery(baseInput({ references: [{ note: 'no source at all' }] }), baseDeps(client));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 400);
  assert.equal(!result.ok && result.errorCode, 'brand_imagery_propose_invalid_reference');
});

test('proposeBrandImagery: a CmsAgent tool-call failure surfaces as 502', async () => {
  const { client } = stubCmsAgent(() => ({ ok: false, code: 'cms_agent_timeout', message: 'CMS-Agent did not respond in time.' }));
  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 502);
  assert.equal(!result.ok && result.errorCode, 'cms_agent_timeout');
  assert.equal(!result.ok && result.error, 'CMS-Agent did not respond in time.');
});

test('proposeBrandImagery: a proposal whose brandImagery fails brandImagerySchema is a 502 with the reason', async () => {
  const { client } = stubCmsAgent(() => ({
    ok: true,
    data: validProposalBody({ brandImagery: { ...VALID_BRAND_IMAGERY, palette: [] } }), // palette min(1) violated
  }));
  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 502);
  assert.equal(!result.ok && result.errorCode, 'brand_imagery_propose_invalid_proposal');
  assert.ok(!result.ok && result.error.includes('brandImagery'), `expected the reason to name the field: ${!result.ok && result.error}`);
  assert.ok(!result.ok && result.detail?.reason, 'expected a machine-readable reason in detail.reason');
});

test('proposeBrandImagery: a proposal missing a required envelope field (sampleSubjects) is a 502 with the reason', async () => {
  const { client } = stubCmsAgent(() => {
    const { sampleSubjects: _drop, ...rest } = validProposalBody();
    return { ok: true, data: rest };
  });
  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 502);
  assert.equal(!result.ok && result.errorCode, 'brand_imagery_propose_invalid_proposal');
  assert.ok(!result.ok && result.error.includes('sampleSubjects'), `expected the reason to name sampleSubjects: ${!result.ok && result.error}`);
});

test('proposeBrandImagery: a region reference is cropped to base64 via sharp when bytes are available', async () => {
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({
    create: { width: 100, height: 50, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();

  const { client } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  let readBlobBytesCalledWith: string | undefined;
  const result = await proposeBrandImagery(
    baseInput({
      references: [{ blobKey: 'image/site/mood-crop.png', region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }],
    }),
    baseDeps(client, {
      readBlobBytes: async (blobKey) => {
        readBlobBytesCalledWith = blobKey;
        return bytes;
      },
    })
  );

  assert.equal(result.ok, true);
  assert.equal(readBlobBytesCalledWith, 'image/site/mood-crop.png');
});

test('proposeBrandImagery: imageRefs carries base64 (not url) once a region is successfully cropped', async () => {
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({
    create: { width: 100, height: 50, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();

  const { client, calls } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  await proposeBrandImagery(
    baseInput({
      references: [{ blobKey: 'image/site/mood-crop.png', region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }],
    }),
    baseDeps(client, { readBlobBytes: async () => bytes })
  );

  const writerInput = calls[0]?.args as Record<string, unknown>;
  const imageRefs = writerInput.imageRefs as Array<Record<string, unknown>>;
  assert.equal(imageRefs.length, 1);
  assert.equal(typeof imageRefs[0]?.base64, 'string');
  assert.ok((imageRefs[0]?.base64 as string).length > 0);
  assert.equal(imageRefs[0]?.mediaType, 'image/png');
  assert.equal(imageRefs[0]?.url, undefined);
});

test('proposeBrandImagery: a region reference falls back to the whole-image URL when bytes are unavailable (no readBlobBytes wired)', async () => {
  const { client, calls } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  const result = await proposeBrandImagery(
    baseInput({
      references: [{ blobKey: 'image/site/mood-crop.jpg', region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }],
    }),
    baseDeps(client) // no readBlobBytes at all — e.g. the chat surface with no blob-store access
  );

  assert.equal(result.ok, true);
  const writerInput = calls[0]?.args as Record<string, unknown>;
  const imageRefs = writerInput.imageRefs as Array<Record<string, unknown>>;
  assert.deepEqual(imageRefs, [{ url: 'https://site.example/img/image/site/mood-crop.jpg', mediaType: 'image/jpeg' }]);
});

test('proposeBrandImagery: an unresolvable reference (unsupported extension, no region) is dropped from imageRefs and reported, never fails the call', async () => {
  const { client, calls } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  const result = await proposeBrandImagery(
    baseInput({ references: [{ blobKey: 'image/site/mood.bmp' }] }),
    baseDeps(client)
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.body.unresolvedReferences, [0]);
  const writerInput = calls[0]?.args as Record<string, unknown>;
  assert.equal(writerInput.imageRefs, undefined);
  // The raw reference is still forwarded verbatim for the materializer.
  assert.deepEqual(writerInput.references, [{ blobKey: 'image/site/mood.bmp' }]);
});

test('proposeBrandImagery: existingBrandImagery, visualStandardId, and templateSlug are forwarded when present', async () => {
  const { client, calls } = stubCmsAgent(() => ({ ok: true, data: validProposalBody({ mode: 'template' }) }));
  await proposeBrandImagery(
    baseInput({
      mode: 'template',
      templateSlug: 'seasonal-launch',
      visualStandardId: 'vis_drlurie_seasonal',
      existingBrandImagery: VALID_BRAND_IMAGERY,
      brief: 'A bolder seasonal variant.',
    }),
    baseDeps(client)
  );
  const writerInput = calls[0]?.args as Record<string, unknown>;
  assert.equal(writerInput.templateSlug, 'seasonal-launch');
  assert.equal(writerInput.visualStandardId, 'vis_drlurie_seasonal');
  assert.deepEqual(writerInput.existingBrandImagery, VALID_BRAND_IMAGERY);
});

// ─── REVIEW: the node.execute envelope (the shape the wire really carries) ──

test('REVIEW: the proposal is read off node.execute\'s execution record, not the envelope itself', async () => {
  const { client } = stubCmsAgent(() => ({ ok: true, data: nodeExecuteResult(validProposalBody()) }));
  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.ok && result.body.brandImagery, VALID_BRAND_IMAGERY);
  assert.equal(result.ok && result.body.artifact, 'brand_imagery_proposal.v1');
});

test('REVIEW: stageOutputs alone (no nodes[].output) still yields the proposal', async () => {
  const { client } = stubCmsAgent(() => ({
    ok: true,
    data: {
      executionId: 'exec_2',
      execution: {
        status: 'completed',
        nodes: [{ nodeId: 'brand_imagery_writer', status: 'completed' }],
        artifacts: [],
        stageOutputs: { brand_imagery_writer: validProposalBody() },
        errors: [],
      },
    },
  }));
  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('REVIEW: a failed node run is a 502 naming the run\'s own errors, not a schema mismatch', async () => {
  const { client } = stubCmsAgent(() => ({
    ok: true,
    data: nodeExecuteResult(undefined, { status: 'failed', errors: ['model_refused'], withOutput: false }),
  }));
  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 502);
  assert.equal(!result.ok && result.errorCode, 'brand_imagery_propose_node_failed');
  assert.ok(!result.ok && result.error.includes('model_refused'), !result.ok ? result.error : '');
});

test('REVIEW: a bare proposal (no execution record) is still accepted', async () => {
  const { client } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, true, JSON.stringify(result));
});

// ─── D1 fix (task A2): visual_identity_propose is the tool now, not node_execute ──

test('D1: proposeBrandImagery calls visual_identity_propose (never node_execute), sending project_id snake_case + kind', async () => {
  const { client, calls } = stubCmsAgent((name) =>
    name === 'visual_identity_propose'
      ? { ok: true, data: validProposalBody() }
      : { ok: false, code: 'unexpected', message: `unexpected tool: ${name}` }
  );
  const result = await proposeBrandImagery(baseInput({ projectId: 'proj_zilberman' }), baseDeps(client));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, 'visual_identity_propose');
  assert.equal(calls[0]?.args.project_id, 'proj_zilberman');
  assert.equal(calls[0]?.args.projectId, undefined, 'project_id must be snake_case on the wire, not camelCase');
  assert.equal(calls[0]?.args.kind, 'brand_imagery');
  assert.equal(calls[0]?.args.nodeId, undefined, 'the new tool takes fields directly, no {nodeId, input} wrapping');
  assert.equal(calls[0]?.args.input, undefined);
});

test("D1: visual_identity_propose's OWN envelope ({ proposal, executionId, nodeId }) is read directly, no execution record needed", async () => {
  const { client } = stubCmsAgent(() => ({
    ok: true,
    data: { proposal: validProposalBody(), executionId: 'exec_vip_1', nodeId: 'brand_imagery_writer' },
  }));
  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.ok && result.body.brandImagery, VALID_BRAND_IMAGERY);
});

test('D1: an older CMS-Agent still answering with the retired node.execute envelope shape is still accepted (kept, additive)', async () => {
  const { client, calls } = stubCmsAgent((name) =>
    name === 'visual_identity_propose'
      ? { ok: true, data: nodeExecuteResult(validProposalBody()) }
      : { ok: false, code: 'unexpected', message: 'unexpected tool' }
  );
  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.ok && result.body.brandImagery, VALID_BRAND_IMAGERY);
  assert.equal(calls[0]?.name, 'visual_identity_propose');
});

test('D1: an unrecognized-tool-name failure (CMS-Agent predates visual_identity_propose) gets its own errorCode', async () => {
  const { client } = stubCmsAgent(() => ({
    ok: false,
    code: 'cms_agent_error',
    message: 'Unknown tool: visual_identity_propose',
    fromJsonBody: true,
  }));
  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 502);
  assert.equal(!result.ok && result.errorCode, 'brand_imagery_propose_tool_not_allowed');
  assert.ok(!result.ok && result.error.includes('visual_identity_propose'), !result.ok ? result.error : '');
});

test('D1: a bad/expired credential (cms_agent_auth_failed, no fromJsonBody) stays on the generic path, never mislabeled tool_not_allowed', async () => {
  const { client } = stubCmsAgent(() => ({
    ok: false,
    code: 'cms_agent_auth_failed',
    message: 'CMS-Agent rejected the credential. The site token may be wrong, or scoped to a different project — the service returns the same response for both.',
    statusCode: 401,
  }));
  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 502);
  // Genuinely indistinguishable on the wire from "tool not in this bearer's allowlist" (see
  // looksLikeUnknownToolFailure's doc comment) — must NOT be relabeled brand_imagery_propose_tool_not_allowed.
  assert.equal(!result.ok && result.errorCode, 'cms_agent_auth_failed');
});

test('D1: a message merely containing "unknown tool" without fromJsonBody is NOT reclassified (fromJsonBody is the real signal, not the text)', async () => {
  const { client } = stubCmsAgent(() => ({
    ok: false,
    code: 'cms_agent_unreachable',
    message: 'network error, cannot tell if the tool is unknown tool or not',
  }));
  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.errorCode, 'cms_agent_unreachable');
});

test("proposeBrandImagery: forwards CMS-Agent's prefetch warnings so a thin proposal is visibly thin", async () => {
  // A degraded site prefetch means the writer never saw the site's palette or image-policy contexts.
  // The proposal is schema-valid either way, so without this the approval card cannot tell the two
  // apart. Non-string entries are dropped rather than trusted.
  const { client } = stubCmsAgent(() => ({
    ok: true,
    data: {
      proposal: validProposalBody(),
      executionId: 'exec_9',
      nodeId: 'brand_imagery_writer',
      warnings: ['site_prefetch_degraded:site_object_unreachable', 'voice_prefetch_fallback:voice_prefetch_unreachable', 42],
    },
  }));

  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && (result.body as { prefetchWarnings?: string[] }).prefetchWarnings, [
    'site_prefetch_degraded:site_object_unreachable',
    'voice_prefetch_fallback:voice_prefetch_unreachable',
  ]);
});

test('proposeBrandImagery: omits prefetchWarnings entirely when CMS-Agent reports none', async () => {
  const { client } = stubCmsAgent(() => ({ ok: true, data: { proposal: validProposalBody(), executionId: 'exec_10', nodeId: 'brand_imagery_writer' } }));
  const result = await proposeBrandImagery(baseInput(), baseDeps(client));
  assert.equal(result.ok, true);
  assert.ok(result.ok && !('prefetchWarnings' in result.body), 'an older CMS-Agent deploy sends no warnings field');
});

// ─── visual_standard_id hydration (live-defect fix, 2026-09-04) ────────────
//
// The live defect: `brand_imagery_propose { visual_standard_id: "vis_drlurie" }`
// alone failed with the GENERIC "requires at least one of references or
// brief" 400, even though `vis_drlurie`'s own record carries a mood board
// (`references[]`) and a current `brandImagery` -- the tool advertised
// `visual_standard_id` as "revise this existing standard" but never read
// what that standard held. These tests cover `hydrateFromVisualStandard`'s
// contract: caller-supplied fields always win (never merged with the
// standard's), a loader failure/absence never crashes and never over-claims
// "the standard has no board" (it falls through to the ordinary generic
// 400), and the reference cap still applies after hydration.

const standardReferences = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ blobKey: `image/req_smoke/ref-${i}.png`, note: `ref ${i}`, weight: 1 }));

test('proposeBrandImagery: visual_standard_id alone hydrates references + existingBrandImagery from the standard and succeeds', async () => {
  const { client, calls } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  const loadVisualStandard = async (visualStandardId: string) => {
    assert.equal(visualStandardId, 'vis_drlurie');
    return {
      references: [
        { blobKey: 'image/req_smoke_featured_20260702_01/d0c446a2.png', note: 'Featured-only smoke test hero image', weight: 1 },
      ],
      brandImagery: VALID_BRAND_IMAGERY,
    };
  };

  const result = await proposeBrandImagery(
    baseInput({ brief: undefined, visualStandardId: 'vis_drlurie' }),
    baseDeps(client, { loadVisualStandard })
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  const writerInput = calls[0]?.args as Record<string, unknown>;
  assert.deepEqual(writerInput.references, [
    { blobKey: 'image/req_smoke_featured_20260702_01/d0c446a2.png', note: 'Featured-only smoke test hero image', weight: 1 },
  ]);
  assert.deepEqual(writerInput.existingBrandImagery, VALID_BRAND_IMAGERY);
});

test("proposeBrandImagery: caller-supplied references win over the standard's and are not merged with them", async () => {
  const { client, calls } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  const callerReferences = [{ blobKey: 'image/caller/own-ref.png' }];
  const loadVisualStandard = async () => ({
    references: [{ blobKey: 'image/standard/board-ref.png' }],
  });

  const result = await proposeBrandImagery(
    baseInput({ brief: undefined, visualStandardId: 'vis_drlurie', references: callerReferences }),
    baseDeps(client, { loadVisualStandard })
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  const writerInput = calls[0]?.args as Record<string, unknown>;
  assert.deepEqual(writerInput.references, callerReferences, "the standard's reference must not appear at all -- no merge");
});

test("proposeBrandImagery: caller-supplied existing_brand_imagery wins over the standard's", async () => {
  const { client, calls } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  const callerExisting = { ...VALID_BRAND_IMAGERY, medium: 'photograph' };
  const loadVisualStandard = async () => ({
    references: [{ blobKey: 'image/standard/board-ref.png' }],
    brandImagery: { ...VALID_BRAND_IMAGERY, medium: 'digital_illustration' },
  });

  const result = await proposeBrandImagery(
    baseInput({ brief: undefined, visualStandardId: 'vis_drlurie', existingBrandImagery: callerExisting }),
    baseDeps(client, { loadVisualStandard })
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  const writerInput = calls[0]?.args as Record<string, unknown>;
  assert.deepEqual(writerInput.existingBrandImagery, callerExisting);
});

test('proposeBrandImagery: a standard with no references and no brief gets the standard-specific error code, not the generic one', async () => {
  const { client, calls } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  const loadVisualStandard = async () => ({ references: [] });

  const result = await proposeBrandImagery(
    baseInput({ brief: undefined, visualStandardId: 'vis_drlurie' }),
    baseDeps(client, { loadVisualStandard })
  );

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 400);
  assert.equal(!result.ok && result.errorCode, 'brand_imagery_propose_standard_has_no_board');
  assert.ok(!result.ok && result.error.includes('vis_drlurie'), `expected the message to name the standard: ${!result.ok && result.error}`);
  assert.equal(calls.length, 0, 'must not call CmsAgent once the standard is confirmed to carry no board');
});

test('proposeBrandImagery: a throwing loader does not crash the call and falls through to the ordinary missing-input 400', async () => {
  const { client, calls } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  const loadVisualStandard = async (): Promise<never> => {
    throw new Error('blob store unreachable');
  };

  const result = await proposeBrandImagery(
    baseInput({ brief: undefined, visualStandardId: 'vis_drlurie' }),
    baseDeps(client, { loadVisualStandard })
  );

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 400);
  assert.equal(
    !result.ok && result.errorCode,
    'brand_imagery_propose_missing_input',
    'a loader failure must NOT be reported as "standard has no board" -- that would be a claim we cannot back up'
  );
  assert.equal(calls.length, 0);
});

test('proposeBrandImagery: an undefined-resolving loader (standard not found) behaves the same as a throw -- the ordinary generic 400', async () => {
  const { client } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  const loadVisualStandard = async () => undefined;

  const result = await proposeBrandImagery(
    baseInput({ brief: undefined, visualStandardId: 'vis_missing' }),
    baseDeps(client, { loadVisualStandard })
  );

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.errorCode, 'brand_imagery_propose_missing_input');
});

test('proposeBrandImagery: no loader supplied at all is byte-identical to pre-fix behavior (regression guard for every existing caller)', async () => {
  const { client, calls } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));

  const result = await proposeBrandImagery(
    baseInput({ brief: undefined, visualStandardId: 'vis_drlurie' }),
    baseDeps(client) // no loadVisualStandard at all -- e.g. every caller/stub that predates this fix
  );

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 400);
  assert.equal(!result.ok && result.errorCode, 'brand_imagery_propose_missing_input');
  assert.equal(calls.length, 0);
});

test('proposeBrandImagery: the reference cap still holds after hydration -- a standard carrying more than the cap is truncated, not refused', async () => {
  const { client, calls } = stubCmsAgent(() => ({ ok: true, data: validProposalBody() }));
  const tooMany = standardReferences(BRAND_IMAGERY_MAX_REFERENCES + 3);
  const loadVisualStandard = async () => ({ references: tooMany });

  const result = await proposeBrandImagery(
    baseInput({ brief: undefined, visualStandardId: 'vis_drlurie' }),
    baseDeps(client, { loadVisualStandard })
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  const writerInput = calls[0]?.args as Record<string, unknown>;
  const references = writerInput.references as unknown[];
  assert.equal(references.length, BRAND_IMAGERY_MAX_REFERENCES, 'truncated to the cap, not refused');
  assert.deepEqual(references, tooMany.slice(0, BRAND_IMAGERY_MAX_REFERENCES));
});
