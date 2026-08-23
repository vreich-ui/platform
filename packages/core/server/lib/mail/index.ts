/**
 * W19 T19.7 — the platform's FIRST outbound mail dependency, behind a seam.
 *
 * The sending code is small; the obligation around it is not. W16 law P2: a
 * new env var read by core lands, in the same change, in the T11.7 env table +
 * `ENV_CHECKLIST` + every existing site's env (or degrades with an explicit
 * catalogued `error_code`) and is covered by the capability probe. All of that
 * is done — see `create-site.mjs`'s checklist, `fleet-capability-probe.mjs`'s
 * `mail` family, and `capability-status.ts`.
 *
 * Unconfigured is NORMAL, not broken. A tenant with no mail behaves exactly as
 * it did before this shipped: `resolveMailSender()` returns the null sender,
 * `capability_status` reports `mail` unconfigured, and the in-app and browser
 * channels are untouched. Nothing in the sweep may fail because mail did.
 *
 * The vendor is one file (`resend.ts`). The seam is the part that matters.
 */

export type MailFailureCode = 'mail_not_configured' | 'mail_rejected' | 'mail_unreachable' | 'mail_invalid';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Provider-side grouping; never carries content. */
  tags?: Record<string, string>;
}

export type MailResult = { ok: true; id?: string } | { ok: false; code: MailFailureCode; message: string };

export interface MailSender {
  readonly provider: string;
  send(message: MailMessage): Promise<MailResult>;
}

/**
 * What a tenant without mail gets. It is not an error path — it is the
 * configured behaviour of every site that has not opted in, and the catalogued
 * code says so plainly rather than looking like a failure.
 */
export const nullMailSender: MailSender = {
  provider: 'none',
  send: async () => ({
    ok: false,
    code: 'mail_not_configured',
    message: 'No mail provider is configured for this site; the in-app and browser channels are unaffected.',
  }),
};

/** Read at CALL time, never at import time — a module-level read would freeze a cold-start env. */
export const mailConfig = () => ({
  provider: (process.env.MAIL_PROVIDER ?? 'none').trim().toLowerCase(),
  apiKey: process.env.MAIL_API_KEY?.trim() ?? '',
  from: process.env.MAIL_FROM?.trim() ?? '',
  replyTo: process.env.MAIL_REPLY_TO?.trim() || undefined,
});

/**
 * The providers this build can actually drive. The capability probe reads the
 * SAME list — reporting `mail` green for a provider the runtime falls back to
 * the null sender for (a typo, or a provider we have no adapter for) is worse
 * than reporting it red, because nobody goes looking.
 */
export const SUPPORTED_MAIL_PROVIDERS: readonly string[] = ['resend'];

export const isMailProviderSupported = (provider: string): boolean =>
  SUPPORTED_MAIL_PROVIDERS.includes(provider.trim().toLowerCase());

export const isMailConfigured = (): boolean => {
  const config = mailConfig();
  return isMailProviderSupported(config.provider) && Boolean(config.apiKey) && Boolean(config.from);
};
