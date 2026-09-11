/**
 * T-ASSET-IDENTITY Part 3 — coverage for `resolveAssetIdentity`.
 *
 *   - a capture request id + a checksum resolves WITHOUT fabricating an
 *     article: no `contentItemExists` stub is ever consulted for
 *     `capture_artifact` / `stored_media`, and ownership stays explicitly
 *     absent rather than invented.
 *   - multiple live artifacts under one request, with no checksum narrowing
 *     it, come back as a SHORTLIST — never an arbitrary pick.
 *   - a request already owned by a DIFFERENT tenant is refused
 *     (`cross_tenant`), distinct from `not_found`.
 *   - a checksum that does not match anything under a (same-tenant) request
 *     is refused (`checksum_mismatch`), distinct from `not_found`.
 *   - a capture request NEVER resolves through the implicit content_item
 *     fallback, even when `contentItemExists` is stubbed to return `true` —
 *     that branch is reachable ONLY for `assetKind: 'content_linked_asset'`.
 *   - no public URL is ever invented for a non-publicly-renderable kind
 *     (e.g. `doc`); for `image`/`pdf` the derived path is byte-identical to
 *     artifact-trust.ts's own `publicPathForArtifactRef`.
 */
import '../../../../sites/drlurie/config/policy-bindings.js';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalBlobStore, setLocalBlobsRootForTesting } from './local-blobs.js';
import { writeArtifactReferenceIndexes, writeRequestOwner, type ArtifactIndexStore } from './artifact-index.js';
import type { ArtifactReference } from './artifacts.js';
import { publicPathForArtifactRef } from './artifact-trust.js';
import { resolveAssetIdentity } from './artifact-identity-resolve.js';

const PLATFORM_VARS = [
  'NETLIFY_SITE_ID',
  'SITE_ID',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'NETLIFY_BLOBS_API_URL',
];
const savedEnv: Record<string, string | undefined> = {};

const REQUEST_ID = 'req_capture_identity_resolve_20260910_01';
const SITE = 'site_test_tenant';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const ref = (overrides: Partial<ArtifactReference> = {}): ArtifactReference => ({
  blobKey: `image/${REQUEST_ID}/${SHA_A}.jpg`,
  sizeBytes: 2048,
  sha256: SHA_A,
  contentType: 'image/jpeg',
  createdAtISO: '2026-01-01T00:00:00.000Z',
  artifactKind: 'image',
  ...overrides,
});

describe('artifact-identity-resolve: resolveAssetIdentity (T-ASSET-IDENTITY Part 3)', () => {
  let root: string;
  let store: ArtifactIndexStore;

  before(async () => {
    for (const name of PLATFORM_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  after(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'artifact-identity-resolve-'));
    setLocalBlobsRootForTesting(root);
    store = createLocalBlobStore('artifact-index') as unknown as ArtifactIndexStore;
  });

  after(async () => {
    setLocalBlobsRootForTesting(undefined);
  });

  it('not_found: a request id with no live artifacts', async () => {
    const result = await resolveAssetIdentity(
      { indexStore: store },
      { assetKind: 'capture_artifact', requestId: 'req_nothing_here_20260910_01', callerSiteId: SITE }
    );
    assert.strictEqual(result.status, 'not_found');
  });

  it('a capture_artifact + checksum resolves to exactly one match without fabricating an article', async () => {
    await writeArtifactReferenceIndexes(store, REQUEST_ID, ref());
    let contentItemExistsCalled = false;

    const result = await resolveAssetIdentity(
      {
        indexStore: store,
        contentItemExists: async () => {
          contentItemExistsCalled = true;
          return true;
        },
      },
      { assetKind: 'capture_artifact', requestId: REQUEST_ID, expectedSha256: SHA_A, callerSiteId: SITE }
    );

    assert.strictEqual(result.status, 'resolved');
    if (result.status !== 'resolved') return;
    assert.strictEqual(result.match.sha256, SHA_A);
    assert.strictEqual(result.match.evidence.checksum.present, true);
    if (result.match.evidence.checksum.present) assert.strictEqual(result.match.evidence.checksum.value, SHA_A);
    // No owner was ever registered for this request, and this is NOT
    // content_linked_asset — ownership must stay explicitly absent, never
    // silently promoted to "this is content_item <requestId>".
    assert.strictEqual(result.match.evidence.ownership.present, false);
    assert.strictEqual(
      contentItemExistsCalled,
      false,
      'contentItemExists must never be consulted for capture_artifact'
    );
  });

  it('multiple matching artifacts under one request, no checksum narrowing, come back as a SHORTLIST', async () => {
    await writeArtifactReferenceIndexes(
      store,
      REQUEST_ID,
      ref({ sha256: SHA_A, blobKey: `image/${REQUEST_ID}/${SHA_A}.jpg` })
    );
    await writeArtifactReferenceIndexes(
      store,
      REQUEST_ID,
      ref({ sha256: SHA_B, blobKey: `image/${REQUEST_ID}/${SHA_B}.jpg` })
    );

    const result = await resolveAssetIdentity(
      { indexStore: store },
      { assetKind: 'stored_media', requestId: REQUEST_ID, callerSiteId: SITE }
    );

    assert.strictEqual(result.status, 'shortlist');
    if (result.status !== 'shortlist') return;
    assert.strictEqual(result.matches.length, 2);
  });

  it('cross_tenant: a request owned by a DIFFERENT site is refused, not merely filtered to not_found', async () => {
    await writeArtifactReferenceIndexes(store, REQUEST_ID, ref());
    await writeRequestOwner(store, REQUEST_ID, {
      object_type: 'page',
      object_id: 'page_other_tenant',
      site: 'site_someone_else',
      registered_by: 'test',
    });

    const result = await resolveAssetIdentity(
      { indexStore: store },
      { assetKind: 'capture_artifact', requestId: REQUEST_ID, callerSiteId: SITE }
    );

    assert.strictEqual(result.status, 'refused');
    if (result.status !== 'refused') return;
    assert.strictEqual(result.reason, 'cross_tenant');
  });

  it('checksum_mismatch: a same-tenant request exists, but no artifact under it matches the given sha256', async () => {
    await writeArtifactReferenceIndexes(store, REQUEST_ID, ref());

    const result = await resolveAssetIdentity(
      { indexStore: store },
      { assetKind: 'capture_artifact', requestId: REQUEST_ID, expectedSha256: 'c'.repeat(64), callerSiteId: SITE }
    );

    assert.strictEqual(result.status, 'refused');
    if (result.status !== 'refused') return;
    assert.strictEqual(result.reason, 'checksum_mismatch');
  });

  it('a capture request id NEVER resolves through the content_item fallback, even when it exists', async () => {
    await writeArtifactReferenceIndexes(store, REQUEST_ID, ref());

    const result = await resolveAssetIdentity(
      { indexStore: store, contentItemExists: async () => true },
      { assetKind: 'capture_artifact', requestId: REQUEST_ID, callerSiteId: SITE }
    );

    assert.strictEqual(result.status, 'resolved');
    if (result.status !== 'resolved') return;
    assert.strictEqual(result.match.evidence.ownership.present, false);
  });

  it('content_linked_asset DOES use the implicit content_item fallback, but only when explicitly asked', async () => {
    await writeArtifactReferenceIndexes(store, REQUEST_ID, ref());

    const result = await resolveAssetIdentity(
      { indexStore: store, contentItemExists: async (id) => id === REQUEST_ID },
      { assetKind: 'content_linked_asset', requestId: REQUEST_ID, callerSiteId: SITE }
    );

    assert.strictEqual(result.status, 'resolved');
    if (result.status !== 'resolved') return;
    assert.strictEqual(result.match.evidence.ownership.present, true);
    if (!result.match.evidence.ownership.present) return;
    assert.strictEqual(result.match.evidence.ownership.value.basis, 'implicit_content_item');
    assert.strictEqual(result.match.evidence.ownership.value.object_type, 'content_item');
  });

  it('never invents a public URL for a non-publicly-renderable kind', async () => {
    await writeArtifactReferenceIndexes(
      store,
      REQUEST_ID,
      ref({ artifactKind: 'doc', blobKey: `doc/${REQUEST_ID}/${SHA_A}.pdf`, contentType: 'application/msword' })
    );

    const result = await resolveAssetIdentity(
      { indexStore: store },
      { assetKind: 'stored_media', requestId: REQUEST_ID, callerSiteId: SITE }
    );

    assert.strictEqual(result.status, 'resolved');
    if (result.status !== 'resolved') return;
    assert.strictEqual(result.match.evidence.publicReference.present, false);
  });

  it('for image/pdf kinds, the derived public path is byte-identical to publicPathForArtifactRef', async () => {
    await writeArtifactReferenceIndexes(store, REQUEST_ID, ref());

    const result = await resolveAssetIdentity(
      { indexStore: store },
      { assetKind: 'stored_media', requestId: REQUEST_ID, callerSiteId: SITE }
    );

    assert.strictEqual(result.status, 'resolved');
    if (result.status !== 'resolved') return;
    assert.strictEqual(result.match.evidence.publicReference.present, true);
    if (!result.match.evidence.publicReference.present) return;
    assert.strictEqual(result.match.evidence.publicReference.value, publicPathForArtifactRef(result.match.blobKey));
    assert.strictEqual(result.match.evidence.publicReference.value, `/img/${REQUEST_ID}/${SHA_A}.jpg`);
  });

  it('source is explicitly absent when never recorded, and explicitly present when it was', async () => {
    await writeArtifactReferenceIndexes(store, REQUEST_ID, ref());
    const withSource = await resolveAssetIdentity(
      { indexStore: store },
      { assetKind: 'stored_media', requestId: REQUEST_ID, callerSiteId: SITE }
    );
    assert.strictEqual(withSource.status, 'resolved');
    if (withSource.status !== 'resolved') return;
    assert.strictEqual(withSource.match.evidence.source.present, false);

    const reqWithSource = 'req_capture_identity_resolve_src_20260910_01';
    await writeArtifactReferenceIndexes(
      store,
      reqWithSource,
      ref({
        blobKey: `image/${reqWithSource}/${SHA_A}.jpg`,
        metadata: { sourceUrl: 'https://example.com/original.jpg' },
      })
    );
    const result = await resolveAssetIdentity(
      { indexStore: store },
      { assetKind: 'stored_media', requestId: reqWithSource, callerSiteId: SITE }
    );
    assert.strictEqual(result.status, 'resolved');
    if (result.status !== 'resolved') return;
    assert.strictEqual(result.match.evidence.source.present, true);
    if (!result.match.evidence.source.present) return;
    assert.strictEqual(result.match.evidence.source.value, 'https://example.com/original.jpg');
  });
});
