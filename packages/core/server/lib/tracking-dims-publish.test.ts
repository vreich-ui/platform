import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeDimsPush, nodeStrategyRowsFromBody, pushNodeStrategyDims } from './tracking-dims-publish.js';

const ENV = {
  TRACKING_SINK_URL: 'https://sink.example.com/api/tracking-sink',
  TRACKING_SINK_TOKEN: 'sekrit-token',
  TRACKING_PROJECT_ID: 'drlurie',
};

const article = {
  slug: 'how-retinoids-work',
  nodes: [
    { id: 'n1', kind: 'hook', private: { strategy: 'curiosity_gap', intent: 'stop_the_scroll' } },
    { id: 'n2', kind: 'body', private: { intent: 'build_credibility' } },
    { id: 'n3', kind: 'body' },
    { kind: 'body', private: { strategy: 'orphan' } },
    'not a node',
  ],
};

const okResponse = { ok: true, status: 200, json: async () => ({}) } as unknown as Response;

describe('nodeStrategyRowsFromBody', () => {
  it('reads the labels the export no longer carries', () => {
    // The whole point of KI-08: these come from the STORE record, where
    // `private` still exists. Read from an export they would all be null.
    const rows = nodeStrategyRowsFromBody('art_1', article);
    assert.deepEqual(rows, [
      { object_id: 'art_1', node_id: 'n1', strategy: 'curiosity_gap', intent: 'stop_the_scroll', node_kind: 'hook', position: 0 },
      { object_id: 'art_1', node_id: 'n2', strategy: null, intent: 'build_credibility', node_kind: 'body', position: 1 },
      { object_id: 'art_1', node_id: 'n3', strategy: null, intent: null, node_kind: 'body', position: 2 },
    ]);
  });

  it('keeps position as the array index even where a node is skipped', () => {
    // Matching scripts/tracking-dims-push.mjs exactly. Position is the node's
    // place in the article, not its place among the rows — renumbering would
    // silently change what "position" means for every row already in the sink.
    const rows = nodeStrategyRowsFromBody('art_1', { nodes: [{ kind: 'x' }, { id: 'n2', kind: 'y' }] });
    assert.deepEqual(rows.map((row) => [row.node_id, row.position]), [['n2', 1]]);
  });

  it('returns nothing for a body that is not an article', () => {
    assert.deepEqual(nodeStrategyRowsFromBody('x', null), []);
    assert.deepEqual(nodeStrategyRowsFromBody('x', { nodes: 'no' }), []);
    assert.deepEqual(nodeStrategyRowsFromBody('x', {}), []);
  });
});

describe('pushNodeStrategyDims', () => {
  it('posts only the node_strategy family, to /dims, with the bearer in the header', async () => {
    let seenUrl = '';
    let seenAuth: string | null = null;
    let seenBody: Record<string, unknown> = {};
    const result = await pushNodeStrategyDims({
      objectType: 'content_item',
      objectId: 'art_1',
      body: article,
      env: ENV,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenAuth = (init.headers as Record<string, string>).authorization ?? null;
        seenBody = JSON.parse(init.body as string);
        return okResponse;
      }) as unknown as typeof fetch,
    });
    assert.equal(seenUrl, 'https://sink.example.com/api/tracking-sink/dims');
    assert.equal(seenAuth, 'Bearer sekrit-token');
    assert.equal(seenBody.project_id, 'drlurie');
    // object_version and producer stay with the postbuild script, which reads
    // the export — the only family that had to move is this one.
    assert.deepEqual(Object.keys(seenBody).sort(), ['node_strategy', 'project_id']);
    assert.equal(result.ok, true);
    assert.equal(result.rows, 3);
    assert.equal(result.labelled, 2);
  });

  it('never sends the token in the body, and never returns a label', async () => {
    const result = await pushNodeStrategyDims({
      objectType: 'content_item',
      objectId: 'art_1',
      body: article,
      env: ENV,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        assert.ok(!(init.body as string).includes(ENV.TRACKING_SINK_TOKEN));
        return okResponse;
      }) as unknown as typeof fetch,
    });
    assert.ok(!JSON.stringify(result).includes('curiosity_gap'));
    assert.ok(!JSON.stringify(result).includes(ENV.TRACKING_SINK_TOKEN));
  });

  it('skips a non-article without calling the sink', async () => {
    const result = await pushNodeStrategyDims({
      objectType: 'page',
      objectId: 'page_1',
      body: article,
      env: ENV,
      fetchImpl: (() => assert.fail('a page must not reach the sink')) as unknown as typeof fetch,
    });
    assert.deepEqual(result, { ok: true, skipped: 'not_an_article', rows: 0, labelled: 0 });
  });

  it('reports missing configuration as ok-and-skipped, not as a failure', async () => {
    // A tenant whose sink is not wired yet must not see publish log a failure.
    const result = await pushNodeStrategyDims({
      objectType: 'content_item',
      objectId: 'art_1',
      body: article,
      env: { TRACKING_SINK_URL: 'https://sink.example.com' },
      fetchImpl: (() => assert.fail('must not call an unconfigured sink')) as unknown as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 'missing_configuration');
    assert.equal(result.rows, 3);
  });

  it('never throws when the sink is unreachable', async () => {
    const result = await pushNodeStrategyDims({
      objectType: 'content_item',
      objectId: 'art_1',
      body: article,
      env: ENV,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'ECONNREFUSED');
    assert.equal(result.rows, 3);
  });

  it('reports a non-2xx without throwing', async () => {
    const result = await pushNodeStrategyDims({
      objectType: 'content_item',
      objectId: 'art_1',
      body: article,
      env: ENV,
      fetchImpl: (async () => ({ ok: false, status: 401 }) as unknown as Response) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });
});

describe('describeDimsPush', () => {
  it('says counts and never a label', () => {
    const line = describeDimsPush('art_1', { ok: true, rows: 3, labelled: 2 });
    assert.match(line, /3 node_strategy row\(s\), 2 labelled/);
    assert.ok(!line.includes('curiosity_gap'));
  });
});
