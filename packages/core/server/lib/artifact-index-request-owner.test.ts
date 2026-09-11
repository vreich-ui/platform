/**
 * The `request-owner/<requestId>.json` record: does an owner written by one
 * call come back out of a real store, and does the pointer hold still?
 *
 * The record exists because an artifact request id used to BE a content_item
 * id, so anything that was not an article — a captured page's imagery, a
 * visual_standard's example images — could not own artifacts at all. This
 * pointer is what a media op consults to decide whose site bytes may be
 * written into, which is why the two behaviours asserted here are not
 * conveniences:
 *
 *   * re-registering the SAME owner is a free no-op, because capture re-runs
 *     and retried uploads register on every pass and must not start failing
 *     on the second one;
 *   * re-pointing a request at a DIFFERENT owner is a 409, because that is a
 *     privilege transfer — it would let whoever registers second inherit
 *     every artifact already stored under that request id.
 *
 * Driven against a real file-backed store, like artifact-index-tag-roundtrip,
 * so the JSON round trip and the key shape are exercised rather than mocked.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalBlobStore, setLocalBlobsRootForTesting } from './local-blobs.js';
import {
  ARTIFACT_REQUEST_OWNER_TYPES,
  normalizeArtifactRequestOwnerInput,
  readRequestOwner,
  requestOwnerKey,
  writeRequestOwner,
  type ArtifactIndexStore,
} from './artifact-index.js';

const REQUEST_ID = 'req_capture_zilberman_20260910_01';
const SITE = 'site_zilberman';

const withStore = async (run: (store: ArtifactIndexStore) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-index-owner-'));
  setLocalBlobsRootForTesting(root);
  try {
    await run(createLocalBlobStore('artifact-index') as unknown as ArtifactIndexStore);
  } finally {
    setLocalBlobsRootForTesting(undefined);
    await rm(root, { recursive: true, force: true });
  }
};

describe('artifact index: request-owner record', () => {
  it('round-trips a page owner through a real store', async () => {
    await withStore(async (store) => {
      const written = await writeRequestOwner(store, REQUEST_ID, {
        object_type: 'page',
        object_id: 'page_home',
        site: SITE,
        registered_by: 'create_artifact_from_url',
        registered_at: '2026-09-10T00:00:00.000Z',
      });

      assert.equal(written.ok, true);
      assert.equal(written.ok && written.changed, true);

      const read = await readRequestOwner(store, REQUEST_ID);
      assert.deepEqual(read, {
        object_type: 'page',
        object_id: 'page_home',
        site: SITE,
        registered_at: '2026-09-10T00:00:00.000Z',
        registered_by: 'create_artifact_from_url',
      });
    });
  });

  it('reads back as absent when no owner was ever registered', async () => {
    await withStore(async (store) => {
      assert.equal(await readRequestOwner(store, 'req_capture_nobody_20260910_01'), undefined);
    });
  });

  it('is idempotent: re-registering the SAME owner changes nothing and is not an error', async () => {
    await withStore(async (store) => {
      await writeRequestOwner(store, REQUEST_ID, {
        object_type: 'page',
        object_id: 'page_home',
        site: SITE,
        registered_by: 'create_artifact_from_url',
        registered_at: '2026-09-10T00:00:00.000Z',
      });

      // A later pass of the same capture: different clock, different caller,
      // same owner. It must neither fail nor rewrite the record.
      const again = await writeRequestOwner(store, REQUEST_ID, {
        object_type: 'page',
        object_id: 'page_home',
        site: SITE,
        registered_by: 'save_artifact',
        registered_at: '2026-09-11T12:00:00.000Z',
      });

      assert.equal(again.ok, true);
      assert.equal(again.ok && again.changed, false);
      assert.equal(again.ok && again.owner.registered_at, '2026-09-10T00:00:00.000Z');
      assert.equal(again.ok && again.owner.registered_by, 'create_artifact_from_url');
    });
  });

  it('refuses a DIFFERENT owner with a 409 artifact_request_owner_conflict and writes nothing', async () => {
    await withStore(async (store) => {
      await writeRequestOwner(store, REQUEST_ID, {
        object_type: 'page',
        object_id: 'page_home',
        site: SITE,
        registered_by: 'create_artifact_from_url',
      });

      const hijack = await writeRequestOwner(store, REQUEST_ID, {
        object_type: 'content_item',
        object_id: 'req_capture_zilberman_20260910_01',
        site: SITE,
        registered_by: 'someone_else',
      });

      assert.equal(hijack.ok, false);
      assert.equal(!hijack.ok && hijack.statusCode, 409);
      assert.equal(!hijack.ok && hijack.errorCode, 'artifact_request_owner_conflict');
      assert.equal(!hijack.ok && hijack.owner?.object_id, 'page_home');

      const stored = await readRequestOwner(store, REQUEST_ID);
      assert.equal(stored?.object_type, 'page');
      assert.equal(stored?.object_id, 'page_home');
    });
  });

  it('a same-id owner of a DIFFERENT type is still a conflict', async () => {
    await withStore(async (store) => {
      await writeRequestOwner(store, REQUEST_ID, {
        object_type: 'page',
        object_id: 'obj_shared_id',
        site: SITE,
        registered_by: 'create_artifact_from_url',
      });

      const other = await writeRequestOwner(store, REQUEST_ID, {
        object_type: 'section',
        object_id: 'obj_shared_id',
        site: SITE,
        registered_by: 'create_artifact_from_url',
      });

      assert.equal(other.ok, false);
      assert.equal(!other.ok && other.errorCode, 'artifact_request_owner_conflict');
    });
  });

  it('refuses an object_type outside the allowlist before it can reach the store', async () => {
    await withStore(async (store) => {
      const refused = await writeRequestOwner(store, REQUEST_ID, {
        object_type: 'theme',
        object_id: 'thm_capture_x',
        site: SITE,
        registered_by: 'create_artifact_from_url',
      });

      assert.equal(refused.ok, false);
      assert.equal(!refused.ok && refused.errorCode, 'artifact_request_owner_invalid');
      assert.equal(await readRequestOwner(store, REQUEST_ID), undefined);
    });
  });

  it('keys the record under request-owner/<encodeURIComponent(requestId)>.json', () => {
    assert.equal(requestOwnerKey('req_a/b'), 'request-owner/req_a%2Fb.json');
  });

  it('never admits a wildcard owner type', () => {
    assert.ok(!(ARTIFACT_REQUEST_OWNER_TYPES as readonly string[]).includes('*'));
    assert.deepEqual(
      [...ARTIFACT_REQUEST_OWNER_TYPES],
      ['content_item', 'page', 'section', 'site', 'visual_standard', 'product']
    );
  });
});

describe('artifact index: owner argument normalization', () => {
  it('treats an omitted owner as "no pointer", not as an error', () => {
    assert.deepEqual(normalizeArtifactRequestOwnerInput(undefined), { ok: true });
    assert.deepEqual(normalizeArtifactRequestOwnerInput(null), { ok: true });
  });

  it('accepts an allowlisted owner and trims the id', () => {
    const normalized = normalizeArtifactRequestOwnerInput({ object_type: 'page', object_id: ' page_home ' });
    assert.equal(normalized.ok, true);
    assert.deepEqual(normalized.ok && normalized.owner, { object_type: 'page', object_id: 'page_home' });
  });

  it('refuses a type outside the allowlist and a missing id', () => {
    assert.equal(normalizeArtifactRequestOwnerInput({ object_type: 'theme', object_id: 'x' }).ok, false);
    assert.equal(normalizeArtifactRequestOwnerInput({ object_type: 'page', object_id: '  ' }).ok, false);
    assert.equal(normalizeArtifactRequestOwnerInput('page_home').ok, false);
  });
});
