/**
 * Function name: Admin_Visual_Identity_Preview_Sample
 * Required method: POST
 * Auth: Netlify Identity; an EDITOR may preview a sample (see PREVIEW_SAMPLE_ROLES).
 *
 * A5 — "Visual identity → PDF templates → Render sample (first page only)",
 * as an endpoint, instead of a chat instruction (`buildPreviewSampleIntent`,
 * visual-identity-pdf.ts, T2.6). Same shape as
 * `admin-visual-identity-render-sample`, minus the job/poll machinery:
 * pdf-tool's `preview_pdf_template` (W1) renders the first page only and
 * returns inline — no `create_agent_artifact_job` job to create or poll —
 * so this endpoint is the direct call, never a second copy of pdf-tool's
 * own logic.
 *
 * TWO CALLS, BOTH THE SAME HANDLERS THE MCP TOOLS USE. First
 * `callGetPdfTemplate` (the `get_pdf_template` tool's own handler) to read
 * the template's OWN `sampleData` — never anything the browser supplies —
 * then `callPreviewPdfTemplate` (the `preview_pdf_template` tool's own
 * handler, added alongside this endpoint since pdf-tool's tool had no
 * Platform-side wrapper before) with that data.
 *
 * NO MCP SIBLING WIRING NEEDED. Unlike `create_agent_artifact_job`, neither
 * handler this endpoint calls ever reaches the object store — both are
 * template-scoped only (`resolveTemplateBridgeScope`) — so, unlike
 * `admin-visual-identity-render-sample`, this file never calls
 * `configureMcp`.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import type { Role } from '../lib/roles.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
// IMPORT ORDER IS LOAD-BEARING: `mcp.ts` and `mcp-tool-handlers.ts` are a
// module CYCLE — see visual-reference-import.ts's identical comment. This
// side-effect-only import enters the cycle through `mcp.ts` before anything
// below reaches `mcp-tool-handlers.ts`.
import './mcp.js';
import { callGetPdfTemplate, callPreviewPdfTemplate } from '../lib/mcp-tool-handlers.js';
import { MAJOR_KEY_ARTIFACT_REF_RE, publicPathForArtifactRef } from '../lib/artifact-trust.js';

/**
 * Ordinary editorial work on a DRAFT artifact, not a publish — same gate as
 * `admin-visual-identity-import`'s `IMPORT_ROLES`.
 */
const PREVIEW_SAMPLE_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'publisher', 'editor']);

type LambdaEvent = {
  blobs?: string;
  body?: string | null;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
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

const buildHandlerImpl =
  (_binding: SiteBinding) =>
  async (event: LambdaEvent, context?: LambdaContext) => {
    if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

    const access = await resolveAdminAccessFromEvent(event, context);
    if (!access.authenticated) return jsonResponse(401, { error: access.error ?? 'Authentication is required.' });
    if (!access.roles.some((role) => PREVIEW_SAMPLE_ROLES.has(role))) {
      return jsonResponse(403, {
        error: `${access.email ?? 'This account'} has no editing role on this publication, so it cannot preview a sample. Ask the owner for editor or publisher.`,
      });
    }

    const payload = parseBody(event);
    if (!isRecord(payload)) return jsonResponse(400, { error: 'Invalid request body.' });

    const templateId = text(payload.templateId);
    if (!templateId) return jsonResponse(400, { error: 'templateId is required.' });

    try {
      const siteId = getSiteIdentity().siteId;

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
          error: `Template ${templateId} has no sampleData to preview.`,
          error_code: 'template_sample_data_missing',
        });
      }

      const previewed = await callPreviewPdfTemplate(event, {
        site_id: siteId,
        template_id: templateId,
        data: sampleData,
      });
      if ('isError' in previewed) {
        const detail = previewed.structuredContent as Record<string, unknown>;
        return jsonResponse(typeof detail.statusCode === 'number' ? (detail.statusCode as number) : 502, {
          error: text(detail.error) ?? 'The preview could not be rendered.',
          error_code: text(detail.error_code),
        });
      }

      event.log?.({
        event: 'visual_identity_pdf_sample_previewed',
        siteId,
        templateId,
      });

      // Best-effort only — never fabricated: `preview_pdf_template`'s exact
      // response shape is not yet proven against a live pdf-tool (see this
      // file's header). When the body carries a `blobKey` shaped like a
      // canonical Major Key, a servable preview URL is added alongside the
      // raw body; otherwise nothing is guessed.
      const blobKey = text(previewed.structuredContent.blobKey);
      const previewUrl =
        blobKey && MAJOR_KEY_ARTIFACT_REF_RE.test(blobKey) ? publicPathForArtifactRef(blobKey) : undefined;

      return jsonResponse(200, {
        template_id: templateId,
        ...previewed.structuredContent,
        ...(previewUrl ? { preview_url: previewUrl } : {}),
      });
    } catch (error) {
      console.error('Visual identity PDF sample preview failed.', error);
      return jsonResponse(500, { error: 'The preview could not be rendered.' });
    }
  };

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
