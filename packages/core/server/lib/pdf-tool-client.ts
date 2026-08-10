import { randomUUID } from 'node:crypto';
import { publicPathForArtifactRef } from './artifact-trust.js';
import type { PdfToolStorageGrant } from './pdf-tool-storage-grant.js';

type EnvSource = Record<string, string | undefined>;

export type PdfToolClientOptions = {
  env?: EnvSource;
  fetchImpl?: typeof fetch;
};

export type PdfToolCallResult =
  | { ok: true; statusCode: number; body: Record<string, unknown>; internalMaterializationProof?: string }
  | { ok: false; statusCode: number; error: string; body?: Record<string, unknown> };

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * T16.5: the single predicate for "is the pdf-tool bridge configured" — both
 * the real call path (resolvePdfToolClientConfig below) and
 * capability-status.ts's `pdf_bridge` family read this same function, so
 * there is exactly one place the env names live.
 */
export const pdfToolBridgeMissingEnvVars = (env: EnvSource = process.env): string[] => {
  const baseUrl = nonEmpty(env.PDF_TOOL_BASE_URL);
  const token = nonEmpty(env.PDF_TOOL_AGENT_RUN_TOKEN);
  return [...(baseUrl ? [] : ['PDF_TOOL_BASE_URL']), ...(token ? [] : ['PDF_TOOL_AGENT_RUN_TOKEN'])];
};

export const isPdfToolBridgeConfigured = (env: EnvSource = process.env): boolean =>
  pdfToolBridgeMissingEnvVars(env).length === 0;

export const resolvePdfToolClientConfig = (env: EnvSource = process.env) => {
  const missing = pdfToolBridgeMissingEnvVars(env);
  if (missing.length > 0) {
    return {
      ok: false as const,
      error: `Platform's pdf-tool bridge is not configured (missing ${missing.join(' and ')}).`,
      errorCode: 'pdf_tool_bridge_not_configured' as const,
      missing,
    };
  }
  const baseUrl = nonEmpty(env.PDF_TOOL_BASE_URL)!.replace(/\/+$/, '');
  const token = nonEmpty(env.PDF_TOOL_AGENT_RUN_TOKEN)!;
  return { ok: true as const, baseUrl, token };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Remove request-only capabilities before anything can reach an MCP response or log. */
export const sanitizePdfToolPayload = (value: unknown, secrets: string[] = []): unknown => {
  if (typeof value === 'string') {
    return secrets.filter(Boolean).reduce((safe, secret) => safe.split(secret).join('[REDACTED]'), value);
  }
  if (Array.isArray(value)) return value.map((child) => sanitizePdfToolPayload(child, secrets));
  if (!isRecord(value)) return value;

  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (['storage', 'token', 'materializationProof', 'materialization_proof'].includes(key)) continue;
    safe[key] = sanitizePdfToolPayload(child, secrets);
  }
  return safe;
};

/**
 * L1: Platform used to POST to eleven separate standalone Netlify Functions on pdf-tool
 * (`/.netlify/functions/create-agent-artifact-job`, `/get-agent-artifact-job-status`, ...).
 * Every distinct function name is its own Netlify Function container, so a burst of calls
 * across different tools kept hitting cold, unwarmed instances even when pdf-tool's `mcp`
 * function itself was warm (see warm-ping-scheduled.ts, which only ever pinged `mcp`).
 * postPdfTool now routes every call through that single already-warm `/mcp` JSON-RPC
 * endpoint instead, as a `tools/call` request naming the equivalent tool (the standalone
 * function's kebab-case name maps 1:1 onto the MCP tool's snake_case name).
 *
 * Two behavioral notes carried over from pdf-tool's docs/MCP_BRIDGE_PARITY.md (added by the
 * chore/mcp-statuscode-parity PR that made this migration safe):
 *  - `validate-pdf-template` and `get-pdf-template-validation` never had standalone Netlify
 *    Functions at all -- validatePlatformPdfTemplate/getPlatformPdfTemplateValidation below
 *    were calling a URL that 404s today. Routing through `/mcp` is not just a latency
 *    optimization for these two: it's the fix that makes them work.
 *  - A tool's HTTP status is not observable via MCP on SUCCESS (e.g. create_pdf_template's
 *    201, create_agent_artifact_job's 202 both collapse to this function's `statusCode: 200`)
 *    -- confirmed unused by any caller in this codebase. On error it IS preserved: pdf-tool's
 *    mcp.ts carries the original statusCode inside `structuredContent.statusCode`.
 */
const postPdfTool = async (
  functionName: string,
  payload: Record<string, unknown>,
  options: PdfToolClientOptions = {}
): Promise<PdfToolCallResult> => {
  const config = resolvePdfToolClientConfig(options.env);
  if (!config.ok) return { ok: false, statusCode: 503, error: config.error };

  let response: Response;
  try {
    response = await (options.fetchImpl ?? globalThis.fetch)(`${config.baseUrl}/.netlify/functions/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: { name: functionName.replace(/-/g, '_'), arguments: payload },
      }),
    });
  } catch {
    return { ok: false, statusCode: 502, error: 'pdf-tool is unreachable from Platform.' };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return { ok: false, statusCode: 502, error: `pdf-tool returned a non-JSON response (HTTP ${response.status}).` };
  }

  const storageToken =
    isRecord(payload.storage) && typeof payload.storage.token === 'string' ? payload.storage.token : undefined;
  const secrets = [config.token, ...(storageToken ? [storageToken] : [])];

  // A successful tools/call always carries `result.structuredContent` (see pdf-tool's
  // mcp.ts toolContent/errorContent) -- true for both a business SUCCESS and a business
  // ERROR, both delivered at HTTP 200. Anything else (non-2xx, or a 200 with no `result`,
  // e.g. "Unknown tool") means the call never reached tool code at all; fall back to
  // whatever pdf-tool sent, sanitized the same way, exactly like the pre-MCP bridge did.
  const rpcResult =
    isRecord(raw) && isRecord((raw as { result?: unknown }).result)
      ? (raw as { result: Record<string, unknown> }).result
      : undefined;
  const bodySource = rpcResult ? rpcResult.structuredContent : raw;
  const internalMaterializationProof =
    isRecord(bodySource) && typeof bodySource.materializationProof === 'string'
      ? bodySource.materializationProof
      : undefined;
  const safe = sanitizePdfToolPayload(bodySource, secrets);
  const body = isRecord(safe) ? safe : {};

  if (rpcResult && !rpcResult.isError) {
    return { ok: true, statusCode: 200, body, internalMaterializationProof };
  }

  const jsonRpcError =
    isRecord(raw) && isRecord((raw as { error?: unknown }).error)
      ? (raw as { error: Record<string, unknown> }).error
      : undefined;
  const statusCode =
    typeof body.statusCode === 'number' ? body.statusCode : response.status !== 200 ? response.status : 502;
  const error =
    typeof body.error === 'string'
      ? body.error
      : typeof jsonRpcError?.message === 'string'
        ? String(sanitizePdfToolPayload(jsonRpcError.message, secrets))
        : `pdf-tool request failed (HTTP ${response.status}).`;
  return { ok: false, statusCode, error, body };
};

export type PlatformArtifactJobInput = {
  requestId: string;
  artifactKind: 'image' | 'pdf';
  operation?: 'generate' | 'edit';
  prompt?: string;
  filename: string;
  slot?: string;
  model?: string;
  requirements?: Record<string, unknown>;
  templateId?: string;
  templateRef?: { storeName?: string; blobKey: string; version?: number };
  data?: unknown;
  assets?: { images?: unknown[] };
};

const projectPayload = (grant: PdfToolStorageGrant, payload: Record<string, unknown>) => ({
  ...payload,
  projectId: grant.projectId,
  storage: grant,
});

export const createPlatformArtifactJob = (
  grant: PdfToolStorageGrant,
  input: PlatformArtifactJobInput,
  options: PdfToolClientOptions = {}
) =>
  postPdfTool(
    'create-agent-artifact-job',
    projectPayload(grant, {
      requestId: input.requestId,
      artifactKind: input.artifactKind,
      operation: input.operation ?? 'generate',
      prompt: input.prompt,
      filename: input.filename,
      slot: input.slot,
      model: input.model,
      requirements: input.requirements,
      templateId: input.templateId,
      templateRef: input.templateRef,
      data: input.data,
      assets: input.assets,
    }),
    options
  );

export const getPlatformArtifactJobStatus = (
  grant: PdfToolStorageGrant,
  jobId: string,
  options: PdfToolClientOptions = {}
) => postPdfTool('get-agent-artifact-job-status', projectPayload(grant, { jobId }), options);

export const getPlatformArtifactBySlot = (
  grant: PdfToolStorageGrant,
  requestId: string,
  slot: string,
  options: PdfToolClientOptions = {}
) => postPdfTool('get-agent-artifact-by-slot', projectPayload(grant, { requestId, slot }), options);

export const verifyPlatformArtifact = (
  grant: PdfToolStorageGrant,
  requestId: string,
  artifactReference: Record<string, unknown>,
  materializationProof: string | undefined,
  options: PdfToolClientOptions = {}
) =>
  postPdfTool(
    'verify-agent-artifact',
    projectPayload(grant, { requestId, artifactReference, materializationProof }),
    options
  );

export type PlatformCreateTemplateInput = {
  templateJson: unknown;
  renderer?: 'pdfme' | 'react-pdf' | 'typst' | 'chromium';
  templateId?: string;
  label?: string;
  tags?: string[];
};

export const createPlatformPdfTemplate = (
  grant: PdfToolStorageGrant,
  input: PlatformCreateTemplateInput,
  options: PdfToolClientOptions = {}
) =>
  postPdfTool(
    'create-pdf-template',
    projectPayload(grant, {
      templateJson: input.templateJson,
      ...(input.renderer ? { renderer: input.renderer } : {}),
      ...(input.templateId ? { templateId: input.templateId } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
    }),
    options
  );

export const listPlatformPdfTemplates = (
  grant: PdfToolStorageGrant,
  input: { limit?: number; cursor?: string } = {},
  options: PdfToolClientOptions = {}
) =>
  postPdfTool(
    'list-pdf-templates',
    projectPayload(grant, {
      ...(input.limit ? { limit: input.limit } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    }),
    options
  );

export const getPlatformPdfTemplate = (
  grant: PdfToolStorageGrant,
  input: { templateId: string; version?: number },
  options: PdfToolClientOptions = {}
) =>
  postPdfTool(
    'get-pdf-template',
    projectPayload(grant, {
      templateId: input.templateId,
      ...(input.version ? { version: input.version } : {}),
    }),
    options
  );

export const publishPlatformPdfTemplate = (
  grant: PdfToolStorageGrant,
  input: { templateId: string; version?: number },
  options: PdfToolClientOptions = {}
) =>
  postPdfTool(
    'publish-pdf-template',
    projectPayload(grant, {
      templateId: input.templateId,
      ...(input.version ? { version: input.version } : {}),
    }),
    options
  );

/**
 * QA-W16-2: react-pdf/typst/chromium templates require a PASSED validation
 * report before publish_pdf_template will activate them (pdf-tool enforces
 * this; publishPlatformPdfTemplate surfaces the refusal as HTTP 409
 * TEMPLATE_VALIDATION_REQUIRED). Until this bridge existed, no site connector
 * could ever produce that report — validate_pdf_template and
 * get_pdf_template_validation are pdf-tool's own tools for exactly this, and
 * they require the same storage grant (siteId + token) that
 * createPlatformPdfTemplate above already mints and forwards server-side.
 * These two mirror that exact pattern: the grant is built here, forwarded to
 * pdf-tool, and never returned to the MCP caller.
 */
export const validatePlatformPdfTemplate = (
  grant: PdfToolStorageGrant,
  input: { templateId: string; version?: number },
  options: PdfToolClientOptions = {}
) =>
  postPdfTool(
    'validate-pdf-template',
    projectPayload(grant, {
      templateId: input.templateId,
      ...(input.version ? { version: input.version } : {}),
    }),
    options
  );

export const getPlatformPdfTemplateValidation = (
  grant: PdfToolStorageGrant,
  input: { templateId: string; version?: number; validationId?: string },
  options: PdfToolClientOptions = {}
) =>
  postPdfTool(
    'get-pdf-template-validation',
    projectPayload(grant, {
      templateId: input.templateId,
      ...(input.version ? { version: input.version } : {}),
      ...(input.validationId ? { validationId: input.validationId } : {}),
    }),
    options
  );

export const deletePlatformPdfTemplate = (
  grant: PdfToolStorageGrant,
  input: { templateId: string; version?: number; reason?: string },
  options: PdfToolClientOptions = {}
) =>
  postPdfTool(
    'delete-pdf-template',
    projectPayload(grant, {
      templateId: input.templateId,
      ...(input.version ? { version: input.version } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    }),
    options
  );

export const canonicalPlatformArtifact = (body: Record<string, unknown>) => {
  const reference = isRecord(body.artifactReference)
    ? body.artifactReference
    : isRecord(body.artifact)
      ? body.artifact
      : undefined;
  const blobKey = reference && typeof reference.blobKey === 'string' ? reference.blobKey : undefined;
  if (!reference || !blobKey) return undefined;
  return { artifactReference: reference, publicPath: publicPathForArtifactRef(blobKey) };
};
