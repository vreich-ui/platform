import assert from 'node:assert/strict';
import test from 'node:test';

import {
  funnelStageRows,
  nodeReadDepthRows,
  objectSourceRows,
  resolveObjectDrilldownPanel,
  variantDisplayRows,
  type ObjectDrilldownInput,
} from './analytics-object-drilldown-logic.js';
import type { OwnTrackerObjectDetail } from './own-analytics-logic.js';

function fixtureObjectDetail(): OwnTrackerObjectDetail {
  return {
    object_id: 'article_1',
    object_type: 'content_item',
    pageviews: 200,
    sessions: 150,
    completion_rate: 0.4,
    funnel: { pageview: 200, read_progress: 120, completion: 80, cta_click: 20, buy_click: 5 },
    nodes: [
      {
        node_id: 'n2',
        strategy: 'agitation',
        intent: 'build-tension',
        position: 2,
        impressions: 90,
        sessions: 80,
        dwell_ms_avg: 4000,
      },
      {
        node_id: 'n1',
        strategy: 'hook',
        intent: 'attention-grab',
        position: 1,
        impressions: 180,
        sessions: 150,
        dwell_ms_avg: 2000,
      },
    ],
    variants: [
      { object_id: 'article_1_v2', version: 2, route: '/skincare-basics-v2', published_at: '2026-08-10T00:00:00.000Z' },
      {
        object_id: 'article_1',
        version: 1,
        route: '/skincare-basics',
        published_at: '2026-07-01T00:00:00.000Z',
        metrics: { pageviews: 150, sessions: 110, completion_rate: 0.35 },
      },
    ],
  };
}

// ─── funnel ──────────────────────────────────────────────────────────────────

test('funnelStageRows computes rate-of-entry against the pageview stage, in fixed funnel order', () => {
  const rows = funnelStageRows(fixtureObjectDetail().funnel);
  assert.deepEqual(
    rows.map((r) => r.stage),
    ['pageview', 'read_progress', 'completion', 'cta_click', 'buy_click']
  );
  assert.equal(rows[1]!.rateOfEntry, '60%');
  assert.equal(rows[4]!.rateOfEntry, '3%');
});

test('funnelStageRows returns an empty list (not zeroed rows) when the funnel is absent', () => {
  assert.deepEqual(funnelStageRows(undefined), []);
});

test('funnelStageRows renders "—" when there are zero pageviews to divide by', () => {
  const rows = funnelStageRows({ pageview: 0, read_progress: 0, completion: 0, cta_click: 0, buy_click: 0 });
  assert.ok(rows.every((r) => r.rateOfEntry === '—'));
});

// ─── nodes ───────────────────────────────────────────────────────────────────

test('nodeReadDepthRows sorts by document position, not by traffic', () => {
  const rows = nodeReadDepthRows(fixtureObjectDetail().nodes);
  assert.deepEqual(
    rows.map((r) => r.label),
    ['hook', 'agitation']
  );
  assert.equal(rows[0]!.share, 1, 'the highest-impression node fills the bar');
  assert.equal(rows[1]!.sublabel, 'build-tension · 4s avg dwell');
});

test('nodeReadDepthRows is empty for an absent node list', () => {
  assert.deepEqual(nodeReadDepthRows(undefined), []);
});

// ─── sources ─────────────────────────────────────────────────────────────────

test('objectSourceRows normalizes a blank referrer to "Direct" and shares against the top row', () => {
  const rows = objectSourceRows([
    { referrer_host_or_utm_source: '', sessions: 10 },
    { referrer_host_or_utm_source: 'google.com', sessions: 40 },
  ]);
  assert.equal(rows[1]!.label, 'google.com');
  assert.equal(rows[1]!.share, 1);
  assert.equal(rows[0]!.label, 'Direct');
  assert.equal(rows[0]!.share, 0.25);
});

// ─── variants ────────────────────────────────────────────────────────────────

test('variantDisplayRows sorts ascending by version and carries per-variant metrics only when the sink provided them', () => {
  const rows = variantDisplayRows(fixtureObjectDetail().variants);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.version, 1);
  assert.equal(rows[0]!.pageviews, 150);
  assert.equal(rows[1]!.version, 2);
  assert.equal(
    rows[1]!.pageviews,
    undefined,
    'no fabricated metric for a variant the sink did not attribute traffic to'
  );
});

// ─── the full panel ──────────────────────────────────────────────────────────

test('resolveObjectDrilldownPanel renders from a fixture object block', () => {
  const input: ObjectDrilldownInput = {
    loading: false,
    error: null,
    identity: {
      objectId: 'article_1',
      found: true,
      title: 'Skincare Basics',
      route: '/skincare-basics',
      objectType: 'content_item',
    },
    producer: { surface: 'plugin:claude', promptVersion: 'v3' },
    objectDetail: fixtureObjectDetail(),
    sourceRows: [{ referrer_host_or_utm_source: 'google.com', sessions: 40 }],
  };
  const panel = resolveObjectDrilldownPanel(input);
  assert.equal(panel.status, 'ready');
  assert.equal(panel.sinkObjectAbsent, false);
  assert.equal(panel.kpis.find((k) => k.id === 'pageviews')?.value, '200');
  assert.equal(panel.kpis.find((k) => k.id === 'completion_rate')?.value, '40%');
  assert.equal(panel.funnel.length, 5);
  assert.equal(panel.nodeRows.length, 2);
  assert.equal(panel.variants.length, 2);
  assert.equal(panel.identity?.title, 'Skincare Basics');
  assert.equal(panel.producer?.promptVersion, 'v3');
});

test('resolveObjectDrilldownPanel names the sink-absent state distinctly from a real zero', () => {
  const withoutSink = resolveObjectDrilldownPanel({ loading: false, error: null, objectDetail: null });
  assert.equal(withoutSink.sinkObjectAbsent, true);
  assert.deepEqual(withoutSink.kpis, []);
  assert.deepEqual(withoutSink.funnel, []);

  const realZero = resolveObjectDrilldownPanel({
    loading: false,
    error: null,
    objectDetail: {
      object_id: 'article_2',
      object_type: 'content_item',
      pageviews: 0,
      sessions: 0,
      completion_rate: 0,
      funnel: { pageview: 0, read_progress: 0, completion: 0, cta_click: 0, buy_click: 0 },
      nodes: [],
      variants: [],
    },
  });
  assert.equal(realZero.sinkObjectAbsent, false, 'the sink answered — zero traffic is a real, computed value');
  assert.equal(realZero.kpis.find((k) => k.id === 'pageviews')?.value, '0');
});

test('resolveObjectDrilldownPanel surfaces loading/error states with no fabricated data', () => {
  assert.equal(resolveObjectDrilldownPanel({ loading: true, error: null }).status, 'loading');
  const errored = resolveObjectDrilldownPanel({ loading: false, error: 'boom' });
  assert.equal(errored.status, 'error');
  assert.equal(errored.error, 'boom');
});
