import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ArtifactKind,
  artifactKindValues,
  createArtifactBlobKey,
  createArtifactReference,
  getArtifactReferenceIssue,
  isArtifactReference,
  type ArtifactReference,
  type ReadableArtifactBlobStore,
} from '../../packages/core/server/lib/artifacts.js';
import {
  readArtifactReference,
  writeArtifactReferenceIndexes,
  type ArtifactIndexStore,
} from '../../packages/core/server/lib/artifact-index.js';
import { sha256Hex } from '../../packages/core/server/lib/crypto.js';

test('sha256Hex returns lowercase hexadecimal digests', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('artifact helpers produce stable blob keys and references', () => {
  const bytes = Buffer.from('artifact bytes');
  const reference = createArtifactReference({
    input: {
      requestId: 'req_test_hero_20260605_01',
      artifactKind: ArtifactKind.Image,
      contentType: 'image/png',
      filename: 'Hero Preview.PNG',
      label: 'Hero image',
      tags: ['hero', 'homepage'],
      metadata: { source: 'test' },
    },
    bytes,
    createdAtISO: '2026-06-05T00:00:00.000Z',
  });

  assert.equal(reference.blobKey, `image/req_test_hero_20260605_01/${reference.sha256}.png`);
  assert.equal(reference.sizeBytes, bytes.byteLength);
  assert.equal(reference.contentType, 'image/png');
  assert.equal(reference.createdAtISO, '2026-06-05T00:00:00.000Z');
  assert.equal(reference.artifactKind, ArtifactKind.Image);
  assert.equal(reference.originalFilename, 'Hero Preview.PNG');
  assert.equal(reference.label, 'Hero image');
  assert.deepEqual(reference.tags, ['hero', 'homepage']);
  assert.deepEqual(reference.metadata, { source: 'test' });
});

test('artifact blob keys reject request ids that are not path-safe (no silent generic fallback)', () => {
  // '///' normalizes to the empty string (normalizeMachineSafeId strips every
  // non [a-z0-9_] char) and MUST be rejected outright, not silently folded to
  // a shared generic path segment — that would let unrelated uploads collide
  // on the same blobKey. createArtifactBlobKey enforces validateRequestId
  // (the req_<flow>_<topic>_<yyyymmdd>_<nn> contract) with no fallback.
  const digest = 'a'.repeat(64);

  assert.throws(
    () =>
      createArtifactBlobKey({
        artifactKind: ArtifactKind.Doc,
        requestId: '///',
        sha256: digest,
        filename: 'notes.md',
      }),
    /request_id is required/
  );
});

test('artifact blob keys enforce the server artifactKind whitelist and sha256 format', () => {
  assert.deepEqual(artifactKindValues, ['image', 'pdf', 'video', 'doc', 'audio', 'data', 'attachment', 'other']);
  assert.throws(
    () =>
      createArtifactBlobKey({
        artifactKind: 'markdown' as ArtifactKind,
        requestId: 'req_test_generic_20260605_01',
        sha256: 'a'.repeat(64),
      }),
    /artifactKind must be one of/
  );
  assert.throws(
    () =>
      createArtifactBlobKey({
        artifactKind: ArtifactKind.Image,
        requestId: 'req_test_generic_20260605_01',
        sha256: 'abc123',
      }),
    /sha256 must be a 64-character hex digest/
  );
});

test('ArtifactReference validation rejects invented media handles and incomplete references', () => {
  const bytes = Buffer.from('validated artifact');
  const reference = createArtifactReference({
    input: {
      requestId: 'req_test_validation_20260605_01',
      artifactKind: ArtifactKind.Image,
      contentType: 'image/png',
      filename: 'validated.png',
    },
    bytes,
    createdAtISO: '2026-06-05T00:00:00.000Z',
  });

  assert.equal(isArtifactReference(reference), true);
  assert.equal(
    getArtifactReferenceIssue({ ...reference, url: 'https://example.com/deterministic.png' }),
    'unexpected top-level keys: url'
  );
  assert.match(
    getArtifactReferenceIssue({ blobKey: reference.blobKey, sha256: reference.sha256 }) ?? '',
    /sizeBytes must be a non-negative number/
  );
  assert.match(
    getArtifactReferenceIssue({ ...reference, blobKey: reference.blobKey.replace(/^image\//, 'markdown/') }) ?? '',
    /blobKey must match the server ArtifactReference path format/
  );
  assert.match(
    getArtifactReferenceIssue({ ...reference, artifactKind: 'markdown' }) ?? '',
    /artifactKind must be one of/
  );
  assert.match(
    getArtifactReferenceIssue({ ...reference, originalFilename: '../unsafe.png' }) ?? '',
    /originalFilename must be a filename/
  );
  assert.match(getArtifactReferenceIssue({ ...reference, label: '<script>' }) ?? '', /label must not contain/);
  assert.match(
    getArtifactReferenceIssue({ ...reference, tags: ['x'.repeat(41)] }) ?? '',
    /tags\[0\] must be at most 40/
  );
  assert.equal(
    getArtifactReferenceIssue({
      ...reference,
      deletedAtISO: '2026-06-10T00:00:00.000Z',
      deletedBy: 'admin@example.com',
    }),
    undefined
  );
  assert.match(
    getArtifactReferenceIssue({ ...reference, deletedAtISO: 'not-a-date' }) ?? '',
    /deletedAtISO must be a valid ISO date string/
  );
  assert.match(getArtifactReferenceIssue({ ...reference, deletedBy: '<admin>' }) ?? '', /deletedBy must not contain/);
});

test('S-20: materializationProof is a purely additive, opaque optional field', () => {
  const bytes = Buffer.from('proof-bearing artifact');
  const reference = createArtifactReference({
    input: {
      requestId: 'req_test_proof_20260605_01',
      artifactKind: ArtifactKind.Pdf,
      contentType: 'application/pdf',
      filename: 'proof.pdf',
    },
    bytes,
    createdAtISO: '2026-06-05T00:00:00.000Z',
  });

  // Present and well-formed: validates, and every OTHER field's meaning is untouched.
  const withProof = { ...reference, materializationProof: 'sig.eyJhbGciOiJIUzI1NiJ9.token' };
  assert.equal(getArtifactReferenceIssue(withProof), undefined);
  assert.equal(isArtifactReference(withProof), true);

  // A reference with no proof at all still validates exactly as before this field existed.
  assert.equal(getArtifactReferenceIssue(reference), undefined);
  assert.equal('materializationProof' in reference, false);

  // Malformed the same way any other bounded string field would be rejected.
  assert.match(
    getArtifactReferenceIssue({ ...reference, materializationProof: 42 }) ?? '',
    /materializationProof must be a string/
  );
  assert.match(
    getArtifactReferenceIssue({ ...reference, materializationProof: 'x'.repeat(8193) }) ?? '',
    /materializationProof must be at most 8192 characters/
  );
});

test('S-20: an ingested reference carrying a proof persists it; one without it is unchanged', async () => {
  const values = new Map<string, string>();
  const indexStore: ArtifactIndexStore = {
    async get(key) {
      return values.get(key) ?? null;
    },
    async setJSON(key, value) {
      values.set(key, JSON.stringify(value));
      return { modified: true };
    },
    async list() {
      return { blobs: [], directories: [] };
    },
  };

  const bytes = Buffer.from('ingest-time proof artifact');
  const reference = createArtifactReference({
    input: {
      requestId: 'req_test_ingest_proof_20260605_01',
      artifactKind: ArtifactKind.Pdf,
      contentType: 'application/pdf',
      filename: 'ingested.pdf',
    },
    bytes,
    createdAtISO: '2026-06-05T00:00:00.000Z',
  });
  const withProof: ArtifactReference = { ...reference, materializationProof: 'attn.proof.value' };

  await writeArtifactReferenceIndexes(indexStore, 'req_test_ingest_proof_20260605_01', withProof);
  const readBack = await readArtifactReference(indexStore, 'req_test_ingest_proof_20260605_01', reference.sha256);
  assert.equal(readBack?.materializationProof, 'attn.proof.value');
  // Every existing field kept its value across the round trip.
  assert.equal(readBack?.blobKey, reference.blobKey);
  assert.equal(readBack?.sha256, reference.sha256);
  assert.equal(readBack?.contentType, reference.contentType);

  // A second ingest with no proof at all round-trips exactly as it always has.
  const requestIdNoProof = 'req_test_ingest_noproof_20260605_01';
  const referenceNoProof = createArtifactReference({
    input: {
      requestId: requestIdNoProof,
      artifactKind: ArtifactKind.Pdf,
      contentType: 'application/pdf',
      filename: 'unproven.pdf',
    },
    bytes: Buffer.from('no proof here'),
    createdAtISO: '2026-06-05T00:00:00.000Z',
  });
  await writeArtifactReferenceIndexes(indexStore, requestIdNoProof, referenceNoProof);
  const readBackNoProof = await readArtifactReference(indexStore, requestIdNoProof, referenceNoProof.sha256);
  assert.equal(readBackNoProof ? 'materializationProof' in readBackNoProof : true, false);
});

type FakeArtifactStoreValue = Buffer | string;

const createFakeArtifactStore = (initialValues: Record<string, FakeArtifactStoreValue> = {}) => {
  const values = new Map<string, FakeArtifactStoreValue>(Object.entries(initialValues));

  const store: ReadableArtifactBlobStore = {
    async get(key: string, options: { type: 'arrayBuffer' }) {
      const value = values.get(key);
      if (value === undefined) return null;
      const bytes = typeof value === 'string' ? Buffer.from(value) : value;
      if (options?.type === 'arrayBuffer')
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return bytes;
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? '';
      return {
        blobs: [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        directories: [],
      };
    },
  };

  return { values, store };
};

const createFakeIndexStore = () => {
  const values = new Map<string, unknown>();

  return {
    values,
    store: {
      async setJSON(key: string, value: unknown) {
        values.set(key, value);
      },
    },
  };
};

const makeImageReference = (requestId: string, bytes = Buffer.from('image bytes'), filename = 'hero.jpg') =>
  createArtifactReference({
    input: { requestId, artifactKind: ArtifactKind.Image, contentType: 'image/jpeg', filename },
    bytes,
    createdAtISO: '2026-06-05T00:00:00.000Z',
  });

test('reconcileImageArtifactReference reads a valid reference with valid blob bytes', async () => {
  const reference = makeImageReference('req_test_validref_20260605_01');
  const { store } = createFakeArtifactStore({ [reference.blobKey]: Buffer.from('image bytes') });
  const { reconcileImageArtifactReference } = await import('../../packages/core/server/lib/artifacts.js');

  const result = await reconcileImageArtifactReference(reference, store);

  assert.equal(result.status, 'found');
  assert.equal(result.blobKey, reference.blobKey);
  assert.equal(result.status === 'found' ? result.bytes.toString() : '', 'image bytes');
});

test('reconcileArtifactReference normalizes stale blobKeys and corrects artifact-index JSON', async () => {
  const reference = makeImageReference('req_test_normalizedstale_20260605_01');
  const staleReference = { ...reference, blobKey: `artifacts/${reference.blobKey}` } as ArtifactReference;
  const { store } = createFakeArtifactStore({ [reference.blobKey]: Buffer.from('normalized bytes') });
  const { values, store: indexStore } = createFakeIndexStore();
  const loggedCorrections: unknown[] = [];
  const { reconcileArtifactReference } = await import('../../packages/core/server/lib/artifacts.js');

  const result = await reconcileArtifactReference(staleReference, store, indexStore, {
    logger: { warn: (...args: unknown[]) => loggedCorrections.push(args) },
  });

  assert.equal(result.status, 'found');
  assert.equal(result.blobKey, reference.blobKey);
  assert.equal(result.status === 'found' ? result.correctedBlobKey : '', reference.blobKey);
  assert.deepEqual(values.get(`request-artifacts/req_test_normalizedstale_20260605_01/${reference.sha256}.json`), {
    ...reference,
    blobKey: reference.blobKey,
  });
  assert.equal(loggedCorrections.length, 1);
});

test('reconcileImageArtifactReference reads from stores that only support arrayBuffer binary reads', async () => {
  const reference = makeImageReference(
    'req_test_arraybufferonly_20260605_01',
    Buffer.from('array buffer bytes'),
    'arraybuffer.jpg'
  );
  const values = new Map([[reference.blobKey, Buffer.from('array buffer bytes')]]);
  const { reconcileImageArtifactReference } = await import('../../packages/core/server/lib/artifacts.js');
  const store: ReadableArtifactBlobStore = {
    async get(key: string, options: { type: 'arrayBuffer' }) {
      assert.equal(options.type, 'arrayBuffer');
      const value = values.get(key);
      if (!value) return null;
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
    },
  };

  const result = await reconcileImageArtifactReference(reference, store);

  assert.equal(result.status, 'found');
  assert.equal(result.status === 'found' ? result.bytes.toString() : '', 'array buffer bytes');
});
test('reconcileImageArtifactReference reports valid JSON with missing blob bytes as missing', async () => {
  const reference = makeImageReference('req_test_missingref_20260605_01');
  const { store } = createFakeArtifactStore();
  const { reconcileImageArtifactReference } = await import('../../packages/core/server/lib/artifacts.js');

  const result = await reconcileImageArtifactReference(reference, store);

  assert.equal(result.status, 'missing');
  assert.equal(result.blobKey, reference.blobKey);
});

test('reconcileImageArtifactReference recovers a blob stored under duplicated artifacts/image prefix', async () => {
  const reference = makeImageReference('req_test_dupprefix_20260605_01');
  const correctedKey = `artifacts/${reference.blobKey}`;
  const { store } = createFakeArtifactStore({ [correctedKey]: Buffer.from('prefixed bytes') });
  const { values, store: indexStore } = createFakeIndexStore();
  const { reconcileImageArtifactReference } = await import('../../packages/core/server/lib/artifacts.js');

  const result = await reconcileImageArtifactReference(reference, store, indexStore);

  assert.equal(result.status, 'found');
  assert.equal(result.blobKey, correctedKey);
  assert.equal(result.status === 'found' ? result.correctedBlobKey : '', correctedKey);
  assert.equal(
    values.has(`request-artifacts/req_test_dupprefix_20260605_01/${reference.sha256}.json`),
    false,
    'legacy prefixed keys should not be written back as invalid ArtifactReference blobKeys'
  );
});

test('reconcileImageArtifactReference recovers a blob stored under a leading slash prefix', async () => {
  const reference = makeImageReference('req_test_leadingslash_20260605_01');
  const correctedKey = `/${reference.blobKey}`;
  const { store } = createFakeArtifactStore({ [correctedKey]: Buffer.from('slash bytes') });
  const { reconcileImageArtifactReference } = await import('../../packages/core/server/lib/artifacts.js');

  const result = await reconcileImageArtifactReference(reference, store);

  assert.equal(result.status, 'found');
  assert.equal(result.blobKey, correctedKey);
});

test('reconcileImageArtifactReference recovers a same-filename blob stored under a different request prefix', async () => {
  const reference = makeImageReference('req_test_stalereq_20260605_01', Buffer.from('moved bytes'), 'hero.png');
  const correctedKey = reference.blobKey.replace(
    'image/req_test_stalereq_20260605_01/',
    'image/req_test_currentreq_20260605_01/'
  );
  const { store } = createFakeArtifactStore({ [correctedKey]: Buffer.from('moved bytes') });
  const { values, store: indexStore } = createFakeIndexStore();
  const { reconcileImageArtifactReference } = await import('../../packages/core/server/lib/artifacts.js');

  const result = await reconcileImageArtifactReference(reference, store, indexStore);

  assert.equal(result.status, 'found');
  assert.equal(result.blobKey, correctedKey);
  assert.deepEqual(values.get(`request-artifacts/req_test_currentreq_20260605_01/${reference.sha256}.json`), {
    ...reference,
    blobKey: correctedKey,
  });
});
test('reconcileImageArtifactReference falls back across jpg jpeg png webp extensions by sha basename', async () => {
  const reference = makeImageReference('req_test_extfallback_20260605_01', Buffer.from('extension bytes'), 'hero.jpg');
  const correctedKey = reference.blobKey.replace(/\.jpg$/, '.jpeg');
  const { store } = createFakeArtifactStore({ [correctedKey]: Buffer.from('extension bytes') });
  const { reconcileImageArtifactReference } = await import('../../packages/core/server/lib/artifacts.js');

  const result = await reconcileImageArtifactReference(reference, store);

  assert.equal(result.status, 'found');
  assert.equal(result.blobKey, correctedKey);
});
