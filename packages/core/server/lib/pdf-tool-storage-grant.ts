/**
 * pdf-tool storage grants — Dr-Lurie is the storage-grant provider for the
 * (stateless) pdf-tool service. pdf-tool holds no blob credentials of its
 * own: Platform mints a short-lived grant and forwards it through its trusted
 * server-side pdf-tool bridge, and pdf-tool uses it
 * to write artifacts, templates, image-search state, and its job records
 * directly into this site's Netlify Blob stores.
 *
 * The grant shape below is the contract pdf-tool accepts. Keep it stable:
 * the future grantType 'exchange' (an opaque short-lived token plus a
 * server-to-server exchange endpoint) must be a drop-in change of
 * grantType/token only.
 *
 * Credentials come from two server-side env vars (see
 * docs/agents/pdf-tool-storage-grant.md for the provisioning runbook):
 * - PDF_TOOL_STORAGE_TOKEN   — personal access token of a dedicated Netlify
 *                              machine account whose only access is this
 *                              site/team (bounds the blast radius of a leak).
 * - PDF_TOOL_STORAGE_SITE_ID — the Dr-Lurie site API id.
 *
 * Neither value may ever reach client-side code, logs, or any stored record
 * (agent responses, workflow JSON, drafts, blobs). Rotation needs no code
 * change: the bridge always uses the current env values.
 *
 * The grant's projectId namespaces this site inside pdf-tool's stores. It
 * comes from the site-identity seam (env PDF_TOOL_PROJECT_ID, else the site
 * slug — 'dr-lurie' here), read at call time like the credentials; the wire
 * format is unchanged.
 */
import { getSiteIdentity } from '../../lib/site-identity.js';
import { activeMediaPolicy, mediaPolicyLimits, type MediaPolicyLimits } from '../../lib/media-policy.js';

/** Store handles pdf-tool writes through a grant, keyed by grant field name. */
export const pdfToolStorageStores = {
  artifacts: 'artifacts',
  artifactIndex: 'artifact-index',
  templates: 'pdf-templates',
  imageSearch: 'image-search',
  renderData: 'pdf-render-data',
  jobs: 'pdf-tool-jobs',
} as const;

export type PdfToolStorageStores = { [K in keyof typeof pdfToolStorageStores]: (typeof pdfToolStorageStores)[K] };

export type PdfToolStorageGrant = {
  grantVersion: 1;
  grantType: 'netlify-pat';
  projectId: string;
  siteId: string;
  token: string;
  stores: PdfToolStorageStores;
  /**
   * Per-site media policy pdf-tool honors when generating/storing images:
   * the byte budget, the preferred web format, and warn-vs-block. Sourced from
   * src/config/media-policy.ts. Additive to the grant contract — unrelated to
   * the grantType/token exchange plan, so it does not affect that migration.
   */
  limits: MediaPolicyLimits;
  expiresAt: string;
};

/**
 * expiresAt is advisory-but-enforced: pdf-tool rejects expired grants, so
 * agents must re-fetch per run rather than cache long-term.
 */
export const pdfToolStorageGrantTtlMs = 60 * 60 * 1000;

export type BuildPdfToolStorageGrantResult =
  | { ok: true; grant: PdfToolStorageGrant }
  | { ok: false; error: string; errorCode: 'pdf_tool_storage_grant_not_configured' };

const toNonEmptyString = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

/**
 * T16.5: the single predicate for "is the pdf-tool storage grant configured"
 * — both the real call path (buildPdfToolStorageGrant below) and
 * capability-status.ts's `pdf_storage_grant` family read this same function,
 * so there is exactly one place the env names live.
 */
export const pdfToolStorageGrantMissingEnvVars = (): string[] => {
  const token = toNonEmptyString(process.env.PDF_TOOL_STORAGE_TOKEN);
  const siteId = toNonEmptyString(process.env.PDF_TOOL_STORAGE_SITE_ID);
  return [...(token ? [] : ['PDF_TOOL_STORAGE_TOKEN']), ...(siteId ? [] : ['PDF_TOOL_STORAGE_SITE_ID'])];
};

export const isPdfToolStorageGrantConfigured = (): boolean => pdfToolStorageGrantMissingEnvVars().length === 0;

export const buildPdfToolStorageGrant = (now: Date = new Date()): BuildPdfToolStorageGrantResult => {
  const missing = pdfToolStorageGrantMissingEnvVars();

  if (missing.length > 0) {
    return {
      ok: false,
      error: `pdf-tool storage grants are not configured on this server (missing ${missing.join(' and ')}).`,
      errorCode: 'pdf_tool_storage_grant_not_configured',
    };
  }

  const token = toNonEmptyString(process.env.PDF_TOOL_STORAGE_TOKEN)!;
  const siteId = toNonEmptyString(process.env.PDF_TOOL_STORAGE_SITE_ID)!;

  return {
    ok: true,
    grant: {
      grantVersion: 1,
      grantType: 'netlify-pat',
      projectId: getSiteIdentity().pdfToolProjectId,
      siteId,
      token,
      stores: { ...pdfToolStorageStores },
      limits: mediaPolicyLimits(activeMediaPolicy()),
      expiresAt: new Date(now.getTime() + pdfToolStorageGrantTtlMs).toISOString(),
    },
  };
};
