import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';

/**
 * W6 D4 — `article_claim_substrate` must tell the truth.
 *
 * Before this change the criterion warned unless BOTH `sources.source_list`
 * and `claims.claim_list` were present. The plugin skill forbids writing
 * `claims` (an unverified or unsourced high-risk claim BLOCKS the publish via
 * article_claim_verification, and a plugin has no readiness report to clear it
 * with), so a plugin that did everything right — three real peer-reviewed
 * sources — still got "no claims recorded" and still surfaced to the operator
 * as an action item. Permanent, unclearable, and false about what was on the
 * body.
 *
 * Driven through the real /mcp handler's `object_validate` candidate mode —
 * the same checks object_create runs — so this pins the behaviour an agent
 * actually sees, not a helper in isolation.
 */
for (const key of [
  'NETLIFY',
  'NETLIFY_SITE_ID',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'SITE_ID',
  'MCP_HTTP_AUTH_TOKEN',
]) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'object-validate-claim-substrate');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);
const SITE_OBJECTS_DIR = join(LOCAL_BLOBS_ROOT, 'site-objects');

type Criterion = { id: string; label: string; status: string; message: string };
type ValidateResult = {
  isError?: boolean;
  content?: { type: string; text: string }[];
  structuredContent?: {
    validation?: { groups?: { criteria: Criterion[] }[]; criteria?: Criterion[] };
    summary?: { blockers?: Criterion[]; warnings?: Criterion[]; eligible?: boolean };
    [key: string]: unknown;
  };
};

const SOURCES = {
  source_list: [
    {
      source_id: 's1',
      name: 'A cross-sectional study of sensitive-skin assessment',
      url: 'https://example.org/study-one',
      publisher: 'Journal of Example Dermatology',
      accessed_at: '2026-09-01',
    },
    {
      source_id: 's2',
      name: 'A second indexed abstract on the same question',
      url: 'https://example.org/study-two',
      publisher: 'Journal of Example Dermatology',
      accessed_at: '2026-09-01',
    },
    {
      source_id: 's3',
      name: 'A third indexed abstract',
      url: 'https://example.org/study-three',
      publisher: 'Journal of Example Dermatology',
      accessed_at: '2026-09-01',
    },
  ],
};

const CLAIMS = {
  claim_list: [
    {
      claim_id: 'c1',
      text: 'Reported sensations vary widely between individuals.',
      source_ids: ['s1'],
      risk: 'low' as const,
      status: 'verified' as const,
    },
  ],
};

const bodyWith = (extra: Record<string, unknown>) => ({
  slug: 'claim-substrate-probe',
  title: 'A short article for the sourcing criterion',
  deck: 'Short, but complete enough to reach the sourcing check.',
  description: 'A fixture article used to pin the article_claim_substrate criterion across its three states.',
  author: 'Dr. Lurie',
  taxonomy: { category: 'skin-health', tags: ['skincare-basics'] },
  seo: { meta_description: 'A fixture article used to pin the article_claim_substrate criterion.' },
  nodes: [
    {
      id: 'n_01',
      kind: 'content' as const,
      public: { body: '<p>A short opening paragraph that carries the article’s point without asserting much.</p>' },
      private: { strategy: 'explanation', intent: 'educate' },
    },
    {
      id: 'n_02',
      kind: 'content' as const,
      public: {
        title: 'A second section',
        body: '<p>A second paragraph, so the body is a plausible article rather than a single line.</p>',
      },
      private: { strategy: 'resolution', intent: 'reassure' },
    },
  ],
  ...extra,
});

const validateCandidate = async (extra: Record<string, unknown>, requestedId: string) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'object_validate',
        arguments: { object_type: 'content_item', requested_id: requestedId, body: bodyWith(extra) },
      },
    }),
  });
  assert.equal(response.statusCode, 200);
  const result = (JSON.parse(response.body) as { result: ValidateResult }).result;
  assert.ok(!result.isError, `object_validate errored: ${result.content?.[0]?.text}`);
  return result;
};

/** The criterion, wherever the readiness payload groups it. */
const criterion = (result: ValidateResult, id: string): Criterion => {
  const structured = result.structuredContent ?? {};
  const found: Criterion[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.id === id && typeof record.status === 'string') found.push(record as unknown as Criterion);
    for (const nested of Object.values(record)) walk(nested);
  };
  walk(structured);
  assert.ok(found.length > 0, `expected the readiness payload to carry criterion ${id}`);
  return found[0];
};

const blockerIds = (result: ValidateResult) => (result.structuredContent?.summary?.blockers ?? []).map((c) => c.id);
const warningIds = (result: ValidateResult) => (result.structuredContent?.summary?.warnings ?? []).map((c) => c.id);

test('article_claim_substrate: sources present, no claims — info, not a warning', async () => {
  await rm(SITE_OBJECTS_DIR, { recursive: true, force: true });
  const result = await validateCandidate({ sources: SOURCES }, 'req_probe_substrate_20260901_01');
  const c = criterion(result, 'article_claim_substrate');

  assert.equal(c.status, 'info', 'three real sources and no claim ledger is the plugin path working, not a shortfall');
  assert.match(c.message, /3 sources listed/);
  assert.match(c.message, /no claim ledger — plugin path/);
  assert.ok(
    !/no claims recorded/.test(c.message),
    'the old text announced an absence while the sources sat right there — it must not come back'
  );

  assert.ok(
    !warningIds(result).includes('article_claim_substrate'),
    'an info criterion is not an operator action item'
  );
  assert.ok(!blockerIds(result).includes('article_claim_substrate'), 'this criterion never blocks');
});

test('article_claim_substrate: no sources at all — warning that names what is missing', async () => {
  const result = await validateCandidate({}, 'req_probe_substrate_20260901_02');
  const c = criterion(result, 'article_claim_substrate');

  assert.equal(c.status, 'warning', 'an unsourced article is the case the warning exists for');
  assert.match(c.message, /No sources listed/);
  assert.ok(warningIds(result).includes('article_claim_substrate'), 'this one SHOULD reach the operator');
  assert.ok(blockerIds(result).includes('article_claim_substrate') === false, 'but it still never blocks');
});

test('article_claim_substrate: both lists present — complete', async () => {
  const result = await validateCandidate({ sources: SOURCES, claims: CLAIMS }, 'req_probe_substrate_20260901_03');
  const c = criterion(result, 'article_claim_substrate');

  assert.equal(c.status, 'complete');
  assert.ok(!blockerIds(result).includes('article_claim_substrate'));
});

test('article_claim_verification is untouched by any of the three states', async () => {
  for (const [extra, id] of [
    [{ sources: SOURCES }, 'req_probe_substrate_20260901_04'],
    [{}, 'req_probe_substrate_20260901_05'],
    [{ sources: SOURCES, claims: CLAIMS }, 'req_probe_substrate_20260901_06'],
  ] as const) {
    const result = await validateCandidate(extra, id);
    const verification = criterion(result, 'article_claim_verification');
    assert.equal(verification.status, 'complete', 'no high-risk unverified claim exists in any fixture');
    assert.ok(!blockerIds(result).includes('article_claim_verification'));
  }
  await rm(SITE_OBJECTS_DIR, { recursive: true, force: true });
});
