/**
 * T13.8 — the CSP hosts-drift gate (12-plan §4): a site's netlify.toml
 * Content-Security-Policy-Report-Only value must equal the documented
 * baseline PLUS exactly the union of that site's ENABLED providers' cspHosts
 * (from that site's own committed tracking export — when one exists — none
 * committed for drlurie today). Drift fails in BOTH directions: an enabled
 * provider whose hosts are missing, and an unexplained host nobody enabled.
 * CSP updates therefore ride the same change that enables a provider.
 *
 * T16.6 — per-site truth (genesis-parity-plan §1.2 item 7): the gate used to
 * read a nonexistent `sites/drlurie/data/site/tracking.json` and only ever
 * check the ROOT netlify.toml — so `platform`, the one site WITH a committed
 * tracking export, was never actually the one being checked; the gate would
 * stay green forever regardless of what platform's own config said. Fixed to
 * pair each real site with ITS OWN tracking export (if committed) and ITS
 * OWN netlify.toml: drlurie via the root netlify.toml (no committed tracking
 * export — zero providers), platform via `sites/platform/netlify.toml` +
 * `sites/platform/data/site/tracking.json`. Plan §1.2 item 4 (`netlify.toml`
 * capability drift): platform's own netlify.toml does not carry a CSP
 * header at all yet — that's T16.2's job, landing separately (possibly
 * concurrently) — so the platform row is a deliberately ANNOTATED
 * expected-fail (`{ todo }`, visible in test output, not silently green)
 * until T16.2 lands, rather than either hiding the gap or turning the whole
 * suite red for a different task's known, tracked work.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { GA4_CSP_HOSTS } from '../../packages/core/lib/tracking/adapters/ga4.js';
import { GOOGLE_ADS_CSP_HOSTS } from '../../packages/core/lib/tracking/adapters/google-ads.js';
import { META_PIXEL_CSP_HOSTS } from '../../packages/core/lib/tracking/adapters/meta-pixel.js';
import { MGID_CSP_HOSTS } from '../../packages/core/lib/tracking/adapters/mgid.js';
import { OUTBRAIN_CSP_HOSTS } from '../../packages/core/lib/tracking/adapters/outbrain.js';
import { TABOOLA_CSP_HOSTS } from '../../packages/core/lib/tracking/adapters/taboola.js';
import { trackingConfigBodySchema } from '../../packages/core/schema/bodies/tracking-config-v1.js';

type HostSets = {
  script: readonly string[];
  connect: readonly string[];
  img: readonly string[];
  frame: readonly string[];
};

type Directive = 'script' | 'connect' | 'frame';

// Every gtag/native ad adapter's contribution, keyed by provider. plausible
// is handled separately (its host is the config's own api_host value).
const ADAPTER_CSP: Record<string, HostSets> = {
  google_ads: GOOGLE_ADS_CSP_HOSTS,
  ga4: GA4_CSP_HOSTS,
  meta_pixel: META_PIXEL_CSP_HOSTS,
  taboola: TABOOLA_CSP_HOSTS,
  outbrain: OUTBRAIN_CSP_HOSTS,
  mgid: MGID_CSP_HOSTS,
};

// The documented all-disabled baseline — netlify.toml's comment block is the
// prose twin of this constant. img-src is deliberately wide (externally
// hosted content images); the pinning directives are script/connect/frame.
const BASE: Record<Directive, readonly string[]> = {
  script: ["'self'", "'unsafe-inline'"],
  connect: ["'self'"],
  frame: ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
};

const repoRoot = (): string => {
  let root = path.dirname(fileURLToPath(import.meta.url));
  while (root !== path.dirname(root)) {
    if (existsSync(path.join(root, 'netlify.toml')) && existsSync(path.join(root, 'packages/core/lib/tracking'))) break;
    root = path.dirname(root);
  }
  return root;
};

/** Parses `relTomlPath`'s CSP-RO header into per-directive host lists, or `null` if that toml has no such header (T16.2's job on sites that don't yet). */
const readPolicyAt = (relTomlPath: string): Record<string, string[]> | null => {
  const full = path.join(repoRoot(), relTomlPath);
  if (!existsSync(full)) return null;
  const toml = readFileSync(full, 'utf8');
  const match = /Content-Security-Policy-Report-Only\s*=\s*"([^"]+)"/.exec(toml);
  if (!match) return null;
  const directives: Record<string, string[]> = {};
  for (const clause of match[1]!.split(';')) {
    const parts = clause.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0) directives[parts[0]!] = parts.slice(1);
  }
  return directives;
};

/** Enabled ad-provider keys per `relTrackingPath`'s committed export (absent path, or no committed export at that path, = none — T16.6: per-site, not hardcoded to drlurie's nonexistent one). */
const enabledProvidersAt = (relTrackingPath?: string): { keys: string[]; plausibleHost?: string } => {
  if (!relTrackingPath) return { keys: [] };
  const exportPath = path.join(repoRoot(), relTrackingPath);
  if (!existsSync(exportPath)) return { keys: [] };
  const raw = JSON.parse(readFileSync(exportPath, 'utf8')) as Record<string, unknown>;
  delete raw.__generated;
  const body = trackingConfigBodySchema.parse(raw);
  const keys = Object.keys(ADAPTER_CSP).filter(
    (key) => (body.providers as Record<string, { enabled?: boolean } | undefined>)[key]?.enabled === true
  );
  return { keys, plausibleHost: body.providers.plausible?.enabled ? body.providers.plausible.api_host : undefined };
};

const expectedHostsFor = (directive: Directive, keys: string[], plausibleHost?: string): Set<string> => {
  const expected = new Set<string>(BASE[directive]);
  for (const key of keys) for (const host of ADAPTER_CSP[key]![directive]) expected.add(host);
  if (plausibleHost && directive !== 'frame') expected.add(plausibleHost);
  return expected;
};

/** The core drift check: given a (possibly missing) parsed policy and a site's enabled providers, what's missing/extra for one directive. Pure — this is what the non-vacuous-gate fixture below exercises directly. */
const driftFor = (
  policy: Record<string, string[]> | null,
  directiveName: string,
  directiveKey: Directive,
  keys: string[],
  plausibleHost?: string
): { missing: string[]; extra: string[] } => {
  const actual = new Set(policy?.[directiveName] ?? []);
  const expected = expectedHostsFor(directiveKey, keys, plausibleHost);
  const missing = [...expected].filter((host) => !actual.has(host));
  const extra = [...actual].filter((host) => !expected.has(host));
  return { missing, extra };
};

const DIRECTIVES = [
  ['script-src', 'script'],
  ['connect-src', 'connect'],
  ['frame-src', 'frame'],
] as const;

type SiteTruth = {
  label: string;
  tomlPath: string;
  trackingPath?: string;
  /** Set when this site's toml is a KNOWN, separately-tracked gap (T16.2) — the test still runs (and its real result is visible in output) but is marked `todo` so the suite stays green until that task lands. */
  expectedFail?: string;
};

const SITES: SiteTruth[] = [
  { label: 'drlurie (root netlify.toml — no committed tracking export)', tomlPath: 'netlify.toml' },
  {
    label: 'platform (sites/platform/netlify.toml + its own tracking.json)',
    tomlPath: 'sites/platform/netlify.toml',
    trackingPath: 'sites/platform/data/site/tracking.json',
    expectedFail: 'T16.2 — platform netlify.toml does not carry the CSP-Report-Only header yet',
  },
];

for (const site of SITES) {
  test(
    `CSP-RO drift, per-site truth — ${site.label}`,
    site.expectedFail ? { todo: site.expectedFail } : {},
    () => {
      const policy = readPolicyAt(site.tomlPath);
      assert.ok(policy, `${site.tomlPath} carries the Content-Security-Policy-Report-Only header`);
      const { keys, plausibleHost } = enabledProvidersAt(site.trackingPath);
      for (const [directiveName, directiveKey] of DIRECTIVES) {
        const { missing, extra } = driftFor(policy, directiveName, directiveKey, keys, plausibleHost);
        assert.deepEqual(
          { missing, extra },
          { missing: [], extra: [] },
          `${site.label} ${directiveName} drift — enabling a provider must add its adapter cspHosts to that site's ` +
            `netlify.toml in the SAME change (and hosts nobody enabled must be removed). Adapter constants: ` +
            `packages/core/lib/tracking/adapters/*.ts`
        );
      }
    }
  );
}

test('fixture: enabling a provider with the CSP-RO header entirely absent is drift, never a vacuous pass', () => {
  // Simulates exactly the failure mode this task closes: a site whose
  // netlify.toml carries no CSP header at all (platform/fernwell's actual
  // state today) that then enables a tracking provider. `driftFor` must
  // report the provider's real hosts as missing — it must be impossible for
  // "no header" plus "a provider enabled" to compute as a pass.
  const { missing, extra } = driftFor(null, 'script-src', 'script', ['ga4']);
  assert.ok(missing.length > 0, 'a provider enabled against a missing CSP header must surface as missing hosts, not a pass');
  for (const host of GA4_CSP_HOSTS.script) {
    assert.ok(missing.includes(host), `ga4's own script host ${host} must be among the reported-missing hosts`);
  }
  assert.deepEqual(extra, [], 'nothing to report as extra when the header itself does not exist');
});

test('fixture: enabling a provider against an unaltered baseline header (CSP not updated) is drift, never a vacuous pass', () => {
  // The realistic version of the same failure: someone flips a provider on
  // in tracking config but does not touch the CSP header in the same
  // change. The baseline-only policy must NOT satisfy the newly-required
  // provider hosts.
  const baselineOnlyPolicy: Record<string, string[]> = {
    'script-src': [...BASE.script],
    'connect-src': [...BASE.connect],
    'frame-src': [...BASE.frame],
  };
  const { missing } = driftFor(baselineOnlyPolicy, 'script-src', 'script', ['ga4']);
  assert.ok(missing.length > 0, 'an un-updated baseline header must show drift once a provider is enabled');
  assert.deepEqual(new Set(missing), new Set(GA4_CSP_HOSTS.script), "the drift must be exactly ga4's own missing hosts");
});

test('CSP-RO structural posture (root/drlurie): default-src self, object-src none, base-uri self, img-src wide-but-present', () => {
  const policy = readPolicyAt('netlify.toml');
  assert.ok(policy, 'root netlify.toml carries the Content-Security-Policy-Report-Only header');
  assert.deepEqual(policy!['default-src'], ["'self'"]);
  assert.deepEqual(policy!['object-src'], ["'none'"]);
  assert.deepEqual(policy!['base-uri'], ["'self'"]);
  for (const source of ["'self'", 'data:', 'https:']) {
    assert.ok(policy!['img-src']?.includes(source), `img-src carries ${source}`);
  }
  assert.ok(policy!['style-src']?.includes('https://fonts.googleapis.com'), 'Google Fonts stylesheet allowed');
  assert.ok(policy!['font-src']?.includes('https://fonts.gstatic.com'), 'Google Fonts files allowed');
});

test('every ad adapter publishes https-only hosts for the drift union', () => {
  for (const [provider, hosts] of Object.entries(ADAPTER_CSP)) {
    for (const directive of ['script', 'connect', 'img', 'frame'] as const) {
      for (const host of hosts[directive]) {
        assert.match(host, /^https:\/\/[a-z0-9.-]+$/, `${provider}.${directive}: ${host}`);
      }
    }
    assert.ok(hosts.script.length > 0 || hosts.connect.length > 0, `${provider} contributes at least one host`);
  }
});
