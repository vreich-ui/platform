/**
 * W19 T19.7 — resolving a sender, and the one message this wave sends.
 */
import { isMailConfigured, mailConfig, nullMailSender, type MailSender } from './index.js';
import { resendMailSender } from './resend.js';

export const resolveMailSender = (fetchImpl: typeof fetch = fetch): MailSender =>
  isMailConfigured() && mailConfig().provider === 'resend' ? resendMailSender(fetchImpl) : nullMailSender;

export interface RequestMailInput {
  requestId: string;
  title: string;
  status: string;
  statusReason?: string;
  /** The site's public origin, for the deep link. */
  origin?: string;
}

const SUBJECTS: Record<string, (title: string) => string> = {
  needs_you: (title) => `Needs you: ${title}`,
  stalled: (title) => `Stalled: ${title}`,
  failed: (title) => `Stopped: ${title}`,
  done: (title) => `Finished: ${title}`,
};

/**
 * Deliberately thin (plan §6.3): what happened, which request, one link, and
 * how to change the setting. No article content, no transcript, no PII beyond
 * the recipient's own address — an inbox is not a place to leak a draft.
 */
export const requestMail = (input: RequestMailInput): { subject: string; text: string } => {
  const subject = (SUBJECTS[input.status] ?? ((title: string) => `Update: ${title}`))(input.title);
  const link = input.origin
    ? `${input.origin.replace(/\/$/, '')}/admin/requests/${encodeURIComponent(input.requestId)}`
    : undefined;
  const lines = [
    input.statusReason ?? '',
    '',
    link ? `Open it: ${link}` : `Request: ${input.requestId}`,
    '',
    'Change or stop these e-mails on the Requests page in your admin.',
  ].filter((line, index, all) => !(line === '' && all[index - 1] === ''));
  return { subject, text: lines.join('\n').trim() };
};
