/**
 * AdminUsers (T9.5 → W18 T18.3a) — the members page at /admin/settings/admins.
 *
 * Owners manage the five tiers (plan §6) and the membership lifecycle
 * (invited / active / suspended / removed) from a members table: role badge,
 * status badge, provenance badge (Break-glass (env) / Bootstrap / Invitation /
 * Netlify UI / MCP), last seen, and a row menu — Change role (five tiers with
 * a one-line description; options the policy forbids are disabled), Suspend /
 * Reinstate, Remove (typed confirm — keeps history, purged after the grace
 * period), Promote to stored Owner (env rows only), View audit (the T18.1
 * audit stream + the legacy per-record array). Guards are surfaced as toasts
 * (`last_owner` → "Promote another member to Owner first"). A non-Owner Admin
 * sees the page read-only. The server 403s every management verb for a
 * non-owner regardless — the client gate is UX, not the security boundary.
 *
 * T18.3b adds two Owner tabs: **Invitations** (pending / expired / revoked
 * rows with GoTrue send status + "how to fix", Resend (capped) / Revoke /
 * copy-link-once) and **Identities** (GoTrue users with no membership here —
 * "Grant role…"; "Delete identity" appears only when the server reports the
 * T18.4 capability). The invite dialog gains an optional message and an
 * inline domain-not-allowed error; a fresh invitation shows its shareable
 * link exactly once (we store only the token's hash).
 */
import { useEffect, useMemo, useState } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Avatar, Badge, Button, Card, EmptyState, IconButton, Skeleton, StatusPill } from './primitives';
import { Input, Select, Switch, Textarea } from './forms';
import { Dialog, ConfirmDialog, Drawer, useToast } from './overlays';
import { DataTable, type Column } from './data';
import { DropdownMenu, Tabs } from './menus';
import {
  DEFAULT_POLICY_VIEW,
  MEMBERSHIP_TIERS,
  formatExpiresIn,
  grantableTiers,
  invitationActionsFor,
  invitationSendStatus,
  memberActionsFor,
  memberSourceLabel,
  relativeTimeFromNow,
  roleOptionsFor,
  tierLabel,
  type MembershipPolicyView,
  type MembershipTier,
} from './logic';
import { canonicalMemberDisplayName, presentLastSeen } from '@core/lib/admin/admin-user-presentation';
import { IconDots, IconPlus, IconAlertTriangle, IconUser, IconCheck } from './icons';
import {
  fetchMe,
  listUsers,
  inviteUser,
  setUserRole,
  suspendUser,
  reinstateUser,
  removeUser,
  promoteBootstrapOwner,
  memberAudit,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  listUnmanagedIdentities,
  grantRole,
  avatarSrc,
  type UserView,
  type UserRole,
  type AuditEventView,
  type InvitationView,
  type UnmanagedIdentityView,
} from '@core/lib/admin/users-client';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

type Confirm =
  | { kind: 'role'; user: UserView; role: UserRole }
  | { kind: 'suspend'; user: UserView }
  | { kind: 'reinstate'; user: UserView }
  | { kind: 'remove'; user: UserView }
  | { kind: 'promote'; user: UserView }
  | null;

/**
 * W18 review ruling (Wolf, 2026-08-18): the **Identities** tab is HIDDEN.
 * Every member on this platform arrives through the platform invite flow, so
 * a "GoTrue users with no membership here" reconcile view is noise on a good
 * day — and while `listMembers` was returning nothing (the `paginate: true`
 * defect this review fixed) it listed every real member as "unmanaged" and
 * offered *Delete identity* on them.
 *
 * `IdentitiesPanel` and its `unmanaged_identities` / `grant` / `delete_identity`
 * verbs are deliberately KEPT — flip this flag to bring the tab back once
 * Netlify-UI-invited users are a real path again. Typed `boolean` (not the
 * `false` literal) so the tab body stays type-checked and lint-clean.
 */
const SHOW_IDENTITIES_TAB: boolean = false;

const errorMessage = (err: unknown, fallback = 'Something went wrong.') =>
  err instanceof Error ? err.message : fallback;

/** `last_owner` and friends arrive as `error` text; map the known ones to helpful copy. */
const friendlyError = (err: unknown): string => {
  const msg = errorMessage(err);
  if (/last Owner/i.test(msg)) return 'This is the last Owner — promote another member to Owner first.';
  return msg;
};

const membershipStatus = (u: UserView): 'invited' | 'active' | 'suspended' | 'removed' =>
  u.membership_status ?? (u.status === 'disabled' ? 'suspended' : u.status);

const statusLabelFor = (u: UserView) => {
  const s = membershipStatus(u);
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const statusToneFor = (u: UserView) => {
  switch (membershipStatus(u)) {
    case 'active':
      return 'success' as const;
    case 'invited':
      return 'info' as const;
    case 'suspended':
      return 'warning' as const;
    default:
      return 'neutral' as const;
  }
};

const roleTone = (role: string) => (role === 'owner' ? 'accent' : role === 'admin' ? 'info' : 'neutral');

// ─── role picker ─────────────────────────────────────────────────────────────

function RolePicker({
  value,
  onChange,
  actorRoles,
  policy,
  currentRole,
  label = 'Role',
}: {
  value: UserRole;
  onChange: (role: UserRole) => void;
  actorRoles: readonly string[];
  policy: MembershipPolicyView;
  currentRole?: string;
  label?: string;
}) {
  const options = roleOptionsFor({ actorRoles, policy, currentRole });
  const selected = options.find((o) => o.value === value);
  return (
    <div className="flex flex-col gap-2">
      <Select
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as UserRole)}
        options={options.map((o) => ({
          value: o.value,
          label: o.disabled && o.reason ? `${o.label} — ${o.reason}` : o.label,
        }))}
      />
      {selected ? (
        <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{selected.description}</p>
      ) : null}
      {selected?.disabled ? (
        <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-warning,#b7791f)]">{selected.reason}</p>
      ) : null}
    </div>
  );
}

// ─── members body ────────────────────────────────────────────────────────────

export function AdminUsersBody() {
  const { toast } = useToast();
  const [meEmail, setMeEmail] = useState<string>('');
  const [me, setMe] = useState<Pick<UserView, 'email' | 'display_name'> | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [users, setUsers] = useState<UserView[]>([]);
  const [showRemoved, setShowRemoved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const policy: MembershipPolicyView = DEFAULT_POLICY_VIEW;

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<UserRole>('admin');
  const [inviteMessage, setInviteMessage] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [createdLink, setCreatedLink] = useState<{ email: string; token: string } | null>(null);
  const [tab, setTab] = useState<'members' | 'invitations' | 'identities'>('members');
  const [invitationsVersion, setInvitationsVersion] = useState(0);

  const [confirm, setConfirm] = useState<Confirm>(null);
  const [roleDialog, setRoleDialog] = useState<{ user: UserView; role: UserRole } | null>(null);
  const [auditUser, setAuditUser] = useState<UserView | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEventView[] | null>(null);

  const owner = roles.includes('owner');
  const canInvite = grantableTiers(roles, policy).length > 0;

  const refresh = async (includeRemoved = showRemoved) => {
    const { users } = await listUsers(getToken, includeRemoved ? { include_removed: true } : {});
    setUsers(users);
  };

  useEffect(() => {
    setNow(Date.now());
    let alive = true;
    (async () => {
      try {
        const res = await fetchMe(getToken);
        if (!alive) return;
        setMeEmail(res.user.email);
        setMe(res.user);
        setRoles(res.roles);
        // T18.6a: `list` is admin-tier (read-only for Admins); Owners get the actions.
        if (res.roles.includes('admin')) await refresh(false);
        if (alive) setLoading(false);
      } catch (err) {
        if (alive) {
          setError(errorMessage(err, 'Could not load members.'));
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!inviteOpen) return;
    const allowed = grantableTiers(roles, policy);
    if (allowed.length && !allowed.includes(inviteRole as MembershipTier)) setInviteRole(allowed[allowed.length - 1]);
  }, [inviteOpen, roles]);

  useEffect(() => {
    if (!auditUser) {
      setAuditEvents(null);
      return;
    }
    let alive = true;
    memberAudit(getToken, auditUser.email)
      .then((res) => {
        if (alive) setAuditEvents(res.events);
      })
      .catch(() => {
        if (alive) setAuditEvents([]);
      });
    return () => {
      alive = false;
    };
  }, [auditUser]);

  const doInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    setInviteError(null);
    try {
      const res = await inviteUser(getToken, email, inviteRole, inviteMessage.trim() || undefined);
      if (owner) await refresh();
      setInviteOpen(false);
      setInviteEmail('');
      setInviteMessage('');
      setInvitationsVersion((v) => v + 1);
      setCreatedLink({ email, token: res.accept_token });
      toast({
        title: `Invited ${email} as ${tierLabel(inviteRole)}`,
        description: res.invite.sent
          ? 'Invitation e-mail sent.'
          : res.invite.error === 'already_invited'
            ? 'Already in Netlify Identity — they can sign in, or re-send from the Netlify UI.'
            : 'Record created; the invitation e-mail could not be sent yet (see Invitations).',
        tone: res.invite.sent ? 'success' : 'warning',
      });
    } catch (err) {
      const msg = friendlyError(err);
      if (/domain|already pending|already an active member/i.test(msg)) setInviteError(msg);
      else toast({ title: 'Invite failed', description: msg, tone: 'danger' });
    } finally {
      setInviting(false);
    }
  };

  const applyConfirm = async () => {
    if (!confirm) return;
    const name = confirm.user.display_name;
    try {
      switch (confirm.kind) {
        case 'role':
          await setUserRole(getToken, confirm.user.email, confirm.role);
          toast({ title: `${name} is now ${tierLabel(confirm.role)}`, tone: 'success' });
          break;
        case 'suspend':
          await suspendUser(getToken, confirm.user.email);
          toast({
            title: `${name} suspended`,
            description: 'They cannot act from now on; open sessions expire within the hour.',
            tone: 'warning',
          });
          break;
        case 'reinstate':
          await reinstateUser(getToken, confirm.user.email);
          toast({ title: `${name} reinstated`, tone: 'success' });
          break;
        case 'remove':
          await removeUser(getToken, confirm.user.email);
          toast({
            title: `${name} removed`,
            description: 'History kept; you can re-invite them later.',
            tone: 'warning',
          });
          break;
        case 'promote':
          await promoteBootstrapOwner(getToken, confirm.user.email);
          toast({
            title: `${name} is now a stored Owner`,
            description: 'The ADMIN_EMAILS row can be removed once you are happy.',
            tone: 'success',
          });
          break;
      }
      await refresh();
    } catch (err) {
      toast({ title: 'Update failed', description: friendlyError(err), tone: 'danger' });
    } finally {
      setConfirm(null);
      setRoleDialog(null);
    }
  };

  const visibleUsers = useMemo(
    () => (showRemoved ? users : users.filter((u) => membershipStatus(u) !== 'removed')),
    [users, showRemoved]
  );

  if (loading) return <Skeleton variant="rect" height={280} />;
  if (error) {
    return (
      <Card>
        <EmptyState icon={<IconAlertTriangle size={26} />} title="Couldn't load members" message={error} />
      </Card>
    );
  }
  if (!owner && !roles.includes('admin')) {
    return (
      <Card>
        <EmptyState
          icon={<IconUser size={26} />}
          title="Owner access required"
          message="Only Owners manage members; Admins can view the list. Ask an Owner to change your role."
        />
      </Card>
    );
  }
  const allColumns: Column<UserView>[] = [
    {
      key: 'display_name',
      header: 'Member',
      sortable: true,
      accessor: (u) => u.display_name,
      render: (u) => {
        const displayName = canonicalMemberDisplayName(u, me);
        const src = avatarSrc(u.avatar_artifact);
        const sourceLabel = memberSourceLabel(u);
        return (
          <div className="flex items-center gap-2.5">
            {src ? (
              <img src={src} alt="" className="h-7 w-7 rounded-full object-cover" />
            ) : (
              <Avatar name={displayName} size={28} />
            )}
            <div className="min-w-0">
              <div className="truncate font-medium text-[var(--adm-text)]">
                {displayName}
                {u.email === meEmail ? (
                  <span className="ml-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">(you)</span>
                ) : null}
                {sourceLabel ? (
                  <Badge
                    tone={u.source === 'environment' ? 'warning' : 'neutral'}
                    className="ml-2 align-middle"
                    title={
                      u.source === 'environment'
                        ? 'Configured in ADMIN_EMAILS / ROLE_EMAILS_* — the break-glass fallback. Promote to a stored Owner to manage them here.'
                        : `Joined via ${sourceLabel.toLowerCase()}`
                    }
                  >
                    {sourceLabel}
                  </Badge>
                ) : null}
              </div>
              <div className="truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{u.email}</div>
            </div>
          </div>
        );
      },
    },
    {
      key: 'role',
      header: 'Role',
      sortable: true,
      accessor: (u) => MEMBERSHIP_TIERS.findIndex((t) => t.value === u.role),
      render: (u) => (
        <Badge tone={roleTone(u.role)} title={MEMBERSHIP_TIERS.find((t) => t.value === u.role)?.description}>
          {tierLabel(u.role)}
        </Badge>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      accessor: (u) => membershipStatus(u),
      render: (u) => <StatusPill status={membershipStatus(u)} tone={statusToneFor(u)} label={statusLabelFor(u)} />,
    },
    {
      key: 'last_seen_at',
      header: 'Last seen',
      sortable: true,
      accessor: (u) => u.last_seen_at ?? '',
      render: (u) => {
        const lastSeen = presentLastSeen(u);
        return (
          <span className="text-[var(--adm-text-muted)]">
            {lastSeen.kind === 'relative' ? relativeTimeFromNow(u.last_seen_at, now) : lastSeen.label}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (u) => {
        const actions = memberActionsFor({ row: u, actorEmail: meEmail, actorRoles: roles });
        const items = [
          actions.includes('change_role')
            ? { id: 'role', label: 'Change role…', onSelect: () => setRoleDialog({ user: u, role: u.role }) }
            : null,
          actions.includes('promote_bootstrap')
            ? {
                id: 'promote',
                label: 'Promote to stored Owner…',
                title: 'Create a normal Owner membership so the ADMIN_EMAILS row can be emptied later.',
                onSelect: () => setConfirm({ kind: 'promote', user: u }),
              }
            : null,
          { id: 'audit', label: 'View audit trail', onSelect: () => setAuditUser(u) },
          actions.includes('suspend')
            ? {
                id: 'suspend',
                label: 'Suspend',
                tone: 'danger' as const,
                separatorBefore: true,
                onSelect: () => setConfirm({ kind: 'suspend', user: u }),
              }
            : null,
          actions.includes('reinstate')
            ? {
                id: 'reinstate',
                label: 'Reinstate',
                separatorBefore: true,
                onSelect: () => setConfirm({ kind: 'reinstate', user: u }),
              }
            : null,
          actions.includes('remove')
            ? {
                id: 'remove',
                label: 'Remove…',
                tone: 'danger' as const,
                onSelect: () => setConfirm({ kind: 'remove', user: u }),
              }
            : null,
        ].filter((i): i is NonNullable<typeof i> => i !== null);
        return (
          <DropdownMenu
            align="end"
            trigger={({ ref, onToggle }) => (
              <IconButton
                ref={ref}
                label={`Actions for ${u.display_name}`}
                icon={<IconDots size={18} />}
                size="sm"
                onClick={onToggle}
              />
            )}
            items={items}
          />
        );
      },
    },
  ];

  const columns = owner ? allColumns : allColumns.filter((c) => c.key !== 'actions');
  const removedCount = users.filter((u) => membershipStatus(u) === 'removed').length;

  const membersTab = (
    <div className="flex flex-col gap-4 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          {visibleUsers.length} {visibleUsers.length === 1 ? 'member' : 'members'}
          {removedCount ? ` · ${removedCount} removed` : ''}
        </p>
        <div className="flex items-center gap-3">
          {/* W18 review (2026-08-18): this was gated on `removedCount`, which is
              computed from a list the server filters `removed` OUT of unless
              `include_removed` is set — so the toggle that loads them could
              never appear. Owners always get it. */}
          {owner ? (
            <Switch
              checked={showRemoved}
              onCheckedChange={(v) => {
                setShowRemoved(v);
                void refresh(v);
              }}
              label="Show removed"
            />
          ) : null}
          {canInvite ? (
            <Button leftIcon={<IconPlus size={16} />} onClick={() => setInviteOpen(true)}>
              Invite
            </Button>
          ) : null}
        </div>
      </div>

      {visibleUsers.length === 0 ? (
        <EmptyState
          icon={<IconUser size={26} />}
          title="No members yet"
          message="Invite your first member to start managing this publication."
        />
      ) : (
        <DataTable
          columns={columns}
          rows={visibleUsers}
          getRowKey={(u) => u.email}
          initialSort={{ key: 'display_name', dir: 'asc' }}
        />
      )}
    </div>
  );

  if (!owner) {
    // T18.6a: Admins see the members list read-only (no row actions, no
    // Invitations/Identities tabs) and may invite when the policy allows.
    return (
      <div className="flex flex-col gap-4">
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          Read-only — Owners manage members and invitations.
        </p>
        {membersTab}
        <InviteDialog
          open={inviteOpen}
          onClose={() => setInviteOpen(false)}
          email={inviteEmail}
          setEmail={setInviteEmail}
          role={inviteRole}
          setRole={setInviteRole}
          onSubmit={doInvite}
          busy={inviting}
          actorRoles={roles}
          policy={policy}
          message={inviteMessage}
          setMessage={setInviteMessage}
          error={inviteError}
        />
        <CreatedLinkDialog created={createdLink} onClose={() => setCreatedLink(null)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Tabs
        value={tab}
        onChange={(id) => setTab(id as typeof tab)}
        tabs={[
          { id: 'members', label: 'Members', content: membersTab },
          {
            id: 'invitations',
            label: 'Invitations',
            content: (
              <InvitationsPanel
                key={invitationsVersion}
                now={now}
                policy={policy}
                onInvite={() => setInviteOpen(true)}
                onChanged={() => {
                  void refresh();
                }}
                onLink={(email, token) => setCreatedLink({ email, token })}
              />
            ),
          },
          ...(SHOW_IDENTITIES_TAB
            ? [
                {
                  id: 'identities',
                  label: 'Identities',
                  content: (
                    <IdentitiesPanel
                      actorRoles={roles}
                      policy={policy}
                      onGranted={() => {
                        void refresh();
                      }}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        email={inviteEmail}
        setEmail={setInviteEmail}
        role={inviteRole}
        setRole={setInviteRole}
        onSubmit={doInvite}
        busy={inviting}
        actorRoles={roles}
        policy={policy}
        message={inviteMessage}
        setMessage={setInviteMessage}
        error={inviteError}
      />
      <CreatedLinkDialog created={createdLink} onClose={() => setCreatedLink(null)} />

      <Dialog
        open={roleDialog !== null}
        onClose={() => setRoleDialog(null)}
        title={roleDialog ? `Change ${roleDialog.user.display_name}'s role` : 'Change role'}
        description="Roles take effect on their next request; open sessions keep their tokens for up to an hour."
        footer={
          <>
            <Button variant="secondary" onClick={() => setRoleDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={!roleDialog || roleDialog.role === roleDialog.user.role}
              onClick={() => roleDialog && setConfirm({ kind: 'role', user: roleDialog.user, role: roleDialog.role })}
            >
              Change role
            </Button>
          </>
        }
      >
        {roleDialog ? (
          <RolePicker
            value={roleDialog.role}
            onChange={(role) => setRoleDialog({ ...roleDialog, role })}
            actorRoles={roles}
            policy={policy}
            currentRole={roleDialog.user.role}
            label="New role"
          />
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={confirm?.kind === 'role'}
        onClose={() => setConfirm(null)}
        onConfirm={applyConfirm}
        title="Change role?"
        message={
          confirm?.kind === 'role'
            ? `${confirm.user.display_name}: ${tierLabel(confirm.user.role)} → ${tierLabel(confirm.role)}. ${
                MEMBERSHIP_TIERS.find((t) => t.value === confirm.role)?.description ?? ''
              }`
            : ''
        }
        confirmLabel="Change role"
      />

      <ConfirmDialog
        open={confirm?.kind === 'suspend'}
        onClose={() => setConfirm(null)}
        onConfirm={applyConfirm}
        title="Suspend member?"
        message={
          confirm?.kind === 'suspend'
            ? `${confirm.user.display_name} loses access within an hour (sessions expire) and cannot act from now on. You can reinstate them any time.`
            : ''
        }
        confirmLabel="Suspend"
        tone="danger"
      />

      <ConfirmDialog
        open={confirm?.kind === 'reinstate'}
        onClose={() => setConfirm(null)}
        onConfirm={applyConfirm}
        title="Reinstate member?"
        message={
          confirm?.kind === 'reinstate'
            ? `${confirm.user.display_name} gets their ${tierLabel(confirm.user.role)} access back.`
            : ''
        }
        confirmLabel="Reinstate"
      />

      <ConfirmDialog
        open={confirm?.kind === 'remove'}
        onClose={() => setConfirm(null)}
        onConfirm={applyConfirm}
        title="Remove member?"
        message={
          confirm?.kind === 'remove'
            ? `${confirm.user.display_name} loses access within an hour and is taken off the members list. Their history is kept and the record is purged after the grace period; you can re-invite them later. Type their e-mail to confirm.`
            : ''
        }
        confirmLabel="Remove member"
        tone="danger"
        requireTyped={confirm?.kind === 'remove' ? confirm.user.email : undefined}
      />

      <ConfirmDialog
        open={confirm?.kind === 'promote'}
        onClose={() => setConfirm(null)}
        onConfirm={applyConfirm}
        title="Promote to stored Owner?"
        message={
          confirm?.kind === 'promote'
            ? `${confirm.user.email} is currently an Owner only because of ADMIN_EMAILS (break-glass). This creates a normal, stored Owner membership so the env row can be emptied later.`
            : ''
        }
        confirmLabel="Promote"
      />

      <Drawer
        open={auditUser !== null}
        onClose={() => setAuditUser(null)}
        title={auditUser ? `${auditUser.display_name} — audit` : 'Audit'}
      >
        {auditEvents === null ? (
          <Skeleton variant="rect" height={120} />
        ) : auditEvents.length > 0 ? (
          <ol className="flex flex-col gap-3">
            {auditEvents.map((entry) => (
              <li key={entry.event_id} className="border-b border-[var(--adm-border)] pb-2 last:border-0">
                <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
                  {entry.action}
                  {entry.detail && Object.keys(entry.detail).length ? (
                    <span className="text-[var(--adm-text-muted)]">
                      {' '}
                      —{' '}
                      {Object.entries(entry.detail)
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(', ')}
                    </span>
                  ) : null}
                </p>
                <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                  {entry.actor.kind === 'human'
                    ? entry.actor.email
                    : entry.actor.kind === 'agent'
                      ? entry.actor.agent_name
                      : 'system'}{' '}
                  · {entry.via} · {now ? relativeTimeFromNow(entry.at, now) : entry.at}
                </p>
              </li>
            ))}
          </ol>
        ) : auditUser?.audit && auditUser.audit.length > 0 ? (
          <ol className="flex flex-col gap-3">
            {[...auditUser.audit].reverse().map((entry, i) => (
              <li key={i} className="border-b border-[var(--adm-border)] pb-2 last:border-0">
                <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
                  {entry.action}
                  {entry.detail ? <span className="text-[var(--adm-text-muted)]"> — {entry.detail}</span> : null}
                </p>
                <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                  {entry.actor_email} · {now ? relativeTimeFromNow(entry.at, now) : entry.at}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">No audit entries yet.</p>
        )}
      </Drawer>
    </div>
  );
}

// ─── invite dialog ───────────────────────────────────────────────────────────

function InviteDialog({
  open,
  onClose,
  email,
  setEmail,
  role,
  setRole,
  onSubmit,
  busy,
  actorRoles,
  policy,
  message,
  setMessage,
  error,
}: {
  open: boolean;
  onClose: () => void;
  email: string;
  setEmail: (v: string) => void;
  role: UserRole;
  setRole: (r: UserRole) => void;
  onSubmit: () => void;
  busy: boolean;
  actorRoles: readonly string[];
  policy: MembershipPolicyView;
  message: string;
  setMessage: (v: string) => void;
  error: string | null;
}) {
  const allowed = grantableTiers(actorRoles, policy);
  const roleOk = allowed.includes(role as MembershipTier);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invite a member"
      description="They get a Netlify Identity invitation e-mail and set their name and password on the accept page."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={busy} disabled={busy || !email.trim() || !roleOk}>
            Send invite
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
          error={error ?? undefined}
        />
        <RolePicker value={role} onChange={setRole} actorRoles={actorRoles} policy={policy} />
        <Textarea
          label="Message (optional)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          maxLength={1000}
          hint="Stored on the invitation; shown on the accept page when you share the invitation link yourself."
        />
      </div>
    </Dialog>
  );
}

/** Shown ONCE after an invite/resend: we store only the token's hash, so the link cannot be recovered later. */
function CreatedLinkDialog({
  created,
  onClose,
}: {
  created: { email: string; token: string } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!created) setCopied(false);
  }, [created]);
  const link =
    created && typeof window !== 'undefined' ? `${window.location.origin}/admin/accept?inv=${created.token}` : '';
  return (
    <Dialog
      open={created !== null}
      onClose={onClose}
      title="Invitation created"
      description={
        created
          ? `${created.email} gets the Netlify Identity e-mail. You can also share this link yourself — it previews who invited them and as what; the e-mail's own link is still needed to set a password.`
          : undefined
      }
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        <Input label="Invitation link (shown once)" value={link} readOnly onFocus={(e) => e.currentTarget.select()} />
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            Copy link
          </Button>
          {copied ? (
            <span className="flex items-center gap-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              <IconCheck size={14} /> Copied
            </span>
          ) : null}
        </div>
        <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          After you close this, the link is no longer available — Resend from the Invitations tab to get a new one.
        </p>
      </div>
    </Dialog>
  );
}

// ─── invitations tab (T18.3b) ────────────────────────────────────────────────

function InvitationsPanel({
  now,
  policy,
  onInvite,
  onChanged,
  onLink,
}: {
  now: number;
  policy: MembershipPolicyView;
  onInvite: () => void;
  onChanged: () => void;
  onLink: (email: string, token: string) => void;
}) {
  const { toast } = useToast();
  const [rows, setRows] = useState<InvitationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<InvitationView | null>(null);

  const load = async () => {
    try {
      const { invitations } = await listInvitations(getToken);
      setRows(invitations.filter((i) => i.status !== 'accepted'));
    } catch (err) {
      setError(errorMessage(err, 'Could not load invitations.'));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const doResend = async (inv: InvitationView) => {
    setBusyId(inv.invite_id);
    try {
      const res = await resendInvitation(getToken, { invite_id: inv.invite_id });
      toast({
        title: `Re-sent to ${inv.email}`,
        description: res.invite.sent ? 'Invitation e-mail sent again.' : (res.invite.error ?? 'Not sent.'),
        tone: res.invite.sent ? 'success' : 'warning',
      });
      onLink(inv.email, res.accept_token);
      await load();
    } catch (err) {
      toast({ title: 'Resend failed', description: friendlyError(err), tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const doRevoke = async () => {
    if (!revoke) return;
    setBusyId(revoke.invite_id);
    try {
      await revokeInvitation(getToken, { invite_id: revoke.invite_id });
      toast({ title: `Invitation for ${revoke.email} revoked`, tone: 'warning' });
      await load();
      onChanged();
    } catch (err) {
      toast({ title: 'Revoke failed', description: friendlyError(err), tone: 'danger' });
    } finally {
      setBusyId(null);
      setRevoke(null);
    }
  };

  if (error) {
    return (
      <Card className="mt-3">
        <EmptyState icon={<IconAlertTriangle size={26} />} title="Couldn't load invitations" message={error} />
      </Card>
    );
  }
  if (rows === null) return <Skeleton variant="rect" height={200} className="mt-3" />;

  const columns: Column<InvitationView>[] = [
    {
      key: 'email',
      header: 'Invitee',
      sortable: true,
      accessor: (i) => i.email,
      render: (i) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-[var(--adm-text)]">{i.email}</div>
          <div className="truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            invited by {i.invited_by.email}
            {i.message ? ` · “${i.message}”` : ''}
          </div>
        </div>
      ),
    },
    { key: 'role', header: 'Role', render: (i) => <Badge tone={roleTone(i.role)}>{tierLabel(i.role)}</Badge> },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      accessor: (i) => i.status,
      render: (i) => (
        <div className="flex flex-col gap-0.5">
          <StatusPill
            status={i.status}
            tone={i.status === 'pending' ? 'info' : i.status === 'revoked' ? 'danger' : 'neutral'}
            label={i.status.charAt(0).toUpperCase() + i.status.slice(1)}
          />
          <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {i.status === 'pending' && now ? formatExpiresIn(i.expires_at, now) : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'sent',
      header: 'E-mail',
      render: (i) => {
        const st = invitationSendStatus({
          gotrue_invited: i.gotrue.invited,
          gotrue_error: i.gotrue.error,
          send_count: i.gotrue.send_count,
        });
        return (
          <div className="flex flex-col gap-0.5">
            <Badge tone={st.tone} title={st.hint}>
              {st.label}
            </Badge>
            <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              {i.gotrue.last_sent_at && now ? `last ${relativeTimeFromNow(i.gotrue.last_sent_at, now)}` : ''}
              {st.hint ? (
                <span title={st.hint} className="ml-1 cursor-help underline decoration-dotted">
                  How to fix
                </span>
              ) : null}
            </span>
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (i) => {
        const a = invitationActionsFor(
          {
            status: i.status,
            send_count: i.gotrue.send_count,
            gotrue_invited: i.gotrue.invited,
            gotrue_error: i.gotrue.error,
          },
          policy
        );
        return (
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!a.resend.enabled || busyId === i.invite_id}
              title={a.resend.reason}
              onClick={() => void doResend(i)}
              loading={busyId === i.invite_id}
            >
              Resend
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!a.revoke.enabled || busyId === i.invite_id}
              title={a.revoke.reason}
              onClick={() => setRevoke(i)}
            >
              Revoke
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-4 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          {rows.filter((r) => r.status === 'pending').length} pending · accepted invitations move to Members
        </p>
        <Button leftIcon={<IconPlus size={16} />} onClick={onInvite}>
          Invite
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={<IconUser size={26} />}
          title="No open invitations"
          message="Everyone you invited has accepted, or nobody has been invited yet."
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(i) => i.invite_id}
          initialSort={{ key: 'status', dir: 'asc' }}
        />
      )}
      <ConfirmDialog
        open={revoke !== null}
        onClose={() => setRevoke(null)}
        onConfirm={doRevoke}
        title="Revoke invitation?"
        message={
          revoke
            ? `${revoke.email} will not be able to accept. If they never signed in, their pending membership is removed too. You can invite them again later.`
            : ''
        }
        confirmLabel="Revoke"
        tone="danger"
      />
    </div>
  );
}

// ─── unmanaged identities (T18.3b, plan §4.2) ────────────────────────────────

function IdentitiesPanel({
  actorRoles,
  policy,
  onGranted,
}: {
  actorRoles: readonly string[];
  policy: MembershipPolicyView;
  onGranted: () => void;
}) {
  const { toast } = useToast();
  const [state, setState] = useState<{
    identities: UnmanagedIdentityView[];
    error_code?: string;
    error?: string;
    capabilities?: { delete_identity?: boolean };
  } | null>(null);
  const [grant, setGrant] = useState<{ identity: UnmanagedIdentityView; role: UserRole } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await listUnmanagedIdentities(getToken);
      setState(res as typeof state);
    } catch (err) {
      setState({ identities: [], error: errorMessage(err, 'Could not load identities.') });
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const doGrant = async () => {
    if (!grant) return;
    setBusy(true);
    try {
      await grantRole(getToken, grant.identity.email, grant.role, grant.identity.id);
      toast({ title: `${grant.identity.email} is now ${tierLabel(grant.role)}`, tone: 'success' });
      setGrant(null);
      await load();
      onGranted();
    } catch (err) {
      toast({ title: 'Grant failed', description: friendlyError(err), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (state === null) return <Skeleton variant="rect" height={200} className="mt-3" />;
  const defaultRole = (grantableTiers(actorRoles, policy).at(-1) ?? 'viewer') as UserRole;

  return (
    <div className="flex flex-col gap-4 pt-3">
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        People who exist in Netlify Identity for this site but have no role here — typically invited from the Netlify
        console. Grant a role to bring them into the workspace.
      </p>
      {state.error_code === 'identity_admin_unavailable' ? (
        <Card>
          <EmptyState
            icon={<IconAlertTriangle size={26} />}
            title="Identity list unavailable"
            message="The Identity admin token was not available for this request (Identity disabled on the site, or a local run). Enable Netlify Identity on the site and reload."
          />
        </Card>
      ) : state.identities.length === 0 ? (
        <EmptyState
          icon={<IconCheck size={26} />}
          title="Everyone in Netlify Identity has a role here"
          message="Nothing to reconcile."
        />
      ) : (
        <DataTable
          columns={[
            {
              key: 'email',
              header: 'Identity',
              sortable: true,
              accessor: (i: UnmanagedIdentityView) => i.email,
              render: (i: UnmanagedIdentityView) => (
                <div className="min-w-0">
                  <div className="truncate font-medium text-[var(--adm-text)]">{i.email}</div>
                  <div className="truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                    {i.confirmed ? 'confirmed' : 'invited, not yet confirmed'}
                    {i.last_sign_in_at ? ` · last sign-in ${i.last_sign_in_at.slice(0, 10)}` : ''}
                  </div>
                </div>
              ),
            },
            {
              key: 'actions',
              header: '',
              align: 'right' as const,
              render: (i: UnmanagedIdentityView) => (
                <div className="flex items-center justify-end gap-2">
                  <Button size="sm" onClick={() => setGrant({ identity: i, role: defaultRole })}>
                    Grant role…
                  </Button>
                  {state.capabilities?.delete_identity ? (
                    <Button size="sm" variant="ghost" title="Delete this Netlify Identity user (T18.4)" disabled>
                      Delete identity
                    </Button>
                  ) : null}
                </div>
              ),
            },
          ]}
          rows={state.identities}
          getRowKey={(i) => i.id}
        />
      )}
      <Dialog
        open={grant !== null}
        onClose={() => setGrant(null)}
        title={grant ? `Grant ${grant.identity.email} a role` : 'Grant role'}
        description="Creates an active membership for this identity (source: Netlify UI). They can sign in straight away."
        footer={
          <>
            <Button variant="secondary" onClick={() => setGrant(null)}>
              Cancel
            </Button>
            <Button onClick={doGrant} loading={busy} disabled={busy}>
              Grant role
            </Button>
          </>
        }
      >
        {grant ? (
          <RolePicker
            value={grant.role}
            onChange={(role) => setGrant({ ...grant, role })}
            actorRoles={actorRoles}
            policy={policy}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

export interface AdminUsersProps {
  identity: SiteIdentity;
}

export default function AdminUsers({ identity }: AdminUsersProps) {
  return (
    <AdminShell currentPath="/admin/settings/admins" title="Members" identity={identity}>
      <AdminUsersBody />
    </AdminShell>
  );
}
