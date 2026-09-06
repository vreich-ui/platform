/**
 * TOOL_DEFINITIONS, analytics family (R12.3 / T21.20) — three READ-ONLY tools
 * over this tenant's own-tracker sink (TRACKING_SINK_URL/TRACKING_SINK_TOKEN,
 * proxied server-side only — see mcp-analytics-handlers.ts; the token never
 * reaches a tool caller) plus this tenant's own object store (publish
 * receipts, body.lineage) for producer/prompt-version/variant facts the sink
 * does not carry.
 *
 * Why this exists: the producers of live content are the publishing plugins
 * (`plugin:claude`, `plugin:openai-agent`), not workspace nodes — they
 * publish, the tracker measures the result, and until this landed the
 * measurement reached nobody on the tenant `/mcp`. `analytics_top_content` is
 * the evidence a plugin cites before choosing what to write next (see
 * `plugin/render-skill.ts` §3, which now sends it there).
 *
 * The sink is being extended in PARALLEL (per-object funnel beyond
 * pageview/completion_rate, previous-period deltas, per-object sources — see
 * `docs/cms-architecture/analytics-dashboard-spec.md` §6.1 / R6.2). Every
 * field these tools cannot honestly compute from TODAY's `/stats` response is
 * named as an explicit omission (a `*_unavailable` list / `degraded_fields` /
 * a `note`), never approximated — see `mcp-analytics-handlers.ts`, which is
 * the single place that honesty rule is enforced.
 */
import { objectSchema, stringSchema } from './mcp-tool-definitions.js';
import type { ToolDefinition } from '../functions/mcp.js';

const rangeSchema = () => ({
  type: 'string',
  enum: ['7d', '30d'],
  description:
    "Reporting window, resolved to a from/to bound ending now (the same resolveDateWindow the admin dashboard uses). Only 7d/30d are exposed on this tool contract today. Default 7d.",
});

const limitSchema = () => ({
  type: 'integer',
  minimum: 1,
  maximum: 20,
  description: 'Row cap, newest/highest-ranked first. Default 10, hard cap 20.',
});

const sortSchema = () => ({
  type: 'string',
  enum: ['pageviews', 'completion_rate', 'cta_ctr'],
  description: 'Ranking measure. cta_ctr degrades to pageviews today with sort_degraded:true (see description).',
});

export const TOOL_DEFINITIONS_ANALYTICS: ToolDefinition[] = [
  {
    name: 'analytics_summary',
    description:
      'Read-only KPI strip from this tenant\'s own first-party tracker: pageviews, sessions, visitors, consented share (consented_share_pct), purchases, and the last recorded event, over `range`. Proxies TRACKING_SINK_URL server-side — the sink token never reaches you. Deltas vs the previous period are NOT available yet (the sink has no previous-period field today; a parallel wave is adding one) — `deltas` is always null and `degraded_fields` names it, never an invented percentage. Returns {configured:false, error_code:"analytics_not_configured", message} when this tenant has no TRACKING_SINK_URL/TRACKING_PROJECT_ID set — never a crash, never a fabricated zero.',
    inputSchema: objectSchema({ range: rangeSchema() }),
    governance: { toolClass: 'read' },
  },
  {
    name: 'analytics_top_content',
    description:
      'Read-only ranked list of published objects (pages, articles) by a chosen measure, each row carrying its engagement funnel and its PRODUCER — which surface published it: a publishing-plugin name, "workflow" for the autonomous path, or "unknown" when the record could not be read. `sort` covers pageviews | completion_rate | cta_ctr — cta_ctr is not yet computable (the sink does not serve per-object CTA-click counts today) and silently falls back to pageviews with `sort_degraded:true` and a reason, never an invented ratio. Each row\'s `funnel` carries only `pageview` and `completion_rate` for the same reason: `read_progress`/`cta_click`/`buy_click` are named in the top-level `funnel_fields_unavailable` list, never filled with zeros. Use this BEFORE choosing a topic or angle to write next, and cite the winning object_id + measure + window as your evidence in the request note. `limit` is capped at 20.',
    inputSchema: objectSchema({ range: rangeSchema(), sort: sortSchema(), limit: limitSchema() }),
    governance: { toolClass: 'read' },
  },
  {
    name: 'analytics_object',
    description:
      "Read-only detail for ONE object: its funnel (pageview/completion_rate from the sink today — read_progress/cta_click/cta_ctr/buy_click are named in funnel_fields_unavailable, not invented); its sources (not yet per-object in the sink's /stats — reported as null with a reason, since top_sources today is site-wide, not per-object); and — read from THIS TENANT's own object store, never the sink — its producer (publishing surface), prompt_version, and variant lineage (variant_of, plus this object's own known variants from a bounded scan, flagged if the corpus was too large to scan in full). Returns a clear not-found, never a guess, when neither the sink nor the object store knows the id.",
    inputSchema: objectSchema(
      {
        object_id: stringSchema('The CMS object id to inspect (e.g. a content_item or page id).'),
        range: rangeSchema(),
      },
      ['object_id']
    ),
    governance: { toolClass: 'read' },
  },
];
