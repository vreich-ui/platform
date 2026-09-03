/**
 * The object-store actor, derived from AUTH rather than from tool arguments.
 *
 * WHAT WENT WRONG (live, 2026-09-03). `object-store.ts` built every principal
 * from one line:
 *
 *     { kind: 'agent', agent_name: payload.agent_name || 'unattributed-agent' }
 *
 * `payload` is the tool-call arguments — model-authored text. So attribution
 * was only ever as reliable as a model remembering to repeat a field, and the
 * ChatGPT agent's first live article proved the failure mode: `create` carried
 * `plugin:openai-agent`, and the sixteen calls after it — four patches and
 * three publishes — carried nothing and landed as `unattributed-agent`.
 *
 * THE RULE (Wolf, 2026-09-03): identity is derived from the credential that
 * authorized the request, never from model-supplied text. `agent_name` stays,
 * demoted to a label. Precedence, strongest first:
 *
 *   1. OAuth grant          → {kind:'human', id, email, client_id, surface}
 *   2. Verified agent token  → {kind:'agent', agent_name: <resolved>}
 *   3. Publish key + label   → {kind:'agent', agent_name: <declared>}
 *   4. Publish key, no label → {kind:'agent', agent_name:'unattributed-agent'}
 *
 * A fifth case, lock inheritance, is applied by the verb layer and only when
 * this derivation produced case 4 — see `inheritActorFromLock`.
 *
 * WHY A HEADER, and why that is not the same mistake. `/mcp` reaches the
 * object store by invoking its sibling lambda with the fleet publish key, and
 * the derived actor travels on a request HEADER. The distinction that matters:
 * a model controls tool ARGUMENTS and cannot set HTTP headers, and this header
 * is only honoured on a request that already presented the publish key. It is
 * therefore exactly as trustworthy as the publish key itself — which is the
 * fleet — whereas `agent_name` was as trustworthy as a sentence in a prompt.
 *
 * The forwarding hazard is real and handled at the source: `/mcp` forwards the
 * caller's own headers to the sibling, so `createObjectStoreHeaders` must SET
 * this header on every call and DELETE it when there is nothing to derive.
 * Never leave it to pass through.
 */
import type { Principal } from '../../schema/object-record-v1.js';

/** The internal channel the derived actor rides. Publish-key-gated; never client-settable. */
export const CALLER_ACTOR_HEADER = 'x-cms-caller-actor';

export const UNATTRIBUTED_AGENT = 'unattributed-agent';

export type ActorSource = {
  oauthPrincipal?: { subject_email: string; subject_id: string; client_id: string; surface?: string } | undefined;
  verifiedAgentName?: string | undefined;
  /**
   * A surface the ENTRY POINT knows for certain, which outranks the
   * redirect-host derivation. Only the Actions façade sets it (see
   * `LambdaEvent.pluginSurface`), because a Custom GPT's OAuth callbacks live
   * on chatgpt.com and would otherwise be labelled `plugin:openai-agent`.
   */
  pluginSurface?: string | undefined;
};

const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const out = value.trim();
  return out.length > 0 ? out : undefined;
};

/**
 * Derive the actor for a `/mcp` request. `selfDeclaredLabel` is the tool call's
 * `agent_name` — a label on cases 1–2, the name on case 3, and nothing on 4.
 */
export const actorFromMcpAuth = (source: ActorSource, selfDeclaredLabel?: unknown): Principal => {
  const label = trimmed(selfDeclaredLabel);
  const oauth = source.oauthPrincipal;

  if (oauth?.subject_email && oauth.subject_id) {
    return {
      kind: 'human',
      id: oauth.subject_id,
      email: oauth.subject_email,
      client_id: oauth.client_id,
      ...(() => {
        const surface = trimmed(source.pluginSurface) ?? oauth.surface;
        return surface ? { surface } : {};
      })(),
      ...(label ? { label } : {}),
      attribution: 'oauth',
    };
  }

  const surface = trimmed(source.pluginSurface);
  const withSurface = surface ? { surface } : {};

  const verified = trimmed(source.verifiedAgentName);
  if (verified) {
    return {
      kind: 'agent',
      agent_name: verified,
      auth: 'mcp_token',
      ...withSurface,
      attribution: 'verified_agent_token',
    };
  }

  if (label) {
    return { kind: 'agent', agent_name: label, auth: 'publish_key', ...withSurface, attribution: 'self_declared' };
  }

  return {
    kind: 'agent',
    agent_name: UNATTRIBUTED_AGENT,
    auth: 'publish_key',
    ...withSurface,
    attribution: 'publish_key',
  };
};

/** True when the derivation found no identity at all — the only case lock inheritance may cover. */
export const isUnattributed = (actor: Principal): boolean =>
  actor.kind === 'agent' && actor.agent_name === UNATTRIBUTED_AGENT;

/**
 * LAST fallback. A write that carried no identity of its own is attributed to
 * the holder of the live lease it rode, stamped so nobody mistakes it for a
 * proven identity.
 *
 * Note what this deliberately does NOT do: inherit from whoever created the
 * object. A create says who started an article; it says nothing about who is
 * writing to it three hours later, and copying it forward would manufacture an
 * audit line that was never true.
 */
export const inheritActorFromLock = (actor: Principal, lockOwnerLabel: unknown): Principal => {
  if (!isUnattributed(actor)) return actor;
  const owner = trimmed(lockOwnerLabel);
  if (!owner || owner === UNATTRIBUTED_AGENT) return actor;
  return { kind: 'agent', agent_name: owner, auth: 'publish_key', attribution: 'inherited_lock' };
};

/** Serialize for the internal header. Returns undefined when there is nothing worth carrying. */
export const encodeCallerActor = (actor: Principal | undefined): string | undefined => {
  if (!actor) return undefined;
  // Case 4 carries nothing the receiver cannot derive itself — UNLESS the entry
  // point knew the surface, which is real information and must travel.
  if (isUnattributed(actor) && !actor.surface) return undefined;
  return Buffer.from(JSON.stringify(actor), 'utf8').toString('base64');
};

/**
 * Parse the internal header. Malformed input yields `undefined` — the caller
 * then derives from the payload exactly as it did before this existed, so a
 * bad header degrades attribution and never fails a write.
 */
export const decodeCallerActor = (raw: unknown): Principal | undefined => {
  const value = trimmed(raw);
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (candidate.kind === 'human' && trimmed(candidate.id) && trimmed(candidate.email)) {
      return candidate as unknown as Principal;
    }
    if (candidate.kind === 'agent' && trimmed(candidate.agent_name)) {
      return candidate as unknown as Principal;
    }
    return undefined;
  } catch {
    return undefined;
  }
};
