/**
 * P5 (brand-imagery wave, BRIEF.md §3.5) — the thin `brand_imagery_propose`
 * proxy. Platform makes NO model call of its own: it builds the request and
 * calls CMS-Agent's narrow, site-scoped `visual_identity_propose` tool
 * through an already-authenticated `CmsAgentClient`-shaped bridge, validates
 * the returned `brand_imagery_proposal.v1` against the SAME `brandImagerySchema`
 * every other brandImagery producer uses (never forked — R1), and hands the
 * proposal back for the chat approval card. It performs NO object-store
 * reads or writes — applying a proposal is a later, separate step
 * (`visual_standard_materializer` then `site_apply_brand_imagery`, §3.5).
 *
 * D1 FIX (task A2): this used to call CMS-Agent's `node_execute`, which is
 * workspace-programming scope and is NEVER granted to a site-scoped bearer
 * (verified against CMS-Agent's `siteGenesis.ts#SITE_CLIENT_MANAGER_TOOLS` +
 * `mcpEndpoint.ts#isScopedRequestAllowed` — only `agent_resolve`/
 * `agent_converse` and a short workflow list are ever scoped to a site
 * token). Every real call came back a 502 `cms_agent_auth_failed`
 * ("CMS-Agent rejected the credential") — the credential was fine, the TOOL
 * was never reachable. `visual_identity_propose` is the fix: a new, narrow,
 * site-scoped MCP tool built for exactly this call, taking `project_id` +
 * `mode` + the writer fields directly (no `nodeId`/`input` wrapping) and
 * returning `{ proposal, executionId, nodeId }` once CmsAgentClient.callTool
 * has stripped the MCP `{ok,data}` envelope. The node.execute-record and
 * bare-proposal parsing below stay — additive, never removed — so a
 * deployment that has not yet cut over still works.
 *
 * Reference resolution (the one piece of real work this module does): the
 * writer's own input keeps `references[]` in the moodboard's declared shape
 * (`blobKey|url`, `region?`, `note?`, `weight?` — §3.1/§3.5) so the eventual
 * `visual_standard_materializer` can store them verbatim, but the WRITER
 * MODEL itself only ever sees pixels through `input.imageRefs[]` (§3.9's
 * generic node-runner image contract: `url|base64` + `mediaType` + `label?`,
 * capped at 8). CMS-Agent has no reach into Platform's own blob store, so
 * Platform is the only party that can turn a `blobKey` into something the
 * model can see — a bare reference becomes a fetchable absolute URL, and a
 * reference carrying a `region` is cropped locally (sharp, already a
 * dependency) and embedded as base64 instead. A reference that cannot be
 * resolved (network hiccup, unreadable bytes, unsupported extension) is
 * dropped from `imageRefs` — never fails the whole call — and reported in
 * `unresolvedReferences`.
 */
import type sharpType from 'sharp';
import { z } from 'zod';

import { brandImagerySchema } from '../../schema/bodies/site-v1.js';

const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

// ─── the node-runner cap (BRIEF §3.9): "max 8, ≤1.5 MB each after fetch" ────
export const BRAND_IMAGERY_MAX_REFERENCES = 8;
const MAX_IMAGE_REF_BYTES = 1.5 * 1024 * 1024;

export type BrandImageryRegion = { x: number; y: number; w: number; h: number };

export type BrandImageryReferenceInput = {
  blobKey?: string;
  url?: string;
  region?: BrandImageryRegion;
  note?: string;
  weight?: number;
};

export type BrandImageryProposeInput = {
  /** Resolved server-side from the authenticated site binding — never caller-supplied. */
  projectId: string;
  mode: 'house' | 'template';
  visualStandardId?: string;
  references?: BrandImageryReferenceInput[];
  brief?: string;
  existingBrandImagery?: unknown;
  templateSlug?: string;
};

export type BrandImageryImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';
export type BrandImageryImageRef = {
  url?: string;
  base64?: string;
  mediaType: BrandImageryImageMediaType;
  label?: string;
};

/**
 * The minimal CmsAgentClient surface this module needs — satisfied
 * structurally by the real class (cms-agent-client.ts's `nodeExecute`/
 * `callTool`), by `ctx.cmsAgent` (agent/tools.ts), and by a plain test stub.
 */
export type BrandImageryCmsAgentClient = {
  callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>
  ): Promise<
    | { ok: true; data: T }
    | {
        ok: false;
        code: string;
        message: string;
        /**
         * Structurally optional here so the real `CmsAgentClient` (which
         * always sets these) and a minimal hand-written test stub (which
         * usually doesn't) both satisfy this type. Read by
         * `looksLikeUnknownToolFailure` below to tell "CMS-Agent doesn't
         * know this tool name" apart from every other failure — see its
         * doc comment for why `fromJsonBody` (never `code`/`message` alone)
         * is the one signal trustworthy enough to key on.
         */
        statusCode?: number;
        fromJsonBody?: boolean;
      }
  >;
};

export type BrandImageryProxyDeps = {
  cmsAgent: BrandImageryCmsAgentClient;
  /** blobKey -> absolute, externally-fetchable URL. Pure; touches no bytes. */
  resolveBlobUrl: (blobKey: string) => string;
  /**
   * Raw bytes for a blobKey, out of Platform's OWN artifact blob store —
   * read ONLY when a reference carries a `region` (cropping needs pixels).
   * Absent (e.g. no LambdaEvent/blob context available, as in the chat
   * surface) simply means region cropping is skipped for blobKey refs; the
   * whole-image URL is still used.
   */
  readBlobBytes?: (blobKey: string) => Promise<Buffer | undefined>;
  /** Fetches bytes for a bare `url` reference that also carries a `region`. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Hydrates `references` / `existingBrandImagery` from the visual_standard
   * named by `input.visualStandardId`, called BEFORE validation. This is the
   * fix for the live defect (2026-09-04): `visual_standard_id` was accepted
   * as "revise this existing standard" but nothing ever read the standard it
   * named, so a caller passing ONLY `visual_standard_id` (no references, no
   * brief) hit "requires at least one of references or brief" even though
   * the standard's own record carries a mood board — an agent has no way to
   * discover or supply what this proxy silently threw away.
   *
   * OPTIONAL, deliberately: this module makes NO object-store read or write
   * of its own (see the file header — P5's whole design is a proxy with no
   * store reach), so hydration can only ever be a caller-supplied lookup.
   * Optional also means every EXISTING caller and every hand-written test
   * stub that constructs `BrandImageryProxyDeps` without this field keeps
   * working byte-identical to before this existed — the regression guard for
   * every caller that predates the fix. A loader that throws or resolves to
   * `undefined` is treated as "no hydration available", never a crash (see
   * `hydrateFromVisualStandard`) — the ordinary validation below then still
   * runs and produces its normal 400 if the caller supplied nothing else.
   */
  loadVisualStandard?: (
    visualStandardId: string
  ) => Promise<{ references?: BrandImageryReferenceInput[]; brandImagery?: unknown } | undefined>;
  /**
   * A3 (admin visual-identity propose) — forces EVERY reference to resolve
   * to base64 pixels the writer model can see directly, never a URL the
   * CMS-Agent node runner would have to fetch itself. THE BUG THIS CLOSES: a
   * photographic mood board produced a `digital_illustration` proposal — the
   * writer received `imageRefs[].url`, the runner fetches unauthenticated
   * http(s) only, an admin-gated blob URL 401s, and the image is silently
   * dropped with no warning why. When true:
   *   - a reference with no valid `region` is still read and re-encoded
   *     (the region defaults to the whole frame, `{x:0,y:0,w:1,h:1}`)
   *     rather than handed to the model as a fetchable URL;
   *   - a reference whose bytes cannot be read, or whose crop/re-encode
   *     fails, is DROPPED (reported in `unresolvedReferences`) rather than
   *     falling back to a URL — the ordinary default behaviour a few lines
   *     down exists precisely to avoid dropping a reference outright, which
   *     is exactly wrong for this caller;
   *   - a bare `url` reference (no `blobKey`) is resolved by fetching it
   *     server-side instead of being handed to the model unfetched;
   *   - a request that resolves ZERO images and carries no `brief` is
   *     refused with `no_images_reached_writer` (422) before CMS-Agent is
   *     ever called — nothing would reach the writer model either way, and
   *     it is better to say so than to spend a model call producing a
   *     proposal from nothing.
   * Opt-in and default-false: the chat-tool `brand_imagery_propose` path
   * (mcp-tool-handlers.ts's `callBrandImageryPropose`) keeps its existing,
   * more forgiving URL-fallback behaviour unless/until it is moved onto this
   * flag too.
   */
  requireResolvedImages?: boolean;
  /** Structured usage/telemetry logging — the existing `event.log?.(...)` convention. */
  log?: (event: Record<string, unknown>) => void;
};

export type BrandImageryProxyError = {
  ok: false;
  status: 400 | 422 | 502;
  errorCode: string;
  error: string;
  detail?: Record<string, unknown>;
};

export type BrandImageryProxySuccess = {
  ok: true;
  status: 200;
  body: Record<string, unknown>;
};

export type BrandImageryProxyResult = BrandImageryProxySuccess | BrandImageryProxyError;

const err = (status: 400 | 422 | 502, errorCode: string, error: string, detail?: Record<string, unknown>): BrandImageryProxyError => ({
  ok: false,
  status,
  errorCode,
  error,
  ...(detail ? { detail } : {}),
});

// ─── request-shape validation (§3.5: "at least one of references / brief") ──

export const validateBrandImageryProposeInput = (input: BrandImageryProposeInput): BrandImageryProxyError | undefined => {
  if (!toNonEmptyString(input.projectId)) {
    return err(400, 'brand_imagery_propose_missing_project', 'projectId is required.');
  }
  if (input.mode !== 'house' && input.mode !== 'template') {
    return err(400, 'brand_imagery_propose_invalid_mode', 'mode must be "house" or "template".');
  }
  const references = input.references ?? [];
  if (references.length > BRAND_IMAGERY_MAX_REFERENCES) {
    return err(
      400,
      'brand_imagery_propose_too_many_references',
      `references must not exceed ${BRAND_IMAGERY_MAX_REFERENCES} items (the node runner's imageRefs cap, BRIEF §3.9); got ${references.length}.`
    );
  }
  const brief = toNonEmptyString(input.brief);
  if (references.length === 0 && !brief) {
    return err(
      400,
      'brand_imagery_propose_missing_input',
      'brand_imagery_propose requires at least one of references or brief.'
    );
  }
  for (const [index, reference] of references.entries()) {
    if (!toNonEmptyString(reference.blobKey) && !toNonEmptyString(reference.url)) {
      return err(
        400,
        'brand_imagery_propose_invalid_reference',
        `references[${index}] must carry a blobKey or a url.`
      );
    }
  }
  return undefined;
};

// ─── reference resolution ───────────────────────────────────────────────────

const isValidRegion = (region: BrandImageryRegion | undefined): region is BrandImageryRegion => {
  if (!region) return false;
  const { x, y, w, h } = region;
  return (
    [x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    x >= 0 &&
    x < 1 &&
    y >= 0 &&
    y < 1 &&
    w > 0 &&
    h > 0
  );
};

const EXTENSION_MEDIA_TYPES: Record<string, BrandImageryImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const mediaTypeFromPath = (pathOrUrl: string): BrandImageryImageMediaType | undefined => {
  const clean = pathOrUrl.split(/[?#]/)[0];
  const ext = clean.slice(clean.lastIndexOf('.') + 1).toLowerCase();
  return EXTENSION_MEDIA_TYPES[ext];
};

// sharp's native libvips binding dominates cold-start module evaluation (same
// rationale as image-validation.ts's loadSharp) — load lazily, cache per
// runtime instance, never at this module's own top level.
let cachedSharp: typeof sharpType | undefined;
const loadSharp = async (): Promise<typeof sharpType> => {
  if (!cachedSharp) {
    cachedSharp = (await import('sharp')).default;
  }
  return cachedSharp;
};

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** Crops `bytes` to `region` (0..1 fractions of the decoded image) and re-encodes, capped at MAX_IMAGE_REF_BYTES. Returns undefined on anything unreadable/oversized rather than throwing — a bad reference image must never fail the whole proposal. */
const cropToImageRef = async (
  bytes: Buffer,
  region: BrandImageryRegion
): Promise<{ base64: string; mediaType: BrandImageryImageMediaType } | undefined> => {
  try {
    const sharpFn = await loadSharp();
    const source = sharpFn(bytes, { failOn: 'error' });
    const metadata = await source.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) return undefined;

    const left = clamp(Math.round(region.x * width), 0, width - 1);
    const top = clamp(Math.round(region.y * height), 0, height - 1);
    const cropWidth = clamp(Math.round(region.w * width), 1, width - left);
    const cropHeight = clamp(Math.round(region.h * height), 1, height - top);

    const outputFormat: 'png' | 'jpeg' | 'webp' =
      metadata.format === 'png' ? 'png' : metadata.format === 'webp' ? 'webp' : 'jpeg';
    const pipeline = sharpFn(bytes).extract({ left, top, width: cropWidth, height: cropHeight });
    const cropped = await (outputFormat === 'png'
      ? pipeline.png()
      : outputFormat === 'webp'
        ? pipeline.webp({ quality: 82 })
        : pipeline.jpeg({ quality: 82 })
    ).toBuffer();

    if (cropped.byteLength > MAX_IMAGE_REF_BYTES) return undefined;
    const mediaType = outputFormat === 'png' ? 'image/png' : outputFormat === 'webp' ? 'image/webp' : 'image/jpeg';
    return { base64: cropped.toString('base64'), mediaType };
  } catch {
    return undefined;
  }
};

const fetchBytes = async (url: string, fetchImpl: typeof fetch): Promise<Buffer | undefined> => {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return undefined;
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return buffer.byteLength > 0 ? buffer : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Resolves ONE moodboard reference into a node-runner `imageRef` (§3.9).
 * Never throws: an unresolved reference returns undefined and is reported by
 * the caller in `unresolvedReferences`, never turned into a hard failure.
 */
const resolveImageRef = async (
  reference: BrandImageryReferenceInput,
  deps: BrandImageryProxyDeps
): Promise<BrandImageryImageRef | undefined> => {
  const label = toNonEmptyString(reference.note);
  const blobKey = toNonEmptyString(reference.blobKey);

  if (deps.requireResolvedImages) {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const bareUrl = !blobKey ? toNonEmptyString(reference.url) : undefined;
    const bytes = blobKey
      ? await deps.readBlobBytes?.(blobKey)
      : bareUrl
        ? await fetchBytes(bareUrl, fetchImpl)
        : undefined;
    if (!bytes) return undefined;
    const region = isValidRegion(reference.region) ? reference.region! : { x: 0, y: 0, w: 1, h: 1 };
    const encoded = await cropToImageRef(bytes, region);
    if (!encoded) return undefined;
    return { base64: encoded.base64, mediaType: encoded.mediaType, ...(label ? { label } : {}) };
  }

  const url = blobKey ? deps.resolveBlobUrl(blobKey) : toNonEmptyString(reference.url);
  if (!url) return undefined;

  if (isValidRegion(reference.region)) {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const bytes = blobKey ? await deps.readBlobBytes?.(blobKey) : await fetchBytes(url, fetchImpl);
    if (bytes) {
      const cropped = await cropToImageRef(bytes, reference.region!);
      if (cropped) return { base64: cropped.base64, mediaType: cropped.mediaType, ...(label ? { label } : {}) };
    }
    // Bytes unavailable or crop failed: fall through to the whole-image URL
    // rather than dropping the reference outright — a courser view still
    // beats no view.
  }

  const mediaType = mediaTypeFromPath(url) ?? mediaTypeFromPath(blobKey ?? '');
  if (!mediaType) return undefined;
  return { url, mediaType, ...(label ? { label } : {}) };
};

const resolveImageRefs = async (
  references: BrandImageryReferenceInput[],
  deps: BrandImageryProxyDeps
): Promise<{ imageRefs: BrandImageryImageRef[]; unresolvedReferences: number[] }> => {
  const imageRefs: BrandImageryImageRef[] = [];
  const unresolvedReferences: number[] = [];
  for (const [index, reference] of references.entries()) {
    const resolved = await resolveImageRef(reference, deps);
    if (resolved) imageRefs.push(resolved);
    else unresolvedReferences.push(index);
  }
  return { imageRefs, unresolvedReferences };
};

// ─── the writer's output contract (§3.5) — validated defensively before it
// ever reaches the approval card. `brandImagery` is checked against the
// SAME schema every other producer uses (never forked, R1); the surrounding
// envelope fields are checked too, since a proposal missing e.g.
// sampleSubjects is just as unusable as one with a malformed brandImagery. ──
const brandImageryProposalSchema = z.object({
  artifact: z.literal('brand_imagery_proposal.v1'),
  mode: z.enum(['house', 'template']),
  brandImagery: brandImagerySchema,
  rationale: z.string().min(1),
  sampleSubjects: z.array(z.string().min(1)).min(1).max(6),
  confidence: z.enum(['high', 'medium', 'low']),
  label: z.string().min(1).max(80),
  whenToUse: z.string().min(1).max(400).optional(),
});

const describeZodError = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');

// ─── unwrapping CMS-Agent's response envelope ──────────────────────────────
//
// REVIEW (brand-imagery wave): the OLD `node_execute` call did NOT hand back
// the node's output directly. CmsAgentClient.callTool already strips the MCP
// `{ok, data}` envelope, and what was left was nodeRuntime.ts's own return
// value — `{ execution: <WorkflowExecutionRecord>, executionId }`. The
// proposal itself lived on that record, in three equivalent places the
// runtime writes on a completed node (`nodes[].output`, `stageOutputs[nodeId]`,
// `artifacts[].value`). Parsing the envelope directly against the proposal
// schema therefore failed for EVERY real call — a 502
// `brand_imagery_propose_invalid_proposal` no fixture caught, because the
// test stub returned a bare proposal the wire never produces.
//
// D1 fix (task A2): the NEW `visual_identity_propose` tool this proxy calls
// now hands back `{ proposal, executionId, nodeId }` directly — no execution
// record to dig through (see `extractWriterProposal` below). All three
// node.execute shapes stay supported, additive, for an older deployment.
export const BRAND_IMAGERY_WRITER_NODE_ID = 'brand_imagery_writer';

const isBag = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const looksLikeProposal = (value: unknown): boolean =>
  isBag(value) && value.artifact === 'brand_imagery_proposal.v1';

/**
 * The node's own output off a `node.execute` result. Accepts a bare proposal
 * too (a future transport that unwraps for us, and the shape a hand-written
 * stub is most likely to use), so this is additive rather than a swap.
 * Returns the run's failure reasons instead when the node ran and failed.
 */
export const extractWriterProposal = (
  data: unknown
): { ok: true; proposal: unknown } | { ok: false; reason: string } => {
  if (looksLikeProposal(data)) return { ok: true, proposal: data };
  if (!isBag(data)) return { ok: false, reason: 'node_execute returned no object.' };

  // `visual_identity_propose`'s OWN envelope (D1 fix, task A2): once
  // CmsAgentClient.callTool strips the MCP {ok,data} wrapper, `executed.data`
  // for the new tool is `{ proposal, executionId, nodeId }` — the proposal is
  // handed back directly, no execution record to dig through. Checked BEFORE
  // the node.execute-record branches below (kept, additive, for an older
  // CMS-Agent deployment still answering the retired `node_execute` path).
  // Deliberately not gated behind `looksLikeProposal(data.proposal)`: an
  // unrecognized shape here is better reported by `brandImageryProposalSchema`
  // downstream (a precise per-field zod error) than swallowed into this
  // function's generic "no execution record" fallback.
  if ('proposal' in data && data.proposal !== undefined) return { ok: true, proposal: data.proposal };

  const execution = isBag(data.execution) ? data.execution : isBag(data.run) ? data.run : undefined;
  if (!execution) return { ok: false, reason: 'node_execute returned no execution record.' };

  const nodes = Array.isArray(execution.nodes) ? execution.nodes.filter(isBag) : [];
  const writerState = nodes.find((node) => node.nodeId === BRAND_IMAGERY_WRITER_NODE_ID) ?? nodes[0];

  if (writerState?.output !== undefined) return { ok: true, proposal: writerState.output };

  const stageOutputs = isBag(execution.stageOutputs) ? execution.stageOutputs : undefined;
  const staged = stageOutputs?.[BRAND_IMAGERY_WRITER_NODE_ID];
  if (staged !== undefined) return { ok: true, proposal: staged };

  const artifacts = Array.isArray(execution.artifacts) ? execution.artifacts.filter(isBag) : [];
  const artifact =
    artifacts.find((entry) => entry.type === 'brand_imagery_proposal.v1') ??
    artifacts.find((entry) => entry.nodeId === BRAND_IMAGERY_WRITER_NODE_ID);
  if (artifact?.value !== undefined) return { ok: true, proposal: artifact.value };

  // Nothing to read: say WHY, using the run's own recorded errors when it
  // failed, rather than reporting a schema mismatch against an absent body.
  const errors = [
    ...(Array.isArray(execution.errors) ? execution.errors : []),
    ...(Array.isArray(writerState?.errors) ? (writerState!.errors as unknown[]) : []),
  ]
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .slice(0, 5);
  const status = typeof execution.status === 'string' ? execution.status : 'unknown';
  return {
    ok: false,
    reason: errors.length > 0 ? `node run ${status}: ${errors.join('; ')}` : `node run ${status} produced no output.`,
  };
};

/**
 * Builds the exact `visual_identity_propose` tool-call ARGUMENTS (task A2's
 * contract) from a validated propose request — these are the top-level
 * `tools/call` params, not a nested `{nodeId, input}` wrapper the old
 * `node_execute` shape needed. `project_id` is deliberately snake_case: it
 * is what CMS-Agent's own endpoint reads to scope the call to the bearer's
 * project (`mcpEndpoint.ts#requestedProject` accepts either spelling, but
 * the contract names `project_id`). `kind` is sent explicitly rather than
 * relying on the tool's own "defaults to brand_imagery" — this proxy is
 * ONLY ever the brand-imagery producer, so leaving it implicit would be one
 * upstream default change away from silently reproposing the wrong kind.
 *
 * `references[]` is forwarded in its declared shape (blobKey|url/region/
 * note/weight) — untouched — so a later `visual_standard_materializer` gets
 * the moodboard verbatim; `imageRefs[]` is the resolved, model-visible view
 * (§3.9), additive alongside it.
 */
const buildVisualIdentityProposeArgs = (
  input: BrandImageryProposeInput,
  imageRefs: BrandImageryImageRef[]
): Record<string, unknown> => {
  const references = input.references ?? [];
  return {
    project_id: input.projectId,
    kind: 'brand_imagery',
    mode: input.mode,
    ...(toNonEmptyString(input.visualStandardId) ? { visualStandardId: input.visualStandardId } : {}),
    ...(references.length > 0 ? { references } : {}),
    ...(toNonEmptyString(input.brief) ? { brief: input.brief } : {}),
    ...(input.existingBrandImagery !== undefined ? { existingBrandImagery: input.existingBrandImagery } : {}),
    ...(toNonEmptyString(input.templateSlug) ? { templateSlug: input.templateSlug } : {}),
    ...(imageRefs.length > 0 ? { imageRefs } : {}),
  };
};

/**
 * D1 discriminator (task A2, item 3) — "the tool is not in this bearer's
 * allowlist" vs "the bearer token is bad". Verified against CMS-Agent's own
 * source before writing this, not guessed:
 *
 *  - Those two ARE byte-identical on the wire and genuinely cannot be told
 *    apart here. A site-scoped bearer calling a tool outside its allowlist
 *    and a bearer whose token is simply wrong/expired both fail
 *    `mcpEndpoint.ts`'s auth gate the exact same way — the exact same HTTP
 *    401 with the exact same body (`runtime/auth.ts`'s
 *    `unauthorizedResponse`: `{error:{code:"unauthorized",message:"Missing
 *    or invalid bearer token."}}`), regardless of which of the two is true.
 *    CmsAgentClient.callTool maps BOTH to `cms_agent_auth_failed` with no
 *    field left anywhere that distinguishes them (see its own `httpFailure`
 *    doc comment, which says exactly this). This proxy does NOT invent a
 *    split there — see the generic path below — because mislabeling a truly
 *    bad/expired credential as "tool not allowed" would send an operator
 *    chasing the wrong fix.
 *  - A tool name CMS-Agent's dispatcher does not recognize AT ALL — an
 *    older CMS-Agent deployment that predates `visual_identity_propose`, or
 *    a typo — IS genuinely distinguishable, and is the one case this
 *    function catches. `workspace/server.ts`'s `tools/call` handler throws
 *    a plain JSON-RPC error for that (`{code:-32602, message:"Unknown
 *    tool: <name>"}`) with no `data.error.code`, so `callTool` can't map it
 *    to any frozen wire code and falls back to `cms_agent_error` — but it
 *    DOES set `fromJsonBody: true` (a real parsed JSON-RPC error body,
 *    never a network/timeout/HTML-5xx guess: see `callTool`'s own comment
 *    on that field) with a message starting "Unknown tool:". That
 *    combination is the one real, checkable signal on the wire, so it is
 *    what this heuristic keys on — still a heuristic (the exact message
 *    text is not a frozen contract), which is why it stays this narrow
 *    rather than trying to generalize.
 */
const looksLikeUnknownToolFailure = (failure: { code?: string; message?: string; fromJsonBody?: boolean }): boolean =>
  failure.fromJsonBody === true && /^unknown tool:/i.test((failure.message ?? '').trim());

// ─── hydrating a revision from its named visual_standard (live-defect fix) ──

type StandardHydrationResult = {
  /** `input`, unchanged, or a shallow copy with `references`/`existingBrandImagery` filled in from the standard. */
  input: BrandImageryProposeInput;
  /**
   * True only once `deps.loadVisualStandard` actually ran to completion and
   * returned a defined record — i.e. we KNOW what the standard does or does
   * not carry. False when there was no `visualStandardId`, no loader wired,
   * or the loader threw/returned `undefined` ("no hydration available",
   * deps.loadVisualStandard's own contract) — in every one of those cases we
   * have no basis for saying the standard has no board, so the ordinary
   * generic-missing-input 400 is what fires below, not the standard-specific
   * one.
   */
  standardLookupSucceeded: boolean;
  /** True once hydration actually changed `references` and/or `existingBrandImagery` on the input handed to validation/CmsAgent. */
  hydratedFromStandard: boolean;
  /** Raw reference count found on the standard, before any cap truncation (0 when hydration didn't touch references). */
  referencesFromStandard: number;
  /** True when the standard's own references exceeded BRAND_IMAGERY_MAX_REFERENCES and were truncated to the cap (see the truncation-vs-refusal decision below). */
  referencesTruncated: boolean;
};

/**
 * Fills in `references` and `existingBrandImagery` from the named
 * visual_standard — ONLY the fields the caller did not already supply. A
 * caller-supplied board always wins outright and is never merged with the
 * standard's own (merging would silently double a mood board the model then
 * sees twice); a caller-supplied `existing_brand_imagery` wins the same way.
 * This is what turns "propose from scratch" into "revise this standard": the
 * standard's own current `brandImagery` becomes `existingBrandImagery` only
 * when the caller left it unset.
 *
 * Reference-cap decision (task requirement): a standard's OWN stored mood
 * board is trusted, already-persisted content — never a caller trying to
 * smuggle extra images past the node-runner's `imageRefs` cap (BRIEF §3.9) —
 * so a board that has grown past `BRAND_IMAGERY_MAX_REFERENCES` (e.g. the
 * cap shrank, or references accumulated over several revisions before the
 * cap applied) is TRUNCATED to the first N, never refused outright. Refusing
 * would turn "this standard's own board happens to be a little large" into a
 * hard failure the caller has no way to fix by supplying different input —
 * their only ask was "revise this standard". Truncation never happens
 * silently: it is reported in `referencesTruncated` / the caller's
 * `brand_imagery_proposed` log line.
 *
 * Never throws: a loader failure (reject) or an `undefined` resolution both
 * mean "no hydration available" and fall straight through to ordinary
 * validation, which then raises its own normal 400 if the caller supplied
 * nothing else — see `deps.loadVisualStandard`'s own doc comment.
 */
const hydrateFromVisualStandard = async (
  input: BrandImageryProposeInput,
  deps: BrandImageryProxyDeps
): Promise<StandardHydrationResult> => {
  const visualStandardId = toNonEmptyString(input.visualStandardId);
  const notHydrated: StandardHydrationResult = {
    input,
    standardLookupSucceeded: false,
    hydratedFromStandard: false,
    referencesFromStandard: 0,
    referencesTruncated: false,
  };
  if (!visualStandardId || !deps.loadVisualStandard) return notHydrated;

  let standard: { references?: BrandImageryReferenceInput[]; brandImagery?: unknown } | undefined;
  try {
    standard = await deps.loadVisualStandard(visualStandardId);
  } catch {
    return notHydrated;
  }
  if (!standard) return notHydrated;

  const callerHasReferences = Array.isArray(input.references) && input.references.length > 0;
  const callerHasExistingBrandImagery = input.existingBrandImagery !== undefined;

  const standardReferences = Array.isArray(standard.references) ? standard.references : [];
  const referencesFromStandard = standardReferences.length;

  let referencesTruncated = false;
  let hydratedReferences: BrandImageryReferenceInput[] | undefined;
  if (!callerHasReferences && standardReferences.length > 0) {
    if (standardReferences.length > BRAND_IMAGERY_MAX_REFERENCES) {
      hydratedReferences = standardReferences.slice(0, BRAND_IMAGERY_MAX_REFERENCES);
      referencesTruncated = true;
    } else {
      hydratedReferences = standardReferences;
    }
  }

  const hydratedExistingBrandImagery =
    !callerHasExistingBrandImagery && standard.brandImagery !== undefined ? standard.brandImagery : undefined;

  const hydratedFromStandard = hydratedReferences !== undefined || hydratedExistingBrandImagery !== undefined;

  return {
    input: hydratedFromStandard
      ? {
          ...input,
          ...(hydratedReferences !== undefined ? { references: hydratedReferences } : {}),
          ...(hydratedExistingBrandImagery !== undefined ? { existingBrandImagery: hydratedExistingBrandImagery } : {}),
        }
      : input,
    standardLookupSucceeded: true,
    hydratedFromStandard,
    referencesFromStandard,
    referencesTruncated,
  };
};

/**
 * The proxy's entire job: build the tool-call arguments, call
 * `visual_identity_propose`, validate what comes back, and return it. Makes
 * no model call itself, reads/writes no CMS object.
 */
export const proposeBrandImagery = async (
  input: BrandImageryProposeInput,
  deps: BrandImageryProxyDeps
): Promise<BrandImageryProxyResult> => {
  const hydration = await hydrateFromVisualStandard(input, deps);
  const hydratedInput = hydration.input;

  const invalid = validateBrandImageryProposeInput(hydratedInput);
  if (invalid) {
    // Sharpen the generic "requires at least one of references or brief"
    // refusal into one that names the REAL problem once we actually know it:
    // a visualStandardId was given, the loader ran and told us definitively
    // what that standard carries, and it carries neither references nor (of
    // course) a brief of its own to fall back on. `standardLookupSucceeded`
    // is what gates this — a missing/throwing loader means we DON'T know
    // that, and must leave the generic 400 alone (see
    // `hydrateFromVisualStandard`'s doc comment / task requirement 3).
    if (invalid.errorCode === 'brand_imagery_propose_missing_input' && hydration.standardLookupSucceeded) {
      return err(
        400,
        'brand_imagery_propose_standard_has_no_board',
        `visual_standard_id "${hydratedInput.visualStandardId}" carries no mood board (no references) and no existing brandImagery to revise. Supply references or a brief.`,
        { visualStandardId: hydratedInput.visualStandardId }
      );
    }
    return invalid;
  }

  const references = hydratedInput.references ?? [];
  const { imageRefs, unresolvedReferences } = await resolveImageRefs(references, deps);

  // A3: with requireResolvedImages, validation above only guarantees
  // references.length > 0 OR a brief was given (never both empty) — so
  // reaching here with zero RESOLVED images and no brief means every
  // reference on this board failed to read/crop. Refuse before spending a
  // CMS-Agent call on a proposal built from nothing, rather than silently
  // proceeding with an empty imageRefs[] the writer would never notice.
  if (deps.requireResolvedImages && imageRefs.length === 0 && !toNonEmptyString(hydratedInput.brief)) {
    return err(
      422,
      'no_images_reached_writer',
      `None of the ${references.length} reference image${references.length === 1 ? '' : 's'} on this mood board could be read, so nothing would reach the writer model. Add a brief, or fix the unreadable references.`,
      { referencesTotal: references.length, unresolvedReferences }
    );
  }

  const proposeArgs = buildVisualIdentityProposeArgs(hydratedInput, imageRefs);

  const executed = await deps.cmsAgent.callTool<Record<string, unknown>>('visual_identity_propose', proposeArgs);
  if (!executed.ok) {
    if (looksLikeUnknownToolFailure(executed)) {
      return err(
        502,
        'brand_imagery_propose_tool_not_allowed',
        `CMS-Agent does not recognize the visual_identity_propose tool (${executed.message}). This site's CMS-Agent deployment may predate it, or the tool name has changed.`,
        { upstreamCode: executed.code }
      );
    }
    return err(502, executed.code || 'cms_agent_error', executed.message);
  }

  const extracted = extractWriterProposal(executed.data);
  if (!extracted.ok) {
    return err(
      502,
      'brand_imagery_propose_node_failed',
      `CMS-Agent's brand_imagery_writer returned no proposal: ${extracted.reason}`,
      { reason: extracted.reason }
    );
  }

  const parsed = brandImageryProposalSchema.safeParse(extracted.proposal);
  if (!parsed.success) {
    return err(
      502,
      'brand_imagery_propose_invalid_proposal',
      `CMS-Agent returned an invalid brand_imagery_proposal.v1: ${describeZodError(parsed.error)}`,
      { reason: describeZodError(parsed.error) }
    );
  }

  // CMS-Agent's `visual_identity_propose` runs the site/voice prefetch itself and reports every read
  // that degraded (`site_prefetch_degraded:*`, `voice_prefetch_fallback:*`). Those warnings are the
  // difference between "the model saw the site's palette" and "the model was told the site declared
  // none" — a proposal built without them looks identical on the card and is not. Forwarded so the
  // approval card can say so; absent on an older CMS-Agent deploy, which is why it is optional.
  const upstreamWarnings = Array.isArray((executed.data as { warnings?: unknown })?.warnings)
    ? ((executed.data as { warnings: unknown[] }).warnings.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))
    : [];

  deps.log?.({
    event: 'brand_imagery_proposed',
    mode: hydratedInput.mode,
    referencesRequested: references.length,
    imageRefsResolved: imageRefs.length,
    ...(unresolvedReferences.length > 0 ? { unresolvedReferences } : {}),
    ...(upstreamWarnings.length > 0 ? { prefetchWarnings: upstreamWarnings } : {}),
    confidence: parsed.data.confidence,
    // Traceability for the live-defect fix: a thin `visual_standard_id`-only
    // call now silently becomes a full revision, so the log line is what
    // makes that visible after the fact.
    ...(hydration.hydratedFromStandard
      ? {
          hydratedFromStandard: true,
          referencesFromStandard: hydration.referencesFromStandard,
          ...(hydration.referencesTruncated ? { referencesFromStandardTruncated: true } : {}),
        }
      : {}),
  });

  return {
    ok: true,
    status: 200,
    body: {
      ...parsed.data,
      ...(unresolvedReferences.length > 0 ? { unresolvedReferences } : {}),
      ...(upstreamWarnings.length > 0 ? { prefetchWarnings: upstreamWarnings } : {}),
    },
  };
};
