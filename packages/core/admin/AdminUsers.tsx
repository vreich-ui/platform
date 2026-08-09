/**
 * AdminUsers (T9.5) — the Owner-only members page: a members table, invite
 * dialog, role-change / disable confirms, and a per-member audit drawer. The
 * server 403s a non-owner on every management verb; this UI additionally hides
 * for non-owners.
 */
import { useEffect, useState } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Avatar, Badge, Button, Card, EmptyState, IconButton, Skeleton, StatusPill } from './primitives';
import { Input, Select } from './forms';
import { Dialog, ConfirmDialog, Drawer, useToast } from './overlays';
import { DataTable, type Column } from './data';
import { DropdownMenu } from './menus';
import { relativeTimeFromNow } from './logic';
import { canonicalMemberDisplayName, presentLastSeen } from '@core/lib/admin/admin-user-presentation';
import { IconDots, IconPlus, IconAlertTriangle, IconUser } from './icons';
import {
  fetchMe,
  listUsers,
  inviteUser,
  setUserRole,
  disableUser,
  avatarSrc,
  type UserView,
  type UserRole,
} from '@core/lib/admin/users-client';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

type Confirm = { kind: 'role'; user: UserView; role: UserRole } | { kind: 'disable'; user: UserView } | null;

const roleLabel = (role: UserView['role']) => role.charAt(0).toUpperCase() + role.slice(1);

function AdminUsersBody() {
  const { toast } = useToast();
  const [meEmail, setMeEmail] = useState<string>('');
  const [me, setMe] = useState<Pick<UserView, 'email' | 'display_name'> | null>(null);
  const [owner, setOwner] = useState<boolean | null>(null);
  const [users, setUsers] = useState<UserView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<UserRole>('admin');
  const [inviting, setInviting] = useState(false);

  const [confirm, setConfirm] = useState<Confirm>(null);
  const [auditUser, setAuditUser] = useState<UserView | null>(null);

  const refresh = async () => {
    const { users } = await listUsers(getToken);
    setUsers(users);
  };

  useEffect(() => {
    setNow(Date.now());
    let alive = true;
    (async () => {
      try {
        const me = await fetchMe(getToken);
        if (!alive) return;
        setMeEmail(me.user.email);
        setMe(me.user);
        const isOwner = me.roles.includes('owner');
        setOwner(isOwner);
        if (isOwner) await refresh();
        if (alive) setLoading(false);
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : 'Could not load members.');
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const doInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    try {
      const res = await inviteUser(getToken, email, inviteRole);
      await refresh();
      setInviteOpen(false);
      setInviteEmail('');
      toast({
        title: `Invited ${email}`,
        description: res.invite.sent ? 'Invitation email sent.' : 'Record created; invite email pending.',
        tone: res.invite.sent ? 'success' : 'warning',
      });
    } catch (err) {
      toast({ title: 'Invite failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setInviting(false);
    }
  };

  const applyConfirm = async () => {
    if (!confirm) return;
    try {
      if (confirm.kind === 'role') {
        await setUserRole(getToken, confirm.user.email, confirm.role);
        toast({ title: `${confirm.user.display_name} is now ${confirm.role}`, tone: 'success' });
      } else {
        await disableUser(getToken, confirm.user.email);
        toast({ title: `${confirm.user.display_name} disabled`, tone: 'warning' });
      }
      await refresh();
    } catch (err) {
      toast({ title: 'Update failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setConfirm(null);
    }
  };

  if (loading) return <Skeleton variant="rect" height={280} />;
  if (error) {
    return (
      <Card>
        <EmptyState icon={<IconAlertTriangle size={26} />} title="Couldn't load members" message={error} />
      </Card>
    );
  }
  if (!owner) {
    return (
      <Card>
        <EmptyState
          icon={<IconUser size={26} />}
          title="Owner access required"
          message="Only Owners can manage admins. Ask an Owner to change your role."
        />
      </Card>
    );
  }

  const columns: Column<UserView>[] = [
    {
      key: 'display_name',
      header: 'Member',
      sortable: true,
      accessor: (u) => u.display_name,
      render: (u) => {
        const displayName = canonicalMemberDisplayName(u, me);
        const src = avatarSrc(u.avatar_artifact);
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
                {u.source === 'environment' ? (
                  <Badge tone="neutral" className="ml-2 align-middle" title="Configured in site environment variables">
                    From environment
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
      accessor: (u) => u.role,
      render: (u) => <Badge tone={u.role === 'owner' ? 'accent' : 'neutral'}>{roleLabel(u.role)}</Badge>,
    },
    { key: 'status', header: 'Status', render: (u) => <StatusPill status={u.status} /> },
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
        const self = u.email === meEmail;
        const fromEnvironment = u.source === 'environment';
        const environmentTitle = fromEnvironment
          ? 'Configured in site environment variables; change it in the site configuration.'
          : undefined;
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
            items={[
              {
                id: 'role',
                label: u.role === 'owner' ? 'Make admin' : 'Make owner',
                disabled: self || fromEnvironment,
                title: environmentTitle,
                onSelect: () => setConfirm({ kind: 'role', user: u, role: u.role === 'owner' ? 'admin' : 'owner' }),
              },
              { id: 'audit', label: 'View audit trail', onSelect: () => setAuditUser(u) },
              {
                id: 'disable',
                label: 'Disable',
                tone: 'danger',
                disabled: self || fromEnvironment || u.status === 'disabled',
                title: environmentTitle,
                onSelect: () => setConfirm({ kind: 'disable', user: u }),
              },
            ]}
          />
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          {users.length} {users.length === 1 ? 'member' : 'members'}
        </p>
        <Button leftIcon={<IconPlus size={16} />} onClick={() => setInviteOpen(true)}>
          Invite admin
        </Button>
      </div>

      {users.length === 0 ? (
        <EmptyState
          icon={<IconUser size={26} />}
          title="No members yet"
          message="Invite your first admin to start managing this publication."
        />
      ) : (
        <DataTable
          columns={columns}
          rows={users}
          getRowKey={(u) => u.email}
          initialSort={{ key: 'display_name', dir: 'asc' }}
        />
      )}

      <Dialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite an admin"
        description="They'll get a Netlify Identity invitation. Owners can do everything; admins do content work."
        footer={
          <>
            <Button variant="secondary" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button onClick={doInvite} loading={inviting} disabled={inviting || !inviteEmail.trim()}>
              Send invite
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Email"
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="name@example.com"
          />
          <Select
            label="Role"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as UserRole)}
            options={[
              { value: 'admin', label: 'Admin' },
              { value: 'owner', label: 'Owner' },
            ]}
          />
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirm?.kind === 'role'}
        onClose={() => setConfirm(null)}
        onConfirm={applyConfirm}
        title="Change role?"
        message={
          confirm?.kind === 'role'
            ? `Change ${confirm.user.display_name} to ${confirm.role}. Owners can assign roles, change guardrails, and run maintenance.`
            : ''
        }
        confirmLabel="Change role"
      />

      <ConfirmDialog
        open={confirm?.kind === 'disable'}
        onClose={() => setConfirm(null)}
        onConfirm={applyConfirm}
        title="Disable member?"
        message={
          confirm?.kind === 'disable'
            ? `${confirm.user.display_name} will lose all access immediately. You can re-invite them later.`
            : ''
        }
        confirmLabel="Disable member"
        tone="danger"
      />

      <Drawer
        open={auditUser !== null}
        onClose={() => setAuditUser(null)}
        title={auditUser ? `${auditUser.display_name} — audit` : 'Audit'}
      >
        {auditUser?.audit && auditUser.audit.length > 0 ? (
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

export interface AdminUsersProps {
  identity: SiteIdentity;
}

export default function AdminUsers({ identity }: AdminUsersProps) {
  return (
    <AdminShell currentPath="/admin/settings/admins" title="Admins" identity={identity}>
      <AdminUsersBody />
    </AdminShell>
  );
}
