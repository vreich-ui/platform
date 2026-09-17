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
import {
  cmsAgentHealthFromProbe,
  cmsAgentProbeView,
  loadGovernanceSnapshot,
  refreshGovernanceSnapshotAfterWrite,
  type CmsAgentProbeResult,
} from '../lib/governance/snapshot-store.js';
import { CHAT_TOOLS, defaultAutonomyFor } from '../lib/agent/tools.js';
import { migrateAutonomyKeys, generatedChatToolByName } from '../lib/agent/generated-tools.js';
import { CHAT_TOOL_ALIASES } from '../lib/mcp-tool-definitions.js';
import { MEMBERSHIP_TOOL_NAMES } from '../lib/mcp-tool-definitions-membership.js';
import { cmsAgentMissingEnvVars } from '../lib/agent/cms-agent-client.js';
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
    /** W21: the capture-plane guardrail. Unset resolves to 'open' — the
     *  registry policy as handed over (governance-store.ts). Narrows only. */
    siteCapture: z.enum(['open', 'self_only', 'locked']).optional(),
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
      'siteCapture',
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

// ─── M3.4: CMS-Agent bridge status, READ FROM THE SNAPSHOT ───────────────────

/**
 * What used to live here: `CMS_AGENT_HEALTH_TTL_MS`, a module-scope
 * `Map` keyed by project id, `cmsAgentProbe` and a `CmsAgentClient`
 * instance — a LIVE cross-service health probe on the `get` verb, which is
 * what `/admin/guardrails` and `/admin/visual-identity` both call on load.
 * Measured 2026-09-16: `governance` 3.9 s on visual identity with
 * `sec.probe = 2768`, and `work = 109` on guardrails two minutes later. The
 * second number is not the fix, it is the memo lottery — module scope, many
 * instances, a cold container starts empty by construction — and wave 1
 * already established that it protects nobody.
 *
 * M3.4 moved the probe to `lib/governance/cms-agent-probe.ts`, called only by
 * the five-minute `functions/governance-probe-refresh.ts`, which stores its
 * result in `snapshots/governance.json`. This function reads that blob. The
 * probe module is not imported here and must not become reachable from here:
 * the milestone is not "probe less often", it is "a page never probes".
 *
 * `configured` is unchanged and still answered live, because it is an env-var
 * NAME check with no network — so the one state an operator can actually act
 * on (this tenant has no CMS-Agent credentials) is still immediate, even on a
 * tenant whose schedule has never run.
 */
const cmsAgentStatus = (
  binding: SiteBinding,
  probe: CmsAgentProbeResult | null,
  nowMs: number,
  legacyOverride?: 'off' | 'fallback' | 'required'
): Record<string, unknown> => {
  const missing = cmsAgentMissingEnvVars(binding.env);
  const status: Record<string, unknown> = {
    configured: missing.length === 0,
    ...(missing.length > 0 ? { missing_env: missing } : {}),
    mode: 'required',
    mode_source: 'permanent_default',
    ...(legacyOverride ? { legacy_mode_override_ignored: legacyOverride } : {}),
    /**
     * The three-state reading (`never_checked` / `fresh` / `stale`) with the
     * bound it was taken against. New in M3.4 and the honest part of the
     * wire: a verdict without a `checked_at` cannot be told apart from one
     * taken an hour ago.
     */
    probe: cmsAgentProbeView(probe, nowMs),
  };
  const health = cmsAgentHealthFromProbe(probe);
  // Absent when nobody has ever probed — exactly what the pre-M3.4 shape did
  // for a tenant it never probed, so no client sees a new shape here.
  return health === undefined ? status : { ...status, health };
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
      /**
       * M3.4 — ONE blob read, and no network call of any kind.
       *
       * Before: one read of `overrides.v1` CONCURRENT WITH a live CMS-Agent
       * probe, and the verb paid for the slower of the two — which on a cold
       * container was always the probe (2768 ms measured on
       * `/admin/visual-identity`, which reads exactly one field of this
       * response). Now: one read of `snapshots/governance.json`, which
       * carries the document AND the last probe result.
       *
       * `sec.snapshot` covers both outcomes, and `snapshot.repaired` on the
       * wire says which one happened: a repair is one extra read of
       * `overrides.v1` plus one write — the old read path, kept as the
       * self-healing repair (AGENTS.md: self-healing over migrations) and
       * reached when the blob is absent, unparseable, written by another
       * schema version, or older than `GOVERNANCE_SNAPSHOT_MAX_AGE_MS`. A
       * surface answering `repaired: true` on every request has a dead
       * schedule; that is what the flag exists to make visible.
       */
      const { snapshot, repaired } = await timeSection('snapshot', () => loadGovernanceSnapshot(store, Date.now()));
      const doc = snapshot.doc;
      return readJsonResponse(event, {
        doc,
        committed: committed(),
        active: activePoliciesFromDoc(doc),
        chat_tools_catalog: chatToolsCatalog,
        cms_agent: cmsAgentStatus(binding, snapshot.cms_agent_probe, Date.now(), doc?.cms_agent_chat_mode),
        /** `as_of` on the wire, so a lagging snapshot is visible rather than silent (the `snapshots/release.json` convention). */
        snapshot: { as_of: snapshot.as_of, source: snapshot.source, repaired },
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
        req.siteCapture !== undefined && `siteCapture=${req.siteCapture}`,
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
        ...(req.siteCapture !== undefined ? { siteCapture: req.siteCapture } : {}),
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
        delete next.siteCapture;
        delete next.genesis;
      } else {
        delete next[req.target];
        if (req.target === 'chat_tools') delete next.chat_tools_migrated;
      }
      next.history = [...existing.history, { at: nowIso(), actor_email: email, action: 'revert', detail: req.target }];
    }

    await putGovernanceDoc(store, next);
    /**
     * M3.4 — the write path is one of `snapshots/governance.json`'s writers.
     *
     * Without this an Owner would save a guardrail and then read the previous
     * value back for up to five minutes, because every READ now comes from
     * the snapshot. Same reasoning, same shape, as `object_publish` refreshing
     * `snapshots/release.json` rather than waiting for its schedule. Awaited
     * rather than fired and forgotten: the response below IS the Owner's next
     * read of this data, and a function frozen after its response would not
     * finish the write.
     */
    await refreshGovernanceSnapshotAfterWrite(store, next, Date.now());
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
