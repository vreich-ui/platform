import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertAssetFieldsFirstParty,
  buildDryRunReport,
  buildEmissionPlan,
  captureRequestId,
  createMcpTransport,
  EmissionError,
  executeEmission,
} from './emit.mjs';

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
      assetPlanCount: plan.assetPlans.length,
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

const MEDIA_ALLOWED = { content: 'retain_allowed_origin_content', media: 'retain_referenced_allowed_origin_media' };
/**
 * T12.16: the mapper's `kind` no longer gates ingestion — the probed
 * contentType does — so every DISTINCT planned asset is uploadable as long as
 * its bytes resolve to a supported type. `kind` only decides where an asset was
 * found, never what it is.
 */
const distinctUploadableAssets = (plan) => new Set(plan.media.map((asset) => asset.manifestRef)).size;

/** A probe answer for the fixture's assets: Wix serves JPEG, the file link a DOCX. */
const fixtureProbe = async (sourceUrl) => ({
  sourceUrl,
  contentType: /\.docx?(?:$|[?#])/i.test(sourceUrl)
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'image/jpeg',
  expectedSizeBytes: 12,
  expectedSha256: createHash('sha256').update(sourceUrl).digest('hex'),
});

/**
 * T12.14: with media rights PROHIBITED no asset field can be bound, so a
 * captured `media` recipe cannot be shipped and is quarantined. Every count
 * assertion below is expressed against this, rather than against a bare
 * `plan.creates.length`, so it stays true whichever way rights fall.
 */
const attemptedCreates = (plan, report) =>
  plan.creates.length - report.quarantines.filter((item) => item.reason === 'asset_binding_unresolved').length;

/**
 * Exactly what the target server does with these arguments: createArtifactBlobKey
 * (packages/core/server/lib/artifacts.ts) builds
 * `<artifactKind>/<requestId>/<sha256><extension>`, and the extension comes from
 * `filename` via getArtifactExtension — which is EMPTY when no filename is sent.
 * The mock reproduces that faithfully, including the empty case, because that
 * empty case IS the T12.16 defect (an unservable key that can never satisfy
 * MAJOR_KEY_ARTIFACT_REF_RE).
 */
const serverBlobKey = (args) =>
  `${args.artifactKind}/${args.requestId}/${String(args.expectedSha256).toLowerCase()}${path.extname(args.filename ?? '').toLowerCase()}`;

/** Every value the section schemas treat as an asset field, wherever it sits. */
function assetFieldValues(value, found = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => assetFieldValues(item, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && (key === 'src' || /assetref$/i.test(key))) found.push([key, item]);
    else assetFieldValues(item, found);
  }
  return found;
}

function mockTransport({
  createFailure,
  pageRoute = null,
  pageRouteInDetail = false,
  recipeSummary = null,
  artifactBlobKey = null,
} = {}) {
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
      if (verb === 'create_artifact_from_url')
        return { artifact: { blobKey: artifactBlobKey ? artifactBlobKey(args) : serverBlobKey(args), portable: false } };
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
  assert.equal(report.createdObjects.length, attemptedCreates(plan, report));
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
  assert.equal(creates.length, attemptedCreates(plan, report) + 1);
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
    assetProbe: fixtureProbe,
  });
  const uploads = transport.calls.filter((call) => call.verb === 'create_artifact_from_url');
  assert.equal(uploads.length, distinctUploadableAssets(plan));
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
  assert.equal(report.createdObjects.length, attemptedCreates(plan, report));
  assert.ok(report.createdObjects.every((item) => item.draftVerified === false));
  assert.equal(
    report.quarantines.filter((item) => item.reason === 'not_draft_only_response').length,
    report.createdObjects.length
  );
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
  assert.equal(
    preReport.quarantines.filter((item) => item.reason === 'validation_or_create_failed').length,
    attemptedCreates(plan, preReport)
  );

  const postTransport = mockTransport();
  const postOriginal = postTransport.call.bind(postTransport);
  postTransport.call = async (verb, args) => {
    if (verb === 'object_validate' && args.object_id) return { summary: { eligible: false, blockers: [{ id: 'structure_allowed' }] } };
    return postOriginal(verb, args);
  };
  const postReport = await executeEmission({ plan, mapping, transport: postTransport, projectPolicyResolver: async (target) => projectPolicy(target) });
  assert.equal(postReport.createdObjects.length, attemptedCreates(plan, postReport));
  assert.equal(
    postReport.quarantines.filter((item) => item.reason === 'postcreate_validation_failed').length,
    postReport.createdObjects.length
  );
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

// ─── T12.14 acceptance ───────────────────────────────────────────────────────

test('materialized artifacts bind into the schema asset fields, first-party only', async () => {
  const plan = await fixturePlan();
  assert.ok(plan.assetPlans.length > 0, 'the fixture must exercise the asset-binding path');
  const transport = mockTransport();
  const report = await executeEmission({
    plan,
    transport,
    projectPolicyResolver: async (target) => projectPolicy(target, MEDIA_ALLOWED),
    assetProbe: async (sourceUrl) => ({
      contentType: 'image/jpeg',
      expectedSizeBytes: 12,
      expectedSha256: createHash('sha256').update(sourceUrl).digest('hex'),
    }),
  });

  // Artifacts are materialized BEFORE anything is created — a section cannot be
  // bound to bytes that do not exist yet.
  const firstUpload = transport.calls.findIndex((call) => call.verb === 'create_artifact_from_url');
  const firstCreate = transport.calls.findIndex((call) => call.verb === 'object_create');
  assert.ok(firstUpload >= 0 && firstCreate > firstUpload);

  assert.equal(report.assetGaps.length, 0);
  // Every planned section bound, plus the repeated-media section_template recipe
  // whose blueprint is one of those sections.
  assert.equal(
    report.assetBindings.filter((entry) => entry.objectType !== 'section_template').length,
    plan.assetPlans.length
  );
  assert.equal(report.assetBindings.filter((entry) => entry.objectType === 'section_template').length, 1);
  assert.ok(report.assetBindings.every((entry) => entry.status === 'bound'));
  assert.deepEqual(
    report.mediaPolicy.mediaRetention,
    'retain_referenced_allowed_origin_media'
  );

  // Every asset value that reached the wire is a served first-party path (or, for
  // the *AssetRef idiom, a Major-Key reference) — never a source URL.
  const createdBodies = transport.calls.filter((call) => call.verb === 'object_create').map((call) => call.args.body);
  const assetValues = assetFieldValues(createdBodies);
  assert.ok(assetValues.length > 0, 'at least one asset field must have been emitted');
  for (const [key, value] of assetValues) {
    if (/assetref$/i.test(key)) assert.match(value, /^(image|pdf)\/[^/]+\/[0-9a-f]{64}\.[a-z]+$/i);
    else assert.match(value, /^\/(img|pdf)\/[^/]+\/[0-9a-f]{64}\.[a-z]+$/i);
  }
  // …and no source-origin host appears anywhere in any created body.
  const wire = JSON.stringify(createdBodies);
  assert.equal(wire.includes('static.wixstatic.com'), false);
  assert.equal(wire.includes('zilbermanfilmfoundation.com'), false);
});

test('a source-origin or third-party URL can never reach an asset field: it quarantines', async () => {
  // The hostile case: an artifact bridge (or a tampered plan) answers with the
  // SOURCE URL instead of a first-party artifact reference. Every planned section
  // must quarantine, no page may carry the URL, and nothing may be coerced.
  const hostileKeys = [
    (args) => args.sourceUrl,
    () => 'https://static.wixstatic.com/media/944663_hostile~mv2.jpg',
    () => 'data:image/jpeg;base64,AAAA',
    () => 'src/assets/hostile.jpg',
    () => '',
  ];
  for (const artifactBlobKey of hostileKeys) {
    const plan = await fixturePlan();
    const transport = mockTransport({ artifactBlobKey });
    const report = await executeEmission({
      plan,
      transport,
      projectPolicyResolver: async (target) => projectPolicy(target, MEDIA_ALLOWED),
      assetProbe: async (sourceUrl) => ({
        contentType: 'image/jpeg',
        expectedSizeBytes: 12,
        expectedSha256: createHash('sha256').update(sourceUrl).digest('hex'),
      }),
    });
    assert.equal(report.assetBindings.length, 0);
    assert.equal(report.assetGaps.filter((gap) => gap.pageRef).length, plan.assetPlans.length);
    assert.ok(report.assetGaps.every((gap) => gap.why === 'asset_binding_unresolved'));
    assert.ok(report.quarantines.some((item) => item.reason === 'artifact_reference_not_bindable'));
    const wire = JSON.stringify(transport.calls.filter((call) => call.verb === 'object_create'));
    assert.equal(wire.includes('static.wixstatic.com'), false);
    assert.equal(wire.includes('data:image'), false);
    assert.equal(wire.includes('src/assets/'), false);
    // No half-bound section survived: not one asset field reached the wire.
    assert.deepEqual(
      assetFieldValues(transport.calls.filter((call) => call.verb === 'object_create').map((call) => call.args.body)),
      []
    );
  }
});

test('the final barrier refuses a coerced asset field even if binding were bypassed', () => {
  // Defence in depth: `assertAssetFieldsFirstParty` guards EVERY body reaching
  // object_create, so a future code path (or a model adapter rewriting copy)
  // cannot introduce a hotlink without a thrown EmissionError.
  for (const hostile of [
    { sections: [{ id: 's', type: 'media', data: { items: [{ kind: 'image', src: 'https://cdn.example.com/a.jpg', alt: 'a' }] } }] },
    { sections: [{ id: 's', type: 'bio', data: { portrait: { src: '/images/a.jpg', alt: 'a' } } }] },
    { sections: [{ id: 's', type: 'bio', data: { portraitAssetRef: 'https://cdn.example.com/a.jpg' } }] },
    { sections: [{ id: 's', type: 'brand_row', data: { logos: [{ src: 'src/assets/a.png', alt: 'a' }] } }] },
  ]) {
    assert.throws(() => assertAssetFieldsFirstParty(hostile), (error) => error instanceof EmissionError && /first-party/.test(error.message));
  }
  // Legitimate captured content is untouched: an external link target is not an
  // asset field, and a bound first-party path passes.
  assertAssetFieldsFirstParty({
    sections: [
      { id: 's1', type: 'cta_banner', data: { actions: [{ label: 'Donate', target: { kind: 'external', href: 'https://justgiving.com/x' } }] } },
      {
        id: 's2',
        type: 'media',
        data: { items: [{ kind: 'image', src: `/img/req_capture_x_20260817_01/${'a'.repeat(64)}.jpg`, alt: 'a' }] },
      },
    ],
  });
});

test('a prohibited-media policy emits zero media and records the gap', async () => {
  const plan = await fixturePlan();
  const transport = mockTransport();
  const report = await executeEmission({
    plan,
    transport,
    projectPolicyResolver: async (target) =>
      projectPolicy(target, { content: 'retain_allowed_origin_content', media: 'prohibited' }),
  });
  // Not one artifact call was made, and not one asset field was bound.
  assert.equal(transport.calls.filter((call) => call.verb === 'create_artifact_from_url').length, 0);
  assert.equal(report.createdArtifacts.length, 0);
  assert.equal(report.assetBindings.length, 0);
  assert.deepEqual(report.mediaPolicy, {
    mediaRetention: 'prohibited',
    materialized: 0,
    declined: plan.media.length,
  });
  // Every planned asset section is a recorded gap, never a coerced or empty one.
  assert.equal(report.assetGaps.filter((gap) => gap.pageRef).length, plan.assetPlans.length);
  assert.ok(report.assetGaps.every((gap) => gap.why === 'asset_binding_unresolved' && gap.gapId && gap.sectionId));
  // A repeated media shape became a section_template recipe; with no bindable
  // asset it is quarantined rather than shipped with an empty gallery.
  assert.ok(
    report.quarantines.some(
      (item) => item.objectType === 'section_template' && item.reason === 'asset_binding_unresolved'
    )
  );
  const createdBodies = transport.calls.filter((call) => call.verb === 'object_create').map((call) => call.args.body);
  assert.deepEqual(assetFieldValues(createdBodies), []);
  const wire = JSON.stringify(createdBodies);
  assert.equal(wire.includes('AssetRef'), false);
  assert.equal(wire.includes('static.wixstatic.com'), false);
});

// ─── T12.17 acceptance ───────────────────────────────────────────────────────

test('a single asset probe failure quarantines only that asset; every sibling asset still materializes and binds', async () => {
  const plan = await fixturePlan();
  const [firstPlan, secondPlan] = plan.assetPlans;
  assert.ok(
    firstPlan?.entries?.length && secondPlan?.entries?.length,
    'the fixture must carry at least two independent asset plans'
  );
  const failingRef = firstPlan.entries[0].manifestRef;
  const failingAsset = plan.media.find((item) => item.manifestRef === failingRef);
  assert.ok(failingAsset, 'the fixture plan must carry the failing asset');
  const survivingRef = secondPlan.entries[0].manifestRef;
  const survivingAsset = plan.media.find((item) => item.manifestRef === survivingRef);
  assert.ok(survivingAsset, 'the fixture plan must carry a sibling asset');

  const transport = mockTransport();
  const report = await executeEmission({
    plan,
    transport,
    projectPolicyResolver: async (target) => projectPolicy(target, MEDIA_ALLOWED),
    assetProbe: async (sourceUrl) => {
      if (sourceUrl === failingAsset.sourceUrl) throw new Error('boom: asset host unreachable');
      return fixtureProbe(sourceUrl);
    },
  });

  // The failing asset is quarantined by T12.17's own reason, not thrown past the loop.
  const quarantine = report.quarantines.find((item) => item.asset === failingRef);
  assert.ok(quarantine, 'the failing asset must be recorded as a quarantine');
  assert.equal(quarantine.reason, 'asset_probe_failed');
  assert.match(quarantine.detail, /boom: asset host unreachable/);
  assert.equal(
    transport.calls.some(
      (call) => call.verb === 'create_artifact_from_url' && call.args.sourceUrl === failingAsset.sourceUrl
    ),
    false,
    'a failed probe must never reach the artifact bridge'
  );

  // The emission itself did not throw or abort: creates still ran.
  assert.ok(transport.calls.some((call) => call.verb === 'object_create'));

  // Every OTHER asset in the same plan still materializes and binds.
  const survivingUpload = transport.calls.find(
    (call) => call.verb === 'create_artifact_from_url' && call.args.sourceUrl === survivingAsset.sourceUrl
  );
  assert.ok(survivingUpload, 'a sibling asset must still be ingested despite the failing probe');
  const survivingBinding = report.assetBindings.find((entry) => entry.manifestRefs?.includes(survivingRef));
  assert.ok(survivingBinding, 'a sibling asset must still bind');
  assert.equal(survivingBinding.status, 'bound');
});

// ─── T12.16 acceptance ───────────────────────────────────────────────────────
// The live zilberman run (run_1787054978582_2o5xu5) ingested 30 artifacts and
// bound NONE: 30 × artifact_reference_not_bindable (no filename → extensionless,
// unservable blobKey) and 20 × unsupported_media_kind (`media` assets dropped
// before a single byte was fetched). Both are fixed at the CALLER; neither
// MAJOR_KEY_ARTIFACT_REF_RE nor PUBLIC_ARTIFACT_PATH_RE is loosened.

/** The mapper's `kind` for an asset the emission plan already carries. */
function retagPlannedAsset(plan, manifestRef, patch) {
  const asset = plan.media.find((item) => item.manifestRef === manifestRef);
  assert.ok(asset, `the fixture plan must carry ${manifestRef}`);
  Object.assign(asset, patch);
  return asset;
}

test('a gallery JPEG the mapper labelled `media` materializes as an image artifact and binds', async () => {
  const plan = await fixturePlan();
  const [firstPlan] = plan.assetPlans;
  assert.ok(firstPlan?.entries?.length, 'the fixture must exercise the asset-binding path');
  const { manifestRef } = firstPlan.entries[0];
  // Exactly the zilberman shape: a real JPEG that reached the mapper through a
  // <picture>/<source> variant rather than a bare <img>, so it was tagged `media`.
  const asset = retagPlannedAsset(plan, manifestRef, { kind: 'media' });

  const transport = mockTransport();
  const report = await executeEmission({
    plan,
    transport,
    projectPolicyResolver: async (target) => projectPolicy(target, MEDIA_ALLOWED),
    assetProbe: fixtureProbe,
  });

  // It was fetched, not dropped: no `unsupported_media_kind` for it, and it was
  // ingested as the image its bytes say it is — not as the mapper's hint.
  assert.equal(report.quarantines.filter((item) => item.asset === manifestRef).length, 0);
  const upload = transport.calls.find(
    (call) => call.verb === 'create_artifact_from_url' && call.args.sourceUrl === asset.sourceUrl
  );
  assert.ok(upload, '`media` kind must no longer be dropped before the fetch');
  assert.equal(upload.args.artifactKind, 'image');
  assert.equal(upload.args.contentType, 'image/jpeg');

  // …and it BOUND: the section that needed it is emitted, not quarantined.
  const bound = report.assetBindings.find((entry) => entry.manifestRefs?.includes(manifestRef));
  assert.ok(bound, 'a materialized `media` JPEG must be bindable');
  assert.equal(bound.status, 'bound');
  assert.equal(report.assetGaps.filter((gap) => gap.sectionId === firstPlan.sectionId).length, 0);
});

test('every ingest call carries a deterministic <sha256><ext> filename, so every blobKey is a servable Major-Key ref', async () => {
  const plan = await fixturePlan();
  const transport = mockTransport();
  const report = await executeEmission({
    plan,
    transport,
    projectPolicyResolver: async (target) => projectPolicy(target, MEDIA_ALLOWED),
    assetProbe: fixtureProbe,
  });
  const uploads = transport.calls.filter((call) => call.verb === 'create_artifact_from_url');
  assert.ok(uploads.length > 0);
  for (const call of uploads) {
    // Deterministic (the content hash), collision-free, path-free, and inside
    // artifactReferenceLimits.originalFilename (160).
    assert.equal(call.args.filename, `${call.args.expectedSha256.toLowerCase()}${call.args.artifactKind === 'doc' ? '' : path.extname(call.args.filename)}`);
    assert.ok(call.args.filename.length <= 160);
    assert.doesNotMatch(call.args.filename, /[/\\]/);
    if (call.args.artifactKind !== 'doc') assert.match(call.args.filename, /^[0-9a-f]{64}\.(jpg|png|webp|gif|avif|svg|pdf)$/);
  }
  // The server-faithful key the mock derives from that filename is bindable —
  // the exact test at emit.mjs that produced 30 quarantines on the live run.
  const bindable = report.createdArtifacts.filter((entry) => entry.artifact.blobKey.startsWith('image/'));
  assert.ok(bindable.length > 0);
  for (const entry of bindable) {
    assert.match(entry.artifact.blobKey, /^(image|pdf)\/[^/]+\/[0-9a-f]{64}\.[a-z]+$/i);
    // …and therefore servable at the public path the redirects expose.
    assert.match(`/img/${entry.artifact.blobKey.slice('image/'.length)}`, /^\/(img|pdf)\/[^/]+\/[0-9a-f]{64}\.[a-z]+$/i);
  }
  // A DOCX still ingests (accounting) and still cannot bind: `doc/…` is not a
  // Major-Key ref by construction.
  const docs = report.createdArtifacts.filter((entry) => entry.artifact.blobKey.startsWith('doc/'));
  assert.ok(docs.length > 0);
  for (const entry of docs) assert.doesNotMatch(entry.artifact.blobKey, /^(image|pdf)\//);
});

test('a contentType with no known extension quarantines instead of minting an unservable key or hotlinking', async () => {
  for (const [contentType, reason] of [
    // Not an image and not a PDF: never ingestible as a bindable artifact.
    ['video/mp4', 'unsupported_media_kind'],
    ['application/octet-stream', 'unsupported_media_kind'],
    // image/* but no extension we can honestly name: the extensionless-key trap.
    ['image/tiff', 'unmappable_artifact_content_type'],
    ['image/x-icon', 'unmappable_artifact_content_type'],
  ]) {
    const plan = await fixturePlan();
    const transport = mockTransport();
    const report = await executeEmission({
      plan,
      transport,
      projectPolicyResolver: async (target) => projectPolicy(target, MEDIA_ALLOWED),
      assetProbe: async (sourceUrl) => ({
        sourceUrl,
        contentType,
        expectedSizeBytes: 12,
        expectedSha256: createHash('sha256').update(sourceUrl).digest('hex'),
      }),
    });
    // Nothing bindable was ingested and nothing was bound. The only ingests
    // that may survive are the file-link `document` assets, which land as
    // `doc` — accounted, never bindable (`doc/…` is not a Major-Key ref).
    const uploads = transport.calls.filter((call) => call.verb === 'create_artifact_from_url');
    assert.ok(uploads.every((call) => call.args.artifactKind === 'doc'));
    assert.ok(report.createdArtifacts.every((entry) => !/^(image|pdf)\//.test(entry.artifact.blobKey)));
    assert.equal(report.assetBindings.length, 0);
    // The observed contentType is recorded on every quarantine, so the reason
    // is diagnosable from the run report alone. (A `doc` that DID ingest still
    // records its own `artifact_reference_not_bindable` — accurate and
    // deliberate: `doc/…` is not a Major-Key ref — so it is excluded here.)
    const quarantined = report.quarantines.filter(
      (item) => item.asset && item.reason !== 'artifact_reference_not_bindable'
    );
    assert.ok(quarantined.length > 0);
    assert.ok(quarantined.every((item) => item.reason === reason && item.contentType === contentType));
    // Every planned section is a recorded gap — never a hotlink, never a
    // half-bound section, never a coerced field.
    assert.equal(report.assetGaps.filter((gap) => gap.pageRef).length, plan.assetPlans.length);
    const createdBodies = transport.calls.filter((call) => call.verb === 'object_create').map((call) => call.args.body);
    assert.deepEqual(assetFieldValues(createdBodies), []);
    const wire = JSON.stringify(createdBodies);
    assert.equal(wire.includes('static.wixstatic.com'), false);
    assert.equal(wire.includes(plan.media[0].sourceUrl), false);
  }
});

test('a Wix transform URL whose path ends in /v1/fill/w_146 still yields .jpg — from the contentType, never the path', async () => {
  const plan = await fixturePlan();
  const [firstPlan] = plan.assetPlans;
  const { manifestRef } = firstPlan.entries[0];
  const sourceUrl =
    'https://static.wixstatic.com/media/944663_fdac4c14e2bd4534b634d7d1532b7ddf~mv2.jpg/v1/fill/w_146';
  // The premise: the URL path is a transform recipe, so it carries no usable
  // extension. Deriving one from the path would produce '' or garbage.
  assert.equal(path.extname(new URL(sourceUrl).pathname), '');
  retagPlannedAsset(plan, manifestRef, { kind: 'media', sourceUrl });

  const transport = mockTransport();
  const report = await executeEmission({
    plan,
    transport,
    projectPolicyResolver: async (target) => projectPolicy(target, MEDIA_ALLOWED),
    assetProbe: fixtureProbe,
  });
  const upload = transport.calls.find((call) => call.verb === 'create_artifact_from_url' && call.args.sourceUrl === sourceUrl);
  assert.ok(upload);
  assert.equal(upload.args.artifactKind, 'image');
  assert.match(upload.args.filename, /^[0-9a-f]{64}\.jpg$/);
  const created = report.createdArtifacts.find((entry) => entry.manifestRef === manifestRef);
  assert.match(created.artifact.blobKey, /^image\/[^/]+\/[0-9a-f]{64}\.jpg$/);
  assert.ok(report.assetBindings.some((entry) => entry.artifactRefs?.includes(created.artifact.blobKey)));
});
