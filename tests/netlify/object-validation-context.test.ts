import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStoreValidationContext } from '../../packages/core/server/lib/object-validation-context.js';

// A minimal in-memory store matching the subset the context builder reads
// (list by prefix + get by key), seeded with a few object records.
const makeStore = (records: Array<{ type: string; id: string; body: unknown; published?: boolean }>) => {
  const blobs = new Map<string, string>();
  for (const r of records) {
    blobs.set(
      `objects/${r.type}/by-id/${r.id}.json`,
      JSON.stringify({
        object_id: r.id,
        object_type: r.type,
        body: r.body,
        publication: { published_time: r.published ? '2026-01-01T00:00:00.000Z' : null },
      })
    );
  }
  return {
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async list({ prefix }: { prefix: string }) {
      return { blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), directories: [] };
    },
    // unused by the builder but part of the store type
    async setJSON() {},
  } as never;
};

const REF_SHA = 'c'.repeat(64);
const REF_REQUEST = 'req_ctx_artifacts_20260719_01';
const REF_KEY = `image/${REF_REQUEST}/${REF_SHA}.png`;

const makeArtifactIndexStore = (references: Array<Record<string, unknown>>) => {
  const blobs = new Map<string, string>();
  for (const reference of references) {
    const requestId = String(reference.blobKey).split('/')[1] ?? '';
    blobs.set(`request-artifacts/${encodeURIComponent(requestId)}/${reference.sha256}.json`, JSON.stringify(reference));
  }
  return {
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async setJSON() {},
    async list() {
      return { blobs: [], directories: [] };
    },
  } as never;
};

const makeThrowingArtifactIndexStore = () =>
  ({
    async get() {
      // What a bad blob credential actually looks like from here.
      throw new Error('Netlify Blobs has generated an internal error (401 status code)');
    },
    async setJSON() {},
    async list() {
      return { blobs: [], directories: [] };
    },
  }) as never;

test('artifactIndexUnreadable: a throwing index read is reported, not silently swallowed', async () => {
  // A thrown read means the index could not be consulted at all. Leaving the key
  // unanswered is right (it is not evidence of absence), but staying SILENT is
  // what let a non-PAT NETLIFY_BLOBS_TOKEN read as a healthy publish gate on
  // 2026-08-11: every read threw, nothing was verified, and article_media
  // reported "complete".
  const missingKey = `image/${REF_REQUEST}/${'d'.repeat(64)}.png`;
  const context = await buildStoreValidationContext(makeStore([]), {
    artifactIndexStore: makeThrowingArtifactIndexStore(),
    artifactRefSources: [{ ops: [{ op: 'set_section_fields', fields: { a: REF_KEY, b: missingKey } }] }],
  });

  // Unanswered, so nothing is falsely reported absent...
  assert.equal(context.resolveArtifactRef?.(REF_KEY), undefined);
  assert.equal(context.resolveArtifactRef?.(missingKey), undefined);
  // ...but the fault is visible to the caller.
  assert.deepEqual([...(context.artifactIndexUnreadable ?? [])].sort(), [REF_KEY, missingKey].sort());
});

test('artifactIndexUnreadable: absent when every read succeeds', async () => {
  const context = await buildStoreValidationContext(makeStore([]), {
    artifactIndexStore: makeArtifactIndexStore([
      { blobKey: REF_KEY, sha256: REF_SHA, sizeBytes: 111, contentType: 'image/png', artifactKind: 'image' },
    ]),
    artifactRefSources: [{ ops: [{ op: 'set_section_fields', fields: { a: REF_KEY } }] }],
  });
  assert.equal(context.artifactIndexUnreadable, undefined);
});

test('resolveArtifactRef: refs from the request payload and record bodies pre-resolve against the artifact index', async (t) => {
  // Explicit-API credentials present => blob reads really are strongly
  // consistent, so an absence observed here is conclusive. Without them the
  // read is silently eventual and a miss must stay unanswered instead (see the
  // eventual-consistency case below).
  const previous = { siteId: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN };
  process.env.NETLIFY_SITE_ID = 'test-site';
  process.env.NETLIFY_BLOBS_TOKEN = 'test-token';
  t.after(() => {
    if (previous.siteId === undefined) delete process.env.NETLIFY_SITE_ID;
    else process.env.NETLIFY_SITE_ID = previous.siteId;
    if (previous.token === undefined) delete process.env.NETLIFY_BLOBS_TOKEN;
    else process.env.NETLIFY_BLOBS_TOKEN = previous.token;
  });

  const missingKey = `image/${REF_REQUEST}/${'d'.repeat(64)}.png`;
  const indexStore = makeArtifactIndexStore([
    {
      blobKey: REF_KEY,
      sha256: REF_SHA,
      sizeBytes: 111,
      contentType: 'image/png',
      createdAtISO: '2026-07-19T00:00:00.000Z',
      artifactKind: 'image',
    },
  ]);
  // A record body referencing the artifact by its PUBLIC path — the sweep must
  // normalize it back to the raw key.
  const store = makeStore([
    {
      type: 'section',
      id: 'sec_x',
      body: { section: { type: 'bio', data: { portrait: { src: `/img/${REF_REQUEST}/${REF_SHA}.png` } } } },
    },
  ]);

  const context = await buildStoreValidationContext(store, {
    artifactIndexStore: indexStore,
    artifactRefSources: [{ ops: [{ op: 'set_section_fields', fields: { portraitAssetRef: missingKey } }] }],
  });

  assert.deepEqual(context.resolveArtifactRef?.(REF_KEY), {
    exists: true,
    sizeBytes: 111,
    contentType: 'image/png',
  });
  assert.deepEqual(context.resolveArtifactRef?.(missingKey), { exists: false });
  // A key that appeared nowhere in the swept sources is unanswered, not failed.
  assert.equal(context.resolveArtifactRef?.(`image/${REF_REQUEST}/${'e'.repeat(64)}.png`), undefined);
});

test('resolveArtifactRef: a miss is unanswered, not absent, when blob reads are only eventually consistent', async (t) => {
  // getArtifactIndexBlobStore asks for strong consistency, but that is honoured
  // only on the explicit-API path (blobSiteId + blobToken). On the Lambda
  // name-lookup path it is silently downgraded to eventual, and a just-written
  // artifact reads as missing for as long as the read lags. Reporting that as
  // "absent" blocks publishing an article whose image is live and serving —
  // observed for 25+ minutes against a real artifact on 2026-08-11.
  const previous = { siteId: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN };
  delete process.env.NETLIFY_SITE_ID;
  delete process.env.SITE_ID;
  delete process.env.NETLIFY_BLOBS_TOKEN;
  delete process.env.NETLIFY_AUTH_TOKEN;
  t.after(() => {
    if (previous.siteId !== undefined) process.env.NETLIFY_SITE_ID = previous.siteId;
    if (previous.token !== undefined) process.env.NETLIFY_BLOBS_TOKEN = previous.token;
  });

  const missingKey = `image/${REF_REQUEST}/${'d'.repeat(64)}.png`;
  const indexStore = makeArtifactIndexStore([
    {
      blobKey: REF_KEY,
      sha256: REF_SHA,
      sizeBytes: 111,
      contentType: 'image/png',
      createdAtISO: '2026-07-19T00:00:00.000Z',
      artifactKind: 'image',
    },
  ]);
  const store = makeStore([]);

  const context = await buildStoreValidationContext(store, {
    artifactIndexStore: indexStore,
    artifactRefSources: [{ ops: [{ op: 'set_section_fields', fields: { a: REF_KEY, b: missingKey } }] }],
  });

  // A HIT is still conclusive under either consistency.
  assert.deepEqual(context.resolveArtifactRef?.(REF_KEY), {
    exists: true,
    sizeBytes: 111,
    contentType: 'image/png',
  });
  // A MISS carries no information — leave it unanswered so the caller degrades
  // to "cannot verify" (a warning) instead of blocking a valid artifact.
  assert.equal(context.resolveArtifactRef?.(missingKey), undefined);
});

test('resolveArtifactRef: soft-deleted references resolve with deleted:true; no index store → no resolver', async () => {
  const indexStore = makeArtifactIndexStore([
    {
      blobKey: REF_KEY,
      sha256: REF_SHA,
      sizeBytes: 111,
      contentType: 'image/png',
      createdAtISO: '2026-07-19T00:00:00.000Z',
      artifactKind: 'image',
      deletedAtISO: '2026-07-19T01:00:00.000Z',
    },
  ]);
  const context = await buildStoreValidationContext(makeStore([]), {
    artifactIndexStore: indexStore,
    artifactRefSources: [REF_KEY],
  });
  assert.deepEqual(context.resolveArtifactRef?.(REF_KEY), {
    exists: true,
    deleted: true,
    sizeBytes: 111,
    contentType: 'image/png',
  });

  const withoutIndex = await buildStoreValidationContext(makeStore([]), { artifactRefSources: [REF_KEY] });
  assert.equal(withoutIndex.resolveArtifactRef, undefined);
});

test('resolveObject: hit reports exists+published; miss reports not-exists', async () => {
  const store = makeStore([
    { type: 'page', id: 'page_home', body: { route: '/' }, published: true },
    { type: 'section', id: 'sec_x', body: { section: { id: 's_a', type: 'newsletter_signup', data: {} } } },
  ]);
  const ctx = await buildStoreValidationContext(store);
  assert.deepEqual(ctx.resolveObject!('page', 'page_home'), { exists: true, published: true });
  assert.deepEqual(ctx.resolveObject!('section', 'sec_x'), { exists: true, published: false });
  assert.deepEqual(ctx.resolveObject!('page', 'page_ghost'), { exists: false });
});

test('resolveSharedSectionType returns the wrapped variant type', async () => {
  const store = makeStore([
    { type: 'section', id: 'sec_x', body: { section: { id: 's_a', type: 'newsletter_signup', data: {} } } },
  ]);
  const ctx = await buildStoreValidationContext(store);
  assert.equal(ctx.resolveSharedSectionType!('sec_x'), 'newsletter_signup');
  assert.equal(ctx.resolveSharedSectionType!('sec_ghost'), undefined);
});

test('isRouteTaken flags a different page on the same route, excludes self', async () => {
  const store = makeStore([
    { type: 'page', id: 'page_home', body: { route: '/' } },
    { type: 'page', id: 'page_about', body: { route: '/about' } },
  ]);
  const ctxOther = await buildStoreValidationContext(store, { selfObjectId: 'page_new' });
  assert.equal(ctxOther.isRouteTaken!('/'), true);
  assert.equal(ctxOther.isRouteTaken!('/nope'), false);
  // a page re-saving its OWN route is not a conflict
  const ctxSelf = await buildStoreValidationContext(store, { selfObjectId: 'page_home' });
  assert.equal(ctxSelf.isRouteTaken!('/'), false);
});

test('resolvePageType returns the code-registry constraint; unknown → undefined', async () => {
  const ctx = await buildStoreValidationContext(makeStore([]));
  const home = ctx.resolvePageType!('home');
  assert.equal(home?.id, 'home');
  assert.ok(Array.isArray(home?.allowedSections));
  assert.deepEqual(home?.requiredSections, ['hero']);
  assert.equal(ctx.resolvePageType!('not_a_type'), undefined);
});

test('componentTypeExists is true only for bound section types', async () => {
  const ctx = await buildStoreValidationContext(makeStore([]));
  assert.equal(ctx.componentTypeExists!('hero'), true);
  assert.equal(ctx.componentTypeExists!('lede'), true);
  assert.equal(ctx.componentTypeExists!('prose'), true); // now bound (Prose.astro)
  // shared_ref is schema-legal but never a component — the renderer dereferences
  // it to the target's variant before dispatch, so it is intentionally unbound.
  assert.equal(ctx.componentTypeExists!('shared_ref'), false);
});

test('resolveTaxonomyTerm: omitted when no taxonomy object exists; follows merged_into when present', async () => {
  const noTax = await buildStoreValidationContext(makeStore([{ type: 'page', id: 'p', body: { route: '/' } }]));
  assert.equal(noTax.resolveTaxonomyTerm, undefined, 'no taxonomy → no resolver (avoids false positives)');

  const withTax = await buildStoreValidationContext(
    makeStore([
      {
        type: 'taxonomy',
        id: 'tax_main',
        body: {
          kinds: {
            category: {
              terms: [
                { term_id: 't_old', status: 'deprecated', merged_into: 't_new' },
                { term_id: 't_new', status: 'active' },
              ],
            },
            tag: { terms: [] },
          },
        },
      },
    ])
  );
  // t_old is deprecated but merges into an active term → resolves active
  assert.deepEqual(withTax.resolveTaxonomyTerm!('category', 't_old'), { active: true });
  assert.deepEqual(withTax.resolveTaxonomyTerm!('category', 't_new'), { active: true });
  assert.equal(withTax.resolveTaxonomyTerm!('category', 't_missing'), undefined);
});
