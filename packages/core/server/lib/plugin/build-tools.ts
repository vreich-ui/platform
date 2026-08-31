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
 * HONESTY ABOUT ENFORCEMENT: this list is ADVISORY. `visibleToolDefinitions`
 * filters on internal-only / optional-handler / membership-OAuth and nothing
 * else, so the server will still answer a tool the plugin was told not to call.
 * For a human-driven plugin that is the correct trade (the editor is the gate);
 * it must never be described as a permission boundary.
 */
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
    .map((tool) => ({
      name: tool.name,
      tool_class: tool.governance.toolClass as ManifestTool['tool_class'],
      consequential: tool.governance.toolClass !== 'read',
      ...(tool.governance.autonomyFloor ? { autonomy_floor: tool.governance.autonomyFloor } : {}),
      summary: firstSentence(tool.description),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

/**
 * A stable fingerprint of the tool surface a bundle was rendered against.
 * Feeds `sources.tool_surface_digest`, which is how W4.2 notices that the
 * server grew or lost a tool and marks installed exports stale.
 */
export const toolSurfaceDigest = (tools: readonly ManifestTool[]): string => {
  const canonical = tools.map((t) => `${t.name}:${t.tool_class}`).join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `sha_${hash.toString(16).padStart(8, '0')}_${tools.length}`;
};
