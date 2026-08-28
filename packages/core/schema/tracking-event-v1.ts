/**
 * `tracking_event.v1` + the `tracking_batch.v1` wrapper (W13, 12-plan §5.2).
 *
 * commerce_event.v1 rules apply VERBATIM: append-only, additive-only
 * evolution (v2 only for breaking changes, dual-write during transition),
 * server-side authoritative / client-side best-effort lossy, PII-minimized
 * (no raw email ever; the raw IP is hashed into vhash at ingest and
 * DISCARDED; `props` is an allowlist, not a passthrough).
 *
 * Two shapes on purpose:
 * - `clientTrackingEventSchema` — what the loader sends. NO project_id, NO
 *   vhash/shash, NO ua, NO geo: those are server-stamped at ingest (a client
 *   value is ignored — spoofing the envelope is structurally pointless).
 * - `trackingEventSchema` — the FULL stored/forwarded shape after
 *   enrichment (netlify/lib/tracking-events.ts).
 *
 * Geo carries country + subdivision ONLY — city is dropped at ingest
 * (OQ-W13-4 ruling, 2026-07-19).
 */
import { z } from 'zod';

import { TRACKING_EVENT_KINDS } from './bodies/tracking-config-v1.js';

export const TRACKING_EVENT_SCHEMA_VERSION = 'tracking_event.v1';
export const TRACKING_BATCH_SCHEMA_VERSION = 'tracking_batch.v1';
export const TRACKING_BATCH_MAX_EVENTS = 25;

export const trackingEventKindSchema = z.enum(TRACKING_EVENT_KINDS);
export type TrackingEventKind = z.infer<typeof trackingEventKindSchema>;

const nullableString = (max: number) => z.string().max(max).nullable();

// Object identity refs — nullable; ids are ADDITIONALLY re-validated against
// the real id grammars at ingest (isObjectIdForType — schema keeps the shape
// loose enough that a v2 type name doesn't break stored-event parsing).
const objectRefSchema = z
  .strictObject({
    object_type: nullableString(32),
    object_id: nullableString(128),
    section_id: nullableString(64),
    section_type: nullableString(48),
    node_id: nullableString(64),
    node_kind: nullableString(32),
    term_id: nullableString(64),
  })
  .partial()
  .optional();

// The per-event ALLOWLISTED props surface (12-plan §5.2). Which keys each
// event kind may carry is enforced by the ingest sanitizer
// (TRACKING_PROPS_ALLOWLIST in netlify/lib/tracking-events.ts); the schema
// bounds every value.
export const trackingPropsSchema = z
  .strictObject({
    depth_pct: z.number().int().min(0).max(100),
    dwell_ms: z.number().int().min(0).max(7_200_000),
    pct_read: z.number().int().min(0).max(100),
    href_host: z.string().max(253),
    goal: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    label_slug: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/),
    value_cents: z.number().int().min(0),
  })
  .partial();
export type TrackingProps = z.infer<typeof trackingPropsSchema>;

const utmSchema = z
  .strictObject({
    source: z.string().max(128),
    medium: z.string().max(128),
    campaign: z.string().max(128),
    content: z.string().max(128),
    term: z.string().max(128),
  })
  .partial();

const consentSchema = z.strictObject({
  analytics: z.boolean(),
  ads: z.boolean(),
  gpc: z.boolean(),
});

const urlSchema = z.strictObject({
  path: z.string().min(1).max(512),
  route: nullableString(256).optional(),
});

const clientContextSchema = z
  .strictObject({
    referrer: nullableString(1024),
    utm: utmSchema.optional(),
    viewport: z
      .strictObject({ w: z.number().int().min(0).max(100000), h: z.number().int().min(0).max(100000) })
      .optional(),
    lang: z.string().max(35).optional(),
  })
  .partial()
  .optional();

/** What the loader is allowed to author. Everything else is server-stamped. */
export const clientTrackingEventSchema = z.strictObject({
  event_id: z.uuid(),
  ts: z.iso.datetime(),
  event: trackingEventKindSchema,
  url: urlSchema,
  object: objectRefSchema,
  props: trackingPropsSchema.optional(),
  visitor: z
    .strictObject({
      mode: z.enum(['cookieless', 'consented']),
      vid: z.uuid().optional(),
    })
    .optional(),
  consent: consentSchema,
  context: clientContextSchema,
});
export type ClientTrackingEvent = z.infer<typeof clientTrackingEventSchema>;

/** The batch wrapper the loader flushes (≤25 events). */
export const trackingBatchSchema = z.strictObject({
  schema: z.literal(TRACKING_BATCH_SCHEMA_VERSION),
  events: z.array(z.unknown()).min(1).max(TRACKING_BATCH_MAX_EVENTS),
});

/** The full stored/forwarded event — after server enrichment. */
export const trackingEventSchema = z.strictObject({
  schema: z.literal(TRACKING_EVENT_SCHEMA_VERSION),
  event_id: z.uuid(),
  /** SERVER-stamped from env — a client-sent value is ignored. */
  project_id: z.string().min(1).max(64),
  ts: z.iso.datetime(),
  event: trackingEventKindSchema,
  url: urlSchema,
  object: objectRefSchema,
  props: trackingPropsSchema,
  visitor: z.strictObject({
    mode: z.enum(['cookieless', 'consented']),
    vid: z.uuid().nullable(),
    /** Ingest-computed: sha256(TRACKING_SALT + utc_date + ip + ua + project_id). */
    vhash: z.string().regex(/^[0-9a-f]{64}$/),
    /** Ingest-computed on a 30-minute window over the vhash. */
    shash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  consent: consentSchema,
  context: z.strictObject({
    referrer: nullableString(1024),
    utm: utmSchema.nullable(),
    viewport: z.strictObject({ w: z.number().int(), h: z.number().int() }).nullable(),
    lang: nullableString(35),
    /** Server-stamped. */
    ua: nullableString(512),
    /** Server-enriched; country + subdivision ONLY (city dropped, OQ-W13-4). */
    geo: z.strictObject({ country: nullableString(2), subdivision: nullableString(8) }),
  }),
});
export type TrackingEvent = z.infer<typeof trackingEventSchema>;
