import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildVariantFamilies, type VariantFamily, type VariantMember } from './variant-experiments.js';
import {
  planWinnerSelection,
  selectWinner,
  winnerSelectionBlockers,
  type WinnerSelectionDeps,
} from './variant-winner.js';
import type { VerbResult } from '../edit-mode/verbs-client.js';

const member = (overrides: Partial<VariantMember> & { object_id: string }): VariantMember => ({
  display_name: overrides.object_id,
  status: 'active',
  review_state: 'none',
  published_time: null,
  unpublished_changes: true,
  updated_at: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

const published = (id: string, extra: Partial<VariantMember> = {}): VariantMember =>
  member({ object_id: id, published_time: '2026-08-01T00:00:00.000Z', unpublished_changes: false, ...extra });

/** Parent live, one drafted clone — the ordinary "promote the variant" shape. */
const familyOf = (members: VariantMember[]): VariantFamily => buildVariantFamilies(members)[0]!;

const CLASSIC = () =>
  familyOf([published('art_parent'), member({ object_id: 'art_v', parent_content_id: 'art_parent' })]);

const getToken = async () => 'token';

interface Recorder {
  deps: WinnerSelectionDeps;
  calls: string[];
}

/**
 * A verb double that records `action:object_id` and answers from a script.
 * `checkout` hands back a lock token because every write leg needs one.
 */
function recorder(script: Record<string, VerbResult> = {}): Recorder {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      callVerb: async (_token, body) => {
        const key = `${String(body.action)}:${String(body.object_id)}`;
        calls.push(key);
        const scripted = script[key] ?? script[String(body.action)];
        if (scripted) return scripted;
        if (body.action === 'checkout') return { status: 200, body: { lockToken: `lock-${String(body.object_id)}` } };
        return { status: 200, body: {} };
      },
    },
  };
}

describe('winnerSelectionBlockers', () => {
  it('passes a clean promote', () => {
    assert.deepEqual(winnerSelectionBlockers(CLASSIC(), 'art_v'), []);
  });

  it('refuses a winner that is not in the family', () => {
    const blockers = winnerSelectionBlockers(CLASSIC(), 'art_elsewhere');
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0]?.code, 'winner_not_in_family');
  });

  it('refuses an archived winner and says why undoing is not a button', () => {
    const family = familyOf([
      published('art_parent'),
      member({ object_id: 'art_v', parent_content_id: 'art_parent', status: 'archived' }),
    ]);
    const blockers = winnerSelectionBlockers(family, 'art_v');
    assert.equal(blockers[0]?.code, 'winner_archived');
    assert.match(blockers[0]!.message, /no unarchive verb/);
  });

  it('names the lock holder rather than failing at the server', () => {
    const family = familyOf([
      published('art_parent'),
      member({
        object_id: 'art_v',
        parent_content_id: 'art_parent',
        lock: { held: true, own: false, owner_label: 'draft-agent' },
      }),
    ]);
    assert.equal(winnerSelectionBlockers(family, 'art_v')[0]?.code, 'winner_locked_elsewhere');
    assert.match(winnerSelectionBlockers(family, 'art_v')[0]!.message, /draft-agent/);
  });

  it('mirrors the publish gate: an approval-governed type with no current approval cannot publish', () => {
    const family = familyOf([
      published('art_parent'),
      member({
        object_id: 'art_v',
        parent_content_id: 'art_parent',
        requires_approval: true,
        approval_state: 'none',
      }),
    ]);
    assert.equal(winnerSelectionBlockers(family, 'art_v')[0]?.code, 'winner_needs_approval');
  });

  it('explains a stale approval as the M-6 pin, not a missing one', () => {
    const family = familyOf([
      published('art_parent'),
      member({
        object_id: 'art_v',
        parent_content_id: 'art_parent',
        requires_approval: true,
        approval_state: 'approved_stale',
      }),
    ]);
    assert.match(winnerSelectionBlockers(family, 'art_v')[0]!.message, /earlier revision/);
  });

  it('does not demand approval when the winner needs no publish at all', () => {
    const family = familyOf([
      published('art_parent'),
      published('art_v', { parent_content_id: 'art_parent', requires_approval: true, approval_state: 'none' }),
    ]);
    assert.deepEqual(
      winnerSelectionBlockers(family, 'art_v').map((blocker) => blocker.code),
      []
    );
  });

  it('mirrors retire refusing to discard a pending human decision on the loser', () => {
    const family = familyOf([
      published('art_parent', { review_state: 'open' }),
      member({ object_id: 'art_v', parent_content_id: 'art_parent' }),
    ]);
    assert.equal(winnerSelectionBlockers(family, 'art_v')[0]?.code, 'loser_review_open');
  });
});

describe('planWinnerSelection', () => {
  it('is promote-then-archive, and every promote step precedes every archive step', () => {
    const plan = planWinnerSelection(CLASSIC(), 'art_v');
    assert.deepEqual(
      plan.steps.map((step) => `${step.id}:${step.objectId}`),
      [
        'checkout_winner:art_v',
        'publish_winner:art_v',
        'checkin_winner:art_v',
        'checkout_loser:art_parent',
        'retire_loser:art_parent',
      ]
    );
    assert.deepEqual(
      plan.steps.map((step) => step.verb),
      ['checkout', 'publish_by_time', 'checkin', 'checkout', 'retire']
    );
    assert.equal(plan.runnable, true);
  });

  it('skips the publish leg when the winner is already published and unedited', () => {
    const family = familyOf([published('art_parent'), published('art_v', { parent_content_id: 'art_parent' })]);
    const plan = planWinnerSelection(family, 'art_v');
    assert.deepEqual(
      plan.steps.map((step) => step.id),
      ['checkout_loser', 'retire_loser']
    );
  });

  it('still publishes an already-published winner that has unpublished edits', () => {
    const family = familyOf([
      published('art_parent'),
      published('art_v', { parent_content_id: 'art_parent', unpublished_changes: true }),
    ]);
    assert.ok(planWinnerSelection(family, 'art_v').steps.some((step) => step.id === 'publish_winner'));
  });

  it('archives only live losers and says why the drafts are left alone', () => {
    const family = familyOf([
      published('art_parent'),
      member({ object_id: 'art_v1', parent_content_id: 'art_parent' }),
      member({ object_id: 'art_v2', parent_content_id: 'art_parent' }),
    ]);
    const plan = planWinnerSelection(family, 'art_v1');
    assert.deepEqual(
      plan.losers.map((loser) => loser.member.object_id),
      ['art_parent']
    );
    assert.deepEqual(
      plan.untouched.map((view) => view.member.object_id),
      ['art_v2']
    );
    assert.match(plan.untouchedReason, /retire removes a published export/);
  });

  it('archives every live loser when more than one is published', () => {
    const family = familyOf([
      published('art_parent'),
      published('art_v1', { parent_content_id: 'art_parent' }),
      published('art_v2', { parent_content_id: 'art_parent' }),
    ]);
    const plan = planWinnerSelection(family, 'art_v1');
    assert.deepEqual(
      plan.losers.map((loser) => loser.member.object_id),
      ['art_parent', 'art_v2']
    );
    assert.equal(plan.steps.filter((step) => step.id === 'retire_loser').length, 2);
  });

  it('refuses a no-op instead of running an empty sequence', () => {
    const family = familyOf([
      published('art_parent', { status: 'archived' }),
      published('art_v', { parent_content_id: 'art_parent' }),
    ]);
    const plan = planWinnerSelection(family, 'art_v');
    assert.equal(plan.runnable, false);
    assert.equal(plan.blockers[0]?.code, 'nothing_to_do');
  });
});

describe('selectWinner — the happy path', () => {
  it('sends exactly the planned verb sequence and nothing else', async () => {
    const rec = recorder();
    const outcome = await selectWinner(getToken, planWinnerSelection(CLASSIC(), 'art_v'), rec.deps);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.state, 'complete');
    assert.deepEqual(rec.calls, [
      'checkout:art_v',
      'publish_by_time:art_v',
      'checkin:art_v',
      'checkout:art_parent',
      'retire:art_parent',
    ]);
    assert.deepEqual(outcome.archived, ['art_parent']);
  });

  it('says in the receipt that the archived permalink stops resolving', async () => {
    const outcome = await selectWinner(getToken, planWinnerSelection(CLASSIC(), 'art_v'), recorder().deps);
    assert.match(outcome.receipt, /next release/);
    assert.match(outcome.receipt, /no redirect/);
  });

  it('carries the winner into the retire reason, so the archive says why', async () => {
    let reason: unknown;
    const deps: WinnerSelectionDeps = {
      callVerb: async (_token, body) => {
        if (body.action === 'retire') reason = body.reason;
        if (body.action === 'checkout') return { status: 200, body: { lockToken: 'lock' } };
        return { status: 200, body: {} };
      },
    };
    await selectWinner(getToken, planWinnerSelection(CLASSIC(), 'art_v'), deps);
    assert.match(String(reason), /Superseded by art_v/);
  });
});

describe('selectWinner — failures that changed nothing', () => {
  it('refuses to send anything when a blocker stands', async () => {
    const rec = recorder();
    const family = familyOf([
      published('art_parent', { review_state: 'open' }),
      member({ object_id: 'art_v', parent_content_id: 'art_parent' }),
    ]);
    const outcome = await selectWinner(getToken, planWinnerSelection(family, 'art_v'), rec.deps);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.state, 'not_started');
    assert.deepEqual(rec.calls, []);
    assert.match(outcome.receipt, /Nothing was changed/);
  });

  it('reports not_started when the winner cannot be checked out', async () => {
    const rec = recorder({ 'checkout:art_v': { status: 423, body: { error: 'Lock required' } } });
    const outcome = await selectWinner(getToken, planWinnerSelection(CLASSIC(), 'art_v'), rec.deps);
    assert.equal(outcome.state, 'not_started');
    assert.equal(outcome.failedStep?.id, 'checkout_winner');
    assert.deepEqual(rec.calls, ['checkout:art_v']);
  });

  it('releases the lock it took when the publish is refused, and never touches the loser', async () => {
    const rec = recorder({
      'publish_by_time:art_v': { status: 403, body: { error: 'Publishing requires approval' } },
    });
    const outcome = await selectWinner(getToken, planWinnerSelection(CLASSIC(), 'art_v'), rec.deps);
    assert.equal(outcome.state, 'not_started');
    assert.equal(outcome.failedStep?.id, 'publish_winner');
    assert.deepEqual(rec.calls, ['checkout:art_v', 'publish_by_time:art_v', 'checkin:art_v']);
    assert.match(outcome.error!, /requires approval/);
  });
});

describe('selectWinner — the half-applied state', () => {
  it('names it, refuses to call it a rollback, and points at the resume', async () => {
    const rec = recorder({ 'retire:art_parent': { status: 409, body: { error: 'Still referenced by page_blog' } } });
    const outcome = await selectWinner(getToken, planWinnerSelection(CLASSIC(), 'art_v'), rec.deps);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.state, 'promoted_not_archived');
    assert.deepEqual(outcome.completed, ['checkout_winner', 'publish_winner', 'checkin_winner', 'checkout_loser']);
    assert.deepEqual(outcome.archived, []);
    assert.equal(outcome.recovery?.resumable, true);
    assert.equal(outcome.recovery?.resumeFrom, 'checkout_loser');
    assert.match(outcome.recovery!.message, /both permalinks serve/);
    assert.match(outcome.recovery!.message, /no unpublish verb/);
    assert.match(outcome.recovery!.message, /resumes at the archive step/);
    // The lock taken for the failed retire is released so the resume is not self-blocked.
    assert.ok(rec.calls.includes('checkin:art_parent'));
  });

  it('keeps the losers it did archive, so a resume does not redo them', async () => {
    const family = familyOf([
      published('art_parent'),
      published('art_v1', { parent_content_id: 'art_parent' }),
      published('art_v2', { parent_content_id: 'art_parent' }),
    ]);
    const rec = recorder({ 'checkout:art_v2': { status: 423, body: { error: 'Lock required' } } });
    const outcome = await selectWinner(getToken, planWinnerSelection(family, 'art_v1'), rec.deps);
    assert.equal(outcome.state, 'promoted_not_archived');
    assert.deepEqual(outcome.archived, ['art_parent']);
    // Only the un-archived loser is named as still live.
    assert.match(outcome.recovery!.message, /art_v2/);
    assert.doesNotMatch(outcome.recovery!.message, /art_parent/);
  });

  it('treats a failed check-in as a warning, not a failure — the lease expires anyway', async () => {
    const rec = recorder({ 'checkin:art_v': { status: 423, body: { error: 'Lock not held' } } });
    const outcome = await selectWinner(getToken, planWinnerSelection(CLASSIC(), 'art_v'), rec.deps);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.state, 'complete');
    assert.equal(outcome.warnings.length, 1);
    assert.match(outcome.warnings[0]!, /lease expires/);
  });
});
