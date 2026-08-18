/**
 * Membership store v2 (W18 T18.1, plan §2) — Person / Membership / Invitation /
 * AuditEvent / MembershipPolicy records and the key layout inside the
 * per-site `users` blob store.
 *
 *   person/<person_id>.json           Person      — one per human; e-mail may change
 *   by-email/<email>                  { person_id }  (index; v1 wrote the FULL record here)
 *   by-identity/<gotrue_user_id>      { person_id }  (index)
 *   membership/<person_id>.json       Membership  — this site's role/status for the person
 *   invitation/<invite_id>.json       Invitation  — pending/accepted/expired/revoked (verbs: T18.2)
 *   invitation-by-email/<email>       { invite_id }  (one open invite per address)
 *   audit/<yyyy-mm>/<ulid>.json       AuditEvent  — append-only stream
 *   policy.json                       MembershipPolicy overrides
 *
 * Person ≠ Membership so e-mail change, cross-site fleet views and "removed
 * but retained for audit" are representable. GoTrue stays the credential
 * provider only; authorization state lives HERE, never in `app_metadata`.
 * `person_id` is deterministic from the normalized e-mail (plan §9-4, R8) so
 * the same human converges to one id across sites when the fleet view lands.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

import type { Principal } from '../../../schema/object-record-v1.js';
import { getNetlifyBlobStore } from '../blob-store.js';
import type { BlobListResponse } from '../blob-list.js';

export const MEMBERSHIP_SCHEMA_VERSION = 2;

// ── enums ───────────────────────────────────────────────────────────────────

/** The five workspace tiers (plan §6). `expandRole` in roles.ts maps them onto the role set the gates read. */
export const membershipRoleSchema = z.enum(['owner', 'admin', 'publisher', 'editor', 'viewer']);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;

export const membershipStatusSchema = z.enum(['invited', 'active', 'suspended', 'removed']);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const membershipSourceSchema = z.enum([
  'bootstrap_env',
  'invitation',
  'netlify_ui',
  'mcp',
  'import',
  'legacy_v1',
]);
export type MembershipSource = z.infer<typeof membershipSourceSchema>;

// ── Person ──────────────────────────────────────────────────────────────────

export const personSchema = z.object({
  schema_version: z.literal(MEMBERSHIP_SCHEMA_VERSION),
  person_id: z.string().min(1),
  email: z.string().min(3),
  identity: z.object({
    provider: z.literal('netlify_identity'),
    user_id: z.string().optional(),
    confirmed_at: z.string().optional(),
  }),
  display_name: z.string(),
  avatar_artifact: z.string().optional(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
  onboarding: z.object({
    completed_at: z.string().optional(),
    steps: z.object({
      name: z.string().optional(),
      password: z.string().optional(),
      tour: z.string().optional(),
    }),
  }),
  created_at: z.string(),
  updated_at: z.string(),
  last_seen_at: z.string().optional(),
});
export type Person = z.infer<typeof personSchema>;

// ── Membership ──────────────────────────────────────────────────────────────

export const grantedBySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), person_id: z.string().optional(), email: z.string() }),
  z.object({ kind: z.literal('system'), reason: z.string() }),
  z.object({ kind: z.literal('agent'), name: z.string(), oauth_subject: z.string().optional() }),
]);
export type GrantedBy = z.infer<typeof grantedBySchema>;

/** The v1 per-record audit entry shape, kept on the membership for one release (compat; plan §2.1). */
export const membershipAuditEntrySchema = z.object({
  at: z.string(),
  actor_email: z.string(),
  action: z.string(),
  detail: z.string().optional(),
});
export type MembershipAuditEntry = z.infer<typeof membershipAuditEntrySchema>;

export const membershipSchema = z.object({
  schema_version: z.literal(MEMBERSHIP_SCHEMA_VERSION),
  person_id: z.string().min(1),
  site_id: z.string().min(1),
  role: membershipRoleSchema,
  status: membershipStatusSchema,
  source: membershipSourceSchema,
  invitation_id: z.string().optional(),
  granted_by: grantedBySchema,
  invited_by: z.string().optional(),
  suspended: z.object({ at: z.string(), by: z.string(), reason: z.string().optional() }).optional(),
  removed: z
    .object({ at: z.string(), by: z.string(), reason: z.string().optional(), purge_after: z.string() })
    .optional(),
  /** Per-record audit array — v1 compat, mirrored into the audit stream. */
  audit: z.array(membershipAuditEntrySchema),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Membership = z.infer<typeof membershipSchema>;

// ── Invitation (records here; verbs land in T18.2) ──────────────────────────

export const invitationStatusSchema = z.enum(['pending', 'accepted', 'expired', 'revoked']);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const invitationSchema = z.object({
  schema_version: z.literal(1),
  invite_id: z.string().min(1),
  email: z.string().min(3),
  role: membershipRoleSchema,
  status: invitationStatusSchema,
  /** sha256 of OUR opaque accept token — never the GoTrue token. */
  token_hash: z.string(),
  gotrue: z.object({
    invited: z.boolean(),
    user_id: z.string().optional(),
    error: z.string().optional(),
    last_sent_at: z.string().optional(),
    send_count: z.number().int().nonnegative(),
  }),
  invited_by: z.object({ person_id: z.string().optional(), email: z.string() }),
  message: z.string().optional(),
  source: z.enum(['platform', 'netlify_ui', 'mcp', 'chat']).default('platform'),
  expires_at: z.string(),
  accepted: z.object({ at: z.string(), person_id: z.string() }).optional(),
  revoked: z.object({ at: z.string(), by: z.string(), reason: z.string().optional() }).optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Invitation = z.infer<typeof invitationSchema>;

// ── AuditEvent (append-only stream) ─────────────────────────────────────────

export const auditActionSchema = z.enum([
  'invitation.create',
  'invitation.resend',
  'invitation.revoke',
  'invitation.accept',
  'invitation.expire',
  'membership.activate',
  'membership.role_change',
  'membership.suspend',
  'membership.reinstate',
  'membership.remove',
  'membership.purge',
  'membership.transfer_ownership',
  'membership.promote_bootstrap',
  'membership.grant',
  'membership.migrate_v1',
  'person.update_profile',
  'person.email_change',
  'person.login',
  'person.sessions_revoked',
  'legacy', // a v1 per-record entry replayed into the stream during upgrade
]);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditActorSchema = z.union([
  z.object({ kind: z.literal('human'), id: z.string().optional(), email: z.string() }),
  z.object({ kind: z.literal('agent'), agent_name: z.string(), auth: z.string().optional() }),
  z.object({ kind: z.literal('system') }),
]);
export type AuditActor = z.infer<typeof auditActorSchema>;

export const auditEventSchema = z.object({
  schema_version: z.literal(1),
  event_id: z.string().min(1),
  at: z.string(),
  actor: auditActorSchema,
  action: auditActionSchema,
  target: z.object({ person_id: z.string().optional(), email: z.string(), invite_id: z.string().optional() }),
  detail: z.record(z.string(), z.unknown()).optional(),
  request_id: z.string().optional(),
  via: z.enum(['admin_ui', 'mcp', 'chat', 'system']),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

// ── MembershipPolicy overrides ──────────────────────────────────────────────

export const membershipPolicyOverrideSchema = z.object({
  invite_ttl_hours: z.number().int().positive().optional(),
  max_resends: z.number().int().nonnegative().optional(),
  allowed_email_domains: z.array(z.string()).optional(),
  default_role: membershipRoleSchema.optional(),
  min_owners: z.number().int().nonnegative().optional(),
  require_display_name: z.boolean().optional(),
  purge_grace_days: z.number().int().nonnegative().optional(),
  who_can_invite: z.enum(['owner', 'owner_admin']).optional(),
  roles_admin_may_grant: z.array(z.enum(['admin', 'publisher', 'editor', 'viewer'])).optional(),
  default_role_for_external: z.enum(['viewer', 'editor']).optional(),
  delete_identity_on_remove: z.boolean().optional(),
});
export type MembershipPolicyOverride = z.infer<typeof membershipPolicyOverrideSchema>;

// ── store surface + keys ────────────────────────────────────────────────────

/** Minimal blob-store surface the membership helpers need (injectable for tests). */
export interface MembershipStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<void | { modified: boolean; etag?: string }>;
  /**
   * MUST be consumed through `collectBlobListItems` — with `paginate: true`
   * the real Netlify Blobs client returns a plain `AsyncIterable` of pages
   * rather than a Promise of one page, so `(await list(...)).blobs` is
   * `undefined` and every caller that reads it silently lists nothing.
   */
  list(options: {
    prefix: string;
    directories?: boolean;
    paginate?: boolean;
  }): BlobListResponse | Promise<BlobListResponse>;
  delete?(key: string): Promise<void>;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const BASE32 = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford, lowercase

const toBase32 = (bytes: Uint8Array, length: number): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
      if (out.length >= length) return out;
    }
  }
  if (bits > 0 && out.length < length) out += BASE32[(value << (5 - bits)) & 31];
  return out.slice(0, length);
};

/** Deterministic person id: `usr_` + base32(sha256(normalized e-mail))[:20] (plan §9-4). */
export const personIdForEmail = (email: string): string =>
  `usr_${toBase32(createHash('sha256').update(normalizeEmail(email)).digest(), 20)}`;

/** Time-sortable id (ULID-shaped: 10 chars of ms time + 16 chars random, Crockford base32). */
export const mintUlid = (nowMs = Date.now()): string => {
  let time = '';
  let t = nowMs;
  for (let i = 0; i < 10; i += 1) {
    time = BASE32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return `${time}${toBase32(randomBytes(10), 16)}`;
};

export const KEYS = {
  person: (personId: string) => `person/${personId}.json`,
  byEmail: (email: string) => `by-email/${normalizeEmail(email)}`,
  byIdentity: (userId: string) => `by-identity/${userId}`,
  membership: (personId: string) => `membership/${personId}.json`,
  invitation: (inviteId: string) => `invitation/${inviteId}.json`,
  invitationByEmail: (email: string) => `invitation-by-email/${normalizeEmail(email)}`,
  audit: (at: string, eventId: string) => `audit/${at.slice(0, 7)}/${eventId}.json`,
  policy: () => 'policy.json',
} as const;

export const PREFIXES = {
  person: 'person/',
  byEmail: 'by-email/',
  byIdentity: 'by-identity/',
  membership: 'membership/',
  invitation: 'invitation/',
  invitationByEmail: 'invitation-by-email/',
  audit: 'audit/',
} as const;

export const pointerSchema = z.object({ person_id: z.string().min(1) });
export const invitePointerSchema = z.object({ invite_id: z.string().min(1) });

/** The site's `users` store (name unchanged from v1 — the key layout is what moved). */
export const getMembershipStore = (event: unknown): Promise<MembershipStore> =>
  getNetlifyBlobStore({ name: 'users', consistency: 'strong' }, event) as unknown as Promise<MembershipStore>;

/** Audit actor from a verb principal. */
export const auditActorFromPrincipal = (principal: Principal): AuditActor =>
  principal.kind === 'human'
    ? { kind: 'human', id: principal.id, email: principal.email }
    : { kind: 'agent', agent_name: principal.agent_name, auth: principal.auth };
