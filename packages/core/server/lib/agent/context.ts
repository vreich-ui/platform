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
// T9.13/PF5: the generated chat tools' "operational" bridge dispatches to
// these already-exported call* handlers — the SAME functions mcp.ts's own
// callTool switch delegates to (mcp-tool-handlers.ts documents the mcp.ts
// <-> mcp-tool-handlers.ts circular import this file now also reaches into;
// every one of these bindings is only ever READ inside a function body below
// — never at this module's own top level — so there is no new require-time
// cycle risk even though mcp.ts is (indirectly, via mcp-tool-handlers.ts) a
// two-hop neighbor of this module).
import type { LambdaEvent } from '../../functions/mcp.js';
import { callPing } from '../../functions/mcp.js';
import {
  callCommerceOrders,
  callCreateAgentArtifactJob,
  callCreatePdfTemplate,
  callDeletePdfTemplate,
  callDeployStatus,
  callGetAgentArtifactBySlot,
  callGetAgentArtifactJobStatus,
  callGetImageModelPolicy,
  callGetImageSearchBank,
  callGetImageSearchJobStatus,
  callGetImageSearchPolicy,
  callGetPdfTemplate,
  callGetPdfTemplateValidation,
  callImportImageFromUrl,
  callImportImagesFromUrl,
  callListPdfTemplates,
  callObjectAction,
  callOrderReissue,
  callPdfToolHealth,
  callProductSetPrice,
  callPublishPdfTemplate,
  callRegistryGet,
  callReleaseToProduction,
  callSearchImages,
  callSetImageModelPolicy,
  callSetImageSearchPolicy,
  callUpdateImageSearchCandidate,
  callValidatePdfTemplate,
  callVerifyArticleImages,
} from '../mcp-tool-handlers.js';
import {
  getArtifactMetadata,
  listArtifactsByKind,
  listArtifactsByRequest,
  searchArtifacts as searchArtifactsAdmin,
} from '../mcp-artifact-admin.js';
import { withIdempotentToolCall } from '../idempotency-store.js';

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
  /**
   * T9.13/PF5: the LambdaEvent the generated chat tools' `ctx.operational`
   * bridge threads through to the shared MCP call* handlers (deploy_status,
   * the pdf-tool/image families, commerce, marginalia_*, registry_get,
   * ping/health, ...) — see agent/generated-tools.ts. Absent for callers that
   * never reach an operational tool; a chat session that does without one
   * gets ToolContext.operational left unset, so those tools answer with a
   * clear "not configured" error instead of crashing.
   */
  operationalEvent?: LambdaEvent;
}

// T9.13/PF5: name → the already-exported call* handler it delegates to,
// exactly as mcp.ts's own callTool switch dispatches (some of these bodies
// were mechanically extracted OUT of that switch into mcp-tool-handlers.ts
// for this purpose — see that file's new exports and mcp.ts's now-one-line
// cases). idempotency-wrapped tools replicate the SAME withIdempotentToolCall
// wrapping mcp.ts's switch applies. Only tools GENERATED_CHAT_TOOLS actually
// routes through `ctx.operational` appear here.
// Deliberately wide: the handlers below return several structurally-distinct
// (but overlapping) result shapes — toolResult's {content, structuredContent},
// toolError's {isError, content, structuredContent}, and (via callObjectAction)
// occasionally a raw pass-through object with neither — so the adapter below
// (toOperationalToolResult) reads each field defensively rather than assuming
// a single fixed shape.
type RawToolResult = Record<string, unknown>;
type OperationalHandler = (event: LambdaEvent, args: Record<string, unknown>) => Promise<RawToolResult>;

const OPERATIONAL_HANDLERS: Record<string, OperationalHandler> = {
  deploy_status: callDeployStatus,
  verify_article_images: callVerifyArticleImages,
  release_to_production: (event, args) =>
    withIdempotentToolCall(event, 'release_to_production', args.idempotency_key, () =>
      callReleaseToProduction(event, args)
    ),
  create_agent_artifact_job: (event, args) =>
    withIdempotentToolCall(event, 'create_agent_artifact_job', args.idempotency_key, () =>
      callCreateAgentArtifactJob(event, args)
    ),
  get_agent_artifact_job_status: callGetAgentArtifactJobStatus,
  get_agent_artifact_by_slot: callGetAgentArtifactBySlot,
  create_pdf_template: (event, args) =>
    withIdempotentToolCall(event, 'create_pdf_template', args.idempotency_key, () =>
      callCreatePdfTemplate(event, args)
    ),
  list_pdf_templates: callListPdfTemplates,
  get_pdf_template: callGetPdfTemplate,
  validate_pdf_template: callValidatePdfTemplate,
  get_pdf_template_validation: callGetPdfTemplateValidation,
  publish_pdf_template: callPublishPdfTemplate,
  delete_pdf_template: callDeletePdfTemplate,
  health: callPdfToolHealth,
  search_images: callSearchImages,
  get_image_search_job_status: callGetImageSearchJobStatus,
  get_image_search_bank: callGetImageSearchBank,
  update_image_search_candidate: callUpdateImageSearchCandidate,
  import_image_from_url: callImportImageFromUrl,
  import_images_from_url: callImportImagesFromUrl,
  get_image_search_policy: callGetImageSearchPolicy,
  set_image_search_policy: callSetImageSearchPolicy,
  get_image_model_policy: callGetImageModelPolicy,
  set_image_model_policy: callSetImageModelPolicy,
  get_artifact_metadata: (event, args) => getArtifactMetadata(event, args.requestId, args.sha256),
  list_artifacts_by_kind: listArtifactsByKind,
  list_artifacts_by_request: listArtifactsByRequest,
  search_artifacts: searchArtifactsAdmin,
  ping: () => Promise.resolve(callPing()),
  marginalia_create: (event, args) =>
    callObjectAction(event, {
      action: 'marginalia_create',
      object_type: args.object_type,
      object_id: args.object_id,
      section_id: args.section_id,
      node_id: args.node_id,
      field: args.field,
      selected_text: args.selected_text,
      body: args.body,
    }),
  marginalia_reply: (event, args) =>
    callObjectAction(event, {
      action: 'marginalia_reply',
      object_type: args.object_type,
      object_id: args.object_id,
      thread_id: args.thread_id,
      body: args.body,
      parent_comment_id: args.parent_comment_id,
    }),
  marginalia_list: (event, args) =>
    callObjectAction(event, { action: 'marginalia_list', object_type: args.object_type, object_id: args.object_id }),
  marginalia_resolve: (event, args) =>
    callObjectAction(event, {
      action: 'marginalia_resolve',
      object_type: args.object_type,
      object_id: args.object_id,
      thread_id: args.thread_id,
      status: args.status,
    }),
  product_set_price: callProductSetPrice,
  order_reissue: callOrderReissue,
  commerce_orders: callCommerceOrders,
  registry_get: callRegistryGet,
};

/** Adapts the MCP tool-result shape to ChatTool's {content: string, is_error: boolean}. */
const toOperationalToolResult = (raw: RawToolResult): { content: string; is_error: boolean } => {
  const is_error = raw.isError === true;
  if (raw.structuredContent !== undefined) return { content: JSON.stringify(raw.structuredContent), is_error };
  if (raw.content !== undefined) return { content: extractTextContent(raw.content), is_error };
  // No content/structuredContent at all: a raw pass-through body (e.g. the
  // object-store's own record via callObjectAction) — stringify it whole
  // rather than losing it.
  return { content: JSON.stringify(raw), is_error };
};

const extractTextContent = (content: unknown): string => {
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as { text?: unknown } | undefined;
    if (first && typeof first.text === 'string') return first.text;
  }
  return typeof content === 'string' ? content : JSON.stringify(content);
};

export const buildToolContext = (deps: ToolContextDeps): ToolContext => {
  const opsCache = new Map<ObjectType, Set<string>>();
  const operationalEvent = deps.operationalEvent;

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
    ...(operationalEvent
      ? {
          operational: {
            call: async (name: string, args: Record<string, unknown>) => {
              const handler = OPERATIONAL_HANDLERS[name];
              if (!handler) {
                return {
                  content: JSON.stringify({ error: `No operational handler is wired for "${name}".` }),
                  is_error: true,
                };
              }
              try {
                const raw = await handler(operationalEvent, args);
                return toOperationalToolResult(raw);
              } catch (error) {
                // An operational handler that THROWS (a site that doesn't
                // deploy an optional sibling, a bridge misconfiguration) must
                // fail this ONE tool call, not the whole run: every other
                // tool reports failure as an is_error result the agent can
                // react to, and a thrown error here would instead reach
                // runAgentLoop's catch and end the run.
                return {
                  content: JSON.stringify({
                    error: error instanceof Error ? error.message : `The "${name}" tool failed.`,
                    tool: name,
                  }),
                  is_error: true,
                };
              }
            },
          },
        }
      : {}),

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
