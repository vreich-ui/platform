/**
 * TOOL_DEFINITIONS, part 1 of 2, plus the JSON-Schema builder helpers they
 * share and the pdf-tool template bridge / artifact schemas they compose.
 *
 * Split out of mcp.ts (W14 T14.3 delete_pdf_template bridge follow-up) purely
 * to keep each source file within the GitHub content-push size this repo's
 * tooling can deliver in one shot -- NOT a behavioral seam. mcp.ts combines
 * TOOL_DEFINITIONS_PART1 and TOOL_DEFINITIONS_PART2 (mcp-tool-definitions-2.ts)
 * into the single TOOL_DEFINITIONS array every tool/list and dispatch call
 * sees; the split is invisible outside this module boundary. Keep names,
 * descriptions and inputSchemas byte-for-byte identical to how they read as
 * one array -- this is a mechanical relocation, not a rewrite.
 */
import { artifactKindValues, artifactReferenceLimits } from './artifacts.js';
import { objectTypes } from '../../schema/object-record-v1.js';

import type { ToolDefinition } from '../functions/mcp.js';

// Relocated from mcp.ts's core-types section (W14 T14.3 follow-up split):
// used only by TOOL_DEFINITIONS' schemas (this file and part 2), and by the
// artifact-admin module -- exported here as the single source of truth for
// both.
export const ARTIFACT_LIST_DEFAULT_LIMIT = 50;
export const ARTIFACT_LIST_MAX_LIMIT = 100;
export const WIPE_BLOB_CONFIRMATION = 'WIPE_BLOBS';
// Used only inside this file's TOOL_DEFINITIONS_PART1 entries below.
const SINGLE_SHOT_ARTIFACT_GUIDANCE_MAX_BYTES = 750_000;

const mediaPortabilityWarning =
  'Media portability constraint: repo-style paths (src/assets/.../uploads/<slug>/...) are scoped to the specific article slug they were generated for and must NEVER be copied into a different request public_media_src or artifactReferences. portable:false and scoped_to_slug/scoped_to_request_id metadata are machine-readable hard constraints, not suggestions. Only artifact pointers freshly resolved for the CURRENT request (image/{requestId}/{sha}.{ext} or pdf/{requestId}/{sha}.{ext}) are safe inputs for a new or repair request. See docs/agents/naming-convention.md for canonical naming rules.';

export const stringSchema = (description?: string) => ({
  type: 'string',
  minLength: 1,
  ...(description ? { description } : {}),
});
export const intSchema = (description?: string) => ({
  type: 'integer',
  minimum: 0,
  ...(description ? { description } : {}),
});
export const nullableStringSchema = (description?: string) => ({
  anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
  ...(description ? { description } : {}),
});

export const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
  description?: string
): Record<string, unknown> => ({
  type: 'object',
  ...(description ? { description } : {}),
  properties,
  required,
  additionalProperties: false,
});

export const arraySchema = (items: Record<string, unknown>, description?: string) => ({
  type: 'array',
  items,
  ...(description ? { description } : {}),
});

/**
 * QA-W16-1: shared idempotency-key schema for every write tool that can mint
 * a fresh id/slot or trigger a fresh build on each call. Pass the SAME value
 * on a retry (after a timeout, a Cloudflare 502, or any ambiguous response)
 * to get back the ORIGINAL result instead of a duplicate — e.g. a second
 * content_item, a second rendered artifact, or a second production build.
 * Example: idempotency_key: "create-hero-article-2026-08-06-01" reused
 * verbatim on retry. Omit it and every call runs the write fresh, as before.
 */
export const idempotencyKeyJsonSchema = stringSchema(
  'Optional client-supplied key for safe retries. Pass the SAME value on a retry of this exact call (e.g. after a timeout or 502) to get back the ORIGINAL result instead of causing a duplicate write. Example: pass "publish-article-42-attempt" on both the first call and any retry. Omit to run the write fresh every time (previous behavior).'
);

/**
 * QA-W16 hardening: the artifact/pdf-template bridge's error catalog, kept in
 * one place for the same reason object_contract's patch_error_codes is —
 * an agent hitting error_code should be able to look up what it means and
 * what to do, not have to guess from raw pass-through text. Referenced from
 * the tool descriptions below rather than exposed as its own tool, since
 * (unlike CMS object types) there is no per-object object_contract() call
 * these errors are scoped to.
 */
export const ARTIFACT_TEMPLATE_ERROR_CODES: Record<string, { http: number; meaning: string }> = {
  pdf_tool_bridge_not_configured: {
    http: 503,
    meaning:
      "This site's PDF_TOOL_BASE_URL/PDF_TOOL_AGENT_RUN_TOKEN are not configured — an operator setup gap, not a caller mistake.",
  },
  pdf_tool_bridge_request_failed: {
    http: 0,
    meaning:
      "pdf-tool rejected or could not be reached for the request; the real HTTP status is in this error's own statusCode field and any pdf-tool-specific code (e.g. TEMPLATE_VALIDATION_REQUIRED) is spread in verbatim alongside it.",
  },
  template_scope_required: { http: 400, meaning: 'site_id is required for every pdf-template bridge call.' },
  template_site_mismatch: {
    http: 403,
    meaning: "The supplied site_id names a different site than this deployment owns — use that site's own connector.",
  },
  artifact_scope_required: { http: 400, meaning: 'site_id and request_id are both required for the artifact bridge.' },
  artifact_site_mismatch: { http: 403, meaning: 'site_id does not match this deployment.' },
  artifact_request_not_found: { http: 404, meaning: 'No content_item exists for the given request_id.' },
  artifact_request_scope_mismatch: {
    http: 403,
    meaning: 'The request_id exists but is not owned by the supplied site_id.',
  },
  artifact_job_scope_mismatch: {
    http: 403,
    meaning: 'The job_id being polled was not created under this site_id/request_id pair.',
  },
  pdf_tool_invalid_response: {
    http: 502,
    meaning:
      'pdf-tool returned 2xx but the body was missing a field this bridge requires (e.g. jobId) — retry, then escalate if it repeats.',
  },
  artifact_materialization_unverified: {
    http: 502,
    meaning:
      "pdf-tool reported the job complete but this bridge's own server-side verification of the resulting bytes failed — do not trust the artifact reference; re-run the job.",
  },
  TEMPLATE_VALIDATION_REQUIRED: {
    http: 409,
    meaning:
      'publish_pdf_template refused a react-pdf/typst/chromium version with no PASSED validate_pdf_template report on file for that exact template_id/version. Call validate_pdf_template, poll get_pdf_template_validation to a terminal PASSED, then retry publish.',
  },
};

const metadataBagSchema = (description: string) => ({
  type: 'object',
  description,
  properties: {},
  additionalProperties: true,
});
const artifactKindJsonSchema = (description?: string) => ({
  type: 'string',
  enum: [...artifactKindValues],
  ...(description ? { description } : {}),
});
const artifactEncodingJsonSchema = (description?: string) => ({
  type: 'string',
  enum: ['base64', 'binary'],
  ...(description ? { description } : {}),
});
const artifactMetadataJsonSchema = metadataBagSchema('Optional artifact metadata saved in the artifact reference.');
const artifactLabelJsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: artifactReferenceLimits.label,
  pattern: '^[^\\u0000-\\u001f\\u007f<>]+$',
  description: 'Optional safe human-readable artifact label saved in the ArtifactReference.',
};
const artifactTagsJsonSchema = {
  type: 'array',
  maxItems: artifactReferenceLimits.tags,
  items: {
    type: 'string',
    minLength: 1,
    maxLength: artifactReferenceLimits.tag,
    pattern: '^[^\\u0000-\\u001f\\u007f<>]+$',
  },
  description: 'Optional safe ArtifactReference tags for filtering or display.',
};
const expectedSizeBytesJsonSchema = intSchema(
  'Optional expected complete artifact byte size for upload integrity checks.'
);
const expectedSha256JsonSchema = {
  type: 'string',
  pattern: '^[a-fA-F0-9]{64}$',
  description: 'Optional expected complete artifact SHA-256 hex digest for upload integrity checks.',
};

const artifactUploadIntentInputSchema = () =>
  objectSchema(
    {
      requestId: stringSchema('Workflow request id that owns this artifact.'),
      artifactKind: artifactKindJsonSchema('Artifact kind for storage routing.'),
      contentType: stringSchema('Real MIME type of the artifact bytes, e.g. image/png or application/pdf.'),
      filename: {
        ...stringSchema('Optional original filename used for blob extension and ArtifactReference originalFilename.'),
        maxLength: artifactReferenceLimits.originalFilename,
      },
      expectedSizeBytes: expectedSizeBytesJsonSchema,
      expectedSha256: expectedSha256JsonSchema,
      label: artifactLabelJsonSchema,
      tags: artifactTagsJsonSchema,
    },
    ['requestId', 'artifactKind', 'contentType', 'expectedSizeBytes', 'expectedSha256']
  );

const artifactListLimitJsonSchema = {
  type: 'integer',
  minimum: 1,
  maximum: ARTIFACT_LIST_MAX_LIMIT,
  description: `Optional result limit; defaults to ${ARTIFACT_LIST_DEFAULT_LIMIT}, max ${ARTIFACT_LIST_MAX_LIMIT}.`,
};
const artifactListCursorJsonSchema = stringSchema(
  'Optional opaque pagination cursor returned by a previous list call.'
);
const artifactReconcileLimitJsonSchema = {
  type: 'integer',
  minimum: 1,
  maximum: ARTIFACT_LIST_MAX_LIMIT,
  description: `Optional maximum number of artifact-index JSON references to reconcile; defaults to ${ARTIFACT_LIST_DEFAULT_LIMIT}, max ${ARTIFACT_LIST_MAX_LIMIT}.`,
};
const artifactMigrationDryRunJsonSchema = {
  type: 'boolean',
  description: 'When true, report migration actions without writing artifact-index records or pointers.',
};

const wipeBlobDryRunJsonSchema = {
  type: 'boolean',
  default: true,
  description: 'When true or omitted, only count and sample matching blob keys without deleting them.',
};
const wipeBlobConfirmJsonSchema = stringSchema(
  `Required only for live deletion; must equal ${WIPE_BLOB_CONFIRMATION}.`
);
const wipeBlobPrefixesJsonSchema = arraySchema(
  { type: 'string', enum: ['workflows/', 'artifact-index/', ...artifactKindValues.map((kind) => `${kind}/`)] },
  'REQUIRED, non-empty — no default. The artifact prefixes (image/, pdf/, etc.) and artifact-index/ are ' +
    'shared with live CMS objects (a content_item article’s media lives at image/{objectRequestId}/{sha}.ext, ' +
    'indistinguishable by prefix from a legacy workflow record’s artifacts) — wiping them can delete live, ' +
    'published media. Pass exactly the prefixes you have verified are safe; workflows/ is the only prefix that ' +
    'is unambiguously legacy-only.'
);
const artifactIncludeDeletedJsonSchema = {
  type: 'boolean',
  description: 'When true, include soft-deleted artifact references. Defaults to false.',
};
const artifactDeletedByJsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: artifactReferenceLimits.label,
  pattern: '^[^\\u0000-\\u001f\\u007f<>]+$',
  description: 'Optional safe actor label recorded as deletedBy; defaults to the authenticated admin email or user id.',
};

const artifactSearchTagJsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: artifactReferenceLimits.tag,
  description: 'Optional tag to search via artifact-index/by-tag pointers.',
};
const isoDateStringSchema = (description: string) => ({
  type: 'string',
  format: 'date-time',
  description,
});

// ── Object-verb tool schemas (T0.9). Additive; the article tool schemas above
//    are untouched. ──
// Single source of truth: the envelope's object-type vocabulary (was a
// hand-copied literal that could drift from object-record-v1.ts).
const OBJECT_TYPE_VALUES = [...objectTypes];
export const objectTypeEnumSchema = (description = 'CMS object type.') => ({
  type: 'string',
  enum: OBJECT_TYPE_VALUES,
  description,
});
export const anyObjectSchema = (description: string) => ({ type: 'object', additionalProperties: true, description });
export const patchOpsSchema = (description: string) =>
  arraySchema({ type: 'object', additionalProperties: true }, description);
// The M-6 publish-action pin (review-state.ts publishActionSchema): an ISO
// instant, the literal string 'immediate', or null (unpublish).
export const publishActionInputSchema = (description: string) =>
  objectSchema(
    {
      published_time: {
        anyOf: [
          { type: 'string', minLength: 1, description: 'ISO 8601 instant, or the literal "immediate".' },
          { type: 'null', description: 'null pins an unpublish.' },
        ],
      },
    },
    ['published_time'],
    description
  );

export const TOOL_DEFINITIONS_PART1: ToolDefinition[] = [
  {
    name: 'deploy_status',
    description:
      'Read-only Netlify deploy receipt lookup by commit or deploy id. Besides the receipt, the response carries publishedDeploy (the deploy production is actually serving) and productionConfirmed (whether that published deploy matches the commit/deployId you asked about) whenever the site lookup is available. A deploy can be deployStatus:"ready" without being what production serves (locked Auto Publishing) — treat a release as live only when deployStatus is "ready" AND productionConfirmed is true. Absent publishedDeploy/productionConfirmed fields mean the published-deploy signal was unavailable (unknown), not "not live". Object exports accumulate on main behind [skip netlify] and one release deploys every accumulated commit at once, so the currently published deploy is very often AHEAD of the commit you are checking rather than exactly equal to it, even though that commit\'s content is already live. When looked up by commit, this tool reconciles that case against GitHub (ancestry check) and returns deployStatus:"ready"/productionConfirmed:true plus reconciled:true + reconciliationNote instead of a stale-looking "queued" for a commit production is demonstrably already serving.',
    inputSchema: objectSchema({
      commit: stringSchema('Commit SHA to look up in saved Netlify deploy receipts.'),
      deployId: stringSchema('Netlify deploy id to look up in saved Netlify deploy receipts.'),
    }),
  },
  {
    name: 'verify_article_images',
    description:
      'Verify that a published article page contains the expected images and that each is fetchable as an image. DEPLOY-AWARE TIMING: pass the publish commit as "commit" and this tool correlates the check to that commit\'s Netlify deploy — image assertions run only once that deploy is confirmed "ready", and a page still served by a stale/previous deploy comes back inconclusive:true (deploy timing), never a false missing-image defect. deployReady:true in the response means the target deploy is live and the result is definitive. Without a commit it falls back to the legacy heuristic (poll deploy_status until deployStatus is "ready" yourself first; an immediate check may hit the previous deploy). A response with inconclusive:true means the deploy is probably not live yet — retry later; it is NOT a proven image defect. MATCHING: for LEGACY committed-asset articles pass the display paths from the publish response (e.g. ~/assets/images/uploads/{slug}/{file}.png) — Astro rewrites committed assets to hashed build URLs (/_astro/{file}.{hash}.{ext}), so matching falls back from exact URL to filename-stem. For OBJECT articles (content_item) pass the node media PUBLIC paths (/img/{id}/{sha256}.{ext}) — they appear verbatim as the rendered <img> src, and the object_publish response\'s production.article_path gives the page URL. Each result reports matchedUrl/matchedBy. Server-only publish credentials are never accepted as inputs or returned.',
    inputSchema: objectSchema(
      {
        url: stringSchema('Published article URL to fetch and inspect for <img> src/srcset sources.'),
        expectedImages: {
          type: 'array',
          items: stringSchema('Expected image URL, page-relative image path, or ~/assets display path.'),
          description:
            'Expected images that must appear in the article HTML. Display paths (~/assets/images/uploads/...) are matched by filename stem against Astro-hashed build URLs.',
        },
        commit: stringSchema(
          "Optional publish commit SHA. When set, the check waits for/correlates to that commit's Netlify deploy so a not-yet-live deploy returns inconclusive instead of a false missing-image defect. Use the commit_sha from the publish receipt."
        ),
        deployTimeoutSeconds: {
          type: 'integer',
          minimum: 0,
          maximum: 120,
          description:
            'Optional seconds to wait in-call for the target commit deploy to reach a terminal state. Default 0 = single-shot correlation (poll deploy_status yourself first). Capped so the call always returns.',
        },
        deployPollIntervalSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          description: 'Optional poll interval (seconds) used only when deployTimeoutSeconds > 0. Default 5.',
        },
      },
      ['url', 'expectedImages']
    ),
  },
  {
    name: 'trigger_netlify_build',
    description:
      "Manually trigger a Netlify build via the server-side build hook, without needing a new git commit. No input is required. This QUEUES a build asynchronously — it does not wait for the build to finish, so poll deploy_status afterward (the same way you already do after a normal publish) to know when the resulting deploy is actually ready. IMPORTANT — batch, do not spam: each triggered build consumes real Netlify build minutes, so use this to batch multiple publishes into a single build rather than triggering one build per publish. For example, after publishing several articles in a row, call this once at the end instead of calling it after every individual object_publish call. Optional reason is recorded only in this function's own server-side logs for traceability of who triggered a build and why — it is never sent to Netlify and never included in the response.",
    inputSchema: objectSchema({
      reason: stringSchema(
        "Optional free-text reason for triggering this build, recorded only in this function's own server logs for traceability. Never sent to Netlify."
      ),
    }),
  },
  {
    name: 'release_to_production',
    description:
      'Release accumulated CMS object exports to production. Object publishes commit to main with [skip netlify], so they do NOT deploy on their own — this is the explicit release that makes them live, and the ONLY thing that fires a production build for them. Steps: resolve the target commit (defaults to the content-branch HEAD, which includes every accumulated skipped export commit), POST the server-side production build hook ONCE (the same hook trigger_netlify_build uses; the only allowed production-build trigger), then poll Netlify deploy receipts until the deploy for that commit is terminal, and report whether production actually reflects it. Returns released:true only when the site\'s PUBLISHED deploy (what production actually serves) reflects the target commit — confirmed as productionConfirmed:true; released:false with status build_not_confirmed_live means the build did not finish within the wait budget (re-check deploy_status). status build_ready_not_published means the build IS ready but production still serves an older commit — Netlify "Auto Publishing" is likely locked; unlock it or publish the deploy manually, then re-check deploy_status. When the published-deploy lookup is unavailable, the tool degrades to ready-by-commit with productionConfirmed:false — treat that as "not independently proven live". WAIT BUDGET: the in-call wait is capped to this serverless function\'s remaining invocation time (seconds, not the full build duration), so a normal 30-120s production build usually returns build_not_confirmed_live on the first call — that is the expected flow, not an error. Prefer polling deploy_status with the returned targetCommit until deployStatus is "ready" AND productionConfirmed is true over calling this again; if you DO call it again for the same release attempt (e.g. after a client-side timeout or 502), pass the SAME idempotency_key so a build that already fired is not fired a second time. One release deploys every skipped commit at once, so batch publishes and release once — it consumes real build minutes.',
    inputSchema: objectSchema({
      commit: stringSchema(
        'Optional commit SHA the live production deploy must reflect. Defaults to the current content branch HEAD.'
      ),
      force_build: {
        type: 'boolean',
        description:
          'When true (default), POST the build hook to force a fresh production build before verifying. When false, only wait for and verify the deploy already triggered by the push.',
      },
      timeout_seconds: {
        type: 'integer',
        minimum: 1,
        description:
          'Optional maximum seconds to wait for the deploy to reach a terminal state before reporting back. Always additionally capped to the remaining serverless invocation budget so the call returns a structured receipt instead of being killed by the platform timeout.',
      },
      idempotency_key: idempotencyKeyJsonSchema,
    }),
  },
  {
    name: 'create_agent_artifact_job',
    description:
      "Create a pdf-tool artifact job through THIS site's trusted Platform bridge. Pass the owning site_id and content-item request_id; Platform resolves the canonical pdf-tool project, verifies request ownership, mints and forwards a fresh short-lived storage grant server-side, and never returns the grant — never attempt to supply your own grant/storage/token argument, it is always minted for you. Do not call pdf-tool directly or guess projectId. The job is asynchronous, BUT this call itself waits briefly (a few seconds, budget permitting) for it to finish: with a warm worker and a fast render the job is often already done before you could poll, so a SINGLE completing create call may come back with the terminal artifactReference, public_path, and verified fields already populated — check for those before polling. jobId and polling instructions are ALWAYS present in the response regardless, so it is always safe to poll get_agent_artifact_job_status with the returned jobId if the job is still running (status will not be complete yet) or if you prefer to ignore the inline result; do not recreate the job. Pass wait:false to skip the inline wait and get the old fire-and-forget 202-style response immediately. For template-driven PDFs pass template_id + data (+ optional assets) instead of a prompt. If this call itself times out or 502s (ambiguous whether the job was created), retry with the SAME idempotency_key to get back the original jobId instead of creating a second job. Error codes (error_code field) this bridge and pdf-tool can return: artifact_scope_required, artifact_site_mismatch, artifact_request_not_found, artifact_request_scope_mismatch, pdf_tool_bridge_not_configured, pdf_tool_bridge_request_failed, pdf_tool_invalid_response — see this platform's docs for the full artifact/template error catalog (meaning + what to do for each).",
    inputSchema: objectSchema(
      {
        site_id: stringSchema('Owning site object id, e.g. site_acme. Must match this deployment.'),
        request_id: stringSchema('Existing content_item object id that will own the artifact.'),
        artifact_kind: { type: 'string', enum: ['image', 'pdf'], description: 'Artifact kind.' },
        operation: { type: 'string', enum: ['generate', 'edit'], description: 'Defaults to generate.' },
        prompt: stringSchema('Generation prompt; required for image generation.'),
        filename: stringSchema('Output filename including the format-matching extension.'),
        slot: stringSchema('Stable request-scoped slot such as article_image_1.'),
        model: stringSchema('Optional explicit model; omit to use the registered project policy.'),
        requirements: anyObjectSchema(
          'pdf-tool requirements, e.g. {maxBytes, image:{outputFormat:"webp", size:"1536x1024", usageContext:"article_body"}}.'
        ),
        template_id: stringSchema('A published pdf_template id to render from, in place of prompt.'),
        data: anyObjectSchema('Template data payload for a template_id-driven PDF render.'),
        assets: anyObjectSchema(
          'Optional supporting assets (e.g. {images: [...]}) for a template_id-driven PDF render.'
        ),
        wait: {
          type: 'boolean',
          default: true,
          description:
            'When true (default), this call waits briefly, internally, for the job to finish and returns the completed artifact inline when it does within budget. Pass false for the old fire-and-forget behavior: return immediately once the job is created, with no internal wait.',
        },
        idempotency_key: idempotencyKeyJsonSchema,
      },
      ['site_id', 'request_id', 'artifact_kind', 'filename']
    ),
  },
  {
    name: 'get_agent_artifact_job_status',
    description:
      'Poll a job created through this Platform bridge. Platform re-validates site/request scope and injects the canonical project and a fresh grant. On completion it verifies materialization server-side and returns the canonical ArtifactReference plus public_path; neither the grant nor materialization proof is exposed. Poll this jobId instead of recreating the job.',
    inputSchema: objectSchema(
      {
        site_id: stringSchema('Owning site object id; must match this deployment.'),
        request_id: stringSchema('The same content_item request id used to create the job.'),
        job_id: stringSchema('Job id returned by create_agent_artifact_job.'),
      },
      ['site_id', 'request_id', 'job_id']
    ),
  },
  {
    name: 'get_agent_artifact_by_slot',
    description:
      'Retrieve and verify the canonical artifact for a request-scoped slot through the trusted Platform bridge. Site ownership, canonical project, storage grant, and materialization verification are handled server-side. Returns ArtifactReference + public_path with no grant or proof.',
    inputSchema: objectSchema(
      {
        site_id: stringSchema('Owning site object id; must match this deployment.'),
        request_id: stringSchema('Existing content_item request id.'),
        slot: stringSchema('The exact slot used when the job was created.'),
      },
      ['site_id', 'request_id', 'slot']
    ),
  },
  {
    name: 'create_pdf_template',
    description:
      "Create or version a pdf-tool PDF template for THIS site through the trusted Platform bridge. Platform resolves the canonical project and mints/forwards a short-lived storage grant server-side; never call pdf-tool directly or pass a grant yourself — this bridge is the ONLY place the grant is minted, and it is never returned to you. Draft only — call publish_pdf_template to activate. renderer is pinned for the template's life. Required call sequence by renderer: pdfme creates then publishes immediately (warn-only on any lint issues). react-pdf/typst/chromium MUST go create_pdf_template -> validate_pdf_template -> poll get_pdf_template_validation until the report is terminal -> publish_pdf_template, which refuses (HTTP 409 TEMPLATE_VALIDATION_REQUIRED) without a PASSED report for that exact version. If this call itself times out or 502s (ambiguous whether the template/version was created), retry with the SAME idempotency_key to get back the original template/version instead of creating a duplicate. Error codes: template_scope_required, template_site_mismatch, pdf_tool_bridge_not_configured, pdf_tool_bridge_request_failed — see the platform's artifact/template error catalog for meaning + remedy.",
    inputSchema: objectSchema(
      {
        site_id: stringSchema('Owning site object id, e.g. site_acme. Must match this deployment.'),
        template_json: anyObjectSchema('The pdf-tool template definition for the chosen renderer.'),
        renderer: {
          type: 'string',
          enum: ['pdfme', 'react-pdf', 'typst', 'chromium'],
          description: "Rendering engine, pinned for the template's life. Omit to default to pdfme.",
        },
        template_id: stringSchema('Optional existing template id to version instead of creating a new template.'),
        label: stringSchema('Optional human-readable label.'),
        tags: arraySchema({ type: 'string', minLength: 1 }, 'Optional list of tags.'),
        idempotency_key: idempotencyKeyJsonSchema,
      },
      ['site_id', 'template_json']
    ),
  },
  {
    name: 'list_pdf_templates',
    description:
      'List pdf-tool PDF templates for THIS site through the trusted Platform bridge. Site ownership, canonical project, and storage grant are resolved server-side.',
    inputSchema: objectSchema(
      {
        site_id: stringSchema('Owning site object id; must match this deployment.'),
        limit: intSchema('Optional page size.'),
        cursor: stringSchema('Optional pagination cursor from a previous list_pdf_templates call.'),
      },
      ['site_id']
    ),
  },
  {
    name: 'get_pdf_template',
    description: 'Fetch a pdf-tool PDF template record for THIS site through the trusted Platform bridge.',
    inputSchema: objectSchema(
      {
        site_id: stringSchema('Owning site object id; must match this deployment.'),
        template_id: stringSchema('The template object id.'),
        version: intSchema('Optional specific version; omit for the active version.'),
      },
      ['site_id', 'template_id']
    ),
  },
  {
    name: 'validate_pdf_template',
    description:
      "Run a validation render for a pdf-tool PDF template version through THIS site's trusted Platform bridge — the REQUIRED step between create_pdf_template and publish_pdf_template for react-pdf/typst/chromium templates (pdfme does not need this; it publishes immediately, warn-only on lint issues). Platform resolves the canonical project and mints/forwards a short-lived storage grant server-side exactly like create_pdf_template; never call pdf-tool directly or supply a grant yourself — this bridge is the only place that grant is ever minted for you. Starts (or restarts) validation for the given template_id/version and returns a validationId plus status; poll get_pdf_template_validation with that id until the report is terminal (PASSED/FAILED). publish_pdf_template will refuse react-pdf/typst/chromium versions with no PASSED report on file (HTTP 409 TEMPLATE_VALIDATION_REQUIRED).",
    inputSchema: objectSchema(
      {
        site_id: stringSchema('Owning site object id; must match this deployment.'),
        template_id: stringSchema('The template object id to validate.'),
        version: intSchema('Optional specific version to validate; omit for the latest draft version.'),
      },
      ['site_id', 'template_id']
    ),
  },
  {
    name: 'get_pdf_template_validation',
    description:
      "Poll the status/report of a validation started with validate_pdf_template, through THIS site's trusted Platform bridge. Site ownership, canonical project, and storage grant are resolved server-side exactly like validate_pdf_template — never call pdf-tool directly. Returns the same terminal states pdf-tool defines (e.g. PASSED/FAILED/pending); publish_pdf_template for react-pdf/typst/chromium requires a PASSED report for the exact template_id/version being published.",
    inputSchema: objectSchema(
      {
        site_id: stringSchema('Owning site object id; must match this deployment.'),
        template_id: stringSchema('The template object id.'),
        version: intSchema('Optional specific version; omit for the latest/active version.'),
        validation_id: stringSchema('Optional specific validationId from validate_pdf_template; omit for the latest.'),
      },
      ['site_id', 'template_id']
    ),
  },
  {
    name: 'publish_pdf_template',
    description:
      "Publish (activate) a pdf-tool PDF template version for THIS site through the trusted Platform bridge. Required sequence by renderer: pdfme creates then publishes immediately (warn-only on lint issues, matching pdfme's existing behavior). react-pdf/typst/chromium MUST go create_pdf_template -> validate_pdf_template -> poll get_pdf_template_validation to a terminal report -> publish_pdf_template; with no PASSED report on file for the exact version, this call refuses verbatim as HTTP 409 TEMPLATE_VALIDATION_REQUIRED (it does not run validation for you).",
    inputSchema: objectSchema(
      {
        site_id: stringSchema('Owning site object id; must match this deployment.'),
        template_id: stringSchema('The template object id to publish.'),
        version: intSchema('Optional specific version to publish; omit for the latest draft version.'),
      },
      ['site_id', 'template_id']
    ),
  },
  {
    name: 'delete_pdf_template',
    description:
      'Deactivate a pdf-tool PDF template for THIS site through the trusted Platform bridge. This is a soft, reversible deactivation (status -> disabled), NOT a hard delete: the underlying template data and stored bytes are preserved. A disabled template is hidden from list_pdf_templates by default, and is blocked from publish_pdf_template and from rendering (create_agent_artifact_job) until reactivated. Deactivating an already-disabled template succeeds without error (idempotent).',
    inputSchema: objectSchema(
      {
        site_id: stringSchema('Owning site object id; must match this deployment.'),
        template_id: stringSchema('The template object id to deactivate.'),
        version: intSchema('Optional specific version to deactivate; omit for the latest/active version.'),
        reason: stringSchema('Optional human-readable reason for deactivation, forwarded to pdf-tool.'),
      },
      ['site_id', 'template_id']
    ),
  },
  {
    name: 'create_artifact_upload_intent',
    description:
      'Create a short-lived scoped direct artifact upload intent. New clients should call this tool first, then upload raw bytes with HTTP POST application/octet-stream to /api/artifacts/upload using the returned requiredHeaders. Keeps binary bytes out of MCP arguments and returns no server secrets other than the scoped upload token. Accepted image formats: JPEG, PNG, WebP only — the upload decodes the bytes and rejects GIF, AVIF, SVG, and anything that does not decode as the declared type. PDF uploads must start with %PDF-.',
    inputSchema: artifactUploadIntentInputSchema(),
  },
  {
    name: 'create_artifact_from_url',
    description:
      'Fallback tool to ingest an artifact from a public HTTPS URL. Use this when the MCP client cannot perform a direct HTTP POST of binary bytes. The server fetches the URL, verifies expectedSizeBytes/expectedSha256 against the fetched bytes, and saves it as a request artifact. Accepted image formats: JPEG, PNG, WebP only (GIF, AVIF, and SVG are rejected); PDF bytes must start with %PDF-.',
    inputSchema: objectSchema(
      {
        requestId: stringSchema('Workflow request id that owns this artifact.'),
        artifactKind: artifactKindJsonSchema('Artifact kind for storage routing.'),
        contentType: stringSchema('MIME type of the artifact bytes.'),
        sourceUrl: stringSchema('Public HTTPS URL of the artifact to fetch.'),
        expectedSizeBytes: expectedSizeBytesJsonSchema,
        expectedSha256: expectedSha256JsonSchema,
        filename: {
          ...stringSchema('Optional original filename used for blob extension and ArtifactReference originalFilename.'),
          maxLength: artifactReferenceLimits.originalFilename,
        },
        label: artifactLabelJsonSchema,
        tags: artifactTagsJsonSchema,
        metadata: artifactMetadataJsonSchema,
      },
      ['requestId', 'artifactKind', 'contentType', 'sourceUrl', 'expectedSizeBytes', 'expectedSha256']
    ),
  },
  {
    name: 'save_artifact',
    description: `Legacy small-artifact single-shot byte upload. Required: requestId, artifactKind, contentType, payload. Store only the returned ArtifactReference; never invent blobKey values, URLs, or repo paths. Generated binary files/images should use create_artifact_upload_intent plus raw HTTP POST /api/artifacts/upload. Writes final artifact bytes and an ArtifactReference index for the request. Accepted image formats: JPEG, PNG, WebP only (GIF, AVIF, and SVG are rejected); PDF bytes must start with %PDF-. Returns artifact, complete=true, deduped; dedup is success and skips rewriting bytes.`,
    inputSchema: objectSchema(
      {
        requestId: stringSchema('Workflow request id that owns this artifact.'),
        artifactKind: artifactKindJsonSchema('Artifact kind for storage routing.'),
        contentType: stringSchema('MIME type for the artifact bytes.'),
        filename: {
          ...stringSchema('Optional original filename used for blob extension and ArtifactReference originalFilename.'),
          maxLength: artifactReferenceLimits.originalFilename,
        },
        encoding: artifactEncodingJsonSchema('Payload encoding; defaults to base64.'),
        expectedSizeBytes: expectedSizeBytesJsonSchema,
        expectedSha256: expectedSha256JsonSchema,
        localSizeBytes: expectedSizeBytesJsonSchema,
        localSha256: expectedSha256JsonSchema,
        payload: stringSchema(
          `Artifact bytes as base64 unless encoding is binary. Preferred for normal web images up to ${SINGLE_SHOT_ARTIFACT_GUIDANCE_MAX_BYTES} raw bytes; do not chunk merely because an image is around 50 KB.`
        ),
        label: artifactLabelJsonSchema,
        tags: artifactTagsJsonSchema,
        metadata: artifactMetadataJsonSchema,
      },
      ['requestId', 'artifactKind', 'contentType', 'payload']
    ),
  },
  {
    name: 'list_artifacts_for_request',
    description: `List ArtifactReference metadata for a requestId. Required: requestId. Reads the request artifact index only; it does not read or write artifact bytes. Soft-deleted artifacts are excluded — an artifact you uploaded but cannot see here has been deleted (use get_artifact_metadata to inspect it). Returns artifacts array. ${mediaPortabilityWarning}`,
    inputSchema: objectSchema(
      { requestId: stringSchema('Workflow request id whose artifact references should be listed.') },
      ['requestId']
    ),
  },
  {
    name: 'get_artifact_metadata',
    description:
      'Get full ArtifactReference metadata for a requestId and sha256. Does not read artifact bytes. Unlike list_artifacts_for_request, this also returns soft-deleted references — check for a deletedAtISO field; a reference carrying it is excluded from listing, trust checks, and publish until restored.',
    inputSchema: objectSchema(
      {
        requestId: stringSchema('Workflow request id that owns the artifact.'),
        sha256: expectedSha256JsonSchema,
      },
      ['requestId', 'sha256']
    ),
  },
  {
    name: 'list_artifacts_by_kind',
    description:
      'Admin-only artifact browser. Lists artifacts via artifact-index/by-kind/{artifactKind}/ pointers and resolves them to ArtifactReference objects. Does not read artifact bytes.',
    inputSchema: objectSchema(
      {
        artifactKind: artifactKindJsonSchema('Artifact kind pointer prefix to browse.'),
        limit: artifactListLimitJsonSchema,
        cursor: artifactListCursorJsonSchema,
        includeDeleted: artifactIncludeDeletedJsonSchema,
      },
      ['artifactKind']
    ),
  },
  {
    name: 'list_artifacts_by_request',
    description:
      'Admin-only artifact browser. Lists artifacts via artifact-index/by-request/{requestId}/ pointers, optionally scoped by artifactKind, and resolves them to ArtifactReference objects. Does not read artifact bytes.',
    inputSchema: objectSchema(
      {
        requestId: stringSchema('Workflow request id to browse artifacts for.'),
        artifactKind: artifactKindJsonSchema('Optional artifact kind pointer prefix within the request.'),
        limit: artifactListLimitJsonSchema,
        cursor: artifactListCursorJsonSchema,
        includeDeleted: artifactIncludeDeletedJsonSchema,
      },
      ['requestId']
    ),
  },
  {
    name: 'search_artifacts',
    description:
      'Admin-only artifact search using prefix indexes, not full text search. With tag, lists artifact-index/by-tag/{tag}/ pointers; without tag, lists by-kind pointer prefixes. Optional createdAfter/createdBefore filters are applied after resolving ArtifactReference objects. Does not read artifact bytes.',
    inputSchema: objectSchema({
      tag: artifactSearchTagJsonSchema,
      createdAfter: isoDateStringSchema('Optional inclusive lower createdAtISO bound.'),
      createdBefore: isoDateStringSchema('Optional inclusive upper createdAtISO bound.'),
      limit: artifactListLimitJsonSchema,
      cursor: artifactListCursorJsonSchema,
      includeDeleted: artifactIncludeDeletedJsonSchema,
    }),
  },
  {
    name: 'soft_delete_artifact',
    description:
      'Admin-only soft delete for an ArtifactReference. Marks request-artifacts/{requestId}/{sha256}.json with deletedAtISO/deletedBy and leaves binary artifact bytes in place.',
    inputSchema: objectSchema(
      {
        requestId: stringSchema('Workflow request id that owns the artifact reference.'),
        sha256: expectedSha256JsonSchema,
        deletedBy: artifactDeletedByJsonSchema,
      },
      ['requestId', 'sha256']
    ),
  },
  {
    name: 'restore_artifact',
    description:
      'Admin-only restore for a soft-deleted ArtifactReference. Clears deletedAtISO/deletedBy on request-artifacts/{requestId}/{sha256}.json and keeps existing blob bytes untouched.',
    inputSchema: objectSchema(
      {
        requestId: stringSchema('Workflow request id that owns the artifact reference.'),
        sha256: expectedSha256JsonSchema,
      },
      ['requestId', 'sha256']
    ),
  },
  {
    name: 'migrate_artifact_indexes',
    description:
      'Admin-only one-time artifact-index migration. Scans request-artifacts/{requestId}/{sha256}.json, fills missing artifactKind/originalFilename/label fields, writes by-kind and by-request pointers, and returns cursor checkpoints for large idempotent batches.',
    inputSchema: objectSchema({
      cursor: artifactListCursorJsonSchema,
      limit: artifactReconcileLimitJsonSchema,
      dryRun: artifactMigrationDryRunJsonSchema,
    }),
  },
  {
    name: 'wipe_blob_stores',
    description:
      'Admin-only MCP maintenance tool protected by server publish-key headers. Dry-runs by default; live mode ' +
      'deletes ONLY the prefixes you explicitly pass — there is no default-to-everything mode. prefixes is ' +
      'required and non-empty on every call, dry run included, so a caller can never wipe more than it verified ' +
      'it meant to. See prefixes for which ones are safe to wipe unconditionally vs. which are shared with live ' +
      'CMS object data and need a cross-reference first.',
    inputSchema: objectSchema(
      {
        dryRun: wipeBlobDryRunJsonSchema,
        confirm: wipeBlobConfirmJsonSchema,
        prefixes: wipeBlobPrefixesJsonSchema,
      },
      ['prefixes']
    ),
  },
  {
    name: 'reconcile_artifact_indexes',
    description:
      'Admin-only artifact-index correction job. Reads request-artifacts JSON references, normalizes blobKeys, checks artifact bytes, corrects stale artifact-index blobKey values when a single matching blob is found, and returns compact correction diagnostics.',
    inputSchema: objectSchema({
      requestId: stringSchema('Optional workflow request id to reconcile; omit to scan request-artifacts by prefix.'),
      artifactKind: artifactKindJsonSchema('Optional artifact kind to reconcile after reading request-artifacts JSON.'),
      limit: artifactReconcileLimitJsonSchema,
    }),
  },
  {
    name: 'capability_status',
    description:
      "Admin-only diagnostic (T16.5): reports this tenant's per-family env-gate status for every tool family that is env-gated at call time (pdf_bridge, pdf_storage_grant, commerce, purchase_token, build_hook, deploy_lookup, git_committer, blob_credentials, mcp_auth, artifact_upload). Each family reports {configured, missing} — missing is a list of env-var NAMES only, never values, lengths, or prefixes. Takes no arguments. Also returns this deployment's own site_id (non-secret) so a fleet probe can target the right site for the pdf-tool bridge families. Use this to find a tenant where a tool family lists in tools/list but 503s at call time — the class of gap docs/cms-architecture/16-genesis-parity-plan.md §1.1 records as previously undetected.",
    inputSchema: objectSchema({}),
  },
];
