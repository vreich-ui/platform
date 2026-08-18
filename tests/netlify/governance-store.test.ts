/**
 * T9.15 — governance overrides resolution (OQ-W9-2). Security-boundary test:
 * a valid override wins, but an empty / corrupt / partial / unavailable store
 * always falls back to the committed policy (the disaster fallback). An
 * invalid override can never take effect.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11 T11.2: register providers for tests hitting active*/getSiteIdentity
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveActivePolicies,
  putGovernanceDoc,
  getGovernanceDoc,
  GOVERNANCE_DOC_KEY,
  type GovernanceBlobStore,
  type GovernanceDoc,
} from '../../packages/core/server/lib/governance-store.js';
import { activeApprovalPolicy } from '../../packages/core/lib/approval-policy.js';
import { activeCreationPolicy } from '../../packages/core/lib/creation-policy.js';

const memStore = (): GovernanceBlobStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    async get(key) {
      return map.get(key) ?? null;
    },
    async setJSON(key, value) {
      map.set(key, JSON.stringify(value));
    },
  };
};

const doc = (over: Partial<GovernanceDoc> = {}): GovernanceDoc => ({
  schema_version: 'overrides.v1',
  updated_by: 'boss@x.com',
  updated_at: '2026-07-17T00:00:00.000Z',
  history: [],
  ...over,
});

test('empty store → committed policy, provenance committed', async () => {
  const active = await resolveActivePolicies(memStore());
  assert.deepEqual(active.approval, activeApprovalPolicy());
  assert.deepEqual(active.creation, activeCreationPolicy());
  assert.equal(active.learning_mode, false);
  assert.deepEqual(active.provenance, { approval: 'committed', creation: 'committed', learning_mode: 'committed' });
});

test('undefined store → committed policy', async () => {
  const active = await resolveActivePolicies(undefined);
  assert.deepEqual(active.provenance, { approval: 'committed', creation: 'committed', learning_mode: 'committed' });
});

test('a valid approval override wins; creation without an override stays committed', async () => {
  const store = memStore();
  const override = { master: 'all-autonomous', overrides: { content_item: 'require-approval' } } as const;
  await putGovernanceDoc(store, doc({ approval: override }));

  const active = await resolveActivePolicies(store);
  assert.deepEqual(active.approval, override);
  assert.equal(active.provenance.approval, 'override');
  // creation had no override → committed
  assert.deepEqual(active.creation, activeCreationPolicy());
  assert.equal(active.provenance.creation, 'committed');
});

test('learning mode is an explicit override and otherwise remains off', async () => {
  const store = memStore();
  await putGovernanceDoc(store, doc({ learning_mode: true }));
  const active = await resolveActivePolicies(store);
  assert.equal(active.learning_mode, true);
  assert.equal(active.provenance.learning_mode, 'override');
});

test('a legacy chat-mode field still parses but cannot affect active policies', async () => {
  const store = memStore();
  await putGovernanceDoc(store, doc({ cms_agent_chat_mode: 'off', learning_mode: true }));
  assert.equal((await getGovernanceDoc(store))?.cms_agent_chat_mode, 'off');
  const active = await resolveActivePolicies(store);
  assert.equal('cms_agent_chat_mode' in active, false);
  assert.equal(active.learning_mode, true, 'unrelated policy data remains active');
});

test('a corrupt governance doc falls back to committed (never applies)', async () => {
  const store = memStore();
  store.map.set(GOVERNANCE_DOC_KEY, '{ not json');
  assert.equal(await getGovernanceDoc(store), null);
  const active = await resolveActivePolicies(store);
  assert.deepEqual(active.provenance, { approval: 'committed', creation: 'committed', learning_mode: 'committed' });
});

test('a doc with an INVALID override shape is rejected on read → committed stands', async () => {
  const store = memStore();
  // master is not a valid enum value — schema rejects the whole doc
  store.map.set(
    GOVERNANCE_DOC_KEY,
    JSON.stringify({
      schema_version: 'overrides.v1',
      approval: { master: 'anything-goes', overrides: {} },
      updated_by: 'x',
      updated_at: 't',
      history: [],
    })
  );
  const active = await resolveActivePolicies(store);
  assert.equal(active.provenance.approval, 'committed');
});

test('a store read that throws degrades to committed', async () => {
  const throwing: GovernanceBlobStore = {
    get: () => Promise.reject(new Error('down')),
    setJSON: async () => {},
  };
  const active = await resolveActivePolicies(throwing);
  assert.deepEqual(active.provenance, { approval: 'committed', creation: 'committed', learning_mode: 'committed' });
});
