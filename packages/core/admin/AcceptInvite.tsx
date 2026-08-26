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
import { IconCheck } from './icons';
import { SeverityIcon } from './severity';

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

/** After a token is consumed, continue to the onboarding step (T18.5 — /admin/welcome is a fleet route; its gate is a no-op once completed). */
const continueToWorkspace = async () => {
  stripHash();
  window.location.assign(WELCOME_PATH);
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
    // D4/D9 (T6.1): was a hardcoded `#c0392b` var() fallback and the
    // Needs-you triangle glyph on what is always a failed/blocked operation
    // (an expired link, a rejected password) — `--adm-danger*` tokens only,
    // and the level's real Error glyph. `role="alert"` already makes this an
    // assertive live region, so a screen-reader user hears it without a
    // separate aria-live wrapper.
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-[var(--adm-danger)] bg-[var(--adm-danger-soft)] px-3 py-2 text-[length:var(--adm-text-sm)] text-[var(--adm-danger-text)]"
    >
      <SeverityIcon level="error" size={16} title="" />
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

type InvitePreviewInfo = { email: string; role: string; invited_by: string; message?: string; expired: boolean };

function InviteForm({
  token,
  siteName,
  minLength,
  preview,
}: {
  token: string;
  siteName: string;
  minLength: number;
  preview?: InvitePreviewInfo | null;
}) {
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
        {preview && !preview.expired ? (
          <p className="text-[length:var(--adm-text-sm)]">
            <strong>{preview.invited_by}</strong> invited you to <strong>{siteName}</strong> as{' '}
            <strong>{preview.role.charAt(0).toUpperCase() + preview.role.slice(1)}</strong>.
            {preview.message ? (
              <span className="block mt-1 text-[var(--adm-text-muted)]">“{preview.message}”</span>
            ) : null}
          </p>
        ) : null}
        {preview?.expired ? (
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            The shared invitation link has expired, but the e-mail link you opened may still work — continue below.
          </p>
        ) : null}
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          {preview && !preview.expired
            ? 'Choose how your name appears and set a password.'
            : `You’ve been invited to the ${siteName} workspace. Choose how your name appears and set a password.`}
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
  const [preview, setPreview] = useState<InvitePreviewInfo | null>(null);

  useEffect(() => {
    setDetected(detectIdentityToken());
  }, []);

  useEffect(() => {
    if (detected === undefined) return;
    // T18.3b: an Owner-shared link carries OUR opaque token as `?inv=`; the
    // preview shows who invited you and as what (never anything sensitive).
    const inv =
      typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('inv') ?? undefined) : undefined;
    if (!detected && !inv) return;
    invitePreview(undefined, inv)
      .then((p) => {
        if (p.policy?.min_password) setMinLength(p.policy.min_password);
        if (p.site?.name) setSiteName(p.site.name);
        if (p.invitation) setPreview(p.invitation as InvitePreviewInfo);
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
  else if (!detected)
    body = (
      <NoTokenPanel
        siteName={siteName}
        message={
          preview && !preview.expired
            ? `${preview.invited_by} invited ${preview.email} to ${siteName} as ${preview.role}. To accept, open the link in the invitation e-mail from Netlify Identity — that link carries the sign-in token this page needs (this shared link only previews the invitation).`
            : undefined
        }
      />
    );
  else if (detected.kind === 'invite')
    body = <InviteForm token={detected.token} siteName={siteName} minLength={minLength} preview={preview} />;
  else if (detected.kind === 'recovery')
    body = <RecoveryForm token={detected.token} siteName={siteName} minLength={minLength} />;
  else body = <AutoConfirm detected={detected} siteName={siteName} />;

  return <div className="w-full max-w-md">{body}</div>;
}
