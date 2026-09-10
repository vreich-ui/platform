/**
 * Function name: Admin_Object
 * Required method: POST
 * Auth: Netlify Identity (admin email allowlist) — the BROWSER MIRROR of the
 *       object verbs (T0.8).
 *
 * Same verb surface and same shared core (netlify/lib/object-verbs.ts) as the
 * publish-key entry point (object-store.ts) — the only difference is that this
 * path authenticates a human via Netlify Identity and attributes writes to a
 * human Principal.
 *
 * A6 — THE BROWSER TRIGGERS THE EXAMPLE GENERATOR TOO. X1 hooked the visual
 * standard example generator onto the MCP verb dispatch only
 * (`mcp-tool-handlers.ts`'s `callObjectAction`) and deliberately left THIS
 * path unhooked, on the reasoning that a human would ask an agent to
 * regenerate. The consequence was that the mood-board save and "Make this the
 * site's imagery" — the surfaces the affordance actually lives on — generated
 * nothing at all, silently. Both surfaces now open the same job record and
 * hand the work to the same background function, and a `get` of a
 * visual_standard carries that record's status back so the board can poll it.
 *
 * SECURITY INVARIANT (A§1.2): the browser path must never see the publish key.
 * This file therefore does not import, read, or forward `PUBLISH_SECRET` /
 * `NETLIFY_PUBLISH_SECRET` or the `x-publish-key` header in any form — it has
 * no code path that touches the shared secret. Enforced by a dedicated test.
 */
import { createHash } from 'node:crypto';

import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import type { ArtifactIndexStore } from '../lib/artifact-index.js';
import { logDiagnostics, timeAuth, timeSerialize, withServerTiming } from '../lib/server-timing.js';
import {
  getAgentLearningBlobStore,
  getArtifactIndexBlobStore,
  getMarginaliaBlobStore,
  getSiteObjectsBlobStore,
} from '../lib/blob-store.js';
import { getGovernanceBlobStore, resolveActivePolicies } from '../lib/governance-store.js';
import {
  examplesJobStatusView,
  readExamplesJob,
  resolveExamplesTriggerTarget,
  triggerVisualStandardExamplesJob,
  type ExamplesJobStore,
} from '../lib/visual-standard-examples-jobs.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import {
  handleObjectVerb,
  objectVerbRequestSchema,
  verbNeedsValidationContext,
  type AgentLearningWriteStore,
  type ObjectVerbStore,
} from '../lib/object-verbs.js';
import type { MarginaliaStore } from '../lib/marginalia-store.js';
import { buildStoreValidationContext } from '../lib/object-validation-context.js';
import type { ObjectType } from '../../schema/object-record-v1.js';
import type { Principal } from '../../schema/object-record-v1.js';

type LambdaEvent = {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
};

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

const jsonResponse = (status: number, body: Record<string, unknown>) => ({
  statusCode: status,
  headers: jsonHeaders,
  body: timeSerialize(() => JSON.stringify({ ok: status >= 200 && status < 300, status, ...body })),
});

/**
 * T2.3 — the pure-read verbs on this shared verb surface (mirrors
 * `verbNeedsValidationContext`'s own read/mutation split in object-verbs.ts,
 * NOT copied from it: `checkout`/`refresh_lock`/`checkin` need no validation
 * context either, but they mutate lock state, so they stay off this list —
 * a lock verb must never carry a validator a later poll could 304 against).
 * Every other action (`create`, `patch`, `publish`, `retire`, …) mutates and
 * keeps the file's existing `no-store` response untouched.
 */
const OBJECT_READ_ACTIONS = new Set(['get', 'list', 'marginalia_list']);

/**
 * `inventory` and `content_search` are pure reads too, but they are NOT on
 * that list, because their validator provably can never match: both bodies
 * carry `generated_at: <this request's ISO timestamp>` (and `index:
 * sweep.stats`, whose `read`/`wrote` counts move run to run) — see
 * object-verbs.ts's `case 'inventory'` / `case 'content_search'`. Hashing
 * them would mint a fresh etag on every single request, so the header could
 * only ever be cost: `inventory` carries the largest body on this surface
 * and object-verbs.ts's own comment notes it runs "two-to-four times per
 * admin page load". Making them conditional means first making their bodies
 * a function of their inputs — a wire-contract change, not this one.
 */

const CACHE_CONTROL = 'private, no-cache';
/**
 * Hashes the ALREADY-SERIALIZED wire body, so a read response is
 * `JSON.stringify`d exactly ONCE per request. The digest is identical to
 * hashing the object (same input string), but the previous shape paid a
 * second full stringify of the whole body on every read — on a latency
 * branch, on this surface's hottest read paths.
 */
const etagForSerialized = (serialized: string): string =>
  `"${createHash('sha1').update(serialized).digest('hex')}"`;

/**
 * A read verb's response, conditionally: 304 on a matching `If-None-Match`,
 * otherwise 200 with `ETag` + `Cache-Control: private, no-cache`. The etag is
 * hashed off the EXACT body this request would have returned (object id,
 * type, projection and any role-gated content are already baked into that
 * body), so it varies with everything that varies the body without needing
 * a second, separate cache key.
 */
const readJsonResponse = (event: LambdaEvent, body: Record<string, unknown>) => {
  const serialized = timeSerialize(() => JSON.stringify({ ok: true, status: 200, ...body }));
  const etag = etagForSerialized(serialized);
  const ifNoneMatch = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
  if (ifNoneMatch && ifNoneMatch === etag) {
    return { statusCode: 304, headers: { 'Cache-Control': CACHE_CONTROL, ETag: etag }, body: '' };
  }
  return {
    statusCode: 200,
    headers: { ...jsonHeaders, 'Cache-Control': CACHE_CONTROL, ETag: etag },
    body: serialized,
  };
};

const safeJsonParse = (event: LambdaEvent): { ok: true; value: unknown } | { ok: false } => {
  if (!event.body) return { ok: false };
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const adminState = await timeAuth(() => resolveAdminAccessFromEvent(event, context, binding));
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });
  if (!adminState.isAdmin) return jsonResponse(403, { error: 'Admin access required' });

  const parsed = safeJsonParse(event);
  if (!parsed.ok) return jsonResponse(400, { error: 'Invalid request body.' });

  const request = objectVerbRequestSchema.safeParse(parsed.value);
  if (!request.success) return jsonResponse(400, { error: 'Invalid request fields.', issues: request.error.issues });

  const principal: Principal = { kind: 'human', id: adminState.userId ?? '', email: adminState.email ?? '' };

  try {
    const store = (await getSiteObjectsBlobStore(event, binding)) as unknown as ObjectVerbStore;
    // Same live validation context as the publish-key path (object-store.ts):
    // the browser admin path enforces the identical structural rules.
    const requestData = request.data as {
      object_id?: string;
      object_type?: ObjectType;
      target?: { kind?: string; page_id?: string };
    };
    // instantiate_section (W8.2) validates the TARGET page under its own id —
    // without the self ref, route uniqueness would flag the page's own route.
    const targetPageId = requestData.target?.kind === 'page' ? requestData.target.page_id : undefined;
    // Perf: a validation context costs a full sweep of every object across all
    // 13 types (plus a GitHub content-item lookup) — skip building one (and
    // skip opening the artifact-index store that only feeds it) for verbs that
    // never read it (pure reads, lock verbs — see verbNeedsValidationContext).
    // Every mutating/body-validating verb still gets the identical live context
    // as before.
    let validationContext: Awaited<ReturnType<typeof buildStoreValidationContext>> | undefined;
    if (verbNeedsValidationContext(request.data.action)) {
      // Artifact existence checks — same wiring as object-store.ts; an
      // unavailable index store degrades to "existence not verified".
      const artifactIndexStore = (await getArtifactIndexBlobStore(event, binding).catch(() => undefined)) as unknown as
        | ArtifactIndexStore
        | undefined;
      validationContext = await buildStoreValidationContext(store, {
        selfObjectId: requestData.object_id ?? targetPageId,
        selfObjectType: requestData.object_type ?? (targetPageId ? 'page' : undefined),
        ...(artifactIndexStore ? { artifactIndexStore } : {}),
        artifactRefSources: [parsed.value],
      });
    }
    // T9.4/S1: the acting human's roles server-side, so owner-only verb
    // options (checkin{force}) are gated by the real tier, not client claims —
    // reuse what resolveAdminAccessFromEvent already resolved above instead of
    // re-reading the users store a second time for the same principal.
    const roles = adminState.roles;
    // T9.15: runtime governance overrides (else committed policy) feed the
    // publish/create gates.
    const { approval, creation } = await resolveActivePolicies(await getGovernanceBlobStore(event, binding));
    // S4x (2/2): the ONLY caller that wires this — a canvas save's ops array
    // may carry a tagged Ask-AI proposal trail marker; handleObjectVerb writes
    // it here, atomically with the patch, once the patch itself has persisted.
    const agentLearningStore = (await getAgentLearningBlobStore(event, binding)) as unknown as AgentLearningWriteStore;
    // W15 S4 (MVP): the same threading pattern as agentLearningStore above —
    // the ONLY caller-supplied dependency the four marginalia_* actions need.
    const marginaliaStore = (await getMarginaliaBlobStore(event, binding)) as unknown as MarginaliaStore;
    const result = await handleObjectVerb(store, request.data, principal, {
      validationContext,
      roles,
      approvalPolicy: approval,
      creationPolicy: creation,
      publishDeps: { exportRoot: binding.dataRoot },
      agentLearningStore,
      marginaliaStore,
    });
    // T0.1: `inventory` and `content_search` report their sweep's `index:
    // sweep.stats` on the wire body already (object-verbs.ts) — log it next
    // to this invocation's timing rather than only inside the JSON payload.
    if ('index' in result.body) {
      logDiagnostics('admin-object', result.body.index);
    }
    if (result.status >= 200 && result.status < 300) {
      // Both example-generation surfaces, one trigger and one job record: a
      // browser write is no longer the silent one. Best-effort by construction
      // — a successful object write is never downgraded because the examples
      // side effect could not be started.
      const target = resolveExamplesTriggerTarget(request.data as Record<string, unknown>, result.body);
      if (target) {
        const jobStore = (await getArtifactIndexBlobStore(event, binding).catch(() => undefined)) as unknown as
          | ExamplesJobStore
          | undefined;
        if (jobStore) {
          await triggerVisualStandardExamplesJob(jobStore, {
            visualStandardId: target,
            trigger: 'browser',
            siteId: getSiteIdentity().siteId,
          });
        }
      }
      // A7 polls this while it says `pending`: the readable status of the round
      // the write above (or an earlier one) started.
      const examplesJob = await readVisualStandardExamplesJob(event, request.data, binding);
      const finalBody = examplesJob ? { ...result.body, examples_job: examplesJob } : result.body;
      // T2.3: ETag + `Cache-Control: private, no-cache` + `304` — ONLY for the
      // pure-read verbs (OBJECT_READ_ACTIONS). Every mutating verb (create,
      // patch, publish, checkout/checkin's lock-state change, …) keeps the
      // `no-store` response above untouched, so a write is never mistaken for
      // a cacheable read and a lock verb never grows a validator a later poll
      // could 304 against.
      if (OBJECT_READ_ACTIONS.has(request.data.action)) return readJsonResponse(event, finalBody);
      return jsonResponse(result.status, finalBody);
    }
    return jsonResponse(result.status, result.body);
  } catch (error) {
    console.error('Admin_Object request failed.', error);
    return jsonResponse(500, { action: request.data.action, error: 'Object request could not be processed.' });
  }
};

/**
 * The job record for a `get` of a visual_standard — the status A7 polls while
 * a round is `pending`. Read-only, best-effort, and only on the one verb a UI
 * actually polls with; never fails the verb it decorates.
 */
const readVisualStandardExamplesJob = async (
  event: LambdaEvent,
  request: { action?: string; object_type?: string; object_id?: string },
  binding?: SiteBinding
) => {
  if (request.action !== 'get' || request.object_type !== 'visual_standard' || !request.object_id) return undefined;
  try {
    const jobStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ExamplesJobStore;
    const job = await readExamplesJob(jobStore, request.object_id);
    return job ? examplesJobStatusView(job) : undefined;
  } catch {
    return undefined;
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. T11.6: threads dataRoot to the publish path. */
export const createHandler = (binding: SiteBinding) => withServerTiming('admin-object', buildHandlerImpl(binding));
