import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler as adminObjectHandler } from '../../netlify/functions/admin-object.js';
import { handler as examplesBackgroundHandler } from '../../netlify/functions/visual-standard-examples-background.js';
import { createLocalBlobStore, setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import {
  contextFailure,
  deriveExamplesStatus,
  isContextFailure,
  readExamplesJob,
  resolveExamplesTriggerTarget,
  triggerVisualStandardExamplesJob,
  visualStandardExamplesJobKey,
  type ExamplesJobStore,
} from '../../packages/core/server/lib/visual-standard-examples-jobs.js';
import { stubPdfToolMcp } from './pdf-tool-mcp-fetch-stub.js';

/**
 * A6 acceptance — "Regenerate examples" produces nothing, fixed.
 *
 * The four things this file pins, in the order the task states them:
 *
 *   1. a trigger leaves a JOB RECORD behind, `pending` — X1 left nothing at all;
 *   2. completion writes `examples[]` onto the standard and flips the job to
 *      `ready`;
 *   3. one context failing is `failed:<reason>` on that context and a `partial`
 *      job — never a silently dropped row (X1's `mergeExampleResults` behaviour);
 *   4. A BROWSER WRITE TRIGGERS THE JOB TOO. This is the regression that
 *      matters: X1 hooked the generator onto `callObjectAction` only, so the
 *      admin surface the affordance actually lives on generated nothing.
 *
 * Driven through the real surfaces — `admin-object.ts` (Netlify Identity) and
 * the background worker — over the local blob fallback, the same posture as
 * object-store-auth.test.ts and mcp-pdf-tool-bridge.test.ts.
 */
const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'visual-standard-examples-job');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID', 'URL']) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';
process.env.ADMIN_EMAILS = 'admin@drlurie.com';
process.env.PDF_TOOL_STORAGE_TOKEN = 'storage-secret-never-expose';
process.env.PDF_TOOL_STORAGE_SITE_ID = 'site-api-id';
process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool.test';
process.env.PDF_TOOL_AGENT_RUN_TOKEN = 'run-secret-never-expose';

const STANDARD_ID = 'vis_drlurie_a6_examples';
const BRAND_IMAGERY = {
  version: 1,
  medium: 'photograph',
  styleSentence: 'Quiet clinical daylight on matte surfaces.',
  palette: ['#2E5C42'],
  negative: [],
  aspectRatios: { article_header: '3:2' },
  seedBase: 11,
};

const adminContext = (email = 'admin@drlurie.com') => ({ clientContext: { user: { sub: 'identity-user', email } } });

const admin = async (body: unknown) => {
  const response = await adminObjectHandler(
    { httpMethod: 'POST', headers: {}, body: JSON.stringify(body) },
    adminContext()
  );
  return { status: response.statusCode, json: JSON.parse(response.body) as Record<string, unknown> };
};

const jobStore = () => createLocalBlobStore('artifact-index') as unknown as ExamplesJobStore;

const readJob = () => readExamplesJob(jobStore(), STANDARD_ID);

const runWorker = async (triggerToken: string) =>
  examplesBackgroundHandler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visual_standard_id: STANDARD_ID, trigger_token: triggerToken }),
  });

/** The pdf-tool double: every example job succeeds unless its usage context is
 *  named in `failing`, in which case pdf-tool refuses it outright. */
const pdfToolDouble = (failing: string[] = []) => {
  const requestIds: string[] = [];
  const { fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: (body) => {
      const requestId = String(body.requestId);
      requestIds.push(requestId);
      if (failing.some((context) => requestId.includes(context))) {
        return { status: 422, body: { error: 'image model refused the prompt', error_code: 'image_model_refused' } };
      }
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
      const sha = 'd'.repeat(64);
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
            sizeBytes: 2048,
            contentType: 'image/png',
            artifactKind: 'image',
            originalFilename: 'example.png',
          },
          materializationProof: 'proof-never-expose',
        },
      };
    },
    verify_agent_artifact: (body) => ({
      body: {
        verified: true,
        projectId: body.projectId,
        requestId: body.requestId,
        artifactReference: body.artifactReference,
        materializationProof: 'proof-never-expose-rotated',
      },
    }),
    get_image_model_policy: () => ({ body: { policy: { byUsageContext: {} }, contexts: [] } }),
  });
  return { requestIds, fetchImpl };
};

const withPdfTool = async <T>(failing: string[], run: (requestIds: string[]) => Promise<T>): Promise<T> => {
  const originalFetch = globalThis.fetch;
  const { requestIds, fetchImpl } = pdfToolDouble(failing);
  globalThis.fetch = fetchImpl;
  try {
    return await run(requestIds);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

/** Checkout → one `set_visual_standard_fields` patch → checkin, exactly the
 *  sequence an admin EditSession performs from the browser. */
const browserPatch = async (fields: Record<string, unknown>) => {
  const checkout = await admin({ action: 'checkout', object_type: 'visual_standard', object_id: STANDARD_ID });
  assert.equal(checkout.status, 200, JSON.stringify(checkout.json));
  const lockToken = checkout.json.lockToken as string;
  const patched = await admin({
    action: 'patch',
    object_type: 'visual_standard',
    object_id: STANDARD_ID,
    lock_token: lockToken,
    expected_record_version: checkout.json.record_version,
    ops: [{ op: 'set_visual_standard_fields', fields }],
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  const checkin = await admin({
    action: 'checkin',
    object_type: 'visual_standard',
    object_id: STANDARD_ID,
    lock_token: lockToken,
  });
  assert.equal(checkin.status, 200, JSON.stringify(checkin.json));
  return patched;
};

const readStandardExamples = async () => {
  const got = await admin({ action: 'get', object_type: 'visual_standard', object_id: STANDARD_ID });
  assert.equal(got.status, 200, JSON.stringify(got.json));
  const record = got.json.record as { body: Record<string, unknown> };
  return {
    examples: (record.body.examples ?? []) as Array<{ usageContext: string; blobKey: string; contractHash: string }>,
    examplesJob: got.json.examples_job as Record<string, unknown> | undefined,
  };
};

// ═══ the pure pieces ═════════════════════════════════════════════════════════

test('deriveExamplesStatus: all ready is ready, none ready is failed, a mix is partial', () => {
  const ready = { usageContext: 'article_header', status: 'ready' };
  const failed = { usageContext: 'article_body', status: contextFailure('image model refused!') };
  assert.equal(deriveExamplesStatus([ready]), 'ready');
  assert.equal(deriveExamplesStatus([failed]), 'failed');
  assert.equal(deriveExamplesStatus([ready, failed]), 'partial');
  assert.equal(deriveExamplesStatus([ready, { usageContext: 'category_page', status: 'pending' }]), 'pending');
  // An empty round generated nothing at all — that is a failure, not a success.
  assert.equal(deriveExamplesStatus([]), 'failed');
  // The reason survives into the status string, machine-shaped.
  assert.equal(failed.status, 'failed:image_model_refused');
  assert.ok(isContextFailure(failed.status));
});

test('resolveExamplesTriggerTarget: the same three writes on both surfaces, and nothing else', () => {
  assert.equal(
    resolveExamplesTriggerTarget({ action: 'create', object_type: 'visual_standard' }, { record: { object_id: 'vis_x' } }),
    'vis_x'
  );
  assert.equal(
    resolveExamplesTriggerTarget({ action: 'patch', object_type: 'visual_standard', object_id: 'vis_x' }, {}),
    'vis_x'
  );
  assert.equal(
    resolveExamplesTriggerTarget(
      { action: 'apply_brand_imagery' },
      { applied_brand_imagery_source: { kind: 'visual_standard', id: 'vis_x' } }
    ),
    'vis_x'
  );
  // A dry run writes nothing; a theme apply has no standard to attach to; an
  // unrelated object type is not a trigger.
  assert.equal(
    resolveExamplesTriggerTarget(
      { action: 'apply_brand_imagery' },
      { dry_run: true, applied_brand_imagery_source: { kind: 'visual_standard', id: 'vis_x' } }
    ),
    undefined
  );
  assert.equal(
    resolveExamplesTriggerTarget({ action: 'apply_brand_imagery' }, { applied_brand_imagery_source: { kind: 'theme', id: 'thm_x' } }),
    undefined
  );
  assert.equal(resolveExamplesTriggerTarget({ action: 'patch', object_type: 'page', object_id: 'page_x' }, {}), undefined);
  assert.equal(resolveExamplesTriggerTarget({ action: 'publish', object_type: 'visual_standard' }, {}), undefined);
});

test('a trigger that cannot reach the worker still leaves a readable record, not silence', async () => {
  const blobs = new Map<string, string>();
  const memory: ExamplesJobStore = {
    get: async (key) => blobs.get(key) ?? null,
    setJSON: async (key, value) => {
      blobs.set(key, JSON.stringify(value));
    },
  };
  const job = await triggerVisualStandardExamplesJob(memory, {
    visualStandardId: 'vis_memory',
    trigger: 'mcp',
    dispatch: async () => false,
  });
  assert.equal(job?.examples_status, 'pending');
  assert.equal(job?.dispatched, false);
  assert.equal(job?.reason, 'not_dispatched');
  assert.ok(blobs.has(visualStandardExamplesJobKey('vis_memory')));
});

// ═══ (4) THE REGRESSION: a browser write triggers the job ════════════════════

test('a BROWSER write on a visual_standard opens a pending examples job (the surface X1 never hooked)', async () => {
  await rm(join(LOCAL_BLOBS_ROOT, 'site-objects'), { recursive: true, force: true });
  await rm(join(LOCAL_BLOBS_ROOT, 'artifact-index'), { recursive: true, force: true });

  const created = await admin({
    action: 'create',
    object_type: 'visual_standard',
    site: 'site_drlurie',
    requested_id: STANDARD_ID,
    body: {
      version: 1,
      kind: 'template',
      label: 'A6 examples template',
      brandImagery: BRAND_IMAGERY,
      references: [],
      sampleSubjects: [],
      status: 'draft',
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));

  const afterCreate = await readJob();
  assert.equal(afterCreate?.examples_status, 'pending', 'a browser create must open a job record');
  assert.equal(afterCreate?.trigger, 'browser', 'the record says which surface asked — the browser one now does');

  // The mood-board save: the browser's checkout → patch → checkin.
  await browserPatch({ sampleSubjects: ['a person reading at a small table', 'a cold-pressed jar'], status: 'active' });

  const afterPatch = await readJob();
  assert.equal(afterPatch?.examples_status, 'pending');
  assert.equal(afterPatch?.trigger, 'browser');
  assert.ok(afterPatch?.trigger_token, 'the worker gets a one-shot token, since the endpoint is public');
  assert.deepEqual(afterPatch?.contexts, [], 'contexts are the worker’s to plan — it alone reads sampleSubjects');
});

// ═══ (1)+(2) the worker completes the round ══════════════════════════════════

test('the worker writes examples[] onto the standard and flips the job to ready', async () => {
  const pending = await readJob();
  assert.equal(pending?.examples_status, 'pending');

  const requestIds = await withPdfTool([], async (ids) => {
    const ran = await runWorker(pending!.trigger_token!);
    assert.equal(ran.statusCode, 200, ran.body);
    return ids;
  });
  assert.equal(requestIds.length, 2, 'two sampleSubjects → two example jobs actually reached pdf-tool');

  const { examples, examplesJob } = await readStandardExamples();
  assert.deepEqual(
    examples.map((example) => example.usageContext),
    ['article_header', 'article_body'],
    'the generated examples are written back onto the standard'
  );
  assert.equal(examples[0]!.contractHash.length, 64);

  const done = await readJob();
  assert.equal(done?.examples_status, 'ready');
  assert.deepEqual(
    done?.contexts.map((context) => `${context.usageContext}=${context.status}`),
    ['article_header=ready', 'article_body=ready']
  );
  assert.equal(done?.trigger_token, undefined, 'the one-shot token is spent');

  // A7 polls the status off the ordinary browser `get` it already makes.
  assert.equal(examplesJob?.examples_status, 'ready');
  assert.equal((examplesJob as { trigger_token?: unknown }).trigger_token, undefined, 'the token never leaves the server');

  // A replayed POST to the public endpoint buys no second round of image jobs.
  const replayed = await runWorker(pending!.trigger_token!);
  assert.equal(replayed.statusCode, 409);
});

// ═══ (3) one context fails, the job still completes ══════════════════════════

test('a failing context surfaces failed:<reason> while the job as a whole still completes', async () => {
  // Clearing examples[] is what "Regenerate examples" asks for — and is itself
  // the trigger, from the browser this time.
  await browserPatch({ examples: [] });
  const pending = await readJob();
  assert.equal(pending?.examples_status, 'pending');

  await withPdfTool(['article_body'], async () => {
    const ran = await runWorker(pending!.trigger_token!);
    assert.equal(ran.statusCode, 200, ran.body);
  });

  const done = await readJob();
  assert.equal(done?.examples_status, 'partial', 'one dead context is a partial job, never a failed one');
  const byContext = new Map(done!.contexts.map((context) => [context.usageContext, context.status]));
  assert.equal(byContext.get('article_header'), 'ready');
  assert.match(String(byContext.get('article_body')), /^failed:[a-z0-9_]+$/, 'the dead context says WHY it died');
  assert.notEqual(byContext.get('article_body'), 'failed:unknown');

  const { examples, examplesJob } = await readStandardExamples();
  assert.deepEqual(
    examples.map((example) => example.usageContext),
    ['article_header'],
    'whatever rendered is still written back — a partial failure is not a lost round'
  );
  assert.equal(examplesJob?.examples_status, 'partial');
});
