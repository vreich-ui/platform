/**
 * A5 — `admin-visual-identity-regenerate-examples`: the Imagery tab's
 * "Regenerate examples" button as a deterministic endpoint instead of the
 * `set_visual_standard_fields` chat instruction
 * (`buildRegenerateExamplesIntent`, visual-identity-imagery.ts).
 *
 * What these pin:
 *   1. the endpoint clears the standard's `examples[]` under an ordinary
 *      checkout/patch/checkin and reports the A6 job it kicked — `pending`,
 *      `dispatched: true`, and the background function actually POSTed to,
 *      naming this standard and carrying the job's one-shot token;
 *   2. it never generates anything itself — no image job, no
 *      `runVisualStandardExamplesGeneration` call, ever reachable from this
 *      file;
 *   3. the ordinary role gate (viewer refused, editor allowed) and a 404 on
 *      an unknown standard, matching A1/A3.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/admin-visual-identity-regenerate-examples.js';
import { getSiteObjectsBlobStore } from '../../packages/core/server/lib/blob-store.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { handleObjectVerb, type ObjectVerbStore } from '../../packages/core/server/lib/object-verbs.js';
import { buildStoreValidationContext } from '../../packages/core/server/lib/object-validation-context.js';
import type { Principal } from '../../packages/core/schema/object-record-v1.js';

const ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'admin-visual-identity-regenerate-examples');
setLocalBlobsRootForTesting(ROOT);

const EDITOR = { sub: 'editor-1', email: 'editor@example.com' };
const VIEWER = { sub: 'viewer-1', email: 'viewer@example.com' };
const HUMAN: Principal = { kind: 'human', id: 'seed-1', email: 'owner@example.com' };

const prepareEnv = () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';
  process.env.ADMIN_EMAILS = 'owner@example.com';
  process.env.ROLE_EMAILS_EDITOR = 'editor@example.com';
  process.env.ROLE_EMAILS_PUBLISHER = '';
  process.env.ROLE_EMAILS_ADMIN = '';
  delete process.env.URL;
};

const seedStandard = async (objectId: string, examples: Array<Record<string, unknown>>) => {
  const store = (await getSiteObjectsBlobStore({})) as unknown as ObjectVerbStore;
  const validationContext = await buildStoreValidationContext(store);
  const result = await handleObjectVerb(
    store,
    {
      action: 'create',
      object_type: 'visual_standard',
      site: 'site_drlurie',
      requested_id: objectId,
      body: {
        version: 1,
        kind: 'template',
        label: 'Regenerate test look',
        whenToUse: 'The fixture the A5 regenerate tests write onto.',
        brandImagery: {
          version: 1,
          medium: 'photograph',
          styleSentence: 'Clinical-clean skincare editorial photography with soft studio light.',
          palette: ['#2E5C42'],
          negative: ['no stock-photo gloss'],
          aspectRatios: { article_header: '3:2' },
          seedBase: 100002,
        },
        references: [],
        sampleSubjects: ['a woman applying serum'],
        examples,
        status: 'draft',
      },
    },
    HUMAN,
    { validationContext, roles: ['owner', 'admin', 'publisher'] }
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
};

const readStandardBody = async (objectId: string) => {
  const store = (await getSiteObjectsBlobStore({})) as unknown as ObjectVerbStore;
  const result = await handleObjectVerb(
    store,
    { action: 'get', object_type: 'visual_standard', object_id: objectId },
    HUMAN,
    { roles: ['owner', 'admin', 'publisher'] }
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return (result.body.record as { body: Record<string, unknown> }).body;
};

const post = (body: Record<string, unknown>, user = EDITOR) =>
  handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) }, { clientContext: { user } });

type RegenerateResponseBody = {
  error?: string;
  standard_id?: string;
  examples_job?: {
    examples_status: string;
    contexts: unknown[];
    trigger: string;
    dispatched?: boolean;
    reason?: string;
  };
};

test('regenerate clears stale examples and reports the A6 job it kicked — never generating inline', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  await seedStandard('vis_drlurie_regen_one', [
    { usageContext: 'article_header', blobKey: 'image/req_x/aa.png', contractHash: 'stale-hash' },
  ]);

  process.env.URL = 'https://drlurie.example';
  const dispatchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    dispatchCalls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ examples_status: 'pending' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  let response;
  try {
    response = await post({ standardId: 'vis_drlurie_regen_one' });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.URL;
  }
  const body = JSON.parse(response.body) as RegenerateResponseBody;

  assert.equal(response.statusCode, 200, JSON.stringify(body));
  assert.equal(body.standard_id, 'vis_drlurie_regen_one');
  assert.equal(body.examples_job?.examples_status, 'pending');
  assert.equal(body.examples_job?.trigger, 'browser');
  assert.equal(body.examples_job?.dispatched, true);
  assert.equal(body.examples_job?.contexts.length, 0);

  // The background function was actually POSTed to, naming this standard.
  assert.equal(dispatchCalls.length, 1);
  assert.match(dispatchCalls[0]?.url ?? '', /\/visual-standard-examples-background$/);
  assert.equal(dispatchCalls[0]?.body.visual_standard_id, 'vis_drlurie_regen_one');
  assert.equal(typeof dispatchCalls[0]?.body.trigger_token, 'string');

  // The stale round is gone — cleared, not merely reported clear.
  const stored = await readStandardBody('vis_drlurie_regen_one');
  assert.deepEqual(stored.examples, []);
});

test('a viewer cannot regenerate examples', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  await seedStandard('vis_drlurie_regen_role', []);

  const response = await post({ standardId: 'vis_drlurie_regen_role' }, VIEWER);
  const body = JSON.parse(response.body) as RegenerateResponseBody;
  assert.equal(response.statusCode, 403, JSON.stringify(body));
  assert.match(String(body.error), /no editing role/i);
});

test('an unknown standard is refused as 404, and nothing to dispatch', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();

  const response = await post({ standardId: 'vis_drlurie_does_not_exist' });
  const body = JSON.parse(response.body) as RegenerateResponseBody;
  assert.equal(response.statusCode, 404, JSON.stringify(body));
  assert.equal(body.examples_job, undefined);
});
