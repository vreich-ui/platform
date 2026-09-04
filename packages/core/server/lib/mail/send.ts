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

export interface InstallInviteMailInput {
  brandName: string;
  /** The tier the invitation granted — the fact GoTrue's own template cannot carry. */
  role: string;
  /** The site's public origin, for the install link. */
  origin: string;
  /** Who invited them, so the message is from a person rather than from a system. */
  invitedBy: string;
}

/**
 * W7.1 — the half of an invitation Netlify Identity cannot send.
 *
 * GoTrue's invitation template can interpolate exactly three values:
 * `{{ .SiteURL }}`, `{{ .Token }}`, `{{ .Email }}`. The ROLE is not among
 * them, and the role is the single most useful thing to tell an invitee: it
 * decides whether they can publish, whether they will be stopped at a review
 * gate, and — via `whoami.can_write` — whether their chat app can write at all.
 * An invitee who does not know their role finds out at the publish gate.
 *
 * So this is a SECOND message, sent by us, carrying the role and the install
 * link. It deliberately does not carry an accept token: GoTrue's mail owns the
 * credential half, this one owns the orientation half, and a token in two
 * places is a token twice as easy to leak. If a tenant has no mail configured,
 * `resolveMailSender` returns the null sender and the invitation still works —
 * the invitee just gets the GoTrue mail's generic install link instead.
 */
export const installInviteMail = (input: InstallInviteMailInput): { subject: string; text: string } => {
  const origin = input.origin.replace(/\/$/, '');
  return {
    subject: `You can publish to ${input.brandName}`,
    text: [
      `${input.invitedBy} invited you to ${input.brandName} as ${input.role}.`,
      '',
      'Accept the invitation in the e-mail from Netlify Identity first — that is the one that creates your account and sets your password.',
      '',
      'Then set up publishing from your own ChatGPT or Claude:',
      `${origin}/plugin/install`,
      '',
      `Your role is ${input.role}. Editor and above can write and publish; viewer is read-only, and a read-only account can attach the tools and then be refused on every write.`,
      '',
      'The install page ends with a check that proves it worked. Run it — a connector that authenticates but cannot write looks exactly like one that works, until you try to publish.',
    ].join('\n'),
  };
};
