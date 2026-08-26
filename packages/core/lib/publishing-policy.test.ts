/**
 * T15.8 — publishing-policy.ts (`autonomyMode`, the "one approval truth"
 * knob). Covers: absence/no-provider defaults closed, an explicit
 * 'autonomous' config resolves 'autonomous', a malformed provider degrades
 * closed instead of throwing, and the schema rejects unknown fields.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  activeAutonomyMode,
  clearActivePublishingPolicyProviderForTests,
  publishingPolicyConfigSchema,
  resolveAutonomyMode,
  resolvePublishingPolicy,
  setActivePublishingPolicyProvider,
} from './publishing-policy.js';

afterEach(() => {
  clearActivePublishingPolicyProviderForTests();
});

describe('resolveAutonomyMode', () => {
  it('absent autonomyMode resolves operator-gated', () => {
    assert.equal(resolveAutonomyMode(undefined), 'operator-gated');
    assert.equal(resolveAutonomyMode({}), 'operator-gated');
  });

  it('an explicit autonomous config resolves autonomous', () => {
    assert.equal(resolveAutonomyMode({ autonomyMode: 'autonomous' }), 'autonomous');
  });

  it('an explicit operator-gated config resolves operator-gated', () => {
    assert.equal(resolveAutonomyMode({ autonomyMode: 'operator-gated' }), 'operator-gated');
  });
});

describe('resolvePublishingPolicy (schema)', () => {
  it('parses a valid config', () => {
    assert.deepEqual(resolvePublishingPolicy({ autonomyMode: 'autonomous' }), { autonomyMode: 'autonomous' });
  });

  it('parses an empty config', () => {
    assert.deepEqual(resolvePublishingPolicy({}), {});
  });

  it('throws on an unknown field (strict schema, fail loud on malformed config)', () => {
    assert.throws(() => resolvePublishingPolicy({ autonomyMode: 'autonomous', extra: 1 }));
  });

  it('throws on an invalid enum value', () => {
    assert.throws(() => resolvePublishingPolicy({ autonomyMode: 'yolo' }));
  });

  it('the strict-object schema rejects extra keys directly too', () => {
    assert.equal(publishingPolicyConfigSchema.safeParse({ autonomyMode: 'autonomous', extra: 1 }).success, false);
  });
});

describe('activeAutonomyMode', () => {
  it('never throws and defaults closed when no provider is registered (every fleet site today)', () => {
    assert.doesNotThrow(() => activeAutonomyMode());
    assert.equal(activeAutonomyMode(), 'operator-gated');
  });

  it('reflects a registered provider set to autonomous', () => {
    setActivePublishingPolicyProvider(() => ({ autonomyMode: 'autonomous' }));
    assert.equal(activeAutonomyMode(), 'autonomous');
  });

  it('reflects a registered provider explicitly set to operator-gated', () => {
    setActivePublishingPolicyProvider(() => ({ autonomyMode: 'operator-gated' }));
    assert.equal(activeAutonomyMode(), 'operator-gated');
  });

  it('degrades closed, never throws, when the registered provider itself throws (malformed committed config)', () => {
    setActivePublishingPolicyProvider(() => {
      throw new Error('malformed publishing-policy.ts');
    });
    assert.doesNotThrow(() => activeAutonomyMode());
    assert.equal(activeAutonomyMode(), 'operator-gated');
  });
});
