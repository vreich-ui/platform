/**
 * PDF (document) attachment discipline on the content_item patch path.
 *
 * The defect (Wolf, 2026-08): a node patched with a PDF src used to land as
 * `{type:'image', src:'/pdf/…'}` — the media type was defaulted, never
 * derived — and the live page rendered a broken <img>. The patch engine now
 * INFERS the type from the src when an op omits it (.pdf → document, image
 * extension → image), REFUSES an opaque src instead of guessing, and rejects
 * an explicit type the src contradicts. The validator applies the same
 * agreement rule to bodies that arrive whole (create / validate / publish).
 */
import '../../sites/drlurie/config/policy-bindings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PatchApplyError, applyPatchOps, derivePatchInverse } from '../../packages/core/lib/object-patch-apply.js';
import { contentItemBodySchema, type ContentItemBody } from '../../packages/core/schema/bodies/content-item-v1.js';
import type { ObjectRecord, Principal } from '../../packages/core/schema/object-record-v1.js';
import { checkStructuralInvariants, type ReadinessCriterion } from '../../packages/core/server/lib/object-validate.js';
import {
  handleObjectVerb,
  type ObjectVerbRequest,
  type ObjectVerbStore,
} from '../../packages/core/server/lib/object-verbs.js';

const SHA = 'b'.repeat(64);
const REQ = 'req_agent_pdf_attach_20260831_01';
const PDF_PATH = `/pdf/${REQ}/${SHA}.pdf`;
const PNG_PATH = `/img/${REQ}/${SHA}.png`;
const OPAQUE_SRC = 'https://cdn.example.com/asset/opaque';

const AT = '2026-08-31T00:00:00.000Z';
const ACTOR: Principal = { kind: 'agent', agent_name: 'tester', auth: 'publish_key' };

const articleBody = (): ContentItemBody =>
  contentItemBodySchema.parse({
    slug: 'retinol-guide',
    title: 'The retinol guide',
    nodes: [
      { id: 'n_a1', kind: 'content', public: { title: 'Intro', body: 'Read the guide below.' } },
      {
        id: 'n_img',
        kind: 'content',
        public: { media: { type: 'image', src: PNG_PATH, alt: 'Chart' } },
        rendering: { placement: 'inline' },
      },
    ],
  });

const articleRecord = (): ObjectRecord<unknown> => ({
  object_id: REQ,
  object_type: 'content_item',
  schema_version: 'content_item.v1',
  site: 'site_drlurie',
  created_at: AT,
  updated_at: AT,
  status: 'active',
  body: articleBody(),
  publication: { published_time: null },
  history: [],
  version: 1,
  content_revision: 1,
});

const apply = (ops: unknown[]) => applyPatchOps(articleRecord(), ops, { actor: ACTOR, at: AT });
const mediaOf = (body: unknown, nodeId: string) =>
  (body as ContentItemBody).nodes.find((node) => node.id === nodeId)?.public.media;

// ─── the patch engine (today's applyNodePatch) ───────────────────────────────

test('upsert_node: a .pdf src with no type lands as type "document" — never "image"', () => {
  const result = apply([
    { op: 'upsert_node', node: { id: 'n_pdf', kind: 'content', public: { media: { src: PDF_PATH, title: 'Guide' } } } },
  ]);
  assert.deepEqual(mediaOf(result.record.body, 'n_pdf'), { src: PDF_PATH, title: 'Guide', type: 'document' });
  // The applied body still satisfies the strict schema (type is required there).
  contentItemBodySchema.parse(result.record.body);
  // History carries the RESOLVED node, so the inverse restores exactly.
  const entry = result.record.history.at(-1)!;
  const capture = (entry.details as { capture: { after: { value: { public: { media: { type: string } } } } } }).capture;
  assert.equal(capture.after.value.public.media.type, 'document');
});

test('upsert_node: a .png src with no type lands as type "image"; contentType application/pdf wins over an opaque src', () => {
  const result = apply([
    { op: 'upsert_node', node: { id: 'n_p1', kind: 'content', public: { media: { src: PNG_PATH, alt: 'x' } } } },
    {
      op: 'upsert_node',
      node: { id: 'n_p2', kind: 'content', public: { media: { src: OPAQUE_SRC, contentType: 'application/pdf' } } },
    },
  ]);
  assert.equal(mediaOf(result.record.body, 'n_p1')?.type, 'image');
  assert.equal(mediaOf(result.record.body, 'n_p2')?.type, 'document');
});

test('upsert_node: an opaque src with no type is REFUSED with an error naming the src (not guessed as image)', () => {
  assert.throws(
    () => apply([{ op: 'upsert_node', node: { id: 'n_x', kind: 'content', public: { media: { src: OPAQUE_SRC } } } }]),
    (error: unknown) => {
      assert.ok(error instanceof PatchApplyError);
      assert.equal(error.code, 'invalid_body');
      assert.ok(error.message.includes(OPAQUE_SRC), error.message);
      assert.match(error.message, /never defaulted to "image"/);
      assert.deepEqual(error.details, { path: 'upsert_node node.public.media', reason: 'unknown_src' });
      return true;
    }
  );
});

test('upsert_node: an explicit type is kept, but one the src contradicts is refused', () => {
  const kept = apply([
    { op: 'upsert_node', node: { id: 'n_d', kind: 'content', public: { media: { type: 'document', src: PDF_PATH } } } },
  ]);
  assert.equal(mediaOf(kept.record.body, 'n_d')?.type, 'document');

  assert.throws(
    () =>
      apply([
        {
          op: 'upsert_node',
          node: { id: 'n_d', kind: 'content', public: { media: { type: 'image', src: PDF_PATH } } },
        },
      ]),
    (error: unknown) =>
      error instanceof PatchApplyError &&
      error.code === 'invalid_body' &&
      /is "image" but its src .* is a PDF document/.test(error.message) &&
      (error.details as { reason: string }).reason === 'type_mismatch'
  );
  assert.throws(
    () =>
      apply([
        {
          op: 'upsert_node',
          node: { id: 'n_d', kind: 'content', public: { images: [{ type: 'document', src: PNG_PATH }] } },
        },
      ]),
    (error: unknown) =>
      error instanceof PatchApplyError && (error.details as { reason: string }).reason === 'type_mismatch'
  );
});

test('update_node: patching a PDF src onto an image node re-derives the type (the stale "image" does not survive)', () => {
  const result = apply([{ op: 'update_node', node_id: 'n_img', fields: { public: { media: { src: PDF_PATH } } } }]);
  assert.deepEqual(mediaOf(result.record.body, 'n_img'), { type: 'document', src: PDF_PATH, alt: 'Chart' });

  // The fields capture carries the resolved type, so the derived inverse
  // restores the image node exactly.
  const entry = result.record.history.at(-1)!;
  const { op, capture } = entry.details as { op: never; capture: never };
  const inverse = derivePatchInverse(op, capture);
  const back = applyPatchOps(result.record, [inverse], { actor: ACTOR, at: AT });
  assert.deepEqual(mediaOf(back.record.body, 'n_img'), { type: 'image', src: PNG_PATH, alt: 'Chart' });
});

test('update_node: a type-only patch that contradicts the node’s src is refused; alt/caption patches pass untouched', () => {
  assert.throws(
    () => apply([{ op: 'update_node', node_id: 'n_img', fields: { public: { media: { type: 'document' } } } }]),
    (error: unknown) =>
      error instanceof PatchApplyError && (error.details as { reason: string }).reason === 'type_mismatch'
  );
  const result = apply([
    { op: 'update_node', node_id: 'n_img', fields: { public: { media: { caption: 'Figure 1' } } } },
  ]);
  assert.deepEqual(mediaOf(result.record.body, 'n_img'), {
    type: 'image',
    src: PNG_PATH,
    alt: 'Chart',
    caption: 'Figure 1',
  });
});

// ─── the verb round-trip (object_patch → 422, not a silent broken <img>) ─────

const createMemoryStore = () => {
  const blobs = new Map<string, string>();
  const store: ObjectVerbStore = {
    get: async (key: string) => blobs.get(key) ?? null,
    setJSON: async (key: string, value: unknown) => {
      blobs.set(key, JSON.stringify(value));
    },
    list: async (options?: { prefix?: string }) => ({
      blobs: [...blobs.keys()]
        .filter((key) => key.startsWith(options?.prefix ?? ''))
        .map((key) => ({ key, etag: 'e' })),
    }),
    delete: async (key: string) => {
      blobs.delete(key);
    },
  } as unknown as ObjectVerbStore;
  return store;
};

const call = (store: ObjectVerbStore, request: ObjectVerbRequest) =>
  handleObjectVerb(store, request, ACTOR, {
    validationContext: { resolveArtifactRef: () => ({ exists: true }) },
  });

test('object_patch: a PDF attached without a type persists as a document node; an opaque src is a 422 naming it', async () => {
  const store = createMemoryStore();
  const created = await call(store, {
    action: 'create',
    object_type: 'content_item',
    site: 'site_drlurie',
    body: articleBody(),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const objectId = (created.body as { record: { object_id: string } }).record.object_id;

  const checkout = await call(store, { action: 'checkout', object_type: 'content_item', object_id: objectId });
  assert.equal(checkout.status, 200);
  const lockToken = (checkout.body as { lockToken: string }).lockToken;
  let version = (checkout.body as { record_version: number }).record_version;

  const attached = await call(store, {
    action: 'patch',
    object_type: 'content_item',
    object_id: objectId,
    lock_token: lockToken,
    expected_record_version: version,
    ops: [
      {
        op: 'upsert_node',
        node: {
          id: 'n_guide',
          kind: 'content',
          public: { title: 'Download the guide', media: { src: PDF_PATH, title: 'Retinol guide', sizeBytes: 245760 } },
          rendering: { placement: 'inline' },
        },
      },
    ],
  });
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  const record = JSON.parse(
    (await store.get(`objects/content_item/by-id/${objectId}.json`)) ?? 'null'
  ) as ObjectRecord<ContentItemBody>;
  assert.equal(mediaOf(record.body, 'n_guide')?.type, 'document');
  version = (attached.body as { version: number }).version;

  const opaque = await call(store, {
    action: 'patch',
    object_type: 'content_item',
    object_id: objectId,
    lock_token: lockToken,
    expected_record_version: version,
    ops: [{ op: 'update_node', node_id: 'n_guide', fields: { public: { media: { src: OPAQUE_SRC } } } }],
  });
  assert.equal(opaque.status, 422, JSON.stringify(opaque.body));
  assert.equal((opaque.body as { code: string }).code, 'invalid_body');
  assert.ok((opaque.body as { message: string }).message.includes(OPAQUE_SRC));
});

// ─── the validator (bodies that arrive whole) ────────────────────────────────

const statusOf = (criteria: ReadinessCriterion[], id: string) => criteria.find((criterion) => criterion.id === id);

test('validator: type ⇄ src disagreement blocks article_media on create/validate/publish', () => {
  const bodyWith = (media: Record<string, unknown>) => ({
    slug: 'probe',
    title: 'Probe',
    nodes: [{ id: 'n_m1', kind: 'content', public: { body: 'Copy.', media } }],
  });
  const context = { resolveArtifactRef: () => ({ exists: true }) };

  const pdfAsImage = statusOf(
    checkStructuralInvariants('content_item', REQ, bodyWith({ type: 'image', src: PDF_PATH }), context, false),
    'article_media'
  );
  assert.equal(pdfAsImage?.status, 'missing');
  assert.match(pdfAsImage?.message ?? '', /is a PDF but the media type is "image"/);
  assert.match(pdfAsImage?.message ?? '', /broken <img>/);

  const pngAsDocument = statusOf(
    checkStructuralInvariants('content_item', REQ, bodyWith({ type: 'document', src: PNG_PATH }), context, false),
    'article_media'
  );
  assert.equal(pngAsDocument?.status, 'missing');
  assert.match(pngAsDocument?.message ?? '', /is an image but the media type is "document"/);

  const good = statusOf(
    checkStructuralInvariants(
      'content_item',
      REQ,
      bodyWith({ type: 'document', src: PDF_PATH, sizeBytes: 1024 }),
      context,
      true
    ),
    'article_media'
  );
  assert.equal(good?.status, 'complete');
});
