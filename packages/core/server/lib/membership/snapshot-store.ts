/**
 * M3.2 — the WRITE half of `snapshots/members.json`, and the only module in
 * the server tree that names its key (`KEY_HELPERS` in
 * `tests/netlify/object-inventory-index.test.ts` fails the build otherwise).
 *
 * WHO WRITES IT. Verified with `rg` against `KEYS.person` / `KEYS.membership` /
 * `putPerson` / `putMembership` / `saveMember` rather than taken on trust,
 * exactly three places change a member row: `write.ts`'s `saveMember` (the pair
 * writer every invite, activation, role change, suspension, reinstatement,
 * ownership transfer and `putUserRecord` ends up in), `write.ts`'s
 * `stampOnboarding` on the branch that writes only the PERSON, and
 * `offboarding.ts`'s `scrubPerson`, the one path that REMOVES a row.
 * `putPerson` and `putMembership` have no other callers, which is what makes
 * those three exhaustive: a half-written pair cannot project a row, so the
 * amendment is made where both halves are in hand.
 *
 * No materiality rule here, unlike `agent/chat-snapshot-store.ts`: member
 * writes are human-rate, and the one that is page-rate — `last_seen_at` on
 * `me` — is already throttled to `LAST_SEEN_REFRESH_MS` by
 * `activateOnLoginDetailed` before it reaches a store.
 *
 * The rebuild lives in `read.ts` (it owns the sweep) and calls
 * `writeRebuiltMembersSnapshot` here rather than writing the key itself.
 */
import {
  armGuardedDoc,
  commitGuardedDoc,
  readBlobWithEtag,
  writeRebuiltDoc,
  type GuardedDocIo,
  type GuardedLease,
  type GuardedWriteResult,
} from '../snapshots/guarded-doc.js';
import {
  compareMemberRows,
  emptyMembersSnapshot,
  membersSnapshotSchema,
  MEMBERS_SNAPSHOT_KEY,
  MEMBERS_SNAPSHOT_SCHEMA_VERSION,
  type MembersSnapshot,
  type MemberSnapshotRow,
} from './snapshot-view.js';
import type { MembershipStore } from './store.js';

/** The ONE `.setJSON(MEMBERS_SNAPSHOT_KEY, …)` in the server tree, and the read that pairs with it. */
const io = (store: MembershipStore): GuardedDocIo<MembersSnapshot> => ({
  label: MEMBERS_SNAPSHOT_KEY,
  schema: membersSnapshotSchema,
  empty: emptyMembersSnapshot,
  read: () => readBlobWithEtag(store, MEMBERS_SNAPSHOT_KEY),
  write: (doc, guard) =>
    (guard
      ? store.setJSON(MEMBERS_SNAPSHOT_KEY, doc, guard)
      : store.setJSON(MEMBERS_SNAPSHOT_KEY, doc)) as Promise<GuardedWriteResult>,
});

export type MembersSnapshotLease = GuardedLease<MembersSnapshot>;

/** Raise the alarm before the records are written. Never throws: they are the truth, this is a cache. */
export const armMembersSnapshot = async (store: MembershipStore, nowMs: number): Promise<MembersSnapshotLease> =>
  armGuardedDoc(io(store), nowMs);

/**
 * Amend and disarm, or do neither. `upserts` replace by `person_id`,
 * `removals` drop by it; a lease that never armed commits nothing, which leaves
 * the flag up and costs the next reader one sweep.
 */
export const commitMembersSnapshot = async (
  store: MembershipStore,
  lease: MembersSnapshotLease,
  change: { upserts?: readonly MemberSnapshotRow[]; removals?: readonly string[]; nowMs: number }
): Promise<boolean> => {
  if (!lease.armed || !lease.previous) return false;
  const removals = new Set(change.removals ?? []);
  const byPerson = new Map<string, MemberSnapshotRow>();
  for (const row of lease.previous.members) {
    if (!removals.has(row.person.person_id)) byPerson.set(row.person.person_id, row);
  }
  for (const row of change.upserts ?? []) byPerson.set(row.person.person_id, row);
  const members = [...byPerson.values()].sort(compareMemberRows);
  return commitGuardedDoc(io(store), lease, { ...lease.previous, members }, change.nowMs);
};

/** The repair write — only a full membership sweep may put a sticky alarm down. */
export const writeRebuiltMembersSnapshot = async (
  store: MembershipStore,
  members: readonly MemberSnapshotRow[],
  nowMs: number
): Promise<boolean> =>
  writeRebuiltDoc(io(store), {
    schema_version: MEMBERS_SNAPSHOT_SCHEMA_VERSION,
    as_of: new Date(nowMs).toISOString(),
    seq: 0,
    members: [...members].sort(compareMemberRows),
  });
