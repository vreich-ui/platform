/**
 * Which chat surface an OAuth grant belongs to — derived from the CLIENT
 * RECORD, never from anything a model can put in a tool argument.
 *
 * THE DEFECT THIS EXISTS FOR (found live, 2026-09-03). The ChatGPT agent
 * published `req_plugin_moisturizer_functions_20260903_01` through the tenant
 * `/mcp`. Its 17-entry ledger reads:
 *
 *     create                          plugin:openai-agent
 *     checkout, patch ×4, publish ×3, checkin, …   unattributed-agent
 *
 * The agent passed `agent_name` on its first call and dropped it for the
 * following sixteen, so the ledger cannot answer "which surface published
 * this article" — the exact question attribution exists to answer. The skill
 * text already asked for it; prose lost to sixteen tool calls, and prose will
 * lose again.
 *
 * So identity stops coming from the model. `agent_name` is demoted to a
 * LABEL on top of an actor derived from the token that authorized the call
 * (Wolf's ruling, 2026-09-03). This module is the "which surface" half of
 * that derivation.
 *
 * WHY THE REDIRECT HOST, and not `client_name`. Both live on the client
 * record, but they are not equally trustworthy. `client_name` is free text a
 * client sends to `/oauth/register` and nothing verifies it — "Claude" is
 * three keystrokes for anyone. A `redirect_uri` is an exact-match allowlist
 * checked on every authorization request: a token cannot be delivered to
 * `https://claude.ai/api/mcp/auth_callback` unless whoever receives it
 * controls claude.ai. That makes the host the strongest surface evidence the
 * grant carries, and it is why an unrecognised host resolves to `undefined`
 * (unknown) rather than falling back to the name.
 */
import type { PluginActorId } from './plugin/manifest-types.js';

/**
 * Registered redirect hosts, by the surface that owns them.
 *
 * Matching is on the host ONLY, exact or a subdomain — never a substring of
 * the whole URI, which `https://evil.test/?x=claude.ai` would satisfy.
 */
const SURFACE_REDIRECT_HOSTS: { readonly surface: PluginActorId; readonly hosts: readonly string[] }[] = [
  { surface: 'plugin:claude', hosts: ['claude.ai', 'claude.com', 'anthropic.com'] },
  // Agent Studio and the ChatGPT app share openai.com/chatgpt.com callbacks.
  // A Custom GPT never reaches this code — it calls the Actions façade, which
  // stamps `plugin:openai-gpt` by construction (see surfaceForFacade).
  { surface: 'plugin:openai-agent', hosts: ['chatgpt.com', 'openai.com', 'chat.openai.com'] },
];

/** Host of a redirect URI, lowercased, or undefined when it will not parse. */
const hostOf = (uri: string): string | undefined => {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const hostMatches = (host: string, registered: string): boolean =>
  host === registered || host.endsWith(`.${registered}`);

/**
 * The surface every one of these redirect URIs agrees on, or `undefined`.
 *
 * Deliberately unanimous: a client registering both a claude.ai and a
 * chatgpt.com callback is not one surface, and guessing which would put a
 * wrong name in an audit ledger. Unknown is a fine answer; wrong is not.
 */
export const surfaceForRedirectUris = (redirectUris: readonly string[] | undefined): PluginActorId | undefined => {
  if (!redirectUris?.length) return undefined;

  const surfaces = new Set<PluginActorId | undefined>();
  for (const uri of redirectUris) {
    const host = hostOf(uri);
    if (!host) {
      surfaces.add(undefined);
      continue;
    }
    surfaces.add(SURFACE_REDIRECT_HOSTS.find((entry) => entry.hosts.some((h) => hostMatches(host, h)))?.surface);
  }

  if (surfaces.size !== 1) return undefined;
  return [...surfaces][0];
};

/** The surface for a registered OAuth client. */
export const surfaceForOAuthClient = (client: { redirect_uris?: readonly string[] }): PluginActorId | undefined =>
  surfaceForRedirectUris(client.redirect_uris);

/**
 * The Actions façade (`/api/plugin/*`) is `plugin:openai-gpt` BY CONSTRUCTION:
 * it is the only thing that route serves, and a Custom GPT is the only thing
 * that calls it. Nothing is derived here because nothing needs to be.
 */
export const surfaceForFacade = (): PluginActorId => 'plugin:openai-gpt';
