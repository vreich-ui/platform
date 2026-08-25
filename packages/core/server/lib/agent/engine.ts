/**
 * PF2 — the TurnEngine seam (roadmap PF2.1/PF2.2).
 *
 * The chat loop's one reasoning call is an interface. The production admin
 * chat implementation is `cmsAgentEngine`, which calls the canonical Client
 * Manager through CMS-Agent.
 *
 * `providerEngine` remains exported only as a test harness for loop-level
 * fixtures. No production admin-chat construction path can select it.
 * `cmsAgentEngine` builds a `client_manager.turn.v1` request from the run,
 *     calls `agent_converse` through the PF1 client, and maps the response to
 *     the loop's expected `ProviderTurnResult` shape.
 *
 * PF5 permanently cut admin chat over to Client Manager. Missing or unhealthy
 * CMS-Agent configuration fails closed; there is no provider fallback.
 *
 * Contract source: CLIENT-MANAGER-CONTRACT.md (CMS-Agent repo root) as
 * corrected by plan §5A. The PF1 client owns transport, bounds pre-flight,
 * error typing and the `retryableWithSameTurnId` rule — none of that is
 * re-derived here.
 */
import type { ChatDoc, ChatMsg, ChatRun } from './chat-store.js';
import type { ProviderAdapter, ProviderTurnResult, WireTool } from './provider.js';
import {
  CMS_AGENT_BOUNDS,
  CMS_AGENT_DEFAULT_CONSTRAINTS,
  type CmsAgentClient,
  type CmsAgentContext,
  type CmsAgentError,
} from './cms-agent-client.js';
import { isMembershipTool } from '../mcp-tool-definitions-membership.js';

// ─── the seam ────────────────────────────────────────────────────────────────

export type TurnEngineInput = {
  doc: ChatDoc;
  run: ChatRun;
  /**
   * The Platform-assembled system prompt. `providerEngine` sends it as today;
   * `cmsAgentEngine` deliberately does NOT — CMS-Agent owns the prompt (single
   * prompt owner, plan §5A constraint 13; the wire request has no system
   * field). The permanent cutover therefore depends on CA6 prompt parity.
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
  new CmsAgentEngineError(
    failure.code.startsWith('cms_agent_') ? failure.code : `cms_agent_${failure.code}`,
    failure.message
  );

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

/**
 * Mirrors the plan §5.1 example; CA6 owns the full governance prompt. ≤1000
 * chars (contract bound, `checkConverseBounds`'s `context.approval_note` row
 * in cms-agent-client.ts).
 *
 * T8 (2026-08-25) — the DEFECT this note exists to close: an editor said
 * "publish it" / "approved, ship it" about a workspace run, and Client
 * Manager answered as though the approval had already gone through — no
 * `publish_workspace_run` call, so no approval card ever rendered, and
 * nothing actually happened. Client Manager owns its own prompt (engine.ts's
 * header comment, CA6) so Platform cannot edit that prompt directly; this
 * `approval_note` is the one per-turn channel Platform DOES control on every
 * `client_manager.turn.v1` request (`conversationContext` below), so the two
 * added sentences ride here rather than needing a CMS-Agent-side change.
 * `publish_workspace_run` already carries `autonomyFloor: 'ask'` (tools.ts) —
 * PROPOSING that call is what turns into the approval card the editor clicks,
 * so telling the model to propose it is telling it to render the button.
 * Second sentence closes a related failure: a `no_go` readiness got
 * paraphrased into a vague "a few things need fixing" instead of the actual
 * checklist entries, leaving the editor unable to act on it.
 */
const APPROVAL_NOTE =
  'Some tools require human approval; propose one coherent change at a time, and never re-submit a call a human ' +
  'declined. Never say an approval, publish, or other privileged action is "registered", "recorded", or "done" ' +
  'unless you propose the matching privileged tool call in the SAME turn — proposing the call is what renders the ' +
  'approval card; nothing happens without it. When an editor approves, confirms, or asks to publish, ship, or take ' +
  'live a workspace run, propose publish_workspace_run — never claim it happened without proposing it. When ' +
  'check_workspace_run_readiness reports no_go, show its checklist and blockers to the editor VERBATIM, not paraphrased.';

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
/** Trim the membership family (only) when the wire list exceeds the CMS-Agent bound. Pure. */
/**
 * W19 T19.8: families are dropped WHOLE, in a documented order, and a
 * positional slice is the last resort.
 *
 * Slicing by array position drops whatever happens to sit at the end, which
 * after this wave was three of the four editorial-request tools — leaving the
 * agent a `list_requests` it could call and a `get_request` it could not. If
 * the wire must lose a capability it should lose all of it and know which:
 * membership first (reachable from the admin UI and OAuth /mcp), then the
 * request tools (the whole registry is on the Requests page anyway). Object
 * verbs are never in this list; without them the chat cannot work at all.
 */
const TRIMMABLE_FAMILIES: ReadonlyArray<{ name: string; matches: (toolName: string) => boolean }> = [
  { name: 'membership', matches: isMembershipTool },
  { name: 'editorial_requests', matches: (name) => REQUEST_TOOL_NAMES.has(name) },
];

const REQUEST_TOOL_NAMES = new Set([
  'list_requests',
  'get_request',
  'get_request_activity',
  'retry_request',
  'archive_request',
]);

export interface ToolTrimResult {
  tools: WireTool[];
  /** Which whole families were dropped, in the order they were dropped. */
  dropped: string[];
  /** True when dropping families was not enough and a positional slice ran. */
  sliced: boolean;
}

export const trimToolsToCmsAgentBound = (
  tools: WireTool[],
  maxTools: number = CMS_AGENT_BOUNDS.maxTools
): ToolTrimResult => {
  if (tools.length <= maxTools) return { tools, dropped: [], sliced: false };
  let trimmed = tools;
  const dropped: string[] = [];
  for (const family of TRIMMABLE_FAMILIES) {
    const next = trimmed.filter((tool) => !family.matches(tool.name));
    if (next.length !== trimmed.length) dropped.push(family.name);
    trimmed = next;
    if (trimmed.length <= maxTools) return { tools: trimmed, dropped, sliced: false };
  }
  return { tools: trimmed.slice(0, maxTools), dropped, sliced: true };
};

export const fitToolsToCmsAgentBound = (tools: WireTool[], maxTools: number = CMS_AGENT_BOUNDS.maxTools): WireTool[] =>
  trimToolsToCmsAgentBound(tools, maxTools).tools;

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
    // W18 T18.6b: CMS-Agent bounds the wire to CMS_AGENT_BOUNDS.maxTools. The
    // membership family (16 tools) is the newest and optional; when the run's
    // wire list would exceed the bound, that family is trimmed here — logged,
    // never a hard failure — and membership stays reachable from the admin UI,
    // /mcp (OAuth) and the provider engine. Raise the bound to lift this.
    const trim = trimToolsToCmsAgentBound(tools);
    let wireTools = trim.tools;
    if (wireTools.length !== tools.length) {
      console.warn(
        JSON.stringify({
          event: 'cms_agent_tools_trimmed',
          run_id: run.run_id,
          dropped: tools.length - wireTools.length,
          bound: CMS_AGENT_BOUNDS.maxTools,
          // The families that ACTUALLY went, not a hardcoded guess — an
          // operator asking "why can't the agent see get_request" needs this
          // line to answer them.
          families: trim.dropped,
          ...(trim.sliced ? { sliced: true } : {}),
        })
      );
    }
    const baseTurnId = `t_${run.run_id}_${run.provider_turns}`;
    let turnId = baseTurnId;
    let refreshedRef = false;
    let retriedSession = false;
    let retriedToolBound = false;

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
        tools: wireTools,
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
      /**
       * W19 T19.8: the two repos raised `maxTools` together (64 → 96), and
       * this makes their merge ORDER irrelevant. If the far side is still on
       * the old ceiling it answers `invalid_turn_request`; we trim to 64 once,
       * with a fresh turn id, and carry on. The trigger is deliberately NOT a
       * match on the rejection's wording — that prose belongs to the other
       * repo and can be reworded at any time, which would silently strand
       * every chat. Any validation rejection of a wire that is over the old
       * ceiling earns exactly one retry under it; if the real cause was
       * something else, the retry fails the same way and the error surfaces.
       */
      if (
        result.code === 'invalid_turn_request' &&
        !retriedToolBound &&
        wireTools.length > CMS_AGENT_BOUNDS.legacyMaxTools
      ) {
        retriedToolBound = true;
        const legacy = trimToolsToCmsAgentBound(tools, CMS_AGENT_BOUNDS.legacyMaxTools);
        wireTools = legacy.tools;
        turnId = `${baseTurnId}_b64`;
        console.warn(
          JSON.stringify({
            event: 'cms_agent_tool_bound_fallback',
            run_id: run.run_id,
            bound: CMS_AGENT_BOUNDS.legacyMaxTools,
            families: legacy.dropped,
            ...(legacy.sliced ? { sliced: true } : {}),
          })
        );
        continue;
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

// ─── PF5 — permanent Client Manager assembly ─────────────────────────────────

export type ChatEngineOptions = {
  client: CmsAgentTurnClient;
  projectId: string;
  siteId: string;
};

/**
 * The sole production admin-chat engine. A CMS-Agent failure throws and the
 * run records a coded error; no direct provider call is available here.
 */
export const buildChatEngine = (options: ChatEngineOptions): TurnEngine =>
  cmsAgentEngine({ client: options.client, projectId: options.projectId, siteId: options.siteId });
