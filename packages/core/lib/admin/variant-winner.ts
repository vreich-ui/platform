/**
 * T4.4 — "select winner", composed from the verbs that exist.
 *
 * There is no `object_promote_variant`. A winner selection is two independent
 * governed legs over `admin-object`, in this order and no other:
 *
 *   PROMOTE  checkout -> publish_by_time -> checkin      (on the winner)
 *   ARCHIVE  checkout -> retire                          (on each live loser)
 *
 * Both legs are ordinary verb calls through `callObjectVerb`
 * (`lib/edit-mode/verbs-client.ts`) — the same path the object workspace uses.
 * Nothing here writes a record, a status or an index directly; there is no
 * side channel.
 *
 * ## Why promote first
 *
 * The two legs are NOT atomic and cannot be made so from the client. The order
 * is chosen so that the half-applied state is the reader-safe one:
 *
 *   - promote-then-archive, interrupted => the winner is live AND the loser is
 *     still live. Two permalinks for one article: duplicate, embarrassing,
 *     recoverable by finishing the archive.
 *   - archive-then-promote, interrupted => the loser is gone and the winner is
 *     not up. A hole where an article used to be. Unacceptable.
 *
 * ## Why there is no rollback
 *
 * `publish_by_time` only moves forward — unpublish is rejected (OQ-2, see
 * `verbs-client.ts:359`), so a completed promote cannot be undone by this code
 * and this module never claims it can. A half-applied selection is therefore
 * RESUMED, not reverted: `retire` is idempotent (an already-archived record
 * returns 200 `already_archived`, `server/lib/object-retire.ts:117-127`), so
 * re-running the archive leg is always safe. `outcome.recovery` carries the
 * resume point and the sentence the UI must show.
 *
 * ## Two consequences the confirm dialog has to state
 *
 *   1. `retire` writes a 301 only for `page` objects — `routeOf` returns
 *      undefined for anything else (`object-retire.ts:92-96`). Archiving a
 *      losing ARTICLE therefore removes its export with NO redirect: its
 *      permalink stops resolving on the next release.
 *   2. `retire` archives, it does not delete (the record and its history
 *      survive; `object-purge.ts` hard-deletes only after the grace period) —
 *      but the object store has no unarchive verb, so undoing it is an
 *      operator job, not a button.
 */
import type { GetToken, VerbResult } from '../edit-mode/verbs-client.js';
import type { VariantFamily, VariantMemberView } from './variant-experiments.js';

// ─── pre-flight ─────────────────────────────────────────────────────────────

export type WinnerBlockerCode =
  | 'winner_not_in_family'
  | 'winner_archived'
  | 'winner_locked_elsewhere'
  | 'winner_needs_approval'
  | 'loser_review_open'
  | 'loser_locked_elsewhere'
  | 'nothing_to_do';

export interface WinnerBlocker {
  code: WinnerBlockerCode;
  /** Which object the blocker is about, when it is about one. */
  objectId?: string;
  /** Cause, then escape hatch — D4 `blocked` tone, written for an editor. */
  message: string;
}

/**
 * Everything that would make the sequence fail server-side, checked BEFORE
 * anything is written. Each one mirrors a real refusal:
 *
 *   winner_needs_approval  -> the publish gate's `requires_approval` denial
 *                             (`checkPublishGate`); on a site whose approval
 *                             policy governs `content_item`, an approval that
 *                             is absent or stale (M-6) refuses the publish.
 *   loser_review_open      -> `object-retire.ts:143` 409 `review_open`.
 *   *_locked_elsewhere     -> 423 `lock_required` from checkout/retire.
 *
 * A blocker is not a disabled button for its own sake: the caller renders each
 * message next to the action so the editor learns what to resolve.
 */
export function winnerSelectionBlockers(family: VariantFamily, winnerId: string): WinnerBlocker[] {
  const blockers: WinnerBlocker[] = [];
  const winner = family.members.find((view) => view.member.object_id === winnerId);
  if (!winner) {
    return [
      {
        code: 'winner_not_in_family',
        objectId: winnerId,
        message: `${winnerId} is not part of this variant family. Reload the list and pick a member of it.`,
      },
    ];
  }

  if (winner.member.status === 'archived') {
    blockers.push({
      code: 'winner_archived',
      objectId: winnerId,
      message:
        'This article is archived, and the object store has no unarchive verb. Pick a live member, or ask an operator to restore this record first.',
    });
  }
  if (winner.member.lock?.held && !winner.member.lock.own) {
    blockers.push({
      code: 'winner_locked_elsewhere',
      objectId: winnerId,
      message: `${winner.member.lock.owner_label ?? 'Someone else'} is editing this article. Publishing needs the lock, so this waits until they check it back in.`,
    });
  }
  if (needsPublish(winner) && winner.member.requires_approval && winner.member.approval_state !== 'approved_current') {
    blockers.push({
      code: 'winner_needs_approval',
      objectId: winnerId,
      message:
        winner.member.approval_state === 'approved_stale'
          ? 'The approval on this article was pinned to an earlier revision and stopped applying when the body changed. It has to be approved again before it can publish.'
          : 'Publishing this type needs a human approval on this site, and this article does not have a current one. Approve it in the object workspace, then come back.',
    });
  }

  for (const loser of losersOf(family, winnerId)) {
    if (loser.member.review_state === 'open') {
      blockers.push({
        code: 'loser_review_open',
        objectId: loser.member.object_id,
        message: `${loser.member.display_name} has an open review, and retire refuses to discard a pending human decision. Decide that review first.`,
      });
    }
    if (loser.member.lock?.held && !loser.member.lock.own) {
      blockers.push({
        code: 'loser_locked_elsewhere',
        objectId: loser.member.object_id,
        message: `${loser.member.lock.owner_label ?? 'Someone else'} is editing ${loser.member.display_name}. Archiving needs the lock, so this waits until they check it back in.`,
      });
    }
  }

  return blockers;
}

/** A published member that is not the winner — the only kind of loser there is to archive. */
const losersOf = (family: VariantFamily, winnerId: string): VariantMemberView[] =>
  family.members.filter(
    (view) => view.member.object_id !== winnerId && view.member.status === 'active' && view.live === true
  );

/**
 * Never-published, non-archived siblings. They are NOT retired: nothing of
 * theirs is serving, and `retire` deletes the export a publish would have
 * written — asking it to remove an export that was never committed is a git
 * commit with a deletion of a path that does not exist. They stay as drafts and
 * the UI says so rather than quietly leaving them out.
 */
const untouchedOf = (family: VariantFamily, winnerId: string): VariantMemberView[] =>
  family.members.filter(
    (view) => view.member.object_id !== winnerId && view.member.status === 'active' && view.live === false
  );

/** True when the winner still needs a publish call — already-published-and-unedited does not. */
const needsPublish = (winner: VariantMemberView): boolean =>
  !winner.member.published_time || winner.member.unpublished_changes;

// ─── the plan ───────────────────────────────────────────────────────────────

export type WinnerStepId = 'checkout_winner' | 'publish_winner' | 'checkin_winner' | 'checkout_loser' | 'retire_loser';

export interface WinnerStep {
  id: WinnerStepId;
  objectId: string;
  /** The verb `action` this step sends, so the plan is checkable against the verb surface. */
  verb: 'checkout' | 'publish_by_time' | 'checkin' | 'retire';
  /** One line of editor-facing copy for the confirm dialog's sequence list. */
  label: string;
}

export interface WinnerPlan {
  familyParentId: string;
  winner: VariantMemberView;
  losers: VariantMemberView[];
  /** Active siblings deliberately left alone, with `untouchedReason` explaining why. */
  untouched: VariantMemberView[];
  untouchedReason: string;
  steps: WinnerStep[];
  blockers: WinnerBlocker[];
  /** False when a blocker stands, or when there is genuinely nothing to do. */
  runnable: boolean;
}

const UNTOUCHED_REASON =
  'Never-published variants are left as drafts: nothing of theirs is serving, and retire removes a published export rather than a draft.';

/**
 * The exact verb sequence, materialised so the confirm dialog can show it and
 * a test can assert it. Ordering is load-bearing (see the module comment):
 * every promote step precedes every archive step.
 */
export function planWinnerSelection(family: VariantFamily, winnerId: string): WinnerPlan {
  const blockers = winnerSelectionBlockers(family, winnerId);
  const winner =
    family.members.find((view) => view.member.object_id === winnerId) ?? family.members[0] ?? UNKNOWN_MEMBER_VIEW;
  const losers = losersOf(family, winnerId);
  const untouched = untouchedOf(family, winnerId);

  const steps: WinnerStep[] = [];
  if (needsPublish(winner)) {
    steps.push(
      { id: 'checkout_winner', objectId: winnerId, verb: 'checkout', label: `Check out ${winner.member.display_name}` },
      {
        id: 'publish_winner',
        objectId: winnerId,
        verb: 'publish_by_time',
        label: `Publish ${winner.member.display_name}`,
      },
      {
        id: 'checkin_winner',
        objectId: winnerId,
        verb: 'checkin',
        label: `Check ${winner.member.display_name} back in`,
      }
    );
  }
  for (const loser of losers) {
    steps.push(
      {
        id: 'checkout_loser',
        objectId: loser.member.object_id,
        verb: 'checkout',
        label: `Check out ${loser.member.display_name}`,
      },
      {
        id: 'retire_loser',
        objectId: loser.member.object_id,
        verb: 'retire',
        label: `Archive ${loser.member.display_name} and remove its export`,
      }
    );
  }

  if (steps.length === 0 && blockers.length === 0) {
    blockers.push({
      code: 'nothing_to_do',
      objectId: winnerId,
      message:
        'This article is already the only published member of its family. There is nothing to promote or archive.',
    });
  }

  return {
    familyParentId: family.parentId,
    winner,
    losers,
    untouched,
    untouchedReason: UNTOUCHED_REASON,
    steps,
    blockers,
    runnable: blockers.length === 0 && steps.length > 0,
  };
}

/** Only reachable for an empty family, which `buildVariantFamilies` never produces. */
const UNKNOWN_MEMBER_VIEW: VariantMemberView = {
  member: {
    object_id: 'unknown',
    display_name: 'unknown',
    status: 'archived',
    review_state: 'none',
    published_time: null,
    unpublished_changes: false,
    updated_at: '',
  },
  role: 'variant',
  severity: 'blocked',
  statusLabel: 'Unknown',
  live: false,
};

// ─── execution ──────────────────────────────────────────────────────────────

export type WinnerSelectionState =
  /** Refused before any write, or the first write failed: nothing changed. */
  | 'not_started'
  /** The winner is published and at least one live loser is still live. THE half-applied state. */
  | 'promoted_not_archived'
  /** Every step landed. */
  | 'complete';

export interface WinnerRecovery {
  resumable: boolean;
  resumeFrom: WinnerStepId;
  /** Cause, then the way out — D4 `blocked`/`error` copy tone. */
  message: string;
}

export interface WinnerSelectionOutcome {
  ok: boolean;
  state: WinnerSelectionState;
  completed: WinnerStepId[];
  /** Object ids whose archive leg landed — what a resume can skip. */
  archived: string[];
  failedStep?: WinnerStep;
  error?: string;
  /** Non-fatal problems: a check-in that did not land, whose lease expires anyway. */
  warnings: string[];
  recovery?: WinnerRecovery;
  /** One sentence: what was decided and what actually changed because of it. */
  receipt: string;
}

export interface WinnerSelectionDeps {
  callVerb: (getToken: GetToken, body: Record<string, unknown>) => Promise<VerbResult>;
}

const verbError = (result: VerbResult, fallback: string): string =>
  (typeof result.body.error === 'string' && result.body.error) || `${fallback} (${result.status}).`;

const HALF_APPLIED = (winner: string, remaining: readonly string[]): string =>
  `${winner} is published, but ${remaining.join(', ')} ${remaining.length === 1 ? 'is' : 'are'} still live — for now both permalinks serve. Publishing cannot be undone (there is no unpublish verb), so this is finished, not reverted: run Select winner again and it resumes at the archive step. Archiving is idempotent, so nothing is done twice.`;

/**
 * Runs the plan. Never throws: every failure comes back as an outcome whose
 * `state` says exactly how far it got and whose `recovery` says what to do.
 *
 * Locks are released on the way out of a failed promote leg (a lock left
 * hanging blocks the retry), and a check-in that itself fails is a WARNING, not
 * a failure — the lease expires on its own and the write it guarded already
 * landed.
 */
export async function selectWinner(
  getToken: GetToken,
  plan: WinnerPlan,
  deps: WinnerSelectionDeps
): Promise<WinnerSelectionOutcome> {
  const completed: WinnerStepId[] = [];
  const archived: string[] = [];
  const warnings: string[] = [];
  const winnerName = plan.winner.member.display_name;

  const fail = (
    step: WinnerStep,
    error: string,
    state: WinnerSelectionState,
    recovery?: WinnerRecovery
  ): WinnerSelectionOutcome => ({
    ok: false,
    state,
    completed,
    archived,
    failedStep: step,
    error,
    warnings,
    ...(recovery ? { recovery } : {}),
    receipt:
      state === 'promoted_not_archived'
        ? HALF_APPLIED(
            winnerName,
            plan.losers.filter((l) => !archived.includes(l.member.object_id)).map((l) => l.member.display_name)
          )
        : `Nothing was changed: ${error}`,
  });

  if (!plan.runnable) {
    const first = plan.blockers[0];
    return {
      ok: false,
      state: 'not_started',
      completed,
      archived,
      warnings,
      error: first?.message ?? 'This selection cannot run.',
      receipt: `Nothing was changed: ${first?.message ?? 'this selection cannot run.'}`,
    };
  }

  const step = (id: WinnerStepId, objectId: string): WinnerStep =>
    plan.steps.find((candidate) => candidate.id === id && candidate.objectId === objectId) ?? {
      id,
      objectId,
      verb: 'checkout',
      label: id,
    };

  // ── promote leg ──────────────────────────────────────────────────────────
  const winnerId = plan.winner.member.object_id;
  if (plan.steps.some((candidate) => candidate.id === 'publish_winner')) {
    const checkout = await deps.callVerb(getToken, {
      action: 'checkout',
      object_type: 'content_item',
      object_id: winnerId,
    });
    const lockToken = typeof checkout.body.lockToken === 'string' ? checkout.body.lockToken : undefined;
    if (checkout.status !== 200 || !lockToken) {
      return fail(
        step('checkout_winner', winnerId),
        verbError(checkout, 'The winner could not be checked out'),
        'not_started'
      );
    }
    completed.push('checkout_winner');

    const published = await deps.callVerb(getToken, {
      action: 'publish_by_time',
      object_type: 'content_item',
      object_id: winnerId,
      lock_token: lockToken,
    });
    if (published.status !== 200) {
      // Release the lock we took so the retry is not blocked by our own hand.
      const released = await deps.callVerb(getToken, {
        action: 'checkin',
        object_type: 'content_item',
        object_id: winnerId,
        lock_token: lockToken,
      });
      if (released.status !== 200)
        warnings.push(`The edit lock on ${winnerName} is still held; its lease expires on its own.`);
      return fail(step('publish_winner', winnerId), verbError(published, 'The publish was refused'), 'not_started');
    }
    completed.push('publish_winner');

    const checkin = await deps.callVerb(getToken, {
      action: 'checkin',
      object_type: 'content_item',
      object_id: winnerId,
      lock_token: lockToken,
    });
    if (checkin.status === 200) completed.push('checkin_winner');
    else warnings.push(`${winnerName} published, but its edit lock did not release; the lease expires on its own.`);
  }

  // ── archive leg ──────────────────────────────────────────────────────────
  for (const loser of plan.losers) {
    const loserId = loser.member.object_id;
    const checkout = await deps.callVerb(getToken, {
      action: 'checkout',
      object_type: 'content_item',
      object_id: loserId,
    });
    const lockToken = typeof checkout.body.lockToken === 'string' ? checkout.body.lockToken : undefined;
    if (checkout.status !== 200 || !lockToken) {
      return fail(
        step('checkout_loser', loserId),
        verbError(checkout, `${loser.member.display_name} could not be checked out`),
        'promoted_not_archived',
        {
          resumable: true,
          resumeFrom: 'checkout_loser',
          message: HALF_APPLIED(
            winnerName,
            plan.losers.filter((l) => !archived.includes(l.member.object_id)).map((l) => l.member.display_name)
          ),
        }
      );
    }
    completed.push('checkout_loser');

    const retired = await deps.callVerb(getToken, {
      action: 'retire',
      object_type: 'content_item',
      object_id: loserId,
      lock_token: lockToken,
      reason: `Superseded by ${winnerName} (${winnerId}) in a variant winner selection.`,
    });
    if (retired.status !== 200) {
      const released = await deps.callVerb(getToken, {
        action: 'checkin',
        object_type: 'content_item',
        object_id: loserId,
        lock_token: lockToken,
      });
      if (released.status !== 200)
        warnings.push(`The edit lock on ${loser.member.display_name} is still held; its lease expires on its own.`);
      return fail(
        step('retire_loser', loserId),
        verbError(retired, `${loser.member.display_name} could not be archived`),
        'promoted_not_archived',
        {
          resumable: true,
          resumeFrom: 'checkout_loser',
          message: HALF_APPLIED(
            winnerName,
            plan.losers.filter((l) => !archived.includes(l.member.object_id)).map((l) => l.member.display_name)
          ),
        }
      );
    }
    completed.push('retire_loser');
    archived.push(loserId);
  }

  const archivedNames = plan.losers.map((loser) => loser.member.display_name);
  return {
    ok: true,
    state: 'complete',
    completed,
    archived,
    warnings,
    receipt:
      archivedNames.length === 0
        ? `${winnerName} is published. Nothing needed archiving.`
        : `${winnerName} is published and ${archivedNames.join(', ')} ${archivedNames.length === 1 ? 'is' : 'are'} archived, exports removed. Both changes go live on the next release; an archived article keeps its record and history but has no redirect, so its old permalink stops resolving.`,
  };
}
