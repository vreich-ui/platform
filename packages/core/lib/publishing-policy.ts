/**
 * Publishing policy — `autonomyMode` (T15.8, platform#615, "one approval
 * truth on the platform"). Governed by
 * `CMS-Agent/docs/plan/ADR-2026-08-25-publish-autonomy.md` §2 and
 * `CMS-Agent/docs/plan/ADR-2026-08-25-structure-studio.md` §4.2, which assigns
 * this repo the job of reconciling the platform's chat `"ask"` floor
 * (`governance.autonomyFloor`, `mcp-tool-definitions.test.ts:62`) with
 * autonomous operation.
 *
 * ## Why this is a NEW field, not a reuse of `approval-policy.ts`
 *
 * Every fleet site already commits `approval-policy.ts` with
 * `master: 'all-autonomous'` (`sites/*\/config/approval-policy.ts`) — but that
 * field answers a narrower question: does PUBLISHING an already-authored
 * governed object need a current human approval (`publish-gate.ts`)? It was
 * never written to cover membership writes, `wipe_blob_stores`,
 * `product_set_price`, template deletion, or any of the other tools that
 * carry `autonomyFloor: 'ask'` — and `mcp-tool-definitions.test.ts` records,
 * deliberately, that today "the floor is a CHAT-approval rule only [and] does
 * not touch the publish gate." Reusing `master: 'all-autonomous'` to satisfy
 * the chat floor would therefore silently hand every already-configured site
 * unattended control over verbs its Owner never considered when they set that
 * switch — precisely the "quietly makes unconfigured tenants autonomous"
 * defect T15.8 exists to prevent.
 *
 * So the ask floor reads its OWN policy field, `autonomyMode`, named and
 * shaped to match `ProjectPublishingPolicy.autonomyMode` on the CMS-Agent
 * side (ADR publish-autonomy §2.1: `"autonomous" | "operator-gated"`, absent
 * ⇒ `"operator-gated"`) — the same name, the same two-state shape, the same
 * fail-closed default — so the two converge on one concept even though they
 * are, today, two separately-configured fields in two repos (CMS-Agent has
 * not yet built a live cross-service reader for this; T15.5/#185). When that
 * lands, a site can point this field at the SAME committed policy CMS-Agent
 * resolves; until then, this is the platform's own half of the one truth.
 *
 * ## Absence is safe by construction
 *
 * `activeAutonomyMode()` NEVER throws (unlike `activeApprovalPolicy()`,
 * which throws on a missing provider because that field's absence would be a
 * misconfigured site). No fleet site registers a provider for this module
 * today — that is deliberate: `autonomyMode` defaults to `'operator-gated'`
 * for every existing tenant, and adopting it is a decision each site's Owner
 * makes by committing their own `sites/<client>/config/publishing-policy.ts`
 * and registering it in `policy-bindings.ts` (mirroring `approval-policy.ts`'s
 * own pattern), not something this task flips on their behalf.
 *
 * Client-safe: no env, no server imports.
 */
import { z } from 'zod';

export const autonomyModeSchema = z.enum(['autonomous', 'operator-gated']);
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;

export const publishingPolicyConfigSchema = z.strictObject({
  autonomyMode: autonomyModeSchema.optional(),
});
export type PublishingPolicyConfig = z.infer<typeof publishingPolicyConfigSchema>;

/** Validate a config value. Throws on anything malformed — same discipline as
 *  `resolveApprovalPolicy`: a broken config must fail loudly, not silently
 *  fall back. (Absence of a provider entirely is a different case — see
 *  `activeAutonomyMode` below — and is never an error.) */
export const resolvePublishingPolicy = (config: unknown): PublishingPolicyConfig => {
  const parsed = publishingPolicyConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid publishing-policy config (sites/<client>/config/publishing-policy.ts): ${parsed.error.message}`);
  }
  return parsed.data;
};

/** Absent `autonomyMode` ⇒ `'operator-gated'` — mirrors ADR publish-autonomy
 *  §2.1 exactly ("absent ⇒ operator-gated"). */
export const resolveAutonomyMode = (config: PublishingPolicyConfig | undefined): AutonomyMode =>
  config?.autonomyMode ?? 'operator-gated';

/** Provider-injection seam, mirroring `setActiveApprovalPolicyProvider`. A
 *  site opts in by registering its own committed config here at startup. */
let activePublishingPolicyProvider: (() => PublishingPolicyConfig) | undefined;

export const setActivePublishingPolicyProvider = (provider: () => PublishingPolicyConfig): void => {
  activePublishingPolicyProvider = provider;
};

/** Test-only: clear a registered provider so one test file's registration
 *  cannot leak into another's assertions about the unconfigured default. */
export const clearActivePublishingPolicyProviderForTests = (): void => {
  activePublishingPolicyProvider = undefined;
};

/**
 * The active autonomy mode. NEVER throws: no provider registered (every
 * fleet site, today) resolves to the fail-closed default exactly as an
 * explicit `'operator-gated'` would, and a provider that itself throws (a
 * malformed committed config) degrades the same way rather than taking the
 * chat loop down — "absent or unconfigured policy keeps 'ask' meaning ask"
 * is the invariant, not "an unconfigured project 500s."
 */
export const activeAutonomyMode = (): AutonomyMode => {
  if (!activePublishingPolicyProvider) return 'operator-gated';
  try {
    return resolveAutonomyMode(activePublishingPolicyProvider());
  } catch {
    return 'operator-gated';
  }
};
