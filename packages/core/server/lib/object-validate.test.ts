import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  checkArtifactTrust,
  checkPdfContentQuality,
  validateObject,
  summarizeValidation,
  type ArtifactRefResolution,
  type ObjectValidationContext,
} from './object-validate.js';
import type { DocumentContentCheck } from './pdf-content-inspection.js';

// A valid 64-hex-char sha256, reused across fixtures.
const SHA = 'a'.repeat(64);
const IMG_PATH = `/img/req_1/${SHA}.png`;
const PDF_PATH = `/pdf/req_1/${SHA}.pdf`;
const IMG_RAW = `image/req_1/${SHA}.png`;
const PDF_RAW = `pdf/req_1/${SHA}.pdf`;

const articleBody = () => ({
  slug: 'my-article',
  nodes: [
    { id: 'n1', kind: 'content', public: { media: { type: 'image', src: IMG_PATH } } },
    { id: 'n2', kind: 'content', public: { media: { type: 'document', src: PDF_PATH } } },
  ],
});

describe('checkArtifactTrust — public artifact paths (article bodies)', () => {
  it('sees a /img/ and /pdf/ node media src instead of reporting "No asset references present"', () => {
    const [result] = checkArtifactTrust(articleBody(), {});
    assert.notStrictEqual(result.status, 'optional');
    assert.ok(
      !result.message.includes('No asset references present'),
      `expected the ref to be seen, got: ${result.message}`
    );
  });

  it('does not double-report existence: a public path that resolveArtifactRef says is missing is left to article_media, not re-blocked here', () => {
    const context: ObjectValidationContext = {
      resolveArtifactRef: (): ArtifactRefResolution | undefined => ({ exists: false }),
    };
    const [result] = checkArtifactTrust(articleBody(), context);
    // article_media (checkContentItemMedia) owns existence for these same
    // fields and blocks at publish; artifact_trust must not repeat it.
    assert.strictEqual(result.status, 'complete');
  });

  it('still enforces the trustedAssetRefs allow-list against the RAW form of a public path', () => {
    const context: ObjectValidationContext = {
      trustedAssetRefs: new Set([IMG_RAW]), // PDF ref deliberately not trusted
    };
    const [result] = checkArtifactTrust(articleBody(), context);
    assert.strictEqual(result.status, 'missing');
    assert.ok(result.message.includes('not an index-trusted artifact reference'), result.message);
  });

  it('reports complete when every public path ref is trusted', () => {
    const context: ObjectValidationContext = {
      trustedAssetRefs: new Set([IMG_RAW, PDF_RAW]),
    };
    const [result] = checkArtifactTrust(articleBody(), context);
    assert.strictEqual(result.status, 'complete');
  });

  it('a body with no asset refs at all still reports "No asset references present" (unchanged)', () => {
    const [result] = checkArtifactTrust({ slug: 'no-media-here', nodes: [] }, {});
    assert.strictEqual(result.status, 'optional');
    assert.ok(result.message.includes('No asset references present'));
  });
});

describe('checkArtifactTrust — *AssetRef fields (unchanged prior behavior)', () => {
  it('a raw *AssetRef with no context is seen and reported complete', () => {
    const [result] = checkArtifactTrust({ imageAssetRef: IMG_RAW }, {});
    assert.strictEqual(result.status, 'complete');
  });

  it('a raw *AssetRef not in trustedAssetRefs is blocked', () => {
    const context: ObjectValidationContext = { trustedAssetRefs: new Set() };
    const [result] = checkArtifactTrust({ portraitAssetRef: IMG_RAW }, context);
    assert.strictEqual(result.status, 'missing');
    assert.ok(result.message.includes('not an index-trusted artifact reference'));
  });

  it('a raw *AssetRef with a resolver reporting non-existence is a draft warning, publish blocker', () => {
    const context: ObjectValidationContext = {
      resolveArtifactRef: (): ArtifactRefResolution | undefined => ({ exists: false }),
    };
    const draft = checkArtifactTrust({ imageAssetRef: IMG_RAW }, context, false);
    assert.strictEqual(draft[0].status, 'warning');
    const publish = checkArtifactTrust({ imageAssetRef: IMG_RAW }, context, true);
    assert.strictEqual(publish[0].status, 'missing');
  });

  it('a non-Major-Key value in a *AssetRef field is a shape (blocking) problem', () => {
    const [result] = checkArtifactTrust({ imageAssetRef: 'not-a-real-ref' }, {});
    assert.strictEqual(result.status, 'missing');
    assert.ok(result.message.includes('Major Key artifact reference'));
  });
});

describe('checkPdfContentQuality (T2.5, ruling D-D) — warn-only, never blocks', () => {
  // articleBody() above already carries a document-typed node (n2) pointing at
  // PDF_PATH — reused here so the fixture matches exactly what checkContentItemMedia
  // and checkPdfContentQuality both walk.
  const articleWithPdf = () => ({ ...articleBody(), title: 'My article' }) as unknown as Parameters<
    typeof checkPdfContentQuality
  >[0];

  it('no resolver on the context: emits nothing (never fabricates a pass)', () => {
    const result = checkPdfContentQuality(articleWithPdf(), {});
    assert.deepStrictEqual(result, []);
  });

  it('resolver present but has no answer for this path: emits nothing', () => {
    const context: ObjectValidationContext = { resolvePdfContentCheck: () => undefined };
    assert.deepStrictEqual(checkPdfContentQuality(articleWithPdf(), context), []);
  });

  it('no PDF attached at all: emits nothing regardless of resolver', () => {
    const context: ObjectValidationContext = {
      resolvePdfContentCheck: (): DocumentContentCheck => ({ status: 'failed', reason: 'x', findings: [] }),
    };
    const noPdfArticle = { title: 't', slug: 'no-pdf', nodes: [] } as unknown as Parameters<
      typeof checkPdfContentQuality
    >[0];
    assert.deepStrictEqual(checkPdfContentQuality(noPdfArticle, context), []);
  });

  it('a clean attached PDF (status: ok) validates complete — no warning', () => {
    const context: ObjectValidationContext = {
      resolvePdfContentCheck: (): DocumentContentCheck => ({ status: 'ok', pageCount: 5, sizeBytes: 12345 }),
    };
    const [result] = checkPdfContentQuality(articleWithPdf(), context);
    assert.strictEqual(result.id, 'pdf_quality');
    assert.strictEqual(result.status, 'complete');
  });

  it('a PDF that failed content inspection: warns, names what was wrong, never blocks', () => {
    const context: ObjectValidationContext = {
      resolvePdfContentCheck: (): DocumentContentCheck => ({
        status: 'failed',
        reason: '2 pages have no readable body text (pages 3, 4). 1 image failed to resolve (page 2).',
        findings: [],
      }),
    };
    const [result] = checkPdfContentQuality(articleWithPdf(), context);
    assert.strictEqual(result.id, 'pdf_quality');
    assert.strictEqual(result.status, 'warning');
    assert.ok(result.message.includes('no readable body text'), result.message);
    assert.ok(result.message.includes('never blocks'), result.message);
  });

  it('the warning never escalates to a publish blocker: validateObject stays eligible at publishIntent:true', () => {
    const context: ObjectValidationContext = {
      resolvePdfContentCheck: (): DocumentContentCheck => ({
        status: 'failed',
        reason: 'Only 1 page(s); at least 2 required.',
        findings: [],
      }),
    };
    // A body that fully satisfies contentItemBodySchema (unlike articleBody() above,
    // whose "n1"/"n2" ids fail ARTICLE_NODE_ID_RE) — checkContentItemStructure parses
    // the body itself and bails to 'optional' before reaching pdf_quality otherwise.
    const body = {
      slug: 'my-article',
      title: 'My article',
      nodes: [
        { id: 'n_1', kind: 'content', public: { media: { type: 'image', src: IMG_PATH } } },
        { id: 'n_2', kind: 'content', public: { media: { type: 'document', src: PDF_PATH } } },
      ],
    };
    const groups = validateObject(
      { objectType: 'content_item', objectId: 'article_x', body, published: false },
      { ...context, publishIntent: true }
    );
    const structure = groups.find((g) => g.id === 'structure');
    const pdfQuality = structure?.criteria.find((c) => c.id === 'pdf_quality');
    assert.ok(pdfQuality, 'expected a pdf_quality criterion');
    assert.strictEqual(pdfQuality!.status, 'warning', 'pdf_quality must stay a warning even at publish intent');
    const summary = summarizeValidation(groups);
    assert.ok(
      summary.warnings.some((w) => w.id === 'pdf_quality'),
      'pdf_quality must surface in summary.warnings'
    );
    assert.ok(
      !summary.blockers.some((b) => b.id === 'pdf_quality'),
      'pdf_quality must never appear in summary.blockers'
    );
  });

  it('a failed-inspection reason carrying a blobKey or sha256 is redacted before it reaches the criterion message', () => {
    const context: ObjectValidationContext = {
      resolvePdfContentCheck: (): DocumentContentCheck => ({
        status: 'failed',
        reason: `Leaked reference pdf/req_1/${SHA}.pdf and bare sha ${SHA} in rendered output.`,
        findings: [],
      }),
    };
    const [result] = checkPdfContentQuality(articleWithPdf(), context);
    assert.strictEqual(result.status, 'warning');
    assert.ok(!result.message.includes(SHA), `message must not carry the raw sha256: ${result.message}`);
    assert.ok(!result.message.includes('pdf/req_1/'), `message must not carry a blobKey: ${result.message}`);
  });

  it('status "unverified": reports "not verified" at optional (never a false pass, never a warning)', () => {
    const context: ObjectValidationContext = {
      resolvePdfContentCheck: (): DocumentContentCheck => ({
        status: 'unverified',
        reason: 'Content could not be inspected: pdf-tool bridge not configured.',
      }),
    };
    const [result] = checkPdfContentQuality(articleWithPdf(), context);
    assert.strictEqual(result.id, 'pdf_quality');
    assert.strictEqual(result.status, 'optional');
    assert.ok(result.message.includes('not verified'), result.message);
  });
});
