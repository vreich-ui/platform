/**
 * Plugin manifest — the canonical, per-tenant bundle a chat-app publishing
 * plugin is rendered from (W1.1, publishing-plugin plan 2026-08-30).
 *
 * WHY THIS IS NOT A GOVERNED OBJECT TYPE (deviation from plan D1, recorded
 * deliberately). D1 proposed a 13th `objectTypes` entry "versioned like
 * skills". A governed object carries locks, review, a publish gate and — the
 * decisive part — GIT EXPORT MATERIALIZATION: every render would commit a file
 * under `sites/<slug>/data/site/` and enter the release batch. But a manifest
 * is DERIVED, never authored: it is a pure function of `editorial_voice`, the
 * site identity's aggression ceiling, the live tool surface and the publish
 * policy. Nothing about it wants a lock or a human approval, and the plan's own
 * W4.2 ("mark the manifest stale when its inputs change, admin shows
 * Re-export") is a cache contract, not an editorial one.
 *
 * So it lives where the other DERIVED per-site documents live: its own blob
 * store, one doc per site, with the draft/active pair and the history trail
 * that governance-store.ts established. Reversible: promoting it to a governed
 * type later is additive and nothing here blocks it.
 */
import { z } from 'zod';

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 'plugin_manifest.v1';

/** Platforms the canonical bundle renders to. `gemini` is write-only (plan D6). */
export const pluginPlatforms = ['claude', 'openai', 'gemini'] as const;
export type PluginPlatform = (typeof pluginPlatforms)[number];

/**
 * The ACTOR id a running plugin declares — `agent_name` on the verbs that take
 * it, and `producer.node_id` on publish. Finer-grained than the platform,
 * because OpenAI ships in two shapes that are operationally different and must
 * be distinguishable in the ledger (Wolf, 2026-09-01):
 *
 *   plugin:openai-gpt     a Custom GPT reaching the tenant through the W3
 *                         Actions façade — charter-enforced, installs on the
 *                         installer's own plan, @-mentionable beside other GPTs
 *   plugin:openai-agent   an Agent Studio agent with the tenant `/mcp`
 *                         attached directly as an App — advisory charter only,
 *                         invite-only, better for long multi-step runs
 *
 * A publish that cannot say which of those wrote it cannot answer "why does
 * this article read differently", which is the whole point of attribution.
 */
export const pluginActors = ['plugin:claude', 'plugin:openai-gpt', 'plugin:openai-agent'] as const;
export type PluginActorId = (typeof pluginActors)[number];

/** The actor a platform's primary shape declares. */
export const primaryActorFor = (platform: PluginPlatform): PluginActorId | null =>
  platform === 'claude' ? 'plugin:claude' : platform === 'openai' ? 'plugin:openai-gpt' : null;

/**
 * The inverse — which platform rendered a bundle that declares this actor.
 *
 * Needed to re-render a bundle's skill for comparison (see `skillFingerprint`):
 * the skill text differs by platform, so comparing a Claude bundle against an
 * OpenAI render would report a permanent, false staleness — and sending an
 * operator to re-promote a healthy bundle is the exact failure this check
 * exists to prevent.
 *
 * A bundle with no `actor_id` predates that field; callers must skip the
 * comparison rather than guess, which is why this takes a defined actor only.
 */
export const platformForActor = (actor: PluginActorId): PluginPlatform =>
  actor === 'plugin:claude' ? 'claude' : 'openai';

/**
 * The chat risk class a tool carries in its own definition
 * (`ToolGovernance.toolClass`). W1.3 derives the plugin's allowlist from this
 * rather than hand-maintaining one — see build-tools.ts.
 */
export const toolClassSchema = z.enum(['read', 'draft', 'creation', 'publication', 'privileged', 'membership']);

export const manifestToolSchema = z
  .object({
    name: z.string().min(1),
    tool_class: toolClassSchema,
    /** True when the tool mutates: drives `x-openai-isConsequential` in the W3 export. */
    consequential: z.boolean(),
    /** Present when the tool's own definition floors it at "ask" — never promote. */
    autonomy_floor: z.literal('ask').optional(),
    summary: z.string(),
  })
  .strict();
export type ManifestTool = z.infer<typeof manifestToolSchema>;

export const manifestConnectionSchema = z
  .object({
    tenant: z.string().min(1),
    site_id: z.string().min(1),
    origin: z.string().min(1),
    mcp_url: z.string().min(1),
    /** Unauthenticated operator probe: accepted audiences + token-store reachability. */
    mcp_auth_health_url: z.string().min(1),
    oauth: z
      .object({
        authorization_url: z.string().min(1),
        token_url: z.string().min(1),
        registration_url: z.string().min(1),
        revocation_url: z.string().min(1),
        authorization_server_metadata_url: z.string().min(1),
        protected_resource_metadata_url: z.string().min(1),
      })
      .strict(),
    /** The W3.1 façade. Absent until that wave ships. */
    openapi_url: z.string().min(1).optional(),
  })
  .strict();
export type ManifestConnection = z.infer<typeof manifestConnectionSchema>;

/**
 * What the render was derived FROM. `stale` is computed by comparing these
 * against the live values — that is the whole of W4.2's staleness contract and
 * the plan's answer to the "skill drift" risk.
 */
export const manifestSourcesSchema = z
  .object({
    voice_object_id: z.string().nullable(),
    voice_record_version: z.number().nullable(),
    aggression_ceiling: z.record(z.string(), z.number()),
    approval_posture: z.string(),
    tool_surface_digest: z.string(),
    /**
     * W7.7 — a fingerprint of the RENDERED SKILL TEXT itself.
     *
     * The four fields above track the bundle's *inputs*, and between them they
     * missed two ways the skill can go stale while the page still reads
     * "Current":
     *
     *   1. The RENDERER changes. `render-skill.ts` is code; editing its prose
     *      moves no input at all. This shipped for real — a direct-to-main
     *      commit rewrote the drafting instructions and every promoted bundle
     *      kept serving the old text, reported as current.
     *   2. The AGGRESSION CEILING changes. It is recorded in
     *      `aggression_ceiling` above and was never compared, so a site-identity
     *      edit rewrote the skill's hard bounds with nothing noticing.
     *
     * Hashing the output catches both, and anything else the skill embeds,
     * without a per-input check for each. Optional because bundles promoted
     * before this field existed are live in the stores: an absent digest means
     * "predates the check", and the comparison is skipped rather than guessed.
     */
    skill_digest: z.string().optional(),
  })
  .strict();
export type ManifestSources = z.infer<typeof manifestSourcesSchema>;

export const manifestBundleSchema = z
  .object({
    manifest_version: z.string().min(1),
    rendered_at: z.string().min(1),
    /** The rendered SKILL.md — voice, method, publish procedure. */
    skill_md: z.string().min(1),
    tools: z.array(manifestToolSchema),
    connection: manifestConnectionSchema,
    sources: manifestSourcesSchema,
    /**
     * The actor `skill_md` declares — the platform's primary shape.
     *
     * The bundle used to record only its rendered text, and the OpenAI export
     * ASSUMED that text said `plugin:openai-gpt`. It does not when the active
     * bundle was rendered for Claude, which is what the page's Render button
     * produces by default, so the ChatGPT download failed on every tenant that
     * had promoted a Claude bundle — which is all of them.
     *
     * Optional because bundles promoted before this field existed are still
     * in the stores; `sourceActorFor` falls back to reading the skill text.
     */
    actor_id: z.enum(pluginActors).optional(),
    /** Non-fatal render notes an operator should see (e.g. no live voice object). */
    warnings: z.array(z.string()).default([]),
  })
  .strict();
export type ManifestBundle = z.infer<typeof manifestBundleSchema>;

export const manifestHistoryEntrySchema = z
  .object({
    at: z.string(),
    actor_email: z.string(),
    action: z.string(),
    manifest_version: z.string().optional(),
    detail: z.string().optional(),
  })
  .strict();

export const pluginManifestDocSchema = z
  .object({
    schema_version: z.literal(PLUGIN_MANIFEST_SCHEMA_VERSION),
    /** The last render. Promotion makes it `active`; nothing else reads it. */
    draft: manifestBundleSchema.optional(),
    /** What an export downloads. Absent until the first promote. */
    active: manifestBundleSchema.optional(),
    updated_by: z.string(),
    updated_at: z.string(),
    history: z.array(manifestHistoryEntrySchema),
  })
  .strict();
export type PluginManifestDoc = z.infer<typeof pluginManifestDocSchema>;

export const emptyPluginManifestDoc = (): PluginManifestDoc => ({
  schema_version: PLUGIN_MANIFEST_SCHEMA_VERSION,
  updated_by: 'system',
  updated_at: new Date(0).toISOString(),
  history: [],
});
