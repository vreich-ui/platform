import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalMemberDisplayName, presentLastSeen } from './admin-user-presentation.js';
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
