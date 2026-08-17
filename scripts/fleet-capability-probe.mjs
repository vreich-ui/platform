#!/usr/bin/env node
/**
 * FLEET CAPABILITY PROBE (T16.5) — live proof of per-tenant capability truth,
 * not repo parity. Calls each site's own `capability_status` (internal-only,
 * see packages/core/server/lib/capability-status.ts) and, for the families
 * where a safe read exists, ALSO exercises one cheap real MCP read so a tool
 * that lists in `tools/list` but 503s at call time on one tenant (the exact,
 * previously-undetected class of gap 16-genesis-parity-plan.md §1.1 records)
 * shows up here instead of living unnoticed (law P3).
 *
 * Usage:
 *   MCP_HTTP_AUTH_TOKEN__DRLURIE=… node scripts/fleet-capability-probe.mjs \
 *     --site drlurie --endpoint https://<host>/.netlify/functions/mcp [--site <slug> --endpoint <url> ...] [--markdown]
 *
 *   MCP_HTTP_AUTH_TOKEN__DRLURIE=… MCP_HTTP_AUTH_TOKEN__PLATFORM=… MCP_HTTP_AUTH_TOKEN__FERNWELL=… \
 *     node scripts/fleet-capability-probe.mjs --all [--markdown]
 *
 * The per-site token is ALWAYS read from env, NEVER from argv (argv leaks
 * into shell history and process lists — same rule as site-genesis-drive.mjs
 * and every other credentialed script in this repo): `MCP_HTTP_AUTH_TOKEN__<SLUG>`,
 * where `<SLUG>` is the site slug upper-cased with every run of non
 * [A-Z0-9] replaced by `_` (e.g. `drlurie` -> `MCP_HTTP_AUTH_TOKEN__DRLURIE`).
 * A site with no token set is reported as `token missing` and skipped over
 * the network — never a crash, never a silent 401.
 *
 * `--markdown` additionally prints a FLEET-STATUS.md-ready table block under
 * a `## Tenant capability matrix (live)` heading, for pasting into
 * docs/cms-architecture/FLEET-STATUS.md (T16.9 does this for real once run
 * with real fleet credentials).
 *
 * Exit code: 0 when every named site answered `capability_status` at all
 * (regardless of which families it reports unconfigured — that is DATA, not
 * a probe failure); 1 when any site could not be reached/authenticated/
 * answered with a malformed response; 2 on bad usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The REAL repo root — walked up, not `..`, because this module is also imported
// from the COMPILED test tree (.tmp/ci-test/scripts/…), same as admin-parity.mjs.
const findRepoRoot = (startDir) => {
  let dir = startDir;
  for (;;) {
    if (
      fs.existsSync(path.join(dir, 'netlify.toml')) &&
      fs.existsSync(path.join(dir, 'packages', 'core', 'app', 'shell-routes.ts'))
    )
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir, '..');
    dir = parent;
  }
};
const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

// ── the small committed fleet endpoints map (T16.5 brief) — `--all` iterates
//    this. Endpoint is each site's OWN `/mcp` front door (per-client
//    connectors over one shared engine — see CLAUDE.md's W14 framing).
//    Update this list in the same change that runs `create-site` for a new
//    tenant; canonicalHost values mirror sites/<slug>/site.config.ts. ──
export const FLEET_SITES = [
  { slug: 'drlurie', endpoint: 'https://drluriescience.netlify.app/.netlify/functions/mcp' },
  { slug: 'platform', endpoint: 'https://kugel-platform.netlify.app/.netlify/functions/mcp' },
  { slug: 'fernwell', endpoint: 'https://kugel-fernwell.netlify.app/.netlify/functions/mcp' },
  // Fleet tenant #4 (T12.12, minted 2026-08-14) — added here by W18 T18.7 (P1: the probe map
  // is part of what a tenant's existence must update).
  { slug: 'zilberman', endpoint: 'https://zilbermanfilmfoundation.netlify.app/.netlify/functions/mcp' },
];

// ── the ten families capability_status reports on. MUST stay in sync with
//    CAPABILITY_FAMILIES in packages/core/server/lib/capability-status.ts —
//    this file is plain .mjs (no TypeScript import here) so the list is
//    duplicated rather than imported; a mismatch would only ever DROP a
//    column from the printed matrix (capability_status itself is still the
//    source of truth read at runtime), never fabricate a false status. ──
export const CAPABILITY_FAMILIES = [
  'pdf_bridge',
  'pdf_storage_grant',
  'commerce',
  'purchase_token',
  'build_hook',
  'deploy_lookup',
  'git_committer',
  'blob_credentials',
  'mcp_auth',
  'artifact_upload',
];

// ── T11.7 env-table coverage (P2: "every var maps to a family or is listed
//    as unprobed with a reason"). Keys are every per-site/fleet-shared/
//    optional var in the T11.7 table (docs/cms-architecture/cms-pipeline/
//    T11.7-provisioning-cli.md); the value is either the capability_status
//    family it gates, or `null` with a `reason` explaining why it is not a
//    probe target. PURCHASE_TOKEN_SECRET is listed even though the T11.7
//    table itself doesn't carry it yet — see the "open risks" note this
//    script's module comment and the T16.5 session report both carry. ──
export const T11_7_ENV_COVERAGE = {
  // Core publish + repo binding
  PUBLISH_SECRET: {
    family: null,
    reason:
      'internal intra-process secret gating almost every tool call in mcp.ts (object store proxy, save-artifact, deploy-status, verify-article-images), not an external-service family of its own; its absence fails EVERY real read this probe attempts, so a gap here is caught immediately rather than needing a dedicated family.',
  },
  NETLIFY_SITE_ID: {
    family: 'blob_credentials',
    note: 'also the primary half of deploy_lookup (shared with NETLIFY_AUTH_TOKEN).',
  },
  NETLIFY_BUILD_HOOK_URL: { family: 'build_hook' },
  GITHUB_REPOSITORY: { family: 'git_committer' },
  GITHUB_BRANCH: {
    family: null,
    reason:
      "optional branch selector with a safe default ('main') per site-binding.ts — never gates configured/not-configured, only which branch a commit lands on.",
  },
  GITHUB_CONTENT_TOKEN: { family: 'git_committer' },
  GITHUB_COMMIT_AUTHOR_EMAIL: {
    family: null,
    reason:
      'cosmetic git-author fallback with a site-identity default (object-git-committer.ts resolveAuthor) — never gates configured/not-configured.',
  },
  GITHUB_COMMIT_AUTHOR_NAME: {
    family: null,
    reason: 'same as GITHUB_COMMIT_AUTHOR_EMAIL — cosmetic, has a code default.',
  },

  // Access, identity, governance
  MCP_HTTP_AUTH_TOKEN: {
    family: 'mcp_auth',
    note: 'trivially true if capability_status answered at all — a request that failed this gate never reaches a tool handler.',
  },
  ADMIN_EMAILS: {
    family: null,
    reason: '/admin UI role bootstrap, not an MCP tool-call gate any capability_status family covers.',
  },
  ROLE_EMAILS_ADMIN: { family: null, reason: '/admin UI role allowlist, not an MCP tool-call gate.' },
  ROLE_EMAILS_EDITOR: { family: null, reason: '/admin UI role allowlist, not an MCP tool-call gate.' },
  ROLE_EMAILS_PUBLISHER: { family: null, reason: '/admin UI role allowlist, not an MCP tool-call gate.' },
  IDENTITY_URL: { family: null, reason: 'Netlify Identity endpoint for the /admin UI, not an MCP tool-call gate.' },
  ARTIFACT_UPLOAD_TOKEN_SECRET: { family: 'artifact_upload' },
  ARTIFACT_URL_INGEST_ALLOWED_HOSTS: {
    family: null,
    reason:
      'a policy allowlist consulted inside create_artifact_from_url (artifact-url-ingest.ts) — an empty/absent value narrows what URLs are accepted, it does not flip a configured/not-configured boolean the way a credential does.',
  },

  // pdf-tool + tracking tenancy axes
  PDF_TOOL_PROJECT_ID: {
    family: null,
    reason:
      'resolver default falls back to the site slug (site-identity.ts) — changes the pdf-tool project namespace, never gates configured/not-configured.',
  },
  PDF_TOOL_BASE_URL: { family: 'pdf_bridge' },
  PDF_TOOL_AGENT_RUN_TOKEN: { family: 'pdf_bridge' },
  PDF_TOOL_STORAGE_SITE_ID: { family: 'pdf_storage_grant' },
  PDF_TOOL_STORAGE_TOKEN: { family: 'pdf_storage_grant' },
  TRACKING_PROJECT_ID: { family: null, reason: 'client-side tracking pixel partitioning, not an MCP tool-call gate.' },
  TRACKING_SALT: { family: null, reason: 'client-side tracking hashing salt, not an MCP tool-call gate.' },
  TRACKING_SINK_URL: { family: null, reason: 'client-side tracking sink endpoint, not an MCP tool-call gate.' },
  TRACKING_SINK_TOKEN: { family: null, reason: 'client-side tracking sink bearer, not an MCP tool-call gate.' },

  // AI + integrations
  ANTHROPIC_API_KEY: { family: null, reason: 'admin chat/agent surface credential, not an MCP tool-call gate.' },
  OPENAI_API_KEY: { family: null, reason: 'admin chat/agent surface credential, not an MCP tool-call gate.' },
  ANTHROPIC_MODEL: { family: null, reason: 'optional model override with a safe code default.' },
  OPENAI_CHATKIT_WORKFLOW_ID: { family: null, reason: 'admin ChatKit workflow config, not an MCP tool-call gate.' },
  NETLIFY_AUTH_TOKEN: {
    family: 'deploy_lookup',
    note: 'also the secondary alias half of blob_credentials (NETLIFY_BLOBS_TOKEN preferred there).',
  },
  STRIPE_SECRET_KEY: { family: 'commerce' },
  STRIPE_SECRET_KEY_TEST: { family: 'commerce' },
  STRIPE_WEBHOOK_SECRET: {
    family: null,
    reason:
      "gates the inbound stripe-webhook function's signature verification, not any capability_status-probable MCP tool family — only a real Stripe event exercises it, never a cheap read.",
  },
  STRIPE_WEBHOOK_SECRET_TEST: { family: null, reason: 'same as STRIPE_WEBHOOK_SECRET, test-mode counterpart.' },
  STRIPE_MODE: {
    family: null,
    reason: 'mode selector consumed INSIDE the commerce predicate itself (stripeMode()), not an independent gate.',
  },

  // Not part of T11.7's provisioning checklist, but present in its table —
  // included here so "every var in the table" is genuinely exhaustive.
  ARTIFACT_UPLOAD_MAX_BYTES: {
    family: null,
    reason: 'ops knob with a safe default; outside the T11.7 provisioning checklist.',
  },
  HERO_IMAGE_REQUIRED: {
    family: null,
    reason: 'feature flag with a safe default; outside the T11.7 provisioning checklist.',
  },
  MCP_ENABLE_ADMIN_TOOLS: {
    family: null,
    reason: 'feature flag with a safe default; outside the T11.7 provisioning checklist.',
  },
  MCP_HTTP_HOST: { family: null, reason: 'self-hosted/local MCP transport knob; unused on Netlify functions.' },
  MCP_HTTP_PORT: { family: null, reason: 'self-hosted/local MCP transport knob; unused on Netlify functions.' },
  MCP_HTTP_PATH: { family: null, reason: 'self-hosted/local MCP transport knob; unused on Netlify functions.' },
  MCP_HTTP_HEALTH_PATH: { family: null, reason: 'self-hosted/local MCP transport knob; unused on Netlify functions.' },
  MCP_KEEPALIVE_DISABLED: { family: null, reason: 'ops knob; unused on Netlify functions.' },
  MCP_KEEPALIVE_TARGET_URL: { family: null, reason: 'ops knob; unused on Netlify functions.' },
  SAVE_JSON_BLOB_BASE_URL: {
    family: null,
    reason: 'legacy — the save-json-blob pipeline was retired (OQ-W11-6); not provisioned for new clients.',
  },
  NETLIFY_BLOBS_API_URL: { family: null, reason: 'platform-injected; not hand-set.' },
  NETLIFY_BLOBS_TOKEN: {
    family: 'blob_credentials',
    note: 'the preferred alias read before NETLIFY_AUTH_TOKEN for blob_credentials.',
  },
  NETLIFY: { family: null, reason: 'platform-injected runtime flag; not hand-set.' },
  URL: { family: null, reason: 'platform-injected; not hand-set.' },
  BRANCH: { family: null, reason: 'platform-injected alias of GITHUB_BRANCH; not hand-set.' },
  CONTEXT: { family: null, reason: 'platform-injected; not hand-set.' },
  SITE_ID: {
    family: 'blob_credentials',
    note: 'the Netlify-injected alias half of NETLIFY_SITE_ID (also feeds deploy_lookup).',
  },

  // Site-identity overrides (transitional per T11.7 — escape hatch, source
  // of truth is sites/<client>/site.config.*)
  SITE_TAXONOMY_ID: { family: null, reason: 'transitional site-identity override, not an MCP tool-call gate.' },
  SITE_TRACKING_PROJECT_ID: { family: null, reason: 'transitional site-identity override, not an MCP tool-call gate.' },
  MCP_SERVER_NAME: {
    family: null,
    reason: 'transitional site-identity override (serverInfo.name), not a capability gate.',
  },
  MCP_SERVER_DIAGNOSTIC_NAME: {
    family: null,
    reason: 'transitional site-identity override (ping diagnostics), not a capability gate.',
  },
  SITE_ASSET_HOST: { family: null, reason: 'transitional site-identity override, not a capability gate.' },
  SITE_ASSET_FOLDER: { family: null, reason: 'transitional site-identity override, not a capability gate.' },

  // In the T16.5 brief's family list but NOT yet in the T11.7 table — an open
  // risk this probe surfaces rather than hides (see the session report).
  PURCHASE_TOKEN_SECRET: {
    family: 'purchase_token',
    note: "NOT currently listed in T11.7-provisioning-cli.md's env table — a P2 (env law) gap: add it there so a new client's checklist actually provisions it.",
  },
};

// ── per-family "one cheap real read" plan. `null` means: no safe read-only
//    exercise exists for this family (documented reason inline) — status
//    only, no live call attempted. ──
const REAL_READ_NOTES = {
  pdf_bridge:
    'list_pdf_templates {site_id, limit:1} — shared exercise with pdf_storage_grant (both must be configured for this call to succeed end to end).',
  pdf_storage_grant: 'list_pdf_templates {site_id, limit:1} — see pdf_bridge.',
  commerce:
    'no safe read-only exercise exists: product_set_price mutates a live Stripe price and commerce_orders never touches Stripe at all. Status-only.',
  purchase_token: 'no safe read-only exercise exists: order_reissue mutates order/fulfillment state. Status-only.',
  build_hook:
    'no safe read-only exercise exists: the only way to exercise this is to actually trigger a production build (a non-goal for a status probe). Status-only.',
  deploy_lookup: 'deploy_status {commit: <40 zero placeholder>} — a real, read-only Netlify deploy-receipt lookup.',
  git_committer:
    'no safe read-only exercise exists: every code path through object-git-committer.ts writes a commit. Status-only.',
  blob_credentials: 'object_inventory {} — a real, read-only blob-store scan.',
  mcp_auth:
    'trivially true if capability_status answered at all — the call already cleared the MCP auth gate. Status-only.',
  artifact_upload: 'create_artifact_upload_intent {…} — mints a signed token; never writes blob bytes.',
};

// ── identity (T18.0c): console-only prerequisites, NOT probed. Netlify Identity
//    has no MCP tool-call gate and no env var of its own (IDENTITY_URL is an
//    override), and this script never calls the Identity admin API — so the
//    probe can only TELL a human what to click. Printed once per tenant so the
//    output is the full truth about what a working invite flow needs. ──
export const IDENTITY_CONSOLE_PREREQUISITES = [
  'Identity enabled on the site (Project configuration → Identity → Enable)',
  'Registration → Invite only',
  'Emails → Invitation template path = /emails/identity/invitation.html',
  'Emails → Confirmation template path = /emails/identity/confirmation.html',
  'Emails → Recovery template path = /emails/identity/recovery.html',
  'Emails → Email change template path = /emails/identity/email-change.html',
  'ADMIN_EMAILS set (bootstrap Owner) — or the first Owner invited from /admin/settings/admins',
];

// ── membership (W18 T18.7): the `membership` family. Not a capability_status
//    family (W18 introduced NO env var — asserted in the T18.7 commit body) so
//    it is reported as its own block: the repo-side parity facts this probe can
//    read without a network (sweep declared, templates present, committed
//    policy override registered) and the two live reads a bearer-token probe
//    CAN make — `membership_status` (internal-only, non-secret; the verbs
//    themselves are human-only) and a HEAD on /admin/accept. ──
export const IDENTITY_EMAIL_TEMPLATE_FILES = ['invitation', 'confirmation', 'recovery', 'email-change'];

/** Root-deploy tenant: sites/<slug>/netlify.toml may not exist because the ROOT netlify.toml is that site's. */
const tomlPathFor = (slug) => {
  const own = path.join(repoRoot, 'sites', slug, 'netlify.toml');
  if (fs.existsSync(own)) return own;
  const root = path.join(repoRoot, 'netlify.toml');
  return fs.existsSync(root) ? root : null;
};

/** Repo-side membership parity for one tenant — pure disk reads, non-secret, no network. */
export const membershipRepoChecks = (slug) => {
  const toml = tomlPathFor(slug);
  const tomlText = toml ? fs.readFileSync(toml, 'utf8') : '';
  const sweepDeclared = /\[functions\."membership-sweep"\]\s*\n\s*schedule = /.test(tomlText);
  const templatesDir = path.join(repoRoot, 'packages', 'core', 'app', 'emails', 'identity');
  const missingTemplates = IDENTITY_EMAIL_TEMPLATE_FILES.filter(
    (f) => !fs.existsSync(path.join(templatesDir, `${f}.html`))
  );
  const configDir = path.join(repoRoot, 'sites', slug, 'config');
  const policyStub = fs.existsSync(path.join(configDir, 'membership-policy.ts'));
  const bindings = path.join(configDir, 'policy-bindings.ts');
  const policyRegistered =
    fs.existsSync(bindings) && /setActiveMembershipPolicyProvider\(/.test(fs.readFileSync(bindings, 'utf8'));
  return {
    sweep_declared: sweepDeclared
      ? 'ok'
      : `FAIL: no [functions."membership-sweep"] schedule in ${toml ? path.relative(repoRoot, toml) : 'netlify.toml (missing)'}`,
    templates_present: missingTemplates.length
      ? `FAIL: missing ${missingTemplates.join(', ')}`
      : 'ok (4/4 under packages/core/app/emails/identity)',
    policy_override:
      policyStub && policyRegistered
        ? 'ok (config/membership-policy.ts present + registered in policy-bindings)'
        : `FAIL: ${[!policyStub && 'config/membership-policy.ts missing', !policyRegistered && 'policy-bindings does not register it'].filter(Boolean).join('; ')}`,
  };
};

const acceptUrlFor = (endpoint) => {
  try {
    return new URL('/admin/accept', endpoint).toString();
  } catch {
    return null;
  }
};

const printMembershipBlock = (result) => {
  for (const [name, outcome] of Object.entries(result.membership ?? {})) {
    console.log(`   membership/${name.padEnd(18)} ${outcome}`);
  }
};

const printIdentityNote = () => {
  console.log(
    '   identity           (console-only, not probed)  human prerequisites for the invite flow — tick in FLEET-STATUS.md:'
  );
  for (const line of IDENTITY_CONSOLE_PREREQUISITES) console.log(`                      ☐ ${line}`);
};

// ── CLI ──────────────────────────────────────────────────────────────────
const parseArgs = (argv) => {
  const opts = { sites: [], all: false, markdown: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--site') {
      opts.sites.push({ slug: argv[i + 1] });
      i += 1;
    } else if (arg === '--endpoint') {
      const last = opts.sites[opts.sites.length - 1];
      if (!last || last.endpoint) {
        console.error('[fleet-capability-probe] --endpoint must directly follow the --site <slug> it belongs to');
        process.exitCode = 2;
        return null;
      }
      last.endpoint = argv[i + 1];
      i += 1;
    } else if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--markdown') {
      opts.markdown = true;
    } else if (arg === '--repo-only') {
      // W18 T18.7: print only the repo-side membership parity block per site — no token, no network.
      opts.repoOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    }
  }
  return opts;
};

const usage =
  'usage: node scripts/fleet-capability-probe.mjs (--site <slug> --endpoint <url>)... [--markdown]\n' +
  '       node scripts/fleet-capability-probe.mjs --all [--markdown]\n' +
  '       node scripts/fleet-capability-probe.mjs --all --repo-only   (W18 T18.7: membership parity from the repo, no token/network)\n' +
  '\n' +
  'Per-site token from env MCP_HTTP_AUTH_TOKEN__<SLUG> (never argv). --all reads the committed FLEET_SITES map in this file.';

/** `drlurie` -> `MCP_HTTP_AUTH_TOKEN__DRLURIE`. */
export const tokenEnvName = (slug) => `MCP_HTTP_AUTH_TOKEN__${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

// ── MCP transport — same tools/call-over-fetch pattern as
//    scripts/site-genesis-drive.mjs; reused, not reinvented. ──
let rpcId = 0;
const callTool = async (endpoint, token, name, args) => {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args ?? {} },
      }),
    });
  } catch (error) {
    return { ok: false, error: `network error: ${error instanceof Error ? error.message : String(error)}` };
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: `non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}` };
  }

  const result = body.result ?? {};
  const isError = Boolean(result.isError) || Boolean(body.error);
  return { ok: !isError, httpStatus: response.status, data: result.structuredContent ?? body.error ?? {} };
};

const brief = (value) => JSON.stringify(value).slice(0, 160);

const todayCompact = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

// ── probe one site ───────────────────────────────────────────────────────
export const probeSite = async (site) => {
  const tokenEnv = tokenEnvName(site.slug);
  const token = process.env[tokenEnv];
  if (!token) {
    return { slug: site.slug, endpoint: site.endpoint, ok: false, error: `${tokenEnv} is not set` };
  }

  const status = await callTool(site.endpoint, token, 'capability_status', {});
  if (!status.ok || !status.data || typeof status.data.families !== 'object') {
    return {
      slug: site.slug,
      endpoint: site.endpoint,
      ok: false,
      error: `capability_status call failed: ${brief(status.data ?? status.error)}`,
    };
  }

  const families = status.data.families;
  const siteObjectId = status.data.site_id;
  const realReads = {};

  const pdfConfigured = Boolean(families.pdf_bridge?.configured && families.pdf_storage_grant?.configured);
  if (pdfConfigured) {
    const listed = await callTool(site.endpoint, token, 'list_pdf_templates', { site_id: siteObjectId, limit: 1 });
    const outcome = listed.ok ? 'ok' : `FAIL: ${brief(listed.data ?? listed.error)}`;
    realReads.pdf_bridge = outcome;
    realReads.pdf_storage_grant = outcome;
  } else {
    realReads.pdf_bridge = 'skipped (capability_status reports unconfigured)';
    realReads.pdf_storage_grant = 'skipped (capability_status reports unconfigured)';
  }

  // object_inventory is attempted regardless of blob_credentials' configured
  // flag: blob-store.ts falls back to the Lambda blob context / local store
  // even without the EXPLICIT api-credential pair, so "unconfigured explicit
  // pair" must not be reported as "blobs unreachable" without actually
  // checking.
  const inventory = await callTool(site.endpoint, token, 'object_inventory', {});
  realReads.blob_credentials = inventory.ok
    ? families.blob_credentials?.configured
      ? 'ok'
      : 'ok (via runtime blob context, not the explicit API pair)'
    : `FAIL: ${brief(inventory.data ?? inventory.error)}`;

  if (families.deploy_lookup?.configured) {
    const looked = await callTool(site.endpoint, token, 'deploy_status', { commit: '0'.repeat(40) });
    realReads.deploy_lookup = looked.ok ? 'ok' : `FAIL: ${brief(looked.data ?? looked.error)}`;
  } else {
    realReads.deploy_lookup = 'skipped (capability_status reports unconfigured)';
  }

  if (families.artifact_upload?.configured) {
    const intent = await callTool(site.endpoint, token, 'create_artifact_upload_intent', {
      requestId: `req_capprobe_check_${todayCompact()}_01`,
      artifactKind: 'image',
      contentType: 'image/png',
      expectedSizeBytes: 1,
      expectedSha256: '0'.repeat(64),
    });
    realReads.artifact_upload = intent.ok ? 'ok' : `FAIL: ${brief(intent.data ?? intent.error)}`;
  } else {
    realReads.artifact_upload = 'skipped (capability_status reports unconfigured)';
  }

  for (const family of ['commerce', 'purchase_token', 'build_hook', 'git_committer', 'mcp_auth']) {
    realReads[family] = REAL_READ_NOTES[family];
  }

  // ── T12.13: the capture bridge, probed on its OWN axis ──────────────────
  // The capture plane needs ONLY the fleet-shared pdf_bridge pair: pdf-tool persists the
  // whole crawl output into its own store (Wolf, 2026-08-14 — "option A, same-site writes"),
  // so a tenant with no PDF_TOOL_STORAGE_TOKEN / PDF_TOOL_STORAGE_SITE_ID can still capture.
  // That is precisely why it cannot ride the pdf_bridge real-read above, which is gated on
  // BOTH families being configured: on a tenant with no per-site PAT that read is skipped and
  // the one capability this change makes load-bearing would go unprobed.
  //
  // Not a new capability_status family, because it introduces no new env var — a family is a
  // set of env-var names, and capture's are already covered by pdf_bridge. Reported as its own
  // line instead.
  const extraReads = {};
  if (families.pdf_bridge?.configured) {
    // Read-only, harmless, and reaches pdf-tool through the bridge WITHOUT a storage grant:
    // pdf-tool answers a nonexistent job with its own typed CAPTURE_JOB_NOT_FOUND / "Capture
    // job not found". Getting that back proves the whole credential-free path is live. A
    // storage-grant refusal coming back here would mean the deployed pdf-tool predates T12.13.
    const probed = await callTool(site.endpoint, token, 'get_capture_job_status', {
      site_id: siteObjectId,
      job_id: `capprobe-${todayCompact()}`,
    });
    const payload = brief(probed.data ?? probed.error ?? {});
    if (probed.ok) extraReads.capture_bridge = 'ok';
    else if (/CAPTURE_JOB_NOT_FOUND|[Cc]apture job not found/.test(payload)) {
      extraReads.capture_bridge = 'ok (bridge reached pdf-tool credential-free; probe job id is deliberately unknown)';
    } else if (/STORAGE_GRANT_REQUIRED/.test(payload)) {
      extraReads.capture_bridge = `FAIL: the deployed pdf-tool still demands a storage grant for capture (pre-T12.13 revision): ${payload}`;
    } else extraReads.capture_bridge = `FAIL: ${payload}`;
  } else {
    extraReads.capture_bridge = 'skipped (pdf_bridge reports unconfigured)';
  }

  // ── W18 T18.7: the membership family ─────────────────────────────────────
  const membership = { ...membershipRepoChecks(site.slug) };
  const mstatus = await callTool(site.endpoint, token, 'membership_status', {});
  if (mstatus.ok && mstatus.data && typeof mstatus.data.users_store === 'string') {
    const policy = mstatus.data.policy ?? {};
    membership.users_store =
      mstatus.data.users_store === 'reachable' ? 'ok (reachable)' : 'FAIL: users store unreachable';
    membership.policy =
      `${policy.source ?? '?'}` +
      (policy.committed_override_keys?.length ? ` committed[${policy.committed_override_keys.join(',')}]` : '') +
      (policy.store_override_keys?.length ? ` store[${policy.store_override_keys.join(',')}]` : '') +
      (policy.effective
        ? ` min_owners=${policy.effective.min_owners} ttl=${policy.effective.invite_ttl_hours}h who_can_invite=${policy.effective.who_can_invite}`
        : '');
  } else {
    membership.users_store = `FAIL: membership_status ${brief(mstatus.data ?? mstatus.error)}`;
    membership.policy = 'unknown (membership_status failed — deployed core predates T18.7?)';
  }
  const acceptUrl = acceptUrlFor(site.endpoint);
  if (acceptUrl) {
    try {
      const head = await fetch(acceptUrl, { method: 'HEAD', redirect: 'manual' });
      membership.accept_page =
        head.status === 200 ? `ok (HEAD ${acceptUrl} → 200)` : `FAIL: HEAD ${acceptUrl} → ${head.status}`;
    } catch (error) {
      membership.accept_page = `FAIL: HEAD ${acceptUrl}: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    membership.accept_page = 'skipped (no site URL known)';
  }

  return {
    slug: site.slug,
    endpoint: site.endpoint,
    ok: true,
    siteObjectId,
    families,
    realReads,
    extraReads,
    membership,
  };
};

// ── report ───────────────────────────────────────────────────────────────
const cell = (entry) => (entry.configured ? '✅ configured' : `❌ missing(${entry.missing.join(',')})`);

const printMatrix = (results) => {
  console.log(`fleet capability probe — ${new Date().toISOString()}`);
  console.log('');
  for (const result of results) {
    if (!result.ok) {
      console.log(`[${result.slug}] ${result.endpoint}`);
      console.log(`   ERROR: ${result.error}`);
      console.log('');
      continue;
    }
    console.log(`[${result.slug}] ${result.endpoint} (site_id: ${result.siteObjectId})`);
    for (const family of CAPABILITY_FAMILIES) {
      const entry = result.families[family];
      if (!entry) continue;
      console.log(`   ${family.padEnd(18)} ${cell(entry).padEnd(28)} real-read: ${result.realReads[family]}`);
    }
    for (const [name, outcome] of Object.entries(result.extraReads ?? {})) {
      // Not a capability_status family (no env var of its own) — reported as its own line so a
      // capability the fleet depends on cannot be load-bearing and unprobed. See T12.13.
      console.log(`   ${name.padEnd(18)} ${'(no env var of its own)'.padEnd(28)} real-read: ${outcome}`);
    }
    printMembershipBlock(result);
    printIdentityNote();
    console.log('');
  }
};

const printMarkdown = (results) => {
  const header = `| Tenant | ${CAPABILITY_FAMILIES.join(' | ')} |`;
  const divider = `| --- | ${CAPABILITY_FAMILIES.map(() => '---').join(' | ')} |`;
  const rows = results.map((result) => {
    if (!result.ok) return `| ${result.slug} | ${CAPABILITY_FAMILIES.map(() => `⚠️ ${result.error}`).join(' | ')} |`;
    return `| ${result.slug} | ${CAPABILITY_FAMILIES.map((family) => cell(result.families[family])).join(' | ')} |`;
  });

  console.log('## Tenant capability matrix (live)');
  console.log('');
  console.log(`_Generated by \`scripts/fleet-capability-probe.mjs\` on ${new Date().toISOString()}._`);
  console.log('');
  console.log(header);
  console.log(divider);
  for (const row of rows) console.log(row);
};

// ── main ─────────────────────────────────────────────────────────────────
export const main = async (argv) => {
  const opts = parseArgs(argv);
  if (!opts) return;
  if (opts.help || (!opts.all && opts.sites.length === 0)) {
    console.log(usage);
    process.exitCode = opts.help ? 0 : 2;
    return;
  }

  const targets = opts.all
    ? FLEET_SITES
    : opts.sites.map((site) => {
        if (!site.endpoint) {
          console.error(`[fleet-capability-probe] --site ${site.slug} has no --endpoint`);
          process.exitCode = 2;
        }
        return site;
      });
  if (process.exitCode === 2) return;

  if (opts.repoOnly) {
    console.log(`fleet membership parity (repo-side, W18 T18.7) — ${new Date().toISOString()}`);
    console.log('');
    for (const site of targets) {
      console.log(`[${site.slug}]`);
      printMembershipBlock({ membership: membershipRepoChecks(site.slug) });
      console.log('');
    }
    return;
  }

  const results = [];
  for (const site of targets) {
    results.push(await probeSite(site)); // sequential: sites are independent tenants, but keep console output ordered and avoid a thundering herd against three separate production endpoints
  }

  if (opts.markdown) printMarkdown(results);
  else printMatrix(results);

  process.exitCode = results.some((result) => !result.ok) ? 1 : 0;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[fleet-capability-probe] FAILED: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
