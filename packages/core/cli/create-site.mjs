#!/usr/bin/env node
/**
 * `create-site` — the W11 T11.7 provisioning CLI: "new client" = one command
 * (+ DNS, which stays human — see the runbook).
 *
 * `--name <client>` scaffolds `sites/<client>/`: a self-contained config
 * bundle (site-identity, SiteBinding, site.config, netlify.toml,
 * package.json) plus an empty committed-export tree and a baseline seed
 * pack (site singleton, nav skeleton, taxonomy skeleton, default theme,
 * five starter section-template recipes) — parameterized copies of the
 * canonical Dr-Lurie seed shapes with `<client>` ids, not Dr-Lurie's actual
 * content. `--dry-run` prints the full plan (files + Netlify actions + the
 * env checklist) and touches neither disk nor network. `--netlify-token`
 * additionally creates the Netlify site via the API, probes-provisions this
 * site's own blob stores (write → read → delete, the
 * scripts/provision-pdf-tool-stores.mjs pattern), and prints the real
 * per-site env checklist (docs/cms-architecture/T11.7-provisioning-cli.md's
 * table — kept in sync with docs/cms-architecture/site-provisioning-runbook.md
 * and the T11.10 governance/secrets inventory).
 *
 * Unlike the Dr-Lurie shell (`sites/drlurie/site.config.ts`, which re-exports
 * identity/binding singletons from `src/config/*` — that location is
 * Dr-Lurie's own committed config, not a shared core seam), a freshly
 * scaffolded client is FULLY self-contained under `sites/<client>/`: its own
 * `config/site-identity.ts` + `config/site-binding.ts` + `site.config.ts`,
 * importing only from `packages/core`. This is the "data + bindings only"
 * target shape (11-platformization-plan.md §2.2) with no residual
 * singleton-location assumption for the next client after this one.
 *
 * Secrets are never written to disk or printed: generatable per-site secrets
 * (PUBLISH_SECRET, TRACKING_SALT, ARTIFACT_UPLOAD_TOKEN_SECRET) are minted in
 * memory and, with a live token, pushed straight to the new Netlify site's
 * env store via the API — the checklist reports the env NAME and a ✓/☐
 * status, never the value. Human-owned values (GitHub tokens, Stripe keys,
 * admin emails…) get a placeholder line + a runbook pointer.
 *
 * Idempotent: an existing `sites/<client>/` directory is detected and left
 * untouched (this script only ever creates; re-run to see what would still
 * be missing, it never overwrites or deletes).
 *
 * Usage:
 *   node packages/core/cli/create-site.mjs --name acme --dry-run
 *   node packages/core/cli/create-site.mjs --name acme
 *   node packages/core/cli/create-site.mjs --name acme --netlify-token $NETLIFY_API_TOKEN
 *   node packages/core/cli/create-site.mjs --name acme --provision-only --netlify-token $NETLIFY_API_TOKEN \
 *     --known-tenant-site kugel-platform --known-tenant-site kugel-fernwell --known-tenant-site dr-lurie-root
 *
 * `--json` (combinable with every mode above): replace the prose report with
 * ONE machine-readable create_site_result.v1 JSON document on stdout — the
 * programmatic seam for CMS-Agent's one-call site duplication (T12.11). Same
 * actions, same idempotence, env var NAMES only, never values.
 *
 * `--known-tenant-site <netlify-site-name>` (repeatable): fleet-law storage
 * parity, enforced not just documented. PDF_TOOL_STORAGE_SITE_ID/TOKEN are
 * per-site, never fleet-shared (docs/agents/pdf-tool-storage-grant.md) — pass
 * every OTHER live tenant's Netlify site name and provisioning refuses to
 * finish if this site's storage target collides with one of theirs (checked
 * live via checkStorageGrantParity, below). Omit it and this check is
 * skipped entirely — it is additive, not required, so existing callers are
 * unaffected. See also the standalone scripts/audit-storage-grant-parity.mjs
 * for auditing an existing fleet without provisioning anything.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dataSiteSubdirs, scaffoldSeedFiles } from './genesis-manifest.mjs';
import { siteReaderRouteTemplates } from './site-reader-route-templates.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ─── W15 S3 follow-up (2026-08-05): the fleet-wide admin-nav gap. Every
// EXISTING tenant (platform, fernwell) was born without an admin-only nav
// group in its header — S3's parity audit never caught it because it is
// live CMS content (the nav_header object), not a repo file, so nothing
// checkable-from-the-repo ever proved it was missing. The admin workspace
// itself always worked (auth + /admin route are fleet law, shell-routes.ts);
// there was simply no visible link INTO it, so a newly signed-in admin saw
// no change and no way in short of typing /admin by hand. Fixed live on
// existing tenants by hand; this constant is the genesis-side fix so EVERY
// FUTURE `create-site` run is born with the link already there. Routes
// mirror shell-routes.ts's fleet-wide /admin/* surface — identical on every
// tenant, so this group needs no per-site parameterization.
export const ADMIN_NAV_GROUP = {
  id: 'g_admin',
  title: 'Admin',
  adminOnly: true,
  items: [
    {
      id: 'i_admin_dashboard',
      label: 'Dashboard',
      description: 'Admin home — overview and quick actions.',
      target: { kind: 'route', href: '/admin' },
    },
    {
      id: 'i_admin_content',
      label: 'Content library',
      description: 'Browse everything by human name — pages, articles, sections, and more.',
      target: { kind: 'route', href: '/admin/content' },
    },
    {
      id: 'i_admin_agents',
      label: 'Agents',
      description: 'Chat with CMS Agents across any object.',
      target: { kind: 'route', href: '/admin/agents' },
    },
    {
      id: 'i_admin_maintenance',
      label: 'Maintenance',
      description: 'Blob browser, diagnostics, and wipe tools (Owner-only).',
      target: { kind: 'route', href: '/admin/maintenance' },
    },
  ],
};

// ─── the per-site env checklist (T11.7-provisioning-cli.md's table; keep in
//     sync with docs/cms-architecture/site-provisioning-runbook.md and the
//     T11.10 governance/secrets inventory when either changes) ───
//
// class: 'per-site' (unique per client, no safe default) | 'fleet-shared'
//   (one value across the fleet — reuse it, do not mint a new one) |
//   'optional' (feature-gated / has a safe default).
// generate: a () => string used ONLY for per-site secrets that are safe to
//   mint automatically; absent entries need a human-supplied value.
const randomSecret = (bytes) => () => crypto.randomBytes(bytes).toString('hex');

export const ENV_CHECKLIST = [
  {
    group: 'Core publish + repo binding',
    rows: [
      { name: 'PUBLISH_SECRET', cls: 'per-site', generate: randomSecret(32), note: 'Publish/release gate secret.' },
      {
        name: 'NETLIFY_SITE_ID',
        cls: 'per-site',
        note:
          'Set AUTOMATICALLY by the provisioning run (W14 — blob runtime detection keys on it; a site without it ' +
          'runs its functions on the file-backed test store and fails at the first write). Only set by hand if ' +
          'provisioning reported a failure for it.',
      },
      {
        name: 'NETLIFY_BUILD_HOOK_URL',
        cls: 'per-site',
        note: 'Create a build hook on the new site, then paste its URL here.',
      },
      { name: 'GITHUB_REPOSITORY', cls: 'per-site', note: "The client's content repo (owner/name)." },
      { name: 'GITHUB_BRANCH', cls: 'per-site', note: 'Content branch (defaults to main if unset).' },
      {
        name: 'GITHUB_CONTENT_TOKEN',
        cls: 'per-site',
        note: "Write token scoped to the client's content repo (may be a fleet machine account, per-repo scoped — T11.10).",
      },
      {
        name: 'GITHUB_COMMIT_AUTHOR_EMAIL',
        cls: 'per-site',
        note: 'Git committer identity fallback (site-config-derived).',
      },
      { name: 'GITHUB_COMMIT_AUTHOR_NAME', cls: 'per-site', note: 'As above.' },
    ],
  },
  {
    group: 'Access, identity, governance',
    rows: [
      {
        name: 'MCP_HTTP_AUTH_TOKEN',
        cls: 'per-site',
        generate: randomSecret(24),
        note: 'Shared MCP auth key (deprecated-fallback once T11.10 per-agent tokens land).',
      },
      {
        name: 'ADMIN_EMAILS',
        cls: 'per-site',
        note:
          'BOOTSTRAP OWNER allowlist — /admin is unusable until this is set (or an invite exists): members are ' +
          'implicit Owners forever (roles.ts env fallback; a wiped users store can never lock the operator out). ' +
          'Human-owned; placeholder: the operator’s real email. Runbook: site-provisioning-runbook.md §admin.',
      },
      { name: 'ROLE_EMAILS_ADMIN', cls: 'per-site', note: 'Role allowlist — human-owned.' },
      { name: 'ROLE_EMAILS_EDITOR', cls: 'per-site', note: 'Role allowlist — human-owned.' },
      { name: 'ROLE_EMAILS_PUBLISHER', cls: 'per-site', note: 'Role allowlist — human-owned.' },
      {
        name: 'IDENTITY_URL',
        cls: 'per-site, optional',
        note:
          'GoTrue endpoint OVERRIDE only — functions fall back to "<site URL>/.netlify/identity", which is correct ' +
          'once Netlify Identity is ENABLED on the site. Enabling Identity is the real gate (console-only, human — ' +
          'runbook §admin); without it every /admin login and function auth check fails.',
      },
      {
        name: 'ARTIFACT_UPLOAD_TOKEN_SECRET',
        cls: 'per-site',
        generate: randomSecret(32),
        note: 'Signs artifact-upload intents.',
      },
      {
        name: 'ARTIFACT_URL_INGEST_ALLOWED_HOSTS',
        cls: 'per-site',
        note: 'Allowed hosts for URL-based artifact ingest — human-owned policy choice.',
      },
    ],
  },
  {
    group: 'pdf-tool + tracking tenancy axes',
    rows: [
      {
        name: 'PDF_TOOL_PROJECT_ID',
        cls: 'per-site',
        note: 'Escape hatch for the canonical project id committed in sites/<client>/config/site-identity.ts.',
      },
      {
        name: 'PDF_TOOL_BASE_URL',
        cls: 'fleet-shared',
        inheritFromPdfTool: true,
        note: 'Inherited automatically from the shared pdf-tool Netlify service for the server-side artifact bridge.',
      },
      {
        name: 'PDF_TOOL_AGENT_RUN_TOKEN',
        cls: 'fleet-shared',
        inheritFromPdfTool: true,
        note: 'Inherited automatically and stored as a Functions-only secret; never written to the scaffold or printed.',
      },
      {
        name: 'PDF_TOOL_STORAGE_SITE_ID',
        cls: 'per-site',
        note:
          "This site's own pdf-tool storage grant target (Netlify site id) — not fleet-shared. Provision a NEW " +
          "dedicated Netlify Blobs-scoped PAT + site id for THIS site (docs/agents/pdf-tool-storage-grant.md's " +
          '"Credential provisioning" steps); do not reuse another tenant\'s value. (Historically every tenant read ' +
          'one shared pair pointed at a single site’s storage; platform moved off that 2026-08-04 — treat the shared ' +
          'pair as legacy, not the default for a new client.)',
      },
      {
        name: 'PDF_TOOL_STORAGE_TOKEN',
        cls: 'per-site',
        note:
          'Auth paired with PDF_TOOL_STORAGE_SITE_ID above — same rule: a dedicated PAT for THIS site, never ' +
          "another tenant's token. Same provisioning steps: docs/agents/pdf-tool-storage-grant.md.",
      },
      {
        name: 'TRACKING_PROJECT_ID',
        cls: 'per-site',
        note: "This client's partition in the tracking owner-DB (trk_<shortId> convention).",
      },
      {
        name: 'TRACKING_SALT',
        cls: 'per-site',
        generate: randomSecret(32),
        note: 'Hashing salt — MUST differ per site for cross-client privacy isolation.',
      },
      {
        name: 'TRACKING_SINK_URL',
        cls: 'per-site (may be fleet-shared)',
        note: 'Owner-DB sink endpoint — one shared DB is allowed with TRACKING_PROJECT_ID as the partition.',
      },
      {
        name: 'TRACKING_SINK_TOKEN',
        cls: 'per-site (may be fleet-shared)',
        note: 'Bearer for the sink; pairs with TRACKING_SINK_URL.',
      },
    ],
  },
  {
    group: 'AI + integrations',
    rows: [
      {
        name: 'ANTHROPIC_API_KEY',
        cls: 'fleet-shared',
        note:
          'AI provider key — reuse the fleet value. Admin-critical: the /admin agents hub and every per-object ' +
          'chat instantiate a provider adapter (both providers are v1 — Wolf 2026-07-16).',
      },
      {
        name: 'OPENAI_API_KEY',
        cls: 'fleet-shared',
        note: 'AI provider key — reuse the fleet value (second v1 adapter).',
      },
      {
        name: 'CMS_AGENT_MCP_ENDPOINT',
        cls: 'fleet-shared',
        note:
          "The shared CMS-Agent Cloud Run Streamable-HTTP MCP URL (…/mcp) the admin chat's client_manager turns " +
          'run through — one service for the whole fleet; reuse the fleet value.',
      },
      {
        name: 'CMS_AGENT_MCP_TOKEN',
        cls: 'per-site',
        note:
          "This site's OWN scoped CMS-Agent bearer — never fleet-shared and never MCP_API_TOKEN. Minted into " +
          'the Secret Manager secret mcp-scoped-tokens-json, scoped to {projects: [this project], toolAllowlist: ' +
          '[agent_resolve, agent_converse]} — that scope is what makes one tenant structurally incapable of ' +
          'acting as another. Store Functions-only + secret so no value can reach a client bundle.',
      },
      {
        name: 'CMS_AGENT_CHAT_MODE',
        cls: 'per-site, optional',
        note:
          'off (default) | fallback | required — the admin-chat engine ladder. Unset, blank or ' +
          'unrecognized all resolve to off, so a typo can never promote a site. Cutover flips this per site ' +
          '(governance override is the instant, no-deploy rollback).',
      },
      {
        name: 'CMS_AGENT_PROJECT_ID',
        cls: 'per-site, optional',
        note: 'Escape hatch for the canonical project id committed in sites/<client>/config/site-identity.ts.',
      },
      // OPENAI_CHATKIT_WORKFLOW_ID was removed W15 S2: ChatKit retired at
      // T9.24 (OQ-W9-1) — the in-house agents hub replaced it and no core
      // code reads the variable any more.
      {
        name: 'NETLIFY_AUTH_TOKEN',
        cls: 'fleet-shared',
        note: 'Netlify account API token (provisioning/build automation) — reuse the fleet value.',
      },
      {
        name: 'STRIPE_SECRET_KEY',
        cls: 'per-site, optional',
        note: "Shop module only, if this client sells — the client's own Stripe account.",
      },
      { name: 'STRIPE_SECRET_KEY_TEST', cls: 'per-site, optional', note: 'Shop test key.' },
      { name: 'STRIPE_WEBHOOK_SECRET', cls: 'per-site, optional', note: 'Shop webhook signing secret.' },
      { name: 'STRIPE_WEBHOOK_SECRET_TEST', cls: 'per-site, optional', note: 'Shop test webhook secret.' },
      {
        name: 'PURCHASE_TOKEN_SECRET',
        cls: 'per-site, optional',
        generate: randomSecret(32),
        note:
          'Signs the expiring bearer download token (purchase-tokens.ts) that gates digital-goods delivery — ' +
          'get-purchase/order_reissue/stripe-webhook/claim-free all read it (free claims too, not only paid Stripe ' +
          'orders). Needed only if this client\'s shop module delivers downloads. Unset (or <16 chars): those ' +
          'endpoints 503 with a plain message, not a catalogued errorCode. Covered by the T16.5 capability probe ' +
          "(purchase_token family)." ,
      },
    ],
  },
];

// Transitional escape-hatch env overrides (src/lib/site-identity.ts) —
// surfaced for parity per the brief, but create-site prefers the config
// file: these are named here, never generated or required.
export const SITE_IDENTITY_ENV_OVERRIDES = [
  'SITE_OBJECT_ID',
  'SITE_SLUG',
  'SITE_BRAND_NAME',
  'SITE_TAXONOMY_ID',
  'SITE_TRACKING_PROJECT_ID',
  'MCP_SERVER_NAME',
  'MCP_SERVER_DIAGNOSTIC_NAME',
  'SITE_ASSET_HOST',
  'SITE_ASSET_FOLDER',
  'PDF_TOOL_PROJECT_ID',
  'CMS_AGENT_PROJECT_ID',
];

// This site's own blob-store namespace (packages/core/server/lib/{blob-store,
// governance-store,users-store}.ts + agent/{chat-store,profiles}.ts — keep
// this list in sync with those store-name literals, the same discipline
// scripts/provision-pdf-tool-stores.mjs uses for the pdf-tool's stores).
// W15 S2 made the sync CHECKED, not tribal: admin-parity.mjs's
// scanCoreBlobStoreNames() reads the literals out of packages/core and the
// audit fails when this list under-covers them. That check is what caught
// the four stores appended below — `agent-profiles` (the W9 §4a
// dedicated-agent store the admin chat resolves profiles from) plus
// `opt-ins`/`commerce-events`/`tracking-events` (blob-store.ts) were used by
// core but never probed at provisioning time, so a new tenant could look
// provisioned while its admin chat hub had an unverified store.
export const CORE_BLOB_STORES = [
  'site-objects',
  'workflows',
  'artifacts',
  'artifact-index',
  'commerce',
  'agent-chats',
  'agent-profiles',
  'governance',
  'users',
  'opt-ins',
  'commerce-events',
  'tracking-events',
  // S4x (2/2): the tagged canvas Ask-AI proposal trail a save carries —
  // write-mostly training data, admin-object.ts's only consumer.
  'agent-learning',
  // W15 S4 (MVP): Marginalia comment threads — the dedicated blob-store side
  // channel getMarginaliaBlobStore reads/writes, independent of the object
  // substrate's lock/version/patch lifecycle.
  'marginalia',
  // QA-W16-1: the idempotency-key bridge (idempotency-store.ts /
  // getIdempotencyBlobStore) — one strongly-consistent store holding the
  // first successful result per (tool, caller-supplied idempotency_key), so
  // a same-key retry after a timeout/502 replays it instead of re-running
  // the write.
  'idempotency',
];

// T16.0: derived from the genesis manifest, the one staged source of truth
// shared with site-genesis-drive.mjs. Add a subdir THERE, not here.
const DATA_SITE_SUBDIRS = dataSiteSubdirs();

// ─── validation ───

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

export const validateClientSlug = (name) => {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('--name is required, e.g. --name acme');
  }
  if (!SLUG_RE.test(name)) {
    throw new Error(
      `--name '${name}' is invalid: must be lowercase, start with a letter, and contain only letters/digits/hyphens (2-31 chars).`
    );
  }
  return name;
};

// ─── plan ids ───

export const idsFor = (clientSlug) => {
  const clientId = clientSlug.replace(/-/g, '_');
  return {
    clientSlug,
    clientId,
    siteId: `site_${clientId}`,
    taxonomyId: `tax_${clientId}`,
    themeId: `thm_${clientId}_default`,
  };
};

// ─── file content templates ───

const titleCase = (slug) =>
  slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');

const siteIdentityTemplate = (ids, brandName) => `/**
 * ${brandName} site-identity config (T11.7 scaffold) — every tenant-specific
 * identifier this client's deployment needs, in ONE place. Mirrors
 * src/config/site-identity.ts's shape (packages/core/lib/site-identity.ts's
 * SiteIdentityConfig) but lives under this client's own sites/<client>/ tree
 * — self-contained, no dependency on another client's committed config.
 *
 * The committed site export (data/site/site.json, materialized from the
 * site singleton record) stays authoritative: a lockstep test should fail if
 * the two drift, the same discipline Dr-Lurie's site-identity.test.ts uses.
 */
import type { SiteIdentityConfig } from '../../../packages/core/lib/site-identity.js';

export const siteIdentityConfig = {
  siteId: '${ids.siteId}',
  siteSlug: '${ids.clientSlug}',
  brandName: '${brandName}',
  mcpServerName: '${titleCase(ids.clientSlug).replace(/\s+/g, '_')}_MCP_Server',
  mcpDiagnosticName: '${titleCase(ids.clientSlug).replace(/\s+/g, '_')}_MCP',
  // Placeholder — point at this client's real asset CDN before going live.
  assetHost: 'https://example-assets.netlify.app',
  assetFolder: '${ids.clientSlug}',
  pdfToolProjectId: '${ids.clientSlug}',
} satisfies SiteIdentityConfig;
`;

/**
 * Capability flags every `SiteBinding` this template scaffolds — AND every
 * already-existing `sites/<client>/config/site-binding.ts` — must declare
 * `true` (T16.3 fleet-wide parity; `warmAdminKeepalive` was drlurie-only
 * before). Single source of truth for `admin-parity`'s `binding-capability`
 * check (packages/core/cli/admin-parity.mjs): add a flag here AND to the
 * template below in the SAME change, never one without the other.
 */
export const SITE_BINDING_CAPABILITY_FLAGS = ['warmAdminKeepalive'];

const siteBindingTemplate = (ids) => `/**
 * ${ids.clientSlug} SiteBinding (T11.7 scaffold) — this client's instantiation
 * of the core server layer's per-site seam (packages/core/server/lib/
 * site-binding.ts). Carries the site id, the env-var NAMES the server
 * machinery reads (the shared \`PLATFORM_ENV_NAMES\` — every client reads the
 * same names, the platform supplies per-site values, OQ-W11-4), and this
 * site's committed-export root.
 */
import { PLATFORM_ENV_NAMES, type SiteBinding } from '../../../packages/core/server/lib/site-binding.js';
import { siteIdentityConfig } from './site-identity.js';

export const siteBinding: SiteBinding = {
  siteId: siteIdentityConfig.siteId,
  env: PLATFORM_ENV_NAMES,
  dataRoot: 'sites/${ids.clientSlug}/data/site',
  // Admin cold-start fix (T16.3 fleet parity): admin-object/admin-audit
  // cold starts add ~1.3s TTFB to /admin/content. Warm them on the same
  // schedule as /mcp.
  warmAdminKeepalive: true,
};
`;

const siteConfigTemplate = (ids, brandName, canonicalHost) => `/**
 * ${brandName} site config (T11.7 scaffold) — the per-client bundle of
 * everything that binds a deployment of the core CMS to THIS site: identity,
 * canonical host, image domains, the redirect table, and the site binding.
 * Routing authority stays a committed FILE (Wolf B2) — this module IS that
 * file for this client. Mirrors sites/drlurie/site.config.ts's shape (the
 * W11 T11.6 pattern) but is fully self-contained under this client's own
 * tree — see ./config/site-identity.ts + ./config/site-binding.ts, not
 * another client's src/config/*.
 *
 * Wire this up the way sites/drlurie's shell does: astro.config.ts reads
 * canonicalHost/imageDomains from here for THIS deployment; config.yaml's
 * site URL must agree; netlify.toml's [[redirects]] must equal \`redirects\`
 * below. (Today only one Netlify build — Dr-Lurie's — reads any site.config
 * at build time; wiring an actual second deployment to read from ITS OWN
 * sites/<client>/site.config.ts, rather than sites/drlurie's, is T11.11's
 * job, not this scaffold's.)
 */
import { z } from 'zod';

import { siteIdentityConfig } from './config/site-identity.js';

const redirectSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
  status: z.number().int(),
});

export const siteConfigSchema = z.strictObject({
  siteId: z.string().regex(/^site_[a-z0-9]+$/),
  canonicalHost: z.string().regex(/^https:\\/\\/[^\\s/]+$/),
  imageDomains: z.array(z.string().min(1)),
  redirects: z.array(redirectSchema),
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;

export const siteConfig: SiteConfig = siteConfigSchema.parse({
  siteId: siteIdentityConfig.siteId,
  canonicalHost: '${canonicalHost}',
  imageDomains: [],
  redirects: [
    { from: '/pdf/*', to: '/.netlify/functions/get-public-pdf?blobKey=pdf/:splat', status: 200 },
    { from: '/img/*', to: '/.netlify/functions/get-public-image?blobKey=image/:splat', status: 200 },
    { from: '/mcp', to: '/.netlify/functions/mcp', status: 200 },
    { from: '/.well-known/oauth-protected-resource', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=protected-resource-metadata', status: 200 },
    { from: '/.well-known/oauth-protected-resource/*', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=protected-resource-metadata', status: 200 },
    { from: '/.well-known/oauth-authorization-server', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=authorization-server-metadata', status: 200 },
    { from: '/.well-known/oauth-authorization-server/*', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=authorization-server-metadata', status: 200 },
    { from: '/oauth/register', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=register', status: 200 },
    { from: '/oauth/authorize', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=authorize', status: 200 },
    { from: '/oauth/consent', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=consent', status: 200 },
    { from: '/oauth/token', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=token', status: 200 },
    { from: '/oauth/revoke', to: '/.netlify/functions/mcp-oauth?oauth_endpoint=revoke', status: 200 },
    { from: '/api/t', to: '/.netlify/functions/track-ingest', status: 200 },
    // W15 S1: one path segment, so /admin/content itself keeps serving the
    // static content library (the splat form swallowed the library index).
    { from: '/admin/content/:objectId', to: '/admin/content/__workspace', status: 200 },
  ],
});

export { siteIdentityConfig };
export { siteBinding } from './config/site-binding.js';
`;

const netlifyTomlTemplate = (ids) => `# Per-site Netlify config. The redirects here MUST equal this client's
# site.config.ts \`redirects\` (the drift-guard discipline root netlify.toml and
# the fleet's root-deployed site's site.config.ts already share).
#
# W14 T14.3: this file describes a REAL build. Set the Netlify project's BASE
# DIRECTORY to sites/${ids.clientSlug} — that is what makes Netlify read this
# file instead of the repo-root one. Every path below is then relative to that
# base, and the build command runs with sites/${ids.clientSlug} as its working
# directory (the shell's astro config, tailwind config, and config.yaml lookups
# are all absolute for exactly this reason).

# The build command self-heals the workspace install. Netlify runs this with
# the BASE DIRECTORY as cwd, and on a site's FIRST build (no warm cache) it does
# not necessarily install the monorepo ROOT — so \`astro\` is absent from
# node_modules, plain \`npx astro\` silently DOWNLOADS the latest astro from the
# registry, and that version rejects NODE_VERSION 20 ("not supported by Astro").
# That is exactly how fernwell's first build failed (W14 T14.9). So: resolve the
# workspace astro or install the root, then run astro with --no-install, which
# makes a missing binary a loud error instead of a silent wrong-version fetch.
# The check short-circuits on warm builds, so this costs nothing once cached.
#
# T16.2: the build also runs scripts/validate-upload-images.mjs, the same
# gate root's \`npm run build\` always ran — a corrupt/mismatched committed
# upload image or a dangling markdown image reference fails the BUILD, not
# just a later render. This site's own tree lays out uploads under
# assets/images and legacy markdown posts under data/post (not the
# root deploy's src/-prefixed legacy layout), so both roots are passed explicitly,
# site-relative (Netlify runs this command with sites/${ids.clientSlug} as cwd).
[build]
  publish = "dist"
  command = "(npx --no-install astro --version > /dev/null 2>&1 || npm ci --prefix ../.. --no-audit --no-fund) && node ../../scripts/validate-upload-images.mjs assets/images data/post && npx --no-install astro build --config astro.config.ts"
  # Netlify skips a build when nothing under the base directory (sites/${ids.clientSlug}) changed.
  # Our MCP functions bundle the shared packages/core workspace, which lives OUTSIDE this
  # base dir — so a packages/core-only change was being skipped and shipped stale functions
  # (PR #501, 2026-08-04). This ignore command builds when EITHER sites/${ids.clientSlug} OR
  # packages/core changed. exit 0 = skip, non-zero = build; \`git diff --quiet\` is 0 when
  # unchanged. An empty $CACHED_COMMIT_REF (first/forced build) makes git error non-zero =>
  # build, which is the safe default.
  ignore = "git -C ../.. diff --quiet $CACHED_COMMIT_REF $COMMIT_REF -- sites/${ids.clientSlug} packages/core"
[build.environment]
  NODE_VERSION = "20"
  # Same omission the root netlify.toml carries (W15 S3 parity): the secrets
  # scanner fails the ENTIRE build on any appearance of GITHUB_REPOSITORY's
  # literal value (the monorepo's own owner/name string) anywhere in scanned
  # files -- and repo docs legitimately name the repo. See the root file's
  # comment for the full story.
  SECRETS_SCAN_OMIT_KEYS = "GITHUB_REPOSITORY"

# T16.2 (genesis-parity-plan §1.2 item 4): the core build/security posture
# root netlify.toml has always carried — pretty_urls off, the /_astro/*
# immutable-cache header, and the CSP-Report-Only header — copied verbatim
# (the admin-parity \`toml-posture\` check enforces byte equality against
# packages/core/cli/admin-parity.mjs's CANONICAL_TOML_POSTURE).
[build.processing.html]
  pretty_urls = false
[[headers]]
  for = "/_astro/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

# W13 T13.8 (12-plan §4): the site's first CSP — REPORT-ONLY until T13.11's
# clean soak promotes the header name to Content-Security-Policy. This value
# is the ALL-PROVIDERS-DISABLED baseline: script-src keeps 'unsafe-inline'
# (the inline consent bootstrap + astro-compress reality); style/font cover
# the Google Fonts chrome; frame-src covers the T10.5 media mint's embed
# hosts (youtube-nocookie/vimeo); img-src stays wide (article/content images
# are externally hosted by design) — the pinning value lives in script-src,
# connect-src, and frame-src. Enabling any ad provider REQUIRES adding its
# adapter's cspHosts here in the SAME change: the hosts-drift test
# (tests/netlify/csp-drift.test.ts) fails otherwise, in both directions.
[[headers]]
  for = "/*"
  [headers.values]
    Content-Security-Policy-Report-Only = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://player.vimeo.com; object-src 'none'; base-uri 'self'"

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"

# Every site DEPLOYS \`mcp-keepalive\`, but a scheduled function only ever runs
# if its schedule is DECLARED here. Shipping the function without this block is
# what leaves a site's /mcp cold: after ~5-15 idle minutes the instance is
# reclaimed and the next agent pays a cold start (bundle load + native sharp
# binding) slow enough to blow an MCP client's initialize timeout — the
# "cannot connect" symptom the function exists to prevent. Scheduled functions
# run only on the published production deploy; MCP_KEEPALIVE_DISABLED=true
# turns probing off without a code change.
[functions."mcp-keepalive"]
  schedule = "*/5 * * * *"

[[redirects]]
  from = "/pdf/*"
  to = "/.netlify/functions/get-public-pdf?blobKey=pdf/:splat"
  status = 200
  force = true

[[redirects]]
  from = "/img/*"
  to = "/.netlify/functions/get-public-image?blobKey=image/:splat"
  status = 200
  force = true

[[redirects]]
  from = "/mcp"
  to = "/.netlify/functions/mcp"
  status = 200
  force = true

# W14 F10 — the site's own OAuth 2.1 authorization server, beside the MCP
# resource server it protects. One function serves every endpoint; each rule
# names its endpoint explicitly rather than relying on a splat, so the routing
# is readable here instead of inferred there. The two well-known splats exist
# because MCP clients probe both the bare metadata path and the
# resource-path-suffixed form.

[[redirects]]
  from = "/.well-known/oauth-protected-resource"
  to = "/.netlify/functions/mcp-oauth?oauth_endpoint=protected-resource-metadata"
  status = 200
  force = true

[[redirects]]
  from = "/.well-known/oauth-protected-resource/*"
  to = "/.netlify/functions/mcp-oauth?oauth_endpoint=protected-resource-metadata"
  status = 200
  force = true

[[redirects]]
  from = "/.well-known/oauth-authorization-server"
  to = "/.netlify/functions/mcp-oauth?oauth_endpoint=authorization-server-metadata"
  status = 200
  force = true

[[redirects]]
  from = "/.well-known/oauth-authorization-server/*"
  to = "/.netlify/functions/mcp-oauth?oauth_endpoint=authorization-server-metadata"
  status = 200
  force = true

[[redirects]]
  from = "/oauth/register"
  to = "/.netlify/functions/mcp-oauth?oauth_endpoint=register"
  status = 200
  force = true

[[redirects]]
  from = "/oauth/authorize"
  to = "/.netlify/functions/mcp-oauth?oauth_endpoint=authorize"
  status = 200
  force = true

[[redirects]]
  from = "/oauth/consent"
  to = "/.netlify/functions/mcp-oauth?oauth_endpoint=consent"
  status = 200
  force = true

[[redirects]]
  from = "/oauth/token"
  to = "/.netlify/functions/mcp-oauth?oauth_endpoint=token"
  status = 200
  force = true

[[redirects]]
  from = "/oauth/revoke"
  to = "/.netlify/functions/mcp-oauth?oauth_endpoint=revoke"
  status = 200
  force = true

[[redirects]]
  from = "/api/t"
  to = "/.netlify/functions/track-ingest"
  status = 200
  force = true

# W15 S1: one path segment (\`:objectId\`), unforced — the splat + force pair
# shadowed the static content library index at /admin/content (root
# netlify.toml's comment has the full story).
[[redirects]]
  from = "/admin/content/:objectId"
  to = "/admin/content/__workspace"
  status = 200
`;

const packageJsonTemplate = (ids) =>
  JSON.stringify(
    {
      name: `@fleet/site-${ids.clientSlug}`,
      version: '0.0.0',
      private: true,
      type: 'module',
      description:
        'Scaffold only (T11.7 create-site). This client site (data + bindings only). Depends on @fleet/core (link declared now; exercised once this site has content).',
      dependencies: {
        '@fleet/core': '*',
      },
    },
    null,
    2
  ) + '\n';

const siteSeedTemplate = (ids, brandName, canonicalHost) => `/**
 * Baseline site-singleton seed for '${ids.siteId}' (T11.7 create-site
 * scaffold). This is a STARTER body — placeholder branding an operator
 * replaces before going live, not finished client content. Follows the
 * sites/drlurie/seeds/site-seed-data.mjs shape exactly (same driver
 * contract) so the standard round-trip/reconcile tooling works unmodified
 * for any new client.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/${ids.clientSlug} --seeds sites/${ids.clientSlug}/seeds/site-seed-data.mjs
 */

export const SEED_SITE = '${ids.siteId}';

export const siteBody = {
  name: '${brandName}',
  logo: {
    text: '${brandName.toUpperCase()}',
  },
  urls: {
    base: '/',
    canonicalHost: '${canonicalHost}',
  },
  metadataDefaults: {
    description: '${brandName} — a starter site, ready for real content.',
    ogImage: '/Social/og-default.jpg',
    titleTemplate: '%s - ${brandName}',
  },
  brandTokens: {
    colors: {
      primary: 'rgb(51 102 204)',
      secondary: 'rgb(38 77 153)',
      accent: 'rgb(0 150 136)',
      gold: 'rgb(191 155 48)',
      'text-heading': 'rgb(20 24 28)',
      'text-default': 'rgb(38 43 48)',
      'text-muted': 'rgb(60 67 75 / 76%)',
      'bg-page': 'rgb(255 255 255)',
      'bg-surface': 'rgb(245 246 248)',
      'bg-page-dark': 'rgb(10 12 20)',
    },
    fonts: {
      sans: 'system-ui, sans-serif',
      serif: 'Georgia, serif',
      heading: 'Georgia, serif',
    },
  },
  chrome: {
    showRssFeed: false,
    showThemeToggle: true,
  },
  defaultNavigation: {
    header: 'nav_header',
    footer: 'nav_footer',
  },
  blog: {
    listPath: 'learn/library',
    postsPerPage: 6,
    categoryBase: 'category',
    tagBase: 'tag',
  },
};

export const CONVERSION_SEEDS = [{ objectType: 'site', objectId: '${ids.siteId}', body: siteBody }];
`;

const navigationSeedTemplate = (ids, brandName) => `/**
 * Baseline navigation SKELETON for '${ids.siteId}' (T11.7 create-site
 * scaffold) — one header menu, one footer menu, each carrying a single
 * "Home" link to '/'. Real content replaces this before launch; it exists
 * so the site singleton's defaultNavigation refs resolve immediately and the
 * round-trip driver has a non-empty nav to drill.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/${ids.clientSlug} --seeds sites/${ids.clientSlug}/seeds/navigation-seed-data.mjs
 */

export const SEED_SITE = '${ids.siteId}';

export const navHeaderBody = {
  role: 'header',
  groups: [
    {
      id: 'g_primary',
      items: [{ id: 'i_home', label: 'Home', target: { kind: 'route', href: '/' } }],
    },
    // W15 S3 follow-up: admin-only nav group, born with every new site so
    // the fleet-wide admin-nav gap (see ADMIN_NAV_GROUP's comment) can't
    // recur for a future client. Client sites remain free to relabel/move
    // this group; only its absence is the fleet-law problem.
    ${JSON.stringify(ADMIN_NAV_GROUP, null, 2).replace(/\n/g, '\n    ')},
  ],
};

export const navFooterBody = {
  role: 'footer',
  brand: { text: '${brandName}' },
  groups: [
    {
      id: 'g_footer_primary',
      items: [{ id: 'i_home', label: 'Home', target: { kind: 'route', href: '/' } }],
    },
  ],
  footNote: '© ${brandName}.',
};

export const CONVERSION_SEEDS = [
  { objectType: 'navigation', objectId: 'nav_header', body: navHeaderBody },
  { objectType: 'navigation', objectId: 'nav_footer', body: navFooterBody },
];
`;

const taxonomySeedTemplate = (ids) => `/**
 * Baseline taxonomy-registry SKELETON for '${ids.taxonomyId}' (T11.7
 * create-site scaffold) — zero terms. A brand-new client has no editorial
 * vocabulary yet; agents grow it with the taxonomy patch ops (add_term, …)
 * as real content gets written. Mirrors sites/drlurie/seeds/
 * taxonomy-seed-data.mjs's shape (empty kinds.category/tag term arrays parse
 * cleanly — taxonomy.v1 imposes no minimum).
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/${ids.clientSlug} --seeds sites/${ids.clientSlug}/seeds/taxonomy-seed-data.mjs
 */

export const SEED_SITE = '${ids.siteId}';

export const taxonomyBody = {
  kinds: {
    category: { terms: [] },
    tag: { terms: [] },
  },
};

export const CONVERSION_SEEDS = [{ objectType: 'taxonomy', objectId: '${ids.taxonomyId}', body: taxonomyBody }];
`;

const themeSeedTemplate = (ids) => `/**
 * Baseline default THEME for '${ids.themeId}' (T11.7 create-site scaffold).
 * Tokens are imported from the site seed so the default theme is
 * byte-identical to the starter palette — applying it to the untouched site
 * is a provable no-op (the same W8.4 zero-risk pattern Dr-Lurie's
 * thm_drlurie_default uses).
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/${ids.clientSlug} --seeds sites/${ids.clientSlug}/seeds/themes-seed-data.mjs
 */
import { siteBody } from './site-seed-data.mjs';

export const SEED_SITE = '${ids.siteId}';

export const themeDefaultBody = {
  name: 'Default',
  description: 'The starter palette, verbatim from the site seed — applying it to the untouched site is a no-op.',
  whenToUse: 'Apply to restore the starter palette after theme experiments, or copy as the starting point for a real brand palette.',
  scope: 'evergreen',
  tokens: structuredClone(siteBody.brandTokens),
};

export const CONVERSION_SEEDS = [{ objectType: 'theme', objectId: '${ids.themeId}', body: themeDefaultBody }];
`;

const sectionTemplatesSeedTemplate = (ids) => `/**
 * Baseline starter section-template RECIPES for '${ids.siteId}' (T11.7
 * create-site scaffold) — the same five core-provided starter shapes every
 * client gets (Dr-Lurie's sites/drlurie/seeds/section-templates-seed-data.mjs,
 * W8.1): a landing hero, a curated audience/feature grid, an automatic
 * related-articles strip, a newsletter CTA, and a closing CTA banner. All
 * blueprint copy is neutral starter text — a recipe supplies structure, an
 * agent replaces the copy before publishing. Recipe ids are stable across
 * the fleet (they carry no client-specific data, so there is no reason for
 * a client's copy to diverge from the canonical starter set).
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/${ids.clientSlug} --seeds sites/${ids.clientSlug}/seeds/section-templates-seed-data.mjs
 */

export const SEED_SITE = '${ids.siteId}';

export const sectionTemplateHeroLandingBody = {
  name: 'Landing hero',
  description: 'Opening hero for a landing or campaign page: kicker + heading + intro copy + action slots.',
  whenToUse: 'Stamp as the FIRST section of a campaign or landing page.',
  scope: 'evergreen',
  blueprint: {
    id: 's_stplhero',
    type: 'hero',
    data: {
      kicker: 'Overview',
      heading: 'New hero heading',
      body: '<p>One short paragraph setting up what this page offers.</p>',
      actions: [],
    },
  },
};

export const sectionTemplateAudienceGridBody = {
  name: 'Audience grid',
  description: 'Curated text-cell grid ("who this is for" / feature highlights) — cards are hand-written copy.',
  whenToUse: '"Who this is for" and feature-highlight rows where every cell is hand-written copy.',
  scope: 'evergreen',
  blueprint: {
    id: 's_stplaudience',
    type: 'content_grid',
    data: {
      kicker: 'Who this is for',
      heading: 'New audience heading',
      limit: 4,
      source: {
        kind: 'cards',
        cards: [
          { description: 'First audience or feature cell.' },
          { description: 'Second audience or feature cell.' },
        ],
      },
    },
  },
};

export const sectionTemplateRelatedArticlesBody = {
  name: 'Related articles',
  description: 'Automatic related-content strip: three tiles picked by tag similarity from published articles.',
  whenToUse: 'End-of-article and hub pages that should surface further reading automatically.',
  scope: 'evergreen',
  blueprint: {
    id: 's_stplrelated',
    type: 'content_grid',
    data: {
      kicker: 'Keep reading',
      heading: 'Related articles',
      limit: 3,
      source: { kind: 'related', algorithm: 'tag_similarity' },
    },
  },
};

export const sectionTemplateNewsletterCtaBody = {
  name: 'Newsletter CTA',
  description: 'A single-field email capture band.',
  whenToUse: 'Anywhere the page should offer an email opt-in.',
  scope: 'evergreen',
  blueprint: {
    id: 's_stplnewsletter',
    type: 'newsletter_signup',
    data: {
      heading: 'Stay in the loop',
      body: '<p>Get occasional updates — no spam.</p>',
      formName: 'newsletter',
    },
  },
};

export const sectionTemplateCtaBannerBody = {
  name: 'CTA banner',
  description: 'A full-width closing call-to-action band.',
  whenToUse: 'End-of-page closing CTA on interior or about-style pages.',
  scope: 'evergreen',
  blueprint: {
    id: 's_stplctabanner',
    type: 'cta_banner',
    data: {
      heading: 'Ready to get started?',
      body: '<p>One short closing sentence.</p>',
      actions: [],
    },
  },
};

export const CONVERSION_SEEDS = [
  { objectType: 'section_template', objectId: 'stpl_hero_landing', body: sectionTemplateHeroLandingBody },
  { objectType: 'section_template', objectId: 'stpl_audience_grid', body: sectionTemplateAudienceGridBody },
  { objectType: 'section_template', objectId: 'stpl_related_articles', body: sectionTemplateRelatedArticlesBody },
  { objectType: 'section_template', objectId: 'stpl_newsletter_cta', body: sectionTemplateNewsletterCtaBody },
  { objectType: 'section_template', objectId: 'stpl_cta_banner', body: sectionTemplateCtaBannerBody },
];
`;

// W15 S3 follow-up (2026-08-05): the fleet-wide template gap. `create-site`
// scaffolded a starter SECTION-template set (five stpl_* recipes, above) but
// never a starter TEMPLATE set (W2.5's tpl_interior/tpl_landing/tpl_legal —
// the whole-page recipes a Page object's `template` field points at). Every
// site born through the CLI has therefore shipped with ZERO template
// objects, unlike Dr-Lurie (built by hand pre-genesis, W2.5) which has all
// three. Not "no PageType support" — PageTypes are schema law regardless —
// but an agent creating a page on a genesis'd tenant has no starter recipe
// to instantiate from and must build page structure from scratch. These
// three bodies are copied verbatim from Dr-Lurie's
// sites/drlurie/seeds/templates-seed-data.mjs (W2.5) — system-owned starter
// copy, no client-specific data, so there is no reason for a client's set to
// diverge from the canonical starter set (same rule as the section
// templates above).
const templatesSeedTemplate = (ids) => `/**
 * Baseline starter TEMPLATE recipes for '${ids.siteId}' (W15 S3 follow-up to
 * the T11.7 create-site scaffold) — the same three core-provided starter
 * page shapes every client gets (Dr-Lurie's
 * sites/drlurie/seeds/templates-seed-data.mjs, W2.5): the standard interior
 * page, the campaign/landing page, and the minimal legal/system page. All
 * blueprint copy is neutral starter text — a recipe supplies structure, an
 * agent replaces the copy before publishing. Recipe ids are stable across
 * the fleet (they carry no client-specific data, so there is no reason for
 * a client's copy to diverge from the canonical starter set).
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/${ids.clientSlug} --seeds sites/${ids.clientSlug}/seeds/templates-seed-data.mjs
 */

export const SEED_SITE = '${ids.siteId}';

export const templateInteriorBody = {
  name: 'Interior page',
  description:
    'The standard interior-page shape: a quiet lede opener, one or more prose body sections, and an optional closing CTA banner.',
  whenToUse:
    'The default recipe for any evergreen content page — guides, explainers, policies. Pick tpl_landing when the page must convert with a hero + highlight grid; tpl_legal for single-block system boilerplate.',
  scope: 'evergreen',
  appliesTo: ['standard'],
  slots: [
    {
      slotId: 'slot_lede',
      allowed: ['lede'],
      required: true,
      repeatable: false,
      blueprint: {
        id: 's_tplintlede',
        type: 'lede',
        data: { kicker: 'Overview', heading: 'New page heading', actions: [] },
      },
    },
    {
      slotId: 'slot_body',
      allowed: ['prose'],
      required: true,
      repeatable: true,
      blueprint: {
        id: 's_tplintbody',
        type: 'prose',
        data: { body: '<p></p>' },
      },
    },
    {
      slotId: 'slot_cta',
      allowed: ['cta_banner'],
      required: false,
      repeatable: false,
      blueprint: {
        id: 's_tplintcta',
        type: 'cta_banner',
        data: { heading: 'Keep exploring', actions: [] },
      },
    },
  ],
};

export const templateLandingBody = {
  name: 'Landing page',
  description: 'The campaign/landing shape: hero opener, optional curated highlight grid, closing CTA banner.',
  whenToUse:
    'Conversion-weight pages — launches, program and offer pages, campaign destinations. For ordinary informational pages use tpl_interior.',
  scope: 'evergreen',
  appliesTo: ['standard'],
  slots: [
    {
      slotId: 'slot_hero',
      allowed: ['hero'],
      required: true,
      repeatable: false,
      blueprint: {
        id: 's_tpllandhero',
        type: 'hero',
        data: { heading: 'New page heading', actions: [] },
      },
    },
    {
      slotId: 'slot_grid',
      allowed: ['content_grid'],
      required: false,
      repeatable: true,
      blueprint: {
        id: 's_tpllandgrid',
        type: 'content_grid',
        data: {
          heading: 'Highlights',
          source: {
            kind: 'cards',
            cards: [{ title: 'First highlight' }, { title: 'Second highlight' }],
          },
          limit: 4,
        },
      },
    },
    {
      slotId: 'slot_cta',
      allowed: ['cta_banner'],
      required: false,
      repeatable: false,
      blueprint: {
        id: 's_tpllandcta',
        type: 'cta_banner',
        data: { heading: 'Ready for the next step?', actions: [] },
      },
    },
  ],
};

export const templateLegalBody = {
  name: 'Legal page',
  description:
    'A minimal system-page recipe: one required prose slot with no blueprint — instantiation fills it from the prose registry defaultData (the standing proof of the fallback path).',
  whenToUse:
    'Legal and system boilerplate — privacy, terms, disclaimers — where the page is one run of prose and nothing else.',
  scope: 'evergreen',
  appliesTo: ['system'],
  slots: [
    // No blueprint on purpose: instantiation falls back to the prose registry
    // defaultData — the standing proof that the fallback path works end-to-end.
    { slotId: 'slot_body', allowed: ['prose'], required: true, repeatable: true },
  ],
};

export const CONVERSION_SEEDS = [
  { objectType: 'template', objectId: 'tpl_interior', body: templateInteriorBody },
  { objectType: 'template', objectId: 'tpl_landing', body: templateLandingBody },
  { objectType: 'template', objectId: 'tpl_legal', body: templateLegalBody },
];
`;

// T16.1: the genesis manifest's ONBOARDING-stage seeds. Every genesis'd site
// carries the governed object TYPE (editorial_voice / tracking_config both
// validate against the shared core schema regardless of tenant) but never an
// invented INSTANCE (Wolf's 2026-08-05 types-not-instances ruling, plan §2).
// So these two templates emit STRUCTURALLY VALID skeletons — every id and
// filename parameterized per client — whose actual content is a placeholder
// an operator/agent fills in during onboarding, never copy this scaffold
// invented for the client. Every free-text field carries the literal marker
// string `onboarding: fill with the client` so a skeleton left un-edited is
// unmistakable from a real one.
const ONBOARDING_FILL_MARKER = 'onboarding: fill with the client';

const voiceSeedTemplate = (ids, brandName) => `/**
 * Editorial-voice SKELETON for '${ids.siteId}' (T16.1 create-site scaffold,
 * onboarding stage) — structurally valid (satisfies
 * packages/core/schema/bodies/editorial-voice-v1.ts) so the standard
 * round-trip/reconcile tooling works unmodified for any new client, but every
 * free-text field is a placeholder: genesis never invents a client's
 * editorial identity (Wolf's 2026-08-05 ruling; see
 * sites/drlurie/seeds/voice-seed-data.mjs for what a FILLED-IN voice looks
 * like). Replace every '${ONBOARDING_FILL_MARKER}' marker with the real
 * answer before this seed is ever driven into the store.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/${ids.clientSlug} --seeds sites/${ids.clientSlug}/seeds/voice-seed-data.mjs
 */

export const SEED_SITE = '${ids.siteId}';

export const voiceBody = {
  name: '${brandName} — voice (${ONBOARDING_FILL_MARKER})',
  audience: '${ONBOARDING_FILL_MARKER} — who is this publication written for?',
  tone: ['${ONBOARDING_FILL_MARKER}'],
  cadence: '${ONBOARDING_FILL_MARKER} — sentence/paragraph rhythm, person, tense.',
  lexicon: {
    prefer: [],
    avoid: [],
  },
  claim_policy: '${ONBOARDING_FILL_MARKER} — what may this publication assert, and what evidence does a claim need?',
  cta_policy: '${ONBOARDING_FILL_MARKER} — what may this publication ask a reader to do, and how directly?',
  reader_safety_notes: '${ONBOARDING_FILL_MARKER} — reader-harm boundaries specific to this audience, if any.',
  frameworks: [
    {
      framework_id: 'fw_placeholder',
      label: '${ONBOARDING_FILL_MARKER}',
      description: '${ONBOARDING_FILL_MARKER}',
      when_to_use: '${ONBOARDING_FILL_MARKER}',
      beats: [],
    },
  ],
  default_framework: 'fw_placeholder',
};

export const CONVERSION_SEEDS = [{ objectType: 'editorial_voice', objectId: 'voice_${ids.clientId}', body: voiceBody }];
`;

const trackingConfigSeedTemplate = (ids) => `/**
 * Tracking-config SKELETON for '${ids.siteId}' (T16.1 create-site scaffold,
 * onboarding stage) — structurally valid (satisfies
 * packages/core/schema/bodies/tracking-config-v1.ts) so the standard
 * round-trip/reconcile tooling works unmodified for any new client, but no
 * provider is enabled and every free-text field is a placeholder: genesis
 * never invents a client's analytics posture or copy (Wolf's 2026-08-05
 * ruling; see sites/drlurie/seeds/tracking-config-seed-data.mjs for what a
 * FILLED-IN config looks like). Replace every '${ONBOARDING_FILL_MARKER}'
 * marker — and pick a real consent posture — before this seed is ever driven
 * into the store.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/${ids.clientSlug} --seeds sites/${ids.clientSlug}/seeds/tracking-config-seed-data.mjs
 */

export const SEED_SITE = '${ids.siteId}';

export const trackingConfigBody = {
  // No analytics/ad provider is enabled by default — ${ONBOARDING_FILL_MARKER}
  // (docs/cms-architecture/12-object-tracking-and-analytics.md §4 has the
  // per-provider id shape when one is turned on).
  providers: {},
  consent: {
    // ${ONBOARDING_FILL_MARKER} — pick the posture that matches this client's
    // real audience geography: 'geo-adaptive' | 'consent-first' | 'us-first'.
    posture: 'consent-first',
    restricted_regions: [],
    honor_gpc: true,
    banner: {
      headline: 'Privacy choices',
      body: '${ONBOARDING_FILL_MARKER} — describe what this site measures and what a visitor is consenting to.',
      accept_label: 'Accept all',
      reject_label: 'Decline',
      manage_label: 'Manage choices',
    },
  },
  defaults: {
    page: ['pageview'],
    section: [],
    content_item: [],
    product: [],
    navigation: [],
    taxonomy: [],
    outbound_links: false,
    utm_capture: false,
  },
};

export const CONVERSION_SEEDS = [
  { objectType: 'tracking_config', objectId: 'trk_${ids.clientId}', body: trackingConfigBody },
];
`;

// ─── the per-site policy bundle (W14 T14.2) ───
//
// T11.10 gave Dr-Lurie its own `config/approval-policy.ts` + `creation-policy.ts`
// and T14.1 moved `media-policy.ts` + `policy-bindings.ts` alongside them. The
// scaffold owed a new client the same four: without `policy-bindings.ts` the
// shell cannot resolve site identity at all and the site does not build.
// Values are the fleet defaults — an operator retunes them per client.

const approvalPolicyTemplate = () => `/**
 * This site's approval posture. \`master\` sets the default for every governed
 * type; \`overrides\` narrows it per type.
 *
 * Commerce is the standing exception to an autonomous posture: an agent
 * PROPOSING a product change is fine, a price going live unseen is not.
 */
import type { ApprovalPolicyConfig } from '../../../packages/core/lib/approval-policy.js';

export const approvalPolicyConfig = {
  master: 'all-autonomous',
  overrides: { product: 'require-approval' },
} satisfies ApprovalPolicyConfig;
`;

const creationPolicyTemplate = () => `/**
 * Who may MINT objects of each type on this site. \`master: 'open'\` lets any
 * authenticated agent create; an override names the only agents allowed.
 *
 * \`tracking_config\` is seed-minted only — agents edit the singleton, they
 * never create one.
 */
import type { CreationPolicyConfig } from '../../../packages/core/lib/creation-policy.js';

export const creationPolicyConfig = {
  master: 'open',
  overrides: { tracking_config: { agents: ['object-conversion-roundtrip'] } },
} satisfies CreationPolicyConfig;
`;

const mediaPolicyTemplate = () => `/**
 * This site's image budget. \`overBudget: 'warn'\` records the overage and lets
 * the write through; 'block' refuses it.
 */
import type { MediaPolicyConfig } from '../../../packages/core/lib/media-policy.js';

export const mediaPolicyConfig = {
  maxImageBytes: 153_600, // 150 KB — web-optimized budget
  overBudget: 'warn',
  preferredImageFormat: 'webp',
} satisfies MediaPolicyConfig;
`;

const policyBindingsTemplate = (ids) => `/**
 * Site → core policy bindings for '${ids.siteId}'.
 *
 * \`packages/core\` holds the policy LAW and the provider seams; this module is
 * the site-side wiring that closes them. Import it for its side effect at any
 * entry point that reaches \`activeApprovalPolicy()\` / \`activeCreationPolicy()\`
 * / \`activeMediaPolicy()\` / \`getSiteIdentity()\` before the first call — every
 * Netlify function shim, and every client \`<script>\` that touches the auth
 * client (W14 T14.0; tests/scripts/client-scripts-site-bindings enforces that
 * half).
 *
 * Imports are RELATIVE, not the \`@core\` alias, so the module resolves under
 * the Node test runtime as well as under Astro/Vite.
 */
import { approvalPolicyConfig } from './approval-policy.js';
import { creationPolicyConfig } from './creation-policy.js';
import { mediaPolicyConfig } from './media-policy.js';
import { siteIdentityConfig } from './site-identity.js';
import {
  setActiveApprovalPolicyProvider,
  resolveApprovalPolicy,
  type ApprovalPolicy,
} from '../../../packages/core/lib/approval-policy.js';
import {
  setActiveCreationPolicyProvider,
  resolveCreationPolicy,
  type CreationPolicy,
} from '../../../packages/core/lib/creation-policy.js';
import {
  setActiveMediaPolicyProvider,
  resolveMediaPolicy,
  type MediaPolicy,
} from '../../../packages/core/lib/media-policy.js';
import { setSiteIdentityConfigProvider } from '../../../packages/core/lib/site-identity.js';

let approvalPolicy: ApprovalPolicy | undefined;
setActiveApprovalPolicyProvider((): ApprovalPolicy => (approvalPolicy ??= resolveApprovalPolicy(approvalPolicyConfig)));

let creationPolicy: CreationPolicy | undefined;
setActiveCreationPolicyProvider((): CreationPolicy => (creationPolicy ??= resolveCreationPolicy(creationPolicyConfig)));

let mediaPolicy: MediaPolicy | undefined;
setActiveMediaPolicyProvider((): MediaPolicy => (mediaPolicy ??= resolveMediaPolicy(mediaPolicyConfig)));

// site-identity resolves committed config + process env on each call (env may
// change between calls); the provider just supplies the committed config.
setSiteIdentityConfigProvider((): unknown => siteIdentityConfig);
`;

// ─── W14 T14.1/T14.2: the BUILD ENTRY ───
//
// T14.1 moved the application shell into `packages/core/app` and made each
// site a thin entry over it. A scaffolded site therefore needs four small
// files (astro config, content-collection binding, its own `config.yaml`
// routing table, and the reader routes it can actually serve) plus a
// BOOTSTRAP set of committed exports — see BOOTSTRAP_EXPORT_NOTE below.

const astroConfigTemplate = (ids) => `/**
 * ${ids.clientSlug}'s build entry — a thin entry over the shared shell in
 * \`packages/core/app\` (W14 T14.1). Everything structural lives there.
 *
 * The import is RELATIVE, not \`@core/…\`: Astro loads this file before Vite's
 * aliases exist.
 *
 *   npx astro build --config sites/${ids.clientSlug}/astro.config.ts
 */
import { defineSiteAstroConfig } from '../../packages/core/app/site-astro-config';

import { siteConfig } from './site.config';

export default defineSiteAstroConfig({
  siteDir: 'sites/${ids.clientSlug}',
  site: siteConfig.canonicalHost,
  imageDomains: siteConfig.imageDomains,
});
`;

const contentConfigTemplate = (ids) => `/**
 * ${ids.clientSlug}'s content collections. The collection SHAPES are fleet law
 * and live in the shell; this file supplies only this deployment's export root.
 * Astro requires the file at \`<srcDir>/content/config.ts\`, which is why every
 * site carries its own three-line copy.
 *
 * \`postDir\` is pinned to THIS site's own (empty) legacy shelf — W15 S3: the
 * shared default is \`src/data/post\`, which is Dr-Lurie's preserved legacy
 * content, and inheriting it published Dr-Lurie's committed test post on
 * every tenant with blog routes. Every real article here is a \`content_item\`
 * object; this shelf stays empty by design.
 */
import { buildSiteCollections } from '@core/app/content/collections';

export const collections = buildSiteCollections({
  dataRoot: 'sites/${ids.clientSlug}/data/site',
  postDir: 'sites/${ids.clientSlug}/data/post',
});
`;

const configYamlTemplate = (ids, brandName, canonicalHost) => `site:
  name: ${brandName}
  site: '${canonicalHost}'
  base: '/'
  trailingSlash: false

# Default SEO metadata
metadata:
  title:
    default: ${brandName}
    template: '%s — ${brandName}'
  description: '${brandName} — a starter site, ready for real content.'
  robots:
    index: true
    follow: true
  openGraph:
    site_name: ${brandName}
    images:
      - url: '/Social/og-default.jpg'
        width: 1200
        height: 630
    type: website
  twitter:
    cardType: summary_large_image

i18n:
  language: en
  textDirection: ltr

apps:
  blog:
    isEnabled: true
    postsPerPage: 6

    post:
      isEnabled: true
      permalink: '/%slug%'
      robots:
        index: true

    list:
      isEnabled: true
      pathname: 'learn/library'
      robots:
        index: true

    category:
      isEnabled: true
      pathname: 'category'
      robots:
        index: true

    tag:
      isEnabled: true
      pathname: 'tag'
      robots:
        index: false

    isRelatedPostsEnabled: false
    relatedPostsCount: 4

ui:
  theme: 'system'
`;

const pageLoaderTemplate = (objectId, note) => `---
/**
 * ${note}
 */
import PageObjectRenderer from '~/components/cms/PageObjectRenderer.astro';
---

<PageObjectRenderer objectId="${objectId}" />
`;

const objectPageCatchAllTemplate = () => `---
/**
 * Object-page catch-all — a Page object an agent creates, publishes, and
 * releases is served at its route by THIS file, no per-page loader needed.
 * Site-owned rather than injected by the shell because it enumerates the
 * file-owned routes NEXT TO IT with import.meta.glob, which only sees this
 * directory.
 */
import type { InferGetStaticPropsType, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';

import PageObjectRenderer from '~/components/cms/PageObjectRenderer.astro';
import { fetchPosts } from '~/utils/blog';
import { computeObjectPageRoutes } from '~/utils/object-page-routes';
import { BLOG_BASE, CATEGORY_BASE, TAG_BASE } from '~/utils/permalinks';

export const prerender = true;

export const getStaticPaths = (async () => {
  const routeFilePaths = Object.keys(import.meta.glob('./**/*.astro'));
  const pageEntries = await getCollection('pageObject');
  const posts = await fetchPosts();

  const { paths, skipped } = computeObjectPageRoutes({
    routeFilePaths,
    pageExports: pageEntries.map((entry) => ({
      objectId: entry.id,
      route: entry.data.route,
      pageType: entry.data.pageType,
    })),
    postPermalinks: posts.map((post) => post.permalink),
    reservedPrefixes: [BLOG_BASE, CATEGORY_BASE, TAG_BASE, 'learn/topics', 'admin'],
  });

  for (const skip of skipped) {
    if (skip.reason === 'file_route') continue;
    if (skip.reason === 'loader_owned_page_type') continue;
    console.warn(
      \`[objectPage] NOT serving \${skip.objectId} at \${skip.route} — \${skip.reason}. \` +
        'The published page is store-backed but unreachable; pick a route nobody else owns.'
    );
  }

  return paths.map((path) => ({
    params: { objectPage: path.param || undefined },
    props: { objectId: path.objectId },
  }));
}) satisfies GetStaticPaths;

type Props = InferGetStaticPropsType<typeof getStaticPaths>;
const { objectId } = Astro.props as Props;
---

<PageObjectRenderer objectId={objectId} />
`;

// ─── bootstrap committed exports ───
//
// A site cannot render one page until its navigation objects are published:
// PageLayout throws on a missing nav export BY DESIGN ("never leaves a surface
// half-fed"), and PageObjectRenderer throws on a missing page export. A freshly
// scaffolded site has an empty store, so without these it would not build at
// all — and "it builds" is the first thing an operator needs to see.
//
// These are BOOTSTRAP exports, not converted objects. Per CLAUDE.md's five-part
// definition they are rendered stubs: no store record backs them yet. The
// provisioning runbook's seed drive (create the real records through the front
// door, publish, release) REPLACES every one of them with a genuine derived
// export. `__generated.from` says so explicitly so nobody mistakes one for a
// published artifact.
const BOOTSTRAP_FROM = 'create-site:bootstrap (not store-backed — replaced by the seed drive)';

// A fixed sentinel, not the scaffold time. `at` means "when the store record
// was published" and no record was: a real timestamp here would claim a publish
// that never happened, and it would make buildPlan non-deterministic (two calls
// a millisecond apart differ, which the idempotency test correctly caught).
const BOOTSTRAP_AT = '1970-01-01T00:00:00.000Z';

const bootstrapExport = (body) =>
  `${JSON.stringify(
    {
      __generated: { at: BOOTSTRAP_AT, from: BOOTSTRAP_FROM, record_version: 0 },
      ...body,
    },
    null,
    2
  )}\n`;

const bootstrapSiteExport = (ids, brandName, canonicalHost) =>
  bootstrapExport({
    name: brandName,
    logo: { text: brandName.toUpperCase() },
    urls: { base: '/', canonicalHost },
    metadataDefaults: {
      description: `${brandName} — a starter site, ready for real content.`,
      ogImage: '/Social/og-default.jpg',
      titleTemplate: `%s - ${brandName}`,
    },
    brandTokens: {
      colors: {
        primary: 'rgb(51 102 204)',
        secondary: 'rgb(38 77 153)',
        accent: 'rgb(0 150 136)',
        gold: 'rgb(191 155 48)',
        'text-heading': 'rgb(20 24 28)',
        'text-default': 'rgb(38 43 48)',
        'text-muted': 'rgb(60 67 75 / 76%)',
        'bg-page': 'rgb(255 255 255)',
        'bg-surface': 'rgb(245 246 248)',
        'bg-page-dark': 'rgb(10 12 20)',
      },
      fonts: { sans: 'system-ui, sans-serif', serif: 'Georgia, serif', heading: 'Georgia, serif' },
    },
    chrome: { showRssFeed: false, showThemeToggle: true },
    defaultNavigation: { header: 'nav_header', footer: 'nav_footer' },
    blog: { listPath: 'learn/library', postsPerPage: 6, categoryBase: 'category', tagBase: 'tag' },
  });

const bootstrapNavHeaderExport = (brandName) =>
  bootstrapExport({
    role: 'header',
    brand: { text: brandName },
    groups: [
      {
        id: 'g_primary',
        items: [{ id: 'i_home', label: 'Home', target: { kind: 'route', href: '/' } }],
      },
      // W15 S3 follow-up: see ADMIN_NAV_GROUP's comment — the committed
      // placeholder export gets the same admin-only group as the seed
      // template so the immediate scaffold matches what the seed drive
      // would later publish.
      ADMIN_NAV_GROUP,
    ],
  });

const bootstrapNavFooterExport = (brandName) =>
  bootstrapExport({
    role: 'footer',
    brand: { text: brandName },
    footNote: `© ${brandName}`,
    groups: [
      {
        id: 'g_explore',
        title: 'Explore',
        items: [{ id: 'i_home', label: 'Home', target: { kind: 'route', href: '/' } }],
      },
    ],
  });

const bootstrapHomePageExport = (brandName, canonicalHost) =>
  bootstrapExport({
    pageType: 'system',
    route: '/',
    title: brandName,
    // Required to PUBLISH the real page_home (structure_home_footer) — carried
    // in the bootstrap so the seeded object is publishable without a fix-up patch.
    navigationOverrides: { footer: 'nav_footer' },
    seo: {
      description: `${brandName} — a starter site, ready for real content.`,
      robots: { index: true, follow: true },
    },
    sections: [
      {
        id: 's_welcome',
        type: 'prose',
        data: {
          // MUST satisfy the RichText allowlist (p,br,strong,em,a,ul,ol,li,h2,h3;
          // absolute http(s) hrefs only) — this body is not just rendered, it is
          // the BODY the genesis drive creates page_home from. The original text
          // used <code> and a root-relative /admin link, so every new client's
          // page_home 422'd at creation (W14 T14.9, hit on fernwell).
          body:
            `<h2>${brandName} is live.</h2>` +
            '<p>This starter page is a bootstrap export written by <strong>create-site</strong>. ' +
            `Sign in at <a href="${canonicalHost}/admin">${canonicalHost}/admin</a> and publish real ` +
            'content — the first publish replaces this file with a genuine derived export.</p>',
        },
      },
    ],
  });

const bootstrap404PageExport = (brandName) =>
  bootstrapExport({
    pageType: 'system',
    route: '/404',
    title: 'Page not found',
    seo: { description: 'Page not found.', robots: { index: false, follow: false } },
    sections: [
      {
        id: 's_notfound',
        type: 'prose',
        data: {
          body: `<h2>Page not found</h2><p>That page does not exist on ${brandName}.</p>`,
        },
      },
    ],
  });

// ─── per-site Netlify function shims (W14 T14.3 prep) ───
//
// Every core server function is a FACTORY over a SiteBinding; the thin file
// that instantiates it is per-site by definition. Netlify resolves
// `functions.directory` relative to a project's base directory, so a site whose
// Netlify project has base `sites/<client>` needs its own
// `netlify/functions/` tree — one three-line shim per factory, generated from
// whatever factories `packages/core/server/functions/` actually exports at
// scaffold time rather than from a list that would silently rot.
/**
 * The MCP server is the one core function that is not a plain
 * createHandler(siteBinding) factory: it is a COMPOSITE that dispatches to
 * three governed sibling handlers, and — on a site that has one — to the
 * legacy article path. A freshly scaffolded client has no legacy path, so its
 * shim wires the governed trio only. Every article on a new site is a
 * content_item OBJECT; the legacy dialect deliberately does not propagate.
 */
export const mcpShimTemplate = (ids) => `/**
 * Site shim for '${ids.siteId}'s MCP endpoint. The server is fleet law in
 * packages/core/server/functions/mcp.ts; this file is the per-site wire.
 *
 * This site has no legacy article path, so the legacy trio is not injected and
 * the tools that need it are absent from this site's tool list — the correct
 * outcome, not a gap.
 */
import '../../config/policy-bindings.js';

import { configureMcp } from '../../../../packages/core/server/functions/mcp.js';
import { createHandler as createSaveArtifactHandler } from '../../../../packages/core/server/functions/save-artifact.js';
import { createHandler as createObjectStoreHandler } from '../../../../packages/core/server/functions/object-store.js';
import { createHandler as createDeployStatusHandler } from '../../../../packages/core/server/functions/deploy-status.js';
import { siteBinding } from '../../config/site-binding.js';

configureMcp({
  saveArtifactHandler: createSaveArtifactHandler(siteBinding),
  objectStoreHandler: createObjectStoreHandler(siteBinding),
  deployStatusHandler: createDeployStatusHandler(siteBinding),
});
export * from '../../../../packages/core/server/functions/mcp.js';
`;

/**
 * A core function is Netlify **Functions-2.0** if it declares `export const
 * config` (a `Request`→`Response` handler reached at `config.path`); otherwise
 * it is v1 (`(event, context) => { statusCode, body }`). The export NAME the
 * runtime honours differs by generation: v2 wants `export default`, v1 wants
 * `export const handler`. Emit the wrong one and the function fails to
 * initialise — Netlify returns "invalid status code returned from lambda: 0"
 * (a 502 on every request, GET included). This is read from the core source,
 * not a hand-list, so a future v2 function is wired right the day it lands.
 * (T14.7 fix, W14 finding F2: the artifact-upload shim shipped as v1 `handler`
 * for a v2 function and 502'd at init on the platform site.)
 */
export const coreFunctionIsV2 = (fnName) => {
  const dir = path.join(repoRoot, 'packages', 'core', 'server', 'functions');
  for (const ext of ['ts', 'js', 'mjs']) {
    const file = path.join(dir, `${fnName}.${ext}`);
    if (fs.existsSync(file)) {
      return /^\s*export\s+const\s+config\s*[:=]/m.test(fs.readFileSync(file, 'utf8'));
    }
  }
  return false;
};

export const functionShimTemplate = (ids, fnName) => {
  const isV2 = coreFunctionIsV2(fnName);
  const handlerExport = isV2
    ? 'export default createHandler(siteBinding);'
    : 'export const handler = createHandler(siteBinding);';
  return `/**
 * Site shim for '${ids.siteId}': instantiates the core \`${fnName}\` handler with
 * this site's SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/${fnName}.ts; this file is the per-site wire.
 *
 * ${isV2 ? 'Functions-2.0 (config.path): the handler is the DEFAULT export.' : 'Functions-1.0: the handler is a named `handler` export.'}
 */
import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/${fnName}.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/${fnName}.js';

${handlerExport}
`;
};

/**
 * Factory names discovered from packages/core/server/functions/.
 *
 * Accepts .ts OR .js and dedupes by stem: this module also runs from the
 * COMPILED test tree (.tmp/ci-test), where the same directory holds .js. A
 * .ts-only filter silently returned an empty list there and the scaffold
 * dropped all 32 shims without failing anything.
 */
export const coreFunctionNames = () => {
  const dir = path.join(repoRoot, 'packages', 'core', 'server', 'functions');
  const stems = new Set();
  for (const name of fs.readdirSync(dir)) {
    const match = /^(.*)\.(ts|js|mjs)$/.exec(name);
    if (!match) continue;
    if (/\.(test|d)$/.test(match[1])) continue;
    stems.add(match[1]);
  }
  return [...stems].sort();
};

// ─── plan builder ───

export const buildPlan = (opts) => {
  const clientSlug = validateClientSlug(opts.name);
  const ids = idsFor(clientSlug);
  const brandName = opts.brandName || titleCase(clientSlug);
  const canonicalHost = opts.canonicalHost || `https://${clientSlug}.netlify.app`;
  const dir = `sites/${clientSlug}`;

  // T16.0: WHICH seed files a tenant is born with is the genesis manifest's
  // call; this table only says how each one is rendered. A manifest entry with
  // no template here is a scaffold gap and the drift test says so.
  const seedTemplates = {
    'site-seed-data.mjs': () => siteSeedTemplate(ids, brandName, canonicalHost),
    'navigation-seed-data.mjs': () => navigationSeedTemplate(ids, brandName),
    'taxonomy-seed-data.mjs': () => taxonomySeedTemplate(ids),
    'themes-seed-data.mjs': () => themeSeedTemplate(ids),
    'section-templates-seed-data.mjs': () => sectionTemplatesSeedTemplate(ids),
    'templates-seed-data.mjs': () => templatesSeedTemplate(ids),
    'voice-seed-data.mjs': () => voiceSeedTemplate(ids, brandName),
    'tracking-config-seed-data.mjs': () => trackingConfigSeedTemplate(ids),
  };

  const files = [
    { path: `${dir}/config/site-identity.ts`, content: siteIdentityTemplate(ids, brandName) },
    { path: `${dir}/config/site-binding.ts`, content: siteBindingTemplate(ids) },
    { path: `${dir}/config/approval-policy.ts`, content: approvalPolicyTemplate() },
    { path: `${dir}/config/creation-policy.ts`, content: creationPolicyTemplate() },
    { path: `${dir}/config/media-policy.ts`, content: mediaPolicyTemplate() },
    { path: `${dir}/config/policy-bindings.ts`, content: policyBindingsTemplate(ids) },
    { path: `${dir}/site.config.ts`, content: siteConfigTemplate(ids, brandName, canonicalHost) },
    { path: `${dir}/netlify.toml`, content: netlifyTomlTemplate(ids) },
    { path: `${dir}/package.json`, content: packageJsonTemplate(ids) },
    ...scaffoldSeedFiles()
      .filter((file) => seedTemplates[file])
      .map((file) => ({ path: `${dir}/seeds/${file}`, content: seedTemplates[file]() })),
    ...DATA_SITE_SUBDIRS.map((sub) => ({ path: `${dir}/data/site/${sub}/.gitkeep`, content: '' })),
    // The site's OWN legacy post shelf (empty by design) — the target of the
    // content config's `postDir` pin above, so the glob has a real directory.
    { path: `${dir}/data/post/.gitkeep`, content: '' },

    // W14 T14.1/T14.2 — the build entry and the routes it can serve.
    { path: `${dir}/astro.config.ts`, content: astroConfigTemplate(ids) },
    { path: `${dir}/config.yaml`, content: configYamlTemplate(ids, brandName, canonicalHost) },
    { path: `${dir}/app/content/config.ts`, content: contentConfigTemplate(ids) },
    {
      path: `${dir}/app/pages/index.astro`,
      content: pageLoaderTemplate('page_home', 'Home — a thin loader over the published page_home object.'),
    },
    {
      path: `${dir}/app/pages/404.astro`,
      content: pageLoaderTemplate(
        'page_404',
        'Not found — Astro treats a file at this exact path as the error-page handler.'
      ),
    },
    { path: `${dir}/app/pages/[...objectPage].astro`, content: objectPageCatchAllTemplate() },
    ...siteReaderRouteTemplates().map((route) => ({
      path: `${dir}/app/pages/${route.path}`,
      content: route.content,
    })),
    ...coreFunctionNames().map((fnName) => ({
      path: `${dir}/netlify/functions/${fnName}.ts`,
      content: fnName === 'mcp' ? mcpShimTemplate(ids) : functionShimTemplate(ids, fnName),
    })),
    { path: `${dir}/public/.gitkeep`, content: '' },
    { path: `${dir}/assets/images/.gitkeep`, content: '' },

    // Bootstrap committed exports — see BOOTSTRAP_FROM. Without these the site
    // cannot render a single page, because the shell fails loudly (by design)
    // on a missing navigation or page export.
    { path: `${dir}/data/site/site.json`, content: bootstrapSiteExport(ids, brandName, canonicalHost) },
    { path: `${dir}/data/site/navigation/nav_header.json`, content: bootstrapNavHeaderExport(brandName) },
    { path: `${dir}/data/site/navigation/nav_footer.json`, content: bootstrapNavFooterExport(brandName) },
    { path: `${dir}/data/site/pages/page_home.json`, content: bootstrapHomePageExport(brandName, canonicalHost) },
    { path: `${dir}/data/site/pages/page_404.json`, content: bootstrap404PageExport(brandName) },
  ];

  return { clientSlug, ids, brandName, canonicalHost, dir, files };
};

// ─── rendering (dry-run / execution report) ───

export const renderEnvChecklist = (executed) => {
  const lines = [];
  for (const { group, rows } of ENV_CHECKLIST) {
    lines.push(`  ${group}:`);
    for (const row of rows) {
      let status;
      if (executed && row.inheritFromPdfTool) status = '✓ inherited + set on the new site (value not shown)';
      else if (executed && row.generate) status = '✓ generated + set on the new site (value not shown)';
      else if (row.inheritFromPdfTool) status = 'inherited automatically from the shared pdf-tool service';
      else if (row.cls === 'fleet-shared') status = 'reuse the fleet value — do not create a new one';
      else status = '☐ human-supplied — see the provisioning runbook';
      lines.push(`    ${row.name.padEnd(32)} [${row.cls}]  ${status}`);
      lines.push(`      ${row.note}`);
    }
  }
  lines.push('  Transitional site-identity env overrides (escape hatch only; prefer the config file):');
  lines.push(`    ${SITE_IDENTITY_ENV_OVERRIDES.join(', ')}`);
  return lines.join('\n');
};

/**
 * The admin/editor bootstrap checklist (W15 S2). Printed with every plan and
 * every real run so "the tenant gets the full admin workspace" stops being
 * tribal knowledge: the three console steps are the HUMAN GATE between a
 * scaffolded site and a usable /admin; everything else on the list is
 * verified by scripts/audit-site-admin-parity.mjs.
 */
export const renderAdminBootstrapChecklist = () =>
  [
    'ADMIN WORKSPACE BOOTSTRAP (human gate — runbook site-provisioning-runbook.md §admin):',
    '  1. Enable Netlify Identity (GoTrue) on the new site — console-only; without it /admin login',
    '     has no identity service and every admin function 401s.',
    '  2. Set ADMIN_EMAILS on the site to the operator’s real email(s) — bootstrap Owners; the',
    '     users store can be empty/wiped and these addresses still get in.',
    '  3. Invite the first Owner via /admin/settings/admins (or rely on ADMIN_EMAILS alone).',
    `  Blob stores backing the workspace (probed automatically when a token is supplied): ${CORE_BLOB_STORES.join(', ')}.`,
    '  Verify any tenant any time:  node scripts/audit-site-admin-parity.mjs --site sites/<client>',
  ].join('\n');

export const renderPlan = (plan, { netlifyToken }) => {
  const lines = [];
  lines.push(`create-site plan for '${plan.clientSlug}' (${plan.brandName})`);
  lines.push(`  site id:        ${plan.ids.siteId}`);
  lines.push(`  taxonomy id:    ${plan.ids.taxonomyId}`);
  lines.push(`  theme id:       ${plan.ids.themeId}`);
  lines.push(`  canonical host: ${plan.canonicalHost}`);
  lines.push('');
  lines.push(`Files to create under ${plan.dir}/ (${plan.files.length}):`);
  for (const file of plan.files) lines.push(`  + ${file.path}`);
  lines.push('');
  if (netlifyToken) {
    lines.push('Netlify actions (would run with the provided token):');
    lines.push(`  - POST /api/v1/sites — create a site named '${plan.clientSlug}'`);
    lines.push(
      `  - probe (write → read → delete) this site's ${CORE_BLOB_STORES.length} blob stores: ${CORE_BLOB_STORES.join(', ')}`
    );
    lines.push(
      '  - generate + push per-site secrets (PUBLISH_SECRET, MCP_HTTP_AUTH_TOKEN, ARTIFACT_UPLOAD_TOKEN_SECRET, TRACKING_SALT) directly to the new site (never printed)'
    );
    lines.push(
      '  - inherit PDF_TOOL_BASE_URL + PDF_TOOL_AGENT_RUN_TOKEN from the shared pdf-tool service; store the token as a Functions-only production secret'
    );
  } else {
    lines.push('Netlify actions: none (no --netlify-token supplied — scaffold only).');
  }
  lines.push('');
  lines.push('Env checklist:');
  lines.push(renderEnvChecklist(false));
  lines.push('');
  lines.push(renderAdminBootstrapChecklist());
  return lines.join('\n');
};

// ─── execution ───

export const writeFiles = (plan) => {
  for (const file of plan.files) {
    const fullPath = path.join(repoRoot, file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content);
  }
};

/**
 * Look up an existing site by name so re-running provisioning is idempotent
 * rather than creating a second project (W14 T14.3: the first live run failed
 * partway through, and the only safe retry is one that reuses the site it
 * already made).
 */
export const findNetlifySite = async (fetchImpl, token, siteName) => {
  const response = await fetchImpl(`https://api.netlify.com/api/v1/sites?name=${encodeURIComponent(siteName)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return undefined;
  const sites = await response.json().catch(() => []);
  return Array.isArray(sites) ? sites.find((site) => site.name === siteName) : undefined;
};

const createNetlifySite = async (fetchImpl, token, siteName) => {
  const existing = await findNetlifySite(fetchImpl, token, siteName);
  if (existing) return existing;
  const response = await fetchImpl('https://api.netlify.com/api/v1/sites', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: siteName }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Netlify site creation failed: ${response.status} ${body}`);
  }
  return response.json();
};

const probeStore = async (getStore, { siteID, token }, storeName) => {
  const store = getStore({ name: storeName, siteID, token, consistency: 'strong' });
  const probeKey = `__create-site-provision-probe__/${crypto.randomUUID()}.json`;
  const payload = { probedAt: new Date().toISOString(), purpose: 'create-site provisioning probe' };
  await store.setJSON(probeKey, payload);
  const readBack = await store.get(probeKey, { type: 'json' });
  if (!readBack || readBack.probedAt !== payload.probedAt) {
    throw new Error(`probe read-back mismatch for store '${storeName}'`);
  }
  await store.delete(probeKey);
};

const setNetlifyEnvVar = async (
  fetchImpl,
  token,
  accountId,
  siteId,
  key,
  value,
  { scopes = ['builds', 'functions', 'runtime', 'post_processing'], context = 'all', isSecret = false } = {}
) => {
  const collectionUrl = `https://api.netlify.com/api/v1/accounts/${accountId}/env?site_id=${encodeURIComponent(siteId)}`;
  const keyUrl = `https://api.netlify.com/api/v1/accounts/${accountId}/env/${encodeURIComponent(key)}?site_id=${encodeURIComponent(siteId)}`;
  const existing = await fetchImpl(keyUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!existing.ok && existing.status !== 404) {
    throw new Error(`Netlify env-var lookup failed for ${key}: ${existing.status}`);
  }
  const variable = {
    key,
    scopes,
    values: [{ value, context }],
    ...(isSecret ? { is_secret: true } : {}),
  };
  const updating = existing.ok;
  const response = await fetchImpl(updating ? keyUrl : collectionUrl, {
    method: updating ? 'PUT' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    // POST takes an ARRAY; PUT replaces one existing variable with one object.
    // Checking first makes --provision-only a real repair path after a partial
    // run, instead of failing on whichever variables the first run did set.
    body: JSON.stringify(updating ? variable : [variable]),
  });
  if (!response.ok) {
    // A secret-setting error body must not be allowed to echo the submitted
    // bearer back into terminal logs or CI output.
    const body = isSecret ? '' : await response.text().catch(() => '');
    throw new Error(`Netlify env-var set failed for ${key}: ${response.status} ${body}`);
  }
};

export const getNetlifyEnvVars = async (fetchImpl, token, accountId, siteId) => {
  const response = await fetchImpl(
    `https://api.netlify.com/api/v1/accounts/${accountId}/env?site_id=${encodeURIComponent(siteId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) {
    throw new Error(`Netlify env-var read failed for shared pdf-tool service: ${response.status}`);
  }
  const variables = await response.json().catch(() => []);
  return Array.isArray(variables) ? variables : [];
};

export const contextValue = (variable) => {
  const values = Array.isArray(variable?.values) ? variable.values : [];
  return (
    values.find((entry) => entry?.context === 'production' && typeof entry.value === 'string')?.value ||
    values.find((entry) => entry?.context === 'all' && typeof entry.value === 'string')?.value
  );
};

/**
 * `checkStorageGrantParity` — the LIVE counterpart to ENV_CHECKLIST's
 * 'per-site' classification of PDF_TOOL_STORAGE_SITE_ID/TOKEN above: proves
 * (or disproves) that a set of named Netlify sites each has its OWN
 * dedicated pdf-tool storage target, rather than two tenants pointing at the
 * same physical Blobs store — the pre-2026-08-04 fleet default this repo is
 * moving off of (docs/agents/pdf-tool-storage-grant.md). Neither
 * PDF_TOOL_STORAGE_SITE_ID nor its paired token is ever committed (they are
 * per-site Netlify env values by design), so this is the only way to prove
 * parity: read the live values and compare.
 *
 * Deliberately takes an explicit list of site NAMES rather than discovering
 * "every site in the account" — an account-wide site-listing call isn't
 * exercised anywhere else in this file, so this composes only the two calls
 * already proven live here (site-by-name lookup, account-scoped env read)
 * instead of a new, unverified endpoint. Callers supply the fleet's known
 * tenant site names: the `--known-tenant-site` CLI flag below (provisioning
 * time) or scripts/audit-storage-grant-parity.mjs (standalone audit).
 *
 * Returns `{ rows, collisions }`:
 *   - rows: one entry per requested name — `{ siteName, status: 'ok' |
 *     'not-found' | 'unset', storageSiteId? }` ('unset' means the site
 *     exists but has no PDF_TOOL_STORAGE_SITE_ID yet — not itself a parity
 *     violation, just not provisioned; the bridge already fails closed for
 *     it, docs/agents/pdf-tool-storage-grant.md).
 *   - collisions: groups of 2+ DIFFERENT site names that reported the SAME
 *     non-empty storageSiteId — the actual parity violation.
 */
export const checkStorageGrantParity = async (fetchImpl, token, siteNames) => {
  const rows = [];
  for (const siteName of siteNames) {
    const site = await findNetlifySite(fetchImpl, token, siteName);
    const siteId = site?.id || site?.site_id;
    const accountId = site?.account_id;
    if (!site || !siteId || !accountId) {
      rows.push({ siteName, status: 'not-found' });
      continue;
    }
    const variables = await getNetlifyEnvVars(fetchImpl, token, accountId, siteId);
    const storageSiteId = contextValue(variables.find((variable) => variable?.key === 'PDF_TOOL_STORAGE_SITE_ID'));
    rows.push(storageSiteId ? { siteName, status: 'ok', storageSiteId } : { siteName, status: 'unset' });
  }

  const byStorageSiteId = new Map();
  for (const row of rows) {
    if (row.status !== 'ok') continue;
    const group = byStorageSiteId.get(row.storageSiteId) || [];
    group.push(row.siteName);
    byStorageSiteId.set(row.storageSiteId, group);
  }
  const collisions = [...byStorageSiteId.entries()]
    .filter(([, siteNamesSharingIt]) => siteNamesSharingIt.length > 1)
    .map(([storageSiteId, siteNamesSharingIt]) => ({ storageSiteId, siteNames: siteNamesSharingIt }));

  return { rows, collisions };
};

/**
 * Throws if `siteName` is one of the sites in a `checkStorageGrantParity`
 * collision group. Split out from `executeNetlifyProvisioning` so the
 * enforcement decision is a small, pure, directly-testable unit — the
 * surrounding function is all network I/O.
 */
export const assertNoStorageGrantCollision = ({ collisions }, siteName) => {
  const ownCollision = collisions.find((c) => c.siteNames.includes(siteName));
  if (!ownCollision) return;
  throw new Error(
    `PDF_TOOL_STORAGE_SITE_ID parity violation: '${siteName}' shares storage target ` +
      `'${ownCollision.storageSiteId}' with ${ownCollision.siteNames.filter((n) => n !== siteName).join(', ')}. ` +
      'Provision a dedicated PDF_TOOL_STORAGE_TOKEN/PDF_TOOL_STORAGE_SITE_ID for THIS site (docs/agents/' +
      'pdf-tool-storage-grant.md "Credential provisioning") and re-run --provision-only.'
  );
};

const resolvePdfToolBridgeEnv = async (
  fetchImpl,
  token,
  { fleetEnv = process.env, pdfToolSiteName = 'pdf-x' } = {}
) => {
  let baseUrl = fleetEnv.PDF_TOOL_BASE_URL;
  let agentRunToken = fleetEnv.PDF_TOOL_AGENT_RUN_TOKEN;

  if (!baseUrl || !agentRunToken) {
    const serviceSite = await findNetlifySite(fetchImpl, token, pdfToolSiteName);
    if (!serviceSite) {
      throw new Error(
        `shared pdf-tool Netlify site '${pdfToolSiteName}' was not found; set PDF_TOOL_BASE_URL and PDF_TOOL_AGENT_RUN_TOKEN in the provisioning environment`
      );
    }
    baseUrl ||= serviceSite.ssl_url || serviceSite.url;
    if (!agentRunToken) {
      const serviceAccountId = serviceSite.account_id;
      const serviceSiteId = serviceSite.id || serviceSite.site_id;
      if (!serviceAccountId || !serviceSiteId) {
        throw new Error(`shared pdf-tool Netlify site '${pdfToolSiteName}' has no account/site id`);
      }
      const variables = await getNetlifyEnvVars(fetchImpl, token, serviceAccountId, serviceSiteId);
      agentRunToken = contextValue(variables.find((variable) => variable?.key === 'AGENT_RUN_TOKEN'));
    }
  }

  if (!baseUrl) {
    throw new Error(`shared pdf-tool base URL is unavailable; set PDF_TOOL_BASE_URL in the provisioning environment`);
  }
  if (!agentRunToken) {
    throw new Error(
      `shared pdf-tool AGENT_RUN_TOKEN is unavailable or secret; set PDF_TOOL_AGENT_RUN_TOKEN in the provisioning environment`
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), agentRunToken };
};

/**
 * Runs the credentialed half. Isolated behind an options bag (fetchImpl /
 * getStoreImpl injectable) so tests can exercise the control flow without a
 * real network call — mirroring the object-publish.ts / provision-pdf-tool-
 * stores.mjs testing seam pattern used elsewhere in this repo.
 */
export const executeNetlifyProvisioning = async (
  plan,
  {
    token,
    fetchImpl = fetch,
    getStoreImpl,
    siteName = undefined,
    fleetEnv = process.env,
    pdfToolSiteName = 'pdf-x',
    knownTenantSiteNames = [],
  }
) => {
  // The Netlify subdomain is globally unique, so it cannot always equal the
  // client slug (W14 T14.3: `platform.netlify.app` was taken). `siteName`
  // overrides it; the in-repo slug — which every id, store, and path is derived
  // from — stays the slug either way.
  const site = await createNetlifySite(fetchImpl, token, siteName || plan.clientSlug);
  const siteId = site.id || site.site_id;
  const accountId = site.account_id;

  // W15-storage-parity: this repo's fleet law is "no two tenants share a
  // pdf-tool storage target" (docs/agents/pdf-tool-storage-grant.md). A
  // brand-new site has nothing set yet, so this is a no-op on the first run
  // — the real bite is a --provision-only RE-run after the operator has set
  // PDF_TOOL_STORAGE_TOKEN/SITE_ID by hand (the runbook's step 3): if what
  // they set collides with a sibling tenant passed via --known-tenant-site,
  // provisioning refuses to finish rather than silently recreating the
  // shared-storage arrangement the fleet is moving off of.
  let storageParity;
  if (knownTenantSiteNames.length) {
    storageParity = await checkStorageGrantParity(fetchImpl, token, [
      site.name,
      ...knownTenantSiteNames.filter((name) => name !== site.name),
    ]);
    assertNoStorageGrantCollision(storageParity, site.name);
  }

  let getStore = getStoreImpl;
  if (!getStore) {
    ({ getStore } = await import('@netlify/blobs'));
  }
  const storeFailures = [];
  for (const storeName of CORE_BLOB_STORES) {
    try {
      await probeStore(getStore, { siteID: siteId, token }, storeName);
    } catch (error) {
      storeFailures.push({ storeName, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const secretsSet = [];
  const secretsFailed = [];
  if (accountId) {
    // W14 T14.4: NETLIFY_SITE_ID is knowable HERE — it is the id of the site
    // this run just created — and leaving it to the by-hand checklist is what
    // put a freshly provisioned site's functions on the file-backed test store
    // in production (blob runtime detection keys on it). Not a secret; set it
    // like one so the checklist prints a tick.
    try {
      await setNetlifyEnvVar(fetchImpl, token, accountId, siteId, 'NETLIFY_SITE_ID', siteId);
      secretsSet.push('NETLIFY_SITE_ID');
    } catch (error) {
      secretsFailed.push({ name: 'NETLIFY_SITE_ID', message: error instanceof Error ? error.message : String(error) });
    }
    for (const { rows } of ENV_CHECKLIST) {
      for (const row of rows) {
        if (!row.generate) continue;
        try {
          await setNetlifyEnvVar(fetchImpl, token, accountId, siteId, row.name, row.generate());
          secretsSet.push(row.name);
        } catch (error) {
          secretsFailed.push({ name: row.name, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    try {
      const bridgeEnv = await resolvePdfToolBridgeEnv(fetchImpl, token, { fleetEnv, pdfToolSiteName });
      await setNetlifyEnvVar(fetchImpl, token, accountId, siteId, 'PDF_TOOL_BASE_URL', bridgeEnv.baseUrl, {
        scopes: ['functions'],
        context: 'production',
      });
      secretsSet.push('PDF_TOOL_BASE_URL');
      await setNetlifyEnvVar(fetchImpl, token, accountId, siteId, 'PDF_TOOL_AGENT_RUN_TOKEN', bridgeEnv.agentRunToken, {
        scopes: ['functions'],
        context: 'production',
        isSecret: true,
      });
      secretsSet.push('PDF_TOOL_AGENT_RUN_TOKEN');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const name of ['PDF_TOOL_BASE_URL', 'PDF_TOOL_AGENT_RUN_TOKEN']) {
        if (!secretsSet.includes(name)) secretsFailed.push({ name, message });
      }
    }
  } else {
    for (const name of ['PDF_TOOL_BASE_URL', 'PDF_TOOL_AGENT_RUN_TOKEN']) {
      secretsFailed.push({ name, message: 'new Netlify site response has no account id' });
    }
  }

  return { site, siteId, accountId, storeFailures, secretsSet, secretsFailed, storageParity };
};

// ─── CLI entry ───

const parseArgs = (argv) => {
  const opts = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--name') {
      opts.name = argv[i + 1];
      i += 1;
    } else if (arg === '--brand-name') {
      opts.brandName = argv[i + 1];
      i += 1;
    } else if (arg === '--canonical-host') {
      opts.canonicalHost = argv[i + 1];
      i += 1;
    } else if (arg === '--netlify-token') {
      opts.netlifyToken = argv[i + 1];
      i += 1;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--provision-only') {
      opts.provisionOnly = true;
    } else if (arg === '--netlify-site-name') {
      opts.netlifySiteName = argv[i + 1];
      i += 1;
    } else if (arg === '--known-tenant-site') {
      opts.knownTenantSites = opts.knownTenantSites || [];
      opts.knownTenantSites.push(argv[i + 1]);
      i += 1;
    } else if (arg === '--json') {
      opts.json = true;
    }
  }
  return opts;
};

// ─── `--json` programmatic mode (T12.11 genesis seam) ───
//
// The one-call site-duplication driver (CMS-Agent's `site.duplicate`, T12.11) invokes this CLI as a
// subprocess and needs the outcome machine-readably: which files/ids a scaffold produced, what the
// Netlify half set (env NAMES only — the same never-print-values rule the prose checklist already
// follows), and which env rows remain human-owned. `--json` replaces the prose report with ONE
// create_site_result.v1 JSON document on stdout; every code path is otherwise byte-identical (same
// buildPlan/writeFiles/executeNetlifyProvisioning calls, same idempotence, same failure exits).
// Secret VALUES never appear in this document by construction: it carries plan metadata, env var
// names, store names, and failure messages only.
const flattenEnvChecklist = () =>
  ENV_CHECKLIST.flatMap(({ group, rows }) =>
    rows.map((row) => ({
      group,
      name: row.name,
      cls: row.cls,
      autoGenerated: Boolean(row.generate),
      inheritFromPdfTool: Boolean(row.inheritFromPdfTool),
      note: row.note,
    }))
  );

const jsonResult = (plan, fields) =>
  JSON.stringify({
    contract: 'create_site_result.v1',
    slug: plan.clientSlug,
    dir: plan.dir,
    brandName: plan.brandName,
    canonicalHost: plan.canonicalHost,
    ids: plan.ids,
    plannedFiles: plan.files.length,
    envChecklist: flattenEnvChecklist(),
    siteIdentityEnvOverrides: SITE_IDENTITY_ENV_OVERRIDES,
    coreBlobStores: CORE_BLOB_STORES,
    // The §admin human gate, machine-listed so a driver can surface it verbatim instead of parsing prose.
    adminBootstrapHumanGate: [
      'enable_netlify_identity',
      'set_admin_emails',
      'invite_first_owner',
    ],
    ...fields,
  });

// Netlify execution result reduced to its safe projection: ids, names, and failure messages —
// never the raw site object or any env value.
const safeNetlifyResult = (result) => ({
  siteId: result.siteId,
  siteName: result.site?.name,
  siteUrl: result.site?.ssl_url || result.site?.url,
  storeFailures: result.storeFailures.map(({ storeName, message }) => ({ storeName, message })),
  secretsSet: result.secretsSet,
  secretsFailed: result.secretsFailed.map(({ name, message }) => ({ name, message })),
  storageParity: result.storageParity ? result.storageParity.rows : null,
});

export const main = async (argv) => {
  const opts = parseArgs(argv);
  const plan = buildPlan(opts);
  const netlifyToken = opts.netlifyToken || process.env.NETLIFY_API_TOKEN;
  // `--json` silences the prose report (say → no-op) and prints ONE machine-readable
  // create_site_result.v1 document instead; every action taken is identical.
  const say = opts.json ? () => {} : (line) => console.log(line);

  if (opts.dryRun) {
    if (opts.json) {
      console.log(jsonResult(plan, { ok: true, mode: 'dry-run', scaffolded: false, alreadyScaffolded: null, netlify: null, netlifyPlanned: Boolean(netlifyToken) }));
      return;
    }
    console.log(renderPlan(plan, { netlifyToken: Boolean(netlifyToken) }));
    return;
  }

  // W14 T14.3: scaffolding and PROVISIONING are separate sittings in practice —
  // the directory is committed in one wave and the Netlify account authority
  // arrives in another. Returning early on an existing directory silently
  // skipped the Netlify half, so the only way to provision was to delete a
  // committed site tree first. `--provision-only` is the seam.
  const targetDir = path.join(repoRoot, plan.dir);
  const alreadyScaffolded = fs.existsSync(targetDir);

  if (alreadyScaffolded && !opts.provisionOnly) {
    if (opts.json) {
      console.log(jsonResult(plan, { ok: true, mode: 'noop-existing', scaffolded: false, alreadyScaffolded: true, netlify: null }));
      return;
    }
    console.log(`[create-site] ${plan.dir}/ already exists — leaving it untouched (idempotent re-run).`);
    console.log('[create-site] Re-run with --provision-only to do the Netlify half against this existing tree,');
    console.log('[create-site] or delete/rename the directory first for a clean re-scaffold.');
    return;
  }

  if (alreadyScaffolded) {
    say(`[create-site] ${plan.dir}/ already exists — provisioning only, no files written.`);
  } else {
    writeFiles(plan);
    say(`[create-site] scaffolded ${plan.files.length} files under ${plan.dir}/.`);
  }

  let netlifyExecution = null;
  if (netlifyToken) {
    say('[create-site] provisioning the Netlify site + blob stores…');
    const result = await executeNetlifyProvisioning(plan, {
      token: netlifyToken,
      siteName: opts.netlifySiteName,
      knownTenantSiteNames: opts.knownTenantSites || [],
    });
    netlifyExecution = result;
    say(`[create-site] Netlify site created: id=${result.siteId}`);
    for (const storeName of CORE_BLOB_STORES) {
      const failed = result.storeFailures.find((f) => f.storeName === storeName);
      say(failed ? `  FAILED   ${storeName}: ${failed.message}` : `  ok       ${storeName}`);
    }
    if (result.storageParity) {
      say('[create-site] pdf-tool storage-grant parity vs. known tenant sites:');
      for (const row of result.storageParity.rows) {
        say(`  ${row.status.padEnd(9)} ${row.siteName}${row.storageSiteId ? ` -> ${row.storageSiteId}` : ''}`);
      }
    }
    if (result.secretsSet.length) say(`[create-site] generated + set: ${result.secretsSet.join(', ')}`);
    if (result.secretsFailed.length) {
      say('[create-site] secret-set FAILURES (fix and set these by hand in the Netlify UI):');
      for (const failure of result.secretsFailed) say(`  FAILED   ${failure.name}: ${failure.message}`);
    }
    const bridgeFailures = result.secretsFailed.filter((failure) =>
      ['PDF_TOOL_BASE_URL', 'PDF_TOOL_AGENT_RUN_TOKEN'].includes(failure.name)
    );
    if (bridgeFailures.length) {
      throw new Error(
        'required pdf-tool bridge environment was not provisioned; set the provisioning fallback values and retry with --provision-only'
      );
    }
  } else {
    say(
      '[create-site] no --netlify-token supplied — scaffold only. Provide one to create the Netlify site + stores.'
    );
  }

  if (opts.json) {
    console.log(
      jsonResult(plan, {
        ok: true,
        mode: netlifyToken ? (alreadyScaffolded ? 'provision' : 'scaffold+provision') : 'scaffold',
        scaffolded: !alreadyScaffolded,
        alreadyScaffolded,
        netlify: netlifyExecution ? safeNetlifyResult(netlifyExecution) : null,
        nextSteps: [
          'run `npm install` at the repo root and COMMIT package-lock.json (a new site is a new npm workspace; without it every `npm ci` fails)',
          'see docs/cms-architecture/site-provisioning-runbook.md for the human half (DNS, secrets, Identity bootstrap)',
        ],
      })
    );
    return;
  }

  console.log('');
  // A new site is a new npm WORKSPACE (the root package.json globs `sites/*`),
  // so package-lock.json is now out of sync and every `npm ci` — which is what
  // CI and Netlify both run — fails with "Missing: @fleet/site-<name> from lock
  // file" before it reaches a single build step. Hit for real on the first
  // scaffolded site (W14 T14.3).
  console.log('NEXT: run `npm install` at the repo root and COMMIT package-lock.json.');
  console.log('      A new site is a new npm workspace; without it every `npm ci` fails.');
  console.log('');
  console.log('Env checklist:');
  console.log(renderEnvChecklist(Boolean(netlifyToken)));
  console.log('');
  console.log(renderAdminBootstrapChecklist());
  console.log('');
  console.log(
    'See docs/cms-architecture/site-provisioning-runbook.md for the human half (DNS, secrets, Identity bootstrap).'
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[create-site] FAILED: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
