/**
 * Object-lock owner attribution bug (2026-08-28): a real checkout on
 * site_drlurie recorded `lock.owner_id: "unattributed-agent"` instead of the
 * calling agent's declared identity.
 *
 * Root cause: `agentPrincipal()` below has always correctly derived
 * `{ agent_name: declared || 'unattributed-agent' }` from the raw request
 * body — that part was never broken. The break was upstream, in
 * `packages/core/server/functions/mcp.ts`'s `callTool` switch: the
 * `object_checkout` / `object_refresh_lock` / `object_checkin` cases built
 * their `callObjectAction` payload WITHOUT `agent_name: input.agent_name`
 * (every other mutating object verb — object_create, site_apply_theme, ... —
 * already forwarded it), so `agentPrincipal(parsed.value)` on the
 * object-store.ts side always saw an absent `agent_name` for these three
 * verbs and always fell back to the sentinel, regardless of what the caller
 * declared.
 *
 * Two layers are pinned here:
 *  1. `agentPrincipal` itself, against the exact payload shapes the
 *     checkout/refresh_lock/checkin cases now send (with and without a
 *     declared agent_name) — proves the derivation is correct once agent_name
 *     actually arrives.
 *  2. The derived principal fed through the real `checkoutObjectLock`
 *     (object-lock.ts) against an in-memory store — proves the lock record
 *     itself, not just the intermediate Principal, carries the right owner.
 *  3. A source-level check on mcp.ts (the migrate-site.test.ts /
 *     admin-requests.test.ts precedent for handler code with no
 *     test-injection seam) pinning that the three verb cases actually
 *     forward `agent_name` and are covered by the verified-agent-token
 *     override — this is the line that regresses if the omission comes back.
 */
import '../../../../sites/drlurie/config/policy-bindings.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentPrincipal } from './object-store.js';
import { checkoutObjectLock } from '../lib/object-lock.js';
import { objectRecordKey } from '../lib/object-store-keys.js';
import type { ObjectRecord } from '../../schema/object-record-v1.js';

const NOW_MS = Date.parse('2026-08-28T00:00:00.000Z');

const makeStore = (seeds: ObjectRecord[]) => {
  const blobs = new Map<string, string>();
  for (const seed of seeds) blobs.set(objectRecordKey(seed.object_type, seed.object_id), JSON.stringify(seed));
  return {
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      blobs.set(key, JSON.stringify(value));
    },
  };
};

const makeSiteRecord = (): ObjectRecord => ({
  object_id: 'site_drlurie',
  object_type: 'site',
  schema_version: 'site.v1',
  site: 'site_drlurie',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  status: 'active',
  body: {},
  publication: { published_time: null },
  history: [],
  version: 1,
  content_revision: 1,
});

describe('agentPrincipal (object-store.ts) — the payload → Principal derivation', () => {
  it('derives the agent Principal from a declared agent_name, exactly as the checkout/refresh_lock/checkin payloads now carry it', () => {
    assert.deepStrictEqual(agentPrincipal({ action: 'checkout', object_type: 'site', object_id: 'site_drlurie', agent_name: 'cms-agent' }), {
      kind: 'agent',
      agent_name: 'cms-agent',
      auth: 'publish_key',
    });
  });

  it('still falls back to the unattributed-agent sentinel when no identity is declared at all (the intentional degrade, not the bug)', () => {
    assert.deepStrictEqual(agentPrincipal({ action: 'checkout', object_type: 'site', object_id: 'site_drlurie' }), {
      kind: 'agent',
      agent_name: 'unattributed-agent',
      auth: 'publish_key',
    });
  });

  it('treats a blank/whitespace-only declared name the same as absent (no empty-string owner_id)', () => {
    assert.deepStrictEqual(agentPrincipal({ action: 'checkout', agent_name: '   ' }), {
      kind: 'agent',
      agent_name: 'unattributed-agent',
      auth: 'publish_key',
    });
  });
});

describe('checkout → lock.owner_id, end to end through the real object-lock.ts path', () => {
  it('a checkout payload carrying agent_name records the lock under that real identity, not the sentinel', async () => {
    const store = makeStore([makeSiteRecord()]);
    const key = objectRecordKey('site', 'site_drlurie');
    const principal = agentPrincipal({
      action: 'checkout',
      object_type: 'site',
      object_id: 'site_drlurie',
      agent_name: 'cms-agent',
    });

    const result = await checkoutObjectLock(store, key, { actor: principal, nowMs: NOW_MS });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.record?.lock?.owner_id, 'cms-agent');
    assert.strictEqual(result.record?.lock?.owner_label, 'cms-agent');
  });

  it('a checkout payload with genuinely no declared identity still records the unattributed-agent sentinel (fallback preserved, not a caller-set owner_id)', async () => {
    const store = makeStore([makeSiteRecord()]);
    const key = objectRecordKey('site', 'site_drlurie');
    const principal = agentPrincipal({ action: 'checkout', object_type: 'site', object_id: 'site_drlurie' });

    const result = await checkoutObjectLock(store, key, { actor: principal, nowMs: NOW_MS });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.record?.lock?.owner_id, 'unattributed-agent');
    assert.strictEqual(result.record?.lock?.owner_label, 'unattributed-agent');
  });
});

/** The compiled test runs from `.tmp/ci-test` — walk up to the repo root (admin-requests.test.ts's precedent). */
const repoRoot = (): string => {
  let root = path.dirname(fileURLToPath(import.meta.url));
  while (root !== path.dirname(root)) {
    if (existsSync(path.join(root, 'netlify.toml')) && existsSync(path.join(root, 'packages/core/admin'))) break;
    root = path.dirname(root);
  }
  return root;
};
const mcpSource = readFileSync(path.join(repoRoot(), 'packages/core/server/functions/mcp.ts'), 'utf8');

describe('mcp.ts source — the dispatch layer agentPrincipal actually depends on', () => {
  // No test-injection seam exists for callTool's full LambdaEvent dispatch
  // (it needs a live publish-key + blob-store context, the admin-requests.test.ts
  // precedent for this codebase's handler layer) — a source assertion is the
  // regression pin for the line that broke: forwarding agent_name at all.
  it('forwards agent_name on every one of the three lock verbs the bug hit', () => {
    for (const action of ['checkout', 'refresh_lock', 'checkin']) {
      const caseStart = mcpSource.indexOf(`action: '${action}',`);
      assert.ok(caseStart > -1, `no callObjectAction payload found for action: '${action}'`);
      const payloadEnd = mcpSource.indexOf('});', caseStart);
      const payloadSlice = mcpSource.slice(caseStart, payloadEnd);
      assert.match(
        payloadSlice,
        /agent_name: input\.agent_name/,
        `the '${action}' callObjectAction payload must forward agent_name: input.agent_name`
      );
    }
  });

  it('covers the same three lock verbs with the verified-per-agent-token override (CMS_AGENT_NAME_ATTRIBUTION_TOOLS)', () => {
    const setStart = mcpSource.indexOf('const CMS_AGENT_NAME_ATTRIBUTION_TOOLS');
    const setEnd = mcpSource.indexOf(']);', setStart);
    const setSlice = mcpSource.slice(setStart, setEnd);
    for (const tool of ['object_checkout', 'object_refresh_lock', 'object_checkin']) {
      assert.ok(setSlice.includes(`'${tool}'`), `CMS_AGENT_NAME_ATTRIBUTION_TOOLS must include '${tool}'`);
    }
  });
});
