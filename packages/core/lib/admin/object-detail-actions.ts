/**
 * Object detail — rights → control mapping, and the review-decision
 * availability the workspace actually renders (T2.2; closes T0.3 rows
 * A1/A2/A4 for this surface).
 *
 * D3/A4: a control the viewer may not use renders DISABLED WITH A REASON,
 * never silently absent. That is why `resolveObjectControls` returns an entry
 * for every control id unconditionally — there is no code path here that can
 * drop a control from the map, so a surface iterating this map cannot
 * accidentally hide one. Where an action is unavailable because no endpoint
 * exists at all (`retire` — T0.1 §7: "no `.tsx` calls `action:'retire'`… no
 * `retire` chat tool… reachable only via raw MCP"), the reason SAYS that
 * rather than pretending it is a permission problem.
 *
 * A1/A2: `reviewerAvailableActions` (`object-review-ui.ts`) has computed
 * `canRequestChanges` since T1.5 with, per T0.3, zero consumers. This module
 * is its consumer, and it adds the one state that function does not model —
 * `canReopenReview`, the control the workspace's own copy ("resolve them,
 * then re-open review before approving") names but that had no button
 * anywhere. Re-opening is `submit_review`, which requires a held lock, so
 * the reason string is honest about needing the checkout.
 *
 * DISPLAY ONLY, exactly like `object-review-ui.ts`: the server re-derives
 * authority on every call (`publish-gate.ts`, `review-state.ts`'s
 * `canDecideReview`). A bug here shows a wrong button state; it cannot grant
 * a write the server would refuse.
 */
import type { ObjectType } from '../../schema/object-record-v1.js';
import type { ObjectReviewTarget } from './decisions.js';
import {
  reviewerAvailableActions,
  type ReviewSummary,
  type ReviewerActionAvailability,
  type Role,
} from './object-review-ui.js';
import type { GovernedObjectType } from '../approval-policy.js';
import { objectEditMode, type ObjectEditMode } from './object-detail-form.js';

export const OBJECT_CONTROL_IDS = [
  'edit_fields',
  'submit_review',
  'approve',
  'request_changes',
  'reopen_review',
  'publish',
  'discard',
  'new_variant',
  'release_lock',
  'retire',
] as const;
export type ObjectControlId = (typeof OBJECT_CONTROL_IDS)[number];

export interface ControlState {
  enabled: boolean;
  /** Why it is disabled. Always set when `enabled` is false — the tooltip copy. */
  reason?: string;
}

export type ObjectControlMap = Record<ObjectControlId, ControlState>;

export interface ObjectControlsInput {
  objectType: ObjectType;
  /** Reviewer-relevant roles the signed-in human holds. */
  roles: readonly Role[];
  isOwner: boolean;
  /** False when the release row could not be confirmed — everything publish-shaped fails closed. */
  releaseKnown: boolean;
  /** Whether a lock is held on the record at all. */
  lockHeld: boolean;
  /** True when the held lock belongs to someone else (or an agent). */
  lockHeldByOther: boolean;
  review?: ReviewSummary;
  contentRevision: number;
  /** Server-confirmed `requires_approval` from the release row, when known. */
  requiresApprovalOverride?: boolean;
  status: 'active' | 'archived';
}

export interface ReviewDecisionAvailability extends ReviewerActionAvailability {
  /**
   * The A1 control: a review sitting in `changes_requested` needs an explicit
   * re-open (`submit_review`) before it is approvable again. Not modeled by
   * `reviewerAvailableActions` — it only reports that Approve is unavailable.
   */
  canReopenReview: boolean;
}

const NO_ROLE_REASON = 'You do not have review or publish authority for this object.';
const UNKNOWN_RELEASE_REASON =
  "This object's release and approval state couldn't be confirmed, so publish-related actions stay disabled until it can be.";
const ARCHIVED_REASON = 'This object is archived. Restore it before editing or publishing.';

/**
 * The review-decision picture for one record. `releaseKnown: false` returns
 * everything false — the same fail-closed rule `ObjectWorkspace` already
 * applied to Publish, extended to the decision buttons so a stale release row
 * cannot make Approve look available.
 */
export const reviewDecisionAvailability = (
  input: Pick<
    ObjectControlsInput,
    'objectType' | 'roles' | 'releaseKnown' | 'lockHeld' | 'review' | 'contentRevision' | 'requiresApprovalOverride'
  >
): ReviewDecisionAvailability => {
  if (!input.releaseKnown) {
    return {
      requiresApproval: true,
      canSubmitForReview: false,
      canRequestChanges: false,
      canApprove: false,
      canPublish: false,
      canReopenReview: false,
    };
  }
  const base = reviewerAvailableActions({
    objectType: input.objectType as GovernedObjectType,
    principalKind: 'human',
    roles: input.roles,
    hasActiveLock: input.lockHeld,
    review: input.review,
    contentRevision: input.contentRevision,
    ...(input.requiresApprovalOverride !== undefined
      ? { requiresApprovalOverride: input.requiresApprovalOverride }
      : {}),
  });
  return {
    ...base,
    canReopenReview: input.roles.length > 0 && input.review?.state === 'changes_requested',
  };
};

/**
 * T3.2 hand-off, closed: the `DecisionTarget` the object detail view hands to
 * `decide()` (`./decisions.ts`), built from the same inputs the buttons are
 * gated on so the façade's own pre-flight check and the rendered disabled
 * state can never disagree.
 *
 * Why the detail view goes through the façade at all rather than calling
 * `EditSession.approveReview()`/`requestChanges()` directly, which also work:
 * `decide()` is the one path that drives the optimistic overlay AND
 * invalidates T2.3's shared request index, so an approval taken here updates
 * the header pill and the runs inbox without a reload. A second decision path
 * would be correct on the wire and still break that.
 *
 * `reviewRevision` is `content_revision`, not `version` — a review has no id
 * and its decisions pin to the revision (D§3.9); `lock` is context for the
 * reject receipt, since a rejection asks for editor work that cannot start
 * while an agent still holds the checkout.
 */
export interface ObjectReviewTargetInput {
  objectType: ObjectType;
  objectId: string;
  displayName?: string;
  contentRevision?: number;
  availability: Pick<ReviewerActionAvailability, 'canApprove' | 'canRequestChanges'>;
  lock?: { held: boolean; ownerLabel?: string };
  /**
   * The editorial request this object's review belongs to, when the surface
   * has a SERVER-resolved link to one — the detail view passes the request
   * its object chat is bound to (`useChat().request`, W19 T19.5's
   * `requestRowForChat`). It makes the approval taken here move the inbox
   * row, the header pill and the needs-you dropdown in the same tick
   * (`decisionKeys` in `decisions.ts`).
   *
   * Omitted when there is no such link, and never invented from `objectId`:
   * a `content_item` id wears the `req_*` request-id shape, but `mintId`
   * hands that shape to content items no editorial request ever produced,
   * so reading one as the other would file a key for a request that does not
   * exist. No link, no alias, behaviour exactly as before.
   */
  requestId?: string;
}

export const objectReviewDecisionTarget = (input: ObjectReviewTargetInput): ObjectReviewTarget => ({
  mechanism: 'object_review',
  objectType: input.objectType,
  objectId: input.objectId,
  ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
  ...(input.contentRevision !== undefined ? { reviewRevision: input.contentRevision } : {}),
  ...(input.lock !== undefined ? { lock: input.lock } : {}),
  ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  availability: {
    canApprove: input.availability.canApprove,
    canRequestChanges: input.availability.canRequestChanges,
  },
});

const state = (enabled: boolean, reason: string): ControlState =>
  enabled ? { enabled: true } : { enabled: false, reason };

/**
 * Every control the detail view offers, with its enabled state and — when
 * disabled — the reason to put in the tooltip. Nothing is omitted.
 */
export const resolveObjectControls = (input: ObjectControlsInput): ObjectControlMap => {
  const archived = input.status === 'archived';
  const availability = reviewDecisionAvailability(input);
  const editMode: ObjectEditMode = objectEditMode(input.objectType);
  const hasRole = input.roles.length > 0;

  const lockReason = input.lockHeldByOther
    ? 'Another editor or an agent holds the checkout on this object.'
    : undefined;

  const editFields = (): ControlState => {
    if (archived) return { enabled: false, reason: ARCHIVED_REASON };
    if (editMode !== 'form') {
      return {
        enabled: false,
        reason: 'This object type has no flat fields to edit — describe the change to the agent instead.',
      };
    }
    if (lockReason) return { enabled: false, reason: lockReason };
    return { enabled: true };
  };

  const decisionReason = (): string => {
    if (!input.releaseKnown) return UNKNOWN_RELEASE_REASON;
    if (archived) return ARCHIVED_REASON;
    if (!hasRole) return NO_ROLE_REASON;
    if (input.review?.state === 'changes_requested') {
      return 'Changes were requested on this review. Re-open review once they are resolved, then decide again.';
    }
    if (input.review?.state === 'approved') {
      return 'This review has already been decided. Re-open review to decide again.';
    }
    if (input.review === undefined) return 'No review has been opened on this object yet.';
    return 'Waiting on a review decision.';
  };

  return {
    edit_fields: editFields(),
    // `submit_review` writes under a held lock, but the handler takes the
    // checkout itself — so the gate here is "nobody ELSE holds it", not
    // "you already hold it" (which is what `reviewerAvailableActions`'
    // `canSubmitForReview` reports, and which would leave this permanently
    // disabled for anyone who has not manually checked out first).
    submit_review: archived
      ? { enabled: false, reason: ARCHIVED_REASON }
      : lockReason
        ? { enabled: false, reason: lockReason }
        : state(hasRole, NO_ROLE_REASON),
    approve: state(availability.canApprove && !archived, decisionReason()),
    request_changes: state(availability.canRequestChanges && !archived, decisionReason()),
    reopen_review: archived
      ? { enabled: false, reason: ARCHIVED_REASON }
      : state(
          availability.canReopenReview,
          hasRole ? 'Re-opening a review applies only while changes have been requested on it.' : NO_ROLE_REASON
        ),
    publish: !input.releaseKnown
      ? { enabled: false, reason: UNKNOWN_RELEASE_REASON }
      : archived
        ? { enabled: false, reason: ARCHIVED_REASON }
        : state(
            availability.canPublish,
            availability.requiresApproval
              ? 'This object type requires a current approval before it can be published.'
              : 'Publishing requires the admin or publisher role.'
          ),
    discard: archived
      ? { enabled: false, reason: ARCHIVED_REASON }
      : lockReason
        ? { enabled: false, reason: lockReason }
        : state(hasRole, NO_ROLE_REASON),
    new_variant:
      input.objectType !== 'content_item'
        ? {
            enabled: false,
            reason: 'Variants exist only for articles — create_variant takes a content_item as its source.',
          }
        : state(!archived, ARCHIVED_REASON),
    release_lock: state(
      input.lockHeld && input.isOwner,
      input.lockHeld
        ? 'Only an Owner can force-release someone else’s checkout.'
        : 'Nothing holds a checkout on this object.'
    ),
    // T0.1 §7: object_retire has no admin UI call site and no chat tool — it
    // is reachable only over raw MCP. Rendering it disabled with that reason
    // is the honest state; wiring it is T4.x, not this task.
    retire: {
      enabled: false,
      reason: 'Retiring an object has no admin endpoint today — the object_retire verb is reachable only over MCP.',
    },
  };
};
