import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { handler } from '../../netlify/functions/admin-analytics.js';
import { handler as compatHandler } from '../../netlify/functions/admin-traffic.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import {
  ANNOTATED_OBJECT_TYPES,
  fetchAnnotationMarkers,
} from '../../packages/core/server/lib/analytics-annotations.js';
import { listAllObjectRecords, type ObjectVerbStore } from '../../packages/core/server/lib/object-verbs.js';
import {
  markersInRange,
  mergeAnnotationMarkers,
  publishMarkersFromRecords,
  type AnnotationMarker,
} from '../../packages/core/lib/admin/analytics-annotations-logic.js';
import { objectTypes, type ObjectRecord } from '../../packages/core/schema/object-record-v1.js';

const parseBody = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'admin-analytics');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

test.after(async () => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
});

test('admin-analytics is read-only', async () => {
  const response = await handler({ httpMethod: 'POST' });
  assert.equal(response.statusCode, 405);
  assert.equal(parseBody(response).ok, false);
});

test('admin-analytics requires an authenticated admin', async () => {
  const response = await handler({ httpMethod: 'GET' });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});

test('T21.2b: admin-analytics?source=own sits behind the SAME admin auth wall', async () => {
  const response = await handler({ httpMethod: 'GET', queryStringParameters: { source: 'own' } });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});

// ─── R11.5 (T21.36): the Insights tab sits behind the SAME admin auth wall ──

test('T21.36: admin-analytics?source=insights sits behind the SAME admin auth wall', async () => {
  const response = await handler({ httpMethod: 'GET', queryStringParameters: { source: 'insights' } });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});

test('T21.6b: admin-analytics?source=arm_metrics sits behind the SAME admin auth wall', async () => {
  const response = await handler({ httpMethod: 'GET', queryStringParameters: { source: 'arm_metrics' } });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});

test('T21.36: admin-analytics?source=insights is read-only — no POST/PUT path is wired for it', async () => {
  const response = await handler({ httpMethod: 'POST', queryStringParameters: { source: 'insights' } });
  assert.equal(response.statusCode, 405);
});

// ─── R11.2 (T21.28): the raw export proxy sits behind the same auth wall ────

test('admin-analytics?resource=raw_export requires an authenticated admin', async () => {
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { resource: 'raw_export', kind: 'events', from: '2026-08-01', to: '2026-08-31' },
  });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});

test('admin-analytics?resource=raw_export is GET-only', async () => {
  const response = await handler({ httpMethod: 'POST', queryStringParameters: { resource: 'raw_export' } });
  assert.equal(response.statusCode, 405);
});

// ─── R11.3 (T21.29): annotations + notes sit behind the same auth wall ──────

test('admin-analytics?resource=annotations requires an authenticated admin', async () => {
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { resource: 'annotations', from: '2026-08-01', to: '2026-08-31' },
  });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
});

test('admin-analytics?resource=annotations is GET-only', async () => {
  const response = await handler({ httpMethod: 'POST', queryStringParameters: { resource: 'annotations' } });
  assert.equal(response.statusCode, 405);
});

// T2.3 — this resource previously returned unconditionally with no
// validator (T0.2's "zero ETags anywhere in server/functions/" finding).
test('admin-analytics?resource=annotations returns an ETag and 304s on a matching If-None-Match', async () => {
  const originalNetlify = process.env.NETLIFY;
  const originalSiteId = process.env.NETLIFY_SITE_ID;
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.ADMIN_EMAILS = 'owner@example.com';
  try {
    const context = { clientContext: { user: { sub: 'owner-1', email: 'owner@example.com' } } };
    const query = { resource: 'annotations', from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' };

    const first = await handler({ httpMethod: 'GET', queryStringParameters: query, headers: {} }, context);
    assert.equal(first.statusCode, 200);
    const firstHeaders = first.headers as Record<string, string> | undefined;
    const etag = firstHeaders?.['ETag'];
    assert.ok(etag, 'ETag must be present');
    assert.equal(firstHeaders?.['Cache-Control'], 'private, no-cache');

    const second = await handler(
      { httpMethod: 'GET', queryStringParameters: query, headers: { 'if-none-match': etag } },
      context
    );
    assert.equal(second.statusCode, 304);
    assert.equal(second.body, '');
    assert.equal((second.headers as Record<string, string> | undefined)?.['ETag'], etag);
  } finally {
    if (originalNetlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = originalNetlify;
    if (originalSiteId === undefined) delete process.env.NETLIFY_SITE_ID;
    else process.env.NETLIFY_SITE_ID = originalSiteId;
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
  }
});

// T0.1 — Server-Timing must be present even on a 401.
test('admin-analytics carries a Server-Timing header on a 401', async () => {
  const response = await handler({ httpMethod: 'GET' });
  assert.ok(response.headers?.['Server-Timing'], 'Server-Timing header must be present');
  assert.match(
    response.headers['Server-Timing'],
    /cold;dur=\d.*auth;dur=[\d.]+.*work;dur=[\d.]+.*serialize;dur=[\d.]+/
  );
});

test('admin-analytics?resource=notes requires an authenticated admin, for every method', async () => {
  for (const httpMethod of ['GET', 'POST', 'DELETE']) {
    const response = await handler({ httpMethod, queryStringParameters: { resource: 'notes' } });
    assert.ok(response.statusCode === 401 || response.statusCode === 403, `${httpMethod} must sit behind the wall`);
  }
});

// ─── R11.4 (T21.30): the object drill-down's identity resource sits behind the same auth wall ──

test('admin-analytics?resource=object_identity requires an authenticated admin', async () => {
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { resource: 'object_identity', id: 'art_skincare_101' },
  });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
});

test('admin-analytics?resource=object_identity is GET-only', async () => {
  const response = await handler({ httpMethod: 'POST', queryStringParameters: { resource: 'object_identity' } });
  assert.equal(response.statusCode, 405);
});

// ─── T21.9b: the old `/.netlify/functions/admin-traffic` URL stays alive ────

test('the admin-traffic compat shim is the SAME handler as admin-analytics, for one wave', () => {
  assert.equal(compatHandler, handler, 'admin-traffic.ts must re-export admin-analytics.ts unchanged, not fork it');
});

// ═══ W3.3: the annotations resource's READ COUNTS ═══════════════════════════
//
// T0.2/W3 measured `/admin/analytics` at ~3 s of server `work`, and the
// annotations resource was the offender: it swept `listAllObjectRecords`
// (one `list()` per governed type, then a WHOLE `ObjectRecord` envelope for
// every object in the store) to find a handful of `publish` timestamps inside
// the window. The acceptance criterion for this task is a before/after read
// count, so — following `object-inventory-index.test.ts`'s precedent — the
// counts are ASSERTED here against a store that tallies every blob operation,
// with the OLD path measured against the SAME fixture in the same test.

const WINDOW = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' };

/** A store that counts operations and mints a fresh etag per write — the shape the index projection's validity check depends on (see `object-inventory-index.test.ts`). */
const countingObjectStore = () => {
  const blobs = new Map<string, { value: string; etag: string }>();
  let etagSeq = 0;
  const counts = { get: 0, list: 0, set: 0 };

  const put = (key: string, value: unknown) => {
    etagSeq += 1;
    blobs.set(key, { value: JSON.stringify(value), etag: `etag-${etagSeq}` });
  };

  const store = {
    get: async (key: string) => {
      counts.get += 1;
      return blobs.get(key)?.value ?? null;
    },
    setJSON: async (key: string, value: unknown) => {
      counts.set += 1;
      put(key, value);
    },
    list: async (options?: { prefix?: string }) => {
      counts.list += 1;
      return {
        blobs: [...blobs.entries()]
          .filter(([key]) => key.startsWith(options?.prefix ?? ''))
          .map(([key, blob]) => ({ key, etag: blob.etag })),
      };
    },
  } as unknown as ObjectVerbStore;

  return { store, counts, put };
};

/** No saved notes — the notes source is exercised separately below. */
const emptyViewsStore = { get: async () => null, setJSON: async () => {} };

type FixtureOptions = {
  objectType: 'content_item' | 'page' | 'theme';
  status?: 'active' | 'archived';
  updatedAt: string;
  /** ISO instants of this record's `publish` history entries; the last one also becomes `published_time`. */
  publishedAt?: string[];
};

const objectRecordFixture = (id: string, options: FixtureOptions): ObjectRecord =>
  ({
    object_id: id,
    object_type: options.objectType,
    schema_version: `${options.objectType}.v1`,
    site: 'site_drlurie',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: options.updatedAt,
    status: options.status ?? 'active',
    body: { title: `Title ${id}`, slug: id, sections: [] },
    publication: {
      published_time: options.publishedAt?.length
        ? (options.publishedAt[options.publishedAt.length - 1] ?? null)
        : null,
    },
    history: [
      { at: '2026-01-01T00:00:00.000Z', action: 'create', actor: { kind: 'human', id: 'u1' } },
      ...(options.publishedAt ?? []).map((at) => ({ at, action: 'publish', actor: { kind: 'human', id: 'u1' } })),
    ],
    version: 3,
    content_revision: 2,
  }) as unknown as ObjectRecord;

/**
 * A library of realistic size and shape: mostly long-published articles and
 * pages nobody has touched in months, a few live drafts, an archived record,
 * a non-annotated type — and exactly THREE publishes inside the window.
 */
const seedAnnotationsLibrary = (put: (key: string, value: unknown) => void) => {
  const publishedInWindow = ['art_in_window_a', 'art_in_window_b', 'page_in_window'];

  for (let i = 0; i < 30; i += 1) {
    const id = `art_old_${String(i).padStart(2, '0')}`;
    put(
      `objects/content_item/by-id/${id}.json`,
      objectRecordFixture(id, {
        objectType: 'content_item',
        updatedAt: '2026-05-14T09:00:00.000Z',
        publishedAt: ['2026-05-14T09:00:00.000Z'],
      })
    );
  }
  for (let i = 0; i < 14; i += 1) {
    const id = `page_old_${String(i).padStart(2, '0')}`;
    put(
      `objects/page/by-id/${id}.json`,
      objectRecordFixture(id, {
        objectType: 'page',
        updatedAt: '2026-03-02T09:00:00.000Z',
        publishedAt: ['2026-03-02T09:00:00.000Z'],
      })
    );
  }
  // Drafts edited INSIDE the window but never published — the index's
  // `published_time === null` clause is what keeps these off the read list.
  for (let i = 0; i < 6; i += 1) {
    const id = `art_draft_${String(i).padStart(2, '0')}`;
    put(
      `objects/content_item/by-id/${id}.json`,
      objectRecordFixture(id, { objectType: 'content_item', updatedAt: '2026-08-12T11:00:00.000Z' })
    );
  }
  // Archived, and published inside the window — the old sweep's
  // `{status:'active'}` filter dropped it and so must this one.
  put(
    'objects/content_item/by-id/art_archived.json',
    objectRecordFixture('art_archived', {
      objectType: 'content_item',
      status: 'archived',
      updatedAt: '2026-08-09T10:00:00.000Z',
      publishedAt: ['2026-08-09T10:00:00.000Z'],
    })
  );
  // A type that is never annotated, published inside the window.
  for (let i = 0; i < 4; i += 1) {
    const id = `theme_${String(i).padStart(2, '0')}`;
    put(
      `objects/theme/by-id/${id}.json`,
      objectRecordFixture(id, {
        objectType: 'theme',
        updatedAt: '2026-08-05T10:00:00.000Z',
        publishedAt: ['2026-08-05T10:00:00.000Z'],
      })
    );
  }
  // The three that actually produce markers. `art_in_window_b` was published
  // BEFORE the window too, so the per-entry range filter still has work to do.
  put(
    'objects/content_item/by-id/art_in_window_a.json',
    objectRecordFixture('art_in_window_a', {
      objectType: 'content_item',
      updatedAt: '2026-08-10T08:00:00.000Z',
      publishedAt: ['2026-08-10T08:00:00.000Z'],
    })
  );
  put(
    'objects/content_item/by-id/art_in_window_b.json',
    objectRecordFixture('art_in_window_b', {
      objectType: 'content_item',
      updatedAt: '2026-08-20T08:00:00.000Z',
      publishedAt: ['2026-06-01T08:00:00.000Z', '2026-08-20T08:00:00.000Z'],
    })
  );
  put(
    'objects/page/by-id/page_in_window.json',
    objectRecordFixture('page_in_window', {
      objectType: 'page',
      updatedAt: '2026-08-15T08:00:00.000Z',
      publishedAt: ['2026-08-15T08:00:00.000Z'],
    })
  );

  return { total: 30 + 14 + 6 + 1 + 4 + 3, publishedInWindow };
};

test('W3.3 BEFORE/AFTER: annotations no longer read a full record for an object the index describes', async () => {
  const { store, counts, put } = countingObjectStore();
  const fixture = seedAnnotationsLibrary(put);

  // ── BEFORE: the sweep this replaces, against the same fixture. ───────────
  counts.get = 0;
  counts.list = 0;
  const before = await listAllObjectRecords(store, { status: 'active' });
  const beforeReads = counts.get;
  const beforeLists = counts.list;
  assert.equal(beforeLists, objectTypes.length, 'one list() per governed object type');
  assert.equal(beforeReads, fixture.total, `every object in the store was read whole (N=${fixture.total})`);

  // The markers that sweep produced, derived exactly as the old module did —
  // same builder, same merge, same final range filter.
  const expected = markersInRange(
    mergeAnnotationMarkers(
      publishMarkersFromRecords(
        before.map((record) => ({
          objectId: record.object_id,
          objectType: record.object_type,
          title: (record.body as { title?: string }).title,
          adminHref: `/admin/content/${encodeURIComponent(record.object_id)}`,
          history: record.history ?? [],
        })),
        WINDOW.from,
        WINDOW.to
      )
    ),
    WINDOW.from,
    WINDOW.to
  );
  assert.equal(expected.length, 3, 'the fixture has exactly three in-window publishes');

  // ── AFTER, cold: the index has to be built once, so this is the old cost
  //    for the two annotated types plus the probe and the projection write.
  counts.get = 0;
  counts.list = 0;
  counts.set = 0;
  const cold = await fetchAnnotationMarkers({ store, viewsStore: emptyViewsStore, ...WINDOW });
  assert.equal(counts.list, 2, 'only content_item and page are listed — 2 of the 14 types, not all of them');
  const coldReads = counts.get;

  // ── AFTER, warm: the steady state. ──────────────────────────────────────
  counts.get = 0;
  counts.list = 0;
  counts.set = 0;
  const warm = await fetchAnnotationMarkers({ store, viewsStore: emptyViewsStore, ...WINDOW });
  assert.equal(counts.list, 2);
  assert.equal(
    counts.get,
    2 + fixture.publishedInWindow.length,
    'two index probes + exactly the three records that can carry an in-window publish'
  );
  assert.equal(counts.set, 0, 'an unchanged store costs zero index writes');
  // Measured on this fixture (N=58 objects, 3 in-window publishes):
  //   before  14 lists + 58 whole-record reads, every load
  //   cold     2 lists + 59 reads + 2 index writes, once per changed library
  //   warm     2 lists +  5 reads (2 index probes + the 3 real candidates)
  assert.ok(
    counts.get < beforeReads / 5,
    `warm reads (${counts.get}) must be a fraction of the old ${beforeReads} — cold was ${coldReads}`
  );

  // ── and the wire is unchanged: same rows, same order, same shape. ────────
  assert.deepEqual(cold, expected);
  assert.deepEqual(warm, expected);
});

test('W3.3: the swept types stay in step with the logic module`s PUBLISHABLE_OBJECT_TYPES', () => {
  // `analytics-annotations-logic.ts` keeps that set private, so pin it
  // behaviourally: feed one record of EVERY governed type through the builder
  // and see which ones survive.
  const producing = objectTypes.filter(
    (objectType) =>
      publishMarkersFromRecords(
        [
          {
            objectId: `id_${objectType}`,
            objectType,
            history: [{ action: 'publish', at: '2026-08-10T00:00:00.000Z' }],
          },
        ],
        WINDOW.from,
        WINDOW.to
      ).length > 0
  );
  assert.deepEqual([...producing].sort(), [...ANNOTATED_OBJECT_TYPES].sort(), 'the sweep scope must not drift');
});

test('W3.3: the memo covers releases and publishes; notes are always read live', async () => {
  const { store, counts, put } = countingObjectStore();
  seedAnnotationsLibrary(put);

  // A notes store whose content changes between calls — the exact case the
  // T2.3 comment cited as the reason this path skipped the memo entirely.
  let notes = [{ id: 'note_1', date: '2026-08-05', text: 'First note', created_at: '2026-08-05T00:00:00.000Z' }];
  const viewsStore = {
    get: async () =>
      JSON.stringify({ schema_version: 'analytics-notes-index.v1', updated_at: '2026-08-05T00:00:00.000Z', notes }),
    setJSON: async () => {},
  };

  const cache = (() => {
    let held: AnnotationMarker[] | undefined;
    return {
      read: () => held,
      write: (markers: readonly AnnotationMarker[]) => {
        held = [...markers];
      },
    };
  })();

  const first = await fetchAnnotationMarkers({ store, viewsStore, ...WINDOW, shippedCache: cache });
  assert.equal(first.filter((marker) => marker.kind === 'publish').length, 3);
  assert.deepEqual(
    first.filter((marker) => marker.kind === 'note').map((marker) => marker.label),
    ['First note']
  );

  // An operator adds a note, then the chart re-reads in the same session.
  notes = [...notes, { id: 'note_2', date: '2026-08-21', text: 'Second note', created_at: '2026-08-21T00:00:00.000Z' }];
  counts.get = 0;
  counts.list = 0;
  const second = await fetchAnnotationMarkers({ store, viewsStore, ...WINDOW, shippedCache: cache });

  assert.equal(counts.list, 0, 'the memoized half costs no object-store listing at all');
  assert.equal(counts.get, 0, 'and no object-store read');
  assert.deepEqual(
    second.filter((marker) => marker.kind === 'note').map((marker) => marker.label),
    ['First note', 'Second note'],
    'the note written this session must still be visible — that is why the WHOLE body was never memoizable'
  );
  assert.deepEqual(
    second.filter((marker) => marker.kind === 'publish'),
    first.filter((marker) => marker.kind === 'publish'),
    'the memoized half is served unchanged'
  );
});
