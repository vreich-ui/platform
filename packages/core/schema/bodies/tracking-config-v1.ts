/**
 * Tracking-config body schema — 'tracking_config.v1' (W13,
 * 12-object-tracking-and-analytics §3). The per-project tracker registry:
 * one singleton per site (`trk_<project>`, the site_/tax_ convention).
 *
 * THE SAFETY LAW (the `checkBrandTokenValue` analogue): agents never inject
 * script text or URLs — they flip typed switches and supply regex-pinned
 * IDs. All script text lives in code-owned adapter templates (§4), which
 * re-assert these regexes at render before interpolating. No free-URL field
 * exists anywhere in this body: the own tracker's endpoint/auth are env-var
 * NAMES (never values or URLs), and plausible's api_host is a bare-https
 * origin with no path/query.
 *
 * `providers` is a FIXED-KEY strict object (not an array) so plain
 * deep-merge (`set_tracking_config_fields`) edits one provider without
 * upsert ops. Absent block = provider disabled. `gtm` exists as a fixed key
 * for shape stability but is PERMANENTLY OUT (OQ-W13-3, ruled 2026-07-19):
 * enabling it fails the schema, not just validation.
 */
import { z } from 'zod';

export const TRACKING_CONFIG_SCHEMA_VERSION = 'tracking_config.v1';

// Env-var NAMES (the CMS-Agent house pattern) — never values, never URLs.
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

const envName = z
  .string()
  .regex(ENV_NAME_RE, { message: 'must be an ENV VAR NAME (A-Z0-9_), never a value or URL' })
  .refine((value) => !value.includes('://'), { message: 'env fields carry names, never URLs' });

export const consentClassSchema = z.enum(['essential', 'analytics', 'advertising']);

/** The §5.3 event vocabulary — the bounded values `defaults` may collect. */
export const TRACKING_EVENT_KINDS = [
  'pageview',
  'section_impression',
  'section_dwell',
  'node_impression',
  'node_dwell',
  'scroll_depth',
  'engagement',
  'cta_click',
  'nav_click',
  'buy_click',
  'outbound_click',
  'form_start',
  'form_submit',
  'term_view',
  'tag_click',
  'read_progress',
  'completion',
  'goal',
] as const;
const eventKindSchema = z.enum(TRACKING_EVENT_KINDS);

// Per-provider ID regexes (re-asserted at render by the §4 adapters).
export const PROVIDER_ID_RES = {
  google_ads: /^AW-\d{6,12}$/,
  ga4: /^G-[A-Z0-9]{4,14}$/,
  gtm: /^GTM-[A-Z0-9]{4,10}$/,
  meta_pixel: /^\d{8,20}$/,
  taboola: /^\d{4,16}$/,
  outbrain: /^[0-9a-f]{8,32}$|^\d{4,16}$/,
  mgid: /^\d{4,16}$/,
  plausible_api_host: /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+$/,
} as const;

const providerBlock = <TShape extends z.ZodRawShape>(shape: TShape) =>
  z
    .strictObject({
      enabled: z.boolean(),
      consent_class: consentClassSchema,
      ...shape,
    })
    .optional();

const requireIdWhenEnabled = (
  block: { enabled: boolean } | undefined,
  idValue: string | undefined,
  at: string,
  ctx: z.RefinementCtx
): void => {
  if (block?.enabled && (idValue === undefined || idValue.trim() === '')) {
    ctx.addIssue({ code: 'custom', path: [at], message: `${at}: enabled requires its id field to be set.` });
  }
};

const providersSchema = z
  .strictObject({
    /** The own first-party pipeline (§5). Endpoint/auth are env-var NAMES. */
    own: z
      .strictObject({
        enabled: z.boolean(),
        consent_class: consentClassSchema,
        ingest_path: z
          .string()
          .regex(/^\/[a-z0-9/_-]*$/, { message: 'a same-origin path like /api/t — never a full URL' })
          .default('/api/t'),
        endpoint_env: envName.optional(),
        auth_env: envName.optional(),
        sample_rate: z.number().min(0).max(1).optional(),
        batch: z
          .strictObject({
            max_events: z.number().int().min(1).max(25),
            max_wait_ms: z.number().int().min(100).max(60000),
          })
          .optional(),
        blob_mirror: z.enum(['fallback', 'always', 'off']).optional(),
      })
      .optional(),
    ga4: providerBlock({ measurement_id: z.string().regex(PROVIDER_ID_RES.ga4).optional() }),
    gtm: providerBlock({ container_id: z.string().regex(PROVIDER_ID_RES.gtm).optional() }),
    google_ads: providerBlock({ conversion_id: z.string().regex(PROVIDER_ID_RES.google_ads).optional() }),
    meta_pixel: providerBlock({ pixel_id: z.string().regex(PROVIDER_ID_RES.meta_pixel).optional() }),
    taboola: providerBlock({ account_id: z.string().regex(PROVIDER_ID_RES.taboola).optional() }),
    outbrain: providerBlock({ account_id: z.string().regex(PROVIDER_ID_RES.outbrain).optional() }),
    mgid: providerBlock({ account_id: z.string().regex(PROVIDER_ID_RES.mgid).optional() }),
    plausible: providerBlock({ api_host: z.string().regex(PROVIDER_ID_RES.plausible_api_host).optional() }),
  })
  .superRefine((providers, ctx) => {
    requireIdWhenEnabled(providers.ga4, providers.ga4?.measurement_id, 'ga4', ctx);
    requireIdWhenEnabled(providers.google_ads, providers.google_ads?.conversion_id, 'google_ads', ctx);
    requireIdWhenEnabled(providers.meta_pixel, providers.meta_pixel?.pixel_id, 'meta_pixel', ctx);
    requireIdWhenEnabled(providers.taboola, providers.taboola?.account_id, 'taboola', ctx);
    requireIdWhenEnabled(providers.outbrain, providers.outbrain?.account_id, 'outbrain', ctx);
    requireIdWhenEnabled(providers.mgid, providers.mgid?.account_id, 'mgid', ctx);
    requireIdWhenEnabled(providers.plausible, providers.plausible?.api_host, 'plausible', ctx);
    if (providers.gtm?.enabled) {
      ctx.addIssue({
        code: 'custom',
        path: ['gtm'],
        message: 'GTM is permanently OUT (OQ-W13-3, 2026-07-19) — the key exists for shape stability only.',
      });
    }
  });

export const consentPostureSchema = z.enum(['geo-adaptive', 'consent-first', 'us-first']);
export const analyticsIdModeSchema = z.enum(['granted-only', 'unrestricted-auto']);

const consentSchema = z.strictObject({
  posture: consentPostureSchema,
  /** ISO-3166 alpha-2 (seed = EEA-30 + UK + CH per OQ-W13-1). */
  restricted_regions: z.array(z.string().regex(/^[A-Z]{2}$/)),
  honor_gpc: z.boolean(),
  analytics_id_mode: analyticsIdModeSchema.default('granted-only'),
  banner: z
    .strictObject({
      headline: z.string().max(120),
      body: z.string().max(600),
      accept_label: z.string().max(48),
      reject_label: z.string().max(48),
      manage_label: z.string().max(48).optional(),
    })
    .optional(),
});

// The §6 per-type collection matrix, plus the two page-context switches.
const defaultsSchema = z.strictObject({
  page: z.array(eventKindSchema),
  section: z.array(eventKindSchema),
  content_item: z.array(eventKindSchema),
  product: z.array(eventKindSchema),
  navigation: z.array(eventKindSchema),
  taxonomy: z.array(eventKindSchema),
  outbound_links: z.boolean(),
  utm_capture: z.boolean(),
});

export const trackingConfigBodySchema = z.strictObject({
  providers: providersSchema,
  consent: consentSchema,
  defaults: defaultsSchema,
});
export type TrackingConfigBody = z.infer<typeof trackingConfigBodySchema>;

/** Provider keys whose consent_class may be 'advertising' — used by the
 *  tracking_config_ready criterion's banner-copy rule. */
export const PROVIDER_KEYS = [
  'own',
  'ga4',
  'gtm',
  'google_ads',
  'meta_pixel',
  'taboola',
  'outbrain',
  'mgid',
  'plausible',
] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];
