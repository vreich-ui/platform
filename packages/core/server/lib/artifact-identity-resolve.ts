/**
 * T-ASSET-IDENTITY Part 3 — typed search/resolve for the three asset kinds
 * the plan names: a tenant-owned CAPTURE ARTIFACT, general STORED MEDIA, and
 * a CONTENT-LINKED ASSET (an article's implicit media).
 *
 * Every resolution reports checksum, source, ownership, tags and
 * public/render-reference evidence EXPLICITLY — each field is either
 * `{ present: true, value }` with its real value, or `{ present: false,
 * reason }`. Nothing here invents a value:
 *
 *   - `source` is reported ONLY when it was actually retained. Platform does
 *     not persist `sourceUrl` on `ArtifactReference` at all (see
 *     artifacts.ts's `allowedArtifactReferenceKeys` — there is no such key),
 *     so unless a caller stashed it under `metadata.sourceUrl` at write time,
 *     source comes back explicitly absent — never guessed from the blobKey,
 *     the label, or a template.
 *   - `publicReference` is computed ONLY via artifact-trust.ts's
 *     `publicPathForArtifactRef`, the single canonical blobKey -> public-path
 *     mapping already used by the renderer and the trust bridge, and ONLY
 *     for the two kinds (`image`, `pdf`) that mapping actually covers. No
 *     other code path here may synthesize a public URL — see
 *     artifact-identity-resolve.test.ts's "never invents a public URL" case.
 *   - a capture request id is NEVER treated as a content_item id by renaming
 *     a parameter. Ownership for `capture_artifact` and `stored_media`
 *     resolves ONLY through the explicit `request-owner` pointer
 *     (artifact-index.ts, the CMS-Agent PR #308 / Platform W1 T1.3 contract).
 *     The historical "the request id IS the content_item id" fallback is
 *     reachable ONLY when the caller explicitly asks for
 *     `assetKind: 'content_linked_asset'` — it is gated on that literal
 *     union member, never on a boolean flag or a renamed field a caller
 *     could set to reach the same branch from a capture request.
 *   - image identity comes from this recorded metadata, or from an explicit
 *     caller selection (`expectedSha256`) — never from analyzing the image's
 *     pixel content. This module has no image-decoding or face-matching
 *     dependency, and must never grow one.
 */
import {
  listArtifactReferencesForRequest,
  readRequestOwner,
  type ArtifactIndexStore,
  type ArtifactRequestOwner,
} from './artifact-index.js';
import type { ArtifactReference } from './artifacts.js';
import { publicPathForArtifactRef } from './artifact-trust.js';

export const ASSET_KINDS = ['capture_artifact', 'stored_media', 'content_linked_asset'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** Kinds whose blobKey the public /img|/pdf redirect actually covers (artifact-trust.ts). */
const PUBLICLY_RENDERABLE_KINDS = new Set(['image', 'pdf']);

export type EvidenceField<T> = { present: true; value: T } | { present: false; reason: string };

export type AssetOwnershipEvidence = {
  object_type: string;
  object_id: string;
  site: string;
  basis: 'registered_owner' | 'implicit_content_item';
};

export type AssetIdentityEvidence = {
  checksum: EvidenceField<string>;
  source: EvidenceField<string>;
  ownership: EvidenceField<AssetOwnershipEvidence>;
  tags: EvidenceField<string[]>;
  publicReference: EvidenceField<string>;
};

export type AssetIdentityMatch = {
  assetKind: AssetKind;
  requestId: string;
  sha256: string;
  blobKey: string;
  artifactKind: string;
  evidence: AssetIdentityEvidence;
};

export type ResolveAssetIdentityInput = {
  assetKind: AssetKind;
  requestId: string;
  /** Narrows to one artifact under the request; a mismatch REFUSES, it does not just filter to zero. */
  expectedSha256?: string;
  /** The CALLER's own tenant site id, from server-verified identity/config — never caller-declared. */
  callerSiteId: string;
};

export type ResolveAssetIdentityResult =
  | { status: 'resolved'; match: AssetIdentityMatch }
  | { status: 'shortlist'; matches: AssetIdentityMatch[] }
  | { status: 'not_found'; requestId: string; assetKind: AssetKind }
  | { status: 'refused'; reason: 'cross_tenant' | 'checksum_mismatch'; detail: string };

export type ResolveAssetIdentityDeps = {
  indexStore: ArtifactIndexStore;
  /**
   * `content_linked_asset` only: does a content_item with this id actually
   * exist (and is it active)? Injected so this module stays pure and
   * store-agnostic, and so existence is never merely assumed — omit it (or
   * have it resolve false) and implicit ownership stays explicitly absent
   * rather than asserted.
   */
  contentItemExists?: (objectId: string) => Promise<boolean>;
};

const evidenceForSourceUrl = (reference: ArtifactReference): EvidenceField<string> => {
  const sourceUrl =
    reference.metadata && typeof reference.metadata.sourceUrl === 'string' ? reference.metadata.sourceUrl : undefined;

  if (sourceUrl) return { present: true, value: sourceUrl };

  return {
    present: false,
    reason:
      'Platform does not persist sourceUrl on ArtifactReference; it is retained only when the writer recorded it under metadata.sourceUrl at upload time.',
  };
};

const evidenceForTags = (reference: ArtifactReference): EvidenceField<string[]> =>
  reference.tags && reference.tags.length > 0
    ? { present: true, value: reference.tags }
    : { present: false, reason: 'No tags were recorded on this artifact.' };

const evidenceForPublicReference = (reference: ArtifactReference): EvidenceField<string> => {
  const kind = reference.artifactKind ?? reference.blobKey.split('/')[0];
  if (!kind || !PUBLICLY_RENDERABLE_KINDS.has(kind)) {
    return {
      present: false,
      reason: `Artifact kind "${kind ?? 'unknown'}" has no public render path — only image and pdf artifacts resolve to a /img or /pdf public path.`,
    };
  }

  // The ONLY legal derivation: artifact-trust.ts's canonical mapping. Never
  // string-templated here directly, so this call site cannot silently drift
  // from the renderer's own rule.
  return { present: true, value: publicPathForArtifactRef(reference.blobKey) };
};

const evidenceForOwnership = (
  owner: ArtifactRequestOwner | undefined,
  implicitContentItem: { objectId: string; exists: boolean } | undefined
): EvidenceField<AssetOwnershipEvidence> => {
  if (owner) {
    return {
      present: true,
      value: {
        object_type: owner.object_type,
        object_id: owner.object_id,
        site: owner.site,
        basis: 'registered_owner',
      },
    };
  }

  if (implicitContentItem?.exists) {
    return {
      present: true,
      value: {
        object_type: 'content_item',
        object_id: implicitContentItem.objectId,
        site: '',
        basis: 'implicit_content_item',
      },
    };
  }

  if (implicitContentItem && !implicitContentItem.exists) {
    return {
      present: false,
      reason: `No content_item with id "${implicitContentItem.objectId}" exists (or it is not active) — implicit ownership is never assumed for a request id that is not a real, active content_item.`,
    };
  }

  return {
    present: false,
    reason:
      'No request-owner pointer is registered for this request id. Register one explicitly (artifact_request_register_owner) or run legacy ownership adoption.',
  };
};

const toMatch = (
  assetKind: AssetKind,
  requestId: string,
  reference: ArtifactReference,
  owner: ArtifactRequestOwner | undefined,
  implicitContentItem: { objectId: string; exists: boolean } | undefined
): AssetIdentityMatch => ({
  assetKind,
  requestId,
  sha256: reference.sha256,
  blobKey: reference.blobKey,
  artifactKind: reference.artifactKind ?? reference.blobKey.split('/')[0] ?? 'other',
  evidence: {
    checksum: { present: true, value: reference.sha256 },
    source: evidenceForSourceUrl(reference),
    ownership: evidenceForOwnership(owner, implicitContentItem),
    tags: evidenceForTags(reference),
    publicReference: evidenceForPublicReference(reference),
  },
});

/**
 * Resolve a typed asset identity for one of the three named kinds.
 *
 * Outcome shape (never collapsed to a bare list):
 *   - `not_found`   — the request id has no live artifacts at all.
 *   - `refused`     — the request id DOES resolve to something, but either
 *                      it belongs to a different tenant (`cross_tenant`) or
 *                      an `expectedSha256` was supplied and nothing under
 *                      this request matches it (`checksum_mismatch`). Both
 *                      are distinct from `not_found`: something real exists,
 *                      it is simply not what — or whose — the caller asked
 *                      for.
 *   - `shortlist`   — more than one artifact matches (no `expectedSha256`
 *                      narrowed it to one); the caller must pick, this
 *                      module never guesses.
 *   - `resolved`    — exactly one match.
 */
export const resolveAssetIdentity = async (
  deps: ResolveAssetIdentityDeps,
  input: ResolveAssetIdentityInput
): Promise<ResolveAssetIdentityResult> => {
  const requestId = input.requestId.trim();
  const allReferences = await listArtifactReferencesForRequest(deps.indexStore, requestId);

  if (allReferences.length === 0) {
    return { status: 'not_found', requestId, assetKind: input.assetKind };
  }

  const owner = await readRequestOwner(deps.indexStore, requestId);

  // Cross-tenant refusal checked BEFORE checksum matching, so a cross-tenant
  // probe cannot be used to fish for which checksums exist under a request
  // this caller does not own.
  if (owner && owner.site !== input.callerSiteId) {
    return {
      status: 'refused',
      reason: 'cross_tenant',
      detail: `Request "${requestId}" is owned by ${owner.object_type} ${owner.object_id} on site "${owner.site}", not "${input.callerSiteId}".`,
    };
  }

  const expectedSha256 = input.expectedSha256?.trim().toLowerCase();
  const candidates = expectedSha256
    ? allReferences.filter((reference) => reference.sha256.toLowerCase() === expectedSha256)
    : allReferences;

  if (expectedSha256 && candidates.length === 0) {
    return {
      status: 'refused',
      reason: 'checksum_mismatch',
      detail: `Request "${requestId}" has ${allReferences.length} live artifact(s), but none has sha256 "${expectedSha256}".`,
    };
  }

  // The ONLY place `content_linked_asset`'s implicit-ownership fallback is
  // reachable — gated on the literal asset-kind union member, never on a
  // renamed parameter or a boolean a caller could flip from a capture
  // request to reach the same branch.
  let implicitContentItem: { objectId: string; exists: boolean } | undefined;
  if (input.assetKind === 'content_linked_asset' && !owner) {
    const exists = deps.contentItemExists ? await deps.contentItemExists(requestId) : false;
    implicitContentItem = { objectId: requestId, exists };
  }

  const matches = candidates.map((reference) =>
    toMatch(input.assetKind, requestId, reference, owner, implicitContentItem)
  );

  return matches.length === 1 ? { status: 'resolved', match: matches[0] } : { status: 'shortlist', matches };
};
