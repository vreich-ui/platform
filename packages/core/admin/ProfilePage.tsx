/**
 * ProfilePage (T9.6) — self-service admin profile. Edit display name (flows
 * into every kit surface that renders people: topbar chip, history timelines,
 * members table), see your role read-only with a tier explanation, and manage
 * preference placeholders. Role self-change is Owner-only (T9.5); avatar
 * upload wiring lands with a user-scoped artifact intent (follow-up).
 */
import { useEffect, useState } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Avatar, Badge, Button, Card, EmptyState, Skeleton, StatusPill } from './primitives';
import { Input, Select, Switch } from './forms';
import { useToast } from './overlays';
import { updateMe, avatarSrc } from '@core/lib/admin/users-client';
import { useCurrentUser } from '@core/lib/admin/use-current-user';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

const TIER_BLURB: Record<string, string> = {
  owner:
    'Owners can do everything an admin can, plus assign roles, change guardrails, create templates & themes, run maintenance tools, and take over locks.',
  admin:
    'Admins do the full content workflow: create and edit every object type, chat with agents, publish, release, and decide reviews.',
};

function ProfileBody() {
  const { toast } = useToast();
  const { user, loading, error, refresh } = useCurrentUser();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [notifyReview, setNotifyReview] = useState(true);

  useEffect(() => {
    if (user) setName(user.display_name);
  }, [user]);

  const onSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast({ title: 'Display name cannot be empty', tone: 'warning' });
      return;
    }
    setSaving(true);
    try {
      const { user: updated } = await updateMe(getToken, { display_name: trimmed });
      setName(updated.display_name);
      await refresh();
      toast({ title: 'Profile saved', tone: 'success' });
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Skeleton variant="rect" height={280} />;
  if (error || !user) {
    return (
      <Card>
        <EmptyState severity="error" title="Couldn't load your profile" message={error} />
      </Card>
    );
  }

  const dirty = name.trim() !== user.display_name;
  const src = avatarSrc(user.avatar_artifact);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Card kicker="Identity" title="Your profile">
        <div className="flex items-center gap-4">
          {src ? (
            <img src={src} alt="" className="h-16 w-16 rounded-full object-cover" />
          ) : (
            <Avatar name={user.display_name} size={64} />
          )}
          <div className="min-w-0">
            <p className="truncate text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">
              {user.display_name}
            </p>
            <p className="truncate text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{user.email}</p>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-4">
          <Input
            label="Display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            hint="Shown wherever you appear — chat, history, the members table."
          />
          <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            Avatar upload arrives with the artifact upload flow. For now your initials are shown.
          </p>
          <div>
            <Button onClick={onSave} loading={saving} disabled={!dirty || saving}>
              Save profile
            </Button>
          </div>
        </div>
      </Card>

      <Card kicker="Access" title="Your role">
        <div className="flex items-center gap-2">
          <Badge tone={user.role === 'owner' ? 'accent' : 'neutral'}>{user.role === 'owner' ? 'Owner' : 'Admin'}</Badge>
          <StatusPill status={user.status} />
        </div>
        <p className="mt-3 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{TIER_BLURB[user.role]}</p>
        <p className="mt-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          Roles are assigned by an Owner on the Admins page — you can&apos;t change your own role here.
        </p>
      </Card>

      <Card kicker="Preferences" title="Preferences">
        <div className="flex flex-col gap-4">
          <Select
            label="Timezone"
            options={[
              { value: 'auto', label: 'Automatic (browser)' },
              { value: 'utc', label: 'UTC' },
            ]}
            defaultValue="auto"
            hint="Placeholder — display-only for now."
          />
          <Switch
            checked={notifyReview}
            onCheckedChange={setNotifyReview}
            label="Notify me about pending reviews"
            hint="Placeholder — notification delivery isn't wired up yet."
          />
        </div>
      </Card>
    </div>
  );
}

export interface ProfilePageProps {
  identity: SiteIdentity;
}

export default function ProfilePage({ identity }: ProfilePageProps) {
  return (
    <AdminShell currentPath="/admin/profile" title="Profile" identity={identity}>
      <ProfileBody />
    </AdminShell>
  );
}
