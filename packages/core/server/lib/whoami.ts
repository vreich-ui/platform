/**
 * `whoami` (W7.2) — the one call that proves an install.
 *
 * THE PROBLEM IT SOLVES. Between an invite email and a published article sit
 * five things that can each be silently wrong, and none of them is visible
 * from inside a chat app:
 *
 *   1. WHICH HUMAN is this token bound to? A connector added while signed in
 *      as the wrong account authenticates perfectly and writes as the wrong
 *      person.
 *   2. WHAT ROLE does that human hold here? A `viewer` can call every write
 *      tool the charter lists and is refused by the gate at the very end of a
 *      long drafting session — the most expensive place to learn it.
 *   3. WHICH SURFACE does the tenant think this is? `plugin:openai-gpt` and
 *      `plugin:openai-agent` are different installs with different charters,
 *      and the ledger separates them. The client never says which it is.
 *   4. IS THE INSTALLED SCHEMA CURRENT? A chat app caches the tool list it
 *      imported. When the tenant's tool surface moves, the cached client keeps
 *      calling a surface that no longer exists and reports nothing but tool
 *      errors (the cached-schema defect — W7.5 makes the digest comparable,
 *      this makes it visible).
 *   5. WHAT ARE THE RULES? The aggression ceiling and the approval posture
 *      govern whether a draft can ever publish. A plugin that learns them at
 *      the gate has already written the wrong article.
 *
 * Every one of those is a fact the SERVER already knows and the client cannot
 * derive. So this returns all five in one read-only call, and the install page
 * makes running it the last step of every install ("Prove it").
 *
 * WHY IT IS SAFE TO BE IN THE CHARTER. It is `read` class and it reports only
 * facts about the CALLER'S OWN grant plus public tenant policy — no other
 * member, no token, no secret, nothing about the store's contents. An
 * unauthenticated caller never reaches it: `/mcp` refuses before dispatch.
 *
 * ATTRIBUTION IS NOT SELF-REPORTED. `member`, `surface` and `attribution` all
 * come from `actorFromMcpAuth` — the same derivation the object ledger uses
 * (caller-actor.ts) — so what `whoami` says about a caller is exactly what the
 * ledger will record for that caller's next write. A `whoami` that disagreed
 * with the ledger would be worse than no `whoami` at all.
 */
import { actorFromMcpAuth } from './caller-actor.js';
import { getSiteIdentity, type AggressionCeiling } from '../../lib/site-identity.js';
import { activeApprovalPolicy } from '../../lib/approval-policy.js';
import { buildPluginTools, toolSurfaceDigest } from './plugin/build-tools.js';
import { getPluginManifestBlobStore, getPluginManifestDoc } from './plugin/manifest-store.js';
import { resolveRolesForPrincipalAsync, type Role } from './roles.js';
import { getUsersBlobStore, getUserRecord } from './users-store.js';
import type { ToolDefinition } from '../functions/mcp.js';
import type { Principal } from '../../schema/object-record-v1.js';

/** Roles that may create or change content. Below this, the plugin must not write. */
const WRITE_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'publisher', 'editor']);

export type WhoamiMember = {
  id: string;
  email: string;
  /** The workspace tier as the membership store holds it, or the env-resolved equivalent. */
  role: Role | 'none';
  /** Every role the tier expands to — what the gates actually read. */
  roles: Role[];
  status: 'active' | 'invited' | 'disabled' | 'unknown';
};

export type WhoamiResult = {
  ok: true;
  server: string;
  tenant: string;
  site_id: string;
  /** The OAuth-bound human, or null when this call is an agent credential. */
  member: WhoamiMember | null;
  /** `plugin:claude` | `plugin:openai-gpt` | `plugin:openai-agent` | 'unknown'. */
  surface: string;
  /** How identity was established: oauth | verified_agent_token | self_declared | publish_key. */
  attribution: string;
  /**
   * Whether this caller may write. FALSE is the answer the plugin must obey at
   * session start rather than discovering at the publish gate.
   */
  can_write: boolean;
  /** Why not, in one sentence, when `can_write` is false. */
  refuse_reason?: string;
  /** The promoted manifest this tenant serves, or null when none is promoted. */
  manifest_version: string | null;
  /** Tool names the active manifest's charter lists, or null when none is promoted. */
  charter: string[] | null;
  /** Live fingerprint of the plugin-eligible tool surface, computed now. */
  tools_digest: string;
  /** The digest the promoted manifest was rendered against. */
  manifest_tools_digest: string | null;
  /**
   * FALSE means the installed export was built against a different tool
   * surface: the client's cached schema is stale and must be re-added. This is
   * the cached-schema defect made diagnosable in one glance (D5).
   */
  tools_digest_matches: boolean;
  aggression_ceiling: AggressionCeiling | null;
  publish_policy: {
    master: string;
    /** Governed types pinned to require-approval — the ones a publish will halt on. */
    require_approval: string[];
    /**
     * W7.5: per-surface allow/block, when the operator has set any. A surface
     * absent from the map is allowed.
     */
    surfaces?: Record<string, 'allow' | 'block'>;
  };
  /**
   * W7.5: TRUE when an operator has cut this surface off. `whoami` still
   * answers — that is the point — and this is how a plugin learns that its
   * tool errors are a decision about the chat app rather than a broken tenant.
   */
  surface_blocked: boolean;
};

export type WhoamiDeps = {
  /** The live tool surface — pass `visibleToolDefinitions(event)`. */
  definitions: readonly ToolDefinition[];
  /**
   * The request, for store resolution. Kept `unknown` for the same reason the
   * blob-store helpers do: this module never reads a field off it.
   */
  event: unknown;
  /**
   * W7.5: reads the per-surface allow/block map, when the caller can supply it.
   * Injected rather than read here so this module keeps its one store
   * dependency shape (the caller already holds a governance store) and so a
   * chat-side call that has no governance store simply omits it.
   */
  surfacePolicy?: () => Promise<Record<string, 'allow' | 'block'> | undefined>;
  /** Auth-derived identity inputs, exactly as `/mcp` holds them. */
  auth: {
    oauthPrincipal?: { subject_email: string; subject_id: string; client_id: string; surface?: string } | undefined;
    verifiedAgentName?: string | undefined;
    pluginSurface?: string | undefined;
  };
};

const memberFromActor = async (actor: Principal, event: unknown): Promise<WhoamiMember | null> => {
  if (actor.kind !== 'human') return null;

  /**
   * Roles resolve through the SAME async resolver every gate uses, including
   * its precedence (bootstrap owner → membership record → env allowlist) and
   * its fail-soft on an unreadable store. A `whoami` that resolved roles its
   * own way would be a second, drifting answer to the question the gate
   * decides — which is the defect, not the feature.
   */
  const roles = await resolveRolesForPrincipalAsync(actor, {
    getUserRecord: async (email) => getUserRecord(await getUsersBlobStore(event), email),
  });

  let status: WhoamiMember['status'] = 'unknown';
  let tier: Role | 'none' = 'none';
  try {
    const record = await getUserRecord(await getUsersBlobStore(event), actor.email);
    if (record) {
      status = record.status;
      tier = record.role as Role;
    }
  } catch {
    // A store outage degrades the DETAIL, never the answer: `roles` above
    // already fell back to the env allowlists, and those are what the gates
    // will use for this same caller.
  }

  // An env-resolved caller (bootstrap owner, ROLE_EMAILS_*) has no record but
  // is unambiguously active — reporting `none` there would be a lie the gate
  // contradicts on the very next call.
  if (tier === 'none' && roles.length > 0) {
    tier = roles.includes('owner') ? 'owner' : roles[0];
    if (status === 'unknown') status = 'active';
  }

  return { id: actor.id, email: actor.email, role: tier, roles, status };
};

export const buildWhoami = async (deps: WhoamiDeps): Promise<WhoamiResult> => {
  const identity = getSiteIdentity();
  // No self-declared label is passed: `whoami` reports the DERIVED identity,
  // and a label would only add a field a caller can set about itself.
  const actor = actorFromMcpAuth(deps.auth, undefined);
  const member = await memberFromActor(actor, deps.event);

  const tools = buildPluginTools(deps.definitions);
  const liveDigest = toolSurfaceDigest(tools);

  let manifestVersion: string | null = null;
  let charter: string[] | null = null;
  let manifestDigest: string | null = null;
  try {
    const active = (await getPluginManifestDoc(await getPluginManifestBlobStore(deps.event))).active;
    if (active) {
      manifestVersion = active.manifest_version;
      charter = active.tools.map((tool) => tool.name);
      manifestDigest = active.sources.tool_surface_digest;
    }
  } catch {
    // The manifest store being unreachable must not take down the call whose
    // whole job is to diagnose a broken install.
  }

  const surface = typeof actor.surface === 'string' && actor.surface.length > 0 ? actor.surface : 'unknown';

  /**
   * TWO independent reasons to refuse a write, and the plugin is told both so
   * it can say which one it hit:
   *   - no standing (viewer, suspended, or an agent credential with no human);
   *   - an unknown surface, which means the ledger cannot attribute the write
   *     and the charter cannot be the one this install was granted.
   */
  const hasStanding = Boolean(member && member.roles.some((role) => WRITE_ROLES.has(role)));
  const canWrite = hasStanding && surface !== 'unknown';
  const refuseReason = canWrite
    ? undefined
    : !member
      ? 'This call is not bound to a member of this tenant — add the connector again and approve it while signed in as the invited member.'
      : !hasStanding
        ? `${member.email} holds "${member.role}" here, which cannot create or change content. Ask the owner for editor or publisher.`
        : 'This tenant cannot tell which chat app this call came from, so a write could not be attributed. Re-add the connector from its own install card.';

  let publishPolicy: WhoamiResult['publish_policy'] = { master: 'unknown', require_approval: [] };
  try {
    const policy = activeApprovalPolicy();
    publishPolicy = {
      master: policy.master,
      require_approval: Object.entries(policy.overrides)
        .filter(([, value]) => value === 'require-approval')
        .map(([type]) => type)
        .sort(),
    };
  } catch {
    // Same stance as build-manifest's committedApprovalPosture: an
    // unresolvable posture is reported as unknown, never thrown.
  }

  let surfaceBlocked = false;
  try {
    const surfaces = deps.surfacePolicy ? await deps.surfacePolicy() : undefined;
    if (surfaces) {
      publishPolicy = { ...publishPolicy, surfaces };
      surfaceBlocked = surfaces[surface] === 'block';
    }
  } catch {
    // A governance-store fault is not a block. Reporting one would send an
    // installer chasing a decision nobody made.
  }

  return {
    ok: true,
    server: identity.mcpDiagnosticName,
    tenant: identity.siteSlug,
    site_id: identity.siteId,
    member,
    surface,
    attribution: typeof actor.attribution === 'string' ? actor.attribution : 'unknown',
    can_write: canWrite,
    ...(refuseReason ? { refuse_reason: refuseReason } : {}),
    manifest_version: manifestVersion,
    charter,
    tools_digest: liveDigest,
    manifest_tools_digest: manifestDigest,
    // No promoted manifest is not a MISMATCH — there is nothing installed to
    // be stale against, and reporting `false` there would send an installer
    // to re-add a connector that was never the problem.
    tools_digest_matches: manifestDigest === null ? true : manifestDigest === liveDigest,
    aggression_ceiling: identity.aggressionCeiling ?? null,
    publish_policy: publishPolicy,
    surface_blocked: surfaceBlocked,
  };
};
