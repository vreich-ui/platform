/**
 * capability_status (T16.5) — one MCP call surfaces per-family env-gate
 * truth for THIS tenant: `{configured, missing}` per gated tool family.
 *
 * Why this exists (16-genesis-parity-plan.md §1.1, law P3): nine tool
 * families are advertised identically on every site but env-gated at CALL
 * TIME, and nothing in the fleet previously detected a tenant where a family
 * 503s — exactly how the Platform PDF gap lived unnoticed until a live probe
 * caught it by hand on 2026-08-10. `capability_status` makes that truth one
 * call, and `scripts/fleet-capability-probe.mjs` makes it a fleet-wide
 * matrix.
 *
 * Hard rule: booleans and env-var NAMES only. Never a value, a length, a
 * prefix, or anything derived from a secret. Every family below delegates to
 * the SAME predicate function the real gated code path calls — see each
 * import's origin module for the "real" caller (pdf-tool-client.ts's
 * postPdfTool, product_set_price's getStripeClient, etc.) — so there is
 * exactly one place per family the required env-var names are declared.
 *
 * `mcp_auth` is a deliberate outlier: by the time ANY tool handler (this one
 * included) runs, `getAuthResult` in mcp.ts has already succeeded — a
 * request that failed the MCP auth gate never reaches callTool at all. So
 * this family is trivially `{configured: true, missing: []}` whenever it can
 * be observed; it exists in the report for T11.7 completeness (every
 * MCP_HTTP_AUTH_TOKEN-gated var maps to a family), not because it can ever
 * be caught false from inside a tool call.
 */
import { getSiteIdentity } from '../../lib/site-identity.js';
import { pdfToolBridgeMissingEnvVars } from './pdf-tool-client.js';
import { pdfToolStorageGrantMissingEnvVars } from './pdf-tool-storage-grant.js';
import { commerceMissingEnvVars } from './stripe-env.js';
import { purchaseTokenMissingEnvVars } from './purchase-tokens.js';
import { netlifyBuildHookMissingEnvVars, netlifyDeployLookupMissingEnvVars } from './netlify-deploys.js';
import { gitCommitterMissingEnvVars } from './object-git-committer.js';
import { blobCredentialsMissingEnvVars } from './blob-store.js';
import { artifactUploadMissingEnvVars } from './artifact-upload.js';

/** The ten gated families this tool reports on (T16.5 brief, verbatim list). */
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
] as const;

export type CapabilityFamily = (typeof CAPABILITY_FAMILIES)[number];

export type CapabilityStatusEntry = { configured: boolean; missing: string[] };

export type CapabilityStatusReport = {
  /** This deployment's own site-singleton id (non-secret identity, e.g. 'site_drlurie') — lets a fleet probe target the right site_id for the pdf-tool bridge's per-family real-read calls without a separate hardcoded map. */
  site_id: string;
  families: Record<CapabilityFamily, CapabilityStatusEntry>;
};

const entry = (missing: string[]): CapabilityStatusEntry => ({ configured: missing.length === 0, missing });

/**
 * Pure, synchronous, side-effect-free: every predicate it calls only reads
 * `process.env` (or an injected env for the ones that accept one — called
 * here with their defaults, i.e. `process.env`). Safe to call on every
 * request; nothing here performs I/O.
 */
export const getCapabilityStatus = (): CapabilityStatusReport => ({
  site_id: getSiteIdentity().siteId,
  families: {
    pdf_bridge: entry(pdfToolBridgeMissingEnvVars()),
    pdf_storage_grant: entry(pdfToolStorageGrantMissingEnvVars()),
    commerce: entry(commerceMissingEnvVars()),
    purchase_token: entry(purchaseTokenMissingEnvVars()),
    build_hook: entry(netlifyBuildHookMissingEnvVars()),
    deploy_lookup: entry(netlifyDeployLookupMissingEnvVars()),
    git_committer: entry(gitCommitterMissingEnvVars()),
    blob_credentials: entry(blobCredentialsMissingEnvVars()),
    mcp_auth: entry([]),
    artifact_upload: entry(artifactUploadMissingEnvVars()),
  },
});
