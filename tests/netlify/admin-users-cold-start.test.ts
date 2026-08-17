import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/admin-users.js';
import {
  getUserRecord,
  listUserRecords,
  putUserRecord,
  type UsersBlobStore,
} from '../../packages/core/server/lib/users-store.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';

const ROLE_ENV_KEYS = ['ADMIN_EMAILS', 'ROLE_EMAILS_ADMIN', 'ROLE_EMAILS_PUBLISHER', 'ROLE_EMAILS_EDITOR'] as const;

const memStore = (): UsersBlobStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    async get(key) {
      return map.get(key) ?? null;
    },
    async setJSON(key, value) {
      map.set(key, JSON.stringify(value));
    },
    async list({ prefix }) {
      return { blobs: [...map.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
};

const withUsersStore = async (
  env: Partial<Record<(typeof ROLE_ENV_KEYS)[number], string>>,
  fn: (store: ReturnType<typeof memStore>) => Promise<void>
) => {
  const savedEnv = [...ROLE_ENV_KEYS, 'NETLIFY', 'NETLIFY_SITE_ID'].map((key) => [key, process.env[key]] as const);
  const store = memStore();

  for (const key of ROLE_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  process.env.NETLIFY = 'true';
  delete process.env.NETLIFY_SITE_ID;

  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore() {
      return store as never;
    },
  });

  try {
    await fn(store);
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const contextFor = (email: string, sub = 'user-1') => ({ clientContext: { user: { sub, email } } });
const post = (verb: string, fields: Record<string, unknown> = {}) => ({
  httpMethod: 'POST',
  body: JSON.stringify({ verb, ...fields }),
});

test('me persists a bootstrap Owner exactly once with an activation audit entry', async () => {
  await withUsersStore({ ADMIN_EMAILS: ' Boss@Example.com ' }, async (store) => {
    const first = await handler(post('me'), contextFor('boss@example.com', 'gotrue-owner'));
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.equal(firstBody.user.email, 'boss@example.com');
    assert.equal(firstBody.user.role, 'owner');
    assert.equal(firstBody.user.user_id, 'gotrue-owner');
    assert.equal(
      firstBody.user.audit.filter((entry: { action: string }) => entry.action === 'bootstrap_activate').length,
      1
    );

    const second = await handler(post('me'), contextFor('boss@example.com', 'gotrue-owner'));
    assert.equal(second.statusCode, 200);
    const persisted = await getUserRecord(store, 'boss@example.com');
    assert.equal(persisted?.audit.filter((entry) => entry.action === 'bootstrap_activate').length, 1);
    // T18.1: one MEMBER (v2 = person + membership + two index pointers), not one blob
    assert.equal((await listUserRecords(store)).length, 1);
  });
});

test('list merges and deduplicates environment principals with their effective role and source', async () => {
  await withUsersStore(
    {
      ADMIN_EMAILS: 'boss@example.com',
      ROLE_EMAILS_ADMIN: 'ADMIN@example.com, boss@example.com',
      ROLE_EMAILS_PUBLISHER: 'stored@example.com, publisher@example.com',
      ROLE_EMAILS_EDITOR: 'editor@example.com, PUBLISHER@example.com',
    },
    async (store) => {
      await putUserRecord(store, {
        schema_version: 1,
        email: 'stored@example.com',
        display_name: 'Stored Member',
        role: 'admin',
        status: 'active',
        invited_by: 'boss@example.com',
        created_at: '2026-08-07T00:00:00.000Z',
        updated_at: '2026-08-07T00:00:00.000Z',
        audit: [],
      });

      const response = await handler(post('list'), contextFor('boss@example.com'));
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as {
        users: Array<{ email: string; role: string; source: string; display_name: string }>;
      };
      assert.deepEqual(
        body.users.map(({ email, role, source }) => ({ email, role, source })),
        [
          { email: 'admin@example.com', role: 'admin', source: 'environment' },
          { email: 'boss@example.com', role: 'owner', source: 'environment' },
          { email: 'editor@example.com', role: 'editor', source: 'environment' },
          { email: 'publisher@example.com', role: 'publisher', source: 'environment' },
          { email: 'stored@example.com', role: 'admin', source: 'environment' },
        ]
      );
      assert.equal(body.users.find((user) => user.email === 'stored@example.com')?.display_name, 'Stored Member');
    }
  );
});

test('environment rows are immutable server-side while the self guard remains first', async () => {
  await withUsersStore(
    { ADMIN_EMAILS: 'boss@example.com', ROLE_EMAILS_EDITOR: 'editor@example.com' },
    async (store) => {
      await putUserRecord(store, {
        schema_version: 1,
        email: 'editor@example.com',
        display_name: 'Environment Editor',
        role: 'admin',
        status: 'active',
        invited_by: 'boss@example.com',
        created_at: '2026-08-07T00:00:00.000Z',
        updated_at: '2026-08-07T00:00:00.000Z',
        audit: [],
      });

      const environmentMutation = await handler(
        post('disable', { email: 'editor@example.com' }),
        contextFor('boss@example.com')
      );
      assert.equal(environmentMutation.statusCode, 409);
      assert.match(JSON.parse(environmentMutation.body).error, /environment variables/i);

      const environmentInvite = await handler(
        post('invite', { email: 'editor@example.com', role: 'owner' }),
        contextFor('boss@example.com')
      );
      assert.equal(environmentInvite.statusCode, 409);
      assert.match(JSON.parse(environmentInvite.body).error, /environment variables/i);

      const selfMutation = await handler(
        post('set_role', { email: 'boss@example.com', role: 'admin' }),
        contextFor('boss@example.com')
      );
      assert.equal(selfMutation.statusCode, 409);
      assert.match(JSON.parse(selfMutation.body).error, /own role or status/i);
      assert.equal((await getUserRecord(store, 'editor@example.com'))?.status, 'active');
    }
  );
});
