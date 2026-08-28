/**
 * Tracking event log + ingest helpers — the commerce-events.ts sibling
 * (W13, 12-plan §5.2–§5.3).
 *
 * Binding rules, inherited verbatim from commerce_event.v1: events are
 * IMMUTABLE (append-only, create-if-absent, nothing here updates or deletes);
 * evolution is additive-only; PII-minimized — the RAW IP enters
 * `computeVisitorHashes` and is DISCARDED (only the salted daily hash
 * persists); `props` passes through `sanitizeTrackingProps`'s per-event
 * allowlist, never as-is.
 *
 * The blob mirror (`tracking-events` store, `events/<yyyy-mm-dd>/
 * <compact-ts>-<uuid>.json` — the commerce layout) exists for REPLAY into
 * the owner DB only, never as a reporting surface (house rule: no reporting
 * on blob listing). Retention: 90 days (OQ-W13-4) — recorded policy;
 * enforcement is a future cleanup script.
 */
import { z } from 'zod';

import { sha256Hex } from './crypto.js';
import { isObjectIdForType } from '../../lib/object-ids.js';
import { objectTypes, type ObjectType } from '../../schema/object-record-v1.js';
import {
  clientTrackingEventSchema,
  trackingEventSchema,
  TRACKING_EVENT_SCHEMA_VERSION,
  type ClientTrackingEvent,
  type TrackingEvent,
  type TrackingEventKind,
} from '../../schema/tracking-event-v1.js';

// ─── per-event props allowlist (12-plan §5.2 — allowlist, not passthrough) ───

export const TRACKING_PROPS_ALLOWLIST: Record<TrackingEventKind, readonly string[]> = {
  pageview: [],
  section_impression: [],
  section_dwell: ['dwell_ms'],
  node_impression: [],
  node_dwell: ['dwell_ms'],
  scroll_depth: ['depth_pct'],
  engagement: ['dwell_ms'],
  cta_click: ['label_slug'],
  nav_click: ['label_slug'],
  buy_click: ['label_slug', 'value_cents', 'commerce_event_id'],
  outbound_click: ['href_host'],
  form_start: ['label_slug'],
  form_submit: ['label_slug'],
  term_view: [],
  tag_click: ['label_slug'],
  read_progress: ['pct_read'],
  completion: [],
  goal: ['goal', 'value_cents', 'label_slug', 'commerce_event_id'],
};

/** Keep only the allowlisted keys for this event kind (drop the rest silently). */
export const sanitizeTrackingProps = (
  event: TrackingEventKind,
  props: Record<string, unknown> | undefined
): Record<string, unknown> => {
  if (!props) return {};
  const allowed = TRACKING_PROPS_ALLOWLIST[event] ?? [];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in props && props[key] !== undefined) out[key] = props[key];
  }
  return out;
};

// ─── object-ref revalidation (ids re-checked against the REAL grammars) ──────

const OBJECT_TYPE_SET = new Set<string>(objectTypes);

/**
 * Null out anything that fails the real id grammars — a bad ref degrades to
 * an anonymous event rather than dropping it (the event itself is still
 * true; the ref was noise or tampering).
 */
export const sanitizeObjectRef = (ref: ClientTrackingEvent['object']): TrackingEvent['object'] => {
  if (!ref) return undefined;
  const out: Record<string, string | null> = {};
  const objectType =
    typeof ref.object_type === 'string' && OBJECT_TYPE_SET.has(ref.object_type) ? ref.object_type : null;
  if (objectType) out.object_type = objectType;
  if (typeof ref.object_id === 'string') {
    const valid = objectType !== null && isObjectIdForType(objectType as ObjectType, ref.object_id);
    if (valid) out.object_id = ref.object_id;
  }
  if (typeof ref.section_id === 'string' && /^s_[a-z0-9]+$/.test(ref.section_id)) out.section_id = ref.section_id;
  if (typeof ref.section_type === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(ref.section_type))
    out.section_type = ref.section_type;
  if (typeof ref.node_id === 'string' && /^n_[a-z0-9]+$/i.test(ref.node_id)) out.node_id = ref.node_id;
  if (typeof ref.node_kind === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(ref.node_kind)) out.node_kind = ref.node_kind;
  if (typeof ref.term_id === 'string' && /^t_[a-z0-9]+$/.test(ref.term_id)) out.term_id = ref.term_id;
  return Object.keys(out).length > 0 ? out : undefined;
};

// ─── visitor identity (cookieless; the Plausible model) ──────────────────────

export const SESSION_WINDOW_MS = 30 * 60 * 1000;

export type VisitorHashInput = {
  salt: string;
  /** UTC date `yyyy-mm-dd` — the daily rotation. */
  utcDate: string;
  ip: string;
  ua: string;
  projectId: string;
  /** Epoch ms of the event — buckets the 30-minute session window. */
  nowMs: number;
};

/**
 * vhash = sha256(salt + utc_date + ip + ua + project_id) — daily-rotating,
 * no persistent identifier, ZERO device storage. The raw IP exists only in
 * this function's arguments; nothing returns or stores it.
 * shash = sha256(salt + vhash + <30-min window index>).
 */
export const computeVisitorHashes = (input: VisitorHashInput): { vhash: string; shash: string } => {
  const vhash = sha256Hex(`${input.salt}${input.utcDate}${input.ip}${input.ua}${input.projectId}`);
  const windowIndex = Math.floor(input.nowMs / SESSION_WINDOW_MS);
  const shash = sha256Hex(`${input.salt}${vhash}${windowIndex}`);
  return { vhash, shash };
};

// ─── enrichment: client event → full stored/forwarded event ──────────────────

export type TrackingEnrichment = {
  projectId: string;
  ua: string | null;
  geo: { country: string | null; subdivision: string | null };
  vhash: string;
  shash: string;
};

export const parseClientTrackingEvent = (value: unknown): ClientTrackingEvent | null => {
  const parsed = clientTrackingEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const buildTrackingEvent = (client: ClientTrackingEvent, enrichment: TrackingEnrichment): TrackingEvent =>
  trackingEventSchema.parse({
    schema: TRACKING_EVENT_SCHEMA_VERSION,
    event_id: client.event_id,
    project_id: enrichment.projectId,
    ts: client.ts,
    event: client.event,
    url: client.url,
    object: sanitizeObjectRef(client.object),
    props: sanitizeTrackingProps(client.event, client.props),
    visitor: {
      mode: client.visitor?.mode ?? 'cookieless',
      vid: client.visitor?.mode === 'consented' ? (client.visitor.vid ?? null) : null,
      vhash: enrichment.vhash,
      shash: enrichment.shash,
    },
    consent: client.consent,
    context: {
      referrer: client.context?.referrer ?? null,
      utm: client.context?.utm ?? null,
      viewport: client.context?.viewport ?? null,
      lang: client.context?.lang ?? null,
      ua: enrichment.ua,
      geo: { country: enrichment.geo.country, subdivision: enrichment.geo.subdivision },
    },
  });

// ─── NDJSON + blob mirror (the commerce-events layout) ───────────────────────

export const toNdjson = (events: readonly TrackingEvent[]): string =>
  events.map((event) => JSON.stringify(event)).join('\n') + '\n';

export const trackingEventKey = (event: Pick<TrackingEvent, 'ts' | 'event_id'>): string => {
  const date = event.ts.slice(0, 10);
  const compactTs = event.ts.replace(/\D/g, '');
  return `events/${date}/${compactTs}-${event.event_id}.json`;
};

type EventStore = {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean }): Promise<void | { modified: boolean }>;
};

/** Append one validated event, create-if-absent — immutable, never overwritten. */
export const appendTrackingEvent = async (
  store: EventStore,
  event: TrackingEvent
): Promise<{ key: string; appended: boolean }> => {
  const parsed = trackingEventSchema.parse(event);
  const key = trackingEventKey(parsed);
  if ((await store.get(key)) !== null) return { key, appended: false };
  const result = await store.setJSON(key, parsed, { onlyIfNew: true });
  if (result && typeof result === 'object' && result.modified === false) return { key, appended: false };
  return { key, appended: true };
};

// ─── sink config (env-var NAMES from tracking_config; safe defaults) ─────────

export const DEFAULT_SINK_ENDPOINT_ENV = 'TRACKING_SINK_URL';
export const DEFAULT_SINK_AUTH_ENV = 'TRACKING_SINK_TOKEN';

const envNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);

export type SinkConfig = {
  endpointEnv: string;
  authEnv: string;
  blobMirror: 'fallback' | 'always' | 'off';
};

/**
 * Resolve the sink wiring from a tracking_config `own` block (already
 * validated at write; re-guarded here because the record crosses a store
 * boundary). Absent/invalid config → the OQ-W13-6 default env names +
 * mirror 'fallback' — ingest never hard-depends on the registry object.
 */
export const resolveSinkConfig = (ownBlock: unknown): SinkConfig => {
  const fallback: SinkConfig = {
    endpointEnv: DEFAULT_SINK_ENDPOINT_ENV,
    authEnv: DEFAULT_SINK_AUTH_ENV,
    blobMirror: 'fallback',
  };
  if (!ownBlock || typeof ownBlock !== 'object' || Array.isArray(ownBlock)) return fallback;
  const block = ownBlock as Record<string, unknown>;
  const endpoint = envNameSchema.safeParse(block.endpoint_env);
  const auth = envNameSchema.safeParse(block.auth_env);
  const mirror =
    block.blob_mirror === 'always' || block.blob_mirror === 'off' || block.blob_mirror === 'fallback'
      ? block.blob_mirror
      : 'fallback';
  return {
    endpointEnv: endpoint.success ? endpoint.data : fallback.endpointEnv,
    authEnv: auth.success ? auth.data : fallback.authEnv,
    blobMirror: mirror,
  };
};
