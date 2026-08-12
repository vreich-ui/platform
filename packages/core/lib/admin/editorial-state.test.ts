import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EDITORIAL_STATE_PRESENTATION,
  RELEASE_UNKNOWN_PRESENTATION,
  getEditorialDeployStatus,
  getEditorialObjectState,
  releaseAwareLifecyclePresentation,
  resolveReleaseAwareLifecycle,
  type EditorialDeployState,
  type EditorialStateRecord,
} from './editorial-state.js';

const deploy = (overrides: Partial<EditorialDeployState> = {}): EditorialDeployState => ({
  production_confirmed: false,
  ...overrides,
});

describe('getEditorialDeployStatus', () => {
  it('distinguishes active, failed, stalled, and ready-but-not-published builds', () => {
    const now = Date.parse('2026-08-07T12:30:00.000Z');
    assert.equal(
      getEditorialDeployStatus(
        { deployStatus: 'building', commit: 'next', startedAt: '2026-08-07T12:25:00.000Z' },
        'live',
        now
      ),
      'building'
    );
    assert.equal(
      getEditorialDeployStatus(
        { deployStatus: 'building', commit: 'next', startedAt: '2026-08-07T12:00:00.000Z' },
        'live',
        now
      ),
      'stalled'
    );
    assert.equal(getEditorialDeployStatus({ deployStatus: 'failed', commit: 'next' }, 'live', now), 'failed');
    assert.equal(
      getEditorialDeployStatus({ deployStatus: 'ready', commit: 'next' }, 'live', now),
      'ready_not_published'
    );
  });
});

const record = (overrides: Partial<EditorialStateRecord> = {}): EditorialStateRecord => ({
  content_revision: 3,
  requires_approval: true,
  publication: { published_time: null },
  ...overrides,
});

describe('getEditorialObjectState', () => {
  it('returns draft when no current approval covers the current revision', () => {
    assert.equal(getEditorialObjectState(record({ approval_state: 'approved_stale' }), deploy()), 'draft');
    assert.equal(getEditorialObjectState(record({ approval_state: 'open' }), deploy()), 'draft');
  });

  it('returns approved for a current approval without a matching current export', () => {
    assert.equal(getEditorialObjectState(record({ approval_state: 'approved_current' }), deploy()), 'approved');
  });

  it('returns published when the current revision is exported but not confirmed live', () => {
    const published = record({
      publication: {
        published_time: '2026-08-07T12:00:00.000Z',
        publish_receipt: { content_revision: 3, commit_sha: 'export-3' },
      },
    });
    assert.equal(getEditorialObjectState(published, deploy({ status: 'building' })), 'published');
    assert.equal(getEditorialObjectState(published, deploy({ status: 'stalled' })), 'published');
  });

  it('returns live only when the confirmed production deploy includes the export commit', () => {
    const published = record({
      publication: {
        published_time: '2026-08-07T12:00:00.000Z',
        publish_receipt: { content_revision: 3, commit_sha: 'export-3' },
      },
    });
    assert.equal(
      getEditorialObjectState(
        published,
        deploy({ production_confirmed: true, live_commit: 'release-8', included_commits: ['export-3'] })
      ),
      'live'
    );
  });

  it('allows autonomous types to publish without inventing an approval', () => {
    assert.equal(
      getEditorialObjectState(
        record({
          requires_approval: false,
          publication: {
            published_time: '2026-08-07T12:00:00.000Z',
            publish_receipt: { content_revision: 3, commit_sha: 'export-3' },
          },
        }),
        deploy()
      ),
      'published'
    );
  });
});

describe('resolveReleaseAwareLifecycle (fail-closed release-unknown decision)', () => {
  it('passes a server-confirmed release row straight through', () => {
    assert.equal(resolveReleaseAwareLifecycle({ state: 'live' }), 'live');
    assert.equal(resolveReleaseAwareLifecycle({ state: 'draft' }), 'draft');
    assert.equal(resolveReleaseAwareLifecycle({ state: 'approved' }), 'approved');
    assert.equal(resolveReleaseAwareLifecycle({ state: 'published' }), 'published');
  });

  it('never fabricates a lifecycle when the release row is missing — always "unknown"', () => {
    assert.equal(resolveReleaseAwareLifecycle(undefined), 'unknown');
  });
});

describe('releaseAwareLifecyclePresentation', () => {
  it('mirrors the known-state presentation for every real lifecycle', () => {
    assert.deepEqual(releaseAwareLifecyclePresentation('draft'), EDITORIAL_STATE_PRESENTATION.draft);
    assert.deepEqual(releaseAwareLifecyclePresentation('approved'), EDITORIAL_STATE_PRESENTATION.approved);
    assert.deepEqual(releaseAwareLifecyclePresentation('published'), EDITORIAL_STATE_PRESENTATION.published);
    assert.deepEqual(releaseAwareLifecyclePresentation('live'), EDITORIAL_STATE_PRESENTATION.live);
  });

  it('shows an honest "unknown" presentation rather than lying with a fabricated state', () => {
    assert.deepEqual(releaseAwareLifecyclePresentation('unknown'), RELEASE_UNKNOWN_PRESENTATION);
  });
});
