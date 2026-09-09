/**
 * `/api/t` — the first-party tracking ingest relay (W13, 12-plan §5.3).
 *
 * POST: validate a tracking_batch.v1 (content-type-agnostic — sendBeacon
 * sends text/plain or no type at all), enrich per event (geo country+
 * subdivision ONLY — city dropped per OQ-W13-4; server UA; server
 * project_id; daily-rotating vhash + 30-min shash — the RAW IP is hashed
 * and DISCARDED), forward NDJSON to the configured owner sink (2s timeout,
 * no retries, at-most-once), and mirror to the `tracking-events` blob store
 * on sink absence/failure (or always, per config). Per-event drop — one bad
 * event never rejects the batch. Fast 202 always.
 *
 * GET ?mode=region: the §8 consent gate's region oracle — `{country}` from
 * the request geo, no storage.
 *
 * Geo accessor (pinned per the T13.3 brief): the `x-nf-geo` request header
 * Netlify stamps on function invocations — JSON (raw or base64-encoded)
 * carrying `{city, country:{code}, subdivision:{code}, …}`; `x-country` is
 * the fallback. `city` is NEVER read.
 *
 * Abuse posture: same-origin only (a foreign `Origin` header is rejected;
 * absent Origin — beacons on some paths, curl — passes: the token bucket
 * and enum/regex gates bound the damage), instance-local token bucket,
 * batch ≤25 events / ≤64KB body.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getSiteObjectsBlobStore, getTrackingEventsBlobStore } from '../lib/blob-store.js';
import { objectRecordKey, objectStatusIndexPrefix } from '../lib/object-store-keys.js';
import { collectBlobListItems, type BlobListResponse } from '../lib/blob-list.js';
import {
  appendTrackingEvent,
  buildTrackingEvent,
  computeVisitorHashes,
  parseClientTrackingEvent,
  resolveSinkConfig,
  toNdjson,
  type SinkConfig,
} from '../lib/tracking-events.js';
import { trackingBatchSchema, type TrackingEvent } from '../../schema/tracking-event-v1.js';
import { resolveSiteIdentity } from '../../lib/site-identity.js';

const MAX_BODY_BYTES = 64 * 1024;
const SINK_TIMEOUT_MS = 2000;

type LambdaEvent = {
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
};

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: jsonHeaders,
  body: JSON.stringify(body),
});

const getHeader = (headers: Record<string, string | undefined> | undefined, name: string): string | undefined => {
  if (!headers) return undefined;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return direct;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1];
};

// ─── geo (the pinned accessor) ────────────────────────────────────────────────

export type GeoReading = { country: string | null; subdivision: string | null };

export const readGeo = (event: LambdaEvent): GeoReading => {
  const raw = getHeader(event.headers, 'x-nf-geo');
  if (raw) {
    for (const candidate of [raw, tryBase64(raw)]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>;
        const country = codeOf(parsed.country);
        const subdivision = codeOf(parsed.subdivision);
        if (country || subdivision) return { country, subdivision };
      } catch {
        // fall through to the next candidate
      }
    }
  }
  const fallback = getHeader(event.headers, 'x-country');
  return { country: fallback && /^[A-Za-z]{2}$/.test(fallback) ? fallback.toUpperCase() : null, subdivision: null };
};

const tryBase64 = (value: string): string | null => {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return decoded.trimStart().startsWith('{') ? decoded : null;
  } catch {
    return null;
  }
};

const codeOf = (value: unknown): string | null => {
  if (typeof value === 'string' && /^[A-Za-z]{2,8}$/.test(value)) return value.toUpperCase();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const code = (value as Record<string, unknown>).code;
    if (typeof code === 'string' && /^[A-Za-z0-9-]{2,8}$/.test(code)) return code.toUpperCase();
  }
  return null;
};

// ─── instance-local token bucket ────────────────────────────────────────────

const BUCKET_CAPACITY = 60;
const BUCKET_REFILL_PER_SECOND = 10;
let bucketTokens = BUCKET_CAPACITY;
let bucketLastRefillMs = 0;

const takeToken = (nowMs: number): boolean => {
  if (bucketLastRefillMs === 0) bucketLastRefillMs = nowMs;
  const elapsed = Math.max(0, nowMs - bucketLastRefillMs);
  bucketTokens = Math.min(BUCKET_CAPACITY, bucketTokens + (elapsed / 1000) * BUCKET_REFILL_PER_SECOND);
  bucketLastRefillMs = nowMs;
  if (bucketTokens < 1) return false;
  bucketTokens -= 1;
  return true;
};

/** Test hook — resets the instance-local bucket. */
export const resetTokenBucketForTests = (): void => {
  bucketTokens = BUCKET_CAPACITY;
  bucketLastRefillMs = 0;
};

// ─── sink config cache (the tracking_config `own` block; 5-min TTL) ──────────

let cachedSink: { config: SinkConfig; readAtMs: number } | null = null;
const SINK_CACHE_TTL_MS = 5 * 60 * 1000;

const loadSinkConfig = async (event: LambdaEvent, nowMs: number, deps: TrackIngestDeps): Promise<SinkConfig> => {
  if (cachedSink && nowMs - cachedSink.readAtMs < SINK_CACHE_TTL_MS) return cachedSink.config;
  let ownBlock: unknown;
  try {
    const store = await (deps.getObjectsStore ?? getSiteObjectsBlobStore)(event, deps.binding);
    const items = await collectBlobListItems(
      (await store.list({ prefix: objectStatusIndexPrefix('tracking_config', 'active') })) as BlobListResponse
    );
    const objectId = items[0]?.key.split('/').at(-1);
    if (objectId) {
      const raw = await store.get(objectRecordKey('tracking_config', objectId));
      if (raw) {
        const record = JSON.parse(raw) as { body?: { providers?: { own?: unknown } } };
        ownBlock = record.body?.providers?.own;
      }
    }
  } catch {
    ownBlock = undefined; // absent/broken registry never blocks ingest
  }
  const config = resolveSinkConfig(ownBlock);
  cachedSink = { config, readAtMs: nowMs };
  return config;
};

/** Test hook — clears the sink-config cache. */
export const resetSinkConfigCacheForTests = (): void => {
  cachedSink = null;
};

// ─── the handler (deps injectable for tests) ──────────────────────────────────────

export type TrackIngestDeps = {
  fetchImpl?: typeof fetch;
  getEventsStore?: (
    event: unknown,
    binding?: SiteBinding
  ) => Promise<{
    get(key: string): Promise<string | null>;
    setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean }): Promise<void | { modified: boolean }>;
  }>;
  getObjectsStore?: (
    event: unknown,
    binding?: SiteBinding
  ) => Promise<{
    get(key: string): Promise<string | null>;
    list(options: { prefix: string }): Promise<unknown>;
  }>;
  nowMs?: () => number;
  env?: Record<string, string | undefined>;
  binding?: SiteBinding;
};

// Warn once per runtime instance, not per beacon — an unset project id is a
// deploy misconfiguration, not per-event news.
let warnedMissingTrackingProjectId = false;

export const createTrackIngestHandler =
  (deps: TrackIngestDeps = {}) =>
  async (event: LambdaEvent) => {
    const env = deps.env ?? process.env;
    const nowMs = deps.nowMs ? deps.nowMs() : Date.now();

    if (event.httpMethod === 'GET') {
      if (event.queryStringParameters?.mode === 'region') {
        return reply(200, { country: readGeo(event).country });
      }
      return reply(400, { error: 'Unsupported GET (only ?mode=region).' });
    }
    if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

    // Same-origin only: a PRESENT foreign Origin is rejected.
    const origin = getHeader(event.headers, 'origin');
    const host = getHeader(event.headers, 'host');
    if (origin && host) {
      try {
        if (new URL(origin).host !== host) return reply(403, { error: 'Cross-origin beacons are not accepted.' });
      } catch {
        return reply(403, { error: 'Malformed Origin.' });
      }
    }

    if (!takeToken(nowMs)) return reply(429, { error: 'Slow down.' });

    if (!event.body) return reply(400, { error: 'A batch body is required.' });
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) return reply(413, { error: 'Batch too large.' });

    // Content-type-agnostic parse (sendBeacon sends text/plain or nothing).
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return reply(400, { error: 'The body must be JSON (a tracking_batch.v1).' });
    }
    const batch = trackingBatchSchema.safeParse(parsedBody);
    if (!batch.success) return reply(400, { error: 'Not a tracking_batch.v1 (schema + events[1..25]).' });

    // Enrichment inputs — the raw IP lives ONLY inside this scope.
    const geo = readGeo(event);
    const ua = getHeader(event.headers, 'user-agent')?.slice(0, 512) ?? null;
    const ip =
      getHeader(event.headers, 'x-nf-client-connection-ip') ??
      getHeader(event.headers, 'x-forwarded-for')?.split(',')[0]?.trim() ??
      '';
    const envProjectId = env.TRACKING_PROJECT_ID?.trim();
    if (!envProjectId && !warnedMissingTrackingProjectId) {
      warnedMissingTrackingProjectId = true;
      console.warn('[track-ingest] TRACKING_PROJECT_ID is unset — tagging events with the site-identity fallback.');
    }
    const projectId = envProjectId || resolveSiteIdentity(env).siteShortId;
    const salt = env.TRACKING_SALT?.trim() || 'dev-salt-unset';
    const utcDate = new Date(nowMs).toISOString().slice(0, 10);
    const { vhash, shash } = computeVisitorHashes({ salt, utcDate, ip, ua: ua ?? '', projectId, nowMs });

    const accepted: TrackingEvent[] = [];
    let dropped = 0;
    for (const candidate of batch.data.events) {
      const client = parseClientTrackingEvent(candidate);
      // Per-event drop, never all-or-nothing; /admin paths are never tracked.
      if (!client || client.url.path.startsWith('/admin')) {
        dropped += 1;
        continue;
      }
      try {
        accepted.push(buildTrackingEvent(client, { projectId, ua, geo, vhash, shash }));
      } catch {
        dropped += 1;
      }
    }

    if (accepted.length > 0) {
      const sink = await loadSinkConfig(event, nowMs, deps);
      const endpoint = env[sink.endpointEnv]?.trim();
      const token = env[sink.authEnv]?.trim();
      let forwarded = false;
      if (endpoint) {
        forwarded = await forwardToSink(deps.fetchImpl ?? fetch, endpoint, token, accepted);
      }
      const shouldMirror = sink.blobMirror === 'always' || (sink.blobMirror === 'fallback' && !forwarded);
      if (shouldMirror) {
        try {
          const store = await (deps.getEventsStore ?? getTrackingEventsBlobStore)(event, deps.binding);
          for (const trackingEvent of accepted) {
            await appendTrackingEvent(store, trackingEvent);
          }
        } catch (error) {
          console.error('Tracking mirror write failed.', error);
        }
      }
    }

    // Fast 202 always; the first pageview's response doubles as the region
    // oracle so steady-state consent gating adds no extra invocation.
    return reply(202, { ok: true, accepted: accepted.length, dropped, country: geo.country });
  };

const forwardToSink = async (
  fetchImpl: typeof fetch,
  endpoint: string,
  token: string | undefined,
  events: readonly TrackingEvent[]
): Promise<boolean> => {
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: toNdjson(events),
      signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false; // no retries — at-most-once, the mirror catches the rest
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => createTrackIngestHandler({ binding });
