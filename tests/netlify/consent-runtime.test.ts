/**
 * T13.6 — the consent runtime (12-plan §8, OQ-W13-1 ratified 2026-07-19),
 * executed AS SHIPPED: the tests run the same `consentRuntime` function
 * TrackingScripts serializes into the inline bootstrap, against a fake
 * window. Pins: the gate matrix (region × posture × GPC × grant) for
 * gated-script activation + Consent Mode v2 defaults; the unknown-region
 * hold + oracle resolution; the Intl heuristic's keep-held-only law;
 * banner reveal/grant/reject/manage; the #privacy-choices re-open; GPC
 * beats grant; no persistent id before grant (loader half); and the
 * banner markup contract (copy from config, escaped, hidden by default).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConsentBannerHtml, escapeHtml } from '../../packages/core/lib/tracking/consent/banner-html.js';
import {
  consentBootstrapScript,
  consentRuntime,
  type ConsentWindowLike,
} from '../../packages/core/lib/tracking/consent/runtime.js';
import { createTracker, type TrackerEnv } from '../../packages/core/lib/tracking/loader/core.js';
import {
  clearPersistentId,
  PERSISTENT_ID_TTL_MS,
  readOrMintPersistentId,
} from '../../packages/core/lib/tracking/loader/persistent-id.js';

// ═══ the fake window ══════════════════════════════════════════════════════════

type FakeAttr = { name: string; value: string };

class FakeElement {
  hidden = true;
  text = '';
  checked?: boolean;
  activated = false;
  panel: FakeElement | null = null;
  private attrs = new Map<string, string>();
  private matchSelectors: string[] = [];

  withAttrs(attrs: Record<string, string>): this {
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value);
    return this;
  }
  matching(...selectors: string[]): this {
    this.matchSelectors = selectors;
    return this;
  }
  get attributes(): FakeAttr[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  querySelector(selector: string): FakeElement | null {
    return selector === '[data-trk-consent-panel]' ? this.panel : null;
  }
  closest(selector: string): FakeElement | null {
    return this.matchSelectors.includes(selector) ? this : null;
  }
  replaceWith(_other: FakeElement): void {
    this.activated = true;
  }
}

class FakeDocument {
  readyState = 'complete';
  elements = new Map<string, FakeElement>();
  gated: FakeElement[] = [];
  options: FakeElement[] = [];
  dispatched: { type: string; detail?: unknown }[] = [];
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector.includes('data-trk-gate')) return this.gated.filter((gatedScript) => !gatedScript.activated);
    if (selector === '[data-trk-consent-opt]') return this.options;
    return [];
  }
  createElement(): FakeElement {
    const element = new FakeElement();
    element.hidden = false;
    return element;
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatchEvent(event: { type: string; detail?: unknown }): boolean {
    this.dispatched.push(event);
    return true;
  }
  fire(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeCustomEvent {
  detail: unknown;
  constructor(
    public type: string,
    init?: { detail?: unknown }
  ) {
    this.detail = init?.detail;
  }
}

const makeStorage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
};

type HarnessOptions = {
  posture?: string;
  regions?: string[];
  analyticsIdMode?: string;
  honorGpc?: boolean;
  gpc?: boolean;
  storedConsent?: { analytics: boolean; ads: boolean };
  cachedRegion?: string;
  timeZone?: string;
  oracleCountry?: string | null | 'fail';
  withBanner?: boolean;
};

const makeHarness = (options: HarnessOptions = {}) => {
  const doc = new FakeDocument();
  const config = new FakeElement();
  config.text = JSON.stringify({
    ingest_path: '/api/t',
    consent: {
      posture: options.posture ?? 'geo-adaptive',
      regions: options.regions ?? ['DE', 'FR', 'GB', 'CH', 'IL'],
      analytics_id_mode: options.analyticsIdMode ?? 'granted-only',
      gpc: options.honorGpc ?? true,
    },
  });
  doc.elements.set('trk-config', config);
  if (options.withBanner !== false) {
    const banner = new FakeElement();
    banner.panel = new FakeElement();
    doc.elements.set('trk-consent-banner', banner);
  }
  const gatedPixel = new FakeElement().withAttrs({ 'data-trk-gate': 'advertising', src: 'https://ads.example/px.js' });
  doc.gated.push(gatedPixel);

  const localStorage = makeStorage(
    options.storedConsent ? { _dlconsent: JSON.stringify({ ...options.storedConsent, ts: 1, region: null }) } : {}
  );
  const sessionStorage = makeStorage(options.cachedRegion ? { _dlregion: options.cachedRegion } : {});
  const fetchCalls: string[] = [];
  const win = {
    document: doc,
    navigator: { globalPrivacyControl: options.gpc === true },
    localStorage,
    sessionStorage,
    fetch:
      options.oracleCountry === undefined
        ? undefined
        : (url: string) => {
            fetchCalls.push(url);
            if (options.oracleCountry === 'fail') return Promise.reject(new Error('down'));
            return Promise.resolve({ json: () => Promise.resolve({ country: options.oracleCountry }) });
          },
    CustomEvent: FakeCustomEvent,
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: options.timeZone ?? 'America/New_York' }) }) },
    Date: { now: () => 1_750_000_000_000 },
    dataLayer: undefined as unknown[] | undefined,
    __trk: undefined as Record<string, unknown> | undefined,
  };
  consentRuntime(win as unknown as ConsentWindowLike);
  const banner = doc.getElementById('trk-consent-banner');
  return {
    win,
    doc,
    banner,
    gatedPixel,
    fetchCalls,
    localStorage,
    sessionStorage,
    consentState: () => (win.__trk as { consent: Record<string, unknown> }).consent,
    layerCalls: () => (win.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>)),
    settleOracle: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    click: (selectors: string[], attrs: Record<string, string> = {}) => {
      const target = new FakeElement().withAttrs(attrs).matching(...selectors);
      doc.fire('click', { target });
      return target;
    },
  };
};

const deniedDefault = (calls: unknown[][]) =>
  calls.find((call) => call[0] === 'consent' && call[1] === 'default') as
    | [string, string, Record<string, string>]
    | undefined;
const consentUpdate = (calls: unknown[][]) =>
  calls.find((call) => call[0] === 'consent' && call[1] === 'update') as
    | [string, string, Record<string, string>]
    | undefined;

// ═══ the gate matrix ══════════════════════════════════════════════════════════

test('geo-adaptive + known unrestricted region: pixels fire, no defaults, no banner', () => {
  const harness = makeHarness({ cachedRegion: 'US' });
  assert.equal(harness.gatedPixel.activated, true, 'gated pixel activates');
  assert.equal(deniedDefault(harness.layerCalls()), undefined, 'no Consent Mode defaults — tags run ungated');
  assert.equal(harness.banner!.hidden, true, 'no banner outside restricted regions');
  assert.equal(harness.fetchCalls.length, 0, 'cached region — the oracle is not asked again');
  assert.equal(harness.consentState().ads, true);
});

test('geo-adaptive + known restricted region: denied defaults present, pixels held, banner shown', () => {
  const harness = makeHarness({ cachedRegion: 'DE' });
  const defaults = deniedDefault(harness.layerCalls());
  assert.ok(defaults, 'Consent Mode v2 defaults set');
  assert.equal(defaults![2].ad_storage, 'denied');
  assert.equal(defaults![2].ad_personalization, 'denied');
  assert.ok(
    harness.layerCalls().some((call) => call[0] === 'set' && call[1] === 'ads_data_redaction' && call[2] === true),
    'ads_data_redaction set'
  );
  assert.ok(
    harness.layerCalls().some((call) => call[0] === 'set' && call[1] === 'url_passthrough' && call[2] === true),
    'url_passthrough set'
  );
  assert.equal(harness.gatedPixel.activated, false, 'pixels held');
  assert.equal(harness.banner!.hidden, false, 'banner shown');
});

test('geo-adaptive + unknown region: held WITHOUT a banner until the oracle answers', async () => {
  const harness = makeHarness({ oracleCountry: 'US' });
  assert.ok(deniedDefault(harness.layerCalls()), 'unknown = restricted — defaults denied');
  assert.equal(harness.gatedPixel.activated, false, 'held before the oracle answers');
  assert.equal(harness.banner!.hidden, true, 'no banner flash while unknown');
  assert.deepEqual(harness.fetchCalls, ['/api/t?mode=region']);
  await harness.settleOracle();
  assert.equal(harness.gatedPixel.activated, true, 'US answer releases the pixels');
  assert.equal(harness.banner!.hidden, true);
  assert.equal(harness.sessionStorage.map.get('_dlregion'), 'US', 'answer cached for the session');
});

test('geo-adaptive + oracle answers restricted: stays held, banner appears', async () => {
  const harness = makeHarness({ oracleCountry: 'DE' });
  await harness.settleOracle();
  assert.equal(harness.gatedPixel.activated, false);
  assert.equal(harness.banner!.hidden, false, 'banner shown once the region is CONFIRMED restricted');
});

test('geo-adaptive + oracle failure: the hold simply stands', async () => {
  const harness = makeHarness({ oracleCountry: 'fail' });
  await harness.settleOracle();
  assert.equal(harness.gatedPixel.activated, false, 'unanswered oracle = still restricted');
  assert.equal(harness.sessionStorage.map.has('_dlregion'), false);
});

test('consent-first: held with a banner everywhere — even a known-unrestricted region', () => {
  const harness = makeHarness({ posture: 'consent-first', cachedRegion: 'US' });
  assert.equal(harness.gatedPixel.activated, false);
  assert.equal(harness.banner!.hidden, false);
  assert.ok(deniedDefault(harness.layerCalls()));
});

test('us-first: unknown region releases immediately (no banner, no defaults)', () => {
  const harness = makeHarness({ posture: 'us-first', oracleCountry: 'US' });
  assert.equal(harness.gatedPixel.activated, true, 'unknown = unrestricted under us-first');
  assert.equal(deniedDefault(harness.layerCalls()), undefined);
  assert.equal(harness.banner!.hidden, true);
});

test('us-first: the Intl heuristic may KEEP pixels held (Europe/*) — and only the oracle releases', async () => {
  const harness = makeHarness({ posture: 'us-first', timeZone: 'Europe/Berlin', oracleCountry: 'US' });
  assert.equal(harness.gatedPixel.activated, false, 'heuristic keeps the hold');
  assert.ok(deniedDefault(harness.layerCalls()), 'held ⇒ denied defaults');
  await harness.settleOracle();
  assert.equal(harness.gatedPixel.activated, true, 'a US oracle answer releases');
});

test('us-first + confirmed restricted region: suppressed with a banner', () => {
  const harness = makeHarness({ posture: 'us-first', cachedRegion: 'FR' });
  assert.equal(harness.gatedPixel.activated, false);
  assert.equal(harness.banner!.hidden, false);
});

test('a stored grant releases inside a restricted region; a stored reject holds an unrestricted one', () => {
  const granted = makeHarness({ cachedRegion: 'DE', storedConsent: { analytics: true, ads: true } });
  assert.equal(granted.gatedPixel.activated, true, 'stored grant fires the pixels');
  assert.equal(granted.banner!.hidden, true, 'no banner once a choice exists');
  const rejected = makeHarness({ cachedRegion: 'US', storedConsent: { analytics: false, ads: false } });
  assert.equal(rejected.gatedPixel.activated, false, 'an explicit reject is honored everywhere');
});

// ═══ GPC beats everything ═════════════════════════════════════════════════════

test('GPC suppresses in restricted AND unrestricted regions, beats a stored grant, blocks the id upgrade', () => {
  for (const cachedRegion of ['US', 'DE']) {
    const harness = makeHarness({ cachedRegion, gpc: true, storedConsent: { analytics: true, ads: true } });
    assert.equal(harness.gatedPixel.activated, false, `GPC holds pixels in ${cachedRegion} despite the grant`);
    assert.equal(harness.banner!.hidden, true, 'no banner — GPC already decided');
    assert.equal(harness.consentState().ads, false);
    assert.equal(harness.consentState().analytics, false, 'no id upgrade under GPC, ever');
  }
});

test('honor_gpc:false ignores the signal (the config switch is respected)', () => {
  const harness = makeHarness({ cachedRegion: 'US', gpc: true, honorGpc: false });
  assert.equal(harness.gatedPixel.activated, true);
});

// ═══ analytics identity mode ═════════════════════════════════════════════════

test('unrestricted-auto upgrades identity only for a confirmed unrestricted visitor without a choice', async () => {
  const us = makeHarness({ cachedRegion: 'US', analyticsIdMode: 'unrestricted-auto' });
  assert.equal(us.consentState().analytics, true, 'confirmed US visitor may mint an analytics id');

  for (const cachedRegion of ['IL', 'DE']) {
    const restricted = makeHarness({ cachedRegion, analyticsIdMode: 'unrestricted-auto' });
    assert.equal(restricted.consentState().analytics, false, `${cachedRegion} stays cookieless without a choice`);
  }

  const unknown = makeHarness({ oracleCountry: 'US', analyticsIdMode: 'unrestricted-auto' });
  assert.equal(unknown.consentState().analytics, false, 'unknown region is fail-closed');
  await unknown.settleOracle();
  assert.equal(unknown.consentState().analytics, true, 'confirmed US oracle result permits the upgrade');
});

test('unrestricted-auto honors explicit choice and GPC; granted-only remains unchanged', () => {
  const eeaGrant = makeHarness({
    cachedRegion: 'DE',
    analyticsIdMode: 'unrestricted-auto',
    storedConsent: { analytics: true, ads: false },
  });
  assert.equal(eeaGrant.consentState().analytics, true, 'explicit analytics grant works in the EEA');

  const gpc = makeHarness({ cachedRegion: 'US', analyticsIdMode: 'unrestricted-auto', gpc: true });
  assert.equal(gpc.consentState().analytics, false, 'GPC prevents the upgrade everywhere');

  const grantedOnly = makeHarness({ cachedRegion: 'US', analyticsIdMode: 'granted-only' });
  assert.equal(grantedOnly.consentState().analytics, false, 'the compatibility default still requires a grant');
});

// ═══ the banner flow ══════════════════════════════════════════════════════════

test('accept: stores _dlconsent, pushes a granted update (personalization stays denied), activates, hides, dispatches', () => {
  const harness = makeHarness({ cachedRegion: 'DE' });
  assert.equal(harness.banner!.hidden, false);
  harness.click(['[data-trk-consent]'], { 'data-trk-consent': 'accept' });
  const stored = JSON.parse(harness.localStorage.map.get('_dlconsent')!) as Record<string, unknown>;
  assert.equal(stored.ads, true);
  assert.equal(stored.analytics, true);
  assert.equal(stored.region, 'DE');
  const update = consentUpdate(harness.layerCalls());
  assert.ok(update, 'consent update pushed');
  assert.equal(update![2].ad_storage, 'granted');
  assert.equal(update![2].ad_user_data, 'granted');
  assert.equal(update![2].ad_personalization, 'denied', 'personalization needs a TCF CMP — permanently denied');
  assert.equal(update![2].analytics_storage, 'granted');
  assert.equal(harness.gatedPixel.activated, true);
  assert.equal(harness.banner!.hidden, true);
  const signal = harness.doc.dispatched.at(-1) as { type: string; detail: { analytics: boolean; ads: boolean } };
  assert.equal(signal.type, 'trk:consent');
  assert.deepEqual(signal.detail, { analytics: true, ads: true, gpc: false });
});

test('reject: stores the refusal, keeps pixels held, hides the banner', () => {
  const harness = makeHarness({ cachedRegion: 'DE' });
  harness.click(['[data-trk-consent]'], { 'data-trk-consent': 'reject' });
  const stored = JSON.parse(harness.localStorage.map.get('_dlconsent')!) as Record<string, unknown>;
  assert.equal(stored.ads, false);
  assert.equal(harness.gatedPixel.activated, false);
  assert.equal(harness.banner!.hidden, true);
  const update = consentUpdate(harness.layerCalls());
  assert.equal(update![2].ad_storage, 'denied');
});

test('manage toggles the panel; save reads the option checkboxes', () => {
  const harness = makeHarness({ cachedRegion: 'DE' });
  const panel = harness.banner!.panel!;
  assert.equal(panel.hidden, true);
  harness.click(['[data-trk-consent]'], { 'data-trk-consent': 'manage' });
  assert.equal(panel.hidden, false);
  const analyticsOption = new FakeElement().withAttrs({ 'data-trk-consent-opt': 'analytics' });
  analyticsOption.checked = true;
  const adsOption = new FakeElement().withAttrs({ 'data-trk-consent-opt': 'ads' });
  adsOption.checked = false;
  harness.doc.options.push(analyticsOption, adsOption);
  harness.click(['[data-trk-consent]'], { 'data-trk-consent': 'save' });
  const stored = JSON.parse(harness.localStorage.map.get('_dlconsent')!) as Record<string, unknown>;
  assert.equal(stored.analytics, true, 'analytics-only grant saved');
  assert.equal(stored.ads, false);
  assert.equal(harness.gatedPixel.activated, false, 'ads still refused — pixels stay held');
  assert.equal(harness.consentState().analytics, true, 'id upgrade allowed on the analytics grant');
});

test('a #privacy-choices link re-opens the banner (the footer nav affordance)', () => {
  const harness = makeHarness({ cachedRegion: 'DE', storedConsent: { analytics: false, ads: false } });
  assert.equal(harness.banner!.hidden, true, 'a stored choice means no auto-banner');
  harness.click(['a[href$="#privacy-choices"]']);
  assert.equal(harness.banner!.hidden, false);
});

test('View-Transition swaps re-settle: fresh gated scripts activate, a fresh banner re-reveals', () => {
  const released = makeHarness({ cachedRegion: 'US' });
  const lateGated = new FakeElement().withAttrs({ 'data-trk-gate': 'advertising' });
  released.doc.gated.push(lateGated);
  released.doc.fire('astro:page-load');
  assert.equal(lateGated.activated, true, 'a swapped-in gated script activates on page-load');

  const held = makeHarness({ cachedRegion: 'DE' });
  held.banner!.hidden = true; // simulate the swapped-in fresh (hidden) banner
  held.doc.fire('astro:page-load');
  assert.equal(held.banner!.hidden, false, 'the banner re-reveals after a swap');
});

test('no config element: the runtime is a no-op', () => {
  const doc = new FakeDocument();
  const win = { document: doc } as unknown as ConsentWindowLike;
  consentRuntime(win);
  assert.equal((win as { __trk?: unknown }).__trk, undefined);
});

// ═══ the shipped bootstrap string ═════════════════════════════════════════════

test('consentBootstrapScript serializes the tested function into a self-invoking inline script', () => {
  const script = consentBootstrapScript();
  assert.ok(script.endsWith('(window);'));
  assert.ok(script.includes('_dlconsent'), 'the page ships the same storage keys the tests exercised');
  assert.ok(!script.includes('__name('), 'no bundler helper references — the serialization must stay self-contained');
  assert.ok(!script.includes('import '), 'self-contained: no module syntax survives serialization');
});

// ═══ banner markup contract ═══════════════════════════════════════════════════

test('banner markup: copy comes from config, is HTML-escaped, ships hidden with the delegated controls', () => {
  const html = buildConsentBannerHtml({
    headline: 'Privacy & tracking',
    body: 'We measure <conversions> only.',
    accept_label: 'Accept',
    reject_label: 'Decline',
    manage_label: 'Manage',
  });
  assert.ok(html.includes('id="trk-consent-banner" hidden'), 'hidden by default — only the runtime reveals');
  assert.ok(html.includes('Privacy &amp; tracking'));
  assert.ok(html.includes('We measure &lt;conversions&gt; only.'), 'copy is escaped — never markup');
  assert.ok(html.includes('data-trk-consent="accept"'));
  assert.ok(html.includes('data-trk-consent="reject"'));
  assert.ok(html.includes('data-trk-consent="manage"'));
  assert.ok(html.includes('data-trk-consent-panel'));
  assert.ok(html.includes('data-trk-consent-opt="analytics"'));
  assert.ok(html.includes('data-trk-consent-opt="ads"'));
  assert.equal(escapeHtml(`<script>"a"&'b'`), '&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;');
  const noManage = buildConsentBannerHtml({ headline: 'H', body: 'B', accept_label: 'A', reject_label: 'R' });
  assert.ok(!noManage.includes('data-trk-consent="manage"'), 'manage button only with a manage_label');
});

// ═══ the loader half: no persistent id before grant ═══════════════════════════

const trackerEnv = (sent: string[], gpc = false): TrackerEnv => ({
  send: (_path, body) => void sent.push(body),
  now: () => 1_750_000_000_000,
  uuid: () => '3fb14a1c-0000-4000-8000-00000000abcd',
  random: () => 0.5,
  referrer: null,
  lang: null,
  viewport: () => null,
  gpc,
});

const CONFIG = {
  ingest_path: '/api/t',
  batch: { max_events: 25, max_wait_ms: 10000 },
  sample_rate: 1,
  defaults: { page: ['pageview'] },
} as const;

test('events stay cookieless until setVisitor; the upgrade flips mode; null reverts; GPC blocks it absolutely', () => {
  const sent: string[] = [];
  const tracker = createTracker(CONFIG, trackerEnv(sent));
  tracker.pageLoad({ path: '/a', route: null });
  tracker.flush();
  const first = JSON.parse(sent[0]!) as { events: { visitor: { mode: string; vid?: string } }[] };
  assert.deepEqual(first.events[0]!.visitor, { mode: 'cookieless' }, 'no persistent id before grant');

  tracker.setVisitor('4c9a7c1e-1111-4111-8111-000000000042');
  tracker.pageLoad({ path: '/b', route: null });
  tracker.flush();
  const second = JSON.parse(sent[1]!) as { events: { visitor: { mode: string; vid?: string } }[] };
  assert.deepEqual(second.events[0]!.visitor, {
    mode: 'consented',
    vid: '4c9a7c1e-1111-4111-8111-000000000042',
  });

  tracker.setVisitor(null);
  tracker.pageLoad({ path: '/c', route: null });
  tracker.flush();
  const third = JSON.parse(sent[2]!) as { events: { visitor: { mode: string } }[] };
  assert.equal(third.events[0]!.visitor.mode, 'cookieless', 'revocation reverts to cookieless');

  const gpcSent: string[] = [];
  const gpcTracker = createTracker(CONFIG, trackerEnv(gpcSent, true));
  gpcTracker.setVisitor('4c9a7c1e-1111-4111-8111-000000000042');
  gpcTracker.pageLoad({ path: '/d', route: null });
  gpcTracker.flush();
  const gpcBatch = JSON.parse(gpcSent[0]!) as { events: { visitor: { mode: string } }[] };
  assert.equal(gpcBatch.events[0]!.visitor.mode, 'cookieless', 'GPC: an id can never be set');
});

test('_dlid: minted with a FIXED 13-month expiry, reused while standing, re-minted after expiry, cleared on revoke', () => {
  const store = makeStorage();
  const minted: string[] = [];
  const mint = () => {
    const vid = `aaaaaaa${minted.length}-2222-4222-8222-000000000000`;
    minted.push(vid);
    return vid;
  };
  const bootMs = 1_750_000_000_000;
  const first = readOrMintPersistentId(store, bootMs, mint);
  assert.equal(first, minted[0]);
  const record = JSON.parse(store.map.get('_dlid')!) as { vid: string; exp: number };
  assert.equal(record.exp, bootMs + PERSISTENT_ID_TTL_MS, '13-month cap stamped at mint');

  const later = readOrMintPersistentId(store, bootMs + 1000, mint);
  assert.equal(later, first, 'reused while standing');
  assert.equal(
    (JSON.parse(store.map.get('_dlid')!) as { exp: number }).exp,
    bootMs + PERSISTENT_ID_TTL_MS,
    'the expiry is NEVER slid on later visits'
  );

  const expired = readOrMintPersistentId(store, bootMs + PERSISTENT_ID_TTL_MS + 1, mint);
  assert.notEqual(expired, first, 'an expired id is never reused');
  assert.equal(minted.length, 2);

  clearPersistentId(store);
  assert.equal(store.map.has('_dlid'), false, 'revocation clears the device');
});
