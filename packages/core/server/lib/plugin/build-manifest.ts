/**
 * Manifest builder (W1.1 + W1.4) — assembles the canonical bundle from live
 * state. Tenant-generic: everything it needs comes from the site identity, the
 * site's object store and the tool definitions, so a freshly minted tenant
 * renders without per-tenant code (plan §0).
 *
 * Deliberately standalone and idempotent rather than a genesis node: W0.2 found
 * no genesis/editorial-genesis workflow to hang it off, and only
 * `editorial_voice` of the objects the plan assumed actually exists. This
 * builder can be called from the admin surface today and becomes one more
 * caller when `genesis_conductor` lands (see docs/plugin/recon-genesis.md §4).
 */
import { getSiteIdentity } from '../../../lib/site-identity.js';
import { activeApprovalPolicy } from '../../../lib/approval-policy.js';
import { buildPluginTools, toolSurfaceDigest } from './build-tools.js';
import { renderSkillMarkdown, type VoiceForSkill } from './render-skill.js';
import { primaryActorFor } from './manifest-types.js';
import type { ManifestBundle, ManifestConnection, PluginPlatform } from './manifest-types.js';
import type { ToolDefinition } from '../../functions/mcp.js';

export type VoiceRecord = { object_id: string; record_version: number | null; body: VoiceForSkill } | null;

export type BuildManifestInput = {
  /**
   * Public origin of this tenant, no trailing slash (e.g.
   * `https://drluriescience.netlify.app`). NOT on the site identity — the
   * deploy learns its own host from the request — so the caller passes it.
   */
  origin: string;
  /** Tool surface as the tenant exposes it — pass `visibleToolDefinitions()`. */
  definitions: readonly ToolDefinition[];
  /** The live editorial_voice record, or null when none is readable. */
  voice: VoiceRecord;
  platform: PluginPlatform;
  /** Injected so renders are reproducible in tests. */
  now?: () => Date;
  /**
   * Pre-resolved approval posture. The admin endpoint resolves it from the
   * governance store and passes it; tests pass a literal. Omitted → the
   * committed posture file is used, which is also the documented fallback.
   */
  approval?: { master: string; overrides?: Record<string, string> };
};

export const buildConnection = (origin: string, tenant: string, siteId: string): ManifestConnection => ({
  tenant,
  site_id: siteId,
  origin,
  mcp_url: `${origin}/mcp`,
  // W0.1: audience pinning is the top connector failure mode and is invisible
  // client-side. This unauthenticated probe answers "which audiences does this
  // deploy accept?" and "can it read its own token store?" — put it on the
  // connector-setup card, not in a runbook nobody opens.
  mcp_auth_health_url: `${origin}/mcp?health=auth`,
  oauth: {
    authorization_url: `${origin}/oauth/authorize`,
    token_url: `${origin}/oauth/token`,
    registration_url: `${origin}/oauth/register`,
    revocation_url: `${origin}/oauth/revoke`,
    authorization_server_metadata_url: `${origin}/.well-known/oauth-authorization-server`,
    protected_resource_metadata_url: `${origin}/.well-known/oauth-protected-resource`,
  },
});

/** `<tenant>-<platform>-<yyyymmdd>-<toolDigest>` — stable for identical inputs. */
export const manifestVersionFor = (tenant: string, platform: string, at: Date, digest: string): string => {
  const day = at.toISOString().slice(0, 10).replace(/-/g, '');
  return `${tenant}-${platform}-${day}-${digest.split('_')[1] ?? '00000000'}`;
};

export const buildManifestBundle = (input: BuildManifestInput): ManifestBundle => {
  const identity = getSiteIdentity();
  const now = (input.now ?? (() => new Date()))();
  const warnings: string[] = [];

  const tools = buildPluginTools(input.definitions);
  const digest = toolSurfaceDigest(tools);
  const manifestVersion = manifestVersionFor(identity.siteSlug, input.platform, now, digest);

  if (!identity.aggressionCeiling) {
    warnings.push(
      'This site declares no aggressionCeiling in its committed site-identity config. The skill says so loudly and tells the plugin to stay at the calmest reading — but the config should be fixed.'
    );
  }

  if (!input.voice) {
    warnings.push(
      'No live editorial_voice object was readable — the skill was rendered with placeholders and instructs the plugin to read the live object at session start.'
    );
  }

  const approval = input.approval ?? committedApprovalPosture(warnings);
  const overrides = approval.overrides ?? {};

  const skillMd = renderSkillMarkdown({
    tenant: identity.siteSlug,
    siteId: identity.siteId,
    origin: input.origin,
    platform: input.platform,
    // The canonical copy declares the platform's PRIMARY actor. The OpenAI
    // agent shape re-points it at export time (export-openai.ts) — see
    // `retargetActor` for why that substitution is safe and asserted.
    actorId: primaryActorFor(input.platform),
    voice: input.voice?.body ?? null,
    aggressionCeiling: identity.aggressionCeiling,
    approvalPosture: approval.master,
    approvalOverrides: overrides,
    tools,
    manifestVersion,
  });

  return {
    manifest_version: manifestVersion,
    rendered_at: now.toISOString(),
    skill_md: skillMd,
    // Recorded so an export never has to GUESS which actor the text declares.
    ...(primaryActorFor(input.platform) ? { actor_id: primaryActorFor(input.platform)! } : {}),
    tools,
    connection: buildConnection(input.origin, identity.siteSlug, identity.siteId),
    sources: {
      voice_object_id: input.voice?.object_id ?? null,
      voice_record_version: input.voice?.record_version ?? null,
      aggression_ceiling: { ...(identity.aggressionCeiling ?? {}) },
      approval_posture: approval.master,
      tool_surface_digest: digest,
    },
    warnings,
  };
};

/**
 * The committed posture file is the labeled default AND the disaster fallback
 * (governance-store.ts), so a governance-store outage degrades the manifest to
 * a warning rather than failing the render.
 */
const committedApprovalPosture = (warnings: string[]): { master: string; overrides?: Record<string, string> } => {
  try {
    const approval = activeApprovalPolicy() as unknown as { master: string; overrides?: Record<string, string> };
    return { master: approval.master, overrides: approval.overrides };
  } catch {
    warnings.push('Approval posture could not be resolved; the skill omits the gated-type list.');
    return { master: 'unknown' };
  }
};

/**
 * W4.2 staleness: an installed export is stale when the state it was rendered
 * from has moved. Compares the recorded sources against live values.
 */
export const manifestStaleReasons = (
  bundle: ManifestBundle,
  live: { voiceRecordVersion: number | null; toolSurfaceDigest: string; approvalPosture: string }
): string[] => {
  const reasons: string[] = [];
  if (bundle.sources.voice_record_version !== live.voiceRecordVersion) {
    reasons.push(
      `The editorial voice moved (rendered against record_version ${String(bundle.sources.voice_record_version)}, live is ${String(live.voiceRecordVersion)}).`
    );
  }
  if (bundle.sources.tool_surface_digest !== live.toolSurfaceDigest) {
    reasons.push('The tenant tool surface changed since this bundle was rendered.');
  }
  if (bundle.sources.approval_posture !== live.approvalPosture) {
    reasons.push(
      `The approval posture changed (rendered against "${bundle.sources.approval_posture}", live is "${live.approvalPosture}").`
    );
  }
  return reasons;
};
