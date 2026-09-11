/**
 * T-ASSET-IDENTITY Part 1 — regression coverage for the artifact-browse
 * admin gate's identity propagation.
 *
 * `search_artifacts` / `list_artifacts_by_kind` / `list_artifacts_by_request`
 * share one non-MCP-gated, non-publish-secret fallback path
 * (`requireArtifactBrowseAccess` -> `getAdminToolState`, mcp-artifact-admin.ts)
 * — exactly the shape a call takes when it arrives through the admin-chat
 * operational bridge (`agent/context.ts`'s `operationalEvent`), which never
 * carries the `/mcp` gate flag and, by A§1.2's own security invariant, never
 * carries the publish secret either.
 *
 * This proves two things about that path:
 *
 *   1. A human whose admin tier comes ONLY from a `users` store invite (not
 *      the static ADMIN_EMAILS bootstrap list) is granted access. Before this
 *      fix, `getAdminToolState` called `getAdminStateFromEvent` directly —
 *      the OLDER, ADMIN_EMAILS-only resolver `resolveAdminAccessFromEvent`
 *      exists specifically to replace (see request-roles.ts's own doc
 *      comment, and `requireAdminToolAccess`'s QA-W16-3 fix a few lines
 *      below `getAdminToolState` in mcp-artifact-admin.ts, which fixed the
 *      IDENTICAL defect for the destructive/migration tools but did not
 *      reach this sibling gate). A caller who is authenticated but has no
 *      admin tier anywhere is still refused — this is a propagation fix, not
 *      a widening.
 *   2. A caller-supplied field shaped like an auth bypass (`admin: true`,
 *      `principal`, `role`, `bypass`, even `mcpGateAuthenticated`) inside the
 *      tool call's own `input` changes NOTHING — the gate reads only the
 *      server-verified `event`, never `input`.
 */
import '../../../../sites/drlurie/config/policy-bindings.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalBlobStore, setLocalBlobsRootForTesting } from './local-blobs.js';
import { saveMember } from './membership/write.js';
import { personIdForEmail } from './membership/store.js';
import { searchArtifacts } from './mcp-artifact-admin.js';

const STORE_ADMIN_EMAIL = 'store-admin@example.com';
const UNPRIVILEGED_EMAIL = 'no-role@example.com';

const IDENTITIES: Record<string, { id: string; email: string }> = {
  'admin-token': { id: 'user_store_admin', email: STORE_ADMIN_EMAIL },
  'unprivileged-token': { id: 'user_unpriv', email: UNPRIVILEGED_EMAIL },
};

const PLATFORM_VARS = [
  'NETLIFY_SITE_ID',
  'SITE_ID',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'NETLIFY_BLOBS_API_URL',
  'ADMIN_EMAILS',
  'URL',
  'IDENTITY_URL',
  'PUBLISH_SECRET',
  'NETLIFY_PUBLISH_SECRET',
];

const savedEnv: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;
let root: string;

const adminEvent = (bearer: string) => ({ httpMethod: 'POST', headers: { authorization: `Bearer ${bearer}` } });

before(async () => {
  for (const name of PLATFORM_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.URL = 'https://example.test';

  root = await mkdtemp(join(tmpdir(), 'artifact-admin-browse-access-'));
  setLocalBlobsRootForTesting(root);

  // Every gate call in this file passes no Lambda `context`, so admin-auth.ts
  // always takes the bearer + GoTrue `/user` fallback — stub that one hop,
  // routed by the bearer token so different callers resolve different
  // identities.
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = headers.Authorization ?? headers.authorization ?? '';
    const token = raw.replace(/^Bearer\s+/i, '');
    const identity = IDENTITIES[token];
    if (!identity) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify(identity), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const usersStore = createLocalBlobStore('users');
  const now = '2026-09-10T00:00:00.000Z';
  await saveMember(usersStore as never, {
    person: {
      schema_version: 2,
      person_id: personIdForEmail(STORE_ADMIN_EMAIL),
      email: STORE_ADMIN_EMAIL,
      identity: { provider: 'netlify_identity', user_id: 'user_store_admin' },
      display_name: 'Store Admin',
      onboarding: { steps: {} },
      created_at: now,
      updated_at: now,
    },
    membership: {
      schema_version: 2,
      person_id: '',
      site_id: 'site_test',
      role: 'admin',
      status: 'active',
      source: 'invitation',
      granted_by: { kind: 'system', reason: 'test fixture: store-invited admin, not in ADMIN_EMAILS' },
      audit: [],
      created_at: now,
      updated_at: now,
    },
  });
  // No record at all for UNPRIVILEGED_EMAIL: it must resolve to no roles.
});

after(async () => {
  setLocalBlobsRootForTesting(undefined);
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const isError = (result: Awaited<ReturnType<typeof searchArtifacts>>) =>
  (result as { isError?: boolean }).isError === true;

describe("mcp-artifact-admin: browse-access gate propagates the caller's real identity (T-ASSET-IDENTITY Part 1)", () => {
  it('grants search_artifacts to a human whose admin tier comes ONLY from a users-store invite', async () => {
    const result = await searchArtifacts(adminEvent('admin-token') as never, {});
    assert.strictEqual(isError(result), false, `expected access, got: ${JSON.stringify(result.structuredContent)}`);
  });

  it('still refuses a caller with no admin tier anywhere, on the identical call shape', async () => {
    const result = await searchArtifacts(adminEvent('unprivileged-token') as never, {});
    assert.strictEqual(isError(result), true);
    assert.strictEqual((result.structuredContent as { error_code?: string }).error_code, 'admin_required');
  });

  it('refuses a caller with no bearer at all', async () => {
    const result = await searchArtifacts({ httpMethod: 'POST', headers: {} } as never, {});
    assert.strictEqual(isError(result), true);
    assert.strictEqual((result.structuredContent as { error_code?: string }).error_code, 'admin_required');
  });

  it('an auth-bypass-shaped input field changes nothing for an UNPRIVILEGED caller', async () => {
    const event = adminEvent('unprivileged-token');
    const plain = await searchArtifacts(event as never, {});
    const withBypassFields = await searchArtifacts(event as never, {
      admin: true,
      principal: { kind: 'human', email: STORE_ADMIN_EMAIL, roles: ['owner'] },
      role: 'owner',
      bypass: true,
      // A flag that only ever means anything when the SERVER sets it on the
      // event object itself (mcp.ts, after a real /mcp gate check) — placed
      // here inside the tool's own input/args, it must be inert.
      mcpGateAuthenticated: true,
    });

    assert.strictEqual(isError(plain), true);
    assert.strictEqual(isError(withBypassFields), true);
    assert.deepStrictEqual(withBypassFields.structuredContent, plain.structuredContent);
  });

  it('an auth-bypass-shaped input field changes nothing for an AUTHORIZED caller either', async () => {
    const event = adminEvent('admin-token');
    const plain = await searchArtifacts(event as never, {});
    const withBypassFields = await searchArtifacts(event as never, {
      admin: true,
      principal: { kind: 'human', email: STORE_ADMIN_EMAIL },
      role: 'owner',
      bypass: true,
    });

    assert.strictEqual(isError(plain), false);
    assert.strictEqual(isError(withBypassFields), false);
    assert.deepStrictEqual(withBypassFields.structuredContent, plain.structuredContent);
  });
});
