/**
 * Membership reads (W18 T18.1) — v2 first, then a v1 `by-email/<email>` FULL
 * record upgraded IN MEMORY (no write). The first *write* to such a row
 * (`write.ts` → `saveMember`) rewrites it as v2 and turns `by-email` into a
 * pointer — the lazy migration, plan §2.3.
 */
import { z } from 'zod';

import {
  KEYS,
  MEMBERSHIP_SCHEMA_VERSION,
  PREFIXES,
  membershipSchema,
  normalizeEmail,
  personIdForEmail,
  personSchema,
  pointerSchema,
  type Membership,
  type MembershipRole,
  type MembershipStatus,
  type MembershipStore,
  type Person,
} from './store.js';
import { getSiteIdentity } from '../../../lib/site-identity.js';
import { collectBlobListItems } from '../blob-list.js';

/** The pre-T18.1 record shape (users-store.ts v1), accepted verbatim on read. */
export const legacyUserRecordSchema = z.object({
  schema_version: z.literal(1),
  email: z.string(),
  user_id: z.string().optional(),
  display_name: z.string(),
  avatar_artifact: z.string().optional(),
  role: z.enum(['owner', 'admin']),
  status: z.enum(['invited', 'active', 'disabled']),
  invited_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  last_seen_at: z.string().optional(),
  audit: z.array(
    z.object({ at: z.string(), actor_email: z.string(), action: z.string(), detail: z.string().optional() })
  ),
});
export type LegacyUserRecord = z.infer<typeof legacyUserRecordSchema>;

export interface Member {
  person: Person;
  membership: Membership;
  /** true when assembled from a v1 row that has not been rewritten yet. */
  legacy: boolean;
}

const siteIdSafe = (): string => {
  try {
    return getSiteIdentity().siteId;
  } catch {
    return 'site_unknown';
  }
};

const v1StatusToV2 = (status: LegacyUserRecord['status']): MembershipStatus =>
  status === 'disabled' ? 'suspended' : status;

/** v1 record → { person, membership } — pure, no writes. */
export const upgradeLegacyRecord = (record: LegacyUserRecord): Member => {
  const email = normalizeEmail(record.email);
  const personId = personIdForEmail(email);
  const person: Person = {
    schema_version: MEMBERSHIP_SCHEMA_VERSION,
    person_id: personId,
    email,
    identity: { provider: 'netlify_identity', ...(record.user_id ? { user_id: record.user_id } : {}) },
    display_name: record.display_name,
    ...(record.avatar_artifact ? { avatar_artifact: record.avatar_artifact } : {}),
    onboarding: { steps: {} },
    created_at: record.created_at,
    updated_at: record.updated_at,
    ...(record.last_seen_at ? { last_seen_at: record.last_seen_at } : {}),
  };
  const membership: Membership = {
    schema_version: MEMBERSHIP_SCHEMA_VERSION,
    person_id: personId,
    site_id: siteIdSafe(),
    role: record.role,
    status: v1StatusToV2(record.status),
    source: record.invited_by === 'bootstrap' || record.invited_by === 'environment' ? 'bootstrap_env' : 'legacy_v1',
    granted_by:
      record.invited_by === 'bootstrap' || record.invited_by === 'environment'
        ? { kind: 'system', reason: 'ADMIN_EMAILS' }
        : { kind: 'human', email: record.invited_by },
    invited_by: record.invited_by,
    audit: record.audit,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
  return { person, membership, legacy: true };
};

const parseJson = (raw: string | null): unknown => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const getPerson = async (store: MembershipStore, personId: string): Promise<Person | null> => {
  const parsed = personSchema.safeParse(parseJson(await store.get(KEYS.person(personId))));
  return parsed.success ? parsed.data : null;
};

export const getMembership = async (store: MembershipStore, personId: string): Promise<Membership | null> => {
  const parsed = membershipSchema.safeParse(parseJson(await store.get(KEYS.membership(personId))));
  return parsed.success ? parsed.data : null;
};

/**
 * Resolve an e-mail to its member. Missing OR corrupt → null (the resolver
 * degrades to env). A v1 full record under `by-email/` is upgraded in memory.
 */
export const getMembershipByEmail = async (store: MembershipStore, email: string): Promise<Member | null> => {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const value = parseJson(await store.get(KEYS.byEmail(normalized)));
  if (!value) return null;

  const pointer = pointerSchema.safeParse(value);
  if (pointer.success && !('schema_version' in (value as object))) {
    const [person, membership] = await Promise.all([
      getPerson(store, pointer.data.person_id),
      getMembership(store, pointer.data.person_id),
    ]);
    if (!person || !membership) return null;
    return { person, membership, legacy: false };
  }

  const legacy = legacyUserRecordSchema.safeParse(value);
  if (legacy.success) return upgradeLegacyRecord(legacy.data);
  return null;
};

export const getMembershipByIdentity = async (store: MembershipStore, userId: string): Promise<Member | null> => {
  const pointer = pointerSchema.safeParse(parseJson(await store.get(KEYS.byIdentity(userId))));
  if (!pointer.success) return null;
  const [person, membership] = await Promise.all([
    getPerson(store, pointer.data.person_id),
    getMembership(store, pointer.data.person_id),
  ]);
  if (!person || !membership) return null;
  return { person, membership, legacy: false };
};

/**
 * Every member: v2 memberships plus any v1 rows not yet rewritten. Corrupt
 * entries are skipped. Sorted by e-mail.
 */
export const listMembers = async (store: MembershipStore): Promise<Member[]> => {
  const byPerson = new Map<string, Member>();

  // `store.list({ paginate: true })` resolves to an AsyncIterable of PAGES, not
  // to a single `{ blobs }` page — reading `.blobs` off it yields `undefined`
  // and silently lists NOTHING (the 2026-08-06 hotfix class; see blob-list.ts).
  const membershipItems = await collectBlobListItems(
    await store.list({ prefix: PREFIXES.membership, directories: false, paginate: true })
  );
  for (const blob of membershipItems) {
    const membership = membershipSchema.safeParse(parseJson(await store.get(blob.key)));
    if (!membership.success) continue;
    const person = await getPerson(store, membership.data.person_id);
    if (!person) continue;
    byPerson.set(person.person_id, { person, membership: membership.data, legacy: false });
  }

  const emailItems = await collectBlobListItems(
    await store.list({ prefix: PREFIXES.byEmail, directories: false, paginate: true })
  );
  for (const blob of emailItems) {
    const value = parseJson(await store.get(blob.key));
    if (!value || typeof value !== 'object') continue;
    if (!('schema_version' in value)) continue; // a v2 pointer — already covered above
    const legacy = legacyUserRecordSchema.safeParse(value);
    if (!legacy.success) continue;
    const member = upgradeLegacyRecord(legacy.data);
    if (!byPerson.has(member.person.person_id)) byPerson.set(member.person.person_id, member);
  }

  return [...byPerson.values()].sort((a, b) => a.person.email.localeCompare(b.person.email));
};

/** Stored ACTIVE owners (for the `min_owners` guard — env bootstrap owners are counted by the caller). */
export const countActiveOwners = async (store: MembershipStore, exceptPersonId?: string): Promise<number> =>
  (await listMembers(store)).filter(
    (m) => m.membership.role === 'owner' && m.membership.status === 'active' && m.person.person_id !== exceptPersonId
  ).length;

export type { MembershipRole };
