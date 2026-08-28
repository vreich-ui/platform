/**
 * TrackingScripts assembly (W13, 12-plan §4) — the PURE half of the render
 * seam, so the component stays a thin shell and every decision here is
 * unit-tested: the `#trk-config` client JSON (project id from the
 * trk_<project> id convention, batch/sampling knobs, the defaults matrix,
 * the consent block, and the goal map aggregated from every collection's
 * `tracking` fields), plus the enabled-adapter head assembly.
 *
 * The goal map carries ONLY objects that need it (goals present or
 * enabled:false) — goal keys/labels are public by construction (§2), but
 * nothing else from `tracking` (label/tags NEVER leave the export).
 */
import { trackingConfigBodySchema, type TrackingConfigBody } from '../../schema/bodies/tracking-config-v1.js';
import { ga4Adapter } from './adapters/ga4.js';
import { googleAdsAdapter } from './adapters/google-ads.js';
import { metaPixelAdapter } from './adapters/meta-pixel.js';
import { mgidAdapter } from './adapters/mgid.js';
import { outbrainAdapter } from './adapters/outbrain.js';
import { ownAdapter } from './adapters/own.js';
import { plausibleAdapter } from './adapters/plausible.js';
import { taboolaAdapter } from './adapters/taboola.js';
import type { AdapterResult } from './adapters/types.js';

export type GoalSourceConversion = {
  provider: string;
  label: string;
  value_source?: string;
};

export type GoalSource = {
  object_id: string;
  tracking?: {
    enabled?: boolean;
    goals?: { goal: string; on?: string; provider_conversions?: GoalSourceConversion[] }[];
  } | null;
  /** Product sources only (T13.7): the export's commerce price — the ONLY
   *  origin of `value_source:'product_price'` values (never client-guessed). */
  price_cents?: number;
  currency?: string;
};

export type TrackerGoalConversion = {
  provider: string;
  label: string;
  value_cents?: number;
  currency?: string;
};

export type TrackerGoal = { goal: string; on?: string; conversions?: TrackerGoalConversion[] };

export type TrackerGoalMap = Record<string, { enabled?: false; goals?: TrackerGoal[] }>;

/** {object_id → goals/off} — only entries that change loader behavior. */
export const buildGoalMap = (sources: readonly GoalSource[]): TrackerGoalMap => {
  const map: TrackerGoalMap = {};
  for (const source of sources) {
    const tracking = source.tracking;
    if (!tracking) continue;
    const entry: TrackerGoalMap[string] = {};
    if (tracking.enabled === false) entry.enabled = false;
    if (Array.isArray(tracking.goals) && tracking.goals.length > 0) {
      entry.goals = tracking.goals.map((goal) => {
        const shaped: TrackerGoal = { goal: goal.goal, ...(goal.on ? { on: goal.on } : {}) };
        // provider_conversions are PUBLIC by construction (§2 — regex-pinned
        // labels); value_source:'product_price' resolves HERE, at build,
        // from the declaring product's export.
        if (Array.isArray(goal.provider_conversions) && goal.provider_conversions.length > 0) {
          shaped.conversions = goal.provider_conversions.map((conversion) => {
            const resolved: TrackerGoalConversion = { provider: conversion.provider, label: conversion.label };
            if (conversion.value_source === 'product_price' && typeof source.price_cents === 'number') {
              resolved.value_cents = source.price_cents;
              if (source.currency) resolved.currency = source.currency;
            }
            return resolved;
          });
        }
        return shaped;
      });
    }
    if (Object.keys(entry).length > 0) map[source.object_id] = entry;
  }
  return map;
};

export type TrackerClientConfig = {
  project: string;
  ingest_path: string;
  batch: { max_events: number; max_wait_ms: number };
  sample_rate: number;
  defaults: TrackingConfigBody['defaults'];
  consent: {
    posture: string;
    regions: string[];
    gpc: boolean;
    analytics_id_mode: TrackingConfigBody['consent']['analytics_id_mode'];
  };
  goals: TrackerGoalMap;
  /** Enabled ad providers the T13.7/T13.8 bridge may call (ids are
   *  already public — they sit in the head snippets). */
  providers?: {
    google_ads?: { id: string };
    ga4?: { id: string };
    meta_pixel?: { id: string };
    taboola?: { id: string };
    outbrain?: { id: string };
    mgid?: { id: string };
  };
};

/**
 * Parse the committed export body (marker already stripped) — THROWS on a
 * present-but-invalid export (drift must be loud, the site-object stance).
 */
export const parseTrackingExport = (raw: unknown): TrackingConfigBody => trackingConfigBodySchema.parse(raw);

export const buildTrackerClientConfig = (
  objectId: string,
  body: TrackingConfigBody,
  goalSources: readonly GoalSource[]
): TrackerClientConfig => {
  const config: TrackerClientConfig = {
    // trk_<project> — the site_/tax_ naming convention IS the project id.
    project: objectId.replace(/^trk_/, ''),
    ingest_path: body.providers.own?.ingest_path ?? '/api/t',
    batch: body.providers.own?.batch ?? { max_events: 20, max_wait_ms: 10000 },
    sample_rate: body.providers.own?.sample_rate ?? 1,
    defaults: body.defaults,
    consent: {
      posture: body.consent.posture,
      regions: body.consent.restricted_regions,
      gpc: body.consent.honor_gpc,
      analytics_id_mode: body.consent.analytics_id_mode,
    },
    goals: buildGoalMap(goalSources),
  };
  const providers: NonNullable<TrackerClientConfig['providers']> = {};
  if (body.providers.google_ads?.enabled && body.providers.google_ads.conversion_id) {
    providers.google_ads = { id: body.providers.google_ads.conversion_id };
  }
  if (body.providers.ga4?.enabled && body.providers.ga4.measurement_id) {
    providers.ga4 = { id: body.providers.ga4.measurement_id };
  }
  if (body.providers.meta_pixel?.enabled && body.providers.meta_pixel.pixel_id) {
    providers.meta_pixel = { id: body.providers.meta_pixel.pixel_id };
  }
  if (body.providers.taboola?.enabled && body.providers.taboola.account_id) {
    providers.taboola = { id: body.providers.taboola.account_id };
  }
  if (body.providers.outbrain?.enabled && body.providers.outbrain.account_id) {
    providers.outbrain = { id: body.providers.outbrain.account_id };
  }
  if (body.providers.mgid?.enabled && body.providers.mgid.account_id) {
    providers.mgid = { id: body.providers.mgid.account_id };
  }
  if (Object.keys(providers).length > 0) config.providers = providers;
  return config;
};

/** Enabled adapters only, in emission order (own first; natives via T13.8). */
export const assembleAdapterHeads = (body: TrackingConfigBody, siteHost: string): AdapterResult[] => {
  const results: AdapterResult[] = [];
  results.push(ownAdapter(body.providers.own));
  results.push(plausibleAdapter(body.providers.plausible, { siteHost }));
  // One gtag.js loader per page: it rides the LEAST-gated enabled consumer
  // (an ungated analytics-class ga4 must load immediately; a gated-only
  // family loads on activation).
  const googleAds = body.providers.google_ads;
  const ga4 = body.providers.ga4;
  const ga4Live = ga4?.enabled === true && ga4.consent_class !== 'advertising';
  results.push(googleAdsAdapter(googleAds, { includeLoader: googleAds?.enabled === true && !ga4Live }));
  results.push(ga4Adapter(ga4, { includeLoader: ga4?.enabled === true && (ga4Live || googleAds?.enabled !== true) }));
  // T13.8: the native pixels — all advertising-gated identically.
  results.push(metaPixelAdapter(body.providers.meta_pixel));
  results.push(taboolaAdapter(body.providers.taboola));
  results.push(outbrainAdapter(body.providers.outbrain));
  results.push(mgidAdapter(body.providers.mgid));
  return results.filter((result) => result.head !== '' || result.cspHosts.script.length > 0);
};
