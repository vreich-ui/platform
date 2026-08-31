import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MediaTypeError,
  inferMediaType,
  mediaSrcExtension,
  normalizeArticleNodeMedia,
  normalizeArticleNodeMediaFields,
  resolveMediaType,
} from './media-type.js';

const SHA = 'a'.repeat(64);
const PDF = `/pdf/req_x/${SHA}.pdf`;
const PNG = `/img/req_x/${SHA}.png`;

describe('inferMediaType', () => {
  it('.pdf / application/pdf → document', () => {
    assert.equal(inferMediaType(PDF), 'document');
    assert.equal(inferMediaType('https://cdn.example.com/guide.PDF?dl=1#p2'), 'document');
    assert.equal(inferMediaType('https://cdn.example.com/opaque', 'application/pdf'), 'document');
    assert.equal(inferMediaType('https://cdn.example.com/opaque', 'application/pdf; charset=binary'), 'document');
  });

  it('image extensions / image/* → image', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg']) {
      assert.equal(inferMediaType(`/img/req_x/${SHA}.${ext}`), 'image', ext);
    }
    assert.equal(inferMediaType('https://cdn.example.com/opaque', 'image/webp'), 'image');
  });

  it('unknown → undefined (never image by default)', () => {
    assert.equal(inferMediaType(''), undefined);
    assert.equal(inferMediaType('https://cdn.example.com/opaque'), undefined);
    assert.equal(inferMediaType('/files/thing.docx'), undefined);
    assert.equal(inferMediaType('/video/clip.mp4'), undefined);
  });

  it('the extension is the rendering signal — it wins over the route prefix', () => {
    assert.equal(inferMediaType(`/img/req_x/${SHA}.pdf`), 'document');
    assert.equal(mediaSrcExtension('/a/b/c.tar.gz?x=1'), 'gz');
    assert.equal(mediaSrcExtension('/a/b/noext'), '');
  });
});

describe('resolveMediaType', () => {
  it('keeps an explicit type that agrees with (or is uncontradicted by) the src', () => {
    assert.deepEqual(resolveMediaType('m', { type: 'document', src: PDF }), {
      ok: true,
      type: 'document',
      inferred: false,
    });
    assert.deepEqual(resolveMediaType('m', { type: 'image', src: PNG }), { ok: true, type: 'image', inferred: false });
    assert.deepEqual(resolveMediaType('m', { type: 'image', src: 'https://cdn.example.com/opaque' }), {
      ok: true,
      type: 'image',
      inferred: false,
    });
    assert.deepEqual(resolveMediaType('m', { type: 'video', src: '/video/clip.mp4' }), {
      ok: true,
      type: 'video',
      inferred: false,
    });
  });

  it('refuses an explicit type the src contradicts, naming the src', () => {
    const asImage = resolveMediaType('nodes.0.public.media', { type: 'image', src: PDF });
    assert.equal(asImage.ok, false);
    if (!asImage.ok) {
      assert.equal(asImage.reason, 'type_mismatch');
      assert.match(asImage.message, /nodes\.0\.public\.media\.type is "image"/);
      assert.ok(asImage.message.includes(PDF));
      assert.match(asImage.message, /type:"document"/);
    }
    const asDocument = resolveMediaType('m', { type: 'document', src: PNG });
    assert.equal(asDocument.ok, false);
    if (!asDocument.ok) assert.equal(asDocument.reason, 'type_mismatch');
  });

  it('infers a missing type; refuses an opaque src instead of guessing image', () => {
    assert.deepEqual(resolveMediaType('m', { src: PDF }), { ok: true, type: 'document', inferred: true });
    assert.deepEqual(resolveMediaType('m', { src: PNG }), { ok: true, type: 'image', inferred: true });
    const opaque = resolveMediaType('m', { src: 'https://cdn.example.com/opaque' });
    assert.equal(opaque.ok, false);
    if (!opaque.ok) {
      assert.equal(opaque.reason, 'unknown_src');
      assert.match(opaque.message, /cannot be inferred from src "https:\/\/cdn\.example\.com\/opaque"/);
      assert.match(opaque.message, /never defaulted to "image"/);
    }
  });
});

describe('normalizeArticleNodeMedia (upsert_node payloads)', () => {
  it('stamps the inferred type on media and images[] in place', () => {
    const node: Record<string, unknown> = {
      id: 'n_a1',
      public: { media: { src: PDF, title: 'Guide' }, images: [{ src: PNG, alt: 'x' }] },
    };
    normalizeArticleNodeMedia(node);
    const pub = node.public as { media: { type?: string }; images: Array<{ type?: string }> };
    assert.equal(pub.media.type, 'document');
    assert.equal(pub.images[0]?.type, 'image');
  });

  it('throws MediaTypeError with the node path for an opaque src or a contradiction', () => {
    assert.throws(
      () => normalizeArticleNodeMedia({ id: 'n_a1', public: { media: { src: '/files/x.bin' } } }, 'upsert_node node'),
      (error: unknown) =>
        error instanceof MediaTypeError &&
        error.reason === 'unknown_src' &&
        error.path === 'upsert_node node.public.media'
    );
    assert.throws(
      () => normalizeArticleNodeMedia({ id: 'n_a1', public: { images: [{ type: 'image', src: PDF }] } }),
      (error: unknown) => error instanceof MediaTypeError && error.reason === 'type_mismatch'
    );
  });

  it('leaves a src-less, type-less media alone (the body schema owns that report)', () => {
    const node = { id: 'n_a1', public: { media: { alt: 'later' } } };
    normalizeArticleNodeMedia(node);
    assert.deepEqual(node.public.media, { alt: 'later' });
  });
});

describe('normalizeArticleNodeMediaFields (update_node deep-merge)', () => {
  const existingImageNode = () => ({ id: 'n_a1', public: { media: { type: 'image', src: PNG, alt: 'x' } } });

  it('a PDF src landing on an image node re-derives the type instead of keeping the stale image', () => {
    const fields: Record<string, unknown> = { public: { media: { src: PDF } } };
    normalizeArticleNodeMediaFields(existingImageNode(), fields);
    assert.deepEqual(fields, { public: { media: { src: PDF, type: 'document' } } });
  });

  it('an explicit type in the op is kept but checked against the effective src', () => {
    const agree: Record<string, unknown> = { public: { media: { type: 'document', src: PDF } } };
    normalizeArticleNodeMediaFields(existingImageNode(), agree);
    assert.deepEqual(agree, { public: { media: { type: 'document', src: PDF } } });

    // type-only patch, src inherited from the node → contradiction
    assert.throws(
      () => normalizeArticleNodeMediaFields(existingImageNode(), { public: { media: { type: 'document' } } }),
      (error: unknown) => error instanceof MediaTypeError && error.reason === 'type_mismatch'
    );
  });

  it('an opaque src without a type is refused, never guessed', () => {
    assert.throws(
      () =>
        normalizeArticleNodeMediaFields(existingImageNode(), {
          public: { media: { src: 'https://cdn.example.com/opaque' } },
        }),
      (error: unknown) => error instanceof MediaTypeError && error.reason === 'unknown_src'
    );
  });

  it('caption/alt-only patches and video/audio/embed src changes are untouched', () => {
    const caption: Record<string, unknown> = { public: { media: { caption: 'Fig. 1' } } };
    normalizeArticleNodeMediaFields(existingImageNode(), caption);
    assert.deepEqual(caption, { public: { media: { caption: 'Fig. 1' } } });

    const video = { id: 'n_v1', public: { media: { type: 'video', src: 'https://videos.example.com/a' } } };
    const fields: Record<string, unknown> = { public: { media: { src: 'https://videos.example.com/b' } } };
    normalizeArticleNodeMediaFields(video, fields);
    assert.deepEqual(fields, { public: { media: { src: 'https://videos.example.com/b' } } });
  });

  it('images[] replaces wholesale — each entry normalizes standalone', () => {
    const fields: Record<string, unknown> = { public: { images: [{ src: PNG }, { src: PDF }] } };
    normalizeArticleNodeMediaFields(existingImageNode(), fields);
    const images = (fields.public as { images: Array<{ type?: string }> }).images;
    assert.deepEqual(
      images.map((entry) => entry.type),
      ['image', 'document']
    );
  });
});
