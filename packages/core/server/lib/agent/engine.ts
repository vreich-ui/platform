/**
 * PF2 — the TurnEngine seam (roadmap PF2.1/PF2.2).
 *
 * The chat loop's one provider call becomes an interface. Two implementations:
 *
 *   - `providerEngine` wraps the existing provider adapters byte-identically —
 *     same input, same output, nothing below the seam changes;
 *   - `cmsAgentEngine` builds a `client_manager.turn.v1` request from the run,
 *     calls `agent_converse` through the PF1 client, and maps the response to
 *     the loop's expected `ProviderTurnResult` shape.
 *
 * Which engine runs is mode resolution: governance override ?? env ?? 'off'
 * (`resolveEffectiveChatMode`). `off` leaves the provider path untouched;
 * `fallback` and `required` both select `cmsAgentEngine` here — the
 * fallback-on-error behavior and its loud `engine_fallback` event are PF3.
 *
 * Contract source: CLIENT-MANAGER-CONTRACT.md (CMS-Agent repo root) as
 * corrected by plan §5A. The PF1 client owns transport, bounds pre-flight,
 * error typing and the `retryableWithSameTurnId` rule — none of that is
 * re-derived here.
 */
import { appendChatEvent, type ChatDoc, type ChatMsg, type ChatRun } from './chat-store.js';
import type { ProviderAdapter, ProviderTurnResult, WireTool } from './provider.js';
import {
  CMS_AGENT_BOUNDS,
  CMS_AGENT_DEFAULT_CONSTRAINTS,
  resolveCmsAgentChatMode,
  type CmsAgentChatMode,
  type CmsAgentClient,
  type CmsAgentContext,
  type CmsAgentError,
} from './cms-agent-client.js';
import type { SiteBindingEnvNames } from '../site-binding.js';

// ─── the seam ────────────────────────────────────────────────────────────────

export type TurnEngineInput = {
  doc: ChatDoc;
  run: ChatRun;
  /**
   * The Platform-assembled system prompt. `providerEngine` sends it as today;
   * `cmsAgentEngine` deliberately does NOT — CMS-Agent owns the prompt (single
   * prompt owner, plan §5A constraint 13; the wire request has no system
   * field). Required-mode cutover therefore depends on CA6 prompt parity.
   */
  system: string;
  tools: WireTool[];
};

/** One model turn. The loop calls this and nothing else above the seam. */
export type TurnEngine = (input: TurnEngineInput) => Promise<ProviderTurnResult>;

export type EngineKind = 'provider' | 'cms_agent';

/** PF2.1 — the legacy path, byte-identical: same adapter, same three fields. */
export const providerEngine =
  (adapter: ProviderAdapter): TurnEngine =>
  ({ system, run, tools }) =>
    adapter({ system, transcript: run.transcript, tools });

// ─── mode resolution ─────────────────────────────────────────────────────────

/**
 * `governance override ?? env ?? 'off'`. The env layer already fail-safes:
 * unset, blank or unrecognized values resolve to 'off' (with the raw value
 * reported via `invalidEnvValue` so PF3 can surface the typo).
 */
export const resolveEffectiveChatMode = (
  governanceOverride?: CmsAgentChatMode,
  names?: SiteBindingEnvNames
): { mode: CmsAgentChatMode; invalidEnvValue?: string } => {
  if (governanceOverride) return { mode: governanceOverride };
  const env = resolveCmsAgentChatMode(names);
  return { mode: env.mode, ...(env.invalidValue === undefined ? {} : { invalidEnvValue: env.invalidValue }) };
};

// ─── failures ────────────────────────────────────────────────────────────────

/**
 * Thrown into the loop's existing catch, which records `message` on a
 * `run_error` event — so the stable `cms_agent_*` code leads the message.
 * PF3 reads `.code` to emit named error events and human copy; nothing here
 * ever contains a bearer (the client sanitizes every message it returns).
 */
export class CmsAgentEngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CmsAgentEngineError';
    this.code = code;
  }
}

/** Wire codes become `cms_agent_<reason>` (plan §5.5); transport codes already carry the prefix. */
const engineFailure = (failure: CmsAgentError): CmsAgentEngineError =>
  new CmsAgentEngineError(failure.code.startsWith('cms_agent_') ? failure.code : `cms_agent_${failure.code}`, failure.message);

/**
 * PF3 — the editor-facing sentence for each failure class. Editor-safe by the
 * house rule: no raw ids, schemas, providers or internals; "nothing was
 * changed" is literally true because the engine fails before any tool
 * executes on this turn.
 */
export const humanCopyForCmsAgentError = (code: string): string => {
  switch (code) {
    case 'cms_agent_not_configured':
      return 'The Publishing Agent service is not configured for this site — nothing was changed. Contact the owner.';
    case 'cms_agent_auth_failed':
      return 'The Publishing Agent service rejected this site’s credentials — nothing was changed. Contact the owner.';
    case 'cms_agent_timeout':
    case 'cms_agent_model_timeout':
      return 'The Publishing Agent service took too long to respond — nothing was changed. Try again.';
    case 'cms_agent_transcript_too_large':
      return 'This conversation has grown too long for the Publishing Agent — start a new conversation to continue.';
    case 'cms_agent_budget_exceeded':
      return 'The Publishing Agent service declined this turn for budget reasons — nothing was changed. Contact the owner.';
    case 'cms_agent_invalid_actor':
      return 'This session could not be attributed to a signed-in editor — nothing was changed. Sign out and back in, then try again.';
    default:
      return 'The Publishing Agent service is unavailable — nothing was changed. Try again or contact the owner.';
  }
};

// ─── transcript trim (constraints 4 + 5) ─────────────────────────────────────

/**
 * The contract's transcript bound (≤200 messages AND ≤256KB serialized) is a
 * second, separate bound from Platform's own event-log trim. Trim oldest-first
 * — exactly the policy the provider adapters document — and preserve tool
 * adjacency: dropping an assistant message must also drop the tool results
 * that answered it, or the leading orphan is `invalid_turn_request` upstream.
 * The latest message is never dropped.
 */
export const trimTranscriptForCmsAgent = (transcript: ChatMsg[]): ChatMsg[] => {
  const messages = [...transcript];
  const overBound = (): boolean =>
    messages.length > CMS_AGENT_BOUNDS.maxMessages ||
    JSON.stringify(messages).length > CMS_AGENT_BOUNDS.maxMessagesChars;
  while (messages.length > 1 && overBound()) {
    messages.shift();
    while (messages.length > 1 && messages[0]!.role === 'tool') messages.shift();
  }
  return messages;
};

// ─── PF2.2 — the CMS-Agent engine ────────────────────────────────────────────

/** What the engine needs from the PF1 client — narrow, so tests stub a plain object. */
export type CmsAgentTurnClient = Pick<CmsAgentClient, 'converse' | 'resolveAgent' | 'invalidateAgentRef'>;

export type CmsAgentEngineOptions = {
  client: CmsAgentTurnClient;
  /** The site's CMS-Agent project (site-identity `cmsAgentProjectId`). */
  projectId: string;
  /** `context.site_id` on every turn (the SiteBinding's site singleton id). */
  siteId: string;
};

/** Mirrors the plan §5.1 example; CA6 owns the full governance prompt. ≤1000 chars (contract bound). */
const APPROVAL_NOTE =
  'Some tools require human approval; propose one coherent change at a time, and never re-submit a call a human declined.';

const conversationContext = (doc: ChatDoc, run: ChatRun, siteId: string): CmsAgentContext => ({
  site_id: siteId,
  // Constraint 7: paired or absent — a free chat sends neither.
  ...(doc.kind === 'object' && doc.object_type && doc.object_id
    ? { object_type: doc.object_type, object_id: doc.object_id }
    : {}),
  ...(run.focus ? { focus: run.focus } : {}),
  learning_mode: run.learning_mode,
  // CA6-additive; only ever sent when the run's Owner-derived flag is set.
  // A tone assertion, never authorization — mirrors systemPrompt()'s branch.
  ...(run.diagnostics_requested ? { diagnostics_requested: true } : {}),
  approval_note: APPROVAL_NOTE,
});

/**
 * One `agent_converse` turn per loop iteration.
 *
 * turn_id discipline (as-built delta 1 — the claim is written before
 * validation upstream, so an id that reaches the service with bad input is
 * pinned forever): the base id `t_<run_id>_<provider_turn>` is unique per
 * provider turn by construction. The only in-engine retries are the two safe
 * cases: a stale agent_ref (validation-class — re-resolve and mint a FRESH
 * id) and an expired MCP session (transport-class — the retry is
 * byte-identical, so the SAME id replays a completed turn for free). Every
 * other failure throws; a later send starts a new run and new ids. Bounds are
 * NOT checked here — the client's pre-flight does that before any claim can
 * be written.
 */
export const cmsAgentEngine = (options: CmsAgentEngineOptions): TurnEngine => {
  const { client, projectId, siteId } = options;
  return async ({ doc, run, tools }) => {
    // Constraint 2: the admin surface can stamp an empty principal id — refuse
    // with a clear error rather than sending an unattributable turn.
    const actorId = run.principal.id.trim();
    if (actorId.length === 0) {
      throw new CmsAgentEngineError(
        'cms_agent_invalid_actor',
        'This run has no stable editor id, so the turn cannot be attributed. Re-authenticate and send again.'
      );
    }

    const resolved = await client.resolveAgent({ role: 'client_manager', project_id: projectId });
    if (!resolved.ok) throw engineFailure(resolved);
    let agentRef = resolved.data;

    const messages = trimTranscriptForCmsAgent(run.transcript);
    const context = conversationContext(doc, run, siteId);
    const baseTurnId = `t_${run.run_id}_${run.provider_turns}`;
    let turnId = baseTurnId;
    let refreshedRef = false;
    let retriedSession = false;

    for (;;) {
      const result = await client.converse({
        agent_ref: agentRef,
        project_id: projectId,
        conversation_id: doc.chat_id,
        turn_id: turnId,
        // Constraint 1: {kind, id} ONLY — principal.email is stripped here.
        actor: { kind: 'human', id: actorId },
        context,
        messages,
        // Constraint 8: sent exactly as Platform builds them today; the
        // client's pre-flight asserts count/size and non-empty descriptions.
        tools,
        constraints: { ...CMS_AGENT_DEFAULT_CONSTRAINTS },
      });
      if (result.ok) {
        // Record what actually reasoned this turn (schema-additive fields).
        run.engine = 'cms_agent';
        run.agent_ref = agentRef;
        return {
          ...(result.data.assistant_text ? { text: result.data.assistant_text } : {}),
          toolCalls: result.data.tool_calls ?? [],
          outputTokens: result.data.usage?.output_tokens ?? 0,
        };
      }
      if (result.code === 'agent_unresolved' && !refreshedRef) {
        // Constraint 10: stale/pinned rev — drop the cache, re-resolve once,
        // and mint a FRESH turn_id (a validation-class rejection pinned the old one).
        refreshedRef = true;
        client.invalidateAgentRef('client_manager', projectId);
        const reresolved = await client.resolveAgent({ role: 'client_manager', project_id: projectId });
        if (!reresolved.ok) throw engineFailure(reresolved);
        agentRef = reresolved.data;
        turnId = `${baseTurnId}_r1`;
        continue;
      }
      if (result.code === 'cms_agent_protocol_error' && result.statusCode === 404 && !retriedSession) {
        // Expired MCP session; the client dropped it and will re-handshake.
        // Byte-identical retry → same turn_id (retryableWithSameTurnId: true).
        retriedSession = true;
        continue;
      }
      throw engineFailure(result);
    }
  };
};

// ─── PF3 — mode-aware engine assembly ────────────────────────────────────────

export type ChatEngineOptions = {
  mode: CmsAgentChatMode;
  /** The run's stamped profile adapter — the legacy path and the fallback target. */
  adapter: ProviderAdapter;
  client: CmsAgentTurnClient;
  projectId: string;
  siteId: string;
  nowIso?: () => string;
};

/**
 * The one place a mode becomes an engine:
 *
 *   off      → providerEngine only; the CMS-Agent client is never touched.
 *   required → cmsAgentEngine only; a failure throws and the run errors —
 *              by construction no code path can reach the provider adapter,
 *              which is done-criteria E3's "provably never invoked".
 *   fallback → cmsAgentEngine first; an engine-class failure appends a LOUD
 *              `engine_fallback` event (code + human copy) to the doc and
 *              retries the same turn on the provider path, restamping
 *              run.engine. A non-engine error (a bug) still throws — only
 *              known CMS-Agent failures may degrade.
 */
export const buildChatEngine = (options: ChatEngineOptions): TurnEngine => {
  const provider = providerEngine(options.adapter);
  if (options.mode === 'off') return provider;
  const cms = cmsAgentEngine({ client: options.client, projectId: options.projectId, siteId: options.siteId });
  if (options.mode === 'required') return cms;
  const at = options.nowIso ?? (() => new Date().toISOString());
  // One engine instance serves one background hop. After the first
  // degradation the REST OF THE HOP stays on the provider path: re-probing a
  // dead service on every turn would add up to 90s latency per turn and spam
  // duplicate engine_fallback events. The next hop retries CMS-Agent fresh.
  let degradedThisHop = false;
  return async (input) => {
    if (degradedThisHop) return provider(input);
    try {
      return await cms(input);
    } catch (error) {
      if (!(error instanceof CmsAgentEngineError)) throw error;
      degradedThisHop = true;
      appendChatEvent(input.doc, at(), 'engine_fallback', {
        run_id: input.run.run_id,
        code: error.code,
        message: humanCopyForCmsAgentError(error.code),
      });
      const turn = await provider(input);
      // The provider answered this turn — record what actually reasoned it.
      input.run.engine = 'provider';
      return turn;
    }
  };
};
