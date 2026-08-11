/**
 * T9.13 — ToolContext wiring shared by the interactive endpoint (approve
 * executes immediately) and the background runner. Every verb call gets the
 * SAME live validation context as the admin-object browser path — the chat
 * runtime enforces identical structural rules, artifact-existence trust, and
 * governance policies. Nothing here touches the publish key (A§1.2 posture:
 * the chat surface is an identity-authenticated HUMAN path).
 */
import type { ArtifactIndexStore } from '../artifact-index.js';
import { listArtifactReferencesForRequest } from '../artifact-index.js';
import { resolveActivePolicies, type GovernanceBlobStore } from '../governance-store.js';
import {
  handleObjectVerb,
  objectVerbRequestSchema,
  verbNeedsValidationContext,
  type ObjectVerbStore,
} from '../object-verbs.js';
import { buildStoreValidationContext } from '../object-validation-context.js';
import { summarizeValidation, validateObject } from '../object-validate.js';
import type { Role } from '../roles.js';
import { buildObjectContract } from '../../../lib/registry/object-contract.js';
import { mintId, MintIdError } from '../../../lib/object-ids-mint.js';
import { validateObjectIdForType } from '../../../lib/object-ids.js';
import type { ObjectType, Principal } from '../../../schema/object-record-v1.js';
import type { ToolContext } from './tools.js';

export interface ToolContextDeps {
  objectStore: ObjectVerbStore;
  governanceStore?: GovernanceBlobStore;
  artifactIndexStore?: ArtifactIndexStore;
  principal: Principal;
  roles: readonly Role[];
  nowMs?: () => number;
  /**
   * The site's committed-export root (SiteBinding.dataRoot, W11 T11.6) —
   * forwarded to a `publish_by_time` verb's materialize step. Optional here
   * only so callers that never reach publish (e.g. `cancel`) need not thread
   * it; a chat session that DOES publish without it fails loudly at
   * `publishObject`, same as every other exportRoot-required call site.
   */
  exportRoot?: string;
  /**
   * PF4: the CMS-Agent bridge for the workspace orchestration tools —
   * provided by callers that hold the module-level client; when absent (or
   * unconfigured) those tools answer with a clear error.
   */
  cmsAgent?: {
    callTool<T = unknown>(
      name: string,
      args: Record<string, unknown>
    ): Promise<{ ok: true; data: T } | { ok: false; code: string; message: string }>;
    projectId: string;
  };
}

export const buildToolContext = (deps: ToolContextDeps): ToolContext => {
  const opsCache = new Map<ObjectType, Set<string>>();

  const policies = async () => resolveActivePolicies(deps.governanceStore);

  const validationContextFor = async (request: Record<string, unknown>) => {
    const target = request.target as { kind?: string; page_id?: string } | undefined;
    const targetPageId = target?.kind === 'page' ? target.page_id : undefined;
    const selfObjectId = (request.object_id as string | undefined) ?? targetPageId;
    const selfObjectType =
      (request.object_type as ObjectType | undefined) ?? (targetPageId ? ('page' as ObjectType) : undefined);
    return buildStoreValidationContext(deps.objectStore, {
      selfObjectId,
      selfObjectType,
      ...(deps.artifactIndexStore ? { artifactIndexStore: deps.artifactIndexStore } : {}),
      artifactRefSources: [request],
    });
  };

  return {
    roles: deps.roles,
    ...(deps.cmsAgent ? { cmsAgent: deps.cmsAgent } : {}),

    verb: async (request) => {
      const parsed = objectVerbRequestSchema.safeParse(request);
      if (!parsed.success) {
        return { status: 400, body: { error: 'Invalid verb request.', issues: parsed.error.issues } };
      }
      const { approval, creation } = await policies();
      // Perf: this ToolContext dispatches EVERY verb the chat/agent tool
      // surface can call, including the pure reads (get/list/inventory) and
      // lock verbs — building a validation context (a full store sweep) for
      // those is pure overhead. See verbNeedsValidationContext for exactly
      // which actions read it.
      const validationContext = verbNeedsValidationContext(parsed.data.action)
        ? await validationContextFor(request)
        : undefined;
      return handleObjectVerb(deps.objectStore, parsed.data, deps.principal, {
        ...(deps.nowMs ? { nowMs: deps.nowMs() } : {}),
        validationContext,
        roles: deps.roles,
        approvalPolicy: approval,
        creationPolicy: creation,
        ...(deps.exportRoot ? { publishDeps: { exportRoot: deps.exportRoot } } : {}),
      });
    },

    contract: (objectType) => buildObjectContract(objectType) as unknown as Record<string, unknown>,

    validateNewObject: async (objectType, body, requestedId) => {
      let objectId = requestedId;
      if (objectId) {
        const check = validateObjectIdForType(objectType, objectId);
        if (!check.ok) return { error: 'Invalid requested_id', detail: check.error };
      } else {
        try {
          const timestamp = new Date(deps.nowMs ? deps.nowMs() : Date.now()).toISOString();
          objectId =
            objectType === 'content_item'
              ? mintId(
                  { kind: 'content_item', yyyymmdd: timestamp.slice(0, 10).replaceAll('-', '') },
                  JSON.stringify(body)
                )
              : mintId({ kind: 'object', objectType }, JSON.stringify(body));
        } catch (error) {
          if (error instanceof MintIdError) return { error: 'Could not mint a preview id', detail: error.message };
          throw error;
        }
      }
      const validationContext = await validationContextFor({ object_type: objectType, object_id: objectId, body });
      const groups = validateObject({ objectType, objectId, body }, validationContext);
      const summary = summarizeValidation(groups);
      return { dry_run: true, object_id_preview: objectId, validation: groups, summary };
    },

    listArtifacts: async (requestId) => {
      if (!deps.artifactIndexStore) return { error: 'Artifact index unavailable.' };
      try {
        const references = await listArtifactReferencesForRequest(deps.artifactIndexStore, requestId);
        return { request_id: requestId, artifacts: references };
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'artifact listing failed' };
      }
    },

    agentAuthoredOps: (objectType) => {
      const cached = opsCache.get(objectType);
      if (cached) return cached;
      const ops = new Set(
        buildObjectContract(objectType)
          .patch_ops.filter((op) => op.agent_authored)
          .map((op) => op.op as string)
      );
      opsCache.set(objectType, ops);
      return ops;
    },
  };
};
