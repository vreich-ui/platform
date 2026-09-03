import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { createLocalBlobStore, setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import { stubPdfToolMcp } from './pdf-tool-mcp-fetch-stub.js';

const REQUEST_ID = 'req_agent_simple_skincare_routine_id_choose_20260802_01';
const STORAGE_SECRET = 'storage-secret-never-expose';
const RUN_SECRET = 'run-secret-never-expose';
const PROOF_SECRET = 'proof-never-expose';
const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-pdf-tool-bridge');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

for (const key of [
  'NETLIFY',
  'NETLIFY_SITE_ID',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'SITE_ID',
  'MCP_HTTP_AUTH_TOKEN',
]) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';
process.env.PDF_TOOL_STORAGE_TOKEN = STORAGE_SECRET;
process.env.PDF_TOOL_STORAGE_SITE_ID = 'site-api-id';
process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool.test';
process.env.PDF_TOOL_AGENT_RUN_TOKEN = RUN_SECRET;

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

const rpc = async (name: string, args: Record<string, unknown>, logs: Array<Record<string, unknown>> = []) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    log: (payload) => logs.push(payload),
  });
  assert.equal(response.statusCode, 200);
  return { response, result: (JSON.parse(response.body) as { result: ToolResult }).result };
};

const resetAndSeedRequest = async () => {
  await rm(join(LOCAL_BLOBS_ROOT, 'site-objects'), { recursive: true, force: true });
  const created = await rpc('object_create', {
    object_type: 'content_item',
    site: 'site_drlurie',
    requested_id: REQUEST_ID,
    body: {
      slug: 'simple-skincare-routine-id-choose',
      title: 'The Simple Skincare Routine I’d Choose',
      nodes: [
        {
          id: 'n_start',
          kind: 'content',
          public: { title: 'Simple on purpose', body: 'A deliberately boring routine.' },
          visibility: 'public',
        },
      ],
    },
  });
  assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));
};

// W16 C4: seeds the site_drlurie singleton record directly into the same
// local site-objects store the MCP object verbs read from -- resetAndSeedRequest
// wipes that whole store, so this must be called AFTER it, per test. Written
// straight to the store (not via object_create) because the site body's real
// reference-integrity requirements (defaultNavigation, urls, ...) are
// irrelevant to a 'get' lookup, which never validates the body.
const seedSiteRecord = async (body: Record<string, unknown>) => {
  const store = createLocalBlobStore('site-objects');
  await store.setJSON(objectRecordKey('site', 'site_drlurie'), {
    object_id: 'site_drlurie',
    object_type: 'site',
    schema_version: 'site.v1',
    site: 'site_drlurie',
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    status: 'active',
    body,
    publication: { published_time: null },
    history: [],
    version: 1,
    content_revision: 1,
  });
};

const pendingArtifactJobRoute =
  (jobId: string) =>
  (body: Record<string, unknown>) => ({
    status: 202,
    body: {
      jobId,
      status: 'pending',
      projectId: body.projectId,
      requestId: body.requestId,
      artifactKind: body.artifactKind,
      polling: { tool: 'get_agent_artifact_job_status', input: { projectId: body.projectId } },
    },
  });

const referenceForSlot = (slot: string) => {
  const digit = slot.endsWith('1') ? 'a' : 'b';
  return {
    blobKey: `image/${REQUEST_ID}/${digit.repeat(64)}.webp`,
    sha256: digit.repeat(64),
    sizeBytes: 120000,
    contentType: 'image/webp',
    artifactKind: 'image',
    originalFilename: `${slot}.webp`,
  };
};

test('tools/list exposes the safe artifact bridge and omits the removed raw grant RPC', async () => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const tools = (JSON.parse(response.body) as { result: { tools: Array<{ name: string }> } }).result.tools;
  const names = new Set(tools.map((tool) => tool.name));
  assert.ok(names.has('create_agent_artifact_job'));
  assert.ok(names.has('get_agent_artifact_job_status'));
  assert.ok(names.has('get_agent_artifact_by_slot'));
  assert.ok(!names.has('get_pdf_tool_storage_grant'));
});

test('content-item contract directs agents to the Platform bridge without project or grant guessing', async () => {
  const response = await rpc('object_contract', { object_type: 'content_item' });
  assert.ok(!response.result.isError, JSON.stringify(response.result.structuredContent));
  const contract = response.result.structuredContent?.contract as {
    auxiliary_inputs: Array<{ how: string }>;
  };
  const instructions = contract.auxiliary_inputs.map((input) => input.how).join('\n');

  assert.match(instructions, /create_agent_artifact_job/);
  assert.match(instructions, /site_id \+.*request_id/);
  assert.match(instructions, /never guess projectId/);
  assert.doesNotMatch(instructions, /get_pdf_tool_storage_grant/);
});

test('Platform creates two Dr. Lurie WebP jobs, polls them, verifies both slots, and never exposes grants or proofs', async () => {
  await resetAndSeedRequest();
  const originalFetch = globalThis.fetch;
  const statusReads = new Map<string, number>();

  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: (body) => {
      const slot = String(body.slot);
      return {
        status: 202,
        body: {
          jobId: `job-${slot}`,
          status: 'pending',
          projectId: body.projectId,
          requestId: body.requestId,
          artifactKind: body.artifactKind,
          polling: { tool: 'get_agent_artifact_job_status', input: { projectId: body.projectId } },
        },
      };
    },
    get_agent_artifact_job_status: (body) => {
      const jobId = String(body.jobId);
      const slot = jobId.replace(/^job-/, '');
      const count = (statusReads.get(jobId) ?? 0) + 1;
      statusReads.set(jobId, count);
      return {
        body:
          count === 1
            ? { jobId, status: 'pending', projectId: body.projectId, requestId: REQUEST_ID, artifactKind: 'image' }
            : {
                jobId,
                status: 'complete',
                projectId: body.projectId,
                requestId: REQUEST_ID,
                artifactKind: 'image',
                artifactReference: referenceForSlot(slot),
                materializationProof: PROOF_SECRET,
              },
      };
    },
    get_agent_artifact_by_slot: (body) => ({
      body: { artifactReference: referenceForSlot(String(body.slot)), materializationProof: PROOF_SECRET },
    }),
    verify_agent_artifact: (body) => ({
      body: {
        verified: true,
        projectId: body.projectId,
        requestId: body.requestId,
        artifactReference: body.artifactReference,
        materializationProof: `${PROOF_SECRET}-rotated`,
      },
    }),
  });
  globalThis.fetch = fetchImpl;

  try {
    const logs: Array<Record<string, unknown>> = [];
    const wireResponses: string[] = [];
    const publicPaths: string[] = [];
    for (const slot of ['article_image_1', 'article_image_2']) {
      const created = await rpc(
        'create_agent_artifact_job',
        {
          site_id: 'site_drlurie',
          request_id: REQUEST_ID,
          artifact_kind: 'image',
          operation: 'generate',
          prompt: `Editorial skincare image ${slot}`,
          filename: `${slot}.webp`,
          slot,
          requirements: { maxBytes: 153600, image: { outputFormat: 'webp', size: '1536x1024' } },
          // This test walks the pending -> complete poll sequence explicitly
          // via separate get_agent_artifact_job_status calls below; opt out
          // of the create call's own inline wait (covered by
          // mcp-create-agent-artifact-job-inline-wait.test.ts) so it doesn't
          // consume one of the two scripted status reads itself.
          wait: false,
        },
        logs
      );
      wireResponses.push(created.response.body);
      assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));
      assert.equal(created.result.structuredContent?.projectId, 'dr-lurie');
      assert.deepEqual((created.result.structuredContent?.polling as { input: unknown }).input, {
        site_id: 'site_drlurie',
        request_id: REQUEST_ID,
        job_id: `job-${slot}`,
      });

      const pending = await rpc(
        'get_agent_artifact_job_status',
        { site_id: 'site_drlurie', request_id: REQUEST_ID, job_id: `job-${slot}` },
        logs
      );
      wireResponses.push(pending.response.body);
      assert.equal(pending.result.structuredContent?.status, 'pending');

      const complete = await rpc(
        'get_agent_artifact_job_status',
        { site_id: 'site_drlurie', request_id: REQUEST_ID, job_id: `job-${slot}` },
        logs
      );
      wireResponses.push(complete.response.body);
      assert.equal(complete.result.structuredContent?.status, 'complete');
      assert.equal(complete.result.structuredContent?.verified, true);
      assert.equal(
        complete.result.structuredContent?.public_path,
        `/img/${REQUEST_ID}/${referenceForSlot(slot).sha256}.webp`
      );
      publicPaths.push(String(complete.result.structuredContent?.public_path));

      const bySlot = await rpc(
        'get_agent_artifact_by_slot',
        { site_id: 'site_drlurie', request_id: REQUEST_ID, slot },
        logs
      );
      wireResponses.push(bySlot.response.body);
      assert.equal(bySlot.result.structuredContent?.verified, true);
      assert.equal(bySlot.result.structuredContent?.public_path, complete.result.structuredContent?.public_path);
    }

    assert.equal(
      calls.filter((call) => call.tool === 'create_agent_artifact_job').length,
      2,
      'polling must not recreate jobs'
    );
    assert.ok(
      calls.every((call) => call.path === '/.netlify/functions/mcp'),
      'every pdf-tool call must route through the single warm /mcp endpoint, not per-tool functions'
    );
    for (const call of calls) {
      assert.equal(call.authorization, `Bearer ${RUN_SECRET}`);
      assert.equal(call.body.projectId, 'dr-lurie');
      assert.equal((call.body.storage as { projectId: string }).projectId, 'dr-lurie');
      assert.equal((call.body.storage as { token: string }).token, STORAGE_SECRET);
    }

    // Simulate the draft-only acceptance step against the real governed object
    // verbs. pdf-tool owns these request-scoped index records in production;
    // the test writes the verified references into the isolated local index.
    const artifactIndex = createLocalBlobStore('artifact-index');
    for (const slot of ['article_image_1', 'article_image_2']) {
      const reference = referenceForSlot(slot);
      await artifactIndex.setJSON(
        `request-artifacts/${encodeURIComponent(REQUEST_ID)}/${reference.sha256}.json`,
        reference
      );
    }
    const before = await rpc('object_get', { object_type: 'content_item', object_id: REQUEST_ID });
    const beforeRecord = before.result.structuredContent?.record as { body: Record<string, unknown> };
    const checkout = await rpc('object_checkout', { object_type: 'content_item', object_id: REQUEST_ID });
    const candidatePatch = [
      {
        op: 'update_node',
        node_id: 'n_start',
        fields: {
          public: {
            images: publicPaths.map((src, index) => ({
              type: 'image',
              src,
              alt:
                index === 0 ? 'A simple skincare routine arranged for morning use' : 'A calm evening skincare routine',
            })),
          },
        },
      },
    ];
    const validatedCandidate = await rpc('object_validate', {
      object_type: 'content_item',
      object_id: REQUEST_ID,
      candidate_patch: candidatePatch,
    });
    assert.equal(validatedCandidate.result.structuredContent?.eligible, true);
    const patched = await rpc('object_patch', {
      object_type: 'content_item',
      object_id: REQUEST_ID,
      lock_token: checkout.result.structuredContent?.lockToken,
      expected_record_version: checkout.result.structuredContent?.record_version,
      ops: candidatePatch,
    });
    assert.ok(!patched.result.isError, JSON.stringify(patched.result.structuredContent));
    const after = await rpc('object_get', { object_type: 'content_item', object_id: REQUEST_ID });
    const afterRecord = after.result.structuredContent?.record as {
      body: Record<string, unknown>;
      publication: unknown;
    };
    assert.equal(afterRecord.body.slug, beforeRecord.body.slug);
    assert.equal(afterRecord.body.title, beforeRecord.body.title);
    assert.deepEqual(
      ((afterRecord.body.nodes as Array<{ public: { images?: Array<{ src: string }> } }>)[0].public.images ?? []).map(
        (image) => image.src
      ),
      publicPaths
    );
    const validatedDraft = await rpc('object_validate', { object_type: 'content_item', object_id: REQUEST_ID });
    assert.deepEqual((validatedDraft.result.structuredContent?.summary as { blockers: unknown[] }).blockers, []);
    assert.equal(
      (afterRecord.publication as { published_time?: unknown }).published_time,
      null,
      'test stops at validated draft and never publishes'
    );

    const visible = JSON.stringify({ logs, wireResponses });
    assert.ok(!visible.includes(STORAGE_SECRET));
    assert.ok(!visible.includes(RUN_SECRET));
    assert.ok(!visible.includes(PROOF_SECRET));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('site/request mismatches fail before pdf-tool is called', async () => {
  await resetAndSeedRequest();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ error: 'must not be reached' }, { status: 500 });
  }) as typeof fetch;
  try {
    const wrongSite = await rpc('create_agent_artifact_job', {
      site_id: 'site_other',
      request_id: REQUEST_ID,
      artifact_kind: 'image',
      filename: 'x.webp',
    });
    assert.equal(wrongSite.result.isError, true);
    assert.equal(wrongSite.result.structuredContent?.error_code, 'artifact_site_mismatch');

    const wrongRequest = await rpc('create_agent_artifact_job', {
      site_id: 'site_drlurie',
      request_id: 'req_agent_foreign_request_20260802_01',
      artifact_kind: 'image',
      filename: 'x.webp',
    });
    assert.equal(wrongRequest.result.isError, true);
    assert.equal(wrongRequest.result.structuredContent?.error_code, 'artifact_request_not_found');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('bridge redacts upstream error echoes of both service and storage credentials', async () => {
  await resetAndSeedRequest();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      { error: `upstream echoed ${RUN_SECRET} and ${STORAGE_SECRET}`, materializationProof: PROOF_SECRET },
      { status: 500 }
    )) as typeof fetch;
  try {
    const failed = await rpc('create_agent_artifact_job', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      artifact_kind: 'image',
      prompt: 'x',
      filename: 'x.webp',
      requirements: { image: { outputFormat: 'webp' } },
    });
    assert.equal(failed.result.isError, true);
    assert.ok(!failed.response.body.includes(RUN_SECRET));
    assert.ok(!failed.response.body.includes(STORAGE_SECRET));
    assert.ok(!failed.response.body.includes(PROOF_SECRET));
    assert.match(failed.response.body, /REDACTED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// W16 C4 (§4 vocabulary): server-side brand-aware image prompt assembly.
// A local replica of mcp-tool-handlers.ts's deterministic seed derivation --
// kept independent (not imported) so this test actually PROVES the wire
// value matches a from-scratch recomputation off seedBase, rather than just
// echoing whatever the handler happened to produce.
const SAFE_SEED_BOUND = 2 ** 31;
const fnv1aHash = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};
const expectedBrandSeed = (seedBase: number, requestId: string, slot: string, subject: string): number => {
  const offset = fnv1aHash(`${requestId}|${slot}|${subject}`) % SAFE_SEED_BOUND;
  return ((seedBase % SAFE_SEED_BOUND) + offset) % SAFE_SEED_BOUND;
};

const SEEDED_BRAND_IMAGERY = {
  version: 1,
  medium: 'photograph',
  styleSentence: 'Clinical-clean skincare editorial photography with soft studio light.',
  palette: ['#2E5C42', '#C2A878'],
  negative: ['no stock-photo gloss'],
  composition: { subjectScale: 'medium close-up', cropRule: 'rule of thirds' },
  aspectRatios: { article_header: '3:2' },
  seedBase: 100001,
  // A lora in the TEST's seeded brandImagery (not in the committed site
  // seeds, per the task brief) so wire forwarding is exercised here.
  lora: {
    url: 'https://cdn.example.com/lora/dr-lurie.safetensors',
    scale: 0.8,
    triggerPhrase: 'drlurie_style',
    version: 'v3',
    modelEndpoint: 'fal-ai/flux-2/klein/9b',
  },
};

test('brand-aware image generation: site brandImagery assembles the prompt/palette/composition/negatives, derives a stable seed, forwards the lora, and overrides agent-supplied generation controls', async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({ name: 'Dr. Lurié', brandImagery: SEEDED_BRAND_IMAGERY });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute('job-brand-1'),
  });
  globalThis.fetch = fetchImpl;

  const subject = 'A jar of moisturizer on a marble countertop';
  const requestArgs = {
    site_id: 'site_drlurie',
    request_id: REQUEST_ID,
    artifact_kind: 'image',
    operation: 'generate',
    prompt: subject,
    negative_prompt: 'no harsh shadows',
    seed: 999,
    loras: [{ path: 'https://agent.example.com/not-the-brand-lora.safetensors' }],
    filename: 'moisturizer-hero.webp',
    slot: 'article_image_1',
    wait: false,
  };

  try {
    const logs: Array<Record<string, unknown>> = [];
    const created = await rpc('create_agent_artifact_job', requestArgs, logs);
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

    const call = calls.find((entry) => entry.tool === 'create_agent_artifact_job');
    assert.ok(call);
    assert.equal(
      call!.body.prompt,
      'Clinical-clean skincare editorial photography with soft studio light. ' +
        'A jar of moisturizer on a marble countertop Palette: #2E5C42, #C2A878. medium close-up, rule of thirds.'
    );
    assert.equal(String(call!.body.prompt).startsWith(SEEDED_BRAND_IMAGERY.styleSentence), true);
    assert.match(String(call!.body.prompt), /Palette: #2E5C42, #C2A878\./);
    assert.equal(call!.body.negativePrompt, 'no stock-photo gloss, no harsh shadows');
    const expectedSeed = expectedBrandSeed(SEEDED_BRAND_IMAGERY.seedBase, REQUEST_ID, 'article_image_1', subject);
    assert.equal(call!.body.seed, expectedSeed);
    assert.deepEqual(call!.body.loras, [{ path: 'https://cdn.example.com/lora/dr-lurie.safetensors', scale: 0.8 }]);

    assert.deepEqual((created.result.structuredContent?.overriddenFields as string[]).slice().sort(), [
      'loras',
      'seed',
    ]);

    const assemblyLog = logs.find((entry) => entry.event === 'brand_prompt_assembled');
    assert.ok(assemblyLog);
    assert.equal(assemblyLog!.siteId, 'site_drlurie');
    assert.equal(assemblyLog!.requestId, REQUEST_ID);
    assert.equal(assemblyLog!.derivedSeedPresent, true);
    assert.deepEqual((assemblyLog!.overriddenFields as string[]).slice().sort(), ['loras', 'seed']);
    assert.ok(!JSON.stringify(assemblyLog).includes('marble countertop'), 'no prompt text in logs');

    // Determinism: an identical second call (same requestId/slot/subject)
    // derives the SAME seed -- no Date.now()/Math.random() in the path.
    const repeated = await rpc('create_agent_artifact_job', requestArgs, logs);
    assert.ok(!repeated.result.isError, JSON.stringify(repeated.result.structuredContent));
    const repeatedCall = calls.filter((entry) => entry.tool === 'create_agent_artifact_job')[1];
    assert.ok(repeatedCall);
    assert.equal(repeatedCall.body.seed, expectedSeed, 'the derived seed is stable across identical calls');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a site with brandTokens but no declared brandImagery derives a contract from its palette', async () => {
  await resetAndSeedRequest();
  // No brandImagery key -- but the site has a governed palette, so the bridge
  // derives a contract from it rather than generating with no identity.
  await seedSiteRecord({
    name: 'Dr. Lurié',
    brandTokens: {
      colors: { primary: 'rgb(0 150 136)', 'bg-page': '#FFFFFF' },
      fonts: { sans: 'system-ui, sans-serif', serif: 'Georgia, serif', heading: 'Georgia, serif' },
    },
  });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute('job-derived-1'),
  });
  globalThis.fetch = fetchImpl;

  const subject = 'A jar of moisturizer on a marble countertop';
  const requestArgs = {
    site_id: 'site_drlurie',
    request_id: REQUEST_ID,
    artifact_kind: 'image',
    operation: 'generate',
    prompt: subject,
    filename: 'moisturizer-hero.webp',
    slot: 'article_image_3',
    wait: false,
  };

  try {
    const logs: Array<Record<string, unknown>> = [];
    const created = await rpc('create_agent_artifact_job', requestArgs, logs);
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

    const call = calls.find((entry) => entry.tool === 'create_agent_artifact_job');
    assert.ok(call);
    const prompt = String(call!.body.prompt);
    // The agent's subject survives verbatim; a derived style contract wraps it.
    assert.ok(prompt.includes(subject), 'the agent subject is preserved');
    assert.match(prompt, /teal/, 'the palette hue is named in prose');
    assert.match(prompt, /Palette: #009688/, 'the exact hex is bound');
    assert.ok(prompt.startsWith('Cool'), 'a teal-led site derives a cool style sentence');
    assert.match(String(call!.body.negativePrompt), /watermarks/, 'baseline negatives apply');
    assert.equal(typeof call!.body.seed, 'number', 'a stable seed is derived');

    assert.equal(created.result.structuredContent?.brandImagerySource, 'derived');
    const assemblyLog = logs.find((entry) => entry.event === 'brand_prompt_assembled');
    assert.ok(assemblyLog);
    assert.equal(assemblyLog!.brandImagerySource, 'derived');

    // Determinism across identical calls, same as the declared path.
    const repeated = await rpc('create_agent_artifact_job', requestArgs, logs);
    assert.ok(!repeated.result.isError);
    const repeatedCall = calls.filter((entry) => entry.tool === 'create_agent_artifact_job')[1];
    assert.equal(repeatedCall!.body.seed, call!.body.seed, 'the derived seed is stable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a declared brandImagery block wins over the brandTokens-derived fallback', async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({
    name: 'Dr. Lurié',
    brandTokens: { colors: { primary: 'rgb(0 150 136)' }, fonts: { sans: 'x', serif: 'y', heading: 'y' } },
    brandImagery: SEEDED_BRAND_IMAGERY,
  });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute('job-declared-wins-1'),
  });
  globalThis.fetch = fetchImpl;

  try {
    const logs: Array<Record<string, unknown>> = [];
    const created = await rpc(
      'create_agent_artifact_job',
      {
        site_id: 'site_drlurie',
        request_id: REQUEST_ID,
        artifact_kind: 'image',
        operation: 'generate',
        prompt: 'A jar of moisturizer on a marble countertop',
        filename: 'moisturizer-hero.webp',
        slot: 'article_image_4',
        wait: false,
      },
      logs
    );
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

    const call = calls.find((entry) => entry.tool === 'create_agent_artifact_job');
    assert.ok(call);
    assert.equal(String(call!.body.prompt).startsWith(SEEDED_BRAND_IMAGERY.styleSentence), true);
    assert.match(String(call!.body.prompt), /Palette: #2E5C42, #C2A878\./, 'the declared palette is used');
    assert.ok(!String(call!.body.prompt).includes('#009688'), 'the derived palette is not mixed in');
    assert.equal(created.result.structuredContent?.brandImagerySource, 'declared');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('image generation on a site with neither brandImagery nor brandTokens passes prompt/negative/seed/loras through unchanged', async () => {
  await resetAndSeedRequest();
  // The site record exists (drift-safe: brandImagery removed/never set) and
  // carries no palette either -- nothing to derive from, so today's verbatim
  // passthrough still holds.
  await seedSiteRecord({ name: 'Dr. Lurié' });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute('job-passthrough-1'),
  });
  globalThis.fetch = fetchImpl;

  try {
    const logs: Array<Record<string, unknown>> = [];
    const created = await rpc(
      'create_agent_artifact_job',
      {
        site_id: 'site_drlurie',
        request_id: REQUEST_ID,
        artifact_kind: 'image',
        operation: 'generate',
        prompt: 'A jar of moisturizer on a marble countertop',
        negative_prompt: 'no harsh shadows',
        seed: 999,
        loras: [{ path: 'https://agent.example.com/lora.safetensors' }],
        filename: 'moisturizer-hero.webp',
        slot: 'article_image_2',
        wait: false,
      },
      logs
    );
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

    const call = calls.find((entry) => entry.tool === 'create_agent_artifact_job');
    assert.ok(call);
    assert.equal(call!.body.prompt, 'A jar of moisturizer on a marble countertop');
    assert.equal(call!.body.negativePrompt, 'no harsh shadows');
    assert.equal(call!.body.seed, 999);
    assert.deepEqual(call!.body.loras, [{ path: 'https://agent.example.com/lora.safetensors' }]);

    assert.equal(created.result.structuredContent?.overriddenFields, undefined);
    assert.ok(!logs.some((entry) => entry.event === 'brand_prompt_assembled'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('brand-aware assembly does not apply to non-image-generation job kinds (template PDF render, image edit)', async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({
    name: 'Dr. Lurié',
    brandImagery: {
      version: 1,
      medium: 'photograph',
      styleSentence: 'Clinical-clean skincare editorial photography.',
      palette: ['#2E5C42'],
      negative: ['no stock-photo gloss'],
      aspectRatios: { article_header: '3:2' },
      seedBase: 100001,
    },
  });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: (body) => pendingArtifactJobRoute(`job-${body.artifactKind}-${body.operation}`)(body),
  });
  globalThis.fetch = fetchImpl;

  try {
    const logs: Array<Record<string, unknown>> = [];

    // A template-driven PDF render: no prompt, brandImagery must never be
    // consulted for a non-image artifact kind.
    const pdfCreated = await rpc(
      'create_agent_artifact_job',
      {
        site_id: 'site_drlurie',
        request_id: REQUEST_ID,
        artifact_kind: 'pdf',
        template_id: 'tpl_some_template',
        data: { title: 'x' },
        filename: 'report.pdf',
        wait: false,
      },
      logs
    );
    assert.ok(!pdfCreated.result.isError, JSON.stringify(pdfCreated.result.structuredContent));
    const pdfCall = calls.find((entry) => entry.body.artifactKind === 'pdf');
    assert.ok(pdfCall);
    assert.equal(pdfCall!.body.negativePrompt, undefined);
    assert.equal(pdfCall!.body.seed, undefined);
    assert.equal(pdfCreated.result.structuredContent?.overriddenFields, undefined);

    // An image EDIT job (operation "edit", not "generate") must also pass
    // through untouched -- brandImagery applies to generation only.
    const editCreated = await rpc(
      'create_agent_artifact_job',
      {
        site_id: 'site_drlurie',
        request_id: REQUEST_ID,
        artifact_kind: 'image',
        operation: 'edit',
        seed: 111,
        filename: 'edited.webp',
        wait: false,
      },
      logs
    );
    assert.ok(!editCreated.result.isError, JSON.stringify(editCreated.result.structuredContent));
    const editCall = calls.find((entry) => entry.body.artifactKind === 'image' && entry.body.operation === 'edit');
    assert.ok(editCall);
    assert.equal(editCall!.body.seed, 111);
    assert.equal(editCreated.result.structuredContent?.overriddenFields, undefined);

    assert.ok(!logs.some((entry) => entry.event === 'brand_prompt_assembled'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── P4 (brand-imagery wave, BRIEF §3.4/§3.7): the `style` override channel,
// the guardrail, and the aspectRatio/usageContext requirements mapping. ─────

const seedGovernanceOverride = async (brandImageryOverrides: 'allow' | 'lock') => {
  const store = createLocalBlobStore('governance');
  await store.setJSON('overrides.v1', {
    schema_version: 'overrides.v1',
    brandImageryOverrides,
    updated_by: 'test@example.com',
    updated_at: '2026-09-01T00:00:00.000Z',
    history: [],
  });
};

const clearGovernanceOverride = () => seedGovernanceOverride('allow');

const seedVisualStandard = async (id: string, styleSentence: string) => {
  const created = await rpc('object_create', {
    object_type: 'visual_standard',
    site: 'site_drlurie',
    requested_id: id,
    body: {
      version: 1,
      kind: 'template',
      label: 'Editorial template',
      brandImagery: {
        version: 1,
        medium: 'photograph',
        styleSentence,
        palette: ['#112233'],
        negative: [],
        aspectRatios: { article_header: '1:1' },
        seedBase: 42,
      },
      references: [],
      sampleSubjects: ['a subject'],
      status: 'active',
    },
  });
  assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));
};

test('style.override is forwarded to pdf-tool verbatim and styleSource "override" is reported, merged over the site\'s own brandImagery', async () => {
  await resetAndSeedRequest();
  await clearGovernanceOverride();
  await seedSiteRecord({ name: 'Dr. Lurié', brandImagery: SEEDED_BRAND_IMAGERY });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute('job-style-override-1'),
  });
  globalThis.fetch = fetchImpl;

  try {
    const styleArg = { override: { styleSentence: 'A one-off editorial look for this job only.' }, note: 'seasonal' };
    const created = await rpc('create_agent_artifact_job', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      artifact_kind: 'image',
      operation: 'generate',
      prompt: 'A jar of moisturizer on a marble countertop',
      filename: 'moisturizer-hero.webp',
      slot: 'article_image_style_1',
      style: styleArg,
      wait: false,
    });
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

    const call = calls.find((entry) => entry.tool === 'create_agent_artifact_job');
    assert.ok(call);
    // Forwarded to pdf-tool verbatim -- pdf-tool stores/echoes it, never
    // resolves it itself.
    assert.deepEqual(call!.body.style, styleArg);
    // Platform's own resolution: the override's styleSentence, not the site's.
    assert.ok(String(call!.body.prompt).startsWith('A one-off editorial look for this job only.'));

    assert.equal(created.result.structuredContent?.styleSource, 'override');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('style.visualStandardId resolves the named visual_standard and wins over the site\'s own declared brandImagery; styleSource "visual_standard"', async () => {
  await resetAndSeedRequest();
  await clearGovernanceOverride();
  await seedSiteRecord({ name: 'Dr. Lurié', brandImagery: SEEDED_BRAND_IMAGERY });
  await seedVisualStandard('vis_drlurie_editorial', 'The named visual_standard\'s own style.');

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute('job-style-standard-1'),
  });
  globalThis.fetch = fetchImpl;

  try {
    const created = await rpc('create_agent_artifact_job', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      artifact_kind: 'image',
      operation: 'generate',
      prompt: 'A jar of moisturizer on a marble countertop',
      filename: 'moisturizer-hero.webp',
      slot: 'article_image_style_2',
      style: { visualStandardId: 'vis_drlurie_editorial' },
      wait: false,
    });
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

    const call = calls.find((entry) => entry.tool === 'create_agent_artifact_job');
    assert.ok(call);
    assert.ok(String(call!.body.prompt).startsWith('The named visual_standard\'s own style.'));
    assert.deepEqual(call!.body.style, { visualStandardId: 'vis_drlurie_editorial' });

    assert.equal(created.result.structuredContent?.styleSource, 'visual_standard');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('guardrail lock ignores the style channel entirely (never an error), reports it in overriddenFields, and styleSource is "site_locked"', async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({ name: 'Dr. Lurié', brandImagery: SEEDED_BRAND_IMAGERY });
  await seedGovernanceOverride('lock');

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute('job-style-locked-1'),
  });
  globalThis.fetch = fetchImpl;

  try {
    const created = await rpc('create_agent_artifact_job', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      artifact_kind: 'image',
      operation: 'generate',
      prompt: 'A jar of moisturizer on a marble countertop',
      filename: 'moisturizer-hero.webp',
      slot: 'article_image_style_3',
      style: { override: { styleSentence: 'Should never win.' } },
      wait: false,
    });
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

    const call = calls.find((entry) => entry.tool === 'create_agent_artifact_job');
    assert.ok(call);
    // The site's own declared brandImagery applies -- the override never wins.
    assert.ok(String(call!.body.prompt).startsWith(SEEDED_BRAND_IMAGERY.styleSentence));
    // Still forwarded to pdf-tool verbatim for its own record, even though
    // Platform ignored it.
    assert.deepEqual(call!.body.style, { override: { styleSentence: 'Should never win.' } });

    assert.equal(created.result.structuredContent?.styleSource, 'site_locked');
    assert.deepEqual(created.result.structuredContent?.overriddenFields, ['style']);
  } finally {
    globalThis.fetch = originalFetch;
    await clearGovernanceOverride();
  }
});

test('requirements.image.size is omitted, so aspectRatios[usageContext] maps to the nearest of the 5 allowed sizes', async () => {
  await resetAndSeedRequest();
  await clearGovernanceOverride();
  // article_header: '3:2' -> nearest allowed size is 1536x1024.
  await seedSiteRecord({ name: 'Dr. Lurié', brandImagery: SEEDED_BRAND_IMAGERY });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute('job-size-map-1'),
    get_image_model_policy: () => ({
      body: {
        policy: { byUsageContext: { article_header: { model: 'flux-2' } } },
        contexts: ['article_header', 'article_body'],
      },
    }),
  });
  globalThis.fetch = fetchImpl;

  try {
    const created = await rpc('create_agent_artifact_job', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      artifact_kind: 'image',
      operation: 'generate',
      prompt: 'A jar of moisturizer on a marble countertop',
      filename: 'moisturizer-hero.webp',
      slot: 'article_image_size_1',
      requirements: { image: { outputFormat: 'webp', usageContext: 'article_header' } },
      wait: false,
    });
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

    const call = calls.find((entry) => entry.tool === 'create_agent_artifact_job');
    assert.ok(call);
    const requirements = call!.body.requirements as {
      image?: { size?: string; usageContext?: string; outputFormat?: string };
    };
    assert.equal(requirements.image?.size, '1536x1024');
    assert.equal(requirements.image?.usageContext, 'article_header');
    assert.equal(requirements.image?.outputFormat, 'webp', 'other requirements.image fields survive untouched');
    assert.equal(created.result.structuredContent?.warnings, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an unrecognized requirements.image.usageContext is coerced to article_body and reported in warnings', async () => {
  await resetAndSeedRequest();
  await clearGovernanceOverride();
  await seedSiteRecord({ name: 'Dr. Lurié', brandImagery: SEEDED_BRAND_IMAGERY });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute('job-context-coerce-1'),
    get_image_model_policy: () => ({
      body: {
        policy: { byUsageContext: { article_header: { model: 'flux-2' } } },
        contexts: ['article_header', 'article_body'],
      },
    }),
  });
  globalThis.fetch = fetchImpl;

  try {
    const created = await rpc('create_agent_artifact_job', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      artifact_kind: 'image',
      operation: 'generate',
      prompt: 'A jar of moisturizer on a marble countertop',
      filename: 'moisturizer-hero.webp',
      slot: 'article_image_context_1',
      requirements: { image: { outputFormat: 'webp', usageContext: 'newsletter_hero' } },
      wait: false,
    });
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

    const call = calls.find((entry) => entry.tool === 'create_agent_artifact_job');
    assert.ok(call);
    const requirements = call!.body.requirements as { image?: { usageContext?: string } };
    assert.equal(requirements.image?.usageContext, 'article_body');
    assert.deepEqual(created.result.structuredContent?.warnings, ['usage_context_not_in_policy:newsletter_hero']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── REVIEW (brand-imagery wave) ────────────────────────────────────────────
//
// Every P4 style/warnings test above passes `wait: false`, so none of them
// ever reached the COMPLETED inline-wait path — the default one, and the one
// the tool's own description tells agents to expect ("a SINGLE completing
// create call may come back with the terminal artifactReference"). On that
// path `...safeStatus` (pdf-tool's echo) is spread AFTER the create call's
// own payload, so pdf-tool's best-effort styleSource overwrote Platform's
// resolved one and Platform's warnings were dropped.

const completingArtifactJobStub = (jobId: string, extraStatusFields: Record<string, unknown> = {}) => ({
  create_agent_artifact_job: (body: Record<string, unknown>) => ({
    status: 202,
    body: {
      jobId,
      status: 'pending',
      projectId: body.projectId,
      requestId: body.requestId,
      artifactKind: body.artifactKind,
      polling: { tool: 'get_agent_artifact_job_status', input: { projectId: body.projectId } },
    },
  }),
  get_agent_artifact_job_status: (body: Record<string, unknown>) => ({
    body: {
      jobId,
      status: 'complete',
      projectId: body.projectId,
      requestId: REQUEST_ID,
      artifactKind: 'image',
      artifactReference: referenceForSlot('article_image_1'),
      materializationProof: PROOF_SECRET,
      ...extraStatusFields,
    },
  }),
  verify_agent_artifact: (body: Record<string, unknown>) => ({
    body: {
      verified: true,
      projectId: body.projectId,
      requestId: body.requestId,
      artifactReference: body.artifactReference,
      materializationProof: `${PROOF_SECRET}-rotated`,
    },
  }),
});

test('a COMPLETING inline job still reports Platform’s styleSource and warnings, not pdf-tool’s echo', async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({ name: 'Dr. Lurié', brandImagery: SEEDED_BRAND_IMAGERY });
  await seedGovernanceOverride('lock');

  const originalFetch = globalThis.fetch;
  const { fetchImpl } = stubPdfToolMcp({
    ...completingArtifactJobStub('job-style-completing-1', {
      // Exactly what pdf-tool really echoes (agent-artifact-mcp.ts's
      // styleResponseFields / deriveLocalStyleSource) plus a render warning.
      styleSource: 'override',
      warnings: ['pdf_tool_render_warning'],
    }),
    get_image_model_policy: () => ({
      body: { policy: { byUsageContext: {} }, contexts: ['article_header', 'article_body'] },
    }),
  });
  globalThis.fetch = fetchImpl;

  try {
    const created = await rpc('create_agent_artifact_job', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      artifact_kind: 'image',
      operation: 'generate',
      prompt: 'A jar of moisturizer on a marble countertop',
      filename: 'moisturizer-hero.webp',
      slot: 'article_image_1',
      requirements: { image: { usageContext: 'newsletter_hero' } },
      style: { override: { styleSentence: 'Should never win.' } },
      // The DEFAULT — this is the path that was untested.
    });
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));
    const body = created.result.structuredContent!;
    assert.equal(body.verified, true, 'the job completed inline — this is the terminal-merge path');

    assert.equal(body.styleSource, 'site_locked', "pdf-tool's best-effort styleSource must not overwrite Platform's");
    assert.deepEqual(body.overriddenFields, ['style']);
    // Platform's warning survives, and pdf-tool's is kept rather than replaced.
    assert.deepEqual(body.warnings, ['usage_context_not_in_policy:newsletter_hero', 'pdf_tool_render_warning']);
  } finally {
    globalThis.fetch = originalFetch;
    await clearGovernanceOverride();
  }
});

// X1's example generator invents its own `req_visimg_*` request id — there is
// no content_item that owns a visual standard's preview images — so
// `resolveArtifactBridgeScope` refused every example job with
// `artifact_request_not_found`, and the persist step then asked for a second
// checkout on an object whose lock the triggering `object_patch` was still
// holding (423). Between them, not one example was ever written by any
// trigger. This drives the whole path through the real MCP surface.
test('an object_patch on a visual_standard writes the generated examples back, under the caller’s own lock', async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({ name: 'Dr. Lurié', brandImagery: SEEDED_BRAND_IMAGERY });
  await clearGovernanceOverride();

  const standardId = 'vis_drlurie_examples';
  const brandImagery = {
    version: 1,
    medium: 'photograph',
    styleSentence: 'Example-standard style.',
    palette: ['#123456'],
    negative: [],
    aspectRatios: { article_header: '3:2' },
    seedBase: 7,
  };
  // Born a DRAFT with no sampleSubjects, so `object_create` plans no jobs
  // (`no_sample_subjects`) and the patch below is the only trigger under test.
  const created = await rpc('object_create', {
    object_type: 'visual_standard',
    site: 'site_drlurie',
    requested_id: standardId,
    body: {
      version: 1,
      kind: 'template',
      label: 'Examples template',
      brandImagery,
      references: [],
      sampleSubjects: [],
      status: 'draft',
    },
  });
  assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

  const originalFetch = globalThis.fetch;
  const jobRequestIds: string[] = [];
  const { fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: (body) => {
      const requestId = String(body.requestId);
      jobRequestIds.push(requestId);
      return {
        status: 202,
        body: {
          jobId: `job-${requestId}`,
          status: 'pending',
          projectId: body.projectId,
          requestId,
          artifactKind: body.artifactKind,
          polling: { tool: 'get_agent_artifact_job_status', input: { projectId: body.projectId } },
        },
      };
    },
    get_agent_artifact_job_status: (body) => {
      const requestId = String(body.jobId).replace(/^job-/, '');
      const sha = 'c'.repeat(64);
      return {
        body: {
          jobId: body.jobId,
          status: 'complete',
          projectId: body.projectId,
          requestId,
          artifactKind: 'image',
          artifactReference: {
            blobKey: `image/${requestId}/${sha}.png`,
            sha256: sha,
            sizeBytes: 4096,
            contentType: 'image/png',
            artifactKind: 'image',
            originalFilename: 'example.png',
          },
          materializationProof: PROOF_SECRET,
        },
      };
    },
    verify_agent_artifact: (body) => ({
      body: {
        verified: true,
        projectId: body.projectId,
        requestId: body.requestId,
        artifactReference: body.artifactReference,
        materializationProof: `${PROOF_SECRET}-rotated`,
      },
    }),
    get_image_model_policy: () => ({ body: { policy: { byUsageContext: {} }, contexts: [] } }),
  });
  globalThis.fetch = fetchImpl;

  try {
    const checkout = await rpc('object_checkout', { object_type: 'visual_standard', object_id: standardId });
    const lockToken = checkout.result.structuredContent?.lockToken as string;
    assert.ok(lockToken, JSON.stringify(checkout.result.structuredContent));

    const patched = await rpc('object_patch', {
      object_type: 'visual_standard',
      object_id: standardId,
      lock_token: lockToken,
      expected_record_version: checkout.result.structuredContent?.record_version,
      ops: [
        {
          op: 'set_visual_standard_fields',
          fields: { sampleSubjects: ['a person reading at a small table'], status: 'active' },
        },
      ],
    });
    assert.ok(!patched.result.isError, JSON.stringify(patched.result.structuredContent));

    // The lock is STILL held here — check-in is a separate call — which is
    // exactly the state the generator has to write in.
    assert.equal(jobRequestIds.length, 1, 'one sampleSubject → one example job actually reached pdf-tool');
    assert.match(jobRequestIds[0]!, /^req_visimg_vis_drlurie_examples_article_header_\d{8}_\d{2}$/);

    const read = await rpc('object_get', { object_type: 'visual_standard', object_id: standardId });
    const body = (read.result.structuredContent?.record as { body: Record<string, unknown> }).body;
    const examples = body.examples as Array<{ usageContext: string; blobKey: string; contractHash: string }>;
    assert.equal(examples?.length, 1, 'the generated example must be persisted, not silently dropped');
    assert.equal(examples[0]!.usageContext, 'article_header');
    assert.match(examples[0]!.blobKey, /^image\/req_visimg_vis_drlurie_examples_article_header_/);
    assert.equal(examples[0]!.contractHash.length, 64);

    await rpc('object_checkin', { object_type: 'visual_standard', object_id: standardId, lock_token: lockToken });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
