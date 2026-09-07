// Same convention as `mcp-analytics-handlers.test.ts`: `getSiteIdentity()`
// (called by `fetchAnalyticsInsights` below to source `cmsAgentProjectId`)
// throws unless the site's config provider is registered first — import the
// site's policy bindings before anything that resolves site identity.
import '../../../../sites/drlurie/config/policy-bindings.js';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractArray,
  parseWindowFromNote,
  readEvidence,
  normalizeOutcomeRow,
  itemEvidenceSources,
  normalizePlaybookItem,
  isOpenProposalStatus,
  normalizeProposalRow,
  observationSource,
  normalizeStrategyObservation,
  fetchAnalyticsInsights,
  type AnalyticsInsightsCmsAgentClient,
} from './analytics-insights.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import type { CmsAgentErrorCode } from './agent/cms-agent-client.js';

// ─── extractArray ───────────────────────────────────────────────────────────

test('extractArray: a bare array passes through', () => {
  assert.deepEqual(extractArray([1, 2, 3], ['records']), [1, 2, 3]);
});

test('extractArray: finds the first matching wrapper key', () => {
  assert.deepEqual(extractArray({ items: [], records: [1] }, ['records', 'items']), [1]);
});

test('extractArray: no matching key or non-array degrades to empty, never throws', () => {
  assert.deepEqual(extractArray({ nope: [1] }, ['records']), []);
  assert.deepEqual(extractArray(null, ['records']), []);
  assert.deepEqual(extractArray('a string', ['records']), []);
});

// ─── parseWindowFromNote ────────────────────────────────────────────────────

test('parseWindowFromNote: the live feedback_list grammar', () => {
  assert.deepEqual(parseWindowFromNote('window 2026-08-22..2026-09-05'), {
    start: '2026-08-22',
    end: '2026-09-05',
  });
});

test('parseWindowFromNote: text with no window mention, or no note at all, is null', () => {
  assert.equal(parseWindowFromNote('planning-chat live proof after R9'), null);
  assert.equal(parseWindowFromNote(undefined), null);
});

// ─── readEvidence ───────────────────────────────────────────────────────────

test('readEvidence: prefers structured window fields over a note', () => {
  const evidence = readEvidence({ window_start: '2026-01-01', window_end: '2026-01-08', n: 40 }, 'window 2099-01-01..2099-01-02');
  assert.equal(evidence.windowStart, '2026-01-01');
  assert.equal(evidence.windowEnd, '2026-01-08');
  assert.equal(evidence.n, 40);
});

test('readEvidence: falls back to parsing the note when no structured window is present', () => {
  const evidence = readEvidence({}, 'window 2026-08-22..2026-09-05');
  assert.equal(evidence.windowStart, '2026-08-22');
  assert.equal(evidence.windowEnd, '2026-09-05');
});

test('readEvidence: nothing usable degrades to nulls, not a throw', () => {
  assert.deepEqual(readEvidence({}), { windowStart: null, windowEnd: null, n: null });
});

// ─── normalizeOutcomeRow — against the REAL feedback_list shape (verified live, 2026-09-05) ──

const LIVE_OUTCOME_FIXTURE = {
  feedbackId: 'fb_1788604170688_ps82bq',
  kind: 'outcome',
  nodeId: 'plugin:claude',
  runId: 'plugin_claude_req_plugin_dark_circles_20260904_01',
  outcome: {
    source: 'tracking:engagement.v1',
    metrics: {
      pageviews: 0,
      exposures: 0,
      sessions: 2,
      completion_rate: 1,
      cta_ctr: 0,
      purchase_rate: 0,
      revenue_cents: 0,
      p75_dwell_ms: 2063,
    },
  },
  actor: { kind: 'human', id: 'wolf', label: 'planning-chat live proof after R9' },
  note: 'window 2026-08-22..2026-09-05',
  createdAt: '2026-09-05T10:29:30.688Z',
};

test('normalizeOutcomeRow: the live wire shape round-trips fully, including the note-parsed window and sessions-as-n', () => {
  const row = normalizeOutcomeRow(LIVE_OUTCOME_FIXTURE);
  assert.deepEqual(row, {
    id: 'fb_1788604170688_ps82bq',
    producer: 'plugin:claude',
    runId: 'plugin_claude_req_plugin_dark_circles_20260904_01',
    createdAt: '2026-09-05T10:29:30.688Z',
    metrics: {
      pageviews: 0,
      exposures: 0,
      sessions: 2,
      completion_rate: 1,
      cta_ctr: 0,
      purchase_rate: 0,
      revenue_cents: 0,
      p75_dwell_ms: 2063,
    },
    evidence: { windowStart: '2026-08-22', windowEnd: '2026-09-05', n: 2 },
  });
});

test('normalizeOutcomeRow: a feedback record whose outcome is not tracking:engagement.v1 is excluded (e.g. a monetizer outcome)', () => {
  const row = normalizeOutcomeRow({ ...LIVE_OUTCOME_FIXTURE, outcome: { source: 'monetizer.v1', metrics: {} } });
  assert.equal(row, null);
});

test('normalizeOutcomeRow: a non-outcome record (approve/reject/edit) or garbage input is excluded, never throws', () => {
  assert.equal(normalizeOutcomeRow({ kind: 'approve' }), null);
  assert.equal(normalizeOutcomeRow(null), null);
  assert.equal(normalizeOutcomeRow('a string'), null);
  assert.equal(normalizeOutcomeRow([]), null);
});

test('normalizeOutcomeRow: a record with no id is excluded', () => {
  assert.equal(normalizeOutcomeRow({ outcome: { source: 'tracking:engagement.v1' } }), null);
});

// ─── playbook items ─────────────────────────────────────────────────────────

test('itemEvidenceSources: collects a top-level source, an evidence[] array, and a provenance field', () => {
  assert.deepEqual(
    itemEvidenceSources({
      source: 'eval',
      evidence: [{ source: 'tracking' }, 'ui'],
      provenance: { source: 'tracking' },
    }).sort(),
    ['eval', 'tracking', 'ui'].sort()
  );
});

test('itemEvidenceSources: no evidence fields at all is an empty list, not a throw', () => {
  assert.deepEqual(itemEvidenceSources({}), []);
});

test('normalizePlaybookItem: includes an item citing tracking anywhere in its evidence', () => {
  const item = normalizePlaybookItem('plugin:claude', {
    id: 'pb_1',
    text: 'Lead with a concrete claim.',
    evidence: [{ source: 'tracking', n: 5 }],
  });
  assert.ok(item);
  assert.equal(item!.nodeId, 'plugin:claude');
  assert.equal(item!.text, 'Lead with a concrete claim.');
  assert.deepEqual(item!.evidenceSources, ['tracking']);
});

test('normalizePlaybookItem: an item with no tracking-sourced evidence is excluded', () => {
  assert.equal(normalizePlaybookItem('plugin:claude', { id: 'pb_2', text: 'x', evidence: [{ source: 'eval' }] }), null);
});

test('normalizePlaybookItem: garbage input is excluded, never throws', () => {
  assert.equal(normalizePlaybookItem('plugin:claude', null), null);
});

// ─── optimizer proposals ────────────────────────────────────────────────────

test('isOpenProposalStatus: a missing status defaults to open', () => {
  assert.equal(isOpenProposalStatus(undefined), true);
});

test('isOpenProposalStatus: known terminal statuses are not open, case-insensitively', () => {
  for (const status of ['promoted', 'REJECTED', 'Applied', 'archived', 'closed', 'discarded', 'declined']) {
    assert.equal(isOpenProposalStatus(status), false, status);
  }
});

test('isOpenProposalStatus: an unrecognized/in-progress status is treated as open', () => {
  for (const status of ['proposed', 'pending', 'open', 'awaiting_review']) {
    assert.equal(isOpenProposalStatus(status), true, status);
  }
});

test('normalizeProposalRow: an open proposal round-trips', () => {
  const row = normalizeProposalRow({
    id: 'prop_1',
    nodeId: 'plugin:claude',
    status: 'proposed',
    title: 'Shorten the hook',
    createdAt: '2026-09-05T00:00:00.000Z',
  });
  assert.deepEqual(row, {
    id: 'prop_1',
    nodeId: 'plugin:claude',
    title: 'Shorten the hook',
    status: 'proposed',
    createdAt: '2026-09-05T00:00:00.000Z',
    evidence: { windowStart: null, windowEnd: null, n: null },
  });
});

test('normalizeProposalRow: a promoted/rejected proposal is excluded — this section is OPEN proposals only', () => {
  assert.equal(normalizeProposalRow({ id: 'prop_2', status: 'promoted' }), null);
});

test('normalizeProposalRow: a record with no id is excluded', () => {
  assert.equal(normalizeProposalRow({ status: 'proposed' }), null);
});

// ─── strategy observations ──────────────────────────────────────────────────

test('observationSource: reads a top-level source/schema field', () => {
  assert.equal(observationSource({ source: 'tracking:strategy.v1' }), 'tracking:strategy.v1');
  assert.equal(observationSource({ schema: 'tracking:strategy.v1' }), 'tracking:strategy.v1');
});

test('observationSource: reads a nested metadata source/schema field', () => {
  assert.equal(observationSource({ metadata: { source: 'tracking:strategy.v1' } }), 'tracking:strategy.v1');
});

test('observationSource: a live-shaped fleet-operations observation (no source field at all) is undefined', () => {
  assert.equal(
    observationSource({
      id: 'learning_1',
      observation: 'Live publish executed for dr-lurie request req_x.',
      metadata: { type: 'publish_executed', projectId: 'dr-lurie' },
    }),
    undefined
  );
});

test('normalizeStrategyObservation: only tracking:strategy.v1-sourced rows are included', () => {
  const row = normalizeStrategyObservation({
    id: 'strat_1',
    source: 'tracking:strategy.v1',
    label: 'p75 dwell rises with a numbered hook',
    window_start: '2026-08-01',
    window_end: '2026-08-29',
    n: 64,
  });
  assert.deepEqual(row, {
    id: 'strat_1',
    label: 'p75 dwell rises with a numbered hook',
    evidence: { windowStart: '2026-08-01', windowEnd: '2026-08-29', n: 64 },
  });
});

test('normalizeStrategyObservation: a real live fleet-log observation (no tracking source) is excluded', () => {
  assert.equal(
    normalizeStrategyObservation({
      id: 'learning_1788007887607_47clhr',
      observation: 'Live publish executed for dr-lurie request req_conductor_njffct_20260828_01.',
      metadata: { type: 'publish_executed', projectId: 'dr-lurie' },
      createdAt: '2026-08-29T12:51:27.607Z',
    }),
    null
  );
});

// ─── fetchAnalyticsInsights ─────────────────────────────────────────────────
//
// projectId sourcing on the two now-tenant-scoped calls; the two
// permanently-workspace-wide sections never reaching CMS-Agent at all; and a
// genuine failure on either scoped call still surfacing as `error`, never
// silently reclassified as `workspaceScope`.

const CMS_AGENT_ENV_KEYS = ['CMS_AGENT_MCP_ENDPOINT', 'CMS_AGENT_MCP_TOKEN'] as const;

/** Pins CMS-Agent's two env vars configured (any non-empty value — no real network call happens, every call goes through the stubbed `AnalyticsInsightsCmsAgentClient`) for the duration of `fn`, restoring whatever was there before. */
const withCmsAgentConfigured = async (fn: () => Promise<void>): Promise<void> => {
  const previous = Object.fromEntries(CMS_AGENT_ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.CMS_AGENT_MCP_ENDPOINT = 'https://cms-agent.example.invalid/mcp';
  process.env.CMS_AGENT_MCP_TOKEN = 'test-token-should-never-be-used';
  try {
    await fn();
  } finally {
    for (const key of CMS_AGENT_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

type StubCall = { name: string; args: Record<string, unknown> };
type StubResponse = { ok: true; data: unknown } | { ok: false; code: CmsAgentErrorCode; message: string };

/** A stubbed `AnalyticsInsightsCmsAgentClient` recording every call it receives — same shape as `brand-imagery-proxy.test.ts`'s `stubCmsAgent`. */
const stubClient = (
  respond: (name: string, args: Record<string, unknown>) => StubResponse
): { client: AnalyticsInsightsCmsAgentClient; calls: StubCall[] } => {
  const calls: StubCall[] = [];
  return {
    calls,
    client: {
      callTool: async (name, args) => {
        calls.push({ name, args });
        return respond(name, args) as never;
      },
    },
  };
};

test('fetchAnalyticsInsights: feedback_list and learning_list_observations both carry the site cmsAgentProjectId', async () => {
  await withCmsAgentConfigured(async () => {
    const { client, calls } = stubClient((name) => {
      if (name === 'feedback_list') return { ok: true, data: { records: [] } };
      if (name === 'learning_list_observations') return { ok: true, data: { observations: [] } };
      return { ok: false, code: 'cms_agent_error', message: `unexpected call: ${name}` };
    });

    const overview = await fetchAnalyticsInsights(client);

    assert.equal(overview.configured, true);
    const expectedProjectId = getSiteIdentity().cmsAgentProjectId;
    const feedbackCall = calls.find((call) => call.name === 'feedback_list');
    const learningCall = calls.find((call) => call.name === 'learning_list_observations');
    assert.ok(feedbackCall, 'feedback_list was called');
    assert.ok(learningCall, 'learning_list_observations was called');
    assert.equal(feedbackCall!.args.projectId, expectedProjectId);
    assert.equal(learningCall!.args.projectId, expectedProjectId);
  });
});

test('fetchAnalyticsInsights: playbook_get/optimizer_status are never called — both sections resolve to workspaceScope with no network round trip', async () => {
  await withCmsAgentConfigured(async () => {
    const { client, calls } = stubClient((name) => {
      if (name === 'feedback_list') return { ok: true, data: { records: [] } };
      if (name === 'learning_list_observations') return { ok: true, data: { observations: [] } };
      // Any call reaching here beyond those two is exactly the round trip
      // this module must no longer make.
      return { ok: false, code: 'cms_agent_auth_failed', message: 'CMS-Agent rejected the credential.' };
    });

    const overview = await fetchAnalyticsInsights(client);

    assert.deepEqual(overview.playbookItems, { workspaceScope: true });
    assert.deepEqual(overview.proposals, { workspaceScope: true });
    assert.deepEqual(
      calls.map((call) => call.name).sort(),
      ['feedback_list', 'learning_list_observations']
    );
  });
});

test('fetchAnalyticsInsights: a genuine feedback_list/learning_list_observations failure still renders as a plain error payload, never workspaceScope', async () => {
  await withCmsAgentConfigured(async () => {
    const { client } = stubClient((name) => {
      if (name === 'feedback_list') {
        return { ok: false, code: 'cms_agent_auth_failed', message: 'CMS-Agent rejected the credential.' };
      }
      if (name === 'learning_list_observations') {
        return { ok: false, code: 'cms_agent_unreachable', message: 'CMS-Agent is unreachable from Platform.' };
      }
      return { ok: false, code: 'cms_agent_error', message: `unexpected call: ${name}` };
    });

    const overview = await fetchAnalyticsInsights(client);

    assert.deepEqual(overview.outcomes, { message: 'CMS-Agent rejected the credential.' });
    assert.deepEqual(overview.strategyObservations, { message: 'CMS-Agent is unreachable from Platform.' });
    // Neither carries `workspaceScope` — that flag is set only by the two
    // sections that never call out at all, never derived from a response.
    assert.equal((overview.outcomes as { workspaceScope?: boolean }).workspaceScope, undefined);
    assert.equal((overview.strategyObservations as { workspaceScope?: boolean }).workspaceScope, undefined);
  });
});

test('fetchAnalyticsInsights: CMS-Agent not configured short-circuits before any client call at all', async () => {
  const previous = Object.fromEntries(CMS_AGENT_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of CMS_AGENT_ENV_KEYS) delete process.env[key];
  try {
    const { client, calls } = stubClient(() => ({ ok: false, code: 'cms_agent_error', message: 'must not be called' }));

    const overview = await fetchAnalyticsInsights(client);

    assert.equal(overview.configured, false);
    assert.equal(calls.length, 0);
  } finally {
    for (const key of CMS_AGENT_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
