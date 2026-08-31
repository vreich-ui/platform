/**
 * Tracking governance view-model (W13 T13.12 — the OQ-W13-2 surface).
 *
 * The PURE half of the guardrails page's Tracking card, so "who may publish
 * tracking_config right now?" is computed from POLICY TRUTH and
 * unit-testable: the effective approval mode comes from the ACTIVE policy
 * (runtime override when present, else the committed config — T9.15's
 * resolution), and the creation posture from the live creation policy
 * (humans always; agents per allowlist — the seed-driver-only pin for
 * tracking_config). Nothing here is hardcoded posture: flip the config and
 * the view follows.
 *
 * The card shows `product` beside tracking (the other pinned type) so the
 * surface is honest about every posture pin — but deliberately NOT a
 * general per-type matrix (that is T9.15's approval matrix, one card
 * below).
 */
import { effectiveApprovalMode, type ApprovalConfig, type ApprovalMode } from './governance-client.js';

/** consent.analytics_id_mode (tracking-config-v1 schema). */
export type AnalyticsIdMode = 'granted-only' | 'unrestricted-auto';

/**
 * Read-only display value for the Tracking card's identity-mode line
 * (T21.2 — the OQ-W13-2 card gains it, next to the posture display). Once a
 * tracking_config export exists its schema default fills the field, so the
 * only real "absent" case is no export at all (nothing to show yet) — that
 * gets the SAME "not set" treatment the admin already uses for a missing
 * value elsewhere (MaintenancePage's site-id diagnostic), not an invented
 * new convention.
 */
export const formatAnalyticsIdMode = (mode: AnalyticsIdMode | null | undefined): string => mode ?? 'not set';

export type CreationRuleLike = 'open' | { agents: string[] };
export type CreationPolicyLike = {
  master: CreationRuleLike;
  overrides: Partial<Record<string, CreationRuleLike>>;
};

export type TrackingPostureRow = {
  type: 'tracking_config' | 'product';
  label: string;
  publish: ApprovalMode;
  /** True when an explicit per-type override pins this type (vs the master). */
  pinned: boolean;
};

export type TrackingGovernanceView = {
  rows: TrackingPostureRow[];
  /** 'override' when the runtime layer is active for approval, else 'committed'. */
  approvalProvenance: 'override' | 'committed';
  /** The one-glance answer for the registry singleton. */
  trackingPublish: ApprovalMode;
  creation: {
    humans: 'always';
    /** 'open' | the allowlisted agent names (the seed driver, today). */
    agents: 'open' | string[];
    creationProvenance: 'override' | 'committed';
  };
};

const creationRuleFor = (policy: CreationPolicyLike, type: string): CreationRuleLike =>
  policy.overrides[type] ?? policy.master;

export const describeTrackingGovernance = (
  activeApproval: ApprovalConfig,
  approvalProvenance: string,
  activeCreation: CreationPolicyLike,
  creationProvenance: string
): TrackingGovernanceView => {
  const rows: TrackingPostureRow[] = (
    [
      ['tracking_config', 'Tracking registry'],
      ['product', 'Product'],
    ] as const
  ).map(([type, label]) => ({
    type,
    label,
    publish: effectiveApprovalMode(activeApproval, type),
    pinned: activeApproval.overrides[type] !== undefined,
  }));
  const creationRule = creationRuleFor(activeCreation, 'tracking_config');
  return {
    rows,
    approvalProvenance: approvalProvenance === 'override' ? 'override' : 'committed',
    trackingPublish: rows[0]!.publish,
    creation: {
      humans: 'always',
      agents: creationRule === 'open' ? 'open' : [...creationRule.agents],
      creationProvenance: creationProvenance === 'override' ? 'override' : 'committed',
    },
  };
};

/**
 * The quick-flip write payload (Owner-only server-side; audit-logged by the
 * governance endpoint like every override write): an EXPLICIT per-type pin
 * for tracking_config — never a silent master change. Flipping to the mode
 * the master already implies still pins it (the pin is the point: the
 * posture survives later master flips); the matrix's "Master default"
 * option remains the unpin path.
 */
export const withTrackingPublishMode = (config: ApprovalConfig, mode: ApprovalMode): ApprovalConfig => ({
  master: config.master,
  overrides: { ...config.overrides, tracking_config: mode },
});
