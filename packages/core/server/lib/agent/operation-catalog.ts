/**
 * A3 — CMS-Agent's read-only operation catalog (operation_list/
 * operation_get/operation_preflight, CMS-Agent A2, LIVE) as consumed from
 * Platform's chat tool layer. PURE and defensive: never calls CMS-Agent
 * itself (tools.ts does) and never trusts the wire blindly.
 *
 * Verified live 2026-09-13 against the six registered operations:
 * asset_lookup_adopt, document_render, image_template_revision,
 * pdf_template_family, site_inventory, visual_identity_review_change.
 *
 * Guardrail: an operation id, tool name, approved flag, principal, or
 * widened scope proposed by the MODEL is never taken at face value —
 * resolveCatalogOperation (tools.ts) always re-asks operation_get/
 * operation_preflight; the model's string is a lookup key only.
 */
import { z } from 'zod';
import type { RequestKind } from '../requests/store.js';

// ─── wire shapes (tolerant; every field optional except what we key on) ─────

export const operationEffectSchema = z.object({
  kind: z.string(),
  targetType: z.string().optional(),
  riskLevel: z.enum(['read', 'write', 'publish']).or(z.string()),
  description: z.string().optional(),
});
export type OperationEffect = z.infer<typeof operationEffectSchema>;

export const operationCompletionSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  evidenceKind: z.string().optional(),
});
export type OperationCompletion = z.infer<typeof operationCompletionSchema>;

export const operationDescriptorSchema = z.object({
  operationId: z.string().min(1),
  version: z.number().int().positive(),
  title: z.string().optional(),
  summary: z.string().optional(),
  surface: z.string().nullable().optional(),
  inputSchema: z.unknown().optional(),
  defaults: z.record(z.string(), z.unknown()).optional(),
  requiredCapabilities: z.array(z.string()).optional(),
  effects: z.array(operationEffectSchema).optional(),
  completion: z.array(operationCompletionSchema).optional(),
  intentKeywords: z.array(z.string()).optional(),
});
export type OperationDescriptor = z.infer<typeof operationDescriptorSchema>;

/** operation_list's envelope: { operations: OperationDescriptor[] }. */
export const parseOperationList = (data: unknown): OperationDescriptor[] => {
  if (!data || typeof data !== 'object') return [];
  const operations = (data as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return [];
  const out: OperationDescriptor[] = [];
  for (const raw of operations) {
    const parsed = operationDescriptorSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
};

/** `operation_get`'s envelope — an unknown operation names the registered alternatives. */
export type OperationGetResult =
  | { known: true; descriptor: OperationDescriptor }
  | { known: false; registeredOperationIds: string[] };

export const parseOperationGet = (data: unknown): OperationGetResult | undefined => {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  if (record.known === true) {
    const parsed = operationDescriptorSchema.safeParse(record.descriptor);
    return parsed.success ? { known: true, descriptor: parsed.data } : undefined;
  }
  if (record.known === false) {
    const ids = Array.isArray(record.registeredOperationIds)
      ? record.registeredOperationIds.filter((id): id is string => typeof id === 'string')
      : [];
    return { known: false, registeredOperationIds: ids };
  }
  return undefined;
};

export const operationBlockerSchema = z.object({
  code: z.string(),
  message: z.string(),
  remedy: z.string().optional(),
  blocking: z.boolean().optional(),
  evidence: z.unknown().optional(),
});
export type OperationBlocker = z.infer<typeof operationBlockerSchema>;

export const operationCapabilityGapSchema = z.object({
  capability: z.string(),
  requiredBy: z.string().optional(),
  reason: z.string().optional(),
  remedy: z.string().optional(),
  evidence: z.unknown().optional(),
});
export type OperationCapabilityGap = z.infer<typeof operationCapabilityGapSchema>;

// #313: what implements an executable operation. workflowId is the ONLY
// field resolveCatalogOperation (tools.ts) may dispatch — an operation id is
// not a workflow id (visual_identity_review_change's bound workflow is
// `visual_identity`), so there is no safe fallback from the descriptor.
// inputMapping renames the operation's input fields to the target workflow's
// entry-node names (e.g. tenantId -> projectId); no entry = unchanged. Both
// optional so `{ workflowId }` alone still parses. Stricter than the
// surrounding `z.unknown()` fields on purpose: this is CMS-Agent's own
// code-defined table, not the model, so a malformed one (missing
// workflowId) failing the whole parse IS the fail-safe.
export const operationBindingSchema = z.object({
  workflowId: z.string().min(1),
  operationId: z.string().optional(),
  inputMapping: z.record(z.string(), z.string()).optional(),
});
export type OperationBinding = z.infer<typeof operationBindingSchema>;

export const operationPreflightResultSchema = z.object({
  operationId: z.string(),
  selectedVersion: z.number().int().positive(),
  appliedDefaults: z.record(z.string(), z.unknown()).optional(),
  missingRequired: z.array(z.string()).optional(),
  blockers: z.array(operationBlockerSchema).optional(),
  capabilityGaps: z.array(operationCapabilityGapSchema).optional(),
  effects: z.array(operationEffectSchema).optional(),
  completion: z.array(operationCompletionSchema).optional(),
  // #313: whether CMS-Agent can actually dispatch this operation (e.g. it
  // has a bound implementing workflow) and, when it can, the binding used.
  // Optional and tolerant on purpose — a caller talking to a CMS-Agent that
  // predates #313 never sends either field, and dropping them here would
  // silently reinstate the bug this schema exists to prevent (resolveCatalogOperation
  // in tools.ts is what fails safe on an absent `executable`; this parser
  // must not fail safe FOR it by discarding the field).
  executable: z.boolean().optional(),
  // .nullable() because CMS-Agent's own wire shape sends `binding: null` for
  // an unbound operation (see the executable:false capabilityGaps case
  // above) rather than omitting the key — both must parse to the same
  // "no binding" state resolveCatalogOperation checks with `pf.binding?.`.
  binding: operationBindingSchema.nullable().optional(),
});
export type OperationPreflightResult = z.infer<typeof operationPreflightResultSchema>;

export const parseOperationPreflight = (data: unknown): OperationPreflightResult | undefined => {
  const parsed = operationPreflightResultSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
};

// ─── risk / registration ─────────────────────────────────────────────────────

const RISK_RANK: Record<string, number> = { read: 0, write: 1, publish: 2 };

/** The highest-risk effect in the list, or undefined if empty. */
export const highestEffectRisk = (
  effects: readonly OperationEffect[] | undefined
): 'read' | 'write' | 'publish' | undefined => {
  if (!effects || effects.length === 0) return undefined;
  let best: 'read' | 'write' | 'publish' | undefined;
  let bestRank = -1;
  for (const effect of effects) {
    const rank = RISK_RANK[effect.riskLevel] ?? -1;
    if (rank > bestRank) {
      bestRank = rank;
      best = (
        effect.riskLevel === 'read' || effect.riskLevel === 'write' || effect.riskLevel === 'publish'
          ? effect.riskLevel
          : undefined
      ) as 'read' | 'write' | 'publish' | undefined;
    }
  }
  return best;
};

/** A pure read answers inline and is never registered as a "running operation". */
export const needsDurableRegistration = (effects: readonly OperationEffect[] | undefined): boolean => {
  const risk = highestEffectRisk(effects);
  return risk === 'write' || risk === 'publish';
};

// ─── operationId → RequestKind (THE fix for the article-stamping bug) ───────

// The six operations CMS-Agent A2 registers, mapped to RequestKind. Closed on
// purpose: an unrecognised id falls back to 'other', never 'article'.
const OPERATION_REQUEST_KIND: Record<string, RequestKind> = {
  site_inventory: 'other',
  visual_identity_review_change: 'theme',
  pdf_template_family: 'pdf',
  document_render: 'pdf',
  asset_lookup_adopt: 'media',
  image_template_revision: 'page',
};

export const operationRequestKind = (operationId: string): RequestKind =>
  OPERATION_REQUEST_KIND[operationId] ?? 'other';

// The kind for a run_workspace_workflow registration when no catalog
// operation was resolved. THE fix: the old code stamped every registration
// 'article' unconditionally. undefined/'publishing_conductor' IS an article
// by construction (ART-1); anything else uses the same map, defaulting to
// 'other' — never a silent, wrong 'article'.
export const requestKindForWorkflow = (workflowId: string | undefined): RequestKind => {
  if (!workflowId || workflowId === 'publishing_conductor') return 'article';
  return OPERATION_REQUEST_KIND[workflowId] ?? 'other';
};
