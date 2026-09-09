/**
 * TOOL_DEFINITIONS, genesis-policy family (Wolf, 2026-09-09). Two tools over
 * one core — `handleGenesisPolicyVerb` — reading and writing the FLEET-wide
 * lever that decides which baseline artifacts a mint must supply
 * (`packages/core/lib/genesis-policy.ts`).
 *
 * Declared and gated on the membership family's model, for the same reason it
 * exists there: these change the rules everything else is checked against.
 * Three consequences a caller must know:
 *
 *   1. HUMAN principal only. Over /mcp that means an OAuth connection a
 *      Netlify Identity human approved; the shared site token and per-agent
 *      tokens are refused with 403 `genesis_policy_requires_human`, and the
 *      tools are not even LISTED to them (mcp.ts `visibleToolDefinitions`).
 *      An agent that could raise the bar on its own mints could equally lower
 *      it, which would make the whole lever decorative.
 *   2. `genesis_policy_get` is Admin tier; `genesis_policy_set` is Owner tier
 *      and `ask`-floored, and no governance or profile override can lower
 *      that floor.
 *   3. Out of the plugin charter BY NAME (`plugin/build-tools.ts`), not by
 *      class — `genesis_policy_get` is `read` class and would otherwise pass
 *      the class filter, which would put a fleet governance lever in a
 *      publishing plugin's advertised surface. The membership family is
 *      excluded there for exactly this reason and this family rides the same
 *      filter.
 *
 * CHAT: both are in `CHAT_HIDDEN_TOOLS` — discoverable on /mcp, absent from a
 * client's chat registry (Wolf's 2026-09-08 "narrow split" posture, the same
 * one the capture family ships under). The admin-chat card for this policy is
 * a later task; until it exists there is nothing for a chat run to render and
 * a half-wired chat tool would be worse than none.
 */
import { idempotencyKeyJsonSchema, objectSchema } from './mcp-tool-definitions.js';
import { GENESIS_ARTIFACTS } from '../../lib/genesis-policy.js';
import type { ToolDefinition } from '../functions/mcp.js';

/** MCP tool name → genesis-policy verb (the core's routing table). */
export const GENESIS_POLICY_TOOL_VERBS: Record<string, 'get' | 'set'> = {
  genesis_policy_get: 'get',
  genesis_policy_set: 'set',
};

export const GENESIS_POLICY_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(GENESIS_POLICY_TOOL_VERBS));
export const isGenesisPolicyTool = (name: unknown): name is string =>
  typeof name === 'string' && GENESIS_POLICY_TOOL_NAMES.has(name);

const HUMAN =
  'HUMAN principal only (an OAuth connection approved by a Netlify Identity human) — agent tokens are refused with 403 genesis_policy_requires_human.';

export const TOOL_DEFINITIONS_GENESIS: ToolDefinition[] = [
  {
    name: 'genesis_policy_get',
    description: `${HUMAN} Admin tier. Reads the FLEET-wide genesis policy: which baseline artifacts a new tenant's mint must supply, or the mint is refused 422 genesis_artifact_required before a single file is written. Returns the committed fleet default, this tenant's stored override if one is set, the effective policy, the closed artifact enum, the artifact → INPUT FIELD map the refusal's missing[] speaks (editorial_strategy → editorialStrategy, and so on), and the refusal contract itself with its two ways out. The shipped default requires NOTHING: every baseline is seeded carrying provenance.set_by:"genesis_default" and consumers warn rather than block. Read this before genesis_policy_set. Read-only.`,
    inputSchema: objectSchema({}),
    governance: { toolClass: 'read', chatDefaultOff: true },
  },
  {
    name: 'genesis_policy_set',
    description: `${HUMAN} Owner tier. Sets the genesis policy override: requiredArtifacts, a subset of [${GENESIS_ARTIFACTS.join(' | ')}] with no repeats. Requiring an artifact means a mint that omits it is REFUSED (422 genesis_artifact_required, missing[] naming the input fields) rather than producing a tenant with a genesis_default placeholder — a posture change with real operational cost, so read genesis_policy_get first and pass the full list you want in force (this replaces, it does not merge). SCOPE, honestly: the governance store is per-tenant, so this override governs the surfaces that read THIS tenant's governance document; the repo-side CLI mint (packages/core/cli/create-site.mjs) enforces the committed fleet default in packages/core/lib/genesis-policy.ts until a deploy carries the change. A fleet-wide flip is an edit to that committed file. There is no separate revert verb: pass requiredArtifacts:[] to require nothing again, which is what the committed fleet default says today.`,
    inputSchema: objectSchema(
      {
        requiredArtifacts: {
          type: 'array',
          description:
            'The artifacts a mint must supply. Replaces the current list wholesale. Empty means nothing is required.',
          items: { type: 'string', enum: [...GENESIS_ARTIFACTS] },
        },
        idempotency_key: idempotencyKeyJsonSchema,
      },
      ['requiredArtifacts']
    ),
    governance: {
      toolClass: 'privileged',
      autonomyFloor: 'ask',
      preview: { kind: 'input_echo' },
      chatDefaultOff: true,
    },
  },
];
