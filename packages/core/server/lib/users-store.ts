/**
 * Users store (T9.4) — the v1 helper surface, now an ADAPTER over the
 * membership store v2 (W18 T18.1, plan §2.3).
 *
 * @deprecated for new code — read `membership/read.ts` and write through
 * `membership/write.ts`. These helpers stay so `admin-users.ts`,
 * `membership/invitations.ts`, `request-roles.ts`, `admin-agent-chat*.ts` and the tests
 * compile unchanged for one release; T18.8 removes them.
 *
 * What the adapter does:
 *   - `getUserRecord` reads v2 (person + membership) — or a not-yet-migrated
 *     v1 row, upgraded in memory — and returns a v1-shaped VIEW
 *     (`schema_version: 1`, `status: invited|active|disabled`; v2 `suspended`
 *     and `removed` both read as `disabled`, so every role gate that keyed on
 *     `disabled` keeps failing closed).
 *   - `putUserRecord` writes v2 (person + membership + indexes) — which is the
 *     lazy migration: the first write to a v1 row replaces the full record
 *     under `by-email/` with a `{ person_id }` pointer.
 *   - `listUserRecords` lists v2 memberships plus unmigrated v1 rows.
 *
 * `ADMIN_EMAILS` members remain bootstrap Owners via env so a wiped/corrupt
 * store can never lock anyone out (see roles.ts).
 */
import { z } from 'zod';

import { getMembershipByEmail, listMembers, type Member } from './membership/read.js';
import { newMember, saveMember } from './membership/write.js';
import {
  KEYS,
  getMembershipStore,
  membershipAuditEntrySchema,
  membershipRoleSchema,
  normalizeEmail,
  type Membership,
  type MembershipStore,
} from './membership/store.js';

export const USERS_SCHEMA_VERSION = 1;

/** The five workspace tiers (T18.1; was owner|admin). */
export const userRoleSchema = membershipRoleSchema;
export type UserRole = z.infer<typeof userRoleSchema>;

/** The v1 status vocabulary of the VIEW. v2 `suspended`|`removed` both surface as `disabled`. */
export const userStatusSchema = z.enum(['invited', 'active', 'disabled']);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const userAuditEntrySchema = membershipAuditEntrySchema;
export type UserAuditEntry = z.infer<typeof userAuditEntrySchema>;

export const userRecordSchema = z.object({
  schema_version: z.literal(USERS_SCHEMA_VERSION),
  email: z.string(),
  user_id: z.string().optional(),
  display_name: z.string(),
  avatar_artifact: z.string().optional(),
  role: userRoleSchema,
  status: userStatusSchema,
  invited_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  last_seen_at: z.string().optional(),
  audit: z.array(userAuditEntrySchema),
  /** T18.1: present on every view assembled from v2. */
  person_id: z.string().optional(),
  /** T18.1: the real v2 status (invited|active|suspended|removed) behind the v1 `status`. */
  membership_status: z.enum(['invited', 'active', 'suspended', 'removed']).optional(),
  /** T18.5: Person.onboarding, read-only on the view (written via stampOnboarding). */
  onboarding: z
    .object({
      completed_at: z.string().optional(),
      steps: z.object({ name: z.string().optional(), password: z.string().optional(), tour: z.string().optional() }),
    })
    .optional(),
  /** T18.1: how the membership came to exist (`source` is taken by ListedUser's stored|environment). */
  membership_source: z.enum(['bootstrap_env', 'invitation', 'netlify_ui', 'mcp', 'import', 'legacy_v1']).optional(),
});
export type UserRecord = z.infer<typeof userRecordSchema>;

/** Minimal blob-store surface the store helpers need (injectable for tests). */
export type UsersBlobStore = MembershipStore;

export const normalizeUserEmail = normalizeEmail;

/** The by-email INDEX key (v2 value is `{ person_id }`; a v1 row still holds a full record until first write). */
export const userRecordKey = (email: string): string => KEYS.byEmail(email);

/** v2 → the v1-shaped view. */
export const memberToUserRecord = (member: Member): UserRecord => {
  const { person, membership } = member;
  const status: UserStatus =
    membership.status === 'suspended' || membership.status === 'removed' ? 'disabled' : membership.status;
  return {
    schema_version: USERS_SCHEMA_VERSION,
    email: person.email,
    ...(person.identity.user_id ? { user_id: person.identity.user_id } : {}),
    display_name: person.display_name,
    ...(person.avatar_artifact ? { avatar_artifact: person.avatar_artifact } : {}),
    role: membership.role,
    status,
    invited_by:
      membership.invited_by ?? (membership.granted_by.kind === 'human' ? membership.granted_by.email : 'bootstrap'),
    created_at: membership.created_at,
    updated_at: membership.updated_at,
    ...(person.last_seen_at ? { last_seen_at: person.last_seen_at } : {}),
    audit: membership.audit,
    person_id: person.person_id,
    onboarding: person.onboarding,
    membership_status: membership.status,
    membership_source: membership.source,
  };
};

/** Read + validate a user record. Missing OR corrupt → null (resolver degrades to env). */
export const getUserRecord = async (store: UsersBlobStore, email: string): Promise<UserRecord | null> => {
  const member = await getMembershipByEmail(store, email);
  return member ? memberToUserRecord(member) : null;
};

const viewStatusToV2 = (status: UserStatus, current?: Membership['status']): Membership['status'] => {
  if (status === 'disabled') return current === 'removed' ? 'removed' : 'suspended';
  return status;
};

/**
 * Write a v1-shaped record: becomes person + membership + indexes. An
 * existing member (v2 or unmigrated v1) is merged so v2-only fields
 * (onboarding, source, granted_by, suspended/removed blocks) survive.
 */
export const putUserRecord = async (store: UsersBlobStore, record: UserRecord): Promise<void> => {
  const validated = userRecordSchema.parse({ ...record, email: normalizeUserEmail(record.email) });
  const existing = await getMembershipByEmail(store, validated.email);
  const isBootstrap = validated.invited_by === 'bootstrap' || validated.invited_by === 'environment';

  if (!existing) {
    const created = newMember({
      email: validated.email,
      display_name: validated.display_name,
      role: validated.role,
      status: viewStatusToV2(validated.status),
      source: isBootstrap ? 'bootstrap_env' : 'invitation',
      granted_by: isBootstrap
        ? { kind: 'system', reason: 'ADMIN_EMAILS' }
        : { kind: 'human', email: validated.invited_by },
      invited_by: validated.invited_by,
      at: validated.created_at,
      user_id: validated.user_id,
      audit: validated.audit,
    });
    created.person.updated_at = validated.updated_at;
    if (validated.avatar_artifact) created.person.avatar_artifact = validated.avatar_artifact;
    if (validated.last_seen_at) created.person.last_seen_at = validated.last_seen_at;
    created.membership.updated_at = validated.updated_at;
    await saveMember(store, created);
    return;
  }

  const person = {
    ...existing.person,
    identity: {
      ...existing.person.identity,
      ...(validated.user_id ? { user_id: validated.user_id } : {}),
    },
    display_name: validated.display_name,
    ...(validated.avatar_artifact !== undefined ? { avatar_artifact: validated.avatar_artifact } : {}),
    updated_at: validated.updated_at,
    ...(validated.last_seen_at ? { last_seen_at: validated.last_seen_at } : {}),
  };
  const nextStatus = viewStatusToV2(validated.status, existing.membership.status);
  const membership: Membership = {
    ...existing.membership,
    role: validated.role,
    status: nextStatus,
    invited_by: validated.invited_by,
    audit: validated.audit,
    updated_at: validated.updated_at,
    // leaving suspension clears its marker; entering it (without one) stamps a minimal one
    ...(nextStatus !== 'suspended' ? { suspended: undefined } : {}),
    ...(nextStatus === 'suspended' && !existing.membership.suspended
      ? { suspended: { at: validated.updated_at, by: validated.audit.at(-1)?.actor_email ?? 'system' } }
      : {}),
  };
  if (membership.suspended === undefined) delete (membership as { suspended?: unknown }).suspended;
  await saveMember(store, { person, membership });
};

/** All valid user records (corrupt entries skipped), sorted by e-mail. `removed` memberships are included as `disabled`. */
export const listUserRecords = async (store: UsersBlobStore): Promise<UserRecord[]> =>
  (await listMembers(store)).map(memberToUserRecord);

/** Append an audit entry (returns a new record; does not persist). */
export const withAuditEntry = (record: UserRecord, entry: UserAuditEntry): UserRecord => ({
  ...record,
  audit: [...record.audit, entry],
});

export const getUsersBlobStore = (event: unknown): Promise<UsersBlobStore> => getMembershipStore(event);
