/**
 * T21.5 — the loader half: EXACTLY ONE `exposure` per page-load, View
 * Transitions included.
 *
 * This drives the real browser binding (`loader/index.ts`) against a hand-built
 * DOM/window stub rather than the tracker core alone, because the property
 * under test is a LIFECYCLE property: the binding is what listens to
 * `astro:page-load` / `astro:before-swap`, and a client-side navigation never
 * re-executes the module. Testing `tracker.exposure()` in isolation would prove
 * nothing about the navigation that actually ships.
 *
 * The stub is deliberately minimal — only what `startTracker` touches — so it
 * cannot quietly diverge into a second implementation of the loader.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

type Attrs = Record<string, string>;

class StubElement {
  constructor(
    readonly tag: string,
    readonly attrs: Attrs = {},
    public textContent: string | null = null
  ) {}
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name]! : null;
  }
  closest(): StubElement | null {
    return null;
  }
  matches(): boolean {
    return false;
  }
  get text(): string | null {
    return this.textContent;
  }
}

const TRACKER_CONFIG = {
  project: 'drlurie',
  ingest_path: '/api/t',
  // max_events 1: every event flushes on the spot, so the test can observe the
  // queue without firing lifecycle events it isn't testing.
  batch: { max_events: 1, max_wait_ms: 10_000 },
  sample_rate: 1,
  defaults: { page: ['pageview'], content_item: ['pageview'], outbound_links: false, utm_capture: false },
  consent: { posture: 'geo-adaptive', regions: [], gpc: false, analytics_id_mode: 'granted-only' },
  goals: {},
};

const CONTROL = 'req_agent_demo_20260713_01';
const VARIANT_A = 'req_agent_demo_variant_a_20260831_01';
const OTHER_CONTROL = 'req_agent_second_20260713_01';

/** One page's DOM: the tracking config script plus an optional arm marker. */
type PageSpec = { path: string; experiment?: string; variant?: string };

const installStubs = () => {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const sent: { path: string; body: string }[] = [];
  let page: PageSpec = { path: '/demo' };

  const configElement = new StubElement('script', { id: 'trk-config' }, JSON.stringify(TRACKER_CONFIG));

  const markerElement = (): StubElement | null =>
    page.experiment
      ? new StubElement('article', {
          'data-cms-experiment': page.experiment,
          ...(page.variant ? { 'data-cms-variant': page.variant } : {}),
        })
      : null;

  const doc = {
    readyState: 'complete',
    referrer: '',
    body: new StubElement('body'),
    hidden: false,
    getElementById: (id: string) => (id === 'trk-config' ? configElement : null),
    querySelector: (selector: string) => {
      if (selector === '[data-cms-experiment]') return markerElement();
      return null; // no page/object markers: readPageContext degrades cleanly
    },
    querySelectorAll: () => [] as unknown[],
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };

  const win = {
    fetch: () => Promise.resolve({ headers: { get: () => null } }),
    addEventListener: doc.addEventListener,
    innerWidth: 1200,
    innerHeight: 800,
  };

  // Node 22 defines `navigator` as a getter-only global, so plain assignment
  // throws — every stub goes in through defineProperty, and the originals are
  // restored by descriptor so nothing leaks into the rest of the suite.
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const define = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  define('document', doc);
  define('window', win);
  define('location', { get pathname() { return page.path; }, search: '', hostname: 'example.com' });
  define('navigator', {
    language: 'en-US',
    sendBeacon: (path: string, body: string) => {
      sent.push({ path, body });
      return true;
    },
  });
  define('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000000' });
  define('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  define('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  });
  define('addEventListener', win.addEventListener);
  define('innerWidth', 1200);
  define('innerHeight', 800);
  define('scrollY', 0);

  return {
    goTo: (next: PageSpec) => {
      page = next;
    },
    fire: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener({});
    },
    events: () =>
      sent.flatMap((batch) => (JSON.parse(batch.body) as { events: Record<string, unknown>[] }).events),
    restore: () => {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as unknown as Record<string, unknown>)[name];
      }
    },
  };
};

test('exactly one exposure per page-load, and one more after a View Transitions navigation', async () => {
  const stubs = installStubs();
  try {
    stubs.goTo({ path: '/demo', experiment: CONTROL, variant: VARIANT_A });
    const { startTracker } = await import('../../packages/core/lib/tracking/loader/index.js');
    startTracker();

    const exposures = () => stubs.events().filter((event) => event.event === 'exposure');

    // Initial load: startTracker binds immediately (readyState !== 'loading').
    assert.equal(exposures().length, 1, 'the first page-load emits exactly one exposure');
    assert.deepEqual(exposures()[0]!.props, { experiment_id: CONTROL, variant_id: VARIANT_A });

    // A repeated astro:page-load for the SAME page must not double-count — this
    // is the Astro-fires-it-again case (a re-render, a back/forward restore).
    stubs.fire('astro:page-load');
    assert.equal(exposures().length, 1, 'a re-bind of the same page emits nothing further');

    // A View Transitions navigation, in the real order: before-swap fires while
    // the OLD document is still current, the new DOM swaps in, page-load fires.
    // The module never re-executes — only these two listeners run.
    stubs.fire('astro:before-swap');
    stubs.goTo({ path: '/second', experiment: OTHER_CONTROL, variant: OTHER_CONTROL });
    stubs.fire('astro:page-load');
    assert.equal(exposures().length, 2, 'the VT-navigated page emits its own single exposure');
    assert.deepEqual(exposures()[1]!.props, { experiment_id: OTHER_CONTROL, variant_id: OTHER_CONTROL });
    stubs.fire('astro:page-load');
    assert.equal(exposures().length, 2, 'and only one, however often page-load repeats');

    // A page with no arm marker emits nothing at all.
    stubs.fire('astro:before-swap');
    stubs.goTo({ path: '/plain' });
    stubs.fire('astro:page-load');
    assert.equal(exposures().length, 2, 'a non-arm page is untouched by the feature');

    // A marker carrying a non-id value is refused rather than transmitted.
    stubs.fire('astro:before-swap');
    stubs.goTo({ path: '/spoof', experiment: 'page_home', variant: '<script>' });
    stubs.fire('astro:page-load');
    assert.equal(exposures().length, 2, 'a hand-edited DOM cannot inject exposure props');

    // A marker with no variant is incomplete, not half-reported.
    stubs.fire('astro:before-swap');
    stubs.goTo({ path: '/partial', experiment: CONTROL });
    stubs.fire('astro:page-load');
    assert.equal(exposures().length, 2);

    // Every exposure names exactly the two allowlisted props and nothing else.
    for (const exposure of exposures()) {
      assert.deepEqual(Object.keys(exposure.props as object).sort(), ['experiment_id', 'variant_id']);
      assert.equal((exposure.object as unknown) ?? null, null, 'no object ref beyond the props');
    }
  } finally {
    stubs.restore();
  }
});
