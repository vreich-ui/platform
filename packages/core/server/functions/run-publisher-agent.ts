import { PLATFORM_ENV_NAMES, readBoundEnv, type SiteBinding } from '../lib/site-binding.js';
import { getHeader, type LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent, type AdminAccessState } from '../lib/request-roles.js';
import { uploadImagesWithIntegrity, type UploadableImage } from '../lib/publisher-artifact-upload-client.js';
import { requireArtifactReferenceArray, type ArtifactReference } from '../lib/artifacts.js';
import { articleBodyV1Schema, type ArticleBodyNode } from '../../schema/article-content-v1.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import { getArtifactIndexBlobStore, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { getGovernanceBlobStore, resolveActivePolicies } from '../lib/governance-store.js';
import type { ArtifactIndexStore } from '../lib/artifact-index.js';
import { handleObjectVerb, type ObjectVerbStore } from '../lib/object-verbs.js';
import { buildStoreValidationContext } from '../lib/object-validation-context.js';
import type { Principal } from '../../schema/object-record-v1.js';
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

/**
 * Netlify environment required by this server-side Agent SDK runner:
 * - OPENAI_API_KEY: used by the OpenAI Agents SDK.
 * - PUBLISH_SECRET (or NETLIFY_PUBLISH_SECRET): accepted as x-publish-key on
 *   this function itself (the agent/scripted caller path).
 *
 * T9.22 (closes W7.5): the workflow's FINAL STAGE targets the object
 * substrate — create content_item → nodes (strategy annotations preserved
 * verbatim into private.*) → taxonomy from the payload → validate → publish
 * under the existing gate, all via handleObjectVerb. The legacy markdown
 * publish-article endpoint receives ZERO writes from this flow; release is
 * NOT auto-fired (batch-publish, release-once discipline). publish-article.ts
 * and admin-workflow-lock.ts stay byte-untouched (off-limits).
 */

type LambdaEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
};

type PublisherRequest = {
  action?: unknown;
  articleIdea?: unknown;
  images?: unknown;
  artifactReferences?: unknown;
  requestId?: unknown;
  request_id?: unknown;
  markdown?: unknown;
  overwrite?: unknown;
  publishedDate?: unknown;
  slug?: unknown;
  title?: unknown;
};

type NormalizedPublisherRequest = {
  images: UploadableImage[];
  artifactReferences: ArtifactReference[];
  requestId?: string;
  markdown: string;
  overwrite: boolean;
  slug: string;
  title: string;
};

type PublishEndpointResult = {
  articlePath?: unknown;
  commit?: unknown;
  deployStatus?: unknown;
  imagePaths?: unknown;
  media?: unknown;
  message?: unknown;
  ok?: unknown;
  path?: unknown;
  success?: unknown;
  [key: string]: unknown;
};

type PublishToolResult = PublishEndpointResult & {
  error?: unknown;
  statusCode?: unknown;
  payload: {
    articlePath: string;
    commitMessage: string;
    imageCount: number;
    overwrite: boolean;
    slug: string;
  };
};

const publishImageSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    repoPath: z.string().trim().min(1).optional(),
    type: z.string().trim().min(1).optional(),
    encoding: z.string().trim().min(1).optional(),
    base64: z.string().trim().min(1).optional(),
    content: z.string().trim().min(1).optional(),
  })
  .strict();

const publishToolInputSchema = z
  .object({
    slug: z.string().trim().min(1),
    title: z.string().trim().min(1),
    markdown: z.string().trim().min(1).optional(),
    content: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    publishDate: z.string().trim().min(1).optional(),
    author: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    images: z.array(publishImageSchema).optional(),
    artifactReferences: z.array(z.unknown()).optional(),
    article_body: articleBodyV1Schema.optional(),
    overwrite: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.markdown && !value.content) {
      ctx.addIssue({
        code: 'custom',
        message: 'Either markdown or content is required.',
        path: ['markdown'],
      });
    }
  });

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

class RunnerError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'RunnerError';
    this.statusCode = statusCode;
  }
}

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: jsonHeaders,
  body: JSON.stringify(body),
});

/** S1 auth-dedupe: resolves the admin session ONCE (full role resolution via
 *  resolveAdminAccessFromEvent, not the shallow ADMIN_EMAILS-only check) and
 *  returns either the 401/403 response to send verbatim, or the resolved
 *  state for the caller to build a Principal from — avoids re-reading the
 *  users store a second time for the same request. */
const verifyAdminSession = async (
  event: LambdaEvent,
  context?: LambdaContext,
  binding?: SiteBinding
): Promise<{ error: ReturnType<typeof jsonResponse> } | { error?: undefined; adminState: AdminAccessState }> => {
  const adminState = await resolveAdminAccessFromEvent(event, context, binding);

  if (!adminState.authenticated) {
    return {
      error: jsonResponse(401, {
        status: 'error',
        success: false,
        error: adminState.error || 'Authentication is required to run the publisher agent.',
      }),
    };
  }

  if (!adminState.isAdmin) {
    return {
      error: jsonResponse(403, {
        status: 'error',
        success: false,
        error: 'This user is not authorized to run the publisher agent.',
      }),
    };
  }

  return { adminState };
};

/** Authorize, and derive the acting Principal for object-history attribution:
 *  the publish key acts as the workflow agent; an admin session acts as the
 *  signed-in human. */
const verifyRequestAuthorization = async (
  event: LambdaEvent,
  context?: LambdaContext,
  binding?: SiteBinding
): Promise<{ error?: ReturnType<typeof jsonResponse>; principal?: Principal }> => {
  const publishKey = getHeader(event.headers, 'x-publish-key').trim();

  if (publishKey) {
    const publishSecret = readBoundEnv(PLATFORM_ENV_NAMES.publishSecret);

    if (publishSecret && publishKey === publishSecret) {
      return { principal: { kind: 'agent', agent_name: 'publisher-workflow', auth: 'publish_key' } };
    }

    return {
      error: jsonResponse(403, {
        status: 'error',
        success: false,
        error: 'Invalid publish key.',
      }),
    };
  }

  const session = await verifyAdminSession(event, context, binding);
  if (session.error) return { error: session.error };
  const { adminState } = session;
  return {
    principal: { kind: 'human', id: adminState.userId ?? '', email: adminState.email ?? '' },
  };
};

const toStringValue = (value: unknown) => {
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toBooleanValue = (value: unknown) => value === true || value === 'true' || value === 'on';

const slugify = (value: string) =>
  value
    .normalize('NFKD')
    .toLowerCase()
    .trim()
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const parseBody = (event: LambdaEvent): PublisherRequest | undefined => {
  if (!event.body) return undefined;

  const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const contentType = getHeader(event.headers, 'content-type');

  if (!contentType.includes('application/json')) {
    throw new RunnerError(415, 'Send a POST request with Content-Type: application/json.');
  }

  const parsed = JSON.parse(body) as unknown;
  return parsed && typeof parsed === 'object' ? (parsed as PublisherRequest) : undefined;
};

const validateEnvironment = () => {
  // Only the drafting model needs configuration now — publishing rides the
  // object substrate in-process (no endpoint, no forwarded secret).
  if (!process.env.OPENAI_API_KEY) {
    throw new RunnerError(500, 'Server-side publisher agent is not configured.');
  }
};

const normalizeInlineAgentImages = (images: unknown) => {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new RunnerError(400, 'images must be an array when provided.');

  return images.map((image, index) => {
    const parsed = publishImageSchema.safeParse(image);
    if (!parsed.success) {
      throw new RunnerError(400, `images[${index}] must include valid artifact upload fields.`);
    }

    return parsed.data;
  });
};

const normalizeArtifactReferences = (value: unknown) => {
  try {
    return requireArtifactReferenceArray(value);
  } catch (error) {
    throw new RunnerError(400, error instanceof Error ? error.message : 'Invalid artifactReferences.');
  }
};

const normalizeRequest = (input: PublisherRequest): NormalizedPublisherRequest => {
  const title = toStringValue(input.title);
  const rawSlug = toStringValue(input.slug) ?? title;
  const slug = rawSlug ? slugify(rawSlug) : undefined;
  const markdown = toStringValue(input.markdown);
  const missing = [!title ? 'title' : undefined, !slug ? 'slug' : undefined, !markdown ? 'markdown' : undefined].filter(
    Boolean
  );

  if (missing.length) {
    throw new RunnerError(400, `Missing required field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`);
  }

  return {
    images: normalizeInlineAgentImages(input.images),
    artifactReferences: normalizeArtifactReferences(input.artifactReferences),
    requestId: toStringValue(input.requestId) ?? toStringValue(input.request_id),
    markdown: markdown ?? '',
    overwrite: toBooleanValue(input.overwrite),
    slug: slug ?? '',
    title: title ?? '',
  };
};

const getActionName = (input: PublisherRequest) => toStringValue(input.action) ?? 'agent.publish_article';

const toStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Fallback when the agent supplies only markdown: blank-line paragraphs
 *  become plain-text content nodes (the string-body contract — plain text,
 *  escaped at render). The agent is INSTRUCTED to supply article_body, so
 *  this path is a safety net, not the norm. */
const nodesFromMarkdown = (markdown: string): ArticleBodyNode[] =>
  markdown
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .slice(0, 60)
    .map((paragraph, index) => ({
      id: `n_md${index.toString(36)}${(paragraph.length % 97).toString(36)}p`,
      kind: 'content' as const,
      public: { body: paragraph },
    }));

/**
 * T9.22 — the object-substrate publish stage, exported for tests. Creates the
 * content_item, then publishes it under the standard gate via the caller's
 * checkout. Release deliberately NOT fired.
 */
export const publishArticleObject = async (
  objectStore: ObjectVerbStore,
  input: {
    slug: string;
    title: string;
    description?: string;
    tags?: string[];
    publishDate?: string;
    nodes: ArticleBodyNode[];
    seoDescription?: string;
  },
  principal: Principal,
  options: Parameters<typeof handleObjectVerb>[3] = {}
): Promise<{ ok: boolean; status: number; objectId?: string; body: Record<string, unknown> }> => {
  const body = {
    slug: input.slug,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...(input.tags && input.tags.length > 0 ? { taxonomy: { tags: input.tags } } : {}),
    ...(input.seoDescription ? { seo: { description: input.seoDescription } } : {}),
    nodes: input.nodes,
  };

  const created = await handleObjectVerb(
    objectStore,
    { action: 'create', object_type: 'content_item', site: getSiteIdentity().siteId, body },
    principal,
    options
  );
  if (created.status !== 200) return { ok: false, status: created.status, body: created.body };
  const objectId = (created.body.record as { object_id: string }).object_id;

  const checkout = await handleObjectVerb(
    objectStore,
    { action: 'checkout', object_type: 'content_item', object_id: objectId },
    principal,
    options
  );
  if (checkout.status !== 200) return { ok: false, status: checkout.status, objectId, body: checkout.body };
  const lockToken = checkout.body.lockToken as string;

  const published = await handleObjectVerb(
    objectStore,
    {
      action: 'publish_by_time',
      object_type: 'content_item',
      object_id: objectId,
      lock_token: lockToken,
      ...(input.publishDate ? { published_time: input.publishDate } : {}),
    },
    principal,
    options
  );
  await handleObjectVerb(
    objectStore,
    { action: 'checkin', object_type: 'content_item', object_id: objectId, lock_token: lockToken },
    principal,
    options
  );
  if (published.status !== 200) return { ok: false, status: published.status, objectId, body: published.body };
  return { ok: true, status: 200, objectId, body: published.body };
};

const createPublishTool = ({
  defaultInput,
  objectStore,
  verbOptions,
  principal,
  onPublishResult,
}: {
  defaultInput: NormalizedPublisherRequest;
  objectStore: ObjectVerbStore;
  verbOptions: Parameters<typeof handleObjectVerb>[3];
  principal: Principal;
  onPublishResult?: (result: PublishToolResult) => void;
}) =>
  tool({
    name: 'publish_approved_article',
    description:
      'Publishes the already-approved article as a governed content_item object (create → nodes with their ' +
      'strategy annotations → validate → publish). The deploy stays deferred; release is a separate human step.',
    parameters: publishToolInputSchema,
    strict: true,
    async execute(rawInput): Promise<PublishToolResult> {
      const parsed = publishToolInputSchema.parse(rawInput);
      const slug = slugify(parsed.slug);
      const markdown = toStringValue(parsed.markdown) ?? defaultInput.markdown;
      const title = toStringValue(parsed.title) ?? defaultInput.title;
      const articlePath = `/${slug}`;
      const normalizedImages = normalizeInlineAgentImages(parsed.images ?? defaultInput.images);
      if (normalizedImages.length) {
        throw new RunnerError(
          400,
          'Artifact upload failed integrity verification: publish tool received unverified inline images.'
        );
      }
      // References stay validated (uploads happened before the run); node
      // media srcs must already carry the /img|/pdf public paths — the
      // article_media validation criterion enforces that on the object path.
      normalizeArtifactReferences(parsed.artifactReferences ?? defaultInput.artifactReferences);

      const nodes: ArticleBodyNode[] = parsed.article_body?.nodes ?? nodesFromMarkdown(markdown);

      console.info('Publisher agent creating content_item.', { slug, nodeCount: nodes.length, title });

      const outcome = await publishArticleObject(
        objectStore,
        {
          slug,
          title,
          ...(parsed.description ? { description: parsed.description } : {}),
          ...(parsed.tags ? { tags: parsed.tags } : {}),
          ...(parsed.publishDate ? { publishDate: parsed.publishDate } : {}),
          nodes,
        },
        principal,
        verbOptions
      );

      const result: PublishToolResult = {
        ...outcome.body,
        ok: outcome.ok,
        success: outcome.ok,
        articlePath,
        ...(outcome.objectId ? { object_id: outcome.objectId } : {}),
        deployStatus: outcome.ok ? 'deferred (release is a separate step)' : 'not published',
        ...(outcome.ok ? {} : { statusCode: outcome.status, error: outcome.body.error }),
        payload: {
          articlePath,
          commitMessage: `Publish article: ${title}`,
          imageCount: 0,
          overwrite: parsed.overwrite ?? defaultInput.overwrite,
          slug,
        },
      };

      onPublishResult?.(result);
      return result;
    },
  });

export const createPublisherAgent = ({
  defaultInput,
  objectStore,
  verbOptions,
  principal,
  onPublishResult,
}: {
  defaultInput: NormalizedPublisherRequest;
  objectStore: ObjectVerbStore;
  verbOptions: Parameters<typeof handleObjectVerb>[3];
  principal: Principal;
  onPublishResult?: (result: PublishToolResult) => void;
}) =>
  new Agent({
    name: `${getSiteIdentity().brandName} Server-Side Publisher`,
    instructions: [
      `You run server-side publishing for already-approved ${getSiteIdentity().brandName} article data.`,
      'Articles are governed content_item objects: structured nodes (article_body.v1 shape) with strategy annotations in private.*.',
      'If you receive a flat markdown body, you must split it into appropriate article_body.nodes before calling the publish tool.',
      'Do not rewrite, summarize, or otherwise alter the approved article content.',
      'Call publish_approved_article once with the approved fields exactly as provided, including artifactReferences and article_body when present.',
      'If image, pdf, video, doc, audio, data, attachment, or other artifact bytes are created upstream, they must be uploaded immediately with create_artifact_upload_intent plus direct HTTP upload and stored only as the returned ArtifactReference objects.',
      'Do not invent or store deterministic blob keys, URLs, repo paths, or inline base64 media; node media srcs use the /img/... or /pdf/... public paths from artifact references.',
      'Call publish_approved_article exactly once, then return a concise JSON-style status summary.',
    ].join('\n'),
    tools: [createPublishTool({ defaultInput, objectStore, verbOptions, principal, onPublishResult })],
  });

const getAgentMetadata = (agentResult: unknown) => {
  const result = agentResult && typeof agentResult === 'object' ? (agentResult as Record<string, unknown>) : {};
  const finalOutput = result.finalOutput;
  const usage = result.usage;
  const state =
    result.state && typeof result.state === 'object' ? (result.state as Record<string, unknown>) : undefined;
  const history = Array.isArray(result.history) ? result.history : undefined;
  const currentAgent = state?.currentAgent;
  const currentAgentRecord =
    currentAgent && typeof currentAgent === 'object' ? (currentAgent as Record<string, unknown>) : undefined;

  return {
    finalOutput,
    usage,
    historyLength: history?.length,
    currentAgentName: typeof currentAgent === 'string' ? currentAgent : toStringValue(currentAgentRecord?.name),
  };
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, {
      status: 'error',
      success: false,
      error: 'Method not allowed. Use POST.',
    });
  }

  let input: NormalizedPublisherRequest;
  let body: PublisherRequest | undefined;
  let principal: Principal;

  try {
    body = parseBody(event);

    if (!body) {
      return jsonResponse(400, {
        status: 'error',
        success: false,
        error: 'Missing request body.',
      });
    }

    const auth = await verifyRequestAuthorization(event, context, binding);
    if (auth.error) {
      return auth.error;
    }
    principal = auth.principal!;

    const action = getActionName(body);
    if (action === 'agent.fill_test_payload') {
      return jsonResponse(200, {
        status: 'ok',
        success: true,
        action,
        message: 'Test payload action acknowledged.',
      });
    }
    if (action === 'agent.start_workflow') {
      return jsonResponse(200, {
        status: 'ok',
        success: true,
        action,
        articleIdea: toStringValue(body.articleIdea) ?? '',
        message: 'Workflow start action acknowledged.',
      });
    }

    if (Object.hasOwn(body, 'publishedDate')) {
      throw new RunnerError(400, 'publishedDate is not supported. Use publishDate in PublishPayload.');
    }

    input = normalizeRequest(body);
    validateEnvironment();
  } catch (error) {
    const statusCode = error instanceof RunnerError ? error.statusCode : 400;
    return jsonResponse(statusCode, {
      status: 'error',
      success: false,
      error: error instanceof Error ? error.message : 'Invalid publisher agent request.',
    });
  }

  const articlePath = `/${input.slug}`;
  let publishResult: PublishToolResult | undefined;

  try {
    console.info('Starting publisher agent run.', {
      articlePath,
      imageCount: input.images.length,
      overwrite: input.overwrite,
      slug: input.slug,
    });

    if (input.images.length) {
      if (!input.requestId) {
        throw new RunnerError(
          400,
          'Artifact upload failed integrity verification: requestId is required to upload article images.'
        );
      }

      const uploadedReferences = await uploadImagesWithIntegrity({
        images: input.images,
        requestId: input.requestId,
        event,
        onWorkflowError: (message) => {
          console.error('Publisher artifact workflow error.', { articlePath, message, slug: input.slug });
        },
      });
      input = { ...input, images: [], artifactReferences: [...input.artifactReferences, ...uploadedReferences] };
    }

    // The object substrate with the SAME live wiring as admin-object: store
    // validation context, governance policies, artifact-index existence trust.
    const objectStore = (await getSiteObjectsBlobStore(event, binding)) as unknown as ObjectVerbStore;
    const artifactIndexStore = (await getArtifactIndexBlobStore(event, binding).catch(() => undefined)) as unknown as
      | ArtifactIndexStore
      | undefined;
    const validationContext = await buildStoreValidationContext(objectStore, {
      selfObjectType: 'content_item',
      ...(artifactIndexStore ? { artifactIndexStore } : {}),
      artifactRefSources: [input],
    });
    const { approval, creation } = await resolveActivePolicies(await getGovernanceBlobStore(event, binding));
    const verbOptions = {
      validationContext,
      approvalPolicy: approval,
      creationPolicy: creation,
      publishDeps: { exportRoot: binding.dataRoot },
    };

    const agent = createPublisherAgent({
      defaultInput: input,
      objectStore,
      verbOptions,
      principal,
      onPublishResult: (result) => {
        publishResult = result;
      },
    });
    const agentResult = await run(
      agent,
      `Publish the approved article using this payload JSON exactly:\n${JSON.stringify(input)}\nArticle path: ${articlePath}.`,
      { maxTurns: 3 }
    );
    const metadata = getAgentMetadata(agentResult);

    if (!publishResult) {
      throw new RunnerError(500, 'Publisher agent completed without returning publish endpoint results.');
    }

    const imagePaths = toStringArray(publishResult.imagePaths ?? publishResult.media);
    const success = publishResult.success === true || publishResult.ok === true;
    const statusCode = success ? 200 : Number(publishResult.statusCode) || 502;

    return jsonResponse(statusCode, {
      status: success ? 'ok' : 'error',
      success,
      articlePath: toStringValue(publishResult.articlePath) ?? articlePath,
      imagePaths,
      deployStatus: toStringValue(publishResult.deployStatus) ?? 'unknown',
      message:
        toStringValue(publishResult.error) ??
        toStringValue(publishResult.message) ??
        (success ? `Article publish queued for ${articlePath}.` : 'Publish endpoint failed.'),
      commit: toStringValue(publishResult.commit),
      agent: {
        ...metadata,
        normalizedSlug: input.slug,
        publishPayload: publishResult.payload,
      },
    });
  } catch (error) {
    console.error('Publisher agent failed.', {
      articlePath,
      slug: input.slug,
      error: error instanceof Error ? error.message : error,
    });

    const statusCode = error instanceof RunnerError ? error.statusCode : 500;

    return jsonResponse(statusCode, {
      status: 'error',
      success: false,
      articlePath,
      imagePaths: [],
      deployStatus: 'failed',
      message: error instanceof Error ? error.message : 'Publisher agent failed.',
      error: error instanceof Error ? error.message : 'Publisher agent failed.',
      commit: undefined,
    });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. T11.6: threads dataRoot to the publish path. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
