/**
 * `handleGenesisPolicyVerb` (Wolf, 2026-09-09) — the gate and the store round
 * trip for the fleet genesis-policy lever.
 *
 * The /mcp wiring (which principals see the tools at all, and what a
 * shared-token call gets back) is proved end-to-end in
 * `tests/netlify/mcp-oauth.test.ts` beside the membership family's own
 * evidence, because that is a statement about ONE pair of tool listings. What
 * is proved here is the core's own contract, in isolation from a live handler:
 * agents refused before any store read, non-Owners refused on the write, a
 * malformed policy refused rather than half-applied, and a successful set
 * landing in the EXISTING governance document rather than a store of its own.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { handleGenesisPolicyVerb } from './genesis-policy-verbs.js';
import { GOVERNANCE_DOC_KEY, type GovernanceBlobStore } from './governance-store.js';
import type { UsersBlobStore } from './users-store.js';

const memoryStore = (seed: Record<string, unknown> = {}) => {
  const blobs = new Map<string, string>(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    blobs,
    store: {
      get: async (key: string) => blobs.get(key) ?? null,
      setJSON: async (key: string, value: unknown) => {
        blobs.set(key, JSON.stringify(value));
      },
      list: () => ({ blobs: [] }),
    } as unknown as GovernanceBlobStore & UsersBlobStore,
  };
};

const OWNER = { kind: 'human' as const, id: 'u1', email: 'owner@example.com' };
const env = { ADMIN_EMAILS: 'owner@example.com', ROLE_EMAILS_EDITOR: 'editor@example.com' };

const call = (
  verb: 'get' | 'set',
  args: Record<string, unknown>,
  principal: { kind: 'human' | 'agent'; id?: string; email?: string; agent_name?: string },
  stores = memoryStore()
) =>
  handleGenesisPolicyVerb({
    verb,
    args,
    principal,
    deps: { governance: stores.store, users: stores.store, env, now: () => '2026-09-09T00:00:00.000Z' },
  }).then((result) => ({ result, stores }));

describe('genesis-policy verbs', () => {
  it('refuses an agent principal before any store read', async () => {
    const stores = memoryStore();
    let reads = 0;
    const spying = {
      ...stores,
      store: new Proxy(stores.store, {
        get(target, prop, receiver) {
          if (prop === 'get') reads += 1;
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }) as GovernanceBlobStore & UsersBlobStore,
    };
    const { result } = await call('get', {}, { kind: 'agent', agent_name: 'client_manager' }, spying);
    assert.strictEqual(result.status, 403);
    assert.strictEqual(result.body.error_code, 'genesis_policy_requires_human');
    assert.strictEqual(reads, 0, 'the gate must come before any store access');
  });

  it('a human with no verified email is refused the same way', async () => {
    const { result } = await call('get', {}, { kind: 'human', id: 'u9', email: '  ' });
    assert.strictEqual(result.status, 403);
    assert.strictEqual(result.body.error_code, 'genesis_policy_requires_human');
  });

  it('get returns the committed fleet default, the vocabulary and the refusal contract', async () => {
    const { result } = await call('get', {}, OWNER);
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual((result.body.committed as { requiredArtifacts: string[] }).requiredArtifacts, []);
    assert.strictEqual(result.body.override, null);
    assert.strictEqual(result.body.provenance, 'committed');
    assert.strictEqual((result.body.input_fields as Record<string, string>).editorial_strategy, 'editorialStrategy');
    assert.strictEqual(
      (result.body.refusal_contract as { error_code: string }).error_code,
      'genesis_artifact_required'
    );
  });

  it('a non-Owner Admin may read but not write', async () => {
    const admin = { kind: 'human' as const, id: 'u2', email: 'admin@example.com' };
    const adminEnv = { ...env, ROLE_EMAILS_ADMIN: 'admin@example.com' };
    const stores = memoryStore();
    const read = await handleGenesisPolicyVerb({
      verb: 'get',
      args: {},
      principal: admin,
      deps: { governance: stores.store, users: stores.store, env: adminEnv },
    });
    assert.strictEqual(read.status, 200);
    const write = await handleGenesisPolicyVerb({
      verb: 'set',
      args: { requiredArtifacts: ['editorial_strategy'] },
      principal: admin,
      deps: { governance: stores.store, users: stores.store, env: adminEnv },
    });
    assert.strictEqual(write.status, 403);
    assert.strictEqual(write.body.error_code, 'owner_required');
  });

  it('an editor is refused outright — Admin is the floor even for the read', async () => {
    const { result } = await call('get', {}, { kind: 'human', id: 'u3', email: 'editor@example.com' });
    assert.strictEqual(result.status, 403);
    assert.strictEqual(result.body.error_code, 'admin_required');
  });

  it('set validates with the committed-config schema and refuses a bad artifact without writing', async () => {
    const { result, stores } = await call('set', { requiredArtifacts: ['editorial_stratgy'] }, OWNER);
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error_code, 'invalid_args');
    assert.ok(Array.isArray(result.body.artifacts), 'the refusal hands back the closed enum');
    assert.strictEqual(stores.blobs.get(GOVERNANCE_DOC_KEY), undefined, 'nothing was written');
  });

  it('set lands in the EXISTING governance document, with a history entry, and reads back as an override', async () => {
    const stores = memoryStore();
    const { result } = await call('set', { requiredArtifacts: ['editorial_strategy', 'logo'] }, OWNER, stores);
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual((result.body.effective as { requiredArtifacts: string[] }).requiredArtifacts, [
      'editorial_strategy',
      'logo',
    ]);
    assert.strictEqual(result.body.provenance, 'override');
    // The committed layer is untouched — the whole point of the two layers.
    assert.deepStrictEqual((result.body.committed as { requiredArtifacts: string[] }).requiredArtifacts, []);

    const doc = JSON.parse(stores.blobs.get(GOVERNANCE_DOC_KEY)!) as {
      schema_version: string;
      genesis: { requiredArtifacts: string[] };
      history: Array<{ action: string; detail: string; actor_email: string }>;
    };
    assert.strictEqual(doc.schema_version, 'overrides.v1', 'no new store, no new document kind');
    assert.deepStrictEqual(doc.genesis.requiredArtifacts, ['editorial_strategy', 'logo']);
    assert.strictEqual(doc.history.at(-1)?.actor_email, 'owner@example.com');
    assert.match(doc.history.at(-1)!.detail, /genesis\.requiredArtifacts=\[editorial_strategy, logo\]/);

    const { result: reread } = await call('get', {}, OWNER, stores);
    assert.deepStrictEqual((reread.body.override as { requiredArtifacts: string[] }).requiredArtifacts, [
      'editorial_strategy',
      'logo',
    ]);
  });

  it('set replaces rather than merges — an empty list clears the requirement', async () => {
    const stores = memoryStore();
    await call('set', { requiredArtifacts: ['logo'] }, OWNER, stores);
    const { result } = await call('set', { requiredArtifacts: [] }, OWNER, stores);
    assert.deepStrictEqual((result.body.effective as { requiredArtifacts: string[] }).requiredArtifacts, []);
  });
});
