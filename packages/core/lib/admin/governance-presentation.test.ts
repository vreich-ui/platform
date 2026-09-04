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
  storedAutonomyFor,
  currentAutonomyForCatalog,
} from './governance-presentation.js';
import type { ChatToolCatalogEntry } from './governance-client.js';

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

// ─── the save-round-trip regression (Owner: "Save changes doesn't save") ────
//
// The server canonicalizes every chat_tools key it writes (`patch` is stored
// as `object_patch`) while the catalog is served under the legacy chat names.
// Reading the stored map by catalog key therefore found nothing for the 19
// aliased tools: the setting WAS saved and WAS honoured by the run loop, but
// the row snapped back to "Use standard setting", which is indistinguishable
// from a failed save. These tests pin the read side of that round-trip.

const catalogEntry = (name: string, canonical?: string): ChatToolCatalogEntry => ({
  name,
  tool_class: 'draft',
  default: 'ask',
  description: `${name} description`,
  ...(canonical ? { canonical_name: canonical } : {}),
});

describe('chat-tool override round-trip', () => {
  const catalog = [
    catalogEntry('patch', 'object_patch'),
    catalogEntry('publish', 'object_publish'),
    catalogEntry('run_workspace_workflow'),
  ];

  it('reads an override back under the name the server stored it as', () => {
    assert.equal(storedAutonomyFor({ object_patch: 'off' }, catalog[0]!), 'off');
    assert.deepEqual(currentAutonomyForCatalog({ object_patch: 'off' }, catalog), { patch: 'off' });
  });

  it('still reads an override stored under the catalog name itself', () => {
    assert.deepEqual(currentAutonomyForCatalog({ run_workspace_workflow: 'off' }, catalog), {
      run_workspace_workflow: 'off',
    });
  });

  it('prefers an exact key over the canonical one when both somehow exist', () => {
    assert.equal(storedAutonomyFor({ patch: 'ask', object_patch: 'off' }, catalog[0]!), 'ask');
  });

  it('drops stored keys with no catalog row rather than re-saving dead settings', () => {
    assert.deepEqual(currentAutonomyForCatalog({ retired_tool: 'off', object_publish: 'auto' }, catalog), {
      publish: 'auto',
    });
  });

  it('treats an absent override doc as no overrides', () => {
    assert.deepEqual(currentAutonomyForCatalog(undefined, catalog), {});
    assert.deepEqual(currentAutonomyForCatalog({}, catalog), {});
  });
});
