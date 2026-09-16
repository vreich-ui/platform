/**
 * Review-state machine (T1.4) — submit / approve / request_changes /
 * discard on the ObjectRecord envelope (D§3.9, C§2.0 state machine).
 *
 * Counter discipline (D§3.1, the twice-hardened invariant): every operation
 * here is review BOOKKEEPING — it bumps `version` (every write does) and
 * NEVER `content_revision` — except discard, which is a genuine body write
 * through the T0.6 engine and therefore bumps `content_revision`, correctly
 * invalidating any approval granted while the rejected change was still in
 * the draft (C§2.4, stated consequence).
 *
 * Approvals pin `{content_revision, publish_action}` together (M-6): the
 * decision entry is the durable home of the pin the publish gate reads.
 * Invalidation is LOGICAL, not stored — nothing here rewrites review.state
 * when the body later moves; the gate compares the pinned content_revision
 * against the record's current one (effectiveApproval), so lock churn and
 * the publish stamp (which never touch content_revision) cannot invalidate
 * an approval, and any body write inherently does.
 *
 * Discard (C§2.4): agents write to the live draft under lock, so a rejected
 * op has already mutated the draft — Discard is a compensating inverse
 * write. Inverses come from T0.6's derivePatchInverse over exactly what the
 * op's history entry stores (`details: {op, capture}`), are applied
 * newest-first as one atomic batch attributed to the reviewer, and carry
 * guards: if intervening accepted ops moved the same field, the engine
 * refuses the blind revert and the surface demands manual resolution.
 *
 * Lock enforcement is deliberately NOT here: like the T0.6 engine itself,
 * these are pure record transforms; the verb endpoints own auth, locks, and
 * persistence (A§1.2 discipline, T0.8 pattern).
 */
import { z } from 'zod';

import {
  applyPatchOps,
  deepEqualJson,
  derivePatchInverse,
  PatchApplyError,
  type PatchOpCapture,
} from '../../lib/object-patch-apply.js';
import { patchOpSchema, PRIVILEGED_PATCH_OPS, type PatchOp } from '../../schema/object-patch-ops.js';
import type { ObjectRecord, Principal, ReviewState } from '../../schema/object-record-v1.js';
import { canDecideReview, type Role } from './roles.js';

export const publishActionSchema = z.strictObject({
  published_time: z.union([z.string(), z.null(), z.literal('immediate')]),
});
export type PublishAction = z.infer<typeof publishActionSchema>;

/**
 * The extended live-publish pin an approval may additionally carry (Goal 4):
 * the exact content-item/request id, the exact artifact set, and the approved
 * release/build behavior. Enforced against agent execution by the publish gate;
 * omitted fields simply aren't enforced.
 */
export const approvalPinSchema = z.strictObject({
  request_id: z.string().min(1).optional(),
  artifact_set: z.array(z.string().min(1)).optional(),
  release_build: z.enum(['defer', 'release']).optional(),
});
export type ApprovalPin = z.infer<typeof approvalPinSchema>;

const validateApprovalPin = (value: unknown): { pin?: ApprovalPin; error?: ReviewOpResult } => {
  if (value === undefined) return {};
  const parsed = approvalPinSchema.safeParse(value);
  if (!parsed.success) {
    return {
      error: err(400, 'invalid_approval_pin', {
        error:
          'approval_pin must be {request_id?: string, artifact_set?: string[], release_build?: "defer" | "release"}.',
      }),
    };
  }
  return { pin: parsed.data };
};

export type ReviewOpResult =
  | { ok: true; status: 200; record: ObjectRecord; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> };

const err = (status: number, code: string, body: Record<string, unknown> = {}): ReviewOpResult => ({
  ok: false,
  status,
  body: { code, ...body },
});

/** A pinned ISO time must actually be an instant; 'immediate' and null are literal. */
const validatePublishAction = (value: unknown): { action?: PublishAction; error?: ReviewOpResult } => {
  if (value === undefined) return {};
  const parsed = publishActionSchema.safeParse(value);
  if (!parsed.success) {
    return {
      error: err(400, 'invalid_publish_action', {
        error: 'publish_action must be {published_time: ISO | null | "immediate"}.',
      }),
    };
  }
  const time = parsed.data.published_time;
  if (typeof time === 'string' && time !== 'immediate' && Number.isNaN(Date.parse(time))) {
    return {
      error: err(400, 'invalid_publish_action', { error: 'publish_action.published_time is not a valid instant.' }),
    };
  }
  return { action: parsed.data };
};

// ─── submit ──────────────────────────────────────────────────────────────────

export type SubmitReviewInput = {
  actor: Principal;
  /** ISO timestamp for updated_at/history. */
  at: string;
  note?: string;
  /**
   * M-6: REQUIRED (by contract, enforced at the gate) whenever an
   * agent-executed publish of an approval-gated type is intended — the
   * reviewer approves this exact action and the decision pins it.
   */
  requested_publish_action?: PublishAction;
};

export const submitReview = (record: ObjectRecord, input: SubmitReviewInput): ReviewOpResult => {
  const { action, error } = validatePublishAction(input.requested_publish_action);
  if (error) return error;

  const review: ReviewState = {
    state: 'open',
    decisions: record.review?.decisions ?? [],
  };
  const next: ObjectRecord = {
    ...record,
    review,
    updated_at: input.at,
    history: [
      ...record.history,
      {
        at: input.at,
        action: 'submit_review',
        actor: input.actor,
        details: {
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(action !== undefined ? { requested_publish_action: action } : {}),
        },
      },
    ],
    version: record.version + 1,
    // Review bookkeeping never moves content_revision (D§3.1).
    content_revision: record.content_revision,
  };
  return { ok: true, status: 200, record: next, body: { review_state: 'open' } };
};

// ─── decide (approve / request_changes) ──────────────────────────────────────
//
// Fully agentic (2026-07): a detached "approval agent" may decide reviews over
// the shared MCP publish key, so an object can go edit → approve → publish with
// NO human. Humans still decide via a configured role (roles.ts); an agent
// principal is allowed without one. This does not weaken the downstream
// invariant — an agent-executed publish on a gated type still requires the
// approval to pin the exact action (M-6, publish-gate.ts) — so an agentic
// approval is still explicit and pinned, just no longer human-gated.
//
// TODO(editor-agents): agent approval currently rides the SAME publish-key MCP
// surface every editor/publishing agent already uses, so any key holder can
// self-approve. Move it to a SEPARATE gate/credential dedicated to approval
// agents (its own auth, distinct from the publishing agents) and re-tighten the
// standing check below once that gate exists (OQ-3 per-agent credentials, OQ-5).

export type DecideReviewInput = {
  actor: Principal;
  /** Resolved via roles.ts by the caller. Humans need ≥1 role; agents are allowed without one. */
  actorRoles: readonly Role[];
  at: string;
  decision: 'approve' | 'request_changes';
  note?: string;
  /** M-6 pin; meaningful on approvals. Ignored-by-gate on request_changes. */
  publish_action?: PublishAction;
  /**
   * Extended live-publish pin (Goal 4); meaningful on approvals. Binds agent
   * execution to the exact request/content-item id, artifact set, and
   * release/build behavior the reviewer saw. Ignored on request_changes.
   */
  approval_pin?: ApprovalPin;
};

export const decideReview = (record: ObjectRecord, input: DecideReviewInput): ReviewOpResult => {
  // A human decides through a configured role; the approval agent decides
  // without one. (See the TODO above — the agent allowance is deliberately on
  // the shared surface for now.)
  if (input.actor.kind === 'human' && !canDecideReview(input.actorRoles)) {
    return err(403, 'review_role_required', { error: 'Deciding a review requires a configured role.' });
  }
  const { action, error } = validatePublishAction(input.publish_action);
  if (error) return error;
  const { pin, error: pinError } = validateApprovalPin(input.approval_pin);
  if (pinError) return pinError;

  const review: ReviewState = {
    state: input.decision === 'approve' ? 'approved' : 'changes_requested',
    decisions: [
      ...(record.review?.decisions ?? []),
      {
        at: input.at,
        by: input.actor,
        decision: input.decision,
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(action !== undefined ? { publish_action: action } : {}),
        ...(pin !== undefined ? { approval_pin: pin } : {}),
        // The pin: approval is valid only while the body stays at this
        // revision. Deliberately NOT `version` (D§3.9 — lock ops and the
        // publish stamp bump version and must not invalidate approvals).
        content_revision: record.content_revision,
      },
    ],
  };
  const next: ObjectRecord = {
    ...record,
    review,
    updated_at: input.at,
    history: [
      ...record.history,
      {
        at: input.at,
        action: 'review_decide',
        actor: input.actor,
        details: {
          decision: input.decision,
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(action !== undefined ? { publish_action: action } : {}),
          ...(pin !== undefined ? { approval_pin: pin } : {}),
          content_revision: record.content_revision,
        },
      },
    ],
    version: record.version + 1,
    content_revision: record.content_revision,
  };
  return { ok: true, status: 200, record: next, body: { review_state: review.state } };
};

// ─── effective approval (what the publish gate reads) ────────────────────────
//
// Lives in the dependency-free `review-approval.ts` and is re-exported here so
// every existing importer keeps its import. See that file for why it moved.
export { effectiveApproval, type EffectiveApproval } from './review-approval.js';

// ─── discard (C§2.4 compensating inverse write) ──────────────────────────────

export type DiscardInput = {
  /** The rejected ops, exactly as their history entries store them. */
  entries: Array<{ op: unknown; capture: unknown }>;
  /** The reviewer — the inverse writes are authored and attributed to them. */
  actor: Principal;
  at: string;
};

// A privileged op (set_site_brand_tokens) is applyable during discard only as
// the inverse of a REAL, already-authorized history entry — never a
// caller-fabricated {op, capture}. object_discard forwards caller-supplied
// entries, so without this a site checkout alone could forge a
// set_site_brand_tokens entry with an arbitrary `capture.before` and set any
// palette, bypassing site_apply_theme's total-theme path (Codex P1).
const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPrivilegedEntryOp = (op: unknown): boolean =>
  isRecordObject(op) && PRIVILEGED_PATCH_OPS.includes((op as { op?: string }).op as never);

// A pre-rollout palette edit is a set_site_fields whose fields carry brandTokens
// — no longer grammar-valid, so a plain reparse+inverse would 400. Its inverse
// still writes the palette, so it is palette-affecting and must be
// history-verified like the privileged op.
const isLegacyPaletteEntryOp = (op: unknown): boolean =>
  isRecordObject(op) &&
  (op as { op?: string }).op === 'set_site_fields' &&
  isRecordObject((op as { fields?: unknown }).fields) &&
  'brandTokens' in (op as { fields: Record<string, unknown> }).fields;

const affectsPalette = (op: unknown): boolean => isPrivilegedEntryOp(op) || isLegacyPaletteEntryOp(op);

// Legacy compat: rewrite the inverse of a legacy set_site_fields{brandTokens,…}
// so brandTokens rides the privileged palette op and any other fields ride
// set_site_fields — restoring the captured `before`. History-verified above.
const legacyPaletteInverses = (capture: unknown): PatchOp[] => {
  const cap = capture as { kind?: string; before?: unknown };
  if (cap.kind !== 'fields' || !isRecordObject(cap.before) || !isRecordObject(cap.before.brandTokens)) {
    throw new Error(
      'legacy palette discard supports only a brandTokens-object capture — revert the palette by applying a theme (site_apply_theme).'
    );
  }
  const { brandTokens, ...rest } = cap.before;
  const ops: PatchOp[] = [patchOpSchema.parse({ op: 'set_site_brand_tokens', fields: { brandTokens } })];
  if (Object.keys(rest).length > 0) ops.push(patchOpSchema.parse({ op: 'set_site_fields', fields: rest }));
  return ops;
};

const entryMatchesHistory = (record: ObjectRecord, entry: { op: unknown; capture: unknown }): boolean =>
  record.history.some(
    (h) =>
      h.details !== undefined &&
      deepEqualJson((h.details as { op?: unknown }).op, entry.op) &&
      deepEqualJson((h.details as { capture?: unknown }).capture, entry.capture)
  );

export const discardProposal = (record: ObjectRecord, input: DiscardInput): ReviewOpResult => {
  if (input.entries.length === 0) return err(400, 'nothing_to_discard', { error: 'No ops to discard.' });

  // Any palette-affecting entry — the privileged op OR a legacy set_site_fields
  // carrying brandTokens — must be provably from this record's history before
  // its inverse writes the palette; else the writer is forgeable.
  for (const entry of input.entries) {
    if (affectsPalette(entry.op) && !entryMatchesHistory(record, entry)) {
      return err(403, 'discard_privileged_unverified', {
        error:
          'A discarded palette op must match a real history entry — a fabricated capture cannot set the palette. Revert the palette by applying a theme (site_apply_theme).',
      });
    }
    // Blind-revert protection for the LEGACY palette path (C§2.4): the
    // synthesized inverse (below) carries no per-op guard, so verify here that
    // the palette hasn't moved since the captured op — else the revert would
    // blindly overwrite an intervening edit. The privileged op keeps its own
    // guard through derivePatchInverse, so this only covers the legacy rewrite.
    if (isLegacyPaletteEntryOp(entry.op)) {
      const capturedAfter = (entry.capture as { after?: unknown } | undefined)?.after;
      const expectedPalette = isRecordObject(capturedAfter) ? capturedAfter.brandTokens : undefined;
      const currentPalette = isRecordObject(record.body)
        ? (record.body as Record<string, unknown>).brandTokens
        : undefined;
      if (!deepEqualJson(currentPalette, expectedPalette)) {
        return err(409, 'discard_conflict', {
          error:
            'The palette moved since this legacy edit (intervening theme/site change); blind revert refused (C§2.4) — revert by applying a theme (site_apply_theme).',
        });
      }
    }
  }

  let inverses: PatchOp[];
  try {
    // Newest-first: unwinding a batch must revert in reverse application order.
    inverses = [...input.entries].reverse().flatMap(({ op, capture }) => {
      // Legacy palette entry: reparse+inverse would fail the new grammar ban, so
      // rewrite its inverse onto the privileged palette op (history-verified above).
      if (isLegacyPaletteEntryOp(op)) return legacyPaletteInverses(capture);
      const parsedOp = patchOpSchema.parse(op);
      return [derivePatchInverse(parsedOp, capture as PatchOpCapture)];
    });
  } catch (error) {
    return err(400, 'discard_invalid_entry', {
      error: 'A discard entry is not a valid {op, capture} history payload.',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    // Discard re-applies inverses of ALREADY-authorized ops, so it may include
    // the privileged palette writer (the inverse of a site_apply_theme) — pass
    // it as privileged, exactly as the applying verb did.
    const applied = applyPatchOps(record, inverses, {
      actor: input.actor,
      at: input.at,
      privilegedOps: PRIVILEGED_PATCH_OPS,
    });
    return {
      ok: true,
      status: 200,
      record: applied.record,
      body: {
        discarded: input.entries.length,
        inverses,
        // Stated C§2.4 consequence, surfaced for callers: the discard is a
        // body write and invalidates approvals granted over the old draft.
        content_revision: applied.record.content_revision,
      },
    };
  } catch (error) {
    if (error instanceof PatchApplyError && error.code === 'blind_revert_refused') {
      return err(409, 'discard_conflict', {
        error:
          'The draft no longer matches the state the rejected op expects (intervening accepted ops); blind revert refused — resolve manually (C§2.4).',
        detail: error.message,
        details: error.details,
      });
    }
    if (error instanceof PatchApplyError) {
      return err(400, 'discard_failed', { error: error.message, code_detail: error.code, details: error.details });
    }
    throw error;
  }
};
