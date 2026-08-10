/**
 * W15 S2 — tests for the fleet admin-parity machinery
 * (packages/core/cli/admin-parity.mjs + scripts/audit-site-admin-parity.mjs
 * + migrate-site's --admin-parity mode).
 *
 * Plain, uncompiled node:test files run directly against the real repo (the
 * discover-fleet-matrix.test.mjs pattern) — deliberately, because the parity
 * tooling's whole contract is "works on a raw checkout".
 *
 * Three layers:
 *   1. parsers + canonical-table sanity (pure);
 *   2. genesis parity BY CONSTRUCTION: a freshly scaffolded site passes the
 *      audit with zero gaps;
 *   3. the repair loop: degrade a scaffold the ways an older site really
 *      drifted (missing shims, the pre-S1 admin splat, no keepalive
 *      schedule, no reader loaders), prove --admin-parity --write restores
 *      parity, and prove a second run is a no-op (idempotency).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ADMIN_CONTENT_REWRITE,
  ADMIN_CRITICAL_ENV,
  CANONICAL_INFRA_REDIRECTS,
  CANONICAL_TOML_POSTURE,
  STALE_ADMIN_CONTENT_FROM,
  computeAdminParity,
  parseNetlifyTomlRedirects,
  parseSiteConfigRedirects,
  parseShellRoutePatterns,
  planAdminParityFixes,
  renderParityReport,
  repoRoot,
  resolveAuditTarget,
  scanCoreBlobStoreNames,
} from '../../packages/core/cli/admin-parity.mjs';
import {
  buildPlan,
  writeFiles,
  CORE_BLOB_STORES,
  ENV_CHECKLIST,
  SITE_BINDING_CAPABILITY_FLAGS,
} from '../../packages/core/cli/create-site.mjs';
import { runAdminParity } from '../../packages/core/cli/migrate-site.mjs';
import { discoverTargets } from '../../scripts/audit-site-admin-parity.mjs';

// ─── 1. canonical table + parsers ───────────────────────────────────────────

test('the canonical infra table ends on the S1 admin rewrite: single segment, status 200, UNFORCED', () => {
  assert.deepEqual(ADMIN_CONTENT_REWRITE, {
    from: '/admin/content/:objectId',
    to: '/admin/content/__workspace',
    status: 200,
    force: false,
  });
  assert.ok(!CANONICAL_INFRA_REDIRECTS.some((r) => r.from === STALE_ADMIN_CONTENT_FROM));
  // The OAuth authorization-server surface (W14 F10) is fully represented:
  // 4 well-known metadata rules + 5 endpoint rules.
  assert.equal(CANONICAL_INFRA_REDIRECTS.filter((r) => r.to.includes('mcp-oauth')).length, 9);
});

test('parseNetlifyTomlRedirects reads from/to/status/force out of [[redirects]] blocks', () => {
  const toml = [
    '[build]',
    '  publish = "dist"',
    '[[redirects]]',
    '  from = "/mcp"',
    '  to = "/.netlify/functions/mcp"',
    '  status = 200',
    '  force = true',
    '',
    '[[redirects]]',
    '  from = "/admin/content/:objectId"',
    '  to = "/admin/content/__workspace"',
    '  status = 200',
  ].join('\n');
  assert.deepEqual(parseNetlifyTomlRedirects(toml), [
    { from: '/mcp', to: '/.netlify/functions/mcp', status: 200, force: true },
    { from: '/admin/content/:objectId', to: '/admin/content/__workspace', status: 200, force: false },
  ]);
});

test('parseSiteConfigRedirects reads single-line AND wrapped entries, ignoring comments', () => {
  const src = [
    'export const siteConfig = siteConfigSchema.parse({',
    '  redirects: [',
    "    { from: '/mcp', to: '/.netlify/functions/mcp', status: 200 },",
    '    {',
    "      from: '/.well-known/oauth-protected-resource',",
    "      to: '/.netlify/functions/mcp-oauth?oauth_endpoint=protected-resource-metadata',",
    '      status: 200,',
    '    },',
    '    // a comment between entries',
    "    { from: '/blog', to: '/learn/library', status: 301 },",
    '  ],',
    '});',
  ].join('\n');
  assert.deepEqual(parseSiteConfigRedirects(src), [
    { from: '/mcp', to: '/.netlify/functions/mcp', status: 200 },
    {
      from: '/.well-known/oauth-protected-resource',
      to: '/.netlify/functions/mcp-oauth?oauth_endpoint=protected-resource-metadata',
      status: 200,
    },
    { from: '/blog', to: '/learn/library', status: 301 },
  ]);
});

test('the real shell-routes.ts carries the full admin route surface the audit requires', () => {
  const patterns = parseShellRoutePatterns();
  for (const route of [
    '/admin',
    '/admin/content',
    '/admin/content/[objectId]',
    '/admin/agents',
    '/admin/authorize',
    '/admin/templates',
    '/admin/media',
    '/admin/release',
  ]) {
    assert.ok(patterns.includes(route), `expected shell route ${route}`);
  }
});

test('CORE_BLOB_STORES covers every store literal core actually references (the agent-profiles class of gap)', () => {
  const literals = scanCoreBlobStoreNames();
  assert.ok(literals.includes('agent-profiles'), 'expected the dedicated-agent store literal to be found');
  assert.ok(literals.includes('users') && literals.includes('governance') && literals.includes('agent-chats'));
  const unprobed = literals.filter((name) => !CORE_BLOB_STORES.includes(name));
  assert.deepEqual(unprobed, [], `store literals never probed by create-site provisioning: ${unprobed.join(', ')}`);
});

test('every admin-critical env row the audit requires is declared in create-site’s checklist', () => {
  const names = ENV_CHECKLIST.flatMap((g) => g.rows.map((r) => r.name));
  for (const row of ADMIN_CRITICAL_ENV.filter((e) => e.checklist)) {
    assert.ok(names.includes(row.name), `expected ${row.name} in ENV_CHECKLIST`);
  }
});

// ─── binding-capability (T16.3) ──────────────────────────────────────────────

test('SITE_BINDING_CAPABILITY_FLAGS is non-empty and the create-site template emits every flag as `true`', () => {
  assert.ok(SITE_BINDING_CAPABILITY_FLAGS.length > 0);
  const plan = buildPlan({ name: 'binding-capability-probe' });
  const bindingFile = plan.files.find((f) => f.path === 'sites/binding-capability-probe/config/site-binding.ts');
  assert.ok(bindingFile, 'expected the scaffold to emit config/site-binding.ts');
  for (const flag of SITE_BINDING_CAPABILITY_FLAGS) {
    assert.match(bindingFile.content, new RegExp(`\\b${flag}\\s*:\\s*true\\b`), `template must declare ${flag}: true`);
  }
});

test('binding-capability: every real tenant’s config/site-binding.ts declares the full capability flag set', () => {
  for (const targetArg of discoverTargets()) {
    const checks = computeAdminParity(resolveAuditTarget(targetArg));
    const check = checks.find((c) => c.id === 'binding-capability');
    assert.ok(check, `expected a binding-capability check for ${targetArg}`);
    assert.equal(check.status, 'PASS', `${targetArg}: ${check.detail}`);
  }
});

test('binding-capability surfaces a GAP when a site-binding.ts is missing a capability flag', () => {
  const slug = 'parity-scratch-bindcap';
  const dir = scratchSite(slug);
  try {
    const bindingPath = path.join(dir, 'config', 'site-binding.ts');
    const withFlags = fs.readFileSync(bindingPath, 'utf8');
    for (const flag of SITE_BINDING_CAPABILITY_FLAGS) {
      assert.match(withFlags, new RegExp(`\\b${flag}\\s*:\\s*true\\b`));
    }
    fs.writeFileSync(bindingPath, withFlags.replace(/\n\s*warmAdminKeepalive:\s*true,\n/, '\n'));

    const checks = computeAdminParity(resolveAuditTarget(`sites/${slug}`));
    const check = checks.find((c) => c.id === 'binding-capability');
    assert.equal(check.status, 'GAP');
    assert.match(check.detail, /warmAdminKeepalive/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T16.2: canonical build/security posture ────────────────────────────────

test('CANONICAL_TOML_POSTURE is byte-equal to the root netlify.toml’s own posture block', () => {
  const rootToml = fs.readFileSync(path.join(repoRoot, 'netlify.toml'), 'utf8');
  for (const [key, value] of Object.entries(CANONICAL_TOML_POSTURE)) {
    assert.ok(rootToml.includes(value), `root netlify.toml must contain the canonical ${key} block verbatim`);
  }
});

// ─── 2. genesis parity by construction ──────────────────────────────────────

const scratchSite = (slug) => {
  const dir = path.join(repoRoot, 'sites', slug);
  assert.ok(!fs.existsSync(dir), `scratch dir sites/${slug} must not already exist`);
  writeFiles(buildPlan({ name: slug, brandName: 'Parity Scratch' }));
  return dir;
};

test('toml-posture check GAPs when a site netlify.toml is missing the canonical posture, and PASSes once restored', () => {
  const slug = 'parity-scratch-posture';
  const dir = scratchSite(slug);
  try {
    const tomlPath = path.join(dir, 'netlify.toml');
    const original = fs.readFileSync(tomlPath, 'utf8');

    // Genesis already carries the posture — confirm the check is a PASS by
    // construction before degrading anything.
    const clean = computeAdminParity(resolveAuditTarget(`sites/${slug}`));
    const cleanCheck = clean.find((c) => c.id === 'toml-posture');
    assert.equal(cleanCheck.status, 'PASS', cleanCheck.detail);

    // Degrade: drop pretty_urls and flip a single byte in the CSP-RO value —
    // both must be individually detected.
    const degraded = original
      .replace('[build.processing.html]\n  pretty_urls = false\n', '')
      .replace('frame-src https://www.youtube-nocookie.com', 'frame-src https://youtube-nocookie.com');
    fs.writeFileSync(tomlPath, degraded);

    const checks = computeAdminParity(resolveAuditTarget(`sites/${slug}`));
    const check = checks.find((c) => c.id === 'toml-posture');
    assert.equal(check.status, 'GAP');
    assert.match(check.detail, /prettyUrls/);
    assert.match(check.detail, /cspReportOnly/);

    // Restore and confirm it PASSes again.
    fs.writeFileSync(tomlPath, original);
    const restored = computeAdminParity(resolveAuditTarget(`sites/${slug}`));
    assert.equal(restored.find((c) => c.id === 'toml-posture').status, 'PASS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a freshly scaffolded site passes the admin-parity audit with ZERO gaps', () => {
  const slug = 'parity-scratch-genesis';
  const dir = scratchSite(slug);
  try {
    const checks = computeAdminParity(resolveAuditTarget(`sites/${slug}`));
    const gaps = checks.filter((c) => c.status === 'GAP');
    assert.deepEqual(
      gaps.map((g) => `${g.id}: ${g.detail}`),
      [],
      'genesis must produce a site already at admin parity'
    );
    // The human gates are still named — the report is the full truth, not
    // the automatable subset.
    assert.ok(checks.some((c) => c.id === 'identity-enabled' && c.status === 'HUMAN'));
    assert.ok(checks.some((c) => c.id === 'admin-env-values' && c.status === 'HUMAN'));
    // And the renderer mentions every check id.
    const report = renderParityReport(`sites/${slug}`, checks);
    for (const check of checks) assert.ok(report.includes(check.id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 3. the repair loop (migrate-site --admin-parity) ───────────────────────

test('planAdminParityFixes repairs a degraded older-scaffold site, idempotently', () => {
  const slug = 'parity-scratch-repair';
  const dir = scratchSite(slug);
  try {
    // Degrade the scaffold the ways older sites really drifted:
    // (a) missing function shims (scaffolded before a core function existed);
    fs.rmSync(path.join(dir, 'netlify', 'functions', 'admin-users.ts'));
    fs.rmSync(path.join(dir, 'netlify', 'functions', 'mcp-oauth.ts'));
    fs.rmSync(path.join(dir, 'netlify', 'functions', 'mcp.ts'));
    // (b) the pre-S1 admin splat rewrite, forced, in netlify.toml…
    const tomlPath = path.join(dir, 'netlify.toml');
    fs.writeFileSync(
      tomlPath,
      fs
        .readFileSync(tomlPath, 'utf8')
        .replace(
          /\[\[redirects\]\]\n {2}from = "\/admin\/content\/:objectId"\n {2}to = "\/admin\/content\/__workspace"\n {2}status = 200\n/,
          '[[redirects]]\n  from = "/admin/content/*"\n  to = "/admin/content/__workspace"\n  status = 200\n  force = true\n'
        )
    );
    // …and in site.config.ts;
    const siteConfigPath = path.join(dir, 'site.config.ts');
    fs.writeFileSync(
      siteConfigPath,
      fs
        .readFileSync(siteConfigPath, 'utf8')
        .replace(
          /\{ from: '\/admin\/content\/:objectId', to: '\/admin\/content\/__workspace', status: 200 \},/,
          "{ from: '/admin/content/*', to: '/admin/content/__workspace', status: 200 },"
        )
    );
    // (c) missing keepalive schedule;
    fs.writeFileSync(
      tomlPath,
      fs
        .readFileSync(tomlPath, 'utf8')
        .replace(/\[functions\."mcp-keepalive"\]\n {2}schedule = "\*\/5 \* \* \* \*"\n/, '')
    );
    // (d) missing reader blog loaders (the real fernwell gap, W14 F11).
    fs.rmSync(path.join(dir, 'app', 'pages', '[...blog]'), { recursive: true });

    const before = computeAdminParity(resolveAuditTarget(`sites/${slug}`));
    const beforeGapIds = before.filter((c) => c.status === 'GAP').map((c) => c.id);
    for (const id of ['function-shims', 'admin-rewrite-s1', 'netlify-functions-config', 'reader-blog-loaders']) {
      assert.ok(beforeGapIds.includes(id), `degraded site must show the ${id} gap (saw: ${beforeGapIds.join(', ')})`);
    }

    // Dry-run plans, does not touch disk.
    const dryRun = planAdminParityFixes(`sites/${slug}`, { write: false });
    assert.ok(dryRun.fixes.length >= 8, `expected shims+rewrite+schedule+loaders fixes, got ${dryRun.fixes.length}`);
    assert.ok(
      computeAdminParity(resolveAuditTarget(`sites/${slug}`)).filter((c) => c.status === 'GAP').length ===
        beforeGapIds.length,
      'dry-run must not modify the tree'
    );

    // Write, then the audit is clean again.
    const applied = planAdminParityFixes(`sites/${slug}`, { write: true });
    assert.equal(applied.fixes.length, dryRun.fixes.length);
    const after = computeAdminParity(resolveAuditTarget(`sites/${slug}`));
    assert.deepEqual(
      after.filter((c) => c.status === 'GAP').map((c) => `${c.id}: ${c.detail}`),
      [],
      'after --write the audit must be gap-free'
    );

    // The stale splat is gone from BOTH files; the S1 form is present, unforced.
    const toml = fs.readFileSync(tomlPath, 'utf8');
    assert.ok(!toml.includes('"/admin/content/*"'), 'stale splat must be replaced in netlify.toml');
    const tomlAdmin = parseNetlifyTomlRedirects(toml).find((r) => r.from === ADMIN_CONTENT_REWRITE.from);
    assert.deepEqual(tomlAdmin, ADMIN_CONTENT_REWRITE);
    const configRedirects = parseSiteConfigRedirects(fs.readFileSync(siteConfigPath, 'utf8'));
    assert.ok(configRedirects.some((r) => r.from === ADMIN_CONTENT_REWRITE.from));
    assert.ok(!configRedirects.some((r) => r.from === STALE_ADMIN_CONTENT_FROM));

    // The regenerated mcp shim is the composite wire, not a generic factory shim.
    const mcpShim = fs.readFileSync(path.join(dir, 'netlify', 'functions', 'mcp.ts'), 'utf8');
    assert.ok(mcpShim.includes('configureMcp('), 'the mcp shim must be regenerated from the composite template');

    // Idempotency: a second run has nothing to do and changes nothing.
    const again = planAdminParityFixes(`sites/${slug}`, { write: true });
    assert.deepEqual(again.fixes, [], 'a second --write run must be a no-op');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planAdminParityFixes never overwrites an existing shim (custom wires are legitimate)', () => {
  const slug = 'parity-scratch-custom';
  const dir = scratchSite(slug);
  try {
    const shimPath = path.join(dir, 'netlify', 'functions', 'object-store.ts');
    const custom = '// CUSTOM site-local wire — must survive a parity run\nexport const handler = () => {};\n';
    fs.writeFileSync(shimPath, custom);
    planAdminParityFixes(`sites/${slug}`, { write: true });
    assert.equal(fs.readFileSync(shimPath, 'utf8'), custom, 'existing shims are never overwritten');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planAdminParityFixes refuses the root target (the root deploy is audited read-only)', () => {
  assert.throws(() => planAdminParityFixes('--root'), /read-only/);
});

test('runAdminParity (migrate-site --admin-parity) reports fixes + audit through one entry point', () => {
  const slug = 'parity-scratch-runner';
  const dir = scratchSite(slug);
  try {
    fs.rmSync(path.join(dir, 'netlify', 'functions', 'admin-agent-chat.ts'));
    const lines = [];
    const dry = runAdminParity(`sites/${slug}`, { write: false, log: (line) => lines.push(String(line)) });
    assert.equal(dry.fixes.length, 1);
    assert.ok(dry.gaps >= 1, 'the missing shim must surface as an audit gap');
    assert.ok(lines.some((l) => l.includes('would apply 1 fix')));
    assert.ok(lines.some((l) => l.includes('admin parity audit')));

    const wrote = runAdminParity(`sites/${slug}`, { write: true, log: () => {} });
    assert.equal(wrote.gaps, 0, 'after --write the audit is clean');
    const rerun = runAdminParity(`sites/${slug}`, { write: false, log: () => {} });
    assert.deepEqual(rerun.fixes, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── the audit CLI’s fleet discovery ────────────────────────────────────────

test('discoverTargets finds every per-site Netlify project plus the root deploy', () => {
  const targets = discoverTargets();
  assert.ok(targets.includes('sites/fernwell'));
  assert.ok(targets.includes('sites/platform'));
  assert.ok(!targets.includes('sites/drlurie'), 'drlurie deploys from the repo root, not its own netlify.toml');
  assert.equal(targets.at(-1), '--root');
});

// ─── the fleet itself stays at parity (the standing regression guard) ───────

test('every real tenant target passes the automatable audit with zero gaps', () => {
  for (const targetArg of discoverTargets()) {
    const checks = computeAdminParity(resolveAuditTarget(targetArg));
    assert.deepEqual(
      checks.filter((c) => c.status === 'GAP').map((c) => `${targetArg} ${c.id}: ${c.detail}`),
      [],
      `${targetArg} must be at admin parity`
    );
  }
});
