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
  /** PF2 (schema-additive): runtime override for the chat TurnEngine mode —
   *  `governance override ?? CMS_AGENT_CHAT_MODE env ?? 'off'`. Rollback to
   *  the provider path is this one field → 'off', no deploy. */
  cms_agent_chat_mode: z.enum(['off', 'fallback', 'required']).optional(),
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
  /** PF3: the runtime chat-engine mode override, when one is set. */
  cms_agent_chat_mode?: 'off' | 'fallback' | 'required';
  provenance: { approval: PolicyProvenance; creation: PolicyProvenance; learning_mode: PolicyProvenance };
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
    chat_tools: doc?.chat_tools,
    learning_mode: doc?.learning_mode ?? false,
    ...(doc?.cms_agent_chat_mode ? { cms_agent_chat_mode: doc.cms_agent_chat_mode } : {}),
    provenance: {
      approval: doc?.approval ? 'override' : 'committed',
      creation: doc?.creation ? 'override' : 'committed',
      learning_mode: doc?.learning_mode !== undefined ? 'override' : 'committed',
    },
  };
};

export const getGovernanceBlobStore = (event: unknown): Promise<GovernanceBlobStore> =>
  getNetlifyBlobStore({ name: 'governance', consistency: 'strong' }, event) as unknown as Promise<GovernanceBlobStore>;
