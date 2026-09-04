import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import artifactUploadHandler from '../../netlify/functions/artifact-upload.js';
import { handler as mcpHandler } from '../../netlify/functions/mcp.js';
import { ArtifactKind } from '../../packages/core/server/lib/artifacts.js';
import {
  createArtifactUploadToken,
  saveArtifactBytes,
  verifyArtifactUploadToken,
} from '../../packages/core/server/lib/artifact-upload.js';
import {
  getArtifactBlobStore,
  getArtifactIndexBlobStore,
  setNetlifyBlobsModuleForTesting,
} from '../../packages/core/server/lib/blob-store.js';
import { sha256Hex } from '../../packages/core/server/lib/crypto.js';

type FakeStoreValue = Buffer | string;

const createFakeStore = (values = new Map<string, FakeStoreValue>()) => ({
  values,
  store: {
    async set(key: string, value: string | Buffer | Uint8Array, options?: { onlyIfNew?: boolean }) {
      if (options?.onlyIfNew && values.has(key)) return { modified: false };
      values.set(key, typeof value === 'string' ? value : Buffer.from(value));
      return { modified: true };
    },
    async setJSON(key: string, value: unknown) {
      values.set(key, JSON.stringify(value));
      return { modified: true };
    },
    async get(key: string, options?: { type?: 'arrayBuffer' }) {
      const value = values.get(key);
      if (value === undefined) return null;
      if (options?.type === 'arrayBuffer') {
        const bytes = typeof value === 'string' ? Buffer.from(value) : value;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      }
      return typeof value === 'string' ? value : value.toString('utf8');
    },
    async del(key: string) {
      values.delete(key);
    },
    async list() {
      return { blobs: Array.from(values.keys()).map((key) => ({ key, etag: '' })), directories: [] };
    },
  },
});

const withBlobStores = async (
  fn: (stores: {
    artifactValues: Map<string, FakeStoreValue>;
    indexValues: Map<string, FakeStoreValue>;
  }) => Promise<void>
) => {
  const previousNetlify = process.env.NETLIFY;
  const previousSiteId = process.env.NETLIFY_SITE_ID;
  const { values: artifactValues, store: artifactStore } = createFakeStore();
  const { values: indexValues, store: indexStore } = createFakeStore();

  process.env.NETLIFY = 'true';
  process.env.NETLIFY_SITE_ID = '';
  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore(input) {
      const storeName = typeof input === 'string' ? input : input.name;
      if (storeName === 'artifacts') {
        return artifactStore as ReturnType<typeof getArtifactBlobStore> extends Promise<infer Store> ? Store : never;
      }
      if (storeName === 'artifact-index') {
        return indexStore as ReturnType<typeof getArtifactIndexBlobStore> extends Promise<infer Store> ? Store : never;
      }
      throw new Error(`Unexpected blob store: ${storeName}`);
    },
  });

  try {
    await fn({ artifactValues, indexValues });
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
    if (previousNetlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = previousNetlify;
    if (previousSiteId === undefined) delete process.env.NETLIFY_SITE_ID;
    else process.env.NETLIFY_SITE_ID = previousSiteId;
  }
};

test('artifact upload tokens validate strict signed claims and expiration', () => {
  const bytes = Buffer.from('direct artifact token');
  const token = createArtifactUploadToken(
    {
      requestId: 'req_direct_upload_token_20260630_01',
      artifactKind: ArtifactKind.Data,
      contentType: 'application/octet-stream',
      filename: 'payload.bin',
      label: 'Direct token',
      tags: ['direct', 'signed'],
      expectedSizeBytes: bytes.byteLength,
      expectedSha256: sha256Hex(bytes),
      expiresAt: 2_000,
    },
    'artifact-token-secret'
  );

  const valid = verifyArtifactUploadToken({ token, nowMs: 1_000, secret: 'artifact-token-secret' });
  assert.equal(valid.ok, true);
  assert.equal(valid.ok ? valid.claims.requestId : '', 'req_direct_upload_token_20260630_01');
  assert.equal(valid.ok ? valid.claims.label : '', 'Direct token');
  assert.deepEqual(valid.ok ? valid.claims.tags : [], ['direct', 'signed']);

  assert.deepEqual(verifyArtifactUploadToken({ token, nowMs: 2_001, secret: 'artifact-token-secret' }), {
    ok: false,
    statusCode: 401,
    error: 'Artifact upload token has expired.',
  });
  assert.deepEqual(verifyArtifactUploadToken({ token: `${token}x`, nowMs: 1_000, secret: 'artifact-token-secret' }), {
    ok: false,
    statusCode: 401,
    error: 'Invalid artifact upload token.',
  });
});

test('saveArtifactBytes writes final bytes and retained artifact indexes idempotently', async () => {
  await withBlobStores(async ({ artifactValues, indexValues }) => {
    const bytes = Buffer.from('%PDF-1.7\nminimal pdf bytes');
    const expectedSha256 = sha256Hex(bytes);
    const input = {
      requestId: 'req_direct_upload_request_20260630_01',
      artifactKind: ArtifactKind.Pdf,
      contentType: 'application/pdf',
      filename: 'paper.pdf',
      label: 'Paper PDF',
      tags: ['paper'],
      metadata: { source: 'direct-test' },
      expectedSizeBytes: bytes.byteLength,
      expectedSha256,
      bytes,
    };

    const result = await saveArtifactBytes(input);
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.deduped : true, false);

    const artifact = result.ok ? result.artifact : undefined;
    assert.ok(artifact);
    assert.equal(artifact.blobKey, `pdf/req_direct_upload_request_20260630_01/${expectedSha256}.pdf`);
    assert.equal(artifact.label, 'Paper PDF');
    assert.deepEqual(artifact.metadata, { source: 'direct-test' });
    assert.equal(Buffer.isBuffer(artifactValues.get(artifact.blobKey)), true);
    assert.deepEqual(
      JSON.parse(
        indexValues.get(`request-artifacts/req_direct_upload_request_20260630_01/${expectedSha256}.json`) as string
      ),
      artifact
    );
    assert.deepEqual(JSON.parse(indexValues.get(`by-kind/pdf/${expectedSha256}.json`) as string), {
      requestId: 'req_direct_upload_request_20260630_01',
      sha256: expectedSha256,
      artifactKind: 'pdf',
    });
    assert.deepEqual(
      JSON.parse(
        indexValues.get(`by-request/req_direct_upload_request_20260630_01/pdf/${expectedSha256}.json`) as string
      ),
      {
        requestId: 'req_direct_upload_request_20260630_01',
        sha256: expectedSha256,
        artifactKind: 'pdf',
      }
    );
    assert.deepEqual(JSON.parse(indexValues.get(`by-tag/paper/${expectedSha256}.json`) as string), {
      requestId: 'req_direct_upload_request_20260630_01',
      sha256: expectedSha256,
      artifactKind: 'pdf',
    });

    const duplicate = await saveArtifactBytes(input);
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.ok ? duplicate.deduped : false, true);
    assert.deepEqual(duplicate.ok ? duplicate.artifact : undefined, artifact);
  });
});

test('saveArtifactBytes rejects integrity mismatches and invalid PDFs before writing', async () => {
  await withBlobStores(async ({ artifactValues, indexValues }) => {
    const bytes = Buffer.from('not a pdf');
    const sizeMismatch = await saveArtifactBytes({
      requestId: 'req_direct_invalid_size_20260630_01',
      artifactKind: ArtifactKind.Data,
      contentType: 'application/octet-stream',
      expectedSizeBytes: bytes.byteLength + 1,
      expectedSha256: sha256Hex(bytes),
      bytes,
    });
    assert.equal(sizeMismatch.ok, false);
    assert.equal(sizeMismatch.ok ? 0 : sizeMismatch.statusCode, 400);

    const invalidPdf = await saveArtifactBytes({
      requestId: 'req_direct_invalid_pdf_20260630_01',
      artifactKind: ArtifactKind.Pdf,
      contentType: 'application/pdf',
      filename: 'bad.pdf',
      expectedSizeBytes: bytes.byteLength,
      expectedSha256: sha256Hex(bytes),
      bytes,
    });
    assert.deepEqual(invalidPdf, {
      ok: false,
      statusCode: 400,
      error: 'Invalid PDF artifact: bytes must start with %PDF-.',
    });
    assert.equal(artifactValues.size, 0);
    assert.equal(indexValues.size, 0);
  });
});

const makeDirectUploadRequest = ({
  bytes,
  token,
  headers = {},
  method = 'POST',
  contentLength,
}: {
  bytes?: Buffer;
  token?: string;
  headers?: Record<string, string>;
  method?: string;
  contentLength?: string;
}) =>
  new Request('https://example.com/api/artifacts/upload', {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/octet-stream',
      ...(contentLength !== undefined
        ? { 'content-length': contentLength }
        : bytes
          ? { 'content-length': String(bytes.byteLength) }
          : {}),
      ...headers,
    },
    body: method === 'POST' ? (bytes ?? Buffer.alloc(0)) : undefined,
  });

const parseJsonResponse = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as Record<string, unknown>,
});

test('artifact-upload function accepts raw binary POSTs and returns ArtifactReference JSON', async () => {
  await withBlobStores(async ({ indexValues }) => {
    const previousSecret = process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
    const bytes = Buffer.from('%PDF-1.7\ndirect function pdf');
    const expectedSha256 = sha256Hex(bytes);
    process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = 'direct-function-secret';

    try {
      const token = createArtifactUploadToken({
        requestId: 'req_function_direct_request_20260630_01',
        artifactKind: ArtifactKind.Pdf,
        contentType: 'application/pdf',
        filename: 'function.pdf',
        label: 'Function PDF',
        tags: ['function'],
        expectedSizeBytes: bytes.byteLength,
        expectedSha256,
        expiresAt: Date.now() + 60_000,
      });
      const response = await parseJsonResponse(
        await artifactUploadHandler(
          makeDirectUploadRequest({
            bytes,
            token,
            headers: {
              'x-artifact-request-id': 'req_function_direct_request_20260630_01',
              'x-artifact-kind': 'pdf',
              'x-artifact-content-type': 'application/pdf',
              'x-artifact-size': String(bytes.byteLength),
              'x-artifact-sha256': expectedSha256,
              'x-artifact-filename': 'function.pdf',
              'x-artifact-tags': 'function',
            },
          })
        )
      );

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.deduped, false);
      const artifact = response.body.artifact as { blobKey: string; sha256: string; label?: string };
      assert.equal(artifact.blobKey, `pdf/req_function_direct_request_20260630_01/${expectedSha256}.pdf`);
      assert.equal(artifact.sha256, expectedSha256);
      assert.equal(artifact.label, 'Function PDF');
      assert.equal(response.body.maxBytes, 5_000_000);
      assert.equal(
        indexValues.has(`request-artifacts/req_function_direct_request_20260630_01/${expectedSha256}.json`),
        true
      );
    } finally {
      if (previousSecret === undefined) delete process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
      else process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = previousSecret;
    }
  });
});

test('create_artifact_upload_intent plus artifact-upload handler chain correctly', async () => {
  await withBlobStores(async ({ artifactValues, indexValues }) => {
    const previousSecret = process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
    const bytes = Buffer.from('%PDF-1.7\ncontract test pdf');
    const expectedSha256 = sha256Hex(bytes);
    process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = 'chain-test-secret';
    process.env.NETLIFY_PUBLISH_SECRET = 'chain-publish-secret';

    try {
      // 1. Create intent via MCP
      const intentResponse = await mcpHandler({
        httpMethod: 'POST',
        headers: { 'content-type': 'application/json', 'x-publish-key': 'chain-publish-secret' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'create_artifact_upload_intent',
            arguments: {
              requestId: 'req_chain_request_20260630_01',
              artifactKind: 'pdf',
              contentType: 'application/pdf',
              expectedSizeBytes: bytes.byteLength,
              expectedSha256,
              filename: 'chain.pdf',
              label: 'Chain PDF',
            },
          },
        }),
      });
      const intentResult = JSON.parse(intentResponse.body).result as {
        structuredContent: {
          uploadUrl: string;
          requiredHeaders: Record<string, string>;
        };
      };

      assert.equal(intentResponse.statusCode, 200);
      assert.ok(intentResult.structuredContent.uploadUrl);
      assert.ok(intentResult.structuredContent.requiredHeaders);

      // 2. Upload using returned requiredHeaders
      const uploadHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(intentResult.structuredContent.requiredHeaders)) {
        uploadHeaders[key.toLowerCase()] = value;
      }

      const uploadResponse = await parseJsonResponse(
        await artifactUploadHandler(
          makeDirectUploadRequest({
            bytes,
            headers: uploadHeaders,
          })
        )
      );

      assert.equal(uploadResponse.status, 200);
      assert.equal(uploadResponse.body.ok, true);
      const artifact = uploadResponse.body.artifact as { blobKey: string; sha256: string };
      assert.equal(artifact.sha256, expectedSha256);
      assert.equal(artifactValues.has(artifact.blobKey), true);
      assert.equal(indexValues.has(`request-artifacts/req_chain_request_20260630_01/${expectedSha256}.json`), true);
    } finally {
      if (previousSecret === undefined) delete process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
      else process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = previousSecret;
      delete process.env.NETLIFY_PUBLISH_SECRET;
    }
  });
});

test('artifact-upload function rejects missing auth, wrong transport, and scoped header mismatches', async () => {
  const bytes = Buffer.from('%PDF-1.7\nscoped pdf');
  const expectedSha256 = sha256Hex(bytes);
  const previousSecret = process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
  process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = 'direct-function-secret';

  try {
    const token = createArtifactUploadToken({
      requestId: 'req_function_scope_request_20260630_01',
      artifactKind: ArtifactKind.Pdf,
      contentType: 'application/pdf',
      expectedSizeBytes: bytes.byteLength,
      expectedSha256,
      expiresAt: Date.now() + 60_000,
    });
    const scopedHeaders = {
      'x-artifact-request-id': 'req_function_scope_request_20260630_01',
      'x-artifact-kind': 'pdf',
      'x-artifact-content-type': 'application/pdf',
      'x-artifact-size': String(bytes.byteLength),
      'x-artifact-sha256': expectedSha256,
    };

    assert.deepEqual(
      await parseJsonResponse(await artifactUploadHandler(makeDirectUploadRequest({ bytes, headers: scopedHeaders }))),
      {
        status: 401,
        body: { ok: false, error: 'Missing bearer upload token.', maxBytes: 5_000_000 },
      }
    );

    assert.deepEqual(
      await parseJsonResponse(
        await artifactUploadHandler(
          makeDirectUploadRequest({ bytes, token, headers: { ...scopedHeaders, 'content-type': 'application/json' } })
        )
      ),
      {
        status: 415,
        body: {
          ok: false,
          error: 'Wrong transport content type; use application/octet-stream.',
          maxBytes: 5_000_000,
        },
      }
    );

    assert.deepEqual(
      await parseJsonResponse(
        await artifactUploadHandler(
          makeDirectUploadRequest({
            bytes,
            token,
            headers: { ...scopedHeaders, 'x-artifact-request-id': 'req_different_request_20260630_01' },
          })
        )
      ),
      {
        status: 403,
        body: { ok: false, error: 'Upload token does not match artifact headers.', maxBytes: 5_000_000 },
      }
    );
  } finally {
    if (previousSecret === undefined) delete process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
    else process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = previousSecret;
  }
});

test('artifact-upload function rejects oversized payloads before saveArtifactBytes', async () => {
  const previousSecret = process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
  const previousMaxBytes = process.env.ARTIFACT_UPLOAD_MAX_BYTES;
  const bytes = Buffer.from('%PDF-1.7\ntoo large');
  const expectedSha256 = sha256Hex(bytes);
  process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = 'direct-function-secret';
  process.env.ARTIFACT_UPLOAD_MAX_BYTES = '5';

  try {
    const token = createArtifactUploadToken({
      requestId: 'req_function_large_request_20260630_01',
      artifactKind: ArtifactKind.Pdf,
      contentType: 'application/pdf',
      expectedSizeBytes: bytes.byteLength,
      expectedSha256,
      expiresAt: Date.now() + 60_000,
    });

    assert.deepEqual(
      await parseJsonResponse(
        await artifactUploadHandler(
          makeDirectUploadRequest({
            bytes,
            token,
            headers: {
              'x-artifact-request-id': 'req_function_large_request_20260630_01',
              'x-artifact-kind': 'pdf',
              'x-artifact-content-type': 'application/pdf',
              'x-artifact-size': String(bytes.byteLength),
              'x-artifact-sha256': expectedSha256,
            },
          })
        )
      ),
      { status: 413, body: { ok: false, error: 'Payload too large.', maxBytes: 5 } }
    );
  } finally {
    if (previousSecret === undefined) delete process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
    else process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = previousSecret;
    if (previousMaxBytes === undefined) delete process.env.ARTIFACT_UPLOAD_MAX_BYTES;
    else process.env.ARTIFACT_UPLOAD_MAX_BYTES = previousMaxBytes;
  }
});

const createTinyPng = () =>
  sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 20, g: 40, b: 60, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

test('artifact-upload function stores valid PNG bytes and writes all artifact indexes', async () => {
  await withBlobStores(async ({ artifactValues, indexValues }) => {
    const previousSecret = process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
    const bytes = await createTinyPng();
    const expectedSha256 = sha256Hex(bytes);
    process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = 'direct-function-secret';

    try {
      const token = createArtifactUploadToken({
        requestId: 'req_function_image_request_20260630_01',
        artifactKind: ArtifactKind.Image,
        contentType: 'image/png',
        filename: 'hero.png',
        label: 'Hero PNG',
        tags: ['hero', 'png'],
        expectedSizeBytes: bytes.byteLength,
        expectedSha256,
        expiresAt: Date.now() + 60_000,
      });

      const response = await parseJsonResponse(
        await artifactUploadHandler(
          makeDirectUploadRequest({
            bytes,
            token,
            headers: {
              'x-artifact-request-id': 'req_function_image_request_20260630_01',
              'x-artifact-kind': 'image',
              'x-artifact-content-type': 'IMAGE/PNG; charset=utf-8',
              'x-artifact-size': String(bytes.byteLength),
              'x-artifact-sha256': expectedSha256.toUpperCase(),
              'x-artifact-filename': 'hero.png',
              'x-artifact-tags': 'hero,png',
            },
          })
        )
      );

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      const artifact = response.body.artifact as {
        artifactKind: string;
        blobKey: string;
        contentType: string;
        label: string;
      };
      assert.equal(artifact.artifactKind, 'image');
      assert.equal(artifact.blobKey, `image/req_function_image_request_20260630_01/${expectedSha256}.png`);
      assert.equal(artifact.contentType, 'image/png');
      assert.equal(artifact.label, 'Hero PNG');
      assert.deepEqual(artifactValues.get(artifact.blobKey), bytes);
      assert.deepEqual(
        JSON.parse(
          indexValues.get(`request-artifacts/req_function_image_request_20260630_01/${expectedSha256}.json`) as string
        ),
        artifact
      );
      assert.deepEqual(
        JSON.parse(
          indexValues.get(`by-request/req_function_image_request_20260630_01/image/${expectedSha256}.json`) as string
        ),
        {
          requestId: 'req_function_image_request_20260630_01',
          sha256: expectedSha256,
          artifactKind: 'image',
        }
      );
      assert.deepEqual(JSON.parse(indexValues.get(`by-kind/image/${expectedSha256}.json`) as string), {
        requestId: 'req_function_image_request_20260630_01',
        sha256: expectedSha256,
        artifactKind: 'image',
      });
      assert.deepEqual(JSON.parse(indexValues.get(`by-tag/hero/${expectedSha256}.json`) as string), {
        requestId: 'req_function_image_request_20260630_01',
        sha256: expectedSha256,
        artifactKind: 'image',
      });
    } finally {
      if (previousSecret === undefined) delete process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
      else process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = previousSecret;
    }
  });
});

test('artifact-upload function rejects invalid image bytes without writing blobs or indexes', async () => {
  await withBlobStores(async ({ artifactValues, indexValues }) => {
    const previousSecret = process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
    const bytes = Buffer.from('not an image');
    const expectedSha256 = sha256Hex(bytes);
    process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = 'direct-function-secret';

    try {
      const token = createArtifactUploadToken({
        requestId: 'req_function_invalid_image_request_20260630_01',
        artifactKind: ArtifactKind.Image,
        contentType: 'image/png',
        filename: 'bad.png',
        expectedSizeBytes: bytes.byteLength,
        expectedSha256,
        expiresAt: Date.now() + 60_000,
      });

      const response = await parseJsonResponse(
        await artifactUploadHandler(
          makeDirectUploadRequest({
            bytes,
            token,
            headers: {
              'x-artifact-request-id': 'req_function_invalid_image_request_20260630_01',
              'x-artifact-kind': 'image',
              'x-artifact-content-type': 'image/png',
              'x-artifact-size': String(bytes.byteLength),
              'x-artifact-sha256': expectedSha256,
              'x-artifact-filename': 'bad.png',
            },
          })
        )
      );

      assert.equal(response.status, 400);
      assert.match(String(response.body.error), /Invalid image artifact/);
      assert.equal(artifactValues.size, 0);
      assert.equal(indexValues.size, 0);
    } finally {
      if (previousSecret === undefined) delete process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
      else process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = previousSecret;
    }
  });
});

test('artifact-upload function returns stable JSON errors for token and integrity failures', async () => {
  await withBlobStores(async ({ artifactValues, indexValues }) => {
    const previousSecret = process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
    const bytes = Buffer.from('%PDF-1.7\nstable errors');
    const expectedSha256 = sha256Hex(bytes);
    process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = 'direct-function-secret';

    try {
      const validToken = createArtifactUploadToken({
        requestId: 'req_function_error_request_20260630_01',
        artifactKind: ArtifactKind.Pdf,
        contentType: 'application/pdf',
        expectedSizeBytes: bytes.byteLength,
        expectedSha256,
        expiresAt: Date.now() + 60_000,
      });
      const expiredToken = createArtifactUploadToken({
        requestId: 'req_function_error_request_20260630_01',
        artifactKind: ArtifactKind.Pdf,
        contentType: 'application/pdf',
        expectedSizeBytes: bytes.byteLength,
        expectedSha256,
        expiresAt: Date.now() - 1,
      });
      const headers = {
        'x-artifact-request-id': 'req_function_error_request_20260630_01',
        'x-artifact-kind': 'pdf',
        'x-artifact-content-type': 'application/pdf',
        'x-artifact-size': String(bytes.byteLength),
        'x-artifact-sha256': expectedSha256,
      };

      assert.deepEqual(
        await parseJsonResponse(
          await artifactUploadHandler(makeDirectUploadRequest({ bytes, token: 'not-a-token', headers }))
        ),
        { status: 401, body: { ok: false, error: 'Invalid artifact upload token.', maxBytes: 5_000_000 } }
      );
      assert.deepEqual(
        await parseJsonResponse(
          await artifactUploadHandler(makeDirectUploadRequest({ bytes, token: expiredToken, headers }))
        ),
        { status: 401, body: { ok: false, error: 'Artifact upload token has expired.', maxBytes: 5_000_000 } }
      );
      assert.deepEqual(
        await parseJsonResponse(
          await artifactUploadHandler(
            makeDirectUploadRequest({ bytes, token: validToken, headers, contentLength: 'NaN' })
          )
        ),
        { status: 400, body: { ok: false, error: 'Invalid Content-Length header.', maxBytes: 5_000_000 } }
      );
      assert.deepEqual(
        await parseJsonResponse(
          await artifactUploadHandler(
            makeDirectUploadRequest({ bytes, token: validToken, headers, contentLength: '1' })
          )
        ),
        {
          status: 400,
          body: {
            ok: false,
            error: `Content-Length 1 does not match expected artifact size ${bytes.byteLength}.`,
            maxBytes: 5_000_000,
          },
        }
      );

      const wrongShaToken = createArtifactUploadToken({
        requestId: 'req_function_sha_error_request_20260630_01',
        artifactKind: ArtifactKind.Pdf,
        contentType: 'application/pdf',
        expectedSizeBytes: bytes.byteLength,
        expectedSha256: 'b'.repeat(64),
        expiresAt: Date.now() + 60_000,
      });
      const shaMismatchResponse = await parseJsonResponse(
        await artifactUploadHandler(
          makeDirectUploadRequest({
            bytes,
            token: wrongShaToken,
            headers: {
              ...headers,
              'x-artifact-request-id': 'req_function_sha_error_request_20260630_01',
              'x-artifact-sha256': 'b'.repeat(64),
            },
          })
        )
      );
      assert.equal(shaMismatchResponse.status, 400);
      assert.match(String(shaMismatchResponse.body.error), /Artifact sha256 mismatch/);
      assert.equal(artifactValues.size, 0);
      assert.equal(indexValues.size, 0);
    } finally {
      if (previousSecret === undefined) delete process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
      else process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = previousSecret;
    }
  });
});

const createLargeJpeg = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30, g: 90, b: 180 },
    },
  })
    .jpeg()
    .toBuffer();

test('artifact-upload function bounds an oversized image longest edge before storing, preserving aspect ratio', async () => {
  await withBlobStores(async ({ artifactValues }) => {
    const previousSecret = process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
    const previousDimensionPx = process.env.ARTIFACT_UPLOAD_MAX_IMAGE_DIMENSION_PX;
    // Uploaded bytes are what the client actually sent — the token and headers
    // must match THESE (headersMatchClaims validates the upload as received),
    // not the bounded bytes the endpoint goes on to store.
    const bytes = await createLargeJpeg(3000, 1500);
    const expectedSha256 = sha256Hex(bytes);
    process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = 'direct-function-secret';
    delete process.env.ARTIFACT_UPLOAD_MAX_IMAGE_DIMENSION_PX; // exercise the 2048px default

    try {
      const token = createArtifactUploadToken({
        requestId: 'req_function_oversized_image_20260630_01',
        artifactKind: ArtifactKind.Image,
        contentType: 'image/jpeg',
        filename: 'huge.jpg',
        expectedSizeBytes: bytes.byteLength,
        expectedSha256,
        expiresAt: Date.now() + 60_000,
      });

      const response = await parseJsonResponse(
        await artifactUploadHandler(
          makeDirectUploadRequest({
            bytes,
            token,
            headers: {
              'x-artifact-request-id': 'req_function_oversized_image_20260630_01',
              'x-artifact-kind': 'image',
              'x-artifact-content-type': 'image/jpeg',
              'x-artifact-size': String(bytes.byteLength),
              'x-artifact-sha256': expectedSha256,
              'x-artifact-filename': 'huge.jpg',
            },
          })
        )
      );

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      const artifact = response.body.artifact as { blobKey: string; sha256: string; sizeBytes: number };

      // Stored artifact is NOT the uploaded bytes' own hash/size — proof the
      // endpoint actually bounded it rather than storing the original.
      assert.notEqual(artifact.sha256, expectedSha256);
      assert.ok(artifact.sizeBytes < bytes.byteLength);

      const storedBytes = artifactValues.get(artifact.blobKey) as Buffer;
      assert.ok(Buffer.isBuffer(storedBytes));
      const storedMetadata = await sharp(storedBytes).metadata();
      assert.equal(storedMetadata.width, 2048);
      assert.equal(storedMetadata.height, 1024); // 3000x1500 (2:1) bounded to 2048x1024 — aspect ratio preserved
      assert.equal(storedMetadata.format, 'jpeg'); // format unchanged, never converted
      assert.equal(Math.max(storedMetadata.width!, storedMetadata.height!), 2048);
    } finally {
      if (previousSecret === undefined) delete process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
      else process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = previousSecret;
      if (previousDimensionPx === undefined) delete process.env.ARTIFACT_UPLOAD_MAX_IMAGE_DIMENSION_PX;
      else process.env.ARTIFACT_UPLOAD_MAX_IMAGE_DIMENSION_PX = previousDimensionPx;
    }
  });
});

test('artifact-upload function still rejects an oversize payload with the same 413 status once the dimension bound sits next to the byte cap', async () => {
  const previousSecret = process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
  const previousMaxBytes = process.env.ARTIFACT_UPLOAD_MAX_BYTES;
  // A small-dimension image (so the new resize step would be a no-op) whose
  // byte count alone must still trip the pre-existing byte cap — regression
  // guard for T-dimension-bound landing right next to that check.
  const bytes = await createTinyPng();
  const expectedSha256 = sha256Hex(bytes);
  process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = 'direct-function-secret';
  process.env.ARTIFACT_UPLOAD_MAX_BYTES = String(bytes.byteLength - 1);

  try {
    const token = createArtifactUploadToken({
      requestId: 'req_function_bytecap_regression_20260630_01',
      artifactKind: ArtifactKind.Image,
      contentType: 'image/png',
      expectedSizeBytes: bytes.byteLength,
      expectedSha256,
      expiresAt: Date.now() + 60_000,
    });

    assert.deepEqual(
      await parseJsonResponse(
        await artifactUploadHandler(
          makeDirectUploadRequest({
            bytes,
            token,
            headers: {
              'x-artifact-request-id': 'req_function_bytecap_regression_20260630_01',
              'x-artifact-kind': 'image',
              'x-artifact-content-type': 'image/png',
              'x-artifact-size': String(bytes.byteLength),
              'x-artifact-sha256': expectedSha256,
            },
          })
        )
      ),
      { status: 413, body: { ok: false, error: 'Payload too large.', maxBytes: bytes.byteLength - 1 } }
    );
  } finally {
    if (previousSecret === undefined) delete process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
    else process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = previousSecret;
    if (previousMaxBytes === undefined) delete process.env.ARTIFACT_UPLOAD_MAX_BYTES;
    else process.env.ARTIFACT_UPLOAD_MAX_BYTES = previousMaxBytes;
  }
});

test('artifact-upload function stores a small PDF byte-identical, unaffected by the image dimension bound', async () => {
  await withBlobStores(async ({ artifactValues }) => {
    const previousSecret = process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
    const bytes = Buffer.from('%PDF-1.7\ndimension-bound must never touch a pdf');
    const expectedSha256 = sha256Hex(bytes);
    process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = 'direct-function-secret';

    try {
      const token = createArtifactUploadToken({
        requestId: 'req_function_pdf_passthrough_20260630_01',
        artifactKind: ArtifactKind.Pdf,
        contentType: 'application/pdf',
        expectedSizeBytes: bytes.byteLength,
        expectedSha256,
        expiresAt: Date.now() + 60_000,
      });

      const response = await parseJsonResponse(
        await artifactUploadHandler(
          makeDirectUploadRequest({
            bytes,
            token,
            headers: {
              'x-artifact-request-id': 'req_function_pdf_passthrough_20260630_01',
              'x-artifact-kind': 'pdf',
              'x-artifact-content-type': 'application/pdf',
              'x-artifact-size': String(bytes.byteLength),
              'x-artifact-sha256': expectedSha256,
            },
          })
        )
      );

      assert.equal(response.status, 200);
      const artifact = response.body.artifact as { blobKey: string; sha256: string };
      assert.equal(artifact.sha256, expectedSha256); // byte-identical: hash of what was uploaded, untouched
      assert.deepEqual(artifactValues.get(artifact.blobKey), bytes);
    } finally {
      if (previousSecret === undefined) delete process.env.ARTIFACT_UPLOAD_TOKEN_SECRET;
      else process.env.ARTIFACT_UPLOAD_TOKEN_SECRET = previousSecret;
    }
  });
});
