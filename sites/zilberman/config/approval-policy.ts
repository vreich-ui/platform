/**
 * This site's approval posture. `master` sets the default for every governed
 * type; `overrides` narrows it per type.
 *
 * Commerce is the standing exception to an autonomous posture: an agent
 * PROPOSING a product change is fine, a price going live unseen is not.
 */
import type { ApprovalPolicyConfig } from '../../../packages/core/lib/approval-policy.js';

export const approvalPolicyConfig = {
  master: 'all-autonomous',
  overrides: { product: 'require-approval' },
} satisfies ApprovalPolicyConfig;
