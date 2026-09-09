/**
 * W8.3b — the creation-policy seam: who may CREATE objects of each type.
 *
 * Resolution unit tests (the approval-policy twin: override → master →
 * committed default 'open'; humans always create) plus verb-level enforcement
 * through the real handler — including the recursion paths (instantiate
 * creates a PAGE; a standalone stamp creates a SECTION) and the deliberate
 * non-gates (page-mode stamping and theme application are patches).
 *
 * ⚠️ agent_name is self-declared until OQ-3 — these tests pin the seam's
 * mechanics, not a security boundary.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11 T11.2: register providers for tests hitting active*/getSiteIdentity
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleObjectVerb,
  type ObjectVerbRequest,
  type ObjectVerbStore,
} from '../../packages/core/server/lib/object-verbs.js';
import { creationPolicyConfig } from '../../sites/drlurie/config/creation-policy.js';
import {
  activeCreationPolicy,
  creationRuleFor,
  isCreationAllowed,
  resolveCreationPolicy,
  type CreationPolicy,
} from '../../packages/core/lib/creation-policy.js';
import type { Principal } from '../../packages/core/schema/object-record-v1.js';

const NOW = Date.parse('2026-07-14T12:00:00.000Z');
const HUMAN: Principal = { kind: 'human', id: 'u1', email: 'wolf@example.com' };
const BUILDER: Principal = { kind: 'agent', agent_name: 'site-builder', auth: 'publish_key' };
const STRANGER: Principal = { kind: 'agent', agent_name: 'some-other-agent', auth: 'publish_key' };

const OPEN: CreationPolicy = { master: 'open', overrides: {} };
const TEMPLATES_RESTRICTED: CreationPolicy = {
  master: 'open',
  overrides: { template: { agents: ['site-builder'] }, section_template: { agents: ['site-builder'] } },
};

// ═══ resolution ════════════════════════════════════════════════════════

test('the committed config parses: open master, the two singletons human/seed-only (W13, D1)', () => {
  const policy = resolveCreationPolicy(creationPolicyConfig);
  // T13.10: the conversion-factory driver is the ONE named seed identity —
  // "seeds mint" (OQ-W13-2) made concrete; casual agents stay excluded.
  // D1 (2026-07-28): editorial_voice joins tracking_config on the same rule —
  // agents EDIT the site's declared voice, they never mint a second one.
  assert.deepEqual(policy, {
    master: 'open',
    overrides: {
      tracking_config: { agents: ['object-conversion-roundtrip'] },
      editorial_voice: { agents: ['object-conversion-roundtrip'] },
      // Wolf 2026-09-09: editorial_strategy joins the same rule.
      editorial_strategy: { agents: ['object-conversion-roundtrip'] },
    },
  });
  assert.deepEqual(activeCreationPolicy(), policy);
});

test('a malformed config THROWS instead of silently resolving to the permissive default', () => {
  assert.throws(() => resolveCreationPolicy(undefined), /Invalid creation-policy config/);
  assert.throws(() => resolveCreationPolicy({ master: 'open' }), /Invalid creation-policy config/);
  assert.throws(
    () => resolveCreationPolicy({ master: 'open', overrides: { templte: { agents: ['x'] } } }),
    /Invalid creation-policy config/,
    'a typo in an override key must fail the parse, never silently do nothing'
  );
  // W13: an EMPTY allowlist is LEGAL and means "no agents at all" — the
  // tracking_config posture (humans/seeds mint; agents only edit).
  const emptyList = resolveCreationPolicy({ master: 'open', overrides: { template: { agents: [] } } });
  assert.deepEqual(emptyList.overrides.template, { agents: [] });
});

test('resolution: humans always; agents resolve override → master; ungoverned types open', () => {
  assert.equal(isCreationAllowed('template', HUMAN, TEMPLATES_RESTRICTED), true, 'humans always create');
  assert.equal(isCreationAllowed('template', BUILDER, TEMPLATES_RESTRICTED), true, 'allowlisted agent');
  assert.equal(isCreationAllowed('template', STRANGER, TEMPLATES_RESTRICTED), false, 'unlisted agent');
  assert.equal(isCreationAllowed('page', STRANGER, TEMPLATES_RESTRICTED), true, 'unrestricted type stays open');
  assert.equal(isCreationAllowed('theme', STRANGER, OPEN), true, 'open master');
  const allowlistMaster: CreationPolicy = { master: { agents: ['site-builder'] }, overrides: { page: 'open' } };
  assert.equal(isCreationAllowed('theme', STRANGER, allowlistMaster), false, 'allowlist master gates');
  assert.equal(isCreationAllowed('page', STRANGER, allowlistMaster), true, 'per-type open override beats it');
  assert.deepEqual(creationRuleFor('template', TEMPLATES_RESTRICTED), { agents: ['site-builder'] });
});

// ═══ verb-level enforcement ═════════════════════════════════════════════

const createMemoryStore = () => {
  const blobs = new Map<string, string>();
  return {
    blobs,
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      blobs.set(key, JSON.stringify(value));
    },
    async list({ prefix }: { prefix: string }) {
      return { blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
};
type Store = ReturnType<typeof createMemoryStore>;

const call = (
  store: Store,
  request: ObjectVerbRequest,
  principal: Principal,
  creationPolicy: CreationPolicy = TEMPLATES_RESTRICTED
) => handleObjectVerb(store as unknown as ObjectVerbStore, request, principal, { nowMs: NOW, creationPolicy });

const templateBody = () => ({
  name: 'Probe recipe',
  description: 'A probe recipe.',
  whenToUse: 'Never — test fixture.',
  scope: 'one_off',
  appliesTo: ['standard'],
  slots: [],
});

const stplBody = () => ({
  name: 'Probe stamp',
  description: 'A probe stamp.',
  whenToUse: 'Never — test fixture.',
  scope: 'one_off',
  blueprint: { id: 's_bp', type: 'cta_banner', data: { heading: 'Go', actions: [] } },
});

test('create: an unlisted agent gets a 403 creation_restricted and the store stays untouched', async () => {
  const store = createMemoryStore();
  const res = await call(
    store,
    {
      action: 'create',
      object_type: 'template',
      site: 'site_drlurie',
      body: templateBody(),
      requested_id: 'tpl_probe',
    },
    STRANGER
  );
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.code, 'creation_restricted');
  assert.deepEqual(res.body.allowed_agents, ['site-builder']);
  assert.equal(store.blobs.size, 0, 'nothing persisted — the gate runs before minting/existence probing');
});

test('create: the allowlisted agent and any human pass; the default committed policy stays fully open', async () => {
  const store = createMemoryStore();
  const asBuilder = await call(
    store,
    { action: 'create', object_type: 'template', site: 'site_drlurie', body: templateBody(), requested_id: 'tpl_a' },
    BUILDER
  );
  assert.equal(asBuilder.status, 200, JSON.stringify(asBuilder.body));
  const asHuman = await call(
    store,
    { action: 'create', object_type: 'template', site: 'site_drlurie', body: templateBody(), requested_id: 'tpl_b' },
    HUMAN
  );
  assert.equal(asHuman.status, 200, JSON.stringify(asHuman.body));
  const defaultPolicy = await call(
    store,
    { action: 'create', object_type: 'template', site: 'site_drlurie', body: templateBody(), requested_id: 'tpl_c' },
    STRANGER,
    activeCreationPolicy()
  );
  assert.equal(defaultPolicy.status, 200, 'the committed config restricts nothing');
});

test('recursion: instantiate is gated as a PAGE create (restricting template restricts minting, not using)', async () => {
  const store = createMemoryStore();
  await call(
    store,
    {
      action: 'create',
      object_type: 'template',
      site: 'site_drlurie',
      body: templateBody(),
      requested_id: 'tpl_probe',
    },
    BUILDER
  );

  // template restricted, page open → any agent instantiates.
  const usesOk = await call(
    store,
    {
      action: 'instantiate',
      template_id: 'tpl_probe',
      site: 'site_drlurie',
      route: '/probe',
      title: 'P',
      dry_run: true,
    },
    STRANGER
  );
  assert.equal(usesOk.status, 200, JSON.stringify(usesOk.body));

  // page restricted → instantiate blocked for unlisted agents, dry_run included.
  const pageRestricted: CreationPolicy = { master: 'open', overrides: { page: { agents: ['site-builder'] } } };
  const blocked = await call(
    store,
    {
      action: 'instantiate',
      template_id: 'tpl_probe',
      site: 'site_drlurie',
      route: '/probe',
      title: 'P',
      dry_run: true,
    },
    STRANGER,
    pageRestricted
  );
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.object_type, 'page');
});

test('recursion: a standalone stamp is gated as a SECTION create; page-mode stamping is a patch and is NOT gated', async () => {
  const store = createMemoryStore();
  await call(
    store,
    {
      action: 'create',
      object_type: 'section_template',
      site: 'site_drlurie',
      body: stplBody(),
      requested_id: 'stpl_probe',
    },
    BUILDER
  );
  await call(
    store,
    {
      action: 'create',
      object_type: 'page',
      site: 'site_drlurie',
      body: {
        route: '/probe',
        pageType: 'standard',
        title: 'P',
        seo: {},
        sections: [{ id: 's_lede', type: 'lede', data: { heading: 'Open', actions: [] } }],
      },
      requested_id: 'page_probe',
    },
    HUMAN
  );

  const sectionRestricted: CreationPolicy = { master: 'open', overrides: { section: { agents: ['site-builder'] } } };
  const standaloneBlocked = await call(
    store,
    { action: 'instantiate_section', section_template_id: 'stpl_probe', target: { kind: 'standalone' }, dry_run: true },
    STRANGER,
    sectionRestricted
  );
  assert.equal(standaloneBlocked.status, 403);
  assert.equal(standaloneBlocked.body.object_type, 'section');

  // Page-mode dry_run stamps a PATCH op — deliberately outside the creation gate.
  const pageModeOk = await call(
    store,
    {
      action: 'instantiate_section',
      section_template_id: 'stpl_probe',
      target: { kind: 'page', page_id: 'page_probe' },
      dry_run: true,
    },
    STRANGER,
    sectionRestricted
  );
  assert.equal(pageModeOk.status, 200, JSON.stringify(pageModeOk.body));
});

test('recursion: create_variant is gated as a content_item create (dry_run included)', async () => {
  const store = createMemoryStore();
  // No source needed: the pre-check fires before the source load.
  const restricted: CreationPolicy = { master: 'open', overrides: { content_item: { agents: ['site-builder'] } } };
  const res = await call(
    store,
    {
      action: 'create_variant',
      object_type: 'content_item',
      source_object_id: 'req_agent_probe_20260714_01',
      dry_run: true,
    },
    STRANGER,
    restricted
  );
  assert.equal(res.status, 403);
  assert.equal(res.body.object_type, 'content_item');
});

test('the 403 points at reuse: the error names object_inventory and the recipe summaries', async () => {
  const store = createMemoryStore();
  const res = await call(
    store,
    { action: 'create', object_type: 'template', site: 'site_drlurie', body: templateBody() },
    STRANGER
  );
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /REUSE FIRST/);
  assert.match(String(res.body.error), /object_inventory/);
});
