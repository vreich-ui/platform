/**
 * Function name: Object_Store
 * Required method: POST
 * Required header: x-publish-key
 * Store name: site-objects
 * Primary record key: objects/{object_type}/by-id/{object_id}.json
 *
 * The publish-key entry point to the generic object verbs (T0.8), for agents
 * and scripts. Actions: get | list | create | checkout | refresh_lock |
 * checkin | patch | validate. (submit / publish / review arrive in P1.)
 *
 * All action logic lives in netlify/lib/object-verbs.ts and is shared with the
 * Netlify-Identity mirror (admin-object.ts); this file only authenticates the
 * shared publish key and builds the self-declared agent Principal (today's
 * trust model, C§2.0 — per-agent credentials are OQ-3, not built here).
 */
import { timingSafeEqual } from 'node:crypto';
import { PLATFORM_ENV_NAMES, readBoundEnv, type SiteBinding } from '../lib/site-binding.js';

import { getHeader } from '../lib/admin-auth.js';
import { CALLER_ACTOR_HEADER, decodeCallerActor } from '../lib/caller-actor.js';
import type { ArtifactIndexStore } from '../lib/artifact-index.js';
import { getArtifactIndexBlobStore, getMarginaliaBlobStore, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import {
  handleObjectVerb,
  objectVerbRequestSchema,
  verbNeedsValidationContext,
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
  body: JSON.stringify({ ok: status >= 200 && status < 300, status, ...body }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const safeJsonParse = (event: LambdaEvent): { ok: true; value: unknown } | { ok: false } => {
  if (!event.body) return { ok: false };
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
};

const secretsMatch = (provided: string, expected: string): boolean => {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
};

const verifyPublishKey = (event: LambdaEvent) => {
  const provided = getHeader(event.headers, 'x-publish-key');
  const expected = readBoundEnv(PLATFORM_ENV_NAMES.publishSecret) ?? '';
  if (!provided || !expected || !secretsMatch(provided, expected)) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }
  return undefined;
};

/**
 * The self-declared path, unchanged: a publish-key caller with no derived
 * actor (a script, a cron, a fleet job) is its declared name or the sentinel.
 * This is still the ONLY thing a model-authored payload can reach.
 */
export const agentPrincipal = (payload: unknown): Principal => {
  const declared = isRecord(payload) && typeof payload.agent_name === 'string' ? payload.agent_name.trim() : '';
  return declared
    ? { kind: 'agent', agent_name: declared, auth: 'publish_key', attribution: 'self_declared' }
    : { kind: 'agent', agent_name: 'unattributed-agent', auth: 'publish_key', attribution: 'publish_key' };
};

/**
 * WHO is writing (2026-09-03, Wolf's ruling).
 *
 * A derived actor on `CALLER_ACTOR_HEADER` wins over anything in the payload.
 * It is only present on a request that already satisfied `verifyPublishKey`,
 * and only `/mcp` mints it — from the OAuth grant or verified agent token that
 * authorized the original call. A model can write the payload; it cannot write
 * this header.
 *
 * Absent or malformed, this degrades to `agentPrincipal` — exactly the previous
 * behaviour — so a script keeps working and a bad header never fails a write.
 */
export const callerPrincipal = (event: LambdaEvent, payload: unknown): Principal =>
  decodeCallerActor(getHeader(event.headers, CALLER_ACTOR_HEADER)) ?? agentPrincipal(payload);

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const authFailure = verifyPublishKey(event);
  if (authFailure) return authFailure;

  const parsed = safeJsonParse(event);
  if (!parsed.ok) return jsonResponse(400, { error: 'Invalid request body.' });

  const request = objectVerbRequestSchema.safeParse(parsed.value);
  if (!request.success) return jsonResponse(400, { error: 'Invalid request fields.', issues: request.error.issues });

  try {
    const store = (await getSiteObjectsBlobStore(event)) as unknown as ObjectVerbStore;
    // Wire the store-backed validation context so reference integrity, PageType
    // section rules, route uniqueness, and taxonomy resolution are enforced live
    // (not the previous no-context degradation to `optional`). Flows to create,
    // patch, validate, and publish.
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
      // Artifact existence checks (Fix: asset refs were shape-only in production).
      // An unavailable index store degrades to "existence not verified", never a
      // failed write.
      const artifactIndexStore = (await getArtifactIndexBlobStore(event).catch(() => undefined)) as unknown as
        | ArtifactIndexStore
        | undefined;
      validationContext = await buildStoreValidationContext(store, {
        selfObjectId: requestData.object_id ?? targetPageId,
        selfObjectType: requestData.object_type ?? (targetPageId ? 'page' : undefined),
        ...(artifactIndexStore ? { artifactIndexStore } : {}),
        artifactRefSources: [parsed.value],
      });
    }
    // W15 S4 (MVP): the same threading pattern object-store.ts already uses
    // for the site-objects/artifact-index stores above — agents reach the
    // four marginalia_* actions over the publish key exactly like every
    // other object verb.
    const marginaliaStore = (await getMarginaliaBlobStore(event)) as unknown as MarginaliaStore;
    const result = await handleObjectVerb(store, request.data, callerPrincipal(event, parsed.value), {
      validationContext,
      publishDeps: { exportRoot: binding.dataRoot },
      marginaliaStore,
    });
    return jsonResponse(result.status, result.body);
  } catch (error) {
    console.error('Object_Store request failed.', error);
    // W14 T14.4: the bare message cost a full debugging loop against a live
    // site — every failure read identically. The 500 now carries a SANITIZED
    // diagnostic: the error's message and top in-repo stack frame, never a
    // dump. Secrets don't flow through error messages on this path (they live
    // in env reads that fail closed), and knowing WHICH check threw is the
    // difference between a fix and a guess.
    const detail = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 200);
    const frame =
      error instanceof Error && error.stack
        ? (error.stack.split('\n').find((line) => /packages\/core|netlify\//.test(line)) ?? '').trim().slice(0, 200)
        : undefined;
    return jsonResponse(500, {
      action: request.data.action,
      error: 'Object request could not be processed.',
      detail,
      ...(frame ? { frame } : {}),
    });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. T11.6: threads dataRoot to the publish path. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
