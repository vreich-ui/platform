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
  renderPluginDraft,
  promotePluginDraft,
  platformCards,
  ceilingRows,
  manifestStatus,
  hasUnpromotedDraft,
  type PluginManifestState,
  type PluginPlatformId,
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
  const [busy, setBusy] = useState<'render' | 'promote' | null>(null);
  const [error, setError] = useState<string | null>(null);

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

        {state?.stale.length ? (
          <ul className="mt-3 list-disc pl-5 text-[length:var(--adm-text-sm)]">
            {state.stale.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
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

      {cards.map((card) => (
        <Card key={card.id} title={card.title} kicker={card.limitation ? 'Drafting only' : undefined}>
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
            <Button size="sm" variant="secondary" onClick={() => window.open(card.downloadUrl!, '_blank')}>
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
