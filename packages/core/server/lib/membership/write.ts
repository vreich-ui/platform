/**
 * Membership writes (W18 T18.1). Every helper writes zod-validated v2 records;
 * `saveMember` is the one place the indexes are maintained (`by-email` →
 * pointer, `by-identity` → pointer), and therefore also the lazy v1→v2
 * migration: a member first read from a v1 row is written back as v2 and its
 * `by-email` value becomes `{ person_id }`.
 */
import { activeMembershipPolicyBase, type MembershipPolicy } from '../../../lib/membership-policy.js';
import { getMembershipByEmail, listMembers, type Member } from './read.js';
import {
  KEYS,
  MEMBERSHIP_SCHEMA_VERSION,
  auditEventSchema,
  membershipPolicyOverrideSchema,
  membershipSchema,
  mintUlid,
  normalizeEmail,
  personIdForEmail,
  personSchema,
  type AuditActor,
  type AuditEvent,
  type Membership,
  type MembershipRole,
  type MembershipStore,
  type Person,
} from './store.js';
import { getSiteIdentity } from '../../../lib/site-identity.js';

export const putPerson = async (store: MembershipStore, person: Person): Promise<Person> => {
  const validated = personSchema.parse({ ...person, email: normalizeEmail(person.email) });
  await store.setJSON(KEYS.person(validated.person_id), validated);
  await store.setJSON(KEYS.byEmail(validated.email), { person_id: validated.person_id });
  if (validated.identity.user_id) {
    await store.setJSON(KEYS.byIdentity(validated.identity.user_id), { person_id: validated.person_id });
  }
  return validated;
};

export const putMembership = async (store: MembershipStore, membership: Membership): Promise<Membership> => {
  const validated = membershipSchema.parse(membership);
  await store.setJSON(KEYS.membership(validated.person_id), validated);
  return validated;
};

/** Person + membership + indexes in one call (the lazy migration lands here too). */
export const saveMember = async (store: MembershipStore, member: { person: Person; membership: Membership }) => {
  const person = await putPerson(store, member.person);
  const membership = await putMembership(store, { ...member.membership, person_id: person.person_id });
  return { person, membership, legacy: false as const };
};

/** Append one event to the audit stream (`audit/<yyyy-mm>/<ulid>.json`). Never throws the caller's write away. */
export const appendAudit = async (
  store: MembershipStore,
  event: Omit<AuditEvent, 'schema_version' | 'event_id'> & { event_id?: string }
): Promise<AuditEvent> => {
  const record = auditEventSchema.parse({ schema_version: 1, event_id: event.event_id ?? mintUlid(), ...event });
  await store.setJSON(KEYS.audit(record.at, record.event_id), record);
  return record;
};

/**
 * `upsertFromV1` — the explicit form of the lazy migration: given an e-mail
 * whose `by-email` row is still a v1 full record, rewrite it as v2. Returns
 * the member (or null when there is nothing to migrate). Idempotent.
 */
export const upsertFromV1 = async (store: MembershipStore, email: string, at = new Date().toISOString()) => {
  const member = await getMembershipByEmail(store, email);
  if (!member) return null;
  if (!member.legacy) return member;
  const saved = await saveMember(store, member);
  await appendAudit(store, {
    at,
    actor: { kind: 'system' },
    action: 'membership.migrate_v1',
    target: { person_id: saved.person.person_id, email: saved.person.email },
    via: 'system',
  });
  return saved;
};

// ── policy ──────────────────────────────────────────────────────────────────

/** DEFAULT ← the site's committed override (policy-bindings provider, T18.7) ← the store's `policy.json` (Owner-set at runtime). */
export const getPolicy = async (store: MembershipStore): Promise<MembershipPolicy> => {
  const base = activeMembershipPolicyBase();
  try {
    const raw = await store.get(KEYS.policy());
    if (!raw) return base;
    const parsed = membershipPolicyOverrideSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return base;
    return { ...base, ...stripUndefined(parsed.data) };
  } catch {
    return base;
  }
};

export const setPolicy = async (store: MembershipStore, override: unknown): Promise<MembershipPolicy> => {
  const parsed = membershipPolicyOverrideSchema.parse(override);
  await store.setJSON(KEYS.policy(), parsed);
  return { ...activeMembershipPolicyBase(), ...stripUndefined(parsed) };
};

const stripUndefined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

// ── construction helpers ────────────────────────────────────────────────────

const siteIdSafe = (): string => {
  try {
    return getSiteIdentity().siteId;
  } catch {
    return 'site_unknown';
  }
};

/** A brand-new person + membership pair (invite / bootstrap / grant). Not persisted. */
export const newMember = (input: {
  email: string;
  display_name: string;
  role: MembershipRole;
  status: Membership['status'];
  source: Membership['source'];
  granted_by: Membership['granted_by'];
  invited_by: string;
  at: string;
  user_id?: string;
  invitation_id?: string;
  audit?: Membership['audit'];
}): { person: Person; membership: Membership } => {
  const email = normalizeEmail(input.email);
  const personId = personIdForEmail(email);
  return {
    person: {
      schema_version: MEMBERSHIP_SCHEMA_VERSION,
      person_id: personId,
      email,
      identity: { provider: 'netlify_identity', ...(input.user_id ? { user_id: input.user_id } : {}) },
      display_name: input.display_name,
      onboarding: { steps: {} },
      created_at: input.at,
      updated_at: input.at,
    },
    membership: {
      schema_version: MEMBERSHIP_SCHEMA_VERSION,
      person_id: personId,
      site_id: siteIdSafe(),
      role: input.role,
      status: input.status,
      source: input.source,
      ...(input.invitation_id ? { invitation_id: input.invitation_id } : {}),
      granted_by: input.granted_by,
      invited_by: input.invited_by,
      audit: input.audit ?? [],
      created_at: input.at,
      updated_at: input.at,
    },
  };
};

/**
 * `min_owners` guard (plan §3.2): would removing/demoting/suspending
 * `exceptPersonId` leave fewer than `min_owners` owners? Counts stored ACTIVE
 * owners (other than the excepted one) plus env bootstrap owners.
 */
export const wouldBreachMinOwners = async (
  store: MembershipStore,
  input: { exceptPersonId: string; envOwnerCount: number; minOwners: number }
): Promise<boolean> => {
  const stored = (await listMembers(store)).filter(
    (m: Member) =>
      m.membership.role === 'owner' && m.membership.status === 'active' && m.person.person_id !== input.exceptPersonId
  ).length;
  return stored + input.envOwnerCount < input.minOwners;
};

export { mintUlid };
export type { AuditActor };

/** Stamp onboarding steps / completion on a person (T18.1; consumed by `/admin/welcome`, T18.5). No-op when the person is missing. */
export const stampOnboarding = async (
  store: MembershipStore,
  email: string,
  input: { steps?: Partial<Person['onboarding']['steps']>; completed_at?: string; at: string }
): Promise<Person | null> => {
  const member = await getMembershipByEmail(store, email);
  if (!member) return null;
  const person: Person = {
    ...member.person,
    onboarding: {
      ...member.person.onboarding,
      steps: { ...member.person.onboarding.steps, ...(input.steps ?? {}) },
      ...(input.completed_at ? { completed_at: input.completed_at } : {}),
    },
    updated_at: input.at,
  };
  if (member.legacy) {
    await saveMember(store, { person, membership: member.membership });
    return person;
  }
  return putPerson(store, person);
};

/**
 * `remove` (T18.3a verb; T18.4 adds the identity/OAuth/lock side effects):
 * membership → `removed{purge_after}`; the person stays for audit/attribution.
 * Returns null when there is no member.
 */
export const removeMembership = async (
  store: MembershipStore,
  input: { email: string; actorEmail: string; at: string; reason?: string; purgeGraceDays: number }
): Promise<Member | null> => {
  const member = await getMembershipByEmail(store, input.email);
  if (!member) return null;
  if (member.membership.status === 'removed') return member;
  const membership: Membership = {
    ...member.membership,
    status: 'removed',
    removed: {
      at: input.at,
      by: input.actorEmail,
      ...(input.reason ? { reason: input.reason } : {}),
      purge_after: new Date(Date.parse(input.at) + input.purgeGraceDays * 86_400_000).toISOString(),
    },
    audit: [
      ...member.membership.audit,
      {
        at: input.at,
        actor_email: input.actorEmail,
        action: 'remove',
        ...(input.reason ? { detail: input.reason } : {}),
      },
    ],
    updated_at: input.at,
  };
  delete (membership as { suspended?: unknown }).suspended;
  return saveMember(store, { person: member.person, membership });
};

/** The audit stream filtered to one person (newest first), for the members page drawer / `member_audit`. */
export const listAuditForEmail = async (store: MembershipStore, email: string, limit = 100): Promise<AuditEvent[]> => {
  const normalized = normalizeEmail(email);
  const listed = await store.list({ prefix: 'audit/', directories: false, paginate: true });
  const events: AuditEvent[] = [];
  for (const blob of listed.blobs ?? []) {
    const raw = await store.get(blob.key);
    if (!raw) continue;
    try {
      const parsed = auditEventSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.target.email === normalized) events.push(parsed.data);
    } catch {
      // skip corrupt
    }
  }
  return events.sort((a, b) => b.at.localeCompare(a.at) || b.event_id.localeCompare(a.event_id)).slice(0, limit);
};
