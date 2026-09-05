/**
 * Function name: Admin_Visual_Identity_Propose
 * Required method: POST
 * Auth: Netlify Identity; an EDITOR may propose (see PROPOSE_ROLES below) —
 * applying stays Owner-gated on `apply_brand_imagery` (object-verbs.ts),
 * untouched by this endpoint.
 *
 * A3 — "Visual identity → Imagery → Write contract from mood board", as an
 * endpoint, instead of a chat instruction (`buildProposeContractIntent`,
 * visual-identity-imagery.ts). Builds on A1's `admin-visual-identity-import`
 * (the same role gate, the same "look the standard up, never trust a
 * client-supplied body" posture) and A2's `visual_identity_propose` tool
 * contract (brand-imagery-proxy.ts).
 *
 * THE BUG THIS CLOSES. A photographic mood board produced a
 * `digital_illustration` proposal. The writer model only ever receives
 * `input.imageRefs[]`; when a reference resolves to a bare `url` (the
 * default, when no crop `region` is set — brand-imagery-proxy.ts's
 * `resolveImageRef`), the CMS-Agent node runner fetches it itself, and that
 * fetch is unauthenticated http(s) only. An admin-gated blob URL 401s there,
 * and the image is silently dropped — the writer never sees it, and nothing
 * on the approval card says why a photographic board produced an
 * illustrated proposal.
 *
 * THE RULING (platform's half of the fix — the CMS-Agent half, making
 * `hasBoard` count resolved images and surfacing drop warnings, already
 * landed in that repo): writer images travel as BASE64 resolved by
 * Platform, never as a URL the runner must fetch. Platform already reads
 * these bytes server-side for the crop case (brand-imagery-proxy.ts's
 * `cropToImageRef`); this endpoint asks for that same treatment on EVERY
 * reference by passing `requireResolvedImages: true` — a reference with no
 * explicit crop is still read and re-encoded (the region defaults to the
 * whole frame) rather than handed to the model as a link, and a reference
 * that cannot be read is DROPPED and reported, never silently forgotten.
 *
 * WHAT THIS ENDPOINT DOES, deterministically:
 *   1. look up the standard (`standardId` only ever names an existing
 *      `visual_standard` — never trusted for anything else);
 *   2. read its OWN `references[]` (the mood board), its current
 *      `brandImagery` (so the writer REVISES the contract in force rather
 *      than starting fresh) and its `kind` (house vs template, the writer's
 *      `mode`) directly off the record — never through CMS-Agent's
 *      `visual_standard_id` hydration path, because that hydration
 *      (mcp-tool-handlers.ts's `toBrandImageryReferenceFromStandardRecord`)
 *      deliberately drops each reference's `id`, and this endpoint needs it
 *      to name a dropped image in `warnings`;
 *   2b. TRUNCATE that board to `BRAND_IMAGERY_MAX_REFERENCES` (8, the node
 *      runner's own imageRefs ceiling) and say so in `warnings`. Supplying
 *      `references` ourselves means skipping the truncation the hydration
 *      path does, and `validateBrandImageryProposeInput` refuses a longer
 *      list outright — so before W5 F1 every board over 8 references (a
 *      board holds up to 24) got a flat 400 instead of a proposal;
 *   3. call `proposeBrandImagery` (brand-imagery-proxy.ts — the SAME module
 *      the `brand_imagery_propose` MCP tool calls, never a second copy of
 *      its validation/CMS-Agent/schema logic) with those references and
 *      `requireResolvedImages: true`;
 *   4. translate the index-based `unresolvedReferences` it returns back into
 *      `ref_<id>`-keyed `warnings` (`image_dropped:<id>`), using the fact
 *      that `proposeBrandImagery` resolves `references` in the order it was
 *      given — the same order this endpoint read them off the record.
 *
 * Zero readable references and no brief is refused as 422
 * `no_images_reached_writer` — `proposeBrandImagery` raises this itself
 * (guarded by `requireResolvedImages`) before ever calling CMS-Agent, so a
 * mood board of entirely-unreadable images never spends a model call
 * producing a proposal from nothing. Supplying a `brief` bypasses this: the
 * writer can still work from words alone.
 *
 * IT PROPOSES; IT DOES NOT WRITE. `visual_identity_propose` is read-only by
 * contract ("no object is created, patched, applied or published") and so is
 * this endpoint. ACCEPTING the proposal — writing `brandImagery`,
 * `sampleSubjects` and `label` onto the standard — is an ordinary
 * `set_visual_standard_fields` patch the tab makes through `admin-object.ts`
 * under a checkout (`buildAcceptProposalOp`,
 * visual-identity-propose-client.ts), the same governed browser write path the
 * mood board itself saves through. Until W5 F2 nothing performed that step at
 * all, so the proposal was rendered on a card and thrown away.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import type { Role } from '../lib/roles.js';
import { getSiteObjectsBlobStore, getArtifactBlobStore } from '../lib/blob-store.js';
import {
  handleObjectVerb,
  objectVerbRequestSchema,
  type ObjectVerbResult,
  type ObjectVerbStore,
} from '../lib/object-verbs.js';
import { CmsAgentClient, isCmsAgentConfigured } from '../lib/agent/cms-agent-client.js';
import {
  BRAND_IMAGERY_MAX_REFERENCES,
  proposeBrandImagery,
  type BrandImageryProposeInput,
  type BrandImageryReferenceInput,
  type BrandImageryRegion,
} from '../lib/brand-imagery-proxy.js';
import { publicPathForArtifactRef } from '../lib/artifact-trust.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import type { Principal } from '../../schema/object-record-v1.js';

/**
 * Ordinary editorial work on a DRAFT artifact, not a publish — same gate as
 * `admin-visual-identity-import`'s `IMPORT_ROLES` (plugin-install.ts's
 * `INSTALL_ROLES` shape: "any role that can change content"). Applying a
 * standard to the site stays Owner-gated in object-verbs.ts, a different
 * verb this endpoint never touches.
 */
const PROPOSE_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'publisher', 'editor']);

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
  region?: BrandImageryRegion;
  note?: string;
  weight?: number;
};

const readStoredReferences = (body: unknown): StoredReference[] => {
  const references = isRecord(body) ? body.references : undefined;
  if (!Array.isArray(references)) return [];
  return references.filter(
    (entry): entry is StoredReference =>
      isRecord(entry) && typeof entry.id === 'string' && typeof entry.blobKey === 'string'
  );
};

const readMode = (body: unknown): 'house' | 'template' | undefined => {
  const kind = isRecord(body) ? body.kind : undefined;
  return kind === 'house' || kind === 'template' ? kind : undefined;
};

/**
 * One client per process, same lifetime/reuse posture as
 * mcp-tool-handlers.ts's module-level `brandImageryCmsAgentClient` — this
 * endpoint is a separate call path (a direct admin request, never a chat
 * tool call) and keeps its own session/agent-ref cache rather than reaching
 * into that module's.
 */
const cmsAgentClient = new CmsAgentClient();

export type AdminVisualIdentityProposeOptions = {
  /** Test seam: a stand-in CmsAgentClient. Production uses the real bridge. */
  cmsAgent?: { callTool: CmsAgentClient['callTool'] };
};

const buildHandlerImpl =
  (_binding: SiteBinding, options: AdminVisualIdentityProposeOptions = {}) =>
  async (event: LambdaEvent, context?: LambdaContext) => {
    if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

    const access = await resolveAdminAccessFromEvent(event, context);
    if (!access.authenticated) return jsonResponse(401, { error: access.error ?? 'Authentication is required.' });
    if (!access.roles.some((role) => PROPOSE_ROLES.has(role))) {
      return jsonResponse(403, {
        error: `${access.email ?? 'This account'} has no editing role on this publication, so it cannot propose an imagery contract. Ask the owner for editor or publisher.`,
      });
    }

    const payload = parseBody(event);
    if (!isRecord(payload)) return jsonResponse(400, { error: 'Invalid request body.' });

    const standardId = text(payload.standardId);
    if (!standardId) return jsonResponse(400, { error: 'standardId is required.' });
    const brief = text(payload.brief)?.slice(0, 4000);

    if (!isCmsAgentConfigured() && !options.cmsAgent) {
      return jsonResponse(502, { error: 'The workspace orchestration bridge is not configured for this site.' });
    }

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
      const recordBody = (read.body.record as Record<string, unknown>).body;
      const board = readStoredReferences(recordBody);
      const mode = readMode(recordBody) ?? 'template';

      // W5 F1: a mood board holds up to MOOD_BOARD_MAX_REFERENCES (24) but the
      // node runner's imageRefs cap — and therefore
      // `validateBrandImageryProposeInput` — is BRAND_IMAGERY_MAX_REFERENCES
      // (8), a hard 400. Passing `references` OURSELVES (which this endpoint
      // must, to keep each entry's `ref_` id for the warnings below) skips the
      // truncation `hydrateFromVisualStandard` does for the
      // `visual_standard_id`-only path, so a 9-reference board was refused
      // outright instead of proposing from its first 8. Truncate here, on the
      // SAME slice `ids` is taken from, and say so in `warnings` — a silent
      // truncation would be the other half of the bug this endpoint exists to
      // close.
      const stored = board.slice(0, BRAND_IMAGERY_MAX_REFERENCES);
      const truncated = board.length - stored.length;

      // Order matters: proposeBrandImagery resolves `references` in the
      // order it is given, and its `unresolvedReferences` are positions into
      // that SAME array — so `ids[index]` below is how a dropped image gets
      // named in `warnings`, never re-derived or re-matched by blobKey.
      const ids = stored.map((reference) => reference.id);
      const references: BrandImageryReferenceInput[] = stored.map((reference) => ({
        blobKey: reference.blobKey,
        ...(reference.region ? { region: reference.region } : {}),
        ...(reference.note ? { note: reference.note } : {}),
        ...(reference.weight !== undefined ? { weight: reference.weight } : {}),
      }));

      // W5 F2: the standard's CURRENT contract, so the writer revises it
      // rather than starting fresh every time. The `visual_standard_id`
      // hydration path supplies this itself; a caller that passes its own
      // `references` (as this endpoint must) gets no hydration at all, so
      // every propose on a standard that already had a contract silently
      // ignored it.
      const existingBrandImagery = isRecord(recordBody) ? recordBody.brandImagery : undefined;

      const proposeInput: BrandImageryProposeInput = {
        projectId: getSiteIdentity().cmsAgentProjectId,
        mode,
        visualStandardId: standardId,
        ...(references.length > 0 ? { references } : {}),
        ...(brief ? { brief } : {}),
        ...(existingBrandImagery !== undefined ? { existingBrandImagery } : {}),
      };

      const baseUrl = (process.env.URL ?? '').replace(/\/+$/, '');
      const artifactStore = (await getArtifactBlobStore(event)) as unknown as {
        get: (key: string, options: { type: 'arrayBuffer' }) => Promise<ArrayBuffer | null>;
      };

      const result = await proposeBrandImagery(proposeInput, {
        cmsAgent: options.cmsAgent ?? cmsAgentClient,
        resolveBlobUrl: (blobKey) => `${baseUrl}${publicPathForArtifactRef(blobKey)}`,
        readBlobBytes: async (blobKey) => {
          try {
            const raw = await artifactStore.get(blobKey, { type: 'arrayBuffer' });
            return raw ? Buffer.from(raw) : undefined;
          } catch {
            return undefined;
          }
        },
        requireResolvedImages: true,
        log: event.log,
      });

      if (!result.ok) {
        return jsonResponse(result.status, {
          error: result.error,
          error_code: result.errorCode,
          ...(result.detail ?? {}),
        });
      }

      const { unresolvedReferences: droppedIndexes, ...proposal } = result.body as Record<string, unknown> & {
        unresolvedReferences?: number[];
      };
      const dropped = Array.isArray(droppedIndexes) ? droppedIndexes : [];
      const warnings = [
        ...dropped.map((index) => `image_dropped:${ids[index] ?? `index_${index}`}`),
        // W5 F1: machine-shaped like `image_dropped:<id>` so the card can read
        // both the same way — "the writer saw the first 8 of your 12".
        ...(truncated > 0 ? [`references_truncated:${stored.length}_of_${board.length}`] : []),
      ];

      const resolvedCount = references.length - dropped.length;
      event.log?.({
        event: 'visual_standard_proposed',
        siteId: getSiteIdentity().siteId,
        standardId,
        mode,
        referencesTotal: board.length,
        referencesSent: references.length,
        referencesResolved: resolvedCount,
        ...(truncated > 0 ? { referencesTruncated: truncated } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      });

      return jsonResponse(200, {
        standard_id: standardId,
        mode,
        // The WHOLE board is the honest denominator: `references_resolved` of
        // `references_total` is what "reached the writer", truncation included.
        references_total: board.length,
        references_sent: references.length,
        references_resolved: resolvedCount,
        warnings,
        proposal,
      });
    } catch (error) {
      console.error('Visual identity contract propose failed.', error);
      return jsonResponse(500, { error: 'The imagery contract could not be proposed.' });
    }
  };

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding, options?: AdminVisualIdentityProposeOptions) =>
  buildHandlerImpl(binding, options);
