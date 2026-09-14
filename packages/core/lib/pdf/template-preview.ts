/**
 * A8 Part 1 — honest, tenant/template/version-scoped PDF template previews.
 *
 * INVESTIGATION FIRST (see the A8 report for the full writeup). The existing template
 * validation path (`validate_pdf_template` / `get_pdf_template_validation`,
 * `pdf-tool-client.ts`'s `validatePlatformPdfTemplate` / `getPlatformPdfTemplateValidation`,
 * forwarded unchanged) is NOT a usable preview on its own:
 *
 *   - pdf-tool's validation-mode render (`netlify/lib/pdf-render/render.ts`, mode:"validation")
 *     deliberately runs WITHOUT the content quality gate ("validation renders serve
 *     deliberately worst-case sample data and would report noise" — that module's own
 *     comment) — so it can never report a leaked `{{token}}`, an `[object Object]`, or a
 *     missing image the way a real render does.
 *   - `pdf-template-validation-worker.ts` "Never writes artifacts" — the rendered bytes are
 *     thrown away, so there is nothing to open, nothing for a human to look at, and nothing a
 *     second tool (`inspect_pdf_artifact` / `verify_pdf_content`) could later inspect.
 *   - `preview_pdf_template` (the "Preview sample" chip) renders the template's OWN STORED
 *     sampleData (not caller-supplied fixtures — pdf-tool's documented input is
 *     `projectId, templateId, version`, no `data`), first page only, as a PNG. It cannot
 *     exercise long/short/empty/rich-text/RTL/image fixtures, and it cannot show page 2+.
 *   - The one tool that DOES run the full content quality gate over real rendered text
 *     (`inspect_pdf_artifact`, wrapped by this repo's `verify_pdf_content` /
 *     `pdf-content-inspection.ts`) only works on an artifact `create_agent_artifact_job`
 *     already produced — and that job requires a registered OWNER from a small fixed set
 *     (`content_item | page | section | site | visual_standard | product` —
 *     `artifact-index.ts`'s `ARTIFACT_REQUEST_OWNER_TYPES`). `pdf_template` is deliberately
 *     NOT in that set (`mcp-tool-handlers.ts`'s own comment on `callCreateAgentArtifactJob`:
 *     "A template sample belongs to no article and `pdf_template` is deliberately NOT in
 *     ARTIFACT_REQUEST_OWNER_TYPES... Registering the site as its owner would close this out
 *     ... Do not add a third [unowned] caller.").
 *
 * THE FIX, entirely inside this trusted bridge, inventing no fake content item and widening
 * no registry: register the SITE (an existing, already-valid owner type) as the owner of a
 * deterministic, template+version-scoped request id, then run a REAL final-mode render
 * (content quality gate included) through the SAME `create_agent_artifact_job` /
 * `get_agent_artifact_job_status` / `verify_pdf_content` machinery every other PDF caller
 * uses — reused UNCHANGED, exactly as `render_article_pdf` (`article-pdf-render.ts`) reuses
 * them for articles. This module is that composition for a template preview instead of an
 * article: build fixture render data → preflight it against the template's own
 * `renderDataSchema` (reusing `validate_pdf_render_data`'s pure checker, unchanged) → create
 * or reuse an idempotent job → poll it by its STORED job id → inspect the actual rendered
 * output (reusing `document-content-check.ts`'s pure verdict, unchanged) → report a receipt
 * that is only ever "verified" when a real, inspected render backs that word.
 *
 * PURE AND EFFECTS-INJECTED, exactly `article-pdf-render.ts`'s architecture: every I/O (owner
 * registration, job creation/poll, content inspection, the clock) is injected so this module's
 * decisions are testable with `node:test` and no live pdf-tool (repo test posture, BRIEF §4).
 * The real I/O binding composes existing, unmodified handlers
 * (`callCreateAgentArtifactJob`, `artifact_request_register_owner`, `callVerifyPdfContent`) —
 * see the A8 report for the exact wiring this module expects from its caller.
 */
import {
  checkRenderDataAgainstSchema,
  checkRenderDataAssets,
  type RenderDataSchemaError,
} from './render-data-schema-check.js';
import {
  evaluateDocumentContent,
  type DocumentContentInspection,
  type DocumentContentRequirement,
} from './document-content-check.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ─── fixtures ───────────────────────────────────────────────────────────────

/**
 * The six reusable, renderer-agnostic worst-case fixtures A8 requires. Each is a pure
 * transform of `derive_render_data_schema`'s own declared output (`sampleData`, `slots`,
 * `imageSlots` — reused, not re-derived) so a fixture works for ANY template, not one
 * hand-authored shape.
 */
export const TEMPLATE_PREVIEW_FIXTURE_IDS = ['long', 'short', 'empty', 'rich_text', 'rtl', 'images'] as const;
export type TemplatePreviewFixtureId = (typeof TEMPLATE_PREVIEW_FIXTURE_IDS)[number];

export const TEMPLATE_PREVIEW_FIXTURE_LABELS: Record<TemplatePreviewFixtureId, string> = {
  long: 'Long content (worst-case multi-page)',
  short: 'Short content (near-empty prose)',
  empty: 'Empty optional fields',
  rich_text: 'Rich text (formatting-shaped content)',
  rtl: 'Right-to-left script',
  images: 'Image slots',
};

/** The shape of `derive_render_data_schema`'s response this module reads. Every field is
 *  optional and read defensively: a template that declares none of this still gets a fixture
 *  (an empty-object one), never a crash. */
export type DerivedTemplateSchema = {
  renderDataSchema?: unknown;
  sampleData?: Record<string, unknown>;
  sampleAssets?: { images?: Array<{ assetId: string; blobKey?: string; width?: number; height?: number }> };
  slots?: string[];
  imageSlots?: string[];
};

export type TemplatePreviewFixture = {
  id: TemplatePreviewFixtureId;
  label: string;
  data: Record<string, unknown>;
  assets?: { images?: Array<{ assetId: string; blobKey?: string }> };
  /** True for the `images` fixture when the template declares image slots but this fixture
   *  deliberately supplies NO matching asset, to exercise "missing images fail the check". */
  deliberatelyMissingAssets?: boolean;
};

/** Deep-maps every string leaf of a JSON-shaped value through `fn`, preserving structure.
 *  Total: never throws on a shape it does not recognize, and arrays/objects/primitives other
 *  than string pass through untouched. */
export function mapStringLeaves(value: unknown, fn: (leaf: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((entry) => mapStringLeaves(entry, fn));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = mapStringLeaves(child, fn);
    return out;
  }
  return value;
}

const REPEAT_TARGET_CHARS = 2400;
const repeatToLength = (seed: string, targetChars: number): string => {
  const base = seed.trim().length > 0 ? seed.trim() : 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
  let out = base;
  while (out.length < targetChars) out += ` ${base}`;
  return out.slice(0, targetChars);
};

const RICH_TEXT_WRAP = (seed: string): string =>
  `<strong>${seed || 'Preview'}</strong> with **markdown emphasis**, a [link](https://example.com/preview) ` +
  `and a raw <em>tag</em> — content an editor pasted from a rich-text source, not markup this fixture expects ` +
  `the template to interpret.`;

const RTL_SAMPLE =
  'معاينة تجريبية من اليمين إلى اليسار: هذا نص عربي طويل بما يكفي لاختبار محاذاة الفقرة والانعكاس الاتجاهي.';

/** `sampleData` reduced to its bare skeleton — every string leaf empty, every array leaf
 *  emptied — so optional fields genuinely have nothing in them rather than the template's own
 *  placeholder prose. Required fields the template cannot render without are left to the
 *  template/schema's own validation to name (see `preflightTemplatePreviewFixture`). */
const emptyLeaves = (value: unknown): unknown => {
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) return [];
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = emptyLeaves(child);
    return out;
  }
  return value;
};

/** Builds one fixture. `derived` is `derive_render_data_schema`'s response for this exact
 *  template — pass the same object to every fixture id so all six exercise the same template
 *  contract. */
export function buildTemplatePreviewFixture(
  id: TemplatePreviewFixtureId,
  derived: DerivedTemplateSchema
): TemplatePreviewFixture {
  const label = TEMPLATE_PREVIEW_FIXTURE_LABELS[id];
  const base = isRecord(derived.sampleData) ? derived.sampleData : {};

  switch (id) {
    case 'long':
      return {
        id,
        label,
        data: mapStringLeaves(base, (leaf) => repeatToLength(leaf, REPEAT_TARGET_CHARS)) as Record<string, unknown>,
      };
    case 'short':
      return {
        id,
        label,
        data: mapStringLeaves(base, (leaf) => leaf.trim().slice(0, 12) || 'Hi') as Record<string, unknown>,
      };
    case 'empty':
      return { id, label, data: emptyLeaves(base) as Record<string, unknown> };
    case 'rich_text':
      return { id, label, data: mapStringLeaves(base, RICH_TEXT_WRAP) as Record<string, unknown> };
    case 'rtl':
      return { id, label, data: mapStringLeaves(base, () => RTL_SAMPLE) as Record<string, unknown> };
    case 'images': {
      const declaredImages = derived.sampleAssets?.images ?? [];
      if (declaredImages.length === 0) {
        return { id, label, data: base, assets: { images: [] }, deliberatelyMissingAssets: false };
      }
      return {
        id,
        label,
        data: base,
        assets: {
          images: declaredImages.map((image) => ({
            assetId: image.assetId,
            ...(image.blobKey ? { blobKey: image.blobKey } : {}),
          })),
        },
      };
    }
  }
}

/** All six fixtures for one template, in the fixed `TEMPLATE_PREVIEW_FIXTURE_IDS` order. */
export function buildTemplatePreviewFixtures(derived: DerivedTemplateSchema): TemplatePreviewFixture[] {
  return TEMPLATE_PREVIEW_FIXTURE_IDS.map((id) => buildTemplatePreviewFixture(id, derived));
}

// ─── deterministic ids (tenant + template + version scope) ─────────────────

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'x';

/** One request id per (template, version) — NOT per fixture, mirroring how
 *  `render_article_pdf` reuses one `request_id` (the content item) across many jobs. Multiple
 *  fixture renders for the same template version share this id and its one registered owner. */
export function templatePreviewRequestId(templateId: string, version: number): string {
  return `pdf_preview_${slugify(templateId)}_v${version}`;
}

/** Small, non-cryptographic, deterministic hash (FNV-1a) of a stably-stringified JSON value —
 *  enough for an idempotency cache key, not a security boundary. Keeps this module free of a
 *  `node:crypto` dependency, matching `article-pdf-render.ts`'s own zero-Node-API posture. */
export function stableJsonHash(value: unknown): string {
  const stringify = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(stringify).join(',')}]`;
    if (isRecord(input)) {
      const keys = Object.keys(input).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${stringify(input[key])}`).join(',')}}`;
    }
    return JSON.stringify(input);
  };
  const text = stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Idempotency key for one fixture render of one template version. The SAME fixture data for
 *  the SAME template version always produces the SAME key, which is what makes job reuse
 *  (never re-rendering an unchanged fixture) possible — see `runTemplatePreviewFixture`. */
export function templatePreviewJobKey(
  templateId: string,
  version: number,
  fixtureId: TemplatePreviewFixtureId,
  data: unknown
): string {
  return `${templatePreviewRequestId(templateId, version)}:${fixtureId}:${stableJsonHash(data)}`;
}

// ─── preflight (reuses validate_pdf_render_data's pure checker, unchanged) ─

export type TemplatePreviewPreflight =
  | { ok: true }
  | { ok: false; errors: RenderDataSchemaError[]; missingAssetIds: string[] };

/** The same dry check `validate_pdf_render_data` runs — reused unchanged — applied to a
 *  fixture before spending a render on it. A fixture that fails this never reaches
 *  `createJob`: the receipt names the schema/asset problem directly rather than paying for a
 *  render that W1 would reject anyway (`RENDER_DATA_INVALID` / `ASSET_MISSING`). */
export function preflightTemplatePreviewFixture(
  fixture: TemplatePreviewFixture,
  renderDataSchema: unknown
): TemplatePreviewPreflight {
  if (renderDataSchema === undefined) return { ok: true };
  const check = checkRenderDataAgainstSchema(renderDataSchema, fixture.data);
  const assetCheck = checkRenderDataAssets(check.assetRefs, fixture.assets);
  if (check.valid && assetCheck.missingAssetIds.length === 0) return { ok: true };
  return { ok: false, errors: check.errors, missingAssetIds: assetCheck.missingAssetIds };
}

// ─── the job, as this module reads it ──────────────────────────────────────

export type TemplatePreviewJobStatus = 'pending' | 'complete' | 'failed';

export type TemplatePreviewJobView = {
  jobId: string;
  status: TemplatePreviewJobStatus;
  publicPath?: string;
  pageCount?: number;
  sizeBytes?: number;
  error?: { code?: string; message: string };
};

const IN_FLIGHT = new Set(['pending', 'queued', 'running', 'blocked', 'awaiting_approval']);
const FAILED_WORDS = new Set(['failed', 'error', 'cancelled', 'canceled']);

/** Mirrors `article-pdf-render.ts`'s `normalizeArticlePdfJobStatus` exactly (same bias toward
 *  "in flight" for an unrecognized word) — duplicated rather than imported so this module never
 *  depends on the article-specific module's unrelated exports; the two are kept in lockstep by
 *  the shared contract test in `template-preview.test.ts`. */
export const normalizeTemplatePreviewJobStatus = (value: unknown): TemplatePreviewJobStatus => {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!status) return 'pending';
  if (status === 'complete' || status === 'completed' || status === 'succeeded') return 'complete';
  if (FAILED_WORDS.has(status)) return 'failed';
  if (IN_FLIGHT.has(status)) return 'pending';
  return 'pending';
};

// ─── content verdict (reuses document-content-check.ts's pure verdict) ────

export type TemplatePreviewContentVerdict =
  | { status: 'ok'; pageCount: number; sizeBytes: number }
  | { status: 'failed'; reason: string; findings: DocumentContentInspection['qualityGate']['findings'] }
  | { status: 'unverified'; reason: string };

/** Wraps `document-content-check.ts`'s `evaluateDocumentContent` (reused, unchanged) with the
 *  "could this even be inspected at all" outcome `verify_pdf_content` / `inspect_pdf_artifact`
 *  can fail with independently of the document's own content — an artifact this module cannot
 *  fetch or parse NEVER becomes a pass by default; it stays `unverified`. */
export function evaluateTemplatePreviewContent(
  fetched: { ok: true; inspection: DocumentContentInspection } | { ok: false; reason: string },
  requirement: DocumentContentRequirement = {}
): TemplatePreviewContentVerdict {
  if (!fetched.ok) return { status: 'unverified', reason: fetched.reason };
  const verdict = evaluateDocumentContent(fetched.inspection, requirement);
  if (verdict.ok) return { status: 'ok', pageCount: verdict.pageCount, sizeBytes: verdict.sizeBytes };
  return { status: 'failed', reason: verdict.reason, findings: verdict.findings };
}

// ─── effects ────────────────────────────────────────────────────────────────

export type TemplatePreviewEffectResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message: string } };

export type TemplatePreviewEffects = {
  /** Registers the SITE as the owner of this preview's request id
   *  (`artifact_request_register_owner`, reused unchanged) — idempotent: re-registering the
   *  same owner is a no-op. Never registers a content item. Called once per request id, before
   *  the first job for it. */
  ensureOwnerRegistered: (requestId: string) => Promise<TemplatePreviewEffectResult<true>>;
  /** The idempotency cache: a job already created for this exact
   *  (template, version, fixture, data) key. */
  getCachedJob: (jobKey: string) => Promise<{ jobId: string } | undefined>;
  setCachedJob: (jobKey: string, value: { jobId: string }) => Promise<void>;
  /** Creates the job through the SAME `create_agent_artifact_job` every other PDF caller
   *  uses (final mode — the content quality gate runs), owned by the registered request id. */
  createJob: (input: {
    requestId: string;
    templateId: string;
    version?: number;
    data: Record<string, unknown>;
    assets?: { images?: unknown[] };
  }) => Promise<TemplatePreviewEffectResult<TemplatePreviewJobView>>;
  /** One status poll, through the SAME status bridge every other caller uses. */
  pollJob: (jobId: string) => Promise<TemplatePreviewEffectResult<TemplatePreviewJobView>>;
  /** Fetches and inspects the completed artifact's actual rendered content — the SAME check
   *  `verify_pdf_content` runs, reused unchanged. Never called for a job that did not
   *  complete with a public path: there is nothing to inspect yet. */
  inspectContent: (input: {
    siteId: string;
    publicPath: string;
  }) => Promise<{ ok: true; inspection: DocumentContentInspection } | { ok: false; reason: string }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log?: (entry: Record<string, unknown>) => void;
};

export type TemplatePreviewParams = {
  siteId: string;
  templateId: string;
  version: number;
  fixture: TemplatePreviewFixture;
  /** The template's own `renderDataSchema`, when known — passed straight to
   *  `preflightTemplatePreviewFixture`; omit to skip the pre-render check. */
  renderDataSchema?: unknown;
  requirement?: DocumentContentRequirement;
  pollBudgetMs: number;
  pollIntervalMs?: number;
  polling?: { tool: string; input: Record<string, unknown> };
};

export const TEMPLATE_PREVIEW_POLL_INTERVAL_MS = 1_000;

export type TemplatePreviewReceipt = {
  siteId: string;
  templateId: string;
  version: number;
  fixtureId: TemplatePreviewFixtureId;
  requestId: string;
  jobId?: string;
  status: TemplatePreviewJobStatus | 'invalid_fixture';
  /** True when an existing completed/in-flight job for this exact fixture was reused instead
   *  of starting a new render — the idempotency guarantee A8 asks for. */
  reused: boolean;
  rendered: boolean;
  public_path?: string;
  pageCount?: number;
  contentCheck?: TemplatePreviewContentVerdict;
  /** True ONLY when a real render completed AND its actual rendered output was inspected and
   *  found clean — never inferred from job status alone. */
  verified: boolean;
  preflight?: TemplatePreviewPreflight;
  error?: { code?: string; message: string };
  polling?: { tool: string; input: Record<string, unknown> };
  summary: string;
};

const summarize = (receipt: Omit<TemplatePreviewReceipt, 'summary'>): string => {
  if (receipt.status === 'invalid_fixture') {
    return `The "${receipt.fixtureId}" fixture did not satisfy template ${receipt.templateId}'s own render-data contract before any render was attempted — see preflight.`;
  }
  if (receipt.status === 'failed') {
    const code = receipt.error?.code ? ` (${receipt.error.code})` : '';
    return `The "${receipt.fixtureId}" preview render failed${code}. ${receipt.error?.message ?? ''}`.trim();
  }
  if (receipt.status === 'pending') {
    return `Still rendering. Job ${receipt.jobId} was created and has not finished — poll it by this stored id; nothing is claimed yet.`;
  }
  if (!receipt.contentCheck) {
    return `Rendered${receipt.pageCount ? ` (${receipt.pageCount} pages)` : ''} but its content was not inspected — unverified.`;
  }
  if (receipt.contentCheck.status === 'unverified') {
    return `Rendered${receipt.pageCount ? ` (${receipt.pageCount} pages)` : ''} but the output could not be inspected (${receipt.contentCheck.reason}) — this preview stays UNVERIFIED, not passed.`;
  }
  if (receipt.contentCheck.status === 'failed') {
    return `Rendered${receipt.pageCount ? ` (${receipt.pageCount} pages)` : ''} but FAILED content inspection: ${receipt.contentCheck.reason}`;
  }
  return `Rendered and verified (${receipt.contentCheck.pageCount} pages, ${receipt.contentCheck.sizeBytes} bytes). Open public_path to view it.`;
};

const buildReceipt = (input: Omit<TemplatePreviewReceipt, 'summary'>): TemplatePreviewReceipt => ({
  ...input,
  summary: summarize(input),
});

/** True only for a receipt this module can actually stand behind: a real completed render
 *  whose own output was inspected and reported clean. Every other state — pending, failed,
 *  invalid_fixture, or a content check that came back `unverified` — is false, never a guess. */
export const templatePreviewPassed = (receipt: TemplatePreviewReceipt): boolean =>
  receipt.status === 'complete' && receipt.contentCheck?.status === 'ok';

/**
 * The orchestrator: preflight → ensure owner → create-or-reuse job → poll to a terminal
 * status or the budget → inspect real output → receipt. Mirrors `renderArticlePdf`'s shape
 * exactly (same termination discipline: the poll loop always ends, either at a terminal
 * status or at the budget, and a budget-exhausted receipt says `pending` with the job id —
 * never a claimed result it does not have).
 */
export async function runTemplatePreviewFixture(
  params: TemplatePreviewParams,
  effects: TemplatePreviewEffects
): Promise<{ ok: true; receipt: TemplatePreviewReceipt } | { ok: false; error: { code?: string; message: string } }> {
  const requestId = templatePreviewRequestId(params.templateId, params.version);
  const base = {
    siteId: params.siteId,
    templateId: params.templateId,
    version: params.version,
    fixtureId: params.fixture.id,
    requestId,
    ...(params.polling ? { polling: params.polling } : {}),
  };

  const preflight = preflightTemplatePreviewFixture(params.fixture, params.renderDataSchema);
  if (!preflight.ok) {
    return {
      ok: true,
      receipt: buildReceipt({
        ...base,
        status: 'invalid_fixture',
        reused: false,
        rendered: false,
        verified: false,
        preflight,
      }),
    };
  }

  const owned = await effects.ensureOwnerRegistered(requestId);
  if (!owned.ok) return { ok: false, error: owned.error };

  const jobKey = templatePreviewJobKey(params.templateId, params.version, params.fixture.id, params.fixture.data);
  const cached = await effects.getCachedJob(jobKey);

  let job: TemplatePreviewJobView;
  let reused = false;
  if (cached) {
    const polled = await effects.pollJob(cached.jobId);
    if (polled.ok) {
      job = polled.value;
      reused = true;
    } else {
      effects.log?.({ event: 'template_preview_cached_job_unreadable', jobKey, detail: polled.error.message });
      const created = await effects.createJob({
        requestId,
        templateId: params.templateId,
        version: params.version,
        data: params.fixture.data,
        ...(params.fixture.assets ? { assets: params.fixture.assets } : {}),
      });
      if (!created.ok) return { ok: false, error: created.error };
      job = created.value;
      await effects.setCachedJob(jobKey, { jobId: job.jobId });
    }
  } else {
    const created = await effects.createJob({
      requestId,
      templateId: params.templateId,
      version: params.version,
      data: params.fixture.data,
      ...(params.fixture.assets ? { assets: params.fixture.assets } : {}),
    });
    if (!created.ok) return { ok: false, error: created.error };
    job = created.value;
    await effects.setCachedJob(jobKey, { jobId: job.jobId });
  }

  const interval = params.pollIntervalMs ?? TEMPLATE_PREVIEW_POLL_INTERVAL_MS;
  const deadline = effects.now() + params.pollBudgetMs;
  while (job.status === 'pending' && effects.now() < deadline) {
    const remaining = deadline - effects.now();
    await effects.sleep(Math.min(interval, remaining));
    const polled = await effects.pollJob(job.jobId);
    if (!polled.ok) {
      effects.log?.({ event: 'template_preview_poll_failed', jobId: job.jobId, detail: polled.error.message });
      continue;
    }
    job = polled.value;
  }

  let contentCheck: TemplatePreviewContentVerdict | undefined;
  if (job.status === 'complete' && job.publicPath) {
    const fetched = await effects.inspectContent({ siteId: params.siteId, publicPath: job.publicPath });
    contentCheck = evaluateTemplatePreviewContent(fetched, params.requirement);
  }

  const receipt = buildReceipt({
    ...base,
    jobId: job.jobId,
    status: job.status,
    reused,
    rendered: job.status === 'complete',
    ...(job.status === 'complete' && job.publicPath ? { public_path: job.publicPath } : {}),
    ...(job.pageCount !== undefined ? { pageCount: job.pageCount } : {}),
    ...(contentCheck ? { contentCheck } : {}),
    verified: job.status === 'complete' && contentCheck?.status === 'ok',
    preflight,
    ...(job.error ? { error: job.error } : {}),
  });
  effects.log?.({
    event: 'template_preview_settled',
    requestId,
    fixtureId: params.fixture.id,
    status: job.status,
    reused,
    verified: receipt.verified,
  });
  return { ok: true, receipt };
}
