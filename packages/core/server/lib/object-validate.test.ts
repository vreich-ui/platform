import { describe, it } from 'node:test';
import assert from 'node:assert';

import { checkArtifactTrust, type ArtifactRefResolution, type ObjectValidationContext } from './object-validate.js';

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
