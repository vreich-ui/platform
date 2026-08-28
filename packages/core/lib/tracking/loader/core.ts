/**
 * Own-tracker loader CORE (W13, 12-plan §5.1) — the DOM-thin collection
 * engine. Everything stateful and decidable lives here, testable without a
 * browser: event assembly, the batch queue + flush policy, per-page
 * impression/dwell accounting, scroll buckets, the visibility-aware
 * engagement accumulator, article read-progress/completion derivation, and
 * sampling. The thin browser binding (index.ts) feeds it real DOM signals.
 *
 * Identity posture: cookieless, consent-free, ZERO device storage — events
 * carry `visitor.mode` only; visitor/session hashes are computed SERVER-side
 * at ingest (/api/t). The consented-upgrade hook (`setConsent`) exists but
 * stays inert until T13.6 wires the banner; GPC is read once at boot.
 *
 * PII rules: no free strings — labels pass through `slugify` (bounded,
 * lowercase, alnum-dash); hosts through `hostOf`. `/admin` never tracks
 * (double-guarded: boot bail + per-event path check server-side).
 */

import {
  EVENT_ACTIVITY,
  matchActivityGoals,
  matchNamedGoals,
  nativeCalls,
  providerCalls,
  type BridgeProviders,
  type GoalBinding,
  type GoalMapLike,
} from './bridge.js';

export type TrackerDefaults = Partial<Record<string, readonly string[]>> & {
  outbound_links?: boolean;
  utm_capture?: boolean;
};

export type TrackerConfig = {
  ingest_path: string;
  batch: { max_events: number; max_wait_ms: number };
  sample_rate: number;
  defaults: TrackerDefaults;
  /** T13.7: the build-resolved goal map + enabled gtag-family providers. */
  goals?: GoalMapLike;
  providers?: BridgeProviders;
};

export type PageContext = {
  path: string;
  route: string | null;
  /** The page's own object identity (from the render seam). */
  object?: { object_type?: string; object_id?: string };
  /** Present on term pages: the taxonomy term whose route is being viewed. */
  term?: { term_id: string };
  /** Present on article pages: public node count + last node id. */
  article?: { object_id: string; node_count: number; last_node_id: string | null };
};

export type TrackableRef =
  | { kind: 'section'; section_id: string; section_type: string | null }
  | { kind: 'node'; node_id: string; node_kind: string | null };

export type ClientEventShape = Record<string, unknown>;

export type TrackerEnv = {
  /** Deliver one tracking_batch.v1 payload (sendBeacon / fetch-keepalive). */
  send: (path: string, body: string) => void;
  /** T13.7: push one gtag call tuple as a REAL `arguments` object onto
   *  window.dataLayer (gtag.js ignores plain-array pushes). Absent = no
   *  provider fan-out (tests, non-browser). */
  gtagPush?: (args: unknown[]) => void;
  /** T13.8: route one native-platform conversion call to the provider's
   *  queue/function (fbq/_tfa/obApi/_mgq). Absent = no native fan-out. */
  nativePush?: (provider: string, args: unknown[]) => void;
  now: () => number;
  uuid: () => string;
  random: () => number;
  referrer: string | null;
  lang: string | null;
  viewport: () => { w: number; h: number } | null;
  gpc: boolean;
};

export const parseTrackerConfig = (raw: unknown): TrackerConfig => {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const batch = record.batch && typeof record.batch === 'object' ? (record.batch as Record<string, unknown>) : {};
  const maxEvents = typeof batch.max_events === 'number' ? Math.min(Math.max(1, batch.max_events), 25) : 20;
  const maxWait = typeof batch.max_wait_ms === 'number' ? Math.min(Math.max(500, batch.max_wait_ms), 60000) : 10000;
  const sample = typeof record.sample_rate === 'number' ? Math.min(Math.max(0, record.sample_rate), 1) : 1;
  return {
    ingest_path:
      typeof record.ingest_path === 'string' && record.ingest_path.startsWith('/') ? record.ingest_path : '/api/t',
    batch: { max_events: maxEvents, max_wait_ms: maxWait },
    sample_rate: sample,
    defaults: (record.defaults && typeof record.defaults === 'object' ? record.defaults : {}) as TrackerDefaults,
    goals: (record.goals && typeof record.goals === 'object' ? record.goals : undefined) as GoalMapLike | undefined,
    providers: (record.providers && typeof record.providers === 'object' ? record.providers : undefined) as
      | BridgeProviders
      | undefined,
  };
};

export const slugify = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || null;
};

export const hostOf = (href: string): string | null => {
  const match = /^https?:\/\/([^/:?#]+)/i.exec(href);
  return match ? match[1]!.toLowerCase() : null;
};

const SCROLL_BUCKETS = [25, 50, 75, 90, 100] as const;

type SetTimeoutLike = (callback: () => void, ms: number) => unknown;
type ClearTimeoutLike = (handle: unknown) => void;

export const createTracker = (
  config: TrackerConfig,
  env: TrackerEnv,
  timers: { setTimeout: SetTimeoutLike; clearTimeout: ClearTimeoutLike } = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  }
) => {
  const queue: ClientEventShape[] = [];
  let flushTimer: unknown = null;
  let firstPageviewSent = false;

  // Per-page state (reset on pageLoad).
  let page: PageContext = { path: '/', route: null };
  const impressed = new Set<string>();
  const seenNodes = new Set<string>();
  const dwellStart = new Map<string, number>();
  const dwellAcc = new Map<string, number>();
  const bucketsHit = new Set<number>();
  let engagementAcc = 0;
  let engagementStart: number | null = null;
  let completionSent = false;
  let pageEnded = false;

  const consent = { analytics: false, ads: false, gpc: env.gpc };
  let visitorId: string | null = null;

  const collects = (type: string, activity: string): boolean =>
    Array.isArray(config.defaults[type]) && (config.defaults[type] as readonly string[]).includes(activity);

  const sampled = (): boolean => config.sample_rate >= 1 || env.random() < config.sample_rate;

  const refKey = (ref: TrackableRef): string => (ref.kind === 'section' ? `s:${ref.section_id}` : `n:${ref.node_id}`);

  const objectOf = (ref: TrackableRef | null): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    if (page.object?.object_type) out.object_type = page.object.object_type;
    if (page.object?.object_id) out.object_id = page.object.object_id;
    if (ref?.kind === 'section') {
      out.section_id = ref.section_id;
      if (ref.section_type) out.section_type = ref.section_type;
    }
    if (ref?.kind === 'node') {
      out.node_id = ref.node_id;
      if (ref.node_kind) out.node_kind = ref.node_kind;
      if (page.article) {
        out.object_type = 'content_item';
        out.object_id = page.article.object_id;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const push = (
    event: string,
    ref: TrackableRef | null,
    props?: Record<string, unknown>,
    extraObject?: Record<string, string>
  ): void => {
    const shaped: ClientEventShape = {
      event_id: env.uuid(),
      ts: new Date(env.now()).toISOString(),
      event,
      url: { path: page.path, route: page.route },
      consent: { ...consent },
      // Consented mode ONLY while an upgrade id stands (T13.6): analytics
      // grant, GPC off — index.ts owns mint/clear; this stays a pure read.
      visitor: visitorId ? { mode: 'consented', vid: visitorId } : { mode: 'cookieless' },
    };
    const object = extraObject ?? objectOf(ref);
    if (object) shaped.object = object;
    if (props && Object.keys(props).length > 0) shaped.props = props;
    // UTM + referrer ride the FIRST pageview only; the server echoes them
    // onto later events via the session hash — never re-sent.
    if (event === 'pageview' && !firstPageviewSent) {
      firstPageviewSent = true;
      const context: Record<string, unknown> = {};
      if (env.referrer) context.referrer = env.referrer;
      if (config.defaults.utm_capture) {
        const utm = readUtm(page.path, pageSearch);
        if (utm) context.utm = utm;
      }
      const viewport = env.viewport();
      if (viewport) context.viewport = viewport;
      if (env.lang) context.lang = env.lang.slice(0, 35);
      if (Object.keys(context).length > 0) shaped.context = context;
    }
    queue.push(shaped);
    if (queue.length >= config.batch.max_events) flush();
    else if (flushTimer === null) flushTimer = timers.setTimeout(flush, config.batch.max_wait_ms);
  };

  let pageSearch = '';
  const readUtm = (path: string, search: string): Record<string, string> | null => {
    void path;
    if (!search) return null;
    const out: Record<string, string> = {};
    for (const key of ['source', 'medium', 'campaign', 'content', 'term']) {
      const match = new RegExp(`[?&]utm_${key}=([^&]+)`).exec(search);
      if (match) out[key] = decodeURIComponent(match[1]!).slice(0, 128);
    }
    return Object.keys(out).length > 0 ? out : null;
  };

  const flush = (): void => {
    if (flushTimer !== null) {
      timers.clearTimeout(flushTimer);
      flushTimer = null;
    }
    while (queue.length > 0) {
      const events = queue.splice(0, 25);
      env.send(config.ingest_path, JSON.stringify({ schema: 'tracking_batch.v1', events }));
    }
  };

  const settleDwell = (nowMs: number): void => {
    for (const [key, start] of dwellStart) {
      dwellAcc.set(key, (dwellAcc.get(key) ?? 0) + Math.max(0, nowMs - start));
      dwellStart.set(key, nowMs);
    }
  };

  // ── the T13.7 goal→conversion bridge ───────────────────────────────────────
  // Declared goals are never sampled and never gated by the collection matrix
  // (a declared conversion is intent, not telemetry); provider fan-out fires
  // ONLY under an ads-released consent state (unrestricted/granted, GPC off) —
  // the own `goal` event is consent-free like the rest of the cookieless
  // pipeline.
  const fireGoalBindings = (
    bindings: readonly GoalBinding[],
    ref: TrackableRef | null,
    extraObject?: Record<string, string>
  ): void => {
    if (bindings.length === 0) return;
    for (const binding of bindings) {
      const props: Record<string, unknown> = { goal: binding.goal };
      const valueCents = binding.conversions?.find(
        (conversion) => typeof conversion.value_cents === 'number'
      )?.value_cents;
      if (typeof valueCents === 'number') props.value_cents = valueCents;
      push('goal', ref, props, extraObject);
    }
    fanOutProviders(bindings);
  };

  // Both fan-out halves (gtag + native queues), consent-gated as one unit.
  const fanOutProviders = (bindings: readonly GoalBinding[]): void => {
    if (!consent.ads || bindings.length === 0) return;
    if (env.gtagPush) {
      for (const call of providerCalls(bindings, config.providers)) env.gtagPush(call);
    }
    if (env.nativePush) {
      for (const call of nativeCalls(bindings, config.providers)) env.nativePush(call.provider, call.args);
    }
  };

  const bridgeActivity = (activity: string, ref: TrackableRef | null, extraObject?: Record<string, string>): void => {
    const object = extraObject ?? objectOf(ref);
    fireGoalBindings(
      matchActivityGoals(config.goals, activity, [object?.object_id, object?.section_id, object?.term_id]),
      ref,
      extraObject
    );
  };

  return {
    /** astro:page-load — reset per-page state, emit the pageview. */
    pageLoad(context: PageContext, search = ''): void {
      page = context;
      pageSearch = search;
      pageEnded = false;
      impressed.clear();
      seenNodes.clear();
      dwellStart.clear();
      dwellAcc.clear();
      bucketsHit.clear();
      engagementAcc = 0;
      engagementStart = env.now();
      completionSent = false;
      if (page.path.startsWith('/admin')) return; // hard bail — never tracked
      if (collects(page.object?.object_type ?? 'page', 'pageview') || collects('page', 'pageview')) {
        push('pageview', null);
      }
      if (page.term?.term_id && collects('taxonomy', 'term_view')) {
        push('term_view', null, undefined, { object_type: 'taxonomy', term_id: page.term.term_id });
      }
      // T13.7: page-scoped `view` goals + ga4's manual page_view
      // (send_page_view:false in its config — the loader owns navigation
      // truth, so View-Transition swaps count correctly).
      bridgeActivity('view', null);
      if (config.providers?.ga4?.id && env.gtagPush) {
        env.gtagPush(['event', 'page_view', { send_to: config.providers.ga4.id }]);
      }
    },

    /** IntersectionObserver signal: an element crossed the 0.5 threshold. */
    elementVisible(ref: TrackableRef, visible: boolean): void {
      if (page.path.startsWith('/admin')) return;
      const key = refKey(ref);
      const nowMs = env.now();
      if (visible) {
        dwellStart.set(key, nowMs);
        if (!impressed.has(key)) {
          impressed.add(key);
          // Gate on the EVENT KIND ('section_impression') — the schema-legal
          // defaults vocabulary (TRACKING_EVENT_KINDS); bare 'impression' is
          // the goal-activity word, which no valid export can carry here
          // (found by the T13.10 seed: the old gate could never open).
          if (ref.kind === 'section' && collects('section', 'section_impression') && sampled()) {
            push('section_impression', ref);
          }
          if (ref.kind === 'node') {
            seenNodes.add(ref.node_id);
            if (collects('content_item', 'node_impression') && sampled()) push('node_impression', ref);
          }
          bridgeActivity('impression', ref); // declared goals ride the raw signal
          if (ref.kind === 'node' && page.article?.last_node_id && ref.node_id === page.article.last_node_id) {
            if (!completionSent) {
              completionSent = true;
              if (collects('content_item', 'completion')) push('completion', ref);
              bridgeActivity('completion', ref);
            }
          }
        }
      } else if (dwellStart.has(key)) {
        dwellAcc.set(key, (dwellAcc.get(key) ?? 0) + Math.max(0, nowMs - dwellStart.get(key)!));
        dwellStart.delete(key);
      }
    },

    /** Scroll position update → max-bucket events, once each. */
    scroll(scrolledPct: number): void {
      if (page.path.startsWith('/admin') || !collects('page', 'scroll_depth')) return;
      for (const bucket of SCROLL_BUCKETS) {
        if (scrolledPct >= bucket && !bucketsHit.has(bucket)) {
          bucketsHit.add(bucket);
          push('scroll_depth', null, { depth_pct: bucket });
        }
      }
    },

    /** visibilitychange: pause/resume the engagement accumulator. */
    visibility(visible: boolean): void {
      const nowMs = env.now();
      if (!visible && engagementStart !== null) {
        engagementAcc += Math.max(0, nowMs - engagementStart);
        engagementStart = null;
        settleDwell(nowMs);
      } else if (visible && engagementStart === null) {
        engagementStart = nowMs;
      }
    },

    /** A classified click (dom.ts decides the kind + refs). */
    click(
      kind: string,
      ref: TrackableRef | null,
      props?: Record<string, unknown>,
      extraObject?: Record<string, string>
    ): void {
      if (page.path.startsWith('/admin')) return;
      const gate: Record<string, [string, string]> = {
        nav_click: ['navigation', 'nav_click'],
        cta_click: ['section', 'cta_click'],
        buy_click: ['product', 'buy_click'],
        outbound_click: ['page', 'outbound_click'],
        tag_click: ['taxonomy', 'tag_click'],
        form_start: ['section', 'form_start'],
        form_submit: ['section', 'form_submit'],
      };
      // T13.7: declared goals ride the raw click signal, independent of the
      // collection matrix (EVENT_ACTIVITY projects nav_click → cta_click;
      // kinds without a goal activity fall through).
      const activity = EVENT_ACTIVITY[kind];
      if (activity && activity !== 'view') bridgeActivity(activity, ref, extraObject);
      const rule = gate[kind];
      if (rule && !collects(rule[0], rule[1])) {
        if (!(kind === 'outbound_click' && config.defaults.outbound_links)) return;
      }
      push(kind, ref, props, extraObject);
    },

    /** trk:goal CustomEvent — the by-NAME bridge path (T13.7): the own goal
     *  event always; provider conversions only for map-declared goals under
     *  a released ads-consent state. */
    goal(name: string, valueCents?: number): void {
      if (page.path.startsWith('/admin')) return;
      if (!/^[a-z][a-z0-9_]{1,31}$/.test(name)) return;
      const props: Record<string, unknown> = { goal: name };
      if (typeof valueCents === 'number' && Number.isInteger(valueCents) && valueCents >= 0)
        props.value_cents = valueCents;
      push('goal', null, props);
      fanOutProviders(matchNamedGoals(config.goals, name));
    },

    /** Consent flags on outgoing events (GPC beats grant — T13.6 wires this). */
    setConsent(next: { analytics?: boolean; ads?: boolean }): void {
      if (typeof next.analytics === 'boolean') consent.analytics = next.analytics && !consent.gpc;
      if (typeof next.ads === 'boolean') consent.ads = next.ads && !consent.gpc;
    },

    /** The consented-id upgrade (T13.6): a standing `_dlid` flips visitor
     *  mode to `consented`; null (no grant / GPC / revocation) reverts to
     *  cookieless. GPC is absolute — an id can never be set under it. */
    setVisitor(vid: string | null): void {
      visitorId = !consent.gpc && typeof vid === 'string' && vid.length > 0 ? vid : null;
    },

    /** pagehide / astro:before-swap — report dwell + engagement + progress, flush. */
    pageEnd(): void {
      if (pageEnded) return;
      pageEnded = true;
      if (!page.path.startsWith('/admin')) {
        const nowMs = env.now();
        settleDwell(nowMs);
        for (const [key, ms] of dwellAcc) {
          if (ms <= 0 || !sampled()) continue;
          const isSection = key.startsWith('s:');
          if (isSection && collects('section', 'section_dwell')) {
            push(
              'section_dwell',
              { kind: 'section', section_id: key.slice(2), section_type: null },
              { dwell_ms: Math.round(ms) }
            );
          }
          if (!isSection && collects('content_item', 'node_dwell')) {
            push('node_dwell', { kind: 'node', node_id: key.slice(2), node_kind: null }, { dwell_ms: Math.round(ms) });
          }
        }
        if (engagementStart !== null) {
          engagementAcc += Math.max(0, nowMs - engagementStart);
          engagementStart = null;
        }
        if (engagementAcc > 0 && collects('page', 'engagement')) {
          push('engagement', null, { dwell_ms: Math.round(Math.min(engagementAcc, 7_200_000)) });
        }
        if (page.article && page.article.node_count > 0 && collects('content_item', 'read_progress')) {
          const pct = Math.min(100, Math.round((100 * seenNodes.size) / page.article.node_count));
          if (pct > 0) {
            push(
              'read_progress',
              null,
              { pct_read: pct },
              { object_type: 'content_item', object_id: page.article.object_id }
            );
          }
        }
      }
      flush();
    },

    flush,
    /** Test/introspection surface. */
    queueLength: () => queue.length,
  };
};

export type Tracker = ReturnType<typeof createTracker>;
