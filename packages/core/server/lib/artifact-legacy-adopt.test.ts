/**
 * T-ASSET-IDENTITY Part 4 — coverage for `adoptLegacyArtifactOwnership`.
 *
 *   - a legacy request with exactly ONE citing active object adopts, writes
 *     the SAME `request-owner` pointer contract a fresh #308 capture would
 *     write, and (for a `page` owner) is stamped `pageOwnershipOnly: true`.
 *   - a legacy request with ZERO citing objects is a NAMED blocker
 *     (`no_recorded_evidence`), never a guessed owner.
 *   - a legacy request with MORE THAN ONE citing object is a NAMED blocker
 *     (`ambiguous_evidence`) carrying a shortlist, never an arbitrary pick.
 *   - a request that already has a registered owner is blocked
 *     (`already_owned`) and is never re-pointed.
 */
import '../../../../sites/drlurie/config/policy-bindings.js';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalBlobStore, setLocalBlobsRootForTesting } from './local-blobs.js';
import {
  writeArtifactReferenceIndexes,
  writeRequestOwner,
  readRequestOwner,
  type ArtifactIndexStore,
} from './artifact-index.js';
import type { ArtifactSweepListStore } from './artifact-dedupe-sweep.js';
import type { ArtifactReference } from './artifacts.js';
import { adoptLegacyArtifactOwnership } from './artifact-legacy-adopt.js';

const PLATFORM_VARS = [
  'NETLIFY_SITE_ID',
  'SITE_ID',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'NETLIFY_BLOBS_API_URL',
];
const savedEnv: Record<string, string | undefined> = {};

const REQUEST_ID = 'req_capture_legacy_adopt_20260910_01';
const SITE = 'site_test_tenant';
const SHA_A = 'a'.repeat(64);

const ref = (): ArtifactReference => ({
  blobKey: `image/${REQUEST_ID}/${SHA_A}.jpg`,
  sizeBytes: 2048,
  sha256: SHA_A,
  contentType: 'image/jpeg',
  createdAtISO: '2026-01-01T00:00:00.000Z',
  artifactKind: 'image',
});

/** Seeds one active object of `objectType` whose body embeds the artifact's raw blobKey. */
const seedCitingObject = async (
  objectsStore: ReturnType<typeof createLocalBlobStore>,
  objectType: string,
  objectId: string,
  blobKey: string
) => {
  await objectsStore.set(`objects/${objectType}/index/by-status/active/${objectId}`, '1');
  await objectsStore.setJSON(`objects/${objectType}/by-id/${objectId}.json`, { id: objectId, hero: { src: blobKey } });
};

describe('artifact-legacy-adopt: adoptLegacyArtifactOwnership (T-ASSET-IDENTITY Part 4)', () => {
  let root: string;
  let indexStore: ArtifactIndexStore;
  let objectsStore: ReturnType<typeof createLocalBlobStore>;

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
    root = await mkdtemp(join(tmpdir(), 'artifact-legacy-adopt-'));
    setLocalBlobsRootForTesting(root);
    indexStore = createLocalBlobStore('artifact-index') as unknown as ArtifactIndexStore;
    objectsStore = createLocalBlobStore('site-objects');
  });

  after(async () => {
    setLocalBlobsRootForTesting(undefined);
  });

  const deps = () => ({
    indexStore,
    objectsStore: objectsStore as unknown as ArtifactSweepListStore,
    site: SITE,
    registeredBy: 'legacy_adoption_test',
  });

  it('no_live_artifacts: a request with no artifact references at all is blocked, not adopted', async () => {
    const result = await adoptLegacyArtifactOwnership(deps(), 'req_capture_never_written_20260910_01');
    assert.strictEqual(result.status, 'blocked');
    if (result.status !== 'blocked') return;
    assert.strictEqual(result.blocker, 'no_live_artifacts');
  });

  it('no_recorded_evidence: artifacts exist, but NO active object of any type cites them — a named blocker, never a guess', async () => {
    await writeArtifactReferenceIndexes(indexStore, REQUEST_ID, ref());

    const result = await adoptLegacyArtifactOwnership(deps(), REQUEST_ID);
    assert.strictEqual(result.status, 'blocked');
    if (result.status !== 'blocked') return;
    assert.strictEqual(result.blocker, 'no_recorded_evidence');
    assert.match(result.detail, /no.*evidence|predates the ownership contract/i);

    // Never guessed: still no owner registered.
    assert.strictEqual(await readRequestOwner(indexStore, REQUEST_ID), undefined);
  });

  it('adopts from a SINGLE citing page object, writing the same request-owner contract a fresh #308 capture would', async () => {
    await writeArtifactReferenceIndexes(indexStore, REQUEST_ID, ref());
    await seedCitingObject(objectsStore, 'page', 'page_capture_home', ref().blobKey);

    const result = await adoptLegacyArtifactOwnership(deps(), REQUEST_ID);
    assert.strictEqual(result.status, 'adopted');
    if (result.status !== 'adopted') return;
    assert.strictEqual(result.owner.object_type, 'page');
    assert.strictEqual(result.owner.object_id, 'page_capture_home');
    assert.strictEqual(result.owner.site, SITE);
    // Page ownership is never proof of PDF-template binding — stamped so a
    // caller cannot mistake "a page cites this artifact" for a resolved slot.
    assert.strictEqual(result.pageOwnershipOnly, true);

    const written = await readRequestOwner(indexStore, REQUEST_ID);
    assert.ok(written);
    assert.strictEqual(written?.object_type, 'page');
    assert.strictEqual(written?.object_id, 'page_capture_home');
    assert.strictEqual(written?.site, SITE);
  });

  it('adopts from a single citing content_item WITHOUT the pageOwnershipOnly caveat', async () => {
    await writeArtifactReferenceIndexes(indexStore, REQUEST_ID, ref());
    await seedCitingObject(objectsStore, 'content_item', 'content_item_article_1', ref().blobKey);

    const result = await adoptLegacyArtifactOwnership(deps(), REQUEST_ID);
    assert.strictEqual(result.status, 'adopted');
    if (result.status !== 'adopted') return;
    assert.strictEqual(result.owner.object_type, 'content_item');
    assert.strictEqual(result.pageOwnershipOnly, false);
  });

  it('ambiguous_evidence: TWO distinct citing objects yield a shortlist, never an arbitrary pick', async () => {
    await writeArtifactReferenceIndexes(indexStore, REQUEST_ID, ref());
    await seedCitingObject(objectsStore, 'page', 'page_capture_home', ref().blobKey);
    await seedCitingObject(objectsStore, 'content_item', 'content_item_article_1', ref().blobKey);

    const result = await adoptLegacyArtifactOwnership(deps(), REQUEST_ID);
    assert.strictEqual(result.status, 'blocked');
    if (result.status !== 'blocked') return;
    assert.strictEqual(result.blocker, 'ambiguous_evidence');
    assert.strictEqual(result.shortlist?.length, 2);

    assert.strictEqual(await readRequestOwner(indexStore, REQUEST_ID), undefined);
  });

  it('already_owned: a request with a registered owner is blocked and never re-pointed', async () => {
    await writeArtifactReferenceIndexes(indexStore, REQUEST_ID, ref());
    const original = await writeRequestOwner(indexStore, REQUEST_ID, {
      object_type: 'page',
      object_id: 'page_original_owner',
      site: SITE,
      registered_by: 'original',
    });
    assert.strictEqual(original.ok, true);

    // Evidence exists too, for a DIFFERENT object — proving adoption checks
    // already_owned FIRST and never overwrites, even when it could resolve.
    await seedCitingObject(objectsStore, 'page', 'page_capture_home', ref().blobKey);

    const result = await adoptLegacyArtifactOwnership(deps(), REQUEST_ID);
    assert.strictEqual(result.status, 'blocked');
    if (result.status !== 'blocked') return;
    assert.strictEqual(result.blocker, 'already_owned');

    const stillOwner = await readRequestOwner(indexStore, REQUEST_ID);
    assert.strictEqual(stillOwner?.object_id, 'page_original_owner');
  });
});
