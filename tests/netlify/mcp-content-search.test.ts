import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';

/**
 * `content_search`, end to end through the MCP handler.
 *
 * The acceptance this suite is written against is the failure the tool exists
 * to remove: an agent holding only a URL or a headline must reach a usable
 * object_id WITHOUT a human pasting a `req_*` id and without enumerating the
 * library. Each test therefore ends at "the id I can now hand to object_get".
 *
 * Note on cost: the local file-backed blob store reports `etag: ''`, so every
 * sweep here runs the ENUMERATION fallback rather than the cached path. That
 * is deliberate — it proves the fallback is correct. The caching path is
 * covered against an etag-reporting store in
 * packages/core/server/lib/objects/search-index-store.test.ts.
 */
for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID', 'MCP_HTTP_AUTH_TOKEN']) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-content-search');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);
const SITE_OBJECTS_DIR = join(LOCAL_BLOBS_ROOT, 'site-objects');
const reset = () => rm(SITE_OBJECTS_DIR, { recursive: true, force: true });

type ToolCallResult = { isError?: boolean; structuredContent?: Record<string, unknown> };
type SearchRow = { object_id: string; object_type: string; slug: string | null; score: number; route: string | null };

const rpc = async (method: string, params?: Record<string, unknown>) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  assert.equal(response.statusCode, 200);
  return JSON.parse(response.body) as { result: Record<string, unknown> };
};

const callTool = async (name: string, args: Record<string, unknown>) => {
  const body = await rpc('tools/call', { name, arguments: args });
  return body.result as ToolCallResult;
};

const search = async (args: Record<string, unknown>) => {
  const result = await callTool('content_search', args);
  assert.ok(!result.isError, JSON.stringify(result.structuredContent));
  const content = result.structuredContent ?? {};
  return {
    results: (content.results ?? []) as SearchRow[],
    canonical: content.canonical_result as SearchRow | undefined,
  };
};

const article = (slug: string, title: string) => ({
  object_type: 'content_item',
  site: 'site_drlurie',
  body: {
    slug,
    title,
    description: `${title} — what the evidence says.`,
    seo: { meta_title: title, meta_description: `${title} explained.` },
    taxonomy: { category: 'ingredients', tags: ['antioxidants'] },
    nodes: [{ id: 'n_a1', kind: 'content', public: { title: 'The evidence', body: 'Body prose.' } }],
  },
});

const page = () => ({
  object_type: 'page',
  site: 'site_drlurie',
  body: {
    route: '/about',
    pageType: 'standard',
    title: 'About Dr. Lurié',
    seo: { description: 'Who we are.' },
    sections: [],
  },
});

/**
 * Ids are MINTED, never requested: the point of the tool is that the caller
 * does not know the id in advance, so a fixture that hard-codes one would be
 * testing a world this feature exists to remove.
 */
const seed = async () => {
  await reset();
  const created = async (input: Record<string, unknown>) => {
    const result = await callTool('object_create', input);
    assert.ok(!result.isError, JSON.stringify(result.structuredContent));
    const record = result.structuredContent?.record as { object_id?: string } | undefined;
    const objectId = record?.object_id;
    assert.ok(objectId, `no object_id in ${JSON.stringify(result.structuredContent)}`);
    return objectId as string;
  };
  return {
    nac: await created(article('nac-for-skin-health', 'NAC for Skin Health')),
    retinol: await created(article('retinol-without-the-peeling', 'Retinol Without the Peeling')),
    about: await created(page()),
  };
};

test('content_search is on the tool surface as a read', async () => {
  const tools = (await rpc('tools/list')).result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
  const tool = tools.find((entry) => entry.name === 'content_search');
  assert.ok(tool, 'content_search is not listed');
  assert.equal(tool?.annotations?.readOnlyHint, true);
});

test('a slug resolves to one object id an agent can act on immediately', async () => {
  const ids = await seed();
  const { canonical } = await search({ slug: 'nac-for-skin-health' });
  assert.equal(canonical?.object_id, ids.nac);
  assert.equal(canonical?.score, 1);

  // The whole point: that id now works in the verbs the agent goes on to call.
  const fetched = await callTool('object_get', {
    object_type: 'content_item',
    object_id: canonical?.object_id,
    projection: 'summary',
  });
  assert.ok(!fetched.isError, JSON.stringify(fetched.structuredContent));
});

test('a full published URL resolves the same object as its slug', async () => {
  const ids = await seed();
  const { canonical } = await search({ url: 'https://drluriescience.netlify.app/nac-for-skin-health' });
  assert.equal(canonical?.object_id, ids.nac);
});

test('a headline resolves the object without anyone knowing the request id', async () => {
  const ids = await seed();
  const { canonical } = await search({ title: 'NAC for Skin Health' });
  assert.equal(canonical?.object_id, ids.nac);
});

test('a free-text query ranks the right article first', async () => {
  const ids = await seed();
  const { results } = await search({ query: 'NAC skin health antioxidants' });
  assert.equal(results[0]?.object_id, ids.nac);
});

test('a page route resolves to the page, and object_type narrows the scope', async () => {
  const ids = await seed();
  const { canonical } = await search({ route: '/about' });
  assert.equal(canonical?.object_id, ids.about);
  assert.equal(canonical?.object_type, 'page');

  const narrowed = await search({ query: 'skin health', object_type: 'page' });
  assert.deepEqual(narrowed.results, [], 'narrowing to page must not return articles');
});

test('a mistyped slug still resolves — the plugin-agent case this was written for', async () => {
  const ids = await seed();
  const { results } = await search({ slug: 'nac-for-skin-helth' });
  assert.equal(results[0]?.object_id, ids.nac);
  assert.ok(results[0]?.score !== undefined && results[0].score < 1, 'an approximate hit must not claim 1.0');
});

test('a search with no criteria is refused rather than returning the whole library', async () => {
  await seed();
  const result = await callTool('content_search', {});
  assert.equal(result.isError, true);
});

test('a search that matches nothing returns an empty list, not an error', async () => {
  await seed();
  const { results, canonical } = await search({ slug: 'a-slug-that-does-not-exist-anywhere' });
  assert.deepEqual(results, []);
  assert.equal(canonical, undefined);
});
