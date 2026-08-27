import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canonicalMemberDisplayName,
  filterMembers,
  memberMatchesFilters,
  memberMatchesQuery,
  presentLastSeen,
  resolveMembershipStatus,
} from './admin-user-presentation.js';
import type { UserView } from './users-client.js';

const member = (overrides: Partial<UserView> = {}): UserView => ({
  email: 'vreich@example.com',
  display_name: 'Vreich',
  role: 'owner',
  status: 'active',
  ...overrides,
});

describe('canonicalMemberDisplayName', () => {
  it('uses the current signed-in canonical identity for its own row', () => {
    assert.equal(
      canonicalMemberDisplayName(member(), { email: 'VREICH@example.com', display_name: 'Wolf Reich' }),
      'Wolf Reich'
    );
  });

  it('does not replace another member name', () => {
    assert.equal(
      canonicalMemberDisplayName(member({ email: 'other@example.com', display_name: 'Vreich' }), {
        email: 'vreich@example.com',
        display_name: 'Wolf Reich',
      }),
      'Vreich'
    );
  });
});

describe('presentLastSeen', () => {
  it('does not imply missing telemetry means never seen for environment users', () => {
    assert.deepEqual(presentLastSeen(member({ source: 'environment' })), {
      kind: 'not_tracked',
      label: 'Activity not tracked',
    });
  });

  it('labels stored members without activity as not signed in', () => {
    assert.deepEqual(presentLastSeen(member({ source: 'stored' })), {
      kind: 'not_seen',
      label: 'Not signed in yet',
    });
  });

  it('keeps a recorded activity timestamp relative', () => {
    assert.deepEqual(presentLastSeen(member({ last_seen_at: '2026-08-09T12:00:00.000Z' })), { kind: 'relative' });
  });
});

describe('resolveMembershipStatus', () => {
  it('prefers the v2 membership_status when present', () => {
    assert.equal(resolveMembershipStatus(member({ status: 'active', membership_status: 'suspended' })), 'suspended');
  });
  it('maps the v1 VIEW status disabled → suspended when membership_status is absent', () => {
    assert.equal(resolveMembershipStatus(member({ status: 'disabled' })), 'suspended');
  });
  it('passes invited/active straight through', () => {
    assert.equal(resolveMembershipStatus(member({ status: 'invited' })), 'invited');
    assert.equal(resolveMembershipStatus(member({ status: 'active' })), 'active');
  });
});

describe('memberMatchesQuery', () => {
  const m = member({ display_name: 'Wolf Reich', email: 'wolf@example.com' });
  it('matches on display name, case-insensitively', () => {
    assert.equal(memberMatchesQuery(m, 'wolf'), true);
    assert.equal(memberMatchesQuery(m, 'REICH'), true);
  });
  it('matches on e-mail', () => {
    assert.equal(memberMatchesQuery(m, 'example.com'), true);
  });
  it('rejects a non-matching query', () => {
    assert.equal(memberMatchesQuery(m, 'zzz'), false);
  });
  it('an empty/blank query matches everyone', () => {
    assert.equal(memberMatchesQuery(m, ''), true);
    assert.equal(memberMatchesQuery(m, '   '), true);
  });
});

describe('memberMatchesFilters', () => {
  const m = member({ role: 'editor', status: 'active' });
  it("'all' (or omitted) passes every role/status", () => {
    assert.equal(memberMatchesFilters(m, {}), true);
    assert.equal(memberMatchesFilters(m, { role: 'all', status: 'all' }), true);
  });
  it('filters by role', () => {
    assert.equal(memberMatchesFilters(m, { role: 'editor' }), true);
    assert.equal(memberMatchesFilters(m, { role: 'admin' }), false);
  });
  it('filters by status, resolving v1 disabled → suspended', () => {
    const suspended = member({ role: 'editor', status: 'disabled' });
    assert.equal(memberMatchesFilters(suspended, { status: 'suspended' }), true);
    assert.equal(memberMatchesFilters(suspended, { status: 'active' }), false);
  });
});

describe('filterMembers', () => {
  const rows: UserView[] = [
    member({ email: 'a@x.com', display_name: 'Ada', role: 'owner', status: 'active' }),
    member({ email: 'b@x.com', display_name: 'Bo', role: 'editor', status: 'active' }),
    member({
      email: 'c@x.com',
      display_name: 'Cy',
      role: 'editor',
      status: 'disabled',
      membership_status: 'suspended',
    }),
  ];
  it('combines search AND role AND status', () => {
    assert.deepEqual(
      filterMembers(rows, { query: '', role: 'editor', status: 'active' }).map((r) => r.email),
      ['b@x.com']
    );
  });
  it('an unset filter (undefined query/role/status) matches everything on that axis', () => {
    assert.deepEqual(
      filterMembers(rows, {}).map((r) => r.email),
      ['a@x.com', 'b@x.com', 'c@x.com']
    );
  });
  it('search alone narrows by name or e-mail', () => {
    assert.deepEqual(
      filterMembers(rows, { query: 'cy' }).map((r) => r.email),
      ['c@x.com']
    );
  });
});
