/**
 * Task B (provider-error-details) — the ONE place that turns a CMS-Agent
 * failure into editor-facing copy, shared by the admin chat's `run_error`
 * line (`chat.tsx`) and the workflow run's "Stopped at …" card
 * (`RequestActivity.tsx`'s per-node error list) — "same text" means the same
 * function, not two hand-copied renderings that drift.
 *
 * Isomorphic on purpose: lives under `lib/admin/`, not `server/lib/agent/`,
 * so a client component can import it directly without pulling server-only
 * code into the browser bundle. `engine.ts`'s `humanCopyForCmsAgentError`
 * delegates here for its server-side callers (loop.ts, admin-agent-chat.ts).
 *
 * The rule (2026-08-29 incident): OpenAI returned 429 credit_balance_exhausted
 * and it surfaced as "The Publishing Agent service is unavailable" — the
 * generic fallback swallowed real detail CMS-Agent had already sent. That
 * text is now shown ONLY when CMS-Agent's HTTP call genuinely carried no
 * JSON body (a connect error, a timeout, an HTML 5xx) — signalled by
 * `fromJsonBody` being false/absent. Whenever CMS-Agent DID answer with a
 * parsed JSON-RPC error body, the real `code`/`message`/`operatorAction`
 * are shown instead, and an Owner additionally sees the upstream provider's
 * own status + message on a second line — diagnostic detail an editor does
 * not need and should not be shown by default.
 */

export type CmsAgentErrorDetail = {
  code: string;
  /** CMS-Agent's own message text (already secret-sanitized upstream). */
  message: string;
  operatorAction?: string;
  /** The UPSTREAM model provider's HTTP status (e.g. 429) — never Platform's own call status. */
  providerStatus?: number;
  providerMessage?: string;
  /**
   * True only when CMS-Agent actually returned a parseable JSON-RPC error
   * body. False/absent for a connect error, a timeout, or an HTML 5xx — the
   * three "no body" cases named in the task brief.
   */
  fromJsonBody?: boolean;
};

export const CMS_AGENT_UNAVAILABLE_TEXT =
  'The Publishing Agent service is unavailable — nothing was changed. Try again or contact the owner.';

/**
 * Editor-safe crafted copy for the failure classes Platform already has a
 * considered sentence for (PF3). These take priority over the raw
 * code/message rendering below regardless of `fromJsonBody` — a crafted
 * sentence is strictly better than the mechanical one, and several of these
 * (e.g. `cms_agent_not_configured`) never carry a JSON body to draw from in
 * the first place.
 */
const CRAFTED_COPY: Readonly<Record<string, string>> = {
  cms_agent_not_configured: 'The Publishing Agent service is not configured for this site — nothing was changed. Contact the owner.',
  cms_agent_auth_failed: 'The Publishing Agent service rejected this site’s credentials — nothing was changed. Contact the owner.',
  cms_agent_timeout: 'The Publishing Agent service took too long to respond — nothing was changed. Try again.',
  cms_agent_model_timeout: 'The Publishing Agent service took too long to respond — nothing was changed. Try again.',
  cms_agent_transcript_too_large: 'This conversation has grown too long for the Publishing Agent — start a new conversation to continue.',
  cms_agent_budget_exceeded: 'The Publishing Agent service declined this turn for budget reasons — nothing was changed. Contact the owner.',
  cms_agent_invalid_actor: 'This session could not be attributed to a signed-in editor — nothing was changed. Sign out and back in, then try again.',
};

export type CmsAgentErrorCopy = {
  /** The primary line: crafted copy, "<code>: <message> — <operatorAction>", or the generic fallback. */
  text: string;
  /** Owner-only second line: "provider <providerStatus>: <providerMessage>". Absent for an editor, or when there is nothing to show. */
  providerDetail?: string;
};

export function cmsAgentErrorCopy(
  error: CmsAgentErrorDetail,
  options: { isOwner: boolean } = { isOwner: false }
): CmsAgentErrorCopy {
  const crafted = CRAFTED_COPY[error.code];
  if (crafted) return { text: crafted };
  if (!error.fromJsonBody) return { text: CMS_AGENT_UNAVAILABLE_TEXT };

  const text = error.operatorAction ? `${error.code}: ${error.message} — ${error.operatorAction}` : `${error.code}: ${error.message}`;
  const providerDetail =
    options.isOwner && error.providerStatus !== undefined && error.providerMessage
      ? `provider ${error.providerStatus}: ${error.providerMessage}`
      : undefined;
  return { text, ...(providerDetail ? { providerDetail } : {}) };
}

/** Whether a "Try again"/"Retry this step" affordance should be replaced by the operatorAction text instead. */
export const hasOperatorAction = (error: Pick<CmsAgentErrorDetail, 'operatorAction'>): boolean =>
  Boolean(error.operatorAction && error.operatorAction.trim().length > 0);
