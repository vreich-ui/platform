/**
 * Tracking attribute — the shared per-object tracking block every governed
 * body carries (W13, 12-object-tracking-and-analytics §2; the
 * recipe-metadata-v1 spread pattern). One shape, ten consumers; every field
 * schema-OPTIONAL so all pre-W13 records keep parsing (the additive
 * guarantee).
 *
 * Leak boundary (§2, tested by the renderer leak greps): `label` and `tags`
 * are reporting-only and NEVER render. `goals` — the goal keys and provider
 * conversion labels — DO reach the page inside the loader's build-time
 * config, which is why GOAL_KEY_RE / CONVERSION_LABEL_RE force neutral
 * slugs: strategy vocabulary lives in `private.*` and `label`/`tags`;
 * anything in `goals` is public by construction.
 *
 * Written ONLY by the uniform `set_tracking` op (one-writer funnel — the
 * seven open fields ops carry forbidKeys(['tracking'])).
 */
import { z } from 'zod';

export const GOAL_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/; // neutral slugs — these reach HTML
export const CONVERSION_LABEL_RE = /^[A-Za-z0-9_-]{4,64}$/; // provider conversion label/id

export const trackingGoalSchema = z.strictObject({
  goal: z.string().regex(GOAL_KEY_RE), // own-tracker goal key ('buy_click', 'opt_in', …)
  on: z
    .enum(['view', 'impression', 'cta_click', 'form_submit', 'buy_click', 'completion', 'outbound_click'])
    .optional(),
  provider_conversions: z
    .array(
      z.strictObject({
        provider: z.enum(['google_ads', 'ga4', 'meta_pixel', 'taboola', 'outbrain', 'mgid']),
        label: z.string().regex(CONVERSION_LABEL_RE),
        value_source: z.enum(['none', 'product_price']).optional(),
      })
    )
    .optional(),
});
export type TrackingGoal = z.infer<typeof trackingGoalSchema>;

export const trackingAttributeSchema = z.strictObject({
  enabled: z.boolean().optional(), // absent = inherit the per-type default from tracking_config
  label: z.string().max(120).optional(), // reporting name — NEVER rendered
  tags: z.array(z.string().max(48)).max(12).optional(), // reporting grouping — NEVER rendered
  goals: z.array(trackingGoalSchema).max(8).optional(),
});
export type TrackingAttribute = z.infer<typeof trackingAttributeSchema>;

/** Spread into every governed body schema (all ten types). */
export const trackingAttributeShape = { tracking: trackingAttributeSchema.optional() };

export type TrackingGoalActivity = NonNullable<TrackingGoal['on']>;

/**
 * Which goal `on` activities are COLLECTABLE per object type — the §6
 * matrix projected onto the goal-activity enum (validation and, later, the
 * T13.5 renderer read THIS table; the mapping is code, never data):
 *
 *   page          → pageview ⇒ 'view'; outbound (foreign hostname) is
 *                   page-context auto-collection ⇒ 'outbound_click'
 *   section       → impression / cta_click / form_submit (dwell is
 *                   auto-collected, not a goal binding)
 *   content_item  → node_impression ⇒ 'impression'; completion (last-node
 *                   impression) ⇒ 'completion'
 *   product       → buy_click
 *   navigation    → nav_click on header/footer items ⇒ 'cta_click' (the
 *                   T2.9 header actions ARE navigation-carried CTAs)
 *   taxonomy      → term_view on term routes ⇒ 'view'
 *   site/theme/template/section_template → no reader events (§6: explicit
 *                   non-goal; the attribute still parses — label/tags stay
 *                   meaningful for reporting; a goal with `on` set cannot
 *                   fire and fails validation at publish)
 */
export const TRACKABLE_ACTIVITIES_BY_TYPE: Record<string, readonly TrackingGoalActivity[]> = {
  page: ['view', 'outbound_click'],
  section: ['impression', 'cta_click', 'form_submit'],
  content_item: ['impression', 'completion'],
  product: ['buy_click'],
  navigation: ['cta_click'],
  taxonomy: ['view'],
  site: [],
  theme: [],
  template: [],
  section_template: [],
  // The registry singleton itself is configuration — no reader events, and it
  // does not carry the tracking attribute at all (schema-level).
  tracking_config: [],
  // D1 (2026-07-28): a declared editorial voice is authoring law, never a
  // reader-facing surface — same exemption, same reason.
  editorial_voice: [],
  // Brand-imagery wave (BRIEF.md §3.1): a mood board is never a reader-facing
  // surface either — same exemption, same reason.
  visual_standard: [],
};

/**
 * The governed types that do NOT carry the shared `tracking` attribute at the
 * schema level, and therefore get no `set_tracking` op and no
 * `tracking_attribute` contract constraint.
 *
 * Exported so the coverage suites DERIVE the exemption instead of restating a
 * count ("all ten types") that silently becomes wrong the next time a type is
 * added. That restated count is exactly what broke when editorial_voice landed.
 */
export const TRACKING_ATTRIBUTE_EXEMPT_TYPES = ['tracking_config', 'editorial_voice', 'visual_standard'] as const;

export const carriesTrackingAttribute = (objectType: string): boolean =>
  !(TRACKING_ATTRIBUTE_EXEMPT_TYPES as readonly string[]).includes(objectType);
