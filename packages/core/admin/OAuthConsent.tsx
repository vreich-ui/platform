/**
 * OAuthConsent (W14 F10) — the one screen a human sees in the OAuth flow.
 *
 * `/oauth/authorize` validates a client's request, parks it server-side, and
 * sends the browser here with nothing but an opaque `request_id`. This page
 * asks the workspace who is signed in (the Identity login the whole /admin
 * surface already uses, external providers included), shows WHAT is asking and
 * WHERE the code will be sent, and posts the decision back. The server mints
 * the authorization code; this component never sees one.
 *
 * Deliberately plain: no branding surface, no marketing copy, nothing that
 * trains a user to click through. The two facts that matter for a phishing
 * check — the client's name and the host the redirect goes to — are the two
 * things shown largest.
 */
import { useEffect, useState } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Button, Card, EmptyState } from './primitives';

const CONSENT_ENDPOINT = '/oauth/consent';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

type ConsentInfo = {
  client_name: string;
  redirect_host: string;
  scope: string;
  site_name: string;
  approver_email: string;
};

const postConsent = async (body: Record<string, string>): Promise<Response> =>
  fetch(CONSENT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getToken()}` },
    body: JSON.stringify(body),
  });

function OAuthConsentBody() {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('request_id');
    setRequestId(id);
    if (!id) {
      setError('This page opens from a connection request. There is no request to approve.');
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await postConsent({ request_id: id, action: 'info' });
        const payload = (await res.json()) as ConsentInfo & { error_description?: string };
        if (!alive) return;
        if (!res.ok) {
          setError(payload.error_description ?? 'This connection request is no longer valid.');
          return;
        }
        setInfo(payload);
      } catch {
        if (alive) setError('The connection request could not be loaded.');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const decide = async (action: 'approve' | 'deny') => {
    if (!requestId) return;
    setBusy(true);
    try {
      const res = await postConsent({ request_id: requestId, action });
      const payload = (await res.json()) as { redirect_to?: string; error_description?: string };
      if (!res.ok || !payload.redirect_to) {
        setError(payload.error_description ?? 'The decision could not be recorded.');
        setBusy(false);
        return;
      }
      // Hand the browser back to the client. On approval this carries the
      // authorization code; on denial, an `access_denied` error — either way
      // the client learns the outcome instead of hanging.
      window.location.href = payload.redirect_to;
    } catch {
      setError('The decision could not be sent.');
      setBusy(false);
    }
  };

  if (error) {
    return <EmptyState severity="error" title="Connection request unavailable" message={error} />;
  }

  if (!info) {
    return <p className="text-[var(--adm-text-muted)]">Loading the connection request…</p>;
  }

  return (
    <Card kicker="Connection request" title={`Connect ${info.client_name}?`}>
      <p className="text-[var(--adm-text-muted)]">
        <strong>{info.client_name}</strong> is asking to use {info.site_name}&rsquo;s MCP endpoint on your behalf. If
        you approve, it can read and change this site&rsquo;s content through the same tools you have.
      </p>

      <dl className="mt-4 grid gap-2 text-[length:var(--adm-text-sm)]">
        <div className="flex gap-2">
          <dt className="w-40 text-[var(--adm-text-muted)]">Sends the code to</dt>
          <dd className="font-mono">{info.redirect_host}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-40 text-[var(--adm-text-muted)]">Access</dt>
          <dd className="font-mono">{info.scope}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-40 text-[var(--adm-text-muted)]">Approving as</dt>
          <dd>{info.approver_email}</dd>
        </div>
      </dl>

      <p className="mt-4 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
        If you did not just start this connection, deny it. Approval can be withdrawn later by revoking the
        client&rsquo;s tokens.
      </p>

      <div className="mt-5 flex gap-2">
        <Button onClick={() => void decide('approve')} disabled={busy}>
          Approve
        </Button>
        <Button variant="secondary" onClick={() => void decide('deny')} disabled={busy}>
          Deny
        </Button>
      </div>
    </Card>
  );
}

export interface OAuthConsentProps {
  identity: SiteIdentity;
}

export default function OAuthConsent({ identity }: OAuthConsentProps) {
  return (
    <AdminShell currentPath="/admin/authorize" title="Connection request" identity={identity}>
      <OAuthConsentBody />
    </AdminShell>
  );
}
