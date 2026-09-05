/**
 * Function name: Admin_Visual_Identity_Import
 * Required method: POST
 * Auth: Netlify Identity; an EDITOR may import (see IMPORT_ROLES below).
 *
 * A1 — "Visual identity → Imagery → Import references", as an endpoint.
 *
 * WHAT IT REPLACES. The Imagery tab's Import button used to build a chat
 * INSTRUCTION (visual-identity-imagery.ts's `buildImportReferencesIntent`):
 * the agent then had to invent an `import_images_from_url` request id and
 * mint `ref_` ids for the mood board, and a wrong id meant the
 * `set_visual_standard_fields` patch failed outright. Nothing about that
 * needs a model. This endpoint does the whole thing deterministically:
 *
 *   1. mint `req_visref_<site>_<yyyymmdd>_<nn>` (visual-reference-import.ts),
 *   2. call the SAME server handler the `import_images_from_url` MCP tool
 *      dispatches to — `callImportImagesFromUrl` — never a second copy of
 *      that logic, and never a round trip through MCP,
 *   3. MIRROR the imported bytes into Platform's own `artifacts` store (the
 *      chosen ruling — no proxy to pdf-tool) so `admin-get-blob-image` can
 *      serve every card,
 *   4. mint `ref_<8>` ids and APPEND to the standard's `references[]` through
 *      the ordinary `set_visual_standard_fields` op under a real checkout.
 *
 * NEVER TRUSTS CLIENT IDS. `standardId` is only ever used to LOOK UP an
 * existing `visual_standard`; reference ids, the request id and every blobKey
 * are minted or computed server-side. A blobKey the caller sends is ignored.
 *
 * APPEND, NEVER REPLACE. `set_visual_standard_fields` replaces `references[]`
 * wholesale (buildReferencesOp's note), so the op carries the standard's
 * CURRENT references read back inside this request, plus the new ones — and
 * the 24-reference schema cap is checked before anything is fetched.
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
  importVisualReferenceImages,
  mintVisualReferenceRequestIdForEvent,
  type ImportImagesOptions,
  type MirroredReference,
} from '../lib/visual-reference-import.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import { getAdminBlobImageEndpoint } from '../../lib/admin/artifact-preview.js';
import {
  MOOD_BOARD_MAX_REFERENCES,
  PROPOSAL_MAX_REFERENCES,
  mintReferenceId,
  parseImportUrls,
} from '../../lib/admin/visual-identity-imagery.js';
import type { Principal } from '../../schema/object-record-v1.js';
import type { LambdaEvent as ToolLambdaEvent } from './mcp.js';

/**
 * Importing a reference is ordinary editorial work on a DRAFT artifact, not a
 * publish: an editor may do it. (Applying a standard to the site stays
 * Owner-gated in object-verbs.ts — a different verb, a different gate.) Same
 * shape as plugin-install.ts's INSTALL_ROLES, which is this repo's existing
 * "any role that can change content" gate.
 */
const IMPORT_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'publisher', 'editor']);

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

/** The stored shape of one mood-board entry (visual-standard-v1.ts, strict). */
type StoredReference = {
  id: string;
  blobKey: string;
  region?: { x: number; y: number; w: number; h: number };
  note?: string;
  weight?: number;
};

const readStoredReferences = (body: unknown): StoredReference[] => {
  const references = isRecord(body) ? body.references : undefined;
  if (!Array.isArray(references)) return [];
  return references.filter((entry): entry is StoredReference => isRecord(entry) && typeof entry.blobKey === 'string');
};

/** Mints a `ref_<8>` id nothing on this board already uses. */
const mintUnusedReferenceId = (used: Set<string>): string => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const id = mintReferenceId();
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error('A free reference id could not be minted for this mood board.');
};

export type ImportedReferenceView = {
  id: string;
  blobKey: string;
  previewUrl?: string;
  sourceUrl?: string;
  note?: string;
};

export type AdminVisualIdentityImportOptions = {
  /** Test seam: bounds the pdf-tool job poll. Production uses the defaults. */
  import?: ImportImagesOptions;
  now?: Date;
};

const buildHandlerImpl =
  (_binding: SiteBinding, options: AdminVisualIdentityImportOptions = {}) =>
  async (event: LambdaEvent, context?: LambdaContext) => {
    if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

    const access = await resolveAdminAccessFromEvent(event, context);
    if (!access.authenticated) return jsonResponse(401, { error: access.error ?? 'Authentication is required.' });
    if (!access.roles.some((role) => IMPORT_ROLES.has(role))) {
      return jsonResponse(403, {
        error: `${access.email ?? 'This account'} has no editing role on this publication, so it cannot import reference images. Ask the owner for editor or publisher.`,
      });
    }

    const payload = parseBody(event);
    if (!isRecord(payload)) return jsonResponse(400, { error: 'Invalid request body.' });

    const standardId = text(payload.standardId);
    if (!standardId) return jsonResponse(400, { error: 'standardId is required.' });

    const rawUrls = Array.isArray(payload.urls)
      ? payload.urls.filter((url): url is string => typeof url === 'string').join('\n')
      : typeof payload.urls === 'string'
        ? payload.urls
        : '';
    const { urls, rejected } = parseImportUrls(rawUrls);
    if (urls.length === 0) {
      return jsonResponse(400, {
        error:
          rejected[0]?.reason ?? `Give between 1 and ${PROPOSAL_MAX_REFERENCES} https:// image addresses to import.`,
        rejected,
      });
    }
    const note = text(payload.note)?.slice(0, 200);

    try {
      const store = (await getSiteObjectsBlobStore(event)) as unknown as ObjectVerbStore;
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
      const existing = readStoredReferences((read.body.record as Record<string, unknown>).body);

      // The cap is the schema's own (visual-standard-v1.ts: references max 24)
      // and is checked BEFORE anything is fetched — refusing after an import
      // would leave stored bytes nothing points at.
      const room = MOOD_BOARD_MAX_REFERENCES - existing.length;
      if (room <= 0) {
        return jsonResponse(409, {
          error: `This mood board already holds the maximum of ${MOOD_BOARD_MAX_REFERENCES} references. Remove one before importing another.`,
          reference_count: existing.length,
        });
      }
      if (urls.length > room) {
        return jsonResponse(409, {
          error: `A mood board holds at most ${MOOD_BOARD_MAX_REFERENCES} references. This one has ${existing.length}, so there is room for ${room} more, not ${urls.length}. Import fewer, or remove some first.`,
          reference_count: existing.length,
          room,
        });
      }

      // Identity by BYTES, not by key: the canonical key embeds the request
      // id this import mints, so the same image re-imported tomorrow would
      // otherwise land a second card. The sha256 is the filename stem of
      // every Major Key (`image/<requestId>/<sha256>.<ext>`), which is where
      // `admin-get-blob-image` reads it from too.
      const existingBySha = new Map<string, string>();
      for (const reference of existing) {
        const sha = /\/([a-f0-9]{64})(?:\.[a-z0-9]+)?$/i.exec(reference.blobKey)?.[1]?.toLowerCase();
        if (sha && !existingBySha.has(sha)) existingBySha.set(sha, reference.blobKey);
      }

      const identity = getSiteIdentity();
      const requestId = await mintVisualReferenceRequestIdForEvent(
        event,
        identity.siteShortId,
        options.now ?? new Date()
      );
      const imported = await importVisualReferenceImages(
        event as ToolLambdaEvent,
        { siteId: identity.siteId, requestId, urls, existingBySha, ...(note ? { note } : {}) },
        options.import ?? {}
      );
      if (!imported.ok) return jsonResponse(imported.statusCode, { error: imported.error, request_id: requestId });

      // Same blobKey ⇒ same image: a re-import of a URL already on the board
      // dedupes to the reference that is already there rather than adding a
      // second card for identical bytes.
      const byBlobKey = new Map(existing.map((reference) => [reference.blobKey, reference]));
      const usedIds = new Set(existing.map((reference) => reference.id));
      const added: ImportedReferenceView[] = [];
      const duplicates: ImportedReferenceView[] = [];
      const references: StoredReference[] = [...existing];

      for (const mirrored of imported.mirrored as MirroredReference[]) {
        const view = (id: string): ImportedReferenceView => ({
          id,
          blobKey: mirrored.blobKey,
          ...(getAdminBlobImageEndpoint(mirrored.blobKey)
            ? { previewUrl: getAdminBlobImageEndpoint(mirrored.blobKey) }
            : {}),
          ...(mirrored.sourceUrl ? { sourceUrl: mirrored.sourceUrl } : {}),
          ...(note ? { note } : {}),
        });
        const already = byBlobKey.get(mirrored.blobKey);
        if (already) {
          duplicates.push(view(already.id));
          continue;
        }
        const reference: StoredReference = {
          id: mintUnusedReferenceId(usedIds),
          blobKey: mirrored.blobKey,
          ...(note ? { note } : {}),
          weight: 1,
        };
        references.push(reference);
        byBlobKey.set(reference.blobKey, reference);
        added.push(view(reference.id));
      }

      if (added.length > 0) {
        const saved = await appendReferences({
          store,
          principal,
          roles,
          event,
          standardId,
          references,
        });
        if (!saved.ok) return jsonResponse(saved.status, { error: saved.error, request_id: requestId });
      }

      event.log?.({
        event: 'visual_standard_references_imported',
        siteId: identity.siteId,
        standardId,
        requestId,
        added: added.length,
        duplicates: duplicates.length,
        failed: imported.failures.length,
      });

      return jsonResponse(200, {
        request_id: requestId,
        standard_id: standardId,
        references: added,
        duplicates,
        failures: imported.failures,
        rejected,
        reference_count: references.length,
      });
    } catch (error) {
      console.error('Visual identity reference import failed.', error);
      return jsonResponse(500, { error: 'The reference images could not be imported.' });
    }
  };

/**
 * checkout → patch → checkin, the same lifecycle the browser's EditSession
 * runs for a mood-board save; the check-in always happens, even when the
 * patch fails, so a failed import never leaves the standard locked.
 */
const appendReferences = async (input: {
  store: ObjectVerbStore;
  principal: Principal;
  roles: Role[];
  event: unknown;
  standardId: string;
  references: StoredReference[];
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
  const ops = [{ op: 'set_visual_standard_fields', fields: { references: input.references } }];
  const artifactIndexStore = (await getArtifactIndexBlobStore(input.event).catch(() => undefined)) as unknown as
    | ArtifactIndexStore
    | undefined;
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
        'This visual standard is checked out by someone else, so the imported references could not be added.',
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
        error: text(patched.body.error) ?? 'The mood board could not be saved with the imported references.',
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
export const createHandler = (binding: SiteBinding, options?: AdminVisualIdentityImportOptions) =>
  buildHandlerImpl(binding, options);
