import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectDimensionRows,
  dimensionRowsForExport,
  pushTrackingDimensions,
} from '../../scripts/tracking-dims-push.mjs';

const producer = {
  run_id: 'run_article_01',
  node_id: 'publish_article',
  prompt_version: 'publisher.v4',
  model: 'gpt-5.6-sol',
};

const article = {
  __generated: {
    from: 'objects/content_item/by-id/req_agent_article_20260828_01.json',
    at: '2026-08-28T12:00:00.000Z',
    record_version: 17,
    producer,
  },
  slug: 'article-one',
  lineage: { parent_content_id: 'req_agent_parent_20260827_01' },
  nodes: [
    { id: 'n_open', kind: 'content', private: { strategy: 'hook', intent: 'attention' }, public: {} },
    { id: 'n_close', kind: 'action', public: {} },
  ],
};

const page = {
  __generated: {
    from: 'objects/page/by-id/page_home.json',
    at: '2026-08-28T12:05:00.000Z',
    record_version: 9,
  },
  route: '/',
};

test('dimensionRowsForExport emits the exact /dims object_version, producer, and node_strategy shapes', () => {
  assert.deepEqual(dimensionRowsForExport(article, 'content_item'), {
    object_version: [
      {
        object_id: 'req_agent_article_20260828_01',
        version: 17,
        published_at: '2026-08-28T12:00:00.000Z',
        route: '/article-one',
        variant_of: 'req_agent_parent_20260827_01',
        // W7.4: which chat surface published this revision, and how that
        // identity was established. Null here because this fixture's marker
        // predates the stamp — which is the state most of the live corpus is in.
        surface: null,
        attribution: null,
      },
    ],
    producer: [{ object_id: 'req_agent_article_20260828_01', version: 17, ...producer }],
    node_strategy: [
      {
        object_id: 'req_agent_article_20260828_01',
        node_id: 'n_open',
        strategy: 'hook',
        intent: 'attention',
        node_kind: 'content',
        position: 0,
      },
      {
        object_id: 'req_agent_article_20260828_01',
        node_id: 'n_close',
        strategy: null,
        intent: null,
        node_kind: 'action',
        position: 1,
      },
    ],
  });
  assert.deepEqual(dimensionRowsForExport(page, 'page'), {
    object_version: [
      {
        object_id: 'page_home',
        version: 9,
        published_at: '2026-08-28T12:05:00.000Z',
        route: '/',
        variant_of: null,
        // W7.4: pages carry the same two columns. A page published by the
        // admin has no chat surface, which is exactly what null says.
        surface: null,
        attribution: null,
      },
    ],
    producer: [],
    node_strategy: [],
  });
});

test('collectDimensionRows reads pages/articles deterministically and skips malformed exports individually', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tracking-dims-'));
  try {
    await mkdir(path.join(root, 'articles'), { recursive: true });
    await mkdir(path.join(root, 'pages'), { recursive: true });
    await writeFile(path.join(root, 'articles', 'article.json'), JSON.stringify(article));
    await writeFile(path.join(root, 'articles', 'bad.json'), '{');
    await writeFile(path.join(root, 'pages', 'page.json'), JSON.stringify(page));

    const result = await collectDimensionRows(root);
    assert.deepEqual(
      result.rows.object_version.map((row) => row.object_id),
      ['page_home', 'req_agent_article_20260828_01']
    );
    assert.equal(result.rows.producer.length, 1);
    assert.equal(result.rows.node_strategy.length, 2);
    assert.deepEqual(result.skipped, [path.join(root, 'articles', 'bad.json')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pushTrackingDimensions posts one authenticated JSON payload to /dims with a 2-second abort signal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tracking-dims-'));
  try {
    await mkdir(path.join(root, 'articles'), { recursive: true });
    await writeFile(path.join(root, 'articles', 'article.json'), JSON.stringify(article));
    const calls = [];
    const result = await pushTrackingDimensions({
      exportRoot: root,
      env: {
        TRACKING_SINK_URL: 'https://sink.example/base/',
        TRACKING_SINK_TOKEN: 'test-token',
        TRACKING_PROJECT_ID: 'drlurie',
      },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ object_version: 1, producer: 1, node_strategy: 2 }), { status: 202 });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://sink.example/base/dims');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-token');
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.project_id, 'drlurie');
    assert.equal(body.object_version.length, 1);
    assert.deepEqual(body.producer[0], { object_id: 'req_agent_article_20260828_01', version: 17, ...producer });
    assert.equal(body.node_strategy.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pushTrackingDimensions no-ops without env and swallows sink failures', async () => {
  let calls = 0;
  const absent = await pushTrackingDimensions({
    exportRoot: '/unused',
    env: {},
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 202 });
    },
  });
  assert.deepEqual(absent.skipped, 'missing_configuration');
  assert.equal(calls, 0);

  const root = await mkdtemp(path.join(os.tmpdir(), 'tracking-dims-'));
  try {
    const failed = await pushTrackingDimensions({
      exportRoot: root,
      env: {
        TRACKING_SINK_URL: 'https://sink.example',
        TRACKING_SINK_TOKEN: 'test-token',
        TRACKING_PROJECT_ID: 'drlurie',
      },
      fetchImpl: async () => {
        throw new Error('sink unavailable');
      },
    });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /sink unavailable/);

    const rejected = await pushTrackingDimensions({
      exportRoot: root,
      env: {
        TRACKING_SINK_URL: 'https://sink.example',
        TRACKING_SINK_TOKEN: 'test-token',
        TRACKING_PROJECT_ID: 'drlurie',
      },
      fetchImpl: async () => new Response(null, { status: 503 }),
    });
    assert.deepEqual({ ok: rejected.ok, status: rejected.status }, { ok: false, status: 503 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the root build, every tenant build, and create-site template run the best-effort dims post-build', async () => {
  const rootPackage = JSON.parse(await readFile('package.json', 'utf8'));
  assert.match(rootPackage.scripts.postbuild, /tracking-dims-push\.mjs --export-root sites\/drlurie\/data\/site/);

  for (const tenant of ['fernwell', 'platform', 'zilberman']) {
    const toml = await readFile(`sites/${tenant}/netlify.toml`, 'utf8');
    assert.match(toml, /tracking-dims-push\.mjs --export-root data\/site \|\| true/);
  }
  const scaffold = await readFile('packages/core/cli/create-site.mjs', 'utf8');
  assert.match(scaffold, /tracking-dims-push\.mjs --export-root data\/site \|\| true/);
});
