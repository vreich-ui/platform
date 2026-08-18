/**
 * Function name: Admin_Governance
 * Required method: POST
 * Auth: read (Admin) · write (Owner). Runtime override layer over the committed
 * approval / creation policy levers (T9.15, OQ-W9-2).
 *
 * Verbs: get (doc + committed defaults + resolved active), set (Owner — write
 * an override), revert (Owner — clear an override so the committed default
 * stands). Every write appends to the doc history.
 *
 * W11 T11.10: `agent_keys_*` verbs manage the per-agent-credential doc
 * (`agent-keys.v1`, packages/core/server/lib/agent-keys.ts) in this SAME
 * governance blob store — a sibling doc, not a new store. `agent_keys_list`
 * is Admin (read, never returns a token hash); `agent_keys_create`/
 * `agent_keys_revoke` are Owner-only, same bar as every other governance
 * write here. `agent_keys_create` is the ONLY response that ever carries a
 * raw token — it is minted here and returned exactly once.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { z } from 'zod';

import { getAdminStateFromEvent, type LambdaContext } from '../lib/admin-auth.js';
import { resolveRolesFromEvent } from '../lib/request-roles.js';
import { isOwner } from '../lib/roles.js';
import {
  getGovernanceBlobStore,
  getGovernanceDoc,
  putGovernanceDoc,
  resolveActivePolicies,
  chatToolAutonomySchema,
  type GovernanceDoc,
} from '../lib/governance-store.js';
import {
  getAgentKeysDoc,
  putAgentKeysDoc,
  emptyAgentKeysDoc,
  createAgentKey,
  revokeAgentKey,
  describeAgentKeys,
  type AgentKeysBlobStore,
} from '../lib/agent-keys.js';
import { CHAT_TOOLS, defaultAutonomyFor } from '../lib/agent/tools.js';
import { migrateAutonomyKeys, generatedChatToolByName } from '../lib/agent/generated-tools.js';
import { MEMBERSHIP_TOOL_NAMES } from '../lib/mcp-tool-definitions-membership.js';
import { CmsAgentClient, cmsAgentMissingEnvVars } from '../lib/agent/cms-agent-client.js';
import { resolveEffectiveChatMode } from '../lib/agent/engine.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import { approvalPolicyConfigSchema, activeApprovalPolicy } from '../../lib/approval-policy.js';
import { creationPolicyConfigSchema, activeCreationPolicy } from '../../lib/creation-policy.js';

type LambdaEvent = {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
};

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const jsonResponse = (status: number, body: Record<string, unknown>) => ({
  statusCode: status,
  headers: jsonHeaders,
  body: JSON.stringify({ ok: status >= 200 && status < 300, status, ...body }),
});

// Exported for admin-governance.test.ts — the request CONTRACT is worth
// testing directly; the owner-gating wiring around it is checked by a
// source-level assertion (this file's established pattern, see
// tests/netlify/tracking-governance.test.ts's own admin-governance check).
export const requestSchema = z.discriminatedUnion('verb', [
  z.object({ verb: z.literal('get') }),
  z.object({
    verb: z.literal('set'),
    approval: approvalPolicyConfigSchema.optional(),
    creation: creationPolicyConfigSchema.optional(),
    chat_tools: chatToolAutonomySchema.optional(),
    learning_mode: z.boolean().optional(),
    /** PF3/PF5: the chat TurnEngine mode override — the cutover/rollback lever. */
    cms_agent_chat_mode: z.enum(['off', 'fallback', 'required']).optional(),
    /** Task 3: the chat-tool registry override — the no-deploy rollback lever
     *  back to the legacy (tools.ts) registry. Unset resolves to 'generated'. */
    chat_registry: z.enum(['legacy', 'generated']).optional(),
  }),
  z.object({
    verb: z.literal('revert'),
    target: z.enum([
      'approval',
      'creation',
      'chat_tools',
      'learning_mode',
      'cms_agent_chat_mode',
      'chat_registry',
      'all',
    ]),
  }),
  z.object({ verb: z.literal('agent_keys_list') }),
  z.object({ verb: z.literal('agent_keys_create'), agent_name: z.string().min(1), site: z.string().min(1) }),
  z.object({ verb: z.literal('agent_keys_revoke'), agent_name: z.string().min(1), site: z.string().min(1) }),
]);

const safeJsonParse = (event: LambdaEvent): { ok: true; value: unknown } | { ok: false } => {
  if (!event.body) return { ok: false };
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
};

const nowIso = () => new Date().toISOString();
const committed = () => ({ approval: activeApprovalPolicy(), creation: activeCreationPolicy() });

// ─── PF3: CMS-Agent bridge status (memoized health probe) ────────────────────

const CMS_AGENT_HEALTH_TTL_MS = 60_000;
const cmsAgentHealthClient = new CmsAgentClient();
/** Keyed by project id: each site is its own Netlify process, but a keyed
 *  cache removes the whole cross-tenant-staleness class outright. */
const cmsAgentHealthCache = new Map<string, { at: number; health: Record<string, unknown> }>();

/** Config + effective mode + a memoized live `agent_resolve` probe. Env NAMES
 *  only, never values; the probe is read-only and cached for a minute so the
 *  governance page cannot hammer the service. */
const cmsAgentStatus = async (override?: 'off' | 'fallback' | 'required'): Promise<Record<string, unknown>> => {
  const missing = cmsAgentMissingEnvVars();
  const effective = resolveEffectiveChatMode(override);
  const status: Record<string, unknown> = {
    configured: missing.length === 0,
    ...(missing.length > 0 ? { missing_env: missing } : {}),
    mode: effective.mode,
    mode_source: override ? 'governance_override' : 'env_default',
    ...(effective.invalidEnvValue === undefined ? {} : { invalid_env_value: effective.invalidEnvValue }),
  };
  if (missing.length > 0) return status;
  const projectId = getSiteIdentity().cmsAgentProjectId;
  const now = Date.now();
  const cached = cmsAgentHealthCache.get(projectId);
  if (!cached || now - cached.at > CMS_AGENT_HEALTH_TTL_MS) {
    const probe = await cmsAgentHealthClient.resolveAgent({ role: 'client_manager', project_id: projectId });
    cmsAgentHealthCache.set(projectId, {
      at: now,
      health: probe.ok ? { ok: true, agent_ref: probe.data } : { ok: false, code: probe.code, message: probe.message },
    });
  }
  return { ...status, health: cmsAgentHealthCache.get(projectId)!.health };
};

/** The chat-tool catalog for the guardrails table — the SINGLE source is
 *  CHAT_TOOLS, so the UI can never drift from the tools the run loop actually
 *  wires. Each entry carries the class-derived default the override layers on
 *  top of (resolveAutonomy in agent/tools.ts). Static, so computed once. */
const chatToolsCatalog = [
  ...CHAT_TOOLS.map((tool) => ({
    name: tool.name,
    tool_class: tool.toolClass,
    default: defaultAutonomyFor(tool),
    description: tool.description,
    ...(tool.autonomyFloor ? { autonomy_floor: tool.autonomyFloor } : {}),
  })),
  // W18 T18.6b: the membership family lives only in the generated registry;
  // surface it here so an Owner can switch the off-by-default writes on and
  // see that the `ask` floor cannot be lowered.
  ...[...MEMBERSHIP_TOOL_NAMES].flatMap((name) => {
    const tool = generatedChatToolByName(name);
    if (!tool) return [];
    return [
      {
        name: tool.name,
        tool_class: tool.toolClass,
        default:
          tool.toolClass === 'read' && !['member_audit', 'membership_policy_get', 'member_export'].includes(name)
            ? ('auto' as const)
            : ('off' as const),
        description: tool.description,
        ...(tool.autonomyFloor ? { autonomy_floor: tool.autonomyFloor } : {}),
      },
    ];
  }),
];

const handlerImpl = async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const adminState = await getAdminStateFromEvent(event, context);
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });

  const email = (adminState.email ?? '').trim().toLowerCase();
  const roles = await resolveRolesFromEvent(event, { kind: 'human', id: adminState.userId ?? '', email });
  if (!roles.includes('admin')) return jsonResponse(403, { error: 'Admin access required' });
  const owner = isOwner(roles);

  const parsed = safeJsonParse(event);
  if (!parsed.ok) return jsonResponse(400, { error: 'Invalid request body.' });
  const request = requestSchema.safeParse(parsed.value);
  if (!request.success) return jsonResponse(400, { error: 'Invalid request fields.', issues: request.error.issues });

  try {
    const store = await getGovernanceBlobStore(event);
    const req = request.data;

    if (req.verb === 'get') {
      const doc = await getGovernanceDoc(store);
      return jsonResponse(200, {
        doc,
        committed: committed(),
        active: await resolveActivePolicies(store),
        chat_tools_catalog: chatToolsCatalog,
        cms_agent: await cmsAgentStatus(doc?.cms_agent_chat_mode),
      });
    }

    if (req.verb === 'agent_keys_list') {
      const doc = await getAgentKeysDoc(store as unknown as AgentKeysBlobStore);
      return jsonResponse(200, { keys: describeAgentKeys(doc) });
    }

    if (req.verb === 'agent_keys_create' || req.verb === 'agent_keys_revoke') {
      if (!owner) return jsonResponse(403, { error: 'Owner access required' });
      const agentKeysStore = store as unknown as AgentKeysBlobStore;
      const existingDoc = (await getAgentKeysDoc(agentKeysStore)) ?? emptyAgentKeysDoc(email, nowIso());

      if (req.verb === 'agent_keys_create') {
        const {
          doc: nextDoc,
          token,
          record,
        } = createAgentKey(existingDoc, {
          agent_name: req.agent_name,
          site: req.site,
          created_by: email,
          now: nowIso(),
        });
        await putAgentKeysDoc(agentKeysStore, nextDoc);
        // The only response in this whole handler that ever carries a raw
        // secret — shown once, never logged, never re-derivable afterward.
        const { token_hash: _tokenHash, ...recordWithoutHash } = record;
        return jsonResponse(200, { token, record: recordWithoutHash });
      }

      const nextDoc = revokeAgentKey(existingDoc, {
        agent_name: req.agent_name,
        site: req.site,
        revoked_by: email,
        now: nowIso(),
      });
      await putAgentKeysDoc(agentKeysStore, nextDoc);
      return jsonResponse(200, { keys: describeAgentKeys(nextDoc) });
    }

    if (!owner) return jsonResponse(403, { error: 'Owner access required' });

    const existing: GovernanceDoc = (await getGovernanceDoc(store)) ?? {
      schema_version: 'overrides.v1',
      updated_by: email,
      updated_at: nowIso(),
      history: [],
    };

    let next: GovernanceDoc;
    if (req.verb === 'set') {
      const touched = [
        req.approval && 'approval',
        req.creation && 'creation',
        req.chat_tools && 'chat_tools',
        req.learning_mode !== undefined && 'learning_mode',
        req.cms_agent_chat_mode !== undefined && `cms_agent_chat_mode=${req.cms_agent_chat_mode}`,
        req.chat_registry !== undefined && `chat_registry=${req.chat_registry}`,
      ]
        .filter(Boolean)
        .join(', ');
      // Task 3 §6: canonicalize chat_tools keys on write, whatever this admin
      // typed — an Owner-authored `chat_tools` may still name a legacy alias
      // (e.g. `patch`). Stamped migrated: further reads never re-interpret a
      // deliberately-set canonical `search_artifacts` key as its legacy meaning.
      const { map: canonicalChatTools } = migrateAutonomyKeys(req.chat_tools);
      next = {
        ...existing,
        ...(req.approval !== undefined ? { approval: req.approval } : {}),
        ...(req.creation !== undefined ? { creation: req.creation } : {}),
        ...(req.chat_tools !== undefined ? { chat_tools: canonicalChatTools, chat_tools_migrated: true } : {}),
        ...(req.learning_mode !== undefined ? { learning_mode: req.learning_mode } : {}),
        ...(req.cms_agent_chat_mode !== undefined ? { cms_agent_chat_mode: req.cms_agent_chat_mode } : {}),
        ...(req.chat_registry !== undefined ? { chat_registry: req.chat_registry } : {}),
        updated_by: email,
        updated_at: nowIso(),
        history: [...existing.history, { at: nowIso(), actor_email: email, action: 'set', detail: touched || 'none' }],
      };
    } else {
      next = { ...existing, updated_by: email, updated_at: nowIso() };
      if (req.target === 'all') {
        delete next.approval;
        delete next.creation;
        delete next.chat_tools;
        delete next.chat_tools_migrated;
        delete next.learning_mode;
        delete next.cms_agent_chat_mode;
        delete next.chat_registry;
      } else {
        delete next[req.target];
        if (req.target === 'chat_tools') delete next.chat_tools_migrated;
      }
      next.history = [...existing.history, { at: nowIso(), actor_email: email, action: 'revert', detail: req.target }];
    }

    await putGovernanceDoc(store, next);
    return jsonResponse(200, {
      doc: next,
      committed: committed(),
      active: await resolveActivePolicies(store),
      chat_tools_catalog: chatToolsCatalog,
    });
  } catch (error) {
    console.error('Admin_Governance request failed.', error);
    return jsonResponse(500, { error: 'Governance request could not be processed.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (_binding: SiteBinding) => handlerImpl;
