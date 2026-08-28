/**
 * T13.5 — the TrackingScripts render seam (12-plan §4), tested through its
 * PURE halves (the component itself is a thin shell; its renders-nothing-
 * without-an-export behavior is proven by the task's build-diff EMPTY gate):
 * client-config assembly (project id from the trk_ convention, own-block
 * knobs, goal map contents), the adapter results (enabled-only; the
 * write+render regex double enforcement THROWS at build on a drifted ID),
 * and the data-cms-track="off" emission across all three annotation sites
 * (page-level, shared-object-level, article nodes).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderArticleNodes } from '../../packages/core/lib/article-object/render-nodes.js';
import { contentItemBodySchema } from '../../packages/core/schema/bodies/content-item-v1.js';
import {
  assembleAdapterHeads,
  buildGoalMap,
  buildTrackerClientConfig,
  parseTrackingExport,
} from '../../packages/core/lib/tracking/assemble.js';
import { ownAdapter } from '../../packages/core/lib/tracking/adapters/own.js';
import { plausibleAdapter } from '../../packages/core/lib/tracking/adapters/plausible.js';
import { AdapterIdError, reassertId } from '../../packages/core/lib/tracking/adapters/types.js';
import { resolveSections, type ResolvePageDeps } from '../../packages/core/lib/renderer/resolve.js';
import { sectionAnnotationAttrs } from '../../packages/core/lib/renderer/section-annotations.js';
import type { TrackingConfigBody } from '../../packages/core/schema/bodies/tracking-config-v1.js';

const trackingBody = (overrides: Partial<TrackingConfigBody['providers']> = {}): TrackingConfigBody =>
  parseTrackingExport({
    providers: {
      own: {
        enabled: true,
        consent_class: 'essential',
        ingest_path: '/api/t',
        sample_rate: 0.5,
        batch: { max_events: 15, max_wait_ms: 8000 },
      },
      ...overrides,
    },
    consent: {
      posture: 'geo-adaptive',
      restricted_regions: ['DE', 'GB'],
      honor_gpc: true,
      analytics_id_mode: 'unrestricted-auto',
    },
    defaults: {
      page: ['pageview'],
      section: ['section_impression'],
      content_item: ['node_impression'],
      product: ['buy_click'],
      navigation: ['nav_click'],
      taxonomy: ['term_view'],
      outbound_links: true,
      utm_capture: true,
    },
  });

// ═══ config assembly ══════════════════════════════════════════════════════════

test('client config: project from trk_<project>, own-block knobs, consent + defaults carried', () => {
  const config = buildTrackerClientConfig('trk_drlurie', trackingBody(), []);
  assert.equal(config.project, 'drlurie');
  assert.equal(config.ingest_path, '/api/t');
  assert.deepEqual(config.batch, { max_events: 15, max_wait_ms: 8000 });
  assert.equal(config.sample_rate, 0.5);
  assert.deepEqual(config.consent, {
    posture: 'geo-adaptive',
    regions: ['DE', 'GB'],
    gpc: true,
    analytics_id_mode: 'unrestricted-auto',
  });
  assert.deepEqual(config.defaults.page, ['pageview']);
});

test('goal map carries ONLY objects with goals or enabled:false — label/tags never leave the export', () => {
  const map = buildGoalMap([
    { object_id: 'page_home', tracking: { goals: [{ goal: 'opt_in', on: 'view' }] } },
    { object_id: 'sec_quiet', tracking: { enabled: false } },
    { object_id: 'page_plain', tracking: { enabled: true } },
    { object_id: 'page_none' },
    {
      object_id: 'prod_guide',
      tracking: { enabled: false, goals: [{ goal: 'buy' }], label: 'SECRET', tags: ['SECRET'] } as never,
    },
  ]);
  assert.deepEqual(Object.keys(map).sort(), ['page_home', 'prod_guide', 'sec_quiet']);
  assert.deepEqual(map.page_home, { goals: [{ goal: 'opt_in', on: 'view' }] });
  assert.deepEqual(map.sec_quiet, { enabled: false });
  assert.ok(!JSON.stringify(map).includes('SECRET'), 'label/tags are reporting-only — never in the page');
});

test('parseTrackingExport THROWS on a drifted export (loud, the site-object stance)', () => {
  assert.throws(() => parseTrackingExport({ providers: {}, consent: 'nope', defaults: {} }));
});

// ═══ adapters ═════════════════════════════════════════════════════════════════

test('adapters emit for enabled providers only; the ID regex re-asserts at render and THROWS on drift', () => {
  assert.equal(ownAdapter({ enabled: true }).cspHosts.connect[0], "'self'");
  assert.equal(ownAdapter({ enabled: false }).cspHosts.connect.length, 0);
  assert.equal(ownAdapter(undefined).head, '');

  assert.equal(plausibleAdapter(undefined, { siteHost: 'drlurie.com' }).head, '');
  assert.equal(plausibleAdapter({ enabled: false, api_host: 'https://p.io' }, { siteHost: 'drlurie.com' }).head, '');
  const live = plausibleAdapter(
    { enabled: true, api_host: 'https://plausible.example.com' },
    { siteHost: 'drlurie.com' }
  );
  assert.match(live.head, /script\.manual\.js/, 'manual mode per the VT discipline');
  assert.match(live.head, /data-domain="drlurie\.com"/);
  assert.deepEqual(live.cspHosts.script, ['https://plausible.example.com']);

  assert.throws(
    () => plausibleAdapter({ enabled: true, api_host: 'https://evil.com/x.js"><script>' }, { siteHost: 'x' }),
    AdapterIdError,
    'a drifted export cannot smuggle script text — the build fails'
  );
  assert.throws(() => reassertId('ga4', 'measurement_id', 'UA-1234', /^G-[A-Z0-9]{4,14}$/), AdapterIdError);

  const heads = assembleAdapterHeads(trackingBody(), 'drlurie.com');
  assert.equal(heads.length, 1, 'own only — plausible stays dormant');
  assert.equal(heads[0]!.head, '', 'own is headless (the loader mounts as a real Astro script)');
});

// ═══ data-cms-track="off" emission ════════════════════════════════════════════

const heroSection = { id: 's_hero1', type: 'hero' as const, data: { heading: 'Hi', actions: [] } };
const deps: ResolvePageDeps = {
  resolveSharedSection: (objectId: string) =>
    objectId === 'sec_quiet'
      ? { type: 'prose' as const, data: { body: 'x' }, trackingOff: true }
      : { type: 'prose' as const, data: { body: 'x' } },
} as ResolvePageDeps;

test('page-level tracking.enabled:false marks every inline section wrapper off', () => {
  const sections = resolveSections([heroSection], deps, { trackingOff: true });
  const attrs = sectionAnnotationAttrs('page_home', sections[0]!);
  assert.equal(attrs['data-cms-track'], 'off');
  const normal = resolveSections([heroSection], deps);
  assert.equal(sectionAnnotationAttrs('page_home', normal[0]!)['data-cms-track'], undefined);
});

test('a shared section object with tracking off carries the flag through the shared_ref', () => {
  const sections = resolveSections(
    [
      { id: 's_ref1', type: 'shared_ref' as const, data: { section: 'sec_quiet' } },
      { id: 's_ref2', type: 'shared_ref' as const, data: { section: 'sec_loud' } },
    ] as never,
    deps
  );
  assert.equal(sectionAnnotationAttrs('page_home', sections[0]!)['data-cms-track'], 'off');
  assert.equal(sectionAnnotationAttrs('page_home', sections[1]!)['data-cms-track'], undefined);
});

test('an article with tracking.enabled:false stamps off on every node wrapper', () => {
  const body = contentItemBodySchema.parse({
    slug: 'x',
    title: 'X',
    tracking: { enabled: false },
    nodes: [
      { id: 'n_a1', kind: 'content', public: { body: 'One.' } },
      { id: 'n_a2', kind: 'content', public: { body: 'Two.' } },
    ],
  });
  const { html } = renderArticleNodes('req_agent_x_20260719_01', body);
  assert.equal((html.match(/data-cms-track="off"/g) ?? []).length, 2);
  const onBody = contentItemBodySchema.parse({
    slug: 'x',
    title: 'X',
    nodes: [{ id: 'n_a1', kind: 'content', public: { body: 'One.' } }],
  });
  assert.ok(!renderArticleNodes('req_agent_x_20260719_01', onBody).html.includes('data-cms-track'));
});
