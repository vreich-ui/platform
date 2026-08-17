/**
 * AcceptInvite (T18.0b) — the island behind /admin/accept. A small state
 * machine keyed by which Netlify Identity token the URL hash carries:
 *
 *   invite        → full name + password → GoTrue /verify {type:'signup'} →
 *                   PUT /user {full_name} → admin-users `accept` → workspace
 *   recovery      → new password → /verify {type:'recovery'} → PUT /user {password}
 *   confirmation  → /verify {type:'signup'} (no password) → workspace
 *   email_change  → /verify {type:'email_change'} → `me` (last_seen) → workspace
 *   none / bad    → friendly error, never the raw token
 *
 * The token is read from the hash and held in component state only; it is
 * never written to storage (only the resulting session is) and never rendered.
 * After success the hash is stripped with history.replaceState.
 */
import { useEffect, useState } from 'react';

import type { SiteIdentity } from '@core/lib/site-identity';
import {
  acceptInvite as goTrueAcceptInvite,
  confirmEmailChange,
  confirmSignup,
  detectIdentityToken,
  exchangeRecoveryToken,
  logout,
  setFullName,
  updatePasswordWithToken,
  type DetectedIdentityToken,
} from '@core/lib/admin/goTrueClient';
import { acceptInvite as storeAcceptInvite, fetchMe, invitePreview } from '@core/lib/admin/users-client';
import { Button, Card } from './primitives';
import { Input } from './forms';
import { IconAlertTriangle, IconCheck } from './icons';

const MIN_PASSWORD_DEFAULT = 8;
const WORKSPACE_PATH = '/admin';
const WELCOME_PATH = '/admin/welcome';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

const stripHash = () => {
  if (typeof window === 'undefined') return;
  history.replaceState(null, '', window.location.pathname + window.location.search);
};

const errorMessage = (err: unknown, fallback: string): string => {
  const status = (err as { status?: number } | null)?.status;
  const raw = err instanceof Error ? err.message : '';
  if (status && status >= 400 && status < 500) {
    return 'This link is no longer valid — it may have expired or already been used.';
  }
  return raw || fallback;
};

/** After a token is consumed, continue to the workspace (or the welcome step, if a site has it — T18.5). */
const continueToWorkspace = async () => {
  stripHash();
  let target = WORKSPACE_PATH;
  try {
    const probe = await fetch(WELCOME_PATH, { method: 'HEAD' });
    if (probe.ok) target = WELCOME_PATH;
  } catch {
    // no welcome page — fall through to /admin
  }
  window.location.assign(target);
};

// ── shared bits ─────────────────────────────────────────────────────────────

function PasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  minLength,
  labels = { password: 'Password', confirm: 'Confirm password' },
  autoFocus,
}: {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  minLength: number;
  labels?: { password: string; confirm: string };
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== password;
  const tooShort = password.length > 0 && password.length < minLength;
  return (
    <>
      <Input
        label={labels.password}
        type={show ? 'text' : 'password'}
        autoComplete="new-password"
        value={password}
        onChange={(e) => onPassword(e.target.value)}
        error={tooShort ? `At least ${minLength} characters.` : undefined}
        hint={tooShort ? undefined : `At least ${minLength} characters.`}
        autoFocus={autoFocus}
        required
      />
      <Input
        label={labels.confirm}
        type={show ? 'text' : 'password'}
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => onConfirm(e.target.value)}
        error={mismatch ? 'Passwords do not match.' : undefined}
        required
      />
      <label className="flex items-center gap-2 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
        Show password
      </label>
    </>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-[var(--adm-danger,#c0392b)] px-3 py-2 text-[length:var(--adm-text-sm)] text-[var(--adm-danger,#c0392b)]"
    >
      <IconAlertTriangle size={16} />
      <span>{message}</span>
    </p>
  );
}

function NoTokenPanel({ siteName, message }: { siteName: string; message?: string }) {
  return (
    <Card kicker={siteName} title="This link can’t be used">
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        {message ??
          'The link is missing its sign-in token, has expired, or was already used. Ask the person who invited you to send a new invitation.'}
      </p>
      <p className="mt-4">
        <a className="underline" href="/">
          Back to the site
        </a>
      </p>
    </Card>
  );
}

// ── invite ──────────────────────────────────────────────────────────────────

function InviteForm({ token, siteName, minLength }: { token: string; siteName: string; minLength: number }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsGrant, setNeedsGrant] = useState<string | null>(null);

  const valid = name.trim().length > 0 && password.length >= minLength && confirm === password;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const displayName = name.trim().slice(0, 200);
      const user = await goTrueAcceptInvite(token, password);
      try {
        await setFullName(displayName);
      } catch {
        // informational only — the store record below is the source of truth
      }
      const result = await storeAcceptInvite(getToken, { display_name: displayName });
      stripHash();
      if (result.needs_grant) {
        setNeedsGrant(user.email);
        return;
      }
      await continueToWorkspace();
    } catch (err) {
      setError(errorMessage(err, 'Could not accept the invitation. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (needsGrant) {
    return (
      <Card kicker={siteName} title="You’re signed in">
        <p className="text-[length:var(--adm-text-sm)]">
          Your account <strong>{needsGrant}</strong> is set up, but no role has been granted on this site yet — ask an
          Owner to grant you a role. Once they have, sign in again to open the workspace.
        </p>
        <div className="mt-4 flex gap-2">
          <Button
            variant="secondary"
            onClick={async () => {
              await logout();
              window.location.assign('/');
            }}
          >
            Sign out
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card kicker={siteName} title="Set up your account">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          You’ve been invited to the {siteName} workspace. Choose how your name appears and set a password.
        </p>
        <Input
          label="Full name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          autoFocus
          required
        />
        <PasswordFields
          password={password}
          confirm={confirm}
          onPassword={setPassword}
          onConfirm={setConfirm}
          minLength={minLength}
        />
        {error ? <ErrorLine message={error} /> : null}
        <div>
          <Button type="submit" loading={busy} disabled={!valid || busy}>
            Create account
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ── recovery ────────────────────────────────────────────────────────────────

function RecoveryForm({ token, siteName, minLength }: { token: string; siteName: string; minLength: number }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = password.length >= minLength && confirm === password;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const user = await exchangeRecoveryToken(token);
      await updatePasswordWithToken(user.token.access_token, password);
      stripHash();
      setDone(true);
      window.setTimeout(() => window.location.assign(WORKSPACE_PATH), 900);
    } catch (err) {
      setError(errorMessage(err, 'Could not update the password. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card kicker={siteName} title="Choose a new password">
      {done ? (
        <p className="flex items-center gap-2 text-[length:var(--adm-text-sm)]">
          <IconCheck size={16} /> Password updated — taking you to the workspace…
        </p>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <PasswordFields
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
            minLength={minLength}
            labels={{ password: 'New password', confirm: 'Confirm new password' }}
            autoFocus
          />
          {error ? <ErrorLine message={error} /> : null}
          <div>
            <Button type="submit" loading={busy} disabled={!valid || busy}>
              Update password
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

// ── confirmation / email change (no form) ───────────────────────────────────

function AutoConfirm({ detected, siteName }: { detected: DetectedIdentityToken; siteName: string }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (detected.kind === 'email_change') {
          await confirmEmailChange(detected.token);
          // stamp last_seen on the store record; the by-email re-index is T18.1
          await fetchMe(getToken).catch(() => null);
        } else {
          await confirmSignup(detected.token);
        }
        if (!cancelled) await continueToWorkspace();
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, 'Could not confirm this link.'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detected]);

  if (error) return <NoTokenPanel siteName={siteName} message={error} />;
  return (
    <Card kicker={siteName} title={detected.kind === 'email_change' ? 'Confirming your new e-mail…' : 'Confirming…'}>
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">One moment.</p>
    </Card>
  );
}

// ── root ────────────────────────────────────────────────────────────────────

export interface AcceptInviteProps {
  identity: SiteIdentity;
}

export default function AcceptInvite({ identity }: AcceptInviteProps) {
  // Read the hash exactly once, AFTER hydration (the server render has no hash,
  // so deciding during render would mismatch); the token lives in state only.
  const [detected, setDetected] = useState<DetectedIdentityToken | null | undefined>(undefined);
  const [minLength, setMinLength] = useState(MIN_PASSWORD_DEFAULT);
  const [siteName, setSiteName] = useState(identity.brandName);

  useEffect(() => {
    setDetected(detectIdentityToken());
  }, []);

  useEffect(() => {
    if (!detected) return;
    invitePreview()
      .then((p) => {
        if (p.policy?.min_password) setMinLength(p.policy.min_password);
        if (p.site?.name) setSiteName(p.site.name);
      })
      .catch(() => {
        // the preview is a nicety; the server-resolved identity prop already carries the name
      });
  }, [detected]);

  let body;
  if (detected === undefined)
    body = (
      <Card kicker={siteName} title="One moment…">
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">Checking your link.</p>
      </Card>
    );
  else if (!detected) body = <NoTokenPanel siteName={siteName} />;
  else if (detected.kind === 'invite')
    body = <InviteForm token={detected.token} siteName={siteName} minLength={minLength} />;
  else if (detected.kind === 'recovery')
    body = <RecoveryForm token={detected.token} siteName={siteName} minLength={minLength} />;
  else body = <AutoConfirm detected={detected} siteName={siteName} />;

  return <div className="w-full max-w-md">{body}</div>;
}
