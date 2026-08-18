/**
 * Welcome (W18 T18.5) — the one-time onboarding screen at /admin/welcome.
 * Three steps on one page: (1) confirm/edit the display name, (2) "What you
 * can do here as <Role>" — one paragraph per tier (plan §6) plus the two most
 * useful links, (3) "Open the workspace" → `update_me { display_name,
 * onboarding_step:'tour' }` stamps `Person.onboarding.steps.{name,tour}` +
 * `completed_at`, then /admin. Members who somehow land here already
 * completed just see the button. No sidebar: this runs BEFORE the workspace.
 */
import { useEffect, useState } from 'react';

import type { SiteIdentity } from '@core/lib/site-identity';
import { Avatar, Badge, Button, Card, EmptyState, Skeleton } from './primitives';
import { Input } from './forms';
import { IconAlertTriangle, IconCheck } from './icons';
import { MEMBERSHIP_TIERS, tierLabel } from './logic';
import { updateMe, avatarSrc } from '@core/lib/admin/users-client';
import { useCurrentUser } from '@core/lib/admin/use-current-user';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

/** Plan §6, in the second person, one paragraph per tier. */
const ROLE_PARAGRAPH: Record<string, string> = {
  owner:
    'You can do everything: create and edit every object, chat with the agents, publish and release, decide reviews — and, as an Owner, invite and manage members, assign roles, change guardrails, create templates and themes, run maintenance tools, and take over locks.',
  admin:
    'You run the full content workflow: create and edit every object type, chat with the agents (read and write tools), submit and decide reviews, and publish and release. You can see who the members are; Owners manage them.',
  publisher:
    'You can create and edit drafts, chat with the agents, decide reviews, and publish and release changes to the live site. Member management, guardrails and recipes stay with Owners.',
  editor:
    'You can create and edit drafts, chat with the agents, and decide reviews. Publishing and releasing to the live site is done by a Publisher, Admin or Owner.',
  viewer:
    'You have read-only access: browse the objects, follow what is happening, and chat with the agents using read tools. Ask an Owner if you need to edit.',
};

const primaryRole = (roles: readonly string[], fallback: string): string =>
  (['owner', 'admin', 'publisher', 'editor', 'viewer'] as const).find((r) => roles.includes(r)) ?? fallback;

export interface WelcomeProps {
  identity: SiteIdentity;
}

export default function Welcome({ identity }: WelcomeProps) {
  const { user, roles, loading, error, onboarding, refresh } = useCurrentUser();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (user && !name) setName(user.display_name);
  }, [user]);

  const role = primaryRole(roles, user?.role ?? 'viewer');
  const alreadyDone = Boolean(onboarding?.completed_at);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 200;

  const finish = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await updateMe(getToken, {
        ...(user && trimmed !== user.display_name ? { display_name: trimmed } : {}),
        onboarding_step: 'tour',
      });
      setDone(true);
      await refresh().catch(() => undefined);
      window.location.assign('/admin');
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Could not save. Please try again.');
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <Skeleton variant="rect" height={280} />
      </div>
    );
  }
  if (error || !user) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <Card>
          <EmptyState icon={<IconAlertTriangle size={26} />} title="Couldn't load your profile" message={error} />
        </Card>
      </div>
    );
  }
  if (roles.length === 0) {
    // The AdminLayout gate shows its forbidden panel before this renders; belt and braces.
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <Card>
          <EmptyState
            icon={<IconAlertTriangle size={26} />}
            title="No role granted yet"
            message="You are signed in, but no role has been granted on this site. Ask an Owner to grant you a role."
          />
        </Card>
      </div>
    );
  }

  const src = avatarSrc(user.avatar_artifact);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-10">
      <div>
        <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
          {identity.brandName}
        </p>
        <h1 className="mt-1 text-[length:var(--adm-text-2xl,1.5rem)] font-semibold text-[var(--adm-text-heading)]">
          Welcome{alreadyDone ? ' back' : ''}, {trimmed || user.display_name}
        </h1>
        <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          {alreadyDone
            ? 'Your account is set up. Open the workspace whenever you are ready.'
            : 'Two quick things before you start, then the workspace is yours.'}
        </p>
      </div>

      <Card kicker="1 · Your name" title="How should we show you?">
        <div className="flex items-center gap-4">
          {src ? (
            <img src={src} alt="" className="h-14 w-14 rounded-full object-cover" />
          ) : (
            <Avatar name={trimmed || user.display_name} size={56} />
          )}
          <div className="min-w-0 flex-1">
            <Input
              label="Display name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              autoFocus={!alreadyDone}
              hint="Shown wherever you appear — chat, history, the members table. You can change it later on your profile."
              error={!valid && name.length > 0 ? 'Please enter a name (up to 200 characters).' : undefined}
            />
            <p className="mt-1 truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{user.email}</p>
          </div>
        </div>
      </Card>

      <Card kicker="2 · Your role" title={`What you can do here as ${tierLabel(role)}`}>
        <div className="flex items-center gap-2">
          <Badge tone={role === 'owner' ? 'accent' : role === 'admin' ? 'info' : 'neutral'}>{tierLabel(role)}</Badge>
          <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {MEMBERSHIP_TIERS.find((t) => t.value === role)?.description}
          </span>
        </div>
        <p className="mt-3 text-[length:var(--adm-text-sm)] leading-relaxed">
          {ROLE_PARAGRAPH[role] ?? ROLE_PARAGRAPH.viewer}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a
            className="adm-focusable rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] px-3 py-1.5 text-[length:var(--adm-text-sm)] font-medium hover:bg-[var(--adm-surface-sunken)]"
            href="/admin/content"
          >
            Content library
          </a>
          <a
            className="adm-focusable rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] px-3 py-1.5 text-[length:var(--adm-text-sm)] font-medium hover:bg-[var(--adm-surface-sunken)]"
            href="/"
            target="_blank"
            rel="noreferrer"
          >
            Edit on site
          </a>
        </div>
      </Card>

      <Card kicker="3 · Go" title="Open the workspace">
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          {alreadyDone
            ? 'Nothing else to do here.'
            : 'This saves your name and takes you to the workspace. You will not see this page again.'}
        </p>
        {failure ? (
          <p role="alert" className="mt-2 text-[length:var(--adm-text-sm)] text-[var(--adm-danger,#c0392b)]">
            {failure}
          </p>
        ) : null}
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={finish} loading={busy} disabled={!valid || busy || done}>
            {done ? 'Opening…' : 'Open the workspace'}
          </Button>
          {done ? (
            <span className="flex items-center gap-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              <IconCheck size={14} /> Saved
            </span>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
