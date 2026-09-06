/**
 * A1 — `admin-visual-identity-import`: the Imagery tab's "Import references"
 * button as a deterministic endpoint instead of a chat instruction.
 *
 * What these pin, with pdf-tool stubbed at its MCP boundary
 * (pdf-tool-mcp-fetch-stub.ts, the mcp-pdf-tool-image-bridge.test.ts pattern)
 * and the blob stores file-backed:
 *
 *   1. two addresses become two mood-board references with SERVER-minted
 *      `ref_` ids under a `req_visref_<site>_<yyyymmdd>_<nn>` request id, the
 *      bytes are mirrored into Platform's OWN artifact store, and
 *      `admin-get-blob-image` — which reads only that store — serves each one
 *      (the "Preview unavailable" bug, closed end to end);
 *   2. re-importing the same address resolves to the SAME blobKey and appends
 *      no second reference;
 *   3. the schema's 24-reference cap is refused in plain words, before
 *      anything is fetched.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import { handler } from '../../netlify/functions/admin-visual-identity-import.js';
import { readAdminBlobImage } from '../../netlify/functions/admin-get-blob-image.js';
import { getArtifactBlobStore, getSiteObjectsBlobStore } from '../../packages/core/server/lib/blob-store.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { handleObjectVerb, type ObjectVerbStore } from '../../packages/core/server/lib/object-verbs.js';
import { buildStoreValidationContext } from '../../packages/core/server/lib/object-validation-context.js';
import type { Principal } from '../../packages/core/schema/object-record-v1.js';
import { stubPdfToolMcp, type PdfToolMcpCall } from './pdf-tool-mcp-fetch-stub.js';

const ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'admin-visual-identity-import');
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
  process.env.PDF_TOOL_STORAGE_TOKEN = 'storage-secret-never-return';
  process.env.PDF_TOOL_STORAGE_SITE_ID = 'private-storage-site';
  process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool.test';
  process.env.PDF_TOOL_AGENT_RUN_TOKEN = 'bridge-secret-never-return';
};

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A real PNG — the mirror re-validates the bytes it stores with sharp. */
const pngBytes = (tint: number) =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: { r: tint, g: 40, b: 90 } } })
    .png()
    .toBuffer();

type ImportFixture = { url: string; blobKey: string; sha256: string; sizeBytes: number };

/**
 * What pdf-tool leaves behind: the bytes ARE in this site's artifacts store
 * (it writes there through the storage grant) but under ITS key shape — four
 * segments, which `admin-get-blob-image`'s allowlist rejects. That is exactly
 * why the endpoint mirrors instead of linking.
 */
const seedPdfToolImport = async (url: string, tint: number): Promise<ImportFixture> => {
  const bytes = await pngBytes(tint);
  const digest = sha256(bytes);
  const blobKey = `image/dr-lurie/url-import/${digest}.png`;
  const artifacts = await getArtifactBlobStore({});
  await artifacts.set(blobKey, bytes, { metadata: { contentType: 'image/png', sha256: digest } });
  return { url, blobKey, sha256: digest, sizeBytes: bytes.byteLength };
};

const stubImport = (fixtures: ImportFixture[]) => {
  const candidates = fixtures.map((fixture, index) => ({
    candidateId: `cand_url_${index + 1}`,
    state: 'kept',
    sourceUrl: fixture.url,
    artifactReference: {
      blobKey: fixture.blobKey,
      sha256: fixture.sha256,
      sizeBytes: fixture.sizeBytes,
      contentType: 'image/png',
    },
  }));
  return stubPdfToolMcp({
    import_images_from_url: (body) => ({
      status: 202,
      body: {
        jobId: 'job-url-import-1',
        status: 'pending',
        projectId: body.projectId,
        requestId: body.requestId,
        urls: body.urls,
        polling: { tool: 'get_image_search_job_status', input: { jobId: 'job-url-import-1' } },
      },
    }),
    get_image_search_job_status: (body) => ({
      body: { jobId: body.jobId, status: 'complete', result: { importedCount: candidates.length } },
    }),
    get_image_search_bank: (body) => ({
      body: { projectId: body.projectId, bank: { requestId: body.requestId, candidates } },
    }),
  });
};

const seedStandard = async (objectId: string, references: Array<Record<string, unknown>>) => {
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
        label: 'Import test look',
        whenToUse: 'The fixture the A1 import tests write onto.',
        brandImagery: {
          version: 1,
          medium: 'photograph',
          styleSentence: 'Clinical-clean skincare editorial photography with soft studio light.',
          palette: ['#2E5C42'],
          negative: ['no stock-photo gloss'],
          aspectRatios: { article_header: '3:2' },
          seedBase: 100001,
        },
        references,
        sampleSubjects: ['a woman applying serum'],
        status: 'draft',
      },
    },
    HUMAN,
    { validationContext, roles: ['owner', 'admin', 'publisher'] }
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
};

const readStandardReferences = async (objectId: string) => {
  const store = (await getSiteObjectsBlobStore({})) as unknown as ObjectVerbStore;
  const result = await handleObjectVerb(
    store,
    { action: 'get', object_type: 'visual_standard', object_id: objectId },
    HUMAN,
    { roles: ['owner', 'admin', 'publisher'] }
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const record = result.body.record as { body: { references?: Array<Record<string, unknown>> } };
  return record.body.references ?? [];
};

const post = (body: Record<string, unknown>, user = EDITOR) =>
  handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) }, { clientContext: { user } });

type ImportResponseBody = {
  error?: string;
  request_id?: string;
  references?: Array<{ id: string; blobKey: string; previewUrl?: string; sourceUrl?: string }>;
  duplicates?: Array<{ id: string; blobKey: string }>;
  failures?: Array<{ source: string; error: string }>;
  reference_count?: number;
};

const runImport = async (
  fixtures: ImportFixture[],
  body: Record<string, unknown>,
  user = EDITOR
): Promise<{ status: number; body: ImportResponseBody; calls: PdfToolMcpCall[] }> => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubImport(fixtures);
  globalThis.fetch = fetchImpl;
  try {
    const response = await post(body, user);
    return { status: response.statusCode, body: JSON.parse(response.body) as ImportResponseBody, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test('two addresses import as mood-board references whose mirrored bytes admin-get-blob-image serves', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  await seedStandard('vis_drlurie_import_two', []);

  const fixtures = [
    await seedPdfToolImport('https://images.example.com/one.jpg', 10),
    await seedPdfToolImport('https://images.example.com/two.jpg', 200),
  ];
  const { status, body, calls } = await runImport(fixtures, {
    standardId: 'vis_drlurie_import_two',
    urls: fixtures.map((fixture) => fixture.url),
    note: 'muted greens, low contrast',
  });

  assert.equal(status, 200, JSON.stringify(body));
  assert.match(String(body.request_id), /^req_visref_drlurie_\d{8}_01$/);
  assert.equal(body.references?.length, 2);
  assert.deepEqual(body.failures, []);

  // Ids are minted here, never taken from the client, and the mirrored key is
  // the canonical `image/<requestId>/<sha256>.<ext>` shape.
  for (const [index, reference] of (body.references ?? []).entries()) {
    assert.match(reference.id, /^ref_[a-z0-9]{1,8}$/);
    assert.equal(reference.blobKey, `image/${body.request_id}/${fixtures[index]?.sha256}.png`);
    assert.equal(reference.sourceUrl, fixtures[index]?.url);
    assert.match(String(reference.previewUrl), /admin-get-blob-image\?blobKey=/);
  }

  // The pdf-tool bridge was actually used — the batch import handler, then the
  // job poll, then the bank read — and its grant never came back out.
  assert.deepEqual(
    calls.map((call) => call.tool),
    ['import_images_from_url', 'get_image_search_job_status', 'get_image_search_bank']
  );
  assert.deepEqual(
    calls[0]?.body.urls,
    fixtures.map((fixture) => fixture.url)
  );
  assert.doesNotMatch(JSON.stringify(body), /storage-secret-never-return|bridge-secret-never-return/);

  // Appended to the standard through set_visual_standard_fields.
  const stored = await readStandardReferences('vis_drlurie_import_two');
  assert.equal(stored.length, 2);
  assert.deepEqual(
    stored.map((reference) => reference.blobKey),
    (body.references ?? []).map((reference) => reference.blobKey)
  );
  assert.equal(stored[0]?.note, 'muted greens, low contrast');

  // The bytes are in Platform's own artifact store, and the identity-gated
  // image endpoint serves them — what the chat path could never achieve.
  const artifacts = await getArtifactBlobStore({});
  for (const reference of body.references ?? []) {
    const mirrored = (await (
      artifacts as unknown as { get: (key: string, options: { type: 'arrayBuffer' }) => Promise<ArrayBuffer | null> }
    ).get(reference.blobKey, { type: 'arrayBuffer' })) as ArrayBuffer | null;
    assert.ok(mirrored, `${reference.blobKey} must exist in the artifacts store`);

    const served = await readAdminBlobImage({ queryStringParameters: {} }, reference.blobKey);
    assert.equal(served.statusCode, 200, JSON.stringify(served.body).slice(0, 200));
    assert.equal(served.headers?.['Content-Type'], 'image/png');
  }
});

test('re-importing the same address resolves to the same blobKey and appends no second reference', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  await seedStandard('vis_drlurie_import_dupe', []);

  const fixtures = [await seedPdfToolImport('https://images.example.com/same.jpg', 64)];
  const first = await runImport(fixtures, { standardId: 'vis_drlurie_import_dupe', urls: [fixtures[0]!.url] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.references?.length, 1);
  const firstBlobKey = first.body.references?.[0]?.blobKey;

  const second = await runImport(fixtures, { standardId: 'vis_drlurie_import_dupe', urls: [fixtures[0]!.url] });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.references?.length, 0);
  assert.equal(second.body.duplicates?.length, 1);
  // Same bytes ⇒ same blobKey, even though the second import minted its own
  // request id — identity comes from the sha256, not from the request.
  assert.equal(second.body.duplicates?.[0]?.blobKey, firstBlobKey);
  assert.match(String(second.body.request_id), /^req_visref_drlurie_\d{8}_02$/);

  const stored = await readStandardReferences('vis_drlurie_import_dupe');
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.blobKey, firstBlobKey);
});

test('the 24-reference cap is refused in plain words, before anything is fetched', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  const full = Array.from({ length: 24 }, (_, index) => ({
    id: `ref_seed${String(index).padStart(4, '0')}`,
    blobKey: `image/req_visref_drlurie_20260101_01/${String(index).padStart(64, '0')}.png`,
    weight: 1,
  }));
  await seedStandard('vis_drlurie_import_full', full);

  const fixtures = [await seedPdfToolImport('https://images.example.com/twenty-five.jpg', 128)];
  const { status, body, calls } = await runImport(fixtures, {
    standardId: 'vis_drlurie_import_full',
    urls: [fixtures[0]!.url],
  });

  assert.equal(status, 409, JSON.stringify(body));
  assert.match(String(body.error), /maximum of 24 references/i);
  assert.match(String(body.error), /Remove one before importing another/i);
  assert.equal(calls.length, 0, 'nothing may be fetched once the board is full');
  assert.equal((await readStandardReferences('vis_drlurie_import_full')).length, 24);
});

test('an editor may import; a viewer may not, and an unauthenticated caller gets 401', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  await seedStandard('vis_drlurie_import_roles', []);

  const anonymous = await handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ standardId: 'vis_drlurie_import_roles', urls: ['https://images.example.com/a.jpg'] }),
  });
  assert.equal(anonymous.statusCode, 401);

  const viewer = await runImport(
    [],
    { standardId: 'vis_drlurie_import_roles', urls: ['https://images.example.com/a.jpg'] },
    VIEWER
  );
  assert.equal(viewer.status, 403);
  assert.match(String(viewer.body.error), /editor or publisher/);
  assert.equal(viewer.calls.length, 0);

  const fixtures = [await seedPdfToolImport('https://images.example.com/editor.jpg', 32)];
  const editor = await runImport(fixtures, {
    standardId: 'vis_drlurie_import_roles',
    urls: [fixtures[0]!.url],
  });
  assert.equal(editor.status, 200, JSON.stringify(editor.body));
  assert.equal(editor.body.references?.length, 1);
});

// ─── W5 review fixes ─────────────────────────────────────────────────────────

/** A writer that lands WHILE the import is in flight — a second tab saving the
 *  mood board, or the agent doing it. checkout → patch → checkin, exactly what
 *  the browser's EditSession does. */
const appendReferenceConcurrently = async (objectId: string, reference: Record<string, unknown>) => {
  const store = (await getSiteObjectsBlobStore({})) as unknown as ObjectVerbStore;
  const before = await readStandardReferences(objectId);
  const checkout = await handleObjectVerb(
    store,
    { action: 'checkout', object_type: 'visual_standard', object_id: objectId, lease_seconds: 300 },
    HUMAN,
    { roles: ['owner', 'admin', 'publisher'] }
  );
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
  const lockToken = checkout.body.lockToken as string;
  const patch = await handleObjectVerb(
    store,
    {
      action: 'patch',
      object_type: 'visual_standard',
      object_id: objectId,
      lock_token: lockToken,
      expected_record_version: checkout.body.record_version as number,
      ops: [{ op: 'set_visual_standard_fields', fields: { references: [...before, reference] } }],
    },
    HUMAN,
    { roles: ['owner', 'admin', 'publisher'], validationContext: await buildStoreValidationContext(store) }
  );
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  await handleObjectVerb(
    store,
    { action: 'checkin', object_type: 'visual_standard', object_id: objectId, lock_token: lockToken },
    HUMAN,
    { roles: ['owner', 'admin', 'publisher'] }
  );
};

const runImportWith = async (
  fixtures: ImportFixture[],
  body: Record<string, unknown>,
  onFirstCall: () => Promise<void>
): Promise<{ status: number; body: ImportResponseBody }> => {
  const originalFetch = globalThis.fetch;
  const { fetchImpl } = stubImport(fixtures);
  let fired = false;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    if (!fired) {
      fired = true;
      await onFirstCall();
    }
    return (fetchImpl as typeof fetch)(...args);
  }) as typeof fetch;
  try {
    const response = await post(body);
    return { status: response.statusCode, body: JSON.parse(response.body) as ImportResponseBody };
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test('W5 F4: a reference written while the import is in flight survives the append', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  await seedStandard('vis_drlurie_import_race', []);

  const fixtures = [await seedPdfToolImport('https://images.example.com/race.jpg', 77)];
  const meanwhile = {
    id: 'ref_meanwhile',
    blobKey: `image/req_visref_drlurie_20260101_09/${'a'.repeat(64)}.png`,
    weight: 1,
  };

  // The endpoint reads references[] BEFORE it calls pdf-tool; this write lands
  // in that window. Patching with the pre-import snapshot would erase it.
  const { status, body } = await runImportWith(
    fixtures,
    { standardId: 'vis_drlurie_import_race', urls: [fixtures[0]!.url] },
    () => appendReferenceConcurrently('vis_drlurie_import_race', meanwhile)
  );

  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.references?.length, 1);
  assert.equal(body.reference_count, 2);

  const stored = await readStandardReferences('vis_drlurie_import_race');
  assert.deepEqual(
    stored.map((reference) => reference.id).sort(),
    ['ref_meanwhile', String(body.references?.[0]?.id)].sort(),
    'the concurrent reference must still be on the board next to the imported one'
  );
});

test('W5 F8: an oversized image is bounded to the upload ceiling before it is stored', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  await seedStandard('vis_drlurie_import_big', []);

  const huge = await sharp({ create: { width: 4000, height: 1000, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .png()
    .toBuffer();
  const digest = sha256(huge);
  const sourceKey = `image/dr-lurie/url-import/${digest}.png`;
  const artifacts = await getArtifactBlobStore({});
  await artifacts.set(sourceKey, huge, { metadata: { contentType: 'image/png', sha256: digest } });

  const { status, body } = await runImport(
    [{ url: 'https://images.example.com/huge.png', blobKey: sourceKey, sha256: digest, sizeBytes: huge.byteLength }],
    { standardId: 'vis_drlurie_import_big', urls: ['https://images.example.com/huge.png'] }
  );

  assert.equal(status, 200, JSON.stringify(body));
  const blobKey = String(body.references?.[0]?.blobKey);
  // The stored key is content-addressed on the BOUNDED bytes, so it cannot be
  // the source digest any more.
  assert.doesNotMatch(blobKey, new RegExp(digest), 'the mirror must not store the unbounded original');

  const storedRaw = (await (
    artifacts as unknown as { get: (key: string, options: { type: 'arrayBuffer' }) => Promise<ArrayBuffer | null> }
  ).get(blobKey, { type: 'arrayBuffer' })) as ArrayBuffer | null;
  assert.ok(storedRaw);
  const metadata = await sharp(Buffer.from(storedRaw)).metadata();
  assert.equal(metadata.width, 2048, 'the longest edge is bounded exactly as the upload endpoint bounds it');
  assert.equal(metadata.height, 512);
});

test('W5 F9: an unreadable candidate names the store and key, and a batch that mirrors nothing is a 502', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  await seedStandard('vis_drlurie_import_missing', []);

  // pdf-tool reports a key Platform cannot read out of its own artifacts store
  // — the exact shape the "is the mirror even looking in the right store?"
  // assumption fails in.
  const missingKey = `image/dr-lurie/url-import/${'b'.repeat(64)}.png`;
  const { status, body } = await runImport(
    [
      {
        url: 'https://images.example.com/missing.png',
        blobKey: missingKey,
        sha256: 'b'.repeat(64),
        sizeBytes: 1234,
      },
    ],
    { standardId: 'vis_drlurie_import_missing', urls: ['https://images.example.com/missing.png'] }
  );

  assert.equal(status, 502, JSON.stringify(body));
  assert.match(String(body.error), new RegExp(missingKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(String(body.error), /artifacts store/);
  assert.equal(body.failures?.length, 1);
  assert.equal((await readStandardReferences('vis_drlurie_import_missing')).length, 0);
});
