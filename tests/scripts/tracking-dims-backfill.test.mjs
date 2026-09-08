import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  collectPublishedArticles,
  nodeStrategyRowsFromRecord,
  parseArgs,
  pushRows,
  runBackfill,
  summarise,
} from '../../scripts/tracking-dims-backfill.mjs';
import { dimensionRowsForExport } from '../../scripts/tracking-dims-push.mjs';

// THE FIXTURE IS THE PIN. This article is byte-identical to the one in
// packages/core/server/lib/tracking-dims-publish.test.ts, and the expected rows
// below are the same rows that test asserts. There are three implementations of
// this one projection — the publish path (TypeScript), the postbuild push, and
// this backfill — because scripts here have no TypeScript runner. Changing one
// without the others breaks this.
const ARTICLE = {
  slug: 'how-retinoids-work',
  nodes: [
    { id: 'n1', kind: 'hook', private: { strategy: 'curiosity_gap', intent: 'stop_the_scroll' } },
    { id: 'n2', kind: 'body', private: { intent: 'build_credibility' } },
    { id: 'n3', kind: 'body' },
    { kind: 'body', private: { strategy: 'orphan' } },
    'not a node',
  ],
};

const EXPECTED_ROWS = [
  { object_id: 'art_1', node_id: 'n1', strategy: 'curiosity_gap', intent: 'stop_the_scroll', node_kind: 'hook', position: 0 },
  { object_id: 'art_1', node_id: 'n2', strategy: null, intent: 'build_credibility', node_kind: 'body', position: 1 },
  { object_id: 'art_1', node_id: 'n3', strategy: null, intent: null, node_kind: 'body', position: 2 },
];

const ENV = {
  TRACKING_SINK_URL: 'https://sink.example.com/api/tracking-sink',
  TRACKING_SINK_TOKEN: 'sekrit-token',
  TRACKING_PROJECT_ID: 'drlurie',
};

/** A tenant MCP surface with two published articles and one never published. */
const toolFor = (calls = []) => async (name, args) => {
  calls.push([name, args]);
  if (name === 'object_list') {
    return {
      isError: false,
      data: {
        objects: [
          { object_id: 'art_1', status: 'active', published_time: '2026-09-01T00:00:00.000Z' },
          { object_id: 'art_2', status: 'active', published_time: '2026-09-05T00:00:00.000Z' },
          { object_id: 'art_draft', status: 'active', published_time: null },
        ],
      },
    };
  }
  if (name === 'object_get') {
    if (args.object_id === 'art_1') return { isError: false, data: { record: { body: ARTICLE } } };
    // art_2 was published after the strip: no labels anywhere in the store either.
    return { isError: false, data: { record: { body: { nodes: [{ id: 'a', kind: 'body' }] } } } };
  }
  return { isError: true, data: { error: `unexpected tool ${name}` } };
};

describe('nodeStrategyRowsFromRecord', () => {
  it('projects exactly what the publish path projects', () => {
    assert.deepEqual(nodeStrategyRowsFromRecord('art_1', ARTICLE), EXPECTED_ROWS);
  });

  it('is empty for a body with no nodes', () => {
    assert.deepEqual(nodeStrategyRowsFromRecord('x', { nodes: 'no' }), []);
    assert.deepEqual(nodeStrategyRowsFromRecord('x', null), []);
  });
});

describe('the three projections are one projection', () => {
  it('projects identically to the postbuild script node_strategy branch — the pin, not a promise', () => {
    // Three implementations of one projection exist (the publish path in
    // TypeScript, the postbuild push, and this). Nothing but this assertion stops
    // them drifting: renumber `position` in one of them and every OTHER test in
    // this repository still passes, while the sink's COALESCE upsert quietly
    // overwrites correct positions with wrong ones.
    const viaExport = dimensionRowsForExport(
      {
        __generated: { from: 'objects/content_item/by-id/art_1.json', at: '2026-09-08T00:00:00.000Z', record_version: 1 },
        ...ARTICLE,
      },
      'content_item'
    ).node_strategy;
    // Given the SAME input the two must agree exactly — `position` most of all.
    // (In production they see different inputs: the postbuild script reads the
    // stripped export and gets null labels, which is the bug this wave routes
    // around. That difference is a property of the INPUT, not of the projection,
    // and `materializers/shared.test.ts` is what pins it.)
    assert.deepEqual(viaExport, nodeStrategyRowsFromRecord('art_1', ARTICLE));
  });
});

describe('collectPublishedArticles', () => {
  it('reads the full body via projection "nodes" and skips the unpublished', async () => {
    const calls = [];
    const result = await collectPublishedArticles({ tool: toolFor(calls), log: () => {} });
    assert.equal(result.published, 2);
    assert.deepEqual(result.perArticle.map((entry) => entry.objectId), ['art_1', 'art_2']);
    // The projection matters: `full` drags the whole history ledger, which for a
    // live article can outweigh the article. `summary` would strip the very
    // fields this backfill exists to read.
    const gets = calls.filter(([name]) => name === 'object_get');
    assert.equal(gets.length, 2);
    for (const [, args] of gets) assert.equal(args.projection, 'nodes');
  });

  it('skips one article that fails to read rather than abandoning the run', async () => {
    const flaky = async (name, args) => {
      if (name === 'object_list') return toolFor()(name, args);
      if (args.object_id === 'art_1') return { isError: true, data: { error: 'boom' } };
      return { isError: false, data: { record: { body: ARTICLE } } };
    };
    const result = await collectPublishedArticles({ tool: flaky, log: () => {} });
    assert.deepEqual(result.perArticle.map((entry) => entry.objectId), ['art_2']);
  });
});

describe('summarise', () => {
  it('counts rows and labels, and names articles carrying no label at all', () => {
    const counts = summarise([
      { objectId: 'art_1', rows: EXPECTED_ROWS },
      { objectId: 'art_2', rows: [{ object_id: 'art_2', node_id: 'a', strategy: null, intent: null, node_kind: 'body', position: 0 }] },
    ]);
    assert.deepEqual(counts, { articles: 2, rows: 4, labelled: 2, articlesWithNoLabels: 1 });
  });
});

describe('runBackfill', () => {
  it('DRY RUN by default: reads everything, sends nothing', async () => {
    const lines = [];
    const result = await runBackfill({
      tool: toolFor(),
      env: ENV,
      fetchImpl: () => assert.fail('a dry run must not POST'),
      log: (line) => lines.push(line),
    });
    assert.equal(result.applied, false);
    assert.equal(result.rows, 4);
    assert.equal(result.labelled, 2);
    assert.ok(lines.some((line) => line.includes('DRY RUN')));
  });

  it('--apply POSTs one node_strategy payload, with the bearer in the header', async () => {
    let seenUrl = '';
    let seenBody = {};
    let seenAuth = null;
    const result = await runBackfill({
      tool: toolFor(),
      apply: true,
      env: ENV,
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenAuth = init.headers.authorization;
        seenBody = JSON.parse(init.body);
        return { ok: true, status: 200 };
      },
      log: () => {},
    });
    assert.equal(seenUrl, 'https://sink.example.com/api/tracking-sink/dims');
    assert.equal(seenAuth, 'Bearer sekrit-token');
    assert.deepEqual(Object.keys(seenBody).sort(), ['node_strategy', 'project_id']);
    assert.equal(seenBody.node_strategy.length, 4);
    assert.equal(result.applied, true);
    assert.equal(result.failed, false);
  });

  it('REFUSES to apply, rather than pushing nulls, when the store has no labels either', async () => {
    // Re-pushing nulls is a no-op the sink COALESCEs away — it would look like a
    // successful backfill and change nothing. That is a different fault and it
    // needs to be seen, not absorbed.
    const unlabelled = async (name) => {
      if (name === 'object_list') return { isError: false, data: { objects: [{ object_id: 'a', published_time: 'x' }] } };
      return { isError: false, data: { record: { body: { nodes: [{ id: 'n', kind: 'body' }] } } } };
    };
    const lines = [];
    // WITH --apply, which is the case that matters: a dry run would not POST
    // anyway, so testing this without it would pass on the wrong branch.
    const result = await runBackfill({
      tool: unlabelled,
      apply: true,
      env: ENV,
      fetchImpl: () => assert.fail('a null-only corpus must never be POSTed'),
      log: (l) => lines.push(l),
    });
    assert.ok(lines.some((line) => line.includes('no article carries a label in the store')));
    assert.equal(result.applied, false);
    assert.equal(result.failed, true);
  });

  it('never puts a token or a label in its own output', async () => {
    const lines = [];
    await runBackfill({ tool: toolFor(), env: ENV, fetchImpl: () => assert.fail('no POST'), log: (l) => lines.push(l) });
    const output = lines.join('\n');
    assert.ok(!output.includes(ENV.TRACKING_SINK_TOKEN));
    assert.ok(!output.includes('curiosity_gap'));
  });
});

describe('pushRows', () => {
  it('refuses without configuration rather than POSTing nowhere', async () => {
    assert.deepEqual(await pushRows({ rows: EXPECTED_ROWS, env: {}, fetchImpl: () => assert.fail('no POST') }), {
      ok: false,
      skipped: 'missing_configuration',
    });
  });
});

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    assert.deepEqual(parseArgs(['--site', 'drlurie', '--endpoint', 'https://x/mcp']), {
      slug: 'drlurie',
      endpoint: 'https://x/mcp',
      apply: false,
    });
    assert.equal(parseArgs(['--apply']).apply, true);
  });
});
