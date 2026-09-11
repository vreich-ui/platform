/**
 * tools.json builder (W1.3).
 *
 * The plan asked for "the intersection of tenant /mcp tools and an allowlist".
 * W0.3 found a better source: every tool definition ALREADY carries
 * `governance: { toolClass, autonomyFloor }` — the same six-class taxonomy the
 * admin chat registry keys its autonomy off. Deriving from it means the plugin
 * bundle cannot drift from the tool surface, and `x-openai-isConsequential` in
 * the W3.2 export is computed (`toolClass !== 'read'`) rather than hand-set.
 *
 * ENFORCEMENT (Wolf, D4, 2026-09-11 — supersedes the "ADVISORY" note this
 * header carried until W0). The promoted manifest's tool list is enforced on
 * BOTH doors:
 *   - `/api/plugin/*` — `plugin-actions.ts:158`, 403 `tool_not_in_plugin_charter`
 *     before auth resolution;
 *   - `/mcp` — `charter-gate.ts`, called from `mcp.ts:preflightToolCall`, same
 *     `error_code`, for any principal whose `surface` is `plugin:*`.
 * `/mcp` additionally refuses `object_create` / create-mode `object_validate`
 * for the four site-design object types (`PLUGIN_FORBIDDEN_CREATE_TYPES`) with
 * `object_type_not_in_plugin_charter` — a rule that is NOT derived from this
 * list, because `object_create` itself must stay in charter for the plugin to
 * write articles at all.
 *
 * Two honest limits remain, both documented in `charter-gate.ts`: a tenant
 * with no promoted manifest, and an unreadable manifest store, disable the
 * TOOL-NAME rule (they are logged as `mcp_charter_unenforced`, never treated
 * as a pass). `visibleToolDefinitions` still filters only on internal-only /
 * optional-handler / membership-OAuth, so `tools/list` may advertise a tool
 * the charter then refuses — a listed-but-refused tool is the intended shape,
 * because the list is the tenant's surface and the charter is this install's.
 */
import { isMembershipTool } from '../mcp-tool-definitions-membership.js';
import { isGenesisPolicyTool } from '../mcp-tool-definitions-genesis.js';
import type { ToolDefinition } from '../../functions/mcp.js';
import type { ManifestTool } from './manifest-types.js';

/**
 * Tool classes a publishing plugin may carry. `privileged` and `membership`
 * are excluded by construction: the plugin writes articles and their media, it
 * never touches members, themes, prices or blob stores.
 */
const PLUGIN_TOOL_CLASSES = new Set(['read', 'draft', 'creation', 'publication']);

/**
 * The one privileged tool a publishing plugin genuinely needs. `release_to_production`
 * is classed privileged because it spends a Netlify build — correctly so — but the
 * documented publish procedure ends with it, and the alternative (leaving every
 * article dark until someone opens the admin) makes the plugin useless. It stays
 * ask-floored by its own definition, and the skill instructs the plugin to ask the
 * human before calling it. Every other privileged tool stays out.
 */
const PLUGIN_PRIVILEGED_ALLOWLIST = new Set(['release_to_production']);

/**
 * Named exclusions inside the allowed classes. Each one is a decision, not an
 * oversight, so each carries its reason.
 */
export const PLUGIN_TOOL_DENYLIST: Record<string, string> = {
  // The plugin READS the voice and obeys it; it must never edit the object that
  // governs every future article. drlurie additionally pins editorial_voice to
  // require-approval, so an attempt would halt at the gate — but it should not
  // reach the gate at all.
  set_voice_fields: 'The plugin reads editorial_voice and never writes it.',
  // Commerce is out of the publishing charter.
  product_set_price: 'Commerce is outside the plugin charter.',
  commerce_orders: 'Commerce is outside the plugin charter.',
  order_reissue: 'Commerce is outside the plugin charter.',
  ownership_transfer: 'Commerce is outside the plugin charter.',
  // Theme/palette governance is theme-tool-only and site-wide.
  site_apply_theme: 'Site-wide palette governance is never a per-article decision.',
  // A build costs money and is a batch decision; trigger_netlify_build bypasses
  // the release receipt. The plugin uses release_to_production, which returns one.
  trigger_netlify_build: 'Use release_to_production — it returns a release receipt and is the documented batch step.',
  // The plugin uses templates that already exist (list_pdf_templates). Authoring
  // and publishing a template is a site-design decision, not a per-article one.
  publish_pdf_template: 'The plugin uses published templates; it never authors or publishes them.',
  create_pdf_template: 'The plugin uses published templates; it never authors or publishes them.',
  // A plugin must never approve its own work. object_review_decide is the human
  // side of the gate; object_submit_review (the agent side) stays available for
  // the day a posture flip makes it live.
  object_review_decide: "The approval decision is the human half of the gate — never the plugin's.",
  // Taking a live article down is an editorial decision made in the admin, with
  // the full object history in view.
  object_retire: 'Retiring a live article is an admin decision, not a drafting-session one.',
};

/**
 * Tools that are in charter on EVERY surface regardless of what the promoted
 * manifest happens to list (W7.2).
 *
 * `whoami` is the only member and the reason is circular in exactly the way
 * that matters: the situation it diagnoses — a manifest promoted before this
 * tool existed, or an export cached against an older tool surface — is
 * precisely the situation in which the charter would refuse it. A diagnostic
 * that is unavailable whenever it is needed is not a diagnostic. It is
 * read-only and reports only the caller's own grant plus public tenant policy,
 * so admitting it costs nothing (see lib/whoami.ts).
 *
 * Adding anything else here would be re-opening the charter, which is real
 * enforcement on the façade. Don't.
 */
export const PLUGIN_ALWAYS_IN_CHARTER: ReadonlySet<string> = new Set(['whoami']);

const firstSentence = (description: string): string => {
  const trimmed = description.trim();
  const cut = trimmed.search(/\.\s/);
  const sentence = cut === -1 ? trimmed : trimmed.slice(0, cut + 1);
  return sentence.length > 240 ? `${sentence.slice(0, 237)}...` : sentence;
};

export const buildPluginTools = (definitions: readonly ToolDefinition[]): ManifestTool[] =>
  definitions
    .filter((tool) => PLUGIN_TOOL_CLASSES.has(tool.governance.toolClass) || PLUGIN_PRIVILEGED_ALLOWLIST.has(tool.name))
    .filter((tool) => !(tool.name in PLUGIN_TOOL_DENYLIST))
    /**
     * W7.2: the membership family is out of the charter by NAME, not by class.
     * Six of its tools (`member_list`, `member_get`, `member_audit`,
     * `membership_contract`, `membership_policy_get`, `member_export`) are
     * `read` class and would pass the class filter above. They never had,
     * because the only caller passed `visibleToolDefinitions()` with no event
     * and membership tools are listed only to an OAuth principal — so the
     * exclusion was an accident of the caller, not a rule. Passing a
     * request-scoped surface here (as `whoami` does) would have quietly put
     * the tenant's member roster in a publishing plugin's charter.
     */
    .filter((tool) => !isMembershipTool(tool.name))
    /**
     * Wolf 2026-09-09: the genesis-policy family is out of the charter by NAME
     * for the identical reason. `genesis_policy_get` is `read` class and would
     * pass the class filter above, which would advertise the fleet's mint
     * policy — and, through the same family, the shape of the write that
     * changes it — on a publishing plugin's surface. Excluding it by class
     * would be an accident waiting to be undone the first time somebody
     * retyped its toolClass.
     */
    .filter((tool) => !isGenesisPolicyTool(tool.name))
    .map((tool) => ({
      name: tool.name,
      tool_class: tool.governance.toolClass as ManifestTool['tool_class'],
      consequential: tool.governance.toolClass !== 'read',
      ...(tool.governance.autonomyFloor ? { autonomy_floor: tool.governance.autonomyFloor } : {}),
      summary: firstSentence(tool.description),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

/**
 * FNV-1a over a canonical string. Deliberately not a cryptographic hash: this
 * detects DRIFT between two copies of a schema, and nothing here is a secret or
 * an integrity claim. Short, stable across runtimes, and cheap enough to
 * compute on every `tools/list`.
 */
export const fnv1a = (canonical: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * A stable fingerprint of the tool surface a bundle was rendered against.
 * Feeds `sources.tool_surface_digest`, which is how W4.2 notices that the
 * server grew or lost a tool and marks installed exports stale.
 */
export const toolSurfaceDigest = (tools: readonly ManifestTool[]): string =>
  `sha_${fnv1a(tools.map((t) => `${t.name}:${t.tool_class}`).join('|'))}_${tools.length}`;
