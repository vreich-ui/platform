/**
 * M4 — the READ half of `snapshots/analytics/<source>/<range>.json`: the key,
 * the shape, the one blob read, and the staleness bound the
 * stale-while-revalidate rule is written against. No Netlify Analytics client,
 * no tracking sink, no object store.
 *
 * ## The defect this removes
 *
 * `/admin/analytics` measured 4.9 s, of which `sec.netlify = 2861` and inside
 * it `sec.netlify_upstream_pageviews = 2151`. That is Netlify's own Analytics
 * API — eleven calls in two dependent layers — on the page path, per view, for
 * data that does not change minute to minute.
 *
 * It has a TTL memo. The memo has never worked for a preset range, and this is
 * the finding that makes the milestone necessary rather than merely nice:
 * `resolveDateWindow('30d', new Date())` returns `to = Date.now()` to the
 * MILLISECOND, and the memo key is `${siteId}:${range}:${window.from}:${window.to}:…`.
 * Two page loads a second apart produce two different keys. So every load
 * missed, every load paid eleven upstream calls, and the same defect sat in
 * the browser cache above it (`analytics:netlify:${window.from}:${window.to}`
 * in `AnalyticsWorkspace.tsx`). A blob keyed by `(source, range)` — with the
 * window it was BUILT for carried inside the body rather than baked into the
 * key — is the fix, and it is the whole fix.
 *
 * ## Why this is a separate file from `snapshot-store.ts`
 *
 * The same cut `release/snapshot-view.ts` and `governance/snapshot-view.ts`
 * make. `snapshot-store.ts` is the builder, so it statically reaches
 * `netlify-analytics.ts`, `own-tracker-stats.ts`, `analytics-object-directory.ts`
 * and the object store. A module that only needs to READ a snapshot — and any
 * future one that does — imports this file and pays for none of it.
 */
import { z } from 'zod';

import type { AnalyticsRangeKey } from '../../../lib/admin/analytics-logic.js';

export const ANALYTICS_SNAPSHOT_SCHEMA_VERSION = 'analytics-snapshot.v1';

/**
 * Which feeds get a blob. Deliberately NOT `AnalyticsSource` from the client:
 * that union also carries `insights`, which has no range, no window and no
 * upstream cost worth materialising (`fetchAnalyticsInsights` is already
 * range-free and its own memo key is a constant — the one memo on this
 * function that does hit).
 */
export type AnalyticsSnapshotSource = 'netlify' | 'own';

/**
 * ONE BLOB PER `(source, range)`.
 *
 * Not per window: the window slides with the clock, and keying on it is
 * exactly the bug this milestone removes (see the header). The window the
 * snapshot was built for travels INSIDE it, so a reader always knows which
 * days it is looking at and a chart never claims a span it did not fetch.
 */
export const analyticsSnapshotKey = (source: AnalyticsSnapshotSource, range: AnalyticsRangeKey): string =>
  `snapshots/analytics/${source}/${range}.json`;

/**
 * How old a blob may be before a read triggers a BACKGROUND refresh.
 *
 * Ten minutes, matching `RELEASE_SNAPSHOT_MAX_AGE_MS` and the browser's own
 * `CACHED_RESOURCE_MAX_AGE_MS`. Past this bound the blob is still SERVED —
 * that is what stale-while-revalidate means, and it is the difference between
 * this and every cache on this page before it: the reader never waits for the
 * refresh, so an eleven-call upstream fan-out can never land on a page load
 * again. The hourly warm (`functions/analytics-snapshot-warm.ts`) is what
 * guarantees the bound is usually met without anybody's page load paying for
 * it.
 */
export const ANALYTICS_SNAPSHOT_MAX_AGE_MS = 10 * 60_000;

const windowSchema = z.object({
  from: z.number(),
  to: z.number(),
  resolution: z.enum(['hour', 'day']),
});

export const analyticsSnapshotSchema = z.object({
  schema_version: z.literal(ANALYTICS_SNAPSHOT_SCHEMA_VERSION),
  /** When the FACTS were gathered. Restated on the wire so a lagging feed is visible, never silent. */
  as_of: z.string(),
  source: z.enum(['netlify', 'own']),
  range: z.enum(['7d', '30d', '90d', 'custom']),
  /** The window these facts cover — built at `as_of`, not at read time. */
  window: windowSchema,
  /**
   * The response body the branch used to compute inline, stored verbatim.
   *
   * A LOOSE record on purpose, and for the reason `objects/index-doc.ts`
   * keeps `row` loose: this is a cache of a wire shape that will keep
   * growing fields, and a future field must degrade to a re-read, never to a
   * parse failure that breaks the page. The shape itself is defined once, by
   * the builder in `snapshot-store.ts` — writing it twice is how the two
   * spellings drift.
   */
  body: z.record(z.string(), z.unknown()),
});
export type AnalyticsSnapshot = z.infer<typeof analyticsSnapshotSchema>;

/** The store subset both halves need — `getAnalyticsViewsBlobStore`'s shape, narrowed. */
export interface AnalyticsSnapshotStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<unknown>;
}

// ═══ the read ═════════════════════════════════════════════════════════════

/**
 * ONE blob read. `undefined` covers absent, unreadable, unparseable and
 * written-by-another-schema alike — every one of them means "build it", which
 * is the same answer every other snapshot in this wave gives.
 */
export const readAnalyticsSnapshot = async (
  store: AnalyticsSnapshotStore,
  source: AnalyticsSnapshotSource,
  range: AnalyticsRangeKey
): Promise<AnalyticsSnapshot | undefined> => {
  let raw: string | null;
  try {
    raw = await store.get(analyticsSnapshotKey(source, range));
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const parsed = analyticsSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/**
 * REVIEW2 — does this blob answer the window that was ASKED FOR?
 *
 * For a PRESET range the answer is always yes by construction: `7d`/`30d`/`90d`
 * name a span, the clock slides the endpoints, and serving a blob built a few
 * minutes ago under a window that now ends a few minutes later is exactly the
 * staleness `as_of` states. That is the whole design.
 *
 * `custom` is not like that, and keying it by the range alone was a defect
 * rather than a lag: `snapshots/analytics/own/custom.json` is ONE key for every
 * custom span anybody has ever picked. An operator who looked at
 * 2026-01-01→2026-01-07 wrote that blob; the next operator asking for
 * 2026-06-01→2026-06-30 read it back, inside `ANALYTICS_SNAPSHOT_MAX_AGE_MS`,
 * as fresh — June's dashboard painted with January's numbers, and past the
 * bound it kept painting them while the background refresh rebuilt the blob for
 * a window the reader had already been given the wrong answer for. A snapshot
 * whose window does not match is not stale, it is about something else, so a
 * caller must treat it as absent and build.
 *
 * Bounds only, never `resolution`: that is derived from the span, so two windows
 * with the same endpoints cannot disagree about it.
 */
export const analyticsSnapshotCoversWindow = (
  snapshot: AnalyticsSnapshot,
  range: AnalyticsRangeKey,
  window: { from: number; to: number }
): boolean => range !== 'custom' || (snapshot.window.from === window.from && snapshot.window.to === window.to);

export const analyticsSnapshotAgeMs = (snapshot: AnalyticsSnapshot, nowMs: number): number => {
  const asOf = Date.parse(snapshot.as_of);
  return Number.isFinite(asOf) ? nowMs - asOf : Number.POSITIVE_INFINITY;
};

/** Fresh enough that a read need not kick a background refresh. An unparseable `as_of` is never fresh. */
export const isAnalyticsSnapshotFresh = (snapshot: AnalyticsSnapshot, nowMs: number): boolean =>
  analyticsSnapshotAgeMs(snapshot, nowMs) <= ANALYTICS_SNAPSHOT_MAX_AGE_MS;
