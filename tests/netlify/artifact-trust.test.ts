import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readArtifactReferenceResult,
  requestArtifactReferenceKey,
  writeArtifactReferenceIndexes,
  type ArtifactIndexStore,
} from '../../packages/core/server/lib/artifact-index.js';
import { artifactStorageKey, isArtifactReference, type ArtifactReference } from '../../packages/core/server/lib/artifacts.js';
import {
  gatherTrustedArtifactRefs,
  parseArtifactTrustIdentity,
  publicPathForArtifactRef,
  readArtifactTrustIdentityResult,
} from '../../packages/core/server/lib/artifact-trust.js';
import { buildStoreValidationContext } from '../../packages/core/server/lib/object-validation-context.js';

const REQUEST_ID = 'req_agent_skin_barrier_damage_20260906_01';
const SHA = '9811d7d00c860d2a60b5e98423f71a5113e7712fdb45eecf5ef81a0a0e7470c6';
const OTHER_SHA = 'b'.repeat(64);
const OTHER_REQUEST = 'req_agent_other_image_20260917_01';
const BLOB_KEY = `image/${REQUEST_ID}/${SHA}.png`;
const INDEX_KEY = requestArtifactReferenceKey(REQUEST_ID, SHA);
const DELETED_AT = '2026-09-17T10:00:00.000Z';
const carrier = { request_id: REQUEST_ID, agent_outputs: {} };

// Mirrors artifact-index-tag-roundtrip.test.ts, including empty tags and nested provenance.
const productionReference = (): ArtifactReference => ({
  blobKey: BLOB_KEY,
  sizeBytes: 1005827,
  sha256: SHA,
  contentType: 'image/png',
  createdAtISO: '2026-09-06T15:41:21.852Z',
  artifactKind: 'image',
  originalFilename: 'skin-barrier-anatomy.png',
  filename: 'skin-barrier-anatomy.png',
  label: 'Skin barrier anatomy diagram',
  tags: [],
  metadata: { import: { sourceUrl: 'https://example.test/x.png', license: { class: 'unknown' } } },
});

const makeIndexStore = (initial: Array<[string, string]> = []) => {
  const entries = new Map(initial);
  const store: ArtifactIndexStore = {
    get: async (key) => entries.get(key) ?? null,
    setJSON: async (key, value) => {
      entries.set(key, JSON.stringify(value));
    },
    list: async ({ prefix = '' } = {}) => ({
      blobs: [...entries.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
      directories: [],
    }),
  };
  return { store, entries };
};

const indexed = (value: unknown, key = INDEX_KEY) => makeIndexStore([[key, JSON.stringify(value)]]);
const parse = (value: unknown, key = INDEX_KEY) => parseArtifactTrustIdentity(value, REQUEST_ID, key);
const trust = (value: unknown) => gatherTrustedArtifactRefs(carrier, indexed(value).store);
const emptyObjectStore = () => makeIndexStore().store as never;

const resolve = async (value: unknown) => {
  const context = await buildStoreValidationContext(emptyObjectStore(), {
    artifactIndexStore: indexed(value).store,
    artifactRefSources: [{ src: publicPathForArtifactRef(BLOB_KEY) }],
  });
  return context.resolveArtifactRef?.(BLOB_KEY);
};

test('production-shaped provenance survives the real index write/read and enters trust', async () => {
  const reference = productionReference();
  const { store, entries } = makeIndexStore();
  await writeArtifactReferenceIndexes(store, REQUEST_ID, reference);
  const before = new Map(entries);
  assert.equal(isArtifactReference(reference), true, 'nested sourceUrl already passes the full validator');
  assert.equal((await readArtifactReferenceResult(store, REQUEST_ID, SHA)).status, 'ok');
  const result = await gatherTrustedArtifactRefs(carrier, store);
  assert.deepEqual(result.trusted, new Set([BLOB_KEY]));
  assert.deepEqual(result.deleted, new Set());
  assert.deepEqual(entries, before, 'trust must not rewrite provenance or repair the index');
});

test('missing, empty, nested, and arbitrary future metadata produce identical trust', async () => {
  const withoutMetadata = productionReference();
  delete withoutMetadata.metadata;
  const baseline = await trust(withoutMetadata);
  for (const metadata of [
    {},
    productionReference().metadata,
    { provider: { originalUrl: 'https://provider.example/foo', licenseUrl: 'https://provider.example/license', foo: 'bar' } },
    { future: [{ deeply: { nested: ['anything', null, 42] } }] },
    null,
    'opaque legacy provenance',
    ['future', 'bag'],
  ]) {
    assert.deepEqual(await trust({ ...withoutMetadata, metadata }), baseline);
    assert.deepEqual(parse({ ...withoutMetadata, metadata }), parse(withoutMetadata));
  }
});

for (const [field, value] of [
  ['label', '<legacy display label>'],
  ['filename', '../../legacy/name.png'],
  ['originalFilename', 42],
  ['tags', 'legacy-tags'],
  ['somethingNew', { provenance: 'https://example.test/source' }],
] as Array<[string, unknown]>) {
  test(`${field}: application-contract rejection is independent of security identity`, async () => {
    const valueWithProvenance = { ...productionReference(), [field]: value };
    assert.equal(isArtifactReference(valueWithProvenance), false);
    const { store } = indexed(valueWithProvenance);
    assert.equal((await readArtifactReferenceResult(store, REQUEST_ID, SHA)).status, 'rejected');
    assert.deepEqual((await trust(valueWithProvenance)).trusted, new Set([BLOB_KEY]));
    assert.deepEqual(await resolve(valueWithProvenance), {
      exists: true, sizeBytes: 1005827, contentType: 'image/png',
    });
  });
}

for (const blobKey of [
  'https://third-party.example/image.png',
  `image/${REQUEST_ID}/${SHA}`,
  `image/${REQUEST_ID}/${SHA}/extra.png`,
  `image/../${SHA}.png`,
  `video/${REQUEST_ID}/${SHA}.mp4`,
  `image/${REQUEST_ID}/bad-sha.png`,
]) {
  test(`malformed blobKey remains untrusted: ${blobKey}`, async () => {
    const reference = { ...productionReference(), blobKey };
    assert.deepEqual(parse(reference), { status: 'rejected', issue: 'invalid artifact blob key' });
    assert.equal((await trust(reference)).trusted.size, 0);
  });
}

for (const sha256 of [undefined, null, 123, 'a', 'g'.repeat(64), OTHER_SHA]) {
  test(`invalid or mismatched top-level SHA cannot be repaired by provenance: ${String(sha256)}`, async () => {
    const reference = { ...productionReference(), sha256, metadata: { sha256: SHA, blobKey: BLOB_KEY } };
    assert.equal(parse(reference).status, 'rejected');
    assert.equal((await trust(reference)).trusted.size, 0);
    assert.equal((await resolve(reference))?.exists, false);
  });
}

test('a soft-deleted indexed artifact is deleted, never live, even in historical agent outputs', async () => {
  const reference = { ...productionReference(), deletedAtISO: DELETED_AT, metadata: { deletedAtISO: null } };
  const result = await gatherTrustedArtifactRefs({
    ...carrier,
    agent_outputs: { writer: { output: { artifactReferences: [{ blobKey: BLOB_KEY }] } } },
  }, indexed(reference).store);
  assert.deepEqual(result.trusted, new Set());
  assert.deepEqual(result.deleted, new Set([BLOB_KEY]));
  assert.deepEqual(await resolve(reference), {
    exists: true, deleted: true, sizeBytes: 1005827, contentType: 'image/png',
  });
});

for (const deletedAtISO of ['', 'not-a-date', null, 42, false]) {
  test(`an invalid deletion marker fails closed: ${String(deletedAtISO)}`, async () => {
    const reference = { ...productionReference(), deletedAtISO };
    assert.deepEqual(parse(reference), { status: 'rejected', issue: 'invalid artifact deletion marker' });
    assert.equal((await trust(reference)).trusted.size, 0);
    assert.equal((await resolve(reference))?.exists, false);
  });
}

test('foreign request identities are refused even under the current request index prefix', async () => {
  const reference = { ...productionReference(), blobKey: `image/${OTHER_REQUEST}/${SHA}.png` };
  assert.deepEqual(parse(reference), { status: 'rejected', issue: 'artifact belongs to a different request' });
  assert.equal((await trust(reference)).trusted.size, 0);
  assert.equal((await resolve(reference))?.exists, false);
});

test('the canonical index key must agree with the recorded SHA and request', async () => {
  const wrongKey = requestArtifactReferenceKey(REQUEST_ID, OTHER_SHA);
  assert.deepEqual(parse(productionReference(), wrongKey), {
    status: 'rejected', issue: 'artifact index key / identity mismatch',
  });
  assert.equal((await gatherTrustedArtifactRefs(carrier, indexed(productionReference(), wrongKey).store)).trusted.size, 0);
  const foreignKey = requestArtifactReferenceKey(OTHER_REQUEST, SHA);
  assert.equal((await gatherTrustedArtifactRefs(carrier, indexed(productionReference(), foreignKey).store)).trusted.size, 0);
});

test('metadata cannot override canonical identity, lifecycle, or storage fields', async () => {
  const reference = {
    ...productionReference(),
    metadata: {
      blobKey: `image/${OTHER_REQUEST}/${OTHER_SHA}.png`,
      sha256: OTHER_SHA, requestId: OTHER_REQUEST, deletedAtISO: DELETED_AT,
      storageKey: 'https://third-party.example/image.png',
      import: { sourceUrl: 'https://third-party.example/image.jpg' },
    },
  };
  assert.deepEqual(parse(reference), { status: 'ok', reference: { blobKey: BLOB_KEY, sha256: SHA } });
  assert.deepEqual((await trust(reference)).trusted, new Set([BLOB_KEY]));
  assert.equal(JSON.stringify(parse(reference)).includes('https:'), false);
  assert.equal(parse({ metadata: { blobKey: BLOB_KEY, sha256: SHA } }).status, 'rejected');
});

test('deduplicated storage is validated but never replaces public/request identity', async () => {
  const storageKey = `image/${OTHER_REQUEST}/${SHA}.png`;
  const reference = { ...productionReference(), storageKey };
  const parsed = parse(reference);
  assert.ok(parsed.status === 'ok');
  assert.equal(artifactStorageKey(parsed.reference), storageKey);
  const result = await trust(reference);
  assert.deepEqual(result.trusted, new Set([BLOB_KEY]));
  assert.equal(result.trusted.has(storageKey), false);
  assert.equal(publicPathForArtifactRef(parsed.reference.blobKey), `/img/${REQUEST_ID}/${SHA}.png`);
  assert.equal((await resolve(reference))?.exists, true);
});

for (const storageKey of ['', null, 42, 'image', 'image/', 'https://example.test/image.png', `image/${OTHER_REQUEST}/${OTHER_SHA}.png`]) {
  test(`invalid storage redirect remains rejected: ${String(storageKey)}`, async () => {
    const reference = { ...productionReference(), storageKey };
    assert.equal(parse(reference).status, 'rejected');
    assert.equal((await trust(reference)).trusted.size, 0);
    assert.equal((await resolve(reference))?.exists, false);
  });
}

test('missing, unusable, and corrupt index records cannot establish trust', async () => {
  for (const value of [null, [], 42, 'record', {}, { metadata: { blobKey: BLOB_KEY, sha256: SHA } }]) {
    assert.equal(parse(value).status, 'rejected');
    assert.equal((await trust(value)).trusted.size, 0);
  }
  const { store } = makeIndexStore([[INDEX_KEY, '{not json']]);
  assert.equal((await gatherTrustedArtifactRefs(carrier, store)).trusted.size, 0);
  assert.deepEqual(await readArtifactTrustIdentityResult(store, REQUEST_ID, SHA), {
    status: 'rejected', issue: 'index entry is not valid JSON',
  });
  assert.deepEqual(await readArtifactTrustIdentityResult(makeIndexStore().store, REQUEST_ID, SHA), { status: 'absent' });
});

test('a pointer or a record in another tenant store cannot substitute for the canonical index', async () => {
  const tenantA = makeIndexStore();
  const tenantB = indexed(productionReference());
  await tenantA.store.setJSON(`by-request/${REQUEST_ID}/image/${SHA}.json`, {
    requestId: REQUEST_ID, sha256: SHA, metadata: { tenant: 'other' },
  });
  assert.equal((await gatherTrustedArtifactRefs(carrier, tenantA.store)).trusted.size, 0);
  assert.equal((await gatherTrustedArtifactRefs(carrier, tenantB.store)).trusted.size, 1);
});

test('agent-output-only references retain their existing minimal contract', async () => {
  const result = await gatherTrustedArtifactRefs({
    ...carrier,
    agent_outputs: {
      writer: { output: { artifactReferences: [{ blobKey: BLOB_KEY }, null, { blobKey: 'not-an-artifact' }] } },
      ignored: { output: { artifactReferences: 'not-an-array' } },
    },
  });
  assert.deepEqual(result.trusted, new Set([BLOB_KEY]));
});

test('live object validation is provenance-insensitive and retains size/type for media policy', async () => {
  assert.deepEqual(await resolve(productionReference()), { exists: true, sizeBytes: 1005827, contentType: 'image/png' });
  assert.deepEqual(await resolve({ ...productionReference(), metadata: null }), {
    exists: true, sizeBytes: 1005827, contentType: 'image/png',
  });
  for (const fields of [{ sizeBytes: -1 }, { sizeBytes: '100' }, { sizeBytes: null }, { contentType: '' }, { contentType: 42 }]) {
    const resolution = await resolve({ ...productionReference(), ...fields });
    assert.equal(resolution?.exists, false);
    assert.ok(resolution?.indexIssue);
  }
});

test('PDF identity uses the same provenance-independent boundary', async () => {
  const blobKey = `pdf/${REQUEST_ID}/${SHA}.pdf`;
  const reference = { ...productionReference(), blobKey, artifactKind: 'pdf', contentType: 'application/pdf' };
  assert.deepEqual((await trust(reference)).trusted, new Set([blobKey]));
  assert.equal(publicPathForArtifactRef(blobKey), `/pdf/${REQUEST_ID}/${SHA}.pdf`);
});

test('unreadable index storage remains an error, not an absence or a trust grant', async () => {
  const { store } = makeIndexStore();
  store.get = async () => { throw new Error('index unavailable'); };
  await assert.rejects(readArtifactTrustIdentityResult(store, REQUEST_ID, SHA), /index unavailable/);
  const context = await buildStoreValidationContext(emptyObjectStore(), {
    artifactIndexStore: store, artifactRefSources: [BLOB_KEY],
  });
  assert.equal(context.resolveArtifactRef?.(BLOB_KEY), undefined);
  assert.deepEqual(context.artifactIndexUnreadable, [BLOB_KEY]);
});
