/**
 * Function name: Admin_Visual_Identity_Render_Sample
 * Required method: POST
 * Auth: Netlify Identity; an EDITOR may render a sample (see RENDER_SAMPLE_ROLES).
 *
 * A5 — "Visual identity → PDF templates → Render sample", as an endpoint,
 * instead of a chat instruction (`buildRenderSampleIntent`,
 * visual-identity-pdf.ts, U1). Follows A1/A3's shape: this never re-derives
 * pdf-tool's own logic — it calls the SAME handlers `get_pdf_template` and
 * `create_agent_artifact_job` dispatch to (`callGetPdfTemplate`,
 * `callCreateAgentArtifactJob`, mcp-tool-handlers.ts), never a second copy.
 *
 * WHAT IT REPLACES. The chat intent told the agent to read a template's own
 * `sampleData` with `get_pdf_template`, then call `create_agent_artifact_job`
 * with that template and data, and to poll rather than recreate the job —
 * three separate instructions a model could get wrong (a stale template id,
 * an invented sample payload, a duplicate job on retry). All three are now
 * deterministic: the template id is read off the row the button is on, its
 * OWN sampleData is what renders (never anything the browser supplies), and
 * `wait: true` (create_agent_artifact_job's own inline-wait budget) means a
 * single call usually comes back with the finished artifact already.
 *
 * NO OWNING CONTENT_ITEM. A template sample belongs to no article, so this
 * mints its own throwaway request id and hands `callCreateAgentArtifactJob`
 * a `presolvedScope` — the exact mechanism the visual-standard example
 * generator's platform-internal jobs already use
 * (mcp-tool-handlers.ts's `createVisualStandardExampleJob`) to skip the
 * content_item-ownership check that has nothing to check against here. The
 * id is never trusted FROM the browser — it is minted here, server-side,
 * from the template id and the clock.
 *
 * WHY THIS CONFIGURES MCP. `callCreateAgentArtifactJob` looks up the site
 * record for brand injection on every PDF job (D-3), through
 * `invokeObjectStore` — which reaches the object store via mcp.ts's injected
 * sibling handlers. Netlify bundles every function separately, so — exactly
 * like `visual-standard-examples-background.ts` — this function must wire
 * those siblings itself before its first call into mcp-tool-handlers.ts.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import type { Role } from '../lib/roles.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import { getArtifactIndexBlobStore } from '../lib/blob-store.js';
import { listArtifactReferencesForRequest, type ArtifactIndexStore } from '../lib/artifact-index.js';
// IMPORT ORDER IS LOAD-BEARING: `mcp.ts` and `mcp-tool-handlers.ts` are a
// module CYCLE — see visual-reference-import.ts's identical comment. This
// file must enter that cycle through `mcp.ts` (the value import below, for
// `configureMcp`), never through `mcp-tool-handlers.ts` first.
import { configureMcp } from './mcp.js';
import { callCreateAgentArtifactJob, callGetPdfTemplate } from '../lib/mcp-tool-handlers.js';
import { createHandler as createSaveArtifactHandler } from './save-artifact.js';
import { createHandler as createObjectStoreHandler } from './object-store.js';
import { createHandler as createDeployStatusHandler } from './deploy-status.js';

/**
 * Ordinary editorial work on a DRAFT artifact, not a publish — same gate as
 * `admin-visual-identity-import`'s `IMPORT_ROLES`.
 */
const RENDER_SAMPLE_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'publisher', 'editor']);

type LambdaEvent = {
  blobs?: string;
  body?: string | null;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
  invocationDeadlineMs?: number;
  log?: (payload: Record<string, unknown>) => void;
};

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});


const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const parseBody = (event: LambdaEvent): unknown => {
  if (!event.body) return undefined;
  try {
    return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
  } catch {
    return undefined;
  }
};

/**
 * `req_pdfsmp_<template>_<yyyymmdd>_<nn>` — agents-naming.ts's REQUEST_ID_RE
 * shape (`nn` is exactly two digits, so there are only ever 100 of them a day
 * per template).
 *
 * W5 F11: `nn` used to be `Date.now() % 100` — two renders of the same
 * template on the same day therefore collided about one time in a hundred,
 * and a collision puts two different samples in ONE artifact-index request
 * bucket, which is the bucket "the latest sample for this template" is read
 * out of. `nn` is now the first sequence of the day nothing is indexed under,
 * probed exactly the way `mintVisualReferenceRequestId` (A1) probes for
 * `req_visref_*` — the repo's existing answer for this id shape.
 */
const toMachineSegment = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'x';
};

export const pdfSampleRequestId = (templateId: string, nowMs: number, sequence: number): string => {
  const yyyymmdd = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');
  return `req_pdfsmp_${toMachineSegment(templateId)}_${yyyymmdd}_${String(sequence).padStart(2, '0')}`;
};

export const mintPdfSampleRequestId = async (input: {
  templateId: string;
  nowMs: number;
  isTaken: (requestId: string) => Promise<boolean>;
}): Promise<string> => {
  for (let sequence = 1; sequence <= 99; sequence += 1) {
    const candidate = pdfSampleRequestId(input.templateId, input.nowMs, sequence);
    if (!(await input.isTaken(candidate))) return candidate;
  }
  // 99 samples of one template in one UTC day: reuse the last slot rather than
  // refusing to render — nothing addresses this id afterwards.
  return pdfSampleRequestId(input.templateId, input.nowMs, 99);
};

const pdfSampleFilename = (templateId: string): string => `${toMachineSegment(templateId).replace(/_/g, '-')}-sample.pdf`;

export type AdminVisualIdentityRenderSampleOptions = {
  now?: () => number;
};

const buildHandlerImpl =
  (binding: SiteBinding, options: AdminVisualIdentityRenderSampleOptions = {}) =>
  async (event: LambdaEvent, context?: LambdaContext) => {
    if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

    const access = await resolveAdminAccessFromEvent(event, context);
    if (!access.authenticated) return jsonResponse(401, { error: access.error ?? 'Authentication is required.' });
    if (!access.roles.some((role) => RENDER_SAMPLE_ROLES.has(role))) {
      return jsonResponse(403, {
        error: `${access.email ?? 'This account'} has no editing role on this publication, so it cannot render a sample. Ask the owner for editor or publisher.`,
      });
    }

    const payload = parseBody(event);
    if (!isRecord(payload)) return jsonResponse(400, { error: 'Invalid request body.' });

    const templateId = text(payload.templateId);
    if (!templateId) return jsonResponse(400, { error: 'templateId is required.' });

    // Lazily, once per process, and never at module load — see
    // visual-standard-examples-background.ts's identical rationale.
    configureMcp({
      saveArtifactHandler: createSaveArtifactHandler(binding),
      objectStoreHandler: createObjectStoreHandler(binding),
      deployStatusHandler: createDeployStatusHandler(binding),
    });

    try {
      const identity = getSiteIdentity();
      const siteId = identity.siteId;

      const templateLookup = await callGetPdfTemplate(event, { site_id: siteId, template_id: templateId });
      if ('isError' in templateLookup) {
        const detail = templateLookup.structuredContent as Record<string, unknown>;
        const status = typeof detail.statusCode === 'number' ? (detail.statusCode as number) : 404;
        return jsonResponse(status, {
          error: text(detail.error) ?? `No pdf template ${templateId} exists on this publication.`,
          error_code: text(detail.error_code),
        });
      }
      const sampleData = templateLookup.structuredContent.sampleData;
      if (!isRecord(sampleData)) {
        return jsonResponse(422, {
          error: `Template ${templateId} has no sampleData to render a sample from.`,
          error_code: 'template_sample_data_missing',
        });
      }

      const nowMs = options.now?.() ?? Date.now();
      const indexStore = (await getArtifactIndexBlobStore(event).catch(() => undefined)) as unknown as
        | ArtifactIndexStore
        | undefined;
      const requestId = await mintPdfSampleRequestId({
        templateId,
        nowMs,
        isTaken: async (candidate) =>
          indexStore ? (await listArtifactReferencesForRequest(indexStore, candidate)).length > 0 : false,
      });
      const filename = pdfSampleFilename(templateId);

      const created = await callCreateAgentArtifactJob(
        event,
        {
          site_id: siteId,
          request_id: requestId,
          artifact_kind: 'pdf',
          template_id: templateId,
          data: sampleData,
          filename,
          wait: true,
        },
        { siteId, requestId }
      );
      if ('isError' in created) {
        const detail = created.structuredContent as Record<string, unknown>;
        return jsonResponse(typeof detail.statusCode === 'number' ? (detail.statusCode as number) : 502, {
          error: text(detail.error) ?? 'The sample could not be rendered.',
          error_code: text(detail.error_code),
        });
      }
      const body = created.structuredContent as Record<string, unknown>;
      // W5 F7: `wait: true` is an inline wait with a BUDGET, and
      // `callCreateAgentArtifactJob` returns its ordinary pending payload —
      // not an error — when that budget runs out (its
      // `artifact_bridge_job_inline_wait_timed_out` branch). Reporting that as
      // a flat 200 told the tab "a sample of X was rendered" for a job that
      // was still running, with no artifact to show and nothing to poll; the
      // only recovery was clicking again, which mints another request id and
      // pays for a second render. A job that has not produced an artifact yet
      // is a 202 with its job id, and the panel waits for it.
      const rendered = Boolean(body.artifactReference);

      event.log?.({
        event: 'visual_identity_pdf_sample_rendered',
        siteId,
        templateId,
        requestId,
        jobId: text(body.jobId),
        hasArtifact: rendered,
      });

      return jsonResponse(rendered ? 200 : 202, { template_id: templateId, request_id: requestId, ...body });
    } catch (error) {
      console.error('Visual identity PDF sample render failed.', error);
      return jsonResponse(500, { error: 'The sample could not be rendered.' });
    }
  };

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding, options?: AdminVisualIdentityRenderSampleOptions) =>
  buildHandlerImpl(binding, options);
