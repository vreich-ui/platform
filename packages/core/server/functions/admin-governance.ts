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
import { createHash } from 'node:crypto';

import type { SiteBinding } from '../lib/site-binding.js';
import { z } from 'zod';

import { getAdminStateFromEvent, type LambdaContext } from '../lib/admin-auth.js';
import { resolveRolesFromEvent } from '../lib/request-roles.js';
import { timeAuth, timeSection, timeSerialize, withServerTiming } from '../lib/server-timing.js';
import { isOwner } from '../lib/roles.js';
import {
  getGovernanceBlobStore,
  getGovernanceDoc,
  putGovernanceDoc,
  activePoliciesFromDoc,
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
import { CHAT_TOOL_ALIASES } from '../lib/mcp-tool-definitions.js';
import { MEMBERSHIP_TOOL_NAMES } from '../lib/mcp-tool-definitions-membership.js';
import { CmsAgentClient, cmsAgentMissingEnvVars } from '../lib/agent/cms-agent-client.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import { approvalPolicyConfigSchema, activeApprovalPolicy } from '../../lib/approval-policy.js';
import { creationPolicyConfigSchema, activeCreationPolicy } from '../../lib/creation-policy.js';
import { activeGenesisPolicy, genesisPolicyConfigSchema } from '../../lib/genesis-policy.js';

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
  body: timeSerialize(() => JSON.stringify({ ok: status >= 200 && status < 300, status, ...body })),
});

/**
 * T2.3 — `get` and `agent_keys_list` are this function's only two read verbs
 * (`agent_keys_list` never returns a token hash; the read bar for it is
 * Admin, same as `get` — see the file header). Every other verb (`set`,
 * `revert`, `agent_keys_create`, `agent_keys_revoke`) writes the governance
 * or agent-keys doc and keeps the plain `no-store` `jsonResponse` above —
 * `agent_keys_create` in particular must NEVER be cacheable, since its body
 * is the one place a raw token is ever returned.
 */
const CACHE_CONTROL = 'private, no-cache';
/**
 * Hashes the ALREADY-SERIALIZED wire body, so a read response is
 * `JSON.stringify`d exactly ONCE per request. The digest is identical to
 * hashing the object (same input string), but the previous shape paid a
 * second full stringify of the whole body on every read — on a latency
 * branch, on this surface's hottest read paths.
 */
const etagForSerialized = (serialized: string): string =>
  `"${createHash('sha1').update(serialized).digest('hex')}"`;

const readJsonResponse = (event: LambdaEvent, body: Record<string, unknown>) => {
  const serialized = timeSerialize(() => JSON.stringify({ ok: true, status: 200, ...body }));
  const etag = etagForSerialized(serialized);
  const ifNoneMatch = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
  if (ifNoneMatch && ifNoneMatch === etag) {
    return { statusCode: 304, headers: { 'Cache-Control': CACHE_CONTROL, ETag: etag }, body: '' };
  }
  return {
    statusCode: 200,
    headers: { ...jsonHeaders, 'Cache-Control': CACHE_CONTROL, ETag: etag },
    body: serialized,
  };
};

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
    /** PF5 permanent cutover: explicitly reject the retired mode lever. */
    cms_agent_chat_mode: z.never().optional(),
    /** Task 3: the chat-tool registry override — the no-deploy rollback lever
     *  back to the legacy (tools.ts) registry. Unset resolves to 'generated'. */
    chat_registry: z.enum(['legacy', 'generated']).optional(),
    /** U2 (BRIEF §3.7/R5): the `style` override channel guardrail on
     *  create_agent_artifact_job. Unset resolves to 'allow' (governance-store.ts). */
    brandImageryOverrides: z.enum(['allow', 'lock']).optional(),
    /** Wolf 2026-09-09: the genesis policy override — which baseline artifacts
     *  a mint must supply. FLEET-wide by nature, per-tenant by storage; see
     *  server/lib/genesis-policy-verbs.ts for the honest limit of what an
     *  override here reaches. Same lever as the `genesis_policy_set` MCP verb,
     *  same Owner bar, same doc field — this is the Identity-JWT door to it. */
    genesis: genesisPolicyConfigSchema.optional(),
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
      'brandImageryOverrides',
      'genesis',
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
// Wolf 2026-09-09: `genesis` resolves through the same seam as its two
// neighbours, but no site registers a provider for it and none should — it has
// no per-site committed layer, which is precisely what makes it fleet-wide
// (packages/core/lib/genesis-policy.ts's header says why). In practice this is
// the committed FLEET_GENESIS_POLICY.
const committed = () => ({
  approval: activeApprovalPolicy(),
  creation: activeCreationPolicy(),
  genesis: activeGenesisPolicy(),
});

// ─── PF3: CMS-Agent bridge status (memoized health probe) ────────────────────

const CMS_AGENT_HEALTH_TTL_MS = 60_000;
/**
 * T-perf wave 3 — after last wave's one-doc-read + `Promise.all` fix shipped,
 * re-measurement showed `work` barely moved (2126 -> 2002 ms). `sec.doc` /
 * `sec.probe` below are what let the NEXT measurement say which half that
 * still is, but the code-level reasoning already points one way: `doc` is a
 * single Netlify Blobs GET, and `probe` — when the memo below is cold, which
 * it always is on a cold container, by construction — is up to three SERIAL
 * cross-service HTTP calls (`initialize`, `notifications/initialized`,
 * `tools/call` for `agent_resolve`), each of which inherited
 * `CmsAgentClient`'s conversational-turn default of 90 s per call with no
 * override. A live-conversation turn can legitimately need that; a
 * governance-page STATUS check cannot — nothing here reads the probe's
 * result to decide anything, `cmsAgentStatus` below turns a failure of any
 * kind into `{configured, health: {ok:false, code, message}}`, never an
 * error response. 3 s is a deliberately tight budget for what should be a
 * same-region, no-payload health call: generous under normal conditions,
 * and it bounds the worst case (a lost session forcing a fresh handshake) to
 * single-digit seconds instead of tens-to-hundreds of them. Scoped to THIS
 * client instance only — every other `CmsAgentClient` caller (chat turns,
 * node execution) keeps the 90 s default this constant does not touch.
 */
export const CMS_AGENT_PROBE_TIMEOUT_MS = 3_000;
const cmsAgentHealthClient = new CmsAgentClient({ timeoutMs: CMS_AGENT_PROBE_TIMEOUT_MS });
/** Keyed by project id: each site is its own Netlify process, but a keyed
 *  cache removes the whole cross-tenant-staleness class outright. Module
 *  scope, so it survives across invocations of a WARM container — the only
 *  thing it cannot do anything about is a cold one, which starts with an
 *  empty module and therefore an empty cache by construction (see `sec.probe`
 *  above for what covers that case instead). */
const cmsAgentHealthCache = new Map<string, { at: number; health: Record<string, unknown> }>();

/**
 * Test-only: the memo living at module scope is the whole point in
 * production (it is what makes a warm container's second-and-later `get`
 * skip the network call entirely), but that same persistence means a test
 * that calls `cmsAgentProbe` directly — the only way to exercise the timeout
 * fix behaviorally rather than by source inspection — would otherwise see
 * whatever an earlier test in this same process already cached. Never
 * imported outside admin-governance.test.ts.
 */
export const __resetCmsAgentProbeCacheForTesting = (): void => {
  cmsAgentHealthCache.clear();
};

type CmsAgentProbe = { missing: string[]; health?: Record<string, unknown> };

/**
 * The SLOW half — env check plus the memoized live `agent_resolve` probe.
 * Env NAMES only, never values; the probe is read-only and cached for a
 * minute so the governance page cannot hammer the service.
 *
 * Deliberately takes NOTHING from the governance doc. On a cold container
 * this is a real cross-service HTTP round trip, and it used to be awaited
 * only AFTER the doc read had already returned — purely because the wire
 * shape carries one doc-derived field (`legacy_mode_override_ignored`).
 * Separating the probe from the field lets the `get` verb start both at once
 * (`Promise.all`) and pay for the slower one, not for both in series.
 *
 * Exported for admin-governance.test.ts — whether a hung CMS-Agent actually
 * degrades this to an unknown status within `CMS_AGENT_PROBE_TIMEOUT_MS`,
 * instead of failing the read or blocking past it, is a runtime property no
 * source-level regex can prove (this file's established pattern for what it
 * CAN prove at the source level; see the wiring test below).
 */
export const cmsAgentProbe = async (binding: SiteBinding): Promise<CmsAgentProbe> => {
  const missing = cmsAgentMissingEnvVars(binding.env);
  if (missing.length > 0) return { missing };
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
  return { missing, health: cmsAgentHealthCache.get(projectId)!.health };
};

/** Config + permanent mode + the probe's outcome, in the key order this
 *  object has always been serialized in (the ETag hashes the wire body). */
const cmsAgentStatus = (
  probe: CmsAgentProbe,
  legacyOverride?: 'off' | 'fallback' | 'required'
): Record<string, unknown> => {
  const status: Record<string, unknown> = {
    configured: probe.missing.length === 0,
    ...(probe.missing.length > 0 ? { missing_env: probe.missing } : {}),
    mode: 'required',
    mode_source: 'permanent_default',
    ...(legacyOverride ? { legacy_mode_override_ignored: legacyOverride } : {}),
  };
  if (probe.health === undefined) return status;
  return { ...status, health: probe.health };
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
    // Save-round-trip fix: a `set` canonicalizes every chat_tools key it
    // writes (migrateAutonomyKeys → CHAT_TOOL_ALIASES), so `patch` is STORED
    // as `object_patch` while this catalog still serves the legacy name. The
    // guardrails table was reading the stored map by catalog key and finding
    // nothing, which read to an Owner as "Save changes doesn't save". Sending
    // the stored name with the row lets the client read its own writes back
    // without duplicating the alias table client-side.
    ...(CHAT_TOOL_ALIASES[tool.name] ? { canonical_name: CHAT_TOOL_ALIASES[tool.name] } : {}),
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

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const adminState = await timeAuth(() => getAdminStateFromEvent(event, context));
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });

  const email = (adminState.email ?? '').trim().toLowerCase();
  const roles = await timeAuth(() =>
    resolveRolesFromEvent(event, { kind: 'human', id: adminState.userId ?? '', email }, binding)
  );
  if (!roles.includes('admin')) return jsonResponse(403, { error: 'Admin access required' });
  const owner = isOwner(roles);

  const parsed = safeJsonParse(event);
  if (!parsed.ok) return jsonResponse(400, { error: 'Invalid request body.' });
  const request = requestSchema.safeParse(parsed.value);
  if (!request.success) return jsonResponse(400, { error: 'Invalid request fields.', issues: request.error.issues });

  try {
    const store = await getGovernanceBlobStore(event, binding);
    const req = request.data;

    if (req.verb === 'get') {
      // ONE read of `overrides.v1` (this used to read the same blob twice —
      // once here and once inside resolveActivePolicies — then wait for the
      // CMS-Agent probe on top of both, all in series). `timeSection` splits
      // `work` by QUESTION ASKED (see admin-editorial-assets.ts for the same
      // pattern) so Server-Timing's `sec.doc` / `sec.probe` say which of the
      // two concurrent halves is actually the long pole, instead of that
      // being an inference again.
      const [doc, probe] = await Promise.all([
        timeSection('doc', () => getGovernanceDoc(store)),
        timeSection('probe', () => cmsAgentProbe(binding)),
      ]);
      return readJsonResponse(event, {
        doc,
        committed: committed(),
        active: activePoliciesFromDoc(doc),
        chat_tools_catalog: chatToolsCatalog,
        cms_agent: cmsAgentStatus(probe, doc?.cms_agent_chat_mode),
      });
    }

    if (req.verb === 'agent_keys_list') {
      const doc = await getAgentKeysDoc(store as unknown as AgentKeysBlobStore);
      return readJsonResponse(event, { keys: describeAgentKeys(doc) });
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
        req.chat_registry !== undefined && `chat_registry=${req.chat_registry}`,
        req.brandImageryOverrides !== undefined && `brandImageryOverrides=${req.brandImageryOverrides}`,
        req.genesis !== undefined && `genesis.requiredArtifacts=[${req.genesis.requiredArtifacts.join(', ')}]`,
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
        ...(req.chat_registry !== undefined ? { chat_registry: req.chat_registry } : {}),
        ...(req.brandImageryOverrides !== undefined ? { brandImageryOverrides: req.brandImageryOverrides } : {}),
        ...(req.genesis !== undefined ? { genesis: req.genesis } : {}),
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
        delete next.brandImageryOverrides;
        delete next.genesis;
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
export const createHandler = (binding: SiteBinding) =>
  withServerTiming('admin-governance', buildHandlerImpl(binding));
