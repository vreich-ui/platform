/**
 * The publishing-plugin charter, enforced on `/mcp` (Wolf, D4, 2026-09-11).
 *
 * WHAT CHANGED. Until this module, the charter bit only on `/api/plugin/*`
 * (`plugin-actions.ts:158`); on `/mcp` the identical list was ADVISORY, and
 * `build-tools.ts` said so in its header. A Custom GPT therefore obeyed the
 * charter and the same tenant's Claude connector — the same install, the same
 * promoted manifest — did not, because it spoke the protocol directly. D4
 * closes that: a plugin principal is refused the same tools on both doors.
 *
 * WHO IS A PLUGIN PRINCIPAL. There is no `isPlugin` flag on the actor. The
 * distinguishing fact is `surface`, and the only things that can set it are
 * the Actions façade (in-process `event.pluginSurface`) and the OAuth grant's
 * own redirect-host derivation — never a tool argument, never a client header
 * (`caller-actor.ts:53-90`). Every plugin surface is spelled `plugin:<app>`
 * (`plugin:claude`, `plugin:openai-gpt`, `plugin:openai-agent`), so the test
 * is the prefix. A HUMAN on `plugin:claude` is a plugin principal: the charter
 * is a statement about the install, not about the person driving it.
 *
 * WHY NO ACTIVE MANIFEST MEANS NO TOOL-NAME REFUSAL. On the façade, a tenant
 * with no promoted manifest 409s every call — correct there, because the
 * manifest IS that route's reason to exist. On `/mcp` the same rule would take
 * four of five fleet tenants offline the day it deployed: `whoami` against
 * `platform` on 2026-09-11 answers `manifest_version: null, charter: null`,
 * and a live `plugin:claude` connector writes there today. A charter that
 * cannot be read is not a charter of zero tools — it is an unanswerable
 * question, and the safe answer to an unanswerable question is the behaviour
 * that existed before this module. The same reasoning covers a manifest-store
 * fault: a transient blob outage must not cut every plugin off the tenant.
 * Both cases are logged (`mcp_charter_unenforced`) rather than silently
 * skipped, so "enforcement was not possible" is never mistaken for
 * "enforcement passed".
 *
 * WHAT IS ENFORCED REGARDLESS. The object-type rule below is NOT derived from
 * the manifest — it is a fixed list of four site-design types — so it binds
 * every plugin principal on every tenant whether or not a manifest is
 * promoted. That is deliberate: `object_create` is IN drlurie's promoted
 * charter (it must be — the plugin writes articles), and without this rule a
 * plugin that may create a `content_item` may equally mint a `theme` or
 * overwrite the `site` object.
 */
import { PLUGIN_ALWAYS_IN_CHARTER } from './build-tools.js';

/** Every plugin surface is `plugin:<app>`; nothing else may be one. */
export const PLUGIN_SURFACE_PREFIX = 'plugin:';

export const isPluginSurface = (surface: unknown): surface is string =>
  typeof surface === 'string' && surface.startsWith(PLUGIN_SURFACE_PREFIX);

/**
 * Object types a publishing plugin may never mint.
 *
 * `template` / `section_template` / `theme` are site-design recipes: they
 * govern how every future page and article looks, and authoring one is the
 * decision the charter's `PLUGIN_TOOL_DENYLIST` already keeps out by tool name
 * (`site_apply_theme`, `create_pdf_template`, …). `site` is the tenant's own
 * root object — navigation, chrome, brand tokens, blog configuration.
 *
 * Deliberately NOT here: `page`, `section`, `content_item`, `navigation`,
 * `taxonomy`, `product`. Those are publishing work, which is what the plugin
 * is for.
 */
export const PLUGIN_FORBIDDEN_CREATE_TYPES: ReadonlySet<string> = new Set([
  'template',
  'section_template',
  'theme',
  'site',
]);

export type CharterErrorCode = 'tool_not_in_plugin_charter' | 'object_type_not_in_plugin_charter';

export type CharterRefusal = {
  message: string;
  payload: Record<string, unknown>;
};

export type CharterGateInput = {
  /** `actor.surface` as the dispatcher resolved it; anything not `plugin:*` is waved through. */
  surface: unknown;
  toolName: string;
  /** The tool call's arguments, for the object-type rule. */
  args: Record<string, unknown>;
  /**
   * Tool names the promoted manifest lists, or `null` for "no active manifest
   * / manifest store unreadable" — see the header: `null` disables the
   * tool-name rule and nothing else.
   */
  charter: readonly string[] | null;
  manifestVersion: string | null;
};

/**
 * `object_validate` mode (2) — "validate a CANDIDATE body as if it were about
 * to be created" — is `object_type` + `body` with NO `object_id`
 * (`mcp-tool-definitions-2.ts:346-376`). Mode (1) validates an object that
 * already exists and is a plain read: a plugin may inspect a theme it did not
 * create, it just may not dry-run minting one.
 */
const isCreateModeValidate = (args: Record<string, unknown>): boolean => typeof args.object_id !== 'string';

/** The refusal, or `undefined` when this call is in charter (or not a plugin's). */
export const charterRefusal = (input: CharterGateInput): CharterRefusal | undefined => {
  if (!isPluginSurface(input.surface)) return undefined;

  if (input.charter && !input.charter.includes(input.toolName) && !PLUGIN_ALWAYS_IN_CHARTER.has(input.toolName)) {
    return {
      message: `"${input.toolName}" is not in this plugin's charter.`,
      payload: {
        error_code: 'tool_not_in_plugin_charter' satisfies CharterErrorCode,
        status: 403,
        surface: input.surface,
        ...(input.manifestVersion ? { manifest_version: input.manifestVersion } : {}),
      },
    };
  }

  const objectType = typeof input.args.object_type === 'string' ? input.args.object_type : undefined;
  const mintsObject =
    input.toolName === 'object_create' ||
    (input.toolName === 'object_validate' && isCreateModeValidate(input.args));
  if (objectType && mintsObject && PLUGIN_FORBIDDEN_CREATE_TYPES.has(objectType)) {
    return {
      message:
        `A publishing plugin may not create "${objectType}" objects. ` +
        `${[...PLUGIN_FORBIDDEN_CREATE_TYPES].sort().join(', ')} are site-design objects that govern every future ` +
        `page and article — they are authored in the tenant admin, not in a drafting session. ` +
        `Pages, sections, articles, navigation, taxonomy and products are unaffected.`,
      payload: {
        error_code: 'object_type_not_in_plugin_charter' satisfies CharterErrorCode,
        status: 403,
        surface: input.surface,
        object_type: objectType,
        forbidden_object_types: [...PLUGIN_FORBIDDEN_CREATE_TYPES].sort(),
        ...(input.manifestVersion ? { manifest_version: input.manifestVersion } : {}),
      },
    };
  }

  return undefined;
};
