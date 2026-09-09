/**
 * Genesis policy (Wolf, 2026-09-09) — the fleet-wide "what must a mint
 * supply" lever, and the SHARED-VOCABULARY pin for the CMS-Agent side.
 *
 * The two repos cannot import each other: CMS-Agent's `site.duplicate`
 * mirrors this refusal before it provisions a Netlify site, from its own copy
 * of the artifact enum and the field map (`src/agent/capture/genesisPolicy.ts`
 * there, with the twin of this test in `tests/genesisPolicy.test.ts`). Both
 * sides therefore pin the vocabulary explicitly, spelled out rather than
 * derived, so a change on either side turns a test red instead of quietly
 * teaching one surface to refuse something the other allows.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  FLEET_GENESIS_POLICY,
  GENESIS_ARTIFACTS,
  GENESIS_ARTIFACT_INPUT_FIELDS,
  activeGenesisPolicy,
  clearActiveGenesisPolicyProviderForTests,
  genesisArtifactRefusal,
  missingGenesisArtifacts,
  resolveGenesisPolicy,
  setActiveGenesisPolicyProvider,
} from './genesis-policy.js';

describe('genesis policy', () => {
  it('ships EMPTY — nothing is required until Wolf says so', () => {
    assert.deepStrictEqual(FLEET_GENESIS_POLICY.requiredArtifacts, []);
    clearActiveGenesisPolicyProviderForTests();
    assert.deepStrictEqual(activeGenesisPolicy().requiredArtifacts, []);
  });

  it('pins the closed artifact enum and the artifact → INPUT FIELD map (shared with CMS-Agent)', () => {
    assert.deepStrictEqual(
      [...GENESIS_ARTIFACTS],
      ['editorial_strategy', 'editorial_voice', 'visual_standard', 'logo', 'tracking_config'],
      'the artifact enum is shared vocabulary with CMS-Agent — change both repos in one wave'
    );
    assert.deepStrictEqual(
      { ...GENESIS_ARTIFACT_INPUT_FIELDS },
      {
        editorial_strategy: 'editorialStrategy',
        editorial_voice: 'editorialVoice',
        visual_standard: 'visualStandard',
        logo: 'logo',
        tracking_config: 'trackingConfig',
      },
      'missing[] names INPUT FIELDS, never object types — CMS-Agent mirrors this exact map'
    );
  });

  it('a malformed config THROWS rather than resolving to the permissive default', () => {
    // The creation-policy precedent. The permissive default here is `[]`, so a
    // silent fallback would turn "Wolf required a strategy" into "nothing is
    // required" with no output at all — the one failure mode worth a throw.
    assert.throws(() => resolveGenesisPolicy({}), /Invalid genesis-policy config/);
    assert.throws(() => resolveGenesisPolicy({ requiredArtifacts: 'editorial_strategy' }), /Invalid genesis-policy/);
    assert.throws(() => resolveGenesisPolicy({ requiredArtifacts: ['editorial_stratgy'] }), /Invalid genesis-policy/);
    assert.throws(() => resolveGenesisPolicy({ requiredArtifacts: [], extra: true }), /Invalid genesis-policy/);
    assert.throws(
      () => resolveGenesisPolicy({ requiredArtifacts: ['logo', 'logo'] }),
      /Invalid genesis-policy/,
      'a repeated artifact is a config nobody proofread — reject it rather than de-duplicating silently'
    );
  });

  it('a provider returning a malformed config throws through activeGenesisPolicy', () => {
    setActiveGenesisPolicyProvider(() => ({ requiredArtifacts: ['nope'] }));
    try {
      assert.throws(() => activeGenesisPolicy(), /Invalid genesis-policy config/);
    } finally {
      clearActiveGenesisPolicyProviderForTests();
    }
  });

  it('the pure resolver reports INPUT FIELD names, in policy order, for what was not supplied', () => {
    const policy = resolveGenesisPolicy({ requiredArtifacts: ['editorial_strategy', 'logo'] });
    assert.deepStrictEqual(missingGenesisArtifacts(policy, {}), ['editorialStrategy', 'logo']);
    assert.deepStrictEqual(missingGenesisArtifacts(policy, { editorialStrategy: { goal: 'x' } }), ['logo']);
    assert.deepStrictEqual(missingGenesisArtifacts(policy, { editorialStrategy: {}, logo: { text: 'A' } }), []);
    // A CLI option bag carries keys set to undefined for flags nobody passed.
    assert.deepStrictEqual(missingGenesisArtifacts(policy, { editorialStrategy: undefined, logo: undefined }), [
      'editorialStrategy',
      'logo',
    ]);
    // The empty policy never reports anything missing, whatever was supplied.
    assert.deepStrictEqual(missingGenesisArtifacts(FLEET_GENESIS_POLICY, {}), []);
  });

  it('the refusal is classified and states BOTH ways out by name', () => {
    const refusal = genesisArtifactRefusal(['editorialStrategy']);
    assert.strictEqual(refusal.status, 422);
    assert.strictEqual(refusal.error_code, 'genesis_artifact_required');
    assert.deepStrictEqual(refusal.missing, ['editorialStrategy']);
    assert.strictEqual(refusal.ways_out.length, 2);
    assert.match(refusal.ways_out[0], /^supply now:/);
    assert.match(refusal.ways_out[1], /^lower the policy:/);
    // The prose an operator actually reads must carry both doors too — a
    // machine field nobody renders is not an actionable blockage.
    assert.match(refusal.error, /SUPPLY NOW/);
    assert.match(refusal.error, /LOWER THE POLICY/);
    assert.match(refusal.error, /--editorial-strategy/);
    assert.match(refusal.error, /editorialStrategy/);
    assert.doesNotMatch(refusal.error, /editorial_strategy/, 'the refusal speaks input fields, not object types');
  });
});
