import '../../sites/drlurie/config/policy-bindings.js'; // W11 T11.2: register providers for tests hitting active*/getSiteIdentity
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildObjectContract,
  OBJECT_CONTRACT_TYPES,
  type ObjectContract,
} from '../../packages/core/lib/registry/object-contract.js';
import type { ApprovalPolicy } from '../../packages/core/lib/approval-policy.js';
import { REGISTERED_SECTION_TYPES } from '../../packages/core/lib/registry/components/registered-types.js';
import { sectionTypes } from '../../packages/core/schema/bodies/section-v1.js';
import { patchOpNamesByObjectType } from '../../packages/core/schema/object-patch-ops.js';
import type { ObjectType } from '../../packages/core/schema/object-record-v1.js';

const GOVERNED: ObjectType[] = [
  'page',
  'section',
  'navigation',
  'taxonomy',
  'site',
  'template',
  'section_template',
  'theme',
  'product',
];

// Building every contract exercises z.toJSONSchema over the recursive navItem
// (z.lazy), the section discriminated union, and the patch-op refinements — so
// this loop IS the "does toJSONSchema throw?" risk check.
test('every object type produces a well-formed contract without throwing', () => {
  for (const type of OBJECT_CONTRACT_TYPES) {
    const contract: ObjectContract = buildObjectContract(type);
    assert.equal(contract.object_type, type);
    assert.ok(contract.summary.length > 0);
    assert.ok(Array.isArray(contract.patch_ops));
    assert.ok(Array.isArray(contract.constraints));
    assert.ok(contract.publish_policy);
    assert.ok(Array.isArray(contract.workflow.sequence) && contract.workflow.sequence.length > 0);
  }
});

test('workflow.sequence names the object_validate candidate-body dry-run BEFORE object_create, for every type', () => {
  for (const type of OBJECT_CONTRACT_TYPES) {
    const sequence = buildObjectContract(type).workflow.sequence;
    const validateIndex = sequence.findIndex((step) => step.startsWith('object_validate ('));
    const createIndex = sequence.findIndex((step) => step.startsWith('object_create ('));
    assert.ok(validateIndex >= 0, `${type} workflow must name the candidate-body object_validate step`);
    assert.ok(createIndex >= 0, `${type} workflow must name object_create`);
    assert.ok(validateIndex < createIndex, `${type} workflow must discover object_validate before object_create`);
    assert.match(sequence[validateIndex]!, new RegExp(`object_type: "${type}"`));
    assert.match(sequence[validateIndex]!, /NO object_id/);
  }
});

test('every governed type — content_item included since W7.3 — carries a non-empty body JSON-schema', () => {
  for (const type of [...GOVERNED, 'content_item' as ObjectType]) {
    const body = buildObjectContract(type).body_schema as Record<string, unknown>;
    assert.equal(body.type, 'object', `${type} body_schema should be a JSON-schema object`);
    assert.ok(body.properties && Object.keys(body.properties).length > 0, `${type} body_schema has properties`);
  }
  const contentItem = buildObjectContract('content_item');
  assert.equal(contentItem.creatable, true);
  assert.equal(contentItem.governed, true);
  // The annotation layer is contract-visible: the node schema carries private.strategy.
  assert.match(JSON.stringify(contentItem.body_schema), /"strategy"/);
});

test('section_types covers every variant; the component-bound ones carry editor hints', () => {
  for (const type of ['page', 'section', 'section_template'] as ObjectType[]) {
    const sections = buildObjectContract(type).section_types ?? [];
    assert.deepEqual(
      sections.map((s) => s.type).sort(),
      [...sectionTypes].sort(),
      `${type} must enumerate every section variant`
    );
    const bound = sections.filter((s) => s.component_bound);
    assert.deepEqual(
      bound.map((s) => s.type).sort(),
      [...REGISTERED_SECTION_TYPES].sort(),
      'component_bound exactly tracks the registered (component-bound) types'
    );
    for (const s of bound) assert.ok(s.editor, `${s.type} (bound) must carry editor hints`);
    for (const s of sections) assert.ok(s.data_schema, `${s.type} must carry a data_schema`);
  }
  // non-page/section types don't enumerate sections
  assert.equal(buildObjectContract('navigation').section_types, undefined);
});

test('patch_ops covers exactly the per-type allowlist, with arg schemas + minted-id fields', () => {
  for (const type of GOVERNED) {
    const ops = buildObjectContract(type).patch_ops;
    assert.deepEqual(
      ops.map((o) => o.op).sort(),
      [...patchOpNamesByObjectType[type]].sort(),
      `${type} patch_ops must match patchOpNamesByObjectType`
    );
    for (const o of ops) assert.ok(o.arg_schema, `${o.op} must carry an arg_schema`);
  }
  // the five minted-id ops advertise which id an agent may omit
  const navOps = buildObjectContract('navigation').patch_ops;
  assert.equal(navOps.find((o) => o.op === 'upsert_item')?.minted_id_field, 'item.id');
  assert.equal(navOps.find((o) => o.op === 'upsert_group')?.minted_id_field, 'group.id');
  const taxOps = buildObjectContract('taxonomy').patch_ops;
  assert.equal(taxOps.find((o) => o.op === 'add_term')?.minted_id_field, 'term.term_id');
  // reactivate_term is inverse-only machinery, not agent-authored
  assert.equal(taxOps.find((o) => o.op === 'reactivate_term')?.agent_authored, false);
});

test('content_item carries the node op family (W7.3 — articles are governed objects)', () => {
  assert.deepEqual(
    buildObjectContract('content_item')
      .patch_ops.map((o) => o.op)
      .sort(),
    [
      'move_node',
      'remove_node',
      'set_article_meta',
      'set_node_visibility',
      'set_tracking',
      'update_node',
      'upsert_node',
    ]
  );
});

test('content_item contract advertises the author field and its set action (T9.23a)', () => {
  const contract = buildObjectContract('content_item');
  const properties = (contract.body_schema as { properties?: Record<string, unknown> }).properties ?? {};
  assert.ok('author' in properties, 'body_schema must list author (derived from the zod body schema)');

  const setArticleMeta = contract.patch_ops.find((op) => op.op === 'set_article_meta');
  assert.ok(setArticleMeta, 'set_article_meta must be a content_item patch op');
  assert.match(String(setArticleMeta?.arg_schema?.description ?? ''), /author/);
});

test('requires_approval is computed from the policy, not hardcoded', () => {
  const gated: ApprovalPolicy = { master: 'all-require-approval', overrides: {} };
  const autonomous: ApprovalPolicy = { master: 'all-autonomous', overrides: {} };
  assert.equal(buildObjectContract('page', { approvalPolicy: gated }).publish_policy.requires_approval, true);
  assert.equal(buildObjectContract('page', { approvalPolicy: autonomous }).publish_policy.requires_approval, false);
  // a per-type override beats the master switch
  const overridden: ApprovalPolicy = { master: 'all-autonomous', overrides: { navigation: 'require-approval' } };
  assert.equal(
    buildObjectContract('navigation', { approvalPolicy: overridden }).publish_policy.requires_approval,
    true
  );
  assert.equal(buildObjectContract('page', { approvalPolicy: overridden }).publish_policy.requires_approval, false);
  // gated workflow surfaces the review step
  assert.ok(
    buildObjectContract('page', { approvalPolicy: gated }).workflow.sequence.some((s) =>
      s.includes('object_review_decide')
    )
  );
});

test('anti-drift coverage guard: contract types match objectTypes exactly', () => {
  assert.deepEqual(
    [...OBJECT_CONTRACT_TYPES].sort(),
    [
      ...([
        'page',
        'section',
        'navigation',
        'taxonomy',
        'site',
        'template',
        'section_template',
        'theme',
        'product',
        'content_item',
        'tracking_config',
        'editorial_voice',
        // Brand-imagery wave (BRIEF.md §3.1): the thirteenth object type,
        // deliberately NOT a fourteenth GOVERNED one (see the GOVERNED const
        // above and approval-policy.ts governedObjectTypes).
        'visual_standard',
      ] as ObjectType[]),
    ].sort()
  );
});

test('section_template carries the blueprint op family, section vocabulary, and the placeability constraint (W8.1)', () => {
  const contract = buildObjectContract('section_template');
  assert.equal(contract.governed, true);
  assert.deepEqual(
    contract.patch_ops.map((op) => op.op),
    ['set_section_template_meta', 'replace_blueprint', 'update_blueprint_data', 'set_tracking']
  );
  assert.equal(
    contract.patch_ops.find((op) => op.op === 'replace_blueprint')?.minted_id_field,
    'blueprint.id',
    'replace_blueprint must advertise the server-minted blueprint id'
  );
  assert.ok(contract.section_types && contract.section_types.length > 0, 'the section vocabulary must be served');
  assert.ok(contract.constraints.some((constraint) => constraint.id === 'blueprint_standalone_renderable'));
});

test('W8.3b: recipe types carry the recipe_metadata constraint, a REUSE-FIRST first workflow step, and useWhen hints', () => {
  for (const type of ['template', 'section_template', 'theme'] as ObjectType[]) {
    const contract = buildObjectContract(type);
    assert.ok(
      contract.constraints.some((constraint) => constraint.id === 'recipe_metadata'),
      `${type} must carry the recipe_metadata constraint`
    );
    assert.match(contract.workflow.sequence[0]!, /REUSE FIRST/, `${type} workflow must open with reuse`);
    assert.match(contract.workflow.sequence[0]!, new RegExp(type));
  }
  const page = buildObjectContract('page');
  assert.equal(
    page.constraints.some((constraint) => constraint.id === 'recipe_metadata'),
    false,
    'non-recipe types carry no recipe_metadata constraint'
  );
  assert.doesNotMatch(page.workflow.sequence[0]!, /REUSE FIRST/);
  // useWhen flows automatically into the served section vocabulary.
  const bound = (buildObjectContract('section_template').section_types ?? []).filter((s) => s.component_bound);
  for (const sectionType of bound) {
    assert.ok(sectionType.editor?.useWhen, `${sectionType.type} must serve editor.useWhen`);
  }
});

test('W8.3b: creation_policy is served on every contract and reflects the injected policy', () => {
  for (const type of OBJECT_CONTRACT_TYPES) {
    const open = buildObjectContract(type).creation_policy;
    assert.equal(open.humans, 'always_allowed');
    if (type === 'tracking_config' || type === 'editorial_voice') {
      // W13/D1: human/seed-only singletons — the conversion-factory driver is
      // the one named seed identity (T13.10); casual agents stay excluded.
      assert.deepEqual(
        open.agents,
        { allowlist: ['object-conversion-roundtrip'] },
        `${type} allows only the seed driver`
      );
    } else {
      assert.equal(open.agents, 'open', `${type} is open under the committed default`);
    }
    assert.match(open.note, /self-declared/);
  }
  const restricted = buildObjectContract('template', {
    creationPolicy: { master: 'open', overrides: { template: { agents: ['site-builder'] } } },
  }).creation_policy;
  assert.deepEqual(restricted.agents, { allowlist: ['site-builder'] });
  assert.match(restricted.note, /creation_restricted/);
});

// P4 (brand-imagery wave, BRIEF §3.7's overridePolicy read path): the
// `brand_imagery_override_policy` constraint on object_contract('site') --
// CMS-Agent's sitePrefetch.ts reads exactly this id/value pair, so both
// strings are load-bearing.
test('object_contract("site") carries the brand_imagery_override_policy constraint with the effective value', () => {
  const findConstraint = (contract: ObjectContract) =>
    contract.constraints.find((constraint) => constraint.id === 'brand_imagery_override_policy');

  const defaulted = findConstraint(buildObjectContract('site'));
  assert.ok(defaulted, 'the constraint is present by default');
  assert.equal(defaulted!.value, 'allow', 'default guardrail is allow (R5)');

  const allowed = findConstraint(buildObjectContract('site', { brandImageryOverridePolicy: 'allow' }));
  assert.equal(allowed!.value, 'allow');

  const locked = findConstraint(buildObjectContract('site', { brandImageryOverridePolicy: 'lock' }));
  assert.equal(locked!.value, 'lock');

  // Inert everywhere else -- the guardrail is a site-only setting.
  for (const type of OBJECT_CONTRACT_TYPES) {
    if (type === 'site') continue;
    assert.equal(
      findConstraint(buildObjectContract(type)),
      undefined,
      `${type} does not carry the site-only brand_imagery_override_policy constraint`
    );
  }
});
