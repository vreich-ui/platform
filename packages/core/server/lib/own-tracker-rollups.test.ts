import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { armMetricsMissingEnvVars, fetchOwnTrackerRollups, fetchOwnTrackerWeights } from './own-tracker-rollups.js';

const ENV = {
  TRACKING_SINK_URL: 'https://sink.example.com',
  TRACKING_PROJECT_ID: 'proj_1',
  TRACKING_SINK_TOKEN: 'sekrit-token',
};

const jsonResponse = (body: unknown, init: { ok?: boolean; status?: number } = {}) => ({
  ok: init.ok ?? true,
  status: init.status ?? 200,
  json: async () => body,
});

describe('armMetricsMissingEnvVars', () => {
  it('names the missing var(s), never a value', () => {
    assert.deepEqual(armMetricsMissingEnvVars({}), ['TRACKING_SINK_URL', 'TRACKING_PROJECT_ID']);
    assert.deepEqual(armMetricsMissingEnvVars({ TRACKING_SINK_URL: 'https://x' }), ['TRACKING_PROJECT_ID']);
    assert.deepEqual(armMetricsMissingEnvVars(ENV), []);
  });
});

describe('fetchOwnTrackerRollups', () => {
  it('calls /rollups?by=object with the project id and a Bearer header, and never returns the token', async () => {
    let seenUrl = '';
    let seenAuth: string | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>).Authorization;
      return jsonResponse({
        rows: [
          {
            object_id: 'a',
            exposures: 10,
            sessions: 8,
            completion_rate: 0.5,
            cta_click_rate: 0.1,
            purchase_rate: 0.05,
            revenue: 12.5,
          },
        ],
      });
    }) as unknown as typeof fetch;

    const rows = await fetchOwnTrackerRollups({ env: ENV, fetchImpl });

    assert.match(seenUrl, /\/rollups\?by=object&project_id=proj_1$/);
    assert.equal(seenAuth, `Bearer ${ENV.TRACKING_SINK_TOKEN}`);
    assert.deepEqual(rows, [
      {
        object_id: 'a',
        exposures: 10,
        sessions: 8,
        completion_rate: 0.5,
        cta_click_rate: 0.1,
        purchase_rate: 0.05,
        revenue: 12.5,
      },
    ]);
    // The Bearer token must never appear anywhere in the returned, client-bound payload.
    assert.ok(!JSON.stringify(rows).includes(ENV.TRACKING_SINK_TOKEN));
  });

  it('degrades a malformed row to zeros rather than throwing on shape', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ rows: [{ object_id: 'a' }, { not_an_object_id: 1 }] })) as unknown as typeof fetch;
    const rows = await fetchOwnTrackerRollups({ env: ENV, fetchImpl });
    assert.deepEqual(rows, [
      {
        object_id: 'a',
        exposures: 0,
        sessions: 0,
        completion_rate: 0,
        cta_click_rate: 0,
        purchase_rate: 0,
        revenue: 0,
      },
    ]);
  });

  it('accepts a bare array body too, not only {rows: [...]}', async () => {
    const fetchImpl = (async () => jsonResponse([{ object_id: 'a', sessions: 5 }])) as unknown as typeof fetch;
    const rows = await fetchOwnTrackerRollups({ env: ENV, fetchImpl });
    assert.equal(rows[0]?.object_id, 'a');
    assert.equal(rows[0]?.sessions, 5);
  });

  it('throws when the sink is unconfigured', async () => {
    await assert.rejects(() => fetchOwnTrackerRollups({ env: {} }));
  });

  it('throws on a non-2xx — the caller treats this as a real failure, not a silent empty page', async () => {
    const fetchImpl = (async () => jsonResponse({}, { ok: false, status: 503 })) as unknown as typeof fetch;
    await assert.rejects(() => fetchOwnTrackerRollups({ env: ENV, fetchImpl }), /HTTP 503/);
  });
});

describe('fetchOwnTrackerWeights', () => {
  it('sends the Bearer header and never returns it in the resolved map', async () => {
    let seenAuth: string | undefined;
    let seenUrl = '';
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>).Authorization;
      return jsonResponse({ parent: { parent: 70, child: 30 } });
    }) as unknown as typeof fetch;

    const weights = await fetchOwnTrackerWeights({ env: ENV, fetchImpl });

    assert.match(seenUrl, /\/weights\?project_id=proj_1$/);
    assert.equal(seenAuth, `Bearer ${ENV.TRACKING_SINK_TOKEN}`);
    assert.deepEqual(weights, { parent: { parent: 70, child: 30 } });
    assert.ok(!JSON.stringify(weights).includes(ENV.TRACKING_SINK_TOKEN));
  });

  it('unwraps a {weights: {...}} envelope the same as a bare row map', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ weights: { parent: { parent: 50, child: 50 } } })) as unknown as typeof fetch;
    const weights = await fetchOwnTrackerWeights({ env: ENV, fetchImpl });
    assert.deepEqual(weights, { parent: { parent: 50, child: 50 } });
  });

  it('never throws — degrades to {} on missing config, a non-2xx, or a network failure', async () => {
    assert.deepEqual(await fetchOwnTrackerWeights({ env: {} }), {});

    const failing = (async () => jsonResponse({}, { ok: false, status: 500 })) as unknown as typeof fetch;
    assert.deepEqual(await fetchOwnTrackerWeights({ env: ENV, fetchImpl: failing }), {});

    const throwing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchOwnTrackerWeights({ env: ENV, fetchImpl: throwing }), {});
  });

  it('degrades to {} on a malformed body (array, string, null)', async () => {
    const arrayBody = (async () => jsonResponse([1, 2, 3])) as unknown as typeof fetch;
    assert.deepEqual(await fetchOwnTrackerWeights({ env: ENV, fetchImpl: arrayBody }), {});
  });
});
