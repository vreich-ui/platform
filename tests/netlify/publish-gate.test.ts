import '../../sites/drlurie/config/policy-bindings.js'; // W11 T11.2: register providers for tests hitting active*/getSiteIdentity
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkinObjectLock, checkoutObjectLock } from '../../packages/core/server/lib/object-lock.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import {
  checkPublishGate,
  type PublishGateResult,
  type RequestedPublishAction,
} from '../../packages/core/server/lib/publish-gate.js';
import {
  canDecideReview,
  canExecutePublish,
  resolveHumanRoles,
  resolveRolesForPrincipal,
  type Role,
} from '../../packages/core/server/lib/roles.js';
import { approvalPolicyConfig } from '../../sites/drlurie/config/approval-policy.js';
import {
  activeApprovalPolicy,
  governedObjectTypes,
  publishRequiresApproval,
  resolveApprovalPolicy,
  type ApprovalPolicy,
  type GovernedObjectType,
} from '../../packages/core/lib/approval-policy.js';
import { applyPatchOps } from '../../packages/core/lib/object-patch-apply.js';
import type { ObjectRecord, ObjectType, Principal, ReviewState } from '../../packages/core/schema/object-record-v1.js';

// The configurable-approval-policy gate matrix. Hand-written truth tables
// throughout — deliberately NOT computed from the gate's own logic, so a
// gate bug cannot silently rewrite the expectations. This suite is the
// permanent regression home for:
//   1. every master × override × type combination (both directions),
//   2. the preserved T1.4 approval logic on gated types (approval states,
//      M-6 pin exactness, content_revision invalidation, counter
//      independence from lock ops and the publish stamp),
//   3. the audit-independence guarantee cannot regress silently at the gate
//      layer (autonomous allows carry no approval, and the wiring tests in
//      object-verbs-review.test.ts prove the history side),
//   4. the committed config itself (parses; dev-stage default is
//      all-autonomous with product pinned to require-approval — the §0.4
//      commerce gate),
//   5. config changes — and only config changes — flipping behavior.

const AT = '2026-07-04T12:00:00.000Z';
const NOW = Date.parse(AT);

const humanActor: Principal = { kind: 'human', id: 'u1', email: 'wolf@example.com' };
const agentActor: Principal = { kind: 'agent', agent_name: 'codex', auth: 'publish_key' };

const ALL_AUTONOMOUS: ApprovalPolicy = { master: 'all-autonomous', overrides: {} };
const ALL_REQUIRE: ApprovalPolicy = { master: 'all-require-approval', overrides: {} };
const gateOne = (objectType: GovernedObjectType, mode: 'require-approval' | 'autonomous'): ApprovalPolicy => ({
  master: mode === 'require-approval' ? 'all-autonomous' : 'all-require-approval',
  overrides: { [objectType]: mode },
});

const OBJECT_IDS: Record<GovernedObjectType, string> = {
  page: 'page_home',
  section: 'sec_cta',
  navigation: 'nav_footer',
  taxonomy: 'tax_drlurie',
  site: 'site_drlurie',
  template: 'tpl_home',
  section_template: 'stpl_hero_landing',
  theme: 'thm_drlurie_default',
  product: 'prod_barrier_repair_guide',
  content_item: 'req_agent_probe_20260713_01',
  tracking_config: 'trk_drlurie',
  editorial_voice: 'voice_drlurie',
  editorial_strategy: 'strat_drlurie',
};

const approveDecision = (contentRevision: number, publishAction?: { published_time: string | null }) => ({
  at: AT,
  by: humanActor,
  decision: 'approve' as const,
  ...(publishAction !== undefined ? { publish_action: publishAction } : {}),
  content_revision: contentRevision,
});

const baseRecord = (objectType: ObjectType, objectId: string, review?: ReviewState): ObjectRecord => ({
  object_id: objectId,
  object_type: objectType,
  schema_version: `${objectType}.v1`,
  site: 'site_drlurie',
  created_at: AT,
  updated_at: AT,
  status: 'active',
  body: {},
  publication: { published_time: null },
  ...(review !== undefined ? { review } : {}),
  history: [{ at: AT, action: 'object_create', actor: humanActor }],
  version: 7,
  content_revision: 2,
});

// ─── the committed config: the dev-stage default posture, pinned ─────────────

test('the committed config parses and is the dev-stage default: all-autonomous, product + editorial_voice pinned', () => {
  const policy = resolveApprovalPolicy(approvalPolicyConfig);
  // Commerce never publishes without a human eye (06-shop-module-plan §0.4).
  // D1 (2026-07-28) adds the second deliberate exception: the declared
  // editorial voice governs every future article on the site, so one silent
  // change moves all downstream output at once — the same class of risk as a
  // price going live unseen. Both are POSTURES, flippable in this one file.
  const GATED: readonly GovernedObjectType[] = ['product', 'editorial_voice'];
  assert.deepEqual(policy, {
    master: 'all-autonomous',
    overrides: { product: 'require-approval', editorial_voice: 'require-approval' },
  });
  assert.deepEqual(activeApprovalPolicy(), policy);
  for (const objectType of governedObjectTypes) {
    assert.equal(
      publishRequiresApproval(objectType, policy),
      GATED.includes(objectType),
      GATED.includes(objectType) ? `${objectType} must require approval` : `${objectType} must default to autonomous`
    );
  }
});

test('a malformed config THROWS instead of silently resolving to the permissive default', () => {
  assert.throws(() => resolveApprovalPolicy(undefined), /Invalid approval-policy config/);
  assert.throws(() => resolveApprovalPolicy({ master: 'autonomous', overrides: {} }), /Invalid approval-policy config/);
  assert.throws(() => resolveApprovalPolicy({ master: 'all-autonomous' }), /Invalid approval-policy config/);
  assert.throws(
    () => resolveApprovalPolicy({ master: 'all-autonomous', overrides: { navigaton: 'require-approval' } }),
    /Invalid approval-policy config/,
    'a typo in an override key must fail the parse, never silently do nothing'
  );
  // content_item is governable since W7.3 — a pin on it is a VALID config.
  assert.equal(
    resolveApprovalPolicy({ master: 'all-autonomous', overrides: { content_item: 'require-approval' } }).overrides
      .content_item,
    'require-approval'
  );
  assert.throws(
    () => resolveApprovalPolicy({ master: 'all-autonomous', overrides: { page: 'gated' } }),
    /Invalid approval-policy config/
  );
});

// ─── resolution order: override → master → (config default) ─────────────────

test('resolution: per-type override beats the master switch, in both directions, for every type', () => {
  for (const objectType of governedObjectTypes) {
    const gated = gateOne(objectType, 'require-approval'); // master all-autonomous
    const freed = gateOne(objectType, 'autonomous'); // master all-require-approval
    assert.equal(publishRequiresApproval(objectType, gated), true, `${objectType} override→require must gate`);
    assert.equal(publishRequiresApproval(objectType, freed), false, `${objectType} override→autonomous must free`);
    for (const other of governedObjectTypes) {
      if (other === objectType) continue;
      assert.equal(publishRequiresApproval(other, gated), false, `${other} must stay on master all-autonomous`);
      assert.equal(publishRequiresApproval(other, freed), true, `${other} must stay on master all-require-approval`);
    }
  }
});

test('resolution: unconfigured types follow the master switch, for every type', () => {
  for (const objectType of governedObjectTypes) {
    assert.equal(publishRequiresApproval(objectType, ALL_AUTONOMOUS), false);
    assert.equal(publishRequiresApproval(objectType, ALL_REQUIRE), true);
  }
});

// ─── gate matrix per policy cell ─────────────────────────────────────────────
//
// Approval-state fixtures: record content_revision is 2 in every fixture;
// requests omit published_time unless a test says otherwise.

type ApprovalKey =
  | 'none'
  | 'open'
  | 'changes_requested'
  | 'approved_current_pin_match'
  | 'approved_current_pin_mismatch'
  | 'approved_current_no_pin'
  | 'approved_stale';

const APPROVALS: Record<ApprovalKey, ReviewState | undefined> = {
  none: undefined,
  open: { state: 'open', decisions: [] },
  changes_requested: {
    state: 'changes_requested',
    decisions: [{ at: AT, by: humanActor, decision: 'request_changes', content_revision: 2 }],
  },
  approved_current_pin_match: {
    state: 'approved',
    decisions: [approveDecision(2, { published_time: 'immediate' })],
  },
  approved_current_pin_mismatch: {
    state: 'approved',
    decisions: [approveDecision(2, { published_time: '2026-07-05T09:00:00.000Z' })],
  },
  approved_current_no_pin: { state: 'approved', decisions: [approveDecision(2)] },
  approved_stale: { state: 'approved', decisions: [approveDecision(1, { published_time: 'immediate' })] },
};

type PrincipalKey = 'agent' | 'human_admin' | 'human_publisher' | 'human_editor' | 'human_norole';
const PRINCIPALS: Record<PrincipalKey, { principal: Principal; roles: Role[] }> = {
  agent: { principal: agentActor, roles: [] },
  human_admin: { principal: humanActor, roles: ['admin'] },
  human_publisher: { principal: humanActor, roles: ['publisher'] },
  human_editor: { principal: humanActor, roles: ['editor'] },
  human_norole: { principal: humanActor, roles: [] },
};

type Expected = 'allow' | NonNullable<Extract<PublishGateResult, { allow: false }>>['code'];

const runCell = (
  objectType: ObjectType,
  objectId: string,
  principalKey: PrincipalKey,
  approvalKey: ApprovalKey,
  policy: ApprovalPolicy
) => {
  const { principal, roles } = PRINCIPALS[principalKey];
  return checkPublishGate({
    record: baseRecord(objectType, objectId, APPROVALS[approvalKey]),
    principal,
    roles,
    requested: {},
    policy,
  });
};

const assertCell = (result: PublishGateResult, expected: Expected, label: string) => {
  if (expected === 'allow') {
    assert.equal(result.allow, true, `${label}: ${JSON.stringify(result)}`);
  } else {
    assert.equal(result.allow, false, `${label}: expected denial ${expected}, got allow`);
    assert.equal(result.allow === false && result.code, expected, label);
    assert.equal(result.allow === false && result.status, 403, label);
  }
};

// The AUTONOMOUS truth table: approval state is irrelevant BY DESIGN — the
// policy switch means what it says; only human publish authority gates.
const AUTONOMOUS_MATRIX: Array<[PrincipalKey, Expected]> = [
  ['agent', 'allow'],
  ['human_admin', 'allow'],
  ['human_publisher', 'allow'],
  ['human_editor', 'publish_role_required'],
  ['human_norole', 'publish_role_required'],
];

// The GATED truth table — T1.4's approval logic, preserved verbatim
// (agents now execute after approval on EVERY gated type; the old Tier 3
// human-execution rule no longer exists).
const GATED_MATRIX: Array<[PrincipalKey, ApprovalKey, Expected]> = [
  ['agent', 'none', 'approval_required'],
  ['agent', 'open', 'approval_required'],
  ['agent', 'changes_requested', 'changes_requested'],
  ['agent', 'approved_current_pin_match', 'allow'],
  ['agent', 'approved_current_pin_mismatch', 'publish_action_mismatch'],
  ['agent', 'approved_current_no_pin', 'publish_action_not_pinned'],
  ['agent', 'approved_stale', 'approval_stale'],
  ['human_admin', 'none', 'approval_required'],
  ['human_admin', 'open', 'approval_required'],
  ['human_admin', 'changes_requested', 'changes_requested'],
  ['human_admin', 'approved_current_pin_match', 'allow'],
  ['human_admin', 'approved_current_pin_mismatch', 'allow'], // pin binds agents, not humans (C§2.2)
  ['human_admin', 'approved_current_no_pin', 'allow'],
  ['human_admin', 'approved_stale', 'approval_stale'],
  ['human_publisher', 'none', 'approval_required'],
  ['human_publisher', 'open', 'approval_required'],
  ['human_publisher', 'changes_requested', 'changes_requested'],
  ['human_publisher', 'approved_current_pin_match', 'allow'],
  ['human_publisher', 'approved_current_pin_mismatch', 'allow'],
  ['human_publisher', 'approved_current_no_pin', 'allow'],
  ['human_publisher', 'approved_stale', 'approval_stale'],
  ['human_editor', 'none', 'approval_required'],
  ['human_editor', 'open', 'approval_required'],
  ['human_editor', 'changes_requested', 'changes_requested'],
  ['human_editor', 'approved_current_pin_match', 'publish_role_required'],
  ['human_editor', 'approved_current_pin_mismatch', 'publish_role_required'],
  ['human_editor', 'approved_current_no_pin', 'publish_role_required'],
  ['human_editor', 'approved_stale', 'approval_stale'],
  ['human_norole', 'none', 'approval_required'],
  ['human_norole', 'open', 'approval_required'],
  ['human_norole', 'changes_requested', 'changes_requested'],
  ['human_norole', 'approved_current_pin_match', 'publish_role_required'],
  ['human_norole', 'approved_current_pin_mismatch', 'publish_role_required'],
  ['human_norole', 'approved_current_no_pin', 'publish_role_required'],
  ['human_norole', 'approved_stale', 'approval_stale'],
];

// Master all-autonomous, unconfigured type → direct publish. Every type,
// every principal, every approval state (approval must be IGNORED).
for (const objectType of governedObjectTypes) {
  test(`master all-autonomous: ${objectType} publishes without approval (every principal × approval state)`, () => {
    for (const [principalKey, expected] of AUTONOMOUS_MATRIX) {
      for (const approvalKey of Object.keys(APPROVALS) as ApprovalKey[]) {
        const result = runCell(objectType, OBJECT_IDS[objectType], principalKey, approvalKey, ALL_AUTONOMOUS);
        assertCell(result, expected, `${objectType} × ${principalKey} × ${approvalKey}`);
        assert.equal(result.requires_approval, false, `${objectType} must report requires_approval false`);
        if (result.allow) assert.equal(result.approval, undefined, 'an autonomous allow consumes no approval');
      }
    }
  });
}

// Master all-require-approval, unconfigured type → the full gated matrix.
for (const objectType of governedObjectTypes) {
  test(`master all-require-approval: ${objectType} runs the full gated matrix`, () => {
    for (const [principalKey, approvalKey, expected] of GATED_MATRIX) {
      const result = runCell(objectType, OBJECT_IDS[objectType], principalKey, approvalKey, ALL_REQUIRE);
      assertCell(result, expected, `${objectType} × ${principalKey} × ${approvalKey}`);
      assert.equal(result.requires_approval, true, `${objectType} must report requires_approval true`);
    }
  });
}

// Master all-autonomous + ONE type overridden to require-approval: that type
// gates (full matrix), the other five stay free — verified per type.
for (const gatedType of governedObjectTypes) {
  test(`override require-approval on ${gatedType} (master all-autonomous): it gates; the other five stay autonomous`, () => {
    const policy = gateOne(gatedType, 'require-approval');
    for (const [principalKey, approvalKey, expected] of GATED_MATRIX) {
      const result = runCell(gatedType, OBJECT_IDS[gatedType], principalKey, approvalKey, policy);
      assertCell(result, expected, `${gatedType} × ${principalKey} × ${approvalKey}`);
    }
    for (const other of governedObjectTypes) {
      if (other === gatedType) continue;
      const result = runCell(other, OBJECT_IDS[other], 'agent', 'none', policy);
      assertCell(result, 'allow', `${other} must stay autonomous while ${gatedType} is gated`);
    }
  });
}

// Master all-require-approval + ONE type overridden to autonomous: that type
// publishes freely, the other five gate — verified per type.
for (const freeType of governedObjectTypes) {
  test(`override autonomous on ${freeType} (master all-require-approval): it frees; the other five stay gated`, () => {
    const policy = gateOne(freeType, 'autonomous');
    for (const [principalKey, expected] of AUTONOMOUS_MATRIX) {
      for (const approvalKey of Object.keys(APPROVALS) as ApprovalKey[]) {
        const result = runCell(freeType, OBJECT_IDS[freeType], principalKey, approvalKey, policy);
        assertCell(result, expected, `${freeType} × ${principalKey} × ${approvalKey}`);
      }
    }
    for (const other of governedObjectTypes) {
      if (other === freeType) continue;
      const result = runCell(other, OBJECT_IDS[other], 'agent', 'none', policy);
      assertCell(result, 'approval_required', `${other} must stay gated while ${freeType} is freed`);
    }
  });
}

// content_item: governed like every type since W7.3 (OQ-8 resolved). Tier 1
// is a POLICY posture (autonomous under the committed default), not a
// structural exemption — all-require-approval gates articles too.
test('content_item follows the gate matrix under both masters (W7.3; Tier 1 = policy, not exemption)', () => {
  const autonomous = runCell(
    'content_item',
    'req_smoke_pdf_cta_20260630_01',
    'agent',
    'approved_current_pin_match',
    ALL_AUTONOMOUS
  );
  assert.equal(autonomous.allow, true);
  assert.equal(autonomous.requires_approval, false);

  const gated = runCell('content_item', 'req_smoke_pdf_cta_20260630_01', 'agent', 'none', ALL_REQUIRE);
  assert.equal(gated.allow, false);
  assert.equal(gated.allow === false && gated.code, 'approval_required');
});

// ─── config changes change behavior immediately, with no code changes ────────

test('flipping the master switch flips the gate outcome for the same record and call', () => {
  const record = baseRecord('page', 'page_home');
  const input = { record, principal: agentActor, roles: [] as Role[], requested: {} };
  assert.equal(checkPublishGate({ ...input, policy: ALL_AUTONOMOUS }).allow, true);
  const gated = checkPublishGate({ ...input, policy: ALL_REQUIRE });
  assert.equal(gated.allow, false);
  assert.equal(gated.allow === false && gated.code, 'approval_required');
});

test('adding and removing a per-type override changes the gate outcome for exactly that type', () => {
  const record = baseRecord('navigation', 'nav_footer');
  const input = { record, principal: agentActor, roles: [] as Role[], requested: {} };
  assert.equal(checkPublishGate({ ...input, policy: ALL_AUTONOMOUS }).allow, true);
  const withOverride = checkPublishGate({ ...input, policy: gateOne('navigation', 'require-approval') });
  assert.equal(withOverride.allow, false, 'adding the override gates navigation');
  assert.equal(
    checkPublishGate({ ...input, policy: ALL_AUTONOMOUS }).allow,
    true,
    'removing it frees navigation again'
  );
});

// ─── M-6 pin-matching exactness (gated types) ────────────────────────────────

const GATED_PAGE = gateOne('page', 'require-approval');

const gateWithPinAndRequest = (pin: { published_time: string | null }, requested: { published_time?: string | null }) =>
  checkPublishGate({
    record: baseRecord('page', 'page_home', { state: 'approved', decisions: [approveDecision(2, pin)] }),
    principal: agentActor,
    roles: [],
    requested,
    policy: GATED_PAGE,
  });

test('M-6: an ISO pin matches the same instant in a different ISO formatting', () => {
  const result = gateWithPinAndRequest(
    { published_time: '2026-07-04T09:00:00.000Z' },
    { published_time: '2026-07-04T09:00:00+00:00' }
  );
  assert.equal(result.allow, true, JSON.stringify(result));
});

test('M-6: an ISO pin rejects a different instant', () => {
  const result = gateWithPinAndRequest(
    { published_time: '2026-07-04T09:00:00.000Z' },
    { published_time: '2026-07-04T09:00:01.000Z' }
  );
  assert.equal(result.allow === false && result.code, 'publish_action_mismatch');
});

test('M-6: a null pin is the only thing authorizing an agent unpublish', () => {
  assert.equal(gateWithPinAndRequest({ published_time: null }, { published_time: null }).allow, true);
  const omitted = gateWithPinAndRequest({ published_time: null }, {});
  assert.equal(omitted.allow === false && omitted.code, 'publish_action_mismatch');
  const nullWithoutPin = gateWithPinAndRequest({ published_time: 'immediate' }, { published_time: null });
  assert.equal(nullWithoutPin.allow === false && nullWithoutPin.code, 'publish_action_mismatch');
});

test("M-6: an 'immediate' pin requires the call to omit published_time", () => {
  const explicit = gateWithPinAndRequest({ published_time: 'immediate' }, { published_time: AT });
  assert.equal(explicit.allow === false && explicit.code, 'publish_action_mismatch');
});

// ─── extended live-publish pin (Goal 4): request id + artifact set + release/build ───
//
// Additive to M-6: an approval MAY additionally pin the exact content-item id,
// artifact set, and release/build behavior. Enforced for agent execution only;
// humans with publish authority are not bound. An approval WITHOUT the extended
// pin behaves exactly as the M-6 baseline (proven by the whole matrix above,
// which sets no approval_pin).

type ExtendedPin = { request_id?: string; artifact_set?: string[]; release_build?: 'defer' | 'release' };

const approveWithPin = (publishAction: { published_time: string | null }, approvalPin: ExtendedPin): ReviewState => ({
  state: 'approved',
  decisions: [
    {
      at: AT,
      by: humanActor,
      decision: 'approve',
      publish_action: publishAction,
      approval_pin: approvalPin,
      content_revision: 2,
    },
  ],
});

const gateExtended = (
  review: ReviewState,
  principalKey: 'agent' | 'human_admin',
  requested: RequestedPublishAction
) => {
  const { principal, roles } = PRINCIPALS[principalKey];
  return checkPublishGate({
    record: baseRecord('content_item', OBJECT_IDS.content_item, review),
    principal,
    roles,
    requested,
    policy: gateOne('content_item', 'require-approval'),
  });
};

test('extended pin: request_id must match the target object_id for agent execution', () => {
  const matching = gateExtended(
    approveWithPin({ published_time: 'immediate' }, { request_id: OBJECT_IDS.content_item }),
    'agent',
    {}
  );
  assert.equal(matching.allow, true, JSON.stringify(matching));

  const mismatch = gateExtended(
    approveWithPin({ published_time: 'immediate' }, { request_id: 'req_other_20260101_01' }),
    'agent',
    {}
  );
  assert.equal(mismatch.allow === false && mismatch.code, 'publish_request_id_mismatch');
});

test('extended pin: artifact_set must be declared by the publish and match exactly (order-insensitive)', () => {
  const pinnedSet = [
    `image/${OBJECT_IDS.content_item}/${'a'.repeat(64)}.png`,
    `pdf/${OBJECT_IDS.content_item}/${'b'.repeat(64)}.pdf`,
  ];
  const review = approveWithPin({ published_time: 'immediate' }, { artifact_set: pinnedSet });

  const ok = gateExtended(review, 'agent', { artifact_set: [pinnedSet[1], pinnedSet[0]] });
  assert.equal(ok.allow, true, JSON.stringify(ok));

  const missing = gateExtended(review, 'agent', {});
  assert.equal(missing.allow === false && missing.code, 'publish_artifact_set_required');

  const diff = gateExtended(review, 'agent', { artifact_set: [pinnedSet[0]] });
  assert.equal(diff.allow === false && diff.code, 'publish_artifact_set_mismatch');
});

test('extended pin: release_build must be declared by the publish and match', () => {
  const review = approveWithPin({ published_time: 'immediate' }, { release_build: 'defer' });
  assert.equal(gateExtended(review, 'agent', { release_build: 'defer' }).allow, true);

  const missing = gateExtended(review, 'agent', {});
  assert.equal(missing.allow === false && missing.code, 'publish_release_build_required');

  const diff = gateExtended(review, 'agent', { release_build: 'release' });
  assert.equal(diff.allow === false && diff.code, 'publish_release_build_mismatch');
});

test('extended pin binds agents but not humans with publish authority; the pin is surfaced on allow', () => {
  const review = approveWithPin({ published_time: 'immediate' }, { request_id: 'req_other_20260101_01' });

  assert.equal(gateExtended(review, 'agent', {}).allow, false, 'the agent is bound by the id pin');

  const human = gateExtended(review, 'human_admin', {});
  assert.equal(human.allow, true, JSON.stringify(human));
  assert.equal(human.allow === true && human.approval?.approval_pin?.request_id, 'req_other_20260101_01');
});

test('an approval with no extended pin behaves exactly as the M-6 baseline', () => {
  const review: ReviewState = { state: 'approved', decisions: [approveDecision(2, { published_time: 'immediate' })] };
  const result = gateExtended(review, 'agent', {});
  assert.equal(result.allow, true);
  assert.equal(result.allow === true && result.approval?.approval_pin, undefined);
});

// ─── the preserved invalidation lifecycle (D§3.1/D§3.9), on a gated type ─────

const approvedPageRecord = () =>
  baseRecord('page', 'page_home', {
    state: 'approved',
    decisions: [approveDecision(2, { published_time: 'immediate' })],
  });

test('lock checkout/checkin does NOT invalidate a pending approval (version-only churn)', async () => {
  const map = new Map<string, string>();
  const store = {
    get: async (key: string) => map.get(key) ?? null,
    setJSON: async (key: string, value: unknown) => {
      map.set(key, JSON.stringify(value));
    },
  };
  const record = approvedPageRecord();
  const key = objectRecordKey('page', 'page_home');
  map.set(key, JSON.stringify(record));

  const checkout = await checkoutObjectLock(store, key, { actor: humanActor, nowMs: NOW });
  assert.equal(checkout.ok, true);
  const afterCheckout = JSON.parse(map.get(key) as string) as ObjectRecord;
  assert.ok(afterCheckout.version > record.version, 'checkout must bump version');
  assert.equal(afterCheckout.content_revision, record.content_revision, 'checkout must not bump content_revision');
  assert.equal(
    checkPublishGate({ record: afterCheckout, principal: agentActor, roles: [], requested: {}, policy: GATED_PAGE })
      .allow,
    true,
    'approval must survive checkout'
  );

  const checkin = await checkinObjectLock(store, key, {
    actor: humanActor,
    lockToken: afterCheckout.lock?.token,
    nowMs: NOW + 1000,
  });
  assert.equal(checkin.ok, true);
  const afterCheckin = JSON.parse(map.get(key) as string) as ObjectRecord;
  assert.equal(afterCheckin.content_revision, record.content_revision);
  assert.equal(
    checkPublishGate({ record: afterCheckin, principal: agentActor, roles: [], requested: {}, policy: GATED_PAGE })
      .allow,
    true,
    'approval must survive checkin'
  );
});

test('a body write DOES invalidate the approval (content_revision moves past the pin) — then blocks the agent again', () => {
  const record = {
    ...approvedPageRecord(),
    body: {
      route: '/',
      pageType: 'home',
      title: 'Home',
      seo: {},
      sections: [{ id: 's_hero1', type: 'hero', data: { heading: 'Original', actions: [] } }],
    },
  };
  // Approval granted → the agent may publish.
  assert.equal(
    checkPublishGate({ record, principal: agentActor, roles: [], requested: {}, policy: GATED_PAGE }).allow,
    true
  );

  const { record: edited } = applyPatchOps(
    record,
    [{ op: 'update_section_data', section_id: 's_hero1', fields: { heading: 'Changed' } }],
    { actor: agentActor, at: AT }
  );
  assert.equal(edited.content_revision, record.content_revision + 1);

  const result = checkPublishGate({
    record: edited,
    principal: agentActor,
    roles: [],
    requested: {},
    policy: GATED_PAGE,
  });
  assert.equal(result.allow, false);
  assert.equal(result.allow === false && result.code, 'approval_stale');

  const humanResult = checkPublishGate({
    record: edited,
    principal: humanActor,
    roles: ['admin'],
    requested: {},
    policy: GATED_PAGE,
  });
  assert.equal(humanResult.allow === false && humanResult.code, 'approval_stale', 'stale approvals bind humans too');
});

test('the publish stamp itself does NOT invalidate the approval (T1.3 writes version, never content_revision)', () => {
  const record = approvedPageRecord();
  // Exactly the T1.3 step-5 stamp shape: publication + history + version.
  const stamped: ObjectRecord = {
    ...record,
    updated_at: AT,
    publication: {
      published_time: AT,
      publish_receipt: {
        kind: 'object_export_commit',
        branch: 'main',
        commit_sha: 'commit1',
        tree_sha: 'tree1',
        no_op: false,
        attempts: 1,
        files: ['sites/drlurie/data/site/pages/page_x.json'],
        content_revision: record.content_revision,
        exported_at: AT,
      },
    },
    history: [...record.history, { at: AT, action: 'publish', actor: humanActor }],
    version: record.version + 1,
    content_revision: record.content_revision,
  };
  const result = checkPublishGate({
    record: stamped,
    principal: agentActor,
    roles: [],
    requested: {},
    policy: GATED_PAGE,
  });
  assert.equal(result.allow, true, 'publishing must consume, never invalidate, its approval');
});

// ─── roles.ts resolution (unchanged by the policy layer) ─────────────────────

test('roles: env allowlists resolve with trim/lowercase and ADMIN_EMAILS superset compatibility', () => {
  const env = {
    ROLE_EMAILS_ADMIN: ' Alice@Example.com ',
    ROLE_EMAILS_PUBLISHER: 'bob@example.com, alice@example.com',
    ROLE_EMAILS_EDITOR: 'carol@example.com',
    ADMIN_EMAILS: 'legacy@example.com',
  };
  assert.deepEqual(resolveHumanRoles('alice@example.com', env), ['admin', 'publisher']);
  assert.deepEqual(resolveHumanRoles('BOB@example.com', env), ['publisher']);
  assert.deepEqual(resolveHumanRoles('carol@example.com', env), ['editor']);
  assert.deepEqual(resolveHumanRoles('legacy@example.com', env), ['admin'], 'ADMIN_EMAILS members stay admins');
  assert.deepEqual(resolveHumanRoles('stranger@example.com', env), []);
  assert.deepEqual(resolveHumanRoles('', env), []);
});

test('roles: agents resolve to no roles; publish execution requires admin or publisher', () => {
  assert.deepEqual(resolveRolesForPrincipal(agentActor, { ROLE_EMAILS_ADMIN: 'codex' }), []);
  assert.equal(canExecutePublish(['admin']), true);
  assert.equal(canExecutePublish(['publisher']), true);
  assert.equal(canExecutePublish(['editor']), false);
  assert.equal(canExecutePublish([]), false);
  assert.equal(canDecideReview(['editor']), true);
  assert.equal(canDecideReview([]), false);
});
