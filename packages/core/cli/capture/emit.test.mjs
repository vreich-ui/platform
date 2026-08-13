import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildDryRunReport, buildEmissionPlan, captureRequestId, createMcpTransport, EmissionError, executeEmission } from './emit.mjs';

async function fixture(name) {
  const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  return JSON.parse(await readFile(path.join(directory, name), 'utf8'));
}

async function fixturePlan(target = 'fixture-target') {
  return buildEmissionPlan({
    target,
    mapping: await fixture('zilberman.mapping.v1.redacted.json'),
    theme: await fixture('zilberman.theme.v1.json'),
  });
}

test('fixture dry-run plan is deterministic, complete, and has no transport side effect', async () => {
  const plan = await fixturePlan();
  const golden = await fixture('zilberman.emission-plan.v1.golden.json');
  assert.deepEqual(
    {
      schemaVersion: plan.schemaVersion,
      target: plan.target,
      repeatThreshold: plan.repeatThreshold,
      createKinds: plan.creates.map((item) => item.kind),
      createIds: plan.creates.map((item) => item.requestedId),
      preflightVerbs: plan.preflight.map((item) => item.verb ?? `resolver:${item.resolver}`),
      mediaCount: plan.media.length,
      gapCount: plan.gaps.length,
    },
    golden
  );
  assert.deepEqual(buildDryRunReport(plan), await fixture('zilberman.emission-run-report.v1.golden.json'));
  assert.ok(plan.creates.every((item) => item.idempotencyKey.startsWith('t12.4:fixture-target:')));
  assert.ok(plan.creates.every((item) => item.body));
  assert.deepEqual(plan.forbiddenVerbs, ['deploy', 'object_publish', 'release_to_production', 'trigger_netlify_build']);
});

// The canonical CMS-Agent ProjectSummary envelope: projectId + capturePolicy.
function projectPolicy(target = 'fixture-target', rights = { content: 'retain_allowed_origin_content', media: 'prohibited' }) {
  return { project: { projectId: target, capturePolicy: { rights } } };
}

function mockTransport({ createFailure, pageRoute = null, pageRouteInDetail = false, recipeSummary = null } = {}) {
  const calls = [];
  let failed = false;
  let ordinal = 0;
  return {
    calls,
    async call(verb, args) {
      calls.push({ verb, args: structuredClone(args) });
      if (verb === 'object_contract') return { contract: { creation_policy: { humans: 'always_allowed', agents: 'open' } } };
      if (verb === 'object_inventory' && args.object_type === 'site') return { objects: [{ object_id: 'site_fixture', object_type: 'site', status: 'active' }] };
      if (verb === 'object_inventory' && args.object_type === 'page')
        return { objects: pageRoute ? [{ object_id: 'page_existing', object_type: 'page', status: 'active', ...(pageRouteInDetail ? {} : { route: pageRoute }) }] : [] };
      if (verb === 'object_inventory' && args.object_type === 'section_template') return { objects: recipeSummary ? [{ recipe_summary: { name: recipeSummary } }] : [] };
      if (verb === 'object_inventory') return { objects: [] };
      if (verb === 'object_validate') return { summary: { eligible: true, blockers: [], warnings: [] } };
      if (verb === 'object_get' && args.object_type === 'page' && args.object_id === 'page_existing')
        return { record: { object_id: 'page_existing', body: { route: pageRoute } } };
      if (verb === 'create_artifact_from_url') return { artifact: { blobKey: `${args.artifactKind}/${args.requestId}/fixture.bin`, portable: false } };
      if (verb === 'object_create') {
        if (createFailure && !failed) {
          failed = true;
          const error = new Error('upstream timeout');
          error.status = 502;
          throw error;
        }
        ordinal += 1;
        return { record: { object_id: args.requested_id, status: 'active', publication: { published_time: null }, ordinal } };
      }
      throw new Error(`unexpected verb ${verb}`);
    },
  };
}

test('live emission binds exactly to the named project and orders all governed calls', async () => {
  const plan = await fixturePlan();
  const mapping = await fixture('zilberman.mapping.v1.redacted.json');
  const transport = mockTransport();
  const resolverCalls = [];
  const report = await executeEmission({ plan, mapping, transport, projectPolicyResolver: async (target) => { resolverCalls.push(target); return projectPolicy(target); } });
  assert.deepEqual(resolverCalls, ['fixture-target']);
  assert.equal(transport.calls[0].verb, 'object_inventory');
  assert.deepEqual(transport.calls[0].args, { object_type: 'site', status: 'active' });
  assert.deepEqual(transport.calls.slice(1, 5).map((call) => call.verb), [
    'object_contract', 'object_contract', 'object_contract', 'object_contract',
  ]);
  assert.equal(report.siteId, 'site_fixture');
  assert.equal(report.copyPolicy.mode, 'keep_extracted');
  assert.equal(report.createdObjects.length, plan.creates.length);
  assert.ok(report.createdObjects.every((item) => item.published_time === null));
  assert.ok(report.trace.every((item) => !['object_publish', 'release_to_production', 'trigger_netlify_build', 'deploy'].includes(item.verb)));
  const firstCreate = transport.calls.findIndex((call) => call.verb === 'object_create');
  assert.equal(transport.calls[firstCreate - 1].verb, 'object_validate');
  assert.equal(transport.calls[firstCreate - 1].args.requested_id, transport.calls[firstCreate].args.requested_id);
  assert.equal(transport.calls[firstCreate + 1].verb, 'object_validate');
  assert.ok(transport.calls.filter((call) => call.verb === 'object_create').every((call) => call.args.site === 'site_fixture'));
});

test('ambiguous create retries exactly once with the same idempotency key', async () => {
  const plan = await fixturePlan();
  const transport = mockTransport({ createFailure: true });
  const report = await executeEmission({ plan, mapping: await fixture('zilberman.mapping.v1.redacted.json'), transport, projectPolicyResolver: async (target) => projectPolicy(target) });
  const creates = transport.calls.filter((call) => call.verb === 'object_create');
  assert.equal(creates.length, plan.creates.length + 1);
  assert.equal(creates[0].args.idempotency_key, creates[1].args.idempotency_key);
  assert.ok(report.trace.some((entry) => entry.retry === 'same_idempotency_key'));
});

test('missing rights requires an explicit adapter and creation restrictions quarantine without loosening policy', async () => {
  const plan = await fixturePlan();
  const mapping = await fixture('zilberman.mapping.v1.redacted.json');
  await assert.rejects(() => executeEmission({ plan, mapping, transport: mockTransport(), projectPolicyResolver: async (target) => projectPolicy(target, { content: 'prohibited', media: 'prohibited' }) }), /model-adapter/);
  const transport = mockTransport();
  const originalCall = transport.call.bind(transport);
  transport.call = async (verb, args) => {
    if (verb === 'object_contract' && args.object_type === 'theme') return { contract: { creation_policy: { humans: 'always_allowed', agents: { allowlist: [] } } } };
    return originalCall(verb, args);
  };
  const report = await executeEmission({
    plan,
    mapping,
    transport, projectPolicyResolver: async (target) => projectPolicy(target, { content: 'prohibited', media: 'prohibited' }),
    modelAdapter: { async regenerateBody({ body }) { return structuredClone(body); } },
  });
  assert.equal(report.copyPolicy.mode, 'regenerate');
  assert.ok(report.quarantines.some((item) => item.reason === 'creation_restricted' && item.objectType === 'theme'));
  assert.equal(transport.calls.filter((call) => call.verb === 'object_create' && call.args.object_type === 'theme').length, 0);
});

test('a project response for any other target fails before contracts or writes', async () => {
  const plan = await fixturePlan();
  const transport = mockTransport();
  await assert.rejects(
    () => executeEmission({ plan, mapping: { pages: [] }, transport, projectPolicyResolver: async () => projectPolicy('wrong-target') }),
    (error) => error instanceof EmissionError && /Target binding mismatch/.test(error.message)
  );
  assert.deepEqual(transport.calls.map((call) => call.verb), []);
});

test('actual inventory recipe_summary is reused and existing page routes quarantine before creation', async () => {
  const plan = await fixturePlan();
  const mapping = await fixture('zilberman.mapping.v1.redacted.json');
  const recipeSummary = plan.creates.find((item) => item.objectType === 'section_template').body.name;
  const transport = mockTransport({ recipeSummary, pageRoute: '/', pageRouteInDetail: true });
  const report = await executeEmission({ plan, mapping, transport, projectPolicyResolver: async (target) => projectPolicy(target) });
  assert.ok(report.reusedObjects.some((item) => item.reason === 'matching_recipe_summary'));
  assert.equal(report.quarantines.some((item) => item.reason === 'reuse_existing_recipe'), false);
  assert.ok(report.quarantines.some((item) => item.reason === 'route_collision' && item.route === '/'));
  assert.equal(transport.calls.filter((call) => call.verb === 'object_create' && call.args.requested_id === plan.creates.find((item) => item.body.route === '/')?.requestedId).length, 0);
  assert.deepEqual(
    transport.calls.find((call) => call.verb === 'object_get')?.args,
    { object_type: 'page', object_id: 'page_existing' }
  );
});

test('media is deduped, hash-enriched, scoped to its owning page, and portable false remains valid for that request', async () => {
  const plan = await fixturePlan();
  plan.media.push(structuredClone(plan.media[0]));
  plan.media.push({
    manifestRef: 'asset_document_fixture',
    pageRef: plan.pageRefs[0],
    candidateId: 'candidate_document_fixture',
    kind: 'document',
    sourceUrl: 'https://example.com/source.docx',
  });
  const mapping = await fixture('zilberman.mapping.v1.redacted.json');
  const transport = mockTransport();
  const report = await executeEmission({
    plan, mapping, transport,
    projectPolicyResolver: async (target) => projectPolicy(target, { content: 'retain_allowed_origin_content', media: 'retain_referenced_allowed_origin_media' }),
    assetProbe: async () => ({ contentType: 'image/jpeg', expectedSizeBytes: 12, expectedSha256: 'a'.repeat(64) }),
  });
  const uploads = transport.calls.filter((call) => call.verb === 'create_artifact_from_url');
  assert.equal(uploads.length, new Set(plan.media.map((asset) => asset.manifestRef)).size);
  assert.ok(uploads.every((call) => /^req_capture_zilberman_20260813_\d{2}$/.test(call.args.requestId)));
  assert.ok(uploads.some((call) => call.args.artifactKind === 'doc'));
  assert.equal(report.createdArtifacts.length, uploads.length);
});

test('artifact request ids use the real req flow/topic/date/ordinal grammar', async () => {
  const plan = await fixturePlan();
  assert.match(captureRequestId(plan, plan.pageRefs[0]), /^req_capture_zilberman_20260813_01$/);
  assert.match(captureRequestId(plan, plan.pageRefs[4]), /^req_capture_zilberman_20260813_05$/);
});

test('a create response with no explicit null publication state is quarantined, never called draft', async () => {
  const plan = await fixturePlan();
  const transport = mockTransport();
  const original = transport.call.bind(transport);
  transport.call = async (verb, args) => {
    if (verb === 'object_create') return { record: { object_id: args.requested_id, status: 'active' } };
    return original(verb, args);
  };
  const report = await executeEmission({ plan, mapping: await fixture('zilberman.mapping.v1.redacted.json'), transport, projectPolicyResolver: async (target) => projectPolicy(target) });
  assert.equal(report.createdObjects.length, plan.creates.length);
  assert.ok(report.createdObjects.every((item) => item.draftVerified === false));
  assert.equal(report.quarantines.filter((item) => item.reason === 'not_draft_only_response').length, plan.creates.length);
});

test('precreate and postcreate validation fail closed on live summary shape', async () => {
  const plan = await fixturePlan();
  const mapping = await fixture('zilberman.mapping.v1.redacted.json');
  const preTransport = mockTransport();
  const preOriginal = preTransport.call.bind(preTransport);
  preTransport.call = async (verb, args) => {
    if (verb === 'object_validate' && !args.object_id) return { summary: { eligible: false, blockers: [{ id: 'schema_zod' }] } };
    return preOriginal(verb, args);
  };
  const preReport = await executeEmission({ plan, mapping, transport: preTransport, projectPolicyResolver: async (target) => projectPolicy(target) });
  assert.equal(preTransport.calls.filter((call) => call.verb === 'object_create').length, 0);
  assert.equal(preReport.quarantines.filter((item) => item.reason === 'validation_or_create_failed').length, plan.creates.length);

  const postTransport = mockTransport();
  const postOriginal = postTransport.call.bind(postTransport);
  postTransport.call = async (verb, args) => {
    if (verb === 'object_validate' && args.object_id) return { summary: { eligible: false, blockers: [{ id: 'structure_allowed' }] } };
    return postOriginal(verb, args);
  };
  const postReport = await executeEmission({ plan, mapping, transport: postTransport, projectPolicyResolver: async (target) => projectPolicy(target) });
  assert.equal(postReport.createdObjects.length, plan.creates.length);
  assert.equal(postReport.quarantines.filter((item) => item.reason === 'postcreate_validation_failed').length, plan.creates.length);
  assert.ok(postReport.validationStates.filter((item) => item.phase === 'postcreate').every((item) => item.valid === false));
});

test('validation without an explicit eligibility signal is quarantined before create', async () => {
  const plan = await fixturePlan();
  const transport = mockTransport();
  const original = transport.call.bind(transport);
  transport.call = async (verb, args) => (verb === 'object_validate' ? { validation: [] } : original(verb, args));
  const report = await executeEmission({
    plan,
    mapping: await fixture('zilberman.mapping.v1.redacted.json'),
    transport,
    projectPolicyResolver: async (target) => ({ data: projectPolicy(target) }),
  });
  assert.equal(transport.calls.filter((call) => call.verb === 'object_create').length, 0);
  assert.ok(report.validationStates.every((item) => item.valid === false && item.reason === 'validation_eligibility_missing'));
});

test('HTTP transport sends only MCP tools/call envelopes to the exact supplied endpoint', async () => {
  const requests = [];
  const transport = createMcpTransport({
    endpoint: 'https://fixture.example/mcp',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, async json() { return { result: { structuredContent: { project: { id: 'fixture-target' } } } }; } };
    },
  });
  await transport.call('ping', {});
  assert.equal(requests[0].url, 'https://fixture.example/mcp');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} },
  });
  await assert.rejects(() => transport.call('object_publish', {}), /Forbidden emission verb/);
  assert.equal(requests.length, 1);
});
