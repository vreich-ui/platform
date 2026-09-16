/**
 * Effective approval — extracted from `review-state.ts` (M0.1, and it is a
 * bundle fix as much as a tidying one).
 *
 * `object-inventory.ts` derives one field of every inventory row from this
 * function, and that single edge pulled `review-state.ts` into the graph of
 * anything that projects an inventory row — which since M0.1 includes the
 * record-write choke point, and therefore `membership/offboarding.ts` and
 * `admin-users`. `review-state.ts` imports the patch machinery
 * (`object-patch-apply.ts` + `object-patch-ops.ts`, ~100 KB of first-party
 * source) for the DISCARD path, which an inventory row has no use for; the
 * `function-bundle-budget` test caught the whole subtree arriving in a
 * function that only lists people.
 *
 * So the pure, dependency-free half lives here and `review-state.ts` re-exports
 * it: every existing importer is untouched, and a row projection now costs the
 * twenty lines it actually reads.
 */
import type { ObjectRecord, ReviewState } from '../../schema/object-record-v1.js';

export type EffectiveApproval =
  | { state: 'none' }
  | { state: 'open' }
  | { state: 'changes_requested' }
  | { state: 'approved_stale'; approval: ReviewState['decisions'][number] }
  | { state: 'approved_current'; approval: ReviewState['decisions'][number] };

/**
 * Derives approval currency from the pin, never from review.state alone: an
 * 'approved' record whose content_revision has moved past the pinned one is
 * stale (a body write happened after approval — D§3.9 invalidation), while
 * version-only churn (locks, publish stamps) leaves it current.
 */
export const effectiveApproval = (record: ObjectRecord): EffectiveApproval => {
  const review = record.review;
  if (!review) return { state: 'none' };
  if (review.state === 'open') return { state: 'open' };
  if (review.state === 'changes_requested') return { state: 'changes_requested' };

  const last = review.decisions[review.decisions.length - 1];
  if (!last || last.decision !== 'approve') return { state: 'none' };
  return last.content_revision === record.content_revision
    ? { state: 'approved_current', approval: last }
    : { state: 'approved_stale', approval: last };
};

