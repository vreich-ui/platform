/**
 * Approval policy (replaces T1.4's hardcoded tiers) — the pure resolution
 * layer for the publish gate's ONE question: does publishing a change to
 * this object type require a current human approval first?
 *
 * The model, exactly (task brief, 2026-07-07):
 *   - One gate only: approval. The old Tier 3 "human must execute the
 *     publish" step no longer exists — when a gated type is approved, the
 *     AGENT executes the publish; approval is the only human touch.
 *   - Master switch: 'all-autonomous' (nothing requires approval) or
 *     'all-require-approval' (everything does).
 *   - Per-type override map: individual object types can be pinned to
 *     'require-approval' or 'autonomous', beating the master switch.
 *   - Resolution order: override if present → master switch → hardcoded
 *     default 'autonomous'. An unconfigured type in an unconfigured system
 *     is fully autonomous.
 *
 * `content_item` (articles) joined the governed set at W7.3 (08-articles-plan
 * — OQ-8 resolved as migration; OQ-W7-4: articles keep Tier 1 direct
 * publish). Under the autonomous master this preserves the article
 * pipeline's trust posture exactly: agents publish articles directly, every
 * publish still writes the full audit trail. Gate articles like any other
 * type by pinning `content_item: 'require-approval'` in the config.
 *
 * This module is client-safe on purpose (no env, no server imports): the
 * admin objects UI reads the same committed config to decide which buttons
 * to render, while enforcement stays server-side in
 * netlify/lib/publish-gate.ts.
 *
 * The committed config lives in ONE place: `src/config/approval-policy.ts`.
 * Wolf flips the whole posture (or gates a single type) by editing that
 * file — no code changes. It is `satisfies`-checked at compile time AND
 * zod-parsed at runtime; a malformed config THROWS rather than silently
 * resolving to the permissive default.
 */
import { z } from 'zod';

import type { ObjectType } from '../schema/object-record-v1.js';

/** Every object type the generic publish gate governs — all nine (W7.3). */
export const governedObjectTypes = [
  'page',
  'section',
  'navigation',
  'taxonomy',
  'site',
  'template',
  'section_template',
  'theme',
  'product',
  'content_item',
  'tracking_config',
  'editorial_voice',
  // Wolf 2026-09-09: editorial_strategy is governed exactly like editorial_voice
  // — publishable (it materializes to an audit-trail export), approvable, and
  // creation-gated. Unlike visual_standard, which is deliberately outside the
  // publish gate, a strategy IS a committed fact about the publication.
  'editorial_strategy',
] as const;
export type GovernedObjectType = (typeof governedObjectTypes)[number];

export const isGovernedObjectType = (objectType: ObjectType): objectType is GovernedObjectType =>
  (governedObjectTypes as readonly string[]).includes(objectType);

export const approvalPolicyConfigSchema = z.strictObject({
  /** The fast lever: flips the default posture for every governed type at once. */
  master: z.enum(['all-autonomous', 'all-require-approval']),
  /**
   * Explicit per-type pins that beat the master switch. Keys are governed
   * object types only — an unknown/typo'd key fails the parse instead of
   * silently doing nothing.
   */
  overrides: z.strictObject({
    page: z.enum(['require-approval', 'autonomous']).optional(),
    section: z.enum(['require-approval', 'autonomous']).optional(),
    navigation: z.enum(['require-approval', 'autonomous']).optional(),
    taxonomy: z.enum(['require-approval', 'autonomous']).optional(),
    site: z.enum(['require-approval', 'autonomous']).optional(),
    template: z.enum(['require-approval', 'autonomous']).optional(),
    section_template: z.enum(['require-approval', 'autonomous']).optional(),
    theme: z.enum(['require-approval', 'autonomous']).optional(),
    product: z.enum(['require-approval', 'autonomous']).optional(),
    content_item: z.enum(['require-approval', 'autonomous']).optional(),
    tracking_config: z.enum(['require-approval', 'autonomous']).optional(),
    editorial_voice: z.enum(['require-approval', 'autonomous']).optional(),
    editorial_strategy: z.enum(['require-approval', 'autonomous']).optional(),
  }),
});

export type ApprovalPolicyConfig = z.infer<typeof approvalPolicyConfigSchema>;
export type ApprovalPolicy = ApprovalPolicyConfig;

/**
 * Validate a config value into a usable policy. Throws (with the zod detail)
 * on anything malformed — a broken policy config must fail loudly, never
 * quietly fall back to the permissive default.
 */
export const resolveApprovalPolicy = (config: unknown): ApprovalPolicy => {
  const parsed = approvalPolicyConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid approval-policy config (src/config/approval-policy.ts): ${parsed.error.message}`);
  }
  return parsed.data;
};

/**
 * The one resolution rule: per-type override if present, else the master
 * switch. (The 'else hardcoded autonomous' leg of the spec is the DEFAULT of
 * the committed config itself — a parsed policy always carries a master.)
 */
export const publishRequiresApproval = (objectType: GovernedObjectType, policy: ApprovalPolicy): boolean => {
  const override = policy.overrides[objectType];
  if (override !== undefined) return override === 'require-approval';
  return policy.master === 'all-require-approval';
};

/**
 * Provider-injection seam (W11 T11.2). `packages/core` is fleet law and must
 * not import a site's committed config (`src/config/approval-policy.ts` stays
 * site-side). The site registers the active-policy provider once at startup
 * via `setActiveApprovalPolicyProvider` (see `src/config/policy-bindings.ts`),
 * which binds `resolveApprovalPolicy(approvalPolicyConfig)`. Behavior is
 * unchanged from the previous committed-config singleton — only the config
 * source is injected instead of imported.
 */
let activeApprovalPolicyProvider: (() => ApprovalPolicy) | undefined;

export const setActiveApprovalPolicyProvider = (provider: () => ApprovalPolicy): void => {
  activeApprovalPolicyProvider = provider;
};

/**
 * The active policy, resolved through the site-registered provider. This is
 * what the server gate and the admin UI use when no policy is injected
 * explicitly (tests inject a policy directly into the pure functions).
 */
export const activeApprovalPolicy = (): ApprovalPolicy => {
  if (!activeApprovalPolicyProvider) {
    throw new Error(
      'Active approval policy provider not configured — import the site policy bindings (src/config/policy-bindings) before calling activeApprovalPolicy().'
    );
  }
  return activeApprovalPolicyProvider();
};
