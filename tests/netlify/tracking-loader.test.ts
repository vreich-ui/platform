/**
 * T13.4 — the own-tracker loader (12-plan §5.1 + §6).
 *
 * The core is DOM-thin by design, so every §6 activity is provable from
 * plain signals: pageview on page-load (with UTM/referrer on the FIRST
 * pageview only), impression-once + dwell accounting per element per
 * pageview, scroll max-buckets once each, visibility-aware engagement,
 * read_progress/completion for articles, delegated click classification
 * (fake elements), goal bridge, batch/flush semantics (max_events,
 * max_wait_ms timer, page-end flush), sampling on impressions/dwell only,
 * /admin hard bail, and the ≤5KB min+gzip size budget on the real built
 * chunk (hard ceiling 6KB; the T13.4 target was 4KB — T13.6/T13.7/T13.8
 * grew the chunk deliberately: consent/id wiring, the goal→conversion
 * bridge, and the native-platform fan-out).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildSync } from 'esbuild';

import {
  createTracker,
  parseTrackerConfig,
  slugify,
  hostOf,
  type TrackerEnv,
} from '../../packages/core/lib/tracking/loader/core.js';
import { classifyClick, trackableRefOf, type ElementLike } from '../../packages/core/lib/tracking/loader/dom.js';

const DEFAULTS = {
  page: ['pageview', 'scroll_depth', 'engagement'],
  // Schema-legal event kinds ONLY (bare 'impression' is goal-activity vocab
  // and can never appear in a validated export — the T13.10 gate fix).
  section: ['section_impression', 'section_dwell', 'cta_click', 'form_start', 'form_submit'],
  content_item: ['node_impression', 'node_dwell', 'read_progress', 'completion'],
  product: ['buy_click'],
  navigation: ['nav_click'],
  taxonomy: ['term_view', 'tag_click'],
  outbound_links: true,
  utm_capture: true,
};

type SentBatch = { path: string; events: Record<string, unknown>[] };

const makeEnv = () => {
  let nowMs = 1_000_000;
  let uuidCount = 0;
  const sent: SentBatch[] = [];
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const env: TrackerEnv = {
    send: (sendPath, body) => {
      const parsed = JSON.parse(body) as { schema: string; events: Record<string, unknown>[] };
      assert.equal(parsed.schema, 'tracking_batch.v1');
      sent.push({ path: sendPath, events: parsed.events });
    },
    now: () => nowMs,
    uuid: () => `00000000-0000-4000-8000-${String(++uuidCount).padStart(12, '0')}`,
    random: () => 0.5,
    referrer: 'https://google.com/',
    lang: 'en-US',
    viewport: () => ({ w: 1200, h: 800 }),
    gpc: false,
  };
  return {
    env,
    sent,
    advance: (ms: number) => {
      nowMs += ms;
    },
    timerApi: {
      setTimeout: (callback: () => void, ms: number) => {
        const handle = { callback, ms, cleared: false };
        timers.push(handle);
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
    fireTimers: () => {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback();
    },
    allEvents: () => sent.flatMap((batch) => batch.events),
  };
};

const CONFIG = parseTrackerConfig({ defaults: DEFAULTS, batch: { max_events: 20, max_wait_ms: 10000 } });

const makeTracker = () => {
  const harness = makeEnv();
  const tracker = createTracker(CONFIG, harness.env, harness.timerApi);
  return { tracker, ...harness };
};

// ═══ pageview + context ═══════════════════════════════════════════════════════

test('pageview fires on page-load; UTM + referrer + viewport ride ONLY the first pageview', () => {
  const { tracker, allEvents, fireTimers } = makeTracker();
  tracker.pageLoad(
    { path: '/learn/library', route: '/learn/library', object: { object_type: 'page', object_id: 'page_library' } },
    '?utm_source=nl&utm_campaign=q3'
  );
  tracker.pageLoad({ path: '/about', route: '/about' });
  fireTimers();
  const pageviews = allEvents().filter((event) => event.event === 'pageview');
  assert.equal(pageviews.length, 2);
  const first = pageviews[0]! as { context?: { utm?: Record<string, string>; referrer?: string }; object?: unknown };
  assert.equal(first.context?.utm?.source, 'nl');
  assert.equal(first.context?.referrer, 'https://google.com/');
  assert.deepEqual(first.object, { object_type: 'page', object_id: 'page_library' });
  assert.equal((pageviews[1]! as { context?: unknown }).context, undefined, 'later pageviews carry no context');
});

test('term pages emit one term_view on page-load and non-term pages emit none', () => {
  const { tracker, allEvents, fireTimers } = makeTracker();
  tracker.pageLoad({
    path: '/learn/topics/barrier',
    route: '/learn/topics/[topicSlug]',
    object: { object_type: 'page', object_id: 'page_topic_detail' },
    term: { term_id: 't_skinbarrier' },
  });
  tracker.pageLoad({ path: '/about', route: '/about', object: { object_type: 'page', object_id: 'page_about' } });
  fireTimers();
  const termViews = allEvents().filter((event) => event.event === 'term_view');
  assert.equal(termViews.length, 1);
  assert.deepEqual((termViews[0] as { object?: unknown }).object, { object_type: 'taxonomy', term_id: 't_skinbarrier' });
});

test('/admin pages never track — hard bail', () => {
  const { tracker, allEvents, fireTimers } = makeTracker();
  tracker.pageLoad({ path: '/admin/agents', route: null });
  tracker.scroll(80);
  tracker.click('cta_click', null);
  tracker.pageEnd();
  fireTimers();
  assert.equal(allEvents().length, 0);
});

// ═══ impressions + dwell ══════════════════════════════════════════════════════

test('impression once per element per pageview; dwell accumulates and reports on page end', () => {
  const { tracker, allEvents, advance } = makeTracker();
  tracker.pageLoad({ path: '/x', route: '/x' });
  const ref = { kind: 'section', section_id: 's_hero1', section_type: 'hero' } as const;
  tracker.elementVisible(ref, true);
  tracker.elementVisible(ref, false);
  tracker.elementVisible(ref, true); // re-entry: NO second impression
  advance(2000);
  tracker.pageEnd();
  const events = allEvents();
  assert.equal(events.filter((event) => event.event === 'section_impression').length, 1);
  const dwell = events.find((event) => event.event === 'section_dwell') as { props?: { dwell_ms?: number } };
  assert.ok(dwell, 'dwell reported at page end');
  assert.ok((dwell.props?.dwell_ms ?? 0) >= 2000, `dwell accumulates visible ms (${dwell.props?.dwell_ms})`);
});

test('article read_progress (pct of public nodes seen) + completion on the last node impression', () => {
  const { tracker, allEvents } = makeTracker();
  tracker.pageLoad({
    path: '/learn/barrier',
    route: '/learn/[slug]',
    article: { object_id: 'req_agent_x_20260719_01', node_count: 4, last_node_id: 'n_d4' },
  });
  tracker.elementVisible({ kind: 'node', node_id: 'n_a1', node_kind: 'content' }, true);
  tracker.elementVisible({ kind: 'node', node_id: 'n_d4', node_kind: 'content' }, true);
  tracker.pageEnd();
  const events = allEvents();
  assert.equal(events.filter((event) => event.event === 'node_impression').length, 2);
  assert.equal(events.filter((event) => event.event === 'completion').length, 1);
  const progress = events.find((event) => event.event === 'read_progress') as { props?: { pct_read?: number } };
  assert.equal(progress?.props?.pct_read, 50, '2 of 4 nodes seen');
});

test('sampling gates impressions/dwell but NEVER pageviews or goals', () => {
  const harness = makeEnv();
  harness.env.random = () => 0.99; // above sample_rate → sampled out
  const tracker = createTracker(
    parseTrackerConfig({ defaults: DEFAULTS, sample_rate: 0.1 }),
    harness.env,
    harness.timerApi
  );
  tracker.pageLoad({ path: '/x', route: null });
  tracker.elementVisible({ kind: 'section', section_id: 's_a', section_type: null }, true);
  tracker.goal('opt_in');
  tracker.pageEnd();
  const events = harness.allEvents();
  assert.ok(
    events.some((event) => event.event === 'pageview'),
    'pageview always 1.0'
  );
  assert.ok(
    events.some((event) => event.event === 'goal'),
    'goals always 1.0'
  );
  assert.ok(!events.some((event) => event.event === 'section_impression'), 'impression sampled out');
});

// ═══ scroll + engagement ══════════════════════════════════════════════════════

test('scroll buckets fire once each at 25/50/75/90/100; engagement is visibility-aware', () => {
  const { tracker, allEvents, advance } = makeTracker();
  tracker.pageLoad({ path: '/x', route: null });
  tracker.scroll(30);
  tracker.scroll(30);
  tracker.scroll(95);
  advance(5000);
  tracker.visibility(false); // hidden for a while — not engaged
  advance(60000);
  tracker.visibility(true);
  advance(1000);
  tracker.pageEnd();
  const events = allEvents();
  assert.deepEqual(
    events
      .filter((event) => event.event === 'scroll_depth')
      .map((event) => (event.props as { depth_pct: number }).depth_pct),
    [25, 50, 75, 90]
  );
  const engagement = events.find((event) => event.event === 'engagement') as { props?: { dwell_ms?: number } };
  assert.ok(engagement);
  assert.ok(
    (engagement.props?.dwell_ms ?? 0) < 10000,
    `hidden time never counts as engagement (${engagement.props?.dwell_ms})`
  );
});

// ═══ batching ═════════════════════════════════════════════════════════════════

test('flush at max_events; timer flush at max_wait_ms; page-end always flushes', () => {
  const harness = makeEnv();
  const tracker = createTracker(
    parseTrackerConfig({ defaults: DEFAULTS, batch: { max_events: 3, max_wait_ms: 1000 } }),
    harness.env,
    harness.timerApi
  );
  tracker.pageLoad({ path: '/x', route: null }); // 1 event queued
  tracker.scroll(30); // +1 (25 bucket)
  assert.equal(harness.sent.length, 0, 'below max_events, nothing sent yet');
  tracker.scroll(55); // +1 = 3 → flush
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]!.events.length, 3);
  assert.equal(harness.sent[0]!.path, '/api/t');

  tracker.scroll(80); // queued
  harness.fireTimers(); // max_wait_ms timer
  assert.equal(harness.sent.length, 2, 'timer flushed the partial batch');

  tracker.scroll(95);
  tracker.pageEnd();
  assert.equal(harness.sent.length, 3, 'page end flushes the tail');
  assert.equal(tracker.queueLength(), 0);
});

// ═══ click classification (fake elements) ═════════════════════════════════════

type FakeNode = {
  attrs: Record<string, string>;
  text?: string;
  tag?: string;
  parent?: FakeNode;
};

const asElement = (node: FakeNode): ElementLike => ({
  closest(selector: string): ElementLike | null {
    const match = (candidate: FakeNode): boolean => {
      const attribute = /\[([a-z-]+)(?:="([^"]*)")?\]/.exec(selector);
      const tagMatch = /^([a-z]+)/.exec(selector);
      if (attribute) {
        const [, name, value] = attribute;
        if (!(name! in candidate.attrs)) return false;
        if (value !== undefined && candidate.attrs[name!] !== value) return false;
        if (tagMatch && selector.startsWith(tagMatch[1]!) && candidate.tag !== tagMatch[1]) return false;
        return true;
      }
      if (tagMatch) return candidate.tag === tagMatch[1];
      return false;
    };
    let current: FakeNode | undefined = node;
    while (current) {
      if (match(current)) return asElement(current);
      current = current.parent;
    }
    return null;
  },
  getAttribute(name: string): string | null {
    return node.attrs[name] ?? null;
  },
  get textContent() {
    return node.text ?? null;
  },
  tagName: node.tag?.toUpperCase(),
});

test('click classification: nav > buy > term > outbound > section CTA; opt-out subtree wins over all', () => {
  const section: FakeNode = { attrs: { 'data-cms-section-id': 's_cta1', 'data-cms-section-type': 'cta_banner' } };
  const anchor: FakeNode = { attrs: { href: '/start-here' }, tag: 'a', text: 'Join Early Access', parent: section };
  const cta = classifyClick(asElement(anchor), 'drlurie.com');
  assert.equal(cta?.kind, 'cta_click');
  assert.deepEqual(cta?.ref, { kind: 'section', section_id: 's_cta1', section_type: 'cta_banner' });
  assert.equal(cta?.props?.label_slug, 'join-early-access');

  const navWrap: FakeNode = { attrs: { 'data-cms-nav-object': 'nav_header' } };
  const navAnchor: FakeNode = { attrs: { href: '/' }, tag: 'a', text: 'Home', parent: navWrap };
  const nav = classifyClick(asElement(navAnchor), 'drlurie.com');
  assert.equal(nav?.kind, 'nav_click');
  assert.deepEqual(nav?.extraObject, { object_type: 'navigation', object_id: 'nav_header' });

  const buyWrap: FakeNode = { attrs: { 'data-cms-buy-product': 'prod_guide' }, parent: section };
  const buyButton: FakeNode = { attrs: {}, tag: 'button', text: 'Buy now', parent: buyWrap };
  assert.equal(classifyClick(asElement(buyButton), 'drlurie.com')?.kind, 'buy_click');

  const outAnchor: FakeNode = { attrs: { href: 'https://example.com/x' }, tag: 'a', text: 'Ref', parent: section };
  const outbound = classifyClick(asElement(outAnchor), 'drlurie.com');
  assert.equal(outbound?.kind, 'outbound_click');
  assert.deepEqual(outbound?.props, { href_host: 'example.com' });

  const optOut: FakeNode = { attrs: { 'data-cms-track': 'off' } };
  const inside: FakeNode = { attrs: { href: 'https://x.com' }, tag: 'a', parent: optOut };
  assert.equal(classifyClick(asElement(inside), 'drlurie.com'), null, 'opt-out subtree emits nothing');

  const termAnchor: FakeNode = {
    attrs: { href: '/learn/topics/x', 'data-cms-term-id': 't_abc' },
    tag: 'a',
    text: 'Barrier',
  };
  assert.equal(classifyClick(asElement(termAnchor), 'drlurie.com')?.kind, 'tag_click');
});

test('trackableRefOf reads the stamped identity attributes; opt-out subtrees excluded', () => {
  const section: FakeNode = { attrs: { 'data-cms-section-id': 's_a', 'data-cms-section-type': 'hero' } };
  assert.deepEqual(trackableRefOf(asElement(section)), { kind: 'section', section_id: 's_a', section_type: 'hero' });
  const node: FakeNode = { attrs: { 'data-cms-node-id': 'n_a1', 'data-cms-node-kind': 'content' } };
  assert.deepEqual(trackableRefOf(asElement(node)), { kind: 'node', node_id: 'n_a1', node_kind: 'content' });
  const off: FakeNode = { attrs: { 'data-cms-track': 'off' } };
  const inside: FakeNode = { attrs: { 'data-cms-section-id': 's_b' }, parent: off };
  assert.equal(trackableRefOf(asElement(inside)), null);
});

// ═══ goal bridge + consent seam ═══════════════════════════════════════════════

test('goal events validate the slug and value; GPC suppresses the consent upgrade', () => {
  const harness = makeEnv();
  harness.env.gpc = true;
  const tracker = createTracker(CONFIG, harness.env, harness.timerApi);
  tracker.pageLoad({ path: '/x', route: null });
  tracker.goal('opt_in', 900);
  tracker.goal('Bad Goal!');
  tracker.setConsent({ analytics: true, ads: true });
  tracker.goal('second_goal');
  tracker.pageEnd();
  const events = harness.allEvents();
  const goals = events.filter((event) => event.event === 'goal');
  assert.equal(goals.length, 2, 'the malformed goal name is refused');
  assert.deepEqual((goals[0] as { props: unknown }).props, { goal: 'opt_in', value_cents: 900 });
  const last = events.at(-1) as { consent: { analytics: boolean; ads: boolean; gpc: boolean } };
  assert.equal(last.consent.gpc, true);
  assert.equal(last.consent.analytics, false, 'GPC always wins — the upgrade is suppressed');
  assert.equal(last.consent.ads, false);
});

// ═══ helpers + size budget ════════════════════════════════════════════════════

test('slugify and hostOf are bounded and conservative', () => {
  assert.equal(slugify('Join Early Access!'), 'join-early-access');
  assert.equal(slugify('  '), null);
  assert.equal(slugify('x'.repeat(100))!.length, 48);
  assert.equal(hostOf('https://Example.COM/path'), 'example.com');
  assert.equal(hostOf('/relative'), null);
  assert.equal(hostOf('javascript:alert(1)'), null);
});

test('SIZE BUDGET: the built loader chunk is ≤5KB min+gzip (hard ceiling 6KB)', () => {
  // Under the ci-test harness this file runs COMPILED from .tmp/ci-test, so
  // resolve the REAL repo root (the nearest ancestor with a package.json that
  // is not the harness dir) and bundle the actual TS source — the exact bytes
  // T13.5's Astro script will ship.
  const here = path.dirname(fileURLToPath(import.meta.url));
  let root = here;
  while (root !== path.dirname(root)) {
    if (
      existsSync(path.join(root, 'package.json')) &&
      existsSync(path.join(root, 'packages/core/lib/tracking/loader/index.ts'))
    ) {
      break;
    }
    root = path.dirname(root);
  }
  const entry = path.join(root, 'packages/core/lib/tracking/loader/index.ts');
  assert.ok(existsSync(entry), `loader entry not found from ${here}`);
  const built = buildSync({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2020',
    write: false,
  });
  const code = built.outputFiles[0]!.contents;
  const gzipped = gzipSync(code).byteLength;
  assert.ok(gzipped <= 6144, `HARD CEILING: loader is ${gzipped}B min+gzip (>6KB)`);
  // 4KB was the T13.4 pre-bridge target; T13.6 (consent/id wiring), T13.7
  // (the goal→conversion bridge), and T13.8 (native fan-out) grew the chunk
  // deliberately — the 6KB ceiling is the hard line.
  assert.ok(gzipped <= 5120, `BUDGET: loader is ${gzipped}B min+gzip (>5KB target)`);
});
