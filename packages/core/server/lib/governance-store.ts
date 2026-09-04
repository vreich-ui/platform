/**
 * Governance overrides store (T9.15, OQ-W9-2). A single `governance` blob doc
 * (`overrides.v1`) layers a RUNTIME override over the committed one-file policy
 * levers (src/lib/approval-policy.ts / creation-policy.ts). The committed files
 * remain the labeled defaults AND the disaster fallback: a missing, empty, or
 * corrupt doc — or a doc without a given override — resolves to the committed
 * policy. `resolveActivePolicies` is the single read the verb publish/create
 * paths consume.
 *
 * Security boundary: this decides who approves what. The override values are
 * validated with the EXISTING committed config schemas, so an invalid override
 * can never widen authority — it fails validation and the committed policy
 * stands.
 */
import { z } from 'zod';

import { approvalPolicyConfigSchema, activeApprovalPolicy, type ApprovalPolicy } from '../../lib/approval-policy.js';
import { creationPolicyConfigSchema, activeCreationPolicy, type CreationPolicy } from '../../lib/creation-policy.js';
import { getNetlifyBlobStore } from './blob-store.js';

export const GOVERNANCE_DOC_KEY = 'overrides.v1';

export const chatToolAutonomySchema = z.record(z.string(), z.enum(['auto', 'ask', 'off']));

export const governanceHistoryEntrySchema = z.object({
  at: z.string(),
  actor_email: z.string(),
  action: z.string(),
  detail: z.string().optional(),
});

export const governanceDocSchema = z.object({
  schema_version: z.literal('overrides.v1'),
  approval: approvalPolicyConfigSchema.optional(),
  creation: creationPolicyConfigSchema.optional(),
  /** Per chat-tool autonomy (auto/ask/off). Stored now; consumed by the chat loop in T9.13. */
  chat_tools: chatToolAutonomySchema.optional(),
  /** M2b: expensive candidate generation is explicitly Owner-governed and off by default. */
  learning_mode: z.boolean().optional(),
  /** PF2 legacy field retained only so pre-PF5 governance documents continue
   *  to parse. PF5 ignores it: admin chat is permanently Client Manager-only. */
  cms_agent_chat_mode: z.enum(['off', 'fallback', 'required']).optional(),
  /** Task 3 (schema-additive): which chat-tool registry new runs stamp.
   *  Effective default when unset is 'generated' (resolved by the caller,
   *  same pattern as cms_agent_chat_mode) — the flag exists purely as a
   *  no-deploy rollback lever back to 'legacy'. */
  chat_registry: z.enum(['legacy', 'generated']).optional(),
  /** Task 3 (schema-additive): set once `chat_tools` has been canonicalized
   *  through `migrateAutonomyKeys` (write-back on read, or an admin-governance
   *  `set`) — short-circuits re-migration so a post-migration owner may
   *  legitimately set the canonical `search_artifacts` key without it being
   *  reinterpreted as its legacy meaning. */
  chat_tools_migrated: z.boolean().optional(),
  /** Brand-imagery wave (BRIEF §3.7/R5): per-site guardrail on the `style`
   *  override channel (create_agent_artifact_job). 'allow' (the default when
   *  unset) lets an agent point a job at a visual_standard or a one-off
   *  override; 'lock' makes the site's own brandImagery the only source --
   *  the style channel is ignored (never an error) and reported in the job
   *  response's overriddenFields. Read by brand-imagery-resolve.ts's
   *  getBrandImageryOverridePolicy, the SAME doc the admin GovernancePage's
   *  Visual identity guardrail card edits (owner-write, same as `approval`). */
  brandImageryOverrides: z.enum(['allow', 'lock']).optional(),
  /**
   * W7.5 — the per-surface kill switch.
   *
   * `member_suspend` cuts a PERSON. This cuts a CHAT APP: when a client starts
   * behaving badly — a runaway agent, a cached schema hammering a retired tool,
   * a shape whose vendor changed something overnight — the operator needs to
   * stop that surface without suspending the editors who use it, and without a
   * deploy. Unset means allow, so an untouched tenant behaves exactly as before.
   *
   * Keys are `PluginActorId`s (`plugin:claude`, `plugin:openai-gpt`,
   * `plugin:openai-agent`). A blocked surface still reaches `ping` and
   * `whoami`, deliberately: an installer whose surface was cut must be able to
   * find out that THAT is what happened, rather than reading a wall of tool
   * errors.
   */
  surfaces: z.record(z.string(), z.enum(['allow', 'block'])).optional(),
  updated_by: z.string(),
  updated_at: z.string(),
  history: z.array(governanceHistoryEntrySchema),
});
export type GovernanceDoc = z.infer<typeof governanceDocSchema>;

export interface GovernanceBlobStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<void | { modified: boolean; etag?: string }>;
}

/** Read + validate the governance doc. Missing OR corrupt → null (committed policy stands). */
export const getGovernanceDoc = async (store: GovernanceBlobStore): Promise<GovernanceDoc | null> => {
  const raw = await store.get(GOVERNANCE_DOC_KEY);
  if (!raw) return null;
  try {
    return governanceDocSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
};

export const putGovernanceDoc = async (store: GovernanceBlobStore, doc: GovernanceDoc): Promise<void> => {
  await store.setJSON(GOVERNANCE_DOC_KEY, governanceDocSchema.parse(doc));
};

export type PolicyProvenance = 'override' | 'committed';

export interface ActivePolicies {
  approval: ApprovalPolicy;
  creation: CreationPolicy;
  chat_tools?: GovernanceDoc['chat_tools'];
  learning_mode: boolean;
  /** Task 3: the runtime chat-registry override, when one is set. Callers
   *  apply the effective default (`chat_registry ?? 'generated'`) themselves. */
  chat_registry?: 'legacy' | 'generated';
  /** U2 (BRIEF §3.7/R5): the `style` override channel guardrail, resolved the
   *  same way as every other lever here — doc override when present, else the
   *  hardcoded default 'allow'. getBrandImageryOverridePolicy resolves this
   *  SAME field independently (it is called from the artifact-job path, which
   *  does not otherwise need the rest of ActivePolicies); this copy is what
   *  the admin GovernancePage's guardrail card reads for display. */
  brandImageryOverrides: 'allow' | 'lock';
  /** W7.5: per-surface allow/block. Absent keys are allowed. */
  surfaces?: Record<string, 'allow' | 'block'>;
  provenance: {
    approval: PolicyProvenance;
    creation: PolicyProvenance;
    learning_mode: PolicyProvenance;
    brandImageryOverrides: PolicyProvenance;
  };
}

/**
 * The one resolution the verb paths call: store override if present (already
 * validated on read), else the committed config. Store read failure degrades
 * to committed — a broken governance store can never brick publishing/creation.
 */
export const resolveActivePolicies = async (store: GovernanceBlobStore | undefined): Promise<ActivePolicies> => {
  let doc: GovernanceDoc | null = null;
  if (store) {
    try {
      doc = await getGovernanceDoc(store);
    } catch {
      doc = null;
    }
  }
  return {
    approval: doc?.approval ?? activeApprovalPolicy(),
    creation: doc?.creation ?? activeCreationPolicy(),
    ...(doc?.surfaces ? { surfaces: doc.surfaces } : {}),
    chat_tools: doc?.chat_tools,
    learning_mode: doc?.learning_mode ?? false,
    brandImageryOverrides: doc?.brandImageryOverrides ?? 'allow',
    ...(doc?.chat_registry ? { chat_registry: doc.chat_registry } : {}),
    provenance: {
      approval: doc?.approval ? 'override' : 'committed',
      creation: doc?.creation ? 'override' : 'committed',
      learning_mode: doc?.learning_mode !== undefined ? 'override' : 'committed',
      brandImageryOverrides: doc?.brandImageryOverrides !== undefined ? 'override' : 'committed',
    },
  };
};

export const getGovernanceBlobStore = (event: unknown): Promise<GovernanceBlobStore> =>
  getNetlifyBlobStore({ name: 'governance', consistency: 'strong' }, event) as unknown as Promise<GovernanceBlobStore>;
