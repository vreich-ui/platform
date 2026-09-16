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
  type TurnOrigin,
} from './cms-agent-client.js';
import { isMembershipTool } from '../mcp-tool-definitions-membership.js';
import { buildUiCapabilities } from '../../../lib/admin/ui-capabilities.js';

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
 *
 * Task B (provider-error-details): carries CMS-Agent's own structured detail
 * (`operatorAction`/`providerStatus`/`providerMessage`/`fromJsonBody`) so the
 * loop's `run_error` event can persist it verbatim instead of losing it to a
 * single precomposed `.message` string — `humanCopyForCmsAgentError` (below)
 * decides the FINAL display text at render time, not here, because whether
 * the viewer is an Owner can only be known then.
 */
export class CmsAgentEngineError extends Error {
  readonly code: string;
  /** The raw CMS-Agent message, WITHOUT the `${code}: ` prefix `.message` carries — that prefix is for log lines, not for rebuilding copy. */
  readonly detailMessage: string;
  readonly operatorAction?: string;
  readonly providerStatus?: number;
  readonly providerMessage?: string;
  readonly fromJsonBody: boolean;
  constructor(
    code: string,
    message: string,
    options: { operatorAction?: string; providerStatus?: number; providerMessage?: string; fromJsonBody?: boolean } = {}
  ) {
    super(`${code}: ${message}`);
    this.name = 'CmsAgentEngineError';
    this.code = code;
    this.detailMessage = message;
    this.operatorAction = options.operatorAction;
    this.providerStatus = options.providerStatus;
    this.providerMessage = options.providerMessage;
    this.fromJsonBody = options.fromJsonBody ?? false;
  }
}

/** Wire codes become `cms_agent_<reason>` (plan §5.5); transport codes already carry the prefix. */
const engineFailure = (failure: CmsAgentError): CmsAgentEngineError =>
  new CmsAgentEngineError(
    failure.code.startsWith('cms_agent_') ? failure.code : `cms_agent_${failure.code}`,
    failure.message,
    {
      operatorAction: failure.operatorAction,
      providerStatus: failure.providerStatus,
      providerMessage: failure.providerMessage,
      fromJsonBody: failure.fromJsonBody,
    }
  );

/**
 * PF3 / Task B — the editor-facing copy for a CMS-Agent failure. Delegates to
 * the isomorphic `cmsAgentErrorCopy` (`@core/lib/admin/cms-agent-error-copy`)
 * so the admin chat's `run_error` line and the workflow run's "Stopped at …"
 * card render the exact same rule from the exact same function — re-exported
 * here so existing server-side callers (loop.ts, admin-agent-chat.ts) do not
 * need a second import path.
 */
export {
  cmsAgentErrorCopy as humanCopyForCmsAgentError,
  CMS_AGENT_UNAVAILABLE_TEXT,
  hasOperatorAction,
  type CmsAgentErrorCopy,
  type CmsAgentErrorDetail,
} from '../../../lib/admin/cms-agent-error-copy.js';

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
  /**
   * ASV2-W4.3 — the run principal's freshly-resolved roles, used ONLY to
   * rights-filter `context.ui_capabilities.actions` (§7). Display-level, like
   * every other rights read outside a verb: the verb re-derives authority on
   * every call, so a wrong value here can hide a button, never grant a write.
   * Optional because a caller that cannot resolve roles should degrade to an
   * empty manifest, not fail the turn.
   */
  roles?: readonly string[];
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

/**
 * ASV2-W4.3 — the capability handshake that lets `context.ui_capabilities`
 * ship at all (chat-controls protocol §7.1).
 *
 * CMS-Agent's `conversationContextSchema` is `.strict()`, so a context field a
 * deployment does not know is not ignored — it fails the whole request as
 * `invalid_turn_request`. And because the idempotency claim is written
 * UPSTREAM of validation (as-built delta 1, the same rule `checkConverseBounds`
 * exists for), that rejection **burns the `turn_id` permanently**. A field sent
 * one turn too early therefore does not degrade; it breaks the chat.
 *
 * So the order is fixed and is the reverse of a prompt-only mirror: CMS-Agent
 * accepts the field first, that revision is deployed, and only then does
 * Platform send it. `agent_resolve` already reports the resolved agent's `rev`,
 * which makes the handshake free — no env var, no per-tenant operator step, no
 * manual migration. A tenant still pinned to an older `client_manager` rev
 * simply sends no manifest and every chat behaves exactly as it does today.
 *
 * 8 is the rev at which `client_manager` accepts `ui_capabilities`
 * (CMS-Agent `agentDefinitions.ts`, ASV2-W4-CA.1/CA.2). The comparison is
 * `>=`, not `===`, because `ensureConversationalAgentSeeds()` bumps a stored
 * agent to `rev + 1` only when its stored prompt is byte-identical to a
 * superseded text: a deployed workspace lands on rev >= 8, but the exact
 * number is not guaranteed, and an operator-edited prompt is never
 * auto-upgraded by seeding. An unknown or non-numeric rev reads as below the
 * gate — the closed side is the safe side.
 *
 * The rev is a strong signal and not a proof: it belongs to the stored agent
 * RECORD, and `agent_update` moves it on any operator edit regardless of what
 * the deployed service's schema accepts. The one-shot retry in
 * `cmsAgentEngine` below is what makes the remaining gap non-fatal.
 */
export const MIN_AGENT_REV_FOR_UI_CAPABILITIES = 8;

/** Whether this turn may carry the manifest. Pure, so the gate is testable on both sides. */
export const uiCapabilitiesAllowedAtRev = (rev: unknown): boolean =>
  typeof rev === 'number' && Number.isFinite(rev) && rev >= MIN_AGENT_REV_FOR_UI_CAPABILITIES;

/**
 * CHAT-ORIGIN — the SECOND field to ride this handshake, and it rides it for
 * exactly the reasons written above `MIN_AGENT_REV_FOR_UI_CAPABILITIES`: the
 * upstream `conversationContextSchema` is `.strict()`, the idempotency claim is
 * written before validation, so a field sent one rev too early does not degrade
 * — it burns the `turn_id` and the editor loses the turn.
 *
 * 9 is the rev at which `client_manager` accepts `context.origin` and renders
 * its "What this chat is about" block (CMS-Agent rev 9, merged and deployed).
 * `>=` for the same reason as the manifest's gate: seeding bumps a stored
 * agent's rev, so a deployed workspace lands at rev >= 9 without the exact
 * number being guaranteed, and an unknown rev reads as below the gate.
 */
export const MIN_AGENT_REV_FOR_ORIGIN = 9;

/** Whether this turn may carry the origin block. Pure, so the gate is testable on both sides. */
export const originAllowedAtRev = (rev: unknown): boolean =>
  typeof rev === 'number' && Number.isFinite(rev) && rev >= MIN_AGENT_REV_FOR_ORIGIN;

/**
 * CHAT-ORIGIN — the stored facts, as the wire shape.
 *
 * Reads ONLY what `create_chat` and `send` stamped (`chat-store.ts`); nothing
 * here derives, guesses or widens. `undefined` when the chat knows nothing,
 * which is every chat created before this change and therefore the honest
 * answer for them.
 *
 * The `'admin'` fallback exists for one case: a chat doc minted BEFORE this
 * change (no `origin_surface`) whose next send resolves a request binding. The
 * surface is required on the wire, and "some admin surface" is true, where
 * dropping the request id the editor is actually asking about is a real loss.
 * It mirrors `lib/admin/chat-origin.ts`'s own unknown-route answer.
 */
export const buildTurnOrigin = (doc: ChatDoc, run: ChatRun): TurnOrigin | undefined => {
  const rest = {
    ...(doc.origin_starter ? { starter: doc.origin_starter } : {}),
    ...(run.origin_request_id ? { request_id: run.origin_request_id } : {}),
    ...(run.origin_run_id ? { run_id: run.origin_run_id } : {}),
    // Constraint 7's sibling: an object chat already sends the pair as
    // `object_type`/`object_id`, so a "selection" there would be the same fact
    // twice and would read as a NEW pick. The server drops it at send; this is
    // the second gate, for docs stamped before that rule existed.
    ...(run.origin_selection && doc.kind !== 'object' ? { selection: run.origin_selection } : {}),
  };
  const surface = doc.origin_surface ?? (Object.keys(rest).length > 0 ? 'admin' : undefined);
  if (!surface) return undefined;
  return { surface, ...rest };
};

const conversationContext = (
  doc: ChatDoc,
  run: ChatRun,
  siteId: string,
  roles: readonly string[],
  agentRev: number
): CmsAgentContext => ({
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
  // ASV2-W4.3 §7: sent every turn exactly like approval_note, and absent
  // below the gate — below it the request is byte-identical to today's.
  // A free chat still sends the manifest, with an empty `actions` list: "I
  // render these card kinds, and there is no object to act on" is a different
  // (and more useful) statement than saying nothing at all.
  ...(uiCapabilitiesAllowedAtRev(agentRev)
    ? { ui_capabilities: buildUiCapabilities(doc.kind === 'object' ? doc.object_type : undefined, roles) }
    : {}),
  // CHAT-ORIGIN §: gated on rev 9 exactly like the manifest is on rev 8, and
  // omitted entirely when the chat knows nothing about where it came from.
  ...(originAllowedAtRev(agentRev) ? withOrigin(buildTurnOrigin(doc, run)) : {}),
});

/** `{ origin }` or `{}` — keeps the spread above readable and the field truly absent when unknown. */
const withOrigin = (origin: TurnOrigin | undefined): { origin?: TurnOrigin } => (origin ? { origin } : {});

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
  const roles = options.roles ?? [];
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
    let agentRef = resolved.data.agent_ref;
    // §7.1's capability handshake — see MIN_AGENT_REV_FOR_UI_CAPABILITIES.
    let agentRev = resolved.data.rev;

    const messages = trimTranscriptForCmsAgent(run.transcript);
    let context = conversationContext(doc, run, siteId, roles, agentRev);
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
    let retriedWithoutManifest = false;

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
      /**
       * ASV2-W4.3 (and CHAT-ORIGIN) — the rev gates' backstop, and the same
       * shape as the tool-bound fallback above (T19.8), for the same reason.
       *
       * `rev` is a property of the STORED AGENT RECORD; accepting
       * `ui_capabilities` is a property of the DEPLOYED SERVICE CODE. They move
       * together on the normal path (ASV2-W4-CA.1 and CA.2 landed in one
       * change), but nothing in the protocol makes that an invariant, and one
       * ordinary path breaks it: `agent_update` bumps a stored agent's rev by
       * one on EVERY edit (workspace store `updateConversationalAgent`). Two
       * operator prompt edits on a pre-CA.1 workspace sitting at rev 6 put a
       * rev-8 record in front of a service whose schema still rejects the
       * field. That rejection is `invalid_turn_request`, and the claim is
       * already written, so the id is gone either way: the choice is between
       * losing the id AND the turn, or losing the id and still answering the
       * editor. Retry once WITHOUT the manifest, under a fresh id.
       *
       * The trigger is deliberately not a match on the rejection's wording —
       * that prose belongs to the other repo and can be reworded at any time.
       * If the real cause was something else, the retry fails the same way and
       * the error surfaces.
       */
      if (
        result.code === 'invalid_turn_request' &&
        !retriedWithoutManifest &&
        (context.ui_capabilities || context.origin)
      ) {
        retriedWithoutManifest = true;
        // CHAT-ORIGIN: BOTH rev-gated fields go, in the SAME single retry.
        // One retry, not two: the second rejection would burn a second
        // turn_id to learn what the first already told us — that this
        // deployment's schema does not match the rev it reports. Whichever of
        // the two it actually choked on, the turn goes without either and the
        // editor still gets an answer.
        const { ui_capabilities: _rejectedManifest, origin: _rejectedOrigin, ...withoutGatedFields } = context;
        context = withoutGatedFields;
        turnId = `${baseTurnId}_nouc`;
        console.warn(
          JSON.stringify({
            event: 'cms_agent_gated_context_rejected',
            run_id: run.run_id,
            agent_rev: agentRev,
            dropped: [...(_rejectedManifest ? ['ui_capabilities'] : []), ...(_rejectedOrigin ? ['origin'] : [])],
            min_rev_ui_capabilities: MIN_AGENT_REV_FOR_UI_CAPABILITIES,
            min_rev_origin: MIN_AGENT_REV_FOR_ORIGIN,
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
        agentRef = reresolved.data.agent_ref;
        // The rev is why we re-resolved; rebuild the context so the retry is
        // gated on what the agent is NOW, not on the stale ref's rev.
        if (reresolved.data.rev !== agentRev) {
          agentRev = reresolved.data.rev;
          context = conversationContext(doc, run, siteId, roles, agentRev);
          /**
           * ASV2-W5 (review) — never PUT BACK a manifest this run already had
           * rejected. `conversationContext` re-derives `ui_capabilities` from
           * the new rev, so on the sequence
           * `invalid_turn_request` (manifest dropped) → `agent_unresolved` →
           * re-resolve to a rev at or above the gate, this line would resend
           * the field that just failed — and `retriedWithoutManifest` is
           * already spent, so the next rejection is terminal and burns the
           * turn. The drop is one-way for the life of the run.
           */
          if (retriedWithoutManifest) {
            const { ui_capabilities: _stillRejected, origin: _originStillRejected, ...withoutGatedFields } = context;
            context = withoutGatedFields;
          }
        }
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
  /** ASV2-W4.3 — see `CmsAgentEngineOptions.roles`; forwarded unchanged. */
  roles?: readonly string[];
};

/**
 * The sole production admin-chat engine. A CMS-Agent failure throws and the
 * run records a coded error; no direct provider call is available here.
 */
export const buildChatEngine = (options: ChatEngineOptions): TurnEngine =>
  cmsAgentEngine({
    client: options.client,
    projectId: options.projectId,
    siteId: options.siteId,
    ...(options.roles ? { roles: options.roles } : {}),
  });
