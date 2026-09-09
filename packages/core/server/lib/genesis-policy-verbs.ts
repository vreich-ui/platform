/**
 * Genesis-policy verbs (Wolf, 2026-09-09) — the ONE core behind
 * `genesis_policy_get` / `genesis_policy_set`, shaped on
 * `membership/verbs.ts` because it guards the same class of thing: a rule
 * every later decision is checked against.
 *
 * ── The gate, in order ──────────────────────────────────────────────────────
 *   1. HUMAN principal or 403 `genesis_policy_requires_human`, before any
 *      store read. An agent that could lower the bar on its own mints makes
 *      the lever decorative; an agent that could raise it could deny the fleet
 *      service. Neither is an agent's call.
 *   2. Admin tier to read, Owner tier to write — re-resolved from the users
 *      store on every call, exactly as the membership core does, so a
 *      suspended human is refused even mid-session.
 *
 * ── Where the override is stored, and the honest limit of what it does ──────
 *
 * In the EXISTING governance document (`overrides.v1`, the `governance` blob
 * store), as a `genesis` field beside `approval` and `creation`. No new
 * storage layer: that document is already the fleet's runtime-override home,
 * it is already Owner-gated, and it already keeps the history entries an
 * audit wants.
 *
 * The limit, stated plainly because a lever that half-works and says
 * otherwise is worse than no lever: that document is PER-TENANT, while the
 * genesis policy is FLEET-wide (see the header of
 * `packages/core/lib/genesis-policy.ts` for why it has to be). So an override
 * written here governs the surfaces that read THIS tenant's governance
 * document; it does not reach `packages/core/cli/create-site.mjs`, which
 * enforces the committed `FLEET_GENESIS_POLICY` because it mints a tenant
 * that has no blob store yet and cannot be taught to read some other tenant's
 * without putting a site literal in core (`core-no-site-literals.test.mjs`).
 *
 * A fleet-wide flip is therefore an edit to the committed default plus a
 * deploy — the same lever `creation-policy.ts` gives Wolf for reserved types.
 * `genesis_policy_set` is the fast, tenant-local half of that, and both the
 * tool description and this module say so rather than implying more.
 */
import type { Principal } from '../../schema/object-record-v1.js';
import {
  GENESIS_ARTIFACTS,
  GENESIS_ARTIFACT_INPUT_FIELDS,
  activeGenesisPolicy,
  genesisArtifactRefusal,
  genesisPolicyConfigSchema,
  type GenesisPolicy,
} from '../../lib/genesis-policy.js';
import { isOwner, resolveRolesForPrincipalAsync, type RoleEnv } from './roles.js';
import { getUserRecord, normalizeUserEmail, type UsersBlobStore } from './users-store.js';
import {
  getGovernanceDoc,
  putGovernanceDoc,
  type GovernanceBlobStore,
  type GovernanceDoc,
} from './governance-store.js';

/** The same principal shape the membership core gates on (`caller-principal.ts` mints it). */
export interface GenesisPolicyPrincipal {
  kind: 'human' | 'agent';
  id?: string;
  email?: string;
  agent_name?: string;
}

export interface GenesisPolicyVerbDeps {
  governance: GovernanceBlobStore;
  users: UsersBlobStore;
  env?: RoleEnv;
  now?: () => string;
}

export interface GenesisPolicyVerbResult {
  status: number;
  body: Record<string, unknown>;
}

const err = (status: number, error: string, error_code: string, extra: Record<string, unknown> = {}) => ({
  status,
  body: { error, error_code, ...extra },
});

/**
 * The read projection. Deliberately verbose: an operator deciding whether to
 * require an artifact needs the committed layer, the override layer, what is
 * actually in force, and — the part a bare policy object never carries — the
 * VOCABULARY the refusal will speak back at them. Shipping the artifact →
 * input-field map with the policy is what stops somebody requiring
 * `editorial_strategy` and then hunting for a `--editorial_strategy` flag.
 */
const describePolicy = (committed: GenesisPolicy, override: GenesisPolicy | undefined) => ({
  committed,
  override: override ?? null,
  effective: override ?? committed,
  provenance: override ? ('override' as const) : ('committed' as const),
  artifacts: [...GENESIS_ARTIFACTS],
  input_fields: { ...GENESIS_ARTIFACT_INPUT_FIELDS },
  // The refusal CONTRACT, not a live refusal. Named so nobody reads the
  // worked example's `missing` as a statement about this tenant: an operator
  // deciding whether to require an artifact needs to see what the refusal
  // will look like before they cause one.
  refusal_contract: {
    status: 422,
    error_code: 'genesis_artifact_required',
    raised_by: 'the mint (create-site buildPlan) and CMS-Agent site.duplicate, before anything is written or provisioned',
    example: genesisArtifactRefusal(['editorialStrategy']),
  },
  scope:
    'FLEET-wide policy, per-tenant override. The committed default in packages/core/lib/genesis-policy.ts is what the repo-side mint (create-site.mjs) enforces; this override governs the surfaces that read this tenant governance document. A fleet-wide change is an edit to the committed default plus a deploy.',
});

export interface GenesisPolicyVerbInput {
  verb: 'get' | 'set';
  args: Record<string, unknown>;
  principal: GenesisPolicyPrincipal;
  deps: GenesisPolicyVerbDeps;
}

export const handleGenesisPolicyVerb = async (input: GenesisPolicyVerbInput): Promise<GenesisPolicyVerbResult> => {
  // ── THE GATE: no agent principal, ever, before anything else. ──
  if (input.principal.kind !== 'human') {
    return err(
      403,
      'Genesis-policy verbs require a verified human principal.',
      'genesis_policy_requires_human'
    );
  }
  const actorEmail = normalizeUserEmail(input.principal.email ?? '');
  if (!actorEmail) return err(403, 'A verified email is required.', 'genesis_policy_requires_human');

  const now = input.deps.now ?? (() => new Date().toISOString());
  const env = input.deps.env ?? (process.env as RoleEnv);
  const corePrincipal: Principal = { kind: 'human', id: input.principal.id ?? '', email: actorEmail };
  const roles = await resolveRolesForPrincipalAsync(corePrincipal, {
    env,
    getUserRecord: (email) => getUserRecord(input.deps.users, email),
  });
  if (!roles.includes('admin')) return err(403, 'Admin access required', 'admin_required');

  const doc = await getGovernanceDoc(input.deps.governance);

  if (input.verb === 'get') {
    return { status: 200, body: describePolicy(activeGenesisPolicy(), doc?.genesis) };
  }

  if (!isOwner(roles)) return err(403, 'Owner access required', 'owner_required');

  // The SAME schema the committed config is validated with — an override can
  // never be a shape the committed layer would reject, which is the invariant
  // governance-store.ts already keeps for `approval` and `creation` ("an
  // invalid override can never widen authority").
  const parsed = genesisPolicyConfigSchema.safeParse({ requiredArtifacts: input.args.requiredArtifacts });
  if (!parsed.success) {
    return err(400, 'Invalid genesis policy.', 'invalid_args', {
      issues: parsed.error.issues,
      artifacts: [...GENESIS_ARTIFACTS],
    });
  }

  const at = now();
  const existing: GovernanceDoc = doc ?? {
    schema_version: 'overrides.v1',
    updated_by: actorEmail,
    updated_at: at,
    history: [],
  };
  const next: GovernanceDoc = {
    ...existing,
    genesis: parsed.data,
    updated_by: actorEmail,
    updated_at: at,
    history: [
      ...existing.history,
      {
        at,
        actor_email: actorEmail,
        action: 'set',
        detail: `genesis.requiredArtifacts=[${parsed.data.requiredArtifacts.join(', ')}]`,
      },
    ],
  };
  await putGovernanceDoc(input.deps.governance, next);
  return { status: 200, body: describePolicy(activeGenesisPolicy(), next.genesis) };
};
