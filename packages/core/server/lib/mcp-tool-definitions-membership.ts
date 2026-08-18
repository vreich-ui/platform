/**
 * TOOL_DEFINITIONS, membership family (W18 T18.6b, plan §7). Sixteen tools over
 * ONE core — `handleMembershipVerb` (T18.6a) — whose first line refuses every
 * non-human principal. Two consequences an agent reading these must know:
 *
 *   1. They work ONLY for a HUMAN principal: over /mcp that means an OAuth
 *      connection a Netlify Identity human approved (the shared site token and
 *      per-agent tokens are refused with 403 membership_requires_human, and
 *      these tools are not even LISTED to them — see mcp.ts
 *      visibleToolDefinitions); in admin chat it is the run's captured human.
 *   2. Everything but the reads is Owner-tier (Admins may `member_invite`
 *      editor|viewer under the site policy) and lands an audit event naming
 *      the door (`via`). Writes are `ask`-class with a hard floor: no
 *      governance or profile override can make them auto-run.
 *
 * `MEMBERSHIP_TOOL_VERBS` is the single name→verb table mcp.ts's callTool and
 * agent/generated-tools.ts both route on. Descriptions lead with the human /
 * Owner / dry-run facts — agents decide from descriptions.
 *
 * Chat defaults (R8 decision, T18.6b): the admin-chat wire list is budgeted
 * at 64 tools (CMS_AGENT_BOUNDS.maxTools, and the registry-wiring test pins
 * the default wire ≤ 64). Three reads (`membership_contract`, `member_list`,
 * `member_get`) are on by default; the other thirteen are `chatDefaultOff` —
 * an Owner enables the ones they want from /admin/settings/guardrails (the
 * chat-tools autonomy table), where the `ask` floor still cannot be lowered.
 * If enabling them pushes a CMS-Agent-mode wire over the bound, the engine
 * trims the membership family and logs it (engine.ts fitToolsToCmsAgentBound).
 */
import { idempotencyKeyJsonSchema, objectSchema, stringSchema } from './mcp-tool-definitions.js';
import type { ToolDefinition } from '../functions/mcp.js';

const HUMAN =
  'HUMAN principal only (an OAuth connection approved by a Netlify Identity human, or the admin-chat human) — agent tokens are refused with 403 membership_requires_human.';
const OWNER = 'Owner tier.';
const DRY = 'Call with dry_run:true first; the approval card shows that result.';

const tierEnum = {
  type: 'string',
  enum: ['owner', 'admin', 'publisher', 'editor', 'viewer'],
  description: 'Workspace tier.',
};
const boolSchema = (description: string) => ({ type: 'boolean', description });

/** MCP tool name → membership verb (also the chat registry's routing table). */
export const MEMBERSHIP_TOOL_VERBS: Record<string, string> = {
  member_list: 'list',
  member_get: 'get',
  member_audit: 'audit',
  member_invite: 'invite',
  invitation_resend: 'resend',
  invitation_revoke: 'revoke',
  member_set_role: 'set_role',
  member_suspend: 'suspend',
  member_reinstate: 'reinstate',
  member_remove: 'remove',
  member_purge: 'purge',
  ownership_transfer: 'transfer_ownership',
  membership_policy_get: 'policy_get',
  membership_policy_set: 'policy_set',
  member_export: 'export',
  membership_contract: 'contract',
};

export const MEMBERSHIP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(MEMBERSHIP_TOOL_VERBS));
export const isMembershipTool = (name: unknown): name is string =>
  typeof name === 'string' && MEMBERSHIP_TOOL_NAMES.has(name);

export const TOOL_DEFINITIONS_MEMBERSHIP: ToolDefinition[] = [
  {
    name: 'membership_contract',
    description: `${HUMAN} Admin tier. Read this FIRST before any member_* call: the machine-readable membership contract — the human gate, the five tiers and what each expands to, role precedence, every verb with its minimum tier / whether it mutates / dry_run support / JSON-schema args, the live policy (who may invite whom, TTLs, min_owners), and the full error-code catalogue. Derived from the enforcing code, so it cannot drift.`,
    inputSchema: objectSchema({}),
    governance: { toolClass: 'read' },
  },
  {
    name: 'member_list',
    description: `${HUMAN} Admin tier. Lists every member of THIS site: role, membership status (invited | active | suspended | removed — removed hidden unless include_removed), provenance (invitation / netlify_ui / bootstrap_env / mcp), last seen; ADMIN_EMAILS break-glass rows are merged in with source:'environment'.`,
    inputSchema: objectSchema({ include_removed: boolSchema('Also list removed memberships (kept for audit).') }),
    governance: { toolClass: 'read' },
  },
  {
    name: 'member_get',
    description: `${HUMAN} Admin tier. One member by e-mail (stored record or environment-managed row); 404 member_not_found otherwise.`,
    inputSchema: objectSchema({ email: stringSchema('The member e-mail.') }, ['email']),
    governance: { toolClass: 'read' },
  },
  {
    name: 'member_audit',
    description: `${HUMAN} ${OWNER} The membership audit stream for one person, newest first (invitation.*, membership.*, person.* events, each with actor and via), plus the legacy per-record audit array.`,
    inputSchema: objectSchema(
      {
        email: stringSchema('The member e-mail.'),
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max events (default 100).' },
      },
      ['email']
    ),
    governance: { toolClass: 'read', chatDefaultOff: true },
  },
  {
    name: 'membership_policy_get',
    description: `${HUMAN} Admin tier. The effective membership policy (invite TTL, max resends, allowed e-mail domains, default role, min_owners, who_can_invite, roles_admin_may_grant, purge grace, delete_identity_on_remove).`,
    inputSchema: objectSchema({}),
    governance: { toolClass: 'read', chatDefaultOff: true },
  },
  {
    name: 'member_invite',
    description: `${HUMAN} Owner tier — or Admin for the tiers the policy allows (default editor|viewer). ${DRY} Creates a first-class Invitation (pending, expiring per policy) + a Person + a Membership{invited}, and asks Netlify Identity to send the invitation e-mail (GoTrue POST /invite; best-effort — the record exists even if the mail could not be sent, and the result says so). One pending invitation per address (409 invite_pending_exists with existing_invite_id — use invitation_resend instead); an active member is 409 member_active (use member_set_role). Returns the invitation, the v1-shaped member view, the send result, and an opaque accept_token shown ONCE (an Owner may share /admin/accept?inv=<token> as a preview link; the e-mail's own link is still needed to set a password).`,
    inputSchema: objectSchema(
      {
        email: stringSchema('Invitee e-mail.'),
        role: tierEnum,
        message: stringSchema('Optional message stored on the invitation and shown on the accept page (≤1000 chars).'),
        dry_run: boolSchema(
          'Preview: would this invite / re-invite / be refused, and would an e-mail go out. Persists nothing.'
        ),
        idempotency_key: idempotencyKeyJsonSchema,
      },
      ['email', 'role']
    ),
    governance: {
      toolClass: 'membership',
      autonomyFloor: 'ask',
      preview: { kind: 'verb_dry_run' },
      chatDefaultOff: true,
    },
  },
  {
    name: 'invitation_resend',
    description: `${HUMAN} ${OWNER} Re-sends a PENDING invitation's e-mail (GoTrue re-sends for an unconfirmed user), bumps send_count, rotates the shareable accept token and extends the expiry. Capped at policy.max_resends (429 resend_cap → invitation_revoke then member_invite again). Expired/revoked/accepted invitations are refused with the matching error code.`,
    inputSchema: objectSchema(
      {
        invite_id: stringSchema('The invitation id (inv_…). Either this or email.'),
        email: stringSchema('The invitee e-mail (finds the open invitation).'),
        idempotency_key: idempotencyKeyJsonSchema,
      },
      []
    ),
    governance: {
      toolClass: 'membership',
      autonomyFloor: 'ask',
      preview: { kind: 'input_echo' },
      chatDefaultOff: true,
    },
  },
  {
    name: 'invitation_revoke',
    description: `${HUMAN} ${OWNER} Revokes a PENDING invitation; a membership that never activated becomes removed (kept for audit, purged after the grace period). A fresh member_invite for the same address is allowed afterwards.`,
    inputSchema: objectSchema(
      {
        invite_id: stringSchema('The invitation id (inv_…). Either this or email.'),
        email: stringSchema('The invitee e-mail.'),
        reason: stringSchema('Optional reason (≤500 chars).'),
        idempotency_key: idempotencyKeyJsonSchema,
      },
      []
    ),
    governance: {
      toolClass: 'membership',
      autonomyFloor: 'ask',
      preview: { kind: 'input_echo' },
      chatDefaultOff: true,
    },
  },
  {
    name: 'member_set_role',
    description: `${HUMAN} ${OWNER} ${DRY} Changes a member's tier (owner | admin | publisher | editor | viewer). Refused for yourself (self_change), for environment-managed rows (env_managed_member), and when demoting the last active Owner below policy.min_owners (last_owner — transfer ownership or add another Owner first).`,
    inputSchema: objectSchema(
      {
        email: stringSchema('The member e-mail.'),
        role: tierEnum,
        dry_run: boolSchema('Preview from/to without persisting.'),
        idempotency_key: idempotencyKeyJsonSchema,
      },
      ['email', 'role']
    ),
    governance: {
      toolClass: 'membership',
      autonomyFloor: 'ask',
      preview: { kind: 'verb_dry_run' },
      chatDefaultOff: true,
    },
  },
  {
    name: 'member_suspend',
    description: `${HUMAN} ${OWNER} Suspends a member: roles resolve to none from now on, their OAuth (MCP) grants are revoked immediately, and any object locks they hold are force-released (history lock_forced_on_offboarding, attributed to you on their behalf). Open Identity sessions expire within the hour. Reversible with member_reinstate. last_owner guard applies.`,
    inputSchema: objectSchema(
      {
        email: stringSchema('The member e-mail.'),
        reason: stringSchema('Optional reason (≤500 chars).'),
        idempotency_key: idempotencyKeyJsonSchema,
      },
      ['email']
    ),
    governance: {
      toolClass: 'membership',
      autonomyFloor: 'ask',
      preview: { kind: 'input_echo' },
      chatDefaultOff: true,
    },
  },
  {
    name: 'member_reinstate',
    description: `${HUMAN} ${OWNER} Reinstates a suspended member with their previous tier. A removed member cannot be reinstated — invite them again.`,
    inputSchema: objectSchema(
      { email: stringSchema('The member e-mail.'), idempotency_key: idempotencyKeyJsonSchema },
      ['email']
    ),
    governance: {
      toolClass: 'membership',
      autonomyFloor: 'ask',
      preview: { kind: 'input_echo' },
      chatDefaultOff: true,
    },
  },
  {
    name: 'member_remove',
    description: `${HUMAN} ${OWNER} ${DRY} Removes a member: everything member_suspend does, plus the membership becomes removed (history kept; the record is purged after policy.purge_grace_days), a pending invitation is revoked, and — by default (policy.delete_identity_on_remove, override with delete_identity:false) — their Netlify Identity login is deleted (immediately when the request carries the Identity admin token, i.e. from the admin UI; from MCP/chat it is QUEUED and drained by the next admin-UI Owner request). Refused for yourself and for the last Owner. Re-inviting later creates a new invitation.`,
    inputSchema: objectSchema(
      {
        email: stringSchema('The member e-mail.'),
        reason: stringSchema('Optional reason (≤500 chars).'),
        delete_identity: boolSchema(
          'Delete their Netlify Identity login too (default: policy.delete_identity_on_remove = true).'
        ),
        dry_run: boolSchema(
          'Preview: role/status, purge window, whether the identity would be deleted now / queued / kept. Persists nothing.'
        ),
        idempotency_key: idempotencyKeyJsonSchema,
      },
      ['email']
    ),
    governance: {
      toolClass: 'membership',
      autonomyFloor: 'ask',
      preview: { kind: 'verb_dry_run' },
      chatDefaultOff: true,
    },
  },
  {
    name: 'member_purge',
    description: `${HUMAN} ${OWNER} Irreversible. Scrubs a REMOVED member's personal data now (person → {person_id, deleted}, indexes gone, avatar soft-deleted; the audit stream and their attribution id are kept) and deletes/queues their Identity login. Requires confirm exactly "PURGE <email>" (verified server-side; 400 confirm_mismatch); 409 not_removed unless member_remove ran first.`,
    inputSchema: objectSchema(
      {
        email: stringSchema('The removed member e-mail.'),
        confirm: stringSchema('Exactly "PURGE <email>".'),
        idempotency_key: idempotencyKeyJsonSchema,
      },
      ['email', 'confirm']
    ),
    governance: {
      toolClass: 'membership',
      autonomyFloor: 'ask',
      preview: { kind: 'input_echo' },
      chatDefaultOff: true,
    },
  },
  {
    name: 'ownership_transfer',
    description: `${HUMAN} ${OWNER} ${DRY} Makes to_email an Owner and demotes from_email (default: yourself) to demote_to (default admin; 'keep' leaves them Owner). Both must be active stored members; environment-managed rows are refused (promote the stored Owner first). Audited on both sides.`,
    inputSchema: objectSchema(
      {
        to_email: stringSchema('The member who becomes Owner.'),
        from_email: stringSchema('The Owner giving it up (default: the caller).'),
        demote_to: {
          type: 'string',
          enum: ['admin', 'publisher', 'editor', 'viewer', 'keep'],
          description: "from_email's tier afterwards (default admin).",
        },
        dry_run: boolSchema('Preview without persisting.'),
        idempotency_key: idempotencyKeyJsonSchema,
      },
      ['to_email']
    ),
    governance: {
      toolClass: 'membership',
      autonomyFloor: 'ask',
      preview: { kind: 'verb_dry_run' },
      chatDefaultOff: true,
    },
  },
  {
    name: 'membership_policy_set',
    description: `${HUMAN} ${OWNER} Overrides membership policy fields for this site (partial: unspecified fields keep the committed default). Fields: invite_ttl_hours, max_resends, allowed_email_domains, default_role, min_owners, require_display_name, purge_grace_days, who_can_invite (owner | owner_admin), roles_admin_may_grant, default_role_for_external, delete_identity_on_remove. Read membership_policy_get first.`,
    inputSchema: objectSchema(
      {
        policy: { type: 'object', description: 'Partial policy override object.', additionalProperties: true },
        idempotency_key: idempotencyKeyJsonSchema,
      },
      ['policy']
    ),
    governance: {
      toolClass: 'membership',
      autonomyFloor: 'ask',
      preview: { kind: 'input_echo' },
      chatDefaultOff: true,
    },
  },
  {
    name: 'member_export',
    description: `${HUMAN} ${OWNER} The GDPR-style bundle for one member: person, memberships, invitations, their audit slice, and the ids (object_type/object_id/at/action) of object-history entries they authored — no third-party data.`,
    inputSchema: objectSchema({ email: stringSchema('The member e-mail.') }, ['email']),
    governance: { toolClass: 'read', chatDefaultOff: true },
  },
];
