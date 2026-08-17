import { describe, it } from 'node:test';
import assert from 'node:assert';

import { statusTone, sortRows, filterCommands, relativeTimeFromNow } from './logic.js';

describe('statusTone', () => {
  it('maps readiness statuses', () => {
    assert.strictEqual(statusTone('complete'), 'success');
    assert.strictEqual(statusTone('warning'), 'warning');
    assert.strictEqual(statusTone('missing'), 'danger');
    assert.strictEqual(statusTone('optional'), 'neutral');
  });
  it('maps lifecycle words and unknowns', () => {
    assert.strictEqual(statusTone('published'), 'success');
    assert.strictEqual(statusTone('changes_requested'), 'warning');
    assert.strictEqual(statusTone('failed'), 'danger');
    assert.strictEqual(statusTone('whatever'), 'neutral');
  });
});

describe('sortRows', () => {
  const rows = [
    { n: 'Beta', v: 2 },
    { n: 'alpha', v: 10 },
    { n: 'Gamma', v: 2 },
  ];

  it('sorts strings ascending, case-insensitive', () => {
    assert.deepStrictEqual(
      sortRows(rows, (r) => r.n, 'asc').map((r) => r.n),
      ['alpha', 'Beta', 'Gamma']
    );
  });

  it('sorts numbers descending', () => {
    assert.deepStrictEqual(
      sortRows(rows, (r) => r.v, 'desc').map((r) => r.v),
      [10, 2, 2]
    );
  });

  it('is stable on ties (Beta before Gamma, both v=2)', () => {
    assert.deepStrictEqual(
      sortRows(rows, (r) => r.v, 'asc').map((r) => r.n),
      ['Beta', 'Gamma', 'alpha']
    );
  });

  it('sinks nullish/empty values to the end regardless of direction', () => {
    const withGaps = [{ x: 'b' }, { x: undefined }, { x: 'a' }];
    assert.deepStrictEqual(
      sortRows(withGaps, (r) => r.x, 'asc').map((r) => r.x),
      ['a', 'b', undefined]
    );
    assert.deepStrictEqual(
      sortRows(withGaps, (r) => r.x, 'desc').map((r) => r.x),
      ['b', 'a', undefined]
    );
  });

  it('does not mutate the input', () => {
    const input = [{ v: 3 }, { v: 1 }];
    sortRows(input, (r) => r.v, 'asc');
    assert.deepStrictEqual(
      input.map((r) => r.v),
      [3, 1]
    );
  });
});

describe('filterCommands', () => {
  const cmds = [
    { id: '1', label: 'Publish article' },
    { id: '2', label: 'Create page' },
    { id: '3', label: 'Republish draft' },
    { id: '4', label: 'Archive item', keywords: ['delete', 'remove'] },
  ];

  it('returns all for an empty query, original order', () => {
    assert.deepStrictEqual(
      filterCommands(cmds, '   ').map((c) => c.id),
      ['1', '2', '3', '4']
    );
  });

  it('ranks label prefix above substring', () => {
    // "pub" → "Publish article" (prefix, rank 0) before "Republish draft" (substring, rank 2)
    assert.deepStrictEqual(
      filterCommands(cmds, 'pub').map((c) => c.id),
      ['1', '3']
    );
  });

  it('matches keywords when the label does not', () => {
    assert.deepStrictEqual(
      filterCommands(cmds, 'delete').map((c) => c.id),
      ['4']
    );
  });

  it('excludes non-matches', () => {
    assert.deepStrictEqual(filterCommands(cmds, 'zzz'), []);
  });
});

describe('relativeTimeFromNow', () => {
  const now = Date.parse('2026-07-17T12:00:00.000Z');

  it('phrases recent spans', () => {
    assert.strictEqual(relativeTimeFromNow('2026-07-17T11:59:40.000Z', now), 'just now');
    assert.strictEqual(relativeTimeFromNow('2026-07-17T11:55:00.000Z', now), '5m ago');
    assert.strictEqual(relativeTimeFromNow('2026-07-17T09:00:00.000Z', now), '3h ago');
    assert.strictEqual(relativeTimeFromNow('2026-07-15T12:00:00.000Z', now), '2d ago');
  });

  it('treats future timestamps as just now (clock skew)', () => {
    assert.strictEqual(relativeTimeFromNow('2026-07-17T12:03:00.000Z', now), 'just now');
  });

  it('is empty for missing/invalid input', () => {
    assert.strictEqual(relativeTimeFromNow(undefined, now), '');
    assert.strictEqual(relativeTimeFromNow('not-a-date', now), '');
  });
});

// ─── W18 T18.3a/b — membership page logic ─────────────────────────────────────

import {
  DEFAULT_POLICY_VIEW,
  formatExpiresIn,
  grantableTiers,
  invitationActionsFor,
  invitationSendStatus,
  memberActionsFor,
  memberSourceLabel,
  roleOptionsFor,
} from './logic.js';

describe('grantableTiers / roleOptionsFor (policy × actor role × target role)', () => {
  it('owner may grant every tier; admin only roles_admin_may_grant under owner_admin; nobody else', () => {
    assert.deepEqual(grantableTiers(['owner', 'admin', 'publisher']), [
      'owner',
      'admin',
      'publisher',
      'editor',
      'viewer',
    ]);
    assert.deepEqual(grantableTiers(['admin']), ['editor', 'viewer']);
    assert.deepEqual(grantableTiers(['admin'], { ...DEFAULT_POLICY_VIEW, who_can_invite: 'owner' }), []);
    assert.deepEqual(
      grantableTiers(['admin'], {
        ...DEFAULT_POLICY_VIEW,
        roles_admin_may_grant: ['admin', 'publisher', 'editor', 'viewer'],
      }),
      ['admin', 'publisher', 'editor', 'viewer']
    );
    assert.deepEqual(grantableTiers(['publisher']), []);
    assert.deepEqual(grantableTiers([]), []);
  });
  it('roleOptionsFor disables the current role and the tiers the actor may not grant, with reasons', () => {
    const opts = roleOptionsFor({ actorRoles: ['admin'], currentRole: 'viewer' });
    assert.deepEqual(
      opts.map((o) => [o.value, o.disabled, o.reason]),
      [
        ['owner', true, 'An Owner must grant this role'],
        ['admin', true, 'An Owner must grant this role'],
        ['publisher', true, 'An Owner must grant this role'],
        ['editor', false, undefined],
        ['viewer', true, 'Current role'],
      ]
    );
    assert.equal(roleOptionsFor({ actorRoles: ['owner'] }).filter((o) => o.disabled).length, 0);
  });
});

describe('memberActionsFor', () => {
  const me = 'boss@x.com';
  it('owner acting: env rows → promote + audit; self → audit; removed → audit; active → change_role/suspend/remove; suspended → reinstate', () => {
    assert.deepEqual(
      memberActionsFor({
        row: { email: 'env@x.com', role: 'owner', status: 'active', source: 'environment' },
        actorEmail: me,
        actorRoles: ['owner'],
      }),
      ['promote_bootstrap', 'view_audit']
    );
    assert.deepEqual(
      memberActionsFor({ row: { email: me, role: 'owner', status: 'active' }, actorEmail: me, actorRoles: ['owner'] }),
      ['view_audit']
    );
    assert.deepEqual(
      memberActionsFor({
        row: { email: 'r@x.com', role: 'admin', status: 'disabled', membership_status: 'removed' },
        actorEmail: me,
        actorRoles: ['owner'],
      }),
      ['view_audit']
    );
    assert.deepEqual(
      memberActionsFor({
        row: { email: 'a@x.com', role: 'admin', status: 'active', membership_status: 'active' },
        actorEmail: me,
        actorRoles: ['owner'],
      }),
      ['change_role', 'view_audit', 'suspend', 'remove']
    );
    assert.deepEqual(
      memberActionsFor({
        row: { email: 's@x.com', role: 'admin', status: 'disabled', membership_status: 'suspended' },
        actorEmail: me,
        actorRoles: ['owner'],
      }),
      ['change_role', 'view_audit', 'reinstate', 'remove']
    );
    // v1 view without membership_status: disabled ⇒ suspended
    assert.deepEqual(
      memberActionsFor({
        row: { email: 's@x.com', role: 'admin', status: 'disabled' },
        actorEmail: me,
        actorRoles: ['owner'],
      }),
      ['change_role', 'view_audit', 'reinstate', 'remove']
    );
  });
  it('a non-owner gets audit only (read-only page)', () => {
    assert.deepEqual(
      memberActionsFor({
        row: { email: 'a@x.com', role: 'admin', status: 'active' },
        actorEmail: me,
        actorRoles: ['admin'],
      }),
      ['view_audit']
    );
  });
  it('memberSourceLabel', () => {
    assert.equal(memberSourceLabel({ source: 'environment' }), 'Break-glass (env)');
    assert.equal(memberSourceLabel({ membership_source: 'bootstrap_env' }), 'Bootstrap');
    assert.equal(memberSourceLabel({ membership_source: 'netlify_ui' }), 'Netlify UI');
    assert.equal(memberSourceLabel({ membership_source: 'legacy_v1' }), null);
    assert.equal(memberSourceLabel({}), null);
  });
});

describe('invitations tab logic', () => {
  const now = Date.parse('2026-08-17T12:00:00.000Z');
  it('formatExpiresIn: countdown then "expired"', () => {
    assert.equal(formatExpiresIn('2026-08-17T12:20:00.000Z', now), 'expires in 20m');
    assert.equal(formatExpiresIn('2026-08-17T15:00:00.000Z', now), 'expires in 3h');
    assert.equal(formatExpiresIn('2026-08-20T16:00:00.000Z', now), 'expires in 3d 4h');
    assert.equal(formatExpiresIn('2026-08-24T12:00:00.000Z', now), 'expires in 7d');
    assert.equal(formatExpiresIn('2026-08-17T11:59:59.000Z', now), 'expired');
    assert.equal(formatExpiresIn('nonsense', now), '');
  });
  it('invitationActionsFor: pending → both; at cap → resend disabled with reason; non-pending → neither', () => {
    assert.deepEqual(invitationActionsFor({ status: 'pending', send_count: 1, gotrue_invited: true }), {
      resend: { enabled: true },
      revoke: { enabled: true },
    });
    const capped = invitationActionsFor({ status: 'pending', send_count: 5, gotrue_invited: true });
    assert.equal(capped.resend.enabled, false);
    assert.match(capped.resend.reason ?? '', /max 5/);
    assert.equal(capped.revoke.enabled, true);
    const expired = invitationActionsFor({ status: 'expired', send_count: 1, gotrue_invited: true });
    assert.equal(expired.resend.enabled, false);
    assert.equal(expired.revoke.enabled, false);
    assert.match(expired.resend.reason ?? '', /Expired/);
    assert.equal(
      invitationActionsFor({ status: 'revoked', send_count: 1, gotrue_invited: true }).revoke.enabled,
      false
    );
  });
  it('invitationSendStatus maps GoTrue outcomes to a label, tone and how-to-fix hint', () => {
    assert.deepEqual(invitationSendStatus({ gotrue_invited: true, send_count: 1 }), { label: 'Sent', tone: 'success' });
    assert.equal(invitationSendStatus({ gotrue_invited: true, send_count: 3 }).label, 'Sent 3×');
    assert.equal(
      invitationSendStatus({ gotrue_invited: true, gotrue_error: 'already_invited', send_count: 0 }).label,
      'Already in Identity'
    );
    const noToken = invitationSendStatus({
      gotrue_invited: false,
      gotrue_error: 'Identity admin token unavailable; store record created, invite email not sent.',
      send_count: 0,
    });
    assert.equal(noToken.tone, 'warning');
    assert.match(noToken.hint ?? '', /Enable Netlify Identity/);
    assert.equal(
      invitationSendStatus({ gotrue_invited: false, gotrue_error: 'GoTrue invite failed (500).', send_count: 0 }).tone,
      'danger'
    );
    assert.equal(invitationSendStatus({ gotrue_invited: false, send_count: 0 }).label, 'Not sent');
  });
});

// ─── W18 T18.5 — welcome gate ─────────────────────────────────────────────────

import { welcomeGateDecision } from './logic.js';

describe('welcomeGateDecision', () => {
  const base = {
    path: '/admin/content',
    roles: ['admin'],
    hasRecord: true,
    completed: false,
    requireDisplayName: true,
  };
  it('redirects an incomplete member on any ordinary admin path, renders once completed', () => {
    assert.equal(welcomeGateDecision(base), 'redirect');
    assert.equal(welcomeGateDecision({ ...base, path: '/admin' }), 'redirect');
    assert.equal(welcomeGateDecision({ ...base, completed: true }), 'render');
  });
  it('never redirects on the exempt pages (welcome itself, accept, authorize), trailing slash tolerant', () => {
    assert.equal(welcomeGateDecision({ ...base, path: '/admin/welcome' }), 'render');
    assert.equal(welcomeGateDecision({ ...base, path: '/admin/welcome/' }), 'render');
    assert.equal(welcomeGateDecision({ ...base, path: '/admin/accept' }), 'render');
    assert.equal(welcomeGateDecision({ ...base, path: '/admin/authorize' }), 'render');
  });
  it('no roles → forbidden (needs_grant users see the panel, no loop); no record → render; policy off → render', () => {
    assert.equal(welcomeGateDecision({ ...base, roles: [] }), 'forbidden');
    assert.equal(welcomeGateDecision({ ...base, roles: [], hasRecord: false }), 'forbidden');
    assert.equal(welcomeGateDecision({ ...base, hasRecord: false }), 'render');
    assert.equal(welcomeGateDecision({ ...base, requireDisplayName: false }), 'render');
  });
  it('a bootstrap Owner (materialised record, empty onboarding) goes through welcome once', () => {
    assert.equal(welcomeGateDecision({ ...base, roles: ['owner', 'admin', 'publisher'] }), 'redirect');
    assert.equal(welcomeGateDecision({ ...base, roles: ['owner', 'admin', 'publisher'], completed: true }), 'render');
  });
});
