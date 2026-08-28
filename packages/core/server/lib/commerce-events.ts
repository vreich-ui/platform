/**
 * Commerce event log — `commerce_event.v1` (06-shop-module-plan §6).
 *
 * The substrate contract for the unknown downstream consumer. Rules, binding:
 *
 * - Events are IMMUTABLE and never deleted: `appendCommerceEvent` refuses to
 *   overwrite an existing key (create-if-absent), and nothing in this module
 *   can update or remove one.
 * - Evolution is additive-only: new `type` values and new OPTIONAL fields.
 *   Bump to `commerce_event.v2` only for breaking shape changes (and then
 *   dual-write during the transition).
 * - Every type carries the same envelope (actor/subject/context/data).
 * - Server-side events (completed / issued / downloaded / abandoned /
 *   mismatch) are authoritative; client-side ones (`product_viewed`,
 *   `checkout_started` via the sendBeacon capture function) are best-effort
 *   and lossy by design. The public capture endpoint accepts ONLY the
 *   client-authored types, so authoritative events cannot be forged from a
 *   browser.
 * - PII-minimized: the actor carries at most an anonymous id and a
 *   `sha256:<hex>` email hash — RAW email lives only in order records
 *   (commerce-orders.ts), never in the event log.
 *
 * Layout mirrors the proven opt-ins capture store (save-opt-in.ts):
 * `events/<yyyy-mm-dd>/<ts>-<uuid>.json`, with the timestamp compacted to
 * digits (colons/dots stripped) so keys stay filename-safe on the local
 * file-backed fallback store while preserving lexicographic time order.
 *
 * Blobs is not a queryable database and this module does not pretend it is:
 * there are no read/aggregate helpers here on purpose (§8.6).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { sha256Hex } from './crypto.js';

export const COMMERCE_EVENT_SCHEMA_VERSION = 'commerce_event.v1';

export const commerceEventTypes = [
  'product_viewed',
  'checkout_started',
  'checkout_completed',
  'fulfillment_issued',
  'download_succeeded',
  'fulfillment_reissued',
  'checkout_abandoned',
  'amount_mismatch',
] as const;
export type CommerceEventType = (typeof commerceEventTypes)[number];

/** The only types the PUBLIC capture endpoint may write (best-effort, lossy). */
export const clientCommerceEventTypes = ['product_viewed', 'checkout_started'] as const;
export type ClientCommerceEventType = (typeof clientCommerceEventTypes)[number];

export const isClientCommerceEventType = (value: string): value is ClientCommerceEventType =>
  (clientCommerceEventTypes as readonly string[]).includes(value);

const EMAIL_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/** `sha256:<hex>` of the normalized (trimmed, lowercased) address. */
export const hashEmail = (email: string): string => `sha256:${sha256Hex(email.trim().toLowerCase())}`;

// JSON-safe values for the additive `data` payload (no undefined, no
// functions) — consumers must be able to JSON.parse every event forever.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

export const commerceEventSchema = z
  .object({
    schema: z.literal(COMMERCE_EVENT_SCHEMA_VERSION),
    event_id: z.uuid(),
    ts: z.iso.datetime(),
    type: z.enum(commerceEventTypes),
    actor: z
      .object({
        anon_id: z.string().min(1).nullable(),
        email_hash: z.string().regex(EMAIL_HASH_RE, { message: 'email_hash must be sha256:<64 hex>' }).nullable(),
      })
      .strict(),
    subject: z
      .object({
        product_id: z.string().min(1).nullable(),
        order_id: z.string().min(1).nullable(),
        session_id: z.string().min(1).nullable(),
      })
      .strict(),
    context: z
      .object({
        path: z.string().nullable(),
        referrer: z.string().nullable(),
        ua: z.string().nullable(),
      })
      .strict(),
    // Additive-only payload (amount_cents/currency/mode today; more later).
    data: z.record(z.string(), jsonValueSchema),
  })
  .strict();
export type CommerceEvent = z.infer<typeof commerceEventSchema>;

export type NewCommerceEventInput = {
  type: CommerceEventType;
  actor?: Partial<CommerceEvent['actor']>;
  subject?: Partial<CommerceEvent['subject']>;
  context?: Partial<CommerceEvent['context']>;
  data?: CommerceEvent['data'];
  /** Injectable for deterministic tests; defaults to now/randomUUID. */
  event_id?: string;
  ts?: string;
};

/** Build a fully-enveloped, validated event; absent envelope slots are explicit nulls. */
export const newCommerceEvent = (input: NewCommerceEventInput): CommerceEvent =>
  commerceEventSchema.parse({
    schema: COMMERCE_EVENT_SCHEMA_VERSION,
    event_id: input.event_id ?? randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
    type: input.type,
    actor: { anon_id: null, email_hash: null, ...input.actor },
    subject: { product_id: null, order_id: null, session_id: null, ...input.subject },
    context: { path: null, referrer: null, ua: null, ...input.context },
    data: input.data ?? {},
  });

/**
 * `events/<yyyy-mm-dd>/<compact-ts>-<event_id>.json` — date directory from
 * the event's OWN ts (the opt-ins layout), timestamp compacted to digits so
 * the key is filename-safe and time-sorts within the day.
 */
export const commerceEventKey = (event: Pick<CommerceEvent, 'ts' | 'event_id'>): string => {
  const date = event.ts.slice(0, 10);
  const compactTs = event.ts.replace(/\D/g, ''); // 20260712120000000 — digits only, time-sorted
  return `events/${date}/${compactTs}-${event.event_id}.json`;
};

type EventStore = {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean }): Promise<void | { modified: boolean }>;
};

export type AppendCommerceEventResult = { key: string; appended: boolean };

const COMMERCE_SINK_TIMEOUT_MS = 2_000;

type CommerceSinkEnv = Partial<Pick<NodeJS.ProcessEnv, 'TRACKING_SINK_URL' | 'TRACKING_SINK_TOKEN'>>;

export type CommerceEventForwardOptions = {
  env?: CommerceSinkEnv;
  fetchImpl?: typeof fetch;
  timeoutSignal?: (delay: number) => AbortSignal;
};

/**
 * Best-effort owner-DB forwarding after the durable blob append. The caller
 * deliberately does not await this work: sink latency or failure must never
 * change the commerce response (especially Stripe webhook acknowledgements).
 */
const forwardCommerceEventToSink = async (
  event: CommerceEvent,
  options: CommerceEventForwardOptions = {}
): Promise<void> => {
  const env = options.env ?? process.env;
  const endpoint = env.TRACKING_SINK_URL?.trim();
  const token = env.TRACKING_SINK_TOKEN?.trim();
  if (!endpoint || !token) return;

  try {
    await (options.fetchImpl ?? fetch)(`${endpoint.replace(/\/+$/, '')}/commerce`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${token}`,
      },
      body: `${JSON.stringify(event)}\n`,
      signal: (options.timeoutSignal ?? AbortSignal.timeout)(COMMERCE_SINK_TIMEOUT_MS),
    });
  } catch {
    // At-most-once best effort: the append-only blob remains authoritative.
  }
};

/**
 * Append one validated event, create-if-absent. `onlyIfNew` makes the write
 * atomic on Netlify Blobs; the pre-read guards the local file-backed store
 * (which ignores set options) and makes replays an explicit no-op either way.
 * Never overwrites — events are immutable (§6).
 */
export const appendCommerceEvent = async (
  store: EventStore,
  event: CommerceEvent,
  forwardOptions: CommerceEventForwardOptions = {}
): Promise<AppendCommerceEventResult> => {
  const parsed = commerceEventSchema.parse(event);
  const key = commerceEventKey(parsed);
  if ((await store.get(key)) !== null) return { key, appended: false };
  const result = await store.setJSON(key, parsed, { onlyIfNew: true });
  if (result && typeof result === 'object' && result.modified === false) return { key, appended: false };
  void forwardCommerceEventToSink(parsed, forwardOptions);
  return { key, appended: true };
};
