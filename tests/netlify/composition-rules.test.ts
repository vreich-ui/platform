import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { checkComposition, summarizeValidation, validateObject } from '../../packages/core/server/lib/object-validate.js';
import {
  COMPOSITION_RULES,
  CTA_DENSITY_MAX,
  SHARED_SECTION_IMPACT_WARN_ABOVE,
  SINGLETON_SECTION_TYPES,
} from '../../packages/core/lib/registry/composition-rules.js';
import { buildObjectContract } from '../../packages/core/lib/registry/object-contract.js';
import type { ObjectValidationContext } from '../../packages/core/server/lib/object-validate.js';

/**
 * W1 T1.3 acceptance — the composition lints.
 *
 * The PageType rules answer "may this KIND be here". These answer "is this
 * ARRANGEMENT a page a reader can use" — two heroes, a second newsletter form,
 * four asks in a row, the same anchor twice. Each is composed out of sections
 * that are individually valid, which is exactly why nothing caught them.
 *
 * One fixture per rule, passing and failing, plus the bar that matters most:
 * every committed page export on every tenant must still validate. A warning
 * on an existing export is information; a BLOCKER on one would mean the rule
 * is wrong, not the export.
 */

const section = (type: string, data: Record<string, unknown> = {}, id = `s_${type}_${Math.random().toString(36).slice(2, 7)}`) => ({
  id,
  type,
  data,
});

const ctx: ObjectValidationContext = {};
const statusOf = (criteria: ReturnType<typeof checkComposition>, id: string) =>
  criteria.find((criterion) => criterion.id === id)?.status;
const run = (sections: unknown[], atPublish = false) => checkComposition({ sections }, ctx, atPublish);

// ─── every rule reports, every time ──────────────────────────────────────────

test('all seven rules emit a criterion on every page — a silent rule is one nobody knows exists', () => {
  const criteria = run([section('prose', { body: '<p>x</p>' })]);
  assert.deepEqual(
    criteria.map((criterion) => criterion.id),
    COMPOSITION_RULES.map((rule) => rule.id)
  );
  for (const criterion of criteria) assert.equal(criterion.status, 'complete', criterion.id);
});

// ─── one fixture per rule: pass, then fail ───────────────────────────────────

test('structure_opener: hero/lede only at position 0', () => {
  assert.equal(statusOf(run([section('hero'), section('prose')]), 'structure_opener'), 'complete');
  const failed = run([section('prose'), section('hero')]);
  assert.equal(statusOf(failed, 'structure_opener'), 'warning');
  assert.match(failed.find((c) => c.id === 'structure_opener')!.message, /position 1/);
});

test('structure_singletons WARNS about a second form — it does not block one that works', () => {
  const one = [section('newsletter_signup'), section('prose')];
  assert.equal(statusOf(run(one, true), 'structure_singletons'), 'complete');

  const two = [section('newsletter_signup'), section('newsletter_signup')];
  // Warns at BOTH gates. drlurie's page_object_showcase carries two newsletter
  // forms deliberately, with different formName values, and renders correctly —
  // so a kind count cannot be the blocking rule. The failure that IS real
  // (duplicate DOM ids) blocks under structure_anchor_unique, below.
  assert.equal(statusOf(run(two, false), 'structure_singletons'), 'warning');
  assert.equal(statusOf(run(two, true), 'structure_singletons'), 'warning');
  assert.ok(SINGLETON_SECTION_TYPES.includes('newsletter_signup'));
});

test('structure_singletons counts THROUGH shared_ref — two forms is two forms', () => {
  const context: ObjectValidationContext = { resolveSharedSectionType: () => 'contact_form' };
  const criteria = checkComposition(
    { sections: [section('contact_form'), section('shared_ref', { section: 'sec_contact' })] },
    context,
    true
  );
  // The deref is what is under test: an inline form plus a shared one is two
  // forms on the page, and the rule must see the second one.
  assert.equal(statusOf(criteria, 'structure_singletons'), 'warning');
  assert.match(criteria.find((c) => c.id === 'structure_singletons')!.message, /contact_form ×2/);
});

test('structure_adjacency: repeats warn, except prose and media which compose BY repeating', () => {
  assert.equal(statusOf(run([section('prose'), section('prose')]), 'structure_adjacency'), 'complete');
  assert.equal(statusOf(run([section('media'), section('media')]), 'structure_adjacency'), 'complete');
  assert.equal(statusOf(run([section('faq'), section('faq')]), 'structure_adjacency'), 'warning');
  // Not adjacent — separated by something — is fine.
  assert.equal(statusOf(run([section('faq'), section('prose'), section('faq')]), 'structure_adjacency'), 'complete');
});

test('structure_cta_density: at most three asks per page', () => {
  const three = Array.from({ length: CTA_DENSITY_MAX }, () => section('cta_banner'));
  assert.equal(statusOf(run(three), 'structure_cta_density'), 'complete');
  assert.equal(
    statusOf(run([...three, section('pricing_table')]), 'structure_cta_density'),
    'warning',
    'the rule counts cta_banner, pricing_table and product_preview together'
  );
});

test('structure_anchor_unique: a duplicated formName blocks — that is the failure a second form really causes', () => {
  // NewsletterSignup.astro derives its input id from formName, so two forms
  // sharing one identity point the second label at the first field.
  const distinct = run([
    section('newsletter_signup', { formName: 'newsletter' }),
    section('newsletter_signup', { formName: 'newsletter-showcase' }),
  ]);
  assert.equal(statusOf(distinct, 'structure_anchor_unique'), 'complete');

  const collided = run([
    section('newsletter_signup', { formName: 'newsletter' }),
    section('contact_form', { formName: 'newsletter' }),
  ]);
  assert.equal(statusOf(collided, 'structure_anchor_unique'), 'missing');
  assert.match(collided.find((c) => c.id === 'structure_anchor_unique')!.message, /formName/);
});

test('structure_anchor_unique: an anchor is a DOM id, so it BLOCKS the write', () => {
  assert.equal(statusOf(run([section('hero', { anchor: 'top' }), section('faq', { anchor: 'faq' })]), 'structure_anchor_unique'), 'complete');
  const dup = run([section('hero', { anchor: 'same' }), section('faq', { anchor: 'same' })]);
  // blocks_write: 'missing' whether or not this is a publish.
  assert.equal(statusOf(dup, 'structure_anchor_unique'), 'missing');
  assert.equal(statusOf(run([section('hero', { anchor: 'same' }), section('faq', { anchor: 'same' })], true), 'structure_anchor_unique'), 'missing');
  assert.match(dup.find((c) => c.id === 'structure_anchor_unique')!.message, /same/);
});

test('structure_region_capacity and structure_viewport_budget pass today — and are live, not stubs', () => {
  // Every bound kind is `flow`, which is unbounded, and no kind declares an
  // edge. Both rules therefore pass on every real page; what is under test is
  // that they RUN, so the first sticky kind meets an enforced rule rather than
  // a commented-out one.
  const criteria = run([section('hero'), section('prose'), section('cta_banner')], true);
  assert.equal(statusOf(criteria, 'structure_region_capacity'), 'complete');
  assert.equal(statusOf(criteria, 'structure_viewport_budget'), 'complete');
  for (const id of ['structure_region_capacity', 'structure_viewport_budget']) {
    assert.equal(COMPOSITION_RULES.find((rule) => rule.id === id)?.enforced_live, true);
  }
});

test('an unresolvable shared_ref is skipped, never guessed', () => {
  // No resolveSharedSectionType: the type is unknown, so no rule may fire on it.
  const criteria = run([section('shared_ref', { section: 'sec_x' }), section('shared_ref', { section: 'sec_y' })], true);
  for (const criterion of criteria) assert.equal(criterion.status, 'complete', criterion.id);
});

// ─── the contract publishes the same rows the validator runs ─────────────────

test('object_contract publishes all seven rules with their severities', () => {
  const constraints = buildObjectContract('page').constraints;
  for (const rule of COMPOSITION_RULES) {
    const published = constraints.find((constraint) => constraint.id === rule.id);
    assert.ok(published, `${rule.id} is enforced but not published`);
    assert.equal(published.severity, rule.severity, rule.id);
    assert.equal(published.enforced_live, rule.enforced_live, rule.id);
    assert.equal(published.description, rule.description, rule.id);
  }
});

test('the shared-section impact threshold is data, not a number in a handler', () => {
  assert.equal(SHARED_SECTION_IMPACT_WARN_ABOVE, 5);
});

// ─── the real bar: every committed page export on every tenant ───────────────

const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'sites', 'drlurie', 'site.config.ts'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate the repo root from the compiled test');
};

test('no committed page export on any tenant is BLOCKED by a composition rule', () => {
  const root = repoRoot();
  const compositionIds = new Set(COMPOSITION_RULES.map((rule) => rule.id));
  let examined = 0;
  const blocked: string[] = [];

  for (const tenant of readdirSync(join(root, 'sites'))) {
    const dir = join(root, 'sites', tenant, 'data', 'site', 'pages');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const { __generated, ...body } = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
      void __generated;
      examined += 1;
      // publishIntent:true — the strictest gate, where blocks_publish bites.
      const groups = validateObject(
        { objectType: 'page', objectId: file.replace(/\.json$/, ''), body, published: true },
        { publishIntent: true }
      );
      for (const blocker of summarizeValidation(groups).blockers) {
        if (compositionIds.has(blocker.id)) blocked.push(`${tenant}/${file}: ${blocker.id} — ${blocker.message}`);
      }
    }
  }

  assert.ok(examined > 30, `expected the committed page exports to be present, saw ${examined}`);
  assert.deepEqual(
    blocked,
    [],
    'a committed export blocked by a composition rule means the RULE is wrong, not the export'
  );
});
