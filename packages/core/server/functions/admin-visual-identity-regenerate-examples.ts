/**
 * Function name: Admin_Visual_Identity_Regenerate_Examples
 * Required method: POST
 * Auth: Netlify Identity; an EDITOR may regenerate (see REGENERATE_ROLES).
 *
 * A5 — "Visual identity → Imagery → Regenerate examples", as an endpoint,
 * instead of a chat instruction (`buildRegenerateExamplesIntent`,
 * visual-identity-imagery.ts, R9/X1). That intent told the agent to check
 * the standard out, patch it with `set_visual_standard_fields` and
 * `fields: { examples: [] }` to clear the stale round, then check it back
 * in — deterministic work with no reason to route through a model. This
 * endpoint does exactly that patch itself, under an ordinary checkout, on
 * the standard's OWN id looked up first (never trusted from the body for
 * anything but a lookup, same posture as A1/A3).
 *
 * IT DOES NOT GENERATE. Clearing `examples[]` is what makes the NEXT
 * generation round unconditional — `planExampleGeneration`
 * (brand-imagery-examples.ts) skips entirely whenever every stored example
 * already carries the standard's current contract hash, so an unrelated
 * "regenerate" click with nothing cleared would just report `hash_unchanged`
 * and render nothing. The actual work happens minutes later, in the
 * background: this endpoint's ONLY side effect beyond the patch is calling
 * `triggerVisualStandardExamplesJob` (visual-standard-examples-jobs.ts, A6)
 * — the same call `admin-object.ts`'s browser writes and the MCP verb
 * dispatch both make — which writes a `pending` job record and fires a
 * background POST to `visual-standard-examples-background`. Unlike those
 * two callers, this endpoint calls `handleObjectVerb` DIRECTLY rather than
 * through `admin-object.ts`, so nothing triggers the job automatically —
 * this file makes that call itself, explicitly, right after the patch
 * lands.
 *
 * The response carries the job's status view so the tab can show "regenerating…"
 * immediately rather than a silent success that only differs from a no-op
 * once someone reloads the page later.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import type { Role } from '../lib/roles.js';
import { getArtifactIndexBlobStore, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import type { ArtifactIndexStore } from '../lib/artifact-index.js';
import {
  handleObjectVerb,
  objectVerbRequestSchema,
  type ObjectVerbResult,
  type ObjectVerbStore,
} from '../lib/object-verbs.js';
import { buildStoreValidationContext } from '../lib/object-validation-context.js';
import {
  examplesJobStatusView,
  triggerVisualStandardExamplesJob,
  type ExamplesJobStore,
} from '../lib/visual-standard-examples-jobs.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import type { Principal } from '../../schema/object-record-v1.js';

/**
 * Ordinary editorial work on a DRAFT artifact, not a publish — same gate as
 * `admin-visual-identity-import`'s `IMPORT_ROLES` (and
 * `visual-identity-imagery.ts`'s `canRegenerate`, which is `canEditBoard`).
 */
const REGENERATE_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'publisher', 'editor']);

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

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const access = await resolveAdminAccessFromEvent(event, context, binding);
  if (!access.authenticated) return jsonResponse(401, { error: access.error ?? 'Authentication is required.' });
  if (!access.roles.some((role) => REGENERATE_ROLES.has(role))) {
    return jsonResponse(403, {
      error: `${access.email ?? 'This account'} has no editing role on this publication, so it cannot regenerate examples. Ask the owner for editor or publisher.`,
    });
  }

  const payload = parseBody(event);
  if (!isRecord(payload)) return jsonResponse(400, { error: 'Invalid request body.' });

  const standardId = text(payload.standardId);
  if (!standardId) return jsonResponse(400, { error: 'standardId is required.' });

  try {
    const store = (await getSiteObjectsBlobStore(event, binding)) as unknown as ObjectVerbStore;
    const principal: Principal = { kind: 'human', id: access.userId ?? '', email: access.email ?? '' };
    const roles = access.roles;
    const verb = async (request: Record<string, unknown>): Promise<ObjectVerbResult> => {
      const parsed = objectVerbRequestSchema.safeParse(request);
      if (!parsed.success) return { status: 400, body: { error: 'Invalid object request.' } };
      return handleObjectVerb(store, parsed.data, principal, { roles });
    };

    const read = await verb({ action: 'get', object_type: 'visual_standard', object_id: standardId });
    if (read.status !== 200 || !isRecord(read.body.record)) {
      return jsonResponse(read.status === 200 ? 404 : read.status, {
        error: text(read.body.error) ?? `No visual standard ${standardId} exists on this publication.`,
      });
    }

    const cleared = await clearExamples({ store, principal, roles, event, standardId, binding });
    if (!cleared.ok) return jsonResponse(cleared.status, { error: cleared.error });

    const identity = getSiteIdentity();
    const jobStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ExamplesJobStore;
    const job = await triggerVisualStandardExamplesJob(jobStore, {
      visualStandardId: standardId,
      trigger: 'browser',
      siteId: identity.siteId,
      log: event.log,
    });

    event.log?.({
      event: 'visual_standard_examples_regenerate_requested',
      siteId: identity.siteId,
      standardId,
      dispatched: job?.dispatched,
    });

    return jsonResponse(200, {
      standard_id: standardId,
      ...(job ? { examples_job: examplesJobStatusView(job) } : {}),
    });
  } catch (error) {
    console.error('Visual identity examples regenerate failed.', error);
    return jsonResponse(500, { error: 'The examples could not be regenerated.' });
  }
};

/**
 * checkout → patch(examples: []) → checkin, the same lifecycle A1's
 * `appendReferences` uses for the mood board — check-in always happens,
 * even when the patch fails, so a failed clear never leaves the standard
 * locked.
 */
const clearExamples = async (input: {
  store: ObjectVerbStore;
  principal: Principal;
  roles: Role[];
  event: unknown;
  standardId: string;
  binding?: SiteBinding;
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
  const ops = [{ op: 'set_visual_standard_fields', fields: { examples: [] } }];
  const artifactIndexStore = (await getArtifactIndexBlobStore(input.event, input.binding).catch(
    () => undefined
  )) as unknown as ArtifactIndexStore | undefined;
  const validationContext = await buildStoreValidationContext(input.store, {
    selfObjectId: input.standardId,
    selfObjectType: 'visual_standard',
    ...(artifactIndexStore ? { artifactIndexStore } : {}),
    artifactRefSources: [{ ops }],
  });

  const run = async (request: Record<string, unknown>, withContext = false): Promise<ObjectVerbResult> => {
    const parsed = objectVerbRequestSchema.safeParse(request);
    if (!parsed.success) return { status: 400, body: { error: 'Invalid object request.' } };
    return handleObjectVerb(input.store, parsed.data, input.principal, {
      roles: input.roles,
      ...(withContext ? { validationContext } : {}),
    });
  };

  const checkout = await run({
    action: 'checkout',
    object_type: 'visual_standard',
    object_id: input.standardId,
    lease_seconds: 300,
  });
  if (checkout.status !== 200) {
    return {
      ok: false,
      status: checkout.status,
      error:
        text(checkout.body.error) ??
        'This visual standard is checked out by someone else, so its examples could not be regenerated.',
    };
  }
  const lockToken = text(checkout.body.lockToken);
  const recordVersion = typeof checkout.body.record_version === 'number' ? checkout.body.record_version : undefined;
  if (!lockToken || recordVersion === undefined) {
    return { ok: false, status: 500, error: 'The visual standard could not be checked out for editing.' };
  }

  try {
    const patched = await run(
      {
        action: 'patch',
        object_type: 'visual_standard',
        object_id: input.standardId,
        lock_token: lockToken,
        expected_record_version: recordVersion,
        ops,
      },
      true
    );
    if (patched.status !== 200) {
      return {
        ok: false,
        status: patched.status,
        error: text(patched.body.error) ?? 'The stale examples could not be cleared.',
      };
    }
    return { ok: true };
  } finally {
    await run({
      action: 'checkin',
      object_type: 'visual_standard',
      object_id: input.standardId,
      lock_token: lockToken,
    }).catch(() => undefined);
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
