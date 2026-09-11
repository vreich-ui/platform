import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStoreValidationContext } from '../../packages/core/server/lib/object-validation-context.js';

/**
 * W1 T1.4 acceptance — the blast radius of a shared-section edit.
 *
 * A shared `section` object is edited in isolation and renders on every page
 * that points at it. "Fix the wording on this CTA" and "change this CTA on
 * eleven pages" were the same call with the same result, and nothing in the
 * answer distinguished them. This is a READ over the snapshot the validation
 * context already loads — no new store, no extra round trip — and it is
 * REPORTED, never enforced: editing a widely-shared section is legitimate, it
 * just should not be a surprise.
 */

type Rec = { type: string; id: string; body: Record<string, unknown> };

const makeStore = (records: Rec[]) => {
  const blobs = new Map<string, string>();
  for (const record of records) {
    blobs.set(
      `objects/${record.type}/by-id/${record.id}.json`,
      JSON.stringify({
        object_id: record.id,
        object_type: record.type,
        body: record.body,
        publication: { published_time: '2026-01-01T00:00:00.000Z' },
      })
    );
  }
  return {
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async list({ prefix }: { prefix: string }) {
      return { blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), directories: [] };
    },
    async setJSON() {},
  } as never;
};

const page = (id: string, sectionRefs: string[]): Rec => ({
  type: 'page',
  id,
  body: {
    route: `/${id}`,
    pageType: 'standard',
    title: id,
    sections: sectionRefs.map((ref, index) => ({ id: `s_${index}`, type: 'shared_ref', data: { section: ref } })),
  },
});

test('a section referenced by two pages reports both, sorted', async () => {
  const context = await buildStoreValidationContext(
    makeStore([
      page('page_a', ['sec_cta']),
      page('page_b', ['sec_other', 'sec_cta']),
      page('page_c', ['sec_other']),
      { type: 'section', id: 'sec_cta', body: { section: { id: 's', type: 'cta_banner', data: {} } } },
    ]),
    { selfObjectId: 'sec_cta', selfObjectType: 'section' }
  );

  assert.deepEqual(context.referencingPages?.('sec_cta'), ['page_a', 'page_b']);
  // Stable between calls: a set iteration order would make this flap.
  assert.deepEqual(context.referencingPages?.('sec_cta'), ['page_a', 'page_b']);
});

test('a section nobody points at reports an empty list, not undefined', async () => {
  const context = await buildStoreValidationContext(
    makeStore([page('page_a', ['sec_other']), { type: 'section', id: 'sec_lonely', body: {} }]),
    { selfObjectId: 'sec_lonely', selfObjectType: 'section' }
  );
  // The difference matters: [] means "checked, nobody"; undefined would mean
  // "not checked", and the verb would omit `impact` entirely.
  assert.deepEqual(context.referencingPages?.('sec_lonely'), []);
});

test('only shared_ref counts — a section type that merely SHARES the id string does not', async () => {
  const context = await buildStoreValidationContext(
    makeStore([
      {
        type: 'page',
        id: 'page_a',
        body: {
          route: '/a',
          pageType: 'standard',
          title: 'a',
          // A content_grid whose manual items name the same string. It is not
          // a shared_ref, so it is not a page this edit changes.
          sections: [{ id: 's_grid', type: 'content_grid', data: { source: { kind: 'manual', items: ['sec_cta'] } } }],
        },
      },
    ]),
    { selfObjectId: 'sec_cta', selfObjectType: 'section' }
  );
  assert.deepEqual(context.referencingPages?.('sec_cta'), []);
});
