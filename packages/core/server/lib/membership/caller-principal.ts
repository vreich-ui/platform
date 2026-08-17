/**
 * W18 T18.6a — how the two agent-facing front doors build the principal the
 * membership core gates on.
 *
 *   /mcp   — `callerPrincipalFromMcpEvent`: an OAuth-bound HUMAN (the token's
 *            `subject_email` / `subject_id`, approved through Netlify Identity)
 *            becomes `{kind:'human', via:'mcp', client_id}`; the shared
 *            `MCP_HTTP_AUTH_TOKEN` and a verified/self-declared `agent_name`
 *            become `{kind:'agent'}` — which `handleMembershipVerb` refuses on
 *            its first line. Nothing an agent can put in a request body
 *            (`agent_name:'owner@site'` included) changes `kind`.
 *   chat   — `callerPrincipalFromChatRun`: the run record's captured HUMAN
 *            principal (T9.13) becomes `{kind:'human', via:'chat'}`; a run
 *            without one yields an agent principal and is refused.
 *
 * T18.6b's tool definitions call these; nothing else may mint a human
 * membership principal.
 */
import type { Principal } from '../../../schema/object-record-v1.js';
import type { MembershipPrincipal } from './verbs.js';

export interface McpPrincipalSource {
  oauthPrincipal?: { subject_email: string; subject_id: string; client_id: string } | undefined;
  verifiedAgentName?: string;
  requestId?: string;
}

export const callerPrincipalFromMcpEvent = (
  event: McpPrincipalSource,
  selfDeclaredAgentName?: unknown
): MembershipPrincipal => {
  if (event.oauthPrincipal?.subject_email && event.oauthPrincipal.subject_id) {
    return {
      kind: 'human',
      id: event.oauthPrincipal.subject_id,
      email: event.oauthPrincipal.subject_email,
      via: 'mcp',
      client_id: event.oauthPrincipal.client_id,
      ...(event.requestId ? { request_id: event.requestId } : {}),
    };
  }
  const agentName =
    event.verifiedAgentName ??
    (typeof selfDeclaredAgentName === 'string' && selfDeclaredAgentName.trim() ? selfDeclaredAgentName.trim() : 'mcp');
  return {
    kind: 'agent',
    agent_name: agentName,
    auth: 'mcp_token',
    via: 'mcp',
    ...(event.requestId ? { request_id: event.requestId } : {}),
  };
};

export const callerPrincipalFromChatRun = (
  runPrincipal: Principal | undefined,
  requestId?: string
): MembershipPrincipal => {
  if (runPrincipal?.kind === 'human' && runPrincipal.email) {
    return {
      kind: 'human',
      id: runPrincipal.id,
      email: runPrincipal.email,
      via: 'chat',
      ...(requestId ? { request_id: requestId } : {}),
    };
  }
  return {
    kind: 'agent',
    agent_name: runPrincipal?.kind === 'agent' ? runPrincipal.agent_name : 'chat',
    auth: 'mcp_token',
    via: 'chat',
    ...(requestId ? { request_id: requestId } : {}),
  };
};
