/**
 * `admin-parity` — the W15 S2 single source of truth for what a tenant needs
 * before its `/admin` workspace and edit-mode canvas actually work, plus the
 * machine checks that PROVE a site has all of it.
 *
 * Wolf's W15 mandate (2026-08-03): every tenant — current clients and all
 * future ones — gets the full admin workspace and canvas editor, not just
 * Dr-Lurie. The admin surface itself is fleet law (shell-routes.ts injects
 * `/admin/*` into every build; create-site emits every core function shim),
 * but the LAST MILE — shims present and correctly wired, the S1 admin
 * rewrite, netlify.toml ⇄ site.config.ts agreement, Identity/ADMIN_EMAILS,
 * blob stores — was tribal knowledge. This module turns it into checked
 * requirements. Human-readable companion:
 * docs/cms-architecture/15-fleet-admin-parity.md (keep the two in sync).
 *
 * Consumed by:
 *   - scripts/audit-site-admin-parity.mjs  (the pass/gap table CLI)
 *   - packages/core/cli/migrate-site.mjs   (--admin-parity: report + write
 *     the automatable fixes onto an older site tree, idempotently)
 *   - tests (tests/scripts/admin-parity.test.mjs, create-site.test.ts's
 *     canonical-redirect drift guard)
 *
 * House discipline: VERIFY rather than generate where a surface already has
 * an owner (the netlify.toml/site.config.ts drift-guard pattern from
 * tests/netlify/site-config-drift.test.ts), and never overwrite an existing
 * file — parity fixes only ADD what is missing or replace the one known-bad
 * legacy form (the pre-S1 `/admin/content/*` splat rewrite).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  coreFunctionNames,
  coreFunctionIsV2,
  functionShimTemplate,
  mcpShimTemplate,
  idsFor,
  ENV_CHECKLIST,
  CORE_BLOB_STORES,
  SITE_BINDING_CAPABILITY_FLAGS,
  buildPlan,
} from './create-site.mjs';
import { siteReaderRouteTemplates } from './site-reader-route-templates.mjs';

/**
 * The REAL repo root — found by walking up, not by a fixed `../../..`,
 * because this module also runs from the COMPILED test tree
 * (.tmp/ci-test/packages/core/cli/…), where three-up is the compiled tree
 * itself: it mirrors compiled TS but carries neither netlify.toml nor the
 * (tsconfig-excluded) app shell this audit reads.
 */
const findRepoRoot = (startDir) => {
  let dir = startDir;
  while (true) {
    if (
      fs.existsSync(path.join(dir, 'netlify.toml')) &&
      fs.existsSync(path.join(dir, 'packages', 'core', 'app', 'shell-routes.ts'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      // Fall back to the naive resolution rather than throwing at import time.
      return path.resolve(startDir, '..', '..', '..');
    }
    dir = parent;
  }
};

export const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

// ─── the canonical infra redirect table ──────────────────────────────────────
//
// Every tenant's netlify.toml MUST carry these rules for the admin workspace,
// the MCP endpoint, and the OAuth authorization server to be reachable, and
// its site.config.ts `redirects` must mirror them (from/to/status; `force` is
// netlify.toml-only). Content redirects (/blog → /learn/library and friends)
// are per-site editorial choices and deliberately NOT in this table.
export const CANONICAL_INFRA_REDIRECTS = [
  { from: '/pdf/*', to: '/.netlify/functions/get-public-pdf?blobKey=pdf/:splat', status: 200, force: true },
  { from: '/img/*', to: '/.netlify/functions/get-public-image?blobKey=image/:splat', status: 200, force: true },
  { from: '/mcp', to: '/.netlify/functions/mcp', status: 200, force: true },
  {
    from: '/.well-known/oauth-protected-resource',
    to: '/.netlify/functions/mcp-oauth?oauth_endpoint=protected-resource-metadata',
    status: 200,
    force: true,
  },
  {
    from: '/.well-known/oauth-protected-resource/*',
    to: '/.netlify/functions/mcp-oauth?oauth_endpoint=protected-resource-metadata',
    status: 200,
    force: true,
  },
  {
    from: '/.well-known/oauth-authorization-server',
    to: '/.netlify/functions/mcp-oauth?oauth_endpoint=authorization-server-metadata',
    status: 200,
    force: true,
  },
  {
    from: '/.well-known/oauth-authorization-server/*',
    to: '/.netlify/functions/mcp-oauth?oauth_endpoint=authorization-server-metadata',
    status: 200,
    force: true,
  },
  { from: '/oauth/register', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=register', status: 200, force: true },
  { from: '/oauth/authorize', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=authorize', status: 200, force: true },
  { from: '/oauth/consent', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=consent', status: 200, force: true },
  { from: '/oauth/token', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=token', status: 200, force: true },
  { from: '/oauth/revoke', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=revoke', status: 200, force: true },
  { from: '/api/t', to: '/.netlify/functions/track-ingest', status: 200, force: true },
  // W15 S1: ONE path segment, UNFORCED — the splat + force pair shadowed the
  // static content library index at /admin/content (the "Back to library"
  // dead-end loop). This is the only sanctioned form of the admin rewrite.
  { from: '/admin/content/:objectId', to: '/admin/content/__workspace', status: 200, force: false },
  // W19 T19.4: the same single-segment, UNFORCED form for the request detail
  // page — /admin/requests must keep serving its own static list index.
  { from: '/admin/requests/:requestId', to: '/admin/requests/__request', status: 200, force: false },
];

/**
 * The S1 admin-workspace rewrite, singled out for detection/repair.
 *
 * Found BY `from`, not by position: it was the last row until W19 appended the
 * request rewrite, and a positional lookup would have silently started
 * repairing the wrong rule.
 */
export const ADMIN_CONTENT_REWRITE = CANONICAL_INFRA_REDIRECTS.find(
  (redirect) => redirect.from === '/admin/content/:objectId'
);

/**
 * The pre-S1 form: the splat matched `/admin/content/` itself and (forced)
 * swallowed the static library index. Any rule with this `from` is stale and
 * must be REPLACED by ADMIN_CONTENT_REWRITE, whatever its status/force.
 */
export const STALE_ADMIN_CONTENT_FROM = '/admin/content/*';

// ─── the canonical build/security posture ────────────────────────────────────
//
// T16.2 (genesis-parity-plan §1.2 item 4): root (Dr-Lurie) alone carried
// `pretty_urls = false`, the `/_astro/*` immutable-cache header, and the
// CSP-Report-Only header — perf + security posture, not branding, yet
// platform and fernwell shipped without any of it. Every tenant's
// netlify.toml must carry this block BYTE-EQUAL to the root file's own copy
// (verbatim, mirroring how CANONICAL_INFRA_REDIRECTS is the single source of
// truth for the redirect table). The CSP-RO value is the ALL-PROVIDERS-
// DISABLED baseline (tests/netlify/csp-drift.test.ts's `BASE`); a site that
// enables a tracking provider extends its OWN copy with that provider's
// cspHosts in the same change — this constant only pins the shared floor
// every tenant starts from.
export const CANONICAL_TOML_POSTURE = {
  prettyUrls: '[build.processing.html]\n  pretty_urls = false\n',
  astroImmutableHeaders:
    '[[headers]]\n  for = "/_astro/*"\n  [headers.values]\n    Cache-Control = "public, max-age=31536000, immutable"\n',
  cspReportOnly:
    "[[headers]]\n  for = \"/*\"\n  [headers.values]\n    Content-Security-Policy-Report-Only = \"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://player.vimeo.com; object-src 'none'; base-uri 'self'\"\n",
};

// ─── admin-critical env + blob stores ────────────────────────────────────────
//
// The env NAMES a working admin needs on the tenant's Netlify site, with who
// supplies each. `checklist: true` rows must appear in create-site's
// ENV_CHECKLIST (checked below) so no new client is scaffolded without at
// least seeing the requirement.
export const ADMIN_CRITICAL_ENV = [
  {
    name: 'ADMIN_EMAILS',
    provisioner: 'human (Netlify console)',
    checklist: true,
    why: 'Bootstrap Owner allowlist — without it (and before any invite) NOBODY can sign in as owner/admin; a wiped users store cannot lock Wolf out only because this env fallback exists (roles.ts).',
  },
  {
    name: 'IDENTITY_URL',
    provisioner: 'human (Netlify console, optional override)',
    checklist: true,
    why: 'GoTrue endpoint override for token verification. Optional: functions fall back to `${URL}/.netlify/identity`, which is correct once Identity is ENABLED on the site — enabling Identity is the real (console-only) gate.',
  },
  {
    name: 'NETLIFY_SITE_ID',
    provisioner: 'create-site provisioning (auto)',
    checklist: true,
    why: 'Blob runtime detection keys on it; without it every admin function writes to the file-backed test store and the workspace looks empty.',
  },
  {
    name: 'NETLIFY_BUILD_HOOK_URL',
    provisioner: 'human (Netlify console)',
    checklist: true,
    why: 'The admin release flow (admin-release / trigger build) needs a build hook to rebuild the site after publish.',
  },
  {
    name: 'GITHUB_CONTENT_TOKEN',
    provisioner: 'human (secret custody)',
    checklist: true,
    why: 'Publish materializes committed exports via the git-write path; publishing from /admin dead-ends without the repo binding (GITHUB_REPOSITORY/_BRANCH + this token).',
  },
  {
    name: 'ANTHROPIC_API_KEY',
    provisioner: 'human (fleet-shared secret)',
    checklist: true,
    why: 'Legacy non-chat AI surfaces may still use the Anthropic adapter; admin chat itself is Client Manager-only.',
  },
  {
    name: 'OPENAI_API_KEY',
    provisioner: 'human (fleet-shared secret)',
    checklist: true,
    why: 'Legacy non-chat AI surfaces may still use the OpenAI adapter; admin chat itself is Client Manager-only.',
  },
  {
    name: 'CMS_AGENT_MCP_ENDPOINT',
    provisioner: 'CMS-Agent genesis/cloning (auto)',
    checklist: true,
    why: "The CMS-Agent Cloud Run /mcp URL the admin chat's client_manager turns run through. Absent, chat fails closed with cms_agent_not_configured.",
  },
  {
    name: 'CMS_AGENT_MCP_TOKEN',
    provisioner: 'CMS-Agent genesis/cloning (auto, raw value never exposed)',
    checklist: true,
    why: "This site's scoped CMS-Agent bearer, pinned to its own project and tool allow-list. Never MCP_API_TOKEN and never another tenant's — the scope is the tenant-isolation boundary, enforced at the door rather than by careful coding.",
  },
  {
    name: 'PUBLISH_SECRET',
    provisioner: 'create-site provisioning (auto)',
    checklist: true,
    why: 'The object-store write gate every admin mutation ultimately authenticates through.',
  },
  {
    name: 'ARTIFACT_UPLOAD_TOKEN_SECRET',
    provisioner: 'create-site provisioning (auto)',
    checklist: true,
    why: 'Signs artifact-upload intents — image upload from the workspace/canvas fails without it.',
  },
];

/**
 * The blob stores the admin workspace itself reads/writes. All of them are
 * per-site (OQ-W11-4: one Netlify site per client = the tenant boundary) and
 * must round-trip on the tenant's own Netlify site.
 */
export const ADMIN_BLOB_STORES = ['users', 'agent-chats', 'agent-profiles', 'governance', 'site-objects', 'artifacts'];

/**
 * Scans packages/core (server + lib) for blob-store NAME literals so
 * CORE_BLOB_STORES (create-site's probe list) can be CHECKED against reality
 * instead of trusted. Matches both call shapes:
 *   getNetlifyBlobStore('name', …)  and  getNetlifyBlobStore({ name: 'name', … })
 */
export const scanCoreBlobStoreNames = (coreDir = path.join(repoRoot, 'packages', 'core')) => {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|js|mjs)$/.test(entry.name) || /\.test\.(ts|js|mjs)$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const match of src.matchAll(/getNetlifyBlobStore\(\s*'([^']+)'/g)) names.add(match[1]);
      for (const match of src.matchAll(/getNetlifyBlobStore\(\s*\{\s*name:\s*'([^']+)'/g)) names.add(match[1]);
    }
  };
  for (const sub of ['server', 'lib']) {
    const dir = path.join(coreDir, sub);
    if (fs.existsSync(dir)) walk(dir);
  }
  return [...names].sort();
};

// ─── parsers (shared with the drift-test approach) ───────────────────────────

/** Parses every `[[redirects]]` block of a netlify.toml into {from,to,status,force}. */
export const parseNetlifyTomlRedirects = (tomlText) =>
  tomlText
    .split('[[redirects]]')
    .slice(1)
    .map((block) => ({
      from: block.match(/from = "([^"]+)"/)?.[1],
      to: block.match(/to = "([^"]+)"/)?.[1],
      status: Number(block.match(/status = (\d+)/)?.[1]),
      force: /force = true/.test(block),
    }));

/**
 * Extracts the `redirects: [...]` entries of a site.config.ts. The array is
 * code, but its entries are the fixed `{ from: '…', to: '…', status: N }`
 * shape (siteConfigSchema strictObject) — a regex over that shape is exact,
 * not heuristic, and works on single-line and wrapped entries alike.
 */
export const parseSiteConfigRedirects = (tsText) => {
  const arrayMatch = tsText.match(/redirects:\s*\[([\s\S]*?)\n\s*\]/);
  if (!arrayMatch) return undefined;
  const entries = [];
  for (const m of arrayMatch[1].matchAll(/\{\s*from:\s*'([^']+)',\s*to:\s*'([^']+)',\s*status:\s*(\d+)\s*,?\s*\}/g)) {
    entries.push({ from: m[1], to: m[2], status: Number(m[3]) });
  }
  return entries;
};

/** Parses SHELL_ROUTES patterns out of packages/core/app/shell-routes.ts. */
export const parseShellRoutePatterns = (shellRoutesPath = path.join(repoRoot, 'packages/core/app/shell-routes.ts')) => {
  const src = fs.readFileSync(shellRoutesPath, 'utf8');
  return [...src.matchAll(/pattern:\s*'([^']+)'/g)].map((m) => m[1]);
};

/** T18.0c: the Netlify Identity e-mail templates core publishes at /emails/identity/<file>. */
export const IDENTITY_EMAIL_TEMPLATE_FILES = [
  'invitation.html',
  'confirmation.html',
  'recovery.html',
  'email-change.html',
];

/** The admin routes the workspace is not usable without. */
export const REQUIRED_SHELL_ROUTES = [
  '/admin',
  '/admin/accept', // T18.0b — the Identity mail-token landing page (invite/recovery/confirm/email-change)
  '/admin/agents',
  '/admin/authorize', // W14 F10 OAuth consent — inside /admin so the approver is a named admin
  '/admin/content',
  '/admin/content/[objectId]',
  '/admin/maintenance',
  '/admin/profile',
  '/admin/requests', // W19 T19.4 — the editorial request list; the shell's three pills all deep-link to it
  '/admin/requests/[requestId]',
  '/admin/settings/admins',
  '/admin/settings/guardrails',
  '/admin/studio',
  '/admin/welcome', // T18.5 — the onboarding step the AdminShell gate redirects to
];

// ─── audit targets ───────────────────────────────────────────────────────────

/**
 * The site the ROOT deploy builds — read from the root astro.config.ts,
 * which is a one-line re-export of some sites/<slug>/astro.config (the W14
 * T14.1 arrangement). Discovered, not hardcoded: core carries no site-name
 * literals (the W11 zero-literal lint), and if the root entry is ever
 * re-pointed the audit follows it automatically.
 */
export const rootDeploySlug = (root = repoRoot) => {
  const rootAstroConfig = path.join(root, 'astro.config.ts');
  if (!fs.existsSync(rootAstroConfig)) return undefined;
  return fs.readFileSync(rootAstroConfig, 'utf8').match(/sites\/([a-z0-9-]+)\/astro\.config/)?.[1];
};

/**
 * Resolves an audit target. Two shapes exist today:
 *   - a per-site Netlify project (base directory sites/<slug>): its own
 *     netlify.toml + netlify/functions shims under the site dir;
 *   - the ROOT deploy: repo-root netlify.toml + netlify/functions, with the
 *     root-deployed site's tree carrying config/site.config/astro entry only.
 */
export const resolveAuditTarget = (siteDirOrRoot, root = repoRoot) => {
  if (siteDirOrRoot === '--root' || siteDirOrRoot === 'root') {
    const slug = rootDeploySlug(root);
    if (!slug) throw new Error('cannot resolve the root deploy: astro.config.ts does not re-export a site entry');
    return {
      label: `root (${slug} wiring)`,
      slug,
      siteDir: path.join(root, 'sites', slug),
      tomlPath: path.join(root, 'netlify.toml'),
      functionsDir: path.join(root, 'netlify', 'functions'),
      siteConfigPath: path.join(root, 'sites', slug, 'site.config.ts'),
      astroConfigPath: path.join(root, 'sites', slug, 'astro.config.ts'),
      isRoot: true,
    };
  }
  const siteDir = path.isAbsolute(siteDirOrRoot) ? siteDirOrRoot : path.join(root, siteDirOrRoot);
  const slug = path.basename(siteDir);
  return {
    label: `sites/${slug}`,
    slug,
    siteDir,
    tomlPath: path.join(siteDir, 'netlify.toml'),
    functionsDir: path.join(siteDir, 'netlify', 'functions'),
    siteConfigPath: path.join(siteDir, 'site.config.ts'),
    astroConfigPath: path.join(siteDir, 'astro.config.ts'),
    isRoot: false,
  };
};

const redirectKey = (r) => `${r.from} → ${r.to} (${r.status})`;

// ─── the audit ───────────────────────────────────────────────────────────────

/**
 * Runs every automatable admin-parity check against one target. Returns
 * ordered checks: { id, requirement, provisioner, status, detail } with
 * status ∈ 'PASS' | 'GAP' | 'HUMAN' (not machine-checkable from the repo —
 * Netlify console / secret custody) | 'INFO'.
 */
export const computeAdminParity = (target) => {
  const checks = [];
  const add = (id, requirement, provisioner, status, detail) =>
    checks.push({ id, requirement, provisioner, status, detail });

  // 1. Shell routes are law and present in core.
  const patterns = parseShellRoutePatterns();
  const missingRoutes = REQUIRED_SHELL_ROUTES.filter((r) => !patterns.includes(r));
  add(
    'shell-routes',
    'Core injects the full /admin route surface into every build (shell-routes.ts)',
    'packages/core (fleet law)',
    missingRoutes.length ? 'GAP' : 'PASS',
    missingRoutes.length ? `missing: ${missingRoutes.join(', ')}` : `${patterns.length} routes injected`
  );

  // 1b. T18.0c: the four Netlify Identity e-mail templates exist in core and
  //     the shell config publishes them into every build (/emails/identity/*).
  //     The console PATH per site is a HUMAN step (see the human rows below).
  const templateProblems = [];
  for (const file of IDENTITY_EMAIL_TEMPLATE_FILES) {
    const source = path.join(repoRoot, 'packages/core/app/emails/identity', file);
    if (!fs.existsSync(source)) {
      templateProblems.push(`missing packages/core/app/emails/identity/${file}`);
      continue;
    }
    if (!fs.readFileSync(source, 'utf8').includes('/admin/accept/#')) {
      templateProblems.push(`${file} does not link to /admin/accept/#`);
    }
  }
  const shellConfigSrc = fs.readFileSync(path.join(repoRoot, 'packages/core/app/site-astro-config.ts'), 'utf8');
  if (!/identityEmailTemplates\(\)/.test(shellConfigSrc)) {
    templateProblems.push('site-astro-config.ts does not mount identityEmailTemplates()');
  }
  if (!patterns.includes('/admin/accept')) templateProblems.push('/admin/accept is not an injected shell route');
  add(
    'identity-email-templates',
    'Core ships the four Identity e-mail templates (invitation/confirmation/recovery/email-change), every build publishes them at /emails/identity/*.html, each links to /admin/accept',
    'packages/core (fleet law)',
    templateProblems.length ? 'GAP' : 'PASS',
    templateProblems.length
      ? templateProblems.join('; ')
      : `${IDENTITY_EMAIL_TEMPLATE_FILES.length} templates in core, published by the shell build, all landing on /admin/accept`
  );

  // 2. The site's build entry actually goes through the shell (which is what
  //    wires shellRoutes + layouts incl. EditMode canvas + admin-tokens.css).
  const astroSrc = fs.existsSync(target.astroConfigPath) ? fs.readFileSync(target.astroConfigPath, 'utf8') : '';
  const usesShell = /defineSiteAstroConfig/.test(astroSrc);
  add(
    'build-entry',
    'astro.config.ts is a thin entry over defineSiteAstroConfig (injects shell routes, EditMode canvas, admin styles)',
    'scaffold (create-site)',
    astroSrc ? (usesShell ? 'PASS' : 'GAP') : 'GAP',
    astroSrc
      ? usesShell
        ? 'build entry uses the core shell'
        : 'astro.config.ts does not reference defineSiteAstroConfig'
      : `missing ${path.relative(repoRoot, target.astroConfigPath)}`
  );

  // 3+4. Function shims: complete and correctly wired.
  const expected = coreFunctionNames();
  const present = fs.existsSync(target.functionsDir)
    ? fs
        .readdirSync(target.functionsDir)
        .filter((f) => /\.(ts|js|mjs)$/.test(f) && !/\.test\./.test(f))
        .map((f) => f.replace(/\.(ts|js|mjs)$/, ''))
    : [];
  const missingShims = expected.filter((name) => !present.includes(name));
  const extraShims = present.filter((name) => !expected.includes(name));
  add(
    'function-shims',
    `Every core server function has a per-site shim in ${path.relative(repoRoot, target.functionsDir)} (${expected.length} expected)`,
    'scaffold (create-site) | migrate-site --admin-parity',
    missingShims.length ? 'GAP' : 'PASS',
    missingShims.length
      ? `missing: ${missingShims.join(', ')}`
      : `${expected.length}/${expected.length} present${extraShims.length ? ` (+ site-local: ${extraShims.join(', ')})` : ''}`
  );

  const wiringProblems = [];
  for (const name of expected) {
    const file = ['ts', 'js', 'mjs'].map((ext) => path.join(target.functionsDir, `${name}.${ext}`)).find(fs.existsSync);
    if (!file) continue; // already reported as missing
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes(`server/functions/${name}.js`)) {
      wiringProblems.push(`${name}: does not import packages/core/server/functions/${name}.js`);
      continue;
    }
    if (!/policy-bindings\.js'/.test(src)) {
      wiringProblems.push(`${name}: missing the policy-bindings side-effect import`);
      continue;
    }
    if (name === 'mcp') {
      if (!src.includes('configureMcp(')) wiringProblems.push('mcp: shim does not call configureMcp');
      continue;
    }
    const isV2 = coreFunctionIsV2(name);
    if (isV2 && !/^export default /m.test(src)) {
      wiringProblems.push(`${name}: core fn is Functions-2.0 but shim has no default export (502s at init — W14 F2)`);
    } else if (!isV2 && !/^export const handler\s*=/m.test(src)) {
      wiringProblems.push(`${name}: core fn is Functions-1.0 but shim has no named handler export`);
    }
  }
  add(
    'shim-wiring',
    'Each shim wires its core factory with THIS site’s binding + policy side-effects, with the export form its function generation requires',
    'scaffold (create-site)',
    wiringProblems.length ? 'GAP' : 'PASS',
    wiringProblems.length ? wiringProblems.join('; ') : 'all shims correctly wired'
  );

  // 5. netlify.toml functions block + keepalive schedule.
  const toml = fs.existsSync(target.tomlPath) ? fs.readFileSync(target.tomlPath, 'utf8') : '';
  const fnProblems = [];
  if (!toml) fnProblems.push(`missing ${path.relative(repoRoot, target.tomlPath)}`);
  else {
    if (!/\[functions\]/.test(toml)) fnProblems.push('no [functions] block');
    if (!/directory = "netlify\/functions"/.test(toml)) fnProblems.push('functions.directory not netlify/functions');
    if (!/\[functions\."mcp-keepalive"\]/.test(toml) || !/schedule = /.test(toml)) {
      fnProblems.push('mcp-keepalive schedule not declared (deployed but never runs → cold /mcp)');
    }
    // W18 T18.4: the daily membership sweep (invitation expiry, purge) must be declared too.
    if (!/\[functions\."membership-sweep"\]\s*\n\s*schedule = /.test(toml)) {
      fnProblems.push('membership-sweep schedule not declared (invitations never expire, removed members never purge)');
    }
  }
  add(
    'netlify-functions-config',
    'netlify.toml declares the functions directory and the mcp-keepalive + membership-sweep schedules',
    'scaffold (create-site) | migrate-site --admin-parity',
    fnProblems.length ? 'GAP' : 'PASS',
    fnProblems.length ? fnProblems.join('; ') : 'functions directory + keepalive schedule declared'
  );

  // 6+7. Canonical infra redirects, incl. the S1 admin rewrite.
  const tomlRedirects = toml ? parseNetlifyTomlRedirects(toml) : [];
  const redirectProblems = [];
  for (const canonical of CANONICAL_INFRA_REDIRECTS) {
    const found = tomlRedirects.find((r) => r.from === canonical.from);
    if (!found) redirectProblems.push(`missing rule: ${redirectKey(canonical)}`);
    else if (found.to !== canonical.to || found.status !== canonical.status || found.force !== canonical.force) {
      redirectProblems.push(
        `rule for ${canonical.from} drifted: expected ${canonical.to} (${canonical.status}${canonical.force ? ', force' : ', unforced'})`
      );
    }
  }
  add(
    'infra-redirects',
    `netlify.toml carries all ${CANONICAL_INFRA_REDIRECTS.length} canonical infra redirects (pdf/img, /mcp, OAuth AS ×9, /api/t, admin rewrite)`,
    'scaffold (create-site) | migrate-site --admin-parity',
    redirectProblems.length ? 'GAP' : 'PASS',
    redirectProblems.length ? redirectProblems.join('; ') : 'all canonical rules present and exact'
  );

  const staleAdmin = tomlRedirects.find((r) => r.from === STALE_ADMIN_CONTENT_FROM);
  const s1Admin = tomlRedirects.find((r) => r.from === ADMIN_CONTENT_REWRITE.from);
  add(
    'admin-rewrite-s1',
    'The /admin/content workspace rewrite uses the S1 single-segment, unforced form (the splat form swallowed the library index)',
    'scaffold (create-site) | migrate-site --admin-parity',
    staleAdmin ? 'GAP' : s1Admin && !s1Admin.force ? 'PASS' : 'GAP',
    staleAdmin
      ? `STALE pre-S1 splat rule present (${STALE_ADMIN_CONTENT_FROM}) — replace with ${ADMIN_CONTENT_REWRITE.from}`
      : s1Admin
        ? s1Admin.force
          ? 'S1 rule present but FORCED — must be unforced'
          : 'S1 form in place'
        : 'admin rewrite missing entirely'
  );

  // 7b. Canonical build/security posture (T16.2): pretty_urls, the
  //     /_astro/* immutable-cache header, and the CSP-Report-Only header,
  //     byte-equal to the root netlify.toml's own copy.
  const postureProblems = [];
  for (const [key, value] of Object.entries(CANONICAL_TOML_POSTURE)) {
    if (!toml.includes(value)) postureProblems.push(`missing or drifted: ${key}`);
  }
  add(
    'toml-posture',
    'netlify.toml carries the canonical build/security posture byte-equal (pretty_urls, /_astro/* immutable headers, CSP-Report-Only)',
    'scaffold (create-site) | migrate-site --admin-parity',
    postureProblems.length ? 'GAP' : 'PASS',
    postureProblems.length ? postureProblems.join('; ') : 'all canonical posture keys present, byte-equal'
  );

  // 8. site.config.ts mirrors netlify.toml (the drift-guard invariant).
  const siteConfigSrc = fs.existsSync(target.siteConfigPath) ? fs.readFileSync(target.siteConfigPath, 'utf8') : '';
  const configRedirects = siteConfigSrc ? parseSiteConfigRedirects(siteConfigSrc) : undefined;
  let mirrorStatus = 'GAP';
  let mirrorDetail;
  if (!siteConfigSrc) mirrorDetail = `missing ${path.relative(repoRoot, target.siteConfigPath)}`;
  else if (!configRedirects) mirrorDetail = 'site.config.ts has no parseable redirects array';
  else {
    const tomlBare = tomlRedirects.map(({ from, to, status }) => ({ from, to, status }));
    const same =
      tomlBare.length === configRedirects.length &&
      tomlBare.every((r, i) => JSON.stringify(r) === JSON.stringify(configRedirects[i]));
    if (same) {
      mirrorStatus = 'PASS';
      mirrorDetail = `${configRedirects.length} rules, byte-equal in order`;
    } else {
      const tomlKeys = new Set(tomlBare.map(redirectKey));
      const configKeys = new Set(configRedirects.map(redirectKey));
      const onlyToml = [...tomlKeys].filter((k) => !configKeys.has(k));
      const onlyConfig = [...configKeys].filter((k) => !tomlKeys.has(k));
      mirrorDetail =
        onlyToml.length || onlyConfig.length
          ? `${onlyToml.length ? `only in netlify.toml: ${onlyToml.join('; ')}` : ''}${onlyToml.length && onlyConfig.length ? ' | ' : ''}${onlyConfig.length ? `only in site.config.ts: ${onlyConfig.join('; ')}` : ''}`
          : 'same rules, different ORDER (first-match-wins semantics — order matters)';
    }
  }
  add(
    'site-config-mirror',
    'site.config.ts `redirects` equals the netlify.toml table (from/to/status, in order) — the drift-guard invariant',
    'scaffold (create-site) | migrate-site --admin-parity',
    mirrorStatus,
    mirrorDetail
  );

  // 9. The per-site config bundle without which the shell cannot even resolve
  //    site identity (policy-bindings) or the functions their binding.
  const configDir = path.join(target.siteDir, 'config');
  const requiredConfig = [
    'site-identity.ts',
    'site-binding.ts',
    'approval-policy.ts',
    'creation-policy.ts',
    'media-policy.ts',
    // W18 T18.7: the committed membership-policy override stub (fleet default = core's).
    'membership-policy.ts',
    'policy-bindings.ts',
  ];
  const missingConfig = requiredConfig.filter((f) => !fs.existsSync(path.join(configDir, f)));
  // W18 T18.7: the stub is inert unless policy-bindings registers it.
  const bindingsPath = path.join(configDir, 'policy-bindings.ts');
  const bindingsSrc = fs.existsSync(bindingsPath) ? fs.readFileSync(bindingsPath, 'utf8') : '';
  const membershipRegistered = /setActiveMembershipPolicyProvider\(/.test(bindingsSrc);
  const configProblems = [
    ...(missingConfig.length ? [`missing: ${missingConfig.join(', ')}`] : []),
    ...(!missingConfig.includes('policy-bindings.ts') && !membershipRegistered
      ? ['policy-bindings.ts does not register the membership-policy override (setActiveMembershipPolicyProvider)']
      : []),
  ];
  add(
    'config-bundle',
    'The per-site config bundle exists (identity, binding, approval/creation/media/membership policy, policy-bindings) and policy-bindings registers the membership override',
    'scaffold (create-site) | migrate-site --admin-parity',
    configProblems.length ? 'GAP' : 'PASS',
    configProblems.length ? configProblems.join('; ') : 'all 7 present, membership override registered'
  );

  // 10. Reader route loaders for content_item (W14 F11) — without them,
  //     published articles are unreachable, and so is the canvas editor on them.
  const pagesDir = path.join(target.siteDir, 'app', 'pages');
  const missingLoaders = siteReaderRouteTemplates()
    .map((r) => r.path)
    .filter((rel) => !fs.existsSync(path.join(pagesDir, rel)));
  add(
    'reader-blog-loaders',
    'The four content_item reader route loaders exist (W14 F11) — published articles (and their canvas chips) are reachable',
    'scaffold (create-site) | migrate-site --admin-parity',
    missingLoaders.length ? 'GAP' : 'PASS',
    missingLoaders.length ? `missing under app/pages/: ${missingLoaders.join(', ')}` : 'all loaders present'
  );

  // 11. Env checklist coverage (core-side: no new client scaffolds without
  //     seeing every admin-critical env name).
  const checklistNames = ENV_CHECKLIST.flatMap((g) => g.rows.map((r) => r.name));
  const missingEnv = ADMIN_CRITICAL_ENV.filter((e) => e.checklist && !checklistNames.includes(e.name));
  add(
    'env-checklist',
    'create-site’s env checklist names every admin-critical env var (values stay human/provisioning-owned)',
    'packages/core (fleet law)',
    missingEnv.length ? 'GAP' : 'PASS',
    missingEnv.length
      ? `missing rows: ${missingEnv.map((e) => e.name).join(', ')}`
      : 'all admin-critical names declared'
  );

  // 12. Blob-store probe coverage: the provisioning probe list must cover
  //     every store literal core actually uses (agent-profiles was the W15 S2
  //     find — the admin chat's dedicated-agent store was never probed).
  const literals = scanCoreBlobStoreNames();
  const unprobed = literals.filter((name) => !CORE_BLOB_STORES.includes(name));
  add(
    'blob-store-probe',
    'create-site’s provisioning probe covers every blob store core references (incl. users/agent-chats/agent-profiles/governance)',
    'create-site provisioning (auto, needs --netlify-token)',
    unprobed.length ? 'GAP' : 'PASS',
    unprobed.length
      ? `store literals never probed: ${unprobed.join(', ')}`
      : `${CORE_BLOB_STORES.length} stores probed; core references ${literals.length}`
  );

  // 13. Genesis regression guard (W15 S3 follow-up, 2026-08-05): platform
  //     and fernwell were BOTH born with no admin-only nav group in their
  //     header, so a signed-in admin had no visible way into /admin at
  //     all — auth and the route always worked, there was just no door.
  //     No prior check here caught it because the missing piece is live
  //     CMS content (the nav_header object), not a repo file — outside
  //     what an all-repo, no-network audit can see for an EXISTING tenant.
  //     What IS checkable is create-site's own genesis output for the
  //     NEXT tenant: exercise the real buildPlan() and confirm it emits
  //     the admin group, so this can't quietly regress again.
  const genesisPlan = buildPlan({ name: 'admin-parity-probe' });
  const genesisNavFile = genesisPlan.files.find(
    (f) => f.path === 'sites/admin-parity-probe/data/site/navigation/nav_header.json'
  );
  const genesisNavBody = genesisNavFile ? JSON.parse(genesisNavFile.content) : undefined;
  const genesisHasAdminGroup = Boolean(genesisNavBody?.groups?.some((g) => g.adminOnly));
  add(
    'admin-nav-genesis',
    'create-site births every new tenant with an admin-only nav group already in nav_header, so the workspace has a visible door from day one',
    'packages/core (fleet law) — create-site genesis',
    genesisHasAdminGroup ? 'PASS' : 'GAP',
    genesisHasAdminGroup
      ? 'buildPlan() emits an adminOnly nav group in the bootstrap nav_header.json'
      : 'buildPlan() does NOT emit an adminOnly nav group — a new tenant would be born with the same invisible-admin-workspace gap platform and fernwell had'
  );

  // 14. Starter-template genesis guard (W15 S3 follow-up, 2026-08-05): the
  //     CLI scaffolded a starter SECTION-template set but never a starter
  //     TEMPLATE set (tpl_interior/tpl_landing/tpl_legal — the whole-page
  //     recipes, W2.5) — every genesis'd tenant (platform, fernwell) was
  //     therefore born with zero template objects, unlike Dr-Lurie (built by
  //     hand pre-genesis). Not a PageType gap — PageTypes are schema law
  //     regardless — but an agent creating a page on a genesis'd tenant had
  //     no starter recipe to instantiate from. Checked the same way as #13:
  //     exercise the real buildPlan() and confirm it emits the seed file.
  const genesisTemplatesFile = genesisPlan.files.find(
    (f) => f.path === `sites/admin-parity-probe/seeds/templates-seed-data.mjs`
  );
  const genesisTemplateIds = genesisTemplatesFile
    ? [...genesisTemplatesFile.content.matchAll(/objectId:\s*'([^']+)'/g)].map((m) => m[1])
    : [];
  add(
    'template-genesis',
    'create-site births every new tenant with the three starter page-template recipes (tpl_interior/tpl_landing/tpl_legal), matching the canonical starter set',
    'packages/core (fleet law) — create-site genesis',
    genesisTemplateIds.length === 3 ? 'PASS' : 'GAP',
    genesisTemplateIds.length === 3
      ? `seeds/templates-seed-data.mjs emits ${genesisTemplateIds.join(', ')}`
      : `seeds/templates-seed-data.mjs is missing or incomplete (found: ${genesisTemplateIds.join(', ') || 'none'}) — a new tenant would have no starter page recipe to instantiate from`
  );

  // 15. Binding capability-flag parity (T16.3): the perf/behavior flags a
  //     SiteBinding can opt into (today just `warmAdminKeepalive`, the
  //     admin cold-start fix) drifted to drlurie-only before this check
  //     existed — platform and fernwell scaffolded before the flag existed
  //     and never got it retrofitted. create-site.mjs's own template is the
  //     single source of truth for what the flag set IS
  //     (SITE_BINDING_CAPABILITY_FLAGS); this check proves every tenant's
  //     committed `config/site-binding.ts` actually declares it `true`, not
  //     just that the flag exists somewhere in core.
  const siteBindingPath = path.join(target.siteDir, 'config', 'site-binding.ts');
  const siteBindingSrc = fs.existsSync(siteBindingPath) ? fs.readFileSync(siteBindingPath, 'utf8') : '';
  const missingFlags = SITE_BINDING_CAPABILITY_FLAGS.filter(
    (flag) => !new RegExp(`\\b${flag}\\s*:\\s*true\\b`).test(siteBindingSrc)
  );
  add(
    'binding-capability',
    `config/site-binding.ts declares the full capability flag set create-site's template emits (${SITE_BINDING_CAPABILITY_FLAGS.join(', ')})`,
    'scaffold (create-site) | migrate-site --admin-parity',
    !siteBindingSrc ? 'GAP' : missingFlags.length ? 'GAP' : 'PASS',
    !siteBindingSrc
      ? `missing ${path.relative(repoRoot, siteBindingPath)}`
      : missingFlags.length
        ? `missing flag(s): ${missingFlags.join(', ')}`
        : `all ${SITE_BINDING_CAPABILITY_FLAGS.length} capability flag(s) declared true`
  );

  // 16+. The human gates — real requirements no repo check can prove. Named
  //      here so the table is the complete truth, not the automatable subset.
  add(
    'identity-enabled',
    'Netlify Identity (GoTrue) ENABLED on the tenant site + first Owner invited or covered by ADMIN_EMAILS',
    'human (Netlify console — runbook §admin)',
    'HUMAN',
    'Console-only: Site → Integrations/Identity → Enable. Without it /admin login has no identity service and every admin function 401s.'
  );
  add(
    'identity-console-settings',
    'Identity console: Registration = Invite only; Emails → Invitation/Confirmation/Recovery/Email-change template PATHS = /emails/identity/<file>.html (T18.0c)',
    'human (Netlify console — runbook §Identity)',
    'HUMAN',
    'Console-only: Project configuration → Identity → Registration + Emails. Until the paths are set, the DEFAULT templates still work — they link to /, and the site-wide router (T18.0b) forwards the token to /admin/accept.'
  );
  add(
    'admin-env-values',
    `Admin env VALUES set on the tenant site: ${ADMIN_CRITICAL_ENV.filter((e) => e.provisioner.startsWith('human'))
      .map((e) => e.name)
      .join(', ')}`,
    'human (Netlify console / secret custody — runbook §3)',
    'HUMAN',
    'The audit proves the names are declared; the values live only in Netlify env and cannot be verified from the repo.'
  );
  add(
    'store-provisioning-run',
    'Blob stores round-trip on the REAL Netlify site (create-site --provision-only --netlify-token …)',
    'create-site provisioning (auto, needs account token)',
    'HUMAN',
    'Automated the moment a token is supplied; the repo alone cannot prove a live store.'
  );

  return checks;
};

/** Renders the audit as the human-readable pass/gap table. */
export const renderParityReport = (label, checks) => {
  const gaps = checks.filter((c) => c.status === 'GAP').length;
  const lines = [
    `admin parity audit — ${label}`,
    `  ${checks.filter((c) => c.status === 'PASS').length} pass, ${gaps} gap(s), ${checks.filter((c) => c.status === 'HUMAN').length} human-gated`,
    '',
  ];
  for (const check of checks) {
    lines.push(`  [${check.status.padEnd(5)}] ${check.id}`);
    lines.push(`          ${check.requirement}`);
    lines.push(`          provisioned by: ${check.provisioner}`);
    lines.push(`          ${check.detail}`);
  }
  return lines.join('\n');
};

// ─── the fix path (migrate-site --admin-parity --write) ──────────────────────

const renderTomlRedirectBlock = (redirect) =>
  [
    '[[redirects]]',
    `  from = "${redirect.from}"`,
    `  to = "${redirect.to}"`,
    `  status = ${redirect.status}`,
    ...(redirect.force ? ['  force = true'] : []),
  ].join('\n');

const S1_TOML_COMMENT =
  '# W15 S1: one path segment (`:objectId`), unforced — the splat + force pair\n' +
  '# shadowed the static content library index at /admin/content (root\n' +
  "# netlify.toml's comment has the full story).\n";

const S1_SITE_CONFIG_ENTRY =
  '    // W15 S1: one path segment, so /admin/content itself keeps serving the\n' +
  '    // static content library (the splat form swallowed the library index).\n' +
  "    { from: '/admin/content/:objectId', to: '/admin/content/__workspace', status: 200 },";

/**
 * Computes (and with `write: true` applies) the AUTOMATABLE parity fixes for
 * one site directory. Additive + idempotent by construction:
 *   - missing function shims are written from the create-site templates;
 *     existing shims are NEVER overwritten (custom shims like Dr-Lurie's mcp
 *     wire are legitimate);
 *   - the stale pre-S1 admin splat rewrite is REPLACED (the one sanctioned
 *     in-place edit) in netlify.toml and site.config.ts;
 *   - missing canonical redirects are APPENDED (netlify.toml) / inserted
 *     before the array close (site.config.ts);
 *   - a missing mcp-keepalive schedule block is appended;
 *   - missing reader blog loaders (W14 F11) are written.
 * Everything else (config bundle, env values, Identity) is reported, never
 * synthesized — those need per-client identity/brand facts or a human.
 */
export const planAdminParityFixes = (siteDir, { write = false } = {}) => {
  const target = resolveAuditTarget(siteDir);
  const ids = idsFor(target.slug.replace(/[^a-z0-9-]/g, '-'));
  const fixes = [];
  const note = (id, action, filePath) => fixes.push({ id, action, path: path.relative(repoRoot, filePath) });

  if (target.isRoot) {
    throw new Error('planAdminParityFixes targets a sites/<slug> directory; audit the root deploy read-only instead.');
  }

  // 1. Missing function shims.
  for (const name of coreFunctionNames()) {
    const existing = ['ts', 'js', 'mjs']
      .map((ext) => path.join(target.functionsDir, `${name}.${ext}`))
      .find(fs.existsSync);
    if (existing) continue;
    const file = path.join(target.functionsDir, `${name}.ts`);
    note('function-shims', `write missing shim ${name}.ts`, file);
    if (write) {
      fs.mkdirSync(target.functionsDir, { recursive: true });
      fs.writeFileSync(file, name === 'mcp' ? mcpShimTemplate(ids) : functionShimTemplate(ids, name));
    }
  }

  // 2. netlify.toml: stale admin splat → S1 form; missing canonical rules →
  //    append; missing keepalive schedule → append.
  if (fs.existsSync(target.tomlPath)) {
    let toml = fs.readFileSync(target.tomlPath, 'utf8');
    let changed = false;

    const staleBlockRe = new RegExp(
      // the whole [[redirects]] block whose from is the stale splat, incl. any
      // directly preceding comment lines
      String.raw`(?:^#[^\n]*\n)*\[\[redirects\]\]\n(?:  [^\n]*\n)*?  from = "${STALE_ADMIN_CONTENT_FROM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\n(?:  [^\n]*\n?)*`,
      'm'
    );
    if (staleBlockRe.test(toml)) {
      note(
        'admin-rewrite-s1',
        'replace stale /admin/content/* splat rule with the S1 single-segment form',
        target.tomlPath
      );
      toml = toml.replace(staleBlockRe, `${S1_TOML_COMMENT}${renderTomlRedirectBlock(ADMIN_CONTENT_REWRITE)}\n`);
      changed = true;
    }

    const parsed = parseNetlifyTomlRedirects(toml);
    const missing = CANONICAL_INFRA_REDIRECTS.filter((c) => !parsed.some((r) => r.from === c.from));
    if (missing.length) {
      note(
        'infra-redirects',
        `append ${missing.length} missing canonical redirect(s): ${missing.map((m) => m.from).join(', ')}`,
        target.tomlPath
      );
      toml = `${toml.trimEnd()}\n\n# W15 S2 admin parity: canonical infra redirects added by migrate-site --admin-parity.\n${missing
        .map((m) =>
          m.from === ADMIN_CONTENT_REWRITE.from
            ? `${S1_TOML_COMMENT}${renderTomlRedirectBlock(m)}`
            : renderTomlRedirectBlock(m)
        )
        .join('\n\n')}\n`;
      changed = true;
    }

    if (!/\[functions\."mcp-keepalive"\]/.test(toml)) {
      note('netlify-functions-config', 'append the mcp-keepalive schedule block', target.tomlPath);
      toml = `${toml.trimEnd()}\n\n# W15 S2 admin parity: a scheduled function only runs if its schedule is DECLARED here.\n[functions."mcp-keepalive"]\n  schedule = "*/5 * * * *"\n`;
      changed = true;
    }
    if (!/\[functions\."membership-sweep"\]/.test(toml)) {
      note('netlify-functions-config', 'append the membership-sweep schedule block', target.tomlPath);
      toml = `${toml.trimEnd()}\n\n# W18 T18.4: daily membership housekeeping (invitation expiry, purge) — a scheduled function only runs if DECLARED here.\n[functions."membership-sweep"]\n  schedule = "17 3 * * *"\n`;
      changed = true;
    }

    if (write && changed) fs.writeFileSync(target.tomlPath, toml);
  }

  // 3. site.config.ts: same two repairs on the redirects array.
  if (fs.existsSync(target.siteConfigPath)) {
    let src = fs.readFileSync(target.siteConfigPath, 'utf8');
    let changed = false;

    const staleEntryRe = /(?:^\s*\/\/[^\n]*\n)*\s*\{\s*from:\s*'\/admin\/content\/\*',[^}]*\},?\n/m;
    if (staleEntryRe.test(src)) {
      note('admin-rewrite-s1', 'replace stale /admin/content/* entry with the S1 form', target.siteConfigPath);
      src = src.replace(staleEntryRe, `\n${S1_SITE_CONFIG_ENTRY}\n`);
      changed = true;
    }

    const entries = parseSiteConfigRedirects(src) ?? [];
    const missing = CANONICAL_INFRA_REDIRECTS.filter((c) => !entries.some((r) => r.from === c.from));
    const arrayClose = src.match(/(redirects:\s*\[[\s\S]*?\n)(\s*\])/);
    if (missing.length && arrayClose) {
      note(
        'site-config-mirror',
        `insert ${missing.length} missing canonical redirect entr${missing.length === 1 ? 'y' : 'ies'}: ${missing.map((m) => m.from).join(', ')}`,
        target.siteConfigPath
      );
      const inserted = missing
        .map((m) =>
          m.from === ADMIN_CONTENT_REWRITE.from
            ? S1_SITE_CONFIG_ENTRY
            : `    { from: '${m.from}', to: '${m.to}', status: ${m.status} },`
        )
        .join('\n');
      src = src.replace(arrayClose[0], `${arrayClose[1]}${inserted}\n${arrayClose[2]}`);
      changed = true;
    }

    if (write && changed) fs.writeFileSync(target.siteConfigPath, src);
  }

  // 4. Reader blog loaders (W14 F11).
  for (const route of siteReaderRouteTemplates()) {
    const file = path.join(target.siteDir, 'app', 'pages', route.path);
    if (fs.existsSync(file)) continue;
    note('reader-blog-loaders', `write missing reader route loader ${route.path}`, file);
    if (write) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, route.content);
    }
  }

  // 5. W18 T18.7: the committed membership-policy override stub + its
  //    registration in policy-bindings (P1 — every tenant gets the same seam).
  const membershipPolicyPath = path.join(target.siteDir, 'config', 'membership-policy.ts');
  if (!fs.existsSync(membershipPolicyPath)) {
    note('config-bundle', 'write the membership-policy.ts override stub', membershipPolicyPath);
    if (write) {
      const stub = buildPlan({ name: target.slug.replace(/[^a-z0-9-]/g, '-') }).files.find((f) =>
        f.path.endsWith('/config/membership-policy.ts')
      );
      fs.mkdirSync(path.dirname(membershipPolicyPath), { recursive: true });
      fs.writeFileSync(membershipPolicyPath, stub.content);
    }
  }
  const bindingsPath = path.join(target.siteDir, 'config', 'policy-bindings.ts');
  if (fs.existsSync(bindingsPath)) {
    let src = fs.readFileSync(bindingsPath, 'utf8');
    if (!/setActiveMembershipPolicyProvider\(/.test(src)) {
      note('config-bundle', 'register the membership-policy override in policy-bindings.ts', bindingsPath);
      const importLines =
        `import { membershipPolicyConfig } from './membership-policy.js';\n` +
        `import { setActiveMembershipPolicyProvider } from '../../../packages/core/lib/membership-policy.js';\n`;
      // insert the imports after the last import statement
      const lastImport = [...src.matchAll(/^import [^;]*;\n/gm)].pop();
      src = lastImport
        ? src.slice(0, lastImport.index + lastImport[0].length) +
          importLines +
          src.slice(lastImport.index + lastImport[0].length)
        : importLines + src;
      src = `${src.trimEnd()}\n\n// W18 T18.7: the committed membership-policy override (runtime store overrides layer on top).\nsetActiveMembershipPolicyProvider(() => membershipPolicyConfig);\n`;
      if (write) fs.writeFileSync(bindingsPath, src);
    }
  }

  return { target, fixes };
};
