import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  applyArtifactTagChanges,
  artifactMatchFields,
  artifactReferenceNeedles,
  clampInventoryLimit,
  decodeInventoryCursors,
  encodeInventoryCursors,
  findReferencingObjectId,
  INVENTORY_DEFAULT_LIMIT,
  INVENTORY_MAX_LIMIT,
  matchesInventoryQuery,
  normalizeArtifactHit,
  normalizeArtifactTag,
  normalizeInventoryQuery,
  normalizeObjectHit,
  normalizeStoreHit,
  paginateInventoryHits,
  parseArtifactHitId,
  parseInventoryCollections,
  parseObjectHitId,
  parseStoreHitId,
  trimJsonPreview,
  trimStoreBlobPreview,
  trimTextPreview,
  type InventoryHit,
} from './inventory-server-logic.js';

const hit = (id: string, overrides: Partial<InventoryHit> = {}): InventoryHit => ({
  collection: 'objects',
  id,
  label: id,
  kind: 'article',
  status: 'active',
  updatedAt: null,
  sizeBytes: null,
  previewRef: id,
  refs: [],
  ...overrides,
});

describe('clampInventoryLimit', () => {
  it('caps the page size at the documented maximum', () => {
    assert.strictEqual(clampInventoryLimit(500), INVENTORY_MAX_LIMIT);
    assert.strictEqual(clampInventoryLimit(INVENTORY_MAX_LIMIT), INVENTORY_MAX_LIMIT);
  });

  it('floors fractional and non-positive requests at one row', () => {
    assert.strictEqual(clampInventoryLimit(7.9), 7);
    assert.strictEqual(clampInventoryLimit(0), 1);
    assert.strictEqual(clampInventoryLimit(-4), 1);
  });

  it('falls back to the default for anything that is not a number', () => {
    assert.strictEqual(clampInventoryLimit(undefined), INVENTORY_DEFAULT_LIMIT);
    assert.strictEqual(clampInventoryLimit('not a number'), INVENTORY_DEFAULT_LIMIT);
    assert.strictEqual(clampInventoryLimit(Number.NaN), INVENTORY_DEFAULT_LIMIT);
  });

  it('accepts a numeric string, which is what a JSON body often carries', () => {
    assert.strictEqual(clampInventoryLimit('10'), 10);
  });
});

describe('parseInventoryCollections', () => {
  it('defaults to all three collections when unspecified', () => {
    assert.deepStrictEqual(parseInventoryCollections(undefined), ['objects', 'artifacts', 'stores']);
  });

  it('keeps the canonical order regardless of how the caller ordered them', () => {
    assert.deepStrictEqual(parseInventoryCollections(['stores', 'objects']), ['objects', 'stores']);
  });

  it('drops unknown names but never returns an empty selection', () => {
    assert.deepStrictEqual(parseInventoryCollections(['artifacts', 'secrets']), ['artifacts']);
    assert.deepStrictEqual(parseInventoryCollections(['secrets']), ['objects', 'artifacts', 'stores']);
  });
});

describe('matchesInventoryQuery', () => {
  it('matches case-insensitively on any supplied field', () => {
    const query = normalizeInventoryQuery('  Retinol ');
    assert.strictEqual(query, 'retinol');
    assert.ok(matchesInventoryQuery(query, ['A guide to RETINOL', null]));
    assert.ok(!matchesInventoryQuery(query, ['niacinamide', undefined]));
  });

  it('treats an empty query as "everything"', () => {
    assert.ok(matchesInventoryQuery('', [null, undefined]));
  });
});

describe('hit ids', () => {
  it('round-trips an object id', () => {
    assert.deepStrictEqual(parseObjectHitId('article/req_x_y_20260101_01'), {
      objectType: 'article',
      objectId: 'req_x_y_20260101_01',
    });
    assert.strictEqual(parseObjectHitId('article/'), undefined);
    assert.strictEqual(parseObjectHitId('/req'), undefined);
  });

  it('refuses an object id that would traverse out of the object namespace', () => {
    // `object_id` has NO pattern in the verb schema (z.string().min(1)), and it
    // becomes a blob-key segment — so these have to die here or not at all.
    assert.strictEqual(parseObjectHitId('article/../../users/someone'), undefined);
    assert.strictEqual(parseObjectHitId('article/..'), undefined);
    assert.strictEqual(parseObjectHitId('article/.'), undefined);
    assert.strictEqual(parseObjectHitId('article/a/../../b'), undefined);
    assert.strictEqual(parseObjectHitId('../article/req_x'), undefined);
    assert.strictEqual(parseObjectHitId('article/..\\..\\x'), undefined);
    // A dot INSIDE a segment is not a traversal and stays usable.
    assert.deepStrictEqual(parseObjectHitId('article/req.x.01'), {
      objectType: 'article',
      objectId: 'req.x.01',
    });
  });

  it('splits an artifact id on the last slash so the sha256 half stays whole', () => {
    const sha = 'b'.repeat(64);
    assert.deepStrictEqual(parseArtifactHitId(`req_a_b_20260101_01/${sha}`), {
      requestId: 'req_a_b_20260101_01',
      sha256: sha,
    });
    assert.deepStrictEqual(parseArtifactHitId(`odd/request/id/${sha.toUpperCase()}`), {
      requestId: 'odd/request/id',
      sha256: sha,
    });
  });

  it('rejects an artifact id whose second half is not a sha256', () => {
    assert.strictEqual(parseArtifactHitId('req_a_b_20260101_01/not-a-sha'), undefined);
    assert.strictEqual(parseArtifactHitId('req_a_b_20260101_01'), undefined);
    assert.strictEqual(parseArtifactHitId(42), undefined);
  });

  it('splits a store id on the first slash and keeps the rest of the key intact', () => {
    assert.deepStrictEqual(parseStoreHitId('workflows/runs/2026/01/run.json'), {
      store: 'workflows',
      key: 'runs/2026/01/run.json',
    });
  });

  it('refuses traversal shapes before the allowlist ever sees them', () => {
    assert.strictEqual(parseStoreHitId('../secrets/key'), undefined);
    assert.strictEqual(parseStoreHitId('workflows/../../etc/passwd'), undefined);
    assert.strictEqual(parseStoreHitId('/leading-slash'), undefined);
    assert.strictEqual(parseStoreHitId('workflows/'), undefined);
  });
});

describe('hit normalization', () => {
  it('normalizes an inventory row and falls back to the id when there is no display name', () => {
    assert.deepStrictEqual(
      normalizeObjectHit({
        object_id: 'req_a',
        object_type: 'article',
        display_name: '  Vitamin C  ',
        status: 'active',
        updated_at: '2026-09-01T00:00:00.000Z',
      }),
      {
        collection: 'objects',
        id: 'article/req_a',
        label: 'Vitamin C',
        kind: 'article',
        status: 'active',
        updatedAt: '2026-09-01T00:00:00.000Z',
        sizeBytes: null,
        previewRef: 'article/req_a',
        refs: [],
      }
    );

    const bare = normalizeObjectHit({ object_id: 'req_b', object_type: 'page' });
    assert.strictEqual(bare.label, 'req_b');
    assert.strictEqual(bare.status, 'unknown');
    assert.strictEqual(bare.updatedAt, null);
  });

  it('normalizes an artifact reference and carries its request id as a ref', () => {
    const sha = 'c'.repeat(64);
    assert.deepStrictEqual(
      normalizeArtifactHit({
        requestId: 'req_img_01',
        sha256: sha,
        blobKey: `image/req_img_01/${sha}.png`,
        label: 'Hero image',
        artifactKind: 'image',
        createdAtISO: '2026-08-01T00:00:00.000Z',
        sizeBytes: 2048,
      }),
      {
        collection: 'artifacts',
        id: `req_img_01/${sha}`,
        label: 'Hero image',
        kind: 'image',
        status: 'active',
        updatedAt: '2026-08-01T00:00:00.000Z',
        sizeBytes: 2048,
        previewRef: `image/req_img_01/${sha}.png`,
        refs: ['req_img_01'],
      }
    );
  });

  it('reports a soft-deleted artifact as deleted rather than active', () => {
    const deleted = normalizeArtifactHit({
      requestId: 'req_img_01',
      sha256: 'd'.repeat(64),
      createdAtISO: '2026-08-01T00:00:00.000Z',
      deletedAtISO: '2026-09-01T00:00:00.000Z',
    });
    assert.strictEqual(deleted.status, 'deleted');
    assert.strictEqual(deleted.updatedAt, '2026-09-01T00:00:00.000Z');
  });

  it('matches artifacts on label, filename, tags and kind', () => {
    const fields = artifactMatchFields({
      requestId: 'req_img_01',
      sha256: 'e'.repeat(64),
      label: 'Hero image',
      originalFilename: 'hero-shot.png',
      artifactKind: 'image',
      tags: ['brand', 'above-the-fold'],
    });

    assert.ok(matchesInventoryQuery('hero-shot', fields));
    assert.ok(matchesInventoryQuery('above', fields));
    assert.ok(matchesInventoryQuery('image', fields));
    assert.ok(!matchesInventoryQuery('unrelated', fields));
  });

  it('never claims a lifecycle state or timestamp a blob listing cannot prove', () => {
    const storeHit = normalizeStoreHit({ store: 'workflows', key: 'runs/run-1.json', etag: 'abc' });
    assert.strictEqual(storeHit.status, 'stored');
    assert.strictEqual(storeHit.updatedAt, null);
    assert.strictEqual(storeHit.sizeBytes, null);
    assert.strictEqual(storeHit.id, 'workflows/runs/run-1.json');
    assert.strictEqual(storeHit.kind, 'workflows');
  });
});

describe('cursors', () => {
  it('round-trips a per-collection cursor map', () => {
    const encoded = encodeInventoryCursors({ objects: 'article/req_a', stores: 'workflows/runs/x.json' });
    assert.deepStrictEqual(decodeInventoryCursors(encoded), {
      objects: 'article/req_a',
      stores: 'workflows/runs/x.json',
    });
  });

  it('degrades to "start from the beginning" on a missing or unusable cursor', () => {
    assert.deepStrictEqual(decodeInventoryCursors(undefined), {});
    assert.deepStrictEqual(decodeInventoryCursors(''), {});
    assert.deepStrictEqual(decodeInventoryCursors('%%%not-a-cursor'), {});
    assert.deepStrictEqual(decodeInventoryCursors(17), {});
  });

  it('pages by id and reports where to continue', () => {
    const hits = [hit('article/c'), hit('article/a'), hit('article/b'), hit('article/d')];

    const first = paginateInventoryHits(hits, undefined, 2);
    assert.deepStrictEqual(
      first.hits.map((row) => row.id),
      ['article/a', 'article/b']
    );
    assert.strictEqual(first.nextAfter, 'article/b');

    const second = paginateInventoryHits(hits, first.nextAfter ?? undefined, 2);
    assert.deepStrictEqual(
      second.hits.map((row) => row.id),
      ['article/c', 'article/d']
    );
    assert.strictEqual(second.nextAfter, null);
  });

  it('is stable when rows are added or removed between pages', () => {
    const first = paginateInventoryHits([hit('a'), hit('b'), hit('c'), hit('d')], undefined, 2);
    // 'a' is deleted and 'a2' appears BEFORE the cursor between the two calls:
    // a keyset cursor still resumes exactly after 'b', so nothing is served
    // twice and nothing after the cursor is skipped.
    const second = paginateInventoryHits(
      [hit('a2'), hit('b'), hit('c'), hit('d'), hit('e')],
      first.nextAfter ?? undefined,
      2
    );

    assert.deepStrictEqual(
      second.hits.map((row) => row.id),
      ['c', 'd']
    );
    assert.strictEqual(second.nextAfter, 'd');
  });

  it('does not hand back a cursor when the last page exactly fills the limit', () => {
    const page = paginateInventoryHits([hit('a'), hit('b')], undefined, 2);
    assert.strictEqual(page.nextAfter, null);
  });
});

describe('preview trimming', () => {
  it('leaves a small payload untouched and reports its size', () => {
    const preview = trimJsonPreview({ a: 1 });
    assert.strictEqual(preview.truncated, false);
    assert.strictEqual(preview.text, JSON.stringify({ a: 1 }, null, 2));
    assert.strictEqual(preview.sizeBytes, new TextEncoder().encode(preview.text).byteLength);
  });

  it('trims to the byte budget and flags the truncation', () => {
    const preview = trimJsonPreview({ blob: 'x'.repeat(200) }, 64);
    assert.strictEqual(preview.truncated, true);
    assert.ok(new TextEncoder().encode(preview.text).byteLength <= 64);
    assert.ok(preview.sizeBytes > 64);
  });

  it('cuts on a code-point boundary so a multi-byte character is never split', () => {
    // Four 3-byte characters; a 7-byte budget lands mid-character.
    const preview = trimTextPreview('世界世界', 7);
    assert.strictEqual(preview.truncated, true);
    assert.strictEqual(preview.text, '世界');
    assert.ok(!preview.text.includes('�'));
  });

  it('reports an unserializable value instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.strictEqual(trimJsonPreview(cyclic).text, '"[unserializable]"');
  });

  it('pretty-prints a JSON blob and falls back to text for anything else', () => {
    assert.deepStrictEqual(trimStoreBlobPreview('{"a":1}'), {
      text: '{\n  "a": 1\n}',
      truncated: false,
      sizeBytes: 12,
      format: 'json',
    });
    assert.strictEqual(trimStoreBlobPreview('not json at all').format, 'text');
  });
});

describe('artifact tag arithmetic', () => {
  it('adds, removes and de-duplicates in one pass', () => {
    const change = applyArtifactTagChanges(['brand', 'hero'], ['Hero', 'seasonal'], ['brand']);
    assert.deepStrictEqual(change.tags, ['hero', 'seasonal']);
    assert.deepStrictEqual(change.added, ['seasonal']);
    assert.deepStrictEqual(change.removed, ['brand']);
    assert.deepStrictEqual(change.rejected, []);
    assert.strictEqual(change.error, undefined);
  });

  it('lets remove win over add for the same tag so the result is order-free', () => {
    const change = applyArtifactTagChanges(['brand'], ['seasonal'], ['seasonal', 'brand']);
    assert.deepStrictEqual(change.tags, []);
    assert.deepStrictEqual(change.added, []);
  });

  it('reports unusable tags instead of silently dropping them', () => {
    const change = applyArtifactTagChanges([], ['ok', '  ', 'x'.repeat(41), '<script>'], []);
    assert.deepStrictEqual(change.tags, ['ok']);
    assert.strictEqual(change.rejected.length, 3);
  });

  it('refuses a change that would exceed the ArtifactReference tag cap', () => {
    const change = applyArtifactTagChanges(
      Array.from({ length: 20 }, (_, index) => `tag-${index}`),
      ['one-too-many'],
      []
    );
    assert.ok(change.error);
  });

  it('normalizes whitespace inside a tag', () => {
    assert.strictEqual(normalizeArtifactTag('  above   the fold '), 'above the fold');
    assert.strictEqual(normalizeArtifactTag(''), undefined);
    assert.strictEqual(normalizeArtifactTag(7), undefined);
  });
});

describe('artifact reference detection', () => {
  const sha = 'f'.repeat(64);

  it('recognizes the raw blob key, the public path form and the bare sha', () => {
    const needles = artifactReferenceNeedles({ blobKey: `image/req_img_01/${sha}.png`, sha256: sha });
    assert.ok(needles.includes(`image/req_img_01/${sha}.png`));
    assert.ok(needles.includes(`/img/req_img_01/${sha}.png`));
    assert.ok(needles.includes(sha));
  });

  it('strips a leading artifacts/ prefix so both stored spellings match', () => {
    const needles = artifactReferenceNeedles({ blobKey: `artifacts/pdf/req_pdf_01/${sha}.pdf`, sha256: sha });
    assert.ok(needles.includes(`pdf/req_pdf_01/${sha}.pdf`));
    assert.ok(needles.includes(`/pdf/req_pdf_01/${sha}.pdf`));
  });

  it('names the first active object that references the artifact', () => {
    const records = [
      { object_id: 'req_other', object_type: 'article', serialized: '{"body":"nothing here"}' },
      { object_id: 'req_uses_it', object_type: 'page', serialized: `{"image":"/img/req_img_01/${sha}.png"}` },
    ];

    assert.deepStrictEqual(findReferencingObjectId(records, artifactReferenceNeedles({ sha256: sha })), {
      object_id: 'req_uses_it',
      object_type: 'page',
    });
  });

  it('returns nothing when no record mentions the artifact', () => {
    const records = [{ object_id: 'req_other', object_type: 'article', serialized: '{}' }];
    assert.strictEqual(findReferencingObjectId(records, artifactReferenceNeedles({ sha256: sha })), undefined);
  });

  it('never matches on an empty needle set', () => {
    const records = [{ object_id: 'req_other', object_type: 'article', serialized: '{"a":""}' }];
    assert.strictEqual(findReferencingObjectId(records, ['']), undefined);
  });
});
