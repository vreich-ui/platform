import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  checkArtifactTrust,
  checkPdfContentQuality,
  checkVisualStandardAssetRefs,
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

/**
 * The "Preview unavailable" mood board (2026-09-07). Live on drlurie,
 * `vis_drlurie` carried mood-board references whose "sha256" was the
 * reference's own minted id padded out to 64 hex characters — `ref_abc27032`
 * → `image/vis_drlurie/abc2703243a27a…` — under a request id (`vis_drlurie`,
 * the OBJECT id) that is not even a valid `req_<flow>_<topic>_<yyyymmdd>_<nn>`
 * and had nothing indexed against it. `set_visual_standard_fields` accepted
 * all of it, because artifact existence was only ever checked for
 * `*AssetRef`-suffixed keys and content_item media, and `visual_standard` is
 * exempted from the renderable-ref guard on top of that.
 */
describe('checkVisualStandardAssetRefs — mood board / example blobKeys', () => {
  const VS_REAL = `image/req_visref_drlurie_20260906_01/${SHA}.jpg`;
  const VS_FABRICATED = `image/vis_drlurie/${'b'.repeat(64)}.jpg`;
  const standard = (refs: unknown[], examples: unknown[] = []) => ({
    version: 1,
    kind: 'house',
    label: 'House standard',
    references: refs,
    examples,
  });
  const resolving = (existing: Set<string>): ObjectValidationContext => ({
    resolveArtifactRef: (blobKey): ArtifactRefResolution | undefined =>
      existing.has(blobKey) ? { exists: true } : { exists: false },
  });

  it('tier 1 — blocks a key owned by an object id rather than a request id, with NO index resolver at all', () => {
    // The exact live shape: the "sha256" is the ref id padded out to 64 hex
    // characters, under `vis_drlurie` — the OBJECT id. This must block on the
    // key alone, because tier 2 cannot be relied on: a MISS only proves
    // absence under a strongly-consistent read, and most deployments do not
    // get one (see the two-tier note in object-validate.ts).
    const [result] = checkVisualStandardAssetRefs(
      'visual_standard',
      standard([{ id: 'ref_abc27032', blobKey: VS_FABRICATED, weight: 1 }]),
      {} // no resolveArtifactRef — tier 1 stands entirely on its own
    );
    assert.strictEqual(result.status, 'missing');
    assert.ok(result.message.includes('references[0].blobKey'), result.message);
    assert.ok(result.message.includes('not a request id'), result.message);
    // It must also say what to do instead, not just refuse.
    assert.ok(/Import references|image library/.test(result.message), result.message);
  });

  it('tier 2 — blocks a properly-owned key the artifact index says is absent', () => {
    const [result] = checkVisualStandardAssetRefs(
      'visual_standard',
      standard([{ id: 'ref_053u3o9t', blobKey: VS_REAL, weight: 1 }]),
      resolving(new Set()) // resolver answers "absent" authoritatively
    );
    assert.strictEqual(result.status, 'missing');
    assert.ok(result.message.includes('not in the artifact index'), result.message);
  });

  it('blocks at WRITE, not only at publish — a visual_standard never publishes, so publish-time is never', () => {
    // Every other existence check in this file warns while drafting and blocks
    // at publish. That posture is what let the fabricated keys land: a
    // visual_standard has no materializer and is absent from
    // approval-policy.ts's governedObjectTypes, so "block at publish" means
    // "never block". This criterion takes no atPublish argument for exactly
    // that reason — a blocking status with nothing publish-like set is the
    // whole point.
    const [drafting] = checkVisualStandardAssetRefs(
      'visual_standard',
      standard([{ id: 'ref_abc27032', blobKey: VS_FABRICATED, weight: 1 }]),
      {}
    );
    assert.strictEqual(drafting.status, 'missing');
    // That it is WIRED into the pipeline (and so really refuses the write with
    // a 422) is proved end to end against the live verb path in
    // tests/netlify/visual-standard.test.ts — `validateObject` cannot be
    // called from here with a resolver, because checkMediaBudget would then
    // reach `activeMediaPolicy()` and this core-side test must not import a
    // site's policy bindings.
  });

  it('accepts a reference whose bytes really are indexed', () => {
    const [result] = checkVisualStandardAssetRefs(
      'visual_standard',
      standard([{ id: 'ref_053u3o9t', blobKey: VS_REAL, weight: 1 }]),
      resolving(new Set([VS_REAL]))
    );
    assert.strictEqual(result.status, 'complete');
  });

  it('checks generated examples[] by the same rule as references[]', () => {
    const [result] = checkVisualStandardAssetRefs(
      'visual_standard',
      standard([], [{ usageContext: 'article_header', blobKey: VS_FABRICATED }]),
      {}
    );
    assert.strictEqual(result.status, 'missing');
    assert.ok(result.message.includes('examples[0].blobKey'), result.message);
  });

  it('ignores a blobKey the admin would never try to preview, rather than blocking it', () => {
    // `img/mood/1.jpg` and friends are not Major-Key shaped, so
    // getAdminBlobImageEndpoint refuses to build a preview URL and the card
    // renders "not in the admin-previewable artifact store" — honest, not a
    // broken promise. That is a different (non-)problem from the one this
    // criterion exists for, and several tests use the shape as a placeholder.
    for (const blobKey of ['img/mood/1.jpg', 'https://example.com/photo.jpg', 'just-a-name.png']) {
      const [result] = checkVisualStandardAssetRefs(
        'visual_standard',
        standard([{ id: 'ref_x', blobKey, weight: 1 }]),
        resolving(new Set())
      );
      assert.strictEqual(result.status, 'optional', `${blobKey} is out of scope, not a blocker`);
    }
  });

  it('degrades to silence when existence is not verifiable, rather than blocking a legitimate write', () => {
    // No resolveArtifactRef wired (no blob credentials, a bare harness) — the
    // same posture validateAssetRef takes when the resolver cannot answer.
    const [result] = checkVisualStandardAssetRefs(
      'visual_standard',
      standard([{ id: 'ref_053u3o9t', blobKey: VS_REAL, weight: 1 }]),
      {}
    );
    assert.strictEqual(result.status, 'complete');
  });

  it('says nothing at all for other object types, and reports "optional" for a board with no images', () => {
    assert.deepStrictEqual(checkVisualStandardAssetRefs('content_item', articleBody(), {}), []);
    const [empty] = checkVisualStandardAssetRefs('visual_standard', standard([]), {});
    assert.strictEqual(empty.status, 'optional');
  });
});
