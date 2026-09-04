/**
 * PluginsPage (W5.1) — the publishing-plugin bundle, one card per chat platform.
 *
 * Follows the object-plane conventions: one status in one place, sections
 * collapsed by default, and a 1–3 click path to the two actions that matter
 * (render, promote) rather than routing them through chat.
 *
 * Every URL an operator copies comes from the ACTIVE bundle's own connection
 * block, never typed into this file. That is deliberate: the legacy ChatGPT
 * setup drifted into an invented OAuth scope and a wrong path prefix precisely
 * because a human maintained those strings by hand.
 *
 * All the logic this page needs lives in `@core/lib/admin/plugins-client` —
 * `.tsx` is excluded from the test compile, so anything worth asserting has to
 * live where a test can import it.
 */
import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Button, Card, EmptyState, Skeleton } from './primitives';
import { useToast } from './overlays';
import {
  fetchPluginManifest,
  fetchPluginExport,
  renderPluginDraft,
  promotePluginDraft,
  inviteAndSendInstallLink,
  fetchInstallersBoard,
  installerRows,
  platformCards,
  installerIdentityStep,
  ceilingRows,
  manifestStatus,
  hasUnpromotedDraft,
  type PluginManifestState,
  type PluginPlatformId,
  type InviteRole,
  type InstallersBoard,
} from '@core/lib/admin/plugins-client';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

const TONE_MAP = { ok: 'success', warn: 'warning', neutral: 'neutral' } as const;

function CopyRow({ label, url }: { label: string; url: string }) {
  const { toast } = useToast();
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 truncate rounded bg-[var(--adm-surface-2)] px-2 py-1 text-[length:var(--adm-text-xs)]">
        {url}
      </code>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(
            () => toast({ title: `${label} copied`, tone: 'success' }),
            () => toast({ title: 'Could not copy', description: url, tone: 'danger' })
          );
        }}
      >
        Copy
      </Button>
    </div>
  );
}

function PluginsBody({ identity }: { identity: SiteIdentity }) {
  const { toast } = useToast();
  const [state, setState] = useState<PluginManifestState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'render' | 'promote' | 'invite' | 'repromote' | null>(null);
  const [board, setBoard] = useState<InstallersBoard | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InviteRole>('editor');

  /**
   * W7.1. A failed MAIL is not a failed invitation, and the toast says which
   * happened: the member is invited either way, and on a tenant without mail
   * the operator sends the link themselves. Conflating the two would have an
   * operator re-inviting someone who is already invited.
   */
  const onInvite = useCallback(async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    setBusy('invite');
    try {
      const result = await inviteAndSendInstallLink(getToken, email, inviteRole);
      setInviteEmail('');
      toast(
        result.mail.sent
          ? { title: `Invited ${email} as ${inviteRole}`, description: 'Install link sent.', tone: 'success' }
          : {
              title: `Invited ${email} as ${inviteRole}`,
              description: `No mail configured — send them ${result.install_url} yourself.`,
              tone: 'warning',
            }
      );
    } catch (cause) {
      toast({
        title: 'Could not invite',
        description: cause instanceof Error ? cause.message : String(cause),
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  }, [inviteEmail, inviteRole, toast]);

  /**
   * W7.6: the board is fetched on FIRST OPEN, not on page load. It costs a
   * bounded object scan, and the page's main job — render, promote, download —
   * must not pay for a section nobody opened.
   */
  const openBoard = useCallback(async () => {
    setBoardOpen((open) => !open);
    if (board) return;
    try {
      setBoard(await fetchInstallersBoard(getToken));
      setBoardError(null);
    } catch (cause) {
      setBoardError(cause instanceof Error ? cause.message : 'Could not load the installers board.');
    }
  }, [board]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState(await fetchPluginManifest(getToken));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the plugin manifest.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRender = async (platform: PluginPlatformId) => {
    setBusy('render');
    try {
      const { warnings } = await renderPluginDraft(getToken, platform);
      await load();
      toast({
        title: 'Draft rendered',
        description: warnings.length
          ? `${warnings.length} warning(s) — see below.`
          : 'Promote it to publish the exports.',
        tone: warnings.length ? 'warning' : 'success',
      });
    } catch (cause) {
      toast({ title: 'Render failed', description: cause instanceof Error ? cause.message : '', tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  /** Render + promote, in one click, from the place the staleness is reported. */
  const onRepromote = async () => {
    setBusy('repromote');
    try {
      await renderPluginDraft(getToken, 'claude');
      await promotePluginDraft(getToken);
      await load();
      setBoard(null);
      toast({
        title: 'Re-promoted',
        description: 'Installed copies are now one version behind — tell installers to re-add the connector.',
        tone: 'success',
      });
    } catch (cause) {
      toast({ title: 'Re-promote failed', description: cause instanceof Error ? cause.message : '', tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const onPromote = async () => {
    setBusy('promote');
    try {
      await promotePluginDraft(getToken);
      await load();
      toast({
        title: 'Promoted',
        description: 'The exports and the Actions schema now serve this bundle.',
        tone: 'success',
      });
    } catch (cause) {
      toast({ title: 'Promote failed', description: cause instanceof Error ? cause.message : '', tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Exports are fetched, not navigated to.
   *
   * `window.open(url)` sends no Authorization header, so the admin function
   * answered 401 and the browser rendered that JSON — every export button on
   * this page was dead from the day it shipped, in a way that looked like a
   * broken download rather than a missing credential. The bytes come through
   * the same authenticated fetch as everything else here and reach the disk as
   * a blob, under the filename the server chose (it carries the tenant and the
   * manifest version).
   */
  const onDownload = async (url: string, label: string) => {
    try {
      const { blob, filename } = await fetchPluginExport(getToken, url, 'plugin-bundle.zip');
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      toast({ title: 'Downloaded', description: filename, tone: 'success' });
    } catch (cause) {
      toast({ title: `${label} failed`, description: cause instanceof Error ? cause.message : '', tone: 'danger' });
    }
  };

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (error) {
    return <EmptyState severity="error" title="Plugin manifest unavailable" message={error} />;
  }

  const status = manifestStatus(state);
  const active = state?.active ?? null;
  const cards = platformCards(active);

  return (
    <div className="flex flex-col gap-4">
      <Card
        kicker="Publishing plugin"
        title={identity.brandName}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={TONE_MAP[status.tone]}>{status.label}</Badge>
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void onRender('claude')}>
              {busy === 'render' ? 'Rendering…' : 'Render draft'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null || !hasUnpromotedDraft(state)}
              onClick={() => void onPromote()}
            >
              {busy === 'promote' ? 'Promoting…' : 'Promote'}
            </Button>
          </div>
        }
      >
        <p className="text-[length:var(--adm-text-sm)] text-[color:var(--adm-fg-muted)]">{status.detail}</p>

        {/*
          W7.6: the two numbers an operator compares against an installed copy.
          They were only readable by unzipping a bundle or reading a function
          log; every install-drift conversation started with someone asking for
          them, so they live on the card.
        */}
        {active ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-[length:var(--adm-text-xs)] text-[color:var(--adm-fg-muted)]">
            <span>
              Manifest <code>{active.manifest_version}</code>
            </span>
            <span>
              Tools <code>{active.sources.tool_surface_digest}</code>
            </span>
            <a href={active.connection.mcp_auth_health_url} target="_blank" rel="noreferrer noopener">
              Connection health
            </a>
            <a href={`${active.connection.origin}/plugin/install`} target="_blank" rel="noreferrer noopener">
              Install page
            </a>
          </div>
        ) : null}

        {state?.stale.length ? (
          <>
            <ul className="mt-3 list-disc pl-5 text-[length:var(--adm-text-sm)]">
              {state.stale.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            {/*
              W7.6: stale is a two-step fix (render, then promote) and the page
              already knew both steps. Making the operator perform them in
              sequence, from two buttons, is how a tenant ends up serving a
              bundle nobody meant to leave stale.
            */}
            <Button className="mt-3" size="sm" disabled={busy !== null} onClick={() => void onRepromote()}>
              {busy === 'repromote' ? 'Re-promoting…' : 'Re-render & promote'}
            </Button>
          </>
        ) : null}

        {active?.warnings.length ? (
          <ul className="mt-3 list-disc pl-5 text-[length:var(--adm-text-sm)] text-[color:var(--adm-warning-fg)]">
            {active.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}

        {active ? (
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-[length:var(--adm-text-sm)] sm:grid-cols-4">
            {ceilingRows(active).map((row) => (
              <div key={row.dial}>
                <dt className="text-[color:var(--adm-fg-muted)]">{row.dial.replace(/_/g, ' ')}</dt>
                <dd className="font-medium">{row.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </Card>

      <Card title={installerIdentityStep.title} kicker="Step 1 — every platform">
        <p className="mb-3 text-[length:var(--adm-text-sm)] text-[color:var(--adm-fg-muted)]">
          {installerIdentityStep.detail}
        </p>
        {/*
          W7.1: one click does both halves. Sending someone to the members page
          and expecting them to come back for the install link is where an
          install stops happening — and GoTrue's invitation mail cannot name the
          role, which is the one fact an invitee most needs.
        */}
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[length:var(--adm-text-xs)]">
            <span className="text-[color:var(--adm-fg-muted)]">E-mail</span>
            <input
              className="rounded border border-[color:var(--adm-border)] bg-[var(--adm-surface-1)] px-2 py-1"
              type="email"
              value={inviteEmail}
              placeholder="editor@example.com"
              onChange={(e) => setInviteEmail(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-[length:var(--adm-text-xs)]">
            <span className="text-[color:var(--adm-fg-muted)]">Role</span>
            <select
              className="rounded border border-[color:var(--adm-border)] bg-[var(--adm-surface-1)] px-2 py-1"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as InviteRole)}
            >
              {(['editor', 'publisher', 'admin', 'viewer'] as const).map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" disabled={busy === 'invite' || !inviteEmail.trim()} onClick={() => void onInvite()}>
            {busy === 'invite' ? 'Sending…' : 'Invite & send link'}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => window.open(installerIdentityStep.action.href, '_self')}>
            {installerIdentityStep.action.label}
          </Button>
        </div>
        <p className="text-[length:var(--adm-text-xs)] text-[color:var(--adm-fg-muted)]">
          The invitee gets the Identity accept mail plus a second message naming their role and linking{' '}
          <code>/plugin/install</code>. On a tenant with no mail configured the invitation still happens and the link is
          yours to send.
        </p>
      </Card>

      {/*
        W7.6 — the installers board. It answers the question an owner asks an
        hour after inviting someone and could not answer before: did it work?
        `whoami` is the signal, and it costs the installer nothing extra — the
        skill calls it at session start and the install page's last step is
        running it, so a working install produces one by construction.
      */}
      <Card
        title="Installers"
        kicker="Who has proven an install"
        actions={
          <Button size="sm" variant="secondary" onClick={() => void openBoard()}>
            {boardOpen ? 'Hide' : 'Show'}
          </Button>
        }
      >
        {!boardOpen ? (
          <p className="text-[length:var(--adm-text-sm)] text-[color:var(--adm-fg-muted)]">
            Last <code>whoami</code> per member and surface, whether they can write, and whether their install is
            running the promoted bundle.
          </p>
        ) : boardError ? (
          <EmptyState severity="error" title="Couldn't load the board" message={boardError} />
        ) : !board ? (
          <Skeleton className="h-24 w-full" />
        ) : installerRows(board).length === 0 ? (
          <EmptyState
            title="No install has been proven yet"
            message="A member appears here the first time their chat app runs whoami — the last step of every card on the install page. If someone says the plugin works and they are not listed, they skipped it, and nothing has verified their connector."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[length:var(--adm-text-sm)]">
              <thead className="text-[length:var(--adm-text-xs)] text-[color:var(--adm-fg-muted)]">
                <tr>
                  <th className="py-1 pr-4">Member</th>
                  <th className="py-1 pr-4">Surface</th>
                  <th className="py-1 pr-4">Last seen</th>
                  <th className="py-1 pr-4">Can write</th>
                  <th className="py-1 pr-4">Install</th>
                  <th className="py-1 pr-4">Last publish from this surface</th>
                </tr>
              </thead>
              <tbody>
                {installerRows(board).map((row) => (
                  <tr key={`${row.email}:${row.surface}`} className="border-t border-[color:var(--adm-border)]">
                    <td className="py-1 pr-4">{row.email}</td>
                    <td className="py-1 pr-4">
                      <code>{row.surface}</code>
                    </td>
                    <td className="py-1 pr-4">
                      {new Date(row.lastSeen).toLocaleString()}
                      <span className="ml-1 text-[color:var(--adm-fg-muted)]">({row.sessions})</span>
                    </td>
                    <td className="py-1 pr-4">
                      <Badge tone={row.canWrite ? 'success' : 'danger'}>{row.canWrite ? 'yes' : 'no'}</Badge>
                    </td>
                    <td className="py-1 pr-4">
                      <Badge tone={row.stale ? 'warning' : 'success'}>{row.stale ? 'stale' : 'current'}</Badge>
                      {row.manifestVersion ? (
                        <code className="ml-2 text-[length:var(--adm-text-xs)]">{row.manifestVersion}</code>
                      ) : null}
                    </td>
                    <td className="py-1 pr-4">
                      {row.lastPublishedAt ? new Date(row.lastPublishedAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[length:var(--adm-text-xs)] text-[color:var(--adm-fg-muted)]">
              <strong>Can write: no</strong> means their role cannot create or change content — they will be refused at
              the publish gate, so fix it before they draft anything. <strong>Stale</strong> means their install was
              built against an older bundle; they re-add the connector, which is one step for a Claude connector and a
              re-import for a Custom GPT. The last publish is matched by SURFACE, not by person: the receipt records
              which chat app published, not which human sat behind it.
            </p>
          </div>
        )}
      </Card>

      {cards.map((card) => (
        <Card key={card.id} title={card.title} kicker={card.limitation ? 'Drafting only' : undefined}>
          {card.actors.length ? (
            <p className="mb-2 text-[length:var(--adm-text-xs)] text-[color:var(--adm-fg-muted)]">
              Ledger actor{card.actors.length > 1 ? 's' : ''}: {card.actors.map((a) => `\`${a}\``).join(' · ')}
            </p>
          ) : null}
          {card.limitation ? (
            <p className="mb-3 text-[length:var(--adm-text-sm)] text-[color:var(--adm-fg-muted)]">{card.limitation}</p>
          ) : null}

          <ol className="mb-3 list-decimal pl-5 text-[length:var(--adm-text-sm)]">
            {card.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>

          {card.copyUrl && card.copyLabel ? (
            <div className="mb-3">
              <p className="mb-1 text-[length:var(--adm-text-xs)] text-[color:var(--adm-fg-muted)]">{card.copyLabel}</p>
              <CopyRow label={card.copyLabel} url={card.copyUrl} />
            </div>
          ) : null}

          {card.downloadUrl ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void onDownload(card.downloadUrl!, card.downloadLabel)}
            >
              {card.downloadLabel}
            </Button>
          ) : (
            <p className="text-[length:var(--adm-text-sm)] text-[color:var(--adm-fg-muted)]">
              Render and promote a bundle to enable this download.
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}

export default function PluginsPage({ identity }: { identity: SiteIdentity }) {
  return (
    <AdminShell currentPath="/admin/plugins" title="Plugins" identity={identity}>
      <PluginsBody identity={identity} />
    </AdminShell>
  );
}
