/**
 * M3.2 — the READ half of `snapshots/members.json`: its shape and the ONE blob
 * read that fetches the Admins list.
 *
 * `listMembers` was an N+1 and then some: two `list()` calls, then SERIALLY
 * one `get` per membership and one more per person to pair with it — twenty-two
 * round trips at ~150-250 ms each for a ten-person workspace, on every load of
 * `/admin/settings/admins` and every `member_list` over `/mcp`.
 *
 * WHY THE ROW IS A WHOLE MEMBER, not a projection. "Store only what the
 * surface renders" is right for `snapshots/chats.json`, where the hub draws
 * eight fields out of an eight-hundred-event transcript. Here the surface
 * renders the member RECORD: `memberToUserRecord` (`users-store.ts`) reads
 * essentially every field of both halves — including `membership.audit`, which
 * the row drawer falls back to when the audit stream has nothing for that
 * person (`AdminUsers.tsx`, `auditUser?.audit`) — and `member_list` puts the
 * same view on the `/mcp` wire. A narrower row would mean either a silently
 * thinner wire or a SECOND zod definition of the member view, in a different
 * file from `memberToUserRecord` and free to drift from it. So the blob holds
 * the `Member` the sweep already returns, under the schemas that already
 * define it. Same bytes; fetched once.
 */
import { z } from 'zod';

import { membershipSchema, personSchema, type MembershipStore } from './store.js';
import { readBlobWithEtag, trustedGuardedDoc } from '../snapshots/guarded-doc.js';

export const MEMBERS_SNAPSHOT_KEY = 'snapshots/members.json';
export const MEMBERS_SNAPSHOT_SCHEMA_VERSION = 'member-list-snapshot.v1';

export const memberSnapshotRowSchema = z.object({
  person: personSchema,
  membership: membershipSchema,
  /** True when assembled from a v1 row that has not been rewritten yet. */
  legacy: z.boolean(),
});
export type MemberSnapshotRow = z.infer<typeof memberSnapshotRowSchema>;

export const membersSnapshotSchema = z.object({
  schema_version: z.literal(MEMBERS_SNAPSHOT_SCHEMA_VERSION),
  as_of: z.string(),
  seq: z.number().int().nonnegative(),
  /** Sticky "this list is known to be short a row". See `snapshots/guarded-doc.ts`. */
  armed: z.boolean().optional(),
  members: z.array(memberSnapshotRowSchema),
});
export type MembersSnapshot = z.infer<typeof membersSnapshotSchema>;

/** The rowless form an arm and a re-arm write. Schema-valid and untrustworthy by construction. */
export const emptyMembersSnapshot = (seq: number, asOf: string): MembersSnapshot => ({
  schema_version: MEMBERS_SNAPSHOT_SCHEMA_VERSION,
  as_of: asOf,
  seq,
  members: [],
});

/** `listMembers`' order, kept identical so no caller can tell the two paths apart. */
export const compareMemberRows = (a: MemberSnapshotRow, b: MemberSnapshotRow): number =>
  a.person.email.localeCompare(b.person.email);

/**
 * THE READ. One blob read. `undefined` means "sweep the records" — absent,
 * unreadable, unparseable, written by another schema version, or armed, which
 * are one answer as far as a caller is concerned.
 */
export const readMembersSnapshot = async (store: MembershipStore): Promise<MembersSnapshot | undefined> => {
  const { raw } = await readBlobWithEtag(store, MEMBERS_SNAPSHOT_KEY);
  return trustedGuardedDoc(raw, membersSnapshotSchema);
};
