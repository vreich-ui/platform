/**
 * OpenAPI 3.1 generator for the ChatGPT Actions façade (W3.1).
 *
 * Generated from the LIVE tool definitions intersected with the active
 * manifest's allowlist — never hand-authored. W0.3 §A.2 found the legacy GPT
 * schema had drifted in five separate ways (missing `expectedDocuments`, a
 * missing `operation`, no `object_refresh_lock`, invented OAuth URLs, and a
 * 12-value object_type enum repeated in nine places). Every one of those is a
 * class of bug that only exists because a human maintained the schema by hand.
 *
 * Two properties matter more than completeness:
 *
 *  1. `x-openai-isConsequential` is COMPUTED from the tool's own governance
 *     class (`toolClass !== 'read'`), so ChatGPT prompts on exactly the writes
 *     and none of the reads.
 *  2. The path list IS the charter. The façade refuses anything not in it, so
 *     on this surface the plugin allowlist is real enforcement rather than the
 *     advisory list it is on `/mcp` (see recon-mcp.md §4.2).
 */
import type { ManifestConnection, ManifestTool } from './manifest-types.js';
import type { ToolDefinition } from '../../functions/mcp.js';

export const PLUGIN_ACTION_PATH_PREFIX = '/api/plugin';

/**
 * OpenAPI 3.1 is JSON Schema 2020-12, so an MCP inputSchema embeds almost
 * verbatim — but `$schema` is not allowed inside a Schema Object, and ChatGPT's
 * importer rejects the whole document when it appears.
 */
const sanitizeSchema = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === '$schema') continue;
    out[key] = sanitizeSchema(value);
  }
  return out;
};

const TOOL_RESULT_RESPONSES = {
  '200': {
    description: 'The tool result, unwrapped from the MCP envelope.',
    content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
  },
  '4XX': {
    description: 'Refusal or tool error: {ok:false, error, error_code?, details?}.',
    content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
  },
} as const;

export type BuildOpenApiInput = {
  connection: ManifestConnection;
  /** The active manifest's allowlist — the charter this façade enforces. */
  tools: readonly ManifestTool[];
  /** Live definitions, for the real input schemas. */
  definitions: readonly ToolDefinition[];
  manifestVersion: string;
};

export const buildOpenApiDocument = (input: BuildOpenApiInput): Record<string, unknown> => {
  const byName = new Map(input.definitions.map((d) => [d.name, d]));
  const paths: Record<string, unknown> = {};

  for (const tool of input.tools) {
    const definition = byName.get(tool.name);
    // A tool in the manifest that no longer exists on the surface is skipped
    // rather than emitted with a guessed schema — a stale manifest must not
    // produce a document that lies about what the tenant accepts.
    if (!definition) continue;

    paths[`${PLUGIN_ACTION_PATH_PREFIX}/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.summary,
        tags: [tool.tool_class],
        'x-openai-isConsequential': tool.consequential,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: sanitizeSchema(definition.inputSchema) } },
        },
        responses: TOOL_RESULT_RESPONSES,
      },
    };
  }

  const oauth = input.connection.oauth;

  return {
    openapi: '3.1.0',
    info: {
      title: `${input.connection.tenant} publishing façade`,
      version: input.manifestVersion,
      description:
        'REST façade over the tenant MCP tools for ChatGPT Actions. Each path forwards its JSON body ' +
        'verbatim to the same-named tool through the same handler and the same OAuth as /mcp — it adds ' +
        'no business logic. Only the tools in this document are accepted; anything else is refused 403.',
    },
    servers: [{ url: input.connection.origin }],
    security: [{ tenantOAuth: [] }],
    components: {
      securitySchemes: {
        tenantOAuth: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: oauth.authorization_url,
              tokenUrl: oauth.token_url,
              // Deliberately empty: the tenant's authorization server does not
              // define plugin-specific scopes, and inventing one here produced
              // an authorization failure that looked like a bad credential
              // (W0.3 §A.2). Read the live set from the discovery document if
              // scopes are ever introduced.
              scopes: {},
            },
          },
        },
      },
    },
    paths,
  };
};
