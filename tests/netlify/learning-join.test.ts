import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { materialize } from '../../packages/core/server/lib/materialize.js';
import { surfaceSplit, WORKFLOW_SURFACE } from '../../packages/core/lib/admin/own-traffic-logic.js';
import { dimensionRowsForExport } from '../../scripts/tracking-dims-push.mjs';
import { publishReceiptSchema } from '../../packages/core/schema/object-record-v1.js';

/**
 * W7.4 acceptance — the learning join.
 *
 * The question the whole plugin programme has to be able to answer: **do
 * plugin-written articles perform differently from workflow-written ones?**
 *
 * It is unanswerable unless the surface is recorded at PUBLISH, on the revision
 * that went live, and then survives into the two places anything downstream
 * reads: the record's publish receipt (what the admin joins on) and the
 * committed export's `__generated` marker (what the owner DB ingests). A
 * dimension that exists in only one of those is a dimension half the system
 * cannot group by.
 *
 * The provenance comes from the AUTH-derived actor, never from a tool argument
 * — `caller-actor.ts` exists because a live run passed `agent_name` once and
 * dropped it for the following sixteen calls. A learning signal built on a
 * field a model may forget is a signal that silently stops being true.
 */
const articleBody = {
  slug: 'learning-join-fixture',
  title: 'A fixture article',
  deck: 'Short but real.',
  description: 'A fixture used to pin the learning join.',
  author: 'Dr. Lurie',
  taxonomy: { category: 'skin-health', tags: ['skincare-basics'] },
  seo: { meta_description: 'A fixture used to pin the learning join.' },
  nodes: [
    {
      id: 'n_01',
      kind: 'content' as const,
      public: { body: '<p>One calm paragraph of body copy for the fixture.</p>' },
      private: { strategy: 'explanation', intent: 'educate' },
    },
  ],
};

// ─── the export marker ───────────────────────────────────────────────────────

test('the committed export carries the publishing surface and how it was established', () => {
  const file = materialize('content_item', 'req_learning_join_20260904_01', articleBody, {
    at: '2026-09-04T12:00:00.000Z',
    record_version: 3,
    exportRoot: 'sites/drlurie/data/site',
    producer: {
      run_id: 'run_1',
      node_id: 'plugin:openai-gpt',
      prompt_version: 'dr-lurie-openai-20260904-abcd1234',
      model: 'gpt-5',
    },
    surface: 'plugin:openai-gpt',
    attribution: 'oauth',
  });
  const parsed = JSON.parse(file.content) as { __generated: Record<string, unknown> };
  assert.equal(parsed.__generated.surface, 'plugin:openai-gpt');
  assert.equal(parsed.__generated.attribution, 'oauth');
  assert.equal(
    (parsed.__generated.producer as { prompt_version: string }).prompt_version,
    'dr-lurie-openai-20260904-abcd1234'
  );
});

test('an export with no surface omits the keys rather than writing nulls', () => {
  const file = materialize('content_item', 'req_learning_join_20260904_02', articleBody, {
    at: '2026-09-04T12:00:00.000Z',
    record_version: 1,
    exportRoot: 'sites/drlurie/data/site',
  });
  const parsed = JSON.parse(file.content) as { __generated: Record<string, unknown> };
  // Determinism: the marker must be byte-stable for identical inputs, and a
  // `"surface": null` would be a new byte in every workflow-published export.
  assert.ok(!('surface' in parsed.__generated));
  assert.ok(!('attribution' in parsed.__generated));
});

// ─── the dims payload ────────────────────────────────────────────────────────

test('the tracking sink receives object_id, surface and the prompt version', () => {
  const exportJson = JSON.parse(
    materialize('content_item', 'req_learning_join_20260904_03', articleBody, {
      at: '2026-09-04T12:00:00.000Z',
      record_version: 7,
      exportRoot: 'sites/drlurie/data/site',
      producer: { run_id: 'r', node_id: 'plugin:claude', prompt_version: 'pv_42', model: 'claude' },
      surface: 'plugin:claude',
      attribution: 'oauth',
    }).content
  ) as unknown;

  const rows = dimensionRowsForExport(exportJson, 'content_item') as {
    object_version: Array<Record<string, unknown>>;
    producer: Array<Record<string, unknown>>;
  };

  const objectVersion = rows.object_version[0];
  assert.equal(objectVersion.object_id, 'req_learning_join_20260904_03');
  assert.equal(objectVersion.surface, 'plugin:claude');
  assert.equal(objectVersion.attribution, 'oauth');
  // prompt_version already rode on the producer family; the join needs both.
  assert.equal(rows.producer[0].prompt_version, 'pv_42');
  assert.equal(rows.producer[0].object_id, 'req_learning_join_20260904_03');
});

test('a workflow-published export sends null, not a missing column', () => {
  const exportJson = JSON.parse(
    materialize('content_item', 'req_learning_join_20260904_04', articleBody, {
      at: '2026-09-04T12:00:00.000Z',
      record_version: 2,
      exportRoot: 'sites/drlurie/data/site',
    }).content
  ) as unknown;
  const rows = dimensionRowsForExport(exportJson, 'content_item') as {
    object_version: Array<Record<string, unknown>>;
  };
  assert.equal(rows.object_version[0].surface, null);
  assert.equal(rows.object_version[0].attribution, null);
});

// ─── the receipt ─────────────────────────────────────────────────────────────

test('the publish receipt schema accepts the provenance, and still accepts older receipts', () => {
  const base = {
    kind: 'object_export_commit' as const,
    branch: 'main',
    commit_sha: 'a'.repeat(40),
    tree_sha: 'b'.repeat(40),
    no_op: false,
    attempts: 1,
    files: ['sites/drlurie/data/site/articles/x.json'],
    content_revision: 4,
    exported_at: '2026-09-04T12:00:00.000Z',
  };
  const withProvenance = publishReceiptSchema.parse({
    ...base,
    surface: 'plugin:openai-agent',
    attribution: 'oauth',
    prompt_version: 'pv_9',
  });
  assert.equal(withProvenance.surface, 'plugin:openai-agent');
  // A receipt written before W7.4 must still parse — they are on live records.
  assert.equal(publishReceiptSchema.parse(base).surface, undefined);
});

// ─── the split /admin/traffic renders ────────────────────────────────────────

test('engagement splits by publishing surface', () => {
  const stats = {
    top_objects: [
      { object_id: 'req_plugin_a', pageviews: 300, sessions: 0 },
      { object_id: 'req_plugin_b', pageviews: 100, sessions: 0 },
      { object_id: 'req_workflow_a', pageviews: 500, sessions: 0 },
      { object_id: 'req_never_read', pageviews: 50, sessions: 0 },
    ],
  } as never;

  const split = surfaceSplit(stats, {
    req_plugin_a: 'plugin:openai-gpt',
    req_plugin_b: 'plugin:openai-gpt',
    // Present in the map with a null surface: the record exists and the
    // autonomous path published it.
    req_workflow_a: null,
  });

  assert.deepEqual(split, [
    { surface: WORKFLOW_SURFACE, objects: 1, pageviews: 500 },
    { surface: 'plugin:openai-gpt', objects: 2, pageviews: 400 },
    { surface: 'unknown', objects: 1, pageviews: 50 },
  ]);
});

test('"we could not read it" is never folded into "the workflow published it"', () => {
  /**
   * The two are different facts, and merging them would quietly overstate the
   * workflow's share for every article published before the surface was
   * stamped — which is most of the corpus on the day this ships.
   */
  const stats = { top_objects: [{ object_id: 'unreadable', pageviews: 10 }] } as never;
  assert.deepEqual(surfaceSplit(stats, {}), [{ surface: 'unknown', objects: 1, pageviews: 10 }]);
  assert.deepEqual(surfaceSplit(stats, { unreadable: null }), [
    { surface: WORKFLOW_SURFACE, objects: 1, pageviews: 10 },
  ]);
});
