/**
 * Genesis policy (Wolf, 2026-09-09) — the one question this module answers:
 * WHICH baseline artifacts must be supplied at mint, or the tenant is not
 * born at all?
 *
 * ── Why this is FLEET-wide, unlike approval/creation policy ─────────────────
 *
 * `approval-policy.ts` and `creation-policy.ts` are PER-TENANT: each site
 * commits its own `sites/<client>/config/*.ts` and registers it through
 * `policy-bindings.ts`, because "may this agent publish a page on THIS site"
 * is a question only that site's Owner can answer. This policy is the
 * opposite. It is asked exactly once per tenant — at mint, by
 * `packages/core/cli/create-site.mjs`, about a tenant that does not exist
 * yet, has no config bundle, no blob stores and no Owner. There is nobody
 * per-tenant to ask. It is a standard the FLEET holds itself to about what a
 * newborn tenant may lack, so it is fleet law and it lives here.
 *
 * ── Where the committed default lives, and why HERE ─────────────────────────
 *
 * The two candidate homes were considered and both were rejected on
 * semantics, not on convenience:
 *
 *   - `packages/core/server/lib/governance-store.ts` is a PER-TENANT Netlify
 *     Blobs document (`governance` store, `overrides.v1`). A fleet-wide value
 *     kept there is N copies that drift the moment one tenant is edited, and
 *     — decisively — the enforcement point cannot read it. `create-site.mjs`
 *     mints a tenant that has no blob store yet; naming some OTHER tenant's
 *     store as the fleet's would put a site literal in core, which
 *     `tests/scripts/core-no-site-literals.test.mjs` forbids outright.
 *   - The site config bundle (`sites/<client>/config/*.ts`) is committed, but
 *     per-tenant for the same reason and equally unreachable from a mint: the
 *     directory being scaffolded IS the thing the policy is deciding about.
 *
 * So the committed default lives in `packages/core/lib` — which is where the
 * fleet's own settings already live, and there is precedent for exactly this
 * shape: `DEFAULT_MEMBERSHIP_POLICY` in `membership-policy.ts` is the
 * fleet-wide committed default that per-site and per-store layers override.
 * No new storage layer is introduced by this module.
 *
 * ── Runtime override ────────────────────────────────────────────────────────
 *
 * `genesis_policy_set` records an override in the EXISTING governance
 * document (`genesis`, beside `approval` / `creation` — see
 * `server/lib/genesis-policy-verbs.ts`). Read the honest caveat there before
 * relying on it: the governance store is per-tenant, so an override governs
 * the surfaces that can read that tenant's store, while the repo-side CLI
 * mint enforces the COMMITTED layer below until a deploy carries the change.
 * A fleet-wide flip is Wolf editing `FLEET_GENESIS_POLICY` in this file — the
 * same "edit one committed file, no code change" lever `creation-policy.ts`
 * gives Wolf for reserved types.
 *
 * ── The default ships EMPTY ─────────────────────────────────────────────────
 *
 * `requiredArtifacts: []` — nothing is required, and a mint with no baselines
 * supplied behaves exactly as it did before this module existed: every
 * baseline is seeded carrying `provenance.set_by: 'genesis_default'` (the
 * unset marker, `schema/bodies/baseline-provenance-v1.ts`) and every consumer
 * warns rather than blocks. That is deliberate. Turning an artifact from
 * "warned about" into "the tenant does not get born" is a posture change with
 * real operational cost, and it is Wolf's to make, not this module's.
 *
 * Client-safe: no env, no server imports, no fs. Imported by the CLI's mirror
 * (see `GENESIS_ARTIFACTS` below) and by the MCP verb layer alike.
 */
import { z } from 'zod';

/**
 * The closed set of baseline artifacts a mint can be required to supply.
 *
 * CLOSED ON PURPOSE. An open string list would let a policy require an
 * artifact no mint path knows how to accept, producing a refusal with no way
 * out — the exact unsatisfiable blockage the 2026-09-09 refusal contract
 * below exists to prevent. Every member here is supplyable today through a
 * `create-site` flag.
 *
 * ⚠️ THIS VOCABULARY IS SHARED WITH A REPO THAT CANNOT IMPORT IT. CMS-Agent's
 * `site.duplicate` mirrors the same refusal before it provisions anything
 * (`src/agent/capture/siteGenesis.ts`, `genesisPolicy.ts`). The two repos have
 * no import path between them, so both sides pin this list and the field map
 * below with their own test. Adding a member here means adding it there in the
 * same wave, or the two surfaces refuse different things.
 */
export const GENESIS_ARTIFACTS = [
  'editorial_strategy',
  'editorial_voice',
  'visual_standard',
  'logo',
  'tracking_config',
] as const;

export type GenesisArtifact = (typeof GENESIS_ARTIFACTS)[number];

/**
 * Artifact (an OBJECT TYPE name) → the INPUT FIELD name a caller supplies it
 * under.
 *
 * The distinction is the whole point of this table and it is not cosmetic.
 * `missing: ['editorial_strategy']` tells an operator what the tenant lacks;
 * `missing: ['editorialStrategy']` tells them what to TYPE. A refusal that
 * names the wrong vocabulary sends the caller looking for a flag that does
 * not exist, which is how a catalogued refusal becomes an outage. The field
 * names are `create-site`'s own option keys (`--editorial-strategy` parses to
 * `opts.editorialStrategy`) and CMS-Agent's `newSite.*` keys, which are the
 * same names deliberately.
 */
export const GENESIS_ARTIFACT_INPUT_FIELDS: Readonly<Record<GenesisArtifact, string>> = Object.freeze({
  editorial_strategy: 'editorialStrategy',
  editorial_voice: 'editorialVoice',
  visual_standard: 'visualStandard',
  logo: 'logo',
  tracking_config: 'trackingConfig',
});

/** The CLI flag each artifact is supplied with — quoted verbatim in the refusal's "supply now" line. */
export const GENESIS_ARTIFACT_CLI_FLAGS: Readonly<Record<GenesisArtifact, string>> = Object.freeze({
  editorial_strategy: '--editorial-strategy',
  editorial_voice: '--editorial-voice',
  visual_standard: '--visual-standard',
  logo: '--logo',
  tracking_config: '--tracking-config',
});

const genesisArtifactSchema = z.enum(GENESIS_ARTIFACTS);

/**
 * The config shape. `strictObject` + a closed enum, so a typo'd artifact name
 * or a stray key FAILS THE PARSE rather than resolving to something
 * permissive — the creation-policy precedent, and the reason `resolve` throws
 * instead of falling back.
 */
export const genesisPolicyConfigSchema = z.strictObject({
  /**
   * Artifacts a mint must supply. Empty (the shipped fleet default) means
   * nothing is required. Duplicates are rejected: a policy that lists the
   * same artifact twice is a config somebody edited without reading, and
   * silently de-duplicating it hides that.
   */
  requiredArtifacts: z
    .array(genesisArtifactSchema)
    .refine((list) => new Set(list).size === list.length, { message: 'requiredArtifacts must not repeat an artifact' }),
});

export type GenesisPolicy = z.infer<typeof genesisPolicyConfigSchema>;

/**
 * THE COMMITTED FLEET DEFAULT. Wolf flips this; nothing else does.
 *
 * Ships `[]` — see the module header. Frozen so a consumer that mutates the
 * array it was handed cannot silently retune the fleet for the rest of the
 * process.
 */
export const FLEET_GENESIS_POLICY: GenesisPolicy = Object.freeze({
  requiredArtifacts: Object.freeze([]) as unknown as GenesisArtifact[],
});

/**
 * Validate a config value into a usable policy. THROWS (with the zod detail)
 * on anything malformed — a broken genesis policy must fail loudly, never
 * quietly resolve to the permissive default. This is the creation-policy
 * discipline verbatim, and it matters more here than there: the permissive
 * default is `[]`, so a silent fallback would turn "Wolf required a strategy"
 * into "nothing is required" without a single line of output.
 */
export const resolveGenesisPolicy = (config: unknown): GenesisPolicy => {
  const parsed = genesisPolicyConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid genesis-policy config (packages/core/lib/genesis-policy.ts): ${parsed.error.message}`);
  }
  return parsed.data;
};

/**
 * THE PURE RESOLVER. Which required artifacts did this mint not supply?
 *
 * `supplied` is keyed by INPUT FIELD name (`{ editorialStrategy: {...} }`) —
 * the caller's own vocabulary, so a mint path can hand its parsed options
 * straight in. A key present but `undefined` counts as NOT supplied, which is
 * what a CLI's option bag looks like for a flag nobody passed.
 *
 * Returns input-field names, in policy order, never object-type names.
 */
export const missingGenesisArtifacts = (
  policy: GenesisPolicy,
  supplied: Readonly<Record<string, unknown>>
): string[] =>
  policy.requiredArtifacts
    .filter((artifact) => supplied[GENESIS_ARTIFACT_INPUT_FIELDS[artifact]] === undefined)
    .map((artifact) => GENESIS_ARTIFACT_INPUT_FIELDS[artifact]);

/** The catalogued refusal payload. */
export interface GenesisArtifactRefusal {
  status: 422;
  error_code: 'genesis_artifact_required';
  error: string;
  /** INPUT FIELD names the caller would have to supply — never object types. */
  missing: string[];
  /** The two ways out, in the order an operator should consider them. */
  ways_out: [string, string];
}

/**
 * Build the 422 refusal.
 *
 * Per the 2026-09-07 blockage contract a blockage must be CLASSIFIED (a
 * stable `error_code` a caller can branch on, not prose) and ACTIONABLE (it
 * names every way out, so nobody has to guess which door is unlocked). There
 * are exactly two ways out of this one and both are stated every time:
 *
 *   1. SUPPLY NOW — pass the baseline at mint. The tenant is born with a real
 *      object marked `provenance.set_by: 'agent'` instead of the
 *      `genesis_default` placeholder.
 *   2. LOWER THE POLICY — take the artifact off `requiredArtifacts`. The
 *      tenant is born with the marked default and the fleet warns instead of
 *      blocking, which is the pre-2026-09-09 behaviour.
 *
 * Deliberately NOT a third option: "mint it now and fill it in later" is
 * option 2 wearing a disguise, and offering it as its own door is how a
 * required artifact quietly stops being required.
 */
export const genesisArtifactRefusal = (missing: readonly string[]): GenesisArtifactRefusal => {
  const fields = missing.join(', ');
  const flags = missing
    .map((field) => {
      const artifact = GENESIS_ARTIFACTS.find((name) => GENESIS_ARTIFACT_INPUT_FIELDS[name] === field);
      return artifact ? GENESIS_ARTIFACT_CLI_FLAGS[artifact] : `--${field}`;
    })
    .join(' ');
  return {
    status: 422,
    error_code: 'genesis_artifact_required',
    error:
      `Genesis policy requires ${missing.length === 1 ? 'a baseline' : 'baselines'} this mint did not supply: ${fields}. ` +
      'No files were written and no tenant was provisioned. Two ways out: ' +
      `SUPPLY NOW — pass ${fields} (CLI: ${flags}) as a partial body, inline JSON or @file, and the tenant is born with it marked provenance.set_by:"agent"; ` +
      'or LOWER THE POLICY — take it off genesisPolicy.requiredArtifacts and the tenant is born with the genesis_default placeholder the fleet warns about instead of blocking on.',
    missing: [...missing],
    ways_out: [
      `supply now: pass ${fields} (CLI: ${flags}) as a partial body — inline JSON or @path/to.json.`,
      'lower the policy: remove the artifact from genesisPolicy.requiredArtifacts (genesis_policy_set, or the committed FLEET_GENESIS_POLICY).',
    ],
  };
};

/**
 * Provider-injection seam, mirroring `setActiveApprovalPolicyProvider` /
 * `setActivePublishingPolicyProvider`. Fleet law must not reach for a config
 * file itself; a host (or a test) registers where the policy comes from.
 *
 * Unlike `activeApprovalPolicy`, an ABSENT provider is never an error — the
 * committed fleet default is a complete, meaningful policy on its own, and a
 * mint run from a bare checkout with nothing registered must behave exactly
 * as the fleet default says. A provider that returns something MALFORMED is a
 * different matter entirely and throws (see `resolveGenesisPolicy`): absence
 * is a configuration Wolf chose, malformation is a configuration nobody chose.
 */
let activeGenesisPolicyProvider: (() => unknown) | undefined;

export const setActiveGenesisPolicyProvider = (provider: () => unknown): void => {
  activeGenesisPolicyProvider = provider;
};

/** Test-only: clear a registered provider so one test's registration cannot leak into another's. */
export const clearActiveGenesisPolicyProviderForTests = (): void => {
  activeGenesisPolicyProvider = undefined;
};

/** The policy in force: the registered provider's config, else the committed fleet default. */
export const activeGenesisPolicy = (): GenesisPolicy =>
  activeGenesisPolicyProvider ? resolveGenesisPolicy(activeGenesisPolicyProvider()) : FLEET_GENESIS_POLICY;
