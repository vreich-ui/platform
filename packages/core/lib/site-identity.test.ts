/**
 * Site-identity resolver (pre-W11 dehardcode) — the byte-compat gate and the
 * lockstep guard:
 *
 *   - for Dr-Lurie, every resolved value equals the pre-parameterization
 *     literal EXACTLY (external MCP connectors key on serverInfo.name; the
 *     pdf-tool grant wire format pins projectId; GitHub UA prefixes and the
 *     kugelmedia asset URLs feed the byte-identical build);
 *   - the committed config stays in lockstep with the site export
 *     (sites/drlurie/data/site/site.json — W11 T11.6 relocated this from
 *     src/data/site/site.json) — same stance as the site-seed drift guard;
 *   - a second tenant gets the id conventions (tax_/trk_<shortId>, slug as
 *     pdf projectId) and every env override wins over the config.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// W11 T11.3: this suite is the DRLURIE byte-compat gate — it asserts the
// committed site config resolves to the pre-parameterization literals. It
// therefore registers the real site bindings (tests are exempt from the
// zero-drlurie core lint per the ratified carve-out, 2026-07-22).
import '../../../sites/drlurie/config/policy-bindings.js';
import { siteIdentityConfig } from '../../../sites/drlurie/config/site-identity.js';
import { siteIdentityConfig as fernwellIdentity } from '../../../sites/fernwell/config/site-identity.js';
import { siteIdentityConfig as platformIdentity } from '../../../sites/platform/config/site-identity.js';
import { siteIdentityConfig as zilbermanIdentity } from '../../../sites/zilberman/config/site-identity.js';
import {
  AGGRESSION_CEILING_DIALS,
  getSiteIdentity,
  resolveSiteIdentity,
  type AggressionCeiling,
} from './site-identity.js';

// The compiled test runs from a temp dir; ascend to the repo root to read the
// committed production export.
const findExport = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, 'sites', 'drlurie', 'data', 'site', 'site.json');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('could not locate sites/drlurie/data/site/site.json');
};

test('Dr-Lurie values resolve exactly to the pre-parameterization literals (byte-compat gate)', () => {
  assert.deepEqual(resolveSiteIdentity({}), {
    siteId: 'site_drlurie',
    siteShortId: 'drlurie',
    siteSlug: 'dr-lurie',
    brandName: 'Dr. Lurié Skincare',
    taxonomyId: 'tax_drlurie',
    trackingProjectId: 'trk_drlurie',
    mcpServerName: 'Dr_Lurie_MCP_Server',
    mcpDiagnosticName: 'Dr_Lurie_Science_MCP',
    assetHost: 'https://kugelmedia.netlify.app',
    assetFolder: 'drlurieblog',
    pdfToolProjectId: 'dr-lurie',
    cmsAgentProjectId: 'dr-lurie',
    // W11 T11.5 additions — pinned in the committed config so the
    // de-hardcoded core resolves byte-identically.
    adminLabel: 'Dr. Lurié admin',
    committerName: 'Dr. Lurié Publisher',
    committerEmail: 'publisher@drlurie.local',
    // W6 §2: the committed aggression ceiling passes through untouched.
    aggressionCeiling: { claim_strength: 0.45, urgency: 0.1, emotional_agitation: 0.15, cta_density: 0.2 },
  });
});

test('the config stays in lockstep with the committed site export (drift guard)', () => {
  const exported = JSON.parse(readFileSync(findExport(), 'utf8')) as {
    __generated?: { from?: string };
    name?: string;
  };
  const identity = resolveSiteIdentity({});
  assert.equal(exported.__generated?.from, `objects/site/by-id/${identity.siteId}.json`);
  assert.equal(exported.name, identity.brandName);
});

test('a second tenant gets the id conventions from its siteId and slug', () => {
  const identity = resolveSiteIdentity(
    { SITE_OBJECT_ID: 'site_acme', SITE_SLUG: 'acme-skin' },
    { ...siteIdentityConfig, pdfToolProjectId: undefined, cmsAgentProjectId: undefined }
  );
  assert.equal(identity.siteShortId, 'acme');
  assert.equal(identity.taxonomyId, 'tax_acme');
  assert.equal(identity.trackingProjectId, 'trk_acme');
  assert.equal(identity.pdfToolProjectId, 'acme-skin');
  assert.equal(identity.cmsAgentProjectId, 'acme-skin');
});

test('the committed site-to-artifact-project mapping wins over slug inference', () => {
  const identity = resolveSiteIdentity(
    {},
    {
      ...siteIdentityConfig,
      siteId: 'site_acme',
      siteSlug: 'acme-site',
      pdfToolProjectId: 'acme-artifacts',
    }
  );
  assert.equal(identity.pdfToolProjectId, 'acme-artifacts');
});

test('every env override wins over the committed config', () => {
  const identity = resolveSiteIdentity({
    SITE_OBJECT_ID: 'site_acme',
    SITE_SLUG: 'acme',
    SITE_BRAND_NAME: 'Acme Skincare',
    SITE_TAXONOMY_ID: 'tax_custom',
    SITE_TRACKING_PROJECT_ID: 'trk_custom',
    MCP_SERVER_NAME: 'Acme_MCP_Server',
    MCP_SERVER_DIAGNOSTIC_NAME: 'Acme_Diag_MCP',
    SITE_ASSET_HOST: 'https://assets.acme.example',
    SITE_ASSET_FOLDER: 'acmeblog',
    PDF_TOOL_PROJECT_ID: 'acme-pdf',
    CMS_AGENT_PROJECT_ID: 'acme-cms',
  });
  assert.deepEqual(identity, {
    siteId: 'site_acme',
    siteShortId: 'acme',
    siteSlug: 'acme',
    brandName: 'Acme Skincare',
    taxonomyId: 'tax_custom',
    trackingProjectId: 'trk_custom',
    mcpServerName: 'Acme_MCP_Server',
    mcpDiagnosticName: 'Acme_Diag_MCP',
    assetHost: 'https://assets.acme.example',
    assetFolder: 'acmeblog',
    pdfToolProjectId: 'acme-pdf',
    cmsAgentProjectId: 'acme-cms',
    // No env overrides exist for these (by design: committer env is honored in
    // object-git-committer, not the resolver) — the committed config wins.
    adminLabel: 'Dr. Lurié admin',
    committerName: 'Dr. Lurié Publisher',
    committerEmail: 'publisher@drlurie.local',
    aggressionCeiling: { claim_strength: 0.45, urgency: 0.1, emotional_agitation: 0.15, cta_density: 0.2 },
  });
});

test('empty or whitespace env values are ignored, never resolved', () => {
  const identity = resolveSiteIdentity({
    SITE_OBJECT_ID: '  ',
    MCP_SERVER_NAME: '',
    PDF_TOOL_PROJECT_ID: '\t',
    CMS_AGENT_PROJECT_ID: '  ',
  });
  assert.equal(identity.siteId, 'site_drlurie');
  assert.equal(identity.mcpServerName, 'Dr_Lurie_MCP_Server');
  assert.equal(identity.pdfToolProjectId, 'dr-lurie');
  assert.equal(identity.cmsAgentProjectId, 'dr-lurie');
});

test('a malformed config throws loudly instead of resolving to defaults', () => {
  assert.throws(
    () => resolveSiteIdentity({}, { siteId: 'not-a-site-id' }),
    /Invalid site-identity config \(src\/config\/site-identity\.ts\)/
  );
});

test('getSiteIdentity resolves from process.env over the committed config', () => {
  assert.equal(getSiteIdentity().siteId, 'site_drlurie');
});

// ─── W6 §2: aggression ceiling ──────────────────────────────────────────────────────────────────────────

const ALL_SITE_IDENTITY_CONFIGS: Record<string, unknown> = {
  drlurie: siteIdentityConfig,
  fernwell: fernwellIdentity,
  platform: platformIdentity,
  zilberman: zilbermanIdentity,
};

test('every committed site identity carries a valid aggression ceiling (all four dials, finite, 0..1)', () => {
  for (const [site, config] of Object.entries(ALL_SITE_IDENTITY_CONFIGS)) {
    const identity = resolveSiteIdentity({}, config);
    assert.ok(identity.aggressionCeiling, `${site}: site-identity.ts must set aggressionCeiling`);
    const ceiling: AggressionCeiling = identity.aggressionCeiling;
    for (const dial of AGGRESSION_CEILING_DIALS) {
      const value = ceiling[dial];
      assert.equal(typeof value, 'number', `${site}.${dial} must be a number`);
      assert.ok(Number.isFinite(value), `${site}.${dial} must be finite`);
      assert.ok(value >= 0 && value <= 1, `${site}.${dial} must be within [0, 1]`);
    }
    assert.deepEqual(Object.keys(ceiling).sort(), [...AGGRESSION_CEILING_DIALS].sort(), `${site}: exactly four dials`);
  }
});

test('the ruled per-site ceilings are pinned (drlurie/fernwell conservative; platform/zilberman moderate)', () => {
  const conservative = { claim_strength: 0.45, urgency: 0.1, emotional_agitation: 0.15, cta_density: 0.2 };
  const moderate = { claim_strength: 0.55, urgency: 0.2, emotional_agitation: 0.2, cta_density: 0.3 };
  assert.deepEqual(resolveSiteIdentity({}, siteIdentityConfig).aggressionCeiling, conservative);
  assert.deepEqual(resolveSiteIdentity({}, fernwellIdentity).aggressionCeiling, conservative);
  assert.deepEqual(resolveSiteIdentity({}, platformIdentity).aggressionCeiling, moderate);
  assert.deepEqual(resolveSiteIdentity({}, zilbermanIdentity).aggressionCeiling, moderate);
});

test('a malformed aggression ceiling is refused at resolve time with a clear per-dial error', () => {
  const withCeiling = (aggressionCeiling: unknown) => ({ ...siteIdentityConfig, aggressionCeiling });
  assert.throws(() => resolveSiteIdentity({}, withCeiling({ ...siteIdentityConfig.aggressionCeiling, urgency: 1.5 })), /urgency/);
  assert.throws(() => resolveSiteIdentity({}, withCeiling({ ...siteIdentityConfig.aggressionCeiling, cta_density: -0.1 })), /cta_density/);
  assert.throws(() => resolveSiteIdentity({}, withCeiling({ ...siteIdentityConfig.aggressionCeiling, claim_strength: Number.NaN })), /claim_strength/);
  assert.throws(
    () => resolveSiteIdentity({}, withCeiling({ claim_strength: 0.5, urgency: 0.5, emotional_agitation: 0.5 })),
    /cta_density/
  );
  assert.throws(() => resolveSiteIdentity({}, withCeiling({ ...siteIdentityConfig.aggressionCeiling, extra: 1 })), /Invalid aggressionCeiling/);
  assert.throws(() => resolveSiteIdentity({}, withCeiling('0.5')), /Invalid aggressionCeiling/);
});
