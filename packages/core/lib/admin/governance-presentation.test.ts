import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTONOMY_LABELS,
  autonomyEffect,
  governanceProvenanceLabel,
  toolGroupLabel,
  BRAND_IMAGERY_OVERRIDE_LABELS,
  BRAND_IMAGERY_OVERRIDE_REVERT_TARGET,
  brandImageryOverrideEffect,
  describeBrandImageryGuardrail,
} from './governance-presentation.js';

describe('governance presentation', () => {
  it('uses human labels for every autonomy setting', () => {
    assert.deepEqual(AUTONOMY_LABELS, {
      auto: 'Run automatically',
      ask: 'Ask me first',
      off: 'Not allowed',
    });
    assert.match(autonomyEffect('ask'), /approval/i);
  });

  it('uses human headings and provenance labels', () => {
    assert.equal(governanceProvenanceLabel('override'), 'Changed here');
    assert.equal(governanceProvenanceLabel('committed'), 'Site default');
    assert.equal(toolGroupLabel('read'), 'Looking things up');
    assert.equal(toolGroupLabel('privileged'), 'Site-wide changes');
  });
});

describe('brand imagery override guardrail (U2)', () => {
  it('default state: no override written -> effective allow, provenance committed', () => {
    const view = describeBrandImageryGuardrail('allow', 'committed');
    assert.equal(view.effective, 'allow');
    assert.equal(view.provenance, 'committed');
    assert.equal(view.provenanceLabel, 'Site default');
    assert.equal(view.label, BRAND_IMAGERY_OVERRIDE_LABELS.allow);
    assert.deepEqual(view.rows, [
      { label: 'Effective setting', value: 'Agents may override per run' },
      { label: 'Source', value: 'Site default' },
      { label: 'Site default', value: 'Agents may override per run' },
    ]);
  });

  it('site-override state: an explicit lock written here -> effective lock, provenance override', () => {
    const view = describeBrandImageryGuardrail('lock', 'override');
    assert.equal(view.effective, 'lock');
    assert.equal(view.provenance, 'override');
    assert.equal(view.provenanceLabel, 'Changed here');
    assert.equal(view.label, "Locked to the site's own imagery");
    assert.deepEqual(view.rows, [
      { label: 'Effective setting', value: "Locked to the site's own imagery" },
      { label: 'Source', value: 'Changed here' },
      // the "site default" row always names the hardcoded default (allow),
      // regardless of what is currently in effect -- it is the revert target.
      { label: 'Site default', value: 'Agents may override per run' },
    ]);
  });

  it('reverted state: the override is cleared -> back to committed/allow, same as the default state', () => {
    // Simulates the page after a one-click revert: the doc entry is gone, so
    // the server resolves 'allow' with provenance 'committed' again.
    const view = describeBrandImageryGuardrail('allow', 'committed');
    assert.equal(view.effective, 'allow');
    assert.equal(view.provenance, 'committed');
  });

  it('an unrecognized provenance string normalizes to committed, never left as-is', () => {
    const view = describeBrandImageryGuardrail('allow', 'anything-else');
    assert.equal(view.provenance, 'committed');
  });

  it('effect copy is distinct for allow vs lock and names the style channel', () => {
    assert.match(brandImageryOverrideEffect('allow'), /style override|visual standard/i);
    assert.match(brandImageryOverrideEffect('lock'), /ignored/i);
    assert.notEqual(brandImageryOverrideEffect('allow'), brandImageryOverrideEffect('lock'));
  });

  it('the one-click revert target is the exact key the store schema/admin-governance verb expects', () => {
    assert.equal(BRAND_IMAGERY_OVERRIDE_REVERT_TARGET, 'brandImageryOverrides');
  });
});
