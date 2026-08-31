/**
 * Reviewer action-availability for the generic objects surface (T1.5) —
 * DISPLAY ONLY. This answers "which buttons should render for this
 * principal," never "is this write authorized" — that is exclusively
 * `netlify/lib/publish-gate.ts`'s `checkPublishGate`, enforced server-side
 * on every `publish_by_time`/`review_decide` call regardless of what this
 * module renders. A bug here can show a stale or missing button; it cannot
 * grant a publish the server would refuse.
 *
 * Kept client-safe on purpose: `publish-gate.ts` pulls in
 * `netlify/lib/roles.ts` → `admin-auth.ts` (Netlify Identity/server env),
 * which has no business in a browser bundle. This module reads only the two
 * small, non-secret facts a reviewer's screen needs — the committed approval
 * policy (src/config/approval-policy.ts, via the same client-safe resolution
 * the server gate uses — public posture, not a security decision) and the
 * content_revision approval-currency comparison (D§3.9; the same comparison
 * `effectiveApproval` makes, over fields the client already received in the
 * `object_get` response).
 */
import {
  activeApprovalPolicy,
  publishRequiresApproval,
  type ApprovalPolicy,
  type GovernedObjectType,
} from '../../lib/approval-policy.js';
import type { UserRole } from './users-client.js';

export type PrincipalKind = 'human' | 'agent';
/**
 * The three tiers with review standing on THIS surface, narrowed from the one
 * role source (`users-client.ts`'s `UserRole`, itself `server/lib/roles.ts`'s
 * five tiers) rather than re-typed here. B1: a second hand-written copy of
 * the role names is how a tier gets renamed in one place and silently missed
 * in another — `Extract` makes that a compile error instead.
 * `owner` is absent on purpose (it expands to admin+publisher server-side,
 * so it never reaches this module as a bare role) and so is `viewer`, which
 * is read-only and has no reviewer standing at all.
 */
export type Role = Extract<UserRole, 'admin' | 'publisher' | 'editor'>;

export type ReviewSummary = {
  state: 'open' | 'changes_requested' | 'approved';
  decisions: ReadonlyArray<{ content_revision: number }>;
};

export type ReviewerAvailabilityInput = {
  objectType: GovernedObjectType;
  principalKind: PrincipalKind;
  roles: readonly Role[];
  hasActiveLock: boolean;
  review?: ReviewSummary;
  contentRevision: number;
  /** The approval policy; defaults to the committed config (tests inject). */
  policy?: ApprovalPolicy;
  /**
   * Pre-resolved `requiresApproval`, e.g. the server-confirmed value on a
   * release-state row. When supplied it wins over `policy`/the committed
   * config outright — the caller already has authoritative, per-object data
   * and resolving the policy again (which may need `activeApprovalPolicy()`'s
   * provider registered) would be redundant. Callers that only know the
   * release state is UNKNOWN should not call this function at all — there is
   * no truthful input to give it; fail closed before this file is reached.
   */
  requiresApprovalOverride?: boolean;
};

export type ReviewerActionAvailability = {
  /** The configured posture for this type (approval policy) — display info. */
  requiresApproval: boolean;
  canSubmitForReview: boolean;
  canRequestChanges: boolean;
  canApprove: boolean;
  /** Autonomous types: publish authority alone. Gated types: a CURRENT approval too. */
  canPublish: boolean;
};

const isApprovedCurrent = (review: ReviewSummary | undefined, contentRevision: number): boolean => {
  if (!review || review.state !== 'approved') return false;
  const last = review.decisions[review.decisions.length - 1];
  return last !== undefined && last.content_revision === contentRevision;
};

const canExecutePublish = (roles: readonly Role[]): boolean => roles.includes('admin') || roles.includes('publisher');

export const reviewerAvailableActions = (input: ReviewerAvailabilityInput): ReviewerActionAvailability => {
  const requiresApproval =
    input.requiresApprovalOverride ?? publishRequiresApproval(input.objectType, input.policy ?? activeApprovalPolicy());
  const isHuman = input.principalKind === 'human';
  const approvedCurrent = isApprovedCurrent(input.review, input.contentRevision);

  return {
    requiresApproval,
    canSubmitForReview: input.hasActiveLock,
    // This admin surface is human (Netlify Identity), so decide buttons render
    // for a role-holding human only; agentic approval happens on the MCP path
    // (review-state.ts decideReview), not here. Decisions are meaningful while open.
    canRequestChanges: isHuman && input.roles.length > 0 && input.review?.state === 'open',
    // `review_decide` (the server verb) itself never requires an open review —
    // it records a fresh decision from whatever state the review is in. This
    // display-only gate is deliberately narrower than the server: a review
    // that has ALREADY been decided (approved — current or stale — or
    // changes_requested) needs an explicit new "open" step before a one-click
    // re-decision is offered again, so a same-click re-approve can never
    // silently paper over a prior human decision (most visibly, a
    // `changes_requested` verdict). An object that has never had a review at
    // all is the one case with nothing to silently override, so it stays
    // directly approvable.
    canApprove: isHuman && input.roles.length > 0 && (input.review === undefined || input.review.state === 'open'),
    // Gated types require a current approval; autonomous types need publish
    // authority alone. Agent execution (M-6 pin matching) is NOT modeled here
    // — this surface is human-only by construction (Netlify Identity gate),
    // so a non-human principalKind always renders Publish absent.
    canPublish: isHuman && canExecutePublish(input.roles) && (requiresApproval ? approvedCurrent : true),
  };
};
