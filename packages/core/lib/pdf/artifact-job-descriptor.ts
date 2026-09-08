/**
 * S1/Task B — the pdf-tool PROJECT DESCRIPTOR this bridge sends with every
 * image artifact job, and the "you omitted usageContext" warning that makes
 * the omission visible.
 *
 * THE DEFECT THIS CLOSES. pdf-tool's `create_agent_artifact_job` accepts an
 * optional `descriptor` ({projectId, defaultModel?, allowedModels?, …}) whose
 * `defaultModel` is, in pdf-tool's own words, "Model used when a job omits
 * `model`; defaults to gpt-image-1". Platform's bridge never sent a
 * descriptor at all (pdf-tool-client.ts's createPlatformArtifactJob forwarded
 * projectId + storage and nothing else), so any image job whose
 * `requirements.image.usageContext` was absent fell through pdf-tool's
 * per-context routing table onto that gpt-image-1 fallback and ran on the
 * `openai-image` executor. Observed live on site_platform 2026-09-08 (job
 * 34d35aab-9eb3-435b-a2b2-a58688c6e675: selectedModel "gpt-image-1",
 * costEstimate.provider "openai", executor "openai-image") on a site whose
 * image-model policy routes every declared context to
 * "fal-ai/flux-2/klein/9b". It billed OpenAI and surfaced OpenAI's own
 * "429 no credits" — a balance message about an account this pipeline is not
 * supposed to be spending from at all.
 *
 * WOLF'S RULING (2026-09-08): FAL is the default. A job must never land on
 * OpenAI by omission. So the bridge states the default explicitly rather than
 * inheriting pdf-tool's — and it states it from the SITE'S OWN configured
 * policy, read at call time (`get_image_model_policy`), never from a model id
 * hardcoded here. When the site re-points its policy at another FAL model,
 * this default follows it with no code change.
 *
 * WHY article_body IS THE MODEL A CONTEXTLESS JOB INHERITS. Platform already
 * coerces every unrecognised usageContext to `article_body`
 * (brand-imagery-resolve.ts's resolveUsageContext / DEFAULT_USAGE_CONTEXT),
 * so article_body's model is by construction "what a job with nothing usable
 * in usageContext should route to". Repeating the literal here rather than
 * importing it keeps this module free of a packages/core/lib →
 * packages/core/server dependency; the two are asserted equal by this
 * module's test.
 *
 * PURE. No I/O: the caller fetches the policy and hands the body in. The
 * bridge remains the only thing that talks to pdf-tool.
 */

/** The usageContext whose configured model a contextless job inherits. */
export const DESCRIPTOR_FALLBACK_USAGE_CONTEXT = 'article_body';

/**
 * Warning code reported on the job response when an image job omitted
 * `requirements.image.usageContext`. A warning, never an error — the call
 * still succeeds and (with the descriptor below) still routes to FAL; this
 * only makes the omission visible so a caller learns to name the context and
 * gets the per-context model it actually wanted.
 */
export const USAGE_CONTEXT_MISSING_WARNING = 'usageContext_missing';

/**
 * Warning code reported when this bridge could not name a default model at
 * all — because the policy could not be read, or because the policy it read
 * names no model anywhere. Both land in the same place and are the same fact
 * to the caller: no descriptor was sent, so PDF-TOOL'S OWN fallback decides
 * the model for a job that omits one, and on today's pdf-tool that fallback
 * is gpt-image-1. The job is NOT failed for it — a policy that is empty or
 * briefly unreadable is not the caller's fault, and failing job creation on
 * it is a worse outcome than a job that ran — but it is exactly the condition
 * that produced the OpenAI bill, so it is never silent.
 */
export const MODEL_DEFAULT_UNRESOLVED_WARNING = 'image_model_default_unresolved';

/** The subset of pdf-tool's `descriptor` this bridge sets. */
export interface ArtifactJobDescriptor {
  projectId: string;
  defaultModel: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * The model id a job that names no usageContext should run on, read out of
 * `get_image_model_policy`'s response body:
 *
 *   1. `policy.defaultModel` — an explicit site-level default, if the policy
 *      shape ever grows one. Nothing sets it today; honouring it first means
 *      a site that later declares one is obeyed without touching this code.
 *   2. `policy.byUsageContext.article_body.model` — the honest default, see
 *      this module's header.
 *   3. the first entry of `contexts[]` that has a model — so a site whose
 *      policy simply does not declare article_body still gets one of ITS OWN
 *      models rather than pdf-tool's OpenAI fallback.
 *   4. failing all of that, the first `byUsageContext` entry with a model.
 *
 * Returns undefined only when the policy names no model anywhere — the
 * caller's cue to send no descriptor and warn.
 */
export const resolvePolicyDefaultImageModel = (policyBody: unknown): string | undefined => {
  if (!isRecord(policyBody)) return undefined;
  const policy = isRecord(policyBody.policy) ? policyBody.policy : undefined;

  const explicitDefault = toNonEmptyString(policy?.defaultModel);
  if (explicitDefault) return explicitDefault;

  const byUsageContext = isRecord(policy?.byUsageContext) ? policy.byUsageContext : undefined;
  const modelForContext = (context: string): string | undefined => {
    const entry = byUsageContext?.[context];
    return isRecord(entry) ? toNonEmptyString(entry.model) : undefined;
  };

  const fallbackContextModel = modelForContext(DESCRIPTOR_FALLBACK_USAGE_CONTEXT);
  if (fallbackContextModel) return fallbackContextModel;

  const declaredContexts = Array.isArray(policyBody.contexts)
    ? policyBody.contexts.filter((c): c is string => typeof c === 'string')
    : [];
  for (const context of declaredContexts) {
    const model = modelForContext(context);
    if (model) return model;
  }

  for (const entry of Object.values(byUsageContext ?? {})) {
    const model = isRecord(entry) ? toNonEmptyString(entry.model) : undefined;
    if (model) return model;
  }

  return undefined;
};

/**
 * Builds the descriptor to send with an image job. pdf-tool requires the
 * descriptor's `projectId` to match the request's projectId AND the grant's
 * projectId, so it is taken from the grant the bridge already minted and
 * never from caller input.
 *
 * Returns undefined when either half is unusable — a descriptor with no
 * defaultModel would tell pdf-tool nothing it does not already assume, and a
 * descriptor whose projectId disagreed with the grant would be rejected
 * outright, turning a routing bug into a failed job.
 */
export const buildArtifactJobDescriptor = (args: {
  projectId: string | undefined;
  policyBody: unknown;
}): ArtifactJobDescriptor | undefined => {
  const projectId = toNonEmptyString(args.projectId);
  if (!projectId) return undefined;
  const defaultModel = resolvePolicyDefaultImageModel(args.policyBody);
  if (!defaultModel) return undefined;
  return { projectId, defaultModel };
};

/**
 * True when an image job carries no usable `requirements.image.usageContext`
 * — the condition that used to route silently to OpenAI. Takes the
 * requirements object the bridge is about to forward (i.e. AFTER Platform's
 * own size/context patching), so a context Platform itself supplied is not
 * reported as missing.
 */
export const isUsageContextMissing = (requirements: unknown): boolean => {
  if (!isRecord(requirements)) return true;
  const image = isRecord(requirements.image) ? requirements.image : undefined;
  return toNonEmptyString(image?.usageContext) === undefined;
};

/**
 * The warnings an image job's response should carry about routing, appended
 * to whatever warnings Platform already computed. Order is stable so tests
 * and callers can assert on it.
 */
export const resolveRoutingWarnings = (args: {
  requirements: unknown;
  descriptor: ArtifactJobDescriptor | undefined;
}): string[] => {
  const warnings: string[] = [];
  if (isUsageContextMissing(args.requirements)) warnings.push(USAGE_CONTEXT_MISSING_WARNING);
  if (!args.descriptor) warnings.push(MODEL_DEFAULT_UNRESOLVED_WARNING);
  return warnings;
};
