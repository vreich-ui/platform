/**
 * T-ASSET-IDENTITY Part 4 — legacy asset ownership reconciliation.
 *
 * PR #308 (CMS-Agent, merged as e5f69b2) produces `owner: { object_type:
 * 'page', object_id }` on newly captured artifacts, and Platform already has
 * a consumer for exactly that shape: the `owner` argument on every artifact
 * WRITE tool (`artifactRequestOwnerJsonSchema`, mcp-tool-definitions.ts,
 * W1 T1.3) forwards it to `writeRequestOwner` (artifact-index.ts), which
 * stamps `request-owner/<requestId>.json`. That is the ONE ownership scheme
 * — this module does not create a second one, it only backfills it for
 * requests that predate it.
 *
 * For an asset captured BEFORE that contract existed (no `request-owner`
 * pointer was ever written for its request id — the majority of a tenant's
 * pre-#308 media, per the live diagnosis), this derives the true owner from
 * RECORDED evidence only, via the SAME full-projection scan
 * `artifact_orphan_sweep` already uses (`collectReferencedArtifactKeys`,
 * artifact-dedupe-sweep.ts, W2 T2.7) — reused, not reinvented — and then
 * registers it through the identical `writeRequestOwner` call a fresh #308
 * capture would make.
 *
 * What this deliberately refuses to do:
 *   - it never assumes resuming a checkpointed capture writes missing
 *     ownership by itself — only an ACTUAL citing object counts as evidence;
 *   - a request with zero citing objects is a NAMED blocker
 *     (`no_recorded_evidence`), never a guessed owner;
 *   - more than one distinct citing object is a SHORTLIST
 *     (`ambiguous_evidence`), never an arbitrary pick;
 *   - it never treats page ownership as proof the asset is correctly bound
 *     into a PDF template — an adopted `page` owner is stamped
 *     `pageOwnershipOnly: true` so a caller cannot mistake "a page cites
 *     this artifact" for "a PDF template slot resolves it";
 *   - it is tenant-checked: `objectsStore`/`indexStore` are whatever this
 *     deployment's own site binding resolved them to (the same binding every
 *     other admin tool in this file uses via `getMcpBinding()`), so there is
 *     no cross-tenant scan and the written owner's `site` is always this
 *     tenant's own site id.
 */
import {
  listArtifactReferencesForRequest,
  readRequestOwner,
  writeRequestOwner,
  isArtifactRequestOwnerType,
  ARTIFACT_REQUEST_OWNER_TYPES,
  type ArtifactIndexStore,
  type ArtifactRequestOwnerType,
} from './artifact-index.js';
import {
  collectReferencedArtifactKeys,
  type ArtifactSweepListStore,
  type ArtifactReferenceSite,
} from './artifact-dedupe-sweep.js';

export type LegacyAdoptionBlocker =
  | 'already_owned'
  | 'no_live_artifacts'
  | 'no_recorded_evidence'
  | 'ambiguous_evidence';

export type LegacyAdoptionResult =
  | {
      status: 'adopted';
      requestId: string;
      owner: { object_type: ArtifactRequestOwnerType; object_id: string; site: string };
      evidence: ArtifactReferenceSite[];
      /** Never read as proof of PDF-template binding — see module doc. */
      pageOwnershipOnly: boolean;
    }
  | {
      status: 'blocked';
      requestId: string;
      blocker: LegacyAdoptionBlocker;
      detail: string;
      shortlist?: ArtifactReferenceSite[];
    };

export type AdoptLegacyArtifactOwnershipDeps = {
  indexStore: ArtifactIndexStore;
  objectsStore: ArtifactSweepListStore;
  /** This deployment's own site id — every written owner is stamped with exactly this, never a caller-supplied value. */
  site: string;
  registeredBy: string;
};

const siteKey = (site: ArtifactReferenceSite) => `${site.objectType}:${site.objectId}`;

export const adoptLegacyArtifactOwnership = async (
  deps: AdoptLegacyArtifactOwnershipDeps,
  requestId: string
): Promise<LegacyAdoptionResult> => {
  const trimmedRequestId = requestId.trim();

  const existingOwner = await readRequestOwner(deps.indexStore, trimmedRequestId);
  if (existingOwner) {
    return {
      status: 'blocked',
      requestId: trimmedRequestId,
      blocker: 'already_owned',
      detail: `Request "${trimmedRequestId}" is already owned by ${existingOwner.object_type} ${existingOwner.object_id} on "${existingOwner.site}". Adoption never re-points an existing owner — see writeRequestOwner's conflict rule.`,
    };
  }

  const references = await listArtifactReferencesForRequest(deps.indexStore, trimmedRequestId);
  if (references.length === 0) {
    return {
      status: 'blocked',
      requestId: trimmedRequestId,
      blocker: 'no_live_artifacts',
      detail: `Request "${trimmedRequestId}" has no live artifact references to adopt ownership for.`,
    };
  }

  // The same full-projection "which active objects of ANY type cite this
  // blobKey" scan artifact_orphan_sweep already runs — evidence, not a guess.
  const referencedByObjects = await collectReferencedArtifactKeys(deps.objectsStore);
  const citingSites = new Map<string, ArtifactReferenceSite>();
  for (const reference of references) {
    for (const site of referencedByObjects.get(reference.blobKey) ?? []) {
      citingSites.set(siteKey(site), site);
    }
  }

  const shortlist = [...citingSites.values()].sort((left, right) =>
    left.objectType === right.objectType
      ? left.objectId.localeCompare(right.objectId)
      : left.objectType.localeCompare(right.objectType)
  );

  if (shortlist.length === 0) {
    return {
      status: 'blocked',
      requestId: trimmedRequestId,
      blocker: 'no_recorded_evidence',
      detail:
        `No active object of any type cites any of the ${references.length} artifact(s) stored under request ` +
        `"${trimmedRequestId}". This request predates the ownership contract and carries no recorded capture/page ` +
        'evidence to derive an owner from. This is a named blocker, not a guess — an operator must register the ' +
        'owner explicitly (artifact_request_register_owner) if it is known by other means.',
    };
  }

  if (shortlist.length > 1) {
    return {
      status: 'blocked',
      requestId: trimmedRequestId,
      blocker: 'ambiguous_evidence',
      detail:
        `${shortlist.length} distinct active objects cite artifacts stored under request "${trimmedRequestId}" — ` +
        'ownership is ambiguous. Pick one from the shortlist and register it explicitly rather than guessing.',
      shortlist,
    };
  }

  const [{ objectType, objectId }] = shortlist;
  if (!isArtifactRequestOwnerType(objectType)) {
    return {
      status: 'blocked',
      requestId: trimmedRequestId,
      blocker: 'no_recorded_evidence',
      detail: `The only citing object is of type "${objectType}", which is not a valid artifact-request owner type (${ARTIFACT_REQUEST_OWNER_TYPES.join(', ')}). Refusing to adopt rather than mis-typing the pointer.`,
    };
  }

  const written = await writeRequestOwner(deps.indexStore, trimmedRequestId, {
    object_type: objectType,
    object_id: objectId,
    site: deps.site,
    registered_by: deps.registeredBy,
  });

  if (!written.ok) {
    return { status: 'blocked', requestId: trimmedRequestId, blocker: 'already_owned', detail: written.error };
  }

  return {
    status: 'adopted',
    requestId: trimmedRequestId,
    owner: { object_type: objectType, object_id: objectId, site: deps.site },
    evidence: shortlist,
    pageOwnershipOnly: objectType === 'page',
  };
};
