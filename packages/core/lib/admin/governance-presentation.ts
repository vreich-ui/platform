import type { ChatToolCatalogEntry, ToolAutonomy } from './governance-client.js';

/** Plain-language copy for the persisted chat-tool autonomy values. */
export const AUTONOMY_LABELS: Record<ToolAutonomy, string> = {
  auto: 'Run automatically',
  ask: 'Ask me first',
  off: 'Not allowed',
};

export const autonomyEffect = (mode: ToolAutonomy): string => {
  switch (mode) {
    case 'auto':
      return 'The agent can use this without pausing for approval.';
    case 'ask':
      return 'The agent pauses for your approval before using this.';
    case 'off':
      return 'The agent cannot use this in a conversation.';
  }
};

export const governanceProvenanceLabel = (provenance: string): string =>
  provenance === 'override' ? 'Changed here' : 'Site default';

// ─── brand imagery override guardrail (U2, BRIEF §3.7/R5) ───────────────────
//
// Governs the `style` override channel on `create_agent_artifact_job`
// (packages/core/server/lib/brand-imagery-resolve.ts's
// getBrandImageryOverridePolicy, and P4's resolveEffectiveBrandImagery). This
// module only presents the value the server already resolved
// (GovernanceState.active.brandImageryOverrides / .provenance) — same split
// as every other card on this page: the store/resolver owns truth, this owns
// labels/rows, GovernancePage.tsx stays a thin renderer.

export type BrandImageryOverridePolicy = 'allow' | 'lock';

export const BRAND_IMAGERY_OVERRIDE_LABELS: Record<BrandImageryOverridePolicy, string> = {
  allow: 'Agents may override per run',
  lock: "Locked to the site's own imagery",
};

export const brandImageryOverrideEffect = (policy: BrandImageryOverridePolicy): string =>
  policy === 'allow'
    ? 'An agent can point a run or slot at a different visual standard, or supply a one-off style override.'
    : "The style override channel is ignored on every run; only the site's own brand imagery is used.";

export interface BrandImageryGuardrailRow {
  label: string;
  value: string;
}

export interface BrandImageryGuardrailView {
  effective: BrandImageryOverridePolicy;
  provenance: 'override' | 'committed';
  provenanceLabel: string;
  label: string;
  effect: string;
  /** Small "where did this come from" table for the card's Technical details. */
  rows: BrandImageryGuardrailRow[];
}

/** The revert target this card's one-click revert writes (admin-governance's
 *  `revert` verb) — a named constant so the card and its test agree on the
 *  string without either hardcoding it twice. */
export const BRAND_IMAGERY_OVERRIDE_REVERT_TARGET = 'brandImageryOverrides' as const;

// ─── W21: the capture-plane guardrail ───────────────────────────────────────
//
// Same split as the card above: the store/resolver owns truth, this owns
// labels and rows. The one thing the copy has to get right is that "Open" does
// NOT mean "crawl anything" — the project registry is still a closed allowlist
// of origins — so every string here says whose decision is being deferred to.

export type SiteCaptureMode = 'open' | 'self_only' | 'locked';

export const SITE_CAPTURE_REVERT_TARGET = 'siteCapture' as const;

export const SITE_CAPTURE_DEFAULT: SiteCaptureMode = 'open';

export const SITE_CAPTURE_LABELS: Record<SiteCaptureMode, string> = {
  open: 'Anything the project registry allows',
  self_only: "This site's own pages only",
  locked: 'Off — no site capture',
};

export const siteCaptureEffect = (mode: SiteCaptureMode): string => {
  if (mode === 'open') {
    return 'Agents may crawl any origin listed on this project’s capture policy in the registry — which is a closed allowlist, not the open web.';
  }
  if (mode === 'self_only') {
    return 'Agents may read back this site’s own published pages and nothing else, whatever the registry lists.';
  }
  return 'Every capture job is refused here, without changing the registry or waiting on a deploy.';
};

export interface SiteCaptureGuardrailView {
  effective: SiteCaptureMode;
  provenance: 'override' | 'committed';
  provenanceLabel: string;
  label: string;
  effect: string;
  rows: BrandImageryGuardrailRow[];
}

/** Pure view-model for the capture guardrail card. */
export const describeSiteCaptureGuardrail = (
  effective: SiteCaptureMode,
  provenance: string
): SiteCaptureGuardrailView => {
  const normalizedProvenance: 'override' | 'committed' = provenance === 'override' ? 'override' : 'committed';
  return {
    effective,
    provenance: normalizedProvenance,
    provenanceLabel: governanceProvenanceLabel(normalizedProvenance),
    label: SITE_CAPTURE_LABELS[effective],
    effect: siteCaptureEffect(effective),
    rows: [
      { label: 'Effective setting', value: SITE_CAPTURE_LABELS[effective] },
      { label: 'Source', value: governanceProvenanceLabel(normalizedProvenance) },
      { label: 'Site default', value: SITE_CAPTURE_LABELS[SITE_CAPTURE_DEFAULT] },
      { label: 'Crawl bounds', value: 'The CMS-Agent project registry’s capturePolicy — this setting can only narrow it.' },
    ],
  };
};

/**
 * Pure view-model for the guardrail card: the effective value (already
 * resolved server-side — override when set, else the 'allow' default) plus
 * its provenance, turned into display rows. Handles the three states a
 * runtime override can be in: default (no doc entry → committed/'allow'),
 * site-override (an explicit 'allow' or 'lock' written here), and reverted
 * (the override cleared → back to committed/'allow').
 */
export const describeBrandImageryGuardrail = (
  effective: BrandImageryOverridePolicy,
  provenance: string
): BrandImageryGuardrailView => {
  const normalizedProvenance: 'override' | 'committed' = provenance === 'override' ? 'override' : 'committed';
  return {
    effective,
    provenance: normalizedProvenance,
    provenanceLabel: governanceProvenanceLabel(normalizedProvenance),
    label: BRAND_IMAGERY_OVERRIDE_LABELS[effective],
    effect: brandImageryOverrideEffect(effective),
    rows: [
      { label: 'Effective setting', value: BRAND_IMAGERY_OVERRIDE_LABELS[effective] },
      { label: 'Source', value: governanceProvenanceLabel(normalizedProvenance) },
      { label: 'Site default', value: BRAND_IMAGERY_OVERRIDE_LABELS.allow },
    ],
  };
};

// ─── stored-override ⇄ catalog key reconciliation (save-round-trip fix) ─────
//
// admin-governance canonicalizes every chat_tools key it writes
// (CHAT_TOOL_ALIASES: `patch` → `object_patch`), but the catalog it serves is
// keyed by CHAT_TOOLS' legacy names. Seeding the table straight from
// `doc.chat_tools` therefore read the wrong key space for the 19 aliased
// tools: the save succeeded, the run loop honoured it, and the row still
// showed "Use standard setting" — indistinguishable from a save that failed.
//
// These two helpers are the whole fix, and they are pure so the test can pin
// the round-trip: read through the canonical name, write back in the
// catalog's key space (the server canonicalizes it again on the way in).

/** Look up one catalog row's persisted override, whichever key it is under. */
export const storedAutonomyFor = (
  stored: Record<string, ToolAutonomy>,
  tool: Pick<ChatToolCatalogEntry, 'name' | 'canonical_name'>
): ToolAutonomy | undefined => stored[tool.name] ?? (tool.canonical_name ? stored[tool.canonical_name] : undefined);

/**
 * Re-key the persisted override map into the catalog's key space, so every
 * row shows what is actually stored for it. Keys with no catalog row are
 * dropped deliberately: the table cannot render them, and carrying them into
 * the draft would silently re-save settings for tools this build no longer
 * wires.
 */
export const currentAutonomyForCatalog = (
  stored: Record<string, ToolAutonomy> | undefined,
  catalog: readonly ChatToolCatalogEntry[]
): Record<string, ToolAutonomy> => {
  if (!stored) return {};
  const out: Record<string, ToolAutonomy> = {};
  for (const tool of catalog) {
    const value = storedAutonomyFor(stored, tool);
    if (value !== undefined) out[tool.name] = value;
  }
  return out;
};

export const toolGroupLabel = (toolClass: ChatToolCatalogEntry['tool_class']): string => {
  switch (toolClass) {
    case 'read':
      return 'Looking things up';
    case 'draft':
      return 'Drafting and editing';
    case 'creation':
      return 'Creating new things';
    case 'publication':
      return 'Publishing';
    case 'privileged':
      return 'Site-wide changes';
    case 'membership':
      return 'Members and roles';
  }
};
