import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  DESCRIPTOR_FALLBACK_USAGE_CONTEXT,
  MODEL_DEFAULT_UNRESOLVED_WARNING,
  USAGE_CONTEXT_MISSING_WARNING,
  buildArtifactJobDescriptor,
  isUsageContextMissing,
  resolvePolicyDefaultImageModel,
  resolveRoutingWarnings,
} from './artifact-job-descriptor.js';

/**
 * site_platform's REAL get_image_model_policy body, read live 2026-09-08
 * through mcp__Kugel-Platform__get_image_model_policy. Copied verbatim so
 * these assertions are about the shape the bridge actually receives, not one
 * invented here.
 */
const SITE_PLATFORM_POLICY_BODY = {
  policy: {
    version: 1,
    byUsageContext: {
      article_header: { model: 'fal-ai/flux-2/klein/9b' },
      article_body: { model: 'fal-ai/flux-2/klein/9b' },
      category_page: { model: 'fal-ai/flux-2/klein/9b' },
    },
  },
  contexts: ['article_header', 'article_body', 'category_page'],
  siteId: 'site_platform',
};

test('the fallback context is article_body — the same one Platform coerces unknown contexts to', () => {
  // brand-imagery-resolve.ts's DEFAULT_USAGE_CONTEXT is the other half of
  // this pair; the repo-wide invariant in
  // tests/scripts/artifact-job-routing-invariants.test.mjs asserts the two
  // sources agree, without dragging that server module (and its blob store)
  // into this pure test.
  assert.equal(DESCRIPTOR_FALLBACK_USAGE_CONTEXT, 'article_body');
});

test("site_platform's live policy yields its FAL model, never gpt-image-1", () => {
  const model = resolvePolicyDefaultImageModel(SITE_PLATFORM_POLICY_BODY);
  assert.equal(model, 'fal-ai/flux-2/klein/9b');
  assert.notEqual(model, 'gpt-image-1');
});

test('an explicit policy-level defaultModel wins over the per-context table', () => {
  const model = resolvePolicyDefaultImageModel({
    policy: {
      defaultModel: 'fal-ai/flux-pro/v1.1',
      byUsageContext: { article_body: { model: 'fal-ai/flux-2/klein/9b' } },
    },
  });
  assert.equal(model, 'fal-ai/flux-pro/v1.1');
});

test('a policy without article_body still resolves one of the site\'s OWN models', () => {
  const model = resolvePolicyDefaultImageModel({
    policy: { byUsageContext: { open_graph: { model: 'fal-ai/some-other-model' } } },
    contexts: ['open_graph'],
  });
  assert.equal(model, 'fal-ai/some-other-model');
});

test('contexts[] ordering decides which model is inherited when article_body is absent', () => {
  const model = resolvePolicyDefaultImageModel({
    policy: {
      byUsageContext: { newsletter: { model: 'fal-ai/b' }, article_header: { model: 'fal-ai/a' } },
    },
    contexts: ['article_header', 'newsletter'],
  });
  assert.equal(model, 'fal-ai/a');
});

test('a policy that names no model anywhere resolves to undefined', () => {
  assert.equal(resolvePolicyDefaultImageModel({ policy: { byUsageContext: {} }, contexts: [] }), undefined);
  assert.equal(resolvePolicyDefaultImageModel({}), undefined);
  assert.equal(resolvePolicyDefaultImageModel(undefined), undefined);
  assert.equal(resolvePolicyDefaultImageModel('nope'), undefined);
  // A blank model string is not a model.
  assert.equal(resolvePolicyDefaultImageModel({ policy: { byUsageContext: { article_body: { model: '  ' } } } }), undefined);
});

test('the descriptor carries the grant projectId and the site FAL model', () => {
  assert.deepEqual(
    buildArtifactJobDescriptor({ projectId: 'platform', policyBody: SITE_PLATFORM_POLICY_BODY }),
    { projectId: 'platform', defaultModel: 'fal-ai/flux-2/klein/9b' }
  );
});

test('no descriptor is sent when either half is unusable', () => {
  // pdf-tool rejects a descriptor whose projectId disagrees with the grant's,
  // and a descriptor with no defaultModel tells it nothing it does not assume.
  assert.equal(buildArtifactJobDescriptor({ projectId: undefined, policyBody: SITE_PLATFORM_POLICY_BODY }), undefined);
  assert.equal(buildArtifactJobDescriptor({ projectId: '  ', policyBody: SITE_PLATFORM_POLICY_BODY }), undefined);
  assert.equal(buildArtifactJobDescriptor({ projectId: 'platform', policyBody: undefined }), undefined);
});

test('a missing usageContext is detected in every shape it can be missing in', () => {
  assert.equal(isUsageContextMissing(undefined), true);
  assert.equal(isUsageContextMissing({}), true);
  assert.equal(isUsageContextMissing({ maxBytes: 1000 }), true);
  assert.equal(isUsageContextMissing({ image: {} }), true);
  assert.equal(isUsageContextMissing({ image: { size: '1024x1024' } }), true);
  assert.equal(isUsageContextMissing({ image: { usageContext: '   ' } }), true);
  assert.equal(isUsageContextMissing({ image: { usageContext: 'article_body' } }), false);
});

test('the omission is warned about, and the call is never failed for it', () => {
  const descriptor = buildArtifactJobDescriptor({ projectId: 'platform', policyBody: SITE_PLATFORM_POLICY_BODY });
  assert.deepEqual(resolveRoutingWarnings({ requirements: undefined, descriptor }), [
    USAGE_CONTEXT_MISSING_WARNING,
  ]);
  assert.deepEqual(
    resolveRoutingWarnings({ requirements: { image: { usageContext: 'article_body' } }, descriptor }),
    []
  );
});

test('an unresolvable default is reported too, and both warnings can ride together', () => {
  assert.deepEqual(resolveRoutingWarnings({ requirements: undefined, descriptor: undefined }), [
    USAGE_CONTEXT_MISSING_WARNING,
    MODEL_DEFAULT_UNRESOLVED_WARNING,
  ]);
  // An empty policy is the same fact as an unreadable one: no descriptor, so
  // pdf-tool's own gpt-image-1 fallback decides. Never silent.
  const descriptor = buildArtifactJobDescriptor({
    projectId: 'platform',
    policyBody: { policy: { byUsageContext: {} }, contexts: [] },
  });
  assert.equal(descriptor, undefined);
  assert.deepEqual(
    resolveRoutingWarnings({ requirements: { image: { usageContext: 'article_body' } }, descriptor }),
    [MODEL_DEFAULT_UNRESOLVED_WARNING]
  );
});
