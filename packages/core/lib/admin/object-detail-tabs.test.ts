import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OBJECT_DETAIL_TABS,
  deriveActivityEntries,
  deriveUsage,
  deriveVersionEntries,
  parseDetailTab,
} from './object-detail-tabs.js';
import type { HistoryEntry, ObjectRecord } from '../../schema/object-record-v1.js';

const human = { kind: 'human' as const, id: 'u1', email: 'ada@example.com' };
const agent = { kind: 'agent' as const, agent_name: 'editor', auth: 'publish_key' as const };

const entry = (
  at: string,
  action: string,
  details?: Record<string, unknown>,
  actor: HistoryEntry['actor'] = human
): HistoryEntry => ({
  at,
  action,
  actor,
  ...(details ? { details } : {}),
});

const recordWith = (history: HistoryEntry[], commitSha?: string) =>
  ({
    history,
    content_revision: 4,
    publication: commitSha
      ? {
          published_time: '2026-08-20T10:00:00.000Z',
          publish_receipt: {
            kind: 'object_export_commit',
            branch: 'main',
            commit_sha: commitSha,
            tree_sha: 't',
            no_op: false,
            attempts: 1,
            files: [],
            content_revision: 4,
            exported_at: '2026-08-20T10:00:00.000Z',
          },
        }
      : { published_time: null },
  }) as unknown as ObjectRecord<Record<string, unknown>>;

describe('parseDetailTab', () => {
  it('round-trips every declared tab and falls back to content', () => {
    for (const tab of OBJECT_DETAIL_TABS) assert.equal(parseDetailTab(tab), tab);
    assert.equal(parseDetailTab('nonsense'), 'content');
    assert.equal(parseDetailTab(null), 'content');
    assert.equal(parseDetailTab(undefined), 'content');
  });
});

describe('deriveVersionEntries', () => {
  it('keeps content-moving entries and drops lock churn', () => {
    const record = recordWith([
      entry('2026-08-01T00:00:00.000Z', 'checkout'),
      entry('2026-08-02T00:00:00.000Z', 'patch', {
        op: { op: 'set_voice_fields' },
        capture: { kind: 'fields', before: { cadence: 'a' }, after: { cadence: 'b' } },
      }),
      entry('2026-08-03T00:00:00.000Z', 'refresh_lock'),
      entry('2026-08-04T00:00:00.000Z', 'checkin'),
    ]);
    const versions = deriveVersionEntries(record);
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.kind, 'edit');
    assert.deepEqual(versions[0]!.changedFields, ['cadence']);
    assert.equal(versions[0]!.historyIndex, 1);
  });

  it('returns newest first', () => {
    const record = recordWith([
      entry('2026-08-01T00:00:00.000Z', 'submit_review'),
      entry('2026-08-02T00:00:00.000Z', 'review_decide', { decision: 'approve' }),
    ]);
    const versions = deriveVersionEntries(record);
    assert.deepEqual(
      versions.map((version) => version.at),
      ['2026-08-02T00:00:00.000Z', '2026-08-01T00:00:00.000Z']
    );
    assert.deepEqual(
      versions.map((version) => version.kind),
      ['review', 'review']
    );
  });

  it('classifies publish, discard and structural edits', () => {
    const record = recordWith([
      entry('2026-08-01T00:00:00.000Z', 'publish_by_time', { publish_receipt: { commit_sha: 'abc' } }),
      entry('2026-08-02T00:00:00.000Z', 'discard'),
      entry('2026-08-03T00:00:00.000Z', 'patch', {
        op: { op: 'upsert_section' },
        capture: { kind: 'element', after: { id: 's_hero' } },
      }),
    ]);
    const kinds = deriveVersionEntries(record).map((version) => version.kind);
    assert.deepEqual(kinds, ['edit', 'discard', 'publish']);
  });

  it('marks the publish entry whose commit is the object’s current published one', () => {
    const record = recordWith(
      [
        entry('2026-08-01T00:00:00.000Z', 'publish_by_time', { publish_receipt: { commit_sha: 'old' } }),
        entry('2026-08-02T00:00:00.000Z', 'publish_by_time', { publish_receipt: { commit_sha: 'live' } }),
      ],
      'live'
    );
    const versions = deriveVersionEntries(record);
    assert.equal(versions[0]!.isCurrentPublish, true);
    assert.equal(versions[1]!.isCurrentPublish, false);
  });

  it('names an agent actor as well as a human one', () => {
    const record = recordWith([
      entry('2026-08-02T00:00:00.000Z', 'patch', { capture: { kind: 'fields', after: { name: 'x' } } }, agent),
    ]);
    assert.equal(deriveVersionEntries(record)[0]!.actor, 'Editor (agent)');
  });

  it('is empty for a record with no history', () => {
    assert.deepEqual(deriveVersionEntries(recordWith([])), []);
  });
});

describe('deriveActivityEntries', () => {
  it('returns every entry, lock churn included, newest first', () => {
    const history = [
      entry('2026-08-01T00:00:00.000Z', 'checkout'),
      entry('2026-08-02T00:00:00.000Z', 'patch'),
      entry('2026-08-03T00:00:00.000Z', 'checkin'),
    ];
    const activity = deriveActivityEntries({ history });
    assert.deepEqual(
      activity.map((item) => item.action),
      ['checkin', 'patch', 'checkout']
    );
  });

  it('does not mutate the record’s own history array', () => {
    const history = [entry('2026-08-01T00:00:00.000Z', 'checkout'), entry('2026-08-02T00:00:00.000Z', 'patch')];
    deriveActivityEntries({ history });
    assert.equal(history[0]!.action, 'checkout');
  });
});

describe('deriveUsage', () => {
  it('reports itself as unavailable and names real would-be sources', () => {
    const usage = deriveUsage();
    assert.equal(usage.available, false);
    assert.ok(usage.message.length > 0);
    assert.ok(usage.wouldBePopulatedBy.length >= 1);
    assert.ok(
      usage.wouldBePopulatedBy.some((source) => source.includes('referrer')),
      'the retire verb’s referrer index is the real source this tab would use'
    );
  });
});
