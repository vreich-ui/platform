import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { handler as mcpHandler } from '../../netlify/functions/mcp.js';
import { saveArtifactBytes } from '../../packages/core/server/lib/artifact-upload.js';
import { handler as saveArtifactLegacyHandler } from '../../netlify/functions/save-artifact.js';
import { getArtifactBlobStore, setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';
import { ArtifactKind, type ArtifactReference } from '../../packages/core/server/lib/artifacts.js';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

type FakeStoreValue = Buffer | string;

interface FakeStore {
  set(
    key: string,
    value: string | Buffer | Uint8Array,
    options?: { onlyIfNew?: boolean }
  ): Promise<{ modified: boolean }>;
  setJSON(key: string, value: unknown): Promise<{ modified: boolean }>;
  get(key: string, options?: { type?: 'arrayBuffer' }): Promise<ArrayBuffer | string | null>;
  del(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ blobs: { key: string; etag: string }[]; directories: string[] }>;
}

const createFakeStore = (
  values = new Map<string, FakeStoreValue>()
): { values: Map<string, FakeStoreValue>; store: FakeStore } => ({
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
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? '';
      const blobs = Array.from(values.keys())
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, etag: '' }));
      return { blobs, directories: [] };
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
  const previousPublishSecret = process.env.NETLIFY_PUBLISH_SECRET;
  const previousMcpAdmin = process.env.MCP_ENABLE_ADMIN_TOOLS;

  const { values: artifactValues, store: artifactStore } = createFakeStore();
  const { values: indexValues, store: indexStore } = createFakeStore();

  process.env.NETLIFY = 'true';
  process.env.NETLIFY_SITE_ID = '';
  process.env.NETLIFY_PUBLISH_SECRET = 'test-secret';
  process.env.MCP_ENABLE_ADMIN_TOOLS = 'true';

  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore(input) {
      const storeName = typeof input === 'string' ? input : input.name;
      if (storeName === 'artifacts') {
        return artifactStore as unknown as ReturnType<typeof getArtifactBlobStore> extends Promise<infer T> ? T : never;
      }
      if (storeName === 'artifact-index') {
        return indexStore as unknown as ReturnType<typeof getArtifactBlobStore> extends Promise<infer T> ? T : never;
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
    if (previousPublishSecret === undefined) delete process.env.NETLIFY_PUBLISH_SECRET;
    else process.env.NETLIFY_PUBLISH_SECRET = previousPublishSecret;
    if (previousMcpAdmin === undefined) delete process.env.MCP_ENABLE_ADMIN_TOOLS;
    else process.env.MCP_ENABLE_ADMIN_TOOLS = previousMcpAdmin;
  }
};

const callMcp = async (method: string, args: Record<string, unknown>) => {
  const response = await mcpHandler({
    httpMethod: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-publish-key': 'test-secret',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: method, arguments: args },
    }),
  });
  const body = JSON.parse(response.body);
  if (body.error) {
    console.error('MCP Error:', body.error);
    throw new Error(body.error.message);
  }
  if (body.result && body.result.isError) {
    console.error('Tool Error Result:', body.result);
  }
  return body.result;
};

test('Artifact listing and metadata retrieval', async () => {
  await withBlobStores(async () => {
    // 1. Save an artifact via saveArtifactBytes (direct)
    const bytes1 = Buffer.from('%PDF-1.7\ndirect artifact');
    const sha1 = sha256(bytes1);
    const requestId1 = 'req_test_direct_20260605_01';
    await saveArtifactBytes({
      requestId: requestId1,
      artifactKind: ArtifactKind.Pdf,
      contentType: 'application/pdf',
      expectedSizeBytes: bytes1.byteLength,
      expectedSha256: sha1,
      bytes: bytes1,
      tags: ['test-tag'],
      label: 'Direct PDF',
    });

    // 2. Save an artifact via save-artifact (legacy)
    const bytes2 = Buffer.from('%PDF-1.7\nlegacy artifact');
    const sha2 = sha256(bytes2);
    const requestId2 = 'req_test_legacy_20260605_01';
    await saveArtifactLegacyHandler({
      httpMethod: 'POST',
      headers: { 'x-publish-key': 'test-secret' },
      body: JSON.stringify({
        requestId: requestId2,
        artifactKind: 'pdf',
        contentType: 'application/pdf',
        payload: bytes2.toString('base64'),
        label: 'Legacy PDF',
      }),
    });

    // 3. Test list_artifacts_for_request
    const list1 = (await callMcp('list_artifacts_for_request', { requestId: requestId1 })) as {
      structuredContent: { artifacts: ArtifactReference[] };
    };
    assert.equal(list1.structuredContent.artifacts.length, 1);
    assert.equal(list1.structuredContent.artifacts[0].sha256, sha1);

    const list2 = (await callMcp('list_artifacts_for_request', { requestId: requestId2 })) as {
      structuredContent: { artifacts: ArtifactReference[] };
    };
    assert.equal(list2.structuredContent.artifacts.length, 1);
    assert.equal(list2.structuredContent.artifacts[0].sha256, sha2);

    // 4. Test list_artifacts_by_kind
    const listKind = (await callMcp('list_artifacts_by_kind', { artifactKind: 'pdf' })) as {
      structuredContent: { artifacts: ArtifactReference[] };
    };
    assert.equal(listKind.structuredContent.artifacts.length, 2);
    const shas = listKind.structuredContent.artifacts.map((a) => a.sha256);
    assert.ok(shas.includes(sha1));
    assert.ok(shas.includes(sha2));

    // 5. Test list_artifacts_by_request
    const listByReq1 = (await callMcp('list_artifacts_by_request', { requestId: requestId1 })) as {
      structuredContent: { artifacts: ArtifactReference[] };
    };
    assert.equal(listByReq1.structuredContent.artifacts.length, 1);
    assert.equal(listByReq1.structuredContent.artifacts[0].sha256, sha1);

    // 6. Test search_artifacts by tag
    const searchTag = (await callMcp('search_artifacts', { tag: 'test-tag' })) as {
      structuredContent: { artifacts: ArtifactReference[] };
    };
    assert.equal(searchTag.structuredContent.artifacts.length, 1);
    assert.equal(searchTag.structuredContent.artifacts[0].sha256, sha1);

    // 7. Test get_artifact_metadata (the new tool)
    const artifactStore = (await getArtifactBlobStore({})) as unknown as FakeStore;
    const originalGet = artifactStore.get;
    let bytesRead = false;
    artifactStore.get = async (key: string, options?: { type?: 'arrayBuffer' }) => {
      bytesRead = true;
      return originalGet.call(artifactStore, key, options);
    };

    try {
      const meta = (await callMcp('get_artifact_metadata', { requestId: requestId1, sha256: sha1 })) as {
        structuredContent: ArtifactReference;
      };
      assert.equal(meta.structuredContent.sha256, sha1);
      assert.equal(meta.structuredContent.label, 'Direct PDF');
      assert.ok(meta.structuredContent.blobKey);
      assert.equal(bytesRead, false, 'get_artifact_metadata should not read artifact bytes');

      // Test metadata not found
      const metaNotFound = (await callMcp('get_artifact_metadata', {
        requestId: requestId1,
        sha256: '0'.repeat(64),
      })) as { isError?: boolean; structuredContent: { error: string } };
      assert.equal(metaNotFound.isError, true);
      assert.match(metaNotFound.structuredContent.error, /not found/i);
    } finally {
      artifactStore.get = originalGet;
    }

    // 8. Test soft delete and filtering
    await callMcp('soft_delete_artifact', { requestId: requestId1, sha256: sha1 });

    // Should be hidden by default
    const listAfterDelete = (await callMcp('list_artifacts_for_request', { requestId: requestId1 })) as {
      structuredContent: { artifacts: ArtifactReference[] };
    };
    assert.equal(listAfterDelete.structuredContent.artifacts.length, 0);

    const listByKindAfterDelete = (await callMcp('list_artifacts_by_kind', { artifactKind: 'pdf' })) as {
      structuredContent: { artifacts: ArtifactReference[] };
    };
    assert.equal(listByKindAfterDelete.structuredContent.artifacts.length, 1); // Only legacy one left

    // Should be visible with includeDeleted
    const listWithDeleted = (await callMcp('list_artifacts_by_kind', {
      artifactKind: 'pdf',
      includeDeleted: true,
    })) as { structuredContent: { artifacts: ArtifactReference[] } };
    assert.equal(listWithDeleted.structuredContent.artifacts.length, 2);

    // Restore and check
    await callMcp('restore_artifact', { requestId: requestId1, sha256: sha1 });
    const listAfterRestore = (await callMcp('list_artifacts_for_request', { requestId: requestId1 })) as {
      structuredContent: { artifacts: ArtifactReference[] };
    };
    assert.equal(listAfterRestore.structuredContent.artifacts.length, 1);
  });
});

/**
 * W3 T1: `ArtifactPointer` now mirrors the reference's `createdAtISO` and
 * `deletedAtISO`, so `admin-editorial-assets` can sort and slice a `by-kind/`
 * listing before it opens a single record. That is only safe while EVERY path
 * that changes a reference also rewrites its pointers — a soft delete that
 * touched `request-artifacts/` alone would leave a pointer swearing a deleted
 * artifact is live, and a restore would leave one swearing a live artifact is
 * deleted.
 *
 * This pins the write side of that contract at the surface an operator uses:
 * the `soft_delete_artifact` / `restore_artifact` MCP tools.
 */
test('soft delete and restore keep every pointer in step with the reference', async () => {
  await withBlobStores(async ({ indexValues }) => {
    const bytes = Buffer.from('%PDF-1.7\npointer liveness');
    const sha = sha256(bytes);
    const requestId = 'req_test_pointer_liveness_20260913_01';

    await saveArtifactBytes({
      requestId,
      artifactKind: ArtifactKind.Pdf,
      contentType: 'application/pdf',
      expectedSizeBytes: bytes.byteLength,
      expectedSha256: sha,
      bytes,
      tags: ['liveness'],
      label: 'Liveness PDF',
    });

    const pointerKeys = [
      `by-kind/pdf/${sha}.json`,
      `by-request/${encodeURIComponent(requestId)}/pdf/${sha}.json`,
      `by-tag/liveness/${sha}.json`,
    ];
    const readPointer = (key: string) =>
      JSON.parse(String(indexValues.get(key))) as { createdAtISO?: string; deletedAtISO?: string };
    const readReference = () =>
      JSON.parse(String(indexValues.get(`request-artifacts/${encodeURIComponent(requestId)}/${sha}.json`))) as {
        createdAtISO: string;
        deletedAtISO?: string;
      };

    const created = readReference().createdAtISO;
    for (const key of pointerKeys) {
      const pointer = readPointer(key);
      assert.equal(pointer.createdAtISO, created, `${key} must carry the reference's sort key`);
      assert.equal(pointer.deletedAtISO, undefined, `${key} must not claim a live artifact is deleted`);
    }

    await callMcp('soft_delete_artifact', { requestId, sha256: sha });

    const deletedAt = readReference().deletedAtISO;
    assert.ok(deletedAt, 'the reference is stamped');
    for (const key of pointerKeys) {
      const pointer = readPointer(key);
      assert.equal(pointer.deletedAtISO, deletedAt, `${key} must carry the same stamp as the reference`);
      assert.equal(pointer.createdAtISO, created, `${key} must not lose the sort key across a delete`);
    }

    await callMcp('restore_artifact', { requestId, sha256: sha });

    assert.equal(readReference().deletedAtISO, undefined);
    for (const key of pointerKeys) {
      const pointer = readPointer(key);
      assert.equal(pointer.deletedAtISO, undefined, `${key} must not keep a stamp the reference no longer has`);
      assert.equal(pointer.createdAtISO, created, `${key} must not lose the sort key across a restore`);
    }
  });
});

/**
 * W3 T1 follow-up: `by-kind/<kind>/<sha>.json` and `by-tag/<tag>/<sha>.json`
 * are keyed by sha256 ALONE, so cross-request dedupe (W2 T2.4 — a second
 * request uploading bytes this tenant already stores gets its own reference
 * over the same digest) leaves TWO live references behind one pointer.
 *
 * While a pointer said nothing about liveness that only decided which
 * requestId a listing happened to show. Now that `deletedAtISO` on a pointer
 * lets `admin-editorial-assets` skip the record read entirely, a soft delete
 * that stamped the shared pointer would take the OTHER request's live artifact
 * off the media picker with nothing left to notice — no torn write, no race,
 * just the ordinary delete path. The request-scoped `by-request/` pointer is
 * still stamped, because that one really is this request's.
 */
test('a soft delete never stamps a shared pointer that names another live request', async () => {
  await withBlobStores(async ({ indexValues }) => {
    const bytes = Buffer.from('%PDF-1.7\nshared digest, two requests');
    const sha = sha256(bytes);
    const deletedRequestId = 'req_test_shared_ptr_a_20260913_01';
    const liveRequestId = 'req_test_shared_ptr_b_20260913_01';

    for (const requestId of [deletedRequestId, liveRequestId]) {
      await saveArtifactBytes({
        requestId,
        artifactKind: ArtifactKind.Pdf,
        contentType: 'application/pdf',
        expectedSizeBytes: bytes.byteLength,
        expectedSha256: sha,
        bytes,
        tags: ['shared'],
        label: 'Shared PDF',
      });
    }

    const readJson = (key: string) => JSON.parse(String(indexValues.get(key))) as Record<string, unknown>;
    const sharedKeys = [`by-kind/pdf/${sha}.json`, `by-tag/shared/${sha}.json`];

    // The second upload is the last writer, so the shared pointers name it.
    for (const key of sharedKeys) {
      assert.equal(readJson(key).requestId, liveRequestId, `${key} names the most recent uploader`);
    }

    await callMcp('soft_delete_artifact', { requestId: deletedRequestId, sha256: sha });

    for (const key of sharedKeys) {
      const pointer = readJson(key);
      assert.equal(pointer.requestId, liveRequestId, `${key} must not be repointed at the deleted request`);
      assert.equal(pointer.deletedAtISO, undefined, `${key} must not hide ${liveRequestId}'s live reference`);
    }

    // The request-scoped pointer IS this request's, and is stamped normally.
    const ownPointer = readJson(`by-request/${encodeURIComponent(deletedRequestId)}/pdf/${sha}.json`);
    assert.ok(ownPointer.deletedAtISO, 'the deleted request keeps an honest by-request pointer');

    // And the live reference is untouched.
    const liveReference = readJson(`request-artifacts/${encodeURIComponent(liveRequestId)}/${sha}.json`);
    assert.equal(liveReference.deletedAtISO, undefined);
  });
});
