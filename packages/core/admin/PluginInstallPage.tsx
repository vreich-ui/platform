/**
 * /plugin/install (W7.1) — the page an invited member opens from their
 * invitation e-mail.
 *
 * It is deliberately NOT inside the admin shell. The person reading it has an
 * invitation and, quite often, no session yet: an auth gate here would send
 * them to a sign-in screen before they have any idea what they are signing in
 * to, which is exactly how an install stalls. So the page renders in full,
 * unauthenticated, and only the DOWNLOADS ask for a session.
 *
 * All content comes from `@core/lib/plugin-install` via the endpoint. Nothing
 * on this page is typed by hand — every URL, version and digest is what the
 * tenant actually serves.
 */
import { useCallback, useEffect, useState } from 'react';

import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Button, Card, EmptyState } from './primitives';
import { NO_MANIFEST_MESSAGE, type InstallCard, type InstallStep } from '@core/lib/plugin-install';
import { downloadInstallBundle, fetchInstallPage, type InstallPageState } from '@core/lib/admin/plugin-install-client';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

const saveBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="pi-copy">
      <code>{value}</code>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            },
            () => setCopied(false)
          );
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </span>
  );
}

function StepBody({ step, onDownload }: { step: InstallStep; onDownload: (href: string, label: string) => void }) {
  return (
    <>
      <p className="pi-step-do">{step.do}</p>
      {step.copy ? <CopyValue value={step.copy} /> : null}
      {step.link ? (
        <p>
          <a href={step.link.href} target="_blank" rel="noreferrer noopener">
            {step.link.label}
          </a>
        </p>
      ) : null}
      {step.download ? (
        <p>
          <Button size="sm" onClick={() => onDownload(step.download!.href, step.download!.label)}>
            {step.download.label}
          </Button>
        </p>
      ) : null}
    </>
  );
}

function InstallCardView({
  card,
  onDownload,
}: {
  card: InstallCard;
  onDownload: (href: string, label: string) => void;
}) {
  return (
    <Card
      kicker={card.advanced ? 'Advanced' : undefined}
      title={card.title}
      className={card.advanced ? 'pi-card pi-card--advanced' : 'pi-card'}
    >
      <p className="pi-suits">{card.suits}</p>
      <ol className="pi-steps">
        {card.steps.map((step, index) => (
          <li key={index}>
            <StepBody step={step} onDownload={onDownload} />
          </li>
        ))}
        <li className="pi-prove">
          <Badge tone="success">Prove it</Badge>
          <StepBody step={card.prove} onDownload={onDownload} />
        </li>
      </ol>
      {card.errors.length ? (
        <details className="pi-errors">
          <summary>If it does not work, match the message</summary>
          <dl>
            {card.errors.map((error) => (
              <div key={error.text}>
                <dt>
                  <code>{error.text}</code>
                </dt>
                <dd>{error.means}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {card.notes.map((note) => (
        <p className="pi-note" key={note}>
          {note}
        </p>
      ))}
    </Card>
  );
}

export default function PluginInstallPage({ identity }: { identity: SiteIdentity }) {
  const [state, setState] = useState<InstallPageState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchInstallPage().then(
      (next) => live && setState(next),
      (cause: Error) => live && setError(cause.message)
    );
    return () => {
      live = false;
    };
  }, []);

  const onDownload = useCallback((href: string, label: string) => {
    setDownloadError(null);
    downloadInstallBundle(getToken, href, label).then(
      ({ blob, filename }) => saveBlob(blob, filename),
      (cause: Error) => setDownloadError(cause.message)
    );
  }, []);

  if (error) {
    return <EmptyState severity="error" title="This install page could not load" message={error} />;
  }
  if (!state) {
    return <EmptyState title="Loading" message={`Reading ${identity.brandName}'s published plugin bundle.`} />;
  }
  if (!state.ready || !state.facts) {
    return <EmptyState title="Nothing published yet" message={NO_MANIFEST_MESSAGE} />;
  }

  const { facts } = state;
  const primary = state.cards.filter((card) => !card.advanced);
  const advanced = state.cards.filter((card) => card.advanced);

  return (
    <div className="pi-page">
      <header className="pi-header">
        <h1>Publish to {state.brand_name} from your own chat app</h1>
        <p>
          Pick the app you already use. Each install ends with one call that proves it worked — do not skip it, because
          a connector that authenticates and then cannot write looks identical to one that works until you try to
          publish.
        </p>
        <p className="pi-meta">
          Manifest <code>{facts.manifest_version}</code> · tools <code>{facts.tools_digest}</code> ·{' '}
          <a href={facts.mcp_auth_health_url} target="_blank" rel="noreferrer noopener">
            connection health
          </a>
        </p>
      </header>

      {downloadError ? (
        <div className="pi-download-error" role="alert">
          {downloadError}
        </div>
      ) : null}

      <div className="pi-cards">
        {primary.map((card) => (
          <InstallCardView key={card.id} card={card} onDownload={onDownload} />
        ))}
      </div>

      {advanced.length ? (
        <details className="pi-advanced">
          <summary>Advanced shapes</summary>
          <div className="pi-cards">
            {advanced.map((card) => (
              <InstallCardView key={card.id} card={card} onDownload={onDownload} />
            ))}
          </div>
        </details>
      ) : null}

      <footer className="pi-footer">
        <p>
          Downloads ask you to sign in as the address your invitation was sent to. Everything else on this page is
          public — the URLs are what this tenant serves to any client.
        </p>
      </footer>
    </div>
  );
}
