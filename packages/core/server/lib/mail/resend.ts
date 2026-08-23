/**
 * W19 T19.7 — the first (and so far only) mail adapter.
 *
 * Plain `fetch` to one endpoint: no SDK, no dependency, nothing added to the
 * function bundle. Bounded timeout, typed errors, no retry — a send that fails
 * is recorded on the request's history and the sweep carries on. Retrying mail
 * inside a sweep would turn a provider outage into a stalled sweep, which
 * costs the record; a missed e-mail costs one notification the in-app channel
 * already delivered.
 */
import { mailConfig, type MailMessage, type MailResult, type MailSender } from './index.js';

const ENDPOINT = 'https://api.resend.com/emails';

/** Bounded so a hung provider cannot eat a background invocation's budget. */
export const MAIL_TIMEOUT_MS = 8_000;

export const resendMailSender = (fetchImpl: typeof fetch = fetch): MailSender => ({
  provider: 'resend',
  send: async (message: MailMessage): Promise<MailResult> => {
    const config = mailConfig();
    if (!config.apiKey || !config.from) {
      return { ok: false, code: 'mail_not_configured', message: 'MAIL_API_KEY and MAIL_FROM are both required.' };
    }
    if (!message.to.includes('@')) {
      return { ok: false, code: 'mail_invalid', message: `Not a deliverable address: ${message.to}` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MAIL_TIMEOUT_MS);
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: config.from,
          to: [message.to],
          ...(config.replyTo ? { reply_to: config.replyTo } : {}),
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
          ...(message.tags ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return {
          ok: false,
          code: 'mail_rejected',
          message: `Provider refused the message (HTTP ${response.status}). ${detail.slice(0, 200)}`.trim(),
        };
      }
      const body = (await response.json().catch(() => ({}))) as { id?: string };
      return { ok: true, ...(body.id ? { id: body.id } : {}) };
    } catch (error) {
      return {
        ok: false,
        code: 'mail_unreachable',
        message: error instanceof Error ? error.message.slice(0, 200) : 'The mail provider could not be reached.',
      };
    } finally {
      clearTimeout(timer);
    }
  },
});
