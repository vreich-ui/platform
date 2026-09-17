/**
 * W11 T11.10 — the `agent_keys_*` verbs admin-governance.ts added.
 *
 * The full handler needs a real Netlify Identity-authenticated event to
 * exercise end-to-end (no test-injection seam exists for
 * `getAdminStateFromEvent` today — the same gap tracking-governance.test.ts
 * already worked around for this exact file). Two levels of proof instead:
 *   1. The request CONTRACT — `requestSchema` — is exported and tested
 *      directly here for the three new verbs.
 *   2. The owner-gating WIRING is asserted at the source level (this file's
 *      own established pattern for admin-governance.ts).
 * The actual verified-vs-forged/revoked/cross-site adversarial logic lives
 * in agent-keys.test.ts (13 tests) — this file only proves the HTTP-layer
 * contract + auth wiring around it, not re-proving that logic.
 */
import '../../../../sites/drlurie/config/policy-bindings.js'; // registers site providers — admin-governance.js's import chain reaches getSiteIdentity()
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';

import { requestSchema } from './admin-governance.js';
import { probeCmsAgent, CMS_AGENT_PROBE_TIMEOUT_MS } from '../lib/governance/cms-agent-probe.js';
import { PLATFORM_ENV_NAMES, type SiteBinding } from '../lib/site-binding.js';

describe('admin-governance requestSchema — agent_keys_* verbs', () => {
  it('accepts agent_keys_list with no extra fields', () => {
    assert.strictEqual(requestSchema.safeParse({ verb: 'agent_keys_list' }).success, true);
  });

  it('accepts agent_keys_create/revoke with agent_name + site', () => {
    assert.strictEqual(
      requestSchema.safeParse({ verb: 'agent_keys_create', agent_name: 'draft-agent', site: 'site_drlurie' }).success,
      true
    );
    assert.strictEqual(
      requestSchema.safeParse({ verb: 'agent_keys_revoke', agent_name: 'draft-agent', site: 'site_drlurie' }).success,
      true
    );
  });

  it('rejects agent_keys_create/revoke missing agent_name or site', () => {
    assert.strictEqual(requestSchema.safeParse({ verb: 'agent_keys_create', site: 'site_drlurie' }).success, false);
    assert.strictEqual(requestSchema.safeParse({ verb: 'agent_keys_create', agent_name: 'x' }).success, false);
    assert.strictEqual(
      requestSchema.safeParse({ verb: 'agent_keys_revoke', agent_name: '', site: 'x' }).success,
      false
    );
  });

  it('still accepts every pre-existing verb unchanged (get/set/revert)', () => {
    assert.strictEqual(requestSchema.safeParse({ verb: 'get' }).success, true);
    assert.strictEqual(requestSchema.safeParse({ verb: 'revert', target: 'all' }).success, true);
  });

  it('accepts an explicit learning-mode toggle and its dedicated revert target', () => {
    assert.strictEqual(requestSchema.safeParse({ verb: 'set', learning_mode: true }).success, true);
    assert.strictEqual(requestSchema.safeParse({ verb: 'set', learning_mode: false }).success, true);
    assert.strictEqual(requestSchema.safeParse({ verb: 'revert', target: 'learning_mode' }).success, true);
  });

  it('U2: accepts the brandImageryOverrides guardrail set (allow/lock) and its dedicated revert target', () => {
    assert.strictEqual(requestSchema.safeParse({ verb: 'set', brandImageryOverrides: 'allow' }).success, true);
    assert.strictEqual(requestSchema.safeParse({ verb: 'set', brandImageryOverrides: 'lock' }).success, true);
    assert.strictEqual(requestSchema.safeParse({ verb: 'revert', target: 'brandImageryOverrides' }).success, true);
  });

  it('U2: rejects an unrecognized brandImageryOverrides value', () => {
    assert.strictEqual(requestSchema.safeParse({ verb: 'set', brandImageryOverrides: 'sometimes' }).success, false);
  });
});

describe('admin-governance source wiring — agent_keys_create/revoke are Owner-gated, agent_keys_list is not', () => {
  it('the handler checks `owner` before agent_keys_create/agent_keys_revoke, but not before agent_keys_list', () => {
    let root = path.dirname(fileURLToPath(import.meta.url));
    while (root !== path.dirname(root)) {
      if (existsSync(path.join(root, 'netlify.toml')) && existsSync(path.join(root, 'packages/core/admin'))) break;
      root = path.dirname(root);
    }
    const source = readFileSync(path.join(root, 'packages/core/server/functions/admin-governance.ts'), 'utf8');

    assert.match(
      source,
      /agent_keys_create'\s*\|\|\s*req\.verb === 'agent_keys_revoke'\)\s*\{\s*\n\s*if \(!owner\)/,
      "agent_keys_create/agent_keys_revoke must be gated by 'if (!owner)' immediately inside their shared branch"
    );
    assert.match(
      source,
      /agent_keys_list.*\{\s*\n\s*const doc = await getAgentKeysDoc/,
      'agent_keys_list must not require an owner check'
    );
    assert.match(source, /token_hash/, 'the module must reference token_hash (never leaking it in a plain record)');
  });
});

describe('admin-governance source wiring — T2.3 ETag only on the two read verbs', () => {
  it('get and agent_keys_list respond via readJsonResponse (ETag); every write verb keeps plain jsonResponse', () => {
    let root = path.dirname(fileURLToPath(import.meta.url));
    while (root !== path.dirname(root)) {
      if (existsSync(path.join(root, 'netlify.toml')) && existsSync(path.join(root, 'packages/core/admin'))) break;
      root = path.dirname(root);
    }
    const source = readFileSync(path.join(root, 'packages/core/server/functions/admin-governance.ts'), 'utf8');

    assert.match(
      source,
      // Window widened from 80 (T-perf), to 400 (T-perf wave 3), and now to
      // 1400 (M3.4): the `get` branch opens with the one snapshot read and
      // the note stating what it replaced — a live CMS-Agent probe on a page
      // path — before the response is built. The assertion still says the
      // same thing: `get` answers through readJsonResponse, never the plain
      // no-store jsonResponse.
      /req\.verb === 'get'\)\s*\{[\s\S]{0,1400}return readJsonResponse\(event, \{/,
      "verb 'get' must respond via readJsonResponse, not the plain no-store jsonResponse"
    );
    assert.match(
      source,
      /req\.verb === 'agent_keys_list'\)\s*\{[\s\S]{0,120}return readJsonResponse\(event, \{ keys:/,
      "verb 'agent_keys_list' must respond via readJsonResponse, not the plain no-store jsonResponse"
    );
    // agent_keys_create is the ONE response that ever carries a raw token — it
    // must never be reachable through the cacheable/ETag'd path.
    assert.match(
      source,
      /return jsonResponse\(200, \{ token, record: recordWithoutHash \}\);/,
      'agent_keys_create must keep returning via the plain no-store jsonResponse, never readJsonResponse'
    );
    assert.doesNotMatch(
      source,
      /token,\s*record: recordWithoutHash[\s\S]{0,40}readJsonResponse/,
      'agent_keys_create must never be routed through readJsonResponse (would cache a one-time secret)'
    );
  });
});

describe('admin-governance requestSchema — PF5 permanent Client Manager cutover', () => {
  it('rejects every retired mode write but keeps the cleanup revert target', () => {
    for (const mode of ['off', 'fallback', 'required']) {
      assert.strictEqual(requestSchema.safeParse({ verb: 'set', cms_agent_chat_mode: mode }).success, false, mode);
    }
    assert.strictEqual(requestSchema.safeParse({ verb: 'revert', target: 'cms_agent_chat_mode' }).success, true);
  });

  it('also rejects unknown mode values', () => {
    assert.strictEqual(requestSchema.safeParse({ verb: 'set', cms_agent_chat_mode: 'reqired' }).success, false);
    assert.strictEqual(requestSchema.safeParse({ verb: 'set', cms_agent_chat_mode: 'on' }).success, false);
  });
});

/**
 * T-perf — `get` was the slowest read on this surface (2126 ms of `work` on
 * the live admin). Two causes, both in this branch:
 *
 *   1. `overrides.v1` was read TWICE in one request — once for the `doc`
 *      field, then again inside `resolveActivePolicies(store)` for `active`,
 *      the second read strictly after the first.
 *   2. The CMS-Agent `agent_resolve` probe — a real cross-service HTTP round
 *      trip on a cold container — was awaited AFTER both of those, only
 *      because the wire shape carries one doc-derived field next to it.
 *
 * The fix is one read plus one `Promise.all`, so the branch costs
 * max(doc read, probe) instead of doc + doc + probe. Asserted at the source
 * level for the same reason the wiring above is: neither the read count nor
 * the concurrency is observable from the response body.
 */
describe('admin-governance source wiring — T-perf: one doc read, probe in parallel', () => {
  const governanceSource = () => {
    let root = path.dirname(fileURLToPath(import.meta.url));
    while (root !== path.dirname(root)) {
      if (existsSync(path.join(root, 'netlify.toml')) && existsSync(path.join(root, 'packages/core/admin'))) break;
      root = path.dirname(root);
    }
    return readFileSync(path.join(root, 'packages/core/server/functions/admin-governance.ts'), 'utf8');
  };

  /**
   * M3.4 supersedes the wave-2 assertion that used to live here (the get
   * branch starting `getGovernanceDoc` and `cmsAgentProbe` together under one
   * `Promise.all`). Concurrency was the best answer available while the probe
   * was on the page path at all; it is not one now. The branch reads ONE blob
   * — `snapshots/governance.json` — and makes no network call, so the shape
   * to pin is the absence of the probe, not its parallelism.
   */
  it('the get branch reads the governance snapshot and nothing else', () => {
    const source = governanceSource();
    const getBranch = source.slice(
      source.indexOf("req.verb === 'get'"),
      source.indexOf("req.verb === 'agent_keys_list'")
    );
    assert.match(
      getBranch,
      /const \{ snapshot, repaired \} = await timeSection\('snapshot', \(\) => loadGovernanceSnapshot\(store, Date\.now\(\)\)\);/,
      'the get branch must serve from snapshots/governance.json, attributed via timeSection'
    );
    assert.doesNotMatch(
      getBranch,
      /getGovernanceDoc\(/,
      'a page read must not go to overrides.v1 directly — the repair inside loadGovernanceSnapshot is the only path there'
    );
  });

  it('nothing in admin-governance can reach the CMS-Agent probe — the milestone is "a page never probes"', () => {
    const source = governanceSource();
    assert.doesNotMatch(
      source,
      /from '[^']*cms-agent-probe/,
      'importing the probe module would put a live cross-service call back inside a page path'
    );
    assert.doesNotMatch(
      source,
      /new CmsAgentClient\(/,
      'admin-governance must not construct a CMS-Agent client; functions/governance-probe-refresh.ts owns the probe'
    );
    // The env-NAME check stays: it costs no network and answers the one state
    // an operator can act on (this tenant has no CMS-Agent credentials).
    assert.match(source, /cmsAgentMissingEnvVars\(binding\.env\)/, 'configured must still be answered live');
  });

  it('a governance write refreshes the snapshot, so an Owner reads their own change back', () => {
    const source = governanceSource();
    assert.match(
      source,
      /await putGovernanceDoc\(store, next\);[\s\S]{0,1200}await refreshGovernanceSnapshotAfterWrite\(store, next, Date\.now\(\)\);/,
      'every governance write must be a writer of snapshots/governance.json'
    );
  });

  it('the get branch resolves `active` from the doc it already read, never with a second store read', () => {
    const source = governanceSource();
    const getBranch = source.slice(
      source.indexOf("req.verb === 'get'"),
      source.indexOf("req.verb === 'agent_keys_list'")
    );
    assert.match(getBranch, /active: activePoliciesFromDoc\(doc\)/, '`active` must come from the doc already in hand');
    assert.doesNotMatch(
      getBranch,
      /resolveActivePolicies\(store\)/,
      'resolveActivePolicies(store) re-reads overrides.v1 — the get branch must not pay for the same blob twice'
    );
    assert.doesNotMatch(
      getBranch,
      /await getGovernanceDoc\(store\)[\s\S]*await getGovernanceDoc\(store\)/,
      'overrides.v1 must be read exactly once per get'
    );
  });

  it('the doc-derived legacy-override field survives the move to the snapshot', () => {
    const source = governanceSource();
    assert.match(source, /legacy_mode_override_ignored: legacyOverride/, 'the legacy-override field must survive');
  });
});

/**
 * T-perf wave 3 — re-measured after the wave-2 fix above shipped: `work`
 * barely moved (2126 -> 2002 ms). `sec.doc`/`sec.probe` (added below) are
 * what let the NEXT live measurement say which of the two concurrent halves
 * is still the long pole; the code-level reasoning already points at the
 * probe, which inherited `CmsAgentClient`'s 90s-per-call conversational-turn
 * default with no override, and is up to three SERIAL cross-service HTTP
 * calls on a cold container with no session. This block proves two things a
 * source regex cannot: the probe now bounds a hung CMS-Agent to its
 * configured budget instead of the 90s default, and degrades to an unknown
 * status rather than failing the read; and the module-scope memo actually
 * skips the network call on a repeat within its TTL (the "cold = always"
 * limitation noted in the brief is that this memo, being module state, is
 * necessarily empty on the FIRST invocation of a fresh container — nothing
 * in-process can fix that, which is exactly why the timeout is the fix for
 * the cold case and the memo is the fix for the warm one).
 */
describe('admin-governance source wiring — T-perf wave 3: Server-Timing sections for the get verb', () => {
  const repoRoot = () => {
    let root = path.dirname(fileURLToPath(import.meta.url));
    while (root !== path.dirname(root)) {
      if (existsSync(path.join(root, 'netlify.toml')) && existsSync(path.join(root, 'packages/core/admin'))) break;
      root = path.dirname(root);
    }
    return root;
  };
  const governanceSource = () =>
    readFileSync(path.join(repoRoot(), 'packages/core/server/functions/admin-governance.ts'), 'utf8');
  const probeSource = () =>
    readFileSync(path.join(repoRoot(), 'packages/core/server/lib/governance/cms-agent-probe.ts'), 'utf8');

  it('the one thing the get branch does is attributed via timeSection', () => {
    const source = governanceSource();
    assert.ok(
      source.includes("timeSection('snapshot'"),
      "work must be attributable per section — missing timeSection('snapshot'"
    );
  });

  it('the health-probe client is given a deliberate, tight timeout — not CmsAgentClient\'s 90s conversational default', () => {
    // M3.4: the constant and the client moved to lib/governance/cms-agent-probe.ts
    // with the probe. The budget matters slightly less now (nobody waits on
    // it) and slightly more in one respect: it runs on a schedule across six
    // tenants, so an unbounded probe is an unbounded scheduled-function bill.
    const source = probeSource();
    assert.match(
      source,
      /export const CMS_AGENT_PROBE_TIMEOUT_MS = 3_000;/,
      'the probe budget must be a named, deliberate constant'
    );
    assert.match(
      source,
      /new CmsAgentClient\(\{ timeoutMs: CMS_AGENT_PROBE_TIMEOUT_MS \}\)/,
      "the health-probe-only client must override CmsAgentClient's default timeout, not inherit the 90s conversational one"
    );
    assert.match(
      source,
      /const newProbeClient = \(\) => new CmsAgentClient/,
      'a module-scope client would answer from its own five-minute agent_ref memo — a green light with no packet behind it'
    );
  });
});

describe('admin-governance CMS-Agent probe — bounded timeout and an effective warm memo', () => {
  let hangServer: Server;
  let hangEndpoint: string;
  let fastServer: Server;
  let fastEndpoint: string;
  let fastToolCalls: string[];

  const binding = (endpoint: string): SiteBinding => {
    process.env.CMS_AGENT_MCP_ENDPOINT = endpoint;
    process.env.CMS_AGENT_MCP_TOKEN = 'test-bearer-do-not-log';
    return { siteId: 'site_test_probe', env: PLATFORM_ENV_NAMES, dataRoot: 'sites/test/data/site' };
  };

  before(async () => {
    // A deliberate black hole: never responds to anything, on any method —
    // exercises the abort path regardless of whether the client already
    // holds a session (it never will, against this server).
    hangServer = createServer((_req, _res) => {
      /* never call res.end() */
    });
    await new Promise<void>((resolve) => hangServer.listen(0, '127.0.0.1', resolve));
    const hangAddress = hangServer.address();
    hangEndpoint = `http://127.0.0.1:${typeof hangAddress === 'object' && hangAddress ? hangAddress.port : 0}/mcp`;

    // A real, fast, minimal Streamable-HTTP MCP server — just enough for
    // initialize -> notifications/initialized -> tools/call(agent_resolve).
    fastServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let rpc: { id?: unknown; method?: string; params?: { name?: string } } = {};
        try {
          rpc = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          rpc = {};
        }
        if (rpc.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'mcps_test_1' });
          res.end(
            JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: {} } })
          );
          return;
        }
        if (rpc.method === 'notifications/initialized') {
          res.writeHead(202).end();
          return;
        }
        if (rpc.method === 'tools/call') {
          fastToolCalls.push(rpc.params?.name ?? '');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: { structuredContent: { ok: true, data: { agent_ref: 'agt_client_manager@2' } } },
            })
          );
          return;
        }
        res.writeHead(400).end();
      });
    });
    await new Promise<void>((resolve) => fastServer.listen(0, '127.0.0.1', resolve));
    const fastAddress = fastServer.address();
    fastEndpoint = `http://127.0.0.1:${typeof fastAddress === 'object' && fastAddress ? fastAddress.port : 0}/mcp`;
  });

  after(async () => {
    hangServer.closeAllConnections?.();
    fastServer.closeAllConnections?.();
    await Promise.all([
      new Promise<void>((resolve) => hangServer.close(() => resolve())),
      new Promise<void>((resolve) => fastServer.close(() => resolve())),
    ]);
    delete process.env.CMS_AGENT_MCP_ENDPOINT;
    delete process.env.CMS_AGENT_MCP_TOKEN;
  });

  beforeEach(() => {
    fastToolCalls = [];
  });

  it('a hung CMS-Agent degrades the probe to an unreachable RESULT within the configured budget, never the 90s default', async () => {
    const start = performance.now();
    const probe = await probeCmsAgent(binding(hangEndpoint));
    const elapsedMs = performance.now() - start;

    assert.equal(probe.reachable, false, 'a hung probe must degrade to a result, not throw');
    assert.equal(probe.code, 'cms_agent_timeout');
    assert.equal(probe.agent_ref, null);
    assert.ok(typeof probe.checked_at === 'string' && probe.checked_at.length > 0, 'every probe states when it was taken');
    // Bounded by CMS_AGENT_PROBE_TIMEOUT_MS, with slack for CI scheduling —
    // nowhere near CmsAgentClient's 90_000 ms conversational default.
    assert.ok(
      elapsedMs < CMS_AGENT_PROBE_TIMEOUT_MS * 3,
      `probe took ${elapsedMs.toFixed(0)}ms against a server that never responds; must stay bounded`
    );
  });

  /**
   * M3.4 replaces the wave-3 memo test that used to sit here.
   *
   * The 60 s module-scope memo existed because the probe ran on a PAGE PATH
   * and had to be de-duplicated across the requests of one warm container.
   * There is no page path any more: the only caller is a five-minute
   * schedule, which has nothing to de-duplicate, and a memo whose remaining
   * effect would be to let a pass publish a `checked_at` it did not take is a
   * lie about the one field that makes a stale verdict readable. So every
   * pass takes a real probe, and this pins that.
   */
  it('every pass takes a fresh probe — there is no memo left to serve a reading nobody took', async () => {
    const first = await probeCmsAgent(binding(fastEndpoint));
    assert.equal(first.reachable, true);
    assert.equal(first.agent_ref, 'agt_client_manager@2');
    assert.deepEqual(fastToolCalls, ['agent_resolve'], 'the first call must actually reach CMS-Agent');

    const second = await probeCmsAgent(binding(fastEndpoint), Date.parse('2026-09-16T12:00:00.000Z'));
    assert.equal(second.reachable, true);
    assert.equal(second.checked_at, '2026-09-16T12:00:00.000Z', 'checked_at is the moment THIS pass asked');
    assert.deepEqual(
      fastToolCalls,
      ['agent_resolve', 'agent_resolve'],
      'a second pass must ask again — a scheduled probe has nothing to memoize'
    );
  });
});
