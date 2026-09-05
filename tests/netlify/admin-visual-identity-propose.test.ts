/**
 * A3 — `admin-visual-identity-propose`: the Imagery tab's "Write contract
 * from mood board" button as a deterministic endpoint that resolves the
 * standard's own references to BASE64 server-side (never a URL the
 * CMS-Agent node runner would have to fetch itself — see the function's own
 * header for the bug this closes) and calls `visual_identity_propose`
 * directly, matching admin-visual-identity-import.test.ts's style: pdf-tool
 * stays out of it here — the double this test stubs is CmsAgentClient's own
 * HTTP boundary (globalThis.fetch), the same rig
 * tests/netlify/mcp-brand-imagery-propose.test.ts uses, because
 * `admin-visual-identity-propose.ts` builds its own module-level
 * CmsAgentClient which captures `globalThis.fetch` at construction — the
 * stub must be installed before that module is ever imported.
 *
 * What these pin:
 *   1. three references, one with no bytes in the artifact store → a
 *      proposal is still returned, `references_resolved` is 2 of 3, and
 *      `warnings` names the dropped one by its OWN `ref_` id
 *      (`image_dropped:ref_x`) — never by index, never silently swallowed;
 *   2. a board where every reference is unreadable and no `brief` is given
 *      is refused as 422 `no_images_reached_writer` before CMS-Agent is
 *      ever called; the SAME board with a `brief` proceeds to 200 instead.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

process.env.NETLIFY = 'false';
process.env.NETLIFY_SITE_ID = '';
process.env.CONTEXT = 'dev';
process.env.ADMIN_EMAILS = 'owner@example.com';
process.env.ROLE_EMAILS_EDITOR = 'editor@example.com';
process.env.ROLE_EMAILS_PUBLISHER = '';
process.env.ROLE_EMAILS_ADMIN = '';
process.env.CMS_AGENT_MCP_ENDPOINT = 'https://cms-agent.test/mcp';
process.env.CMS_AGENT_MCP_TOKEN = 'test-cms-agent-token';
process.env.URL = 'https://drlurie.example';

const ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'admin-visual-identity-propose');

const EDITOR = { sub: 'editor-1', email: 'editor@example.com' };
const VIEWER = { sub: 'viewer-1', email: 'viewer@example.com' };

/**
 * CmsAgentClient captures `globalThis.fetch` at construction, and
 * `admin-visual-identity-propose.ts` builds its client at MODULE scope — so
 * this stub, a stable wrapper over a mutable `dispatch`, must be installed
 * before the handler module is ever imported (same rig as
 * mcp-brand-imagery-propose.test.ts's own comment explains).
 */
type DispatchOutcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };
let dispatch: (name: string, args: Record<string, unknown>) => DispatchOutcome = () => ({ ok: true, data: {} });
let calls: Array<{ name: string; args: Record<string, unknown> }> = [];

const jsonRes = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const payload = JSON.parse(String(init?.body ?? '{}')) as {
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  };
  if (payload.method === 'initialize') {
    return jsonRes(
      { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } },
      { 'mcp-session-id': 'visual-identity-propose-session' }
    );
  }
  if (payload.method === 'notifications/initialized') return jsonRes({});
  const name = payload.params?.name ?? '';
  const args = payload.params?.arguments ?? {};
  calls.push({ name, args });
  const outcome = dispatch(name, args);
  return jsonRes({
    jsonrpc: '2.0',
    id: 2,
    result: {
      structuredContent: {
        ok: outcome.ok,
        ...(outcome.ok ? { data: outcome.data } : { code: outcome.code, message: outcome.message }),
      },
    },
  });
}) as typeof fetch;

const { setLocalBlobsRootForTesting } = await import('../../packages/core/server/lib/local-blobs.js');
setLocalBlobsRootForTesting(ROOT);

const { handler } = await import('../../netlify/functions/admin-visual-identity-propose.js');
const { getArtifactBlobStore, getSiteObjectsBlobStore } = await import(
  '../../packages/core/server/lib/blob-store.js'
);
const { handleObjectVerb } = await import('../../packages/core/server/lib/object-verbs.js');
const { buildStoreValidationContext } = await import('../../packages/core/server/lib/object-validation-context.js');

type ObjectVerbStoreLike = Parameters<typeof handleObjectVerb>[0];
type Principal = Parameters<typeof handleObjectVerb>[2];

const HUMAN: Principal = { kind: 'human', id: 'seed-1', email: 'owner@example.com' };

const VALID_BRAND_IMAGERY = {
  version: 1,
  medium: 'photograph',
  styleSentence: 'Clinical-clean skincare editorial photography with soft studio light.',
  palette: ['#2E5C42'],
  negative: ['no stock-photo gloss'],
  aspectRatios: { article_header: '3:2' },
  seedBase: 100001,
};

const validProposal = (overrides: Record<string, unknown> = {}) => ({
  artifact: 'brand_imagery_proposal.v1',
  mode: 'template',
  brandImagery: VALID_BRAND_IMAGERY,
  rationale: "Matches the site's existing warm neutral palette.",
  sampleSubjects: ['a jar of moisturizer on a marble countertop'],
  confidence: 'high',
  label: 'Clinical clean',
  ...overrides,
});

const stubPropose = (proposal: Record<string, unknown> = validProposal()) => {
  dispatch = (name) => {
    if (name === 'visual_identity_propose') {
      return { ok: true, data: { proposal, executionId: 'exec_1', nodeId: 'brand_imagery_writer' } };
    }
    return { ok: false, code: 'cms_agent_error', message: `unexpected tool ${name}` };
  };
};

const pngBytes = (tint: number) =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: { r: tint, g: 40, b: 90 } } })
    .png()
    .toBuffer();

const seedReadableReference = async (id: string, tint: number) => {
  const bytes = await pngBytes(tint);
  const blobKey = `image/req_visref_drlurie_20260101_01/${id}-${tint}.png`;
  const artifacts = await getArtifactBlobStore({});
  await artifacts.set(blobKey, bytes, { metadata: { contentType: 'image/png' } });
  return { id, blobKey };
};

/** A blobKey nothing was ever written under — readBlobBytes resolves undefined, exactly the "unreadable" case. */
const unreadableReference = (id: string) => ({
  id,
  blobKey: `image/req_visref_drlurie_20260101_01/${id}-never-written.png`,
});

const seedStandard = async (objectId: string, references: Array<Record<string, unknown>>) => {
  const store = (await getSiteObjectsBlobStore({})) as unknown as ObjectVerbStoreLike;
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
        label: 'Propose test look',
        whenToUse: 'The fixture the A3 propose tests write onto.',
        brandImagery: VALID_BRAND_IMAGERY,
        references: references.map((reference) => ({ weight: 1, ...reference })),
        sampleSubjects: ['a woman applying serum'],
        status: 'draft',
      },
    },
    HUMAN,
    { validationContext, roles: ['owner', 'admin', 'publisher'] }
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
};

const post = (body: Record<string, unknown>, user = EDITOR) =>
  handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) }, { clientContext: { user } });

type ProposeResponseBody = {
  error?: string;
  error_code?: string;
  standard_id?: string;
  mode?: string;
  references_total?: number;
  references_resolved?: number;
  warnings?: string[];
  proposal?: Record<string, unknown>;
};

const run = async (body: Record<string, unknown>, user = EDITOR): Promise<{ status: number; body: ProposeResponseBody }> => {
  const response = await post(body, user);
  return { status: response.statusCode, body: JSON.parse(response.body) as ProposeResponseBody };
};

test('three references, one unreadable: a proposal is returned and warnings names it by ref id', async () => {
  await rm(ROOT, { recursive: true, force: true });
  calls = [];
  stubPropose();

  const one = await seedReadableReference('ref_aaa1', 10);
  const two = await seedReadableReference('ref_bbb2', 90);
  const three = unreadableReference('ref_ccc3');
  await seedStandard('vis_drlurie_propose_three', [one, two, three]);

  const { status, body } = await run({ standardId: 'vis_drlurie_propose_three' });

  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.standard_id, 'vis_drlurie_propose_three');
  assert.equal(body.references_total, 3);
  assert.equal(body.references_resolved, 2);
  assert.deepEqual(body.warnings, ['image_dropped:ref_ccc3']);
  assert.equal(body.proposal?.artifact, 'brand_imagery_proposal.v1');

  // visual_identity_propose was actually called, with exactly the 2
  // resolved images as base64 — never a url the runner would have to fetch.
  const proposeCall = calls.find((call) => call.name === 'visual_identity_propose');
  assert.ok(proposeCall, 'visual_identity_propose must have been called');
  const imageRefs = proposeCall!.args.imageRefs as Array<{ url?: string; base64?: string }>;
  assert.equal(imageRefs.length, 2);
  for (const ref of imageRefs) {
    assert.ok(ref.base64 && ref.base64.length > 0, 'every imageRef must carry base64, never a url');
    assert.equal(ref.url, undefined);
  }
});

test('zero readable references is refused as 422 no_images_reached_writer, unless a brief is supplied', async () => {
  await rm(ROOT, { recursive: true, force: true });
  calls = [];
  stubPropose();

  const references = [unreadableReference('ref_ddd4'), unreadableReference('ref_eee5')];
  await seedStandard('vis_drlurie_propose_unreadable', references);

  const withoutBrief = await run({ standardId: 'vis_drlurie_propose_unreadable' });
  assert.equal(withoutBrief.status, 422, JSON.stringify(withoutBrief.body));
  assert.equal(withoutBrief.body.error_code, 'no_images_reached_writer');
  assert.equal(
    calls.find((call) => call.name === 'visual_identity_propose'),
    undefined,
    'CMS-Agent must never be called when nothing would reach the writer'
  );

  const withBrief = await run({
    standardId: 'vis_drlurie_propose_unreadable',
    brief: 'Warm, editorial skincare photography — no illustration.',
  });
  assert.equal(withBrief.status, 200, JSON.stringify(withBrief.body));
  assert.equal(withBrief.body.references_total, 2);
  assert.equal(withBrief.body.references_resolved, 0);
  assert.deepEqual(withBrief.body.warnings?.sort(), ['image_dropped:ref_ddd4', 'image_dropped:ref_eee5']);
  assert.equal(withBrief.body.proposal?.artifact, 'brand_imagery_proposal.v1');
  assert.ok(calls.some((call) => call.name === 'visual_identity_propose'));
});

test('an editor may propose; a viewer may not, and an unauthenticated caller gets 401', async () => {
  await rm(ROOT, { recursive: true, force: true });
  calls = [];
  stubPropose();

  await seedStandard('vis_drlurie_propose_roles', [await seedReadableReference('ref_fff6', 40)]);

  const anonymous = await handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ standardId: 'vis_drlurie_propose_roles' }),
  });
  assert.equal(anonymous.statusCode, 401);

  const viewer = await run({ standardId: 'vis_drlurie_propose_roles' }, VIEWER);
  assert.equal(viewer.status, 403);
  assert.match(String(viewer.body.error), /editor or publisher/);

  const editor = await run({ standardId: 'vis_drlurie_propose_roles' });
  assert.equal(editor.status, 200, JSON.stringify(editor.body));
  assert.equal(editor.body.references_resolved, 1);
});
