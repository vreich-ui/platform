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

// A4 (CMS-Agent #321): the OTHER thing that can implement an operation. An
// operation is bound to EITHER a workflow (operationBindingSchema above) OR a
// registered EXECUTOR — never both (CMS-Agent's operationExecutorBindings.ts
// asserts this mutual exclusivity at import). executorId is the only field
// this schema requires for the same reason workflowId is required above: a
// malformed row is CMS-Agent's own bug, not the model's input, so failing
// the whole parse on a missing executorId IS the fail-safe, not a thing to
// tolerate. inputSchema is a nested JSON-Schema object describing what the
// executor itself requires (see checkExecutorInputContract on the CMS-Agent
// side) — carried through as z.unknown() the same way operationDescriptorSchema's
// own inputSchema is, since this side never evaluates it (only CMS-Agent's
// preflight does, before ever reporting executorBinding as non-null).
export const operationExecutorBindingSchema = z.object({
  executorId: z.string().min(1),
  operationId: z.string().optional(),
  inputSchema: z.unknown().optional(),
});
export type OperationExecutorBinding = z.infer<typeof operationExecutorBindingSchema>;

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
  // A4 (CMS-Agent #321): the executor-side sibling of `binding` — set when
  // this operation is implemented by a registered EXECUTOR instead of a
  // workflow (site_inventory is the one example today). Same tolerance as
  // `binding`: .nullable() because CMS-Agent sends `executorBinding: null`
  // for an operation that has neither kind of implementation, and
  // .optional() so a CMS-Agent predating A4 (which never sends this field at
  // all) still parses — resolveCatalogOperation (tools.ts) checks
  // `pf.executorBinding` the same defensive way it already checks
  // `pf.binding`, never assuming absence means "no executor".
  executorBinding: operationExecutorBindingSchema.nullable().optional(),
});
export type OperationPreflightResult = z.infer<typeof operationPreflightResultSchema>;

export const parseOperationPreflight = (data: unknown): OperationPreflightResult | undefined => {
  const parsed = operationPreflightResultSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
};

// A4 — CMS-Agent's operation.execute envelope (operationTools.ts). Read-only
// gated on CMS-Agent's side (it refuses any operation whose declared effects
// are not all riskLevel "read" before ever reaching an executor); Platform
// never re-derives that gate, it only relays what CMS-Agent decided.
//
// `refusal` carries CMS-Agent's REAL code/message/evidence — not_read_only,
// unknown_operation, input_invalid, no_executor_binding, executor_failed
// (see operationTools.ts's operation.execute for the full refusal chain, in
// order) — so a caller can surface the actual reason and remedy to the
// editor instead of a single flattened "it failed". `executed`/`refusal` are
// NOT modeled as evidence-typed opposites of each other in this schema (both
// could in principle be sent inconsistently by a future CMS-Agent) —
// resolveCatalogOperation's caller treats `executed !== true` OR a
// non-null `refusal` as a refusal, whichever fires, so a malformed
// `{executed: true, refusal: {...}}` still fails safe as a refusal rather
// than being read as success.
export const operationExecuteRefusalSchema = z.object({
  code: z.string(),
  message: z.string(),
  evidence: z.unknown().optional(),
});
export type OperationExecuteRefusal = z.infer<typeof operationExecuteRefusalSchema>;

export const operationExecuteResultSchema = z.object({
  operationId: z.string(),
  tenantId: z.string().optional(),
  executed: z.boolean(),
  refusal: operationExecuteRefusalSchema.nullable().optional(),
  result: z.unknown().optional(),
  completion: z.array(operationCompletionSchema).optional(),
});
export type OperationExecuteResult = z.infer<typeof operationExecuteResultSchema>;

export const parseOperationExecuteResult = (data: unknown): OperationExecuteResult | undefined => {
  const parsed = operationExecuteResultSchema.safeParse(data);
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
