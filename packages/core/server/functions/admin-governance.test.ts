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
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requestSchema } from './admin-governance.js';

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
      // Window widened from 80 (T-perf): the `get` branch now opens with the
      // single doc read + CMS-Agent probe it runs concurrently, which is
      // several lines of comment and code before the response is built. The
      // assertion still says the same thing — `get` answers through
      // readJsonResponse, never the plain no-store jsonResponse.
      /req\.verb === 'get'\)\s*\{[\s\S]{0,400}return readJsonResponse\(event, \{/,
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

  it('the get branch reads the governance doc once and starts the CMS-Agent probe alongside it', () => {
    const source = governanceSource();
    assert.match(
      source,
      /const \[doc, probe\] = await Promise\.all\(\[getGovernanceDoc\(store\), cmsAgentProbe\(binding\)\]\);/,
      'the get branch must start the doc read and the CMS-Agent probe together'
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

  it('the CMS-Agent probe takes nothing from the governance doc, so it can start before the doc is read', () => {
    const source = governanceSource();
    const probe = source.slice(source.indexOf('const cmsAgentProbe'), source.indexOf('const cmsAgentStatus'));
    assert.doesNotMatch(probe, /\bdoc\b|legacyOverride/, 'cmsAgentProbe must not depend on the governance doc');
    // The doc-derived field still exists — it just moved to the pure assembler.
    assert.match(source, /legacy_mode_override_ignored: legacyOverride/, 'the legacy-override field must survive');
  });
});
