/**
 * The cost of `admin-editorial-assets` is "blob reads per listed artifact",
 * and the wire response cannot show it. These tests pin it against a counting
 * store whose `list()` emits a REAL etag per key — sha1 of the stored value,
 * bumped by every write — because the whole projection rests on that etag
 * changing when a record's bytes change and staying put when they do not.
 *
 * What is pinned:
 *   - cold: one projection read + one read per record, one write;
 *   - warm and unchanged: one projection read, ZERO record reads, zero
 *     writes — however large the store is;
 *   - one record edited: exactly one record read, one write;
 *   - a record soft-deleted: its row leaves the listing;
 *   - a store that reports no etags (`local-blobs.ts`): degrades to the old
 *     full-read cost and never persists a projection it could not verify;
 *   - the cold-start budget converges in ⌈A/budget⌉ loads.
 *
 * And the three ways a cache of this shape gets a listing WRONG rather than
 * merely slow, each pinned at the bottom of this file:
 *   - a verdict that belongs to the BUILD, not the record, is never
 *     remembered against an etag that will never move again;
 *   - a partial sweep never replaces a projection it could not read;
 *   - which of two records for one digest is served does not depend on which
 *     half of the sweep — cached or freshly read — it came from.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  EDITORIAL_PROJECTION_KEY,
  RESULT_LIMIT,
  sweepEditorialArtifacts,
} from '../../packages/core/server/lib/artifact-listing-projection.js';

const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');

/**
 * `etags: false` reproduces the local file-backed store, which reports
 * `etag: ''` — the "unverifiable" case every projection in this repo has to
 * degrade around rather than trust.
 */
const countingStore = (
  entries: Map<string, string>,
  options: { etags?: boolean; failProjectionGet?: boolean } = {}
) => {
  const withEtags = options.etags ?? true;
  const reads: string[] = [];
  const writes: string[] = [];
  const lists: string[] = [];
  let inFlight = 0;
  let peakInFlight = 0;
  return {
    entries,
    reads,
    writes,
    lists,
    peak: () => peakInFlight,
    resetCounters() {
      reads.length = 0;
      writes.length = 0;
    },
    recordReads: () => reads.filter((key) => key.startsWith('request-artifacts/')),
    async get(key: string) {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        reads.push(key);
        // `failProjectionGet` is the transient blob-read failure this store
        // already sees under load (the 2026-08-06 concurrency hotfix in
        // blob-list.ts), aimed at the one key whose loss is not free.
        if (options.failProjectionGet && key === EDITORIAL_PROJECTION_KEY) throw new Error('transient blob read failure');
        return entries.get(key) ?? null;
      } finally {
        inFlight -= 1;
      }
    },
    async setJSON(key: string, value: unknown) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      writes.push(key);
      entries.set(key, JSON.stringify(value));
    },
    async list({ prefix = '' }: { prefix?: string } = {}) {
      lists.push(prefix);
      return {
        blobs: [...entries.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, etag: withEtags ? sha1(value) : '' })),
      };
    },
  };
};

const recordKey = (requestId: string, sha: string) => `request-artifacts/${encodeURIComponent(requestId)}/${sha}.json`;

const shaFor = (i: number) => String(i).padStart(64, 'a');
const requestFor = (kind: 'image' | 'pdf', i: number) => `req_perf_${kind}${i}_20260901_01`;

/** Strictly ascending with `i`, so the newest artifacts are the highest `i`. */
const createdFor = (i: number) => new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString();

const seedRecords = (count: number, kind: 'image' | 'pdf', options: { deleteEvery?: number } = {}) => {
  const entries = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    const sha = shaFor(i);
    const requestId = requestFor(kind, i);
    const deleted = options.deleteEvery ? i % options.deleteEvery === 0 : false;
    entries.set(
      recordKey(requestId, sha),
      JSON.stringify({
        blobKey: `${kind}/${requestId}/${sha}.${kind === 'pdf' ? 'pdf' : 'png'}`,
        sha256: sha,
        sizeBytes: 100 + i,
        contentType: kind === 'pdf' ? 'application/pdf' : 'image/png',
        createdAtISO: createdFor(i),
        artifactKind: kind,
        originalFilename: `${kind}-${i}.${kind === 'pdf' ? 'pdf' : 'png'}`,
        ...(deleted ? { deletedAtISO: '2026-09-02T00:00:00.000Z' } : {}),
      })
    );
  }
  return entries;
};

test('cold sweep reads every record once, writes the projection once, and answers the newest 100', async () => {
  const ARTIFACTS = 250;
  const store = countingStore(seedRecords(ARTIFACTS, 'image'));

  const result = await sweepEditorialArtifacts(store as never);

  assert.equal(store.reads.filter((key) => key === EDITORIAL_PROJECTION_KEY).length, 1, 'one projection read');
  assert.equal(store.recordReads().length, ARTIFACTS, 'a cold projection reads every record exactly once');
  assert.equal(new Set(store.recordReads()).size, ARTIFACTS, 'no record is read twice in one sweep');
  assert.deepEqual(store.writes, [EDITORIAL_PROJECTION_KEY], 'exactly one write: the projection itself');
  assert.equal(result.complete, true);
  assert.equal(result.stats.cached, 0);
  assert.equal(result.stats.read, ARTIFACTS);
  assert.equal(result.stats.rebuilt, false, 'a cold store is not a rebuild');

  assert.equal(result.byKind.image.length, RESULT_LIMIT);
  assert.equal(result.byKind.pdf.length, 0);
  assert.equal(result.byKind.image[0]?.id, shaFor(ARTIFACTS - 1), 'the newest artifact leads');
  const created = result.byKind.image.map((artifact) => artifact.created_at);
  assert.deepEqual(
    created,
    [...created].sort((a, b) => b.localeCompare(a)),
    'newest first'
  );
});

test('a warm, unchanged store costs ONE read and no writes, at every size', async () => {
  for (const ARTIFACTS of [50, 500, 2000]) {
    const entries = seedRecords(ARTIFACTS, 'image');
    // Converge first: at the default budget a 2,000-record tenant is cold for
    // two loads, which is exactly the behaviour P2 asks for.
    let first = await sweepEditorialArtifacts(countingStore(entries) as never);
    while (!first.complete) first = await sweepEditorialArtifacts(countingStore(entries) as never);

    const warm = countingStore(entries);
    const second = await sweepEditorialArtifacts(warm as never);

    assert.equal(warm.recordReads().length, 0, `A=${ARTIFACTS}: a warm sweep reads no records`);
    assert.deepEqual(warm.reads, [EDITORIAL_PROJECTION_KEY], `A=${ARTIFACTS}: the projection is the only read`);
    // The whole claim of this module, in two numbers: ONE list, ONE get, for
    // both kinds, however large the tenant is.
    assert.deepEqual(warm.lists, ['request-artifacts/'], `A=${ARTIFACTS}: one listing, of the records`);
    assert.equal(warm.writes.length, 0, `A=${ARTIFACTS}: nothing changed, nothing written`);
    assert.equal(second.stats.cached, ARTIFACTS);
    assert.equal(second.stats.read, 0);
    assert.deepEqual(
      second.byKind.image.map((artifact) => artifact.id),
      first.byKind.image.map((artifact) => artifact.id),
      `A=${ARTIFACTS}: a cached sweep answers exactly what the cold one did`
    );
  }
});

test('one changed record costs exactly one record read and one write', async () => {
  const entries = seedRecords(120, 'image');
  await sweepEditorialArtifacts(countingStore(entries) as never);

  // Inside the newest 100 (the fixture holds 120), so the re-read row is one
  // the listing actually returns.
  const changedKey = recordKey(requestFor('image', 115), shaFor(115));
  const changed = JSON.parse(entries.get(changedKey) as string) as Record<string, unknown>;
  entries.set(changedKey, JSON.stringify({ ...changed, label: 'Renamed by an editor' }));

  const store = countingStore(entries);
  const result = await sweepEditorialArtifacts(store as never);

  assert.deepEqual(store.recordReads(), [changedKey], 'only the record whose etag moved is re-read');
  assert.deepEqual(store.writes, [EDITORIAL_PROJECTION_KEY]);
  assert.equal(result.stats.read, 1);
  assert.equal(result.stats.cached, 119);
  const row = result.byKind.image.find((artifact) => artifact.id === shaFor(115));
  assert.equal(row?.label, 'Renamed by an editor', 'the re-read row is the one served');
});

test('a soft-deleted record leaves the listing, and stays out without being re-read', async () => {
  const entries = seedRecords(30, 'image');
  const first = await sweepEditorialArtifacts(countingStore(entries) as never);
  assert.equal(first.byKind.image.length, 30);

  const deletedKey = recordKey(requestFor('image', 7), shaFor(7));
  const record = JSON.parse(entries.get(deletedKey) as string) as Record<string, unknown>;
  entries.set(deletedKey, JSON.stringify({ ...record, deletedAtISO: '2026-09-03T00:00:00.000Z' }));

  const store = countingStore(entries);
  const second = await sweepEditorialArtifacts(store as never);

  assert.deepEqual(store.recordReads(), [deletedKey]);
  assert.equal(second.byKind.image.length, 29);
  assert.ok(
    !second.byKind.image.some((artifact) => artifact.id === shaFor(7)),
    'a soft-deleted artifact is never returned'
  );

  // And the deletion is REMEMBERED: a deleted record must not be re-read on
  // every later load just because it contributes no row.
  const third = countingStore(entries);
  await sweepEditorialArtifacts(third as never);
  assert.equal(third.recordReads().length, 0, 'a known-deleted record costs nothing on the next sweep');
  assert.equal(third.writes.length, 0);
});

test('a store that reports no etags degrades to the old cost and persists nothing', async () => {
  const ARTIFACTS = 40;
  const entries = seedRecords(ARTIFACTS, 'pdf');
  const store = countingStore(entries, { etags: false });

  const result = await sweepEditorialArtifacts(store as never);

  assert.equal(store.recordReads().length, ARTIFACTS, 'every record is read, exactly as before this module existed');
  assert.equal(store.writes.length, 0, 'a projection that cannot be verified is never written');
  assert.equal(result.complete, true, 'unverifiable is not incomplete — the rows are all there');
  assert.equal(result.byKind.pdf.length, ARTIFACTS);
  assert.equal(entries.has(EDITORIAL_PROJECTION_KEY), false);
});

test('a corrupt or superseded projection is rebuilt in place', async () => {
  const entries = seedRecords(20, 'image');
  entries.set(EDITORIAL_PROJECTION_KEY, '{ not json');

  const store = countingStore(entries);
  const result = await sweepEditorialArtifacts(store as never);

  assert.equal(result.stats.rebuilt, true, 'a blob that was there and could not be used is a REBUILD');
  assert.equal(store.recordReads().length, 20);
  assert.deepEqual(store.writes, [EDITORIAL_PROJECTION_KEY]);
  assert.equal(result.byKind.image.length, 20);

  entries.set(
    EDITORIAL_PROJECTION_KEY,
    JSON.stringify({ schema_version: 'editorial-assets-projection.v0', seq: 9, updated_at: 'x', entries: [] })
  );
  const afterBump = await sweepEditorialArtifacts(countingStore(entries) as never);
  assert.equal(afterBump.stats.rebuilt, true, 'a schema bump rebuilds by the same path — no script, no migration');
  assert.equal(afterBump.byKind.image.length, 20);
});

test('both kinds come from ONE sweep, each capped and deduped on its own', async () => {
  const entries = new Map([...seedRecords(140, 'image'), ...seedRecords(20, 'pdf')]);
  // The same digest under two request ids — one artifact, two records. The
  // listing must show it once.
  const duplicateSha = shaFor(139);
  const twinRequest = 'req_perf_image139_twin_20260901_01';
  entries.set(
    recordKey(twinRequest, duplicateSha),
    JSON.stringify({
      blobKey: `image/${twinRequest}/${duplicateSha}.png`,
      sha256: duplicateSha,
      sizeBytes: 999,
      contentType: 'image/png',
      createdAtISO: createdFor(139),
      artifactKind: 'image',
      originalFilename: 'twin.png',
    })
  );

  const store = countingStore(entries);
  const result = await sweepEditorialArtifacts(store as never);

  assert.equal(store.reads.filter((key) => key.startsWith('by-kind/')).length, 0, 'pointers are not consulted at all');
  assert.equal(result.byKind.image.length, RESULT_LIMIT);
  assert.equal(result.byKind.pdf.length, 20);
  assert.equal(
    result.byKind.image.filter((artifact) => artifact.id === duplicateSha).length,
    1,
    'two records for one digest are one row'
  );
  assert.equal(new Set(result.byKind.image.map((artifact) => artifact.id)).size, RESULT_LIMIT);
});

/**
 * P2 — the cold-start budget. A tenant large enough to time out a single cold
 * sweep must converge over a few loads instead, and each partial load must
 * declare itself incomplete so the caller answers that ONE response the old
 * way.
 */
test('the read budget converges: 2,500 records at a budget of 1,000 take three loads', async () => {
  const entries = seedRecords(2500, 'image');
  const expectedReads = [1000, 1000, 500, 0];
  const expectedComplete = [false, false, true, true];

  for (let call = 0; call < expectedReads.length; call += 1) {
    const store = countingStore(entries);
    const result = await sweepEditorialArtifacts(store as never, { budget: 1000 });
    assert.equal(store.recordReads().length, expectedReads[call], `call ${call + 1}: record reads`);
    assert.equal(result.complete, expectedComplete[call], `call ${call + 1}: complete`);
    assert.equal(result.stats.deferred, Math.max(0, 2500 - 1000 * (call + 1)), `call ${call + 1}: deferred`);
    assert.equal(store.writes.length, call < 3 ? 1 : 0, `call ${call + 1}: writes`);
  }

  const converged = await sweepEditorialArtifacts(countingStore(entries) as never, { budget: 1000 });
  assert.equal(converged.byKind.image.length, RESULT_LIMIT);
  assert.equal(converged.byKind.image[0]?.id, shaFor(2499), 'once converged the newest artifact leads');
});

test('a budgeted sweep never budgets a store it cannot cache', async () => {
  const entries = seedRecords(300, 'image');
  const store = countingStore(entries, { etags: false });
  const result = await sweepEditorialArtifacts(store as never, { budget: 100 });

  assert.equal(store.recordReads().length, 300, 'budgeting an unverifiable store would never converge');
  assert.equal(result.complete, true);
  assert.equal(store.writes.length, 0);
});

/**
 * A record this build's `isArtifactReference` REJECTS is not a record that
 * "contributes nothing" — the allow-list in `getArtifactReferenceIssue`
 * rejects a reference outright for one top-level key it has not been taught,
 * which is exactly what a newer writer's new field does to an older reader
 * (`artifacts.ts:40` is the record of the last time). The bytes never change,
 * so remembering that verdict against the etag would hide a LIVE artifact from
 * the picker for good.
 */
test('a record the validator rejects is re-read every sweep, never remembered as deleted', async () => {
  const entries = seedRecords(3, 'image');
  const rejectedKey = recordKey(requestFor('image', 1), shaFor(1));
  const record = JSON.parse(entries.get(rejectedKey) as string) as Record<string, unknown>;
  // A field this build's allow-list does not know: the whole reference is invalid to it.
  entries.set(rejectedKey, JSON.stringify({ ...record, futureField: 'written by a newer build' }));

  const first = countingStore(entries);
  const cold = await sweepEditorialArtifacts(first as never);
  assert.equal(cold.byKind.image.length, 2, 'the rejected record contributes no row');

  const stored = JSON.parse(entries.get(EDITORIAL_PROJECTION_KEY) as string) as {
    entries: { key: string }[];
  };
  assert.ok(
    !stored.entries.some((entry) => entry.key === rejectedKey),
    'a validator verdict is never persisted — only a soft-delete and an unshowable kind are'
  );

  const second = countingStore(entries);
  await sweepEditorialArtifacts(second as never);
  assert.deepEqual(
    second.recordReads(),
    [rejectedKey],
    'the next sweep opens it again, so the build that understands the field shows it on its first load'
  );
});

/**
 * P2's budget must not turn one failed blob read into a truncated projection.
 * A `get` that throws says nothing about what is in the bucket, and a partial
 * sweep that overwrites it discards entries this call never looked at — which
 * the next reader pays for twice, in re-reads AND in the `listKind` fallback
 * the incompleteness forces.
 */
test('a partial sweep never replaces a projection it could not read', async () => {
  const entries = seedRecords(2500, 'image');
  let converged = await sweepEditorialArtifacts(countingStore(entries) as never, { budget: 1000 });
  while (!converged.complete) {
    converged = await sweepEditorialArtifacts(countingStore(entries) as never, { budget: 1000 });
  }
  const before = JSON.parse(entries.get(EDITORIAL_PROJECTION_KEY) as string) as { entries: unknown[]; seq: number };
  assert.equal(before.entries.length, 2500);

  const failing = countingStore(entries, { failProjectionGet: true });
  const partial = await sweepEditorialArtifacts(failing as never, { budget: 1000 });

  assert.equal(partial.complete, false, 'the sweep still declares itself incomplete, so the caller falls back');
  assert.equal(failing.writes.length, 0, 'and it writes nothing over the projection it could not read');
  const after = JSON.parse(entries.get(EDITORIAL_PROJECTION_KEY) as string) as { entries: unknown[]; seq: number };
  assert.equal(after.entries.length, 2500, 'the converged projection survives');
  assert.equal(after.seq, before.seq, 'untouched');

  const recovered = await sweepEditorialArtifacts(countingStore(entries) as never, { budget: 1000 });
  assert.equal(recovered.complete, true, 'one transient failure costs one load, not a re-convergence');
});

/** One digest, two request ids, one instant: which record is SERVED must not depend on which half of the sweep it came from. */
test('the row served for a duplicated digest does not depend on the cached/fresh split', async () => {
  const sha = shaFor(1);
  const created = createdFor(1);
  const twin = (requestId: string) =>
    [
      recordKey(requestId, sha),
      JSON.stringify({
        blobKey: `image/${requestId}/${sha}.png`,
        sha256: sha,
        sizeBytes: 10,
        contentType: 'image/png',
        createdAtISO: created,
        artifactKind: 'image',
        originalFilename: `${requestId}.png`,
      }),
    ] as const;

  const entries = new Map([twin('req_perf_aaa_20260901_01'), twin('req_perf_zzz_20260901_01')]);
  const cold = await sweepEditorialArtifacts(countingStore(new Map(entries)) as never);
  const winner = cold.byKind.image[0]?.request_id;
  assert.equal(cold.byKind.image.length, 1, 'two records for one digest are one row');

  // Converge, then touch ONE of the pair so the sweep serves one cached row
  // and one freshly read one — the concatenation order the sort has to survive.
  for (const touched of ['req_perf_aaa_20260901_01', 'req_perf_zzz_20260901_01']) {
    const mixed = new Map(entries);
    await sweepEditorialArtifacts(countingStore(mixed) as never);
    const key = recordKey(touched, sha);
    mixed.set(key, JSON.stringify({ ...JSON.parse(mixed.get(key) as string), label: 'touched' }));

    const warm = await sweepEditorialArtifacts(countingStore(mixed) as never);
    assert.equal(warm.byKind.image[0]?.request_id, winner, `re-reading ${touched} must not change which row wins`);
  }
});
