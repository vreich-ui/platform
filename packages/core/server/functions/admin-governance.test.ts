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
