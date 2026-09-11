/**
 * W2 T2.6 / T2.7 — the two admin maintenance passes over the artifact plane.
 *
 * Both are pure store logic with every store INJECTED: the MCP envelopes (admin
 * gate, toolResult) live in `mcp-artifact-admin.ts`, and a test can drive these
 * against fixture maps without an MCP round trip. Neither function authenticates
 * anything — AUTHORIZATION IS THE CALLER'S JOB, exactly as in
 * `artifact-soft-delete.ts`.
 *
 * The law both obey, and the reason they are safe to run on a live tenant:
 *
 *   `blobKey` is IDENTITY and is never rewritten. It is what a published page's
 *   `src` cites through `/img/<requestId>/<sha>.<ext>`, what
 *   MAJOR_KEY_ARTIFACT_REF_RE matches, and what the trust index keys on. These
 *   passes only ever move BYTES and set `storageKey`, which is a read-side
 *   redirect (see ArtifactReference.storageKey). No public path changes.
 */
import {
  artifactShaIndexKey,
  listArtifactIndexKeys,
  repointArtifactByShaIndex,
  type ArtifactIndexStore,
} from './artifact-index.js';
import { artifactStorageKey, isArtifactReference, type ArtifactReference } from './artifacts.js';
import {
  countLiveReferencesForStorageKey,
  writeArtifactReferenceForAdminMutation,
  type ArtifactByteStore,
} from './artifact-soft-delete.js';
import { MAJOR_KEY_ARTIFACT_REF_RE, PUBLIC_ARTIFACT_PATH_RE, rawArtifactRefForPublicPath } from './artifact-trust.js';
import { collectBlobListItems, type BlobListResponse } from './blob-list.js';
import { objectTypes } from '../../schema/object-record-v1.js';

export type ArtifactSweepListStore = {
  get: (key: string) => Promise<string | null>;
  list: (options?: {
    prefix?: string;
    directories?: boolean;
    paginate?: boolean;
  }) => Promise<BlobListResponse> | AsyncIterable<BlobListResponse>;
};

const parseJson = async (store: { get: (key: string) => Promise<string | null> }, key: string) => {
  const text = await store.get(key);
  if (!text) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const requestIdFromReferenceKey = (key: string) => {
  const segment = key.split('/')[1];
  if (!segment) return '';

  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const shaFromReferenceKey = (key: string) => (key.split('/').pop() ?? '').replace(/\.json$/i, '').toLowerCase();

type LoadedReference = { key: string; requestId: string; sha256: string; reference: ArtifactReference };

const loadReferences = async (indexStore: ArtifactIndexStore, keys: string[]): Promise<LoadedReference[]> => {
  const loaded: LoadedReference[] = [];

  for (const key of keys) {
    const reference = await parseJson(indexStore, key);
    if (!isArtifactReference(reference)) continue;

    loaded.push({ key, requestId: requestIdFromReferenceKey(key), sha256: reference.sha256.toLowerCase(), reference });
  }

  return loaded;
};

const byteLengthOf = (value: ArrayBuffer | Buffer | string | null) => {
  if (value === null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value);

  return value.byteLength;
};

/** The artifact kind a reference belongs to, from the field or (legacy) from its key. */
const referenceKind = (reference: ArtifactReference): string =>
  reference.artifactKind ?? reference.blobKey.split('/')[0] ?? '';

// ─────────────────────────────────────────────────────────────────────────────
// T2.6  artifact_dedupe_by_sha
// ─────────────────────────────────────────────────────────────────────────────

export type ArtifactDedupeGroupReport = {
  sha256: string;
  artifactKind: string;
  /** The blob every reference in this group now points at — the OLDEST one. */
  keptStorageKey: string;
  /** References repointed at `keptStorageKey` (their blobKey is untouched). */
  referencesRepointed: number;
  requestIds: string[];
  blobsDeleted: string[];
  bytesFreed: number;
  /** Set when the group was left alone; the group is then a no-op. */
  skippedReason?: 'already-deduped' | 'keeper-bytes-unverified';
};

export type ArtifactDedupeResult = {
  dryRun: boolean;
  scanned: number;
  groups: number;
  blobsDeleted: number;
  bytesFreed: number;
  checkpoint: { cursor: string; nextCursor: string | null; processed: number; totalKeys: number };
  details: ArtifactDedupeGroupReport[];
};

/**
 * Collapse every group of live references that share a sha256 onto ONE blob.
 *
 * Idempotent by construction: a group whose references already resolve to a single
 * storage key is reported `already-deduped` and nothing is read, written or deleted.
 *
 * Cursor paging is over reference keys SORTED BY sha, and the page end is extended
 * until the sha changes — so a group is never split across two pages and a page can
 * never see only half of the references that share a blob. That is what makes the
 * delete safe: `countLiveReferencesForStorageKey` is consulted before every byte
 * removal anyway, but the paging guarantees it agrees.
 */
export const dedupeArtifactsBySha = async (
  indexStore: ArtifactIndexStore,
  artifactStore: ArtifactByteStore,
  options: { dryRun: boolean; artifactKind?: string; limit: number; cursor: number }
): Promise<ArtifactDedupeResult> => {
  const allKeys = await listArtifactIndexKeys(indexStore, 'request-artifacts/');
  const sorted = [...allKeys].sort((left, right) => {
    const shaCompare = shaFromReferenceKey(left).localeCompare(shaFromReferenceKey(right));
    return shaCompare !== 0 ? shaCompare : left.localeCompare(right);
  });

  let end = Math.min(options.cursor + options.limit, sorted.length);
  while (end < sorted.length && shaFromReferenceKey(sorted[end]) === shaFromReferenceKey(sorted[end - 1])) end += 1;

  const pageKeys = sorted.slice(options.cursor, end);
  const loaded = (await loadReferences(indexStore, pageKeys)).filter((entry) => !entry.reference.deletedAtISO);

  const groups = new Map<string, LoadedReference[]>();
  for (const entry of loaded) {
    if (options.artifactKind && referenceKind(entry.reference) !== options.artifactKind) continue;
    const group = groups.get(entry.sha256);
    if (group) group.push(entry);
    else groups.set(entry.sha256, [entry]);
  }

  const details: ArtifactDedupeGroupReport[] = [];
  let blobsDeleted = 0;
  let bytesFreed = 0;

  for (const [sha256, entries] of groups) {
    const artifactKind = referenceKind(entries[0].reference);
    const storageKeys = new Set(entries.map((entry) => artifactStorageKey(entry.reference)));

    if (storageKeys.size <= 1) {
      details.push({
        sha256,
        artifactKind,
        keptStorageKey: [...storageKeys][0] ?? '',
        referencesRepointed: 0,
        requestIds: entries.map((entry) => entry.requestId).sort(),
        blobsDeleted: [],
        bytesFreed: 0,
        skippedReason: 'already-deduped',
      });
      continue;
    }

    // The OLDEST blob wins: earliest createdAtISO among the references pointing at it,
    // ties broken lexicographically so two runs on the same store agree.
    const oldestByStorageKey = new Map<string, string>();
    for (const entry of entries) {
      const key = artifactStorageKey(entry.reference);
      const seen = oldestByStorageKey.get(key);
      if (!seen || entry.reference.createdAtISO < seen) oldestByStorageKey.set(key, entry.reference.createdAtISO);
    }
    const keptStorageKey = [...oldestByStorageKey.entries()].sort(
      (left, right) => left[1].localeCompare(right[1]) || left[0].localeCompare(right[0])
    )[0][0];

    // Never repoint onto bytes we have not confirmed are there and correct.
    const keeperBytes = await artifactStore.get(keptStorageKey, { type: 'arrayBuffer' });
    if (!keeperBytes || byteLengthOf(keeperBytes) !== entries[0].reference.sizeBytes) {
      details.push({
        sha256,
        artifactKind,
        keptStorageKey,
        referencesRepointed: 0,
        requestIds: entries.map((entry) => entry.requestId).sort(),
        blobsDeleted: [],
        bytesFreed: 0,
        skippedReason: 'keeper-bytes-unverified',
      });
      continue;
    }

    const repointed = entries.filter((entry) => artifactStorageKey(entry.reference) !== keptStorageKey);

    if (!options.dryRun) {
      for (const entry of repointed) {
        await writeArtifactReferenceForAdminMutation(indexStore, entry.requestId, {
          ...entry.reference,
          storageKey: keptStorageKey,
        });
      }

      await repointArtifactByShaIndex(indexStore, artifactKind, sha256, {
        storageKey: keptStorageKey,
        contentType: entries[0].reference.contentType,
        sizeBytes: entries[0].reference.sizeBytes,
        firstRequestId: requestIdFromReferenceKey(
          entries.find((entry) => entry.reference.blobKey === keptStorageKey)?.key ?? entries[0].key
        ),
        createdAtISO: entries[0].reference.createdAtISO,
      });
    }

    const groupBlobsDeleted: string[] = [];
    let groupBytesFreed = 0;

    for (const staleKey of [...storageKeys].filter((key) => key !== keptStorageKey).sort()) {
      const bytes = await artifactStore.get(staleKey, { type: 'arrayBuffer' });
      const size = byteLengthOf(bytes);
      if (!bytes) continue;

      if (options.dryRun) {
        groupBlobsDeleted.push(staleKey);
        groupBytesFreed += size;
        continue;
      }

      // Belt and braces: the references were just repointed, so this must be zero.
      // If it is not, something outside this page still needs the bytes — keep them.
      const refcount = await countLiveReferencesForStorageKey(indexStore, staleKey, sha256);
      if (refcount.liveReferences > 0) continue;

      await artifactStore.del(staleKey);
      groupBlobsDeleted.push(staleKey);
      groupBytesFreed += size;
    }

    blobsDeleted += groupBlobsDeleted.length;
    bytesFreed += groupBytesFreed;

    details.push({
      sha256,
      artifactKind,
      keptStorageKey,
      referencesRepointed: repointed.length,
      requestIds: entries.map((entry) => entry.requestId).sort(),
      blobsDeleted: groupBlobsDeleted,
      bytesFreed: groupBytesFreed,
    });
  }

  return {
    dryRun: options.dryRun,
    scanned: pageKeys.length,
    groups: details.length,
    blobsDeleted,
    bytesFreed,
    checkpoint: {
      cursor: String(options.cursor),
      nextCursor: end < sorted.length ? String(end) : null,
      processed: pageKeys.length,
      totalKeys: sorted.length,
    },
    details,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// T2.7  artifact_orphan_sweep
// ─────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

/**
 * Every artifact key cited anywhere in one object record, in EITHER form: the public
 * `/img|/pdf/<id>/<sha>.<ext>` path a renderable `src` must carry, and the raw
 * `image|pdf/<id>/<sha>.<ext>` Major Key the trusted `*AssetRef` fields hold. Both are
 * normalized to the raw key, which is what an ArtifactReference.blobKey is.
 *
 * A FULL walk of the record on purpose: an object's artifacts are spread across body
 * blocks, section props, slot blueprints, og images, portraits and template defaults,
 * and a field-by-field projection is exactly how a sweep starts deleting live media.
 */
export const collectArtifactRefsFromValue = (value: unknown, into = new Set<string>()): Set<string> => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (PUBLIC_ARTIFACT_PATH_RE.test(trimmed)) into.add(rawArtifactRefForPublicPath(trimmed));
    else if (MAJOR_KEY_ARTIFACT_REF_RE.test(trimmed)) into.add(trimmed);
    return into;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectArtifactRefsFromValue(item, into);
    return into;
  }

  if (isRecord(value)) {
    for (const item of Object.values(value)) collectArtifactRefsFromValue(item, into);
  }

  return into;
};

export type ArtifactReferenceSite = { objectType: string; objectId: string };

/**
 * Scan EVERY active object of EVERY object type, full projection, and return
 * blobKey -> the objects citing it.
 */
export const collectReferencedArtifactKeys = async (
  objectsStore: ArtifactSweepListStore
): Promise<Map<string, ArtifactReferenceSite[]>> => {
  const referenced = new Map<string, ArtifactReferenceSite[]>();

  for (const objectType of objectTypes) {
    const listed = await objectsStore.list({
      prefix: `objects/${objectType}/index/by-status/active/`,
      directories: false,
      paginate: true,
    });
    const items = await collectBlobListItems(listed as BlobListResponse);

    for (const item of items) {
      const objectId = item.key.split('/').pop() ?? '';
      if (!objectId) continue;

      const record = await parseJson(objectsStore, `objects/${objectType}/by-id/${objectId}.json`);
      if (record === undefined) continue;

      for (const blobKey of collectArtifactRefsFromValue(record)) {
        const sites = referenced.get(blobKey);
        if (sites) sites.push({ objectType, objectId });
        else referenced.set(blobKey, [{ objectType, objectId }]);
      }
    }
  }

  return referenced;
};

/**
 * Slot pointers in the artifact-index store (`by-slot/...`), when a deployment has
 * them. Platform's own by-slot resolution lives in pdf-tool today, so this is usually
 * empty — it is here so a store that DOES carry them is not swept out from under.
 */
export const collectSlotPointerArtifactKeys = async (indexStore: ArtifactIndexStore): Promise<Set<string>> => {
  const keys = await listArtifactIndexKeys(indexStore, 'by-slot/');
  const referenced = new Set<string>();

  for (const key of keys) {
    const pointer = await parseJson(indexStore, key);
    collectArtifactRefsFromValue(pointer, referenced);

    if (isRecord(pointer) && typeof pointer.requestId === 'string' && typeof pointer.sha256 === 'string') {
      // A {requestId, sha256} pointer names an artifact without spelling its key out.
      const reference = await parseJson(
        indexStore,
        `request-artifacts/${encodeURIComponent(pointer.requestId)}/${pointer.sha256.toLowerCase()}.json`
      );
      if (isArtifactReference(reference)) referenced.add(reference.blobKey);
    }
  }

  return referenced;
};

export type OrphanCandidate = {
  requestId: string;
  sha256: string;
  blobKey: string;
  storageKey: string;
  sizeBytes: number;
  createdAtISO: string;
  artifactKind: string;
};

export type DanglingReference = {
  blobKey: string;
  /** The active objects citing an artifact that has no live reference behind it. */
  citedBy: ArtifactReferenceSite[];
};

export type ArtifactOrphanSweepResult = {
  dryRun: boolean;
  scanned: number;
  referencedKeys: number;
  orphans: number;
  softDeleted: number;
  /** Orphan candidates grouped by the request that owns them. */
  byRequest: Array<{ requestId: string; count: number; artifacts: OrphanCandidate[] }>;
  /** REPORTED, NEVER FIXED — see the note on the sweep itself. */
  dangling: DanglingReference[];
  checkpoint: { cursor: string; nextCursor: string | null; processed: number; totalKeys: number };
};

/**
 * Soft-delete every live artifact reference that no active object and no slot pointer
 * cites. Bytes are NOT touched: this is a soft delete, and a restore must stay possible.
 *
 * Dangling references — an active object citing an artifact that does not exist — are
 * REPORTED, never "fixed". A sweep that edited object bodies to drop a broken `src`
 * would be destroying the only evidence of the real defect (a lost upload, a bad
 * migration) and rewriting governed content behind the operator's back. The report is
 * the deliverable; the repair is a human decision.
 *
 * `dryRun` defaults true at the verb boundary; this core takes it explicitly.
 */
export const sweepOrphanArtifacts = async (
  indexStore: ArtifactIndexStore,
  objectsStore: ArtifactSweepListStore,
  options: {
    dryRun: boolean;
    requestPrefix?: string;
    olderThan?: string;
    deletedBy: string;
    limit: number;
    cursor: number;
  }
): Promise<ArtifactOrphanSweepResult> => {
  const [referencedByObjects, slotReferenced] = await Promise.all([
    collectReferencedArtifactKeys(objectsStore),
    collectSlotPointerArtifactKeys(indexStore),
  ]);

  const referenced = new Set<string>([...referencedByObjects.keys(), ...slotReferenced]);

  const allKeys = await listArtifactIndexKeys(indexStore, 'request-artifacts/');
  const scoped = options.requestPrefix
    ? allKeys.filter((key) => requestIdFromReferenceKey(key).startsWith(options.requestPrefix as string))
    : allKeys;

  const pageKeys = scoped.slice(options.cursor, options.cursor + options.limit);
  const loaded = (await loadReferences(indexStore, pageKeys)).filter((entry) => !entry.reference.deletedAtISO);

  const candidates: OrphanCandidate[] = [];
  const liveKeysOnPage = new Set<string>();

  for (const entry of loaded) {
    liveKeysOnPage.add(entry.reference.blobKey);

    if (referenced.has(entry.reference.blobKey)) continue;
    if (options.olderThan && entry.reference.createdAtISO >= options.olderThan) continue;

    candidates.push({
      requestId: entry.requestId,
      sha256: entry.sha256,
      blobKey: entry.reference.blobKey,
      storageKey: artifactStorageKey(entry.reference),
      sizeBytes: entry.reference.sizeBytes,
      createdAtISO: entry.reference.createdAtISO,
      artifactKind: referenceKind(entry.reference),
    });
  }

  let softDeleted = 0;
  if (!options.dryRun) {
    const deletedAtISO = new Date().toISOString();

    for (const entry of loaded) {
      if (!candidates.some((candidate) => candidate.blobKey === entry.reference.blobKey)) continue;

      await writeArtifactReferenceForAdminMutation(indexStore, entry.requestId, {
        ...entry.reference,
        deletedAtISO,
        deletedBy: options.deletedBy,
      });
      softDeleted += 1;
    }
  }

  // Dangling: cited by an active object, but the index has no live reference for it.
  // Only asserted for keys whose owning request is on THIS page, so paging cannot
  // manufacture false alarms about references it has not looked at.
  const pageRequestIds = new Set(loaded.map((entry) => entry.requestId));
  const dangling: DanglingReference[] = [];

  for (const [blobKey, citedBy] of referencedByObjects) {
    const ownerRequestId = blobKey.split('/')[1] ?? '';
    if (!pageRequestIds.has(ownerRequestId)) continue;
    if (liveKeysOnPage.has(blobKey)) continue;

    dangling.push({ blobKey, citedBy });
  }

  const byRequest = [...new Map(candidates.map((candidate) => [candidate.requestId, candidate.requestId])).keys()]
    .sort()
    .map((requestId) => {
      const artifacts = candidates.filter((candidate) => candidate.requestId === requestId);
      return { requestId, count: artifacts.length, artifacts };
    });

  return {
    dryRun: options.dryRun,
    scanned: pageKeys.length,
    referencedKeys: referenced.size,
    orphans: candidates.length,
    softDeleted,
    byRequest,
    dangling: dangling.sort((left, right) => left.blobKey.localeCompare(right.blobKey)),
    checkpoint: {
      cursor: String(options.cursor),
      nextCursor: options.cursor + pageKeys.length < scoped.length ? String(options.cursor + pageKeys.length) : null,
      processed: pageKeys.length,
      totalKeys: scoped.length,
    },
  };
};

/** Re-exported so the MCP envelope does not need a second import path. */
export { artifactShaIndexKey };
