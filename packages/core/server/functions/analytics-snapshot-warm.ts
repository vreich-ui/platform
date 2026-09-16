/**
 * Function name: Analytics_Snapshot_Warm (M4) — scheduled, hourly at minute 47.
 *
 * The guarantee behind `snapshots/analytics/<source>/<range>.json`.
 *
 * M4 made `/admin/analytics` serve those blobs and refresh them in the
 * background when they age past `ANALYTICS_SNAPSHOT_MAX_AGE_MS`. The
 * background refresh is an OPTIMISATION and must not be mistaken for the
 * guarantee: this runtime freezes a function container the moment its response
 * is written, so a promise still in flight resumes only when that container is
 * next invoked — which on a rarely-opened admin page may be hours, or never.
 * This function is what makes the bound real without anybody's page load
 * paying for it.
 *
 * ## What it refreshes, and what it deliberately does not
 *
 * The `(source, range)` pairs come from the CLIENT, not from a list invented
 * here: `ANALYTICS_WARM_RANGES` is `ANALYTICS_RANGE_OPTIONS` minus `custom`
 * (7d / 30d / 90d — the three a bare visit, a `?range=` bookmark or the
 * remembered range in `localStorage` can resolve to), and
 * `ANALYTICS_WARM_SOURCES` is `netlify` and `own`, both of which the page
 * fetches on mount whichever tab is active.
 *
 * A pair is refreshed when it is the DEFAULT range (`30d`) or when a blob for
 * it already exists — `shouldWarmTarget`. Refreshing all six unconditionally
 * would have a tenant nobody has opened in a month spending 33 Netlify
 * Analytics calls an hour, forever, on ranges nobody has ever selected,
 * against an API that is undocumented and presumably rate-limited. This makes
 * the cost proportional to use and still leaves a cold tenant's first visit
 * warm on the range it actually opens.
 *
 * `custom` is never warmed: it is one operator's ad-hoc span, and
 * materialising it would be manufacturing upstream traffic for a window that
 * may never be asked for again.
 *
 * ## The 30 s wall (REVIEW2)
 *
 * A SCHEDULED function is killed at 30 s and Netlify logs nothing when it
 * happens — no timeout line, no `Duration:` line, no JSON from the function
 * itself. This fleet has already paid for that once: `media-compaction-sweep`
 * spent three days being killed mid-run while its log was indistinguishable
 * from "the schedule never fired" (DEPLOYMENT.md, and
 * `media-compaction-run.ts:SWEEP_BUDGET_MS`). A pass here is up to six serial
 * upstream fan-outs, each call bounded at 6 s in two dependent layers, so it
 * can reach that wall — and this function is the GUARANTEE behind the whole
 * M4 mechanism, so a silent kill would mean analytics quietly stopped
 * refreshing at all.
 *
 * Two mitigations, both cheap: `ANALYTICS_WARM_BUDGET_MS` stops the pass
 * STARTING new pairs past 20 s and reports them as `deferred`, and
 * `analyticsWarmTargets` puts the default range's two feeds first so a short
 * pass never defers the pair a bare visit opens. The proper fix if the
 * upstream keeps slowing is the dispatcher/background split
 * `media-compaction-sweep` took — recorded as `KNOWN_ISSUES.md` #75 rather
 * than built now, because a background function is a public endpoint and wants
 * the one-shot token that comes with it.
 *
 * ## Invocation cost — stated, per KNOWN_ISSUES #72
 *
 * 1 firing per hour x 24 = **24 invocations per tenant per day**, and the
 * fleet is six tenants (root/drlurie plus the five `sites/*`), so **144
 * scheduled invocations per day** are added by this function.
 *
 * Upstream per pass, steady state on a tenant that only ever opens the
 * default: 11 Netlify Analytics calls (the `/pageviews` layer, the previous
 * window, two rankings, one bandwidth probe) plus one tracking-sink call.
 * That is 264 Netlify Analytics calls per tenant per day, 1,584 fleet-wide.
 * A tenant that keeps all three ranges warm on both feeds pays 33 + 3 per
 * pass: 792 Netlify Analytics calls per tenant per day, 4,752 fleet-wide, and
 * that is the ceiling.
 *
 * What it removes: `/admin/analytics` measured 4.9 s per view, of which
 * `netlify_upstream_pageviews` was 2151 ms — eleven upstream calls, on the
 * page path, PER VIEW, with a memo that could never hit because its key
 * carried a millisecond-precision window (see `analytics/snapshot-view.ts`).
 *
 * Minute 47, not `0`: `*\/5` (mcp-keepalive, editorial-request-sweep) and
 * `*\/2` (release-snapshot-refresh) both fire on the hour, `object-index-rebuild`
 * holds minute 23, `governance-probe-refresh` holds 4/9/14/…/59, and the two
 * daily sweeps hold 03:17 and 03:41. 47 is clear of all of them, and being odd
 * it is clear of `*\/2` as well.
 *
 * Declared per site in netlify.toml (`[functions."analytics-snapshot-warm"]
 * schedule = "47 * * * *"`) — a scheduled function only runs if its schedule
 * is DECLARED (P1: every `sites/<client>/netlify.toml` carries the block, and
 * so does the `create-site.mjs` scaffold).
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getAnalyticsViewsBlobStore } from '../lib/blob-store.js';
import { resolveDateWindow } from '../../lib/admin/analytics-logic.js';
import {
  analyticsWarmTargets,
  readAnalyticsSnapshot,
  refreshAnalyticsSnapshot,
  shouldWarmTarget,
  ANALYTICS_WARM_BUDGET_MS,
  type AnalyticsSnapshotStore,
} from '../lib/analytics/snapshot-store.js';

export const runAnalyticsSnapshotWarm = async (
  event: unknown,
  nowMs = Date.now(),
  binding?: SiteBinding,
  options: { budgetMs?: number; clock?: () => number } = {}
) => {
  if (!binding) throw new Error('analytics-snapshot-warm requires a SiteBinding.');
  const store = (await getAnalyticsViewsBlobStore(event, binding)) as unknown as AnalyticsSnapshotStore;
  const siteHost = process.env.URL || undefined;

  const refreshed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const deferred: string[] = [];

  /**
   * REVIEW2 — THE WALL. Netlify kills a scheduled function at 30 s and logs
   * NOTHING when it does (`media-compaction-run.ts:SWEEP_BUDGET_MS`, and the
   * three days of dead `media-compaction-sweep` runs DEPLOYMENT.md records).
   * This pass does up to six upstream fan-outs serially, each of which
   * `netlify-analytics.ts` bounds at 6 s per call in two dependent layers, so
   * it can reach that wall on a tenant that keeps all three ranges warm — and
   * if it did, the one function that is supposed to GUARANTEE the freshness
   * bound would be failing silently, with `failed: []` never printed because
   * the line never gets written.
   *
   * So the pass watches its own clock and stops STARTING pairs past the
   * budget. A deferred pair is served stale with a stated `as_of` and is first
   * in line next hour; `analyticsWarmTargets` puts the default range's two
   * feeds at the front so they are never the ones deferred.
   */
  const clock = options.clock ?? Date.now;
  const budgetMs = options.budgetMs ?? ANALYTICS_WARM_BUDGET_MS;
  const startedAt = clock();
  const outOfTime = () => clock() - startedAt >= budgetMs;

  // SERIAL on purpose. These are the calls this milestone exists to keep off
  // a page path; firing six fan-outs at once against an undocumented,
  // presumably rate-limited API would be trading one kind of trouble for
  // another.
  for (const { source, range } of analyticsWarmTargets()) {
    const label = `${source}/${range}`;
    if (outOfTime()) {
      deferred.push(label);
      continue;
    }
    const existing = await readAnalyticsSnapshot(store, source, range);
    if (!shouldWarmTarget(range, existing)) {
      skipped.push(label);
      continue;
    }
    const windowResult = resolveDateWindow(range, new Date(nowMs));
    if (!windowResult.ok) {
      failed.push(label);
      continue;
    }
    try {
      await refreshAnalyticsSnapshot(store, {
        source,
        range,
        window: windowResult.window,
        nowMs,
        binding,
        ...(siteHost !== undefined ? { siteHost } : {}),
      });
      refreshed.push(label);
    } catch (error) {
      // One feed failing must not cost the others their pass.
      console.warn(`analytics-snapshot-warm: ${label} failed.`, error);
      failed.push(label);
    }
  }

  return {
    ok: true,
    at: new Date(nowMs).toISOString(),
    refreshed,
    /** Pairs nobody has opened yet — the bound that keeps a dormant tenant cheap. */
    skipped,
    /**
     * The number the operator should watch. A pair failing every pass means
     * the upstream is down or the credentials moved; the page degrades to a
     * stale snapshot with a stated `as_of`, never to a wrong zero.
     */
    failed,
    /**
     * REVIEW2 — pairs this pass ran out of clock for. Never the default range
     * (see `analyticsWarmTargets`). Persistently non-empty means the upstream
     * has slowed enough that this function wants the dispatcher/background
     * split `media-compaction-sweep` took — `KNOWN_ISSUES.md` #75.
     */
    deferred,
  };
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: unknown) => {
  try {
    const result = await runAnalyticsSnapshotWarm(event, Date.now(), binding);
    console.log(JSON.stringify({ ts: result.at, event: 'analytics_snapshot_warm', ...result }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Analytics snapshot warm failed.', error);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false }) };
  }
};

/** Per-site factory — the site shim instantiates this with its binding (the `membership-sweep` pattern). */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
