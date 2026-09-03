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
    name === 'node_execute'
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
  assert.equal(calls[0]?.name, 'node_execute');
  assert.equal(calls[0]?.args.nodeId, 'brand_imagery_writer');
  const writerInput = calls[0]?.args.input as Record<string, unknown>;
  assert.equal(writerInput.projectId, 'proj_drlurie');
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

  const writerInput = calls[0]?.args.input as Record<string, unknown>;
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
  const writerInput = calls[0]?.args.input as Record<string, unknown>;
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
  const writerInput = calls[0]?.args.input as Record<string, unknown>;
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
  const writerInput = calls[0]?.args.input as Record<string, unknown>;
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
