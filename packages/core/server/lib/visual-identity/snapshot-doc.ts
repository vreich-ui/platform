/**
 * M3.3 — `snapshots/visual-identity.json`: the ONE document behind the
 * `/admin/settings/visual-identity` read, and the only module in the server
 * tree that names its key (`KEY_HELPERS` in
 * `tests/netlify/object-inventory-index.test.ts` fails the build otherwise).
 *
 * INTEGRATION (wave 2): this milestone shipped its own copy of
 * `objects/index-doc.ts`'s alarm plumbing plus a SECOND blob,
 * `snapshots/visual-identity.version`, to carry the alarm. M3.1 and M3.2
 * shipped `snapshots/guarded-doc.ts` — the same mechanism, generalised, with
 * the alarm INSIDE the document. The three are converged here on
 * `guarded-doc.ts`, and the `.version` blob is gone. Two reasons, in order:
 *
 *  1. READ COST. This surface's acceptance is ONE blob read; a second document
 *     is a second ~150-250 ms round trip on the page path, and it buys nothing
 *     a reader can use — `armed` inside the payload answers "may I trust this?"
 *     in the same read that fetches the rows. The write path gets the saving
 *     twice over: the record-write choke point's arm was reading BOTH blobs
 *     before it could take the lease, and now reads one.
 *  2. ONE MECHANISM. Two arm/commit implementations of the same law is two
 *     places for the sticky-flag reasoning to drift, and `guarded-doc.ts` is
 *     the one with the law written down.
 *
 * What the `.version` blob did buy, and what converging costs: its seq could
 * DISAGREE with the snapshot's, so a rebuild that stamped the seq it read
 * before listing left a detectable mismatch when a writer committed underneath
 * it. With the alarm inside the document there is nothing left to disagree
 * with, so a rebuild whose sweep is overtaken by a completed write can publish
 * stale rows that read as trusted. That is not a regression this convergence
 * introduces so much as one it joins: `objects/index-store.ts` has had exactly
 * this race since M0, and chats and members inherited it from `guarded-doc.ts`.
 * Recorded once, for all four, as `KNOWN_ISSUES.md` #74.
 *
 * Split from `snapshot-store.ts` exactly as `objects/index-doc.ts` is split
 * from `index-store.ts`, and for a reason `function-bundle-budget` makes
 * concrete: the record-write choke point amends this snapshot, and
 * `membership/offboarding.ts` is a choke-point caller, so a module that also
 * reached `store.list()` and the rebuild would land all of it in
 * `admin-users`' cold start for code it can never execute.
 *
 * Every decision behind the DOCUMENT — what the seventeen calls were, why the
 * alarm is armed before the record, why the ledger is the one thing dropped
 * from a stored record, what each interrupted write leaves behind — is stated
 * once, in `snapshot-store.ts`'s header and `snapshots/guarded-doc.ts`'s
 * before it. This file is the key and the I/O.
 */
import { z } from 'zod';

import {
  armGuardedDoc,
  commitGuardedDoc,
  parseGuardedDoc,
  readBlobWithEtag,
  writeRebuiltDoc,
  type GuardedDocIo,
  type GuardedLease,
  type GuardedWriteResult,
} from '../snapshots/guarded-doc.js';
import type { ObjectIndexDocStore } from '../objects/index-doc.js';
import type { ObjectRecord, ObjectType } from '../../../schema/object-record-v1.js';

export const VISUAL_IDENTITY_OBJECT_TYPES = ['template', 'section_template', 'theme', 'visual_standard'] as const;
export type VisualIdentityObjectType = (typeof VISUAL_IDENTITY_OBJECT_TYPES)[number];

export const isVisualIdentityObjectType = (objectType: ObjectType): objectType is VisualIdentityObjectType =>
  (VISUAL_IDENTITY_OBJECT_TYPES as readonly string[]).includes(objectType);

export const VISUAL_IDENTITY_SNAPSHOT_KEY = 'snapshots/visual-identity.json';
export const VISUAL_IDENTITY_SNAPSHOT_SCHEMA_VERSION = 'visual-identity-snapshot.v1';

const snapshotEntrySchema = z.object({
  /** The record's blob key — what a rebuild's listing reports, and the merge key here. */
  key: z.string(),
  object_id: z.string(),
  object_type: z.enum(VISUAL_IDENTITY_OBJECT_TYPES),
  status: z.enum(['active', 'archived']),
  /** Loose on purpose: a future body change must degrade to a rebuild, never to a parse failure. */
  record: z.record(z.string(), z.unknown()),
});
export type VisualIdentitySnapshotEntry = z.infer<typeof snapshotEntrySchema>;

export const visualIdentitySnapshotSchema = z.object({
  schema_version: z.literal(VISUAL_IDENTITY_SNAPSHOT_SCHEMA_VERSION),
  seq: z.number().int().nonnegative(),
  as_of: z.string(),
  /** Sticky "this snapshot is known to be short a record". See `snapshots/guarded-doc.ts`. */
  armed: z.boolean().optional(),
  /** Diagnostic only: who last wrote it. */
  source: z.enum(['write', 'rebuild']),
  entries: z.array(snapshotEntrySchema),
});
export type VisualIdentitySnapshot = z.infer<typeof visualIdentitySnapshotSchema>;

/**
 * The rowless form an arm and a re-arm write. Schema-valid and untrustworthy
 * by construction — an armed document is never read, so carrying its rows
 * would make every amendment write this blob twice for nothing.
 */
export const emptyVisualIdentitySnapshot = (seq: number, asOf: string): VisualIdentitySnapshot => ({
  schema_version: VISUAL_IDENTITY_SNAPSHOT_SCHEMA_VERSION,
  seq,
  as_of: asOf,
  source: 'write',
  entries: [],
});

/** `objects/index-doc.ts`'s store subset, aliased so every guarded document agrees about what a store must do. */
export type VisualIdentitySnapshotDocStore = ObjectIndexDocStore;

/** The ONE `.setJSON(VISUAL_IDENTITY_SNAPSHOT_KEY, …)` in the server tree, and the read that pairs with it. */
const io = (store: VisualIdentitySnapshotDocStore): GuardedDocIo<VisualIdentitySnapshot> => ({
  label: VISUAL_IDENTITY_SNAPSHOT_KEY,
  schema: visualIdentitySnapshotSchema,
  empty: emptyVisualIdentitySnapshot,
  read: () => readBlobWithEtag(store, VISUAL_IDENTITY_SNAPSHOT_KEY),
  write: (doc, guard) =>
    (guard
      ? store.setJSON(VISUAL_IDENTITY_SNAPSHOT_KEY, doc, guard)
      : store.setJSON(VISUAL_IDENTITY_SNAPSHOT_KEY, doc)) as Promise<GuardedWriteResult>,
});

/**
 * ONE blob read, with everything the reader and the rebuild both need out of
 * it. `superseded` = a blob was there and was unusable (which means a REBUILD,
 * not merely a cold store); `bytes` is the number the "does this still fit in
 * one blob" question is answered with.
 */
export type VisualIdentitySnapshotRead = {
  /** The stored document whatever its state — `undefined` for absent, corrupt or foreign-schema. */
  doc: VisualIdentitySnapshot | undefined;
  /** The one state a reader may serve: it parsed AND no writer left the flag up. */
  trusted: boolean;
  superseded: boolean;
  bytes: number;
};

export const readVisualIdentitySnapshotDoc = async (
  store: VisualIdentitySnapshotDocStore
): Promise<VisualIdentitySnapshotRead> => {
  const { raw } = await readBlobWithEtag(store, VISUAL_IDENTITY_SNAPSHOT_KEY);
  const { doc, present } = parseGuardedDoc(raw, visualIdentitySnapshotSchema);
  return {
    doc,
    trusted: Boolean(doc && doc.armed !== true),
    superseded: present && !doc,
    bytes: raw ? Buffer.byteLength(raw) : 0,
  };
};

/**
 * The one place a record becomes an entry, so the choke point and the rebuild
 * cannot project it differently: what `object_get` returns minus the unbounded
 * ledger (the store's header says why that is the one subtraction).
 */
export const projectVisualIdentityEntry = (key: string, record: ObjectRecord): VisualIdentitySnapshotEntry => {
  const { history, ...rest } = record as ObjectRecord & { history?: unknown[] };
  return {
    key,
    object_id: record.object_id,
    object_type: record.object_type as VisualIdentityObjectType,
    status: record.status,
    record: { ...(rest as Record<string, unknown>), history: [], history_length: Array.isArray(history) ? history.length : 0 },
  };
};

// ═══ what the record-write choke point calls ══════════════════════════════

export type VisualIdentitySnapshotLease = GuardedLease<VisualIdentitySnapshot>;

/** Raise the alarm and hand back the entries to amend. Called BEFORE the record moves — `objects/record-writer.ts`'s header, case 2. */
export const armVisualIdentitySnapshotWrite = async (
  store: VisualIdentitySnapshotDocStore,
  nowMs: number
): Promise<VisualIdentitySnapshotLease> => armGuardedDoc(io(store), nowMs);

/**
 * Amend the snapshot and disarm the alarm, or do neither. Compare-and-swap at
 * the lease's etag, so a writer that slipped in between is never overwritten.
 * Declining is the normal, safe outcome — the alarm stays armed and the next
 * read rebuilds — so this answers a boolean and never throws.
 */
export const commitVisualIdentitySnapshotEntries = async (
  store: VisualIdentitySnapshotDocStore,
  lease: VisualIdentitySnapshotLease,
  change: { upserts?: readonly VisualIdentitySnapshotEntry[]; removals?: readonly string[]; nowMs: number }
): Promise<boolean> => {
  if (!lease.armed || !lease.previous) return false;

  const removals = new Set(change.removals ?? []);
  const byKey = new Map<string, VisualIdentitySnapshotEntry>();
  for (const entry of lease.previous.entries) {
    if (!removals.has(entry.key)) byKey.set(entry.key, entry);
  }
  for (const entry of change.upserts ?? []) byKey.set(entry.key, entry);

  return commitGuardedDoc(
    io(store),
    lease,
    {
      ...lease.previous,
      source: 'write',
      entries: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
    },
    change.nowMs
  );
};

/**
 * The REBUILD's write: a complete re-derivation from the records, so it is
 * unconditional and it is the only thing that may put a sticky alarm down.
 * Never throws — a cache that could not be persisted costs the next read a
 * rebuild and must not fail this one.
 */
export const writeRebuiltVisualIdentitySnapshot = async (
  store: VisualIdentitySnapshotDocStore,
  entries: readonly VisualIdentitySnapshotEntry[],
  nowMs: number
): Promise<boolean> =>
  writeRebuiltDoc(io(store), {
    schema_version: VISUAL_IDENTITY_SNAPSHOT_SCHEMA_VERSION,
    seq: 0,
    as_of: new Date(nowMs).toISOString(),
    source: 'rebuild',
    entries: [...entries].sort((a, b) => a.key.localeCompare(b.key)),
  });
