/**
 * D4 — the five-level severity standard. See `severity.ts`'s header for the
 * naming decision (`AdminSeverity`, not `Severity`) and the adapter rationale.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ADMIN_SEVERITY_ORDER, SEVERITY, severityCopy, severityFromActivity } from './severity.js';
import type { AdminSeverity } from './severity.js';

describe('the SEVERITY record', () => {
  it('defines all five D4 levels', () => {
    assert.deepEqual([...ADMIN_SEVERITY_ORDER].sort(), ['blocked', 'error', 'info', 'needs_you', 'success']);
    for (const level of ADMIN_SEVERITY_ORDER) {
      assert.equal(SEVERITY[level].key, level);
    }
  });

  it('gives every level a distinct icon — the B10 fix', () => {
    const icons = ADMIN_SEVERITY_ORDER.map((level) => SEVERITY[level].icon);
    assert.equal(new Set(icons).size, icons.length, 'every level must render a different glyph');
  });

  it('is blocking only for blocked', () => {
    for (const level of ADMIN_SEVERITY_ORDER) {
      assert.equal(SEVERITY[level].blocking, level === 'blocked');
    }
  });

  it('assigns the token family D4 specifies, with error/blocked deliberately sharing red', () => {
    assert.equal(SEVERITY.info.tokens.family, 'info');
    assert.equal(SEVERITY.success.tokens.family, 'success');
    assert.equal(SEVERITY.needs_you.tokens.family, 'warning');
    assert.equal(SEVERITY.error.tokens.family, 'danger');
    assert.equal(SEVERITY.blocked.tokens.family, 'danger');
    // The B1/B10 rule made explicit: same red, different icon.
    assert.notEqual(SEVERITY.error.icon, SEVERITY.blocked.icon);
  });

  it('exposes solid/soft/text tokens that resolve to real admin-tokens.css names', () => {
    for (const level of ADMIN_SEVERITY_ORDER) {
      const { solid, soft, text } = SEVERITY[level].tokens;
      assert.match(solid, /^--adm-(info|success|warning|danger)$/);
      assert.match(soft, /^--adm-(info|success|warning|danger)-soft$/);
      assert.match(text, /^--adm-(info|success|warning|danger)-text$/);
    }
  });
});

describe('severityCopy', () => {
  it('needs_you is imperative, leading with the action verb', () => {
    const copy = severityCopy('needs_you', { action: 'approve the pending release before it ships' });
    assert.equal(copy, 'Approve the pending release before it ships.');
    assert.doesNotMatch(copy, /^(You should|Please consider|We recommend)/i);
  });

  it('blocked states the cause and includes an escape hatch', () => {
    const copy = severityCopy('blocked', {
      cause: 'the article has no signed-in approver',
      escape: 'ask an admin to grant approval rights',
    });
    assert.match(copy, /no signed-in approver/);
    assert.match(copy, /ask an admin to grant approval rights/i);
  });

  it('error says what failed and that a retry exists', () => {
    const copy = severityCopy('error', { subject: 'Publishing', escape: 'retry the step' });
    assert.match(copy, /^Publishing failed\./);
    assert.match(copy, /retry the step/i);
  });

  it('error falls back to a generic retry sentence when no escape is given', () => {
    const copy = severityCopy('error', { subject: 'The upload' });
    assert.match(copy, /^The upload failed\./);
    assert.match(copy, /retry is available/i);
  });

  it('info and success render as a plain stated fact', () => {
    assert.equal(
      severityCopy('info', { subject: 'The draft', action: 'was saved automatically' }),
      'The draft was saved automatically.'
    );
    assert.equal(
      severityCopy('success', { subject: 'The article', action: 'was published' }),
      'The article was published.'
    );
  });
});

describe('severityFromActivity — the T0.3/B1 adapter', () => {
  it('maps the four activity-severity levels onto D4', () => {
    assert.equal(severityFromActivity('ok'), 'success');
    assert.equal(severityFromActivity('notice'), 'info');
    assert.equal(severityFromActivity('attention'), 'needs_you');
  });

  it('splits failure into error (retry offered) vs blocked (no retry) on the B1 criterion', () => {
    assert.equal(severityFromActivity('failure', { canRetry: true }), 'error');
    assert.equal(severityFromActivity('failure', { canRetry: false }), 'blocked');
    // Unknown recovery state defaults to the hard stop, not a false promise of a retry.
    assert.equal(severityFromActivity('failure'), 'blocked');
  });

  it('never resolves to something outside the five D4 levels', () => {
    const levels: AdminSeverity[] = ['ok', 'notice', 'attention', 'failure'].flatMap((a) => [
      severityFromActivity(a as Parameters<typeof severityFromActivity>[0]),
      severityFromActivity(a as Parameters<typeof severityFromActivity>[0], { canRetry: true }),
    ]);
    for (const level of levels) {
      assert.ok(level in SEVERITY, `${level} must be a real D4 level`);
    }
  });
});
